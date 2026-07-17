-- Migration: Fix SECURITY DEFINER warnings on helper functions
--
-- set_updated_at is a trigger function — it runs as the table owner,
-- not as the calling user, so SECURITY INVOKER is correct here.
-- It doesn't need elevated privileges; it just sets updated_at = now().
--
-- is_admin is only ever evaluated inside RLS policy USING clauses.
-- The function must be SECURITY DEFINER to query profiles without
-- recursion, but we revoke the public execute grants to prevent
-- direct /rpc/is_admin calls.

-- ── 1. set_updated_at: switch to SECURITY INVOKER ────────────────────────────
-- Trigger functions run in the security context of the table owner by default;
-- SECURITY INVOKER is the correct, minimal-privilege setting.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── 2. is_admin: revoke all public execute grants ─────────────────────────────
-- Must revoke both the PUBLIC grant and the individual role grants.
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM authenticated;
-- Re-grant only to service_role (used by edge functions) and postgres.
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO postgres;
