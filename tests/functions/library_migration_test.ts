// Migration 0007 (supabase/migrations/0007_answer_library.sql), read as text like watch_migration_test.ts reads 0003:
// row level security on, every login reads, nobody writes but the function, anon gets nothing, safe to run twice, no
// link to snl_jobs that the 30-day clean-up could follow, and the columns and limits match what the function writes.
import { answerCopy, entryOut, LIBRARY, searchText } from "../../supabase/functions/_shared/library.ts";
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const raw = Deno.readTextFileSync(new URL("../../supabase/migrations/0007_answer_library.sql", import.meta.url));

/** SQL statements with comments removed, lower-cased and single-spaced. */
function statements(sql: string): string[] {
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  return code.split(";").map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}
const st = statements(raw);
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const bare = (t: string) => t.replace(/^public\./, "");
const tables = st.map((s) => s.match(/^create table (?:if not exists )?public\.(\w+)/)?.[1]).filter(Boolean) as string[];

// ---------- the table and row level security ----------
{
  ok("the migration creates one table, snl_library", same(tables, ["snl_library"]), tables);
  ok("row level security is switched on", st.includes("alter table public.snl_library enable row level security"));
  ok("row level security is never switched off or bypassed", !st.some((s) => /disable row level security|no force row level security|bypassrls|security definer/.test(s)));
  ok("it changes no table from earlier migrations", !st.some((s) => /^(alter|drop|insert|update|delete|grant|revoke).*public\.(profiles|snl_store|snl_usage|snl_throttle|snl_jobs|snl_job_state|snl_settings|snl_watch_runs|snl_watch_found)\b/.test(s)));
  ok("no foreign key to snl_jobs, so clearing an answer never removes or changes its copy", !/references/.test(st.join(";")) && !/on delete/.test(st.join(";")));
}

// ---------- safe to run twice ----------
{
  ok("the table is created only if it isn't there", st.filter((s) => s.startsWith("create table")).every((s) => s.startsWith("create table if not exists public.")));
  const idx = st.filter((s) => /^create (unique )?index/.test(s));
  ok("every index is created only if it isn't there", idx.length === 2 && idx.every((s) => /^create (unique )?index if not exists /.test(s)), idx);
  const pols = st.filter((s) => s.startsWith("create policy"));
  ok("every policy is dropped first if it exists", pols.length === 1 && pols.every((p) => {
    const m = p.match(/^create policy "([^"]+)" on (public\.\w+)/)!;
    const drop = st.indexOf(`drop policy if exists "${m[1]}" on ${m[2]}`);
    return drop >= 0 && drop < st.indexOf(p);
  }));
  ok("nothing is inserted, dropped or altered that a second run would trip on", !st.some((s) => /^(insert|drop table|drop index|alter table .* (add|drop) column|create function|create or replace function|create trigger)/.test(s)));
}

// ---------- grants and policies ----------
type Grant = { privs: string[]; tables: string[]; roles: string[] };
const grants: Grant[] = st.map((s) => s.match(/^grant (.+?) on (.+?) to (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const revokes: Grant[] = st.map((s) => s.match(/^revoke (.+?) on (.+?) from (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const privsOf = (role: string) => [...new Set(grants.filter((g) => g.roles.includes(role) && g.tables.includes("snl_library")).flatMap((g) => g.privs))].sort();
{
  for (const role of ["anon", "authenticated"]) ok(`all rights are revoked from ${role} first`, revokes.some((r) => r.privs.includes("all") && r.roles.includes(role) && r.tables.includes("snl_library")));
  const lastRevoke = Math.max(...st.map((s, i) => (/^revoke /.test(s) ? i : -1))), firstGrant = st.findIndex((s) => /^grant /.test(s));
  ok("the revoke comes before the grants", lastRevoke >= 0 && firstGrant > lastRevoke);
  ok("anon is granted nothing", !st.some((s) => /^grant\b/.test(s) && /\banon\b/.test(s)) && !st.some((s) => /with grant option|to public\b(?!\.)/.test(s)));
  ok("a login may only read", same(privsOf("authenticated"), ["select"]), privsOf("authenticated"));
  ok("the service role, which the function uses, can read and write", same(privsOf("service_role"), ["delete", "insert", "select", "update"]));
  const pols = st.filter((s) => s.startsWith("create policy"));
  ok("one policy: every login with a role reads every entry", pols.length === 1 && / on public\.snl_library for select to authenticated using \(public\.app_role\(\) is not null\)$/.test(pols[0]), pols);
  ok("no insert, update or delete policy for logins", !pols.some((p) => / for (insert|update|delete|all) /.test(p)));
}

// ---------- the columns match what the function writes ----------
const cols = (() => {
  const s = st.find((x) => x.startsWith("create table if not exists public.snl_library ("))!;
  const body = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of body) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out.map((c) => ({ name: c.split(" ")[0], def: c }));
})();
const def = (name: string) => cols.find((c) => c.name === name)?.def ?? "";
{
  const row = { job_id: "j", title: "t", question: "q", answer: answerCopy({}), model: null, asked_at: "", answered_at: "", saved_by: "u", saved_by_name: "n", tags: [], companies: [], search_text: "" };
  ok("the table has exactly the columns the function writes, plus id and the two times it sets", same(cols.map((c) => c.name).sort(), [...Object.keys(row), "id", "saved_at", "updated_at"].sort()), cols.map((c) => c.name));
  ok("what the page is sent is the columns but the answer and search text", same(Object.keys(entryOut({ ...row, id: "i", saved_at: "", updated_at: "" } as never)).sort(), cols.map((c) => c.name).filter((n) => n !== "answer" && n !== "search_text").sort()));
  ok("one entry per answer: a unique index on job_id", st.includes("create unique index if not exists snl_library_job on public.snl_library (job_id)"));
  ok("newest first is quick: an index on saved_at", st.includes("create index if not exists snl_library_saved on public.snl_library (saved_at desc)"));
  ok("the title limit matches the function's", def("title").includes(`length(title) between 1 and ${LIBRARY.title}`));
  ok("the question limit matches the one on a question", def("question").includes("length(question) between 1 and 4000"));
  ok("tags: a list of at most 5", def("tags").includes(`jsonb_array_length(tags) <= ${LIBRARY.tags}`) && def("tags").includes("jsonb_typeof(tags) = 'array'"));
  ok("companies: a list of at most 40", def("companies").includes(`jsonb_array_length(companies) <= ${LIBRARY.companies}`));
  const cap = Number(def("answer").match(/pg_column_size\(answer\) < (\d+)/)?.[1]);
  ok("the answer column backs up the function's 150 KB limit with room to spare", cap >= LIBRARY.maxBytes * 3 && cap <= 1_048_576, cap);
  ok("the search text fits however long the question", def("search_text").includes("length(search_text) <= 12000") && searchText("t".repeat(120), "q".repeat(4000), ["x".repeat(30)], Array(40).fill("c".repeat(120))).length <= 12000);
  ok("the saver's id is kept even if the login is later deleted (no cascade)", def("saved_by") === "saved_by uuid");
  ok("nothing records why an answer was saved", !cols.some((c) => /reason|why|purpose|deal|note/.test(c.name)));
}

done();
