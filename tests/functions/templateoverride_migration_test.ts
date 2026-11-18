// Migration 0008 (supabase/migrations/0008_own_templates.sql), read as text like profile_migration_test.ts reads 0004:
// it replaces 0004's bucket-wide policies with narrower ones (the standard template for everyone, Corp Dev changes
// it; one template of your own at <your user id>/template.pptx that only you can read or change), lets logins see the
// bucket's settings so the site can tell the file has been run, and touches nothing else. Safe to run twice.
// A local Postgres has no "storage" schema, so the SQL is checked as text, not run.
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const root = new URL("../../supabase/", import.meta.url);
const raw = Deno.readTextFileSync(new URL("migrations/0008_own_templates.sql", root));
const raw4 = Deno.readTextFileSync(new URL("migrations/0004_profile_template.sql", root));

/** SQL statements with comments removed, lower-cased and single-spaced. */
function statements(sql: string): string[] {
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  return code.split(";").map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}
const st = statements(raw);
const all = st.join(";");
const pols = st.filter((s) => s.startsWith("create policy"));
const objPols = pols.filter((p) => / on storage\.objects /.test(p));
const BUCKET = "bucket_id = 'snl-template'";
const STD = `${BUCKET} and name = 'template.pptx'`;
const OWN = `${BUCKET} and name = auth.uid()::text || '/template.pptx'`;
const ROLE = "public.app_role() is not null", CD = "public.app_role() = 'corpdev'";

// ---------- 0004's policies are removed ----------
{
  const old = [...raw4.matchAll(/create policy "([^"]+)" on storage\.objects/g)].map((m) => m[1].toLowerCase());
  ok("0004 has the four policies this file replaces", old.length === 4, old);
  ok("each of 0004's policies is dropped", old.every((n) => st.includes(`drop policy if exists "${n}" on storage.objects`)), old);
  ok("none of 0004's policy names is created again (so they can't be left wide)", old.every((n) => !pols.some((p) => p.startsWith(`create policy "${n}" `))));
  ok("0004 itself is unchanged: still four bucket-wide policies", /for select to authenticated using \(bucket_id = 'snl-template' and public\.app_role\(\) is not null\)/.test(raw4.replace(/\s+/g, " ")));
}

// ---------- the policies ----------
{
  ok("nine policies: four on the standard template, four on your own, one to see the bucket", pols.length === 9 && objPols.length === 8, pols);
  ok("every policy is for logins only (to authenticated), never anon or public", pols.every((p) => / to authenticated /.test(p)) && !/\banon\b|to public\b/.test(all));
  ok("no catch-all policy", !pols.some((p) => / for all /.test(p)));
  const one = (verb: string, who: RegExp) => objPols.filter((p) => new RegExp(` for ${verb} `).test(p) && who.test(p));
  const std = (verb: string) => one(verb, /standard template/), own = (verb: string) => one(verb, /your own template/);
  ok("read the standard template: any login with a role, that one object only", std("select").length === 1 && std("select")[0].endsWith(`for select to authenticated using (${STD} and ${ROLE})`), std("select"));
  ok("upload the standard template: Corp Dev only, that one object only", std("insert").length === 1 && std("insert")[0].endsWith(`for insert to authenticated with check (${STD} and ${CD})`), std("insert"));
  ok("replace the standard template: Corp Dev only, before and after", std("update").length === 1 && std("update")[0].endsWith(`for update to authenticated using (${STD} and ${CD}) with check (${STD} and ${CD})`), std("update"));
  ok("delete the standard template: Corp Dev only", std("delete").length === 1 && std("delete")[0].endsWith(`for delete to authenticated using (${STD} and ${CD})`), std("delete"));
  ok("read your own: only the object named by your own user id", own("select").length === 1 && own("select")[0].endsWith(`for select to authenticated using (${OWN} and ${ROLE})`), own("select"));
  ok("upload your own: only there", own("insert").length === 1 && own("insert")[0].endsWith(`for insert to authenticated with check (${OWN} and ${ROLE})`), own("insert"));
  ok("replace your own: only there, before and after", own("update").length === 1 && own("update")[0].endsWith(`for update to authenticated using (${OWN} and ${ROLE}) with check (${OWN} and ${ROLE})`), own("update"));
  ok("delete your own: only there", own("delete").length === 1 && own("delete")[0].endsWith(`for delete to authenticated using (${OWN} and ${ROLE})`), own("delete"));
  ok("every object rule names this bucket and one exact object, in each using and with check", objPols.every((p) => {
    const parts = [...p.matchAll(/(using|with check) \((.+?)\)(?= with check| *$)/g)].map((m) => m[2]);
    return parts.length >= 1 && parts.every((x) => x.startsWith(STD + " and ") || x.startsWith(OWN + " and "));
  }), objPols);
  ok("Corp Dev gets no rule on anyone's own template", !objPols.some((p) => p.includes("auth.uid()") && p.includes("corpdev")));
  ok("no rule reaches another login's folder: no wildcard, prefix or folder match", !/ like |foldername|starts_with|position\(|~/.test(all));
  const seen = pols.filter((p) => / on storage\.buckets /.test(p));
  ok("logins with a role may see this bucket's settings, and no other bucket's", seen.length === 1 && seen[0].endsWith(`for select to authenticated using (id = 'snl-template' and ${ROLE})`), seen);
  ok("every policy is dropped first if it exists, so running again replaces it", pols.every((p) => {
    const m = p.match(/^create policy "([^"]+)" on (storage\.\w+)/)!;
    const drop = st.indexOf(`drop policy if exists "${m[1]}" on ${m[2]}`);
    return drop >= 0 && drop < st.indexOf(p);
  }));
  ok("every policy name says it is for this bucket", pols.every((p) => /^create policy "snl-template: /.test(p)) && st.filter((s) => s.startsWith("drop policy")).every((s) => /^drop policy if exists "snl-template: /.test(s)));
}

// ---------- nothing else ----------
{
  ok("only policies: no bucket made or changed, no table, no function", st.every((s) => /^(drop|create) policy .* on storage\.(objects|buckets)/.test(s)), st);
  ok("it touches no table of the app", !/public\.(profiles|snl_\w+)/.test(all) && !/delete from|update storage|insert into|truncate|drop table|alter table/.test(all));
  ok("no bucket is made public", !/public = true/.test(all));
  ok("row level security is left as Supabase sets it", !/row level security/.test(all));
}

done();
