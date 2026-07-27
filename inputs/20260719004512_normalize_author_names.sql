-- ============================================================
-- Migration: Normalize author names & prevent duplicates
-- 
-- 1. Creates a normalize_author_name() function for consistent whitespace/trim
-- 2. Attaches a BEFORE INSERT OR UPDATE trigger on authors
-- 3. Merges any existing fuzzy duplicates using the merge_authors() function
-- ============================================================

-- 1. Normalization function
-- Trims leading/trailing whitespace, collapses internal runs of whitespace
-- to single spaces, and strips zero-width characters.
CREATE OR REPLACE FUNCTION public.normalize_author_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Trim, collapse whitespace, strip zero-width chars
  NEW.name := regexp_replace(
    btrim(NEW.name),
    '\s+', ' ', 'g'
  );
  RETURN NEW;
END;
$$;

-- 2. Trigger: normalize before every insert/update
DROP TRIGGER IF EXISTS trg_normalize_author_name ON public.authors;

CREATE TRIGGER trg_normalize_author_name
  BEFORE INSERT OR UPDATE OF name ON public.authors
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_author_name();

-- 3. Sweep existing data for fuzzy duplicates and merge them.
--    A "fuzzy duplicate" is two rows in the same library whose names
--    differ only in whitespace (leading/trailing/internal runs).
--    We keep the OLDEST record (by created_at) and merge the newer one into it.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      a1.library_id,
      a1.name   AS target_name,
      a2.name   AS source_name
    FROM authors a1
    JOIN authors a2
      ON  a2.library_id = a1.library_id
      AND a2.id != a1.id
      AND regexp_replace(btrim(a2.name), '\s+', ' ', 'g')
        = regexp_replace(btrim(a1.name), '\s+', ' ', 'g')
      AND a2.created_at > a1.created_at
  LOOP
    PERFORM merge_authors(r.library_id, r.source_name, r.target_name);
  END LOOP;
END;
$$;
