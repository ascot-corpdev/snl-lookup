// Migration 0008 (supabase/migrations/0008_personal_templates.sql), read as text like profile_migration_test.ts reads
// 0004: each login's own folder in the "snl-template" bucket ("users/<login id>/"), readable and writable by that login
// only; the team object "template.pptx" readable by any login with a role and writable by Corp Dev only; 0004's
// bucket-wide policies replaced; anon nothing; safe to run twice. Then the policies of 0004 followed by 0008 are
// applied in order and evaluated for a grid of logins, objects and actions, the way Postgres combines permissive
// policies (any one that passes allows it). A local Postgres has no "storage" schema, so this is checked as text.
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const dir = new URL("../../supabase/migrations/", import.meta.url);
const raw = Deno.readTextFileSync(new URL("0008_personal_templates.sql", dir));
const raw4 = Deno.readTextFileSync(new URL("0004_profile_template.sql", dir));

/** SQL statements with comments removed, lower-cased and single-spaced. */
function statements(sql: string): string[] {
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  return code.split(";").map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}
const st = statements(raw);
const BUCKET = "bucket_id = 'snl-template'";
const TEAM = `${BUCKET} and name = 'template.pptx'`;
const OWN = `${BUCKET} and (storage.foldername(name))[1] = 'users' and (storage.foldername(name))[2] = (select auth.uid()::text) and public.app_role() is not null`;

// ---------- what it contains ----------
const pols = st.filter((s) => s.startsWith("create policy"));
{
  ok("next free number after 0007", [...Deno.readDirSync(dir)].map((f) => f.name).filter((n) => n.endsWith(".sql")).sort().at(-1) === "0008_personal_templates.sql");
  ok("0004's four bucket-wide policies are dropped", ["read, any login", "upload, corp dev", "replace, corp dev", "delete, corp dev"].every((n) => st.includes(`drop policy if exists "snl-template: ${n}" on storage.objects`)));
  ok("eight policies: read, upload, replace and delete, for the team object and for a login's own folder", pols.length === 8, pols);
  ok("every policy is on storage.objects, for logins only, never anon or public", pols.every((p) => / on storage\.objects for \w+ to authenticated /.test(p)) && !st.some((s) => /\banon\b|to public\b/.test(s)));
  ok("no catch-all policy", !pols.some((p) => / for all /.test(p)));
  ok("every policy is dropped first if it exists, so running again replaces it", pols.every((p) => {
    const m = p.match(/^create policy "([^"]+)" on storage\.objects/)!;
    const drop = st.indexOf(`drop policy if exists "${m[1]}" on storage.objects`);
    return drop >= 0 && drop < st.indexOf(p);
  }));
  ok("every policy name says it is for this bucket", pols.every((p) => /^create policy "snl-template: /.test(p)) && st.filter((s) => s.startsWith("drop policy")).every((s) => /^drop policy if exists "snl-template: /.test(s)));
  const conds = pols.flatMap((p) => [...p.matchAll(/(?:using|with check) \((.+?)\)(?= with check| *$)/g)].map((m) => m[1]));
  ok("every rule names this bucket and either the team object or the login's own folder: none covers the whole bucket", conds.length === 10 && conds.every((c) => c.startsWith(TEAM + " and ") || c === OWN), conds);
  const one = (verb: string, who: "team" | "own") => pols.filter((p) => new RegExp(` for ${verb} `).test(p) && p.includes(who === "team" ? "name = 'template.pptx'" : "foldername"));
  ok("team: read by any login with a role", one("select", "team").length === 1 && one("select", "team")[0].endsWith(`for select to authenticated using (${TEAM} and public.app_role() is not null)`), one("select", "team"));
  ok("team: upload, replace and delete by Corp Dev only", one("insert", "team")[0]?.endsWith(`with check (${TEAM} and public.app_role() = 'corpdev')`) &&
    one("update", "team")[0]?.endsWith(`using (${TEAM} and public.app_role() = 'corpdev') with check (${TEAM} and public.app_role() = 'corpdev')`) &&
    one("delete", "team")[0]?.endsWith(`using (${TEAM} and public.app_role() = 'corpdev')`));
  ok("own folder: read, upload, replace (before and after) and delete, the login's own folder only",
    one("select", "own")[0]?.endsWith(`using (${OWN})`) && one("insert", "own")[0]?.endsWith(`with check (${OWN})`) &&
    one("update", "own")[0]?.endsWith(`using (${OWN}) with check (${OWN})`) && one("delete", "own")[0]?.endsWith(`using (${OWN})`), pols.filter((p) => p.includes("foldername")));
  const kinds = st.map((s) => s.split(" ").slice(0, 2).join(" "));
  ok("the migration only replaces policies: no bucket change, no table, nothing deleted", kinds.every((k) => ["drop policy", "create policy"].includes(k)), kinds);
  ok("row level security on storage.objects is left as Supabase sets it", !/row level security/.test(st.join(";")));
  ok("the bucket's limits stay as 0004 set them", /insert into storage\.buckets .*'snl-template', 'snl-template', false, 52428800/.test(statements(raw4).join(";")) && !/storage\.buckets/.test(st.join(";")));
}

// ---------- the rules, evaluated ----------
type Login = { uid: string; role: string | null };
type Obj = { bucket: string; name: string };
type Pol = { name: string; cmd: string; using?: (u: Login, o: Obj) => boolean; check?: (u: Login, o: Obj) => boolean };
/** storage.foldername(name): the folders of the path, without the file name. */
const folders = (name: string) => name.split("/").slice(0, -1);
/** One SQL predicate as a function; throws on anything this small translator doesn't know, so nothing is skipped. */
function predicate(sql: string): (u: Login, o: Obj) => boolean {
  const parts = sql.split(" and ").map((t) => {
    let m;
    if ((m = t.match(/^bucket_id = '([^']+)'$/))) { const v = m[1]; return (_u: Login, o: Obj) => o.bucket === v; }
    if ((m = t.match(/^name = '([^']+)'$/))) { const v = m[1]; return (_u: Login, o: Obj) => o.name === v; }
    if ((m = t.match(/^\(storage\.foldername\(name\)\)\[(\d)\] = '([^']+)'$/))) { const i = +m[1] - 1, v = m[2]; return (_u: Login, o: Obj) => folders(o.name)[i] === v; }
    if ((m = t.match(/^\(storage\.foldername\(name\)\)\[(\d)\] = \(select auth\.uid\(\)::text\)$/))) { const i = +m[1] - 1; return (u: Login, o: Obj) => folders(o.name)[i] === u.uid; }
    if (t === "public.app_role() is not null") return (u: Login) => u.role !== null;
    if ((m = t.match(/^public\.app_role\(\) = '([^']+)'$/))) { const v = m[1]; return (u: Login) => u.role === v; }
    throw new Error("unknown condition: " + t);
  });
  return (u, o) => parts.every((f) => f(u, o));
}
const live = new Map<string, Pol>();
let unknown = "";
for (const s of [...statements(raw4), ...st]) {
  let m;
  if ((m = s.match(/^drop policy if exists "([^"]+)" on storage\.objects$/))) { live.delete(m[1]); continue; }
  if (!(m = s.match(/^create policy "([^"]+)" on storage\.objects for (\w+) to authenticated (.*)$/))) continue;
  const [, name, cmd, rest] = m;
  const u = rest.match(/using \((.+?)\)(?= with check| *$)/), c = rest.match(/with check \((.+?)\)$/);
  try { live.set(name, { name, cmd, using: u ? predicate(u[1]) : undefined, check: c ? predicate(c[1]) : undefined }); } catch (e) { unknown = String(e); }
}
ok("every condition in 0004 and 0008 is understood by the evaluator", unknown === "", unknown);
ok("after both run, only 0008's eight policies are left", live.size === 8 && [...live.keys()].every((n) => / (team|own), /.test(n)), [...live.keys()]);
/** May this login do this to this object? select, delete: some using passes; insert: some check passes; update: some
    using passes for the old row and some check passes for the new one (the same object here). */
function may(u: Login, cmd: string, o: Obj): boolean {
  const ps = [...live.values()].filter((p) => p.cmd === cmd);
  if (cmd === "insert") return ps.some((p) => p.check!(u, o));
  if (cmd === "update") return ps.some((p) => p.using!(u, o)) && ps.some((p) => (p.check ?? p.using)!(u, o));
  return ps.some((p) => p.using!(u, o));
}
const READER: Login = { uid: "11111111-aaaa-4aaa-8aaa-000000000001", role: "reader" };
const CORPDEV: Login = { uid: "22222222-bbbb-4bbb-8bbb-000000000002", role: "corpdev" };
const NOROLE: Login = { uid: "33333333-cccc-4ccc-8ccc-000000000003", role: null };
const at = (name: string, bucket = "snl-template"): Obj => ({ bucket, name });
const own = (u: Login) => at(`users/${u.uid}/template.pptx`);
const ALL = ["select", "insert", "update", "delete"];
const grid = (u: Login, o: Obj) => ALL.filter((c) => may(u, c, o)).join(",");
ok("the team template: any login with a role reads it", grid(READER, at("template.pptx")) === "select" && grid(CORPDEV, at("template.pptx")) === "select,insert,update,delete");
ok("a login's own template: it may read, upload, replace and delete it", grid(READER, own(READER)) === "select,insert,update,delete" && grid(CORPDEV, own(CORPDEV)) === "select,insert,update,delete");
ok("another login's template: nothing, Corp Dev included", grid(READER, own(CORPDEV)) === "" && grid(CORPDEV, own(READER)) === "");
ok("a login without a role: nothing, not even its own folder", grid(NOROLE, own(NOROLE)) === "" && grid(NOROLE, at("template.pptx")) === "");
ok("a folder whose name only starts with the login's id is not its own", grid(READER, at(`users/${READER.uid}x/template.pptx`)) === "" && grid(READER, at(`users/x${READER.uid}/template.pptx`)) === "");
ok("its own folder at any depth, but never another folder named after it", grid(READER, at(`users/${READER.uid}/old/template.pptx`)) === "select,insert,update,delete" && grid(READER, at(`other/${READER.uid}/template.pptx`)) === "");
ok("any other object in the bucket: nobody, Corp Dev included", grid(CORPDEV, at("other.pptx")) === "" && grid(CORPDEV, at("users/template.pptx")) === "" && grid(READER, at("other.pptx")) === "");
ok("another bucket: nothing from these policies", grid(READER, at(`users/${READER.uid}/template.pptx`, "avatars")) === "" && grid(CORPDEV, at("template.pptx", "avatars")) === "");
ok("the migration holds no secret, key or real login id", !/sk-ant-|eyJ[A-Za-z0-9_-]{10,}|password\s*=|BEGIN [A-Z ]*PRIVATE KEY|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw));

done();
