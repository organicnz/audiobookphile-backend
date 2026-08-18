import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { requireAdminRole } from "../_shared/auth.ts";
import { createOpenApiRouter, z } from "../_shared/openapi.ts";

export const usersRouter = createOpenApiRouter();

const UserCreateSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  type: z.string().optional(),
});

const UserUpdateSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(6).optional(),
  type: z.string().optional(),
});

const ServerErrorSchema = z.object({ error: z.string() });
const ForbiddenSchema = z.object({ error: z.string() });
const UsersResultSchema = z.object({
  users: z.array(z.record(z.string(), z.any())),
});
const SuccessIdSchema = z.object({ success: z.boolean(), id: z.string() });
const SuccessSchema = z.object({ success: z.boolean() });
const PreferencesResultSchema = z.object({
  preferences: z.record(z.string(), z.any()),
});

const getUsersRoute = {
  method: "get" as const,
  path: "/",
  tags: ["users"],
  responses: {
    200: {
      description: "List users",
      content: { "application/json": { schema: UsersResultSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const createUserRoute = {
  method: "post" as const,
  path: "/",
  tags: ["users"],
  responses: {
    200: {
      description: "User created",
      content: { "application/json": { schema: SuccessIdSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const deleteUserRoute = {
  method: "delete" as const,
  path: "/:id",
  tags: ["users"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "User deleted",
      content: { "application/json": { schema: SuccessSchema } },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const updateUserRoute = {
  method: "patch" as const,
  path: "/:id",
  tags: ["users"],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: UserUpdateSchema } },
    },
  },
  responses: {
    200: {
      description: "User updated",
      content: { "application/json": { schema: SuccessSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
    403: {
      description: "Admin role required",
      content: { "application/json": { schema: ForbiddenSchema } },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const getPreferencesRoute = {
  method: "get" as const,
  path: "/me/preferences",
  tags: ["users"],
  responses: {
    200: {
      description: "Get user preferences",
      content: { "application/json": { schema: PreferencesResultSchema } },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

const updatePreferencesRoute = {
  method: "patch" as const,
  path: "/me/preferences",
  tags: ["users"],
  request: {
    body: {
      content: {
        "application/json": { schema: z.record(z.string(), z.any()) },
      },
    },
  },
  responses: {
    200: {
      description: "User preferences updated",
      content: { "application/json": { schema: PreferencesResultSchema } },
    },
    400: {
      description: "Invalid payload",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
    500: {
      description: "Database error",
      content: { "application/json": { schema: ServerErrorSchema } },
    },
  },
};

usersRouter.openapi(getUsersRoute, async (c) => {
  const user = c.get("user")!;
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: users, error } = await adminSupabase.from("profiles").select(
    "*",
  );
  if (error) {
    console.error("[users] Get users error:", error);
    return c.json({ error: "Failed to get users" }, 500);
  }

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

  return c.json({ users: formattedUsers }, 200);
});

usersRouter.openapi(createUserRoute, async (c) => {
  const user = c.get("user")!;
  if (!requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");

  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = UserCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  const emailToUse = parsed.data.username.includes("@")
    ? parsed.data.username
    : `${parsed.data.username}@local.abp`;

  const { data: authData, error: authError } = await adminSupabase.auth.admin
    .createUser({
      email: emailToUse,
      password: parsed.data.password,
      email_confirm: true,
    });
  if (authError) {
    console.error("[users] Create user auth error:", authError);
    return c.json({ error: "Failed to create user auth" }, 500);
  }

  const { error: profileError } = await adminSupabase
    .from("profiles")
    .update({
      username: parsed.data.username,
      user_type: parsed.data.type === "admin" ? "admin" : "user",
    })
    .eq("id", authData.user.id);

  if (profileError) {
    console.error("[users] Create user profile error:", profileError);
    return c.json({ error: "Failed to create user profile" }, 500);
  }

  return c.json({ success: true, id: authData.user.id }, 200);
});

usersRouter.openapi(deleteUserRoute, async (c) => {
  const user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { id: userId } = c.req.valid("param");

  // Self-deletion is allowed; managing other users is strictly admin-only
  if (user.id !== userId && !requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  const { error } = await adminSupabase.auth.admin.deleteUser(userId);
  if (error) {
    console.error("[users] Delete user error:", error);
    return c.json({ error: "Failed to delete user" }, 500);
  }
  return c.json({ success: true }, 200);
});

usersRouter.openapi(updateUserRoute, async (c) => {
  const user = c.get("user")!;
  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { id: userId } = c.req.valid("param");

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = UserUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten().fieldErrors }, 400);
  }

  // Role changes are strictly admin-only and can never be applied to yourself
  // (prevents self-elevation). Any management of other users also requires admin.
  if (parsed.data.type) {
    if (user.id === userId || !requireAdminRole(user)) {
      return c.json({ error: "Forbidden: Admin access required" }, 403);
    }
  } else if (user.id !== userId && !requireAdminRole(user)) {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }

  if (parsed.data.password) {
    const { error: authError } = await adminSupabase.auth.admin.updateUserById(
      userId,
      { password: parsed.data.password },
    );
    if (authError) {
      console.error("[users] Update user auth error:", authError);
      return c.json({ error: "Failed to update user auth" }, 500);
    }
  }

  if (parsed.data.type || parsed.data.username) {
    const updates: any = {};
    if (parsed.data.type) {
      updates.user_type = parsed.data.type === "admin" ? "admin" : "user";
    }
    if (parsed.data.username) updates.username = parsed.data.username;
    const { error: profileError } = await adminSupabase.from("profiles").update(
      updates,
    ).eq("id", userId);
    if (profileError) {
      console.error("[users] Update user profile error:", profileError);
      return c.json({ error: "Failed to update user profile" }, 500);
    }
  }

  return c.json({ success: true }, 200);
});

usersRouter.openapi(getPreferencesRoute, async (c) => {
  const user = c.get("user")!;
  if (!user || !user.id) return c.json({ error: "Unauthorized" }, 401);

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: authUser, error } = await adminSupabase.auth.admin.getUserById(
    user.id,
  );
  if (error) {
    console.error("[users] Get preferences error:", error);
    return c.json({ error: "Failed to get user preferences" }, 500);
  }
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
  return c.json({ preferences }, 200);
});

usersRouter.openapi(updatePreferencesRoute, async (c) => {
  const user = c.get("user")!;
  if (!user || !user.id) return c.json({ error: "Unauthorized" }, 401);

  const supabaseUrl = c.get("supabaseUrl");
  const serviceRoleKey = c.get("serviceRoleKey");
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  let body;
  try {
    body = await c.req.json();
  } catch (_e) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { data: authUser, error: getError } = await adminSupabase.auth.admin
    .getUserById(user.id);
  if (getError) {
    console.error("[users] Get user metadata error:", getError);
    return c.json({ error: "Failed to get user metadata" }, 500);
  }
  const currentPreferences = authUser.user.user_metadata?.preferences || {};

  const newPreferences = { ...currentPreferences, ...body };
  const newMetadata = {
    ...authUser.user.user_metadata,
    preferences: newPreferences,
  };

  const { error } = await adminSupabase.auth.admin.updateUserById(user.id, {
    user_metadata: newMetadata,
  });
  if (error) {
    console.error("[users] Update user metadata error:", error);
    return c.json({ error: "Failed to update user metadata" }, 500);
  }

  return c.json({ preferences: newPreferences }, 200);
});
