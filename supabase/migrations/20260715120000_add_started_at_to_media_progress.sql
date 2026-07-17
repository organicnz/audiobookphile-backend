-- Add started_at to media_progress (first-play timestamp).
--
-- The mapper (api/mappers.ts) and all clients already model a `startedAt`
-- field, but no such column existed in the DB, so it was faked from
-- created_at/last_update. This adds the real column.
--
-- Preserved across subsequent progress upserts: the upsert payload in
-- _shared/progress.ts excludes started_at, so the DEFAULT only applies on
-- the INSERT path of ON CONFLICT (set-on-first-play, never overwritten).
ALTER TABLE public.media_progress
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- Backfill existing rows from last_update (best available proxy for first play).
UPDATE public.media_progress
  SET started_at = last_update
  WHERE started_at IS NULL;

-- New inserts get now() via default; conflict-updates leave the existing value.
ALTER TABLE public.media_progress
  ALTER COLUMN started_at SET DEFAULT now();
