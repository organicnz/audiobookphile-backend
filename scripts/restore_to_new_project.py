#!/usr/bin/env python3
"""
Automated Restore Script for Audiobookphile Supabase Project
Restores schemas, functions, triggers, RLS, auth users, and table data into a new Supabase project.

Usage:
  python3 scripts/restore_to_new_project.py <NEW_PROJECT_REF>
"""

import sys
import os
import json
import urllib.request
import urllib.error

BACKUP_DIR = "/Users/organic/dev/work/audiobookphile/audiobookphile-backend/backup_export"
ENV_PATH = "/Users/organic/dev/work/audiobookphile/audiobookphile-backend/.env"

if len(sys.argv) < 2:
    print("Usage: python3 scripts/restore_to_new_project.py <NEW_PROJECT_REF>")
    sys.exit(1)

NEW_PROJECT_REF = sys.argv[1].strip()

token = None
if os.path.exists(ENV_PATH):
    with open(ENV_PATH) as f:
        for line in f:
            if line.startswith("SUPABASE_ACCESS_TOKEN="):
                token = line.strip().split("=", 1)[1]
                break

if not token:
    raise RuntimeError("SUPABASE_ACCESS_TOKEN not found in .env")

print(f"[*] Restoring backup into new project: {NEW_PROJECT_REF}")

def run_query(sql, timeout=120):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{NEW_PROJECT_REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"[!] Query failed on {NEW_PROJECT_REF} ({e.code}): {err_body[:400]}")
        raise

# Step 1: Extensions
print("\n[1/7] Applying Extensions...")
with open(os.path.join(BACKUP_DIR, "01_extensions.sql")) as f:
    run_query(f.read())
print(" -> Extensions applied.")

# Step 2: Table Schemas
print("\n[2/7] Applying Table DDL Schemas...")
with open(os.path.join(BACKUP_DIR, "02_schema.sql")) as f:
    run_query(f.read())
print(" -> Tables created.")

# Step 3: Functions
print("\n[3/7] Applying Custom Functions...")
with open(os.path.join(BACKUP_DIR, "05_functions.sql")) as f:
    run_query(f.read())
print(" -> Custom functions applied.")

# Step 4: Triggers, Indexes & Foreign Keys
print("\n[4/7] Applying Triggers, Indexes, and Constraints...")
with open(os.path.join(BACKUP_DIR, "04_indexes.sql")) as f:
    run_query(f.read())
with open(os.path.join(BACKUP_DIR, "03_foreign_keys.sql")) as f:
    run_query(f.read())
with open(os.path.join(BACKUP_DIR, "06_triggers.sql")) as f:
    run_query(f.read())
with open(os.path.join(BACKUP_DIR, "07_rls_policies.sql")) as f:
    run_query(f.read())
print(" -> Triggers, Indexes, Foreign Keys, and RLS policies applied.")

# Step 5: Restore Auth Users
print("\n[5/7] Restoring Auth Users and Identities...")
with open(os.path.join(BACKUP_DIR, "08_auth_users.json")) as f:
    users = json.load(f)

for user in users:
    cols = []
    vals = []
    for k, v in user.items():
        if k == "is_anonymous": # Ignore generated/virtual if not in target
            continue
        cols.append(f'"{k}"')
        if v is None:
            vals.append("NULL")
        elif isinstance(v, bool):
            vals.append("TRUE" if v else "FALSE")
        elif isinstance(v, (int, float)):
            vals.append(str(v))
        elif isinstance(v, (dict, list)):
            escaped = json.dumps(v).replace("'", "''")
            vals.append(f"'{escaped}'::jsonb")
        else:
            escaped = str(v).replace("'", "''")
            vals.append(f"'{escaped}'")
    
    col_str = ", ".join(cols)
    val_str = ", ".join(vals)
    sql = f"INSERT INTO auth.users ({col_str}) VALUES ({val_str}) ON CONFLICT (id) DO NOTHING;"
    run_query(sql)

with open(os.path.join(BACKUP_DIR, "08_auth_identities.json")) as f:
    identities = json.load(f)

for ident in identities:
    cols = []
    vals = []
    for k, v in ident.items():
        cols.append(f'"{k}"')
        if v is None:
            vals.append("NULL")
        elif isinstance(v, (dict, list)):
            escaped = json.dumps(v).replace("'", "''")
            vals.append(f"'{escaped}'::jsonb")
        else:
            escaped = str(v).replace("'", "''")
            vals.append(f"'{escaped}'")
    col_str = ", ".join(cols)
    val_str = ", ".join(vals)
    sql = f"INSERT INTO auth.identities ({col_str}) VALUES ({val_str}) ON CONFLICT (id) DO NOTHING;"
    run_query(sql)

print(f" -> Restored {len(users)} auth users and {len(identities)} identities.")

# Step 6: Restore Public Data
print("\n[6/7] Restoring Public Table Data...")
with open(os.path.join(BACKUP_DIR, "09_restore_data.sql")) as f:
    restore_sql = f.read()

# Chunk into manageable batches of SQL statements
statements = [s.strip() for s in restore_sql.split(";\n\n") if s.strip()]
print(f" -> Total batches to execute: {len(statements)}")
run_query("SET session_replication_role = 'replica';")
for idx, stmt in enumerate(statements, 1):
    if not stmt.endswith(";"):
        stmt += ";"
    run_query(stmt)
    if idx % 10 == 0 or idx == len(statements):
        print(f"    Executed batch {idx}/{len(statements)}...")
run_query("SET session_replication_role = 'origin';")
print(" -> Public table data restored successfully.")

# Step 7: Storage Buckets
print("\n[7/7] Re-creating Storage Buckets...")
with open(os.path.join(BACKUP_DIR, "10_storage_buckets.json")) as f:
    buckets = json.load(f)

for b in buckets:
    bid = b["id"]
    bname = b["name"]
    public = "TRUE" if b["public"] else "FALSE"
    sql = f"""
    INSERT INTO storage.buckets (id, name, public) 
    VALUES ('{bid}', '{bname}', {public}) 
    ON CONFLICT (id) DO NOTHING;
    """
    run_query(sql)
print(" -> Storage buckets created.")

print("\n" + "="*60)
print(f"[SUCCESS] Complete database restoration finished on {NEW_PROJECT_REF}!")
print("Next steps:")
print(f" 1. Deploy Edge Functions: bunx supabase functions deploy api --project-ref {NEW_PROJECT_REF}")
print(f" 2. Run cover sync: deno run --allow-all sync_covers.ts")
print(f" 3. Update environment variables in .env and .env.local")
print("="*60)
