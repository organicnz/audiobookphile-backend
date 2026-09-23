-- Repair identity drift on library_item_merge_audit.id.
--
-- Incident (2026-09-22): the Daily Compatibility suite failed with
--   23502: null value in column "id" of relation "library_item_merge_audit"
-- because every merge-audit INSERT (correctly) omits `id`, while the table
-- in production was created WITHOUT the `GENERATED ALWAYS AS IDENTITY`
-- clause that supabase/migrations/20260825190000_merge_safety_redesign.sql
-- declares. The file uses CREATE TABLE IF NOT EXISTS, so the drift was
-- never repaired — and it breaks real merges, not just the test:
-- merge_two_library_items() fails the same way in production.
--
-- This migration adds the missing identity in place, idempotently: it only
-- fires when information_schema still shows a non-identity id column, and
-- starts the new sequence above any legacy max(id) that may exist.
-- Sibling audit tables were verified healthy (deletion_audit IS identity,
-- split_audit defaults gen_random_uuid()) and are untouched.

DO $$
DECLARE
  v_max bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'library_item_merge_audit'
      AND column_name = 'id'
      AND is_identity = 'NO'
  ) THEN
    SELECT COALESCE(MAX(id), 0) INTO v_max
    FROM public.library_item_merge_audit;
    EXECUTE format(
      'ALTER TABLE public.library_item_merge_audit ' ||
      'ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
      v_max + 1
    );
    RAISE NOTICE '[merge-audit-repair] identity added, sequence starts at %', v_max + 1;
  ELSE
    RAISE NOTICE '[merge-audit-repair] id already identity-managed, nothing to do';
  END IF;
END
$$;
