/**
 * 2FA brute-force guard.
 *
 * TOTP codes (6 digits) and especially PIN codes (4-8 digits) are
 * brute-forceable when unlimited verification attempts are allowed. This
 * guard enforces a per-user attempt budget backed by the profiles table:
 *
 *  - After MAX_FAILED_ATTEMPTS consecutive failures, the account's 2FA
 *    verification is locked for LOCKOUT_MINUTES.
 *  - Any successful verification resets the counter.
 *  - The guard applies to TOTP, PIN, passkey, and 2FA-disable attempts.
 */

export const MAX_2FA_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface TwoFactorGuardState {
  locked: boolean;
  remainingSeconds: number;
  failedAttempts: number;
  attemptsRemaining: number;
}

/**
 * Evaluates the guard state for a profile.
 */
export function evaluate2FALockout(profile: {
  two_factor_failed_attempts?: number | null;
  two_factor_locked_until?: string | null;
}): TwoFactorGuardState {
  const failedAttempts = profile.two_factor_failed_attempts || 0;

  const lockedUntil = profile.two_factor_locked_until
    ? new Date(profile.two_factor_locked_until).getTime()
    : 0;

  if (lockedUntil > Date.now()) {
    return {
      locked: true,
      remainingSeconds: Math.max(
        1,
        Math.ceil((lockedUntil - Date.now()) / 1000),
      ),
      failedAttempts,
      attemptsRemaining: 0,
    };
  }

  // The lock has expired: give the user a fresh attempt budget instead of
  // leaving them at 0 (a single mistake would instantly re-arm the lock).
  const effectiveAttempts = failedAttempts >= MAX_2FA_FAILED_ATTEMPTS
    ? 0
    : failedAttempts;

  return {
    locked: false,
    remainingSeconds: 0,
    failedAttempts,
    attemptsRemaining: Math.max(0, MAX_2FA_FAILED_ATTEMPTS - effectiveAttempts),
  };
}

export function lockoutError(state: TwoFactorGuardState) {
  const minutes = Math.max(1, Math.ceil(state.remainingSeconds / 60));
  return {
    error:
      `Too many failed verification attempts. Two-factor authentication is locked for ${minutes} more minute${
        minutes === 1 ? "" : "s"
      }.`,
    code: "2FA_LOCKED",
    locked: true,
    lockoutSeconds: state.remainingSeconds,
  };
}

/**
 * Records a failed 2FA attempt. Returns the updated guard state.
 * When the attempt budget is exhausted, the lock is armed.
 */
export async function register2FAFailure(
  adminSupabase: any,
  userId: string,
): Promise<TwoFactorGuardState> {
  const { data: profile } = await adminSupabase.from("profiles").select(
    "two_factor_failed_attempts, two_factor_locked_until",
  ).eq("id", userId).maybeSingle();

  const lockedUntil = profile?.two_factor_locked_until
    ? new Date(profile.two_factor_locked_until as string).getTime()
    : 0;

  // If a previous lock has already expired, treat this as a fresh budget so
  // the user is never permanently one-mistake-away from a new 15-minute lock.
  const baseAttempts = lockedUntil > 0 && lockedUntil <= Date.now()
    ? 0
    : (profile?.two_factor_failed_attempts as number || 0);

  const failedAttempts = baseAttempts + 1;
  const shouldLock = failedAttempts >= MAX_2FA_FAILED_ATTEMPTS;

  const update: Record<string, unknown> = {
    two_factor_failed_attempts: failedAttempts,
  };
  if (shouldLock) {
    update.two_factor_locked_until = new Date(
      Date.now() + LOCKOUT_MINUTES * 60 * 1000,
    ).toISOString();
  }

  await adminSupabase.from("profiles").update(update).eq("id", userId);

  return evaluate2FALockout({
    two_factor_failed_attempts: failedAttempts,
    two_factor_locked_until: shouldLock
      ? update.two_factor_locked_until as string
      : null,
  });
}

/**
 * Resets the guard (attempt counter + lock) after a successful verification
 * and clears the consumed single-use challenge nonce.
 */
export async function reset2FAGuard(
  adminSupabase: any,
  userId: string,
  nonce: string | null = null,
): Promise<void> {
  await adminSupabase.from("profiles").update({
    two_factor_failed_attempts: 0,
    two_factor_locked_until: null,
    two_factor_challenge_nonce: nonce,
  }).eq("id", userId);
}
