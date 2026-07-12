import { Hono } from "hono";
import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { Variables } from "../_shared/types.ts";
import { getProxyOrigin } from "../_shared/proxy.ts";

export const authRouter = new Hono<{ Variables: Variables }>();

authRouter.post("/login", async (c) => {
  const supabase = c.get("supabase");
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const body = await c.req.json();
  const { username, password } = body;
  if (!username || !password) throw new Error("Username and password required");

  let emailToUse = username;
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  if (!username.includes("@")) {
    const { data: profile } = await adminSupabase.from("profiles").select("id")
      .eq("username", username).single();
    if (profile?.id) {
      const { data: userData } = await adminSupabase.auth.admin.getUserById(
        profile.id,
      );
      if (userData?.user?.email) emailToUse = userData.user.email;
    }
  }

  const { data: authData, error: authError } = await supabase.auth
    .signInWithPassword({ email: emailToUse, password });
  if (authError || !authData.user) {
    return c.json({ error: { message: "Invalid credentials" } }, 401);
  }

  const { data: profile } = await adminSupabase.from("profiles").select("*").eq(
    "id",
    authData.user.id,
  ).single();

  const userPayload = {
    user: {
      id: authData.user.id,
      username: profile?.username || authData.user.email?.split("@")[0] ||
        "User",
      email: authData.user.email,
      type: profile?.user_type || "user",
      token: authData.session.access_token,
      refreshToken: authData.session.refresh_token || null,
      mediaProgress: [],
      seriesHideFromContinueListening: [],
      bookmarks: [],
      isActive: true,
      isLocked: false,
      lastSeen: Date.now(),
      createdAt: new Date(profile?.created_at || authData.user.created_at)
        .getTime(),
      permissions: {
        download: true,
        update: profile?.user_type === "admin",
        delete: profile?.user_type === "admin",
        upload: profile?.user_type === "admin",
        accessAllLibraries: true,
        accessAllTags: true,
        accessExplicitContent: true,
      },
      librariesAccessible: [],
      itemTagsAccessible: [],
    },
    userDefaultLibraryId: profile?.default_library_id || null,
    serverSettings: {},
    source: "local",
  };
  return c.json(userPayload);
});

authRouter.post("/signup", async (c) => {
  const supabase = c.get("supabase");
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const body = await c.req.json();
  const { email, password, username } = body;
  if (!email || !password) throw new Error("Email and password required");

  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
  });
  if (authError) return c.json({ error: authError.message }, 400);

  if (username && authData.user) {
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
    await adminSupabase.from("profiles").update({ username }).eq(
      "id",
      authData.user.id,
    );
  }

  return c.json({ success: true, user: authData.user });
});

authRouter.post("/logout", async (c) => {
  const supabase = c.get("supabase");
  const jwt = c.req.header("Authorization")?.replace("Bearer ", "");
  if (jwt) {
    await supabase.auth.signOut();
  }
  return c.json({ success: true });
});

authRouter.post("/auth/forgot-password", async (c) => {
  const supabase = c.get("supabase");
  const body = await c.req.json();
  const { email } = body;
  const siteUrl = getProxyOrigin(c);
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl}/auth/callback?next=/reset-password`,
  });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ success: true });
});

authRouter.post("/auth/reset-password", async (c) => {
  const supabase = c.get("supabase");
  const body = await c.req.json();
  const { password } = body;
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ success: true });
});

authRouter.post("/auth/change-password", async (c) => {
  const supabase = c.get("supabase");
  const body = await c.req.json();
  const { newPassword } = body;
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ success: true });
});

authRouter.post("/auth/refresh", async (c) => {
  const supabase = c.get("supabase");
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const refreshToken = c.req.header("x-refresh-token") ||
    (await c.req.json().catch(() => ({}))).refreshToken;
  if (!refreshToken) throw new Error("Missing refresh token");

  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: refreshToken,
  });
  if (error || !data.session) {
    return c.json({ error: { message: "Invalid refresh token" } }, 401);
  }

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: profile } = await adminSupabase.from("profiles").select("*").eq(
    "id",
    data.user!.id,
  ).single();

  const userPayload = {
    user: {
      id: data.user!.id,
      username: profile?.username || data.user!.email?.split("@")[0] || "User",
      email: data.user!.email,
      type: profile?.user_type || "user",
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      mediaProgress: [],
      seriesHideFromContinueListening: [],
      bookmarks: [],
      isActive: true,
      isLocked: false,
      lastSeen: Date.now(),
      createdAt: new Date(profile?.created_at || data.user!.created_at)
        .getTime(),
      permissions: {
        download: true,
        update: profile?.user_type === "admin",
        delete: profile?.user_type === "admin",
        upload: profile?.user_type === "admin",
        accessAllLibraries: true,
        accessAllTags: true,
        accessExplicitContent: true,
      },
      librariesAccessible: [],
      itemTagsAccessible: [],
    },
    userDefaultLibraryId: profile?.default_library_id || null,
    serverSettings: {},
    source: "local",
  };
  return c.json(userPayload);
});

authRouter.post("/authorize", async (c) => {
  const supabase = c.get("supabase");
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const jwt = c.req.header("Authorization")?.replace("Bearer ", "") || "";

  const { data: { user }, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !user) {
    console.error(
      `[auth.ts] /authorize getUser failed:`,
      userError,
      `user is null?`,
      !user,
    );
    return c.json({ error: { message: "Unauthorized" } }, 401);
  }

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: profile } = await adminSupabase.from("profiles").select("*").eq(
    "id",
    user.id,
  ).single();

  const userPayload = {
    user: {
      id: user.id,
      username: profile?.username || user.email?.split("@")[0] || "User",
      email: user.email,
      type: profile?.user_type || "user",
      token: c.req.header("Authorization")?.replace("Bearer ", "") || "",
      mediaProgress: [],
      seriesHideFromContinueListening: [],
      bookmarks: [],
      isActive: true,
      isLocked: false,
      lastSeen: Date.now(),
      createdAt: new Date(profile?.created_at || user.created_at).getTime(),
      permissions: {
        download: true,
        update: profile?.user_type === "admin",
        delete: profile?.user_type === "admin",
        upload: profile?.user_type === "admin",
        accessAllLibraries: true,
        accessAllTags: true,
        accessExplicitContent: true,
      },
      librariesAccessible: [],
      itemTagsAccessible: [],
    },
    userDefaultLibraryId: profile?.default_library_id || null,
    serverSettings: {},
    source: "local",
  };
  return c.json(userPayload);
});
