-- Migration: Extend profiles table and add updated_at trigger
-- Requirements: 4.3, 4.11
--
-- The `profiles` table is created automatically by Supabase Auth with only `id`.
-- This migration adds the application-specific columns and the reusable
-- `set_updated_at` trigger function used by all tables that track record lifecycle.

-- ============================================================
-- 1. Reusable trigger function: set_updated_at
--    Updates the `updated_at` column to now() on every row modification.
--    Attach to any table with:
--      CREATE TRIGGER set_updated_at
--        BEFORE UPDATE ON <table>
--        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- 2. Extend the existing profiles table
--    Supabase Auth creates profiles with only `id uuid PRIMARY KEY`.
--    We add all application columns here.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username           text,
  ADD COLUMN IF NOT EXISTS user_type          text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS language           text NOT NULL DEFAULT 'en-us',
  ADD COLUMN IF NOT EXISTS theme              text NOT NULL DEFAULT 'dark',
  -- default_library_id references public.libraries(id), which is created in the
  -- next migration (20240001000001_libraries_and_library_items). The FK constraint
  -- is added there via ALTER TABLE public.profiles ADD CONSTRAINT ...
  ADD COLUMN IF NOT EXISTS default_library_id uuid,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz DEFAULT now();

-- ============================================================
-- 3. Attach the updated_at trigger to profiles
-- ============================================================

DROP TRIGGER IF EXISTS set_updated_at ON public.profiles;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Migration: libraries and library_items tables
-- Requirements: 4.1, 4.4, 4.5, 4.6, 4.7, 4.12, 4.13
--
-- Creates the `libraries` and `library_items` tables, attaches the
-- `set_updated_at` trigger to both, and adds the deferred FK from
-- `profiles.default_library_id` to `libraries.id` (the FK was intentionally
-- omitted from the previous migration because `libraries` did not yet exist).

-- ============================================================
-- 1. libraries
--    Top-level container for a collection of books or podcasts.
--    Replaces the ABS `Library` entity.
--    Requirements: 4.7 (CHECK on media_type), 4.12 (column list)
-- ============================================================

CREATE TABLE public.libraries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  media_type    text        NOT NULL CHECK (media_type IN ('book', 'podcast')),
  icon          text        NOT NULL DEFAULT 'database',
  display_order integer     NOT NULL DEFAULT 0,
  settings      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz          DEFAULT now(),
  updated_at    timestamptz          DEFAULT now()
);

-- Attach the reusable updated_at trigger (function defined in migration 000000)
DROP TRIGGER IF EXISTS set_updated_at ON public.libraries;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.libraries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 2. library_items
--    Each row is a single book or podcast.
--    Replaces the ABS `LibraryItem` entity.
--    Requirements: 4.4 (cascade from library_items), 4.5 (cascade from libraries),
--                  4.6 (CHECK on media_type), 4.13 (column list)
-- ============================================================

CREATE TABLE public.library_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id      uuid        NOT NULL REFERENCES public.libraries(id) ON DELETE CASCADE,
  media_type      text        NOT NULL CHECK (media_type IN ('book', 'podcast')),

  -- Shared metadata
  title           text        NOT NULL,
  subtitle        text,
  description     text,
  cover_path      text,   -- Supabase Storage path: covers/{item_id}/cover.jpg
  tags            text[]  NOT NULL DEFAULT '{}',
  genres          text[]  NOT NULL DEFAULT '{}',
  language        text,
  explicit        boolean NOT NULL DEFAULT false,

  -- Book-specific metadata (null for podcasts)
  publisher       text,
  published_year  text,
  published_date  text,
  isbn            text,
  asin            text,
  abridged        boolean,

  -- Podcast-specific metadata (null for books)
  feed_url                  text,
  image_url                 text,
  itunes_id                 text,
  auto_download_episodes    boolean DEFAULT false,
  auto_download_schedule    text,
  max_episodes_to_keep      integer,

  -- Computed / display fields
  duration        numeric,  -- total duration in seconds
  size            bigint,   -- total size in bytes
  num_files       integer,

  added_at        timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Attach the reusable updated_at trigger
DROP TRIGGER IF EXISTS set_updated_at ON public.library_items;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.library_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 3. Deferred FK: profiles.default_library_id → libraries.id
--    The profiles table was created in migration 000000 without this FK
--    because libraries did not exist yet. Now that libraries exists we
--    add the constraint.
--    Requirements: 4.11 (profiles column list)
-- ============================================================

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_default_library_id_fkey
    FOREIGN KEY (default_library_id)
    REFERENCES public.libraries(id)
    ON DELETE SET NULL;
-- Migration: authors, narrators, and series tables
-- Requirements: 4.1, 4.4, 4.9
--
-- Creates the `authors`, `book_authors`, `narrators`, `book_narrators`,
-- `series`, and `book_series` tables.
--
-- Key constraints:
--   • `authors` and `series` cascade-delete from `libraries` (Req 4.5)
--   • `narrators` cascade-delete from `libraries` (Req 4.5)
--   • All join tables cascade-delete from both `library_items` and their
--     respective entity table (Req 4.4)
--   • `narrators` enforces UNIQUE (library_id, name) (Req 4.9)
--   • `authors` and `series` carry `updated_at` managed by the reusable
--     `set_updated_at` trigger (Req 4.3)

-- ============================================================
-- 1. authors
--    One row per author, scoped to a library.
--    Cascade-deletes when the parent library is deleted.
-- ============================================================

CREATE TABLE public.authors (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id  uuid        NOT NULL REFERENCES public.libraries(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  name_lf     text,        -- "Last, First" format for sorting
  description text,
  image_path  text,        -- Supabase Storage path: covers/authors/{author_id}/photo.jpg
  asin        text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Attach the reusable updated_at trigger (function defined in migration 000000)
DROP TRIGGER IF EXISTS set_updated_at ON public.authors;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.authors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 2. book_authors  (join table: library_items ↔ authors)
--    Cascade-deletes when either the book or the author is deleted.
--    Requirements: 4.4 (cascade from library_items)
-- ============================================================

CREATE TABLE public.book_authors (
  book_id    uuid NOT NULL REFERENCES public.library_items(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES public.authors(id)       ON DELETE CASCADE,
  PRIMARY KEY (book_id, author_id)
);

-- ============================================================
-- 3. narrators
--    One row per narrator, scoped to a library.
--    Enforces UNIQUE (library_id, name) per Req 4.9.
--    Cascade-deletes when the parent library is deleted.
-- ============================================================

CREATE TABLE public.narrators (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid        NOT NULL REFERENCES public.libraries(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  UNIQUE (library_id, name)
);

-- ============================================================
-- 4. book_narrators  (join table: library_items ↔ narrators)
--    Cascade-deletes when either the book or the narrator is deleted.
--    Requirements: 4.4 (cascade from library_items)
-- ============================================================

CREATE TABLE public.book_narrators (
  book_id     uuid NOT NULL REFERENCES public.library_items(id) ON DELETE CASCADE,
  narrator_id uuid NOT NULL REFERENCES public.narrators(id)     ON DELETE CASCADE,
  PRIMARY KEY (book_id, narrator_id)
);

-- ============================================================
-- 5. series
--    One row per series, scoped to a library.
--    Cascade-deletes when the parent library is deleted.
-- ============================================================

CREATE TABLE public.series (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id         uuid        NOT NULL REFERENCES public.libraries(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  name_ignore_prefix text,        -- name without leading articles for sorting
  description        text,
  cover_path         text,        -- Supabase Storage path
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

-- Attach the reusable updated_at trigger
DROP TRIGGER IF EXISTS set_updated_at ON public.series;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.series
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 6. book_series  (join table: library_items ↔ series)
--    `sequence` stores the position within the series (e.g. "1", "2.5").
--    Cascade-deletes when either the book or the series is deleted.
--    Requirements: 4.4 (cascade from library_items)
-- ============================================================

CREATE TABLE public.book_series (
  book_id   uuid NOT NULL REFERENCES public.library_items(id) ON DELETE CASCADE,
  series_id uuid NOT NULL REFERENCES public.series(id)        ON DELETE CASCADE,
  sequence  text,  -- e.g. "1", "2.5", "Book 3"
  PRIMARY KEY (book_id, series_id)
);
-- Migration: audio_files, chapters, and podcast_episodes tables
-- Requirements: 4.1, 4.4, 4.10, 4.14
--
-- Creates the `podcast_episodes`, `audio_files`, and `chapters` tables.
--
-- Creation order matters:
--   • `podcast_episodes` is created first because `audio_files.episode_id`
--     references `podcast_episodes.id`.
--   • `audio_files` is created second.
--   • `chapters` is created last (references both `library_items` and
--     `audio_files`).
--
-- Key constraints:
--   • All three tables cascade-delete from `library_items` (Req 4.4)
--   • `audio_files.episode_id` cascade-deletes from `podcast_episodes` (Req 4.4)
--   • `chapters.audio_file_id` cascade-deletes from `audio_files` (Req 4.4)
--   • `chapters` enforces UNIQUE (library_item_id, chapter_index) (Req 4.10)
--   • `audio_files` includes `storage_path`, `track_index`, and codec
--     metadata columns (Req 4.14)
--   • `podcast_episodes` carries `updated_at` managed by the reusable
--     `set_updated_at` trigger (Req 4.3)

-- ============================================================
-- 1. podcast_episodes
--    One row per episode belonging to a podcast library item.
--    Must be created before `audio_files` because audio_files
--    references this table.
--    Cascade-deletes when the parent library_item is deleted.
--    Requirements: 4.1, 4.4
-- ============================================================

CREATE TABLE public.podcast_episodes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_item_id uuid        NOT NULL REFERENCES public.library_items(id) ON DELETE CASCADE,
  episode_index   integer,
  season          text,
  episode         text,
  episode_type    text,
  title           text        NOT NULL,
  subtitle        text,
  description     text,
  pub_date        text,
  published_at    timestamptz,
  guid            text,
  enclosure_url   text,
  enclosure_type  text,
  duration        numeric,    -- seconds
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Attach the reusable updated_at trigger (function defined in migration 000000)
DROP TRIGGER IF EXISTS set_updated_at ON public.podcast_episodes;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.podcast_episodes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 2. audio_files
--    One row per audio file belonging to a book or podcast episode.
--    Replaces the ABS `AudioFile` entity.
--    Cascade-deletes when the parent library_item is deleted.
--    episode_id cascade-deletes when the parent podcast_episode is deleted.
--    Requirements: 4.1, 4.4, 4.14
-- ============================================================

CREATE TABLE public.audio_files (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_item_id uuid        NOT NULL REFERENCES public.library_items(id)    ON DELETE CASCADE,
  episode_id      uuid                 REFERENCES public.podcast_episodes(id) ON DELETE CASCADE,
  storage_path    text        NOT NULL,  -- Supabase Storage path: audio/{item_id}/{file_id}/{filename}
  filename        text        NOT NULL,
  mime_type       text        NOT NULL,
  size            bigint      NOT NULL,
  duration        numeric     NOT NULL,  -- seconds
  track_index     integer     NOT NULL DEFAULT 0,

  -- Codec metadata columns
  bit_rate        integer,
  codec           text,
  channels        integer,
  channel_layout  text,

  created_at      timestamptz DEFAULT now()
);

-- ============================================================
-- 3. chapters
--    One row per chapter marker, scoped to a library_item.
--    Optionally linked to a specific audio_file.
--    Cascade-deletes when the parent library_item is deleted.
--    audio_file_id cascade-deletes when the parent audio_file is deleted.
--    Enforces UNIQUE (library_item_id, chapter_index) per Req 4.10.
--    Requirements: 4.1, 4.4, 4.10
-- ============================================================

CREATE TABLE public.chapters (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_item_id uuid        NOT NULL REFERENCES public.library_items(id) ON DELETE CASCADE,
  audio_file_id   uuid                 REFERENCES public.audio_files(id)   ON DELETE CASCADE,
  chapter_index   integer     NOT NULL,
  title           text        NOT NULL,
  start_time      numeric     NOT NULL,  -- seconds
  end_time        numeric     NOT NULL,  -- seconds
  UNIQUE (library_item_id, chapter_index)
);
-- Migration: media_progress, collections, playlists, bookmarks tables
-- Requirements: 4.1, 4.4, 4.8, 4.15
--
-- Creates the `media_progress`, `collections`, `collection_items`,
-- `playlists`, `playlist_items`, and `bookmarks` tables.
--
-- Key constraints:
--   • `media_progress` enforces UNIQUE NULLS NOT DISTINCT (user_id, library_item_id, episode_id)
--     to prevent duplicate progress rows, including when episode_id IS NULL (Req 4.8)
--   • All tables cascade-delete from `library_items` (Req 4.4)
--   • `media_progress`, `playlists`, `playlist_items`, and `bookmarks`
--     cascade-delete from `auth.users` (Req 4.4)
--   • `collection_items` and `playlist_items` cascade-delete from their
--     parent collection/playlist (Req 4.4)
--   • `media_progress` columns match Req 4.15:
--     id, user_id, library_item_id, episode_id, current_time_pos,
--     duration, progress, is_finished, last_update

-- ============================================================
-- 1. media_progress
--    Tracks per-user playback position for books and podcast episodes.
--    Cascade-deletes when the parent library_item or auth.user is deleted.
--    Enforces UNIQUE (user_id, library_item_id, episode_id) per Req 4.8.
--    NULLS NOT DISTINCT ensures that two book-progress rows (episode_id IS NULL)
--    for the same (user_id, library_item_id) are treated as duplicates.
--    Requires Postgres 15+ (available on all current Supabase projects).
--    Requirements: 4.1, 4.4, 4.8, 4.15
-- ============================================================

CREATE TABLE public.media_progress (
  id                           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                      uuid        NOT NULL REFERENCES auth.users(id)            ON DELETE CASCADE,
  library_item_id              uuid        NOT NULL REFERENCES public.library_items(id)  ON DELETE CASCADE,
  episode_id                   uuid                 REFERENCES public.podcast_episodes(id) ON DELETE CASCADE,
  current_time_pos             numeric     NOT NULL DEFAULT 0,  -- seconds
  duration                     numeric,                          -- total duration in seconds
  progress                     numeric,                          -- 0.0 to 1.0
  is_finished                  boolean     NOT NULL DEFAULT false,
  hide_from_continue_listening boolean     NOT NULL DEFAULT false,
  finished_at                  timestamptz,
  last_update                  timestamptz DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (user_id, library_item_id, episode_id)
);

-- ============================================================
-- 2. collections
--    Admin-managed, library-scoped groupings of books.
--    Shared across all authenticated users (read-all, admin-write).
--    Cascade-deletes when the parent library is deleted.
--    Requirements: 4.1, 4.4
-- ============================================================

CREATE TABLE public.collections (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id  uuid        NOT NULL REFERENCES public.libraries(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  description text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Attach the reusable updated_at trigger (function defined in migration 000000)
DROP TRIGGER IF EXISTS set_updated_at ON public.collections;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 3. collection_items
--    Join table linking books to collections with display ordering.
--    Cascade-deletes when the parent collection or book is deleted.
--    Requirements: 4.1, 4.4
-- ============================================================

CREATE TABLE public.collection_items (
  collection_id uuid        NOT NULL REFERENCES public.collections(id)    ON DELETE CASCADE,
  book_id       uuid        NOT NULL REFERENCES public.library_items(id)  ON DELETE CASCADE,
  display_order integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, book_id)
);

-- ============================================================
-- 4. playlists
--    Per-user, library-scoped ordered lists of books/episodes.
--    Cascade-deletes when the parent library or auth.user is deleted.
--    Requirements: 4.1, 4.4
-- ============================================================

CREATE TABLE public.playlists (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id)         ON DELETE CASCADE,
  library_id  uuid        NOT NULL REFERENCES public.libraries(id)   ON DELETE CASCADE,
  name        text        NOT NULL,
  description text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Attach the reusable updated_at trigger (function defined in migration 000000)
DROP TRIGGER IF EXISTS set_updated_at ON public.playlists;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.playlists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 5. playlist_items
--    Ordered entries in a playlist; each entry is a library item
--    (book or podcast episode).
--    Cascade-deletes when the parent playlist, library_item, or
--    podcast_episode is deleted.
--    Requirements: 4.1, 4.4
-- ============================================================

CREATE TABLE public.playlist_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id     uuid        NOT NULL REFERENCES public.playlists(id)          ON DELETE CASCADE,
  library_item_id uuid        NOT NULL REFERENCES public.library_items(id)      ON DELETE CASCADE,
  episode_id      uuid                 REFERENCES public.podcast_episodes(id)   ON DELETE CASCADE,
  display_order   integer     NOT NULL DEFAULT 0
);

-- ============================================================
-- 6. bookmarks
--    Per-user time-position markers within a library item.
--    Cascade-deletes when the parent library_item or auth.user is deleted.
--    Requirements: 4.1, 4.4
-- ============================================================

CREATE TABLE public.bookmarks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id)           ON DELETE CASCADE,
  library_item_id uuid        NOT NULL REFERENCES public.library_items(id) ON DELETE CASCADE,
  time_pos        numeric     NOT NULL,  -- seconds
  title           text,
  created_at      timestamptz DEFAULT now()
);
-- Migration: on_auth_user_created trigger
-- Requirements: 2.1, 2.2, 2.3, 2.4
--
-- Creates a trigger function that automatically inserts a profiles row
-- whenever a new user is created in auth.users.
-- The first user (empty profiles table) is assigned user_type = 'admin';
-- all subsequent users get user_type = 'user'.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, username, user_type)
  VALUES (
    NEW.id,
    SPLIT_PART(NEW.email, '@', 1),
    CASE
      WHEN (SELECT COUNT(*) FROM public.profiles) = 0 THEN 'admin'
      ELSE 'user'
    END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
-- Migration: RLS policies for all tables
-- Requirements: 3.1, 3.2, 3.3, 3.4, 5.1–5.10
--
-- Enables Row Level Security on every table in the public schema and
-- defines the following policy groups:
--
--   Catalog tables (libraries, library_items, authors, series, narrators,
--   audio_files, chapters, podcast_episodes, collections, collection_items):
--     • Authenticated users can SELECT (read-all)
--     • Admins (profiles.user_type = 'admin') can INSERT / UPDATE / DELETE
--
--   Per-user tables (media_progress, playlists, playlist_items, bookmarks):
--     • Users can SELECT / INSERT / UPDATE / DELETE their own rows
--       (user_id = auth.uid() or via parent playlist ownership)
--
--   profiles:
--     • Users can SELECT and UPDATE their own row (id = auth.uid())
--     • Admins can SELECT all rows
--     • Users can INSERT their own row (handled by the trigger, but policy
--       allows it for completeness)

-- ============================================================
-- Helper: reusable admin check
--   Returns true when the calling user has user_type = 'admin' in profiles.
--   Uses SECURITY DEFINER to bypass RLS and prevent infinite recursion.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND user_type = 'admin'
  );
$$;

-- ============================================================
-- 1. profiles
--    Requirements: 5.1, 5.8, 5.9, 5.10
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile row
CREATE POLICY "profiles: users can read own row"
  ON public.profiles
  FOR SELECT
  USING (id = auth.uid());

-- Admins can read all profile rows
CREATE POLICY "profiles: admins can read all rows"
  ON public.profiles
  FOR SELECT
  USING (
    public.is_admin()
  );

-- Users can update their own profile row
CREATE POLICY "profiles: users can update own row"
  ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Users can insert their own profile row (trigger-driven, but policy permits it)
CREATE POLICY "profiles: users can insert own row"
  ON public.profiles
  FOR INSERT
  WITH CHECK (id = auth.uid());

-- ============================================================
-- 2. libraries
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.libraries ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read libraries
CREATE POLICY "libraries: authenticated users can read"
  ON public.libraries
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Admins can insert, update, and delete libraries
CREATE POLICY "libraries: admins can write"
  ON public.libraries
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 3. library_items
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.library_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "library_items: authenticated users can read"
  ON public.library_items
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "library_items: admins can write"
  ON public.library_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 4. authors
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.authors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authors: authenticated users can read"
  ON public.authors
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "authors: admins can write"
  ON public.authors
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 5. book_authors (join table)
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.book_authors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "book_authors: authenticated users can read"
  ON public.book_authors
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "book_authors: admins can write"
  ON public.book_authors
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 6. narrators
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.narrators ENABLE ROW LEVEL SECURITY;

CREATE POLICY "narrators: authenticated users can read"
  ON public.narrators
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "narrators: admins can write"
  ON public.narrators
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 7. book_narrators (join table)
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.book_narrators ENABLE ROW LEVEL SECURITY;

CREATE POLICY "book_narrators: authenticated users can read"
  ON public.book_narrators
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "book_narrators: admins can write"
  ON public.book_narrators
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 8. series
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "series: authenticated users can read"
  ON public.series
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "series: admins can write"
  ON public.series
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 9. book_series (join table)
--    Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.book_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "book_series: authenticated users can read"
  ON public.book_series
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "book_series: admins can write"
  ON public.book_series
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 10. audio_files
--     Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.audio_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audio_files: authenticated users can read"
  ON public.audio_files
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "audio_files: admins can write"
  ON public.audio_files
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 11. chapters
--     Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chapters: authenticated users can read"
  ON public.chapters
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "chapters: admins can write"
  ON public.chapters
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 12. podcast_episodes
--     Requirements: 3.1, 3.2, 3.3, 5.1
-- ============================================================

ALTER TABLE public.podcast_episodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "podcast_episodes: authenticated users can read"
  ON public.podcast_episodes
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "podcast_episodes: admins can write"
  ON public.podcast_episodes
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 13. collections
--     Requirements: 3.1, 3.2, 3.3, 5.1, 12.1, 12.2, 12.3
-- ============================================================

ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collections: authenticated users can read"
  ON public.collections
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "collections: admins can write"
  ON public.collections
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 14. collection_items
--     Requirements: 3.1, 3.2, 3.3, 5.1, 12.1, 12.2, 12.3
-- ============================================================

ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_items: authenticated users can read"
  ON public.collection_items
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "collection_items: admins can write"
  ON public.collection_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND user_type = 'admin'
    )
  );

-- ============================================================
-- 15. media_progress
--     Requirements: 5.1, 5.2, 5.3
-- ============================================================

ALTER TABLE public.media_progress ENABLE ROW LEVEL SECURITY;

-- Users can read only their own progress rows
CREATE POLICY "media_progress: users can read own rows"
  ON public.media_progress
  FOR SELECT
  USING (user_id = auth.uid());

-- Users can insert only rows for themselves
CREATE POLICY "media_progress: users can insert own rows"
  ON public.media_progress
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can update only their own progress rows
CREATE POLICY "media_progress: users can update own rows"
  ON public.media_progress
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users can delete only their own progress rows
CREATE POLICY "media_progress: users can delete own rows"
  ON public.media_progress
  FOR DELETE
  USING (user_id = auth.uid());

-- ============================================================
-- 16. playlists
--     Requirements: 5.1, 5.4, 5.5
-- ============================================================

ALTER TABLE public.playlists ENABLE ROW LEVEL SECURITY;

-- Users can read only their own playlists
CREATE POLICY "playlists: users can read own rows"
  ON public.playlists
  FOR SELECT
  USING (user_id = auth.uid());

-- Users can insert only playlists for themselves
CREATE POLICY "playlists: users can insert own rows"
  ON public.playlists
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can update only their own playlists
CREATE POLICY "playlists: users can update own rows"
  ON public.playlists
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users can delete only their own playlists
CREATE POLICY "playlists: users can delete own rows"
  ON public.playlists
  FOR DELETE
  USING (user_id = auth.uid());

-- ============================================================
-- 17. playlist_items
--     Requirements: 5.1, 5.4, 5.5
--
--     playlist_items has no direct user_id column; ownership is
--     determined via the parent playlist's user_id.
-- ============================================================

ALTER TABLE public.playlist_items ENABLE ROW LEVEL SECURITY;

-- Users can read items belonging to their own playlists
CREATE POLICY "playlist_items: users can read own rows"
  ON public.playlist_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE id = playlist_items.playlist_id
        AND user_id = auth.uid()
    )
  );

-- Users can insert items into their own playlists
CREATE POLICY "playlist_items: users can insert own rows"
  ON public.playlist_items
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE id = playlist_items.playlist_id
        AND user_id = auth.uid()
    )
  );

-- Users can update items in their own playlists
CREATE POLICY "playlist_items: users can update own rows"
  ON public.playlist_items
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE id = playlist_items.playlist_id
        AND user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE id = playlist_items.playlist_id
        AND user_id = auth.uid()
    )
  );

-- Users can delete items from their own playlists
CREATE POLICY "playlist_items: users can delete own rows"
  ON public.playlist_items
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.playlists
      WHERE id = playlist_items.playlist_id
        AND user_id = auth.uid()
    )
  );

-- ============================================================
-- 18. bookmarks
--     Requirements: 5.1, 5.6, 5.7
-- ============================================================

ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;

-- Users can read only their own bookmarks
CREATE POLICY "bookmarks: users can read own rows"
  ON public.bookmarks
  FOR SELECT
  USING (user_id = auth.uid());

-- Users can insert only bookmarks for themselves
CREATE POLICY "bookmarks: users can insert own rows"
  ON public.bookmarks
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can update only their own bookmarks
CREATE POLICY "bookmarks: users can update own rows"
  ON public.bookmarks
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Users can delete only their own bookmarks
CREATE POLICY "bookmarks: users can delete own rows"
  ON public.bookmarks
  FOR DELETE
  USING (user_id = auth.uid());
-- Migration: search_library_items RPC function and FTS indexes
-- Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
--
-- Creates a GIN index on the tsvector of title + description for fast
-- full-text search, then defines the search_library_items() RPC function
-- that the API module calls via supabase.rpc().
--
-- The function:
--   • Accepts p_library_id, p_query, and an optional p_limit (default 12)
--   • Filters results to the specified library (Req 11.4)
--   • Uses plainto_tsquery so plain user input is safe (no tsquery syntax needed)
--   • Ranks results by ts_rank descending (Req 11.3)
--   • Aggregates author_names and series_names via LEFT JOINs (Req 11.5)
--   • Returns an empty set when no items match (Req 11.6)

-- ============================================================
-- GIN index for fast full-text search on library_items
-- ============================================================

CREATE INDEX IF NOT EXISTS library_items_fts_idx
  ON public.library_items
  USING GIN (
    to_tsvector('english', title || ' ' || COALESCE(description, ''))
  );

-- ============================================================
-- RPC function: search_library_items
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_library_items(
  p_library_id uuid,
  p_query      text,
  p_limit      integer DEFAULT 12
)
RETURNS TABLE (
  id           uuid,
  title        text,
  media_type   text,
  cover_path   text,
  author_names text[],
  series_names text[],
  rank         real
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    li.id,
    li.title,
    li.media_type,
    li.cover_path,
    ARRAY_AGG(DISTINCT a.name)  FILTER (WHERE a.name  IS NOT NULL) AS author_names,
    ARRAY_AGG(DISTINCT s.name)  FILTER (WHERE s.name  IS NOT NULL) AS series_names,
    ts_rank(
      to_tsvector('english', li.title || ' ' || COALESCE(li.description, '')),
      plainto_tsquery('english', p_query)
    ) AS rank
  FROM public.library_items li
  LEFT JOIN public.book_authors  ba ON ba.book_id   = li.id
  LEFT JOIN public.authors        a ON a.id          = ba.author_id
  LEFT JOIN public.book_series   bs ON bs.book_id   = li.id
  LEFT JOIN public.series         s ON s.id          = bs.series_id
  WHERE li.library_id = p_library_id
    AND to_tsvector('english', li.title || ' ' || COALESCE(li.description, ''))
        @@ plainto_tsquery('english', p_query)
  GROUP BY li.id, li.title, li.media_type, li.cover_path
  ORDER BY rank DESC
  LIMIT p_limit;
$$;

-- Grant execute to authenticated users so the RPC is callable via the
-- anon/authenticated Supabase client (RLS on library_items still applies
-- because SECURITY INVOKER is used).
GRANT EXECUTE ON FUNCTION public.search_library_items(uuid, text, integer)
  TO authenticated;
-- Migration: storage buckets
-- Requirements: 6.1
--
-- Creates three Supabase Storage buckets:
--   • audio   – private (signed URLs required for access)
--   • covers  – public  (direct public URLs, no auth needed)
--   • ebooks  – private (signed URLs required for access)
--
-- The `public` column in storage.buckets controls whether objects in the
-- bucket are publicly readable without a signed URL.

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('audio',  'audio',  false),
  ('covers', 'covers', true),
  ('ebooks', 'ebooks', false)
ON CONFLICT (id) DO NOTHING;
-- Migration: storage RLS policies
-- Requirements: 6.2, 6.3, 6.4, 6.5, 6.6

-- audio bucket: authenticated SELECT only (Req 6.2, 6.3)
CREATE POLICY "Authenticated users can read audio objects"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'audio'
    AND auth.role() = 'authenticated'
  );

-- covers bucket: public SELECT, no auth required (Req 6.4)
CREATE POLICY "Public read access for cover objects"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'covers');

-- ebooks bucket: authenticated SELECT only
CREATE POLICY "Authenticated users can read ebook objects"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'ebooks'
    AND auth.role() = 'authenticated'
  );

-- No INSERT/UPDATE/DELETE policies for authenticated/anon roles.
-- Storage RLS is deny-by-default, so browser clients cannot write.
-- Service role bypasses RLS entirely — server-side uploads work without
-- an explicit policy. (Req 6.5, 6.6)
-- Migration: add storage sync status columns to library_items
-- Adds `is_missing` flag and `last_storage_check` timestamp for tracking
-- whether storage files referenced by a library item actually exist.

ALTER TABLE public.library_items
  ADD COLUMN IF NOT EXISTS is_missing boolean NOT NULL DEFAULT false;

ALTER TABLE public.library_items
  ADD COLUMN IF NOT EXISTS last_storage_check timestamptz;

-- Index for quickly finding items that need attention
CREATE INDEX IF NOT EXISTS idx_library_items_is_missing
  ON public.library_items (is_missing)
  WHERE is_missing = true;
-- Migration 20240001000011: Performance and Security Fixes

-- 1. Skipped pg_net (does not support SET SCHEMA)

-- 2. Drop unused indexes to improve write performance and save space
DROP INDEX IF EXISTS idx_media_progress_library_item_id;
DROP INDEX IF EXISTS idx_media_progress_last_update;
DROP INDEX IF EXISTS idx_profiles_updated_at;
DROP INDEX IF EXISTS idx_profiles_default_library_id;
DROP INDEX IF EXISTS idx_book_series_series_id;
DROP INDEX IF EXISTS idx_collection_books_collection_id;
DROP INDEX IF EXISTS idx_authors_library_id;
DROP INDEX IF EXISTS idx_collections_library_id;
DROP INDEX IF EXISTS idx_devices_user_id;
DROP INDEX IF EXISTS idx_feed_episodes_feed_id;
DROP INDEX IF EXISTS idx_feeds_user_id;
DROP INDEX IF EXISTS idx_library_folders_library_id;
DROP INDEX IF EXISTS idx_media_item_shares_user_id;
DROP INDEX IF EXISTS idx_playback_sessions_library_id;
DROP INDEX IF EXISTS idx_playlist_media_items_playlist_id;
DROP INDEX IF EXISTS idx_playlists_library_id;
DROP INDEX IF EXISTS idx_playlists_user_id;
DROP INDEX IF EXISTS idx_podcast_episodes_podcast_id;
DROP INDEX IF EXISTS idx_series_library_id;
DROP INDEX IF EXISTS idx_library_items_is_missing;

-- 3. Fix auth_rls_initplan by wrapping auth.uid() in (select auth.uid())



-- library_items
DROP POLICY IF EXISTS "Admins can insert library_items" ON public.library_items;
CREATE POLICY "Admins can insert library_items" ON public.library_items FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (select auth.uid()) AND profiles.user_type IN ('admin', 'root')
  )
);

DROP POLICY IF EXISTS "Admins can update library_items" ON public.library_items;
CREATE POLICY "Admins can update library_items" ON public.library_items FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (select auth.uid()) AND profiles.user_type IN ('admin', 'root')
  )
);

-- authors
DROP POLICY IF EXISTS "Admins can insert authors" ON public.authors;
CREATE POLICY "Admins can insert authors" ON public.authors FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (select auth.uid()) AND profiles.user_type IN ('admin', 'root')
  )
);

-- book_authors
DROP POLICY IF EXISTS "Admins can insert book_authors" ON public.book_authors;
CREATE POLICY "Admins can insert book_authors" ON public.book_authors FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (select auth.uid()) AND profiles.user_type IN ('admin', 'root')
  )
);

-- series
DROP POLICY IF EXISTS "Admins can insert series" ON public.series;
CREATE POLICY "Admins can insert series" ON public.series FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (select auth.uid()) AND profiles.user_type IN ('admin', 'root')
  )
);

-- book_series
DROP POLICY IF EXISTS "Admins can insert book_series" ON public.book_series;
CREATE POLICY "Admins can insert book_series" ON public.book_series FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (select auth.uid()) AND profiles.user_type IN ('admin', 'root')
  )
);

-- 4. Fix multiple_permissive_policies by splitting FOR ALL into INSERT/UPDATE/DELETE where SELECT already exists

-- collection_items
DROP POLICY IF EXISTS "Admins can manage collection_items" ON public.collection_items;
CREATE POLICY "Admins can insert collection_items" ON public.collection_items FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);
CREATE POLICY "Admins can update collection_items" ON public.collection_items FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);
CREATE POLICY "Admins can delete collection_items" ON public.collection_items FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);

-- collections
DROP POLICY IF EXISTS "Admins can manage collections" ON public.collections;
CREATE POLICY "Admins can insert collections" ON public.collections FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);
CREATE POLICY "Admins can update collections" ON public.collections FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);
CREATE POLICY "Admins can delete collections" ON public.collections FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);



-- podcast_episodes
DROP POLICY IF EXISTS "Admins can manage podcast_episodes" ON public.podcast_episodes;
CREATE POLICY "Admins can insert podcast_episodes" ON public.podcast_episodes FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);
CREATE POLICY "Admins can update podcast_episodes" ON public.podcast_episodes FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);
CREATE POLICY "Admins can delete podcast_episodes" ON public.podcast_episodes FOR DELETE USING (
  EXISTS (SELECT 1 FROM profiles WHERE profiles.id = (select auth.uid()) AND profiles.user_type = 'admin')
);
-- Migration 20240001000012: Add Missing Foreign Key Indexes

-- Table: authors
CREATE INDEX IF NOT EXISTS idx_authors_library_id 
ON public.authors (library_id);

-- Table: book_series
CREATE INDEX IF NOT EXISTS idx_book_series_series_id 
ON public.book_series (series_id);

-- Table: collection_items
CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id 
ON public.collection_items (collection_id);

-- Table: collections
CREATE INDEX IF NOT EXISTS idx_collections_library_id 
ON public.collections (library_id);

-- Table: playlist_items
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id 
ON public.playlist_items (playlist_id);

-- Table: playlists
CREATE INDEX IF NOT EXISTS idx_playlists_library_id 
ON public.playlists (library_id);

CREATE INDEX IF NOT EXISTS idx_playlists_user_id 
ON public.playlists (user_id);

-- Table: podcast_episodes
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_library_item_id 
ON public.podcast_episodes (library_item_id);

-- Table: profiles
CREATE INDEX IF NOT EXISTS idx_profiles_default_library_id 
ON public.profiles (default_library_id);

-- Table: series
CREATE INDEX IF NOT EXISTS idx_series_library_id 
ON public.series (library_id);
-- Migration: Add user preferences
-- Description: Adds a jsonb preferences column to the profiles table to store client settings

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;
-- Enable the pgvector extension to work with embedding vectors
CREATE EXTENSION IF NOT EXISTS vector;

-- Add an embedding column to library_items for OpenAI's text-embedding-3-small (1536 dimensions)
ALTER TABLE public.library_items ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create a function to search for similar library items
CREATE OR REPLACE FUNCTION match_library_items (
  item_id uuid,
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  similarity float
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  item_embedding vector(1536);
BEGIN
  -- Lookup the embedding for the requested item
  SELECT embedding INTO item_embedding FROM library_items WHERE library_items.id = item_id;
  
  IF item_embedding IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    library_items.id,
    1 - (library_items.embedding <=> item_embedding) AS similarity
  FROM library_items
  WHERE library_items.id != item_id
    AND library_items.embedding IS NOT NULL
    AND 1 - (library_items.embedding <=> item_embedding) > match_threshold
  ORDER BY library_items.embedding <=> item_embedding
  LIMIT match_count;
END;
$$;
-- Create a function to search library items by an arbitrary query embedding
CREATE OR REPLACE FUNCTION search_library_items_by_embedding (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    library_items.id,
    1 - (library_items.embedding <=> query_embedding) AS similarity
  FROM library_items
  WHERE library_items.embedding IS NOT NULL
    AND 1 - (library_items.embedding <=> query_embedding) > match_threshold
  ORDER BY library_items.embedding <=> query_embedding
  LIMIT match_count;
$$;
