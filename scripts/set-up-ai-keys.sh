#!/bin/bash
# Set up AI API keys (replace with your actual keys)

echo "🔑 Setting up AI API keys..."

if [ -f .env.local ]; then
    echo ".env.local already exists"
else
    cat > .env.local << 'ENVFILE'
# Local environment — DO NOT commit to git
ZAI_API_KEY=your_zai_api_key_here
HIPPU_AI_API_KEY=your_hippu_ai_api_key_here  
ZHIPU_API_KEY=your_zhipu_api_key_here
ENVFILE
    
    echo "Created .env.local with placeholders"
fi

# If keys are already set, verify them
if [ -f .env.local ]; then
    if grep -q "ZAI_API_KEY=" .env.local; then
        echo "✅ ZAI API key configured in .env.local"
    else
        echo "⚠️  No ZAI API key found in .env.local — functions will fail without it"
    fi
    
    if grep -q "HIPPU_AI_API_KEY=" .env.local; then
        echo "✅ HIPPU AI API key configured in .env.local"
    else
        echo "⚠️  No HIPPU AI API key found in .env.local — functions will fail without it"
    fi
fi

echo ""
echo "To deploy Supabase functions, run:"
cd supabase/functions
bunx supabase functions deploy
