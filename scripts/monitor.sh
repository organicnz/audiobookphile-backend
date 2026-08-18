#!/bin/bash
# Monitor Supabase function execution locally

echo "🔍 Starting local function monitoring..."
sleep 5

echo ""
echo "============================================="
echo "Supabase Functions Status (last 5 minutes)"
echo "============================================="

for endpoint in items search bookmarks playlists authors collections; do
    response=$(curl -s --max-time 10 "http://localhost:54321/functions/v1/$endpoint?pretty" 2>/dev/null) || true
    
    if [ -n "$response" ]; then
        # Check for errors in the JSON response
        error_count=$(echo "$response" | jq -r 'if has("error") then (.error | length // 0) else 0 end' 2>/dev/null)
        
        status="✅ OK"
        [ $error_count -gt 0 ] && status="⚠️ Errors ($error_count)"
        
        echo "• /$endpoint: $status"
    else
        echo "• /$endpoint: ⏳ Not responding (check if function is deployed/running)"
    fi
done

echo ""
echo "============================================="
