-- 1. Create a function to check and delete orphaned authors
CREATE OR REPLACE FUNCTION check_and_delete_orphaned_author()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM book_authors WHERE author_id = OLD.author_id) THEN
        DELETE FROM authors WHERE id = OLD.author_id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- 2. Create the trigger for book_authors
CREATE TRIGGER cleanup_orphaned_author_trigger
AFTER DELETE OR UPDATE OF author_id ON book_authors
FOR EACH ROW
EXECUTE FUNCTION check_and_delete_orphaned_author();

-- 3. Same for series
CREATE OR REPLACE FUNCTION check_and_delete_orphaned_series()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM book_series WHERE series_id = OLD.series_id) THEN
        DELETE FROM series WHERE id = OLD.series_id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cleanup_orphaned_series_trigger
AFTER DELETE OR UPDATE OF series_id ON book_series
FOR EACH ROW
EXECUTE FUNCTION check_and_delete_orphaned_series();

-- 4. Same for collections
CREATE OR REPLACE FUNCTION check_and_delete_orphaned_collection()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM collection_books WHERE collection_id = OLD.collection_id) THEN
        DELETE FROM collections WHERE id = OLD.collection_id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cleanup_orphaned_collection_trigger
AFTER DELETE OR UPDATE OF collection_id ON collection_books
FOR EACH ROW
EXECUTE FUNCTION check_and_delete_orphaned_collection();

-- 5. Immediately clean up existing orphans
DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM book_authors);
DELETE FROM series WHERE id NOT IN (SELECT series_id FROM book_series);
DELETE FROM collections WHERE id NOT IN (SELECT collection_id FROM collection_books);
