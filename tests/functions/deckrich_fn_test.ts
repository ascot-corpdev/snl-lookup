// The richer filings profile through the snl-profile function (handle()): filings_facts reads the saved summaries of the
// company's filings and the market index from the database at no S&P cost, says which rate and form filings could still
// be summarised (candidates, never summarised by the function itself), and still keeps to every rule of the filings
// profile: the same S&P requests with or without summaries, the search saved unlisted, a summaries table that can't be
// read or an index that isn't set up never stops it, Claude's draft gets the new figures but not the candidates, and
// the sample shows every slide from made-up summaries and a made-up index. Every company, id and filing is made up.
(globalThis as any).__SNL_TEST__ = true;
const profile = await import(new URL("../../supabase/functions/snl-profile/index.ts", import.meta.url).href);
const D = await import(new URL("../../supabase/functions/_shared/digest.ts", import.meta.url).href);
import * as P from "../../supabase/functions/_shared/profile.ts";
import { forgetTokens } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, corpdev, digestTables, env, fakeAnthropic, fakeClock, J, memoryDb, read, type Reply, req, say } from "./helpers/fakes.ts";
import { filing, spPage, spStub } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SP = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" }, AI = { ANTHROPIC_API_KEY: "test-key-not-a-secret" };
const ENT = [{ companyName: "Calloway Insurance Co", institutionId: "6000001", companyId: null, naicCompanyCode: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: "Calloway Group (SNL P&C Group)" }];
const base = { filingDescription: "Made-up description that must never reach the facts.", trackingNumber: null, overallRateImpact: null, dispOverallRateImpact: null, companyId: null, institutionId: 6000001, companyName: "Calloway Insurance Co" };
const HELD = [
  filing(1, { ...base, sfcNumber: "CAL0000001", serffFilingType: "Rate", filingStatus: "Approved", overallRateImpact: 6.2, publishDate: "2026-10-01", dateSubmitted: "2026-08-02", pages: 400 }),
  filing(2, { ...base, sfcNumber: "CAL0000002", serffFilingType: "Rate", filingStatus: "Pending", overallRateImpact: 3.1, publishDate: "2026-11-01", dateSubmitted: "2026-09-02", pages: 90 }),
  filing(3, { ...base, sfcNumber: "CAL0000003", serffFilingStateId: "TX", serffFilingType: "Form", filingStatus: "Approved", publishDate: "2026-06-10", dateSubmitted: "2026-05-11" }),
];
// a current summary of filing 1, with exposure and an indicated change
const DG1 = { ...D.metaFrom(HELD[0]), read: [{ from: 1, to: 150 }], madeAt: "2026-11-17T00:00:00Z", by: "claude", summary: "Made-up.", programs: [], forms: [], eligibility: [], notable: [], v: 2,
  rate: { overallPct: 6.2, requestedPct: 6.2, approvedPct: 6.2, premium: 12_500_000, policyholders: 9_800, effectiveNew: null, effectiveRenewal: null, page: 4, indicatedPct: 8.8, pages: { indicatedPct: 11 } } };
const ST = { state: "FL", from_date: "2025-01-01", to_date: "2026-11-15", last_complete_at: "2026-11-15T10:00:00Z", last_sweep_id: null, companies_covered: 2712, companies_missed: 0, missed: [] };
const IROWS = [
  { state: "FL", companies: [{ n: "Calloway Insurance Co", c: null, i: 6000001 }], type_of_insurance: "Homeowners", rate_impact: 6.2, publish_date: "2026-10-01", filing_status: "Approved" },
  { state: "FL", companies: [{ n: "Tarrow Mutual Insurance Co", c: null, i: 7000001 }], type_of_insurance: "Homeowners", rate_impact: 2, publish_date: "2026-09-01", filing_status: "Approved" },
  { state: "FL", companies: [{ n: "Nonesuch Home Co", c: null, i: 7000002 }], type_of_insurance: "Homeowners", rate_impact: 4, publish_date: "2026-08-01", filing_status: "Approved" },
];

function world(o: { digests?: "on" | "off" | "broken"; index?: boolean; script?: (Reply | ((body: any, n: number) => Reply))[] } = {}) {
  forgetTokens();
  const clock = fakeClock("2026-11-18T12:00:00Z"), db: any = memoryDb(clock), tables = digestTables(clock);
  db.putEntities(ENT);
  if (o.digests !== "off") Object.assign(db, tables);
  if (o.digests === "broken") tables.fail = "relation public.snl_digests does not exist";
  const queries: any[] = [];
  if (o.index) Object.assign(db, { indexStates: async () => [ST], queryIndex: async (q: any) => { queries.push(q); const rows = IROWS.filter((r) => r.state === q.state); return { total: rows.length, withRate: 0, rateFilings: 0, stateRows: rows.length, stateDescribed: 0, rows }; } });
  const refs = read("spgmi_reference.json");
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") { const l = refs[call.query.referenceField]; return J({ headers: l.headers, rows: l.rows.map((row: unknown[]) => ({ row })) }); }
    const p = call.body.properties;
    return J(spPage(HELD.filter((r: any) => p.serffFilingStateId.includes(r.serffFilingStateId) && String(r.publishDate) >= p.minPublishDate && String(r.publishDate) <= p.maxPublishDate), { totalPages: 1, currentPage: 1 }));
  });
  const ai = fakeAnthropic(o.script ?? []);
  const deps = { env: env({ ...SP, ...AI }), fetch: sp.fetch, anthropicFetch: ai.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown) => { const res: Response = await profile.handle(req("snl-profile", body), deps); return { status: res.status, body: await res.json() }; };
  return { db, tables, sp, ai, call, queries };
}
const CO = { action: "filings_facts", kind: "company", institutionId: "6000001", years: 1 };

{
  const plain = world({ digests: "off" });
  const a = await plain.call(CO);
  const w = world({ index: true });
  await w.tables.putDigest(D.digestRow(D.cleanDigest(DG1)!, D.digestId(DG1)!));
  const r = await w.call(CO), f = r.body.facts;
  ok("the profile is built as before", r.status === 200 && f.totals.filings === 3 && a.status === 200);
  ok("saved summaries and the index cost no S&P request: the same requests as a profile without them", r.body.spRequests === a.body.spRequests && w.sp.log.length === plain.sp.log.length, [r.body.spRequests, a.body.spRequests]);
  ok("the summaries are read from the database for the company's filings", w.tables.gets.length === 1 && same(w.tables.gets[0].documentIds.sort(), [71000001, 71000002, 71000003]));
  ok("summary counts: 2 rate filings, 1 summarised and current; 1 form filing, none", same(f.summaries.rate, { filings: 2, withDocument: 2, summarised: 1, older: 0 }) && same(f.summaries.form, { filings: 1, withDocument: 1, summarised: 0, older: 0 }));
  ok("exposure from the summary: $12.5M and 9,800 policyholders on page 4", f.exposure.total === 1 && f.exposure.rows[0].premium === 12_500_000 && f.exposure.rows[0].policyholders === 9_800 && f.exposure.rows[0].page === 4);
  ok("adequacy: indicated 8.8% on page 11", f.adequacy.rows[0].indicatedPct === 8.8 && f.adequacy.rows[0].pages.indicatedPct === 11);
  ok("candidates: the other rate filing and the form filing, newest first, each with its row for snl-digest", same(r.body.candidates.rate.map((c: any) => c.filingNo), ["S&P no. CAL0000002"]) && same(r.body.candidates.form.map((c: any) => c.filingNo), ["S&P no. CAL0000003"]) && r.body.candidates.rate[0].row.documentId === 71000002 && r.body.candidates.rate[0].pages === 90);
  ok("nothing summarised by the profile itself: no Claude call, nothing saved", w.ai.calls.length === 0 && w.tables.puts === 1);
  ok("the market: FL homeowners from the index, 1 of 3 filings, read from the database", f.market.rows.length === 1 && f.market.rows[0].carrier.filings === 1 && f.market.rows[0].market.filings === 3 && w.queries.length === 1 && w.queries[0].state === "FL");
  ok("no description anywhere in the facts or candidates", !JSON.stringify(r.body).includes("Made-up description"));
  ok("the map: every state searched is listed", Array.isArray(f.map.searched) && f.map.searched.includes("FL") && f.map.searched.length === r.body.search.states.length);
  const saved = w.db.store ? [...(w.db.store.values?.() ?? [])] : [];
  ok("the search is still saved unlisted", saved.length === 0 || saved.every((x: any) => x.kind !== "search" || x.doc?.unlisted === true));
}
{
  const w = world({ digests: "broken" });
  const keep = console.error; console.error = () => {};
  const r = await w.call(CO);
  console.error = keep;
  ok("a summaries table that can't be read: the profile is still built, and the facts say why none are used", r.status === 200 && r.body.facts.summaries.checked === false && /couldn't be read/.test(r.body.facts.summaries.note) && r.body.candidates.rate.length === 2);
  ok("no state indexed yet: said in the facts, with where to sweep one", /No state is in the market index yet/.test(r.body.facts.market.reason), r.body.facts.market);
}
{
  const w = world({ digests: "off" });
  const r = await w.call(CO);
  ok("no summaries table at all: said, and nothing breaks", r.status === 200 && r.body.facts.summaries.checked === false);
}
{
  // Claude's draft sees the new figures, never the candidates
  const w = world({ index: true, script: [(body: any) => { const f = JSON.parse(String(body.messages[0].content).split("<facts>\n")[1].split("\n</facts>")[0]); const t: any = P.filingsPlainText(f); delete t.by; delete t.note; return { content: [say(JSON.stringify(t))] }; }] });
  await w.tables.putDigest(D.digestRow(D.cleanDigest(DG1)!, D.digestId(DG1)!));
  const r = await w.call({ ...CO, action: "filings_draft" });
  const sent = String(w.ai.calls[0].body.messages[0].content);
  ok("the draft: Claude's text kept, the candidates returned to the page", r.status === 200 && r.body.text.by === "claude" && r.body.candidates.rate.length === 1);
  ok("Claude is sent the new figures but not the rows that could be summarised", sent.includes("\"exposure\"") && sent.includes("12500000") && !sent.includes("\"candidates\"") && !sent.includes("\"row\"") && !sent.includes("Made-up description"));
  ok("the schema asks for the five new sections", ["rateMap", "exposure", "adequacy", "programs", "market"].every((k) => (P.FP_SECTIONS as readonly string[]).includes(k) &&P.FP_DRAFT_SYSTEM.includes(`in this order: ${[...P.FP_SECTIONS, "questions"].join(", ")}`)));
}
{
  const w = world();
  const r = await w.call({ action: "filings_sample" });
  const f = r.body.facts;
  ok("the sample: made-up summaries and a made-up index fill every new slide", r.status === 200 && f.sample && f.exposure.total > 0 && f.adequacy.total > 0 && f.programs.programs.length > 0 && f.market.rows.length === 2 && f.summaries.rate.older > 0 && f.map.searched.length === 51);
  ok("the sample uses no S&P, Claude or database summaries, and offers nothing to summarise", w.sp.log.length === 0 && w.ai.calls.length === 0 && w.tables.gets.length === 0 && r.body.candidates === undefined);
  const names = JSON.stringify(f).match(/"(?:name|company|n)":"([^"]+)"/g) ?? [];
  ok("the sample's names are made up: Calloway, Tarrow and Nonesuch only", names.every((x) => /Calloway|Tarrow|Nonesuch/.test(x)), names.filter((x) => !/Calloway|Tarrow|Nonesuch/.test(x)));
  const saved = JSON.parse(await Deno.readTextFile(new URL("../fixtures/deckfilings_sample_answer.json", import.meta.url)));
  ok("the saved sample answer the slide suites build from is this one", same(saved.facts.exposure, JSON.parse(JSON.stringify(f.exposure))));
}

done();
