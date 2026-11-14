// Migration 0003 (supabase/migrations/0003_watchlist.sql), read as text like migration_test.ts reads 0001: row level
// security on, logins read only, the service role writes, anon gets nothing, safe to run twice, and the columns
// match what the snl-watch function writes. Then the schedule file and the function's entry in config.toml.
import { foundRow } from "../../supabase/functions/_shared/watch.ts";
import { checks } from "./helpers/fakes.ts";
import { filing } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const root = new URL("../../supabase/", import.meta.url);
const raw = Deno.readTextFileSync(new URL("migrations/0003_watchlist.sql", root));

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

// ---------- tables and row level security ----------
{
  ok("the migration creates the two watchlist tables", same([...tables].sort(), ["snl_watch_found", "snl_watch_runs"]), tables);
  for (const t of tables) ok(`${t} has row level security switched on`, st.includes(`alter table public.${t} enable row level security`));
  ok("row level security is never switched off or bypassed", !st.some((s) => /disable row level security|no force row level security|bypassrls/.test(s)));
  ok("it touches no table from migration 0001 or 0002", !st.some((s) => /public\.(profiles|snl_store|snl_usage|snl_throttle|snl_jobs|snl_job_state|snl_settings|snl_keepalive)\b/.test(s)), st.filter((s) => /public\.(profiles|snl_store|snl_usage|snl_jobs|snl_settings)\b/.test(s)));
}

// ---------- safe to run twice ----------
{
  ok("every table is created only if it isn't there", st.filter((s) => s.startsWith("create table")).every((s) => s.startsWith("create table if not exists public.")));
  ok("every index is created only if it isn't there", st.filter((s) => /^create (unique )?index/.test(s)).every((s) => /^create (unique )?index if not exists /.test(s)) && st.filter((s) => /^create (unique )?index/.test(s)).length === 4);
  const pols = st.filter((s) => s.startsWith("create policy"));
  ok("every policy is dropped first if it exists, so running again replaces it", pols.length === 2 && pols.every((p) => {
    const m = p.match(/^create policy "([^"]+)" on (public\.\w+)/)!;
    return st.indexOf(`drop policy if exists "${m[1]}" on ${m[2]}`) >= 0 && st.indexOf(`drop policy if exists "${m[1]}" on ${m[2]}`) < st.indexOf(p);
  }));
  ok("nothing is inserted, dropped or altered that a second run would trip on", !st.some((s) => /^(insert|drop table|drop index|alter table .* (add|drop) column|create function|create trigger)/.test(s)));
}

// ---------- grants ----------
type Grant = { privs: string[]; tables: string[]; roles: string[] };
const grants: Grant[] = st.map((s) => s.match(/^grant (.+?) on (?!function)(.+?) to (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const revokes: Grant[] = st.map((s) => s.match(/^revoke (.+?) on (?!function)(.+?) from (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const privsOf = (role: string, table: string) => [...new Set(grants.filter((g) => g.roles.includes(role) && g.tables.includes(table)).flatMap((g) => g.privs))].sort();
{
  for (const role of ["anon", "authenticated"]) ok(`both tables have all rights revoked from ${role}`, tables.every((t) => revokes.some((r) => r.privs.includes("all") && r.roles.includes(role) && r.tables.includes(t))));
  const lastRevoke = Math.max(...st.map((s, i) => (/^revoke /.test(s) ? i : -1))), firstGrant = st.findIndex((s) => /^grant /.test(s));
  ok("the revoke comes before the grants", lastRevoke >= 0 && firstGrant > lastRevoke);
  ok("anon is granted nothing", !st.some((s) => /^grant\b/.test(s) && /\banon\b/.test(s)) && !st.some((s) => /with grant option|to public\b(?!\.)/.test(s)));
  for (const t of tables) ok(`a login may only read ${t}`, same(privsOf("authenticated", t), ["select"]), privsOf("authenticated", t));
  for (const t of tables) ok(`the service role, which the function uses, can read and write ${t}`, same(privsOf("service_role", t), ["delete", "insert", "select", "update"]));
  ok("only authenticated and service_role are named in grants", grants.every((g) => g.roles.every((r) => ["authenticated", "service_role"].includes(r))));
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
  return out.map((c) => ({ name: c.split(" ")[0], def: c }));
};
{
  const found = colsOf("snl_watch_found"), runs = colsOf("snl_watch_runs");
  const row = foundRow(filing(1, { filingVersionId: "0C0C0C0C-0000-4000-8000-000000000001" }) as never, "run", "2026-11-13T12:00:00.000Z", false)!;
  ok("the found table has exactly the columns a found filing has", same(found.map((c) => c.name).sort(), Object.keys(row).sort()), { table: found.map((c) => c.name), row: Object.keys(row) });
  ok("the found table keeps what the page needs to show and open a filing", ["companies", "state", "filing_type", "type_of_insurance", "filing_status", "date_submitted", "publish_date", "effective_new", "effective_renewal", "rate_impact", "description", "tracking_number", "document_id", "filing_version_id", "first_seen_at", "baseline"].every((c) => found.some((x) => x.name === c)));
  ok("a filing version is found once: it is the primary key", found.find((c) => c.name === "filing_version_id")!.def.includes("primary key"));
  ok("the record of checks has the columns the function writes", same(runs.map((c) => c.name).sort(), ["baseline", "complete", "emailed", "finished_at", "found", "id", "message", "new_count", "requests", "scope", "started_at", "status", "trigger"]), runs.map((c) => c.name));
  ok("a check's status is one of running, ok, failed or skipped", runs.find((c) => c.name === "status")!.def.includes("check (status in ('running', 'ok', 'failed', 'skipped'))"));
  ok("only one check runs at a time: a unique index on running rows", st.includes("create unique index if not exists snl_watch_runs_one_running on public.snl_watch_runs ((status)) where status = 'running'"));
  ok("a found filing points at the check that found it, and survives that check being cleared", found.find((c) => c.name === "run_id")!.def === "run_id uuid references public.snl_watch_runs (id) on delete set null");

  // Every length limit in the table is at least what foundRow keeps, even for over-long made-up text.
  const long = foundRow(filing(2, { filingVersionId: "X".repeat(64), companyName: "N".repeat(500), serffFilingState: "S".repeat(500), serffFilingType: "T".repeat(500), typeOfInsurance: "I".repeat(500), subTypeOfInsurance: "U".repeat(500), filingStatus: "F".repeat(500),
    dateSubmitted: "D".repeat(500), publishDate: "P".repeat(500), newBusReqEffDate: "E".repeat(500), renewBusReqEffDate: "R".repeat(500), dispOverallRateImpact: "9".repeat(500), filingDescription: "Z".repeat(5000), trackingNumber: "K".repeat(500) }) as never, "run", "2026-11-13T12:00:00.000Z", false)! as Record<string, unknown>;
  const limits = found.map((c) => [c.name, Number(c.def.match(/length\(\w+\) <= (\d+)/)?.[1])] as const).filter(([, n]) => n > 0);
  ok("every free-text column has a length limit", limits.length === 12, limits);
  ok("what the function keeps always fits the table's limits", limits.every(([name, n]) => long[name] === null || String(long[name]).length <= n), limits.map(([name, n]) => [name, n, String(long[name]).length]));
  ok("the description is kept to 300 characters", (long.description as string).length === 300 && limits.some(([n, v]) => n === "description" && v === 300));
}

// ---------- the schedule file ----------
{
  const sched = Deno.readTextFileSync(new URL("watch_schedule.sql", root));
  const code = sched.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ok("the schedule calls snl-watch with placeholders, never real values", code.includes("https://YOUR_PROJECT_REF.supabase.co/functions/v1/snl-watch") && code.includes("'YOUR_WATCH_SECRET'") && !/[a-z0-9]{20}\.supabase\.co/.test(sched), code);
  ok("the schedule sends the secret in the x-watch-secret header, from Vault", code.includes("'x-watch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'snl_watch_secret')"));
  ok("the schedule runs once a day", /cron\.schedule\('snl-watchlist-daily', '\d{1,2} \d{1,2} \* \* \*'/.test(code));
  ok("the schedule waits long enough for a check to finish", /timeout_milliseconds := (\d+)/.test(code) && Number(code.match(/timeout_milliseconds := (\d+)/)![1]) >= 120000);
  ok("the schedule says how to check it and how to stop it", sched.includes("cron.job_run_details") && sched.includes("cron.unschedule('snl-watchlist-daily')"));
  const toml = Deno.readTextFileSync(new URL("config.toml", root));
  ok("config.toml deploys snl-watch with the gateway's login check off, like the others", /\[functions\.snl-watch\]\nverify_jwt = false/.test(toml));
}

done();
