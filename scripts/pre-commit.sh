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
JSON_FILES=$(echo "$@" | tr ' ' '\n' | grep -E '\.(json|yml|yaml)$' || true)
ALL_FILES="$@"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 1 — INSTANT BLOCKERS (fast grep, <100ms)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# 1. Merge Conflict Marker Guard
echo "🔍 [1/11] Merge Conflict Marker check..."
CONFLICT_FILES=$(grep -E -l '^(<<<<<<<|=======|>>>>>>>)' $ALL_FILES 2>/dev/null | grep -v 'pre-commit.sh' || true)
if [ -n "$CONFLICT_FILES" ]; then
    echo "❌ Unresolved git merge conflict markers found in:"
    echo "$CONFLICT_FILES"
    exit 1
fi

# 2. Secret & Credential Leak Scanner
echo "🔍 [2/11] Secret Scan check..."
FORBIDDEN_PATTERNS="eyJhbGci|sbp_[a-zA-Z0-9]{20,}|SUPABASE_SERVICE_ROLE|BEGIN PRIVATE KEY|sk_live_|AKIA[0-9A-Z]{16}"
LEAKED_FILES=$(grep -E -l "$FORBIDDEN_PATTERNS" $ALL_FILES 2>/dev/null | grep -v '\.example' | grep -v 'pre-commit.sh' || true)
if [ -n "$LEAKED_FILES" ]; then
    echo "❌ SECURITY: Potential secret/credential leak detected in:"
    echo "$LEAKED_FILES"
    exit 1
fi

# 3. Large Audio Media & Bloat File Guard (.m4b, .mp3, .flac, >10MB)
echo "🔍 [3/11] Repo Bloat & Audio Media Guard..."
AUDIO_BLOAT=$(echo "$ALL_FILES" | tr ' ' '\n' | grep -i -E '\.(m4b|mp3|flac|aac|wav|ogg|zip|tar\.gz|iso)$' || true)
if [ -n "$AUDIO_BLOAT" ]; then
    echo "❌ REPO BLOAT GUARD: Accidental audio media or large binary file staged:"
    echo "$AUDIO_BLOAT"
    echo "Audio files must not be committed into git storage!"
    exit 1
fi

# 4. JSON / YAML Syntax Guard
if [ -n "$JSON_FILES" ]; then
    echo "🔍 [4/11] JSON/YAML Syntax Guard..."
    for f in $JSON_FILES; do
        if echo "$f" | grep -q '\.json$'; then
            python3 -m json.tool "$f" >/dev/null 2>&1
            if [ $? -ne 0 ]; then
                echo "❌ JSON SYNTAX ERROR in file: $f"
                exit 1
            fi
        fi
    done
fi

# 5. Supabase Edge Guard (Rule 3: npm:@supabase/supabase-js@2.44.0)
if [ -n "$TS_FILES" ]; then
    echo "🔍 [5/11] Supabase Edge Guard (Rule 3)..."
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

# 6. SQL Migration Safety Scanner
if [ -n "$SQL_FILES" ]; then
    echo "🔍 [6/11] SQL Migration Safety Scanner..."
    DANGEROUS_DROP=$(grep -i -n 'DROP TABLE [^I]' $SQL_FILES 2>/dev/null || true)
    if [ -n "$DANGEROUS_DROP" ]; then
        echo "❌ DANGEROUS SQL: DROP TABLE without IF EXISTS"
        echo "$DANGEROUS_DROP"
        exit 1
    fi
    DANGEROUS_TRUNCATE=$(grep -i -n 'TRUNCATE' $SQL_FILES 2>/dev/null || true)
    if [ -n "$DANGEROUS_TRUNCATE" ]; then
        echo "❌ DANGEROUS SQL: TRUNCATE found in migration — use DELETE with WHERE"
        echo "$DANGEROUS_TRUNCATE"
        exit 1
    fi
fi

# 7. Hardcoded URL Guard
if [ -n "$TS_FILES" ]; then
    echo "🔍 [7/11] Hardcoded URL Guard..."
    HARDCODED=$(grep -n 'http://localhost\|127\.0\.0\.1\|http://0\.0\.0\.0' $TS_FILES 2>/dev/null | grep -v '_test\.ts' | grep -v 'test_' || true)
    if [ -n "$HARDCODED" ]; then
        echo "⚠️ WARNING: Hardcoded localhost URLs in non-test code:"
        echo "$HARDCODED"
        exit 1
    fi
fi

# 8. Console.log / Debug Leftover Guard
if [ -n "$TS_FILES" ]; then
    echo "🔍 [8/11] Debug Statement Guard..."
    DEBUG_LOGS=$(grep -n 'console\.log\|console\.debug\|console\.trace' $TS_FILES 2>/dev/null | grep -v '_test\.ts' | grep -v 'test_' | grep -v 'JSON.stringify' || true)
    if [ -n "$DEBUG_LOGS" ]; then
        echo "⚠️ WARNING: console.log/debug/trace found in production code:"
        echo "$DEBUG_LOGS"
        exit 1
    fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 2 — STATIC ANALYSIS (deno lint + fmt, ~1s)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "🔍 [9/11] Deno Lint..."
deno lint --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Lint failed."
    exit 1
fi

echo "🔍 [10/11] Deno Fmt check..."
deno fmt --check --config supabase/functions/deno.json "$@"
if [ $? -ne 0 ]; then
    echo "❌ Deno Fmt failed. Run 'deno fmt' first."
    exit 1
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 3 — COMPILER & RUNTIME VERIFICATION (~3-5s)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "🔍 [11/11] Deno Edge Typecheck & Unit Tests..."
deno check supabase/functions/api/index.ts && deno test -A supabase/functions/api/
if [ $? -ne 0 ]; then
    echo "❌ Typecheck or unit tests failed."
    exit 1
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUMMARY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TOTAL_FILES=$(echo "$ALL_FILES" | wc -w | tr -d ' ')
echo ""
echo "✅ Backend pre-commit passed — $TOTAL_FILES file(s) verified across 11 intelligent guards."
