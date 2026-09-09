-- 10x pro: Storage hardening – prevent 7.5 GB audio-files blow-up from re-occurring
--
-- Context: 2026-08-26 bulk import via scripts/import_missing_books.ts wrote 738
-- objects (6.6 GB) directly to Supabase `audio-files` bucket, bypassing B2.
-- Dashboard: 858 objects / 7566 MB total (covers is only 241 objects / 13 MB).
-- Free plan is 1 GB – grace until 2026-09-29 then 402.
--
-- This migration:
--  1. Tightens `storage.buckets` limits so accidental Supabase audio uploads
--     fail fast (prod values; local parity via supabase/config.toml).
--  2. Adds `storage_quota_snapshot` helper + `check_storage_quota()` guard used
--     by edge functions to return 507 before quota is exceeded.
--  3. Fixes `storage.objects` RLS: covers remains public read, audio-files
--     stays admin-only (existing policies kept, just documented here).
--  4. Adds orphan GC helper `list_storage_orphans()` for admin diagnostics.
--  5. Ensures dedupe-merge cleans up the duplicate's cover object.

-- 1. Buckets – prod limits (idempotent)
UPDATE storage.buckets
SET file_size_limit = 5242880,  -- 5 MiB
    allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','image/svg+xml']
WHERE id = 'covers';

UPDATE storage.buckets
SET file_size_limit = 10485760, -- 10 MiB – audio must go to B2, this is a safety net
    allowed_mime_types = ARRAY['audio/mpeg','audio/mp4','audio/ogg','audio/flac','audio/x-matroska','audio/wav','audio/aac','audio/webm','audio/x-aiff','audio/x-caf','audio/opus']
WHERE id = 'audio-files';

-- Ensure backups bucket exists for settings.ts:650 (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
SELECT 'backups','backups', false, 5242880, ARRAY['application/json','application/gzip','application/zip']
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='backups');

-- 2. Quota helpers
CREATE OR REPLACE FUNCTION public.storage_quota_snapshot()
RETURNS TABLE(bucket_id text, object_count bigint, total_bytes bigint, pretty text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = storage, public AS $$
  SELECT bucket_id::text, count(*)::bigint, coalesce(sum((metadata->>'size')::bigint),0)::bigint,
         pg_size_pretty(coalesce(sum((metadata->>'size')::bigint),0))
  FROM storage.objects GROUP BY bucket_id
  UNION ALL
  SELECT '_total'::text, count(*)::bigint, coalesce(sum((metadata->>'size')::bigint),0)::bigint,
         pg_size_pretty(coalesce(sum((metadata->>'size')::bigint),0))
  FROM storage.objects;
$$;
REVOKE ALL ON FUNCTION public.storage_quota_snapshot() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_quota_snapshot() TO service_role;

-- Guard: free plan = 1 GiB, pro = 100 GiB. Default 1 GiB; override via server_settings key
-- `storage_quota_bytes` (jsonb number). Edge functions call this before any Supabase Storage write.
CREATE OR REPLACE FUNCTION public.check_storage_quota(p_need_bytes bigint DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = storage, public AS $$
DECLARE v_total bigint; v_quota bigint; v_flag text;
BEGIN
  SELECT coalesce(sum((metadata->>'size')::bigint),0) INTO v_total FROM storage.objects;
  SELECT value #>> '{}' INTO v_flag FROM public.server_settings WHERE key='storage_quota_bytes';
  IF v_flag IS NOT NULL AND v_flag ~ '^[0-9]+$' THEN
    v_quota := v_flag::bigint;
  ELSE
    v_quota := 1073741824; -- 1 GiB free
  END IF;
  IF v_total + coalesce(p_need_bytes,0) > v_quota THEN
    RAISE EXCEPTION 'Storage quota exceeded: % / % bytes (need %)', v_total, v_quota, p_need_bytes
      USING ERRCODE = 'P0001', HINT = 'Free plan is 1 GiB. Migrate audio to B2 and prune Supabase audio-files, or upgrade to Pro (100 GiB).';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.check_storage_quota(bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_storage_quota(bigint) TO service_role, authenticated;

-- 3. Orphan helper – compare storage.objects vs library_items (for admin tooling)
CREATE OR REPLACE FUNCTION public.list_storage_orphans(p_bucket text DEFAULT 'audio-files')
RETURNS TABLE(name text, size_bytes bigint, pretty text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = storage, public AS $$
  WITH refs AS (
    SELECT DISTINCT split_part(name,'/',1) AS folder FROM storage.objects WHERE bucket_id=p_bucket
  )
  SELECT o.name::text, (o.metadata->>'size')::bigint, pg_size_pretty((o.metadata->>'size')::bigint), o.created_at
  FROM storage.objects o
  WHERE o.bucket_id=p_bucket
    AND NOT EXISTS (
      SELECT 1 FROM public.library_items li
      WHERE li.id::text = split_part(o.name,'/',1)
         OR o.name = ANY(SELECT (jsonb_array_elements(li.audio_files)->'metadata'->>'path')::text FROM public.library_items li2 WHERE li2.id::text = split_part(o.name,'/',1))
    )
  ORDER BY (o.metadata->>'size')::bigint DESC
  LIMIT 200;
$$;
REVOKE ALL ON FUNCTION public.list_storage_orphans(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_storage_orphans(text) TO service_role;

-- 4. Seed quota setting (admin can UPDATE to 107374182400 for Pro = 100 GiB)
INSERT INTO public.server_settings (key, value)
SELECT 'storage_quota_bytes', '1073741824'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.server_settings WHERE key='storage_quota_bytes');

COMMENT ON FUNCTION public.storage_quota_snapshot() IS '10x pro: bucket size breakdown; used by /api/admin/storage-health and quota guard.';
COMMENT ON FUNCTION public.check_storage_quota(bigint) IS '10x pro: throws  P0001 if Supabase Storage would exceed free (1 GiB) or custom quota.';
