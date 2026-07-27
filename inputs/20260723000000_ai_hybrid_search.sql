-- Migration: 20260723000000_ai_hybrid_search.sql
-- Description: Enables pgvector & pg_trgm, adds vector embeddings & HNSW index, and creates match_library_items_hybrid RPC function.

-- 1. Enable Extensions
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- 2. Add embedding column to library_items if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'library_items' 
        AND column_name = 'embedding'
    ) THEN
        ALTER TABLE public.library_items ADD COLUMN embedding vector(1536);
    END IF;
END $$;

-- 3. Create HNSW Vector Index for sub-millisecond similarity search
CREATE INDEX IF NOT EXISTS library_items_embedding_hnsw_idx 
ON public.library_items 
USING hnsw (embedding vector_cosine_ops) 
WITH (m = 16, ef_construction = 64);

-- 4. Create Trigram GIN Indexes for fuzzy text matching
CREATE INDEX IF NOT EXISTS library_items_title_trgm_idx 
ON public.library_items 
USING gin (title gin_trgm_ops);

-- 5. Hybrid Search Function combining vector cosine similarity & trigram keyword match
CREATE OR REPLACE FUNCTION public.match_library_items_hybrid(
    query_text text,
    query_embedding vector(1536) DEFAULT NULL,
    match_threshold float DEFAULT 0.2,
    match_count int DEFAULT 20,
    target_library_id uuid DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    library_id uuid,
    title text,
    subtitle text,
    author_name text,
    narrator_name text,
    description text,
    cover_path text,
    duration double precision,
    similarity_score float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        li.id,
        li.library_id,
        li.title,
        li.subtitle,
        li.author_name,
        li.narrator_name,
        li.description,
        li.cover_path,
        li.duration,
        (
            CASE 
                WHEN query_embedding IS NOT NULL AND li.embedding IS NOT NULL THEN
                    (1 - (li.embedding <=> query_embedding)) * 0.6
                ELSE 0.0
            END
            +
            CASE 
                WHEN query_text IS NOT NULL AND query_text <> '' THEN
                    (similarity(COALESCE(li.title, ''), query_text) * 0.3 +
                     similarity(COALESCE(li.author_name, ''), query_text) * 0.1)
                ELSE 0.0
            END
        )::float AS similarity_score
    FROM public.library_items li
    WHERE (target_library_id IS NULL OR li.library_id = target_library_id)
      AND (
          (query_embedding IS NOT NULL AND li.embedding IS NOT NULL AND (1 - (li.embedding <=> query_embedding)) >= match_threshold)
          OR (query_text IS NOT NULL AND query_text <> '' AND (li.title % query_text OR li.author_name % query_text))
      )
    ORDER BY similarity_score DESC
    LIMIT match_count;
END;
$$;
