#!/bin/bash

if [ "$#" -eq 0 ]; then
  exit 0
fi

if ! which deno >/dev/null; then
    echo "⚠️ warning: Deno not installed."
    exit 0
fi

echo "Running Deno Lint on staged files..."
deno lint --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Lint failed. Please fix the errors before committing."
    exit 1
fi

echo "Running Deno Fmt check..."
deno fmt --check --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Fmt failed. Please run 'deno fmt' before committing."
    exit 1
fi

echo "Running Deno Edge Typecheck..."
deno check supabase/functions/api/index.ts
if [ $? -ne 0 ]; then
    echo "❌ Deno typecheck failed. Please fix type errors before committing."
    exit 1
fi

echo "Running Deno Unit Tests..."
deno test -A supabase/functions/api/
if [ $? -ne 0 ]; then
    echo "❌ Deno unit tests failed. Please fix broken tests before committing."
    exit 1
fi

echo "✅ Backend pre-commit verification passed cleanly!"
