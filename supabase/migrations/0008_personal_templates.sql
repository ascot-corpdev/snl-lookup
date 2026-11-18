-- Company profiles: a personal PowerPoint template for each login, beside the team's.
-- Run once in the Supabase SQL editor (or `supabase db push`), after 0004. Safe to run again.
--
-- The same private bucket as migration 0004, "snl-template". The team template stays the object "template.pptx",
-- which any login with a role may read and only Corp Dev logins may upload, replace or delete. Each login may also
-- keep its own template in its own folder, "users/<the login's id>/template.pptx", used only for its own decks.
-- A login may read, upload, replace and delete only inside its own folder; nobody else, Corp Dev included, can read or
-- change it. Anonymous visitors get nothing. The bucket's limits (private, 50 MB a file, PowerPoint files only) stay.
--
-- Migration 0004's four policies covered the whole bucket, which would let every login read every personal template,
-- so they are replaced here by the same rules for the team object only. Nothing else in Storage is touched.

-- ---------- the team template: as in 0004, for "template.pptx" only ----------
drop policy if exists "snl-template: read, any login" on storage.objects;
drop policy if exists "snl-template: upload, corp dev" on storage.objects;
drop policy if exists "snl-template: replace, corp dev" on storage.objects;
drop policy if exists "snl-template: delete, corp dev" on storage.objects;

drop policy if exists "snl-template: read team, any login" on storage.objects;
create policy "snl-template: read team, any login" on storage.objects
  for select to authenticated using (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() is not null);

drop policy if exists "snl-template: upload team, corp dev" on storage.objects;
create policy "snl-template: upload team, corp dev" on storage.objects
  for insert to authenticated with check (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev');

-- Replacing the file (an upload with upsert) needs update as well as insert.
drop policy if exists "snl-template: replace team, corp dev" on storage.objects;
create policy "snl-template: replace team, corp dev" on storage.objects
  for update to authenticated using (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev') with check (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev');

drop policy if exists "snl-template: delete team, corp dev" on storage.objects;
create policy "snl-template: delete team, corp dev" on storage.objects
  for delete to authenticated using (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev');

-- ---------- each login's own folder: users/<auth.uid()>/ ----------
-- storage.foldername(name) splits the object's path into its folders, as Supabase's storage examples use it.
drop policy if exists "snl-template: read own, any login" on storage.objects;
create policy "snl-template: read own, any login" on storage.objects
  for select to authenticated using (bucket_id = 'snl-template' and (storage.foldername(name))[1] = 'users' and (storage.foldername(name))[2] = (select auth.uid()::text) and public.app_role() is not null);

drop policy if exists "snl-template: upload own, any login" on storage.objects;
create policy "snl-template: upload own, any login" on storage.objects
  for insert to authenticated with check (bucket_id = 'snl-template' and (storage.foldername(name))[1] = 'users' and (storage.foldername(name))[2] = (select auth.uid()::text) and public.app_role() is not null);

drop policy if exists "snl-template: replace own, any login" on storage.objects;
create policy "snl-template: replace own, any login" on storage.objects
  for update to authenticated using (bucket_id = 'snl-template' and (storage.foldername(name))[1] = 'users' and (storage.foldername(name))[2] = (select auth.uid()::text) and public.app_role() is not null) with check (bucket_id = 'snl-template' and (storage.foldername(name))[1] = 'users' and (storage.foldername(name))[2] = (select auth.uid()::text) and public.app_role() is not null);

drop policy if exists "snl-template: delete own, any login" on storage.objects;
create policy "snl-template: delete own, any login" on storage.objects
  for delete to authenticated using (bucket_id = 'snl-template' and (storage.foldername(name))[1] = 'users' and (storage.foldername(name))[2] = (select auth.uid()::text) and public.app_role() is not null);
