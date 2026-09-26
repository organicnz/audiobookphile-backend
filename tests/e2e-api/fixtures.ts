import { createClient } from "@supabase/supabase-js";

/**
 * Shared fixtures for API e2e: throwaway user + library items wired to REAL
 * storage objects so playback resolution exercises actual tiers.
 *
 * KNOWN_GOOD points at an object verified to exist in B2 (Art of War's
 * preface track, tertiary tier). Resolution probes every configured tier, so
 * the exact tier doesn't matter — but if the object is ever removed, replace
 * the reference. The suite fails loudly either way.
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

/** Item whose media_id prefix holds a real audio object in B2. */
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
  _password: string,
): Promise<string> {
  void _password;
  // Production GoTrue has password logins disabled (magic-link-only), so the
  // custom /auth/login password path 401s by design. Mint a magic-link OTP
  // via the admin API and verify it — no inbox required, exercises the real
  // Supabase JWT session path the edge API authenticates.
  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!gen.ok) {
    throw new Error(`loginUser generate_link failed: ${gen.status}`);
  }
  const { properties, email_otp: topLevelOtp } = (await gen.json()) as {
    properties?: { email_otp?: string };
    email_otp?: string;
  };
  // GoTrue version-dependent: newer returns email_otp nested in properties,
  // this project returns it top-level.
  const otp = properties?.email_otp ?? topLevelOtp;
  if (!otp) throw new Error("loginUser: no email_otp in generate_link");

  const ver = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email, token: otp }),
  });
  if (!ver.ok) throw new Error(`loginUser verify failed: ${ver.status}`);
  const session = (await ver.json()) as { access_token?: string };
  if (!session.access_token) throw new Error("loginUser: no token in session");
  return session.access_token;
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
  isMissing?: boolean;
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
    ...(opts.isMissing === undefined ? {} : { is_missing: opts.isMissing }),
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
