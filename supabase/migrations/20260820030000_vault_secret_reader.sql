-- Secure Vault secret reader for Edge Functions.
--
-- Supabase Vault stores secrets encrypted at rest (vault.secrets); the
-- decrypted view (vault.decrypted_secrets) is NOT exposed to PostgREST on this
-- project ([api] schemas = public, graphql_public), so Edge Functions cannot
-- query it directly. This security-definer function runs with the owner's
-- privileges to read the decrypted value and is gated so only the service_role
-- (or postgres) may execute it. Edge Functions call it via
-- supabase.rpc('read_secret', { p_name }) using the service-role key injected
-- by the Edge Runtime.
create or replace function public.read_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_secret text;
begin
  -- Defense in depth: the GRANTs below already restrict callers to
  -- service_role, but verify the caller role so a future grant mistake cannot
  -- widen access.
  if coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role'
     and current_user <> 'postgres' then
    raise exception 'read_secret: access denied';
  end if;

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = p_name
   limit 1;

  return v_secret;
end;
$$;

revoke all on function public.read_secret(text) from public;
revoke all on function public.read_secret(text) from anon;
revoke all on function public.read_secret(text) from authenticated;
grant execute on function public.read_secret(text) to service_role;