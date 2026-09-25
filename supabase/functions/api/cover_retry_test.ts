import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SignJWT } from "jose";
import { app } from "./index.ts";

/**
 * Cover sentinel regression tests.
 *
 * Production bug: 20 of 100 library items were permanently pinned to
 * cover_path = "missing" even though every one of them had a fetchable cover
 * (verified live against iTunes/OpenLibrary/Google Books). "missing" is a
 * terminal sentinel — the route only retries it with ?force=1 — so a single
 * transient network/provider error stripped the cover forever.
 *
 * These tests lock in the contract: only a *definitive* "providers had no
 * cover" result may persist "missing". Transient errors must leave the row
 * untouched and return 503 so the client retries.
 */

const SECRET = "cover-retry-test-secret-0123456789abcdef";
Deno.env.set("SUPABASE_JWT_SECRET", SECRET);
Deno.env.set("SUPABASE_URL", "https://cover-test.supabase.internal");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_role_cover_test");
Deno.env.set("NODE_ENV", "test");

const ADMIN_ID = "admin-cover-1";
const ITEM_ID = "99999999-8888-7777-6666-555555555555";

const PROFILES: Record<string, unknown> = {
  [ADMIN_ID]: {
    id: ADMIN_ID,
    username: "coveradmin",
    user_type: "admin",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_banned: false,
    is_locked: false,
    default_library_id: null,
  },
};

/** Rows the route attempted to write, so we can assert nothing was persisted. */
let libraryItemWrites: Record<string, unknown>[] = [];

/** How the external metadata providers should behave. */
type ProviderMode = "transient-failure" | "no-results";

let providerMode: ProviderMode = "transient-failure";

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

globalThis.fetch = async (input: any, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();

  if (path.endsWith("/rest/v1/profiles")) {
    const idFilter = url.searchParams.get("id");
    if (idFilter) {
      const profile = PROFILES[idFilter.replace(/^eq\./, "")];
      return jsonResponse(profile ? [profile] : []);
    }
    return jsonResponse(Object.values(PROFILES));
  }

  if (path.includes("/rest/v1/library_items")) {
    if (method !== "GET") {
      // Record every attempted write to the library_items row.
      try {
        libraryItemWrites.push(JSON.parse(String(init?.body ?? "{}")));
      } catch {
        libraryItemWrites.push({ __unparsed: String(init?.body) });
      }
      return jsonResponse([]);
    }
    // The route uses .single(), so PostgREST would return a bare object here
    // (Accept: application/vnd.pgrst.object+json), not an array. The row under
    // test is pinned to the terminal sentinel.
    return jsonResponse({
      id: ITEM_ID,
      title: "Art of War",
      cover_path: "missing",
      book_authors: [{ authors: { name: "Nicolo Machiavelli" } }],
    });
  }

  if (path.includes("/rest/v1/")) return jsonResponse([]);

  if (path.includes("/auth/v1/admin/users")) {
    if ((init?.method ?? "GET").toUpperCase() === "GET") {
      return jsonResponse({
        user: { id: ADMIN_ID, email: "coveradmin@test.local" },
      });
    }
    return jsonResponse({});
  }

  // External cover providers — match on host, not pathname (their paths are
  // just /search, /search.json and /books/v1/volumes).
  const host = url.hostname;
  if (
    host.includes("itunes.apple.com") || host.includes("openlibrary.org") ||
    host.includes("googleapis.com")
  ) {
    if (providerMode === "transient-failure") {
      // A dropped connection mid-flight — exactly the class of failure that
      // used to be written to the row as a terminal "missing".
      throw new TypeError("fetch failed");
    }
    // Providers answered, and genuinely had nothing.
    if (host.includes("itunes.apple.com")) return jsonResponse({ results: [] });
    if (host.includes("openlibrary.org")) return jsonResponse({ docs: [] });
    return jsonResponse({ totalItems: 0, items: [] });
  }

  return jsonResponse({});
};

async function mintAdminToken(): Promise<string> {
  return await new SignJWT({
    email: "coveradmin@test.local",
    role: "authenticated",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ADMIN_ID)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

async function requestCover(token: string): Promise<Response> {
  return await app.request(
    new Request(
      `http://localhost/api/items/${ITEM_ID}/cover?force=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
  );
}

Deno.test("cover: transient provider failure does NOT persist the terminal missing sentinel", async () => {
  libraryItemWrites = [];
  providerMode = "transient-failure";
  const token = await mintAdminToken();

  const res = await requestCover(token);

  assertEquals(
    res.status,
    503,
    "transient provider failure must surface as retryable 503, not a terminal answer",
  );

  const persistedMissing = libraryItemWrites.some(
    (w) => w.cover_path === "missing",
  );
  assertEquals(
    persistedMissing,
    false,
    `a transient error must not be written to cover_path; got writes: ${
      JSON.stringify(libraryItemWrites)
    }`,
  );
});

Deno.test("cover: providers with no results still persist the terminal missing sentinel", async () => {
  libraryItemWrites = [];
  providerMode = "no-results";
  const token = await mintAdminToken();

  const res = await requestCover(token);

  // A definitive "this work has no cover anywhere" is terminal and should be
  // recorded so the item is not re-queried on every page load.
  assertEquals(res.status, 404);
  const persistedMissing = libraryItemWrites.some(
    (w) => w.cover_path === "missing",
  );
  assert(
    persistedMissing,
    `a definitive no-cover result must persist "missing"; got writes: ${
      JSON.stringify(libraryItemWrites)
    }`,
  );
});
