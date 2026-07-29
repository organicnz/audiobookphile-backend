-- Migration: Add Backend-Authoritative TOTP 2FA columns to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS is_2fa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS totp_secret TEXT DEFAULT NULL;

-- Index for quick lookup during login verification
CREATE INDEX IF NOT EXISTS idx_profiles_2fa_enabled ON public.profiles(is_2fa_enabled) WHERE is_2fa_enabled = TRUE;
