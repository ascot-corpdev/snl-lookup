// The snl-chat function end to end, through handle(): ask and continue, the tool loop, documents and the Files
// API, the limits on one question, time slices (pause, resume, a function call that died), clearing up, and
// every way an answer can fail. S&P, Snowflake and Claude are stand-ins; nothing is billed and nothing is real.
(globalThis as any).__SNL_TEST__ = true;
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { LIMITS, SYSTEM, TOO_SLOW } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
const { forgetTokens, NOT_CONFIGURED } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
const { SNOWFLAKE_NOT_CONFIGURED } = await import(new URL("../../supabase/functions/_shared/snowflake.ts", import.meta.url).href);
import { checks, documentsIn, env, fakeAnthropic, fakeClock, fakeSpgmi, J, memoryDb, pageCite, PDF, type Reply, req, say, thinking, toolResults, toolUse } from "./helpers/fakes.ts";
import { filing, finish, never, spPage, spStub } from "./helpers/more.ts";
import { fakeSnowflake, route } from "./helpers/snowflake.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "test-anthropic-key" };
const IDS = [9100001, 9100002, 9100003, 9200001];
const DOCS = {
  "70000001": { bytes: PDF("Homeowner Program. Policy form CHO 30 01 (06 25)."), name: "CALL-134000001.pdf" },
  "70000002": { bytes: PDF("Signature Home. Policy form SH-HO 01 (12 25)."), name: "CALL-134000002.pdf" },
  "70000003": { bytes: PDF("Homeowner Program rate revision."), name: "CALL-134000003.pdf" },
  "70000004": { bytes: PDF("Rules manual."), name: "CALL-134000004.pdf" },
  "70000005": { bytes: PDF("Homeowners policy form TMI-HO 3 (02 25)."), name: "TARR-135000001.pdf" },
  "70000007": { bytes: PDF("Policy form CHO 30 01 (08 22)."), name: "CALL-132000009.pdf" },
  "0A0A0A0A-0000-4000-8000-000000000006": { bytes: new TextEncoder().encode("PK made-up spreadsheet bytes"), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "TARR-135000002.xlsx" },
  "70000090": { bytes: new TextEncoder().encode("Plain text filing memo. Form TXT-1."), type: "text/plain; charset=utf-8", name: "memo.txt" },
  "70000091": { bytes: new TextEncoder().encode("<html>login page</html>"), type: "text/html", name: "x.html" },
};
const NO_TABLE: Reply = { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] };
const SEARCH_ALL = (id = "s1") => toolUse(id, "search_filings", { company_ids: IDS, institution_ids: [], states: ["FL"], from: "2021-11-13", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] });
const READ = (id: string, documentId: number | null, versionId: string | null = null) => toolUse(id, "read_filing_document", { document_id: documentId, filing_version_id: versionId });
const USER = { id: "login-7f3a9c2e", role: "corpdev" };
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string) { for (let i = 0; i < 2000 && !cond(); i++) await tick(); if (!cond()) throw new Error(`never happened: ${what}`); }
const silently = async <T>(work: () => Promise<T>): Promise<T> => { const keep = console.error; console.error = () => {}; try { return await work(); } finally { console.error = keep; } };

type Opts = { secrets?: Record<string, string>; documents?: Record<string, { bytes: Uint8Array; type?: string; name?: string }>; spFetch?: (inner: typeof fetch) => typeof fetch; claudeFetch?: (inner: typeof fetch) => typeof fetch; who?: { id: string; role: string } };
function world(script: Parameters<typeof fakeAnthropic>[0], opts: Opts = {}) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock, { documents: opts.documents ?? DOCS }), claude = fakeAnthropic(script);
  const pending: Promise<unknown>[] = [], claudeHeaders: Record<string, string>[] = [];
  const recording = (async (input: string | URL | Request, init: RequestInit = {}) => { claudeHeaders.push(Object.fromEntries(new Headers(init.headers))); return claude.fetch(input, init); }) as typeof fetch;
  const deps = {
    env: env(opts.secrets ?? SECRETS), fetch: opts.spFetch ? opts.spFetch(sp.fetch) : sp.fetch, anthropicFetch: opts.claudeFetch ? opts.claudeFetch(recording) : recording,
    now: clock.fn, whoIs: async () => opts.who ?? USER, db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); },
  };
  const post = async (body: unknown, over: Record<string, unknown> = {}) => { const res: Response = await chat.handle(req("snl-chat", body), { ...deps, ...over }); return { res, status: res.status, body: await res.json() }; };
  const settle = async () => { while (pending.length) await pending.shift(); };
  /** Asks and waits for the background work of that function call to end (finished, failed or paused). */
  const ask = async (question = "Do Calloway file separate homeowners forms in Florida?", extra: Record<string, unknown> = {}) => {
    const r = await post({ action: "ask", question, ...extra });
    await settle();
    const jobId = r.body.jobId as string;
    return { jobId, job: db.jobs.get(jobId)!, result: db.jobs.get(jobId)?.result as any, status: r.status, body: r.body };
  };
  const cont = async (jobId: string, over: Record<string, unknown> = {}) => { const r = await post({ action: "continue", jobId }, over); await settle(); return r; };
  return { clock, db, sp, claude, deps, pending, claudeHeaders, post, settle, ask, cont, job: (id: string) => db.jobs.get(id)!, messages: () => claude.calls.filter((c) => c.body.tools) };
}

// ---------- ask: the answer starts in the background ----------
{
  const w = world([{ content: [say("S&P's data has nothing on that.")] }, NO_TABLE]);
  const r = await w.post({ action: "ask", question: "  What did Calloway file?  " });
  const id = r.body.jobId;
  ok("ask answers 202 with a job id at once", r.status === 202 && typeof id === "string" && same(Object.keys(r.body), ["jobId"]), r.body);
  ok("the answer is queued and Claude hasn't been called yet when ask returns", w.claude.calls.length === 0 && w.pending.length === 1 && w.job(id).result === null && ["queued", "running"].includes(w.job(id).status));
  ok("the job belongs to the caller and holds the trimmed question", w.job(id).owner === USER.id && w.job(id).question === "What did Calloway file?");
  ok("the answer's place is saved before it starts", w.db.states.has(id));
  await w.settle();
  const job = w.job(id), res = job.result as any;
  ok("the work then runs in the background and lands in the job row", job.status === "done" && job.error === null && same(res.answer, [{ text: "S&P's data has nothing on that.", cites: [] }]), job);
  ok("with needs_table false there is no table and no limit note", res.table === null && same(res.caps, []), res);
  ok("the result carries sources, lookups, the model and usage", same(res.sources, []) && same(res.lookups, []) && res.model === "claude-opus-5-5" && res.usage.inputTokens === 2000 && res.usage.outputTokens === 400 && typeof res.usage.spRequests === "number", res);
  ok("the partial text is cleared and the saved place dropped when the answer finishes", job.partial === "" && !w.db.states.has(id));
  ok("progress ends with building the table", job.progress.at(-1)?.text === "Building the comparison table" && job.progress.every((s) => typeof s.at === "string"), job.progress);

  const first = w.claude.calls[0], body = first.body;
  ok("the model is claude-opus-5-5 unless CLAUDE_MODEL is set", body.model === "claude-opus-5-5" && w.claude.calls[1].body.model === "claude-opus-5-5");
  ok("the answer request streams, with adaptive thinking and high effort", first.stream === true && same(body.thinking, { type: "adaptive" }) && body.output_config?.effort === "high" && body.max_tokens > 0, body.output_config);
  ok("server-side fallback is on, with its beta header", body.fallbacks === "default" && (first.betas ?? "").split(",").map((s) => s.trim()).includes("server-side-fallback-2026-07-01"), first.betas);
  ok("the six strict tools are sent", same(body.tools.map((t: any) => [t.name, t.strict]), [["resolve_entity", true], ["resolve_entities", true], ["search_filings", true], ["query_market_index", true], ["read_filing_document", true], ["query_statutory", true]]));
  ok("the system prompt is the app's own text plus S&P's reference ids", body.system.length === 2 && body.system[0].text === SYSTEM && body.system[1].text.startsWith("S&P's reference ids for search filters."), body.system[1].text);
  ok("Claude is sent only the question and today's date", same(body.messages, [{ role: "user", content: [{ type: "text", text: "What did Calloway file?" }, { type: "text", text: "Today is 2026-11-13." }] }]), body.messages);
  const sent = JSON.stringify(w.claude.calls.map((c) => c.body)), heads = JSON.stringify(w.claudeHeaders);
  ok("no user id, role, job id or login token appears in anything sent to Claude", !sent.includes(USER.id) && !sent.includes("corpdev") && !sent.includes(id) && !sent.includes("Bearer u") && body.metadata === undefined && !heads.includes(USER.id) && !heads.includes("Bearer u"), { metadata: body.metadata });
  ok("no S&P or Snowflake secret appears in anything sent to Claude", !sent.includes("api-pass") && !sent.includes("api-user") && !heads.includes("api-pass"));
  ok("the Anthropic key travels only as the request's credential header, never in a body", w.claudeHeaders.length === 2 && w.claudeHeaders.every((h) => h["x-api-key"] === "test-anthropic-key" || h.authorization === "Bearer test-anthropic-key") && !sent.includes("test-anthropic-key"), w.claudeHeaders.map((h) => Object.keys(h)));
  ok("the table request carries the question and the answer, and nothing else about the user", w.claude.calls[1].body.messages[0].content.includes("What did Calloway file?") && w.claude.calls[1].body.messages[0].content.includes("S&P's data has nothing on that."));

  const other = world([{ content: [say("Fine.")] }, NO_TABLE], { secrets: { ...SECRETS, CLAUDE_MODEL: "claude-test-model" } });
  await other.ask();
  ok("CLAUDE_MODEL changes the model for the answer and the table", other.claude.calls.length === 2 && other.claude.calls.every((c) => c.body.model === "claude-test-model"), other.claude.calls.map((c) => c.body.model));
}
{
  const history = [{ question: " Which companies are in the Calloway group? ", answer: "Three: Calloway Insurance Co, Calloway Home Co and Calloway Coastal Co. " }, { question: "And Tarrow?", answer: "Tarrow Mutual Insurance Co files on its own." }];
  const w = world([(body) => ({ content: [say(`Seen ${body.messages.length} messages.`)] }), NO_TABLE]);
  const a = await w.ask("Which of them filed forms in 2025?", { history });
  ok("earlier turns of the conversation go to Claude in order, before the new question", a.job.status === "done" && same(w.claude.calls[0].body.messages, [
    { role: "user", content: "Which companies are in the Calloway group?" }, { role: "assistant", content: "Three: Calloway Insurance Co, Calloway Home Co and Calloway Coastal Co." },
    { role: "user", content: "And Tarrow?" }, { role: "assistant", content: "Tarrow Mutual Insurance Co files on its own." },
    { role: "user", content: [{ type: "text", text: "Which of them filed forms in 2025?" }, { type: "text", text: "Today is 2026-11-13." }] }]), w.claude.calls[0].body.messages);
  ok("six earlier turns are allowed", (await world([{ content: [say("ok")] }, NO_TABLE]).ask("Q", { history: Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` })) })).job.status === "done");

  const v = world([]);
  for (const [name, body] of [["no question", {}], ["an empty question", { question: "" }], ["a question of spaces", { question: "   \n " }], ["a question that isn't text", { question: { text: "hi" } }], ["a question as a list", { question: ["hi"] }], ["a question of 4,001 characters", { question: "q".repeat(4001) }]] as const) {
    const r = await v.post({ action: "ask", ...body });
    ok(`ask with ${name} is refused and nothing is started`, r.status === 400 && r.body.error === "bad" && r.body.message === "Type a question of up to 4,000 characters." && v.db.jobs.size === 0 && v.pending.length === 0, r.body);
  }
  for (const [name, history] of [["history that isn't a list", "earlier"], ["seven earlier turns", Array.from({ length: 7 }, () => ({ question: "q", answer: "a" }))], ["a turn with no answer", [{ question: "q" }]], ["a turn with an empty question", [{ question: " ", answer: "a" }]], ["a turn that is null", [null]],
    ["a turn whose answer isn't text", [{ question: "q", answer: { a: 1 } }]], ["a turn with an answer over 20,000 characters", [{ question: "q", answer: "a".repeat(20_001) }]], ["a turn with a question over 4,000 characters", [{ question: "q".repeat(4001), answer: "a" }]], ["history as an object", { 0: { question: "q", answer: "a" } }]] as const) {
    const r = await v.post({ action: "ask", question: "Q", history });
    ok(`ask with ${name} is refused and nothing is started`, r.status === 400 && r.body.error === "bad" && /Start a new conversation/.test(r.body.message) && v.db.jobs.size === 0, r.body);
  }
  ok("a question of exactly 4,000 characters is accepted", (await v.post({ action: "ask", question: "q".repeat(4000) })).status === 202);
  await silently(() => v.settle());
  const full = world([]);
  const r = await full.post({ action: "ask", question: "Q" }, { db: { ...full.db, createJob: async () => null } });
  ok("if the job row can't be created the caller is told plainly", r.status === 500 && r.body.error === "server" && r.body.message === "The answer couldn't be started. Try again." && full.pending.length === 0, r.body);
}
{
  const w = world([], { secrets: { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" } });
  for (const [name, body] of [["ask", { action: "ask", question: "Q" }], ["continue", { action: "continue", jobId: "00000000-0000-4000-8000-000000000001" }], ["an unknown action", { action: "stop" }]] as const) {
    const r = await w.post(body);
    ok(`with no Anthropic key, ${name} answers 503 not_configured in plain words`, r.status === 503 && r.body.error === "not_configured" && r.body.message === chat.CLAUDE_NOT_CONFIGURED && chat.CLAUDE_NOT_CONFIGURED.includes("ANTHROPIC_API_KEY"), r.body);
  }
  ok("and nothing is started or sent", w.db.jobs.size === 0 && w.claude.calls.length === 0 && w.pending.length === 0);
  const key = world([]);
  const bad = await key.post({ action: "stop" });
  ok("an unknown action is refused, naming the two that exist", bad.status === 400 && bad.body.message === "Unknown action. Use ask or continue.", bad.body);
}

// ---------- the tool loop: look-ups, documents and the Files API ----------
{
  const seen: Record<string, any> = {};
  const w = world([
    { content: [thinking(), SEARCH_ALL("s1")] },
    (body) => { seen.search = toolResults(body).s1; return { content: [say("Reading two filings."), READ("r1", 70000001), READ("r2", 70000002), READ("r3", 70000001)] }; },
    (body) => { seen.round2 = body; seen.partial = w.job([...w.db.jobs.keys()][0]).partial; return { content: [READ("r4", 70000002), READ("r5", null, "0A0A0A0A-0000-4000-8000-000000000001"), READ("r6", 70000005)] }; },
    (body) => { seen.round3 = body; return { content: [say("Calloway uses CHO 30 01.", [pageCite(0, 3, 5, "Policy form CHO 30 01 (06 25)")]), say("\n"), say("Tarrow uses TMI-HO 3.", [pageCite(2, 1, 2, "TMI-HO 3 (02 25)")])] }; },
    (body) => { seen.table = body; return NO_TABLE; },
  ]);
  const before = w.sp.log.length;
  const a = await w.ask();
  ok("an answer that searches and reads documents finishes", a.job.status === "done" && a.job.error === null, a.job.error);
  ok("text Claude writes while it works shows on the job as partial text", seen.partial.length > 0 && "Reading two filings.".startsWith(seen.partial), seen.partial);
  ok("Claude's search result names the source, totals, per-state and per-company counts, notes and compact rows", seen.search.isError === false && seen.search.value.source.includes("SNL Insurance Product Filings") && seen.search.value.total === 7 && seen.search.value.shown === 7 && seen.search.value.fromSavedResult === false && same(seen.search.value.byState, [{ state: "FL", rows: 7 }])
    && seen.search.value.byCompany.length === 4 && Array.isArray(seen.search.value.notes) && seen.search.value.filings.every((f: any) => "trackingNumber" in f && "documentId" in f && "pages" in f && !("serffFilingEntityEventId" in f)), seen.search.value);
  const r2 = toolResults(seen.round2), docs2 = documentsIn(seen.round2);
  ok("each document goes to Claude as a document block on a file id, with citations on and a title that names the filing", docs2.length === 2 && same(docs2.map((d) => [d.type, d.source, d.citations]), [["document", { type: "file", file_id: "file_test1" }, { enabled: true }], ["document", { type: "file", file_id: "file_test2" }, { enabled: true }]])
    && docs2[0].title === "CALL-134000001, Calloway Insurance Co, Calloway Home Co, FL, Form" && docs2[1].title.startsWith("CALL-134000002, Calloway Coastal Co"), docs2);
  ok("the document's bytes are never put in the request itself", !JSON.stringify(seen.round2).includes("made-up test document") && !JSON.stringify(seen.round2).includes("%PDF") && docs2.every((d) => d.source.data === undefined));
  ok("the tool results say the document is attached, with its pages", r2.r1.value.attached === true && r2.r1.value.pages === 42 && r2.r2.value.pages === 58 && !r2.r1.isError, r2);
  ok("asking for the same document again in the same step attaches nothing new", r2.r3.value.attached === true && /already attached above as "CALL-134000001/.test(r2.r3.value.note) && !r2.r3.isError, r2.r3);
  const last = seen.round2.messages.at(-1).content;
  ok("results come first, in the order asked, then the documents, in one user turn", same(last.map((b: any) => b.type), ["tool_result", "tool_result", "tool_result", "document", "document"]) && same(last.slice(0, 3).map((b: any) => b.tool_use_id), ["r1", "r2", "r3"]) && last.slice(0, 3).every((b: any) => typeof b.content === "string"), last.map((b: any) => b.type));
  ok("Claude's own turn is echoed back before its results, thinking included", seen.round2.messages.at(-2).role === "assistant" && same(seen.round2.messages.at(-2).content.map((b: any) => b.type), ["text", "tool_use", "tool_use", "tool_use"]) && same(seen.round2.messages[1].content.map((b: any) => b.type), ["thinking", "tool_use"]));
  const r3 = toolResults(seen.round3), docs3 = documentsIn(seen.round3);
  ok("asking again in a later step for a document already read downloads and uploads nothing", /already attached/.test(r3.r4.value.note) && w.sp.calls("/api/v1/download").length === 3 && w.claude.uploads.length === 3, { downloads: w.sp.calls("/api/v1/download").length, uploads: w.claude.uploads.length });
  ok("the same filing asked for by its version id is recognised as already attached", /already attached/.test(r3.r5.value.note ?? ""), r3.r5);
  ok("documents stay in the conversation, in the order read, so citation numbers hold", same(docs3.map((d) => d.source.file_id), ["file_test1", "file_test2", "file_test3"]));
  ok("each document was uploaded once, as a PDF with a neutral file name", same(w.claude.uploads.map((u) => u.type), ["application/pdf", "application/pdf", "application/pdf"]) && w.claude.uploads.every((u) => u.size > 0));
  ok("every uploaded file is deleted when the answer finishes", same([...w.claude.deleted].sort(), ["file_test1", "file_test2", "file_test3"]) && !w.db.states.has(a.jobId), w.claude.deleted);
  ok("citations point at the right filings", same(a.result.sources.map((s: any) => [s.n, s.documentId, s.trackingNumber, s.pages]), [[1, 70000001, "CALL-134000001", "3-4"], [2, 70000005, "TARR-135000001", "1"]]) && same(a.result.answer.map((s: any) => s.cites), [[1], [2]]), a.result.sources);
  ok("look-ups are listed in plain words, one for each search and each document read", same(a.result.lookups.map((l: any) => l.tool), ["search_filings", "read_filing_document", "read_filing_document", "read_filing_document"]) && a.result.lookups[0].detail === "4 companies, FL, 2021 to 2026: 7 filings" && a.result.lookups[1].detail === "CALL-134000001, 42 pages", a.result.lookups);
  ok("progress says what is being done in plain English", ["Searching S&P filings: 4 companies, FL, 2021 to 2026", "S&P returned 7 filings (6 requests)", "Reading filing CALL-134000001 (42 pages)", "Reading filing TARR-135000001 (36 pages)", "Building the comparison table"].every((t) => a.job.progress.some((s) => s.text === t)), a.job.progress.map((s) => s.text));
  ok("S&P requests made for the answer are counted on it", a.result.usage.spRequests === w.sp.log.length - before && a.result.usage.spRequests === 1 + 2 + 2 + 6 + 3, { counted: a.result.usage.spRequests, calls: w.sp.log.slice(before).map((c) => c.path) });
  ok("every S&P call was at least a second after the one before", w.sp.log.every((c, i) => i === 0 || c.at - w.sp.log[i - 1].at >= 1000));
  ok("the table request carries no document blocks and no tools, and lists the filings found", documentsIn(seen.table).length === 0 && seen.table.tools === undefined && seen.table.output_config.format.type === "json_schema" && seen.table.messages[0].content.includes("CALL-134000002") && !JSON.stringify(seen.table).includes("file_test"), seen.table.output_config);
  ok("no login detail reached Claude anywhere in the tool loop", !JSON.stringify(w.claude.calls.map((c) => c.body)).includes(USER.id) && !JSON.stringify(w.claude.calls.map((c) => c.body)).includes(a.jobId));
}
{
  // the same filing by version id first, then by document id
  const seen: Record<string, any> = {};
  const w = world([{ content: [SEARCH_ALL("s1")] }, { content: [READ("v1", null, "0A0A0A0A-0000-4000-8000-000000000002")] }, { content: [READ("d1", 70000002)] }, (body) => { seen.end = body; return { content: [say("Done.", [pageCite(0, 1, 2, "x")])] }; }, NO_TABLE],
    { documents: { ...DOCS, "0A0A0A0A-0000-4000-8000-000000000002": DOCS["70000002"] } });
  const a = await w.ask();
  ok("a filing read by version id and then asked for by document id is attached once, not downloaded twice", w.claude.uploads.length === 1 && w.sp.calls("/api/v1/download").length === 1 && /already attached/.test(toolResults(seen.end).d1?.value.note ?? ""), { uploads: w.claude.uploads.length, downloads: w.sp.calls("/api/v1/download").length, d1: toolResults(seen.end).d1?.value });
  ok("a source read by version id still names the filing's document id from the search row", a.result.sources[0]?.documentId === 70000002 && a.result.sources[0]?.filingVersionId === "0A0A0A0A-0000-4000-8000-000000000002" && a.result.sources[0]?.trackingNumber === "CALL-134000002", a.result.sources[0]);
}
{
  // documents that can't be read, bad inputs, and S&P failures inside a tool
  const seen: Record<string, any> = {};
  const w = world([
    { content: [SEARCH_ALL("s1")] },
    { content: [READ("x1", null, "0A0A0A0A-0000-4000-8000-000000000006"), READ("x2", 70000091), READ("x3", 70000090), READ("x4", 79999999), READ("x5", null, null), READ("x6", -5), toolUse("x7", "resolve_entity", { query: "   " }),
      toolUse("x8", "search_filings", { company_ids: [], institution_ids: [], states: ["FL"], from: "2025-01-01", to: "2025-12-31", type_of_insurance_ids: [], filing_type_ids: [] }), toolUse("x9", "search_filings", { company_ids: [9100001], institution_ids: [], states: ["Florida"], from: "2025-01-01", to: "2025-12-31", type_of_insurance_ids: [], filing_type_ids: [] }),
      toolUse("x10", "delete_everything", {}), toolUse("x11", "resolve_entity", { query: "Nonesuch Mutual" }), toolUse("x12", "query_statutory", { kind: "company", naic_codes: ["91001"], from_year: 2022, to_year: 2025, fields: [] })] },
    (body) => { seen.r = toolResults(body); seen.body = body; w.sp.failNext.push({ status: 403 }); return { content: [READ("y1", 70000003)] }; },
    (body) => { seen.r2 = toolResults(body); w.sp.failNext.push({ status: 500 }); return { content: [toolUse("y2", "search_filings", { company_ids: [9100001], institution_ids: [], states: ["TX"], from: "2025-01-01", to: "2025-12-31", type_of_insurance_ids: [], filing_type_ids: [] })] }; },
    (body) => { seen.r3 = toolResults(body); return { content: [say("I couldn't read some of them.", [{ type: "char_location", cited_text: "Form TXT-1", document_index: 0, document_title: "memo", start_char_index: 25, end_char_index: 35, file_id: null }])] }; },
    NO_TABLE,
  ]);
  const a = await silently(() => w.ask());
  const r = seen.r;
  ok("a document that isn't a PDF is refused with a plain tool error that says what to do", r.x1.isError && /^This document is a application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet file, which can't be read here\. Tell the user to open it from the Filings view\.$/.test(r.x1.value.error) && r.x2.isError && /text\/html/.test(r.x2.value.error), [r.x1, r.x2]);
  ok("a refused document is not uploaded or attached", w.claude.uploads.length === 1 && documentsIn(seen.body).length === 1, w.claude.uploads);
  ok("a plain-text document is read, uploaded as text", !r.x3.isError && r.x3.value.attached === true && w.claude.uploads[0].type === "text/plain" && documentsIn(seen.body)[0].citations.enabled === true, r.x3);
  ok("a document S&P doesn't have goes back to Claude as a tool error in plain words, with S&P's reference", r.x4.isError && /^S&P couldn't find that \(404\)\..*S&P reference: req-\d+\.$/.test(r.x4.value.error), r.x4);
  ok("a read with no id, or a bad id, is a tool error that says what to send", r.x5.isError && r.x6.isError && r.x5.value.error === "Give the documentId (a number) or the filingVersionId from a search row.", [r.x5, r.x6]);
  ok("an empty look-up is a tool error", r.x7.isError && r.x7.value.error === "Give a company name, a NAIC code or an S&P id.");
  ok("a search with no company, or a state written out, is a tool error with the reason", r.x8.isError && /Choose at least one company/.test(r.x8.value.error) && r.x9.isError && /two-letter code/.test(r.x9.value.error), [r.x8, r.x9]);
  ok("a tool the app doesn't have is a tool error, and nothing runs", r.x10.isError && r.x10.value.error === "Unknown tool delete_everything.");
  ok("a company that isn't known comes back with the note that explains why, not as an error", !r.x11.isError && r.x11.value.matches.length === 0 && /S&P's filings API has no company search/.test(r.x11.value.note), r.x11);
  ok("statutory data that isn't set up is a tool error that says so", r.x12.isError && r.x12.value.error === SNOWFLAKE_NOT_CONFIGURED, r.x12);
  ok("an S&P entitlement refusal inside a tool goes back to Claude in plain words rather than failing the answer", seen.r2.y1.isError && /isn't entitled to SNL Insurance Product Filings/.test(seen.r2.y1.value.error) && /S&P reference: req-forced\./.test(seen.r2.y1.value.error), seen.r2.y1);
  ok("an S&P outage inside a search goes back to Claude the same way", seen.r3.y2.isError && /S&P's service failed \(500\)/.test(seen.r3.y2.value.error), seen.r3.y2);
  ok("the answer still finishes, citing the text document without page numbers", a.job.status === "done" && a.result.sources[0].pages === null && a.result.sources[0].documentId === 70000090 && a.result.sources[0].quote === "Form TXT-1" && same(a.result.caps, []), { status: a.job.status, error: a.job.error, sources: a.result?.sources });
  ok("failed look-ups aren't listed as look-ups done", same(a.result.lookups.map((l: any) => l.tool), ["search_filings", "read_filing_document", "resolve_entity"]), a.result.lookups);
  ok("the one uploaded file is deleted at the end", same(w.claude.deleted, ["file_test1"]));
}
{
  // S&P not set up: saved searches still open, everything else is a plain tool error
  const on = world([{ content: [SEARCH_ALL("s1")] }, { content: [say("ok")] }, NO_TABLE]);
  await on.ask();
  const seen: Record<string, any> = {};
  const off = world([
    (body) => { seen.system = body.system[1].text; return { content: [SEARCH_ALL("s1"), toolUse("s2", "search_filings", { company_ids: [9100001], institution_ids: [], states: ["TX"], from: "2025-01-01", to: "2025-12-31", type_of_insurance_ids: [], filing_type_ids: [] }), READ("r1", 70000001), toolUse("e1", "resolve_entity", { query: "calloway" })] }; },
    (body) => { seen.r = toolResults(body); return { content: [say("S&P isn't connected yet.")] }; }, NO_TABLE,
  ], { secrets: { ANTHROPIC_API_KEY: "test-anthropic-key" } });
  for (const [id, row] of on.db.store) off.db.store.set(id, row);
  const a = await off.ask();
  ok("before S&P is set up, a saved search still opens for Claude and is marked as saved", !seen.r.s1.isError && seen.r.s1.value.fromSavedResult === true && seen.r.s1.value.total === 7, seen.r.s1);
  ok("a search that isn't saved comes back as the plain not-set-up message", seen.r.s2.isError && seen.r.s2.value.error === NOT_CONFIGURED);
  ok("so does reading a document", seen.r.r1.isError && seen.r.r1.value.error === NOT_CONFIGURED);
  ok("company look-up still works", !seen.r.e1.isError && seen.r.e1.value.matches.length === 3);
  ok("the answer finishes, having sent nothing to S&P", a.job.status === "done" && off.sp.log.length === 0 && a.result.usage.spRequests === 0, { status: a.job.status, calls: off.sp.log.length });
  ok("saved reference lists still reach the system prompt", seen.system.startsWith("S&P's reference ids for search filters."), seen.system);
}
{
  // more rows than Claude is shown, and a search cut short by its request cap
  forgetTokens();
  const many = Array.from({ length: 180 }, (_, i) => filing(i + 1, { publishDate: `2026-0${1 + (i % 9)}-1${i % 9}` }));
  const seen: Record<string, any> = {};
  const w = world([
    { content: [toolUse("s1", "search_filings", { company_ids: [9100001], institution_ids: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] })] },
    (body) => { seen.s1 = toolResults(body).s1; return { content: [toolUse("s2", "search_filings", { company_ids: [9300001], institution_ids: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] }),
      toolUse("s3", "search_filings", { company_ids: Array.from({ length: 50 }, (_, i) => 9400001 + i), institution_ids: [], states: ["FL"], from: "2016-11-14", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] })] }; },
    (body) => { seen.s2 = toolResults(body).s2; seen.s3 = toolResults(body).s3; return { content: [say("Partial.")] }; }, NO_TABLE,
  ], { spFetch: () => spStub(fakeClock(), (call) => (call.path === "/api/v1/reference" ? J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }] }) : (call.body.properties.companyId ?? []).includes(9300001) ? J(spPage([filing(1000 + call.body.properties.pageNumber)], { totalPages: 999 })) : J(spPage((call.body.properties.companyId ?? []).includes(9100001) ? many : [], { totalPages: 1 })))).fetch });
  const a = await w.ask();
  ok(`Claude is shown the newest ${LIMITS.rowsToClaude} filings of a larger result and told the rest were left out`, seen.s1.value.total === 180 && seen.s1.value.shown === LIMITS.rowsToClaude && seen.s1.value.filings.length === LIMITS.rowsToClaude && seen.s1.value.notes.some((n: string) => n === `Only the newest ${LIMITS.rowsToClaude} of 180 filings are shown here. Narrow the dates or add a type filter to see the rest.`)
    && seen.s1.value.filings.every((f: any, i: number) => i === 0 || f.published <= seen.s1.value.filings[i - 1].published), seen.s1.value.notes);
  ok(`a search Claude runs stops at ${LIMITS.searchRequests} S&P requests and tells Claude the result is incomplete`, seen.s2.value.notes[0].startsWith(`The search stopped after ${LIMITS.searchRequests} S&P requests`) && !seen.s2.value.notes.some((n: string) => /returned no filings|returned nothing/.test(n)), seen.s2.value.notes);
  ok("a search that could never finish inside the limit is refused to Claude in plain words, and no S&P request is spent on it", seen.s3.isError === true && /needs at least 55 S&P requests/.test(seen.s3.value.error) && new RegExp(`more than the ${LIMITS.searchRequests} one search may use`).test(seen.s3.value.error), seen.s3);
  ok("the answer says so too, in its list of limits hit", a.job.status === "done" && a.result.caps.some((c: string) => /search/i.test(c) && /incomplete|stopped/i.test(c)), a.result?.caps);
}
{
  // statutory data through Claude's tool
  const clockless = fakeClock();
  const sf = fakeSnowflake(clockless, { tables: { IR_SURPLUS: [{ NAIC_CD: "91001", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, PHS_000: 5000 }, { NAIC_CD: "91001", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2019, PHS_000: 1 }] }, loaded: { IR_SURPLUS: "2026-10-20T04:00:00" } });
  const seen: Record<string, any> = {};
  const w = world([
    { content: [toolUse("q1", "query_statutory", { kind: "company", naic_codes: ["91001"], from_year: 2022, to_year: 2025, fields: ["surplus", "loss_ratio"] }), toolUse("q2", "query_statutory", { kind: "company", naic_codes: ["91001' OR '1'='1"], from_year: 2022, to_year: 2025, fields: [] }),
      toolUse("q3", "query_statutory", { kind: "company", naic_codes: ["91001"], from_year: 2022, to_year: 2031, fields: [] })] },
    (body) => { seen.r = toolResults(body); return { content: [say("Surplus was $5.0M in 2024.")] }; }, NO_TABLE,
  ], { secrets: { ...SECRETS, SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" }, spFetch: (inner) => route({ "snowflakecomputing.com": sf.fetch }, inner) });
  w.db.settings.set("statutory_mapping", { fields: { surplus: { view: "IR_SURPLUS", entity: { company: "NAIC_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "PHS_000", scale: 1000 } } });
  const a = await w.ask("What is Calloway Insurance Co's surplus?");
  const q1 = seen.r.q1.value;
  ok("Claude's statutory query returns the mapped field's rows, scaled, with units and the source", !seen.r.q1.isError && same(q1.fields[0].rows, [{ code: "91001", year: 2024, line: null, state: null, value: 5_000_000 }]) && /usd fields are US dollars/.test(q1.units) && q1.source.includes("SNL Insurance Regulatory Data") && same(q1.entities, [{ code: "91001", name: "Calloway Insurance Co" }]) && same(q1.loaded, [{ view: "IR_SURPLUS", at: "2026-10-20T04:00:00" }]), q1);
  ok("a field that isn't mapped is reported to Claude as not mapped", q1.fields[1].id === "loss_ratio" && q1.fields[1].mapped === false && q1.fields[1].note === "This field isn't mapped to a Snowflake view yet.", q1.fields[1]);
  ok("a hostile code from Claude is refused before any SQL, as a tool error", seen.r.q2.isError && /1 to 8 NAIC codes/.test(seen.r.q2.value.error) && seen.r.q3.isError && /Years must be whole years/.test(seen.r.q3.value.error) && sf.statements.every((s) => !s.statement.includes("OR '1'")), [seen.r.q2, seen.r.q3]);
  ok("the statutory look-up is listed and the answer finishes", a.job.status === "done" && same(a.result.lookups, [{ tool: "query_statutory", detail: "company 91001, 2022 to 2025" }]) && a.job.progress.some((s) => s.text === "Querying statutory data: 1 company, 2022 to 2025"), a.result?.lookups);
  ok("Snowflake requests are not counted as S&P requests", (await w.db.usage()).day === w.sp.log.length && sf.log.length === 2, { sp: w.sp.log.length, sf: sf.log.length });
}

{
  // S&P refuses the reference lists as the answer starts; a reader asks
  const seen: Record<string, any> = {};
  const w = world([(body) => { seen.system = body.system[1].text; return { content: [say("Answered without the lists.")] }; }, NO_TABLE], { who: { id: "reader-5d1c", role: "reader" } });
  w.sp.failNext.push({ status: 403 }, { status: 403 });
  const a = await silently(() => w.ask());
  ok("if S&P refuses the reference lists, the answer still runs and Claude is told to filter rows itself", a.job.status === "done" && seen.system.startsWith("S&P's reference id lists aren't saved yet."), { status: a.job.status, system: seen.system });
  ok("a reader may ask a question too", a.job.owner === "reader-5d1c" && a.result.answer[0].text === "Answered without the lists.");
}
{
  // a document too large to read
  const keep = LIMITS.docBytes, seen: Record<string, any> = {};
  LIMITS.docBytes = 20;
  try {
    const w = world([{ content: [READ("r1", 70000001)] }, (body) => { seen.r = toolResults(body); seen.docs = documentsIn(body); return { content: [say("Too large to read.")] }; }, NO_TABLE]);
    const a = await w.ask();
    ok("a document over the size limit is refused after download: Claude is told, nothing is uploaded, and the answer says so", seen.r.r1.isError && seen.r.r1.value.error.startsWith("This document is too large to read here: ") && seen.r.r1.value.error.endsWith(" Tell the user to open it from the Filings view, and answer from the search results.") && seen.docs.length === 0 && w.claude.uploads.length === 0
      && a.result.caps.length === 1 && /^Filing document 70000001 is .*, too large for Claude to read here \(the limit is .* a document\)\. Open it from the Filings view to read it yourself\.$/.test(a.result.caps[0]), { r: seen.r.r1, caps: a.result.caps });
  } finally { LIMITS.docBytes = keep; }
}

// ---------- the limits on one question ----------
{
  // documents
  forgetTokens();
  const n = LIMITS.docs + 2, rows = Array.from({ length: n }, (_, i) => filing(i + 1, { pages: 5 }));
  const seen: Record<string, any> = {};
  const stub = spStub(fakeClock(), (call) => call.path === "/api/v1/reference" ? J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }] })
    : call.path === "/api/v1/download" ? new Response(PDF(`Made-up document ${call.body.properties.documentId}`), { status: 200, headers: { "content-type": "application/pdf" } }) : J(spPage(rows, { totalPages: 1 })));
  const w = world([
    { content: [toolUse("s1", "search_filings", { company_ids: [9100001], institution_ids: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] })] },
    { content: rows.map((r, i) => READ(`r${i + 1}`, r.documentId as number)) },
    (body) => { seen.r = toolResults(body); seen.docs = documentsIn(body); return { content: [say("Read what I could.")] }; }, NO_TABLE,
  ], { spFetch: () => stub.fetch });
  const a = await w.ask();
  ok(`the first ${LIMITS.docs} documents are read and the next ones are refused, with Claude told in the tool result`, seen.docs.length === LIMITS.docs && !seen.r[`r${LIMITS.docs}`].isError && seen.r[`r${LIMITS.docs + 1}`].isError && seen.r[`r${LIMITS.docs + 2}`].isError
    && seen.r[`r${LIMITS.docs + 1}`].value.error === `The limit of ${LIMITS.docs} documents for one question is reached. Answer from what you have and say which filings you didn't read.`, seen.r[`r${LIMITS.docs + 1}`]);
  ok("no S&P request or upload is spent on a refused document", stub.calls("/api/v1/download").length === LIMITS.docs && w.claude.uploads.length === LIMITS.docs);
  ok("the answer says the document limit was hit, once, in plain words", same(a.result.caps, [`Claude stopped at the limit of ${LIMITS.docs} documents for one question. Open the others from the Filings view.`]), a.result.caps);
  ok("all the documents are deleted afterwards", w.claude.deleted.length === LIMITS.docs);
}
{
  // pages in one document, and pages in total
  const order = [70000002, 70000001, 70000007, 70000005, 70000003], pagesOf: Record<number, number> = { 70000002: 58, 70000001: 42, 70000007: 40, 70000005: 36, 70000003: 30 };
  let sum = 0;
  const fits = order.map((id) => { if (sum + pagesOf[id] > LIMITS.totalPages) return false; sum += pagesOf[id]; return true; });
  const seen: Record<string, any> = {};
  const w = world([{ content: [SEARCH_ALL("s1")] }, { content: [toolUse("big", "read_filing_document", { document_id: 70000004, filing_version_id: null, first_page: 1, last_page: 310 }), ...order.map((id) => READ(`p${id}`, id))] }, (body) => { seen.r = toolResults(body); seen.docs = documentsIn(body); return { content: [say("Read what fitted.")] }; }, NO_TABLE]);
  const a = await w.ask();
  ok(`a read of all 310 pages is over the limit of ${LIMITS.docPages} pages for one read: Claude is told and it is never downloaded`, seen.r.big.isError && seen.r.big.value.error === `One read takes at most ${LIMITS.docPages} pages. Ask for a shorter range, for example pages 1 to ${LIMITS.docPages}.`
    && !w.sp.calls("/api/v1/download").some((c) => c.body.properties.documentId === 70000004), seen.r.big);
  ok(`documents are read until the next one would pass ${LIMITS.totalPages} pages in total; those are refused and Claude is told`, order.every((id, i) => seen.r[`p${id}`].isError === !fits[i]) && fits.includes(false) && fits.includes(true)
    && order.filter((_, i) => !fits[i]).every((id) => seen.r[`p${id}`].value.error === `Reading this would pass the limit of ${LIMITS.totalPages} document pages for one question. Answer from what you have and say which filings you didn't read.`), { fits, results: order.map((id) => seen.r[`p${id}`].isError) });
  ok("a smaller document after a refused one can still be read if it fits", seen.docs.length === fits.filter(Boolean).length && w.claude.uploads.length === fits.filter(Boolean).length);
  ok("the answer names each limit hit in plain words", a.result.caps.filter((c: string) => c.startsWith(`Claude stopped at the limit of ${LIMITS.totalPages} document pages for one question, so it didn't read filing `)).length === fits.filter((f) => !f).length && a.result.caps.length === fits.filter((f) => !f).length, a.result.caps);
}
{
  // look-ups in one question
  const seen: Record<string, any> = {};
  const w = world([
    { content: Array.from({ length: LIMITS.toolCalls + 2 }, (_, i) => toolUse(`t${i + 1}`, "resolve_entity", { query: `company ${i + 1}` })) },
    (body) => { seen.r = toolResults(body); seen.last = body.messages.at(-1).content; return { content: [toolUse("extra", "resolve_entity", { query: "one more" })] }; },
    (body) => { seen.r2 = toolResults(body); return { content: [say("That's all I could check.")] }; }, NO_TABLE,
  ]);
  const a = await w.ask();
  ok(`${LIMITS.toolCalls} look-ups run; the next ones are refused, with Claude told in the tool result`, !seen.r[`t${LIMITS.toolCalls}`].isError && seen.r[`t${LIMITS.toolCalls + 1}`].isError && seen.r[`t${LIMITS.toolCalls + 2}`].isError
    && seen.r[`t${LIMITS.toolCalls + 1}`].value.error === "The lookup limit for this question is reached. Answer from what you have and say what you couldn't check.", seen.r[`t${LIMITS.toolCalls + 1}`]);
  ok("Claude is also told, after the results, to answer now", seen.last.at(-1).type === "text" && seen.last.at(-1).text === "The lookup limit for this question is reached. Answer now from what you have, and say what you couldn't check.", seen.last.at(-1));
  ok("a look-up asked for after the limit is refused too", seen.r2.extra.isError && /lookup limit/.test(seen.r2.extra.value.error));
  ok("the answer finishes and says the look-up limit was hit, once", a.job.status === "done" && same(a.result.caps, [`Claude stopped at the limit of ${LIMITS.toolCalls} lookups for one question. Ask a narrower question to go further.`]) && a.result.lookups.length === LIMITS.toolCalls, a.result.caps);
}
{
  // back-and-forth steps
  const seen: Record<string, any> = {};
  const w = world([
    ...Array.from({ length: LIMITS.rounds }, (_, i) => (body: any) => { seen[`told${i}`] = body.messages.at(-1).content.at?.(-1)?.text; return { content: [toolUse(`t${i + 1}`, "resolve_entity", { query: `company ${i + 1}` })] }; }),
    (body) => { seen.last = body.messages.at(-1).content; return { content: [say("Answering from what I have.")] }; }, NO_TABLE,
  ]);
  const a = await w.ask();
  ok(`after ${LIMITS.rounds} steps Claude is told to answer now, and not before`, seen.last.at(-1).text === "The lookup limit for this question is reached. Answer now from what you have, and say what you couldn't check." && !/limit/.test(String(seen[`told${LIMITS.rounds - 1}`] ?? "")), seen.last.at(-1));
  ok("the answer finishes with a note that the step limit was hit", a.job.status === "done" && a.result.caps.length === 1, a.result.caps);
  ok(`the note names the limit that was actually hit (${LIMITS.rounds} steps), not the limit of ${LIMITS.toolCalls} look-ups, which wasn't`, !a.result.caps[0].includes(`limit of ${LIMITS.toolCalls} lookups`), a.result.caps[0]);

  const stubborn = world(Array.from({ length: LIMITS.rounds + 4 }, (_, i) => ({ content: [toolUse(`t${i + 1}`, "resolve_entity", { query: `company ${i + 1}` })] })));
  const b = await stubborn.ask();
  ok("if Claude keeps looking things up after being told to stop, the answer ends with a plain error instead of running on", b.job.status === "error" && b.job.error === "This question needed more lookups than one question allows. Ask a narrower question." && stubborn.claude.calls.length === LIMITS.rounds + 3, { status: b.job.status, error: b.job.error, calls: stubborn.claude.calls.length });
  ok("and its saved place is cleared", !stubborn.db.states.has(b.jobId));
}
{
  // the length limit
  const cut = world([{ content: [say("The first part of a long answer")], stop_reason: "max_tokens" }, NO_TABLE]);
  const a = await cut.ask();
  ok("an answer cut off at the length limit is kept, with a note saying it was cut short", a.job.status === "done" && a.result.answer[0].text === "The first part of a long answer" && same(a.result.caps, ["The answer was cut short at the length limit. Ask a narrower question for the rest."]), a.result);
  const mid = world([{ content: [say("Let me look"), toolUse("t1", "resolve_entity", { query: "Calloway" })], stop_reason: "max_tokens" }]);
  const b = await mid.ask();
  ok("a reply cut off in the middle of a tool call ends the answer with a plain error, and the tool isn't run", b.job.status === "error" && b.job.error === "Claude's reply was cut off mid-step. Ask again, or ask a narrower question." && b.job.progress.length === 0, b.job);
  const empty = world([{ content: [thinking()] }, NO_TABLE]);
  const c = await empty.ask();
  ok("a reply with no text at all gives a plain line rather than an empty answer", c.job.status === "done" && same(c.result.answer, [{ text: "No answer came back. Try rephrasing the question.", cites: [] }]), c.result);
}

// ---------- the comparison table ----------
{
  const TABLE = { needs_table: true, title: "Forms", columns: ["Company", "Form number"], rows: [{ cells: ["Calloway Insurance Co", "CHO 30 01 (06 25)"] }, { cells: ["Tarrow Mutual Insurance Co", ""] }], notes: [] };
  let during = "";
  const good = world([{ content: [say("Calloway uses CHO 30 01.\nTarrow's form number isn't given.")] }, () => { during = good.job([...good.db.jobs.keys()][0]).partial; return { content: [say(JSON.stringify(TABLE))] }; }]);
  const a = await good.ask();
  ok("the table comes from a second request and lands in the result", good.claude.calls.length === 2 && same(a.result.table, { title: "Forms", columns: ["Company", "Form number"], rows: [["Calloway Insurance Co", "CHO 30 01 (06 25)"], ["Tarrow Mutual Insurance Co", "n/d"]], notes: [] }) && same(a.result.caps, []), a.result.table);
  ok("while the table is built, the page can already show the finished answer", during === "Calloway uses CHO 30 01.\nTarrow's form number isn't given.", during);
  ok("the table's tokens are added to the answer's usage", a.result.usage.inputTokens === 2000 && a.result.usage.outputTokens === 400);

  const cases: [string, Reply][] = [
    ["an API failure", { error: { status: 500, type: "api_error", message: "Internal server error" } }], ["an overloaded API", { error: { status: 529, type: "overloaded_error", message: "Overloaded" } }],
    ["JSON that can't be read", { content: [say('{"needs_table": true, "title": "Forms", "columns": ["Company"')] }], ["a reply cut off at the length limit", { content: [say(JSON.stringify(TABLE).slice(0, 60))], stop_reason: "max_tokens" }],
    ["a refusal", { content: [], stop_reason: "refusal" }], ["a reply with no text", { content: [thinking()] }],
  ];
  const noNote: string[] = [];
  for (const [name, reply] of cases) {
    const w = world([{ content: [say("The answer stands.")] }, reply]);
    const r = await silently(() => w.ask());
    ok(`when the table request ends in ${name}, the answer still finishes with no table`, r.job.status === "done" && r.job.error === null && r.result.table === null && same(r.result.answer, [{ text: "The answer stands.", cites: [] }]), { status: r.job.status, error: r.job.error });
    if (!same(r.result.caps, ["The comparison table couldn't be built. The answer above is complete."])) noNote.push(name);
  }
  ok("every failed or unreadable table leaves a note that the table couldn't be built", noNote.length === 0, { noNoteAfter: noNote });
  const none = world([{ content: [say("Nothing to compare.")] }, NO_TABLE]);
  const n = await none.ask();
  ok("needs_table false leaves no table and no note", n.result.table === null && same(n.result.caps, []));
}

// ---------- time slices: pause and continue ----------
{
  const seen: Record<string, any> = {};
  const w = world([
    { content: [SEARCH_ALL("s1")] },
    () => { w.clock.now += 111_000; return { content: [READ("r1", 70000001)] }; },                    // the slice (110 s) runs out while Claude is replying
    (body) => { seen.resumed = body; return { content: [READ("r2", 70000001)] }; },                    // after the pause Claude asks for the document again
    (body) => { seen.afterRead = body; return { content: [say("Calloway uses CHO 30 01.", [pageCite(0, 3, 5, "CHO 30 01 (06 25)")])] }; },
    (body) => { seen.table = body; return NO_TABLE; },
  ]);
  const a = await w.ask();
  const paused = structuredClone(w.job(a.jobId));
  ok("when the slice's time is used up the answer pauses instead of running on", paused.status === "paused" && paused.result === null && paused.error === null && w.claude.calls.length === 2, { status: paused.status, calls: w.claude.calls.length });
  ok("the reply in hand is kept and its place saved, but a lookup asked for after the time ran out is put off, not started", (w.db.states.get(a.jobId)!.state as any).docs.length === 0 && (w.db.states.get(a.jobId)!.state as any).messages.length === 5 && (w.db.states.get(a.jobId)!.state as any).tries === 0 && w.sp.calls("/api/v1/download").length === 0 && w.claude.uploads.length === 0);
  ok("a lookup that was put off doesn't count against the lookup limit", (w.db.states.get(a.jobId)!.state as any).toolCalls === 1);
  ok("progress says the answer will carry on", paused.progress.at(-1)!.text === "Saved progress. Carrying on.", paused.progress.at(-1));
  const downloads = w.sp.calls("/api/v1/download").length, searches = w.sp.calls("/api/v1/search").length;
  w.db.jobs.get(a.jobId)!.progress = [...Array.from({ length: 76 }, (_, i) => ({ at: "2026-11-13T12:00:00.000Z", text: `Earlier step ${i + 1}` })), ...paused.progress];
  const c = await w.post({ action: "continue", jobId: a.jobId });
  ok("continue answers 202 at once and says it resumed", c.status === 202 && same(c.body, { jobId: a.jobId, resumed: true }) && w.pending.length === 1, c.body);
  await w.settle();
  const job = w.job(a.jobId);
  ok("the resumed answer finishes", job.status === "done" && (job.result as any).answer[0].text === "Calloway uses CHO 30 01." && same((job.result as any).answer[0].cites, [1]), job.error);
  ok("it carries on exactly where it stopped: Claude gets the whole conversation so far and is told the lookup was put off", w.claude.calls.length === 5 && seen.resumed.messages.length === 5 && same(Object.keys(toolResults(seen.resumed)), ["s1", "r1"]) && toolResults(seen.resumed).r1.isError === true && /put off because this step ran out of time/.test(toolResults(seen.resumed).r1.value.error), { calls: w.claude.calls.length, messages: seen.resumed.messages.length, r1: toolResults(seen.resumed).r1 });
  ok("asked again, the document is read once and attached", documentsIn(seen.afterRead).length === 1 && documentsIn(seen.afterRead)[0].source.file_id === "file_test1" && w.sp.calls("/api/v1/download").length === downloads + 1 && w.claude.uploads.length === 1);
  ok("nothing is searched a second time", w.sp.calls("/api/v1/search").length === searches);
  ok("the continue is counted as a segment", job.segments === 1);
  ok("progress from before the pause is kept", job.progress.some((s) => s.text === "Reading filing CALL-134000001 (42 pages)") && job.progress.at(-1)!.text === "Building the comparison table");
  ok("progress keeps the newest 80 lines and drops the oldest", job.progress.length === 80 && job.progress[0].text === "Earlier step 2" && !job.progress.some((s) => s.text === "Earlier step 1"), { n: job.progress.length, first: job.progress[0].text });
  ok("look-ups, usage and S&P requests from before the pause are in the result", (job.result as any).lookups.length === 2 && (job.result as any).usage.inputTokens === 5000 && (job.result as any).usage.spRequests === w.sp.log.length, (job.result as any).usage);
  ok("the file is deleted once the resumed answer finishes", same(w.claude.deleted, ["file_test1"]) && !w.db.states.has(a.jobId));

  const calls = w.claude.calls.length;
  const again = await w.cont(a.jobId);
  ok("continue on a finished answer does nothing", again.status === 202 && same(again.body, { jobId: a.jobId, resumed: false }) && w.claude.calls.length === calls && w.job(a.jobId).segments === 1 && w.job(a.jobId).status === "done", again.body);
  const stranger = await w.post({ action: "continue", jobId: a.jobId }, { whoIs: async () => ({ id: "someone-else", role: "corpdev" }) });
  ok("another user's answer is not found", stranger.status === 404 && stranger.body.error === "not_found" && stranger.body.message === "That answer wasn't found. Ask the question again." && !JSON.stringify(stranger.body).includes(USER.id), stranger.body);
  for (const [name, jobId] of [["an unknown id", "00000000-0000-4000-8000-00000000ffff"], ["no id", undefined], ["an id that isn't an id", "../../etc"], ["a number", 7], ["an id with SQL in it", "x' or '1'='1"]] as const)
    ok(`continue with ${name} is not found`, (await w.post({ action: "continue", jobId })).status === 404);
}
{
  // paused between the answer and the table: the answer is not written again
  const w = world([() => { w.clock.now += 200_000; return { content: [say("The finished answer.")] }; }, { content: [say(JSON.stringify({ needs_table: true, title: "T", columns: ["A"], rows: [{ cells: ["x"] }], notes: [] }))] }]);
  const a = await w.ask();
  ok("an answer that pauses after its text is written keeps that text for the page", a.job.status === "paused" && w.job(a.jobId).partial === "The finished answer." && w.claude.calls.length === 1, { status: a.job.status, partial: w.job(a.jobId).partial });
  await w.cont(a.jobId);
  const job = w.job(a.jobId);
  ok("continuing builds only the table: the answer is not asked for again", job.status === "done" && w.claude.calls.length === 2 && w.claude.calls[1].body.tools === undefined && (job.result as any).answer[0].text === "The finished answer." && (job.result as any).table.title === "T", { calls: w.claude.calls.length });
}
{
  // the function call dies while the table is being built, twice
  let hangs = 0;
  const w = world([{ content: [say("The finished answer.")] }, { content: [say("never delivered")] }, { content: [say("never delivered")] }, { content: [say("never delivered")] }], { claudeFetch: (inner) => ((input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/v1/messages" && !String(init?.body).includes('"tools"')) { hangs++; return never<Response>(); }
    return inner(input, init);
  }) as typeof fetch });
  const r = await w.post({ action: "ask", question: "A question whose table never comes back." });
  const id = r.body.jobId;
  await until(() => hangs === 1, "the first table request");
  w.pending.length = 0;
  ok("while the table is being built the finished answer is already on the job", w.job(id).status === "running" && w.job(id).partial === "The finished answer." && (w.db.states.get(id)!.state as any).phase === "table");
  w.clock.now += 46_000;
  await w.post({ action: "continue", jobId: id });
  await until(() => hangs === 2, "the second table request");
  w.pending.length = 0;
  w.clock.now += 46_000;
  await w.cont(id);
  const job = w.job(id);
  ok("a table that can't be built in two tries is given up on: the answer finishes without it and says so", hangs === 2 && job.status === "done" && (job.result as any).table === null && same((job.result as any).answer, [{ text: "The finished answer.", cites: [] }]) && same((job.result as any).caps, ["The comparison table couldn't be built. The answer above is complete."]), { hangs, status: job.status, caps: (job.result as any)?.caps });
  ok("the answer itself was asked for only once", w.claude.calls.filter((c) => c.body.tools).length === 1);
}
{
  // CHAT_SLICE_SECONDS
  for (const [value, pauses] of [["20", true], ["380", false], ["5", false], ["9999", false], ["soon", false]] as const) {
    const w = world([() => { w.clock.now += 30_000; return { content: [toolUse("t1", "resolve_entity", { query: "Calloway" })] }; }, { content: [say("ok")] }, NO_TABLE], { secrets: { ...SECRETS, CHAT_SLICE_SECONDS: value } });
    const a = await w.ask();
    ok(`CHAT_SLICE_SECONDS=${value}: a step that takes 30 seconds ${pauses ? "pauses the answer (slice of 20 seconds)" : "doesn't pause it (slice of " + (value === "380" ? "380" : "the default 110") + " seconds)"}`, a.job.status === (pauses ? "paused" : "done"), a.job.status);
  }
}

// ---------- continue: who may pick an answer up ----------
{
  // two continue calls at once
  const w = world([() => { w.clock.now += 111_000; return { content: [toolUse("t1", "resolve_entity", { query: "Calloway" })] }; }, { content: [say("Only once.")] }, NO_TABLE]);
  const a = await w.ask();
  const [x, y] = await Promise.all([w.post({ action: "continue", jobId: a.jobId }), w.post({ action: "continue", jobId: a.jobId })]);
  await w.settle();
  ok("two continue calls at once start only one run", [x.body.resumed, y.body.resumed].filter(Boolean).length === 1 && x.status === 202 && y.status === 202 && w.claude.calls.length === 3 && w.job(a.jobId).status === "done" && w.job(a.jobId).segments === 1, { x: x.body, y: y.body, calls: w.claude.calls.length });
}
{
  // a running answer: fresh heartbeat, then a function call that died mid-step with a document uploaded
  let hang = true, hung = false;
  const seen: Record<string, any> = {};
  const w = world([
    { content: [READ("r1", 70000001), READ("r2", 70000002)] },
    (body) => { seen.retry = body; return { content: [READ("r1", 70000001), READ("r2", 70000002)] }; },
    (body) => { seen.after = body; return { content: [say("Both read.", [pageCite(1, 2, 3, "SH-HO 01")])] }; }, NO_TABLE,
  ], { spFetch: (inner) => ((input: string | URL | Request, init?: RequestInit) => {
    if (hang && String(input).includes("/api/v1/download") && String(init?.body).includes("70000002")) { hang = false; hung = true; return never<Response>(); }
    return inner(input, init);
  }) as typeof fetch });
  const r = await w.post({ action: "ask", question: "Read both Calloway forms." });
  const id = r.body.jobId;
  await until(() => hung, "the first function call reaching the download that never answers");
  const dead = w.pending.shift();                                        // that function call never comes back
  const st = () => w.db.states.get(id)!.state as any;
  ok("a document uploaded during a step that hasn't finished is noted beside the last saved place", w.job(id).status === "running" && same(st().orphans, ["file_test1"]) && st().docs.length === 0 && st().messages.length === 1 && st().tries === 1 && w.claude.uploads.length === 1, st());
  const beat = Date.parse(w.job(id).heartbeat_at);
  w.clock.now = beat + 10_000;
  const fresh = await w.cont(id);
  ok("a running answer with a fresh heartbeat is not claimed", same(fresh.body, { jobId: id, resumed: false }) && w.claude.calls.length === 1 && w.job(id).segments === 0, fresh.body);
  w.clock.now = beat + 45_000;
  ok("at exactly 45 seconds of silence it is still not claimed", (await w.cont(id)).body.resumed === false && w.claude.calls.length === 1);
  w.clock.now = beat + 45_001;
  const c = await w.post({ action: "continue", jobId: id });
  ok("once the heartbeat is older than 45 seconds the answer is claimed", same(c.body, { jobId: id, resumed: true }), c.body);
  await w.settle();
  const job = w.job(id);
  ok("the resumed run finishes the answer", job.status === "done" && (job.result as any).answer[0].text === "Both read.", { status: job.status, error: job.error });
  ok("it starts from the last saved place: Claude is asked the unfinished step again, with nothing from the dead step", seen.retry.messages.length === 1 && documentsIn(seen.retry).length === 0 && Object.keys(toolResults(seen.retry)).length === 0, seen.retry.messages.length);
  ok("the file uploaded during the step that died is deleted before anything else", w.claude.deleted[0] === "file_test1", w.claude.deleted);
  ok("the documents are read again for the retried step, and only those reach Claude", same(documentsIn(seen.after).map((d) => d.source.file_id), ["file_test2", "file_test3"]) && w.claude.uploads.length === 3);
  ok("every file, from the dead step and the live one, is deleted by the end", same([...w.claude.deleted].sort(), ["file_test1", "file_test2", "file_test3"]) && !w.db.states.has(id), w.claude.deleted);
  ok("citations in the resumed answer point at the right document", (job.result as any).sources[0].documentId === 70000002);
  ok("the pick-up is counted as a segment", job.segments === 1);
  void dead;
}
{
  // a step that keeps dying
  let hangs = 0;
  const w = world([{ content: [say("never delivered")] }, { content: [say("never delivered")] }, { content: [say("never delivered")] }], { claudeFetch: (inner) => ((input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/v1/messages") { hangs++; return never<Response>(); }
    return inner(input, init);
  }) as typeof fetch });
  const r = await w.post({ action: "ask", question: "A question whose first step never comes back." });
  const id = r.body.jobId;
  await until(() => hangs === 1, "the first call to Claude");
  w.pending.length = 0;
  w.clock.now += 46_000;
  ok("the first pick-up tries the step again", (await w.post({ action: "continue", jobId: id })).body.resumed === true);
  await until(() => hangs === 2, "the second call to Claude");
  w.pending.length = 0;
  w.clock.now += 46_000;
  const third = await w.post({ action: "continue", jobId: id });
  await w.settle();
  ok("a step that has died twice is not tried a third time: the answer ends, saying one step takes longer than Supabase lets a function run", third.body.resumed === true && hangs === 2 && w.job(id).status === "error" && w.job(id).error === TOO_SLOW && /takes longer than Supabase lets a function run/.test(TOO_SLOW), { hangs, status: w.job(id).status, error: w.job(id).error });
  ok("its saved place is cleared", !w.db.states.has(id) && w.job(id).segments === 2);
}
{
  // the segment limit
  const w = world([{ content: [READ("r1", 70000001)] }, () => { w.clock.now += 111_000; return { content: [READ("r2", 70000002)] }; }, { content: [say("ok")] }, NO_TABLE]);
  const a = await w.ask();
  const okay = world([() => { okay.clock.now += 111_000; return { content: [READ("r1", 70000001)] }; }, { content: [say("ok")] }, NO_TABLE]);
  const b = await okay.ask();
  okay.db.jobs.get(b.jobId)!.segments = LIMITS.segments - 2;
  ok(`an answer that has used ${LIMITS.segments - 1} function calls may continue once more`, (await okay.cont(b.jobId)).body.resumed === true && okay.job(b.jobId).status === "done");
  w.db.jobs.get(a.jobId)!.segments = LIMITS.segments - 1;
  const c = await w.cont(a.jobId);
  ok(`an answer that has used all ${LIMITS.segments} function calls ends with a plain error instead of continuing`, same(c.body, { jobId: a.jobId, resumed: false }) && w.job(a.jobId).status === "error" && w.job(a.jobId).error === "This answer needed more time than one question is allowed. Ask a narrower question, for example fewer companies or fewer documents." && w.claude.calls.length === 2, { body: c.body, status: w.job(a.jobId).status });
  ok("its uploaded document is deleted and its saved place cleared", same(w.claude.deleted, ["file_test1"]) && !w.db.states.has(a.jobId));
}
{
  // a queued answer whose first function call died before it started; an answer with no saved place; a job row that is gone
  const w = world([{ content: [say("Picked up.")] }, NO_TABLE]);
  const id = (await w.db.createJob(USER.id, "Started but never run"))!;
  const { newState } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
  await w.db.putJobState(id, newState("Started but never run", [], "2026-11-13"));
  ok("a queued answer is left alone while its function call may still be starting", (await w.cont(id)).body.resumed === false);
  w.clock.now += 46_000;
  ok("a queued answer that has gone quiet is picked up and run", (await w.cont(id)).body.resumed === true && w.job(id).status === "done" && (w.job(id).result as any).answer[0].text === "Picked up.");

  const lost = world([]);
  const id2 = (await lost.db.createJob(USER.id, "No saved place"))!;
  lost.db.jobs.get(id2)!.status = "paused";
  await lost.cont(id2);
  ok("an answer whose saved place is gone ends with a plain error", lost.job(id2).status === "error" && lost.job(id2).error === "This answer's saved place was lost. Ask the question again." && lost.claude.calls.length === 0, lost.job(id2));
  const err = world([]);
  const id3 = (await err.db.createJob(USER.id, "Already failed"))!;
  Object.assign(err.db.jobs.get(id3)!, { status: "error", error: "earlier failure" });
  ok("continue on an answer that already failed does nothing", same((await err.cont(id3)).body, { jobId: id3, resumed: false }) && err.job(id3).error === "earlier failure");
}

// ---------- clearing up abandoned answers ----------
{
  const w = world([{ content: [say("A new answer.")] }, NO_TABLE]);
  const make = async (owner: string, status: string, ageMs: number, state: Record<string, unknown>) => {
    const id = (await w.db.createJob(owner, "An old question"))!;
    w.db.jobs.get(id)!.status = status as "paused";
    w.db.jobs.get(id)!.heartbeat_at = new Date(w.clock.now - ageMs).toISOString();   // an abandoned answer went quiet when it stopped
    await w.db.putJobState(id, state);
    w.db.states.get(id)!.updated_at = new Date(w.clock.now - ageMs).toISOString();
    return id;
  };
  const old = await make("someone-else", "paused", 61 * 60_000, { docs: [{ fileId: "file_old1" }, { fileId: "file_old2" }], orphans: ["file_old3"] });
  const oldRunning = await make(USER.id, "running", 3 * 3600_000, { docs: [{ fileId: "file_old4" }] });
  const recent = await make("someone-else", "paused", 59 * 60_000, { docs: [{ fileId: "file_recent" }] });
  const oldDone = await make(USER.id, "done", 2 * 3600_000, { docs: [{ fileId: "file_old5" }] });
  const a = await w.ask("A new question");
  ok("the new answer is not held up by the clearing", a.job.status === "done");
  ok("answers abandoned for over an hour have their uploaded files deleted on the next ask", ["file_old1", "file_old2", "file_old3", "file_old4", "file_old5"].every((f) => w.claude.deleted.includes(f)), w.claude.deleted);
  ok("and are marked as stopped, in plain words, with their saved place cleared", w.job(old).status === "error" && w.job(old).error === "This answer stopped before it finished. Ask the question again." && w.job(oldRunning).status === "error" && !w.db.states.has(old) && !w.db.states.has(oldRunning), [w.job(old), w.job(oldRunning)]);
  ok("an answer paused less than an hour ago is left alone, files and all", w.job(recent).status === "paused" && w.db.states.has(recent) && !w.claude.deleted.includes("file_recent"));
  ok("a finished answer that still had a saved place keeps its result and loses only the leftovers", w.job(oldDone).status === "done" && w.job(oldDone).error === null && !w.db.states.has(oldDone));
  ok("an abandoned answer can't be continued afterwards", same((await w.cont(old, { whoIs: async () => ({ id: "someone-else", role: "reader" }) })).body, { jobId: old, resumed: false }));
}

// ---------- one answer at a time for each login, and a limit on S&P requests for one question ----------
{
  const w = world([{ content: [say("First answer.")] }, NO_TABLE, { content: [say("Second answer.")] }, NO_TABLE]);
  const going = (await w.db.createJob(USER.id, "A question still running"))!;
  w.db.jobs.get(going)!.status = "running";
  const second = await w.post({ action: "ask", question: "Another question" });
  ok("a login with an answer in progress is asked to wait, and no second answer starts", second.status === 409 && second.body.error === "busy" && /already have an answer in progress/.test(second.body.message) && second.body.jobId === going && w.db.jobs.size === 1 && w.claude.calls.length === 0, second.body);
  const other = await w.post({ action: "ask", question: "A colleague's question" }, { whoIs: async () => ({ id: "another-login", role: "reader" }) });
  ok("another login is not held up by it", other.status === 202);
  await w.settle();
  for (const status of ["queued", "paused"] as const) {
    w.db.jobs.get(going)!.status = status;
    ok(`an answer that is ${status} also counts as in progress`, (await w.post({ action: "ask", question: "Another question" })).status === 409);
  }
  w.clock.now += 10 * 60_000 + 1000;
  const later = await w.post({ action: "ask", question: "Another question" });
  ok("an answer that has shown no life for ten minutes no longer blocks a new one", later.status === 202, later.body);
  await w.settle();
  w.db.jobs.get(going)!.status = "done";
  ok("a finished answer never blocks", (await w.post({ action: "ask", question: "One more" })).status !== 409);
}
{
  forgetTokens();
  const seen: Record<string, any> = {};
  const asks = Array.from({ length: 5 }, (_, i) => toolUse(`s${i}`, "search_filings", { company_ids: [9500001 + i], institution_ids: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] }));
  const w = world([
    { content: asks },
    (body) => { seen.results = toolResults(body); return { content: [say("Partial.")] }; }, NO_TABLE,
  ], { secrets: { ...SECRETS, CHAT_SLICE_SECONDS: "380" }, spFetch: () => spStub(fakeClock(), (call) => (call.path === "/api/v1/reference" ? J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }] }) : J(spPage([filing(2000 + call.body.properties.pageNumber + 100 * (call.body.properties.companyId[0] - 9500000))], { totalPages: 999 })))).fetch });
  const a = await w.ask();
  const errors = Object.values(seen.results as Record<string, { value: any; isError: boolean }>).filter((r) => r.isError);
  ok(`one question stops asking S&P at ${LIMITS.spRequests} requests`, a.result.usage.spRequests === LIMITS.spRequests, a.result?.usage);
  ok("the lookup that hit the limit is told so, and the answer still finishes", a.job.status === "done" && errors.length >= 1 && errors.every((r) => /used its limit of 150 S&P requests/.test(r.value.error)), errors);
  ok("the answer says the S&P request limit was reached", a.result.caps.some((c: string) => c === `Claude stopped at the limit of ${LIMITS.spRequests} S&P requests for one question. Ask a narrower question to go further.`), a.result?.caps);
}

// ---------- every way an answer can fail ----------
{
  const refused = world([{ content: [], stop_reason: "refusal" }]);
  const a = await refused.ask();
  ok("a refusal ends the answer with a plain 'Claude declined' error", a.job.status === "error" && a.job.error === "Claude declined this question. Try rephrasing it." && a.job.result === null && !refused.db.states.has(a.jobId), a.job);
  ok("no table is asked for after a refusal", refused.claude.calls.length === 1);

  const late = world([{ content: [SEARCH_ALL("s1")] }, { content: [READ("r1", 70000001), READ("r2", 70000002)] }, { content: [say("I can't continue with this.")], stop_reason: "refusal" }]);
  const b = await late.ask();
  ok("a refusal after documents were read ends the answer and deletes the uploaded files", b.job.status === "error" && /Claude declined/.test(b.job.error!) && same([...late.claude.deleted].sort(), ["file_test1", "file_test2"]) && !late.db.states.has(b.jobId), late.claude.deleted);

  for (const [status, type, says] of [[429, "rate_limit_error", "Claude is busy. Wait a minute and ask again."], [401, "authentication_error", "The Anthropic API key on Supabase is missing or invalid (README, step 6)."],
    [400, "invalid_request_error", "Claude couldn't read this conversation. Start a new conversation and ask again."], [500, "api_error", "Claude is unavailable (500). Try again shortly."], [529, "overloaded_error", "Claude is unavailable (529). Try again shortly."], [403, "permission_error", "Claude is unavailable (403). Try again shortly."]] as const) {
    const w = world([{ content: [READ("r1", 70000001)] }, { error: { status, type, message: `raw upstream detail ${status} for org-secret-name` } }]);
    const r = await silently(() => w.ask());
    ok(`an Anthropic ${status} ends the answer with a plain error`, r.job.status === "error" && r.job.error === says && r.job.result === null, r.job.error);
    ok(`after an Anthropic ${status} the uploaded file is deleted, the saved place cleared, and the request not retried`, same(w.claude.deleted, ["file_test1"]) && !w.db.states.has(r.jobId) && w.claude.calls.length === 2, { deleted: w.claude.deleted, calls: w.claude.calls.length });
    ok(`the ${status} error never repeats Anthropic's raw message`, !r.job.error!.includes("org-secret-name"));
  }
  const down = world([], { claudeFetch: () => (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch });
  const c = await silently(() => down.ask());
  ok("Claude unreachable ends the answer with a plain error", c.job.status === "error" && c.job.error === "Couldn't reach Claude. Try again shortly.", c.job.error);

  const upload = world([{ content: [READ("r1", 70000001)] }], { claudeFetch: (inner) => ((input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === "/v1/files" ? Promise.resolve(J({ type: "error", error: { type: "invalid_request_error", message: "file too large" } }, 413, { "x-should-retry": "false" })) : inner(input, init))) as typeof fetch });
  const d = await silently(() => upload.ask());
  ok("a document Anthropic won't take ends the answer with a plain error rather than a crash", d.job.status === "error" && /^Claude is unavailable \(413\)|^Claude couldn't/.test(d.job.error!), d.job.error);

  const broken = world([{ content: [toolUse("t1", "resolve_entity", { query: "Calloway" })] }]);
  const e = await silently(() => broken.post({ action: "ask", question: "Q" }, { db: { ...broken.db, findEntities: async () => { throw new Error("relation snl_store does not exist"); } } }).then(async (r) => { await broken.settle(); return broken.job(r.body.jobId); }));
  ok("an unexpected failure inside a tool ends the answer with an error the user can read", e.status === "error" && e.error === "The answer failed: relation snl_store does not exist. Ask again.", e.error);

  // the hourly S&P limit, inside a tool
  const seen: Record<string, any> = {};
  const limited = world([{ content: [SEARCH_ALL("s1")] }, (body) => { seen.r = toolResults(body); return { content: [say("S&P's hourly limit is used up.")] }; }, NO_TABLE]);
  for (let i = 0; i < 500; i++) await limited.db.takeSlot({ hour: 500, day: 12_000 });
  const f = await silently(() => limited.ask());
  ok("with S&P's hourly limit used up, Claude is told which limit and when it resets, and S&P isn't called", f.job.status === "done" && seen.r.s1.isError && /this hour's limit of 500 S&P requests is used up\. It resets at the top of the hour\./.test(seen.r.s1.value.error) && limited.sp.log.length === 0, { r: seen.r?.s1, calls: limited.sp.log.length });
}
{
  // a refusal fallback part-way through a reply
  const fallback = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-fallback-test" }, trigger: { type: "refusal" } };
  const seen: Record<string, any> = {};
  const w = world([
    { content: [thinking(), say("Starting."), toolUse("old1", "resolve_entity", { query: "run by the model that declined" }), fallback, thinking(), toolUse("new1", "resolve_entity", { query: "Calloway" })], model: "claude-fallback-test" },
    (body) => { seen.next = body; return { content: [say("Answered by the fallback model.")], model: "claude-fallback-test" }; }, NO_TABLE,
  ]);
  const a = await w.ask();
  const echoed = seen.next.messages.at(-2).content, results = toolResults(seen.next);
  ok("after a fallback, the tool call made before the hand-over is not run", same(Object.keys(results), ["new1"]) && a.result.lookups.length === 1 && a.result.lookups[0].detail.startsWith("Calloway"), { results: Object.keys(results), lookups: a.result.lookups });
  ok("thinking and tool calls from before the fallback block are not echoed back; the fallback block and what follows are", same(echoed.map((b: any) => b.type), ["text", "fallback", "thinking", "tool_use"]) && echoed.at(-1).id === "new1" && same(echoed[1], fallback), echoed.map((b: any) => b.type));
  ok("no tool result is sent for the call that was left out", !seen.next.messages.at(-1).content.some((b: any) => b.tool_use_id === "old1"));
  ok("the answer finishes and names the model that wrote it", a.job.status === "done" && a.result.model === "claude-fallback-test" && a.result.answer[0].text === "Answered by the fallback model.", a.result.model);

  const p = world([{ content: [say("Part one.")], stop_reason: "pause_turn" }, (body) => { seen.paused = body; return { content: [say("Part two.")] }; }, NO_TABLE]);
  const b = await p.ask();
  ok("a turn Claude pauses is sent back so it can carry on", b.job.status === "done" && seen.paused.messages.length === 2 && seen.paused.messages[1].role === "assistant" && b.result.answer[0].text === "Part two.", { status: b.job.status, messages: seen.paused?.messages.length });
}

finish(done);
