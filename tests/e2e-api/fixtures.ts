import { createClient } from "@supabase/supabase-js";

/**
 * Shared fixtures for API e2e: throwaway user + library items wired to REAL
 * storage objects so playback resolution exercises actual tiers.
 *
 * KNOWN_GOOD_B2_PATH points at an object verified to exist in the primary B2
 * bucket (Art of War's preface track). If that object is ever removed, replace
 * the reference - the suite fails loudly either way.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for api e2e",
  );
}

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Item whose media_id prefix holds real audio objects in B2 primary. */
export const KNOWN_GOOD = {
  itemId: "029bb772-cea8-4d3f-882a-1bf9f54198d8", // Art of War (prod)
  b2Prefix: "14f87e3d-c1eb-42ef-b6f7-292838b0a225", // its media_id prefix
  filename: "00 - Preface.mp3",
};

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
}

export async function createTestUser(prefix: string): Promise<TestUser> {
  const email = `${prefix}-${Date.now()}@audiobookphile.test`;
  const password = `E2e-Pw-${crypto.randomUUID().slice(0, 13)}!`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) {
    throw new Error(`createTestUser: ${res.status} ${await res.text()}`);
  }
  const { id } = (await res.json()) as { id: string };
  return { id, email, password, token: "" };
}

export async function loginUser(
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email, password }),
  });
  if (!res.ok) throw new Error(`loginUser failed: ${res.status}`);
  const body = await res.json();
  const token = body?.user?.token ?? body?.access_token;
  if (!token) throw new Error(`loginUser: no token in response`);
  return token as string;
}

export async function deleteTestUser(userId: string): Promise<void> {
  // profile row blocks auth deletion (FK) - clear it first
  await admin.from("profiles").delete().eq("id", userId);
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
}

export interface FixtureItem {
  id: string;
}

/**
 * Seed a minimal book item. Track paths are scheme'd (b2://...) so the play
 * endpoint takes the blind-presign + self-heal code path under test.
 */
export async function seedItem(opts: {
  title: string;
  tracks: { filename: string; path: string; duration?: number }[];
}): Promise<FixtureItem> {
  const id = crypto.randomUUID();
  const audio_files = opts.tracks.map((t, i) => ({
    index: i + 1,
    duration: t.duration ?? 120,
    mimeType: "audio/mpeg",
    metadata: { filename: t.filename, relPath: t.filename, path: t.path },
  }));
  const libRow = await admin.from("libraries").select("id").limit(1)
    .maybeSingle();
  if (!libRow.data?.id) throw new Error("no library exists to attach fixture");
  const { error } = await admin.from("library_items").insert({
    id,
    title: opts.title,
    media_type: "book",
    library_id: libRow.data.id,
    created_at: new Date().toISOString(),
    audio_files,
    library_files: [],
  });
  if (error) throw new Error(`seedItem: ${error.message}`);
  return { id };
}

export async function deleteItem(id: string): Promise<void> {
  // children first where FKs are NO ACTION/cascade-sensitive in odd orders
  await admin.from("media_progress").delete().eq("library_item_id", id);
  await admin.from("book_authors").delete().eq("library_item_id", id);
  await admin.from("book_series").delete().eq("library_item_id", id);
  await admin.from("collection_items").delete().eq("library_item_id", id);
  const { error } = await admin.from("library_items").delete().eq("id", id);
  if (error) throw new Error(`deleteItem(${id}): ${error.message}`);
}
