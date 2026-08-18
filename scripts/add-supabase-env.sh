#!/bin/bash
# Add missing Supabase environment variables to .env

ENV_FILE=".env"

if grep -q "^SUPABASE_URL=" "$ENV_FILE"; then
    echo "✓ SUPABASE_URL already present in .env"
else
    sed -i '/^SUPABASE_PROJECT_ID=/a SUPABASE_URL=https://iambzzclljayqdxkeepy.supabase.co\nSUPABASE_ANON_KEY=your_anon_key_here' "$ENV_FILE"
    echo "✓ Added SUPABASE_URL and SUPABASE_ANON_KEY to .env"
fi

if grep -q "^ZAI_API_KEY=" ".env"; then
    echo "✓ ZAI_API_KEY already present in .env"
else
    sed -i '/^SUPABASE_PROJECT_ID=/a ZAI_API_KEY=your_zai_api_key_here' ".env" 2>/dev/null || true
    echo "✓ Added ZAI_API_KEY placeholder to .env"
fi

if grep -q "^HIPPU_AI_API_KEY=" ".env"; then
    echo "✓ HIPPU_AI_API_KEY already present in .env"
else
    sed -i '/^ZAI_API_KEY=/a HIPPU_AI_API_KEY=your_hippu_ai_api_key_here' ".env" 2>/dev/null || true
    echo "✓ Added HIPPU_AI_API_KEY placeholder to .env"
fi

# Create .env.local if it doesn't exist for local development
if [ ! -f audiobookphile-backend/.env.local ]; then
    cp audiobookphile-backend/.env audiobookphile-backend/.env.local
    chmod 600 audiobookphile-backend/.env.local
    echo "✓ Created .env.local from .env"
fi

echo ""
echo "--- Current Supabase config ---"
grep -E "^SUPABASE_URL|^SUPABASE_ANON_KEY|ZAI_API_KEY|HIPPU_AI_API_KEY" ".env" | head -10 || echo "(not found)"
