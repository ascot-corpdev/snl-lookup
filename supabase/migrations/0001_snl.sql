-- SNL lookup: logins, saved S&P results, the S&P request counter and background Claude answers.
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Every signed-in login with a profile can read. Only the Edge Functions write S&P data (with the service role).
-- Corp Dev logins can also edit shared settings (the statutory field mapping). Anonymous visitors get nothing.
-- Logins and roles are managed with scripts/logins.mjs (secret key), never from the browser.
-- The rows hold S&P Global data: keep it inside this project.

-- ---------- logins ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9._-]{2,40}$'),
  display_name text not null,
  role         text not null check (role in ('corpdev', 'reader')),
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.app_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;
revoke all on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated, service_role;

drop policy if exists "profiles: signed-in read" on public.profiles;
create policy "profiles: signed-in read" on public.profiles
  for select to authenticated using (public.app_role() is not null);
-- No insert/update/delete policies: only the service role (logins script) changes profiles.

-- ---------- saved S&P results ----------
-- One row per saved thing. kind says what it is:
--   reference  an S&P reference list, id "ref:<field>" (types of insurance, states, statuses, filing types)
--   search     a filing search and its rows, id "search:<hash of the search>"
--   entity     a company S&P has returned before, id "entity:<companyId>", so names and NAIC codes can be looked up
--   discover   the Snowflake views and columns this account can see, id "discover:<name>"
--   statutory  a statutory query result, id "statutory:<hash>"
-- label is the text the app searches on (company name and NAIC code for an entity).
create table if not exists public.snl_store (
  id         text primary key check (id ~ '^(ref|search|entity|discover|statutory):[A-Za-z0-9_.:-]{1,80}$'),
  kind       text not null check (kind in ('reference', 'search', 'entity', 'discover', 'statutory')),
  label      text not null default '' check (length(label) <= 400),
  doc        jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) < 4194304),
  fetched_at timestamptz not null default now()
);
create index if not exists snl_store_kind on public.snl_store (kind, fetched_at desc);
alter table public.snl_store enable row level security;

drop policy if exists "read: any login" on public.snl_store;
create policy "read: any login" on public.snl_store
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: logins can't write here; the functions use the service role.

-- ---------- S&P request counter and throttle ----------
-- S&P allows 1 request a second and a fixed number an hour and a day. Every call a function makes to S&P first
-- takes a slot here, so the limit holds across function calls running at the same time.
create table if not exists public.snl_usage (
  bucket    text not null check (bucket in ('hour', 'day')),
  starts_at timestamptz not null,
  requests  integer not null default 0 check (requests >= 0),
  primary key (bucket, starts_at)
);
alter table public.snl_usage enable row level security;

drop policy if exists "read: any login" on public.snl_usage;
create policy "read: any login" on public.snl_usage
  for select to authenticated using (public.app_role() is not null);

create table if not exists public.snl_throttle (
  id      boolean primary key default true check (id),
  next_at timestamptz not null default now()
);
insert into public.snl_throttle (id) values (true) on conflict (id) do nothing;
alter table public.snl_throttle enable row level security;
-- No policies: only the function below touches it.

-- Takes the next free one-second slot and counts the request. Returns allowed = false (and counts nothing) when
-- the hourly or daily limit is used up; otherwise wait_ms is how long the caller must wait before sending.
-- Days are UTC days.
create or replace function public.snl_take_slot(p_hour_limit integer, p_day_limit integer, p_gap_ms integer default 1000)
returns table (allowed boolean, wait_ms integer, hour_count integer, day_count integer)
language plpgsql security definer
set search_path = public
as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_hour timestamptz;
  v_day  timestamptz;
  v_slot timestamptz;
  v_h    integer;
  v_d    integer;
begin
  -- One caller at a time: the row lock is held until this transaction ends.
  perform 1 from public.snl_throttle where id for update;
  v_now  := clock_timestamp();
  v_hour := date_trunc('hour', v_now, 'UTC');
  v_day  := date_trunc('day', v_now, 'UTC');
  select coalesce((select u.requests from public.snl_usage u where u.bucket = 'hour' and u.starts_at = v_hour), 0) into v_h;
  select coalesce((select u.requests from public.snl_usage u where u.bucket = 'day' and u.starts_at = v_day), 0) into v_d;
  if v_h >= p_hour_limit or v_d >= p_day_limit then
    return query select false, 0, v_h, v_d;
    return;
  end if;
  select greatest(t.next_at, v_now) into v_slot from public.snl_throttle t where t.id;
  update public.snl_throttle set next_at = v_slot + make_interval(secs => greatest(p_gap_ms, 0) / 1000.0) where id;
  insert into public.snl_usage (bucket, starts_at, requests) values ('hour', v_hour, 1)
    on conflict (bucket, starts_at) do update set requests = public.snl_usage.requests + 1;
  insert into public.snl_usage (bucket, starts_at, requests) values ('day', v_day, 1)
    on conflict (bucket, starts_at) do update set requests = public.snl_usage.requests + 1;
  return query select true, greatest(0, ceil(extract(epoch from (v_slot - v_now)) * 1000))::integer, v_h + 1, v_d + 1;
end $$;
revoke all on function public.snl_take_slot(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.snl_take_slot(integer, integer, integer) to service_role;

-- ---------- background Claude answers ----------
-- One row per question. The snl-chat function writes progress and the result here; the page polls its own rows.
create table if not exists public.snl_jobs (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'queued' check (status in ('queued', 'running', 'paused', 'done', 'error')),
  question     text not null check (length(question) between 1 and 4000),
  progress     jsonb not null default '[]'::jsonb check (jsonb_typeof(progress) = 'array'),
  partial      text not null default '',
  result       jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) < 4194304)),
  error        text,
  segments     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);
create index if not exists snl_jobs_owner on public.snl_jobs (owner, created_at desc);
alter table public.snl_jobs enable row level security;

drop policy if exists "read: own answers" on public.snl_jobs;
create policy "read: own answers" on public.snl_jobs
  for select to authenticated using (owner = auth.uid() and public.app_role() is not null);
-- No insert, update or delete policies: the snl-chat function writes with the service role.

-- Where an unfinished answer has got to, so the next function call can carry on. Never readable by logins.
create table if not exists public.snl_job_state (
  job_id     uuid primary key references public.snl_jobs (id) on delete cascade,
  state      jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.snl_job_state enable row level security;
-- No policies: service role only.

-- ---------- shared settings ----------
-- One JSON document per key. Today: "statutory_mapping", which says which Snowflake view and columns hold each
-- statutory field. Every login reads; only Corp Dev logins write.
create table if not exists public.snl_settings (
  id         text primary key check (id ~ '^[a-z0-9_]{1,64}$'),
  doc        jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) < 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.snl_settings enable row level security;

drop policy if exists "read: any login" on public.snl_settings;
create policy "read: any login" on public.snl_settings
  for select to authenticated using (public.app_role() is not null);
drop policy if exists "insert: corp dev" on public.snl_settings;
create policy "insert: corp dev" on public.snl_settings
  for insert to authenticated with check (public.app_role() = 'corpdev');
drop policy if exists "update: corp dev" on public.snl_settings;
create policy "update: corp dev" on public.snl_settings
  for update to authenticated using (public.app_role() = 'corpdev') with check (public.app_role() = 'corpdev');
-- No delete policy: settings are edited, not removed.

create or replace function public.stamp_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
-- Only ever runs as a trigger, which needs no grant.
revoke all on function public.stamp_update() from public, anon, authenticated;

drop trigger if exists stamp_snl_settings on public.snl_settings;
create trigger stamp_snl_settings before insert or update on public.snl_settings for each row execute function public.stamp_update();

-- ---------- grants ----------
-- Anonymous visitors get nothing. Logins get exactly what the policies above cover.
revoke all on public.profiles, public.snl_store, public.snl_usage, public.snl_throttle, public.snl_jobs,
  public.snl_job_state, public.snl_settings from anon, authenticated;
grant select on public.profiles, public.snl_store, public.snl_usage, public.snl_jobs to authenticated;
grant select, insert, update on public.snl_settings to authenticated;
grant select, insert, update, delete on public.profiles, public.snl_store, public.snl_usage, public.snl_throttle,
  public.snl_jobs, public.snl_job_state, public.snl_settings to service_role;
