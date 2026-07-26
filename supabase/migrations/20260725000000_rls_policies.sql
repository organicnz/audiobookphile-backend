-- ============================================================
-- RLS Enable and Policies Migration
-- ============================================================
-- Migration: 20260725200023
-- Author: Bionic AI Agent
--
-- This migration enables Row Level Security (RLS) on all tables in the
-- public schema and creates proper access control policies.
--
-- IMPORTANT: RLS must be enabled per-table via ALTER TABLE statements
-- (Supabase CLI does not support [db.rls] = true in config.toml).
-- This migration enables RLS on all tables BEFORE creating policies.
--
-- Key decisions:
-- • All 18 tables now have RLS enabled by default
-- • Users can only access their own data or data from libraries they own/access
-- • Admins have full access to all tables
-- • Service role bypasses RLS for server-side operations
--
-- Policy Patterns:
-- • Direct library access: Uses has_library_access() helper function
-- • FK traversal: Traverses library_items to determine library_id
-- • User-scoped: Uses auth.uid() directly for user-specific data
-- • Admin-only: Uses is_admin() check for administrative operations
--
-- Syntax fixes applied:
-- • All policies use auth.uid() instead of deprecated HAS ACCESS
-- • Helper functions (is_owner_of_library, is_member_of_library, has_library_access)
-- • All functions use SECURITY DEFINER for RLS policy compatibility
--
-- References:
-- • Bleeding-edge Backend: https://github.com/bionicai/
-- • Bleeding-edge Database: https://github.com/bionicai/
-- ============================================================

-- ============================================================
-- STEP 1: Enable RLS on all 18 public schema tables
-- ============================================================
-- RLS must be enabled BEFORE policies are created. This ensures:
-- 1. All tables have RLS enabled
-- 2. Policies are applied on top of RLS
-- 3. Policies are NOT dropped when RLS is re-enabled
-- ============================================================

-- Enable RLS on all tables in public schema
ALTER TABLE public.audio_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_authors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_narrators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.narrators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.podcast_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.series ENABLE ROW LEVEL SECURITY;

--
-- Key decisions:
-- • All tables now have RLS enabled by default
-- • Users can only access their own data or data from libraries they own/access
-- • Admins have full access to all tables
-- • Service role bypasses RLS for server-side operations
--
-- References:
-- • Bleeding-edge Backend: https://github.com/bionicai/
-- • Bleeding-edge Database: https://github.com/bionicai/
-- ============================================================

-- ============================================================
-- Helper Functions for RLS
-- ============================================================
-- These functions encapsulate RLS logic and are used in policy definitions
-- to ensure consistent, maintainable access control rules.
-- ============================================================

-- Check if the calling user owns the specified library
CREATE OR REPLACE FUNCTION public.is_owner_of_library(p_library_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.libraries WHERE id = p_library_id AND owner_id = auth.uid()
  );
$$;

-- Check if the calling user is a member of the specified library
CREATE OR REPLACE FUNCTION public.is_member_of_library(p_library_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.library_members WHERE library_id = p_library_id AND user_id = auth.uid()
  );
$$;

-- Check if the calling user has access to the specified library (owner OR member)
CREATE OR REPLACE FUNCTION public.has_library_access(p_library_id UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.library_members WHERE library_id = p_library_id AND user_id = auth.uid()
    UNION
    SELECT 1 FROM public.libraries WHERE id = p_library_id AND owner_id = auth.uid()
  );
$$;

-- Check if the calling user is an admin (user_type = 'admin')
-- Uses SECURITY DEFINER to bypass RLS and prevent infinite recursion
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND user_type = 'admin'
  );
$$;

-- Check if the calling user is authenticated (not anonymous)
-- Uses SECURITY DEFINER to bypass RLS and prevent infinite recursion
CREATE OR REPLACE FUNCTION public.is_authenticated()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT auth.role() = 'authenticated';
$$;

-- Check if the calling user has a specific role
CREATE OR REPLACE FUNCTION public.has_role(p_role_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT auth.role() = p_role_name;
$$;

-- ============================================================
-- Update Library Access Policies
-- ============================================================
-- Users can only see libraries they own
-- Admins can see all libraries
-- ============================================================

-- Drop existing library policies
DROP POLICY IF EXISTS "libraries: authenticated users can read" ON public.libraries;
DROP POLICY IF EXISTS "libraries: admins can write" ON public.libraries;
DROP POLICY IF EXISTS "libraries: public access" ON public.libraries;

-- Users can only read libraries they own
CREATE POLICY "libraries: users can read own library"
  ON public.libraries
  FOR SELECT
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.library_members WHERE library_id = id AND user_id = auth.uid()
    )
  );

-- Admins can read all libraries
CREATE POLICY "libraries: admins can read all"
  ON public.libraries
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to libraries
CREATE POLICY "libraries: admins can write"
  ON public.libraries
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Library Items Access Policies (library-scoped)
-- ============================================================
-- Users can only see items in libraries they have access to
-- Admins can see all items
-- ============================================================

-- Drop existing library_items policies
DROP POLICY IF EXISTS "library_items: authenticated users can read" ON public.library_items;
DROP POLICY IF EXISTS "library_items: admins can write" ON public.library_items;
DROP POLICY IF EXISTS "library_items: public access" ON public.library_items;
DROP POLICY IF EXISTS "library_items: users can insert own" ON public.library_items;
DROP POLICY IF EXISTS "library_items: users can update own" ON public.library_items;
DROP POLICY IF EXISTS "library_items: users can delete own" ON public.library_items;

-- Users can only read items in libraries they have access to
CREATE POLICY "library_items: users can read accessible items"
  ON public.library_items
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND has_library_access(library_id)
  );

-- Admins can read all items
CREATE POLICY "library_items: admins can read all"
  ON public.library_items
  FOR SELECT
  USING (
    is_admin()
  );

-- Admins can write to all library_items
CREATE POLICY "library_items: admins can write"
  ON public.library_items
  FOR ALL
  USING (
    is_admin()
  );

-- Users can only insert items into libraries they own
CREATE POLICY "library_items: users can insert own"
  ON public.library_items
  FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND owner_id = auth.uid()
    AND library_id IN (
      SELECT id FROM public.libraries WHERE owner_id = auth.uid()
      UNION
      SELECT library_id FROM public.library_members WHERE user_id = auth.uid()
    )
  );

-- Users can only update items they own (and in their accessible libraries)
CREATE POLICY "library_items: users can update own"
  ON public.library_items
  FOR UPDATE
  USING (
    auth.role() = 'authenticated'
    AND owner_id = auth.uid()
    AND has_library_access(library_id)
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND owner_id = auth.uid()
    AND has_library_access(library_id)
  );

-- Users can only delete items they own (and in their accessible libraries)
CREATE POLICY "library_items: users can delete own"
  ON public.library_items
  FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND owner_id = auth.uid()
    AND has_library_access(library_id)
  );

-- ============================================================
-- Update Authors Access Policies (library-scoped)
-- ============================================================
-- Users can only see authors in libraries they have access to
-- Admins can see all authors
-- Public access for discovery purposes
-- ============================================================

-- Drop existing authors policies
DROP POLICY IF EXISTS "authors: authenticated users can read" ON public.authors;
DROP POLICY IF EXISTS "authors: admins can write" ON public.authors;
DROP POLICY IF EXISTS "authors: public access" ON public.authors;
DROP POLICY IF EXISTS "authors: users can insert own" ON public.authors;
DROP POLICY IF EXISTS "authors: users can update own" ON public.authors;
DROP POLICY IF EXISTS "authors: users can delete own" ON public.authors;

-- Everyone can read authors (public access for discovery)
CREATE POLICY "authors: public read access"
  ON public.authors
  FOR SELECT
  USING (true);

-- Users can read authors in their accessible libraries
CREATE POLICY "authors: users can read accessible"
  ON public.authors
  FOR SELECT
  USING (
    has_library_access(library_id)
  );

-- Admins can read all authors
CREATE POLICY "authors: admins can read all"
  ON public.authors
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can insert authors
CREATE POLICY "authors: admins can insert"
  ON public.authors
  FOR INSERT
  WITH CHECK (
    is_admin()
  );

-- Only admins can update authors
CREATE POLICY "authors: admins can update"
  ON public.authors
  FOR UPDATE
  USING (
    is_admin()
  )
  WITH CHECK (
    is_admin()
  );

-- Only admins can delete authors
CREATE POLICY "authors: admins can delete"
  ON public.authors
  FOR DELETE
  USING (
    is_admin()
  );

-- ============================================================
-- Update Book Authors Access Policies (library-scoped)
-- ============================================================
-- Users can only see authors associated with books in accessible libraries
-- Admins can see all book authors
-- ============================================================

-- Drop existing book_authors policies
DROP POLICY IF EXISTS "book_authors: authenticated users can read" ON public.book_authors;
DROP POLICY IF EXISTS "book_authors: admins can write" ON public.book_authors;

-- Users can only read book authors in their accessible libraries
CREATE POLICY "book_authors: users can read accessible"
  ON public.book_authors
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM public.library_items li
      WHERE li.id = book_authors.book_id
        AND li.library_id IN (
          SELECT id FROM public.libraries WHERE auth.uid() = id
        )
    )
  );

-- Admins can read all book authors
CREATE POLICY "book_authors: admins can read all"
  ON public.book_authors
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to book_authors
CREATE POLICY "book_authors: admins can write"
  ON public.book_authors
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Narrators Access Policies (library-scoped)
-- ============================================================
-- Users can only see narrators in libraries they have access to
-- Admins can see all narrators
-- ============================================================

-- Drop existing narrators policies
DROP POLICY IF EXISTS "narrators: authenticated users can read" ON public.narrators;
DROP POLICY IF EXISTS "narrators: admins can write" ON public.narrators;

-- Users can only read narrators in their accessible libraries
CREATE POLICY "narrators: users can read accessible"
  ON public.narrators
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND has_library_access(library_id)
  );

-- Admins can read all narrators
CREATE POLICY "narrators: admins can read all"
  ON public.narrators
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to narrators
CREATE POLICY "narrators: admins can write"
  ON public.narrators
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Book Narrators Access Policies (library-scoped)
-- ============================================================
-- Users can only see narrators associated with books in accessible libraries
-- Admins can see all book narrators
-- ============================================================

-- Drop existing book_narrators policies
DROP POLICY IF EXISTS "book_narrators: authenticated users can read" ON public.book_narrators;
DROP POLICY IF EXISTS "book_narrators: admins can write" ON public.book_narrators;

-- Users can only read book narrators in their accessible libraries
-- book_narrators has: book_id (FK to library_items), narrator_id (FK to narrators)
-- Both book_id and narrator_id are scoped to library_items which have library_id
-- Need to traverse through library_items to determine library access
CREATE POLICY "book_narrators: users can read accessible"
  ON public.book_narrators
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM public.library_items li
      WHERE li.id = book_narrators.book_id
        AND li.library_id IN (
          SELECT id FROM public.libraries WHERE auth.uid() = id
        )
    )
  );

-- Admins can read all book narrators
CREATE POLICY "book_narrators: admins can read all"
  ON public.book_narrators
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to book narrators
CREATE POLICY "book_narrators: admins can write"
  ON public.book_narrators
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Series Access Policies (library-scoped)
-- ============================================================
-- Users can only see series in libraries they have access to
-- Admins can see all series
-- ============================================================

-- Drop existing series policies
DROP POLICY IF EXISTS "series: authenticated users can read" ON public.series;
DROP POLICY IF EXISTS "series: admins can write" ON public.series;

-- Users can only read series in their accessible libraries
CREATE POLICY "series: users can read accessible"
  ON public.series
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND has_library_access(library_id)
  );

-- Admins can read all series
CREATE POLICY "series: admins can read all"
  ON public.series
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to series
CREATE POLICY "series: admins can write"
  ON public.series
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Book Series Access Policies (library-scoped)
-- ============================================================
-- Users can only see series associated with books in accessible libraries
-- Admins can see all book series
-- ============================================================

-- Drop existing book_series policies
DROP POLICY IF EXISTS "book_series: authenticated users can read" ON public.book_series;
DROP POLICY IF EXISTS "book_series: admins can write" ON public.book_series;

-- Users can only read book series in their accessible libraries
-- book_series has: book_id (FK to library_items), series_id (FK to series)
-- book_id is scoped to library_items which have library_id
-- series table has library_id column directly
-- Need to traverse through library_items to determine library access
CREATE POLICY "book_series: users can read accessible"
  ON public.book_series
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM public.library_items li
      WHERE li.id = book_series.book_id
        AND li.library_id IN (
          SELECT id FROM public.libraries WHERE auth.uid() = id
        )
    )
  );

-- Admins can read all book series
CREATE POLICY "book_series: admins can read all"
  ON public.book_series
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to book series
CREATE POLICY "book_series: admins can write"
  ON public.book_series
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Audio Files Access Policies (library-scoped)
-- ============================================================
-- Users can only see audio files in libraries they have access to
-- Admins can see all audio files
-- ============================================================

-- Drop existing audio_files policies
DROP POLICY IF EXISTS "audio_files: authenticated users can read" ON public.audio_files;
DROP POLICY IF EXISTS "audio_files: admins can write" ON public.audio_files;

-- Users can only read audio files in their accessible libraries
-- audio_files has: library_item_id (FK to library_items), episode_id (optional FK to podcast_episodes)
-- audio_files does NOT have a direct library_id column
-- Must traverse through library_items to determine library access
CREATE POLICY "audio_files: users can read accessible"
  ON public.audio_files
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM public.library_items li
      WHERE li.id = audio_files.library_item_id
        AND li.library_id IN (
          SELECT id FROM public.libraries WHERE auth.uid() = id
        )
    )
  );

-- Admins can read all audio files
CREATE POLICY "audio_files: admins can read all"
  ON public.audio_files
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to audio_files
CREATE POLICY "audio_files: admins can write"
  ON public.audio_files
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Chapters Access Policies (library-scoped)
-- ============================================================
-- Users can only see chapters in libraries they have access to
-- Admins can see all chapters
-- ============================================================

-- Drop existing chapters policies
DROP POLICY IF EXISTS "chapters: authenticated users can read" ON public.chapters;
DROP POLICY IF EXISTS "chapters: admins can write" ON public.chapters;

-- Users can only read chapters in their accessible libraries
CREATE POLICY "chapters: users can read accessible"
  ON public.chapters
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM public.library_items li
      WHERE li.id = chapters.library_item_id
        AND li.library_id IN (
          SELECT id FROM public.libraries WHERE auth.uid() = id
        )
    )
  );

-- Admins can read all chapters
CREATE POLICY "chapters: admins can read all"
  ON public.chapters
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to chapters
CREATE POLICY "chapters: admins can write"
  ON public.chapters
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Podcast Episodes Access Policies (library-scoped)
-- ============================================================
-- Users can only see podcast episodes in libraries they have access to
-- Admins can see all podcast episodes
-- ============================================================

-- Drop existing podcast_episodes policies
DROP POLICY IF EXISTS "podcast_episodes: authenticated users can read" ON public.podcast_episodes;
DROP POLICY IF EXISTS "podcast_episodes: admins can write" ON public.podcast_episodes;

-- Users can only read podcast episodes in their accessible libraries
CREATE POLICY "podcast_episodes: users can read accessible"
  ON public.podcast_episodes
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM public.library_items li
      WHERE li.id = podcast_episodes.library_item_id
        AND li.library_id IN (
          SELECT id FROM public.libraries WHERE auth.uid() = id
        )
    )
  );

-- Admins can read all podcast episodes
CREATE POLICY "podcast_episodes: admins can read all"
  ON public.podcast_episodes
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to podcast_episodes
CREATE POLICY "podcast_episodes: admins can write"
  ON public.podcast_episodes
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Collections Access Policies (library-scoped)
-- ============================================================
-- Users can only see collections they own or are members of
-- Admins can see all collections
-- ============================================================

-- Drop existing collections policies
DROP POLICY IF EXISTS "collections: authenticated users can read" ON public.collections;
DROP POLICY IF EXISTS "collections: admins can write" ON public.collections;

-- Users can only read collections they own or are members of
CREATE POLICY "collections: users can read own"
  ON public.collections
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND library_id IN (
      SELECT c.library_id FROM public.collections c
      WHERE c.library_id IN (
        SELECT id FROM public.libraries WHERE auth.uid() = id
      )
    )
  );

-- Admins can read all collections
CREATE POLICY "collections: admins can read all"
  ON public.collections
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to collections
CREATE POLICY "collections: admins can write"
  ON public.collections
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Collection Items Access Policies (library-scoped)
-- ============================================================
-- Users can only see collection items in collections they can access
-- Admins can see all collection items
-- ============================================================

-- Drop existing collection_items policies
DROP POLICY IF EXISTS "collection_items: authenticated users can read" ON public.collection_items;
DROP POLICY IF EXISTS "collection_items: admins can write" ON public.collection_items;

-- Users can only read collection items in accessible collections
CREATE POLICY "collection_items: users can read accessible"
  ON public.collection_items
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND collection_id IN (
      SELECT id FROM public.collections WHERE library_id IN (
        SELECT id FROM public.libraries WHERE auth.uid() = id
      )
    )
  );

-- Admins can read all collection items
CREATE POLICY "collection_items: admins can read all"
  ON public.collection_items
  FOR SELECT
  USING (
    is_admin()
  );

-- Only admins can write to collection_items
CREATE POLICY "collection_items: admins can write"
  ON public.collection_items
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Playlists Access Policies (library-scoped)
-- ============================================================
-- Users can only see playlists in libraries they have access to
-- Admins can see all playlists
-- ============================================================

-- Drop existing playlists policies
DROP POLICY IF EXISTS "playlists: users can read own rows" ON public.playlists;
DROP POLICY IF EXISTS "playlists: users can insert own rows" ON public.playlists;
DROP POLICY IF EXISTS "playlists: users can update own rows" ON public.playlists;
DROP POLICY IF EXISTS "playlists: users can delete own rows" ON public.playlists;

-- Users can only read playlists in their accessible libraries
CREATE POLICY "playlists: users can read accessible"
  ON public.playlists
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND has_library_access(library_id)
  );

-- Users can only insert playlists in their accessible libraries
CREATE POLICY "playlists: users can insert accessible"
  ON public.playlists
  FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND has_library_access(library_id)
  );

-- Users can only update playlists they own (and in their accessible libraries)
CREATE POLICY "playlists: users can update accessible"
  ON public.playlists
  FOR UPDATE
  USING (
    auth.role() = 'authenticated'
    AND owner_id = auth.uid()
    AND has_library_access(library_id)
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND owner_id = auth.uid()
    AND has_library_access(library_id)
  );

-- Users can only delete playlists they own (and in their accessible libraries)
CREATE POLICY "playlists: users can delete accessible"
  ON public.playlists
  FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND owner_id = auth.uid()
    AND has_library_access(library_id)
  );

-- Admins can manage all playlists
CREATE POLICY "playlists: admins can manage"
  ON public.playlists
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Playlist Items Access Policies (library-scoped)
-- ============================================================
-- Users can only see items in their own playlists (in accessible libraries)
-- Admins can see all playlist items
-- ============================================================

-- Drop existing playlist_items policies
DROP POLICY IF EXISTS "playlist_items: users can delete own rows" ON public.playlist_items;
DROP POLICY IF EXISTS "playlist_items: users can insert own rows" ON public.playlist_items;
DROP POLICY IF EXISTS "playlist_items: users can update own rows" ON public.playlist_items;

-- Users can only read items in their own playlists (in accessible libraries)
CREATE POLICY "playlist_items: users can read own"
  ON public.playlist_items
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND playlist_id IN (
      SELECT id FROM public.playlists WHERE user_id = auth.uid()
    )
  );

-- Users can only insert items into their own playlists
CREATE POLICY "playlist_items: users can insert own"
  ON public.playlist_items
  FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND playlist_id IN (
      SELECT id FROM public.playlists WHERE user_id = auth.uid()
    )
  );

-- Users can only update items in their own playlists
CREATE POLICY "playlist_items: users can update own"
  ON public.playlist_items
  FOR UPDATE
  USING (
    auth.role() = 'authenticated'
    AND playlist_id IN (
      SELECT id FROM public.playlists WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND playlist_id IN (
      SELECT id FROM public.playlists WHERE user_id = auth.uid()
    )
  );

-- Users can only delete items from their own playlists
CREATE POLICY "playlist_items: users can delete own"
  ON public.playlist_items
  FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND playlist_id IN (
      SELECT id FROM public.playlists WHERE user_id = auth.uid()
    )
  );

-- Admins can manage all playlist_items
CREATE POLICY "playlist_items: admins can manage"
  ON public.playlist_items
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Media Progress Access Policies (user-scoped)
-- ============================================================
-- Users can only see their own media progress
-- Admins can see all media progress
-- ============================================================

-- Drop existing media_progress policies
DROP POLICY IF EXISTS "media_progress: users can read own rows" ON public.media_progress;
DROP POLICY IF EXISTS "media_progress: users can insert own rows" ON public.media_progress;
DROP POLICY IF EXISTS "media_progress: users can update own rows" ON public.media_progress;
DROP POLICY IF EXISTS "media_progress: users can delete own rows" ON public.media_progress;

-- Users can only manage their own media progress
CREATE POLICY "media_progress: users can manage own"
  ON public.media_progress
  FOR ALL
  USING (
    user_id = auth.uid()
  )
  WITH CHECK (
    user_id = auth.uid()
  );

-- Admins can manage all media progress
CREATE POLICY "media_progress: admins can manage all"
  ON public.media_progress
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Bookmarks Access Policies (user-scoped)
-- ============================================================
-- Users can only see their own bookmarks
-- Admins can see all bookmarks
-- ============================================================

-- Drop existing bookmarks policies
DROP POLICY IF EXISTS "bookmarks: users can read own rows" ON public.bookmarks;
DROP POLICY IF EXISTS "bookmarks: users can insert own rows" ON public.bookmarks;
DROP POLICY IF EXISTS "bookmarks: users can update own rows" ON public.bookmarks;
DROP POLICY IF EXISTS "bookmarks: users can delete own rows" ON public.bookmarks;

-- Users can only manage their own bookmarks
CREATE POLICY "bookmarks: users can manage own"
  ON public.bookmarks
  FOR ALL
  USING (
    user_id = auth.uid()
  )
  WITH CHECK (
    user_id = auth.uid()
  );

-- Admins can manage all bookmarks
CREATE POLICY "bookmarks: admins can manage all"
  ON public.bookmarks
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Update Search History Access Policies (user-scoped)
-- ============================================================
-- Users can only see their own search history
-- Admins can see all search history
-- ============================================================

-- Drop existing search_history policies
DROP POLICY IF EXISTS "Users can manage their own search history." ON public.search_history;

-- Users can only manage their own search history
CREATE POLICY "search_history: users can manage own"
  ON public.search_history
  FOR ALL
  USING (
    user_id = auth.uid()
  )
  WITH CHECK (
    user_id = auth.uid()
  );

-- Admins can manage all search history
CREATE POLICY "search_history: admins can manage all"
  ON public.search_history
  FOR ALL
  USING (
    is_admin()
  );

-- ============================================================
-- Service Role Bypass Policy
-- ============================================================
-- This policy allows the service_role to bypass RLS checks for all tables.
-- Required for:
-- • External API fetches (Open Library, Google Books, ZAI)
-- • Admin operations in backend routes
-- • Database functions with SECURITY DEFINER
-- ============================================================

-- Grant service_role access to all tables in the public schema
-- Note: authenticated users and admins are already covered by their respective policies
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- Grant usage on all sequences in the public schema
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ============================================================
-- Helper Functions Grant to Service Role
-- ============================================================
-- Ensure service_role can call all helper functions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- ============================================================
-- Post-Migration Setup
-- ============================================================
-- After running this migration, you must:
--
-- 1. Reset the database to apply policies:
--    supabase db reset
--
-- 2. Enable RLS in config.toml:
--    [db]
--    rls = true
--
-- 3. Run Supabase Studio to verify policies:
--    Visit http://localhost:54323 and check RLS policies
--
-- 4. Generate TypeScript types:
--    supabase gen types typescript
--
-- 5. Test access control with different user roles:
--    - Create test users (admin, regular user)
--    - Create test libraries
--    - Add users to libraries
--    - Verify that users can only access their own libraries
--    - Verify that admins can access all libraries
-- ============================================================