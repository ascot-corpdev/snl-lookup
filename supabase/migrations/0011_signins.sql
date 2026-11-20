-- SNL lookup: sign-in notices. A record of who signed in through Cloudflare sign-on, one row per sign-in.
-- Run once in the Supabase SQL editor (or `supabase db push`), after 0001. Safe to run again.
--
-- The snl-signin function writes this table with the service role (supabase/functions/_shared/signins.ts). One row
-- is one Cloudflare Access session: the first call of a session adds the row, later calls only move last_seen_at,
-- at most every few minutes. session_key is a SHA-256 of the email address and the time Cloudflare issued the
-- session's token; the token itself is never kept. notice says what happened about the email to the owner.
-- Only Corp Dev logins can read it. Readers and anonymous visitors get nothing. Nobody writes from the browser.
-- Rows not seen for 90 days are removed by the function whenever it records a new sign-in.
-- The rows hold colleagues' email addresses and sign-in times: keep them inside this project.

create table if not exists public.snl_signins (
  session_key   text primary key check (session_key ~ '^[0-9a-f]{64}$'),
  email         text not null check (email = lower(email) and length(email) between 3 and 254),
  role          text not null check (role in ('corpdev', 'reader')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  notice        text not null default 'pending' check (notice in ('pending', 'sent', 'failed', 'not_needed', 'off', 'not_set_up'))
);
-- The page lists the newest first; the function clears rows by last_seen_at.
create index if not exists snl_signins_first_seen on public.snl_signins (first_seen_at desc);
create index if not exists snl_signins_last_seen on public.snl_signins (last_seen_at);
alter table public.snl_signins enable row level security;

drop policy if exists "read: corpdev" on public.snl_signins;
create policy "read: corpdev" on public.snl_signins
  for select to authenticated using (public.app_role() = 'corpdev');
-- No insert, update or delete policies: the snl-signin function writes with the service role.

-- ---------- grants ----------
-- Anonymous visitors get nothing. Logins may only read, and the policy above lets only Corp Dev see any row.
revoke all on public.snl_signins from anon, authenticated;
grant select on public.snl_signins to authenticated;
grant select, insert, update, delete on public.snl_signins to service_role;
