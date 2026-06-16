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
  const { currentTime, timeListened } = await c.req.json();

  const result = await PlaybackService.syncSession(
    supabase,
    user.id,
    sessionId,
    currentTime,
    timeListened,
  );
  return c.json(result);
});

playbackRouter.post("/session/:id/close", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const sessionId = c.req.param("id");

  await PlaybackService.closeSession(supabase, user.id, sessionId);
  return c.json({ success: true });
});
