-- Function to separate author names embedded inside titles and clean up existing library items
CREATE OR REPLACE FUNCTION public.separate_title_and_author_for_all_books()
RETURNS void AS $$
DECLARE
    rec RECORD;
    v_raw_title text;
    v_raw_author text;
    v_clean_title text;
    v_clean_author text;
    v_last_first_match text[];
BEGIN
    FOR rec IN 
        SELECT id, library_id, title, author_names_first_last 
        FROM public.library_items 
        WHERE title IS NOT NULL AND trim(title) != ''
    LOOP
        v_raw_title := trim(rec.title);
        v_raw_author := trim(coalesce(rec.author_names_first_last, ''));
        IF v_raw_author = 'Unknown Author' THEN
            v_raw_author := '';
        END IF;

        v_clean_title := v_raw_title;
        v_clean_author := v_raw_author;

        -- 1. Handle "Last, First -- Title" or "Last, First - Title" (e.g. "Sagan, Carl -- The Demon-Haunted World")
        IF v_raw_title ~ '^([A-Z][a-zA-Z''\-]+),\s*([A-Z][a-zA-Z''\-\.]+)\s*(?:--|-)\s*(.+)$' THEN
            v_last_first_match := regexp_matches(v_raw_title, '^([A-Z][a-zA-Z''\-]+),\s*([A-Z][a-zA-Z''\-\.]+)\s*(?:--|-)\s*(.+)$');
            v_clean_author := trim(v_last_first_match[2]) || ' ' || trim(v_last_first_match[1]);
            v_clean_title := trim(v_last_first_match[3]);
        
        -- 2. Handle "Author - Year - Title" or "Author - Title" (e.g. "Alexei Navalny - 2024 - Patriot", "Christopher Hitchens - Hitch-22")
        ELSIF v_raw_title ~ '^([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+){1,3})\s*(?:--|-)\s*(?:(19|20)\d{2}\s*(?:--|-)\s*)?(.+)$' THEN
            v_last_first_match := regexp_matches(v_raw_title, '^([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+){1,3})\s*(?:--|-)\s*(?:(19|20)\d{2}\s*(?:--|-)\s*)?(.+)$');
            IF v_clean_author = '' THEN
                v_clean_author := trim(v_last_first_match[1]);
            END IF;
            v_clean_title := trim(v_last_first_match[3]);

        -- 3. Handle "Title by Author" (e.g. "Essential CISSP by Phil Martin")
        ELSIF v_raw_title ~* '^(.+?)\s+by\s+([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+)+)$' THEN
            v_last_first_match := regexp_matches(v_raw_title, '^(.+?)\s+by\s+([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+)+)$', 'i');
            v_clean_title := trim(v_last_first_match[1]);
            IF v_clean_author = '' THEN
                v_clean_author := trim(v_last_first_match[2]);
            END IF;
        
        -- 4. Strip known author from title prefix if present (e.g. "Christopher Hitchens - Hitch-22" where author is "Christopher Hitchens")
        ELSIF v_clean_author != '' AND v_raw_title ~* ('^' || regexp_replace(v_clean_author, '([.*+?^${}()|[\]\\])', '\\\1', 'g') || '\s*(?:--|-|:)\s*(.+)$') THEN
            v_last_first_match := regexp_matches(v_raw_title, '^' || regexp_replace(v_clean_author, '([.*+?^${}()|[\]\\])', '\\\1', 'g') || '\s*(?:--|-|:)\s*(.+)$', 'i');
            v_clean_title := trim(v_last_first_match[1]);
        END IF;

        -- Clean up title trailing punctuation
        v_clean_title := trim(regexp_replace(v_clean_title, '^[-–—:\s]+|[-–—:\s]+$', '', 'g'));
        IF v_clean_author = '' THEN
            v_clean_author := 'Unknown Author';
        END IF;

        -- Update library_items if changes detected
        IF v_clean_title != v_raw_title OR (v_clean_author != v_raw_author AND v_clean_author != 'Unknown Author') THEN
            UPDATE public.library_items
            SET title = v_clean_title,
                author_names_first_last = v_clean_author
            WHERE id = rec.id;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Execute immediate title & author cleanup across all books
SELECT public.separate_title_and_author_for_all_books();

-- Update trigger function to run title/author separation before insert/update
CREATE OR REPLACE FUNCTION public.before_library_item_separate_title_author()
RETURNS TRIGGER AS $$
DECLARE
    v_raw_title text;
    v_raw_author text;
    v_clean_title text;
    v_clean_author text;
    v_match text[];
BEGIN
    v_raw_title := trim(coalesce(NEW.title, ''));
    v_raw_author := trim(coalesce(NEW.author_names_first_last, ''));
    IF v_raw_author = 'Unknown Author' THEN
        v_raw_author := '';
    END IF;

    v_clean_title := v_raw_title;
    v_clean_author := v_raw_author;

    -- 1. "Last, First -- Title"
    IF v_raw_title ~ '^([A-Z][a-zA-Z''\-]+),\s*([A-Z][a-zA-Z''\-\.]+)\s*(?:--|-)\s*(.+)$' THEN
        v_match := regexp_matches(v_raw_title, '^([A-Z][a-zA-Z''\-]+),\s*([A-Z][a-zA-Z''\-\.]+)\s*(?:--|-)\s*(.+)$');
        v_clean_author := trim(v_match[2]) || ' ' || trim(v_match[1]);
        v_clean_title := trim(v_match[3]);

    -- 2. "Author - Year - Title" or "Author - Title"
    ELSIF v_raw_title ~ '^([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+){1,3})\s*(?:--|-)\s*(?:(19|20)\d{2}\s*(?:--|-)\s*)?(.+)$' THEN
        v_match := regexp_matches(v_raw_title, '^([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+){1,3})\s*(?:--|-)\s*(?:(19|20)\d{2}\s*(?:--|-)\s*)?(.+)$');
        IF v_clean_author = '' THEN
            v_clean_author := trim(v_match[1]);
        END IF;
        v_clean_title := trim(v_match[3]);

    -- 3. "Title by Author"
    ELSIF v_raw_title ~* '^(.+?)\s+by\s+([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+)+)$' THEN
        v_match := regexp_matches(v_raw_title, '^(.+?)\s+by\s+([A-Z][a-zA-Z''\-\.]+(?:\s+[A-Z][a-zA-Z''\-\.]+)+)$', 'i');
        v_clean_title := trim(v_match[1]);
        IF v_clean_author = '' THEN
            v_clean_author := trim(v_match[2]);
        END IF;

    -- 4. Strip known author from title prefix if present
    ELSIF v_clean_author != '' AND v_raw_title ~* ('^' || regexp_replace(v_clean_author, '([.*+?^${}()|[\]\\])', '\\\1', 'g') || '\s*(?:--|-|:)\s*(.+)$') THEN
        v_match := regexp_matches(v_raw_title, '^' || regexp_replace(v_clean_author, '([.*+?^${}()|[\]\\])', '\\\1', 'g') || '\s*(?:--|-|:)\s*(.+)$', 'i');
        v_clean_title := trim(v_match[1]);
    END IF;

    v_clean_title := trim(regexp_replace(v_clean_title, '^[-–—:\s]+|[-–—:\s]+$', '', 'g'));
    
    NEW.title := v_clean_title;
    IF v_clean_author != '' THEN
        NEW.author_names_first_last := v_clean_author;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_before_library_item_separate_title_author ON public.library_items;
CREATE TRIGGER trigger_before_library_item_separate_title_author
BEFORE INSERT OR UPDATE OF title, author_names_first_last ON public.library_items
FOR EACH ROW
EXECUTE FUNCTION public.before_library_item_separate_title_author();
