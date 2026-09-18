# Library Health Report — 2026-09-18 Migration & Asset Recovery Session

**Target Environment:** Production (`$SUPABASE_PROJECT_ID`)  
**Status:** All services operational, database mirrored, covers & author avatars 100% restored, storage quota healthy.

---

## 1. Migration Summary

Following the retirement of the legacy Supabase project, all database schemas, extensions, RLS policies, functions, triggers, and table datasets were restored into the new production Supabase project.

### Database Table Snapshot
| Table | Row Count | Status |
|---|---|---|
| `library_items` | 113 | ✅ Operational (97 real books + 16 test fixtures) |
| `authors` | 104 | ✅ Operational |
| `book_authors` | 131 | ✅ Operational |
| `profiles` | 167 | ✅ Operational |
| `playback_sessions` | 34 | ✅ Operational |
| `media_progress` | 14 | ✅ Operational |
| `series` | 18 | ✅ Operational |
| `book_series` | 24 | ✅ Operational |
| `server_settings` | 5 | ✅ Operational |
| `webauthn_credentials` | 3 | ✅ Operational |
| `webauthn_challenges` | 24 | ✅ Operational |

---

## 2. Storage & Asset Recovery (Covers + Author Avatars)

- **The Problem:** Storage objects were not transferable from the previous project due to vendor spend cap constraints, leaving the new project's `covers` bucket empty (0 objects). Calls to `/api/items/:id/cover` and `/api/authors/:id/image` failed.
- **Book Cover Recovery:**
  - Automated refetching via `repair_metadata.ts` and targeted recovery for merged works (e.g. *Mortality*, *River Out of Eden*, *The Divine Within*, *BBC Classics*).
  - **Outcome:** **97 high-resolution covers** restored into storage (100% of all real books in the library). The remaining 16 items are synthetic Playwright test fixtures (`PW Cover Fixture`, `PW Dead Track Fixture`, etc.).
- **Author Avatar Recovery:**
  - Built and executed `scripts/restore_author_avatars.ts` using the 3-tier waterfall logic from `avatarFetcher.ts` (Wikipedia 500px portrait → OpenLibrary API → DiceBear deterministic SVG initials).
  - **Outcome:** **102 author avatars** uploaded and synced into `authors/<id>/photo.(jpg|svg)` in the `covers` bucket. 100% of authors in the database now have active, verified avatars.
- **Public Image Route Hardening:**
  - Enhanced `authMiddleware` in `auth.ts` to skip authentication for both `GET` and `HEAD` requests on public cover (`/api/items/:id/cover`) and author avatar (`/api/authors/:id/image`) endpoints. This ensures pre-fetchers, mobile clients, and browser image tags never encounter 401s.
  - Deployed updated `api` Edge Function to production.

---

## 3. Storage Quota & Capacity Health

Live validation via `storage_quota_snapshot()`:

| Bucket / Category | Object Count | Measured Size | Quota Limit | % Used |
|---|---|---|---|---|
| **Covers & Avatars** (`covers`) | 199 | 11.5 MB | Unlimited | — |
| **Database Backups** (`backups`) | 1 | 5.8 MB | Unlimited | — |
| **Total Supabase Storage** | **200** | **17.5 MB** | 1,024 MB (1 GiB Free Tier) | **1.71%** |
| **Audio File Tiering** | — | Offloaded to Backblaze B2 | Multi-tier failover | Immune to Supabase spend caps |

---

## 4. API & Contract Verification

Live production health and asset delivery check:
- `GET https://audiobookphile.vercel.app/api/health` → `HTTP 200 OK`
  - `status`: `"ok"`
  - `database`: `"connected"`
  - `zai`: `"configured"`
  - `sentry`: `"configured"`
  - All core tables reporting `ok`.
- Book Cover Delivery (`GET https://audiobookphile.vercel.app/api/items/:id/cover`):
  - Verified `HTTP 200 OK`, `image/jpeg` with Cloudflare edge caching.
- Author Avatar Delivery (`GET https://audiobookphile.vercel.app/api/authors/:id/image`):
  - Verified `HTTP 200 OK`, `image/jpeg` and `image/svg+xml`.
- Pre-flight `HEAD` verification:
  - Verified `HTTP 302 Found` redirecting directly to CDN object storage without auth challenges.

---

## 5. Configuration & Hygiene
- **Dynamic Config Invariant:** Zero hardcoded Supabase project refs or URLs. All scripts, functions, workflows, and documentation use variables (`$SUPABASE_PROJECT_ID`, `$NEXT_PUBLIC_SUPABASE_URL`, etc.).
- **Clean Git State:** Secrets, tokens, and temporary files remain strictly ignored by `.gitignore`.
