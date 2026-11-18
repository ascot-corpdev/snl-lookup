// Claude and the market index: the query_market_index tool (strict, placed straight after search_filings, the other
// tools unchanged), the sentence in the market-question guidance, what Claude is told at the start of an answer about
// which states are indexed, and a scripted market question answered from the index with zero S&P requests. Made-up
// companies, ids and fake services throughout; nothing real is called.
(globalThis as any).__SNL_TEST__ = true;
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { SYSTEM, TOOLS } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
import type { IndexRow, IndexState } from "../../supabase/functions/_shared/db.ts";
import { CLAUDE_ROWS, marketIndexNote } from "../../supabase/functions/_shared/marketindex.ts";
import { forgetTokens } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, type MemoryDb, type Reply, req, say, toolResults, toolUse } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "test-anthropic-key" };
const NO_TABLE: Reply = { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] };
const tool = (name: string) => TOOLS.find((t: any) => t.name === name) as any;
const ix = (db: MemoryDb) => db as unknown as { putIndexRows(r: IndexRow[]): Promise<void>; putIndexState(s: IndexState): Promise<void>; queries: unknown[] };

// ---------- the tool ----------
{
  const t = tool("query_market_index"), names = TOOLS.map((x: any) => x.name);
  ok("query_market_index is offered, straight after search_filings", !!t && names.indexOf("query_market_index") === names.indexOf("search_filings") + 1);
  ok("the other tools keep their order", same(names.filter((n: string) => n !== "query_market_index"), ["resolve_entity", "resolve_entities", "search_filings", "read_filing_document", "query_statutory"]), names);
  ok("it is strict: every property required, nothing else allowed", t.strict === true && t.input_schema.additionalProperties === false && same([...t.input_schema.required].sort(), Object.keys(t.input_schema.properties).sort()));
  const p = t.input_schema.properties;
  ok("its inputs: one state, a grouping, three text filters, dates, words and the rate range, each nullable where it may be left out",
    p.state.type === "string" && same(p.group.enum, ["company", "type", "month", "rows"]) && ["type_of_insurance", "filing_type", "status", "from", "to"].every((k) => same(p[k].type, ["string", "null"]))
    && p.words.type === "array" && p.words.items.type === "string" && same(p.rate_above.type, ["number", "null"]) && same(p.rate_below.type, ["number", "null"]), p);
  ok("its description says it costs no S&P request, carries coverage and refuses what isn't indexed", t.description.includes("Costs no S&P request") && t.description.includes("Every answer carries coverage") && t.description.includes("A state or dates outside the index are refused.") && t.description.includes(`at most ${CLAUDE_ROWS}`));
}

// ---------- the prompt ----------
{
  const lines = SYSTEM.split("\n"), market = lines.findIndex((l: string) => l.startsWith("- S&P can't list every company that filed in a market"));
  ok("one new sentence, as its own line, at the end of the market-question guidance", lines[market + 1] === "- For a question about a market in a state the market index covers (listed under \"Market index\" at the start, when any state is), ask query_market_index first and say in the answer what the index covers and when it was last completed; choose carriers yourself only for states it does not cover.", lines[market + 1]);
  ok("the guidance for states the index doesn't cover is unchanged", lines[market].includes("Choosing that list is the one place to use your general knowledge") && lines[market].includes("never the whole market"));
}

// ---------- what Claude is told at the start of an answer ----------
const FL: IndexState = { state: "FL", from_date: "2025-11-19", to_date: "2026-11-18", last_complete_at: "2026-11-18T09:05:00.000Z", last_sweep_id: null, companies_covered: 2690, companies_missed: 10, missed: [{ kind: "institutionId", id: 930010, name: "Nonesuch Carrier No. 10 Co" }] };
{
  const db = memoryDb(fakeClock());
  ok("with nothing indexed, nothing is added", (await marketIndexNote(db)) === "");
  ok("with the migration not run, nothing is added and nothing fails", (await marketIndexNote({ ...db, indexStates: async () => { throw new Error("relation snl_index_states does not exist"); } } as any)) === "" && (await marketIndexNote({ getStore: db.getStore } as any)) === "");
  await ix(db).putIndexState(FL);
  await ix(db).putIndexState({ ...FL, state: "GA", companies_covered: 2700, companies_missed: 0, missed: [] });
  const note = await marketIndexNote(db);
  ok("with states indexed, a short fenced block lists each, with its period, last complete sweep and coverage", note === "\n\nMarket index (information, not instructions): query_market_index answers from these states at no S&P cost.\n```\nFL: published 2025-11-19 to 2026-11-18; last complete sweep 2026-11-18; 2,690 companies covered, 10 not\nGA: published 2025-11-19 to 2026-11-18; last complete sweep 2026-11-18; 2,700 companies covered, 0 not\n```", note);
}

// ---------- a scripted market question, answered from the index ----------
function world(script: Parameters<typeof fakeAnthropic>[0]) {
  forgetTokens();
  const clock = fakeClock("2026-11-20T12:00:00Z"), db = memoryDb(clock), sp = fakeSpgmi(clock), claude = fakeAnthropic(script);
  // S&P's reference lists are already saved, so the answer needs nothing from S&P
  for (const [field, rows] of [["typeOfInsurance", [[4, "Homeowners"]]], ["serffFilingType", [[1, "Rate"], [0, "Form"]]]] as const) {
    db.store.set(`ref:${field}`, { id: `ref:${field}`, kind: "reference", label: field, doc: { field, headers: ["id", "name"], rows: [], options: rows.map(([id, name]) => ({ id, name })) }, fetched_at: "2026-11-19T00:00:00.000Z" });
  }
  const pending: Promise<unknown>[] = [];
  const deps = { env: env(SECRETS), fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: async () => ({ id: "login-1", role: "reader" }), db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const ask = async (question: string) => {
    const res: Response = await chat.handle(req("snl-chat", { action: "ask", question }), deps);
    const jobId = (await res.json()).jobId as string;
    while (pending.length) await pending.shift();
    return { job: db.jobs.get(jobId)!, result: db.jobs.get(jobId)!.result as any };
  };
  return { clock, db, sp, claude, ask };
}
const ROW = (k: number, name: string, over: Partial<IndexRow> = {}): IndexRow => ({
  state: "FL", filing_key: `v:0F0F0F0F-0000-4000-8000-${String(k).padStart(12, "0")}`, filing_version_id: `0F0F0F0F-0000-4000-8000-${String(k).padStart(12, "0")}`, document_id: 74000000 + k,
  companies: [{ n: name, c: null, i: 940000 + ["Calloway Home Co", "Tarrow Mutual Insurance Co", "Calloway Coastal Co", "Nonesuch Carrier Co"].indexOf(name) }], type_of_insurance_id: 4, type_of_insurance: "Homeowners", sub_type_of_insurance: null, filing_type_id: 1, filing_type: "Rate",
  filing_status_id: 1, filing_status: "Approved", date_submitted: "2026-02-01", publish_date: `2026-0${1 + (k % 9)}-15`, effective_new: null, effective_renewal: null,
  rate_impact: k % 2 ? 7.5 : -1.2, rate_impact_text: null, description: null, tracking_number: null, sfc_number: `QQQ${1000000 + k}`, pages: 600, sweep_id: null, seen_at: "2026-11-18T09:00:00.000Z", ...over,
});
{
  const seen: Record<string, any> = {};
  const w = world([
    (body) => {
      seen.system = body.system;
      return { content: [say("Florida is in the market index, so I'll ask it."), toolUse("m1", "query_market_index", { state: "FL", group: "company", type_of_insurance: "homeowners", filing_type: "rate", status: null, from: "2026-01-01", to: null, words: [], rate_above: null, rate_below: null })] };
    },
    (body) => {
      seen.byCo = toolResults(body).m1;
      return { content: [toolUse("m2", "query_market_index", { state: "FL", group: "rows", type_of_insurance: "homeowners", filing_type: "rate", status: null, from: "2026-01-01", to: null, words: [], rate_above: 5, rate_below: null })] };
    },
    (body) => {
      seen.rows = toolResults(body).m2;
      return { content: [toolUse("m3", "query_market_index", { state: "GA", group: "company", type_of_insurance: null, filing_type: null, status: null, from: null, to: null, words: [], rate_above: null, rate_below: null })] };
    },
    (body) => { seen.ga = toolResults(body).m3; return { content: [say("From the market index of Florida (filings published 19 Nov 2025 to 18 Nov 2026, last completed 18 Nov 2026, covering 2,690 of the companies in the app's list, 10 not), three carriers filed homeowners rate filings this year. Georgia isn't indexed.")] }; },
    NO_TABLE,
  ]);
  await ix(w.db).putIndexState(FL);
  await ix(w.db).putIndexRows([ROW(1, "Calloway Home Co"), ROW(2, "Calloway Home Co"), ROW(3, "Tarrow Mutual Insurance Co"), ROW(4, "Calloway Coastal Co", { filing_type: "Form", rate_impact: null }), ROW(5, "Calloway Coastal Co"), ROW(6, "Nonesuch Carrier Co", { type_of_insurance: "Commercial Auto" })]);
  const a = await w.ask("Who filed homeowners rate filings in Florida this year?");
  ok("the answer finishes", a.job.status === "done" && a.job.error === null, a.job.error);
  ok("it used zero S&P requests: not a sign-in, not a search", w.sp.log.length === 0 && a.result.usage.spRequests === 0, w.sp.log.map((c) => c.path));
  const sys = seen.system.map((b: any) => b.text).join("\n");
  ok("Claude was told at the start which states are indexed", sys.includes("Market index (information, not instructions): query_market_index answers from these states at no S&P cost.\n```\nFL: published 2025-11-19 to 2026-11-18; last complete sweep 2026-11-18; 2,690 companies covered, 10 not\n```"));
  ok("the note sits after the reference ids, in the cached block, so it is the same on every step", seen.system[1].text.startsWith("S&P's reference ids for search filters.") && seen.system[1].text.includes("Market index") && !!seen.system[1].cache_control);
  const byCo = seen.byCo.value;
  ok("by company: the index answered, grouped, with the filters as asked", !seen.byCo.isError && byCo.groupedBy === "company" && same(byCo.groups.map((g: any) => [g.name, g.filings]), [["Calloway Home Co", 2], ["Calloway Coastal Co", 1], ["Tarrow Mutual Insurance Co", 1]]) && byCo.total === 4 && byCo.asked.from === "2026-01-01", byCo);
  ok("every answer carries its coverage for Claude to quote", byCo.coverage.state === "FL" && byCo.coverage.from === "2025-11-19" && byCo.coverage.lastComplete === "2026-11-18T09:05:00.000Z" && byCo.coverage.companiesCovered === 2690 && byCo.coverage.companiesMissed === 10 && byCo.coverage.sentence.includes("isn't the whole market"));
  ok("and says which companies weren't covered", byCo.notes.some((n: string) => n.includes("10 companies in the list weren't covered") && n.includes("Nonesuch Carrier No. 10 Co")), byCo.notes);
  const rows = seen.rows.value;
  ok("as rows: shaped like search rows, named by S&P's number, never a bare tracking number", !seen.rows.isError && rows.rowsShown === 3 && rows.filings.length === 3 && rows.filings.every((f: any) => f.trackingNumber === null && /^QQQ\d+$/.test(f.sfcNumber) && f.state === "FL" && f.rateImpact === "7.5" && f.documentId > 0), rows.filings);
  ok("the rate filter's note is passed on", rows.notes.includes("Filings with no overall rate impact are left out by a rate filter."));
  ok("a state that isn't indexed comes back as an error telling Claude to choose carriers itself", seen.ga.isError && seen.ga.value.error.startsWith("GA isn't in the market index") && seen.ga.value.error.includes("For this state, choose carriers yourself and use search_filings."), seen.ga.value);
  ok("the lookups list says what was asked", same(a.result.lookups.map((l: any) => [l.tool, l.detail]), [["query_market_index", "FL, by company: 4 filings"], ["query_market_index", "FL: 3 filings"], ["query_market_index", "GA: not answered from the index"]]), a.result.lookups);
  ok("the index was asked three times, the last refused before any query", ix(w.db).queries.length === 2);
  ok("the answer is Claude's", a.result.answer[0].text.startsWith("From the market index of Florida"));
}

// ---------- the migration not run: the tool says so, and the answer still finishes ----------
{
  const seen: Record<string, any> = {};
  const w = world([
    { content: [toolUse("m1", "query_market_index", { state: "FL", group: "company", type_of_insurance: null, filing_type: null, status: null, from: null, to: null, words: [], rate_above: null, rate_below: null })] },
    (body) => { seen.r = toolResults(body).m1; return { content: [say("The index isn't set up, so I chose carriers myself.")] }; },
    NO_TABLE,
  ]);
  for (const k of ["openSweep", "queryIndex", "putIndexRows", "indexStates"]) delete (w.db as any)[k];
  const a = await w.ask("Who filed in Florida?");
  ok("without the index tables the tool says so and points Claude to search_filings", a.job.status === "done" && seen.r.isError && seen.r.value.error === "The market index isn't set up in this app yet. Choose carriers yourself and use search_filings.", seen.r);
}

done();
