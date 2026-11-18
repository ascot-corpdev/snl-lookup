// End to end, on fixtures: the first real question the app was built for, with made-up companies standing in
// for the real ones. "Pull <group> and <insurer> homeowners form filings in Florida. Does <group> have separate
// forms for middle market and private client customers?" Runs the Filings search and then the Ask flow through
// the real functions against a fake S&P API and a fake Claude. Nothing is billed and nothing real is named.
(globalThis as any).__SNL_TEST__ = true;
const filings = await import(new URL("../../supabase/functions/snl-filings/index.ts", import.meta.url).href);
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { forgetTokens } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
import { checks, corpdev, documentsIn, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, pageCite, PDF, req, say, thinking, toolResults, toolUse } from "./helpers/fakes.ts";

const { ok, done } = checks();
forgetTokens();
const clock = fakeClock("2026-11-13T12:00:00Z");
const db = memoryDb(clock);
const sp = fakeSpgmi(clock, { documents: {
  "70000001": { bytes: PDF("Homeowner Program. Policy form CHO 30 01 (06 25)."), name: "CALL-134000001.pdf" },
  "70000002": { bytes: PDF("Signature Home. Policy form SH-HO 01 (12 25)."), name: "CALL-134000002.pdf" },
  "70000005": { bytes: PDF("Homeowners policy form TMI-HO 3 (02 25)."), name: "TARR-135000001.pdf" },
} });
const secrets = env({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "sk-ant-test" });
const IDS = [9100001, 9100002, 9100003, 9200001];

// ---------- 1. the Filings view: the same search, where one state returns nothing ----------
const base = { env: secrets, fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
const res = await filings.handle(req("snl-filings", { action: "search", companyIds: IDS, states: ["FL", "GA"], from: "2024-01-01", to: "2026-11-13", typeOfInsuranceIds: [4], filingTypeIds: [0] }), base);
const found = await res.json();
ok("search answers 200", res.status === 200, found);
ok("three form filings, one row per filing version", found.total === 3 && found.rows.map((r: any) => r.trackingNumber).sort().join() === "CALL-134000001,CALL-134000002,TARR-135000001", found.rows?.map((r: any) => r.trackingNumber));
const shared = found.rows.find((r: any) => r.trackingNumber === "CALL-134000001");
ok("a filing made by two companies lists both", shared.companies.length === 2 && shared.companies.map((c: any) => c.companyName).sort().join("|") === "Calloway Home Co|Calloway Insurance Co", shared.companies);
ok("counts by state", JSON.stringify(found.byState) === JSON.stringify([{ state: "FL", rows: 3 }, { state: "GA", rows: 0 }]), found.byState);
const gaNote = found.notes.find((n: string) => n.includes("GA"));
ok("the empty state is called out plainly", !!gaNote && gaNote.startsWith("S&P returned no filings for GA") && gaNote.includes("doesn't prove that none were filed"), found.notes);
ok("no note claims Florida is empty", !found.notes.some((n: string) => n.includes("no filings for FL")), found.notes);
ok("each company is counted", found.byCompany.length === 4 && found.byCompany.every((c: any) => c.rows >= 1), found.byCompany);
ok("saved, and marked as fresh from S&P", found.saved === true && found.fromStore === false);
ok("companies are remembered for later look-ups", (await db.findEntities("calloway", 10)).length === 3 && (await db.findEntities("92001", 10))[0]?.companyName === "Tarrow Mutual Insurance Co");
const spCallsAfterSearch = sp.log.length;
const again = await (await filings.handle(req("snl-filings", { action: "search", companyIds: IDS, states: ["FL", "GA"], from: "2024-01-01", to: "2026-11-13", typeOfInsuranceIds: [4], filingTypeIds: [0] }), base)).json();
ok("the same search opens from the saved result without asking S&P", again.fromStore === true && again.total === 3 && sp.log.length === spCallsAfterSearch, { fromStore: again.fromStore, calls: sp.log.length - spCallsAfterSearch });

// ---------- 2. the Ask view: the question, answered with tools, citations and a table ----------
const QUESTION = "Pull Calloway and Tarrow homeowners form filings in Florida. Do Calloway have separate forms for middle market and private client customers? In Calloway's filings, Signature Home is the private client homeowners product and the standard homeowner form is middle market.";
const TABLE = {
  needs_table: true, title: "Homeowners forms in Florida",
  columns: ["Company", "Form number", "Product", "Segment", "Effective date", "Source filing"],
  rows: [
    { cells: ["Calloway Insurance Co, Calloway Home Co", "CHO 30 01 (06 25)", "Homeowner Program", "Middle market", "1 Jun 2025", "CALL-134000001, FL"] },
    { cells: ["Calloway Coastal Co", "SH-HO 01 (12 25)", "Signature Home", "Private client", "1 Dec 2025", "CALL-134000002, FL"] },
    { cells: ["Tarrow Mutual Insurance Co", "TMI-HO 3 (02 25)", "Homeowners", "", "1 Feb 2025", "TARR-135000001, FL"] },
  ],
  notes: ["Segments follow the mapping given in the question."],
};
const seenByClaude: Record<string, any> = {};
const claude = fakeAnthropic([
  { content: [thinking(), toolUse("t1", "resolve_entity", { query: "Calloway" }), toolUse("t2", "resolve_entity", { query: "Tarrow" })] },
  (body) => {
    seenByClaude.resolve = toolResults(body);
    return { content: [thinking(), toolUse("t3", "search_filings", { company_ids: IDS, institution_ids: [], states: ["FL"], from: "2021-11-13", to: "2026-11-13", type_of_insurance_ids: [4], filing_type_ids: [0] })] };
  },
  (body) => {
    seenByClaude.search = toolResults(body).t3;
    return { content: [say("I'll read the three current form filings."), toolUse("t4", "read_filing_document", { document_id: 70000001, filing_version_id: null }),
      toolUse("t5", "read_filing_document", { document_id: 70000002, filing_version_id: null }), toolUse("t6", "read_filing_document", { document_id: 70000005, filing_version_id: null })] };
  },
  (body) => {
    seenByClaude.docs = documentsIn(body);
    seenByClaude.read = toolResults(body);
    return { content: [
      say("Yes. Calloway files separate homeowners forms for the two segments in Florida.\n"),
      say("- **Middle market:** Calloway Insurance Co and Calloway Home Co use form CHO 30 01 (06 25) in the Homeowner Program, effective 1 Jun 2025 (CALL-134000001, FL).", [pageCite(0, 3, 5, "Policy form CHO 30 01 (06 25)")]),
      say("\n"),
      say("- **Private client:** Calloway Coastal Co uses form SH-HO 01 (12 25) in the Signature Home program, effective 1 Dec 2025 (CALL-134000002, FL).", [pageCite(1, 2, 3, "Signature Home. Policy form SH-HO 01 (12 25)")]),
      say("\n"),
      say("- **Tarrow:** Tarrow Mutual Insurance Co files one homeowners form, TMI-HO 3 (02 25), effective 1 Feb 2025 (TARR-135000001, FL).", [pageCite(2, 1, 2, "Homeowners policy form TMI-HO 3 (02 25)")]),
    ] };
  },
  (body) => { seenByClaude.tableRequest = body; return { content: [say(JSON.stringify(TABLE))] }; },
]);

const pending: Promise<unknown>[] = [];
const chatDeps = { ...base, anthropicFetch: claude.fetch, background: (p: Promise<unknown>) => { pending.push(p); } };
const spBefore = sp.log.length;
const asked = await chat.handle(req("snl-chat", { action: "ask", question: QUESTION }), chatDeps);
const { jobId } = await asked.json();
ok("ask answers 202 with a job id at once, before the answer is written", asked.status === 202 && typeof jobId === "string" && db.jobs.get(jobId)?.result === null && claude.calls.length === 0, { status: asked.status, jobId });
await Promise.all(pending);
const job = db.jobs.get(jobId)!;
ok("the answer finished", job.status === "done" && job.error === null, { status: job.status, error: job.error });
const r = job.result as any;

// What Claude was given
ok("Claude found the three Calloway companies and Tarrow by name", seenByClaude.resolve.t1.value.matches.length === 3 && seenByClaude.resolve.t2.value.matches[0].companyId === "9200001", seenByClaude.resolve);
ok("the search Claude ran returned four form filings since 2021", seenByClaude.search.value.total === 4 && seenByClaude.search.value.filings.some((f: any) => f.trackingNumber === "CALL-132000009"), seenByClaude.search.value.total);
ok("Claude's rows name both companies on the shared filing", seenByClaude.search.value.filings.find((f: any) => f.trackingNumber === "CALL-134000001").companies.length === 2);
ok("three documents were attached as files, with citations on, in the order read", seenByClaude.docs.length === 3 && seenByClaude.docs.every((d: any, i: number) => d.source.type === "file" && d.source.file_id === `file_test${i + 1}` && d.citations?.enabled === true), seenByClaude.docs);
ok("documents were uploaded once each and deleted when the answer finished", claude.uploads.length === 3 && claude.uploads.every((u) => u.type === "application/pdf") && claude.deleted.sort().join() === "file_test1,file_test2,file_test3", { uploads: claude.uploads, deleted: claude.deleted });
ok("the answer's saved place is cleared", !db.states.has(jobId));

// How Claude was called
const first = claude.calls[0];
ok("Claude Opus 5.5 by default, streaming, adaptive thinking, high effort", first.body.model === "claude-opus-5-5" && first.stream && first.body.thinking?.type === "adaptive" && first.body.output_config?.effort === "high", first.body.output_config);
ok("server-side fallback is on", first.body.fallbacks === "default" && (first.betas ?? "").includes("server-side-fallback-2026-07-01"), first.betas);
ok("seven strict tools", first.body.tools.length === 7 && first.body.tools.every((t: any) => t.strict === true && t.input_schema.additionalProperties === false) && first.body.tools.map((t: any) => t.name).join() === "resolve_entity,resolve_entities,search_filings,query_market_index,read_filing_document,get_filing_summaries,query_statutory");
ok("Claude sees only the question (and today's date), no deal data", JSON.stringify(first.body.messages) === JSON.stringify([{ role: "user", content: [{ type: "text", text: QUESTION }, { type: "text", text: "Today is 2026-11-13." }] }]), first.body.messages);
ok("the system prompt carries S&P's saved reference ids", first.body.system[1].text.includes("4 = Homeowners") && first.body.system[1].text.includes("0 = Form"), first.body.system[1].text);
const tr = seenByClaude.tableRequest;
ok("the table is a separate structured-output request with no documents", tr.output_config?.format?.type === "json_schema" && documentsIn(tr).length === 0 && !tr.tools && tr.messages[0].content.includes(QUESTION), tr.output_config);

// The result the page shows
ok("the answer leads with the conclusion", r.answer[0].text === "Yes. Calloway files separate homeowners forms for the two segments in Florida." && r.answer[0].cites.length === 0, r.answer[0]);
ok("each bullet carries its own source", r.answer.length === 4 && JSON.stringify(r.answer.slice(1).map((s: any) => s.cites)) === "[[1],[2],[3]]", r.answer);
ok("sources name the filing and the pages cited", r.sources.length === 3 && r.sources[0].documentId === 70000001 && r.sources[0].trackingNumber === "CALL-134000001" && r.sources[0].pages === "3-4" && r.sources[0].startPage === 3
  && r.sources[1].pages === "2" && r.sources[2].state === "FL" && r.sources[2].quote === "Homeowners policy form TMI-HO 3 (02 25)", r.sources);
ok("the comparison table has the expected columns", r.table.columns.join("|") === "Company|Form number|Product|Segment|Effective date|Source filing", r.table.columns);
const seg = Object.fromEntries(r.table.rows.map((row: string[]) => [row[1], row[3]]));
ok("the two Calloway forms are split by segment", seg["CHO 30 01 (06 25)"] === "Middle market" && seg["SH-HO 01 (12 25)"] === "Private client", seg);
ok("a blank cell reads n/d", r.table.rows[2][3] === "n/d", r.table.rows[2]);
ok("no limit was hit", r.caps.length === 0, r.caps);
ok("progress was written in plain English as it went", job.progress.some((s) => s.text === "Searching S&P filings: 4 companies, FL, 2021 to 2026") && job.progress.some((s) => s.text === "Reading filing CALL-134000001 (42 pages)") && job.progress.at(-1)!.text === "Building the comparison table", job.progress.map((s) => s.text));
ok("lookups are listed", r.lookups.map((l: any) => l.tool).join() === "resolve_entity,resolve_entity,search_filings,read_filing_document,read_filing_document,read_filing_document", r.lookups);

// S&P usage: two reference lists not yet saved, 6 one-year windows for the search, and 3 documents
const spCalls = sp.log.slice(spBefore);
ok("S&P requests are counted on the answer", r.usage.spRequests === spCalls.length && spCalls.filter((c) => c.path === "/api/v1/reference").length === 2 && spCalls.filter((c) => c.path === "/api/v1/search").length === 6 && spCalls.filter((c) => c.path === "/api/v1/download").length === 3, { counted: r.usage.spRequests, calls: spCalls.map((c) => c.path) });
ok("every S&P call is at least a second after the one before", sp.log.every((c, i) => i === 0 || c.at - sp.log[i - 1].at >= 1000), sp.log.map((c) => c.at - sp.log[0].at));
ok("S&P requests show in the counter", (await db.usage()).day === sp.log.length, { used: await db.usage(), calls: sp.log.length });

done();
