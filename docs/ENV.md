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

## Sentry observability (backend)

| Variable     | Where it lives                     | How it is read                         |
| ------------ | ---------------------------------- | -------------------------------------- |
| `SENTRY_DSN` | Supabase Vault (name `SENTRY_DSN`) | Edge Function → `public.read_secret()` |
| `NODE_ENV`   | Supabase Edge Function secret      | `Deno.env.get("NODE_ENV")`             |

- `SENTRY_DSN` is provisioned idempotently by the deploy workflow
  (`Provision Sentry Vault Secret` step, Management API SQL) from the
  `SENTRY_DSN` GitHub Actions secret. It is stored encrypted at rest in
  `vault.secrets` and never written to env vars in production.
- The `public.read_secret()` reader function is created by
  `supabase/migrations/20260820030000_vault_secret_reader.sql` — a
  security-definer RPC executable only by `service_role` / `postgres`.
- `NODE_ENV=production` is an Edge Function secret
  (`Ensure Edge Function
  Secrets` step, equivalent to
  `supabase secrets set NODE_ENV=production`) and gates the structured-logging +
  Sentry metrics/error-capture middleware.
- Local dev: export `SENTRY_DSN` (and optionally `NODE_ENV=production`) in your
  shell before `supabase functions serve` — the env var takes precedence over
  Vault in `_shared/sentry.ts`. Without it Sentry stays disabled locally.
  `supabase/config.toml` intentionally has no `[functions.api] env` map:
  `supabase config push` only accepts `env(VAR)` references, and inline strings
  break its parser.

### Error-remediation workflow (`error-remediation.yml`)

Runs daily at 03:00 UTC (plus `workflow_dispatch`). Needs these GitHub Actions
secrets on `organicnz/audiobookphile-backend` (workflow warns and skips while
missing):

| Secret              | Value                                          |
| ------------------- | ---------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | Sentry user/API token with `issue:write`       |
| `SENTRY_ORG`        | `organicnz` (see dashboard URL)                |
| `SENTRY_PROJECT`    | `audiobookphile` (project ID 4511573264236624) |
| `ZAI_API_KEY`       | Zhipu GLM API key for patch generation         |

It creates draft PRs (`bot/fix-sentry-*`) and never merges; progress is tracked
on the `sentry-checkpoint` branch. For local testing see the script header
(`DRY_RUN`, `SENTRY_API`, `ZAI_URL` overrides).
