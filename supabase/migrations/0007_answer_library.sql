-- SNL lookup: the team library. Answers a login chose to share with everyone who has a login on this site.
-- Run once in the Supabase SQL editor (or `supabase db push`), after 0001. Safe to run again.
--
-- Each row is a COPY of one finished answer (public.snl_jobs, migration 0001), taken when its owner saved it, so it
-- outlives the 30-day clean-up of answers and any later change to the original. Nothing points back at snl_jobs
-- with a foreign key: clearing or deleting the original answer never touches the copy.
-- Every signed-in login with a profile can read every row. Nobody writes from the browser: the snl-chat function
-- saves, renames and removes entries with the service role, after checking who is asking (the saver, or any Corp
-- Dev login, may change or remove an entry). Anonymous visitors get nothing.
-- The function keeps the library to 500 entries and one entry's answer to 150 KB; the checks below are
-- a backstop. Nothing records why an answer was saved.
-- The rows hold S&P Global data: keep it inside this project.

create table if not exists public.snl_library (
  id            uuid primary key default gen_random_uuid(),
  -- The answer this was copied from. Not a foreign key, on purpose (see above). One entry per answer.
  job_id        uuid not null,
  title         text not null check (length(title) between 1 and 120),
  question      text not null check (length(question) between 1 and 4000),
  -- The answer as it was shown: {answer: [{text, cites}], sources: [...], table, caps: [...], lookups: [...]}.
  answer        jsonb not null check (jsonb_typeof(answer) = 'object' and pg_column_size(answer) < 524288),
  model         text check (model is null or length(model) <= 80),
  asked_at      timestamptz not null,
  answered_at   timestamptz not null,
  -- Who saved it: their login id (kept if the login is later deleted, so the name still shows) and display name.
  saved_by      uuid,
  saved_by_name text not null check (length(saved_by_name) between 1 and 80),
  saved_at      timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  tags          jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array' and jsonb_array_length(tags) <= 5 and pg_column_size(tags) < 1024),
  -- The companies named in the answer's sources, for the search box.
  companies     jsonb not null default '[]'::jsonb check (jsonb_typeof(companies) = 'array' and jsonb_array_length(companies) <= 40 and pg_column_size(companies) < 8192),
  -- Title, question, tags and companies in lower case, written by the function, so the page can search one column.
  search_text   text not null default '' check (length(search_text) <= 12000)
);
create unique index if not exists snl_library_job on public.snl_library (job_id);
create index if not exists snl_library_saved on public.snl_library (saved_at desc);
alter table public.snl_library enable row level security;

drop policy if exists "read: any login" on public.snl_library;
create policy "read: any login" on public.snl_library
  for select to authenticated using (public.app_role() is not null);
-- No insert, update or delete policies: the snl-chat function writes with the service role.

-- ---------- grants ----------
-- Anonymous visitors get nothing. Logins may only read.
revoke all on public.snl_library from anon, authenticated;
grant select on public.snl_library to authenticated;
grant select, insert, update, delete on public.snl_library to service_role;
