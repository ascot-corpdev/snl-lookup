-- SNL lookup: the watchlist. What each daily check found, and the record of checks.
-- Run once in the Supabase SQL editor (or `supabase db push`), after 0001. Safe to run again.
--
-- What is watched is the "watchlist" document in public.snl_settings (migration 0001): Corp Dev logins edit it on
-- the Filings view. The snl-watch function writes the two tables below with the service role. Every signed-in login
-- with a profile can read them. Anonymous visitors get nothing. Rows are cleared after 90 days by the function.
-- The rows hold S&P Global data: keep it inside this project.

-- ---------- the record of checks ----------
-- One row per check. status: running, ok, failed (with the reason in message) or skipped (not set up, nothing
-- watched, switched off). scope is what a complete check covered, so the next one can tell new filings from
-- filings of companies or states that were only just added.
create table if not exists public.snl_watch_runs (
  id          uuid primary key default gen_random_uuid(),
  status      text not null default 'running' check (status in ('running', 'ok', 'failed', 'skipped')),
  trigger     text not null check (trigger in ('schedule', 'manual')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  requests    integer not null default 0 check (requests >= 0),
  found       integer not null default 0 check (found >= 0),
  new_count   integer not null default 0 check (new_count >= 0),
  baseline    boolean not null default false,
  complete    boolean not null default true,
  emailed     integer not null default 0 check (emailed >= 0),
  message     text check (message is null or length(message) <= 1000),
  scope       jsonb check (scope is null or (jsonb_typeof(scope) = 'object' and pg_column_size(scope) < 262144))
);
create index if not exists snl_watch_runs_started on public.snl_watch_runs (started_at desc);
-- Only one check runs at a time: a second insert of a running row fails.
create unique index if not exists snl_watch_runs_one_running on public.snl_watch_runs ((status)) where status = 'running';
alter table public.snl_watch_runs enable row level security;

drop policy if exists "read: any login" on public.snl_watch_runs;
create policy "read: any login" on public.snl_watch_runs
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: the snl-watch function writes with the service role.

-- ---------- the filings found ----------
-- One row per filing version a check has seen. baseline: part of the starting point (the first check, or a
-- company, state or filter just added), not shown as new. The description is shortened.
create table if not exists public.snl_watch_found (
  filing_version_id     text primary key check (filing_version_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  run_id                uuid references public.snl_watch_runs (id) on delete set null,
  first_seen_at         timestamptz not null default now(),
  baseline              boolean not null default false,
  companies             jsonb not null default '[]'::jsonb check (jsonb_typeof(companies) = 'array' and pg_column_size(companies) < 8192),
  state                 text check (state is null or state ~ '^[A-Z]{2}$'),
  state_name            text check (state_name is null or length(state_name) <= 60),
  filing_type           text check (filing_type is null or length(filing_type) <= 80),
  type_of_insurance     text check (type_of_insurance is null or length(type_of_insurance) <= 120),
  sub_type_of_insurance text check (sub_type_of_insurance is null or length(sub_type_of_insurance) <= 120),
  filing_status         text check (filing_status is null or length(filing_status) <= 80),
  date_submitted        text check (date_submitted is null or length(date_submitted) <= 30),
  publish_date          text check (publish_date is null or length(publish_date) <= 30),
  effective_new         text check (effective_new is null or length(effective_new) <= 30),
  effective_renewal     text check (effective_renewal is null or length(effective_renewal) <= 30),
  rate_impact           text check (rate_impact is null or length(rate_impact) <= 40),
  description           text check (description is null or length(description) <= 300),
  tracking_number       text check (tracking_number is null or length(tracking_number) <= 60),
  document_id           bigint check (document_id is null or document_id > 0)
);
create index if not exists snl_watch_found_new on public.snl_watch_found (baseline, first_seen_at desc);
create index if not exists snl_watch_found_seen on public.snl_watch_found (first_seen_at);
alter table public.snl_watch_found enable row level security;

drop policy if exists "read: any login" on public.snl_watch_found;
create policy "read: any login" on public.snl_watch_found
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: the snl-watch function writes with the service role.

-- ---------- grants ----------
-- Anonymous visitors get nothing. Logins may only read.
revoke all on public.snl_watch_runs, public.snl_watch_found from anon, authenticated;
grant select on public.snl_watch_runs, public.snl_watch_found to authenticated;
grant select, insert, update, delete on public.snl_watch_runs, public.snl_watch_found to service_role;
