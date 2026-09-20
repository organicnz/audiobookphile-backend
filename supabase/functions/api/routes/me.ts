import { buildUserPayload } from "../_shared/payloads.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const meRouter = createOpenApiRouter();

const ServerErrorSchema = z.object({ error: z.string() });

const PermissionsSchema = z.object({
  download: z.boolean(),
  update: z.boolean(),
  delete: z.boolean(),
  upload: z.boolean(),
  accessAllLibraries: z.boolean(),
  accessAllTags: z.boolean(),
  accessExplicitContent: z.boolean(),
});

const MeProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  type: z.string(),
  token: z.string(),
  refreshToken: z.string().nullable(),
  mediaProgress: z.array(z.unknown()),
  seriesHideFromContinueListening: z.array(z.unknown()),
  bookmarks: z.array(z.unknown()),
  isActive: z.boolean(),
  isLocked: z.boolean(),
  lastSeen: z.number(),
  createdAt: z.number(),
  permissions: PermissionsSchema,
  librariesAccessible: z.array(z.unknown()),
  itemTagsAccessible: z.array(z.unknown()),
  userDefaultLibraryId: z.string().nullable(),
  serverSettings: z.object({}).passthrough(),
  source: z.string(),
}).passthrough();

const MediaProgressSchema = z.object({
  id: z.string(),
  library_item_id: z.string(),
  duration: z.number().nullable(),
  progress: z.number().nullable(),
  is_finished: z.boolean().nullable(),
  finished_at: z.string().nullable(),
  last_update: z.string().nullable(),
  started_at: z.string().nullable(),
  title: z.string().nullable(),
});

const RecentSessionSchema = z.object({
  id: z.string(),
  display_title: z.string().nullable(),
  display_author: z.string().nullable(),
  time_listening: z.number().nullable(),
  session_date: z.string().nullable(),
  updated_at: z.string(),
});

const meProfileRoute = {
  method: "get" as const,
  path: "/",
  tags: ["me"],
  responses: {
    200: {
      description: "Current user profile payload",
      content: { "application/json": { schema: MeProfileSchema } },
    },
    500: {
      description: "Profile fetch failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const meStatsRoute = {
  method: "get" as const,
  path: "/stats",
  tags: ["me"],
  responses: {
    200: {
      description: "User listening stats and recent sessions",
      content: {
        "application/json": {
          schema: z.object({
            mediaProgress: z.array(MediaProgressSchema),
            recentSessions: z.array(RecentSessionSchema),
          }),
        },
      },
    },
    500: {
      description: "Stats fetch failure",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

meRouter.openapi(meProfileRoute, async (c: any) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  try {
    const { data: profile, error } = await supabase.from("profiles").select("*")
      .eq("id", user.id).single();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    const authorization = c.req.header("authorization") || "";
    const accessToken = authorization.replace(/^Bearer\s+/i, "");

    const userPayload = buildUserPayload(profile as any, {
      access_token: accessToken,
      refresh_token: null,
    }, {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
    });

    return c.json(
      {
        ...userPayload.user,
        ...userPayload,
        email: user.email,
        id: user.id,
      },
      200,
    );
  } catch (err: any) {
    console.error("[me] profile fetch failed:", err);
    return c.json({ error: "Failed to fetch profile" }, 500);
  }
});

meRouter.openapi(meStatsRoute, async (c: any) => {
  const user = c.get("user")!;
  const supabase = c.get("supabase");

  try {
    // Fetch media progress joined with library_items for title
    const { data: progressData, error: progressError } = await supabase
      .from("media_progress")
      .select(
        `
        id,
        library_item_id,
        duration,
        progress,
        is_finished,
        finished_at,
        last_update,
        started_at,
        library_items ( title )
      `,
      )
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

    return c.json({ mediaProgress, recentSessions }, 200);
  } catch (err: any) {
    console.error("[me] stats failed:", err);
    return c.json({ error: "Failed to fetch stats" }, 500);
  }
});
