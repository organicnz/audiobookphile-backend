-- Migration: Fix media_progress schema
--
-- Problems addressed:
--   1. Missing columns: hide_from_continue_listening, finished_at, started_at
--      were modelled in code and types but never applied to production.
--   2. Type mismatch: library_item_id and episode_id were TEXT; library_items.id
--      is UUID. PostgREST cannot establish a real FK relationship across type
--      boundaries, so !inner joins and embedding silently dropped rows.
--   3. No FK: without a real FK PostgREST's relationship discovery didn't work
--      for media_progress → library_items, causing the !inner join filter
--      .eq("library_items.library_id", id) to silently exclude most rows.
--   4. Duplicate unique indexes: two overlapping indexes existed with slightly
--      different semantics; collapsed to one NULLS NOT DISTINCT index.
--   5. Orphaned rows: 14 of 18 progress rows referenced library_items that
--      no longer exist (legacy data from a previous ABS instance). Deleted —
--      there is nothing to resume for items that don't exist.
--   6. No covering indexes for the Continue Listening / Listen Again queries.

-- ── 1. Add missing columns ──────────────────────────────────────────────────
ALTER TABLE public.media_progress
  ADD COLUMN IF NOT EXISTS hide_from_continue_listening boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS finished_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS started_at                   timestamptz DEFAULT now();

-- Backfill started_at for existing rows using last_update as best proxy
UPDATE public.media_progress
  SET started_at = last_update
  WHERE started_at IS NULL;

-- ── 2. Delete orphaned rows ──────────────────────────────────────────────────
-- Must happen BEFORE the type cast so we can still join on ::text for the check,
-- and before adding the FK so there are no dangling references.
DELETE FROM public.media_progress mp
  WHERE NOT EXISTS (
    SELECT 1 FROM public.library_items li WHERE li.id::text = mp.library_item_id
  );

-- ── 3. Drop old unique constraints (recreated below with better semantics) ───
ALTER TABLE public.media_progress
  DROP CONSTRAINT IF EXISTS media_progress_user_item_episode_unique;

ALTER TABLE public.media_progress
  DROP CONSTRAINT IF EXISTS media_progress_user_id_library_item_id_episode_id_key;

-- ── 4. Cast TEXT columns to UUID ─────────────────────────────────────────────
ALTER TABLE public.media_progress
  ALTER COLUMN library_item_id TYPE uuid USING library_item_id::uuid;

ALTER TABLE public.media_progress
  ALTER COLUMN episode_id TYPE uuid USING episode_id::uuid;

-- ── 5. Add FK: media_progress → library_items (ON DELETE CASCADE) ────────────
ALTER TABLE public.media_progress
  ADD CONSTRAINT media_progress_library_item_id_fkey
    FOREIGN KEY (library_item_id)
    REFERENCES public.library_items(id)
    ON DELETE CASCADE;

-- ── 6. Canonical unique constraint with NULLS NOT DISTINCT (Postgres 15+) ────
-- Ensures (user, book, NULL episode) is treated as one row, not unbounded dupes
ALTER TABLE public.media_progress
  ADD CONSTRAINT media_progress_user_item_episode_uq
    UNIQUE NULLS NOT DISTINCT (user_id, library_item_id, episode_id);

-- ── 7. Covering indexes for personalized endpoint hot paths ──────────────────
-- Continue Listening: WHERE user_id=$1 AND is_finished=false
--   AND hide_from_continue_listening=false AND episode_id IS NULL
--   ORDER BY last_update DESC
CREATE INDEX IF NOT EXISTS idx_media_progress_continue_listening
  ON public.media_progress (user_id, is_finished, hide_from_continue_listening, last_update DESC)
  WHERE episode_id IS NULL;

-- Listen Again: WHERE user_id=$1 AND is_finished=true AND episode_id IS NULL
--   ORDER BY last_update DESC
CREATE INDEX IF NOT EXISTS idx_media_progress_listen_again
  ON public.media_progress (user_id, is_finished, last_update DESC)
  WHERE episode_id IS NULL;
