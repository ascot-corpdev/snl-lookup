-- SNL lookup: the market index. Filing details for chosen states, swept from S&P for every company in the app's
-- company list, so a market question ("who filed homeowners forms in Florida this year") can be answered over every
-- company in the list instead of the ten or fifteen carriers someone thought of.
-- Run once in the Supabase SQL editor (or `supabase db push`), after 0001. Safe to run again.
--
-- The snl-index function writes these tables with the service role, in steps (see _shared/marketindex.ts). Every
-- signed-in login with a profile can read them. Anonymous visitors get nothing.
-- The rows hold S&P Global data: keep it inside this project.
--
-- Size: a filing row takes about 0.7 KB with its indexes (measured on made-up rows shaped like real ones: no
-- description, one or two companies). See the README, "Market index", for what one, five and fifty states cost.

-- ---------- the filings ----------
-- One row per filing version per state, counted once, with every company S&P named on it. filing_key is "v:" and
-- S&P's filingVersionId, or "e:" and serffFilingEntityEventId when a row has no version id. companies is a list of
-- {n: name, c: companyId, i: institutionId}; company_names is the same names joined, for searching by words.
-- rate_impact is S&P's overallRateImpact in percentage points (-11 means an 11% decrease).
create table if not exists public.snl_index_filings (
  state                 text not null check (state ~ '^[A-Z]{2}$'),
  filing_key            text not null check (filing_key ~ '^[ve]:[A-Za-z0-9._-]{1,64}$'),
  filing_version_id     text check (filing_version_id is null or filing_version_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  document_id           bigint check (document_id is null or document_id > 0),
  companies             jsonb not null default '[]'::jsonb check (jsonb_typeof(companies) = 'array' and pg_column_size(companies) < 8192),
  company_names         text not null default '' check (length(company_names) <= 2000),
  type_of_insurance_id  integer,
  type_of_insurance     text check (type_of_insurance is null or length(type_of_insurance) <= 120),
  sub_type_of_insurance text check (sub_type_of_insurance is null or length(sub_type_of_insurance) <= 120),
  filing_type_id        integer,
  filing_type           text check (filing_type is null or length(filing_type) <= 80),
  filing_status_id      integer,
  filing_status         text check (filing_status is null or length(filing_status) <= 80),
  date_submitted        date,
  publish_date          date,
  effective_new         date,
  effective_renewal     date,
  rate_impact           numeric(9, 3) check (rate_impact is null or rate_impact between -1000 and 1000),
  rate_impact_text      text check (rate_impact_text is null or length(rate_impact_text) <= 40),
  description           text check (description is null or length(description) <= 1000),
  tracking_number       text check (tracking_number is null or length(tracking_number) <= 60),
  sfc_number            text check (sfc_number is null or length(sfc_number) <= 60),
  pages                 integer check (pages is null or pages between 0 and 1000000),
  sweep_id              uuid,
  seen_at               timestamptz not null default now(),
  primary key (state, filing_key)
);
-- Every question names one state and a range of publish dates; the other filters are applied to that state's rows.
create index if not exists snl_index_filings_published on public.snl_index_filings (state, publish_date desc);
alter table public.snl_index_filings enable row level security;

drop policy if exists "read: any login" on public.snl_index_filings;
create policy "read: any login" on public.snl_index_filings
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: the snl-index function writes with the service role.

-- ---------- the record of sweeps, and where an unfinished one has got to ----------
-- One row per sweep (every company in the list, one state, a period) or top-up (the same, for filings published
-- since the last complete sweep). status: running (a step is working on it now), waiting (between steps, or
-- waiting until resume_after to leave room for people), held (paused by a person, or stopped by a problem a person
-- must fix), done, failed (with the reason in message) or stopped. request: a person asked the running step to
-- pause or stop. plan: the companies (in a fixed order), the date windows and S&P's filing statuses the sweep asks
-- for; next_unit: the next batch of 10 companies and window to ask for. missed: batches that failed twice and were
-- skipped, with the companies they hold.
create table if not exists public.snl_index_sweeps (
  id              uuid primary key default gen_random_uuid(),
  state           text not null check (state ~ '^[A-Z]{2}$'),
  kind            text not null check (kind in ('sweep', 'top_up')),
  period          text not null check (period in ('this_year', 'last_12_months', 'last_3_years', 'top_up')),
  from_date       date not null,
  to_date         date not null,
  status          text not null default 'waiting' check (status in ('running', 'waiting', 'held', 'done', 'failed', 'stopped')),
  request         text check (request is null or request in ('pause', 'stop')),
  trigger         text not null check (trigger in ('schedule', 'manual')),
  started_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  resume_after    timestamptz,
  companies_total integer not null default 0 check (companies_total >= 0),
  units_total     integer not null default 0 check (units_total >= 0),
  next_unit       integer not null default 0 check (next_unit >= 0),
  tries           integer not null default 0 check (tries >= 0),
  stalls          integer not null default 0 check (stalls >= 0),
  requests        integer not null default 0 check (requests >= 0),
  rows_found      integer not null default 0 check (rows_found >= 0),
  missed          jsonb not null default '[]'::jsonb check (jsonb_typeof(missed) = 'array' and pg_column_size(missed) < 1048576),
  message         text check (message is null or length(message) <= 1000),
  plan            jsonb check (plan is null or (jsonb_typeof(plan) = 'object' and pg_column_size(plan) < 2097152)),
  check (from_date <= to_date)
);
create index if not exists snl_index_sweeps_started on public.snl_index_sweeps (started_at desc);
-- Only one sweep is unfinished at a time: a second insert of an open sweep fails.
create unique index if not exists snl_index_sweeps_one_open on public.snl_index_sweeps ((true)) where status in ('running', 'waiting', 'held');
alter table public.snl_index_sweeps enable row level security;

drop policy if exists "read: any login" on public.snl_index_sweeps;
create policy "read: any login" on public.snl_index_sweeps
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: the snl-index function writes with the service role.

-- ---------- what the index covers, state by state ----------
-- Written when a sweep or top-up finishes. from_date to to_date is the period of publish dates covered; a question
-- outside it is refused. companies_missed and missed: companies whose batch failed in any sweep or top-up since.
create table if not exists public.snl_index_states (
  state             text primary key check (state ~ '^[A-Z]{2}$'),
  from_date         date not null,
  to_date           date not null,
  last_complete_at  timestamptz not null,
  last_sweep_id     uuid,
  companies_covered integer not null default 0 check (companies_covered >= 0),
  companies_missed  integer not null default 0 check (companies_missed >= 0),
  missed            jsonb not null default '[]'::jsonb check (jsonb_typeof(missed) = 'array' and pg_column_size(missed) < 262144),
  check (from_date <= to_date)
);
alter table public.snl_index_states enable row level security;

drop policy if exists "read: any login" on public.snl_index_states;
create policy "read: any login" on public.snl_index_states
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: the snl-index function writes with the service role.

-- ---------- writing filings ----------
-- Two lists of companies made into one: each company once, sorted, at most 30.
create or replace function public.snl_index_merge(a jsonb, b jsonb)
returns jsonb
language sql immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(d.e order by d.e->>'n' collate "C", d.e->>'c' collate "C", d.e->>'i' collate "C"), '[]'::jsonb)
  from (
    select u.e from (select distinct x.e from jsonb_array_elements(coalesce(a, '[]'::jsonb) || coalesce(b, '[]'::jsonb)) as x(e)) u
    order by u.e->>'n' collate "C", u.e->>'c' collate "C", u.e->>'i' collate "C"
    limit 30
  ) d
$$;

-- The company names of a list, each once, sorted, joined with "; ".
create or replace function public.snl_index_names(c jsonb)
returns text
language sql immutable
set search_path = public
as $$
  select left(coalesce(string_agg(n.name, '; ' order by n.name collate "C"), ''), 2000)
  from (select distinct x.e->>'n' as name from jsonb_array_elements(coalesce(c, '[]'::jsonb)) as x(e) where coalesce(x.e->>'n', '') <> '') n
$$;

-- Saves a batch of filings. A filing already in the index keeps every company it had and gains the new ones (the
-- same filing comes back once for each batch of companies named on it); its other columns take the new values.
-- p_rows must hold each (state, filing_key) once. Returns how many rows were written.
create or replace function public.snl_index_put(p_rows jsonb)
returns integer
language sql
set search_path = public
as $$
  with ins as (
    insert into public.snl_index_filings as f (
      state, filing_key, filing_version_id, document_id, companies, company_names, type_of_insurance_id, type_of_insurance,
      sub_type_of_insurance, filing_type_id, filing_type, filing_status_id, filing_status, date_submitted, publish_date,
      effective_new, effective_renewal, rate_impact, rate_impact_text, description, tracking_number, sfc_number, pages, sweep_id, seen_at)
    select r.state, r.filing_key, r.filing_version_id, r.document_id, public.snl_index_merge(r.companies, null),
      public.snl_index_names(public.snl_index_merge(r.companies, null)), r.type_of_insurance_id, r.type_of_insurance,
      r.sub_type_of_insurance, r.filing_type_id, r.filing_type, r.filing_status_id, r.filing_status, r.date_submitted, r.publish_date,
      r.effective_new, r.effective_renewal, r.rate_impact, r.rate_impact_text, r.description, r.tracking_number, r.sfc_number, r.pages,
      r.sweep_id, coalesce(r.seen_at, now())
    from jsonb_to_recordset(p_rows) as r(
      state text, filing_key text, filing_version_id text, document_id bigint, companies jsonb, type_of_insurance_id integer,
      type_of_insurance text, sub_type_of_insurance text, filing_type_id integer, filing_type text, filing_status_id integer,
      filing_status text, date_submitted date, publish_date date, effective_new date, effective_renewal date, rate_impact numeric,
      rate_impact_text text, description text, tracking_number text, sfc_number text, pages integer, sweep_id uuid, seen_at timestamptz)
    on conflict (state, filing_key) do update set
      companies = public.snl_index_merge(f.companies, excluded.companies),
      company_names = public.snl_index_names(public.snl_index_merge(f.companies, excluded.companies)),
      filing_version_id = excluded.filing_version_id, document_id = excluded.document_id,
      type_of_insurance_id = excluded.type_of_insurance_id, type_of_insurance = excluded.type_of_insurance,
      sub_type_of_insurance = excluded.sub_type_of_insurance, filing_type_id = excluded.filing_type_id, filing_type = excluded.filing_type,
      filing_status_id = excluded.filing_status_id, filing_status = excluded.filing_status, date_submitted = excluded.date_submitted,
      publish_date = excluded.publish_date, effective_new = excluded.effective_new, effective_renewal = excluded.effective_renewal,
      rate_impact = excluded.rate_impact, rate_impact_text = excluded.rate_impact_text, description = excluded.description,
      tracking_number = excluded.tracking_number, sfc_number = excluded.sfc_number, pages = excluded.pages,
      sweep_id = excluded.sweep_id, seen_at = excluded.seen_at
    returning 1
  )
  select count(*)::integer from ins
$$;

-- ---------- asking the index ----------
-- The filings of one state that match a question. p: {state, from, to, typeOfInsurance, filingType, status, words,
-- rateAbove, rateBelow}; every key but state may be missing or null. The three texts match anywhere in the field,
-- in any letter case (the type of insurance also matches the sub-type). Every word must appear in the description or
-- a company name. rateAbove and rateBelow leave out filings with no overall rate impact.
create or replace function public.snl_index_match(p jsonb)
returns setof public.snl_index_filings
language sql stable
as $$
  select f.* from public.snl_index_filings f
  where f.state = p->>'state'
    and (nullif(p->>'from', '') is null or f.publish_date >= (p->>'from')::date)
    and (nullif(p->>'to', '') is null or f.publish_date <= (p->>'to')::date)
    and (nullif(p->>'typeOfInsurance', '') is null
         or strpos(lower(coalesce(f.type_of_insurance, '') || ' / ' || coalesce(f.sub_type_of_insurance, '')), lower(p->>'typeOfInsurance')) > 0)
    and (nullif(p->>'filingType', '') is null or strpos(lower(coalesce(f.filing_type, '')), lower(p->>'filingType')) > 0)
    and (nullif(p->>'status', '') is null or strpos(lower(coalesce(f.filing_status, '')), lower(p->>'status')) > 0)
    and (nullif(p->>'rateAbove', '') is null or f.rate_impact > (p->>'rateAbove')::numeric)
    and (nullif(p->>'rateBelow', '') is null or f.rate_impact < (p->>'rateBelow')::numeric)
    and not exists (
      select 1 from jsonb_array_elements_text(case when jsonb_typeof(p->'words') = 'array' then p->'words' else '[]'::jsonb end) as w(word)
      where strpos(lower(coalesce(f.description, '') || ' ' || f.company_names), lower(w.word)) = 0)
$$;

-- One answer to a question: counts, and either rows (newest first) or groups (by company, type of insurance or
-- month). p as above, plus group ('rows', 'company', 'type' or 'month'), limit (1 to 500) and offset.
-- A rate filing is one whose filing type contains "rate".
create or replace function public.snl_index_query(p jsonb)
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  v_group  text := coalesce(nullif(p->>'group', ''), 'rows');
  v_limit  integer := least(greatest(coalesce((p->>'limit')::integer, 50), 1), 500);
  v_offset integer := least(greatest(coalesce((p->>'offset')::integer, 0), 0), 100000);
  v_out    jsonb;
  v_more   jsonb;
begin
  if v_group not in ('rows', 'company', 'type', 'month') then
    raise exception 'unknown group %', v_group;
  end if;
  select jsonb_build_object(
    'total', count(*),
    'withRate', count(*) filter (where m.rate_impact is not null),
    'rateFilings', count(*) filter (where strpos(lower(coalesce(m.filing_type, '')), 'rate') > 0))
  into v_out from public.snl_index_match(p) m;
  select jsonb_build_object('stateRows', count(*), 'stateDescribed', count(*) filter (where s.description is not null))
  into v_more from public.snl_index_filings s where s.state = p->>'state';
  v_out := v_out || v_more;

  if v_group = 'rows' then
    select jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(x) - 'sweep_id' - 'seen_at' order by x.publish_date desc nulls last, x.filing_key collate "C"), '[]'::jsonb))
    into v_more
    from (select * from public.snl_index_match(p) m order by m.publish_date desc nulls last, m.filing_key collate "C" limit v_limit offset v_offset) x;
  elsif v_group = 'company' then
    with g as (
      select coalesce('c' || (c.e->>'c'), 'i' || (c.e->>'i'), 'n' || lower(c.e->>'n')) as k,
        max(c.e->>'n' collate "C") as name, max(c.e->>'c' collate "C") as company_id, max(c.e->>'i' collate "C") as institution_id,
        count(distinct m.filing_key) as filings,
        count(distinct m.filing_key) filter (where strpos(lower(coalesce(m.filing_type, '')), 'rate') > 0) as rate_filings,
        min(m.rate_impact) as rate_min, max(m.rate_impact) as rate_max, max(m.publish_date) as latest
      from public.snl_index_match(p) m, jsonb_array_elements(m.companies) as c(e)
      group by 1)
    select jsonb_build_object('groupTotal', (select count(*) from g), 'groups', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'companyId', x.company_id, 'institutionId', x.institution_id, 'filings', x.filings,
        'rateFilings', x.rate_filings, 'rateMin', x.rate_min, 'rateMax', x.rate_max, 'latest', x.latest) order by x.filings desc, x.name collate "C", x.k collate "C")
      from (select * from g order by g.filings desc, g.name collate "C", g.k collate "C" limit v_limit offset v_offset) x), '[]'::jsonb))
    into v_more;
  else
    with g as (
      select case when v_group = 'type' then coalesce(m.type_of_insurance, 'n/d') else coalesce(to_char(m.publish_date, 'YYYY-MM'), 'n/d') end as name,
        count(*) as filings,
        count(*) filter (where strpos(lower(coalesce(m.filing_type, '')), 'rate') > 0) as rate_filings,
        min(m.rate_impact) as rate_min, max(m.rate_impact) as rate_max, max(m.publish_date) as latest
      from public.snl_index_match(p) m
      group by 1)
    select jsonb_build_object('groupTotal', (select count(*) from g), 'groups', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'filings', x.filings, 'rateFilings', x.rate_filings, 'rateMin', x.rate_min,
        'rateMax', x.rate_max, 'latest', x.latest) order by x.o1, x.o2, x.name collate "C")
      from (select g.*, case when v_group = 'type' then -g.filings else 0 end as o1, case when g.name = 'n/d' then 1 else 0 end as o2
            from g order by o1, o2, g.name collate "C" limit v_limit offset v_offset) x), '[]'::jsonb))
    into v_more;
  end if;
  return v_out || v_more;
end $$;

-- ---------- grants ----------
-- Anonymous visitors get nothing. Logins may only read the tables. Only the function's service role writes them and
-- runs the five functions above.
revoke all on public.snl_index_filings, public.snl_index_sweeps, public.snl_index_states from anon, authenticated;
grant select on public.snl_index_filings, public.snl_index_sweeps, public.snl_index_states to authenticated;
grant select, insert, update, delete on public.snl_index_filings, public.snl_index_sweeps, public.snl_index_states to service_role;
revoke all on function public.snl_index_merge(jsonb, jsonb), public.snl_index_names(jsonb), public.snl_index_put(jsonb),
  public.snl_index_match(jsonb), public.snl_index_query(jsonb) from public, anon, authenticated;
grant execute on function public.snl_index_merge(jsonb, jsonb), public.snl_index_names(jsonb), public.snl_index_put(jsonb),
  public.snl_index_match(jsonb), public.snl_index_query(jsonb) to service_role;
