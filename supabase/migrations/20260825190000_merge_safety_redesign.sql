-- Merge-safety redesign for the library dedupe pipeline.
--
-- Problems with the previous implementation (observed in the 2026-08-25
-- Sapiens incident):
--   * Primary selection was arbitrary (most audio files, then shortest title,
--     then id ordering) - a transient duplicate-shaped row could win and the
--     REAL row got merged away.
--   * No dry-run, no logging: destructive decisions were invisible until data
--     was gone.
--   * merge_two_library_items() double-counted duration when both records had
--     one (greatest(pri,dup) + dup).
--   * Prefix/trigram passes could pair distinct works (e.g. "X" vs "X: The
--     Sequel") with only weak author evidence.
--
-- Redesign:
--   * plan_library_item_merges(): READ-ONLY planner. Single source of truth
--     for pairing across all four passes. Primary = OLDEST created_at row
--     (stable identity anchor). Pairs whose durations diverge >35% are
--     deferred (likely distinct editions/works) - flagged in `reason`.
--   * deduplicate_library_items(p_dry_run := false): consumes the plan.
--     Dry-run touches nothing; real runs are capped per invocation.
--   * merge_two_library_items(): duration fixed, every merge recorded in
--     library_item_merge_audit.
-- All wrapped by deduplicate_library_items_guarded() (opt-in flag) from
-- migration 20260825180000.

-- ---------------------------------------------------------------------------
-- 1. Merge audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.library_item_merge_audit (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  primary_id         uuid NOT NULL,
  primary_title      text,
  dup_id             uuid NOT NULL,
  dup_title          text,
  pass               integer,
  reason             text,
  audio_files_before jsonb,
  deleted_by         text NOT NULL DEFAULT current_user,
  merged_at          timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.library_item_merge_audit FROM anon, authenticated;

-- The new executor takes an optional dry-run flag; drop the legacy zero-arg
-- overload (a zero-arg call would otherwise be ambiguous between the two).
-- The guarded wrapper from 20260825180000 references the zero-arg form, so it
-- is recreated below against the new signature.
DROP FUNCTION IF EXISTS public.deduplicate_library_items();

-- ---------------------------------------------------------------------------
-- 2. Planner (read-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plan_library_item_merges()
RETURNS TABLE (
  primary_id    uuid,
  primary_title text,
  dup_id        uuid,
  dup_title     text,
  pass          integer,
  reason        text
)
LANGUAGE sql
STABLE
AS $$
WITH pairs AS (
    -- PASS 1: same normalized title within a library
    SELECT 1 AS pass,
           least(i1.id, i2.id) AS a, greatest(i1.id, i2.id) AS b,
           'same-normalized-title'::text AS reason
    FROM public.library_items i1
    JOIN public.library_items i2
      ON i1.library_id = i2.library_id AND i1.id < i2.id
    WHERE public.normalize_book_title(i1.title) != ''
      AND public.normalize_book_title(i1.title) = public.normalize_book_title(i2.title)

    UNION

    -- PASS 2: share a specific (non-generic) audio filename
    SELECT 2, least(i1.id, i2.id), greatest(i1.id, i2.id),
           'shared-specific-audio-file'
    FROM public.library_items i1
    JOIN public.library_items i2
      ON i1.library_id = i2.library_id AND i1.id < i2.id
    WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(coalesce(i1.audio_files, '[]'::jsonb)) f1
        JOIN jsonb_array_elements(coalesce(i2.audio_files, '[]'::jsonb)) f2
          ON coalesce(f1->'metadata'->>'filename', f1->'metadata'->>'relPath')
           = coalesce(f2->'metadata'->>'filename', f2->'metadata'->>'relPath')
        WHERE length(coalesce(f1->'metadata'->>'filename', f1->'metadata'->>'relPath', '')) > 15
          AND lower(coalesce(f1->'metadata'->>'filename', f1->'metadata'->>'relPath', ''))
              NOT SIMILAR TO '%(chapter|part|track|cd|disc|volume)\s*\d+%'
    )

    UNION

    -- PASS 3: title prefix + author evidence
    SELECT 3, least(i1.id, i2.id), greatest(i1.id, i2.id),
           'title-prefix+author'
    FROM public.library_items i1
    JOIN public.library_items i2
      ON i1.library_id = i2.library_id AND i1.id < i2.id
    WHERE public.normalize_book_title(i1.title) != ''
      AND public.normalize_book_title(i2.title) != ''
      AND (
        (public.normalize_book_title(i1.title) LIKE public.normalize_book_title(i2.title) || '%')
        OR
        (public.normalize_book_title(i2.title) LIKE public.normalize_book_title(i1.title) || '%')
      )
      AND (
        i1.author_names_first_last IS NULL OR i2.author_names_first_last IS NULL
        OR i1.author_names_first_last = 'Unknown Author' OR i2.author_names_first_last = 'Unknown Author'
        OR lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g'))
           = lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g'))
        OR lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g'))
           LIKE lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g')) || '%'
        OR lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g'))
           LIKE lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g')) || '%'
      )
      AND NOT (
        (i1.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+' AND i2.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+')
        AND regexp_replace(lower(i1.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2')
            != regexp_replace(lower(i2.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2')
      )

    UNION

    -- PASS 4: trigram similarity + exact-normalized author
    SELECT 4, least(i1.id, i2.id), greatest(i1.id, i2.id),
           'trigram>0.85+author'
    FROM public.library_items i1
    JOIN public.library_items i2
      ON i1.library_id = i2.library_id AND i1.id < i2.id
    WHERE public.normalize_book_title(i1.title) != ''
      AND public.normalize_book_title(i2.title) != ''
      AND similarity(public.normalize_book_title(i1.title), public.normalize_book_title(i2.title)) > 0.85
      AND (
        i1.author_names_first_last IS NULL OR i2.author_names_first_last IS NULL
        OR i1.author_names_first_last = 'Unknown Author' OR i2.author_names_first_last = 'Unknown Author'
        OR lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g'))
           = lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g'))
      )
      AND NOT (
        (i1.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+' AND i2.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+')
        AND regexp_replace(lower(i1.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2')
            != regexp_replace(lower(i2.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2')
      )
),
deduped AS (
    -- Earlier passes win; each unordered pair appears once.
    SELECT DISTINCT ON (a, b) a, b, pass, reason
    FROM pairs
    ORDER BY a, b, pass ASC
),
primary_chosen AS (
    -- Primary = OLDEST row (created_at, then id) - stable identity anchor.
    SELECT d.a, d.b, d.pass, d.reason,
           p.id AS pri_id, p.created_at AS pri_created, p.duration AS pri_dur,
           q.id AS dup_id, q.duration AS dup_dur
    FROM deduped d
    JOIN public.library_items p ON p.id IN (d.a, d.b)
    JOIN public.library_items q ON q.id IN (d.a, d.b) AND q.id != p.id
    WHERE (p.created_at, p.id) <= (q.created_at, q.id)
)
SELECT pri_id,
       (SELECT title FROM public.library_items WHERE id = pri_id),
       dup_id,
       (SELECT title FROM public.library_items WHERE id = dup_id),
       pass,
       CASE
         WHEN pri_dur IS NOT NULL AND dup_dur IS NOT NULL
              AND pri_dur > 0 AND dup_dur > 0
              AND abs(pri_dur - dup_dur) / greatest(pri_dur, dup_dur) > 0.35
         THEN reason || ' [DEFERRED: durations diverge >35%]'
         ELSE reason
       END
FROM primary_chosen
ORDER BY pass, a, b;
$$;

COMMENT ON FUNCTION public.plan_library_item_merges() IS
  'Read-only pairing plan for library dedupe. Primary is always the oldest row. Pairs with >35% duration divergence carry a [DEFERRED] reason and must not be auto-merged.';

-- ---------------------------------------------------------------------------
-- 3. Executor: consume the plan (dry-run safe)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deduplicate_library_items(
  p_dry_run boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_merged_count integer := 0;
    v_default_lib_id uuid;
    v_rec RECORD;
    v_max_merges constant integer := 50;
BEGIN
    IF p_dry_run THEN
        SELECT count(*) INTO v_merged_count
        FROM public.plan_library_item_merges()
        WHERE reason NOT LIKE '%[DEFERRED%]';
        RETURN v_merged_count;
    END IF;

    -- Housekeeping retained from the original implementation: adopt orphaned
    -- rows into the first library and unite multi-part folder books.
    SELECT id INTO v_default_lib_id FROM public.libraries ORDER BY display_order ASC LIMIT 1;
    IF v_default_lib_id IS NOT NULL THEN
        UPDATE public.library_items SET library_id = v_default_lib_id WHERE library_id IS NULL;
    END IF;
    v_merged_count := v_merged_count + public.merge_multipart_folder_books();

    FOR v_rec IN
        SELECT * FROM public.plan_library_item_merges()
        WHERE reason NOT LIKE '%[DEFERRED%]'
        ORDER BY pass, primary_id, dup_id
        LIMIT v_max_merges
    LOOP
        IF public.merge_two_library_items(v_rec.primary_id, v_rec.dup_id, v_rec.pass, v_rec.reason) THEN
            v_merged_count := v_merged_count + 1;
        END IF;
    END LOOP;

    RETURN v_merged_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Merge primitive: fixed duration math + mandatory audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_two_library_items(
  p_primary_id uuid,
  p_dup_id uuid,
  p_pass integer DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_primary_rec RECORD;
    v_dup_rec RECORD;
    v_combined_audio jsonb;
    v_combined_files jsonb;
    v_audio_elem jsonb;
    v_file_elem jsonb;
    v_filename text;
    v_seen_filenames text[];
    v_seen_lib_filenames text[];
    v_total_dur numeric;
    v_total_size bigint;
BEGIN
    IF p_primary_id IS NULL OR p_dup_id IS NULL OR p_primary_id = p_dup_id THEN
        RETURN false;
    END IF;

    SELECT * INTO v_primary_rec FROM public.library_items WHERE id = p_primary_id;
    SELECT * INTO v_dup_rec FROM public.library_items WHERE id = p_dup_id;

    IF v_primary_rec.id IS NULL OR v_dup_rec.id IS NULL THEN
        RETURN false;
    END IF;

    -- 1. Merge audio_files JSONB array (dedupe by filename)
    v_combined_audio := coalesce(v_primary_rec.audio_files, '[]'::jsonb);
    v_seen_filenames := ARRAY[]::text[];

    FOR v_audio_elem IN SELECT * FROM jsonb_array_elements(v_combined_audio)
    LOOP
        v_filename := coalesce(v_audio_elem->'metadata'->>'filename', v_audio_elem->'metadata'->>'relPath', '');
        IF v_filename != '' THEN
            v_seen_filenames := array_append(v_seen_filenames, v_filename);
        END IF;
    END LOOP;

    FOR v_audio_elem IN SELECT * FROM jsonb_array_elements(coalesce(v_dup_rec.audio_files, '[]'::jsonb))
    LOOP
        v_filename := coalesce(v_audio_elem->'metadata'->>'filename', v_audio_elem->'metadata'->>'relPath', '');
        IF v_filename = '' OR NOT (v_filename = ANY(v_seen_filenames)) THEN
            v_combined_audio := v_combined_audio || jsonb_build_array(v_audio_elem);
            IF v_filename != '' THEN
                v_seen_filenames := array_append(v_seen_filenames, v_filename);
            END IF;
        END IF;
    END LOOP;

    FOR i IN 0..(jsonb_array_length(v_combined_audio) - 1) LOOP
        v_combined_audio := jsonb_set(v_combined_audio, ARRAY[i::text, 'index'], to_jsonb(i + 1));
    END LOOP;

    -- 2. Merge library_files JSONB array (dedupe by filename)
    v_combined_files := coalesce(v_primary_rec.library_files, '[]'::jsonb);
    v_seen_lib_filenames := ARRAY[]::text[];

    FOR v_file_elem IN SELECT * FROM jsonb_array_elements(v_combined_files)
    LOOP
        v_filename := coalesce(v_file_elem->'metadata'->>'filename', v_file_elem->'metadata'->>'relPath', '');
        IF v_filename != '' THEN
            v_seen_lib_filenames := array_append(v_seen_lib_filenames, v_filename);
        END IF;
    END LOOP;

    FOR v_file_elem IN SELECT * FROM jsonb_array_elements(coalesce(v_dup_rec.library_files, '[]'::jsonb))
    LOOP
        v_filename := coalesce(v_file_elem->'metadata'->>'filename', v_file_elem->'metadata'->>'relPath', '');
        IF v_filename = '' OR NOT (v_filename = ANY(v_seen_lib_filenames)) THEN
            v_combined_files := v_combined_files || jsonb_build_array(v_file_elem);
            IF v_filename != '' THEN
                v_seen_lib_filenames := array_append(v_seen_lib_filenames, v_filename);
            END IF;
        END IF;
    END LOOP;

    -- Duplicate copies of the SAME work overlap; the most complete copy wins.
    -- (Previously: greatest(pri,dup) + dup when both non-null -> inflated.)
    v_total_dur := greatest(coalesce(v_primary_rec.duration, 0), coalesce(v_dup_rec.duration, 0));
    v_total_size := coalesce(v_primary_rec.size, 0) + coalesce(v_dup_rec.size, 0);

    UPDATE public.library_items
    SET audio_files = v_combined_audio,
        library_files = v_combined_files,
        duration = v_total_dur,
        size = v_total_size,
        author_names_first_last = coalesce(
            nullif(v_primary_rec.author_names_first_last, 'Unknown Author'),
            nullif(v_dup_rec.author_names_first_last, 'Unknown Author'),
            v_primary_rec.author_names_first_last
        ),
        cover_path = case
            when v_primary_rec.cover_path is not null and v_primary_rec.cover_path != '' and v_primary_rec.cover_path != 'missing'
            then v_primary_rec.cover_path
            else coalesce(v_dup_rec.cover_path, v_primary_rec.cover_path)
        end
    WHERE id = p_primary_id;

    -- 3. Safely re-link foreign keys
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'media_progress') THEN
        DELETE FROM public.media_progress mp_dup
        WHERE mp_dup.library_item_id = p_dup_id
          AND EXISTS (
              SELECT 1 FROM public.media_progress mp_pri
              WHERE mp_pri.library_item_id = p_primary_id
                AND mp_pri.user_id = mp_dup.user_id
          );
        UPDATE public.media_progress SET library_item_id = p_primary_id WHERE library_item_id = p_dup_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bookmarks') THEN
        UPDATE public.bookmarks SET library_item_id = p_primary_id WHERE library_item_id = p_dup_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_library_items') THEN
        INSERT INTO public.user_library_items (user_id, library_item_id, is_favorite)
        SELECT user_id, p_primary_id, is_favorite FROM public.user_library_items WHERE library_item_id = p_dup_id
        ON CONFLICT DO NOTHING;
        DELETE FROM public.user_library_items WHERE library_item_id = p_dup_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'book_authors') THEN
        INSERT INTO public.book_authors (library_item_id, author_id)
        SELECT p_primary_id, author_id FROM public.book_authors WHERE library_item_id = p_dup_id
        ON CONFLICT (library_item_id, author_id) DO NOTHING;
        DELETE FROM public.book_authors WHERE library_item_id = p_dup_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'book_series') THEN
        INSERT INTO public.book_series (library_item_id, series_id, sequence)
        SELECT p_primary_id, series_id, sequence FROM public.book_series WHERE library_item_id = p_dup_id
        ON CONFLICT (library_item_id, series_id) DO NOTHING;
        DELETE FROM public.book_series WHERE library_item_id = p_dup_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'collection_items') THEN
        INSERT INTO public.collection_items (library_item_id, collection_id, "order")
        SELECT p_primary_id, collection_id, "order" FROM public.collection_items WHERE library_item_id = p_dup_id
        ON CONFLICT (collection_id, library_item_id) DO NOTHING;
        DELETE FROM public.collection_items WHERE library_item_id = p_dup_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'playlist_media_items') THEN
        UPDATE public.playlist_media_items SET media_item_id = p_primary_id WHERE media_item_id = p_dup_id;
    END IF;

    -- 4. Audit before the destructive step (deletion itself also hits the
    --    deletion trigger from migration 20260825180000)
    INSERT INTO public.library_item_merge_audit
        (primary_id, primary_title, dup_id, dup_title, pass, reason, audio_files_before, deleted_by)
    VALUES
        (p_primary_id, v_primary_rec.title, p_dup_id, v_dup_rec.title,
         p_pass, p_reason, v_dup_rec.audio_files, current_user);

    DELETE FROM public.library_items WHERE id = p_dup_id;
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Recreate the guarded wrapper against the new executor signature
--    (the 20260825180000 body called the now-dropped zero-arg overload)
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

  RETURN public.deduplicate_library_items(false);
END;
$$;
