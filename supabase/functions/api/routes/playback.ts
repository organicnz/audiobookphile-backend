import { Hono } from "hono";
import { z } from "zod";
import { PlaybackService } from "../playbackService.ts";
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
