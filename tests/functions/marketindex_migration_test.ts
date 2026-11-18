// Migration 0006 (supabase/migrations/0006_market_index.sql), read as text like watch_migration_test.ts reads 0003:
// row level security on, logins read only, the service role writes and runs the functions, anon gets nothing, safe to
// run twice, one open sweep at a time, the columns match what the snl-index function writes and every length limit
// fits what it keeps. Then the schedule file and the function's entry in config.toml. (The SQL itself was also run
// twice on a local Postgres 16 while building this, and its answers compared with the in-memory stand-in.)
import { indexRow } from "../../supabase/functions/_shared/marketindex.ts";
import { checks } from "./helpers/fakes.ts";
import { filing } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const root = new URL("../../supabase/", import.meta.url);
const raw = Deno.readTextFileSync(new URL("migrations/0006_market_index.sql", root));

/** SQL statements with comments removed, lower-cased and single-spaced. Function bodies ($$ ... $$) stay whole. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "", inBody = false;
  for (const line of sql.split("\n")) {
    const code = inBody ? line : line.replace(/--.*$/, "");
    for (const part of code.split(/(\$\$|;)/)) {
      if (part === "$$") { inBody = !inBody; cur += "$$"; }
      else if (part === ";" && !inBody) { if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " ").toLowerCase()); cur = ""; }
      else cur += part;
    }
    cur += "\n";
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " ").toLowerCase());
  return out;
}
const st = statements(raw);
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const bare = (t: string) => t.replace(/^public\./, "");
const tables = st.map((s) => s.match(/^create table (?:if not exists )?public\.(\w+)/)?.[1]).filter(Boolean) as string[];
const fns = st.map((s) => s.match(/^create or replace function public\.(\w+)\(/)?.[1]).filter(Boolean) as string[];

// ---------- tables, functions and row level security ----------
{
  ok("the migration creates the three index tables", same([...tables].sort(), ["snl_index_filings", "snl_index_states", "snl_index_sweeps"]), tables);
  for (const t of tables) ok(`${t} has row level security switched on`, st.includes(`alter table public.${t} enable row level security`));
  ok("row level security is never switched off or bypassed", !st.some((s) => /disable row level security|no force row level security|bypassrls/.test(s)));
  ok("it touches no table from earlier migrations", !st.some((s) => /public\.(profiles|snl_store|snl_usage|snl_throttle|snl_jobs|snl_job_state|snl_settings|snl_keepalive|snl_watch_\w+)\b/.test(s)));
  ok("its five functions: merge companies, join names, save filings, match a question, answer it", same([...fns].sort(), ["snl_index_match", "snl_index_merge", "snl_index_names", "snl_index_put", "snl_index_query"]), fns);
  ok("no function runs with raised rights", !st.some((s) => /security definer/.test(s)));
  ok("every function but the matcher pins its search path (the matcher stays plain SQL so Postgres can fold it into the query)",
    st.filter((s) => s.startsWith("create or replace function")).every((s) => s.includes("set search_path = public") !== s.startsWith("create or replace function public.snl_index_match(")));
}

// ---------- safe to run twice ----------
{
  ok("every table is created only if it isn't there", st.filter((s) => s.startsWith("create table")).every((s) => s.startsWith("create table if not exists public.")));
  const idx = st.filter((s) => /^create (unique )?index/.test(s));
  ok("every index is created only if it isn't there", idx.length === 3 && idx.every((s) => /^create (unique )?index if not exists /.test(s)), idx);
  ok("every function is created or replaced", st.filter((s) => /^create (or replace )?function/.test(s)).every((s) => s.startsWith("create or replace function")));
  const pols = st.filter((s) => s.startsWith("create policy"));
  ok("every policy is dropped first if it exists, so running again replaces it", pols.length === 3 && pols.every((p) => {
    const m = p.match(/^create policy "([^"]+)" on (public\.\w+)/)!;
    const drop = st.indexOf(`drop policy if exists "${m[1]}" on ${m[2]}`);
    return drop >= 0 && drop < st.indexOf(p);
  }));
  ok("nothing is inserted, dropped or altered that a second run would trip on", !st.some((s) => /^(insert|drop table|drop index|drop function|alter table .* (add|drop) column|create trigger)/.test(s)));
}

// ---------- grants ----------
type Grant = { privs: string[]; tables: string[]; roles: string[] };
const grants: Grant[] = st.map((s) => s.match(/^grant (.+?) on (?!function)(.+?) to (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const revokes: Grant[] = st.map((s) => s.match(/^revoke (.+?) on (?!function)(.+?) from (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const privsOf = (role: string, table: string) => [...new Set(grants.filter((g) => g.roles.includes(role) && g.tables.includes(table)).flatMap((g) => g.privs))].sort();
{
  for (const role of ["anon", "authenticated"]) ok(`every table has all rights revoked from ${role}`, tables.every((t) => revokes.some((r) => r.privs.includes("all") && r.roles.includes(role) && r.tables.includes(t))));
  const lastRevoke = Math.max(...st.map((s, i) => (/^revoke all on public\./.test(s) ? i : -1))), firstGrant = st.findIndex((s) => /^grant /.test(s));
  ok("the revoke comes before the grants", lastRevoke >= 0 && firstGrant > lastRevoke);
  ok("anon is granted nothing", !st.some((s) => /^grant\b/.test(s) && /\banon\b/.test(s)) && !st.some((s) => /with grant option|to public\b(?!\.)/.test(s)));
  for (const t of tables) ok(`a login may only read ${t}`, same(privsOf("authenticated", t), ["select"]), privsOf("authenticated", t));
  for (const t of tables) ok(`the service role, which the function uses, can read and write ${t}`, same(privsOf("service_role", t), ["delete", "insert", "select", "update"]));
  ok("only authenticated and service_role are named in table grants", grants.every((g) => g.roles.every((r) => ["authenticated", "service_role"].includes(r))));
  const fnRevoke = st.find((s) => s.startsWith("revoke all on function"))!, fnGrant = st.find((s) => s.startsWith("grant execute on function"))!;
  ok("the functions are taken from public, anon and logins, and given to the service role only", !!fnRevoke && fns.every((f) => fnRevoke.includes(`public.${f}(`)) && fnRevoke.endsWith("from public, anon, authenticated")
    && !!fnGrant && fns.every((f) => fnGrant.includes(`public.${f}(`)) && fnGrant.endsWith("to service_role"), { fnRevoke, fnGrant });
}

// ---------- policies ----------
{
  const pols = st.filter((s) => s.startsWith("create policy"));
  for (const t of tables) {
    const mine = pols.filter((p) => p.includes(` on public.${t} `));
    ok(`${t}: one policy, read only, for logins with a profile`, mine.length === 1 && / for select to authenticated using \(public\.app_role\(\) is not null\)$/.test(mine[0]), mine);
  }
  ok("no insert, update or delete policy for logins", !pols.some((p) => / for (insert|update|delete|all) /.test(p)));
}

// ---------- the columns match what the function writes ----------
const colsOf = (table: string) => {
  const s = st.find((x) => x.startsWith(`create table if not exists public.${table} (`))!;
  const body = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of body) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out.map((c) => ({ name: c.split(" ")[0], def: c })).filter((c) => !["primary", "check"].includes(c.name));
};
{
  const cols = colsOf("snl_index_filings");
  const row = indexRow(filing(1, { filingVersionId: "0E0E0E0E-0000-4000-8000-000000000001" }) as never, "FL", "00000000-0000-4000-a000-000000000001", "2026-11-18T09:00:00.000Z")!;
  ok("the filings table has exactly the columns of an index row, plus the joined company names", same(cols.map((c) => c.name).sort(), [...Object.keys(row), "company_names"].sort()), { table: cols.map((c) => c.name), row: Object.keys(row) });
  ok("a filing is kept once per state: (state, filing_key) is the primary key", st.some((s) => s.startsWith("create table if not exists public.snl_index_filings (") && s.includes("primary key (state, filing_key)")));
  ok("every question names a state and dates: there is an index on (state, publish_date)", st.includes("create index if not exists snl_index_filings_published on public.snl_index_filings (state, publish_date desc)"));
  ok("publish and effective dates are dates; rate impact is a number", ["date_submitted", "publish_date", "effective_new", "effective_renewal"].every((c) => cols.find((x) => x.name === c)!.def === `${c} date`) && cols.find((x) => x.name === "rate_impact")!.def.startsWith("rate_impact numeric"));
  // Every length limit in the table is at least what indexRow keeps, even for over-long made-up text.
  const long = indexRow(filing(2, { filingVersionId: "X".repeat(64), companyName: "N".repeat(500), typeOfInsurance: "I".repeat(500), subTypeOfInsurance: "U".repeat(500), serffFilingType: "T".repeat(500), filingStatus: "F".repeat(500),
    dispOverallRateImpact: "9".repeat(500), filingDescription: "Z".repeat(5000), trackingNumber: "K".repeat(500), sfcNumber: "S".repeat(500) }) as never, "FL", null, "2026-11-18T09:00:00.000Z")! as unknown as Record<string, unknown>;
  const limits = cols.map((c) => [c.name, Number(c.def.match(/length\(\w+\) <= (\d+)/)?.[1])] as const).filter(([, k]) => k > 0);
  ok("every free-text column has a length limit", limits.length === 9, limits);
  ok("what the function keeps always fits the table's limits", limits.every(([name, k]) => name === "company_names" || long[name] === null || String(long[name]).length <= k), limits.map(([name, k]) => [name, k, String(long[name]).length]));
  ok("the filing key and version id fit their patterns", /^[ve]:[A-Za-z0-9._-]{1,64}$/.test(String(long.filing_key)) && cols.find((c) => c.name === "filing_key")!.def.includes("'^[ve]:[a-za-z0-9._-]{1,64}$'"));
  ok("the description is kept to 1,000 characters", (long.description as string).length === 1000 && limits.some(([k, v]) => k === "description" && v === 1000));

  const sweeps = colsOf("snl_index_sweeps");
  ok("the record of sweeps has the columns the function writes", same(sweeps.map((c) => c.name).sort(), ["companies_total", "finished_at", "from_date", "id", "kind", "message", "missed", "next_unit", "period", "plan", "request", "requests", "resume_after", "rows_found", "stalls", "started_at", "state", "status", "to_date", "tries", "trigger", "units_total", "updated_at"]), sweeps.map((c) => c.name));
  ok("a sweep's status is one of running, waiting, held, done, failed or stopped", sweeps.find((c) => c.name === "status")!.def.includes("check (status in ('running', 'waiting', 'held', 'done', 'failed', 'stopped'))"));
  ok("only one sweep is unfinished at a time: a unique index on open rows", st.includes("create unique index if not exists snl_index_sweeps_one_open on public.snl_index_sweeps ((true)) where status in ('running', 'waiting', 'held')"));
  ok("where a paused sweep left off is kept with it: its plan and next batch", sweeps.some((c) => c.name === "plan" && c.def.startsWith("plan jsonb")) && sweeps.some((c) => c.name === "next_unit"));
  const states = colsOf("snl_index_states");
  ok("what the index covers, by state", same(states.map((c) => c.name).sort(), ["companies_covered", "companies_missed", "from_date", "last_complete_at", "last_sweep_id", "missed", "state", "to_date"]) && states.find((c) => c.name === "state")!.def.includes("primary key"));
  ok("saving merges companies and never asks logins: the put function inserts with on conflict", st.some((s) => s.startsWith("create or replace function public.snl_index_put(") && s.includes("on conflict (state, filing_key) do update set companies = public.snl_index_merge(f.companies, excluded.companies)")));
  ok("the query takes the four groupings and caps rows at 500", st.some((s) => s.startsWith("create or replace function public.snl_index_query(") && s.includes("if v_group not in ('rows', 'company', 'type', 'month')") && s.includes("least(greatest(coalesce((p->>'limit')::integer, 50), 1), 500)")));
}

// ---------- the schedule file and config.toml ----------
{
  const sched = Deno.readTextFileSync(new URL("index_schedule.sql", root));
  const code = sched.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ok("the schedule calls snl-index with placeholders, never real values", code.includes("https://YOUR_PROJECT_REF.supabase.co/functions/v1/snl-index") && code.includes("'YOUR_INDEX_SECRET'") && !/[a-z0-9]{20}\.supabase\.co/.test(sched), code);
  ok("the schedule sends its own secret in the x-index-secret header, from Vault", code.includes("'x-index-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'snl_index_secret')") && !code.includes("snl_watch_secret"));
  ok("the schedule asks for the scheduled action every 10 minutes", code.includes(`'{"action": "scheduled"}'::jsonb`) && code.includes("cron.schedule('snl-index-steps', '*/10 * * * *'"));
  ok("the schedule waits long enough for a step to finish", Number(code.match(/timeout_milliseconds := (\d+)/)?.[1]) >= 120000);
  ok("it says honestly what a top-up costs and recommends weekly or monthly", sched.includes("A top-up costs about as much as a sweep of a year") && sched.includes("weekly or monthly"));
  ok("the schedule says how to check it and how to stop it", sched.includes("cron.job_run_details") && sched.includes("cron.unschedule('snl-index-steps')"));
  const toml = Deno.readTextFileSync(new URL("config.toml", root));
  ok("config.toml deploys snl-index with the gateway's login check off, like the others", /\[functions\.snl-index\]\nverify_jwt = false/.test(toml));
}

done();
