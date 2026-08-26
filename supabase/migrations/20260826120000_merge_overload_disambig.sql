-- Disambiguate merge_two_library_items overloads.
--
-- Migration 20260825190000 added (uuid,uuid,integer,text) WITH defaults next
-- to the legacy (uuid,uuid). Postgres then could not resolve legacy 2-arg
-- call sites (merge_multipart_folder_books) -> 42725 at runtime. Removing the
-- defaults makes the 4-arg form callable ONLY with explicit args, so both
-- overloads coexist deterministically: legacy callers hit the 2-arg form,
-- the redesigned pipeline passes pass/reason explicitly.

-- Postgres cannot ALTER away defaults: drop + recreate.
DROP FUNCTION IF EXISTS public.merge_two_library_items(uuid, uuid, integer, text);
CREATE OR REPLACE FUNCTION public.merge_two_library_items(
  p_primary_id uuid,
  p_dup_id uuid,
  p_pass integer,
  p_reason text
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
