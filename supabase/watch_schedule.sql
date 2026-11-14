-- Daily watchlist check (Supabase Cron). Run in the Supabase SQL editor AFTER running migration 0003, setting
-- WATCH_SECRET and deploying the snl-watch function (see README, "Watchlist (optional)").
-- Replace the two placeholders first: YOUR_PROJECT_REF (from the project URL) and YOUR_WATCH_SECRET (the same value
-- you set as WATCH_SECRET). Never commit the file with your real values in it.
-- Needs the pg_cron and pg_net extensions (Database > Extensions, or the two lines below).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The function address and the shared secret live in Supabase Vault, not in the job text.
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/snl-watch', 'snl_watch_url');
select vault.create_secret('YOUR_WATCH_SECRET', 'snl_watch_secret');

-- Every day at 06:23 UTC. Change the five fields to move it. Each check uses a few S&P requests (see the README).
-- The timeout is longer than a check can take (the function stops asking S&P after 100 seconds).
select cron.schedule('snl-watchlist-daily', '23 6 * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'snl_watch_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-watch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'snl_watch_secret')),
    body    := '{"action": "run"}'::jsonb,
    timeout_milliseconds := 150000
  );
$$);

-- Check it ran:        select * from cron.job_run_details order by start_time desc limit 5;
-- See what it said:    select status_code, content from net._http_response order by created desc limit 5;
-- Stop the checks:     select cron.unschedule('snl-watchlist-daily');
-- Change the secret:   select vault.update_secret((select id from vault.secrets where name = 'snl_watch_secret'), 'NEW_VALUE');
