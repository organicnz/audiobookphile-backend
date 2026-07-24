-- Migration: 20260724000000_deduplicate_library_items.sql
-- Function to deduplicate library_items (books) in the backend and merge tracks, files, and references

CREATE OR REPLACE FUNCTION public.deduplicate_library_items()
RETURNS integer AS $$
DECLARE
    v_merged_count integer := 0;
    v_norm_title text;
    v_lib_id uuid;
    v_primary_id uuid;
    v_dup_rec RECORD;
    v_primary_rec RECORD;
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
    -- Loop over library items grouped by library_id and normalized title
    FOR v_lib_id, v_norm_title IN
        SELECT library_id, lower(regexp_replace(title, '[^a-z0-9]', '', 'g')) as norm_title
        FROM public.library_items
        WHERE title IS NOT NULL AND trim(title) != ''
        GROUP BY library_id, lower(regexp_replace(title, '[^a-z0-9]', '', 'g'))
        HAVING count(*) > 1
    LOOP
        -- Pick the primary record (the one with the largest audio_files array or earliest created_at)
        SELECT * INTO v_primary_rec
        FROM public.library_items
        WHERE library_id = v_lib_id
          AND lower(regexp_replace(title, '[^a-z0-9]', '', 'g')) = v_norm_title
        ORDER BY jsonb_array_length(coalesce(audio_files, '[]'::jsonb)) DESC, created_at ASC
        LIMIT 1;

        IF v_primary_rec.id IS NULL THEN
            CONTINUE;
        END IF;

        v_primary_id := v_primary_rec.id;

        -- Process each duplicate record for this normalized title
        FOR v_dup_rec IN
            SELECT *
            FROM public.library_items
            WHERE library_id = v_lib_id
              AND lower(regexp_replace(title, '[^a-z0-9]', '', 'g')) = v_norm_title
              AND id != v_primary_id
        LOOP
            -- 1. Merge audio_files JSONB array
            v_combined_audio := coalesce(v_primary_rec.audio_files, '[]'::jsonb);
            v_seen_filenames := ARRAY[]::text[];
            
            -- Track existing audio filenames in primary
            FOR v_audio_elem IN SELECT * FROM jsonb_array_elements(v_combined_audio)
            LOOP
                v_filename := coalesce(v_audio_elem->'metadata'->>'filename', v_audio_elem->'metadata'->>'relPath', '');
                IF v_filename != '' THEN
                    v_seen_filenames := array_append(v_seen_filenames, v_filename);
                END IF;
            END LOOP;

            -- Append non-duplicate audio files from dup_rec
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

            -- 2. Merge library_files JSONB array
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

            -- Calculate total size and duration
            v_total_dur := greatest(coalesce(v_primary_rec.duration, 0), coalesce(v_dup_rec.duration, 0));
            v_total_size := coalesce(v_primary_rec.size, 0) + coalesce(v_dup_rec.size, 0);

            -- Update primary record
            UPDATE public.library_items
            SET audio_files = v_combined_audio,
                library_files = v_combined_files,
                duration = v_total_dur,
                size = v_total_size,
                author_names_first_last = coalesce(nullif(v_primary_rec.author_names_first_last, 'Unknown Author'), v_dup_rec.author_names_first_last, v_primary_rec.author_names_first_last)
            WHERE id = v_primary_id;

            -- 3. Re-link foreign key references from duplicate item to primary item
            -- media_progress
            UPDATE public.media_progress
            SET library_item_id = v_primary_id
            WHERE library_item_id = v_dup_rec.id;

            -- bookmarks
            UPDATE public.bookmarks
            SET library_item_id = v_primary_id
            WHERE library_item_id = v_dup_rec.id;

            -- user_library_items
            UPDATE public.user_library_items
            SET library_item_id = v_primary_id
            WHERE library_item_id = v_dup_rec.id;
            DELETE FROM public.user_library_items WHERE library_item_id = v_dup_rec.id;

            -- book_authors
            INSERT INTO public.book_authors (library_item_id, author_id)
            SELECT v_primary_id, author_id
            FROM public.book_authors
            WHERE library_item_id = v_dup_rec.id
            ON CONFLICT (library_item_id, author_id) DO NOTHING;
            DELETE FROM public.book_authors WHERE library_item_id = v_dup_rec.id;

            -- book_series
            INSERT INTO public.book_series (library_item_id, series_id, sequence)
            SELECT v_primary_id, series_id, sequence
            FROM public.book_series
            WHERE library_item_id = v_dup_rec.id
            ON CONFLICT (library_item_id, series_id) DO NOTHING;
            DELETE FROM public.book_series WHERE library_item_id = v_dup_rec.id;

            -- collection_items (if table exists)
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'collection_items') THEN
                INSERT INTO public.collection_items (library_item_id, collection_id, "order")
                SELECT v_primary_id, collection_id, "order"
                FROM public.collection_items
                WHERE library_item_id = v_dup_rec.id
                ON CONFLICT (collection_id, library_item_id) DO NOTHING;
                DELETE FROM public.collection_items WHERE library_item_id = v_dup_rec.id;
            END IF;

            -- playlist_media_items (if table exists)
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'playlist_media_items') THEN
                UPDATE public.playlist_media_items
                SET media_item_id = v_primary_id
                WHERE media_item_id = v_dup_rec.id;
            END IF;

            -- Delete the duplicate library_items row
            DELETE FROM public.library_items WHERE id = v_dup_rec.id;
            v_merged_count := v_merged_count + 1;
        END LOOP;
    END LOOP;

    RETURN v_merged_count;
END;
$$ LANGUAGE plpgsql;

-- Execute immediate backend deduplication across existing books
SELECT public.deduplicate_library_items();
