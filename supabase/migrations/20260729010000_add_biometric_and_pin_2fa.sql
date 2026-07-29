-- Migration: Add Biometric (Facial 2FA) and PIN Code 2FA columns to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS pin_code_hash TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS biometric_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS biometric_device_id TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS two_factor_methods TEXT[] DEFAULT '{}'::text[];

-- Index for biometric enabled checks
CREATE INDEX IF NOT EXISTS idx_profiles_biometric_enrolled ON public.profiles(biometric_enrolled) WHERE biometric_enrolled = TRUE;
