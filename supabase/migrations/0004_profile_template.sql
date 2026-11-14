-- Company profiles: private storage for the team's PowerPoint template, which the site uses to build a profile deck.
-- Run once in the Supabase SQL editor (or `supabase db push`). Safe to run again.
--
-- One private bucket, "snl-template". The site keeps the template there as the object "template.pptx".
-- Any login with a role may read it (to build a deck). Only Corp Dev logins may upload, replace or delete it.
-- Anonymous visitors get nothing. Nothing else in Storage is touched: these policies name this bucket only.

-- ---------- the bucket ----------
-- Private (not public), at most 50 MB a file, PowerPoint files only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snl-template', 'snl-template', false, 52428800, array[
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template'
])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------- who may do what ----------
-- public.app_role() (migration 0001) is the login's role, or null for a login without a profile.
drop policy if exists "snl-template: read, any login" on storage.objects;
create policy "snl-template: read, any login" on storage.objects
  for select to authenticated using (bucket_id = 'snl-template' and public.app_role() is not null);

drop policy if exists "snl-template: upload, corp dev" on storage.objects;
create policy "snl-template: upload, corp dev" on storage.objects
  for insert to authenticated with check (bucket_id = 'snl-template' and public.app_role() = 'corpdev');

-- Replacing the file (an upload with upsert) needs update as well as insert.
drop policy if exists "snl-template: replace, corp dev" on storage.objects;
create policy "snl-template: replace, corp dev" on storage.objects
  for update to authenticated using (bucket_id = 'snl-template' and public.app_role() = 'corpdev') with check (bucket_id = 'snl-template' and public.app_role() = 'corpdev');

drop policy if exists "snl-template: delete, corp dev" on storage.objects;
create policy "snl-template: delete, corp dev" on storage.objects
  for delete to authenticated using (bucket_id = 'snl-template' and public.app_role() = 'corpdev');
