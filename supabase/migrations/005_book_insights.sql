-- Create book_insights table for persistent caching of AI generated insights
CREATE TABLE IF NOT EXISTS public.book_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id TEXT NOT NULL UNIQUE,
    book_title TEXT NOT NULL,
    book_author TEXT,
    summary TEXT NOT NULL,
    key_takeaways TEXT[] NOT NULL DEFAULT '{}',
    mood TEXT NOT NULL DEFAULT 'Reflective',
    themes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.book_insights ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Authenticated users can read and insert insights
CREATE POLICY "Authenticated users can read book insights"
    ON public.book_insights FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can insert book insights"
    ON public.book_insights FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Authenticated users can update book insights"
    ON public.book_insights FOR UPDATE
    TO authenticated
    USING (true);

-- Index for fast lookup by book_id
CREATE INDEX IF NOT EXISTS idx_book_insights_book_id ON public.book_insights (book_id);
