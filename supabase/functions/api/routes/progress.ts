import { Hono } from "hono";
import { upsertMediaProgress } from "../../_shared/progress.ts";
import { Variables } from "../_shared/types.ts";
import { z } from "zod";

export const progressRouter = new Hono<{ Variables: Variables }>();

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

progressRouter.patch("/me/progress/:id", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const libraryItemId = c.req.param("id");
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

  return c.json(data);
});

progressRouter.patch("/me/progress-batch", async (c) => {
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
  return c.json({ success: true });
});

progressRouter.patch("/me/progress/series/:id", async (c) => {
  // For series, we might update a separate table or user preferences
  return c.json({
    success: true,
    message: "Not fully implemented for Supabase yet",
  });
});

progressRouter.delete("/me/progress/id/:id", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user")!;
  const progressId = c.req.param("id");

  const { error } = await supabase.from("media_progress").delete().eq(
    "id",
    progressId,
  ).eq("user_id", user.id);
  if (error) throw error;
  return c.json({ success: true });
});
