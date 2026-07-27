DO $$
BEGIN
    CREATE TEMP TABLE tmp_split_authors ON COMMIT DROP AS
    SELECT DISTINCT
        old_author_id,
        library_id,
        TRIM(split_name) AS split_name
    FROM (
        SELECT
            id AS old_author_id,
            library_id,
            REGEXP_SPLIT_TO_TABLE(name, '\s*(?:/|,|&|\band\b)\s*', 'i') AS split_name
        FROM authors
        WHERE name ~* '\s*(?:/|,|&|\band\b)\s*'
    ) sub
    WHERE TRIM(split_name) != '';

    INSERT INTO authors (id, library_id, name)
    SELECT uuid_generate_v4(), t.library_id, t.split_name
    FROM tmp_split_authors t
    ON CONFLICT (library_id, name) DO NOTHING;

    INSERT INTO book_authors (book_id, author_id)
    SELECT ba.book_id, new_a.id
    FROM book_authors ba
    JOIN tmp_split_authors t ON ba.author_id = t.old_author_id
    JOIN authors new_a ON new_a.library_id = t.library_id AND new_a.name = t.split_name
    ON CONFLICT (book_id, author_id) DO NOTHING;

    DELETE FROM authors
    WHERE id IN (SELECT old_author_id FROM tmp_split_authors);

    -- -------------------------------------------------------------------------
    
    CREATE TEMP TABLE tmp_split_series ON COMMIT DROP AS
    SELECT DISTINCT
        old_series_id,
        library_id,
        TRIM(split_name) AS split_name
    FROM (
        SELECT
            id AS old_series_id,
            library_id,
            REGEXP_SPLIT_TO_TABLE(name, '\s*(?:/|,|&|\band\b)\s*', 'i') AS split_name
        FROM series
        WHERE name ~* '\s*(?:/|,|&|\band\b)\s*'
    ) sub
    WHERE TRIM(split_name) != '';

    INSERT INTO series (id, library_id, name)
    SELECT uuid_generate_v4(), t.library_id, t.split_name
    FROM tmp_split_series t
    ON CONFLICT (library_id, name) DO NOTHING;

    INSERT INTO book_series (book_id, series_id)
    SELECT bs.book_id, new_s.id
    FROM book_series bs
    JOIN tmp_split_series t ON bs.series_id = t.old_series_id
    JOIN series new_s ON new_s.library_id = t.library_id AND new_s.name = t.split_name
    ON CONFLICT (book_id, series_id) DO NOTHING;

    DELETE FROM series
    WHERE id IN (SELECT old_series_id FROM tmp_split_series);

END $$;
