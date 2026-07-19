create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Create a helper function to trigger the avatar sync edge function
-- This allows us to handle dynamic environments (local vs prod) gracefully.
create or replace function public.sync_author_avatars()
returns void
language plpgsql
security definer
as $$
declare
  edge_url text;
  auth_header text;
  request_id bigint;
begin
  -- Try to get custom URL setting, fallback to production URL
  begin
    edge_url := current_setting('app.settings.edge_api_url', true) || '/sync-authors';
  exception when others then
    edge_url := 'https://iambzzclljayqdxkeepy.supabase.co/functions/v1/sync-authors';
  end;
  
  if edge_url is null or edge_url = '/sync-authors' then
     edge_url := 'https://iambzzclljayqdxkeepy.supabase.co/functions/v1/sync-authors';
  end if;

  -- Try to get cron secret, fallback to anon key or empty
  begin
    auth_header := 'Bearer ' || current_setting('app.settings.cron_secret', true);
  exception when others then
    auth_header := null;
  end;

  -- If no explicit cron_secret is set, try to use service role key for cron
  if auth_header is null or auth_header = 'Bearer ' then
     -- This is purely a fallback, in production a secret should be set in vault or settings
     auth_header := 'Bearer fallback_secret'; 
  end if;

  select net.http_post(
    url := edge_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', auth_header
    ),
    timeout_milliseconds := 30000
  ) into request_id;
end;
$$;

-- Schedule the cron job to run every 15 minutes
select cron.schedule(
  'sync-author-avatars-job', 
  '*/15 * * * *', 
  $$ select public.sync_author_avatars(); $$
);
