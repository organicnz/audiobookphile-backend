#!/bin/bash

if [ "$#" -eq 0 ]; then
  exit 0
fi

if ! which deno >/dev/null; then
    echo "⚠️ warning: Deno not installed."
    exit 0
fi

# 1. Merge Conflict Marker Guard
echo "Running Merge Conflict Marker check..."
CONFLICT_FILES=$(grep -E -l '^(<<<<<<<|=======|>>>>>>>)' "$@" 2>/dev/null | grep -v 'pre-commit.sh' || true)
if [ -n "$CONFLICT_FILES" ]; then
    echo "❌ ERROR: Unresolved git merge conflict markers found in:"
    echo "$CONFLICT_FILES"
    echo "Please resolve conflict markers (<<<<<<< HEAD, =======, >>>>>>>) before committing!"
    exit 1
fi

# 2. Secret Scan Guard
echo "Running Secret Scan check..."
FORBIDDEN_PATTERNS="eyJh|eyJhbGci|sbp_[a-zA-Z0-9]{40}|BEGIN PRIVATE KEY|service_role"
LEAKED_FILES=$(grep -E -l "$FORBIDDEN_PATTERNS" "$@" 2>/dev/null | grep -v '\.example' | grep -v 'pre-commit.sh' || true)
if [ -n "$LEAKED_FILES" ]; then
    echo "❌ SECURITY ALERT: Potential secret / credential leak detected in:"
    echo "$LEAKED_FILES"
    echo "Please remove hardcoded secrets or service role keys before committing!"
    exit 1
fi

# 3. Supabase Edge Guard (Rule 3 Enforcement: import { createClient } from "npm:@supabase/supabase-js@2.44.0")
echo "Running Supabase Edge Guard (Rule 3)..."
CREATE_CLIENT_FILES=$(grep -l 'createClient' "$@" 2>/dev/null | grep '\.ts$' || true)
if [ -n "$CREATE_CLIENT_FILES" ]; then
    for f in $CREATE_CLIENT_FILES; do
        if ! grep -q 'npm:@supabase/supabase-js@2.44.0' "$f"; then
            echo "❌ SUPABASE EDGE GUARD VIOLATION in: $f"
            echo "Rule 3 Failure: Every Supabase Edge Function using createClient MUST explicitly import:"
            echo 'import { createClient } from "npm:@supabase/supabase-js@2.44.0";'
            exit 1
        fi
    done
fi

# 4. SQL Migration Danger Guard
SQL_FILES=$(echo "$@" | grep '\.sql$' || true)
if [ -n "$SQL_FILES" ]; then
    echo "Running SQL Migration Safety Scanner..."
    DANGEROUS_SQL=$(grep -i -E 'DROP TABLE [^I]' $SQL_FILES 2>/dev/null || true)
    if [ -n "$DANGEROUS_SQL" ]; then
        echo "❌ DANGEROUS SQL DETECTED: DROP TABLE without IF EXISTS"
        echo "$DANGEROUS_SQL"
        echo "Use DROP TABLE IF EXISTS to prevent accidental migration crashes!"
        exit 1
    fi
fi

# 5. Deno Lint
echo "Running Deno Lint on staged files..."
deno lint --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Lint failed. Please fix the errors before committing."
    exit 1
fi

# 6. Deno Fmt check
echo "Running Deno Fmt check..."
deno fmt --check --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Fmt failed. Please run 'deno fmt' before committing."
    exit 1
fi

# 7. Deno Edge Typecheck
echo "Running Deno Edge Typecheck..."
deno check supabase/functions/api/index.ts
if [ $? -ne 0 ]; then
    echo "❌ Deno typecheck failed. Please fix type errors before committing."
    exit 1
fi

# 8. Deno Unit Tests
echo "Running Deno Unit Tests..."
deno test -A supabase/functions/api/
if [ $? -ne 0 ]; then
    echo "❌ Deno unit tests failed. Please fix broken tests before committing."
    exit 1
fi

echo "✅ Backend pre-commit verification passed cleanly!"
