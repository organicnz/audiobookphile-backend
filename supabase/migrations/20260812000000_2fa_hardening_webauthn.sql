-- Migration: 2FA hardening + WebAuthn passkey support
-- 1. Real passkey (WebAuthn) credential storage
-- 2. Brute-force lockout columns for TOTP/PIN verification
-- 3. Single-use login challenge nonce

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}'::text[],
  device_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
  ON public.webauthn_credentials(user_id);

-- Single-use challenges for WebAuthn register/login flows
CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register',
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user
  ON public.webauthn_challenges(user_id, purpose, used);

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS two_factor_failed_attempts INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS two_factor_locked_until TIMESTAMPTZ DEFAULT NULL,
ADD COLUMN IF NOT EXISTS two_factor_challenge_nonce TEXT DEFAULT NULL;

-- Grant: passkey rows are read/written via the Edge Function (service role),
-- but users may read their own credentials for status display.
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own passkeys"
  ON public.webauthn_credentials
  FOR SELECT
  USING (auth.uid() = user_id);

-- WebAuthn challenges are managed server-side only; no direct client access.
CREATE POLICY "No client access to webauthn challenges"
  ON public.webauthn_challenges
  FOR ALL
  USING (FALSE);
