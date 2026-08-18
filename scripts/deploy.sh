#!/bin/bash
set -e

echo "🚀 Starting deployment..."

# 1. Sync types and schemas between backend and frontend
echo "📦 Generating TypeScript types from Supabase..."
bun run gen:types

# 2. Push schema to production (if linked)
if [ -f .env.local ] && grep -q "SUPABASE_URL" .env.local; then
    echo "🌐 Pushing database schema to production..."
    bunx supabase db push --include-all || true
fi

# 3. Verify Supabase functions are running
echo ""
echo "🔍 Checking Supabase functions status..."
sleep 5
curl -s "http://localhost:54321/functions/v1/items?pretty" | jq '{error, path}' 2>/dev/null || echo "Items endpoint not responding"

# Output deployment timestamp and URL
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
echo ""
echo "============================================="
echo "Deployment completed: $TIMESTAMP"
echo "============================================="
