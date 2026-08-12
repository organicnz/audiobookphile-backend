/**
 * GoTrue session minting for post-2FA sign-in.
 *
 * After a second factor has been verified, a GoTrue session is minted via a
 * magic-link OTP through the admin API and consumed with its pre-hashed
 * token: admin generateLink returns `hashed_token` = SHA-224(email + otp),
 * i.e. the exact hash stored on auth.users.recovery_token. It must be passed
 * as `token_hash` — passing it as `token` makes GoTrue re-hash it
 * (email + token) and reject the verify with "Token has expired or is
 * invalid".
 */

import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { buildUserPayload } from "./payloads.ts";

export async function mintSessionFor2FAUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
) {
  const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData } = await adminSupabase.auth.admin.getUserById(
    userId,
  );
  const userEmail = userData?.user?.email;

  if (!userEmail) {
    throw new Error("User email not found");
  }

  const { data: linkData, error: linkError } = await adminSupabase.auth.admin
    .generateLink({
      type: "magiclink",
      email: userEmail,
    });

  if (linkError || !linkData?.properties?.hashed_token) {
    console.error("[2fa] Failed to generate login session link:", linkError);
    throw new Error("Failed to establish user session");
  }

  const { data: verifyData, error: verifyError } = await adminSupabase.auth
    .verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });

  if (verifyError || !verifyData.session || !verifyData.user) {
    console.error("[2fa] Failed to verify login OTP:", verifyError);
    throw new Error("Failed to establish user session");
  }

  const { data: profile } = await adminSupabase.from("profiles").select("*")
    .eq("id", verifyData.user.id).maybeSingle();

  return buildUserPayload(
    profile,
    verifyData.session,
    {
      id: verifyData.user.id,
      email: verifyData.user.email,
      created_at: verifyData.user.created_at,
    },
  );
}
