import { upsertMediaProgress } from "../../_shared/progress.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const progressRouter = createOpenApiRouter();

const ProgressPayloadSchema = z.object({
  episodeId: z.string().optional(),
  progress: z.number().min(0).max(1),
  duration: z.number().min(0).optional(),
  isFinished: z.boolean().optional(),
  hideFromContinueListening: z.boolean().optional(),
});

const BatchProgressPayloadSchema = z.array(
  ProgressPayloadSchema.extend({
    libraryItemId: z.string(),
  }),
);

const LegacyProgressPayloadSchema = ProgressPayloadSchema.extend({
  libraryItemId: z.string().optional(),
  itemId: z.string().optional(),
});

const ServerErrorSchema = z.object({ error: z.string() });
const ProgressResultSchema = z.record(z.string(), z.any());
const SuccessSchema = z.object({ success: z.boolean() });
const SuccessDataSchema = z.object({ success: z.boolean(), data: z.any() });

const updateProgressRoute = {
  method: "patch" as const,
  path: "/me/progress/:id",
  tags: ["progress"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: ProgressPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Progress updated",
      content: { "application/json": { schema: ProgressResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const updateProgressBatchRoute = {
  method: "patch" as const,
  path: "/me/progress-batch",
  tags: ["progress"],
  request: {
    body: {
      content: { "application/json": { schema: BatchProgressPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Batch progress updated",
      content: { "application/json": { schema: SuccessSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const updateProgressSeriesRoute = {
  method: "patch" as const,
  path: "/me/progress/series/:id",
  tags: ["progress"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Series progress updated",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
  },
};

const deleteProgressRoute = {
  method: "delete" as const,
  path: "/me/progress/id/:id",
  tags: ["progress"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Progress deleted",
      content: { "application/json": { schema: SuccessSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const playbackProgressRoute = {
  method: "post" as const,
  path: "/playback-progress",
  tags: ["progress"],
  request: {
    body: {
      content: { "application/json": { schema: LegacyProgressPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Progress updated",
      content: { "application/json": { schema: SuccessDataSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const sessionSyncRoute = {
  method: "post" as const,
  path: "/session-sync",
  tags: ["progress"],
  request: {
    body: {
      content: { "application/json": { schema: LegacyProgressPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Progress synced",
      content: { "application/json": { schema: SuccessDataSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

progressRouter.openapi(updateProgressRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: libraryItemId } = c.req.valid("param");

  let body;
  try {
    const rawBody = await c.req.json();
    body = ProgressPayloadSchema.parse(rawBody);
  } catch (e: any) {
    return c.json(
      { success: false, error: e.errors || "Invalid payload" },
      400,
    );
  }

  const data = await upsertMediaProgress(
    supabase,
    user.id,
    libraryItemId,
    body.episodeId ?? null,
    {
      progress: body.progress,
      duration: body.duration,
      isFinished: body.isFinished,
      hideFromContinueListening: body.hideFromContinueListening,
    },
  );

  return c.json(data, 200);
});

progressRouter.openapi(updateProgressBatchRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  let items;

  try {
    const rawBody = await c.req.json();
    items = BatchProgressPayloadSchema.parse(rawBody);
  } catch (e: any) {
    return c.json(
      { success: false, error: e.errors || "Invalid payload" },
      400,
    );
  }

  for (const item of items) {
    await upsertMediaProgress(
      supabase,
      user.id,
      item.libraryItemId,
      item.episodeId ?? null,
      {
        progress: item.progress,
        duration: item.duration,
        isFinished: item.isFinished,
        hideFromContinueListening: item.hideFromContinueListening,
      },
    );
  }
  return c.json({ success: true }, 200);
});

progressRouter.openapi(updateProgressSeriesRoute, async (c) => {
  // For series, we might update a separate table or user preferences
  return c.json({
    success: true,
    message: "Not fully implemented for Supabase yet",
  }, 200);
});

progressRouter.openapi(deleteProgressRoute, async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const { id: progressId } = c.req.valid("param");

  const { error } = await supabase.from("media_progress").delete().eq(
    "id",
    progressId,
  ).eq("user_id", user.id);
  if (error) {
    console.error("[progress] delete error:", error);
    return c.json({ error: "Failed to delete progress" }, 500);
  }
  return c.json({ success: true }, 200);
});

const legacyProgressHandler = async (c: any) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  let body;
  try {
    body = await c.req.json().catch(() => ({}));
  } catch (_e) {
    body = {};
  }
  const libraryItemId = body.libraryItemId || body.itemId;
  if (!libraryItemId) {
    return c.json({ success: false, error: "libraryItemId is required" }, 400);
  }
  const data = await upsertMediaProgress(
    supabase,
    user.id,
    libraryItemId,
    body.episodeId ?? null,
    {
      progress: body.progress ?? 0,
      duration: body.duration,
      isFinished: body.isFinished,
      hideFromContinueListening: body.hideFromContinueListening,
    },
  );
  return c.json({ success: true, data }, 200);
};

progressRouter.openapi(playbackProgressRoute, legacyProgressHandler);
progressRouter.openapi(sessionSyncRoute, legacyProgressHandler);
