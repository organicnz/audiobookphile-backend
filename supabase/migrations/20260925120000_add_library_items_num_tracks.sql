-- Shelves could not tell whether a book was playable.
--
-- The player needs a per-item track count to decide whether to render a Play
-- affordance, but the shelf/list projection (LIST_ITEM_SELECT in
-- supabase/functions/api/_shared/domain/libraries.ts) deliberately omits
-- `audio_files` -- that column is megabytes per item (a 343-chapter book) and
-- selecting it for a 100-book shelf was ~20x the payload.
--
-- mapBookForMobile therefore derived numTracks from the (empty) audio_files
-- list and every shelf item came back with numTracks: 0, so the Play button
-- was hidden for books that were perfectly playable. The phantom `tracks`
-- array the web reads instead is never emitted by the API at all, so the
-- detail page's Play button was hidden for *every* book.
--
-- Rather than re-selecting audio_files (correct but expensive), keep a
-- denormalised counter in sync with a trigger. The trigger is the single
-- source of truth, so scans, resyncs, item_delete and ad-hoc repair scripts
-- all stay correct without each call site remembering to maintain it.
--
-- Design notes:
--  * BEFORE INSERT/UPDATE OF audio_files, so the stored value can never drift
--    from the array it summarises, even within the same statement.
--  * jsonb_array_length (not json_array_length): audio_files is jsonb, and
--    json_array_length errors on jsonb. Guarded with COALESCE for NULL.
--  * Reading the column is a plain int4 fetch, so the shelf projection stays
--    cheap while still answering "is this book playable?".

ALTER TABLE public.library_items
  ADD COLUMN IF NOT EXISTS num_tracks integer;

COMMENT ON COLUMN public.library_items.num_tracks IS
  'Denormalised count of audio_files. Maintained by trigger; read by the '
  'shelf projection so the UI can decide playability without selecting the '
  '(very large) audio_files column.';

CREATE OR REPLACE FUNCTION public.sync_library_items_num_tracks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.num_tracks := COALESCE(
    jsonb_array_length(COALESCE(NEW.audio_files, '[]'::jsonb)), 0
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS library_items_sync_num_tracks
  ON public.library_items;

CREATE TRIGGER library_items_sync_num_tracks
BEFORE INSERT OR UPDATE OF audio_files ON public.library_items
FOR EACH ROW
EXECUTE FUNCTION public.sync_library_items_num_tracks();

-- Backfill existing rows and make the column NOT NULL with a 0 default so
-- every future writer (including ones that predate the trigger) gets a
-- sane value. NOT NULL lets the mapper treat it as a guaranteed number.
UPDATE public.library_items
SET num_tracks = COALESCE(jsonb_array_length(COALESCE(audio_files, '[]'::jsonb)), 0)
WHERE num_tracks IS DISTINCT FROM COALESCE(
  jsonb_array_length(COALESCE(audio_files, '[]'::jsonb)), 0
);

ALTER TABLE public.library_items
  ALTER COLUMN num_tracks SET DEFAULT 0,
  ALTER COLUMN num_tracks SET NOT NULL;
