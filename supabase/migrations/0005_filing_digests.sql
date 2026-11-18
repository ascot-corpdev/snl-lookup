-- SNL lookup: saved filing summaries ("digests"). What one reading of a filing found, saved so the document need not be
-- read again, and searchable by form number, form title, program name and words.
-- Run once in the Supabase SQL editor (or `supabase db push`), after 0001. Safe to run again.
--
-- One row per filing: the key is "v:" and the filing version id, or "d:" and the document id when there is no version
-- id. doc holds the summary in the shape the app uses (supabase/functions/_shared/digest.ts). The snl-digest and snl-chat
-- functions write it with the service role. Every signed-in login with a profile can read it. Anonymous visitors get
-- nothing. The rows hold text taken from S&P's filing documents: keep it inside this project.
--
-- Search: form_keys holds the form numbers without spacing or punctuation ("CHO3001"), matched with ilike, which is a
-- scan of the table; that is quick for the thousands of rows the team will make. search_body holds the summary, program
-- names, form titles and points; search_text, generated from it, has Postgres's word index. Nothing here needs an
-- extension, so it runs on Supabase's free plan.

create table if not exists public.snl_digests (
  id                text primary key check (id ~ '^(v:[A-Za-z0-9._-]{8,64}|d:[0-9]{1,15})$'),
  filing_version_id text check (filing_version_id is null or filing_version_id ~ '^[A-Za-z0-9._-]{8,64}$'),
  document_id       bigint check (document_id is null or document_id > 0),
  state             text check (state is null or state ~ '^[A-Z]{2}$'),
  company           text check (company is null or length(company) <= 200),
  form_keys         text not null default '' check (length(form_keys) <= 4000),
  search_body       text not null default '' check (length(search_body) <= 20000),
  pages_read        integer not null default 0 check (pages_read >= 0 and pages_read <= 100000),
  made_at           timestamptz not null default now(),
  doc               jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) < 262144),
  search_text       tsvector generated always as (to_tsvector('english'::regconfig, search_body)) stored,
  check (filing_version_id is not null or document_id is not null)
);
create index if not exists snl_digests_version on public.snl_digests (filing_version_id);
create index if not exists snl_digests_document on public.snl_digests (document_id);
create index if not exists snl_digests_state_made on public.snl_digests (state, made_at desc);
create index if not exists snl_digests_made on public.snl_digests (made_at desc);
create index if not exists snl_digests_search on public.snl_digests using gin (search_text);
alter table public.snl_digests enable row level security;

drop policy if exists "read: any login" on public.snl_digests;
create policy "read: any login" on public.snl_digests
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: the functions write with the service role.

-- ---------- grants ----------
-- Anonymous visitors get nothing. Logins may only read.
revoke all on public.snl_digests from anon, authenticated;
grant select on public.snl_digests to authenticated;
grant select, insert, update, delete on public.snl_digests to service_role;
