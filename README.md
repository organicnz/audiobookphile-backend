# Audiobookphile Backend 🗄️

The official Supabase backend for the Audiobookphile ecosystem. This repository
contains the PostgreSQL database schema, Row Level Security (RLS) policies, and
Deno Edge Functions that power the web and mobile clients.

## Tech Stack

- **Database**: [Supabase PostgreSQL](https://supabase.com)
- **Functions**: Deno Edge Functions
- **Local Dev**: [Bun](https://bun.sh) / Supabase CLI
- **Formatting**: Prettier / Deno

## Setup

Ensure you have the Supabase CLI installed, or use `bunx supabase`.

```bash
# Install dependencies (for local script execution)
bun install

# Start local Supabase instance
bunx supabase start
```

## Structure

- `supabase/migrations/`: Contains all SQL migrations defining tables,
  functions, and RLS policies.
- `supabase/functions/`: Deno Edge Functions for advanced logic (metadata
  scraping, semantic search, B2 upload presigning).
- `supabase/config.toml`: Local Supabase configuration.

## Deployment

Deployments are handled automatically via GitHub Actions when pushing to the
`main` branch.

To deploy manually:

```bash
bunx supabase link --project-ref <your-project-id>
bunx supabase db push
bunx supabase functions deploy
```

## Contributing

Pull requests are welcome. Ensure that all new edge functions are formatted and
pass Deno lint checks.
