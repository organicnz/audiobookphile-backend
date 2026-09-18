#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_ROOT/crates/cli/target/release/audiobookphile" ]; then
    "$REPO_ROOT/crates/cli/target/release/audiobookphile" audit --path "$REPO_ROOT"
    exit 0
fi

cargo run --manifest-path "$REPO_ROOT/crates/cli/Cargo.toml" --release -- audit --path "$REPO_ROOT"
