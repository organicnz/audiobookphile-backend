-- Migration: 20260724000000_deduplicate_library_items.sql

-- Ensure pg_trgm extension exists for trigram similarity fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Helper function to normalize book titles for Unicode-safe fuzzy matching
CREATE OR REPLACE FUNCTION public.normalize_book_title(p_title text)
RETURNS text AS $$
DECLARE
    v_clean text;
BEGIN
    IF p_title IS NULL OR trim(p_title) = '' THEN
        RETURN '';
    END IF;
    
    v_clean := lower(trim(p_title));
    -- Remove common bracketed / parenthetical tags: [Audiobook], (Audiobook), (Unabridged), [Unabridged], (Abridged), [MP3]
    v_clean := regexp_replace(v_clean, '\[(audiobook|unabridged|abridged|mp3)\]|\((audiobook|unabridged|abridged|mp3)\)', '', 'gi');
    -- Remove CD / Disc / Part / Vol suffixes: e.g. CD 1, CD01, Disc 2, Part 1, Volume 1
    v_clean := regexp_replace(v_clean, '\b(cd|disc|part|vol|volume)\s*\d+\b', '', 'gi');
    -- Strip all non-alphanumeric characters (Unicode-safe for Cyrillic, Latin, Accented, Asian)
    v_clean := regexp_replace(v_clean, '[^[:alnum:]]', '', 'g');
    
    RETURN v_clean;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Helper function to merge a duplicate library_item into a primary library_item
CREATE OR REPLACE FUNCTION public.merge_two_library_items(p_primary_id uuid, p_dup_id uuid)
RETURNS boolean AS $$
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

    -- 1. Merge audio_files JSONB array
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

    -- Re-index audio files sequentially
    FOR i IN 0..(jsonb_array_length(v_combined_audio) - 1) LOOP
        v_combined_audio := jsonb_set(v_combined_audio, ARRAY[i::text, 'index'], to_jsonb(i + 1));
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

    v_total_dur := greatest(coalesce(v_primary_rec.duration, 0), coalesce(v_dup_rec.duration, 0)) + case when v_primary_rec.duration is not null and v_dup_rec.duration is not null then coalesce(v_dup_rec.duration, 0) else 0 end;
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

    DELETE FROM public.library_items WHERE id = p_dup_id;
    RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Helper function to unite multi-part books under a single book cover card
CREATE OR REPLACE FUNCTION public.merge_multipart_folder_books()
RETURNS integer AS $$
DECLARE
    v_merged_count integer := 0;
    v_parent_dir text;
    v_lib_id uuid;
    v_primary_rec RECORD;
    v_dup_rec RECORD;
    v_clean_title text;
    v_clean_author text;
BEGIN
    -- 1. Clean scene/release group tags from authors
    UPDATE public.library_items
    SET author_names_first_last = regexp_replace(author_names_first_last, '^\[[a-z0-9._\-]+\]\.?|[-.]?Complete-MaLiBu$', '', 'gi')
    WHERE author_names_first_last ~* '\[[a-z0-9._\-]+\]|Complete-MaLiBu';

    UPDATE public.library_items
    SET author_names_first_last = 'Isaac Asimov'
    WHERE author_names_first_last ILIKE '%Isaac%Asimov%';

    -- 2. Loop over parent directories in rel_path that contain multiple book items (e.g. "Isaac Asimov Foundation")
    FOR v_parent_dir, v_lib_id IN
        SELECT split_part(rel_path, '/', 1) as parent_dir, library_id
        FROM public.library_items
        WHERE rel_path LIKE '%/%'
          AND split_part(rel_path, '/', 1) NOT ILIKE 'audiobooks'
          AND split_part(rel_path, '/', 1) NOT ILIKE 'music'
          AND split_part(rel_path, '/', 1) NOT ILIKE 'Marshall Rosenberg'
          AND split_part(rel_path, '/', 1) NOT ILIKE 'Annie Jacobsen'
          AND split_part(rel_path, '/', 1) NOT ILIKE 'Dark Psychology Audiobook Collection'
        GROUP BY split_part(rel_path, '/', 1), library_id
        HAVING count(*) > 1
    LOOP
        v_clean_title := v_parent_dir;

        -- Pick primary record (Book 1 / earliest part)
        SELECT * INTO v_primary_rec
        FROM public.library_items
        WHERE library_id = v_lib_id
          AND split_part(rel_path, '/', 1) = v_parent_dir
        ORDER BY case 
                    when rel_path ILIKE '%Book 1%' or rel_path ILIKE '%01%' or rel_path ILIKE '%Vol.1%' then 0
                    when rel_path ILIKE '%Book 2%' or rel_path ILIKE '%02%' or rel_path ILIKE '%Vol.2%' then 1
                    else 2
                 end ASC,
                 created_at ASC
        LIMIT 1;

        IF v_primary_rec.id IS NULL THEN
            CONTINUE;
        END IF;

        v_clean_author := v_primary_rec.author_names_first_last;
        IF v_clean_author ILIKE '%Isaac%Asimov%' OR v_clean_author ILIKE '%MaLiBu%' THEN
            v_clean_author := 'Isaac Asimov';
        END IF;

        UPDATE public.library_items
        SET title = v_clean_title,
            author_names_first_last = v_clean_author
        WHERE id = v_primary_rec.id;

        -- Merge all other multi-part books under this folder into the primary single book
        FOR v_dup_rec IN
            SELECT *
            FROM public.library_items
            WHERE library_id = v_lib_id
              AND split_part(rel_path, '/', 1) = v_parent_dir
              AND id != v_primary_rec.id
            ORDER BY case 
                        when rel_path ILIKE '%Book 1%' or rel_path ILIKE '%01%' then 1
                        when rel_path ILIKE '%Book 2%' or rel_path ILIKE '%02%' then 2
                        when rel_path ILIKE '%Book 3%' or rel_path ILIKE '%03%' then 3
                        when rel_path ILIKE '%Book 4%' or rel_path ILIKE '%04%' then 4
                        when rel_path ILIKE '%Book 5%' or rel_path ILIKE '%05%' then 5
                        when rel_path ILIKE '%Book 6%' or rel_path ILIKE '%06%' then 6
                        when rel_path ILIKE '%Book 7%' or rel_path ILIKE '%07%' then 7
                        else 99
                     end ASC
        LOOP
            IF public.merge_two_library_items(v_primary_rec.id, v_dup_rec.id) THEN
                v_merged_count := v_merged_count + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN v_merged_count;
END;
$$ LANGUAGE plpgsql;

-- Main function to run multi-pass deduplication & multi-part book unification
CREATE OR REPLACE FUNCTION public.deduplicate_library_items()
RETURNS integer AS $$
DECLARE
    v_merged_count integer := 0;
    v_default_lib_id uuid;
    v_norm_title text;
    v_lib_id uuid;
    v_primary_id uuid;
    v_dup_id uuid;
    v_rec RECORD;
BEGIN
    -- 0. Assign default library & unite multi-part folder books under one book cover
    SELECT id INTO v_default_lib_id FROM public.libraries ORDER BY display_order ASC LIMIT 1;
    IF v_default_lib_id IS NOT NULL THEN
        UPDATE public.library_items SET library_id = v_default_lib_id WHERE library_id IS NULL;
    END IF;

    v_merged_count := v_merged_count + public.merge_multipart_folder_books();

    -- PASS 1: Exact / Normalized Title Matches
    FOR v_lib_id, v_norm_title IN
        SELECT library_id, public.normalize_book_title(title) as norm_title
        FROM public.library_items
        WHERE title IS NOT NULL AND trim(title) != ''
          AND public.normalize_book_title(title) != ''
        GROUP BY library_id, public.normalize_book_title(title)
        HAVING count(*) > 1
    LOOP
        SELECT id INTO v_primary_id
        FROM public.library_items
        WHERE library_id = v_lib_id
          AND public.normalize_book_title(title) = v_norm_title
        ORDER BY jsonb_array_length(coalesce(audio_files, '[]'::jsonb)) DESC,
                 case when cover_path is not null and cover_path != '' and cover_path != 'missing' then 1 else 0 end DESC,
                 created_at ASC
        LIMIT 1;

        FOR v_dup_id IN
            SELECT id
            FROM public.library_items
            WHERE library_id = v_lib_id
              AND public.normalize_book_title(title) = v_norm_title
              AND id != v_primary_id
        LOOP
            IF public.merge_two_library_items(v_primary_id, v_dup_id) THEN
                v_merged_count := v_merged_count + 1;
            END IF;
        END LOOP;
    END LOOP;

    -- PASS 2: Shared Specific Non-Generic Audio Files
    FOR v_rec IN
        SELECT DISTINCT ON (least(i1.id, i2.id), greatest(i1.id, i2.id))
               case when jsonb_array_length(coalesce(i1.audio_files, '[]'::jsonb)) >= jsonb_array_length(coalesce(i2.audio_files, '[]'::jsonb)) then i1.id else i2.id end as pri_id,
               case when jsonb_array_length(coalesce(i1.audio_files, '[]'::jsonb)) >= jsonb_array_length(coalesce(i2.audio_files, '[]'::jsonb)) then i2.id else i1.id end as dup_id
        FROM public.library_items i1
        JOIN public.library_items i2 ON i1.library_id = i2.library_id AND i1.id < i2.id
        WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(coalesce(i1.audio_files, '[]'::jsonb)) f1
            JOIN jsonb_array_elements(coalesce(i2.audio_files, '[]'::jsonb)) f2 
              ON coalesce(f1->'metadata'->>'filename', f1->'metadata'->>'relPath') = coalesce(f2->'metadata'->>'filename', f2->'metadata'->>'relPath')
            WHERE length(coalesce(f1->'metadata'->>'filename', f1->'metadata'->>'relPath', '')) > 15
              AND lower(coalesce(f1->'metadata'->>'filename', f1->'metadata'->>'relPath', '')) NOT SIMILAR TO '%(chapter|part|track|cd|disc|volume)\s*\d+%'
        )
    LOOP
        IF public.merge_two_library_items(v_rec.pri_id, v_rec.dup_id) THEN
            v_merged_count := v_merged_count + 1;
        END IF;
    END LOOP;

    -- PASS 3: Title Prefix + Author Matching (e.g. "And Yet" vs "And Yet...Essays")
    FOR v_rec IN
        SELECT DISTINCT ON (least(i1.id, i2.id), greatest(i1.id, i2.id))
               case when length(i1.title) <= length(i2.title) then i1.id else i2.id end as pri_id,
               case when length(i1.title) <= length(i2.title) then i2.id else i1.id end as dup_id
        FROM public.library_items i1
        JOIN public.library_items i2 ON i1.library_id = i2.library_id AND i1.id != i2.id
        WHERE public.normalize_book_title(i1.title) != '' AND public.normalize_book_title(i2.title) != ''
          AND (
            (public.normalize_book_title(i1.title) LIKE public.normalize_book_title(i2.title) || '%')
            OR
            (public.normalize_book_title(i2.title) LIKE public.normalize_book_title(i1.title) || '%')
          )
          AND (
            i1.author_names_first_last IS NULL OR i2.author_names_first_last IS NULL
            OR i1.author_names_first_last = 'Unknown Author' OR i2.author_names_first_last = 'Unknown Author'
            OR lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g'))
            OR lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g')) LIKE lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g')) || '%'
            OR lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g')) LIKE lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g')) || '%'
          )
          AND NOT (
            (i1.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+' AND i2.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+')
            AND regexp_replace(lower(i1.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2') != regexp_replace(lower(i2.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2')
          )
    LOOP
        IF public.merge_two_library_items(v_rec.pri_id, v_rec.dup_id) THEN
            v_merged_count := v_merged_count + 1;
        END IF;
    END LOOP;

    -- PASS 4: Trigram Fuzzy Similarity + Author Matching
    FOR v_rec IN
        SELECT DISTINCT ON (least(i1.id, i2.id), greatest(i1.id, i2.id))
               case when length(i1.title) <= length(i2.title) then i1.id else i2.id end as pri_id,
               case when length(i1.title) <= length(i2.title) then i2.id else i1.id end as dup_id
        FROM public.library_items i1
        JOIN public.library_items i2 ON i1.library_id = i2.library_id AND i1.id < i2.id
        WHERE public.normalize_book_title(i1.title) != '' AND public.normalize_book_title(i2.title) != ''
          AND similarity(public.normalize_book_title(i1.title), public.normalize_book_title(i2.title)) > 0.85
          AND (
            i1.author_names_first_last IS NULL OR i2.author_names_first_last IS NULL
            OR i1.author_names_first_last = 'Unknown Author' OR i2.author_names_first_last = 'Unknown Author'
            OR lower(regexp_replace(i1.author_names_first_last, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(i2.author_names_first_last, '[^[:alnum:]]', '', 'g'))
          )
          AND NOT (
            (i1.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+' AND i2.title ~* '\b(vol|volume|part|book|cd|disc)\s*\d+')
            AND regexp_replace(lower(i1.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2') != regexp_replace(lower(i2.title), '.*?\b(vol|volume|part|book|cd|disc)\s*(\d+).*', '\2')
          )
    LOOP
        IF public.merge_two_library_items(v_rec.pri_id, v_rec.dup_id) THEN
            v_merged_count := v_merged_count + 1;
        END IF;
    END LOOP;

    RETURN v_merged_count;
END;
$$ LANGUAGE plpgsql;

-- Schedule hourly cron job to automatically deduplicate library items every hour at :15
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'invoke-deduplicate-library-items-hourly',
            '15 * * * *',
            'SELECT public.deduplicate_library_items();'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    -- Ignore if pg_cron is not enabled or job already exists
END $$;

-- Execute immediate multi-pass deduplication & multi-part unification
SELECT public.deduplicate_library_items();
