CREATE OR REPLACE FUNCTION public.get_library_stats(p_library_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_total_items INT;
    v_total_books INT;
    v_total_authors INT;
    v_total_series INT;
    v_total_duration NUMERIC;
    v_total_size NUMERIC;
    v_added_last_30_days INT;
    v_num_audio_tracks INT;
    
    v_genres_json JSONB;
    v_authors_json JSONB;
    v_longest_json JSONB;
    v_largest_json JSONB;
    
    v_result JSONB;
BEGIN
    -- Basic counts from library_items
    SELECT 
        COUNT(*),
        COUNT(*), -- Assumes all are books for now
        COALESCE(SUM(duration), 0),
        COALESCE(SUM(size), 0),
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')
    INTO 
        v_total_items,
        v_total_books,
        v_total_duration,
        v_total_size,
        v_added_last_30_days
    FROM public.library_items
    WHERE library_id = p_library_id AND is_missing = FALSE AND is_invalid = FALSE;
    
    -- Count total authors and series for this library
    SELECT COUNT(*) INTO v_total_authors FROM public.authors WHERE library_id = p_library_id;
    SELECT COUNT(*) INTO v_total_series FROM public.series WHERE library_id = p_library_id;
    
    -- Audio tracks (summing json array length)
    SELECT COALESCE(SUM(jsonb_array_length(audio_files)), 0)
    INTO v_num_audio_tracks
    FROM public.library_items
    WHERE library_id = p_library_id AND audio_files IS NOT NULL AND jsonb_typeof(audio_files) = 'array';
    
    -- Genres with count
    WITH unnested_genres AS (
        SELECT jsonb_array_elements_text(genres) AS genre
        FROM public.library_items
        WHERE library_id = p_library_id AND genres IS NOT NULL AND jsonb_typeof(genres) = 'array'
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('genre', genre, 'count', count)), '[]'::jsonb)
    INTO v_genres_json
    FROM (
        SELECT genre, COUNT(*) as count
        FROM unnested_genres
        GROUP BY genre
        ORDER BY count DESC
        LIMIT 50
    ) t;

    -- Authors with count
    -- This ensures we use the proper book_authors mapping to get accurate counts
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'count', count)), '[]'::jsonb)
    INTO v_authors_json
    FROM (
        SELECT a.id, a.name, COUNT(ba.library_item_id) as count
        FROM public.authors a
        JOIN public.book_authors ba ON a.id = ba.author_id
        JOIN public.library_items li ON ba.library_item_id = li.id
        WHERE a.library_id = p_library_id AND li.library_id = p_library_id
        GROUP BY a.id, a.name
        ORDER BY count DESC
        LIMIT 50
    ) t;

    -- Longest items
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'duration', duration)), '[]'::jsonb)
    INTO v_longest_json
    FROM (
        SELECT id, title, duration
        FROM public.library_items
        WHERE library_id = p_library_id AND duration IS NOT NULL
        ORDER BY duration DESC
        LIMIT 10
    ) t;

    -- Largest items
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'size', size)), '[]'::jsonb)
    INTO v_largest_json
    FROM (
        SELECT id, title, size
        FROM public.library_items
        WHERE library_id = p_library_id AND size IS NOT NULL
        ORDER BY size DESC
        LIMIT 10
    ) t;

    v_result := jsonb_build_object(
        'totalItems', v_total_items,
        'totalBooks', v_total_books,
        'totalAuthors', v_total_authors,
        'totalSeries', v_total_series,
        'totalDuration', v_total_duration,
        'totalSize', v_total_size,
        'addedLast30Days', v_added_last_30_days,
        'numAudioTracks', v_num_audio_tracks,
        'genresWithCount', v_genres_json,
        'authorsWithCount', v_authors_json,
        'longestItems', v_longest_json,
        'largestItems', v_largest_json
    );

    RETURN v_result;
END;
$$;
