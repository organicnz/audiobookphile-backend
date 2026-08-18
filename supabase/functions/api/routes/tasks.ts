import { createClient } from "npm:@supabase/supabase-js@2.44.0";

function getSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") || "";
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Type definition for Task (used by frontend TasksContext) — must match TypeScript API types
export interface Task {
  id: string;
  action: string;
  libraryId?: string | null;
  isFinished: boolean | null;
}

/**
 * Get all tasks — used by TasksContext to load initial state.
 */
async function getTasks() {
  const supabase = getSupabaseClient();

  // Fetch all tasks from the tasks table (using snake_case)
  try {
    const { data, error } = await supabase
      .from("tasks")
      .select("*");

    if (error) {
      console.error("[getTasks] Error:", error);
      return [];
    }

    // Convert snake_case to camelCase for frontend compatibility
    return (data as any).map((t: any) => ({
      id: t.id,
      action: t.action,
      libraryId: t.library_id || undefined,
      isFinished: t.is_finished !== null ? !!t.is_finished : false,
    }));
  } catch (err) {
    console.error("[getTasks] Exception:", err);
    return [];
  }
}

/**
 * Get tasks filtered by library ID.
 */
async function getTasksByLibraryId(libraryId: string) {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("library_id", libraryId);

    if (error) {
      console.error(`[getTasksByLibraryId] Error for ${libraryId}:`, error);
      return [];
    }

    const result = data as any;
    // Convert to array of objects with camelCase properties
    const tasks: Task[] = result.map((t: any) => ({
      id: t.id,
      action: t.action,
      libraryId: t.library_id || undefined,
      isFinished: t.is_finished !== null ? !!t.is_finished : false,
    }));

    return tasks;
  } catch (err) {
    console.error(`[getTasksByLibraryId] Exception for ${libraryId}:`, err);
    return [];
  }
}

/**
 * Get task progress — returns current progress string.
 */
async function getTaskProgress(taskId: string) {
  const supabase = getSupabaseClient();

  try {
    // This assumes there's a "progress" or similar column in tasks table
    const { data, error } = await supabase
      .from("tasks")
      .select("progress, is_finished")
      .eq("id", taskId)
      .single();

    if (error) {
      console.error(`[getTaskProgress] Error for ${taskId}:`, error);
      return "unknown";
    }

    // Return progress as string (e.g., "25%", "75%") or percentage number
    const progress = data?.progress;
    if (typeof progress === "number") {
      return `${Math.round(progress)}%`;
    } else if (typeof progress === "string" && typeof progress !== "boolean") {
      return `0${progress}`.replace(/^0+/, ""); // " 25%" -> "25%"
    }

    // Use is_finished as fallback
    const finished = data?.is_finished;
    if (finished === false) return "100%";
    if (finished === true) return "0%";

    return progress || "unknown";
  } catch (err) {
    console.error(`[getTaskProgress] Exception for ${taskId}:`, err);
    return "error";
  }
}

/**
 * Get audio files encoding status.
 */
async function getAudioFilesEncoding(libraryId: string) {
  const supabase = getSupabaseClient();

  try {
    // This assumes there's an "audio_encoding_status" column in tasks table
    const { data, error } = await supabase
      .from("tasks")
      .select("audio_encoding_status")
      .eq("library_id", libraryId);

    if (error) {
      console.error(`[getAudioFilesEncoding] Error for ${libraryId}:`, error);
      return undefined;
    }

    // Return map of file -> encoding status
    const result: Record<string, string> = {};
    data?.forEach((task: any) => {
      if (task.audio_encoding_status) {
        result[task.id] = task.audio_encoding_status || "unknown";
      }
    });

    return result;
  } catch (err) {
    console.error(`[getAudioFilesEncoding] Exception for ${libraryId}:`, err);
    return undefined;
  }
}

/**
 * Get audio files finished status.
 */
async function getAudioFilesFinished(libraryId: string) {
  const supabase = getSupabaseClient();

  try {
    // This assumes there's an "audio_finished_status" column in tasks table
    const { data, error } = await supabase
      .from("tasks")
      .select("audio_finished_status")
      .eq("library_id", libraryId);

    if (error) {
      console.error(`[getAudioFilesFinished] Error for ${libraryId}:`, error);
      return undefined;
    }

    const result: Record<string, boolean> = {};
    data?.forEach((task: any) => {
      if (
        task.audio_finished_status !== null &&
        task.audio_finished_status !== undefined
      ) {
        result[task.id] = !!task.audio_finished_status;
      }
    });

    return result;
  } catch (err) {
    console.error(`[getAudioFilesFinished] Exception for ${libraryId}:`, err);
    return undefined;
  }
}

/**
 * Get all tasks — the main endpoint used by frontend TasksContext.
 */
export async function getTasksEndpoint() {
  const supabase = getSupabaseClient();

  try {
    // Fetch all tasks with their data (including library_id, action, etc.)
    const { data: tasksWithData, error } = await supabase
      .from("tasks")
      .select("*");

    if (error) {
      return { errors: [error.message] };
    }

    // Convert snake_case columns to camelCase for frontend compatibility
    const enrichedTasks = [...(tasksWithData || [])];
    const taskIds = new Set(enrichedTasks.map((t: any) => t.id));

    if (taskIds.size > 0) {
      // Fetch metadata rows for each task (in batches of 100)
      const ids = [...taskIds];
      const metadataMap = new Map<string, Record<string, unknown>>();
      const batchSize = 100;

      for (let offset = 0; offset < ids.length; offset += batchSize) {
        const batch = ids.slice(offset, offset + batchSize);
        const { data: metadataRows, error: metaError } = await supabase
          .from("tasks_metadata")
          .select("*")
          .in("id", batch);

        if (metaError) {
          console.warn("[getTasksEndpoint] Metadata fetch error:", metaError);
          continue;
        }

        metadataRows?.forEach((row: any) => {
          const { id, ...rest } = row;
          metadataMap.set(id, rest);
        });
      }

      enrichedTasks.forEach((task: any) => {
        task.data = metadataMap.get(task.id) || {};
      });
    }

    return { tasks: enrichedTasks };
  } catch (err) {
    console.error("[getTasksEndpoint] Exception:", err);
    return { errors: ["Internal server error"] };
  }
}

/**
 * Get queued metadata embeds — returns array of libraryItemIds.
 */
async function getQueuedEmbedLIds() {
  const supabase = getSupabaseClient();

  try {
    // This assumes there's an "embedded_library_id" or similar column in tasks_metadata table
    const { data, error } = await supabase
      .from("tasks_metadata")
      .select("library_item_id")
      .eq("queued", true);

    if (error) {
      console.error("[getQueuedEmbedLIds] Error:", error);
      return [];
    }

    const result = data?.map((t: any) => t.library_item_id) || [];
    return result;
  } catch (err) {
    console.error("[getQueuedEmbedLIds] Exception:", err);
    return [];
  }
}

// Export all functions for frontend use
export {
  getAudioFilesEncoding,
  getAudioFilesFinished,
  getQueuedEmbedLIds,
  getTaskProgress,
  getTasks,
  getTasksByLibraryId,
  getTasksByLibraryItemId,
};
