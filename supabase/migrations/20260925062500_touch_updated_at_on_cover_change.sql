-- Keep the client cover cache-buster honest.
--
-- The web app builds cover image URLs as
--   /api/items/:id/cover?ts=<library_items.updated_at>
-- (src/shared/lib/coverUtils.ts -> getLibraryItemCoverUrl). `ts` is the only
-- cache-busting input, so a cover that is written without also bumping
-- updated_at leaves the client requesting the exact same URL it cached before
-- the change -- typically a 404/placeholder response, even though the new
-- image object exists in storage.
--
-- Observed in production: a cover repair rewrote cover_path for 20 items but
-- left updated_at untouched, so those items kept rendering the pre-repair
-- cached response.
--
-- Centralising this in a trigger fixes every writer at once (edge-function
-- cover route, scan, sync-covers, repair_metadata, and ad-hoc scripts) instead
-- of relying on each call site to remember to touch the timestamp.
CREATE OR REPLACE FUNCTION public.touch_library_items_updated_at_on_cover_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.cover_path IS DISTINCT FROM OLD.cover_path THEN
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS library_items_touch_updated_at_on_cover_path
  ON public.library_items;

CREATE TRIGGER library_items_touch_updated_at_on_cover_path
BEFORE UPDATE ON public.library_items
FOR EACH ROW
EXECUTE FUNCTION public.touch_library_items_updated_at_on_cover_change();
