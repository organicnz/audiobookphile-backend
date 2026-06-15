import { SupabaseClient } from "npm:@supabase/supabase-js"

export async function upsertMediaProgress(
  supabase: SupabaseClient, 
  userId: string, 
  libraryItemId: string, 
  episodeId: string | null, 
  progressData: { progress?: number, duration?: number, currentTime?: number, isFinished?: boolean, hideFromContinueListening?: boolean }
) {
  const { progress, duration, currentTime, isFinished, hideFromContinueListening } = progressData

  const finalDuration = duration || 0
  const finalCurrentTime = currentTime ?? (progress && finalDuration ? progress * finalDuration : 0)
  const finalProgress = progress ?? (finalDuration > 0 ? finalCurrentTime / finalDuration : 0)
  const finalIsFinished = isFinished ?? (finalDuration > 0 && finalCurrentTime >= finalDuration - 5)

  const dataToUpsert = {
    user_id: userId,
    library_item_id: libraryItemId,
    episode_id: episodeId || null,
    progress: finalProgress,
    duration: finalDuration,
    current_time_pos: finalCurrentTime,
    is_finished: finalIsFinished,
    last_update: new Date().toISOString(),
    hide_from_continue_listening: hideFromContinueListening ?? false,
    finished_at: finalIsFinished ? new Date().toISOString() : null
  }

  const { data, error } = await supabase
    .from('media_progress')
    .upsert(dataToUpsert, { onConflict: 'user_id,library_item_id,episode_id' })
    .select()
    .single()

  if (error) throw error
  return data
}
