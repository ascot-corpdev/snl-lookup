-- Market index schedule (Supabase Cron). Optional: without it, a sweep runs only while Corp Dev has the index manager
-- open. Run in the Supabase SQL editor AFTER running migration 0006, setting INDEX_SECRET and deploying the snl-index
-- function (see README, "Market index").
-- Replace the two placeholders first: YOUR_PROJECT_REF (from the project URL) and YOUR_INDEX_SECRET (the same value
-- you set as INDEX_SECRET; a different value from WATCH_SECRET). Never commit the file with your real values in it.
-- Needs the pg_cron and pg_net extensions (Database > Extensions, or the two lines below).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The function address and the shared secret live in Supabase Vault, not in the job text.
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/snl-index', 'snl_index_url');
select vault.create_secret('YOUR_INDEX_SECRET', 'snl_index_secret');

-- Every 10 minutes. Each call does one of three things: carries on an unfinished sweep for up to 100 seconds (about
-- 90 S&P requests, and never into the last 150 of the hour or the last 3,000 of the day); or, with no sweep
-- unfinished, starts a top-up of the indexed state whose last complete sweep is more than INDEX_TOPUP_DAYS days old
-- (default 7); or nothing, at no S&P cost. A top-up costs about as much as a sweep of a year (about 300 requests for
-- 2,700 companies), so weekly or monthly is enough: set INDEX_TOPUP_DAYS=30 for monthly, 0 to stop top-ups.
select cron.schedule('snl-index-steps', '*/10 * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'snl_index_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-index-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'snl_index_secret')),
    body    := '{"action": "scheduled"}'::jsonb,
    timeout_milliseconds := 150000
  );
$$);

-- Check it ran:        select * from cron.job_run_details order by start_time desc limit 5;
-- See what it said:    select status_code, content from net._http_response order by created desc limit 5;
-- Stop the schedule:   select cron.unschedule('snl-index-steps');
-- Change the secret:   select vault.update_secret((select id from vault.secrets where name = 'snl_index_secret'), 'NEW_VALUE');
