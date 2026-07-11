-- Migration: Add missing columns to media_progress
-- Adds finished_at and hide_from_continue_listening columns to public.media_progress.

ALTER TABLE public.media_progress 
  ADD COLUMN IF NOT EXISTS hide_from_continue_listening boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;
