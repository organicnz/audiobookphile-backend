import { Hono } from "hono";
import { Variables } from "../_shared/types.ts";

export const meRouter = new Hono<{ Variables: Variables }>();

meRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    const profileData = profile as any;

    const userProfile = {
      user: {
        id: user.id,
        username: profile?.username || user?.email?.split("@")[0] || "User",
        email: user.email,
        type: profile?.user_type || "user",
        token: "",
        isActive: true,
        isLocked: false,
        hasUpdateAvailable: false,
        createdAt: new Date(user.created_at || Date.now()).getTime(),
        lastSeen: new Date(
          user.last_sign_in_at || user.created_at || Date.now(),
        ).getTime(),
        extra: {},
        mediaProgress: [],
        seriesHideFromContinueListening: [],
        bookmarks: [],
        permissions: profileData?.permissions || {},
      },
      userDefaultLibraryId: profile?.default_library_id || null,
      serverSettings: null,
      ereaderDevices: [],
      Source: "local",
    };

    return c.json(userProfile);
  } catch (err: any) {
    console.error("[me] profile fetch failed:", err);
    return c.json({ error: "Failed to fetch profile" }, 500);
  }
});

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
