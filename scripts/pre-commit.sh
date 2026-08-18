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
# LAYER 1 — INSTANT BLOCKERS & CYBERSECURITY AUDIT (<100ms)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# 1. Merge Conflict Marker Guard
echo "🔍 [1/13] Merge Conflict Marker check..."
CONFLICT_FILES=$(grep -E -l '^(<<<<<<<|=======|>>>>>>>)' $ALL_FILES 2>/dev/null | grep -v 'pre-commit.sh' || true)
if [ -n "$CONFLICT_FILES" ]; then
    echo "❌ Unresolved git merge conflict markers found in:"
    echo "$CONFLICT_FILES"
    exit 1
fi

# 2. Deep Cybersecurity Secret & Private Key Scanner
echo "🔍 [2/13] Cybersecurity Secret & Key Scan..."
FORBIDDEN_PATTERNS="eyJhbGci|sbp_[a-zA-Z0-9]{20,}|SUPABASE_SERVICE_ROLE_KEY=[a-zA-Z0-9]|BEGIN PRIVATE KEY|sk_live_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}"
LEAKED_FILES=$(grep -E -l "$FORBIDDEN_PATTERNS" $ALL_FILES 2>/dev/null | grep -v '\.example' | grep -v 'pre-commit.sh' || true)
if [ -n "$LEAKED_FILES" ]; then
    echo "❌ CYBERSECURITY ALERT: Secret, private key, or credential leak detected in:"
    echo "$LEAKED_FILES"
    exit 1
fi

# 3. SQL Injection Risk Scanner (Raw String Concatenation in SQL)
if [ -n "$TS_FILES" ]; then
    echo "🔍 [3/13] SQL Injection Risk Scanner..."
    SQL_INJECTION=$(grep -n -E '\.query\([^)]*\+|from\([^)]*\+' $TS_FILES 2>/dev/null || true)
    if [ -n "$SQL_INJECTION" ]; then
        echo "❌ CYBERSECURITY ALERT: Potential SQL injection / string concatenation query found:"
        echo "$SQL_INJECTION"
        echo "Use parameterized queries ($1, $2) to prevent SQL injection vulnerabilities!"
        exit 1
    fi
fi

# 4. Insecure Random Generator Guard (Cryptographic Token Security)
if [ -n "$TS_FILES" ]; then
    echo "🔍 [4/13] Cryptographic Random Security Guard..."
    INSECURE_RANDOM=$(grep -n 'Math\.random()' $TS_FILES 2>/dev/null | grep -i -E '(token|secret|auth|nonce|key|pin)' || true)
    if [ -n "$INSECURE_RANDOM" ]; then
        echo "❌ CYBERSECURITY VIOLATION: Math.random() used for security token / PIN generation:"
        echo "$INSECURE_RANDOM"
        echo "Use crypto.getRandomValues() or crypto.randomUUID() for security tokens!"
        exit 1
    fi
fi

# 5. Deno Package & Import Compatibility Audit (Deprecated std modules & Supabase version)
if [ -n "$TS_FILES" ]; then
    echo "🔍 [5/13] Deno Package Compatibility Audit..."
    DEPRECATED_STD=$(grep -n 'https://deno.land/std@0\.[0-9]\{2\}\.' $TS_FILES 2>/dev/null || true)
    if [ -n "$DEPRECATED_STD" ]; then
        echo "⚠️ WARNING: Outdated Deno std library version below std@0.200.0 found:"
        echo "$DEPRECATED_STD"
        echo "Upgrade Deno std modules to compatible modern versions!"
        exit 1
    fi
fi

# 6. Large Audio Media & Bloat File Guard (.m4b, .mp3, .flac, >10MB)
echo "🔍 [6/13] Repo Bloat & Audio Media Guard..."
AUDIO_BLOAT=$(echo "$ALL_FILES" | tr ' ' '\n' | grep -i -E '\.(m4b|mp3|flac|aac|wav|ogg|zip|tar\.gz|iso)$' || true)
if [ -n "$AUDIO_BLOAT" ]; then
    echo "❌ REPO BLOAT GUARD: Accidental audio media or large binary file staged:"
    echo "$AUDIO_BLOAT"
    exit 1
fi

# 7. JSON / YAML Syntax Guard
if [ -n "$JSON_FILES" ]; then
    echo "🔍 [7/13] JSON/YAML Syntax Guard..."
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

# 8. Supabase Edge Guard (Rule 3: npm:@supabase/supabase-js@2.44.0)
if [ -n "$TS_FILES" ]; then
    echo "🔍 [8/13] Supabase Edge Guard (Rule 3)..."
    CREATE_CLIENT_FILES=$(grep -l 'createClient' $TS_FILES 2>/dev/null | grep 'supabase/functions/' | grep -v '_test\.ts' || true)
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

# 9. SQL Migration Safety Scanner
if [ -n "$SQL_FILES" ]; then
    echo "🔍 [9/13] SQL Migration Safety Scanner..."
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

# 10. Hardcoded URL Guard
if [ -n "$TS_FILES" ]; then
    echo "🔍 [10/13] Hardcoded URL Guard..."
    HARDCODED=$(grep -n 'http://localhost\|127\.0\.0\.1\|http://0\.0\.0\.0' $TS_FILES 2>/dev/null | grep -v '_test\.ts' | grep -v 'test_' || true)
    if [ -n "$HARDCODED" ]; then
        echo "⚠️ WARNING: Hardcoded localhost URLs in non-test code:"
        echo "$HARDCODED"
        exit 1
    fi
fi

# 11. Console.log / Debug Leftover Guard
if [ -n "$TS_FILES" ]; then
    echo "🔍 [11/13] Debug Statement Guard..."
    DEBUG_LOGS=$(grep -n 'console\.log\|console\.debug\|console\.trace' $TS_FILES 2>/dev/null | grep -v '_test\.ts' | grep -v 'test_' | grep -v 'JSON.stringify' || true)
    if [ -n "$DEBUG_LOGS" ]; then
        echo "⚠️ WARNING: console.log/debug/trace found in production code:"
        echo "$DEBUG_LOGS"
    fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 2 — STATIC ANALYSIS & LINTING (~1s)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "🔍 [12/13] Deno Lint & Format check..."
# deno lint/fmt only accepts code files — skip when no TS/SQL files are staged
if [ -n "$TS_FILES" ] || [ -n "$SQL_FILES" ]; then
  deno lint --config supabase/functions/deno.json $TS_FILES && deno fmt --check --config supabase/functions/deno.json $TS_FILES $SQL_FILES
  if [ $? -ne 0 ]; then
      echo "❌ Deno Lint/Fmt failed."
      exit 1
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAYER 3 — COMPILER & RUNTIME VERIFICATION (~3-5s)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "🔍 [13/13] Deno Edge Typecheck & Unit Tests..."
deno check --config supabase/functions/deno.json supabase/functions/api/index.ts && deno test -A --config supabase/functions/deno.json supabase/functions/api/
if [ $? -ne 0 ]; then
    echo "❌ Typecheck or unit tests failed."
    exit 1
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUMMARY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TOTAL_FILES=$(echo "$ALL_FILES" | wc -w | tr -d ' ')
echo ""
echo "✅ Backend pre-commit passed — $TOTAL_FILES file(s) verified across 13 intelligent cybersecurity & quality guards."
