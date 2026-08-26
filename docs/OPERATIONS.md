# Operations Runbook

Production project: `iambzzclljayqdxkeepy` · Edge API: `https://iambzzclljayqdxkeepy.supabase.co/functions/v1/api`

## Workflows (self-hosted macOS runner)

| Workflow | Trigger | What it does |
|---|---|---|
| `deploy-backend.yml` | push to `main` touching `supabase/**` | secret scan → migrate → deploy edge → hurl/schemathesis/smoke → **Playwright API e2e** |
| `daily-compat.yml` | cron 04:15 UTC + manual | L1 unit · L2 SQL merge-safety · L3 Playwright · AI adversarial probe · AI cover audit · AI code review; artifacts in `reports/` |
| `nightly-audit.yml` | cron 03:00 UTC + manual | read-only merged/corrupted library detector, report artifact |
| `backup-cron.yml` | nightly | automated DB backup |
| `repair-covers.yml` | manual | identity-gated cover refetch for explicit item ids |

If the self-hosted runner's Docker Desktop is not running, deploy fails at
TruffleHog — the workflow now auto-starts it (`Ensure Docker` step).

## Feature flags & settings

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `auto_dedupe_enabled` | `server_settings` (key/value jsonb) | `false` | hourly dedupe cron is a **no-op** until this is `true`. Before enabling: review `merge_two_library_items` tie-breaks and check `SELECT * FROM plan_library_item_merges()` output. Enable: `UPDATE server_settings SET value='true' WHERE key='auto_dedupe_enabled';` |
| `ZAI_MODEL` | edge function secret | `glm-4.5-air` | chat model for all z.ai features (thinking disabled internally) |
| `ZAI_EMBEDDING_MODEL` | edge function secret | `embedding-3` | semantic search embeddings. z.ai retired embedding-2/3 → endpoint returns 5xx until a valid model is configured |
| `COVER_VISION_MODEL` / `AI_PROBE_*` / `AI_REVIEW_*` | GH secrets/env | glm-4.5v / gpt-oss-120b / glm-4.6 | model overrides for AI jobs |

## Audit trails

- `library_item_deletion_audit` — every `library_items` DELETE (who/when/what)
- `library_item_merge_audit` — every dedupe merge with pass/reason

Investigate surprises:
```sql
SELECT * FROM library_item_deletion_audit ORDER BY deleted_at DESC LIMIT 20;
SELECT * FROM library_item_merge_audit   ORDER BY merged_at   DESC LIMIT 20;
```

## Common operations

```bash
# Dry-run metadata/title repairs across the library
deno run --allow-all supabase/functions/repair_metadata.ts
# Apply targeted cover refetch (identity-gated)
deno run --allow-all supabase/functions/repair_metadata.ts --apply --covers-only --ids <uuid,uuid>
# Read-only duplicate plan (what would auto-dedupe do right now?)
# -> SELECT * FROM plan_library_item_merges();
```

## Known states

- **86 legacy imports have no audio bytes** (2023-era files never migrated off
  the original filesystem). They cannot play until re-uploaded through the app
  (`reports/reupload-needed-2026-08-25.csv`). Originals are believed to live in
  Mail.ru Cloud via Disk-O.
- 8 items hold honest **placeholder covers** (no verifiable public art).
  The daily cover audit will auto-fill if art ever becomes available.
- Edge secret `SUPABASE_SERVICE_ROLE_KEY` is platform-injected; the literal
  service-role bypass in `_shared/auth.ts` does not match it — cron endpoints
  use `CRON_SECRET` instead. Harmless, but rotate deliberately if touched.
