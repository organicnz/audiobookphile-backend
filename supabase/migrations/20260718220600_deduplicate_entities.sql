-- 1. Deduplicate Authors
WITH duplicates AS (
  SELECT id,
         library_id,
         name,
         ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.authors
),
surviving AS (
  SELECT library_id, name, id as keep_id
  FROM duplicates
  WHERE row_num = 1
),
dupe_authors AS (
  SELECT id
  FROM duplicates
  WHERE row_num > 1
)
INSERT INTO public.book_authors (book_id, author_id)
SELECT ba.book_id, s.keep_id
FROM public.book_authors ba
JOIN public.authors a ON ba.author_id = a.id
JOIN surviving s ON a.library_id = s.library_id AND a.name = s.name
WHERE a.id != s.keep_id
ON CONFLICT (book_id, author_id) DO NOTHING;

WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.authors
)
DELETE FROM public.book_authors
WHERE author_id IN (SELECT id FROM duplicates WHERE row_num > 1);

WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.authors
)
DELETE FROM public.authors
WHERE id IN (SELECT id FROM duplicates WHERE row_num > 1);


-- 2. Deduplicate Series
WITH duplicates AS (
  SELECT id,
         library_id,
         name,
         ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.series
),
surviving AS (
  SELECT library_id, name, id as keep_id
  FROM duplicates
  WHERE row_num = 1
),
dupe_series AS (
  SELECT id
  FROM duplicates
  WHERE row_num > 1
)
INSERT INTO public.book_series (book_id, series_id, sequence)
SELECT bs.book_id, s.keep_id, bs.sequence
FROM public.book_series bs
JOIN public.series se ON bs.series_id = se.id
JOIN surviving s ON se.library_id = s.library_id AND se.name = s.name
WHERE se.id != s.keep_id
ON CONFLICT (book_id, series_id) DO NOTHING;

WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.series
)
DELETE FROM public.book_series
WHERE series_id IN (SELECT id FROM duplicates WHERE row_num > 1);

WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.series
)
DELETE FROM public.series
WHERE id IN (SELECT id FROM duplicates WHERE row_num > 1);


-- 3. Deduplicate Collections
WITH duplicates AS (
  SELECT id,
         library_id,
         name,
         ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.collections
),
surviving AS (
  SELECT library_id, name, id as keep_id
  FROM duplicates
  WHERE row_num = 1
),
dupe_colls AS (
  SELECT id
  FROM duplicates
  WHERE row_num > 1
)
INSERT INTO public.collection_books (collection_id, book_id, "order")
SELECT s.keep_id, ci.book_id, ci."order"
FROM public.collection_books ci
JOIN public.collections c ON ci.collection_id = c.id
JOIN surviving s ON c.library_id = s.library_id AND c.name = s.name
WHERE c.id != s.keep_id
ON CONFLICT (collection_id, book_id) DO NOTHING;

WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.collections
)
DELETE FROM public.collection_books
WHERE collection_id IN (SELECT id FROM duplicates WHERE row_num > 1);

WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY library_id, name ORDER BY created_at ASC) as row_num
  FROM public.collections
)
DELETE FROM public.collections
WHERE id IN (SELECT id FROM duplicates WHERE row_num > 1);


-- 4. Apply Unique Constraints
ALTER TABLE public.authors ADD CONSTRAINT authors_library_name_key UNIQUE (library_id, name);
ALTER TABLE public.series ADD CONSTRAINT series_library_name_key UNIQUE (library_id, name);
ALTER TABLE public.collections ADD CONSTRAINT collections_library_name_key UNIQUE (library_id, name);
