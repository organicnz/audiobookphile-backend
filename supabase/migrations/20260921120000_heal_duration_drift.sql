-- Heal Dark Psychology-class duration drift: library_items.duration must equal
-- SUM(audio_files[] track durations). Legacy SQLite imports and the old
-- upload-finalize path (which preserved stale totals while writing 0 per-track
-- durations) left rows like 281072s (~78h) whose tracks sum to ~72115s (~20h).
-- AVPlayer then seeks past EOF and the scrubber snaps to 0/100%.
--
-- Ground truth lives in audio_files (metadata.duration wins, else duration),
-- mirroring parseTrackDuration() in supabase/functions/_shared/invariants.ts.
-- This backfill is idempotent: only rows with a sane sum (>0, <=40h cap
-- MAX_ITEM_DURATION_S) that drift >1s from the stored total are touched.
-- Unknowns (all-zero tracks) are left at 0 = unknown; playback falls back to
-- size-based estimation instead of a lie.
--
-- Edge functions now enforce the same rule on every write path:
--   upload-finalize recomputes from merged tracks, sync-durations +
--   reconcile-storage self-heal drift, playback/mapper/download refuse to
--   prorate bogus totals (>40h or >3x/<1/3x vs size/12000 estimate).

WITH sums AS (
  SELECT
    li.id,
    COALESCE(li.duration, 0) AS stored,
    COALESCE((
      SELECT SUM(
        GREATEST(0, COALESCE(
          CASE
            WHEN (e.value -> 'metadata' ->> 'duration') ~ '^[0-9]+(\.[0-9]+)?$'
              THEN (e.value -> 'metadata' ->> 'duration')::double precision
            ELSE NULL
          END,
          CASE
            WHEN (e.value ->> 'duration') ~ '^[0-9]+(\.[0-9]+)?$'
              THEN (e.value ->> 'duration')::double precision
            ELSE NULL
          END,
          0
        ))
      )
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(li.audio_files) = 'array' THEN li.audio_files
          ELSE '[]'::jsonb
        END
      ) AS e(value)
    ), 0) AS summed
  FROM public.library_items AS li
)
UPDATE public.library_items AS li
SET
  duration = ROUND(s.summed),
  updated_at = NOW()
FROM sums AS s
WHERE li.id = s.id
  AND s.summed > 0
  AND s.summed <= 144000 -- MAX_ITEM_DURATION_S (40h): never invent insane totals
  AND (s.stored IS NULL OR s.stored = 0 OR ABS(s.stored - ROUND(s.summed)) > 1);
