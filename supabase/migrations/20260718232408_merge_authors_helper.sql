CREATE OR REPLACE FUNCTION merge_authors(p_target_name TEXT, p_source_name TEXT, p_library_id UUID)
RETURNS VOID AS $$
DECLARE
    v_target_id UUID;
    v_source_id UUID;
BEGIN
    -- Get source id
    SELECT id INTO v_source_id FROM authors WHERE name = p_source_name AND library_id = p_library_id;
    
    IF v_source_id IS NULL THEN
        RETURN; -- Source doesn't exist, nothing to do
    END IF;

    -- Get target id, if not exists, just rename source!
    SELECT id INTO v_target_id FROM authors WHERE name = p_target_name AND library_id = p_library_id;
    
    IF v_target_id IS NULL THEN
        UPDATE authors SET name = p_target_name WHERE id = v_source_id;
        RETURN;
    END IF;
    
    IF v_source_id = v_target_id THEN
        RETURN;
    END IF;

    -- Both exist. Update book_authors for source to point to target
    -- Need to handle duplicates in book_authors (if book is linked to both)
    INSERT INTO book_authors (book_id, author_id)
    SELECT book_id, v_target_id 
    FROM book_authors 
    WHERE author_id = v_source_id
    ON CONFLICT (book_id, author_id) DO NOTHING;

    -- Delete old links (which will trigger orphan cleanup and delete the source author if no other books are linked)
    DELETE FROM book_authors WHERE author_id = v_source_id;
    
    -- Safety delete of author
    DELETE FROM authors WHERE id = v_source_id;
END;
$$ LANGUAGE plpgsql;

-- Execute for existing libraries
DO $$
DECLARE 
    lib RECORD;
BEGIN
    FOR lib IN SELECT id FROM libraries LOOP
        PERFORM merge_authors('Richard P Feynman', 'Richard Phillips Feynman', lib.id);
        PERFORM merge_authors('Richard P Feynman', 'Feynman', lib.id);
        PERFORM merge_authors('Walter Isaacson', 'Walter Isaacson - Steve Jobs - 2011 - Collectors edition', lib.id);
        PERFORM merge_authors('Kelly McGonigal', 'Kelly McGonigal Ph.D.', lib.id);
        PERFORM merge_authors('Жан-Поль Сартр', 'Сартр Жан-Поль - Сумерки богов', lib.id);
    END LOOP;
END;
$$;
