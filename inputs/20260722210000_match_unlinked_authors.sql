-- Function to match any library_items that have author_names_first_last populated but no book_authors links
CREATE OR REPLACE FUNCTION public.match_unlinked_authors()
RETURNS void AS $$
DECLARE
    rec RECORD;
    v_author_name text;
    v_clean_author text;
    v_author_id uuid;
    v_author_names text[];
BEGIN
    FOR rec IN 
        SELECT id, library_id, author_names_first_last 
        FROM public.library_items 
        WHERE author_names_first_last IS NOT NULL 
          AND trim(author_names_first_last) != ''
          AND id NOT IN (SELECT library_item_id FROM public.book_authors)
    LOOP
        -- Split on /, comma, &, or and
        v_author_names := regexp_split_to_array(rec.author_names_first_last, '\s*(?:/|,|&|\band\b)\s*');
        
        FOREACH v_author_name IN ARRAY v_author_names LOOP
            v_clean_author := trim(regexp_replace(v_author_name, '\s+', ' ', 'g'));
            IF v_clean_author IS NOT NULL AND v_clean_author != '' THEN
                -- Insert author if not exists
                INSERT INTO public.authors (id, name, library_id)
                VALUES (gen_random_uuid(), v_clean_author, rec.library_id)
                ON CONFLICT (library_id, name) DO NOTHING;

                -- Fetch author ID
                SELECT id INTO v_author_id
                FROM public.authors
                WHERE name = v_clean_author AND library_id = rec.library_id
                LIMIT 1;

                -- Link in book_authors
                IF v_author_id IS NOT NULL THEN
                    INSERT INTO public.book_authors (library_item_id, author_id)
                    VALUES (rec.id, v_author_id)
                    ON CONFLICT (library_item_id, author_id) DO NOTHING;
                END IF;
            END IF;
        END LOOP;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Execute the match immediately
SELECT public.match_unlinked_authors();

-- Create a trigger function to automatically create and link authors whenever library_items is inserted or updated
CREATE OR REPLACE FUNCTION public.auto_link_library_item_authors()
RETURNS TRIGGER AS $$
DECLARE
    v_author_name text;
    v_clean_author text;
    v_author_id uuid;
    v_author_names text[];
BEGIN
    IF NEW.author_names_first_last IS NOT NULL AND trim(NEW.author_names_first_last) != '' THEN
        v_author_names := regexp_split_to_array(NEW.author_names_first_last, '\s*(?:/|,|&|\band\b)\s*');
        
        FOREACH v_author_name IN ARRAY v_author_names LOOP
            v_clean_author := trim(regexp_replace(v_author_name, '\s+', ' ', 'g'));
            IF v_clean_author IS NOT NULL AND v_clean_author != '' THEN
                INSERT INTO public.authors (id, name, library_id)
                VALUES (gen_random_uuid(), v_clean_author, NEW.library_id)
                ON CONFLICT (library_id, name) DO NOTHING;

                SELECT id INTO v_author_id
                FROM public.authors
                WHERE name = v_clean_author AND library_id = NEW.library_id
                LIMIT 1;

                IF v_author_id IS NOT NULL THEN
                    INSERT INTO public.book_authors (library_item_id, author_id)
                    VALUES (NEW.id, v_author_id)
                    ON CONFLICT (library_item_id, author_id) DO NOTHING;
                END IF;
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_link_library_item_authors ON public.library_items;
CREATE TRIGGER trigger_auto_link_library_item_authors
AFTER INSERT OR UPDATE OF author_names_first_last ON public.library_items
FOR EACH ROW
EXECUTE FUNCTION public.auto_link_library_item_authors();
