#!/bin/bash
# Ensures a working container engine for GitHub container-based actions.
#
# WHY THIS EXISTS, AND WHY IT IS NOT SIMPLY "start Docker"
#
# This project runs on Podman: the build input is a `Containerfile`, not a
# Dockerfile, and Podman is rootless by design. Docker is not the runtime.
#
# But GitHub's `uses:` container actions (here: trufflesecurity/trufflehog)
# speak the Docker API, and on a self-hosted runner they need a
# Docker-compatible endpoint. Podman exposes exactly that, so the correct
# behaviour is to use whichever engine is actually present and point
# DOCKER_HOST at it -- not to demand Docker Desktop and fail the production
# deploy when it is absent.
#
# The previous version of this gate ran `docker info` and, on failure, told the
# operator to restart Docker Desktop. On a Podman-only host that fails every
# single time, with a message that describes the wrong problem. It blocked the
# backend deploy for a reason unrelated to the deploy.
#
# Exports (via $GITHUB_ENV, since `export` does not survive to later steps):
#   CONTAINER_ENGINE  - "docker" | "podman", for diagnostics
#   DOCKER_HOST       - Docker-API endpoint, only when we had to derive it
#
# Every probe is time-bounded. An unresponsive engine socket blocks
# indefinitely, and an unbounded wait turns a slow host into a hung pipeline
# with no diagnostic at all -- which is its own kind of failure.
set -uo pipefail

# Total budget: probe + (launch) + retries. Kept small: if the engine is not
# up within a couple of minutes, something is genuinely wrong with the host.
PROBE_SECONDS="${ENGINE_PROBE_SECONDS:-6}"
LAUNCH_SECONDS="${ENGINE_LAUNCH_SECONDS:-25}"
RETRIES="${ENGINE_RETRIES:-12}"

log() { echo "::notice::$*"; }
warn() { echo "::warning::$*"; }

# Run a command with a hard time limit. A hung `docker info` must never be
# able to hang the pipeline.
bounded() {
  local limit="$1"; shift
  ( "$@" >/dev/null 2>&1 ) 2>/dev/null &
  local child=$!
  local waited=0
  while kill -0 "$child" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill -9 "$child" 2>/dev/null || true
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$child"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 1. Prefer an already-working engine, in the order the project actually uses.
# ---------------------------------------------------------------------------
ENGINE=""

if have docker && bounded "$PROBE_SECONDS" docker info; then
  ENGINE="docker"
  log "Container engine: Docker (daemon already responding)."
fi

if [ -z "$ENGINE" ] && have podman; then
  # A Podman socket may already be exported (CI runner service container, or a
  # previous step). Honour it before touching the machine.
  if bounded "$PROBE_SECONDS" podman info; then
    ENGINE="podman"
    log "Container engine: Podman (already responding${DOCKER_HOST:+ on $DOCKER_HOST})."
  else
    log "Podman installed but not responding; attempting to start the Podman machine..."
    # The Podman analogue of `open -a Docker`. Bounded, because on a cold host
    # a VM boot can take a while and we do not want to hang the pipeline.
    bounded "$LAUNCH_SECONDS" podman machine start >/dev/null 2>&1 || true
    for _ in $(seq 1 "$RETRIES"); do
      if bounded "$PROBE_SECONDS" podman info; then
        ENGINE="podman"
        break
      fi
      sleep 3
    done
  fi

  if [ -n "$ENGINE" ]; then
    # Point GitHub's Docker-API consumers (container actions) at Podman.
    # Only set it when the socket is actually discoverable -- exporting a bogus
    # DOCKER_HOST is worse than exporting none.
    if [ -z "${DOCKER_HOST:-}" ]; then
      socket="$(bounded "$PROBE_SECONDS" podman machine inspect \
        --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null || true)"
      if [ -n "${socket:-}" ] && [ -S "$socket" ]; then
        export DOCKER_HOST="unix://$socket"
        echo "DOCKER_HOST=unix://$socket" >> "${GITHUB_ENV:-/dev/null}"
        log "Exported DOCKER_HOST=unix://$socket so container actions can reach Podman."
      else
        warn "Podman is up but its Docker-compatible socket could not be located. Container actions may not be able to reach it."
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 2. Last resort: Docker Desktop, if it happens to be installed. Only reached
#    when neither Docker-as-a-service nor Podman is available.
# ---------------------------------------------------------------------------
if [ -z "$ENGINE" ] && have docker; then
  warn "No container engine responding; attempting to launch Docker Desktop as a fallback..."
  if [ "$(uname)" = "Darwin" ] && [ -d /Applications/Docker.app ]; then
    bounded "$LAUNCH_SECONDS" open -a Docker >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 "$RETRIES"); do
    if bounded "$PROBE_SECONDS" docker info; then
      ENGINE="docker"
      warn "Fell back to Docker Desktop; this project targets Podman, so check the host configuration."
      break
    fi
    sleep 3
  done
fi

if [ -n "$ENGINE" ]; then
  echo "CONTAINER_ENGINE=$ENGINE" >> "${GITHUB_ENV:-/dev/null}"
  log "Container engine ready: $ENGINE"
  exit 0
fi

cat >&2 <<'EOF'
::error::No usable container engine on this runner.
This project targets Podman (Containerfile, rootless). Container-based GitHub
actions additionally require a Docker-API endpoint, which Podman provides.
Neither `podman info` nor `docker info` responded within the time budget.
Check on the runner host:  podman machine list / podman machine start
EOF
exit 1
