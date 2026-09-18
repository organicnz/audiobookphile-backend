#!/bin/bash
# Automatically populate or refresh Supabase environment variables in .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${BACKEND_DIR}/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "Creating new .env at ${ENV_FILE}"
    touch "$ENV_FILE"
fi

# Run python helper to sync live keys from Supabase Management API if access token is present
python3 - <<EOF
import os, json, urllib.request

env_file = "$ENV_FILE"
env = {}
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v.strip().strip("'\"")

token = env.get("SUPABASE_ACCESS_TOKEN") or os.environ.get("SUPABASE_ACCESS_TOKEN")
project_id = env.get("SUPABASE_PROJECT_ID") or os.environ.get("SUPABASE_PROJECT_ID")

if not project_id:
    print("Notice: SUPABASE_PROJECT_ID not set. Please set it in .env or environment.")
    exit(0)

supabase_url = f"https://{project_id}.supabase.co"
anon_key = env.get("SUPABASE_ANON_KEY", "")
service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")

if token:
    try:
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{project_id}/api-keys",
            headers={"Authorization": f"Bearer {token}"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            keys = json.loads(resp.read().decode())
            for k in keys:
                if k.get("name") == "anon" and not anon_key:
                    anon_key = k.get("api_key")
                elif k.get("name") == "service_role" and not service_key:
                    service_key = k.get("api_key")
        print("✓ Successfully retrieved active API keys from Supabase Management API")
    except Exception as e:
        print(f"Notice: Could not fetch keys automatically from Management API: {e}")

lines = []
if os.path.exists(env_file):
    with open(env_file) as f:
        lines = f.readlines()

new_lines = []
found_url = False
found_anon = False
found_service = False

for line in lines:
    if line.startswith("SUPABASE_URL=") or line.startswith("NEXT_PUBLIC_SUPABASE_URL="):
        new_lines.append(f"SUPABASE_URL={supabase_url}\n")
        found_url = True
    elif line.startswith("SUPABASE_ANON_KEY=") or line.startswith("NEXT_PUBLIC_SUPABASE_ANON_KEY="):
        if anon_key:
            new_lines.append(f"SUPABASE_ANON_KEY={anon_key}\n")
        else:
            new_lines.append(line)
        found_anon = True
    elif line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
        if service_key:
            new_lines.append(f"SUPABASE_SERVICE_ROLE_KEY={service_key}\n")
        else:
            new_lines.append(line)
        found_service = True
    else:
        new_lines.append(line)

if not found_url:
    new_lines.append(f"SUPABASE_URL={supabase_url}\n")
if not found_anon and anon_key:
    new_lines.append(f"SUPABASE_ANON_KEY={anon_key}\n")
if not found_service and service_key:
    new_lines.append(f"SUPABASE_SERVICE_ROLE_KEY={service_key}\n")

with open(env_file, "w") as f:
    f.writelines(new_lines)
print(f"✓ Synchronized {env_file}")
EOF

# Ensure .env.local exists for local development with restricted permissions
LOCAL_ENV="${BACKEND_DIR}/.env.local"
if [ ! -f "$LOCAL_ENV" ]; then
    cp "$ENV_FILE" "$LOCAL_ENV"
    chmod 600 "$LOCAL_ENV"
    echo "✓ Created .env.local from .env"
fi

echo "✓ Supabase configuration verified."
