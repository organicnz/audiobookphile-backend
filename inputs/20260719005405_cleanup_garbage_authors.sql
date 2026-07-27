-- ============================================================
-- Migration: Clean up garbage authors
-- 
-- Fixes known metadata ingestion errors where book titles or 
-- generic labels were incorrectly parsed as authors.
-- ============================================================

DO $$
DECLARE
  v_library_id UUID;
  v_garbage_author_id UUID;
  v_correct_author_id UUID;
  v_correct_author_id2 UUID;
BEGIN
  -- 1. "The Fabric of the Cosmos" (Title parsed as author)
  SELECT id, library_id INTO v_garbage_author_id, v_library_id
  FROM authors 
  WHERE name = 'The Fabric of the Cosmos'
  LIMIT 1;

  IF FOUND THEN
    -- Ensure "Brian Greene" exists in this library
    SELECT id INTO v_correct_author_id FROM authors WHERE name = 'Brian Greene' AND library_id = v_library_id LIMIT 1;
    IF NOT FOUND THEN
      v_correct_author_id := gen_random_uuid();
      INSERT INTO authors (id, library_id, name) VALUES (v_correct_author_id, v_library_id, 'Brian Greene');
    END IF;

    -- Re-assign books and fix titles
    UPDATE book_authors SET author_id = v_correct_author_id WHERE author_id = v_garbage_author_id;
    UPDATE books SET title = 'The Fabric of the Cosmos' 
    WHERE id IN (
      SELECT book_id FROM book_authors WHERE author_id = v_correct_author_id
    ) AND title LIKE 'CH %';

    -- Delete garbage
    DELETE FROM authors WHERE id = v_garbage_author_id;
  END IF;

  -- 2. "Thinker's Guide Library" (Publisher/Series parsed as author)
  SELECT id, library_id INTO v_garbage_author_id, v_library_id
  FROM authors 
  WHERE name = 'Thinker''s Guide Library'
  LIMIT 1;

  IF FOUND THEN
    -- Author 1: Richard Paul
    SELECT id INTO v_correct_author_id FROM authors WHERE name = 'Richard Paul' AND library_id = v_library_id LIMIT 1;
    IF NOT FOUND THEN
      v_correct_author_id := gen_random_uuid();
      INSERT INTO authors (id, library_id, name) VALUES (v_correct_author_id, v_library_id, 'Richard Paul');
    END IF;

    -- Author 2: Linda Elder
    SELECT id INTO v_correct_author_id2 FROM authors WHERE name = 'Linda Elder' AND library_id = v_library_id LIMIT 1;
    IF NOT FOUND THEN
      v_correct_author_id2 := gen_random_uuid();
      INSERT INTO authors (id, library_id, name) VALUES (v_correct_author_id2, v_library_id, 'Linda Elder');
    END IF;

    -- Re-assign books to Richard Paul
    UPDATE book_authors SET author_id = v_correct_author_id WHERE author_id = v_garbage_author_id;
    
    -- Insert mapping for Linda Elder (ignore if exists)
    INSERT INTO book_authors (book_id, author_id)
    SELECT book_id, v_correct_author_id2 
    FROM book_authors 
    WHERE author_id = v_correct_author_id
    ON CONFLICT DO NOTHING;

    -- Delete garbage
    DELETE FROM authors WHERE id = v_garbage_author_id;
  END IF;
END;
$$;
