#!/bin/bash

if [ "$#" -eq 0 ]; then
  exit 0
fi

if ! which deno >/dev/null; then
    echo "⚠️ Deno not installed."
    exit 0
fi

TS_FILES=$(echo "$@" | tr ' ' '\n' | grep '\.ts$' || true)
SQL_FILES=$(echo "$@" | tr ' ' '\n' | grep '\.sql$' || true)
ALL_FILES="$@"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 1 — INSTANT BLOCKERS (fast grep, <100ms)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# 1. Merge Conflict Marker Guard
echo "🔍 [1/10] Merge Conflict Marker check..."
CONFLICT_FILES=$(grep -E -l '^(<<<<<<<|=======|>>>>>>>)' $ALL_FILES 2>/dev/null | grep -v 'pre-commit.sh' || true)
if [ -n "$CONFLICT_FILES" ]; then
    echo "❌ Unresolved git merge conflict markers found in:"
    echo "$CONFLICT_FILES"
    exit 1
fi

# 2. Secret & Credential Leak Scanner
echo "🔍 [2/10] Secret Scan check..."
FORBIDDEN_PATTERNS="eyJhbGci|sbp_[a-zA-Z0-9]{20,}|SUPABASE_SERVICE_ROLE|BEGIN PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16}"
LEAKED_FILES=$(grep -E -l "$FORBIDDEN_PATTERNS" $ALL_FILES 2>/dev/null | grep -v '\.example' | grep -v 'pre-commit.sh' || true)
if [ -n "$LEAKED_FILES" ]; then
    echo "❌ SECURITY: Potential secret/credential leak detected in:"
    echo "$LEAKED_FILES"
    exit 1
fi

# 3. Supabase Edge Guard (Rule 3: npm:@supabase/supabase-js@2.44.0)
if [ -n "$TS_FILES" ]; then
    echo "🔍 [3/10] Supabase Edge Guard (Rule 3)..."
    CREATE_CLIENT_FILES=$(grep -l 'createClient' $TS_FILES 2>/dev/null || true)
    if [ -n "$CREATE_CLIENT_FILES" ]; then
        for f in $CREATE_CLIENT_FILES; do
            if ! grep -q 'npm:@supabase/supabase-js@2.44.0' "$f"; then
                echo "❌ SUPABASE EDGE GUARD VIOLATION in: $f"
                echo 'Required: import { createClient } from "npm:@supabase/supabase-js@2.44.0";'
                exit 1
            fi
        done
    fi
fi

# 4. SQL Migration Safety Scanner
if [ -n "$SQL_FILES" ]; then
    echo "🔍 [4/10] SQL Migration Safety Scanner..."
    # Block DROP TABLE without IF EXISTS
    DANGEROUS_DROP=$(grep -i -n 'DROP TABLE [^I]' $SQL_FILES 2>/dev/null || true)
    if [ -n "$DANGEROUS_DROP" ]; then
        echo "❌ DANGEROUS SQL: DROP TABLE without IF EXISTS"
        echo "$DANGEROUS_DROP"
        exit 1
    fi
    # Block TRUNCATE in migration files
    DANGEROUS_TRUNCATE=$(grep -i -n 'TRUNCATE' $SQL_FILES 2>/dev/null || true)
    if [ -n "$DANGEROUS_TRUNCATE" ]; then
        echo "❌ DANGEROUS SQL: TRUNCATE found in migration — use DELETE with WHERE"
        echo "$DANGEROUS_TRUNCATE"
        exit 1
    fi
fi

# 5. Hardcoded URL / Dev Environment Guard
if [ -n "$TS_FILES" ]; then
    echo "🔍 [5/10] Hardcoded URL Guard..."
    HARDCODED=$(grep -n 'http://localhost\|127\.0\.0\.1\|http://0\.0\.0\.0' $TS_FILES 2>/dev/null | grep -v '_test\.ts' | grep -v 'test_' || true)
    if [ -n "$HARDCODED" ]; then
        echo "⚠️  WARNING: Hardcoded localhost URLs in non-test code:"
        echo "$HARDCODED"
        echo "Use Deno.env.get() for environment-based configuration."
        exit 1
    fi
fi

# 6. Console.log / Debug Leftover Guard
if [ -n "$TS_FILES" ]; then
    echo "🔍 [6/10] Debug Statement Guard..."
    DEBUG_LOGS=$(grep -n 'console\.log\|console\.debug\|console\.trace' $TS_FILES 2>/dev/null | grep -v '_test\.ts' | grep -v 'test_' | grep -v 'JSON.stringify' || true)
    if [ -n "$DEBUG_LOGS" ]; then
        echo "⚠️  WARNING: console.log/debug/trace found in production code:"
        echo "$DEBUG_LOGS"
        echo "Use structured logging (console.info/warn/error) instead."
        exit 1
    fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 2 — STATIC ANALYSIS (deno lint + fmt, ~1s)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "🔍 [7/10] Deno Lint..."
deno lint --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Lint failed."
    exit 1
fi

echo "🔍 [8/10] Deno Fmt check..."
deno fmt --check --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Fmt failed. Run 'deno fmt' first."
    exit 1
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 3 — COMPILER & RUNTIME VERIFICATION (~3-5s)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "🔍 [9/10] Deno Edge Typecheck..."
deno check supabase/functions/api/index.ts
if [ $? -ne 0 ]; then
    echo "❌ Deno typecheck failed."
    exit 1
fi

echo "🔍 [10/10] Deno Unit Tests (12 tests)..."
deno test -A supabase/functions/api/
if [ $? -ne 0 ]; then
    echo "❌ Unit tests failed."
    exit 1
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUMMARY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TOTAL_FILES=$(echo "$ALL_FILES" | wc -w | tr -d ' ')
echo ""
echo "✅ Backend pre-commit passed — $TOTAL_FILES file(s) verified across 10 intelligent guards."
