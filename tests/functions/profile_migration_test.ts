// Migration 0004 (supabase/migrations/0004_profile_template.sql), read as text like watch_migration_test.ts reads 0003:
// one private bucket for the PowerPoint template, policies on storage.objects for that bucket only (any login with a
// role reads, only Corp Dev writes, anon nothing), safe to run twice. Then snl-profile's entry in config.toml.
// A local Postgres has no "storage" schema, so the SQL is checked as text, not run.
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const root = new URL("../../supabase/", import.meta.url);
const raw = Deno.readTextFileSync(new URL("migrations/0004_profile_template.sql", root));

/** SQL statements with comments removed, lower-cased and single-spaced. */
function statements(sql: string): string[] {
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  return code.split(";").map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}
const st = statements(raw);
const BUCKET = "bucket_id = 'snl-template'";

// ---------- the bucket ----------
{
  const ins = st.filter((s) => s.startsWith("insert into storage.buckets"));
  ok("one bucket is created", ins.length === 1, ins);
  const b = ins[0] ?? "";
  ok("its id and name are snl-template", /values \('snl-template', 'snl-template',/.test(b), b);
  ok("it is private", /'snl-template', 'snl-template', false,/.test(b) && /on conflict \(id\) do update set public = false/.test(b), b);
  ok("its file size limit is 50 MB", /, 52428800, array\[/.test(b));
  const types = [...b.matchAll(/'(application\/[^']+)'/g)].map((m) => m[1]);
  ok("it takes PowerPoint files only", types.length === 2 && types.every((t) => t.startsWith("application/vnd.openxmlformats-officedocument.presentationml.")) && types.includes("application/vnd.openxmlformats-officedocument.presentationml.presentation"), types);
  ok("running it again updates the bucket instead of failing", /on conflict \(id\) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types$/.test(b));
  ok("no bucket is made public, anywhere", !/public = true|, true,/.test(st.join(";")));
}

// ---------- the policies ----------
const pols = st.filter((s) => s.startsWith("create policy"));
{
  ok("four policies: read, upload, replace and delete", pols.length === 4, pols);
  ok("every policy is on storage.objects", pols.every((p) => / on storage\.objects /.test(p)));
  ok("every policy is for logins only (to authenticated), never anon or public", pols.every((p) => / to authenticated /.test(p)) && !st.some((s) => /\banon\b|to public\b/.test(s)));
  ok("every rule names this bucket, in each using and with check", pols.every((p) => {
    const parts = [...p.matchAll(/(using|with check) \((.+?)\)(?= with check| *$)/g)].map((m) => m[2]);
    return parts.length >= 1 && parts.every((x) => x.startsWith(BUCKET + " and "));
  }), pols);
  const one = (verb: string) => pols.filter((p) => new RegExp(` for ${verb} `).test(p));
  ok("read: any login with a role", one("select").length === 1 && one("select")[0].endsWith(`for select to authenticated using (${BUCKET} and public.app_role() is not null)`), one("select"));
  ok("upload: Corp Dev only", one("insert").length === 1 && one("insert")[0].endsWith(`for insert to authenticated with check (${BUCKET} and public.app_role() = 'corpdev')`), one("insert"));
  ok("replace: Corp Dev only, both before and after", one("update").length === 1 && one("update")[0].endsWith(`for update to authenticated using (${BUCKET} and public.app_role() = 'corpdev') with check (${BUCKET} and public.app_role() = 'corpdev')`), one("update"));
  ok("delete: Corp Dev only", one("delete").length === 1 && one("delete")[0].endsWith(`for delete to authenticated using (${BUCKET} and public.app_role() = 'corpdev')`), one("delete"));
  ok("no catch-all policy", !pols.some((p) => / for all /.test(p)));
  ok("every policy is dropped first if it exists, so running again replaces it", pols.every((p) => {
    const m = p.match(/^create policy "([^"]+)" on (storage\.objects)/)!;
    const drop = st.indexOf(`drop policy if exists "${m[1]}" on ${m[2]}`);
    return drop >= 0 && drop < st.indexOf(p);
  }));
  ok("every policy name says it is for this bucket, so it can't replace another policy", pols.every((p) => /^create policy "snl-template: /.test(p)) && st.filter((s) => s.startsWith("drop policy")).every((s) => /^drop policy if exists "snl-template: /.test(s)));
}

// ---------- nothing else ----------
{
  const kinds = st.map((s) => s.split(" ").slice(0, 2).join(" "));
  ok("the migration only adds the bucket and its policies", kinds.every((k) => ["insert into", "drop policy", "create policy"].includes(k)), kinds);
  ok("it touches no table of the app and no other bucket", !/public\.(profiles|snl_\w+)/.test(st.join(";")) && !/delete from|update storage|truncate|drop table|alter table/.test(st.join(";")));
  ok("row level security on storage.objects is left as Supabase sets it", !/row level security/.test(st.join(";")));
  ok("only statements Supabase documents for storage: a bucket row and policies", st.every((s) => s.startsWith("insert into storage.buckets") || /^(drop|create) policy .* on storage\.objects/.test(s)));
}

// ---------- config.toml ----------
{
  const toml = Deno.readTextFileSync(new URL("config.toml", root));
  ok("config.toml deploys snl-profile with the gateway's login check off, like the others", /\[functions\.snl-profile\]\nverify_jwt = false/.test(toml));
}

done();
