-- Create an hourly cron job to sync missing covers
SELECT cron.schedule(
    'invoke-sync-covers-hourly',
    '0 * * * *',
    $$
    SELECT net.http_post(
        url:='https://iambzzclljayqdxkeepy.supabase.co/functions/v1/sync-covers',
        headers:=jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.cron_secret', true)
        ),
        body:='{}'::jsonb
    ) as request_id;
    $$
);

-- Create an hourly cron job to sync missing authors
SELECT cron.schedule(
    'invoke-sync-authors-hourly',
    '30 * * * *',
    $$
    SELECT net.http_post(
        url:='https://iambzzclljayqdxkeepy.supabase.co/functions/v1/sync-authors',
        headers:=jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.cron_secret', true)
        ),
        body:='{}'::jsonb
    ) as request_id;
    $$
);
