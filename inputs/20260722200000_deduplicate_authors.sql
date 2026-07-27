-- Migration: 20260722200000_deduplicate_authors.sql
-- 1. Deduplicate authors: Keep one author per (library_id, name)
WITH RankedAuthors AS (
  SELECT id, library_id, name,
         ROW_NUMBER() OVER(PARTITION BY library_id, name ORDER BY image_path NULLS LAST, created_at ASC) as rn
  FROM public.authors
)
-- Insert the deduplicated mappings into book_authors, ignoring conflicts if they already exist
INSERT INTO public.book_authors (library_item_id, author_id)
SELECT ba.library_item_id, kept.id
FROM public.book_authors ba
JOIN RankedAuthors dup ON dup.id = ba.author_id
JOIN RankedAuthors kept ON kept.library_id = dup.library_id AND kept.name = dup.name AND kept.rn = 1
WHERE dup.rn > 1
ON CONFLICT DO NOTHING;

-- 2. Delete the old mappings from book_authors
WITH RankedAuthors AS (
  SELECT id, library_id, name,
         ROW_NUMBER() OVER(PARTITION BY library_id, name ORDER BY image_path NULLS LAST, created_at ASC) as rn
  FROM public.authors
)
DELETE FROM public.book_authors
WHERE author_id IN (
  SELECT id FROM RankedAuthors WHERE rn > 1
);

-- 3. Delete the duplicate authors
WITH RankedAuthors AS (
  SELECT id, library_id, name,
         ROW_NUMBER() OVER(PARTITION BY library_id, name ORDER BY image_path NULLS LAST, created_at ASC) as rn
  FROM public.authors
)
DELETE FROM public.authors
WHERE id IN (
  SELECT id FROM RankedAuthors WHERE rn > 1
);

-- 4. Add the unique constraint so it never happens again
ALTER TABLE public.authors
ADD CONSTRAINT authors_library_id_name_key UNIQUE (library_id, name);
