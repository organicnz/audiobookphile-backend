CREATE OR REPLACE FUNCTION public.delete_library_item_atomic(
  p_item_id uuid,
  p_hard_delete boolean,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
  v_audio_prefixes text[] := ARRAY[]::text[];
  v_unresolved_storage_count integer := 0;
  v_path text;
  v_manifest jsonb;
  v_retained_file_count integer;
  v_audit_id bigint;
  v_pending_manifest jsonb;
  v_pending_cleanup_status text;
  v_pending_removed_files integer;
  v_pending_files_retained integer;
BEGIN
  IF p_item_id IS NULL OR p_actor_id IS NULL OR p_hard_delete IS NULL THEN
    RAISE EXCEPTION 'item id, actor id, and delete mode are required' USING ERRCODE = '22023';
  END IF;

  SELECT user_type::text
  INTO v_actor_role
  FROM public.profiles
  WHERE id = p_actor_id;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'root') THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_item
  FROM public.library_items
  WHERE id = p_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_hard_delete THEN
      SELECT id, storage_manifest, storage_cleanup_status,
             storage_removed_files, storage_files_retained
      INTO v_audit_id, v_pending_manifest, v_pending_cleanup_status,
           v_pending_removed_files, v_pending_files_retained
      FROM public.library_item_deletion_audit
      WHERE item_id = p_item_id
        AND delete_mode = 'delete_files'
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'found', true,
          'retry', v_pending_cleanup_status = 'pending',
          'item_id', p_item_id,
          'audit_id', v_audit_id,
          'manifest', v_pending_manifest,
          'storage_cleanup_status', v_pending_cleanup_status,
          'storage_removed_files', COALESCE(v_pending_removed_files, 0),
          'storage_files_retained', COALESCE(v_pending_files_retained, 0)
        );
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'found', false,
      'retry', false,
      'item_id', p_item_id
    );
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
    FROM jsonb_array_elements(v_audio_files) AS audio(entry)
    UNION ALL
    SELECT entry
    FROM jsonb_array_elements(v_library_files) AS library(entry)
  ), fields AS (
    SELECT entry, root.key, root.value,
      root.key IN ('path', 'storage_path', 'storagePath') AS canonical
    FROM entries
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(entry) = 'object' THEN entry ELSE '{}'::jsonb END
    ) AS root(key, value)
    UNION ALL
    SELECT entry, metadata.key, metadata.value,
      metadata.key IN ('path', 'storagePath', 'storage_path') AS canonical
    FROM entries
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(entry) = 'object' THEN entry ELSE '{}'::jsonb END
    ) AS root(key, value)
    CROSS JOIN LATERAL jsonb_each(
      CASE
        WHEN root.key = 'metadata' AND jsonb_typeof(root.value) = 'object'
          THEN root.value
        ELSE '{}'::jsonb
      END
    ) AS metadata(key, value)
  ), raw_candidates AS (
    SELECT entry, canonical, btrim(value #>> '{}') AS raw_path
    FROM fields
    WHERE key IN ('path', 'storage_path', 'storagePath', 'relPath', 'rel_path', 'filename')
      AND jsonb_typeof(value) = 'string'
      AND btrim(value #>> '{}') <> ''
  ), classified AS (
    SELECT
      entry,
      CASE
        WHEN raw_path ~* '^https?://' THEN NULL
        WHEN raw_path ~* '^(b2|s3)(?:[-_][a-z]+)?://'
          AND regexp_replace(raw_path, '^[a-z0-9+.-]+://', '', 'i')
            LIKE p_item_id::text || '/%'
          THEN raw_path
        WHEN raw_path LIKE 'supabase://%'
          AND regexp_replace(raw_path, '^supabase://', '', 'i')
            LIKE p_item_id::text || '/%'
          THEN raw_path
        WHEN raw_path LIKE p_item_id::text || '/%'
          OR raw_path LIKE 'audiobooks/' || p_item_id::text || '/%'
          THEN raw_path
        WHEN NOT canonical
          AND raw_path !~ '(^|/)\.\.(/|$)'
          THEN p_item_id::text || '/' || ltrim(raw_path, '/')
        ELSE NULL
      END AS path,
      CASE
        WHEN raw_path ~* '^https?://' THEN 'ignored'
        WHEN raw_path ~* '^(b2|s3)(?:[-_][a-z]+)?://'
          AND regexp_replace(raw_path, '^[a-z0-9+.-]+://', '', 'i')
            LIKE p_item_id::text || '/%'
          THEN 'owned'
        WHEN raw_path LIKE 'supabase://%'
          AND regexp_replace(raw_path, '^supabase://', '', 'i')
            LIKE p_item_id::text || '/%'
          THEN 'owned'
        WHEN raw_path LIKE p_item_id::text || '/%'
          OR raw_path LIKE 'audiobooks/' || p_item_id::text || '/%'
          THEN 'owned'
        WHEN NOT canonical
          AND raw_path !~ '(^|/)\.\.(/|$)'
          THEN 'owned'
        ELSE 'unresolved'
      END AS state
    FROM raw_candidates
  ), safe_candidates AS (
    SELECT DISTINCT entry, path
    FROM classified
    WHERE state = 'owned'
      AND path IS NOT NULL
      AND path !~ '(^|/)\.\.(/|$)'
  ), recognized_entries AS (
    SELECT DISTINCT entry
    FROM safe_candidates
    UNION
    SELECT DISTINCT entry
    FROM classified
    WHERE state = 'ignored'
  ), categorized AS (
    SELECT
      COALESCE(
        array_agg(path ORDER BY path) FILTER (WHERE path NOT LIKE 'supabase://%'),
        ARRAY[]::text[]
      ) AS b2_paths,
      COALESCE(
        array_agg(
          regexp_replace(path, '^supabase://', '', 'i') ORDER BY path
        ) FILTER (WHERE path LIKE 'supabase://%'),
        ARRAY[]::text[]
      ) AS supabase_paths,
      (
        SELECT count(*)::integer
        FROM entries entry
        WHERE jsonb_typeof(entry.entry) <> 'object'
          OR NOT EXISTS (
            SELECT 1
            FROM recognized_entries recognized
            WHERE recognized.entry = entry.entry
          )
      ) AS unresolved_count
    FROM safe_candidates
  )
  SELECT b2_paths, supabase_paths, unresolved_count
  INTO v_b2_paths, v_supabase_audio_paths, v_unresolved_storage_count
  FROM categorized;

  v_path := NULLIF(btrim(COALESCE(v_item.cover_path, '')), '');
  IF v_path IS NOT NULL
     AND v_path <> 'missing'
     AND v_path NOT LIKE '/%'
     AND v_path NOT LIKE 'http://%'
     AND v_path NOT LIKE 'https://%'
     AND v_path NOT LIKE 'supabase://%'
     AND v_path LIKE p_item_id::text || '/%'
     AND v_path !~ '(^|/)\.\.(/|$)'
     AND NOT EXISTS (
       SELECT 1
       FROM public.library_items other_item
       WHERE other_item.id <> p_item_id
         AND other_item.cover_path = v_path
     ) THEN
    v_cover_paths := ARRAY[v_path];
  ELSIF v_path IS NOT NULL
     AND v_path <> 'missing'
     AND v_path NOT LIKE 'http://%'
     AND v_path NOT LIKE 'https://%'
     AND v_path NOT LIKE 'supabase://%' THEN
    v_unresolved_storage_count := v_unresolved_storage_count + 1;
  END IF;
  v_cover_prefixes := ARRAY[v_item.id::text];
  v_audio_prefixes := ARRAY[v_item.id::text];

  v_retained_file_count :=
    COALESCE(jsonb_array_length(v_audio_files), 0) +
    COALESCE(jsonb_array_length(v_library_files), 0) +
    CASE WHEN cardinality(v_cover_paths) > 0 THEN 1 ELSE 0 END;

  v_manifest := jsonb_build_object(
    'manifestVersion', 1,
    'b2Paths', to_jsonb(v_b2_paths),
    'supabaseAudioPaths', to_jsonb(v_supabase_audio_paths),
    'audioPrefixes', to_jsonb(v_audio_prefixes),
    'coverPaths', to_jsonb(v_cover_paths),
    'coverPrefixes', to_jsonb(v_cover_prefixes),
    'unresolvedStorageCount', v_unresolved_storage_count,
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

  IF v_audit_id IS NULL THEN
    RAISE EXCEPTION 'deletion audit trigger did not record the delete' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'retry', false,
    'item_id', p_item_id,
    'audit_id', v_audit_id,
    'manifest', v_manifest,
    'retained_file_count', v_retained_file_count,
    'storage_cleanup_status', CASE WHEN p_hard_delete THEN 'pending' ELSE 'not_requested' END,
    'storage_removed_files', 0,
    'storage_files_retained', 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_library_item_delete_cleanup(
  p_item_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role text;
  v_audit_id bigint;
  v_manifest jsonb;
  v_cleanup_status text;
  v_removed_files integer;
  v_files_retained integer;
BEGIN
  IF p_item_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'item id and actor id are required' USING ERRCODE = '22023';
  END IF;

  SELECT user_type::text
  INTO v_actor_role
  FROM public.profiles
  WHERE id = p_actor_id;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'root') THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;

  SELECT id, storage_manifest, storage_cleanup_status,
         storage_removed_files, storage_files_retained
  INTO v_audit_id, v_manifest, v_cleanup_status, v_removed_files, v_files_retained
  FROM public.library_item_deletion_audit
  WHERE item_id = p_item_id
    AND delete_mode = 'delete_files'
  ORDER BY id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'found', false,
      'retry', false,
      'item_id', p_item_id
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'retry', v_cleanup_status = 'pending',
    'item_id', p_item_id,
    'audit_id', v_audit_id,
    'manifest', v_manifest,
    'storage_cleanup_status', v_cleanup_status,
    'storage_removed_files', COALESCE(v_removed_files, 0),
    'storage_files_retained', COALESCE(v_files_retained, 0)
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_delete_mode text;
  v_status text;
  v_removed_files integer;
  v_files_retained integer;
BEGIN
  IF p_audit_id IS NULL
     OR p_status NOT IN ('pending', 'complete')
     OR p_removed_files IS NULL OR p_removed_files < 0
     OR p_files_retained IS NULL OR p_files_retained < 0 THEN
    RAISE EXCEPTION 'invalid storage cleanup arguments' USING ERRCODE = '22023';
  END IF;

  SELECT delete_mode, storage_cleanup_status, storage_removed_files, storage_files_retained
  INTO v_delete_mode, v_status, v_removed_files, v_files_retained
  FROM public.library_item_deletion_audit
  WHERE id = p_audit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion audit record not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_delete_mode <> 'delete_files' THEN
    RAISE EXCEPTION 'audit record is not a file cleanup job' USING ERRCODE = '22023';
  END IF;
  IF v_status = 'complete' THEN
    IF p_status = 'complete' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'completed cleanup cannot regress to pending' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'complete' AND p_files_retained <> 0 THEN
    RAISE EXCEPTION 'complete cleanup cannot retain files' USING ERRCODE = '22023';
  END IF;

  UPDATE public.library_item_deletion_audit
  SET storage_cleanup_status = p_status,
      storage_cleanup_error = NULLIF(COALESCE(p_error, ''), ''),
      storage_cleanup_attempts = storage_cleanup_attempts + 1,
      storage_removed_files = GREATEST(v_removed_files, p_removed_files),
      storage_files_retained = p_files_retained,
      storage_cleanup_updated_at = now()
  WHERE id = p_audit_id;
END;
$$;

CREATE INDEX IF NOT EXISTS library_item_deletion_audit_pending_idx
  ON public.library_item_deletion_audit (id)
  WHERE storage_cleanup_status = 'pending';

REVOKE ALL ON FUNCTION public.audit_library_item_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_library_item_delete_cleanup(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_library_item_atomic(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_library_item_storage_cleanup(bigint, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_library_item_delete_cleanup(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_library_item_atomic(uuid, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_library_item_storage_cleanup(bigint, text, text, integer, integer) TO service_role;
