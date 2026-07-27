-- Add missing playback progress columns to media_progress
ALTER TABLE public.media_progress
ADD COLUMN IF NOT EXISTS hide_from_continue_listening boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS finished_at timestamptz;
