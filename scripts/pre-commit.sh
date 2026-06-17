#!/bin/bash

if [ "$#" -eq 0 ]; then
  exit 0
fi

if ! which deno >/dev/null; then
    echo "⚠️ warning: Deno not installed."
    exit 0
fi

echo "Running Deno Lint on staged files..."
deno lint "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Lint failed. Please fix the errors before committing."
    exit 1
fi

echo "Running Deno Fmt..."
deno fmt --check "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Fmt failed. Please format before committing."
    exit 1
fi
