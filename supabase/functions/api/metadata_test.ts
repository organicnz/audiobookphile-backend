import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { app } from "./index.ts";

Deno.test("Metadata: GET /api/metadata/:id returns error without auth", async () => {
  const req = new Request("http://localhost/api/metadata/test-id", {
    method: "GET",
  });

  const res = await app.request(req);
  const json = await res.json();

  assertEquals(res.status >= 400, true);
});
