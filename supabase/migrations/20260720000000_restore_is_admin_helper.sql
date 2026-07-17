-- Migration: Restore is_admin() and set_updated_at() helper functions
--
-- is_admin() was declared in the init migration SQL but was never applied to
-- the production Supabase project (absent from pg_proc). Admin write RLS
-- policies currently use inline EXISTS subqueries; this function provides a
-- cleaner reusable alternative and is available for edge functions.
--
-- set_updated_at() is included defensively — it should already exist on all
-- tables via triggers, but is re-declared idempotently here.

-- ── is_admin() ───────────────────────────────────────────────────────────────
-- Returns true when the calling user's profiles.user_type is 'admin' or 'root'.
-- SECURITY DEFINER + empty search_path prevents RLS recursion on `profiles`.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND user_type IN ('admin', 'root')
  );
$$;

-- ── set_updated_at() ─────────────────────────────────────────────────────────
-- Reusable trigger function that sets updated_at = now() on every UPDATE.
-- Attach with: CREATE TRIGGER set_updated_at BEFORE UPDATE ON <table>
--              FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
