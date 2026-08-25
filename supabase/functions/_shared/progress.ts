import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";
import { Database } from "../../../src/types/supabase.ts";
import { sanitizeProgressInput } from "./invariants.ts";

export async function upsertMediaProgress(
  supabase: any,
  userId: string,
  libraryItemId: string,
  episodeId: string | null,
  rawProgressData: {
    progress?: number;
    duration?: number;
    currentTime?: number;
    isFinished?: boolean;
    hideFromContinueListening?: boolean;
  },
) {
  // Server-side sanity: client claims must be physically possible before
  // they poison cross-device resume state (Sapiens incident: a 19.8h bogus
  // duration and an end-of-book position were synced from corrupted files).
  const { corrections, ...progressData } = sanitizeProgressInput(
    rawProgressData,
  );
  if (corrections.length > 0) {
    console.warn(
      `[progress] sanitized input for item ${libraryItemId}: ${
        corrections.join("; ")
      }`,
    );
  }
  const { currentTime, duration, progress } = progressData;
  const {
    isFinished: rawIsFinished,
    hideFromContinueListening,
  } = rawProgressData;
  const isFinished = typeof rawIsFinished === "boolean"
    ? rawIsFinished
    : undefined;

  const finalDuration = duration || 0;
  const finalCurrentTime = currentTime ??
    (progress && finalDuration ? progress * finalDuration : 0);
  const finalProgress = Math.min(
    1,
    Math.max(
      0,
      progress ?? (finalDuration > 0 ? finalCurrentTime / finalDuration : 0),
    ),
  );
  const finalIsFinished = isFinished ??
    (finalDuration > 0 && finalCurrentTime >= finalDuration - 5);

  const dataToUpsert = {
    user_id: userId,
    library_item_id: libraryItemId,
    episode_id: episodeId || null,
    progress: finalProgress,
    duration: finalDuration,
    current_time_pos: finalCurrentTime,
    is_finished: finalIsFinished,
    hide_from_continue_listening: hideFromContinueListening ?? false,
    finished_at: finalIsFinished ? new Date().toISOString() : null,
    last_update: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("media_progress")
    .upsert(dataToUpsert, {
      onConflict: "user_id,library_item_id,episode_id",
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function bulkUpsertMediaProgress(
  supabase: SupabaseClient<Database>,
  userId: string,
  progressItems: {
    libraryItemId: string;
    episodeId: string | null;
    progress?: number;
    duration?: number;
    currentTime?: number;
    isFinished?: boolean;
    hideFromContinueListening?: boolean;
  }[],
) {
  const dataToUpsert = progressItems.map((item) => {
    const finalDuration = item.duration || 0;
    const finalCurrentTime = item.currentTime ??
      (item.progress && finalDuration ? item.progress * finalDuration : 0);
    const finalProgress = item.progress ??
      (finalDuration > 0 ? finalCurrentTime / finalDuration : 0);
    const finalIsFinished = item.isFinished ??
      (finalDuration > 0 && finalCurrentTime >= finalDuration - 5);

    return {
      user_id: userId,
      library_item_id: item.libraryItemId,
      episode_id: item.episodeId || null,
      progress: finalProgress,
      duration: finalDuration,
      current_time_pos: finalCurrentTime,
      is_finished: finalIsFinished,
      hide_from_continue_listening: item.hideFromContinueListening ?? false,
      finished_at: finalIsFinished ? new Date().toISOString() : null,
      last_update: new Date().toISOString(),
    };
  });

  const { data, error } = await supabase
    .from("media_progress")
    .upsert(dataToUpsert, {
      onConflict: "user_id,library_item_id,episode_id",
    })
    .select();

  if (error) throw error;
  return data;
}
