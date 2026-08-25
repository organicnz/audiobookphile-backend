-- Guard the destructive hourly library dedupe behind an explicit opt-in flag,
-- and add a forensic audit trail for library_items deletions.
--
-- Background (2026-08-25 incident): cron job "invoke-deduplicate-library-items-hourly"
-- ran public.deduplicate_library_items() every hour with no dry-run, no logging and
-- no safety gates. When a transient duplicate-shaped row appeared (a diagnostic
-- clone of a real book), the next run silently chose the clone as primary
-- (id-ordering tie-break in PASS 2) and merged + deleted the REAL item's row
-- within minutes. Recovery was manual. Two structural fixes:
--
--   1. The cron now calls a guarded wrapper that is DISABLED BY DEFAULT and must
--      be enabled explicitly via server_settings key 'auto_dedupe_enabled'
--      (jsonb boolean). Re-enabling is one statement, no redeploy:
--        UPDATE server_settings SET value='true' WHERE key='auto_dedupe_enabled';
--      Before re-enabling, review merge_two_library_items(): it must log merges,
--      prefer OLDEST row as primary on ties, and never treat non-audio entries
--      as identity signals. Until then the nightly detect_merged_books.ts audit
--      remains the safe, read-only way to surface duplicates.
--
--   2. Every future DELETE on library_items is recorded with who/when/what, so
--      silent data loss is immediately visible instead of discovered days later.

-- ---------------------------------------------------------------------------
-- 1. Guarded entry point (default-deny)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deduplicate_library_items_guarded()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_flag text;
BEGIN
  SELECT value::text INTO v_flag
  FROM public.server_settings
  WHERE key = 'auto_dedupe_enabled';

  IF COALESCE(v_flag, '') NOT IN ('true', '"true"') THEN
    RAISE WARNING '[dedupe-guard] auto_dedupe_enabled is not true - skipping run';
    RETURN 0;
  END IF;

  RETURN public.deduplicate_library_items();
END;
$$;

COMMENT ON FUNCTION public.deduplicate_library_items_guarded() IS
  'Opt-in wrapper for deduplicate_library_items(); disabled unless server_settings.auto_dedupe_enabled = true. See 2026-08-25 incident note.';

-- Seed the flag explicitly disabled (row-absent also means disabled).
INSERT INTO public.server_settings (key, value)
SELECT 'auto_dedupe_enabled', 'false'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.server_settings WHERE key = 'auto_dedupe_enabled');

-- ---------------------------------------------------------------------------
-- 2. Re-point the cron at the guarded entry point (idempotent)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_ignored bigint;
BEGIN
  BEGIN
    SELECT cron.unschedule('invoke-deduplicate-library-items-hourly') INTO v_ignored;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- not currently scheduled; nothing to remove
  END;
  PERFORM cron.schedule(
    'invoke-deduplicate-library-items-hourly',
    '15 * * * *',
    $cmd$SELECT public.deduplicate_library_items_guarded()$cmd$
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Forensic deletion audit for library_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.library_item_deletion_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id       uuid NOT NULL,
  title         text,
  path          text,
  media_id      uuid,
  audio_count   integer,
  deleted_at    timestamptz NOT NULL DEFAULT now(),
  deleted_by    text NOT NULL DEFAULT current_user
);

REVOKE ALL ON public.library_item_deletion_audit FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_library_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.library_item_deletion_audit
    (item_id, title, path, media_id, audio_count, deleted_by)
  VALUES
    (OLD.id, OLD.title, OLD.path, OLD.media_id,
     COALESCE(jsonb_array_length(OLD.audio_files), 0),
     current_user);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS audit_library_item_delete_trg ON public.library_items;
CREATE TRIGGER audit_library_item_delete_trg
  AFTER DELETE ON public.library_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_library_item_delete();
