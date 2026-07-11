import { Hono } from "hono";
import { PlaybackService } from "../playbackService.ts";
import { Variables } from "../_shared/types.ts";

export const playbackRouter = new Hono<{ Variables: Variables }>();

playbackRouter.post("/items/:id/play", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const itemId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));
  const deviceInfo = body.deviceInfo ||
    { deviceId: "web-unknown", clientName: "Web Client" };
  const forceDirectPlay = body.forceDirectPlay ?? false;
  const forceTranscode = body.forceTranscode ?? false;
  const supportedMimeTypes = body.supportedMimeTypes || [];

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
});

playbackRouter.post("/items/:id/play/:episodeId", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const itemId = c.req.param("id");
  const episodeId = c.req.param("episodeId");

  const body = await c.req.json().catch(() => ({}));
  const deviceInfo = body.deviceInfo ||
    { deviceId: "web-unknown", clientName: "Web Client" };
  const forceDirectPlay = body.forceDirectPlay ?? false;
  const forceTranscode = body.forceTranscode ?? false;
  const supportedMimeTypes = body.supportedMimeTypes || [];

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
});

playbackRouter.post("/session/:id/sync", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const sessionId = c.req.param("id");
  const { currentTime, timeListened, duration, progress, episodeId } = await c
    .req.json();

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
  const body = await c.req.json();
  
  if (!Array.isArray(body)) {
    return c.json({ success: false, error: "Expected an array of sync payloads" }, 400);
  }

  const result = await PlaybackService.bulkSyncSessions(
    supabase,
    user.id,
    body
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
  const body = await c.req.json().catch(() => ({}));

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
