-- Migration: 20260721000000_flatten_library_items.sql

-- 1. Add columns to `library_items`
ALTER TABLE public.library_items
ADD COLUMN IF NOT EXISTS abridged boolean,
ADD COLUMN IF NOT EXISTS asin text,
ADD COLUMN IF NOT EXISTS audio_files jsonb,
ADD COLUMN IF NOT EXISTS chapters jsonb,
ADD COLUMN IF NOT EXISTS description text,
ADD COLUMN IF NOT EXISTS duration numeric,
ADD COLUMN IF NOT EXISTS ebook_file jsonb,
ADD COLUMN IF NOT EXISTS explicit boolean,
ADD COLUMN IF NOT EXISTS genres jsonb,
ADD COLUMN IF NOT EXISTS isbn text,
ADD COLUMN IF NOT EXISTS language text,
ADD COLUMN IF NOT EXISTS narrators jsonb,
ADD COLUMN IF NOT EXISTS published_date text,
ADD COLUMN IF NOT EXISTS published_year text,
ADD COLUMN IF NOT EXISTS publisher text,
ADD COLUMN IF NOT EXISTS subtitle text,
ADD COLUMN IF NOT EXISTS tags jsonb,
ADD COLUMN IF NOT EXISTS title text;

-- 2. Migrate data from `books` to `library_items`
UPDATE public.library_items
SET 
  abridged = books.abridged,
  asin = books.asin,
  audio_files = books.audio_files,
  chapters = books.chapters,
  description = books.description,
  duration = books.duration,
  ebook_file = books.ebook_file,
  explicit = books.explicit,
  genres = books.genres,
  isbn = books.isbn,
  language = books.language,
  narrators = books.narrators,
  published_date = books.published_date,
  published_year = books.published_year,
  publisher = books.publisher,
  subtitle = books.subtitle,
  tags = books.tags,
  title = books.title
FROM public.books
WHERE public.library_items.media_id = public.books.id;

-- 3. Update related tables to point to library_items.id instead of books.id
-- First, book_authors
ALTER TABLE public.book_authors RENAME COLUMN book_id TO library_item_id;
ALTER TABLE public.book_authors DROP CONSTRAINT book_authors_book_id_fkey;

UPDATE public.book_authors
SET library_item_id = library_items.id
FROM public.library_items
WHERE book_authors.library_item_id = library_items.media_id;

ALTER TABLE public.book_authors
ADD CONSTRAINT book_authors_library_item_id_fkey
FOREIGN KEY (library_item_id) REFERENCES public.library_items(id) ON DELETE CASCADE;

-- book_series
ALTER TABLE public.book_series RENAME COLUMN book_id TO library_item_id;
ALTER TABLE public.book_series DROP CONSTRAINT book_series_book_id_fkey;

UPDATE public.book_series
SET library_item_id = library_items.id
FROM public.library_items
WHERE book_series.library_item_id = library_items.media_id;

ALTER TABLE public.book_series
ADD CONSTRAINT book_series_library_item_id_fkey
FOREIGN KEY (library_item_id) REFERENCES public.library_items(id) ON DELETE CASCADE;

-- collection_books -> collection_items
ALTER TABLE public.collection_books RENAME TO collection_items;
ALTER TABLE public.collection_items RENAME COLUMN book_id TO library_item_id;
ALTER TABLE public.collection_items DROP CONSTRAINT collection_books_book_id_fkey;

UPDATE public.collection_items
SET library_item_id = library_items.id
FROM public.library_items
WHERE collection_items.library_item_id = library_items.media_id;

ALTER TABLE public.collection_items
ADD CONSTRAINT collection_items_library_item_id_fkey
FOREIGN KEY (library_item_id) REFERENCES public.library_items(id) ON DELETE CASCADE;

-- 4. Backup the books table instead of dropping it immediately to ensure no data loss
ALTER TABLE public.books RENAME TO _backup_books_v1;
-- Also drop the foreign key on media_id to books so it doesn't complain when we later drop books
ALTER TABLE public.library_items DROP CONSTRAINT library_items_media_id_fkey;
