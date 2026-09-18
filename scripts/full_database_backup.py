#!/usr/bin/env python3
"""
Full Database Backup for Audiobookphile Supabase Project
Extracts schemas, custom functions, triggers, RLS policies, tables, and data.
"""

import os
import json
import urllib.request
import urllib.error
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(SCRIPT_DIR)
BACKUP_DIR = os.environ.get("BACKUP_DIR", os.path.join(BACKEND_DIR, "backup_export"))
ENV_PATH = os.environ.get("ENV_PATH", os.path.join(BACKEND_DIR, ".env"))
SUPABASE_PROJECT_ID = os.environ.get("SUPABASE_PROJECT_ID")
if not SUPABASE_PROJECT_ID:
    raise RuntimeError("SUPABASE_PROJECT_ID environment variable is required")

token = None
if os.path.exists(ENV_PATH):
    with open(ENV_PATH) as f:
        for line in f:
            if line.startswith("SUPABASE_ACCESS_TOKEN="):
                token = line.strip().split("=", 1)[1]
                break

if not token:
    raise RuntimeError("SUPABASE_ACCESS_TOKEN not found in .env")

os.makedirs(BACKUP_DIR, exist_ok=True)
print(f"[*] Starting full export for project '{SUPABASE_PROJECT_ID}' -> {BACKUP_DIR}")

def query(sql, timeout=60):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_ID}/database/query",
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
        print(f"[!] Query failed ({e.code}): {err_body[:300]}")
        raise

# 1. Extensions
print("[1/9] Exporting extensions...")
ext_rows = query("SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql');")
ext_sql = "-- Extensions\n"
for r in ext_rows:
    ext_sql += f"CREATE EXTENSION IF NOT EXISTS \"{r['extname']}\" WITH SCHEMA extensions;\n"
with open(os.path.join(BACKUP_DIR, "01_extensions.sql"), "w") as f:
    f.write(ext_sql)

# 2. Table Schemas DDL
print("[2/9] Generating complete Table DDL...")
tables_meta = query("""
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
""")
table_names = [r["table_name"] for r in tables_meta]

columns_meta = query("""
SELECT 
    table_name, 
    column_name, 
    data_type, 
    udt_name,
    is_nullable, 
    column_default,
    character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
""")

cols_by_table = {}
for c in columns_meta:
    cols_by_table.setdefault(c["table_name"], []).append(c)

pks_meta = query("""
SELECT
    tc.table_name, 
    kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
ORDER BY tc.table_name, kcu.ordinal_position;
""")
pks_by_table = {}
for p in pks_meta:
    pks_by_table.setdefault(p["table_name"], []).append(p["column_name"])

schema_sql = "-- Table DDL for public schema\nSET check_function_bodies = false;\n\n"
for tname in sorted(table_names):
    schema_sql += f"CREATE TABLE IF NOT EXISTS public.\"{tname}\" (\n"
    col_defs = []
    for c in cols_by_table.get(tname, []):
        cname = c["column_name"]
        dtype = c["data_type"].upper()
        if dtype == "USER-DEFINED":
            dtype = c["udt_name"]
        elif dtype == "CHARACTER VARYING" and c["character_maximum_length"]:
            dtype = f"VARCHAR({c['character_maximum_length']})"
        elif dtype == "ARRAY":
            dtype = f"{c['udt_name'].lstrip('_')}[]"

        line = f"    \"{cname}\" {dtype}"
        if c["is_nullable"] == "NO":
            line += " NOT NULL"
        if c["column_default"]:
            line += f" DEFAULT {c['column_default']}"
        col_defs.append(line)

    pks = pks_by_table.get(tname, [])
    if pks:
        pk_cols = ", ".join([f'"{pk}"' for pk in pks])
        col_defs.append(f"    CONSTRAINT \"{tname}_pkey\" PRIMARY KEY ({pk_cols})")

    schema_sql += ",\n".join(col_defs)
    schema_sql += "\n);\n\n"

with open(os.path.join(BACKUP_DIR, "02_schema.sql"), "w") as f:
    f.write(schema_sql)

# 3. Foreign Keys & Constraints
print("[3/9] Exporting Foreign Keys and Unique Constraints...")
fks_meta = query("""
SELECT
    tc.constraint_name,
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name,
    rc.update_rule,
    rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints AS rc
    ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';
""")

fk_sql = "-- Foreign Key Constraints\n"
for fk in fks_meta:
    fk_sql += f"""DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{fk["constraint_name"]}') THEN
        ALTER TABLE public.\"{fk["table_name"]}\" 
        ADD CONSTRAINT \"{fk["constraint_name"]}\" 
        FOREIGN KEY (\"{fk["column_name"]}\") 
        REFERENCES public.\"{fk["foreign_table_name"]}\" (\"{fk["foreign_column_name"]}\") 
        ON UPDATE {fk["update_rule"]} ON DELETE {fk["delete_rule"]};
    END IF;
END $$;\n\n"""

with open(os.path.join(BACKUP_DIR, "03_foreign_keys.sql"), "w") as f:
    f.write(fk_sql)

# 4. Indexes
print("[4/9] Exporting Indexes...")
indexes_meta = query("""
SELECT tablename, indexname, indexdef 
FROM pg_indexes 
WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'
ORDER BY tablename, indexname;
""")
index_sql = "-- Indexes for public schema\n"
for idx in indexes_meta:
    index_sql += f"{idx['indexdef']};\n"
with open(os.path.join(BACKUP_DIR, "04_indexes.sql"), "w") as f:
    f.write(index_sql)

# 5. Functions
print("[5/9] Exporting Custom Functions...")
funcs_meta = query("""
SELECT 
    p.proname,
    pg_get_functiondef(p.oid) as definition
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
JOIN pg_language l ON p.prolang = l.oid
WHERE n.nspname = 'public' AND l.lanname IN ('plpgsql', 'sql')
ORDER BY p.proname;
""")

func_sql = "-- Custom Functions in public schema\n"
for fn in funcs_meta:
    func_sql += f"{fn['definition']};\n\n"
with open(os.path.join(BACKUP_DIR, "05_functions.sql"), "w") as f:
    f.write(func_sql)

# 6. Triggers
print("[6/9] Exporting Triggers...")
triggers_meta = query("""
SELECT 
    event_object_table as table_name,
    trigger_name,
    action_timing,
    event_manipulation,
    action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;
""")
trigger_sql = "-- Triggers in public schema\n"
for tg in triggers_meta:
    trigger_sql += f"""CREATE OR REPLACE TRIGGER \"{tg['trigger_name']}\"
{tg['action_timing']} {tg['event_manipulation']} ON public.\"{tg['table_name']}\"
FOR EACH ROW {tg['action_statement']};\n\n"""
with open(os.path.join(BACKUP_DIR, "06_triggers.sql"), "w") as f:
    f.write(trigger_sql)

# 7. RLS Policies
print("[7/9] Exporting Row Level Security (RLS) Policies...")
rls_meta = query("""
SELECT 
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
""")

rls_sql = "-- Row Level Security (RLS) Policies\n"
# Enable RLS on all tables
for tname in sorted(table_names):
    rls_sql += f"ALTER TABLE public.\"{tname}\" ENABLE ROW LEVEL SECURITY;\n"
rls_sql += "\n"

for pol in rls_meta:
    role_str = ", ".join(pol["roles"]) if pol["roles"] else "public"
    cmd = pol["cmd"]
    rls_sql += f"CREATE POLICY \"{pol['policyname']}\" ON public.\"{pol['tablename']}\"\n"
    rls_sql += f"    AS {pol['permissive']}\n"
    rls_sql += f"    FOR {cmd}\n"
    rls_sql += f"    TO {role_str}\n"
    if pol["qual"]:
        rls_sql += f"    USING ({pol['qual']})\n"
    if pol["with_check"]:
        rls_sql += f"    WITH CHECK ({pol['with_check']})\n"
    rls_sql += ";\n\n"

with open(os.path.join(BACKUP_DIR, "07_rls_policies.sql"), "w") as f:
    f.write(rls_sql)

# 8. Auth Users & Identities
print("[8/9] Exporting Auth Users and Identities...")
auth_users = query("""
SELECT 
    id, instance_id, email, encrypted_password, email_confirmed_at,
    invited_at, confirmation_token, confirmation_sent_at, recovery_token,
    recovery_sent_at, email_change_token_new, email_change, email_change_sent_at,
    last_sign_in_at, raw_app_meta_data, raw_user_meta_data, is_super_admin,
    created_at, updated_at, phone, phone_confirmed_at, phone_change,
    phone_change_token, phone_change_sent_at, email_change_token_current,
    email_change_confirm_status, banned_until, reauthentication_token,
    reauthentication_sent_at, is_sso_user, deleted_at, is_anonymous
FROM auth.users;
""")

auth_identities = query("""
SELECT 
    id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at, email
FROM auth.identities;
""")

with open(os.path.join(BACKUP_DIR, "08_auth_users.json"), "w") as f:
    json.dump(auth_users, f, indent=2, default=str)

with open(os.path.join(BACKUP_DIR, "08_auth_identities.json"), "w") as f:
    json.dump(auth_identities, f, indent=2, default=str)

# 9. Public Table Data
print("[9/9] Exporting data from all 32 public tables...")
all_public_data = {}
summary = {
    "project_id": SUPABASE_PROJECT_ID,
    "timestamp": datetime.utcnow().isoformat(),
    "auth_users_count": len(auth_users),
    "auth_identities_count": len(auth_identities),
    "tables": {}
}

# Generate clean restore SQL
restore_sql = """-- Full Public Data Restore
-- Temporarily disable FK triggers for clean batch insertion
SET session_replication_role = 'replica';\n\n"""

for tname in table_names:
    print(f"  -> Exporting table: {tname}...")
    rows = query(f"SELECT * FROM public.\"{tname}\";")
    all_public_data[tname] = rows
    summary["tables"][tname] = len(rows)

    if rows:
        col_list = list(rows[0].keys())
        cols_joined = ", ".join([f'"{c}"' for c in col_list])
        restore_sql += f"-- Table: {tname} ({len(rows)} rows)\n"
        
        # Batch into insert statements
        batch_size = 50
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i+batch_size]
            val_clauses = []
            for row in batch:
                row_vals = []
                for c in col_list:
                    val = row[c]
                    if val is None:
                        row_vals.append("NULL")
                    elif isinstance(val, bool):
                        row_vals.append("TRUE" if val else "FALSE")
                    elif isinstance(val, (int, float)):
                        row_vals.append(str(val))
                    elif isinstance(val, (dict, list)):
                        # JSONB string literal
                        escaped = json.dumps(val).replace("'", "''")
                        row_vals.append(f"'{escaped}'::jsonb")
                    else:
                        escaped = str(val).replace("'", "''")
                        row_vals.append(f"'{escaped}'")
                val_clauses.append("(" + ", ".join(row_vals) + ")")
            
            restore_sql += f"INSERT INTO public.\"{tname}\" ({cols_joined})\nVALUES\n"
            restore_sql += ",\n".join(val_clauses)
            restore_sql += "\nON CONFLICT DO NOTHING;\n\n"

restore_sql += "SET session_replication_role = 'origin';\n"

with open(os.path.join(BACKUP_DIR, "09_data.json"), "w") as f:
    json.dump(all_public_data, f, indent=2, default=str)

with open(os.path.join(BACKUP_DIR, "09_restore_data.sql"), "w") as f:
    f.write(restore_sql)

# Storage buckets
buckets = query("SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets;")
with open(os.path.join(BACKUP_DIR, "10_storage_buckets.json"), "w") as f:
    json.dump(buckets, f, indent=2)

with open(os.path.join(BACKUP_DIR, "summary.json"), "w") as f:
    json.dump(summary, f, indent=2)

print("\n" + "="*60)
print(f"[SUCCESS] Complete database backup finished successfully!")
print(f"Files written to: {BACKUP_DIR}")
print(f"Auth Users: {summary['auth_users_count']}")
for t, count in summary["tables"].items():
    if count > 0:
        print(f" - {t}: {count} rows")
print("="*60)
