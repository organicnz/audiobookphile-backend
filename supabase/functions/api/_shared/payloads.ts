/**
 * Shared User Payload Builder
 *
 * Single source of truth for the user payload shape returned by all auth endpoints:
 * login, refresh, authorize, verify-otp, and 2FA verify-login.
 */

interface PayloadProfile {
  username?: string | null;
  user_type?: string | null;
  default_library_id?: string | null;
  created_at?: string | null;
}

interface PayloadSession {
  access_token: string;
  refresh_token?: string | null;
}

interface PayloadUser {
  id: string;
  email?: string | null;
  created_at?: string;
}

/**
 * Builds the standardized user payload returned to clients after authentication.
 *
 * @param profile - User profile from the `profiles` table
 * @param session - GoTrue session containing access and refresh tokens
 * @param user - GoTrue user object
 */
export function buildUserPayload(
  profile: PayloadProfile | null,
  session: PayloadSession,
  user: PayloadUser,
) {
  const isAdmin = profile?.user_type === "admin" ||
    profile?.user_type === "root";
  return {
    user: {
      id: user.id,
      username: profile?.username || user.email?.split("@")[0] || "User",
      email: user.email,
      type: profile?.user_type || "user",
      token: session.access_token,
      refreshToken: session.refresh_token || null,
      mediaProgress: [],
      seriesHideFromContinueListening: [],
      bookmarks: [],
      isActive: true,
      isLocked: false,
      lastSeen: Date.now(),
      createdAt: new Date(profile?.created_at || user.created_at || Date.now())
        .getTime(),
      permissions: {
        download: true,
        update: isAdmin,
        delete: isAdmin,
        upload: isAdmin,
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
}
