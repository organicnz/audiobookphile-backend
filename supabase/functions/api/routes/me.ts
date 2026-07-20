import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";

export const meRouter = new Hono<{ Variables: Variables }>();

meRouter.get("/stats", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  try {
    // Fetch media progress joined with library_items for title
    const { data: progressData, error: progressError } = await supabase
      .from("media_progress")
      .select(`
        id,
        library_item_id,
        duration,
        progress,
        is_finished,
        finished_at,
        last_update,
        started_at,
        library_items ( title )
      `)
      .eq("user_id", user.id)
      .order("last_update", { ascending: false });

    if (progressError) throw progressError;

    // Fetch recent playback sessions
    const { data: sessionsData, error: sessionsError } = await supabase
      .from("playback_sessions")
      .select(
        "id, display_title, display_author, time_listening, session_date, updated_at",
      )
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(10);

    if (sessionsError) throw sessionsError;

    const mediaProgress = (progressData ?? []).map((row: any) => ({
      id: row.id,
      library_item_id: row.library_item_id,
      duration: row.duration ?? null,
      progress: row.progress ?? null,
      is_finished: row.is_finished ?? null,
      finished_at: row.finished_at ?? null,
      last_update: row.last_update ?? null,
      started_at: row.started_at ?? null,
      title: row.library_items?.title ?? null,
    }));

    const recentSessions = (sessionsData ?? []).map((row: any) => ({
      id: row.id,
      display_title: row.display_title ?? null,
      display_author: row.display_author ?? null,
      time_listening: row.time_listening ?? null,
      session_date: row.session_date ?? null,
      updated_at: row.updated_at,
    }));

    return c.json({ mediaProgress, recentSessions });
  } catch (err: any) {
    console.error("[me] stats failed:", err);
    return c.json({ error: "Failed to fetch stats" }, 500);
  }
});
