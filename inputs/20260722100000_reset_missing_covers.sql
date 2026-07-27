-- Migration: 20260722100000_reset_missing_covers.sql
-- Reset 'missing' covers since they were erroneously marked as such due to a flattened schema bug
UPDATE public.library_items
SET cover_path = NULL
WHERE cover_path = 'missing';
