import { createOpenApiRouter, z } from "../_shared/openapi.ts";
import { PlaybackService } from "../../api/playbackService.ts";

export const playbackRouter = createOpenApiRouter();

const PlaySessionSchema = z.object({
  deviceInfo: z.object({
    name: z.string().optional(),
    deviceId: z.string().optional(),
    clientName: z.string().optional(),
    model: z.string().optional(),
    os: z.string().optional(),
    clientVersion: z.string().optional(),
  }).passthrough().optional(),
  forceDirectPlay: z.boolean().optional(),
  forceTranscode: z.boolean().optional(),
  supportedMimeTypes: z.array(z.string()).optional(),
});

const SyncPayloadSchema = z.object({
  currentTime: z.number().min(0),
  timeListened: z.number().min(0),
  duration: z.number().min(0).optional(),
  progress: z.number().min(0).max(1).optional(),
  episodeId: z.string().optional(),
  seekEpoch: z.number().optional(),
});

const BulkSyncSchema = z.array(
  SyncPayloadSchema.extend({
    sessionId: z.string(),
  }),
);

const CloseSessionSchema = SyncPayloadSchema.partial();

const ErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({ message: z.string() }).or(z.string()),
});

const AudioTrackSchema = z.object({
  index: z.number(),
  startOffset: z.number(),
  duration: z.number(),
  title: z.string(),
  contentUrl: z.string(),
  mimeType: z.string().nullable(),
  codec: z.string().nullable(),
  isMissing: z.boolean(),
});

const ChapterSchema = z.object({
  id: z.number(),
  title: z.string(),
  start: z.number(),
  end: z.number(),
});

const SessionResultSchema = z.object({
  id: z.string(),
  userId: z.string(),
  libraryId: z.string().nullable(),
  libraryItemId: z.string(),
  episodeId: z.string().optional(),
  displayTitle: z.string(),
  displayAuthor: z.string(),
  coverPath: z.string().nullable(),
  duration: z.number(),
  playMethod: z.number(),
  mediaPlayer: z.string(),
  mediaType: z.string(),
  audioTracks: z.array(AudioTrackSchema),
  chapters: z.array(ChapterSchema),
  manifestUrl: z.string(),
  missingTrackCount: z.number(),
  currentTime: z.number(),
  playbackRate: z.number(),
  startedAt: z.number(),
  updatedAt: z.number(),
}).passthrough();

const SyncResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  syncedSessionIds: z.array(z.string()).optional(),
});

const playItemRoute = {
  method: "post" as const,
  path: "/items/:id/play",
  tags: ["playback"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: PlaySessionSchema } },
    },
  },
  responses: {
    200: {
      description: "Session started",
      content: { "application/json": { schema: SessionResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Item not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const playItemEpisodeRoute = {
  method: "post" as const,
  path: "/items/:id/play/:episodeId",
  tags: ["playback"],
  request: {
    params: z.object({ id: z.string(), episodeId: z.string() }),
    body: {
      content: { "application/json": { schema: PlaySessionSchema } },
    },
  },
  responses: {
    200: {
      description: "Session started",
      content: { "application/json": { schema: SessionResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Item/episode not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const syncSessionRoute = {
  method: "post" as const,
  path: "/session/:id/sync",
  tags: ["playback"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: SyncPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Session synced",
      content: { "application/json": { schema: SyncResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const bulkSyncRoute = {
  method: "post" as const,
  path: "/session/bulk-sync",
  tags: ["playback"],
  request: {
    body: {
      content: { "application/json": { schema: BulkSyncSchema } },
    },
  },
  responses: {
    200: {
      description: "Sessions synced",
      content: { "application/json": { schema: SyncResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const closeSessionRoute = {
  method: "post" as const,
  path: "/session/:id/close",
  tags: ["playback"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: CloseSessionSchema } },
    },
  },
  responses: {
    200: {
      description: "Session closed",
      content: { "application/json": { schema: SyncResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const itemManifestRoute = {
  method: "get" as const,
  path: "/items/:id/manifest.m3u8",
  tags: ["playback"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "HLS Master Playlist",
      content: { "application/vnd.apple.mpegurl": { schema: z.string() } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const LegacyPlayBodySchema = z.object({
  itemId: z.string().optional(),
  id: z.string().optional(),
  episodeId: z.string().optional(),
  deviceInfo: PlaySessionSchema.shape.deviceInfo,
  forceDirectPlay: z.boolean().optional(),
  forceTranscode: z.boolean().optional(),
  supportedMimeTypes: z.array(z.string()).optional(),
}).passthrough();

const legacySessionPlayRoute = {
  method: "post" as const,
  path: "/session-play",
  tags: ["playback"],
  request: {
    body: {
      content: {
        "application/json": { schema: LegacyPlayBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Session started",
      content: { "application/json": { schema: SessionResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const legacyPlaybackStartRoute = {
  method: "post" as const,
  path: "/playback-start",
  tags: ["playback"],
  request: {
    body: {
      content: {
        "application/json": { schema: LegacyPlayBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Session started",
      content: { "application/json": { schema: SessionResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

const LegacyCloseBodySchema = z.object({
  sessionId: z.string().optional(),
  id: z.string().optional(),
  currentTime: z.number().optional(),
  timeListened: z.number().optional(),
  duration: z.number().optional(),
  progress: z.number().optional(),
  episodeId: z.string().optional(),
}).passthrough();

const legacySessionCloseRoute = {
  method: "post" as const,
  path: "/session-close",
  tags: ["playback"],
  request: {
    body: {
      content: {
        "application/json": { schema: LegacyCloseBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Session closed",
      content: { "application/json": { schema: SyncResultSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
};

playbackRouter.openapi(playItemRoute, async (c: any) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: itemId } = c.req.valid("param");

  let body;
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    body = PlaySessionSchema.parse(rawBody);
  } catch (e: unknown) {
    const zodErrors = e instanceof Object && "errors" in e
      ? (e as { errors: unknown }).errors
      : null;
    return c.json(
      { success: false, error: zodErrors || "Invalid payload" },
      400,
    );
  }

  const deviceInfo = body.deviceInfo ||
    { deviceId: "web-unknown", clientName: "Web Client" };
  const forceDirectPlay = body.forceDirectPlay ?? false;
  const forceTranscode = body.forceTranscode ?? false;
  const supportedMimeTypes = body.supportedMimeTypes || [];

  try {
    const session = await PlaybackService.startSession(
      supabase,
      user.id,
      itemId,
      null,
      deviceInfo,
      supportedMimeTypes,
      forceDirectPlay,
      forceTranscode,
    );
    return c.json(session, 200);
  } catch (err: unknown) {
    const e = err as Error;
    const msg = (e.message || "").toLowerCase();
    const isNotFound = msg.includes("not found") ||
      msg.includes("does not exist") ||
      msg.includes("no audio files") ||
      msg.includes("missing from storage") ||
      msg.includes("missing");
    const status = isNotFound ? 404 : 400;
    return c.json({ success: false, error: { message: e.message } }, status);
  }
});

playbackRouter.openapi(playItemEpisodeRoute, async (c: any) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: itemId, episodeId } = c.req.valid("param");

  let body;
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    body = PlaySessionSchema.parse(rawBody);
  } catch (e: unknown) {
    const zodErrors = e instanceof Object && "errors" in e
      ? (e as { errors: unknown }).errors
      : null;
    return c.json(
      { success: false, error: zodErrors || "Invalid payload" },
      400,
    );
  }

  const deviceInfo = body.deviceInfo ||
    { deviceId: "web-unknown", clientName: "Web Client" };
  const forceDirectPlay = body.forceDirectPlay ?? false;
  const forceTranscode = body.forceTranscode ?? false;
  const supportedMimeTypes = body.supportedMimeTypes || [];

  try {
    const session = await PlaybackService.startSession(
      supabase,
      user.id,
      itemId,
      episodeId,
      deviceInfo,
      supportedMimeTypes,
      forceDirectPlay,
      forceTranscode,
    );
    return c.json(session, 200);
  } catch (err: unknown) {
    const e = err as Error;
    const msg = (e.message || "").toLowerCase();
    const isNotFound = msg.includes("not found") ||
      msg.includes("does not exist") ||
      msg.includes("no audio files") ||
      msg.includes("missing from storage") ||
      msg.includes("missing");
    const status = isNotFound ? 404 : 400;
    return c.json({ success: false, error: { message: e.message } }, status);
  }
});

playbackRouter.openapi(syncSessionRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: sessionId } = c.req.valid("param");
  let body;
  try {
    const rawBody = await c.req.json();
    body = SyncPayloadSchema.parse(rawBody);
  } catch (e: unknown) {
    const zodErrors = e instanceof Object && "errors" in e
      ? (e as { errors: unknown }).errors
      : null;
    return c.json(
      { success: false, error: zodErrors || "Invalid payload" },
      400,
    );
  }

  const { currentTime, timeListened, duration, progress, episodeId } = body;

  const result = await PlaybackService.syncSession(
    supabase,
    user.id,
    sessionId,
    currentTime,
    timeListened,
    duration,
    progress,
    episodeId,
  );

  if (!result.success) {
    return c.json(
      { success: false, error: result.error || "Unknown error" },
      400,
    );
  }

  return c.json(result, 200);
});

playbackRouter.openapi(bulkSyncRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  let body;
  try {
    const rawBody = await c.req.json();
    body = BulkSyncSchema.parse(rawBody);
  } catch (e: unknown) {
    const zodErrors = e instanceof Object && "errors" in e
      ? (e as { errors: unknown }).errors
      : null;
    return c.json(
      { success: false, error: zodErrors || "Invalid payload" },
      400,
    );
  }

  const result = await PlaybackService.bulkSyncSessions(
    supabase,
    user.id,
    body,
  );

  if (!result.success) {
    return c.json(
      { success: false, error: result.error || "Unknown error" },
      400,
    );
  }

  return c.json(result, 200);
});

playbackRouter.openapi(closeSessionRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: sessionId } = c.req.valid("param");
  let body;
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    body = CloseSessionSchema.parse(rawBody);
  } catch (e: unknown) {
    const zodErrors = e instanceof Object && "errors" in e
      ? (e as { errors: unknown }).errors
      : null;
    return c.json(
      { success: false, error: zodErrors || "Invalid payload" },
      400,
    );
  }

  const result = await PlaybackService.closeSession(
    supabase,
    user.id,
    sessionId,
    body.currentTime,
    body.timeListened,
    body.duration,
    body.progress,
    body.episodeId,
  );

  if (!result.success) {
    return c.json(
      { success: false, error: result.error || "Unknown error" },
      400,
    );
  }

  return c.json(result, 200);
});

// Aliases for legacy standalone functions
playbackRouter.openapi(legacySessionPlayRoute, async (c: any) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  let body;
  try {
    body = await c.req.json().catch(() => ({}));
  } catch (_e) {
    body = {};
  }
  const itemId = body.itemId || body.id;
  if (!itemId) {
    return c.json({ success: false, error: "itemId is required" }, 400);
  }
  const deviceInfo = body.deviceInfo ||
    { deviceId: "web-unknown", clientName: "Web Client" };
  const forceDirectPlay = body.forceDirectPlay ?? false;
  const forceTranscode = body.forceTranscode ?? false;
  const supportedMimeTypes = body.supportedMimeTypes || [];

  try {
    const session = await PlaybackService.startSession(
      supabase,
      user.id,
      itemId,
      body.episodeId || null,
      deviceInfo,
      supportedMimeTypes,
      forceDirectPlay,
      forceTranscode,
    );
    return c.json(session, 200);
  } catch (err: unknown) {
    const e = err as Error;
    return c.json({ success: false, error: { message: e.message } }, 400);
  }
});

playbackRouter.openapi(legacyPlaybackStartRoute, async (c: any) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  let body;
  try {
    body = await c.req.json().catch(() => ({}));
  } catch (_e) {
    body = {};
  }
  const itemId = body.itemId || body.id;
  if (!itemId) {
    return c.json({ success: false, error: "itemId is required" }, 400);
  }
  try {
    const session = await PlaybackService.startSession(
      supabase,
      user.id,
      itemId,
      body.episodeId || null,
      body.deviceInfo || { deviceId: "web-unknown", clientName: "Web Client" },
      body.supportedMimeTypes || [],
      body.forceDirectPlay ?? false,
      body.forceTranscode ?? false,
    );
    return c.json(session, 200);
  } catch (err: unknown) {
    const e = err as Error;
    return c.json({ success: false, error: { message: e.message } }, 400);
  }
});

playbackRouter.openapi(legacySessionCloseRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  let body;
  try {
    body = await c.req.json().catch(() => ({}));
  } catch (_e) {
    body = {};
  }
  const sessionId = body.sessionId || body.id;
  if (!sessionId) {
    return c.json({ success: false, error: "sessionId is required" }, 400);
  }
  const result = await PlaybackService.closeSession(
    supabase,
    user.id,
    sessionId,
    body.currentTime,
    body.timeListened,
    body.duration,
    body.progress,
    body.episodeId,
  );
  if (!result.success) {
    return c.json(
      { success: false, error: result.error || "Unknown error" },
      400,
    );
  }
  return c.json(result, 200);
});

playbackRouter.openapi(itemManifestRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: itemId } = c.req.valid("param");

  try {
    const manifest = await PlaybackService.generateMasterManifest(
      supabase,
      user.id,
      itemId,
      null,
    );
    return new Response(manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err: unknown) {
    const e = err as Error;
    return c.json({ success: false, error: { message: e.message } }, 400);
  }
});
