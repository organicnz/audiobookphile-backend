import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";
import { Variables } from "../_shared/types.ts";

export const usersRouter = new Hono<{ Variables: Variables }>();

usersRouter.get("/", async (c) => {
  const user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const supabase = c.get("supabase");

  // Verify admin
  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: users, error } = await adminSupabase.from("profiles").select(
    "*",
  );
  if (error) throw error;

  // Fetch auth info
  const { data: authUsers } = await adminSupabase.auth.admin.listUsers();
  const emailMap = new Map(
    (authUsers?.users || []).map((u: any) => [u.id, u.email]),
  );

  const formattedUsers = users.map((u: any) => ({
    id: u.id,
    username: u.username || emailMap.get(u.id)?.split("@")[0] || "User",
    type: u.user_type,
    token: "",
    permissions: {
      download: true,
      update: u.user_type === "admin",
      delete: u.user_type === "admin",
      upload: u.user_type === "admin",
      accessAllLibraries: true,
      accessAllTags: true,
      accessExplicitContent: true,
    },
    librariesAccessible: [],
    itemTagsAccessible: [],
    mediaProgress: [],
    seriesHideFromContinueListening: [],
    bookmarks: [],
    isActive: true,
    isLocked: false,
    lastSeen: Date.now(),
    createdAt: new Date(u.created_at).getTime(),
  }));

  return c.json({ users: formattedUsers });
});

usersRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const supabase = c.get("supabase");

  // Verify admin
  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
  const body = await c.req.json();
  const emailToUse = body.username.includes("@")
    ? body.username
    : `${body.username}@local.abp`;

  const { data: authData, error: authError } = await adminSupabase.auth.admin
    .createUser({
      email: emailToUse,
      password: body.password,
      email_confirm: true,
    });
  if (authError) throw authError;

  const { error: profileError } = await adminSupabase.from("profiles").update({
    username: body.username,
    user_type: body.type === "admin" ? "admin" : "user",
  }).eq("id", authData.user.id);

  if (profileError) throw profileError;

  return c.json({ success: true, id: authData.user.id });
});

usersRouter.delete("/:id", async (c) => {
  const user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const supabase = c.get("supabase");

  // Verify admin
  const { data: profile } = await supabase.from("profiles").select("user_type")
    .eq("id", user.id).single();
  if (profile?.user_type !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
  const userId = c.req.param("id");

  const { error } = await adminSupabase.auth.admin.deleteUser(userId);
  if (error) throw error;
  return c.json({ success: true });
});

usersRouter.patch("/:id", async (c) => {
  const user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const supabase = c.get("supabase");

  const userId = c.req.param("id");

  // Verify admin or self
  if (user.id !== userId) {
    const { data: profile } = await supabase.from("profiles").select(
      "user_type",
    ).eq("id", user.id).single();
    if (profile?.user_type !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
  const body = await c.req.json();

  if (body.password) {
    const { error: authError } = await adminSupabase.auth.admin.updateUserById(
      userId,
      { password: body.password },
    );
    if (authError) throw authError;
  }

  if (body.type || body.username) {
    const updates: any = {};
    if (body.type) updates.user_type = body.type === "admin" ? "admin" : "user";
    if (body.username) updates.username = body.username;
    const { error: profileError } = await adminSupabase.from("profiles").update(
      updates,
    ).eq("id", userId);
    if (profileError) throw profileError;
  }

  return c.json({ success: true });
});

usersRouter.get("/me/preferences", async (c) => {
  const user = c.get("user")!;
  if (!user || !user.id) return c.json({ error: "Unauthorized" }, 401);

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: authUser, error } = await adminSupabase.auth.admin.getUserById(
    user.id,
  );
  if (error) throw error;
  const defaultPreferences = {
    jumpForwardTime: 30,
    jumpBackwardsTime: 10,
    lockScreenControls: true,
    autoDownloadPodcasts: false,
    sleepTimerAutoStart: false,
    sleepTimerDefaultTime: 900,
    theme: "system",
    bookCoverAspectRatio: 1,
    autoResume: true,
    hapticsEnabled: true,
    lockOrientation: false,
  };
  const userPrefs = authUser.user.user_metadata?.preferences || {};
  const preferences = { ...defaultPreferences, ...userPrefs };
  return c.json({ preferences });
});

usersRouter.patch("/me/preferences", async (c) => {
  const user = c.get("user")!;
  if (!user || !user.id) return c.json({ error: "Unauthorized" }, 401);

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const body = await c.req.json();

  const { data: authUser, error: getError } = await adminSupabase.auth.admin
    .getUserById(user.id);
  if (getError) throw getError;
  const currentPreferences = authUser.user.user_metadata?.preferences || {};

  const newPreferences = { ...currentPreferences, ...body };
  const newMetadata = {
    ...authUser.user.user_metadata,
    preferences: newPreferences,
  };

  const { error } = await adminSupabase.auth.admin.updateUserById(user.id, {
    user_metadata: newMetadata,
  });
  if (error) throw error;

  return c.json({ preferences: newPreferences });
});
