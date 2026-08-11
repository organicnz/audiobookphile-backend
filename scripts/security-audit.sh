#!/bin/bash

echo "🔒 Running Backend Security & Package Audit..."

# 1. Secret & Key Scan Audit
FORBIDDEN_PATTERNS="eyJhbGci|sbp_[a-zA-Z0-9]{20,}|SUPABASE_SERVICE_ROLE_KEY=[a-zA-Z0-9]|BEGIN PRIVATE KEY|sk_live_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}"
LEAKS=$(grep -r -E -n "$FORBIDDEN_PATTERNS" supabase/functions/ 2>/dev/null | grep -v '\.example' | grep -v 'node_modules' || true)
if [ -n "$LEAKS" ]; then
    echo "❌ SECURITY AUDIT FAILED: Hardcoded secret/key leak detected:"
    echo "$LEAKS"
    exit 1
fi

# 2. SQL Injection Risk Scanner
SQL_INJECTION=$(grep -r -n -E '\.query\([^)]*\+|from\([^)]*\+' supabase/functions/ 2>/dev/null | grep -v 'node_modules' || true)
if [ -n "$SQL_INJECTION" ]; then
    echo "❌ SECURITY AUDIT FAILED: Potential SQL injection / string concatenation query found:"
    echo "$SQL_INJECTION"
    exit 1
fi

# 3. Rule 3 Supabase Edge Guard Compliance Audit
CREATE_CLIENT_FILES=$(grep -r -l 'createClient' supabase/functions/ 2>/dev/null | grep -v 'node_modules' | grep '\.ts$' || true)
if [ -n "$CREATE_CLIENT_FILES" ]; then
    for f in $CREATE_CLIENT_FILES; do
        if ! grep -q 'npm:@supabase/supabase-js@2.44.0' "$f"; then
            echo "❌ SUPABASE EDGE GUARD AUDIT FAILURE in: $f"
            echo 'Required: import { createClient } from "npm:@supabase/supabase-js@2.44.0";'
            exit 1
        fi
    done
fi

echo "✅ Backend Security & Package Audit Passed Cleanly!"
