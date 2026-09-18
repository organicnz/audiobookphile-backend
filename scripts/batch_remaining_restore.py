#!/usr/bin/env python3
import os
import json
import time
import urllib.request
import urllib.error

ENV_PATH = "/Users/organic/dev/work/audiobookphile/audiobookphile-backend/.env"
BACKUP_DIR = "/Users/organic/dev/work/audiobookphile/audiobookphile-backend/backup_export"
NEW_PROJECT_REF = "kfidobawnbziftwxavyl"

token = None
with open(ENV_PATH) as f:
    for line in f:
        if line.startswith("SUPABASE_ACCESS_TOKEN="):
            token = line.strip().split("=", 1)[1]
            break

def run_query_with_retry(sql, max_retries=5):
    for attempt in range(max_retries):
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
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait_time = (attempt + 1) * 10
                print(f"[429] Rate limited. Waiting {wait_time}s before retry {attempt+1}/{max_retries}...")
                time.sleep(wait_time)
                continue
            err_msg = e.read().decode()
            print(f"[!] Error {e.code}: {err_msg[:400]}")
            raise
    raise RuntimeError("Max retries exceeded")

with open(os.path.join(BACKUP_DIR, "09_data.json")) as f:
    data = json.load(f)

# 1. Batch Insert Profiles
profiles = data.get("profiles", [])
print(f"Preparing batch insert for {len(profiles)} profiles...")

prof_cols = list(profiles[0].keys())
prof_cols_joined = ", ".join([f'"{c}"' for c in prof_cols])

val_clauses = []
for p in profiles:
    row_vals = []
    for c in prof_cols:
        v = p.get(c)
        if v is None:
            row_vals.append("NULL")
        elif c == "two_factor_methods":
            if isinstance(v, list):
                escaped_items = ["'" + str(x).replace("'", "''") + "'" for x in v]
                row_vals.append("ARRAY[" + ", ".join(escaped_items) + "]::text[]")
            else:
                row_vals.append("NULL")
        elif isinstance(v, bool):
            row_vals.append("TRUE" if v else "FALSE")
        elif isinstance(v, (int, float)):
            row_vals.append(str(v))
        elif isinstance(v, (dict, list)):
            escaped = json.dumps(v).replace("'", "''")
            row_vals.append(f"'{escaped}'::jsonb")
        else:
            escaped = str(v).replace("'", "''")
            row_vals.append(f"'{escaped}'")
    val_clauses.append("(" + ", ".join(row_vals) + ")")

profiles_sql = f"""
SET search_path TO public, extensions;
SET session_replication_role = 'replica';
INSERT INTO public.profiles ({prof_cols_joined})
VALUES
{',\n'.join(val_clauses)}
ON CONFLICT (id) DO NOTHING;
SET session_replication_role = 'origin';
"""

# print("Executing single batch insert for all profiles...")
# run_query_with_retry(profiles_sql)
# print("Profiles batch completed.")
# time.sleep(2)

# 2. Batch Insert Other 3 Tables
insights = data.get("book_insights", [])
settings = data.get("server_settings", [])
creds = data.get("webauthn_credentials", [])

misc_sql = "SET search_path TO public, extensions;\nSET session_replication_role = 'replica';\n"

if insights:
    ins_cols = list(insights[0].keys())
    ins_cols_joined = ", ".join([f'"{c}"' for c in ins_cols])
    i_vals = []
    for item in insights:
        row_vals = []
        for c in ins_cols:
            v = item.get(c)
            if v is None:
                row_vals.append("NULL")
            elif c in ("key_takeaways", "themes"):
                if isinstance(v, list):
                    escaped_items = ["'" + str(x).replace("'", "''") + "'" for x in v]
                    row_vals.append("ARRAY[" + ", ".join(escaped_items) + "]::text[]")
                else:
                    row_vals.append("NULL")
            elif isinstance(v, bool):
                row_vals.append("TRUE" if v else "FALSE")
            elif isinstance(v, (int, float)):
                row_vals.append(str(v))
            elif isinstance(v, (dict, list)):
                escaped = json.dumps(v).replace("'", "''")
                row_vals.append(f"'{escaped}'::jsonb")
            else:
                escaped = str(v).replace("'", "''")
                row_vals.append(f"'{escaped}'")
        i_vals.append("(" + ", ".join(row_vals) + ")")
    misc_sql += f"INSERT INTO public.book_insights ({ins_cols_joined}) VALUES {','.join(i_vals)} ON CONFLICT (book_id) DO NOTHING;\n"

if settings:
    sett_cols = list(settings[0].keys())
    sett_cols_joined = ", ".join([f'"{c}"' for c in sett_cols])
    s_vals = []
    for s in settings:
        row_vals = []
        for c in sett_cols:
            v = s.get(c)
            if v is None:
                row_vals.append("NULL")
            elif c == "value":
                escaped = json.dumps(v).replace("'", "''")
                row_vals.append(f"'{escaped}'::jsonb")
            elif isinstance(v, bool):
                row_vals.append("TRUE" if v else "FALSE")
            elif isinstance(v, (int, float)):
                row_vals.append(str(v))
            elif isinstance(v, (dict, list)):
                escaped = json.dumps(v).replace("'", "''")
                row_vals.append(f"'{escaped}'::jsonb")
            else:
                escaped = str(v).replace("'", "''")
                row_vals.append(f"'{escaped}'")
        s_vals.append("(" + ", ".join(row_vals) + ")")
    misc_sql += f"INSERT INTO public.server_settings ({sett_cols_joined}) VALUES {','.join(s_vals)} ON CONFLICT (key) DO NOTHING;\n"

if creds:
    cred_cols = list(creds[0].keys())
    cred_cols_joined = ", ".join([f'"{c}"' for c in cred_cols])
    c_vals = []
    for c in creds:
        row_vals = []
        for col in cred_cols:
            v = c.get(col)
            if v is None:
                row_vals.append("NULL")
            elif col == "transports":
                if isinstance(v, list):
                    escaped_items = ["'" + str(x).replace("'", "''") + "'" for x in v]
                    row_vals.append("ARRAY[" + ", ".join(escaped_items) + "]::text[]")
                else:
                    row_vals.append("NULL")
            elif isinstance(v, bool):
                row_vals.append("TRUE" if v else "FALSE")
            elif isinstance(v, (int, float)):
                row_vals.append(str(v))
            elif isinstance(v, (dict, list)):
                escaped = json.dumps(v).replace("'", "''")
                row_vals.append(f"'{escaped}'::jsonb")
            else:
                escaped = str(v).replace("'", "''")
                row_vals.append(f"'{escaped}'")
        c_vals.append("(" + ", ".join(row_vals) + ")")
    misc_sql += f"INSERT INTO public.webauthn_credentials ({cred_cols_joined}) VALUES {','.join(c_vals)} ON CONFLICT (id) DO NOTHING;\n"

misc_sql += "SET session_replication_role = 'origin';\n"

print("Executing single batch insert for insights, settings, and credentials...")
run_query_with_retry(misc_sql)
print("Misc batch completed.")
time.sleep(2)

# 3. Create Storage Buckets
print("Creating Storage Buckets...")
buckets_sql = """
INSERT INTO storage.buckets (id, name, public) VALUES 
('covers', 'covers', true),
('audio-files', 'audio-files', false),
('backups', 'backups', false)
ON CONFLICT (id) DO NOTHING;
"""
run_query_with_retry(buckets_sql)
print("Storage buckets ready.")

# 4. Verification Check
res = run_query_with_retry("""
SELECT relname as table_name, n_live_tup as row_count 
FROM pg_stat_user_tables 
WHERE schemaname = 'public' 
ORDER BY n_live_tup DESC;
""")

print("\n" + "="*50)
print("CURRENT ROW COUNTS IN NEW PROJECT:")
print("="*50)
for r in res:
    if r['row_count'] > 0:
        print(f" - {r['table_name']}: {r['row_count']} rows")
print("="*50)
