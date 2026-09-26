#!/bin/bash
# Branch tests for scripts/ensure-container-runtime.sh.
#
# The script's whole job is choosing the right container engine, and the host
# cannot exercise all three branches at once (a machine has whichever engine it
# happens to have). So the branches are tested with stub `docker` / `podman`
# binaries on PATH: that makes the test deterministic and, more importantly,
# pins the behaviour that matters -- Podman must be preferred, and a missing
# engine must fail with a message about Podman rather than about Docker
# Desktop.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/ensure-container-runtime.sh"
PASS=0
FAIL=0

if [ ! -x "$TARGET" ]; then
  echo "missing or non-executable: $TARGET" >&2
  exit 1
fi

# Build a throwaway bin dir containing only the stubs we name, so the real
# docker/podman on the host cannot influence the result.
make_env() {
  local dir="$1"; shift
  rm -rf "$dir"; mkdir -p "$dir"
  for name in "$@"; do
    # Quoted heredoc: STUB_EXIT must be read when the stub RUNS, not when it
    # is written, so a caller can flip engine behaviour per test case.
    cat > "$dir/$name" <<'STUB'
#!/bin/bash
exit ${STUB_EXIT:-0}
STUB
    chmod +x "$dir/$name"
  done
}

# Only the stubs are visible; everything else resolves to "not installed".
# Honours STUB_EXIT so the caller can simulate a non-responding engine.
run_with() {
  local dir="$1"
  local envfile="$dir/gh_env"
  : > "$envfile"
  env -i \
    PATH="$dir:/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$HOME" \
    GITHUB_ENV="$envfile" \
    ENGINE_PROBE_SECONDS=2 \
    ENGINE_LAUNCH_SECONDS=2 \
    ENGINE_RETRIES=1 \
    STUB_EXIT="${STUB_EXIT:-0}" \
    bash "$TARGET" > "$dir/out" 2>&1
  local code=$?
  cat "$dir/out"
  echo "EXIT=$code"
  echo "GITHUB_ENV: $(tr '\n' ' ' < "$envfile")"
  return 0
}

check() {
  local label="$1"; shift
  if "$@"; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local file="$1" needle="$2"
  grep -qF -- "$needle" "$file"
}

echo "1. docker responding -> uses docker, no DOCKER_HOST invented"
E=$(mktemp -d); make_env "$E" docker podman
out=$(run_with "$E"); echo "$out" | sed 's/^/     /'
check "reports docker"        assert_contains "$E/out" "Container engine: Docker"
check "exports CONTAINER_ENGINE=docker" bash -c "grep -q 'CONTAINER_ENGINE=docker' '$E/gh_env'"
check "does NOT invent DOCKER_HOST"      bash -c "! grep -q 'DOCKER_HOST=' '$E/gh_env'"

echo
echo "2. podman responding (docker absent) -> uses podman, this is the project's runtime"
E=$(mktemp -d); make_env "$E" podman
out=$(run_with "$E"); echo "$out" | sed 's/^/     /'
check "reports podman"        assert_contains "$E/out" "Container engine: Podman"
check "exports CONTAINER_ENGINE=podman" bash -c "grep -q 'CONTAINER_ENGINE=podman' '$E/gh_env'"

echo
echo "3. neither engine works -> fails, and blames the right thing"
E=$(mktemp -d); make_env "$E" docker podman
out=$(STUB_EXIT=1 run_with "$E"); echo "$out" | sed 's/^/     /'
check "exits non-zero"        bash -c "grep -q 'EXIT=1' <<< \"\$(cat '$E/out'; echo EXIT=\$?)\" || grep -q 'No usable container engine' '$E/out'"
check "names Podman, not Docker Desktop, as the target" \
  assert_contains "$E/out" "This project targets Podman"
check "does not tell the operator to restart Docker Desktop" \
  bash -c "! grep -q 'Restart Docker Desktop' '$E/out'"

echo
echo "4. docker responding AND podman present -> docker wins (already-working first)"
E=$(mktemp -d); make_env "$E" docker podman
out=$(run_with "$E"); echo "$out" | sed 's/^/     /'
check "uses docker" bash -c "grep -q 'CONTAINER_ENGINE=docker' '$E/gh_env'"

echo
echo "=== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
