import { Hono } from "hono";
import { z } from "zod";
import { PlaybackService } from "../../api/playbackService.ts";
import { Variables } from "../_shared/types.ts";

export const playbackRouter = new Hono<{ Variables: Variables }>();

const PlaySessionSchema = z.object({
  deviceInfo: z.record(z.unknown()).optional(),
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
});

const BulkSyncSchema = z.array(
  SyncPayloadSchema.extend({
    sessionId: z.string(),
  }),
);

const CloseSessionSchema = SyncPayloadSchema.partial();

playbackRouter.post("/items/:id/play", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const itemId = c.req.param("id");

  let body;
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    body = PlaySessionSchema.parse(rawBody);
  } catch (e: any) {
    return c.json(
      { success: false, error: e.errors || "Invalid payload" },
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
    return c.json(session);
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

playbackRouter.post("/items/:id/play/:episodeId", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const itemId = c.req.param("id");
  const episodeId = c.req.param("episodeId");

  let body;
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    body = PlaySessionSchema.parse(rawBody);
  } catch (e: any) {
    return c.json(
      { success: false, error: e.errors || "Invalid payload" },
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
    return c.json(session);
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

playbackRouter.post("/session/:id/sync", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const sessionId = c.req.param("id");
  let body;
  try {
    const rawBody = await c.req.json();
    body = SyncPayloadSchema.parse(rawBody);
  } catch (e: any) {
    return c.json(
      { success: false, error: e.errors || "Invalid payload" },
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
    return c.json(result, 400);
  }

  return c.json(result);
});

playbackRouter.post("/session/bulk-sync", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  let body;
  try {
    const rawBody = await c.req.json();
    body = BulkSyncSchema.parse(rawBody);
  } catch (e: any) {
    return c.json(
      { success: false, error: e.errors || "Invalid payload" },
      400,
    );
  }

  const result = await PlaybackService.bulkSyncSessions(
    supabase,
    user.id,
    body,
  );

  if (!result.success) {
    return c.json(result, 400);
  }

  return c.json(result);
});

playbackRouter.post("/session/:id/close", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const sessionId = c.req.param("id");
  let body;
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    body = CloseSessionSchema.parse(rawBody);
  } catch (e: any) {
    return c.json(
      { success: false, error: e.errors || "Invalid payload" },
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
    return c.json(result, 400);
  }

  return c.json(result);
});

// Aliases for legacy standalone functions
playbackRouter.post("/session-play", async (c) => {
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
    return c.json(session);
  } catch (err: unknown) {
    const e = err as Error;
    return c.json({ success: false, error: { message: e.message } }, 400);
  }
});

playbackRouter.post("/playback-start", async (c) => {
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
    return c.json(session);
  } catch (err: unknown) {
    const e = err as Error;
    return c.json({ success: false, error: { message: e.message } }, 400);
  }
});

playbackRouter.post("/session-close", async (c) => {
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
    return c.json(result, 400);
  }
  return c.json(result);
});

