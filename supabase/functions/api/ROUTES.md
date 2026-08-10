# API Route Authorization Inventory

Last audited: 2026-08-10 (P0.2 authorization sweep)

Every mutating/server-global endpoint must have an explicit owner: **self** (RLS-protected,
user-scoped), **admin** (`requireAdminRole` — admin or root, DB-fresh per request), or
**public** (documented). Auth middleware runs on all routes except `publicAuthRoutes`.

## Admin-only (requireAdminRole enforced)

| Router | Endpoints |
|---|---|
| users.ts | GET `/`, POST `/`, PATCH `/ :id` (role changes never on self), DELETE `/ :id` (self allowed) |
| libraries.ts | POST `/`, PATCH `/ :id`, DELETE `/ :id`, POST `/ :id/scan`, `/ :id/smart-sort`, `/ :id/deduplicate` |
| settings.ts | **whole router** — filesystem, backups, api-keys, sessions, feeds, shares, genres, tags, storage-sync, backup-database |
| metadata.ts | **whole router** — mounted bare under `/api`; real paths: PATCH/DELETE `/api/narrators/:id`, DELETE `/api/tags/:id`, DELETE `/api/genres/:id`, POST `/api/match-book`, POST `/api/scrape-metadata`, POST `/api/metadata/scrape` |
| authors.ts | PATCH `/ :id`, DELETE `/ :id`, POST `/ :id/match`, POST `/ :id/image`, DELETE `/ :id/image`, POST `/sync-authors` |
| items.ts | DELETE `/ :id/cover`, POST/PATCH `/ :id/cover`, sync-covers, sync-durations, sync-insights |
| downloads.ts | POST `/upload-presign`, POST `/upload/presign` |
| migrateBatch.ts | POST `/` |
| admin.ts | **whole router** — GET `/api/admin/analytics`, `/api/admin-analytics` |
| auth.ts | POST `/invite` |

## Authenticated user (self-scoped via RLS / user.id filter)

playback.ts (all session ops), progress.ts (me/*), bookmarks.ts (me/*), search.ts history,
users.ts `/me/preferences`, twoFactor.ts (enroll/verify/disable — self), playlists.ts,
collections.ts, items.ts GET `/batch` (own progress only).

## Authenticated user — AI/cost features (user-facing by design)

aiService.ts `POST /api/ai/insights`, items.ts `handleChapterAI` (`/api/chapter-ai`,
`/api/items/:id/chapters/ai`), search.ts `/smart`, `/semantic`, `/search-semantic`,
`/generate-embedding`. Cache-gated (book_insights) to bound cost. Revisit if quota abuse.

## Public (auth-skipped)

`/api/health`, login/refresh/authorize/logout/forgot/reset/change-password/magic-link/verify/
verify-token/signup, cover & author images (GET).

## Notes / debt

- items.ts DELETE `/ :id/audio-files/:ino` uses an inline admin|root DB check — migrate to
  `requireAdminRole` next pass.
- `GET /api/users` remains the only admin-gated read on the user list — keep behind admin.
- Route inventory should be re-verified whenever a new mutating handler is added
  (add to lefthook `inspect` guard: require an explicit owner comment in diff).
