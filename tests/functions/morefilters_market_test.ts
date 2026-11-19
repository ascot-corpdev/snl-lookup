// "Narrow it down" by filing type and status on the Market view, through the snl-index function's query action:
// several filing types and several statuses in one question, chosen from the names the index holds (groups "ftype" and
// "status" list them), each matched by its whole name in any letter case, so "Approved" never matches "Disapproved"
// and "Rate" not "Rate/Rule"; the one filing type and status words work as before, with or without migration 0010; a
// database without 0010 is refused, saying what to run, rather than answered wider than asked; malformed lists are
// refused; the empty-result note names the filing types and statuses. Then migration 0010 read as text: what it
// replaces and that it is safe to run twice. (The SQL was also run twice on a local Postgres 16 while building this,
// after 0006 and 0009, and its answers to the lists, the old texts, the two groups and a wrong group checked by hand.)
import type { IndexRow, IndexState } from "../../supabase/functions/_shared/db.ts";
import { indexRow, MAX_QUERY_KINDS, NEEDS_0009, NEEDS_0010 } from "../../supabase/functions/_shared/marketindex.ts";
import { checks, reader } from "./helpers/fakes.ts";
import { F, same, world } from "./helpers/marketindex.ts";

const { ok, done } = checks();
const idx = (db: unknown) => db as { queries: any[]; filtersVersion: number; putIndexRows(r: IndexRow[]): Promise<void>; putIndexState(s: IndexState): Promise<void> };
const st = (state: string): IndexState => ({ state, from_date: "2025-11-19", to_date: "2026-11-18", last_complete_at: "2026-11-17T08:00:00Z", last_sweep_id: null, companies_covered: 400, companies_missed: 0, missed: [] });
const at = "2026-11-17T08:00:00Z", who = { institutionId: 930005, name: "Nonesuch Carrier No. 5 Co" };
const row = (i: number, state: string, type: string, status: string, pub = "2026-06-01") =>
  indexRow(F(i, who, { serffFilingStateId: state, typeOfInsurance: "Homeowners", subTypeOfInsurance: null, serffFilingType: type, filingStatus: status, publishDate: pub }) as any, state, null, at)!;

async function indexed(version = 3) {
  const w = world(), d = idx(w.db);
  d.filtersVersion = version;
  await d.putIndexRows([row(1, "FL", "Rate", "Approved"), row(2, "FL", "Rate/Rule", "Disapproved"), row(3, "FL", "Form", "Pending"), row(4, "FL", "rate", "approved")]);
  await d.putIndexRows([row(5, "TX", "Rule", "Approved"), row(6, "TX", "Form", "Withdrawn")]);
  await d.putIndexState(st("FL"));
  await d.putIndexState(st("TX"));
  return w;
}
const ask = (w: ReturnType<typeof world>, q: Record<string, unknown>) => w.call({ action: "query", ...q }, { whoIs: reader });
const keys = (r: any) => (r.body.rows ?? []).map((x: any) => `${x.serffFilingType}/${x.filingStatus}`).sort();

// ---------- the index's own lists of filing types and statuses ----------
{
  const w = await indexed();
  const ft = await ask(w, { state: "FL", group: "ftype" }), fs = await ask(w, { states: ["FL", "TX"], group: "status" });
  ok("group ftype lists the filing types the index holds, the most first", ft.status === 200 && same(ft.body.groups.map((g: any) => g.name).sort(), ["Form", "Rate", "Rate/Rule", "rate"]) && ft.body.groupTotal === 4, ft.body);
  ok("group status lists the statuses, over several states", fs.status === 200 && same(fs.body.groups.map((g: any) => `${g.name}:${g.filings}`).sort(), ["Approved:2", "Disapproved:1", "Pending:1", "Withdrawn:1", "approved:1"]), fs.body.groups);
}

// ---------- several filing types and statuses ----------
{
  const w = await indexed();
  const r = await ask(w, { state: "FL", filingTypes: ["Rate"] });
  ok("a filing type from the list matches its whole name in any letter case: Rate and rate, not Rate/Rule", r.status === 200 && same(keys(r), ["Rate/Approved", "rate/approved"]), keys(r));
  ok("the database is asked with the list, the one filing type left empty", same(idx(w.db).queries.at(-1).filingTypes, ["Rate"]) && idx(w.db).queries.at(-1).filingType === null && same(r.body.query.filingTypes, ["Rate"]));
  const s = await ask(w, { state: "FL", statuses: ["Approved"] });
  ok("a status matches its whole name: Approved never matches Disapproved", same(keys(s), ["Rate/Approved", "rate/approved"]), keys(s));
  const both = await ask(w, { states: ["FL", "TX"], filingTypes: ["Rule", "Form"], statuses: ["Approved", "Pending"] });
  ok("several of each over several states: either filing type, either status", both.status === 200 && same(keys(both), ["Form/Pending", "Rule/Approved"]) && same(both.body.coverages.map((c: any) => c.state), ["FL", "TX"]), keys(both));
  const none = await ask(w, { state: "FL", filingTypes: ["Rule"], statuses: ["Withdrawn"] });
  ok("nothing matches: the note names the filing types and statuses, and that it says nothing about others", none.status === 200 && none.body.total === 0
    && none.body.notes.some((n: string) => /No filing in the index matches filing type "Rule" and status "Withdrawn" in FL\. That isn't proof.*or other filing types and statuses\./.test(n)), none.body.notes);
}

// ---------- the one filing type and status words, as before ----------
{
  const w = await indexed(2);
  const r = await ask(w, { state: "FL", filingType: "Rate", status: "approv" });
  ok("before 0010, the one filing type and status words still work, matched anywhere as always", r.status === 200 && same(keys(r), ["Rate/Approved", "Rate/Rule/Disapproved", "rate/approved"]), keys(r));
  ok("…and are asked as before: no lists", !("filingTypes" in idx(w.db).queries.at(-1)) && !("statuses" in idx(w.db).queries.at(-1)));
  const many = await ask(w, { states: ["FL", "TX"], filingType: "Form" });
  ok("several states with the one filing type: as 0009 answers it", many.status === 200 && same(keys(many), ["Form/Pending", "Form/Withdrawn"]));
}

// ---------- the database without migration 0010 ----------
{
  const w = await indexed(2);
  const r = await ask(w, { state: "FL", filingTypes: ["Rate"] });
  ok("filing types from the list before migration 0010: refused, saying what to run, never answered wider", r.status === 400 && r.body.error === "needs_update" && r.body.message === NEEDS_0010 && !("rows" in r.body), r.body);
  ok("…and statuses too", (await ask(w, { states: ["FL", "TX"], statuses: ["Approved"] })).body.message === NEEDS_0010);
  const g = await ask(w, { state: "FL", group: "status" });
  ok("asking for the list of statuses before 0010: the same message, not a failure", g.status === 400 && g.body.error === "needs_update" && g.body.message === NEEDS_0010, g.body);
  idx(w.db).filtersVersion = 0;
  ok("before 0009 as well: still says 0010 for the lists", (await ask(w, { state: "FL", filingTypes: ["Rate"] })).body.message === NEEDS_0010);
  ok("…and 0009 for several states alone, as before", (await ask(w, { states: ["FL", "TX"] })).body.message === NEEDS_0009);
}

// ---------- malformed lists ----------
{
  const w = await indexed();
  for (const [name, q, says] of [["filing types not a list", { state: "FL", filingTypes: "Rate" }, /Filing types must be names from the index's list/], ["a status of punctuation", { state: "FL", statuses: ["Approved", "%%"] }, /Statuses must be names from the index's list/],
    [`${MAX_QUERY_KINDS + 1} statuses`, { state: "FL", statuses: Array.from({ length: MAX_QUERY_KINDS + 1 }, (_, i) => `Status ${i}`) }, /at most 20/], ["a filing type as a number", { state: "FL", filingTypes: [1] }, /Filing types must be names/],
    ["an unknown group", { state: "FL", group: "nope" }, /Group by company, type, filing type, status or month/]] as const) {
    const r = await ask(w, q);
    ok(`malformed (${name}): 400 bad`, r.status === 400 && r.body.error === "bad" && says.test(r.body.message), r.body);
  }
  const evil = await ask(w, { state: "FL", statuses: ["<img src=x onerror=alert(1)>", "Pending"] });
  ok("a hostile status name is only matched as text: it finds nothing of its own", evil.status === 200 && same(keys(evil), ["Form/Pending"]));
}

// ---------- migration 0010, read as text ----------
{
  const raw = Deno.readTextFileSync(new URL("../../supabase/migrations/0010_market_more_filters.sql", import.meta.url));
  const code = raw.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").toLowerCase();
  const made = [...code.matchAll(/create (or replace )?(\w+)/g)].map((m) => `${m[1] ? "or replace " : ""}${m[2]}`);
  ok("0010 only replaces the two query functions: no table, policy or index", made.length === 2 && made.every((m) => m === "or replace function") && /function public\.snl_index_match\(p jsonb\)/.test(code) && /function public\.snl_index_query\(p jsonb\)/.test(code), made);
  ok("0010 is safe to run twice: create or replace only, nothing dropped", !/\bdrop\b|\balter table\b|\binsert\b|\bdelete\b|\bupdate\b/.test(code.replace(/set search_path = public/g, "")));
  ok("0010 keeps the functions to the service role; anon and logins get nothing", /revoke all on function public\.snl_index_match\(jsonb\), public\.snl_index_query\(jsonb\) from public, anon, authenticated/.test(code) && /grant execute on function public\.snl_index_match\(jsonb\), public\.snl_index_query\(jsonb\) to service_role/.test(code) && !/to (anon|authenticated)\b/.test(code));
  ok("0010 answers say filters 3 and read the two lists as whole names", /'filters', 3/.test(code) && /p->'filingtypes'/.test(code) && /p->'statuses'/.test(code) && /lower\(btrim\(coalesce\(f\.filing_type, ''\)\)\) = lower\(btrim\(t\.name\)\)/.test(code) && /lower\(btrim\(coalesce\(f\.filing_status, ''\)\)\) = lower\(btrim\(t\.name\)\)/.test(code));
  ok("0010 still answers what 0009 answers: scope, types, and the one filing type and status texts", /p->'scope'/.test(code) && /p->'types'/.test(code) && /lower\(p->>'filingtype'\)/.test(code) && /lower\(p->>'status'\)/.test(code));
  ok("0010 adds the groups ftype and status and keeps the others", /v_group not in \('rows', 'company', 'type', 'month', 'ftype', 'status'\)/.test(code) && /coalesce\(m\.filing_type, 'n\/d'\)/.test(code) && /coalesce\(m\.filing_status, 'n\/d'\)/.test(code));
}

done();
