// "Narrow it down" on the Market view, through the snl-index function's query action: several types of insurance and
// several states in one question. Each state is answered over what its own sweep covers, with its coverage; a state
// the index doesn't hold, or whose sweep misses the dates, is named and left out (never answered as empty); one state
// and one type are answered exactly as before; a database without migration 0009 is refused rather than answered
// wider than asked; malformed lists are refused. Then migration 0009 read as text: what it replaces and that it is safe
// to run twice. (The SQL was also run twice on a local Postgres 16 while building this, after 0006, and its answers
// to one state, several states with their own dates, several types and the company grouping checked by hand.)
import type { IndexRow, IndexState } from "../../supabase/functions/_shared/db.ts";
import { indexRow, MAX_QUERY_STATES, MAX_QUERY_TYPES, NEEDS_0009 } from "../../supabase/functions/_shared/marketindex.ts";
import { checks, reader } from "./helpers/fakes.ts";
import { F, same, world } from "./helpers/marketindex.ts";

const { ok, done } = checks();
const idx = (db: unknown) => db as { queries: any[]; filtersVersion: number; putIndexRows(r: IndexRow[]): Promise<void>; putIndexState(s: IndexState): Promise<void> };
const st = (state: string, from: string, to: string, missed = 0): IndexState => ({ state, from_date: from, to_date: to, last_complete_at: "2026-11-17T08:00:00Z", last_sweep_id: null, companies_covered: 400 - missed, companies_missed: missed,
  missed: missed ? [{ kind: "institutionId", id: 930099, name: "Nonesuch Missed Co" }] : [] });
const at = "2026-11-17T08:00:00Z";
const row = (i: number, state: string, toi: string, pub: string, who = { institutionId: 930005, name: "Nonesuch Carrier No. 5 Co" }, over: Record<string, unknown> = {}) =>
  indexRow(F(i, who, { serffFilingStateId: state, typeOfInsurance: toi, subTypeOfInsurance: null, publishDate: pub, ...over }) as any, state, null, at)!;

async function indexed() {
  const w = world(), d = idx(w.db);
  await d.putIndexRows([
    row(1, "FL", "Homeowners", "2026-03-01"), row(2, "FL", "Personal auto", "2026-04-01", { institutionId: 930006, name: "Nonesuch Carrier No. 6 Co" }, { serffFilingType: "Form", overallRateImpact: null }),
    row(3, "FL", "Commercial property", "2026-05-01"), row(4, "FL", "Homeowners", "2025-06-01"),
  ]);
  await d.putIndexRows([row(1, "TX", "Homeowners", "2026-05-01"), row(5, "TX", "Personal auto", "2026-06-01"), row(6, "TX", "Commercial property", "2026-07-01"), row(7, "TX", "Homeowners", "2025-02-01")]);
  await d.putIndexRows([row(8, "GA", "Homeowners", "2026-06-01")]);
  await d.putIndexState(st("FL", "2025-11-19", "2026-11-18"));
  await d.putIndexState(st("TX", "2026-01-01", "2026-11-18", 1));
  await d.putIndexState(st("GA", "2023-01-01", "2023-12-31"));
  return w;
}
const ask = (w: ReturnType<typeof world>, q: Record<string, unknown>) => w.call({ action: "query", ...q }, { whoIs: reader });

// ---------- one state, one type: as before ----------
{
  const w = await indexed();
  const a = await ask(w, { state: "FL", typeOfInsurance: "Homeowners" });
  const b = await ask(w, { states: ["FL"], typesOfInsurance: ["Homeowners"] });
  ok("one state and one type, old keys: answered as before", a.status === 200 && a.body.total === 1 && a.body.rows[0].publishDate === "2026-03-01" && !("coverages" in a.body) && !("states" in a.body.query) && a.body.query.typeOfInsurance === "Homeowners", a.body);
  ok("the same asked as lists of one: the same answer and the same question to the database", b.status === 200 && same({ ...b.body }, { ...a.body }) && same(idx(w.db).queries.at(-1), idx(w.db).queries.at(-2)), b.body.query);
  idx(w.db).filtersVersion = 0;
  ok("one state and one type need no database update", (await ask(w, { states: ["FL"], typesOfInsurance: ["Homeowners"] })).status === 200);
}

// ---------- several types in one state ----------
{
  const w = await indexed();
  const r = await ask(w, { states: ["FL"], typesOfInsurance: ["Homeowners", "personal auto", "Homeowners"] });
  ok("two types in Florida: filings of either, nothing else", r.status === 200 && r.body.total === 2 && same(r.body.rows.map((x: any) => x.typeOfInsurance), ["Personal auto", "Homeowners"]), r.body);
  ok("the types are sent to the database as a list, the one-type filter left empty", same(idx(w.db).queries.at(-1).types, ["Homeowners", "personal auto"]) && idx(w.db).queries.at(-1).typeOfInsurance === null);
  ok("the answer says what was asked and the coverage of Florida", same(r.body.query.states, ["FL"]) && same(r.body.coverages.map((c: any) => c.state), ["FL"]) && r.body.coverage.state === "FL");
  const none = await ask(w, { states: ["FL"], typesOfInsurance: ["Inland marine", "Boiler"] });
  ok("nothing matches: says so for these types in this state, and that it isn't proof", none.status === 200 && none.body.total === 0 && none.body.notes.some((n: string) => /No filing in the index matches "Inland marine" and "Boiler" in FL\. That isn't proof/.test(n)), none.body.notes);
}

// ---------- several states, each over its own sweep ----------
{
  const w = await indexed();
  const r = await ask(w, { states: ["tx", "FL"], typesOfInsurance: ["Homeowners"] });
  ok("Florida and Texas homeowners: each state's filings over its own sweep", r.status === 200 && r.body.total === 2 && same(r.body.rows.map((x: any) => `${x.serffFilingStateId} ${x.publishDate}`), ["TX 2026-05-01", "FL 2026-03-01"]), r.body.rows?.map((x: any) => x.publishDate));
  ok("filings from before a state's own sweep began aren't counted", !r.body.rows.some((x: any) => x.publishDate === "2025-02-01" || x.publishDate === "2025-06-01"));
  const q = idx(w.db).queries.at(-1);
  ok("the database is asked with each state's own dates", same(q.scope, [{ state: "FL", from: "2025-11-19", to: "2026-11-18" }, { state: "TX", from: "2026-01-01", to: "2026-11-18" }]) || same(q.scope, [{ state: "FL", from: "2025-11-19", to: "2026-11-18" }, { state: "TX", from: "2026-01-01", to: "2026-11-18" }]), q.scope);
  ok("a coverage line for each state", same(r.body.coverages.map((c: any) => c.state), ["FL", "TX"]) && r.body.coverages.every((c: any) => /^The market index of (FL|TX) holds filings published/.test(c.sentence)));
  ok("the different periods are said", r.body.notes.some((n: string) => /each state is answered over its own: FL 19 Nov 2025 to 18 Nov 2026; TX 1 Jan 2026 to 18 Nov 2026/.test(n)), r.body.notes);
  ok("companies a state's sweep missed are named for that state", r.body.notes.some((n: string) => /^In TX, 1 company in the list wasn't covered.*Nonesuch Missed Co/.test(n)));
  const byCo = await ask(w, { states: ["FL", "TX"], typesOfInsurance: ["Homeowners"], group: "company" });
  ok("by company: a filing in two states counts once in each", byCo.status === 200 && byCo.body.groups[0].name === "Nonesuch Carrier No. 5 Co" && byCo.body.groups[0].filings === 2);
  const all = await ask(w, { states: ["FL", "TX"] });
  ok("two states, every type: every filing in both sweeps", all.status === 200 && all.body.total === 6 && !idx(w.db).queries.at(-1).types?.length);
}

// ---------- states the index can't answer are named, never answered as empty ----------
{
  const w = await indexed();
  const r = await ask(w, { states: ["FL", "NY", "GA"], typesOfInsurance: ["Homeowners"], from: "2026-01-01" });
  ok("a state not in the index and a state whose sweep misses the dates: named, left out", r.status === 200 && same(r.body.notIndexed, ["NY"]) && same(r.body.outOfRange, ["GA"]) && same(r.body.coverages.map((c: any) => c.state), ["FL"]), r.body);
  ok("…and said in the notes", r.body.notes.some((n: string) => /^NY isn't in the market index, so it isn't in this answer \(not answered as empty\)/.test(n)) && r.body.notes.some((n: string) => /^The index of GA doesn't cover these dates/.test(n)), r.body.notes);
  ok("the dates are cut to the state's own sweep", same(idx(w.db).queries.at(-1).scope, [{ state: "FL", from: "2026-01-01", to: "2026-11-18" }]));
  const none = await ask(w, { states: ["NY", "OH"] });
  ok("no state the index holds: refused, naming them and what the index covers", none.status === 404 && none.body.error === "not_indexed" && /^NY and OH aren't in the market index/.test(none.body.message) && same(none.body.indexed, ["FL", "GA", "TX"]), none.body);
  const out = await ask(w, { states: ["GA", "TX"], from: "2020-01-01", to: "2020-12-31" });
  ok("dates outside every state's sweep: refused, with each state's period", out.status === 400 && out.body.error === "out_of_range" && /GA: 1 Jan 2023 to 31 Dec 2023; TX: 1 Jan 2026 to 18 Nov 2026/.test(out.body.message), out.body.message);
}

// ---------- the database without migration 0009 ----------
{
  const w = await indexed();
  idx(w.db).filtersVersion = 0;
  const r = await ask(w, { states: ["FL", "TX"], typesOfInsurance: ["Homeowners"] });
  ok("several states before migration 0009: refused, saying what to run, never answered wider", r.status === 400 && r.body.error === "needs_update" && r.body.message === NEEDS_0009 && !("rows" in r.body));
  ok("…and several types too", (await ask(w, { states: ["FL"], typesOfInsurance: ["Homeowners", "Personal auto"] })).body.error === "needs_update");
}

// ---------- malformed lists ----------
{
  const w = await indexed();
  for (const [name, q, says] of [["a state by name", { states: ["Florida"] }, /two-letter codes/], ["no states", { states: [] }, /two-letter codes/], [`${MAX_QUERY_STATES + 1} states`, { states: Array.from({ length: MAX_QUERY_STATES + 1 }, (_, i) => String.fromCharCode(65 + (i % 26)) + "A") }, /at most 10/],
    ["types not a list", { state: "FL", typesOfInsurance: "Homeowners" }, /names from the index's list/], ["a type of punctuation", { state: "FL", typesOfInsurance: ["Homeowners", "%%"] }, /names from the index's list/],
    [`${MAX_QUERY_TYPES + 1} types`, { state: "FL", typesOfInsurance: Array.from({ length: MAX_QUERY_TYPES + 1 }, (_, i) => `Type ${i}`) }, /at most 20/]] as const) {
    const r = await ask(w, q);
    ok(`malformed (${name}): 400 bad`, r.status === 400 && r.body.error === "bad" && says.test(r.body.message), r.body);
  }
  const evil = await ask(w, { states: ["FL"], typesOfInsurance: ["<img src=x onerror=alert(1)>", "Homeowners"] });
  ok("a hostile type name is only matched as text: it finds nothing of its own", evil.status === 200 && evil.body.total === 1);
}

// ---------- migration 0009, read as text ----------
{
  const raw = Deno.readTextFileSync(new URL("../../supabase/migrations/0009_market_filters.sql", import.meta.url));
  const code = raw.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").toLowerCase();
  const made = [...code.matchAll(/create (or replace )?(\w+)/g)].map((m) => `${m[1] ? "or replace " : ""}${m[2]}`);
  ok("0009 only replaces the two query functions: no table, policy or index", made.every((m) => m === "or replace function") && /function public\.snl_index_match\(p jsonb\)/.test(code) && /function public\.snl_index_query\(p jsonb\)/.test(code), made);
  ok("0009 is safe to run twice: create or replace only, nothing dropped", !/\bdrop\b|\balter table\b|\binsert\b|\bdelete\b|\bupdate\b/.test(code.replace(/set search_path = public/g, "")));
  ok("0009 keeps the functions to the service role; anon and logins get nothing", /revoke all on function public\.snl_index_match\(jsonb\), public\.snl_index_query\(jsonb\) from public, anon, authenticated/.test(code) && /grant execute on function public\.snl_index_match\(jsonb\), public\.snl_index_query\(jsonb\) to service_role/.test(code) && !/to (anon|authenticated)\b/.test(code));
  ok("0009 answers say filters 2, scope and types are read, and a question without them is answered as 0006 does", /'filters', 2/.test(code) && /p->'scope'/.test(code) && /p->'types'/.test(code) && /f\.state = p->>'state'/.test(code) && /lower\(p->>'typeofinsurance'\)/.test(code));
  ok("0009 counts a filing in two states once in each when grouping by company", /count\(distinct m\.state \|\| '\|' \|\| m\.filing_key\)/.test(code));
}

done();
