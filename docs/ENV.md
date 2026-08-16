# Environment Variables (Single Source of Truth)

All per-repo env values originate here in the backend repo. There are exactly
two canonical files:

| File | Meaning |
| --- | --- |
| `env/local.env` | Local development (localhost origins) |
| `env/prod.env` | Production-shaped values (audiobookphile.vercel.app) |

Each file is divided into `# [backend]`, `# [web]`, and `# [maestro]` sections.
Secrets (`SUPABASE_ACCESS_TOKEN`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_POSTHOG_KEY`, Maestro test credentials, ...) are stored blank and
configured in the platform instead: Vercel project env vars (web), Supabase
Vault, and Supabase Edge Function secrets.

## Generating per-repo env files

```bash
./scripts/sync-env.sh         # local development
./scripts/sync-env.sh --prod  # production-shaped
```

This writes:

| Repo | File |
| --- | --- |
| audiobookphile-backend | `.env` (Supabase CLI / local scripts) |
| audiobookphile-web | `.env.local` |
| audiobookphile-app | `.maestro/.env` (Maestro E2E) |

Merge semantics: non-blank canonical values always win; blank canonical values
preserve whatever is already set in the target file, so locally-filled secrets
survive re-syncs. All generated files are gitignored.

## Changing a variable

1. Edit the matching section in `env/local.env` (and `env/prod.env` if it
   should change in production).
2. Re-run `./scripts/sync-env.sh [--prod]`.
3. For prod, also update the value in Vercel / Vault / Edge Function secrets.
