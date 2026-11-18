-- Templates of your own: any login with a role may keep one PowerPoint template that only they use, beside the
-- standard template Corp Dev uploads for everyone. Run once in the Supabase SQL editor, after
-- 0004_profile_template.sql. Safe to run again. If 0004 is ever run again, run this file again after it.
--
-- Same private bucket, "snl-template":
--   template.pptx            the standard template: any login with a role reads it; only Corp Dev uploads, replaces
--                            or deletes it (as 0004, but now for that one object only).
--   <user id>/template.pptx  a login's own template: only that login reads, uploads, replaces or deletes it. Nobody
--                            else can, Corp Dev included, and nobody can list whose folders exist.
-- Nothing else can be stored in the bucket. 0004's four policies covered every object in the bucket; they are
-- replaced here by narrower ones. Anonymous visitors get nothing. Nothing else in Storage is touched: every policy
-- here names this bucket only.

-- ---------- 0004's policies go: they let any login read, and Corp Dev write, every object in the bucket ----------
drop policy if exists "snl-template: read, any login" on storage.objects;
drop policy if exists "snl-template: upload, corp dev" on storage.objects;
drop policy if exists "snl-template: replace, corp dev" on storage.objects;
drop policy if exists "snl-template: delete, corp dev" on storage.objects;

-- ---------- the standard template: any login reads it, Corp Dev changes it ----------
-- public.app_role() (migration 0001) is the login's role, or null for a login without a profile.
drop policy if exists "snl-template: read the standard template, any login" on storage.objects;
create policy "snl-template: read the standard template, any login" on storage.objects
  for select to authenticated using (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() is not null);

drop policy if exists "snl-template: upload the standard template, corp dev" on storage.objects;
create policy "snl-template: upload the standard template, corp dev" on storage.objects
  for insert to authenticated with check (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev');

-- Replacing the file (an upload with upsert) needs update as well as insert.
drop policy if exists "snl-template: replace the standard template, corp dev" on storage.objects;
create policy "snl-template: replace the standard template, corp dev" on storage.objects
  for update to authenticated using (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev') with check (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev');

drop policy if exists "snl-template: delete the standard template, corp dev" on storage.objects;
create policy "snl-template: delete the standard template, corp dev" on storage.objects
  for delete to authenticated using (bucket_id = 'snl-template' and name = 'template.pptx' and public.app_role() = 'corpdev');

-- ---------- a login's own template: <their user id>/template.pptx, theirs alone ----------
drop policy if exists "snl-template: read your own template" on storage.objects;
create policy "snl-template: read your own template" on storage.objects
  for select to authenticated using (bucket_id = 'snl-template' and name = auth.uid()::text || '/template.pptx' and public.app_role() is not null);

drop policy if exists "snl-template: upload your own template" on storage.objects;
create policy "snl-template: upload your own template" on storage.objects
  for insert to authenticated with check (bucket_id = 'snl-template' and name = auth.uid()::text || '/template.pptx' and public.app_role() is not null);

drop policy if exists "snl-template: replace your own template" on storage.objects;
create policy "snl-template: replace your own template" on storage.objects
  for update to authenticated using (bucket_id = 'snl-template' and name = auth.uid()::text || '/template.pptx' and public.app_role() is not null) with check (bucket_id = 'snl-template' and name = auth.uid()::text || '/template.pptx' and public.app_role() is not null);

drop policy if exists "snl-template: delete your own template" on storage.objects;
create policy "snl-template: delete your own template" on storage.objects
  for delete to authenticated using (bucket_id = 'snl-template' and name = auth.uid()::text || '/template.pptx' and public.app_role() is not null);

-- ---------- how the site knows this file has been run ----------
-- Logins with a role may see the bucket's own settings (its name, size limit and file types; nothing about what is in
-- it). Before this file is run the bucket is hidden from them, so the site says templates of your own aren't switched
-- on yet and offers only the standard template.
drop policy if exists "snl-template: see the bucket, any login" on storage.buckets;
create policy "snl-template: see the bucket, any login" on storage.buckets
  for select to authenticated using (id = 'snl-template' and public.app_role() is not null);
