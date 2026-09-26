// Contract-drift guard: the similar-items route must call an RPC that exists
// and must return the same shape as every other item endpoint.
//
// ── WHY THIS TEST EXISTS ──
// `GET /api/items/:id/similar` drove the "Similar to this" shelf on every item
// page. It called `rpc("match_library_items", { item_id, ... })` — a function
// that has never existed in this database. The only similarity function the
// schema has is `match_library_items_hybrid`, which is keyed on `query_text`
// rather than an item id. So the route answered 500 (PGRST202, "Could not find
// the function") on every single request.
//
// It was invisible for two independent reasons, and both had to be fixed:
//   1. the shelf treats an error as "no similar items" and renders nothing, so
//      a total failure looks identical to an empty result, and
//   2. even with a working RPC the route returned raw `library_items` rows,
//      while the shelf feeds them to BookMediaCard / PodcastMediaCard, which
//      branch on `mediaType` and read nested `media.coverPath`. Raw rows have
//      neither field, so the cards would have misrendered anyway.
//
// The invariants worth pinning are therefore mechanical, and all three are
// checked below: the RPC name that is called actually exists, its argument
// shape matches the real signature, and the response is passed through the
// shared mobile mapper so it cannot drift from the other item endpoints again.
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("similar-items route contract", async () => {
  const ROUTE_PATH = new URL("./routes/items.ts", import.meta.url);
  const routeSource = await Deno.readTextFile(ROUTE_PATH);

  /** The body of the similar-items route handler. */
  function similarHandler(): string {
    const start = routeSource.indexOf("itemsRouter.openapi(similarItemsRoute");
    assertEquals(
      start >= 0,
      true,
      "similarItemsRoute is no longer registered on itemsRouter",
    );
    const end = routeSource.indexOf("itemsRouter.openapi(", start + 10);
    return routeSource.slice(start, end === -1 ? undefined : end);
  }

  const handler = similarHandler();

  // 1. The RPC that is called must be one that exists. `match_library_items` is
  //    the PGRST202 trap; `match_library_items_hybrid` is the real signature.
  assertStringIncludes(
    handler,
    'rpc("match_library_items_hybrid"',
    "the similar route must call match_library_items_hybrid; a bare `match_library_items` 500s with PGRST202",
  );
  assertEquals(
    /rpc\(\s*["']match_library_items["']/.test(handler),
    false,
    "`match_library_items` does not exist in the schema and always returns PGRST202",
  );

  // 2. The hybrid function is keyed on query_text, not item_id. Passing item_id
  //    is a type error at best and a silent no-match at worst.
  assertStringIncludes(
    handler,
    "query_text:",
    "match_library_items_hybrid takes query_text; an item_id argument cannot match",
  );
  assertEquals(
    /item_id:\s*itemId/.test(handler),
    false,
    "the similar route must not pass item_id to a query_text-keyed function",
  );

  // 3. Relevance order is the whole point of a similarity endpoint, and an
  //    `in (...)` query returns rows in whatever order Postgres feels like.
  assertStringIncludes(
    handler,
    "const byId = new Map",
    "similar items must be re-ordered back into the RPC's relevance ranking",
  );

  // 4. The response must be mapped, not raw. The shelf's media cards branch on
  //    `mediaType`, which only mapBookForMobile emits.
  assertStringIncludes(
    handler,
    "mapBookForMobile(",
    "similar items must go through mapBookForMobile so they match every other item endpoint's shape",
  );
  assertEquals(
    /\.select\("\*"\)\s*\.in\("id", ids\)/.test(handler),
    false,
    "selecting bare library_items rows returns no mediaType and no media.coverPath, which the shelf's cards require",
  );

  // 5. The source item must be excluded from its own results.
  assertStringIncludes(
    handler,
    ".filter((id) => id !== itemId)",
    "the similar shelf must never show the book you are already looking at",
  );
});
