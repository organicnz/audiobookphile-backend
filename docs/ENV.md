# Environment Variables (Single Source of Truth)

All per-repo env values originate here in the backend repo — one canonical file:

| File            | Meaning                               |
| --------------- | ------------------------------------- |
| `env/local.env` | Local development + local Maestro E2E |

It is divided into `# [backend]`, `# [web]`, and `# [maestro]` sections. Secrets
(`SUPABASE_ACCESS_TOKEN`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_POSTHOG_KEY`, Maestro test credentials, ...) are stored blank.
Production and CI values live on the platforms, never in this repo:

- Web prod / preview env vars — Vercel project settings
- Edge Function secrets (B2, 2FA signing key, cron secret, AI keys) — Supabase
- Maestro CI envs — GitHub Actions secrets (`mobile-e2e.yml`)

## Generating per-repo env files

```bash
./scripts/sync-env.sh
```

This writes:

| Repo                   | File                                  |
| ---------------------- | ------------------------------------- |
| audiobookphile-backend | `.env` (Supabase CLI / local scripts) |
| audiobookphile-web     | `.env.local`                          |
| audiobookphile-app     | `.maestro/.env` (Maestro E2E)         |

Merge semantics: non-blank canonical values always win; blank canonical values
preserve whatever is already set in the target file, so locally-filled secrets
survive re-syncs. All generated files are gitignored.

## Changing a variable

1. Edit the matching section in `env/local.env`.
2. Re-run `./scripts/sync-env.sh`.
3. If it changed in production too, update the value in Vercel / Vault / Edge
   Function secrets.
