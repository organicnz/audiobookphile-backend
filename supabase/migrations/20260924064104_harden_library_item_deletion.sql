ALTER TABLE public.library_item_deletion_audit
  ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS deleted_by_role text,
  ADD COLUMN IF NOT EXISTS delete_mode text NOT NULL DEFAULT 'database',
  ADD COLUMN IF NOT EXISTS storage_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS storage_cleanup_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS storage_cleanup_error text,
  ADD COLUMN IF NOT EXISTS storage_cleanup_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_removed_files integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_files_retained integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_cleanup_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.library_item_deletion_audit'::regclass
      AND conname = 'library_item_deletion_audit_delete_mode_check'
  ) THEN
    ALTER TABLE public.library_item_deletion_audit
      ADD CONSTRAINT library_item_deletion_audit_delete_mode_check
      CHECK (delete_mode IN ('database', 'delete_files'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.library_item_deletion_audit'::regclass
      AND conname = 'library_item_deletion_audit_cleanup_status_check'
  ) THEN
    ALTER TABLE public.library_item_deletion_audit
      ADD CONSTRAINT library_item_deletion_audit_cleanup_status_check
      CHECK (storage_cleanup_status IN ('not_requested', 'pending', 'complete'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.audit_library_item_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_id_text text;
  v_actor_role text;
  v_delete_mode text;
  v_storage_manifest jsonb;
  v_storage_cleanup_status text;
BEGIN
  v_actor_id_text := NULLIF(current_setting('app.library_item_actor_id', true), '');
  IF v_actor_id_text IS NOT NULL THEN
    BEGIN
      v_actor_id := v_actor_id_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_actor_id := NULL;
    END;
  END IF;

  v_actor_role := COALESCE(
    NULLIF(current_setting('app.library_item_actor_role', true), ''),
    'system'
  );
  v_delete_mode := COALESCE(
    NULLIF(current_setting('app.library_item_delete_mode', true), ''),
    'database'
  );
  v_storage_manifest := COALESCE(
    NULLIF(current_setting('app.library_item_storage_manifest', true), '')::jsonb,
    '{}'::jsonb
  );
  v_storage_cleanup_status := COALESCE(
    NULLIF(current_setting('app.library_item_storage_cleanup_status', true), ''),
    'not_requested'
  );

  INSERT INTO public.library_item_deletion_audit
    (item_id, title, path, media_id, audio_count, deleted_by,
     deleted_by_user_id, deleted_by_role, delete_mode,
     storage_manifest, storage_cleanup_status)
  VALUES
    (OLD.id, OLD.title, OLD.path, OLD.media_id,
     CASE
       WHEN jsonb_typeof(OLD.audio_files) = 'array'
         THEN jsonb_array_length(OLD.audio_files)
       ELSE 0
     END,
     COALESCE(v_actor_id_text, current_user),
     v_actor_id, v_actor_role, v_delete_mode,
     v_storage_manifest, v_storage_cleanup_status);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_library_item_atomic(
  p_item_id uuid,
  p_hard_delete boolean,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.library_items%ROWTYPE;
  v_audio_files jsonb := '[]'::jsonb;
  v_library_files jsonb := '[]'::jsonb;
  v_actor_role text;
  v_b2_paths text[] := ARRAY[]::text[];
  v_supabase_audio_paths text[] := ARRAY[]::text[];
  v_cover_paths text[] := ARRAY[]::text[];
  v_cover_prefixes text[] := ARRAY[]::text[];
  v_path text;
  v_manifest jsonb;
  v_retained_file_count integer;
  v_audit_id bigint;
BEGIN
  IF p_item_id IS NULL OR p_actor_id IS NULL OR p_hard_delete IS NULL THEN
    RAISE EXCEPTION 'item id, actor id, and delete mode are required' USING ERRCODE = '22023';
  END IF;

  SELECT user_type::text
  INTO v_actor_role
  FROM public.profiles
  WHERE id = p_actor_id;

  IF v_actor_role NOT IN ('admin', 'root') THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_item
  FROM public.library_items
  WHERE id = p_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'item_id', p_item_id);
  END IF;

  v_audio_files := CASE
    WHEN jsonb_typeof(COALESCE(v_item.audio_files, '[]'::jsonb)) = 'array'
      THEN COALESCE(v_item.audio_files, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;
  v_library_files := CASE
    WHEN jsonb_typeof(COALESCE(v_item.library_files, '[]'::jsonb)) = 'array'
      THEN COALESCE(v_item.library_files, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  WITH entries AS (
    SELECT entry
    FROM jsonb_array_elements(COALESCE(v_audio_files, '[]'::jsonb))
      AS audio(entry)
    UNION ALL
    SELECT entry
    FROM jsonb_array_elements(COALESCE(v_library_files, '[]'::jsonb))
      AS library(entry)
  ), candidates AS (
    SELECT DISTINCT btrim(path) AS path
    FROM entries
    CROSS JOIN LATERAL jsonb_each(entry) AS root(key, value)
    CROSS JOIN LATERAL (
      SELECT root.value #>> '{}' AS path
      WHERE root.key IN ('path', 'storage_path')
        AND jsonb_typeof(root.value) = 'string'
      UNION ALL
      SELECT metadata.value #>> '{}' AS path
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(root.value) = 'object' THEN root.value
          ELSE '{}'::jsonb
        END
      ) AS metadata(key, value)
      WHERE root.key = 'metadata'
        AND metadata.key IN ('path', 'storagePath')
        AND jsonb_typeof(metadata.value) = 'string'
    ) AS candidate
    WHERE btrim(candidate.path) <> ''
      AND candidate.path NOT LIKE 'http://%'
      AND candidate.path NOT LIKE 'https://%'
  ), categorized AS (
    SELECT
      COALESCE(array_agg(path ORDER BY path) FILTER (WHERE path NOT LIKE 'supabase://%'), ARRAY[]::text[]) AS b2_paths,
      COALESCE(array_agg(substring(path FROM 11) ORDER BY path) FILTER (WHERE path LIKE 'supabase://%'), ARRAY[]::text[]) AS supabase_paths
    FROM candidates
  )
  SELECT b2_paths, supabase_paths
  INTO v_b2_paths, v_supabase_audio_paths
  FROM categorized;

  v_path := NULLIF(btrim(COALESCE(v_item.cover_path, '')), '');
  IF v_path IS NOT NULL
     AND v_path <> 'missing'
     AND v_path NOT LIKE '/%'
     AND v_path NOT LIKE 'http://%'
     AND v_path NOT LIKE 'https://%'
     AND v_path NOT LIKE 'supabase://%' THEN
    v_cover_paths := ARRAY[v_path];
  END IF;
  v_cover_prefixes := ARRAY[v_item.id::text];

  v_retained_file_count :=
    COALESCE(jsonb_array_length(v_audio_files), 0) +
    COALESCE(jsonb_array_length(v_library_files), 0) +
    CASE WHEN cardinality(v_cover_paths) > 0 THEN 1 ELSE 0 END;

  v_manifest := jsonb_build_object(
    'b2Paths', to_jsonb(v_b2_paths),
    'supabaseAudioPaths', to_jsonb(v_supabase_audio_paths),
    'coverPaths', to_jsonb(v_cover_paths),
    'coverPrefixes', to_jsonb(v_cover_prefixes),
    'retainedFileCount', v_retained_file_count
  );

  PERFORM set_config('app.library_item_actor_id', p_actor_id::text, true);
  PERFORM set_config('app.library_item_actor_role', v_actor_role, true);
  PERFORM set_config('app.library_item_delete_mode',
    CASE WHEN p_hard_delete THEN 'delete_files' ELSE 'database' END, true);
  PERFORM set_config('app.library_item_storage_manifest', v_manifest::text, true);
  PERFORM set_config('app.library_item_storage_cleanup_status',
    CASE WHEN p_hard_delete THEN 'pending' ELSE 'not_requested' END, true);

  IF to_regclass('public.media_progress') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.media_progress WHERE library_item_id = $1' USING p_item_id;
  END IF;
  IF to_regclass('public.bookmarks') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.bookmarks WHERE library_item_id = $1' USING p_item_id;
  END IF;
  IF to_regclass('public.user_library_items') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.user_library_items WHERE library_item_id = $1' USING p_item_id;
  END IF;
  IF to_regclass('public.book_authors') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.book_authors WHERE library_item_id = $1' USING p_item_id;
  END IF;
  IF to_regclass('public.book_series') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.book_series WHERE library_item_id = $1' USING p_item_id;
  END IF;
  IF to_regclass('public.collection_items') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.collection_items WHERE library_item_id = $1' USING p_item_id;
  END IF;
  IF to_regclass('public.playlist_media_items') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.playlist_media_items WHERE media_item_id = $1' USING p_item_id;
  END IF;
  IF to_regclass('public.book_insights') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.book_insights WHERE book_id = $1' USING p_item_id::text;
  END IF;
  IF to_regclass('public.media_item_shares') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.media_item_shares WHERE media_item_id = $1 AND (media_item_type IS NULL OR lower(media_item_type) IN (''book'', ''library_item'', ''libraryitem''))' USING p_item_id;
  END IF;

  DELETE FROM public.library_items WHERE id = p_item_id;

  SELECT id
  INTO v_audit_id
  FROM public.library_item_deletion_audit
  WHERE item_id = p_item_id
  ORDER BY id DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'item_id', p_item_id,
    'audit_id', v_audit_id,
    'manifest', v_manifest,
    'retained_file_count', v_retained_file_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_library_item_storage_cleanup(
  p_audit_id bigint,
  p_status text,
  p_error text,
  p_removed_files integer DEFAULT 0,
  p_files_retained integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('pending', 'complete') THEN
    RAISE EXCEPTION 'invalid storage cleanup status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.library_item_deletion_audit
  SET storage_cleanup_status = p_status,
      storage_cleanup_error = NULLIF(COALESCE(p_error, ''), ''),
      storage_cleanup_attempts = storage_cleanup_attempts + 1,
      storage_removed_files = GREATEST(COALESCE(p_removed_files, 0), 0),
      storage_files_retained = GREATEST(COALESCE(p_files_retained, 0), 0),
      storage_cleanup_updated_at = now()
  WHERE id = p_audit_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion audit record not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_library_item_atomic(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_library_item_storage_cleanup(bigint, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_library_item_atomic(uuid, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_library_item_storage_cleanup(bigint, text, text, integer, integer) TO service_role;
