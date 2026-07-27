-- Remove orphaned unique index left over after dropping the old constraint
DROP INDEX IF EXISTS public.media_progress_user_id_library_item_id_episode_id_key;

-- Add FK-covering index on library_item_id.
-- Required by the FK media_progress_library_item_id_fkey for efficient
-- ON DELETE CASCADE and any reverse-lookup joins from library_items.
CREATE INDEX IF NOT EXISTS idx_media_progress_library_item_id
  ON public.media_progress (library_item_id);
