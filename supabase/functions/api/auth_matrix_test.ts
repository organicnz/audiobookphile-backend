import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SignJWT } from "jose";
import { app } from "./index.ts";

/**
 * Authorization Matrix tests.
 *
 * Runs the real Hono app (index.ts) with cryptographically valid JWTs minted
 * against SUPABASE_JWT_SECRET, and a fake Supabase REST/Auth stack implemented
 * by intercepting globalThis.fetch. Every request therefore exercises the
 * real authMiddleware (JWT verification + DB-fresh profile lookup) and the
 * per-route requireAdminRole guards — without any network access.
 */

const SECRET = "auth-matrix-test-secret-0123456789abcdef";
Deno.env.set("SUPABASE_JWT_SECRET", SECRET);
Deno.env.set("SUPABASE_URL", "https://matrix-test.supabase.internal");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_role_matrix_test");
Deno.env.set("NODE_ENV", "test");
Deno.env.delete("ZAI_API_KEY");
Deno.env.delete("ZHIPU_API_KEY");

const PROFILES: Record<string, any> = {
  "member-1": {
    id: "member-1",
    username: "member1",
    user_type: "user",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_banned: false,
    is_locked: false,
    default_library_id: null,
  },
  "member-2": {
    id: "member-2",
    username: "member2",
    user_type: "user",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_banned: false,
    is_locked: false,
    default_library_id: null,
  },
  "admin-1": {
    id: "admin-1",
    username: "admin1",
    user_type: "admin",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_banned: false,
    is_locked: false,
    default_library_id: null,
  },
  "root-1": {
    id: "root-1",
    username: "root1",
    user_type: "root",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_banned: false,
    is_locked: false,
    default_library_id: null,
  },
};

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

  if (path.endsWith("/rest/v1/profiles")) {
    const idFilter = url.searchParams.get("id");
    if (idFilter) {
      const profile = PROFILES[idFilter.replace(/^eq\./, "")];
      return jsonResponse(profile ? [profile] : []);
    }
    return jsonResponse(Object.values(PROFILES));
  }

  if (path.includes("/rest/v1/")) {
    return jsonResponse([], 200, { "content-range": "0-0/4" });
  }

  if (path.includes("/auth/v1/admin/users")) {
    const method = (init?.method ?? "GET").toUpperCase();
    const maybeId = path.split("/").pop()!;
    if (method === "GET" && PUBLIC_IDS.has(maybeId)) {
      return jsonResponse({
        user: { id: maybeId, email: `${maybeId}@test.local` },
      });
    }
    if (method === "GET") {
      return jsonResponse({
        users: Object.values(PROFILES).map((p) => ({
          id: p.id,
          email: `${p.id}@test.local`,
          role: "authenticated",
          created_at: p.created_at,
          user_metadata: { username: p.username },
        })),
        next_page: null,
      });
    }
    return jsonResponse({});
  }

  return jsonResponse({});
};

const PUBLIC_IDS = new Set(Object.keys(PROFILES));

async function mintToken(sub: string, secret = SECRET): Promise<string> {
  return await new SignJWT({
    email: `${sub}@test.local`,
    role: "authenticated",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

async function requestStatus(
  method: string,
  path: string,
  token?: string,
  body?: object,
): Promise<number> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await app.request(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return res.status;
}

const FORBIDDEN = new Set([401, 403]);

function assertAccess(
  expectedForbidden: boolean,
  status: number,
  label: string,
) {
  if (expectedForbidden) {
    assert(
      FORBIDDEN.has(status),
      `${label}: expected 401/403 (forbidden), got ${status}`,
    );
  } else {
    assert(
      !FORBIDDEN.has(status),
      `${label}: expected allowed (not 401/403), got ${status}`,
    );
  }
}

// Every server-global / management surface that must be admin-or-root only.
const protectedRoutes: Array<[string, string]> = [
  ["GET", "/api/users"],
  ["POST", "/api/users"],
  ["POST", "/api/auth/invite"],
  ["GET", "/api/admin-analytics"],
  ["GET", "/api/admin/analytics"],
  ["GET", "/api/filesystem"],
  ["GET", "/api/sessions"],
  ["DELETE", "/api/backups/backup-1"],
  ["POST", "/api/sessions/batch/delete"],
  ["POST", "/api/backup-database"],
  ["PATCH", "/api/genres/Fantasy"],
  ["PUT", "/api/tags/narrated"],
  ["DELETE", "/api/tags/narrated"],
  ["PATCH", "/api/narrators/narrator-1"],
  ["DELETE", "/api/narrators/narrator-1"],
  ["DELETE", "/api/tags/tag-1"],
  ["DELETE", "/api/genres/genre-1"],
  ["POST", "/api/match-book"],
  ["POST", "/api/scrape-metadata"],
  ["POST", "/api/metadata/scrape"],
  ["PATCH", "/api/authors/author-1"],
  ["DELETE", "/api/authors/author-1"],
  ["POST", "/api/authors/author-1/match"],
  ["POST", "/api/authors/author-1/image"],
  ["DELETE", "/api/authors/author-1/image"],
  ["POST", "/api/authors/sync-authors"],
  ["POST", "/api/libraries"],
  ["PATCH", "/api/libraries/library-1"],
  ["DELETE", "/api/libraries/library-1"],
  ["POST", "/api/libraries/library-1/scan"],
  ["POST", "/api/libraries/library-1/smart-sort"],
  ["POST", "/api/libraries/library-1/deduplicate"],
  ["DELETE", "/api/items/item-1/cover"],
  ["POST", "/api/items/item-1/cover"],
  ["PATCH", "/api/items/item-1/cover"],
  ["POST", "/api/items/sync-covers"],
  ["POST", "/api/items/sync-durations"],
  ["POST", "/api/items/sync-insights"],
  ["POST", "/api/migrate-batch"],
];

Deno.test("AuthZ Matrix: every protected route rejects members", async () => {
  const token = await mintToken("member-1");
  for (const [method, path] of protectedRoutes) {
    const status = await requestStatus(
      method,
      path,
      token,
      method === "GET" ? undefined : {},
    );
    assertAccess(true, status, `member ${method} ${path}`);
  }
});

Deno.test("AuthZ Matrix: admin and root reach every protected route", async () => {
  for (const role of ["admin-1", "root-1"]) {
    const token = await mintToken(role);
    for (const [method, path] of protectedRoutes) {
      const status = await requestStatus(
        method,
        path,
        token,
        method === "GET" ? undefined : {},
      );
      assertAccess(false, status, `${role} ${method} ${path}`);
    }
  }
});

Deno.test("AuthZ Matrix: guests without tokens are rejected", async () => {
  for (const [method, path] of protectedRoutes) {
    const status = await requestStatus(
      method,
      path,
      undefined,
      method === "GET" ? undefined : {},
    );
    assertEquals(status, 401, `guest ${method} ${path}`);
  }
});

Deno.test("AuthZ Matrix: self-service and role-change rules", async () => {
  const member = await mintToken("member-1");
  const _member2 = await mintToken("member-2");
  const admin = await mintToken("admin-1");

  // Self-elevation is impossible for members (role change on self or any other user)
  assertAccess(
    true,
    await requestStatus("PATCH", "/api/users/member-1", member, {
      type: "admin",
    }),
    "member self-elevation",
  );
  assertAccess(
    true,
    await requestStatus("PATCH", "/api/users/admin-1", member, {
      type: "admin",
    }),
    "member elevates admin",
  );
  // Plain self-edit stays allowed
  assertAccess(
    false,
    await requestStatus("PATCH", "/api/users/member-1", member, {
      username: "renamed",
    }),
    "member self rename",
  );
  // Self-deletion is allowed; deleting others requires admin
  assertAccess(
    false,
    await requestStatus("DELETE", "/api/users/member-1", member),
    "member self delete",
  );
  assertAccess(
    true,
    await requestStatus("DELETE", "/api/users/member-2", member),
    "member deletes other",
  );
  // Admins can never change their OWN role
  assertAccess(
    true,
    await requestStatus("PATCH", "/api/users/admin-1", admin, { type: "root" }),
    "admin self elevation",
  );
  // Admins manage other users
  assertAccess(
    false,
    await requestStatus("PATCH", "/api/users/member-1", admin, {
      type: "admin",
    }),
    "admin promotes member",
  );
  assertAccess(
    false,
    await requestStatus("DELETE", "/api/users/member-2", admin),
    "admin deletes member",
  );
});

Deno.test("AuthZ Matrix: forged and tampered tokens are rejected", async () => {
  // Signed with a different secret — must fail signature verification
  const forged = await mintToken("member-1", "attacker-controlled-secret");
  assertEquals(
    await requestStatus("GET", "/api/users", forged),
    401,
    "forged signature",
  );

  // Complete garbage
  assertEquals(
    await requestStatus("GET", "/api/users", "not.a.jwt"),
    401,
    "garbage token",
  );
});

Deno.test("AuthZ Matrix: user-facing routes remain open to members", async () => {
  const member = await mintToken("member-1");
  const openRoutes: Array<[string, string]> = [
    ["GET", "/api/me"],
    ["GET", "/api/me/stats"],
    ["GET", "/api/search/history"],
    ["GET", "/api/items/item-1"],
    ["GET", "/api/items/item-1/cover"],
    ["POST", "/api/chapter-ai"],
    ["POST", "/api/ai/chapter"],
    ["POST", "/api/ai/insights"],
    ["POST", "/api/upload-presign"],
    ["POST", "/api/items/upload-presign"],
    ["GET", "/api/libraries/library-1/items"],
    ["GET", "/api/users/me/preferences"],
  ];
  for (const [method, path] of openRoutes) {
    const status = await requestStatus(
      method,
      path,
      member,
      method === "GET" ? undefined : {},
    );
    assertAccess(false, status, `member ${method} ${path} (user-facing)`);
  }

  // Health check is public
  assertEquals(
    await requestStatus("GET", "/api/health", undefined),
    200,
    "public health",
  );
});
