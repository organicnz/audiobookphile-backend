import { Hono } from "hono";

import { Variables } from "../_shared/types.ts";
export const metadataRouter = new Hono<{ Variables: Variables }>();

// --- NARRATORS ---
metadataRouter.patch("/narrators/:id", async (c) => {
  return c.json(
    { error: "Not implemented (narrators table does not exist)" },
    501,
  );
});

metadataRouter.delete("/narrators/:id", async (c) => {
  return c.json(
    { error: "Not implemented (narrators table does not exist)" },
    501,
  );
});

// --- TAGS ---
metadataRouter.delete("/tags/:id", async (c) => {
  return c.json({ error: "Not implemented (tags table does not exist)" }, 501);
});

// --- GENRES ---
metadataRouter.delete("/genres/:id", async (c) => {
  return c.json(
    { error: "Not implemented (genres table does not exist)" },
    501,
  );
});
