// Follow-ups to the first Live check: a filing named by S&P's own number when it has no tracking number (every place
// the functions name a filing), one company one row in the company list (saving merges, reading collapses rows
// saved twice before), ids that match whether text or number, a document over the download limit turned down
// before it is read (and still counted), and watchlist marks for filings with no description. Every company, id,
// number and filing here is made up.
(globalThis as any).__SNL_TEST__ = true;
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { LIMITS, TOOLS, buildAnswer, compactFiling, partReadNotes, readUpTo } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { collapseEntities, type Entity, mergeEntity, oneEach, planEntityWrites, sameCompany, supabaseDb, withSameCompanies } from "../../supabase/functions/_shared/db.ts";
import { dedupe, entitiesFrom, filingNumber, filingNumberText, groupChoices, mapRows, parseSearch, planSearch, resolveEntity, resolveMany, sameId, searchFilings, SP_NUMBER_MARK } from "../../supabase/functions/_shared/filings.ts";
import { diagnose } from "../../supabase/functions/_shared/diagnose.ts";
import { cutPages, openPdf, READS_IN_PLACE } from "../../supabase/functions/_shared/pdf.ts";
import { filingsFacts, lookUpDirectory } from "../../supabase/functions/_shared/profile.ts";
import { forgetTokens, Spgmi } from "../../supabase/functions/_shared/spgmi.ts";
import { flagFiling, foundRow, markFound, watchEmail } from "../../supabase/functions/_shared/watch.ts";
import * as companiesLib from "../../scripts/companies-lib.mjs";
import { checks, env, fakeAnthropic, fakeClock, J, memoryDb, pageCite, type Reply, req, say, toolResults, toolUse } from "./helpers/fakes.ts";
import { filing, spPage, spStub } from "./helpers/more.ts";

const { ok, done } = checks();
// deno-lint-ignore no-explicit-any
const lib: any = companiesLib;   // plain JavaScript, read without types
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SP = "ABC1234567", SP2 = "XYZ7654321";

// =====================================================================================================
// A. a filing's number
// =====================================================================================================
{
  const n = (trackingNumber: unknown, sfcNumber: unknown) => filingNumber({ trackingNumber, sfcNumber });
  ok("the tracking number when there is one", same(n("CALL-FL-1", null), { kind: "tracking", value: "CALL-FL-1" }) && filingNumberText({ trackingNumber: "CALL-FL-1" }) === "CALL-FL-1");
  ok("S&P's number, marked, when there is no tracking number", same(n(null, SP), { kind: "sp", value: SP }) && filingNumberText({ trackingNumber: null, sfcNumber: SP }) === `S&P no. ${SP}` && SP_NUMBER_MARK === "S&P no.");
  ok("an empty or blank tracking number counts as none", same(n("", SP), { kind: "sp", value: SP }) && same(n("   ", SP), { kind: "sp", value: SP }) && same(n(undefined, SP), { kind: "sp", value: SP }));
  ok("both: the tracking number wins", same(n("CALL-FL-2", SP), { kind: "tracking", value: "CALL-FL-2" }));
  ok("neither: nothing, never an empty string", n(null, null) === null && n("", "  ") === null && filingNumberText({}) === null && filingNumberText(null) === null && filingNumberText(undefined) === null && filingNumberText("CALL-1") === null);
  ok("a number as a number is read as text", same(n(null, 1234567), { kind: "sp", value: "1234567" }) && same(n(42, null), { kind: "tracking", value: "42" }));
  ok("objects, lists and true/false are no number", n({ x: 1 }, SP)?.value === SP && n([1], null) === null && n(true, false) === null);
  const hostile = filingNumberText({ trackingNumber: null, sfcNumber: "<img src=x onerror=1>\u0000\n\u2028" + "9".repeat(80) });
  ok("control characters and line breaks are taken out, and it is cut to 50 characters (so the mark still fits 60)", !!hostile && !/[\u0000-\u001f\u2028]/.test(hostile) && hostile.length <= 60 && hostile.startsWith("S&P no. <img src=x onerror=1> 999"), hostile);
  ok("markup is kept as text here: the page escapes it", filingNumber({ trackingNumber: "<b>CALL</b>" })!.value === "<b>CALL</b>");
}

// ----- what Claude is shown, and the one sentence that tells it -----
{
  const row = (over: Record<string, unknown>) => dedupe(mapRows(spPage([filing(1, over)])))[0];
  const tracking = compactFiling(row({ trackingNumber: "CALL-FL-1", sfcNumber: SP })), spOnly = compactFiling(row({ trackingNumber: null, sfcNumber: SP }));
  const neither = compactFiling(row({ trackingNumber: null, sfcNumber: null }));
  ok("a row with a tracking number is shown as before, with no second number", tracking.trackingNumber === "CALL-FL-1" && !("sfcNumber" in tracking), tracking);
  ok("a row with only S&P's number is shown with sfcNumber, and no tracking number to copy into a search", spOnly.trackingNumber === null && spOnly.sfcNumber === SP, spOnly);
  ok("a row with neither shows no number at all", neither.trackingNumber === null && !("sfcNumber" in neither));
  const desc = TOOLS.find((t: any) => t.name === "search_filings").description as string;
  ok("search_filings tells Claude, in one sentence, that such a filing is named by S&P's number, and not to search by it", desc.includes(`A filing with no tracking number is identified by S&P's own filing number (sfcNumber): quote it as "S&P no." and the number wherever you would give a tracking number, and never put it in tracking_numbers.`), desc);
  // the tracking-number filter is unchanged: only what was given goes to S&P, never an S&P number
  const p = parseSearch({ companyIds: [9100001], states: ["FL"], trackingNumbers: ["CALL-FL-1"], from: "2026-01-01", to: "2026-11-13" }, "2026-11-13");
  const bodies = p.ok ? planSearch(p.params) : [];
  ok("the tracking-number search filter still sends only the tracking numbers given", bodies.length === 1 && same(bodies[0].trackingNumber, ["CALL-FL-1"]) && !JSON.stringify(bodies).includes("sfc"), bodies);
  const noTracking = parseSearch({ companyIds: [9100001], states: ["FL"], from: "2026-01-01", to: "2026-11-13" }, "2026-11-13");
  ok("and a search with none sends no tracking-number filter", noTracking.ok && !("trackingNumber" in planSearch(noTracking.params)[0]));
}

// ----- the notes about documents, the sources, and reading a filing with no tracking number -----
{
  const doc = (over: Record<string, unknown>) => ({ documentId: 71000001, filingVersionId: null, fileId: "file_1", title: "t", company: "Calloway Insurance Co", state: "FL", trackingNumber: null, pages: 624, firstPage: 1, lastPage: 150, ...over });
  ok("a part-read note names the filing by S&P's number when it has no tracking number", same(partReadNotes([doc({ sfcNumber: SP })]), [`Claude read pages 1 to 150 of 624 of filing S&P no. ${SP}, not the whole document. Open it from the Filings view for the rest.`]), partReadNotes([doc({ sfcNumber: SP })]));
  ok("and by the tracking number when it has one, as before", partReadNotes([doc({ trackingNumber: "CALL-FL-1", sfcNumber: SP })])[0].includes("of filing CALL-FL-1, not"));
  ok("neither: by the document id, as before", partReadNotes([doc({})])[0].includes("of filing document 71000001, not"));
  const built = buildAnswer([{ type: "text", text: "A fact.", citations: [pageCite(0, 2, 3, "Quoted words")] }] as any, [doc({ sfcNumber: SP, firstPage: undefined, lastPage: undefined })]);
  ok("a source carries S&P's number for the page to show", built.sources[0].sfcNumber === SP && built.sources[0].trackingNumber === null, built.sources);
  const built2 = buildAnswer([{ type: "text", text: "A fact.", citations: [pageCite(0, 2, 3, "Quoted words")] }] as any, [doc({ trackingNumber: "CALL-FL-1", firstPage: undefined, lastPage: undefined })]);
  ok("a source with a tracking number has no sfcNumber key", !("sfcNumber" in built2.sources[0]) && built2.sources[0].trackingNumber === "CALL-FL-1");
}

const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "test-anthropic-key" };
const NO_TABLE: Reply = { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] };
const SEARCH = (id = "s1") => toolUse(id, "search_filings", { company_ids: [9100001], institution_ids: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [], filing_status_ids: [], tracking_numbers: [] });
const READ = (id: string, documentId: number) => toolUse(id, "read_filing_document", { document_id: documentId, filing_version_id: null, first_page: null, last_page: null });
async function makePdf(n: number): Promise<Uint8Array> {
  const d = await PDFDocument.create({ updateMetadata: false });
  for (let i = 1; i <= n; i++) d.addPage([612, 792]);
  return await d.save({ useObjectStreams: false });
}
type Download = (call: any) => Response;
function world(rows: Record<string, unknown>[], download: Download, script: Parameters<typeof fakeAnthropic>[0]) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), claude = fakeAnthropic(script);
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") return J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }] });
    if (call.path === "/api/v1/download") return download(call);
    return J(spPage(rows, { totalPages: 1 }));
  });
  const pending: Promise<unknown>[] = [];
  const deps = { env: env(SECRETS), fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: async () => ({ id: "login-followups", role: "corpdev" }), db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const ask = async () => {
    const res: Response = await chat.handle(req("snl-chat", { action: "ask", question: "What does the Calloway filing say?" }), deps);
    const { jobId } = await res.json();
    while (pending.length) await pending.shift();
    const job = db.jobs.get(jobId)!;
    return { job, result: job.result as any };
  };
  return { clock, db, sp, claude, ask };
}
{
  const pdf = await makePdf(5), seen: Record<string, any> = {};
  const w = world([filing(1, { trackingNumber: null, sfcNumber: SP, pages: 5 })], () => new Response(pdf as unknown as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(pdf.length) } }), [
    { content: [SEARCH()] },
    (body) => { seen.search = toolResults(body).s1; return { content: [READ("r1", 71000001)] }; },
    (body) => { seen.read = toolResults(body).r1; return { content: [say("It sets out the form schedule.")] }; }, NO_TABLE,
  ]);
  const a = await w.ask();
  ok("Claude sees S&P's number on a search row with no tracking number", seen.search.value.filings[0].sfcNumber === SP && seen.search.value.filings[0].trackingNumber === null, seen.search?.value?.filings?.[0]);
  ok("the document is titled by S&P's number", seen.read.value.title === `S&P no. ${SP}, Calloway Insurance Co, FL, Form`, seen.read?.value);
  ok("the progress line names the filing by S&P's number", a.job.progress.some((s: any) => s.text === `Reading filing S&P no. ${SP} (5 pages)`), a.job.progress.map((s: any) => s.text));
  ok("the list of lookups names it the same way", a.result.lookups.some((l: any) => l.tool === "read_filing_document" && l.detail.startsWith(`S&P no. ${SP}`)), a.result.lookups);
}

// ----- the watchlist, its email, and the profile -----
{
  const at = "2026-11-18T06:00:00Z";
  const fr = (over: Record<string, unknown>) => foundRow(filing(1, over) as any, "run-1", at, false)!;
  ok("a found filing keeps its tracking number", fr({ trackingNumber: "CALL-FL-1", sfcNumber: SP }).tracking_number === "CALL-FL-1");
  ok("or S&P's number, marked, when it has none (no new column needed)", fr({ trackingNumber: null, sfcNumber: SP }).tracking_number === `S&P no. ${SP}`);
  ok("or nothing", fr({ trackingNumber: null, sfcNumber: null }).tracking_number === null);
  const long = fr({ trackingNumber: null, sfcNumber: "Q".repeat(200) }).tracking_number!;
  ok("never longer than the 60 characters the table allows", long.length <= 60 && long.startsWith("S&P no. QQQ"), long);
  const mail = watchEmail([fr({ trackingNumber: "CALL-FL-1" }), { ...fr({ trackingNumber: null, sfcNumber: SP }), filing_version_id: "v-2" }, { ...fr({ trackingNumber: null, sfcNumber: null }), filing_version_id: "v-3" }], { now: Date.parse(at), site: null });
  ok("the email names each filing by its tracking number, or by S&P's number, or says n/d", mail.text.includes("(tracking number CALL-FL-1)") && mail.text.includes(`(S&P no. ${SP})`) && mail.text.includes("(tracking number n/d)") && !mail.text.includes("tracking number S&P"), mail.text);
  const facts: any = filingsFacts({ rows: dedupe(mapRows(spPage([filing(1, { trackingNumber: null, sfcNumber: SP }), filing(2, { trackingNumber: "CALL-FL-2", sfcNumber: SP2, publishDate: "2026-01-01" }), filing(3, { trackingNumber: null, sfcNumber: null, publishDate: "2025-12-01" })]))), total: 3, capped: false }, "2025-11-18", "2026-11-17");
  ok("the profile's filings slide gets the same number for each filing", same(facts.rows.map((r: any) => r.tracking), [`S&P no. ${SP}`, "CALL-FL-2", null]), facts.rows.map((r: any) => r.tracking));
}

// =====================================================================================================
// B. one company, one row
// =====================================================================================================
const E = (over: Partial<Entity>): Entity => ({ companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...over });
const LISTED = E({ institutionId: "5000001", naicGroupName: "Calloway Group (SNL P&C Group)", spStatEntityId: "C90001" });
const FROM_RESULTS = E({ companyId: "4000001", institutionId: "5000001", naicCompanyCode: "90001", spStatEntityId: "C90001" });
const FULL = { companyId: "4000001", companyName: "Calloway Insurance Co", naicCompanyCode: "90001", institutionId: "5000001", spStatEntityId: "C90001", naicGroupCode: null, naicGroupName: "Calloway Group (SNL P&C Group)" };
{
  ok("the same institution id is the same company", sameCompany(LISTED, FROM_RESULTS) && sameCompany(E({ institutionId: 5000001 as any }), E({ institutionId: "5000001" })));
  ok("different company ids are never the same company, whatever else they share", !sameCompany(E({ companyId: "1", institutionId: "5" }), E({ companyId: "2", institutionId: "5" })));
  ok("rows that share no id are not the same company", !sameCompany(E({ companyId: "1" }), E({ institutionId: "1" })) && !sameCompany(E({}), E({})));
  ok("merging: every field is kept, and a later empty value never wipes one", same(mergeEntity(LISTED, FROM_RESULTS, { keepGroup: true }), FULL) && same(mergeEntity(FULL as Entity, E({ institutionId: "5000001" })), FULL));
  ok("merging: a loaded group name is kept against results; a list loaded later sets it", mergeEntity(LISTED, E({ institutionId: "5000001", naicGroupName: "Calloway Grp" }), { keepGroup: true }).naicGroupName === "Calloway Group (SNL P&C Group)"
    && mergeEntity(FROM_RESULTS, LISTED).naicGroupName === "Calloway Group (SNL P&C Group)");

  // results after the list
  let plan = planEntityWrites([{ id: "entity:i.5000001", doc: LISTED }], [FROM_RESULTS]);
  ok("results after the list: merged into the list's row, nothing new, nothing removed", same(plan, { rows: [{ id: "entity:i.5000001", doc: FULL }], drop: [] }), plan);
  // the list after results
  const jsPlan = lib.planEntityWrites([{ id: "entity:4000001", doc: FROM_RESULTS }], [LISTED]);
  ok("the list after results: one row, every field, the loaded group name", jsPlan.rows.length === 1 && same(jsPlan.rows[0].doc, FULL) && jsPlan.merged === 1 && same(jsPlan.drop, []), jsPlan);
  // a pair saved before merging
  plan = planEntityWrites([{ id: "entity:i.5000001", doc: LISTED }, { id: "entity:4000001", doc: FROM_RESULTS }], [E({ companyId: "4000001", companyName: "Calloway Insurance Co" })]);
  ok("a pair saved before merging is folded into the list's row, and the second row removed", same(plan, { rows: [{ id: "entity:i.5000001", doc: FULL }], drop: ["entity:4000001"] }), plan);
  ok("the importer makes the same plan as the functions, either way round", same(lib.planEntityWrites([{ id: "entity:i.5000001", doc: LISTED }, { id: "entity:4000001", doc: FROM_RESULTS }], [LISTED]).rows, planEntityWrites([{ id: "entity:i.5000001", doc: LISTED }, { id: "entity:4000001", doc: FROM_RESULTS }], [LISTED], { fromList: true }).rows)
    && same(lib.planEntityWrites([{ id: "entity:i.5000001", doc: LISTED }], [FROM_RESULTS], { fromList: false }).rows, planEntityWrites([{ id: "entity:i.5000001", doc: LISTED }], [FROM_RESULTS]).rows));
  plan = planEntityWrites([{ id: "entity:4000009", doc: E({ companyId: "4000009", institutionId: "5000001" }) }], [FROM_RESULTS]);
  ok("a saved row with another company id is left alone; the company gets its own row", same(plan.rows.map((r) => r.id), ["entity:4000001"]) && plan.drop.length === 0, plan);
  plan = planEntityWrites([{ id: "entity:n.90001", doc: E({ naicCompanyCode: "90001", naicGroupCode: "9001" }) }, { id: "entity:i.5000001", doc: LISTED }], [FROM_RESULTS]);
  ok("a NAIC-only row and an institution row of the same company end as one row", same(plan.rows.map((r) => r.id), ["entity:i.5000001"]) && same(plan.drop, ["entity:n.90001"]) && plan.rows[0].doc.naicGroupCode === "9001", plan);
  ok("collapsing on read: the fuller row leads, the other fills its gaps", same(collapseEntities([LISTED, FROM_RESULTS]), [FULL]) && same(oneEach([FROM_RESULTS, LISTED]), [FULL]));
  ok("collapsing joins two halves through a row that has both ids", collapseEntities([E({ institutionId: "5000001" }), E({ naicCompanyCode: "90001" }), E({ institutionId: "5000001", naicCompanyCode: "90001", companyId: "4000001" })]).length === 1);
  ok("partners that match no company found are left out", same(withSameCompanies([LISTED], [FROM_RESULTS, E({ companyId: "4000002", companyName: "Calloway Home Co" })]), [FULL]));
}

/** snl_store in memory, behind the query chain supabaseDb and the import use: select (with "alias:doc->>field"
    columns), eq, in and ilike on a column or a doc field, order, limit, range, upsert and delete. */
function storeSb(opts: { failIn?: boolean } = {}) {
  const rows = new Map<string, { id: string; kind: string; label: string; doc: Record<string, unknown>; fetched_at?: string }>();
  const ops: string[] = [];
  const get = (r: any, col: string) => (col.startsWith("doc->>") ? (r.doc?.[col.slice(6)] === null || r.doc?.[col.slice(6)] === undefined ? null : String(r.doc[col.slice(6)])) : r[col]);
  const client = {
    from: (_t: string) => {
      const q: any = { filters: [] as ((r: any) => boolean)[], limit: 1000, from: 0, cols: "*" };
      const chain: any = {
        select: (cols: string) => { q.cols = cols; return chain; },
        eq: (col: string, v: string) => { q.filters.push((r: any) => get(r, col) === v); return chain; },
        in: (col: string, vs: string[]) => { q.in = true; q.filters.push((r: any) => vs.map(String).includes(get(r, col))); return chain; },
        ilike: (col: string, pat: string) => { const re = new RegExp("^" + pat.split("%").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "is"); q.filters.push((r: any) => re.test(String(get(r, col) ?? ""))); return chain; },
        or: (expr: string) => { const parts = expr.split(",").map((p) => p.match(/^doc->>(\w+)\.eq\.(.*)$/)!); q.filters.push((r: any) => parts.some((m) => String(r.doc?.[m[1]] ?? "") === m[2])); return chain; },
        order: () => { q.order = true; return chain; },
        limit: (n: number) => { q.limit = n; return chain; },
        range: (a: number, b: number) => { q.from = a; q.limit = b - a + 1; return chain; },
        upsert: (list: any[]) => { q.upsert = list; return chain; },
        delete: () => { q.del = true; return chain; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => {
          if (q.upsert) { ops.push("upsert"); for (const r of q.upsert) rows.set(r.id, structuredClone(r)); return { data: null, error: null }; }
          if (q.del) { ops.push("delete"); for (const r of [...rows.values()]) if (q.filters.every((f: any) => f(r))) rows.delete(r.id); return { data: null, error: null }; }
          ops.push(q.in ? "read by id" : "read");
          if (q.in && opts.failIn) return { data: null, error: { message: "made-up failure" } };
          let out = [...rows.values()].filter((r) => q.filters.every((f: any) => f(r)));
          if (q.order) out = out.sort((a, b) => a.label.localeCompare(b.label));
          out = out.slice(q.from, q.from + q.limit);
          const alias = [...String(q.cols).matchAll(/(\w+):doc->>(\w+)/g)];
          return { data: out.map((r) => (alias.length ? Object.fromEntries(alias.map((m) => [m[1], get(r, "doc->>" + m[2])])) : { id: r.id, doc: structuredClone(r.doc) })), error: null };
        }).then(res, rej),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  /** Loads a company list the way scripts/companies.mjs load does: read what is saved for these ids, merge, write. */
  const load = async (list: Entity[]) => {
    const ids = lib.entityIdsOf(list), saved: { id: string; doc: Entity }[] = [];
    for (const k of ["companyId", "institutionId", "naicCompanyCode"]) for (const r of [...rows.values()]) if (r.kind === "entity" && ids[k].includes(String(r.doc[k] ?? ""))) if (!saved.some((x) => x.id === r.id)) saved.push({ id: r.id, doc: r.doc as unknown as Entity });
    const plan = lib.planEntityWrites(saved, list);
    for (const r of lib.planRows(plan, "2026-11-18T00:00:00.000Z")) rows.set(r.id, r);
    for (const id of plan.drop) rows.delete(id);
    return plan;
  };
  const put = (id: string, doc: Entity) => rows.set(id, { id, kind: "entity", label: [doc.companyName, doc.naicCompanyCode ? `NAIC ${doc.naicCompanyCode}` : "", doc.naicGroupName ?? ""].filter(Boolean).join(" | "), doc: doc as unknown as Record<string, unknown> });
  return { rows, ops, client, load, put, entities: () => [...rows.values()].filter((r) => r.kind === "entity") };
}

const LIST_CSV = [
  "Company Name,SNL Institution Key,S&P Statutory Entity Key,NAIC Group Name",
  "Calloway Insurance Co,5000001,C90001,Calloway Group (SNL P&C Group)",
  "Calloway Home Co,5000002,C90002,Calloway Group (SNL P&C Group)",
  "Calloway Coastal Co,5000003,C90003,Calloway Group (SNL P&C Group)",
  "Tarrow Mutual Insurance Co,5000004,C90004,Tarrow Mutual Group",
].join("\n");
const RESULT_ROWS = [
  filing(1, { companyId: 4000001, institutionId: 5000001, naicCompanyCode: "90001", spStatEntityId: "C90001", companyName: "Calloway Insurance Co", naicGroupCode: null, naicGroupName: null }),
  filing(2, { companyId: 4000002, institutionId: 5000002, naicCompanyCode: "90002", spStatEntityId: "C90002", companyName: "Calloway Home Co", naicGroupCode: null, naicGroupName: null }),
];
const fromResults = () => entitiesFrom(dedupe(mapRows(spPage(RESULT_ROWS))));
{
  // ----- the list first, then results (what happened on the owner's database, now merged) -----
  const sb = storeSb(), db = supabaseDb(sb.client, () => Date.parse("2026-11-18T12:00:00Z"));
  const listed = lib.readCompanies(LIST_CSV);
  await sb.load(listed.companies);
  ok("the list loads four companies, keyed by institution id", same(sb.entities().map((r) => r.id).sort(), ["entity:i.5000001", "entity:i.5000002", "entity:i.5000003", "entity:i.5000004"]));
  await db.putEntities(fromResults());
  ok("a search's companies merge into the list's rows: still four rows, none keyed by company id", sb.entities().length === 4 && !sb.rows.has("entity:4000001") && !sb.rows.has("entity:4000002"), [...sb.rows.keys()]);
  const one = sb.rows.get("entity:i.5000001")!.doc;
  ok("the one row carries company id, institution id, NAIC code, statutory key and the loaded group name", same(one, { ...FULL, naicGroupCode: null }), one);
  ok("its label now has the NAIC code too, so it is found by name with the code shown", sb.rows.get("entity:i.5000001")!.label === "Calloway Insurance Co | NAIC 90001 | Calloway Group (SNL P&C Group)");
  await db.putEntities(entitiesFrom(dedupe(mapRows(spPage([filing(3, { companyId: 4000001, institutionId: 5000001, naicCompanyCode: null, spStatEntityId: null, companyName: "Calloway Insurance Co", naicGroupCode: null, naicGroupName: null })])))));
  ok("a later search that lacks some fields never wipes them", same(sb.rows.get("entity:i.5000001")!.doc, { ...FULL, naicGroupCode: null }), sb.rows.get("entity:i.5000001")!.doc);
  const again = await sb.load(lib.readCompanies(LIST_CSV).companies);
  ok("loading the list again keeps what results taught, and adds no row", sb.entities().length === 4 && same(sb.rows.get("entity:i.5000001")!.doc, { ...FULL, naicGroupCode: null }) && again.merged === 4, sb.rows.get("entity:i.5000001")!.doc);
  ok("the importer's count is the number of companies", (lib.tidyPlan(sb.entities().map((r) => ({ id: r.id, doc: r.doc })))).companies === 4);
  const found = await db.findEntities("90001", 50);
  ok("the Statutory finder now finds a listed company by the NAIC code results taught", found.length === 1 && found[0].naicCompanyCode === "90001" && found[0].naicGroupName === "Calloway Group (SNL P&C Group)", found);
}
{
  // ----- results first, then the list -----
  const sb = storeSb(), db = supabaseDb(sb.client, () => Date.parse("2026-11-18T12:00:00Z"));
  await db.putEntities(fromResults());
  ok("results alone: one row each under the company id", same(sb.entities().map((r) => r.id).sort(), ["entity:4000001", "entity:4000002"]));
  const plan = await sb.load(lib.readCompanies(LIST_CSV).companies);
  ok("then the list: four companies in four rows, the list merged into the rows results made", same(sb.entities().map((r) => r.id).sort(), ["entity:4000001", "entity:4000002", "entity:i.5000003", "entity:i.5000004"]) && same(plan.drop, []) && plan.merged === 2, [...sb.rows.keys()]);
  ok("and the row carries every field, with the loaded group name", same(sb.rows.get("entity:4000001")!.doc, { ...FULL, naicGroupCode: null }), sb.rows.get("entity:4000001")!.doc);
  await db.putEntities(fromResults());
  ok("results again land on the same rows", sb.entities().length === 4 && same(sb.rows.get("entity:4000001")!.doc, { ...FULL, naicGroupCode: null }));
}
{
  // ----- a pair saved before this change: read as one, folded on the next save -----
  const sb = storeSb(), db = supabaseDb(sb.client, () => Date.parse("2026-11-18T12:00:00Z"));
  sb.put("entity:i.5000001", { ...LISTED, naicGroupCode: "9001" });
  sb.put("entity:4000001", FROM_RESULTS);
  sb.put("entity:i.5000002", E({ companyName: "Calloway Home Co", institutionId: "5000002", naicGroupName: "Calloway Group (SNL P&C Group)", naicGroupCode: "9001" }));
  sb.put("entity:i.5000004", E({ companyName: "Tarrow Mutual Insurance Co", institutionId: "5000004", naicGroupName: "Tarrow Mutual Group" }));
  const want = { ...FULL, naicGroupCode: "9001" };
  const byName = await db.findEntities("Calloway Insurance", 50), byCode = await db.findEntities("90001", 50), byId = await db.findEntities("4000001", 50), byInst = await db.findEntities("5000001", 50);
  ok("by name: one company, with everything both rows know", same(byName, [want]), byName);
  ok("by NAIC code (the Statutory finder), by company id and by institution id: the same one row", same(byCode, [want]) && same(byId, [want]) && same(byInst, [want]), { byCode, byId, byInst });
  const group = await db.entitiesInGroupName("Calloway Group", 100);
  ok("a group by name lists the company once, with its company id", group.length === 2 && same(group.find((e) => e.institutionId === "5000001"), want), group);
  const groupByCode = await db.entitiesInGroup("9001", 100);
  ok("a group by code lists it once too", groupByCode.length === 2 && same(groupByCode.find((e) => e.institutionId === "5000001"), want), groupByCode);
  const choice = await groupChoices(db, "Calloway Group");
  const members = choice.groups[0]?.members ?? [];
  ok("'add all' for the group: two companies, the merged one by its company id only, the other by institution id", choice.groups.length === 1 && choice.groups[0].companies === 2 && members.length === 2
    && same(members.find((m) => m.companyName === "Calloway Insurance Co"), { companyName: "Calloway Insurance Co", companyId: "4000001", institutionId: null })
    && same(members.find((m) => m.companyName === "Calloway Home Co"), { companyName: "Calloway Home Co", companyId: null, institutionId: "5000002" }) && choice.groups[0].requestsPerYear === 2, choice);
  const many = await resolveMany(db, ["Calloway Insurance"], ["Calloway Group"]);
  ok("Claude's look-up of names and groups: each company once, searched once", many.names[0].matches.length === 1 && many.groups[0].members.length === 2 && same(many.searchBatches, [{ company_ids: [4000001], institution_ids: [5000002], requestsPerYear: 2 }]), many);
  const r = await resolveEntity(db, "Calloway Insurance");
  ok("the Filings finder's look-up: one match", r.matches.length === 1 && r.matches[0].companyId === "4000001");
  const dir = await lookUpDirectory(db, "company", "90001");
  ok("the profile's look-up by NAIC code: the company, searched by its company id, with its group name", same(dir.companyIds, [4000001]) && same(dir.institutionIds, []) && dir.groupName === "Calloway Group (SNL P&C Group)", dir);
  const grp = await lookUpDirectory(db, "group", "9001");
  ok("the profile's look-up by group code: each member once", same(grp.companyIds, [4000001]) && same(grp.institutionIds, [5000002]) && grp.members === 2, grp);
  // the Live check counts companies, not rows, and says how many rows are second rows
  const mdb = memoryDb(fakeClock());
  for (const r of sb.entities()) mdb.store.set(r.id, { id: r.id, kind: "entity", label: r.label, doc: structuredClone(r.doc), fetched_at: "2026-11-18T00:00:00Z" });
  const rep = await diagnose({ creds: {}, db: mdb, gate: async () => {}, fetch: (() => { throw new Error("no S&P"); }) as unknown as typeof fetch, sleep: async () => {}, now: () => Date.parse("2026-11-18T12:00:00Z"), plan: "trial", limits: { hour: 500, day: 12000 } });
  const counts = rep.findings.find((f) => f.id === "dir.counts")!.found;
  ok("the Live check counts three companies in four rows, and says how to merge the second row", counts.startsWith("3 companies. With a company id 1, an institution id 3,") && counts.includes("These are in 4 rows: 1 company has a second row from before saving merged them.") && counts.includes("node scripts/companies.mjs tidy --apply"), counts);
  // the next save of that company folds the pair
  await db.putEntities(fromResults().slice(0, 1));
  ok("the next time results name the company, the second row is merged in and removed", !sb.rows.has("entity:4000001") && same(sb.rows.get("entity:i.5000001")!.doc, want) && sb.entities().length === 3, [...sb.rows.keys()]);
  ok("the merged row is written before the second row is removed", sb.ops.indexOf("upsert") < sb.ops.lastIndexOf("delete"), sb.ops);
  // the one-off tidy, for pairs nothing will touch again
  const t = lib.tidyPlan([{ id: "entity:i.5000009", doc: E({ institutionId: "5000009", naicGroupName: "Nonesuch Group" }) }, { id: "entity:4000009", doc: E({ companyId: "4000009", institutionId: "5000009", naicCompanyCode: "90009", naicGroupName: "Nonesuch Grp" }) }, { id: "entity:i.5000004", doc: E({ institutionId: "5000004" }) }]);
  ok("tidy: each company saved twice becomes the list's row, with every id and the list's group name; the other row goes", same(t.rows.map((r: any) => [r.id, r.doc.companyId, r.doc.naicCompanyCode, r.doc.naicGroupName]), [["entity:i.5000009", "4000009", "90009", "Nonesuch Group"]]) && same(t.drop, ["entity:4000009"]) && t.companies === 2 && t.duplicates === 1, t);
}
{
  // ----- a read that fails still saves, and still reads -----
  const sb = storeSb({ failIn: true }), db = supabaseDb(sb.client, () => Date.parse("2026-11-18T12:00:00Z"));
  sb.put("entity:i.5000001", LISTED);
  await db.putEntities(fromResults().slice(0, 1));
  ok("if the saved rows can't be read, the company is saved under its own key as before (never lost)", sb.rows.has("entity:4000001") && sb.rows.has("entity:i.5000001"));
  const found = await db.findEntities("Calloway Insurance", 50);
  ok("and a look-up still lists the company once", found.length === 1 && found[0].companyId === "4000001" && found[0].naicGroupName === "Calloway Group (SNL P&C Group)", found);
}
{
  // ----- the stand-in database the other suites use behaves the same -----
  const db = memoryDb(fakeClock());
  await db.putEntities([LISTED]);
  await db.putEntities([FROM_RESULTS]);
  ok("the in-memory stand-in merges the same way", db.store.size === 1 && same(db.store.get("entity:i.5000001")!.doc, FULL));
}

// =====================================================================================================
// C. ids: text or number
// =====================================================================================================
{
  ok("'1' and 1 are the same id", sameId("1", 1) && sameId(1, "1") && sameId(" 11 ", 11) && sameId("11.0", 11));
  ok("a state matches in any letter case", sameId("fl", "FL") && sameId(" FL", "FL"));
  ok("different ids, and missing ones, don't match", !sameId("1", 2) && !sameId(null, null) && !sameId("", "") && !sameId(undefined, 0) && !sameId(true, "true") && !sameId({}, "[object Object]"));
  forgetTokens();
  const clock = fakeClock();
  // live rows: serffFilingTypeId and the company ids as text
  const rows = [filing(1, { serffFilingTypeId: "11", companyId: "9100001", institutionId: "810001", serffFilingStateId: "fl" }), filing(2, { serffFilingTypeId: 11 })];
  const sp = spStub(clock, () => J(spPage(rows, { totalPages: 1 })));
  const api = new Spgmi({ username: "u", password: "p" }, { fetch: sp.fetch, gate: async () => {}, sleep: clock.sleep });
  const p = parseSearch({ companyIds: ["9100001"], states: ["FL"], from: "2026-01-01", to: "2026-11-13" }, "2026-11-13");
  const res = await searchFilings(api, (p as any).params);
  ok("the counts by state and by company match text ids to the search's numbers", same(res.byState, [{ state: "FL", rows: 2 }]) && res.byCompany[0].rows === 2 && res.byCompany[0].name === "Calloway Insurance Co", { byState: res.byState, byCompany: res.byCompany });
  ok("so no note says S&P returned nothing for a company it did return", !res.notes.some((n: string) => n.includes("returned nothing")), res.notes);
  ok("a text filing type id in a choice from the page is taken as the number", (parseSearch({ companyIds: [1], states: ["FL"], filingTypeIds: ["11"], from: "2026-01-01", to: "2026-11-13" }, "2026-11-13") as any).params.filingTypeIds[0] === 11);
}

// =====================================================================================================
// D. a document over the download limit
// =====================================================================================================
{
  const body = (chunks: number, size: number) => {
    const s = { pulled: 0, cancelled: false };
    const stream = new ReadableStream({ pull(c) { if (s.pulled >= chunks) return c.close(); s.pulled++; c.enqueue(new Uint8Array(size).fill(7)); }, cancel() { s.cancelled = true; } }, { highWaterMark: 0 });
    return { s, stream };
  };
  let b = body(10, 10);
  let got = await readUpTo(new Response(b.stream, { headers: { "content-length": "101" } }), 100);
  ok("over the limit by S&P's stated length: turned down before any of it is read", got.bytes === null && got.declared === 101 && b.s.pulled === 0 && b.s.cancelled, { got, s: b.s });
  b = body(10, 10);
  got = await readUpTo(new Response(b.stream, { headers: { "content-length": "100" } }), 100);
  ok("at the limit: read whole, in one block of the stated size", got.bytes!.length === 100 && got.bytes!.buffer.byteLength === 100 && got.bytes!.every((x: number) => x === 7));
  b = body(10, 10);
  got = await readUpTo(new Response(b.stream), 95);
  ok("with no stated length: reading stops as soon as it passes the limit", got.bytes === null && got.declared === null && b.s.pulled === 10 && b.s.cancelled, b.s);
  b = body(3, 10);
  got = await readUpTo(new Response(b.stream, { headers: { "content-length": "20" } }), 100);
  ok("longer than S&P said, but under the limit: all of it is kept", got.bytes!.length === 30);
  b = body(3, 10);
  got = await readUpTo(new Response(b.stream, { headers: { "content-length": "50" } }), 100);
  ok("shorter than S&P said: just what came", got.bytes!.length === 30);
  b = body(9, 10);
  got = await readUpTo(new Response(b.stream, { headers: { "content-length": "50" } }), 60);
  ok("longer than S&P said and over the limit: turned down", got.bytes === null);
  got = await readUpTo(new Response(null, { headers: { "content-length": "abc" } }), 100);
  ok("a stated length that isn't a number is ignored", got.bytes!.length === 0 && got.declared === null);

  // through an answer: refused early, the request counted, plain words for the user and for Claude
  let pulled = 0, cancelled = false, seen: any;
  const w = world([filing(1, { trackingNumber: null, sfcNumber: SP, pages: 900 })], () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status: 200, headers: { "content-type": "application/pdf", "content-length": "72400000" } }), [
    { content: [SEARCH()] }, { content: [READ("r1", 71000001)] },
    (body) => { seen = toolResults(body).r1; return { content: [say("Couldn't read it.")] }; }, NO_TABLE,
  ]);
  const before = await w.db.usage();
  const a = await w.ask();
  const after = await w.db.usage();
  ok("a 72 MB filing is turned down from its stated length, without reading it, and nothing is sent to Claude", seen.isError && pulled === 0 && cancelled && w.claude.uploads.length === 0, { pulled, cancelled });
  ok("Claude is told plainly why, that no part can be read, and what to tell the user", seen.value.error === "This document is too large to read here: it is 73 MB, over the 60 MB limit for one document, so no part of it can be read. Don't ask for it again. Tell the user to open it from the Filings view, and answer from the search results.", seen.value.error);
  ok("the answer says so, naming the filing by S&P's number", a.result.caps.includes(`Filing S&P no. ${SP} is 73 MB, too large for Claude to read here (the limit is 60 MB a document). Open it from the Filings view to read it yourself.`), a.result.caps);
  ok("the download is still counted: by the app's counter and in the answer's S&P requests", w.sp.calls("/api/v1/download").length === 1 && after.hour - before.hour === w.sp.log.filter((c) => c.path !== "token").length + 1 && a.result.usage.spRequests === after.hour - before.hour, { before, after, usage: a.result.usage });
  ok("the limit is 60 MB, under the 256 MB a function may use, with the measured peak in mind", LIMITS.docBytes === 60_000_000);
  ok("pdf-lib reads the file in place", READS_IN_PLACE === true);
  const pdf = await makePdf(12), kept = pdf.slice(), opened = await openPdf(pdf);
  const cut = opened.ok ? await cutPages(opened.doc, 3, 7) : null;
  const back = cut ? await PDFDocument.load(cut) : null;
  ok("…and a cut is still a sound PDF of just the pages asked for, with the file left as it was", !!back && back.getPageCount() === 5 && pdf.length === kept.length && pdf.every((x, i) => x === kept[i]));
}

// =====================================================================================================
// F. watchlist marks when S&P sends no description
// =====================================================================================================
{
  const base = { filing_version_id: "v-1", companies: ["Calloway Insurance Co"], state: "FL", filing_type: "Rate", type_of_insurance: "Homeowners", sub_type_of_insurance: null, filing_status: "Pending", rate_impact: null, tracking_number: `S&P no. ${SP}` } as any;
  let threw = false, marks: any[] = [];
  try { marks = [null, undefined, "", "   ", 0, {}, []].map((d) => flagFiling({ ...base, description: d })); } catch { threw = true; }
  ok("no description (missing, empty, blank or not text): no error and no mark", !threw && marks.every((m) => same(m, [])), marks);
  const kinds = (over: Record<string, unknown>) => flagFiling({ ...base, description: null, ...over }).map((f) => f.kind);
  ok("the rate impact still marks a large change, read from overallRateImpact as live rows send it", same(kinds({ rate_impact: "-11" }), ["large_rate"]) && same(kinds({ rate_impact: "-0.8" }), []) && flagFiling({ ...base, description: null, rate_impact: "-11" })[0].reason === "the overall rate impact is -11.0%");
  ok("the status and the filing type still mark a withdrawal", same(kinds({ filing_status: "Closed - Withdrawn" }), ["withdrawal"]) && same(kinds({ filing_type: "Withdrawal" }), ["withdrawal"]));
  ok("the filing type and the type of insurance still mark a new program", same(kinds({ filing_type: "New Program" }), ["new_program"]) && same(kinds({ sub_type_of_insurance: "New high value homeowners program" }), ["new_program"]));
  ok("new form and new to state can't fire without a description", ["new_form", "new_state"].every((k) => !kinds({ filing_type: "Form", type_of_insurance: "New form", rate_impact: "-2" }).includes(k as any)));
  const rows = [filing(1, { trackingNumber: null, sfcNumber: SP, filingDescription: null, overallRateImpact: -11, dispOverallRateImpact: null }), filing(2, { trackingNumber: null, sfcNumber: SP2, filingDescription: null, overallRateImpact: -0.8, dispOverallRateImpact: null })];
  const found = dedupe(mapRows(spPage(rows))).map((f, i) => foundRow(f, "run-1", "2026-11-18T06:00:00Z", false)!);
  const marked = markFound(found);
  ok("live-shaped rows: the -11 rate change is marked and listed first; the -0.8 one is not", same(marked.map((r) => [r.tracking_number, r.flags.map((f) => f.kind)]), [[`S&P no. ${SP}`, ["large_rate"]], [`S&P no. ${SP2}`, []]]), marked.map((r) => [r.tracking_number, r.flags]));
  const mail = watchEmail(found, { now: Date.parse("2026-11-18T06:00:00Z"), site: null });
  ok("the email says No description and names each by S&P's number", mail.text.includes(`: No description (S&P no. ${SP})`) && mail.text.includes(`: No description (S&P no. ${SP2})`) && mail.text.includes("[Large rate change]"), mail.text);
}

done();
