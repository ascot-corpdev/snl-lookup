// What keeps an answer safe when things go wrong: a forced answer at the step limit, the same system prompt on
// every step, a final write that fails, leftovers cleared when the app is opened, an oversized document that is
// never read, and a statutory query that runs out of time. Made-up data and fake services throughout.
(globalThis as any).__SNL_TEST__ = true;
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const filings = await import(new URL("../../supabase/functions/snl-filings/index.ts", import.meta.url).href);
const { LIMITS } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
const { forgetTokens } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
const { savedOrFreshStatutory, NOT_MAPPED } = await import(new URL("../../supabase/functions/_shared/statutory.ts", import.meta.url).href);
const { SnowflakeError, SNOWFLAKE_NOT_CONFIGURED } = await import(new URL("../../supabase/functions/_shared/snowflake.ts", import.meta.url).href);
import { checks, corpdev, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, PDF, type Reply, req, say, toolResults, toolUse } from "./helpers/fakes.ts";

const { ok, done } = checks();
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "sk-ant-test" };
const NO_TABLE: Reply = { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] };
const quiet = async <T>(work: () => Promise<T>): Promise<T> => { const keep = console.error; console.error = () => {}; try { return await work(); } finally { console.error = keep; } };

function world(script: Parameters<typeof fakeAnthropic>[0], spFetch?: (inner: typeof fetch) => typeof fetch) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  const sp = fakeSpgmi(clock, { documents: { "70000001": { bytes: PDF("Homeowner Program.") } } });
  const claude = fakeAnthropic(script);
  const pending: Promise<unknown>[] = [];
  const deps = { env: env(SECRETS), fetch: spFetch ? spFetch(sp.fetch) : sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const post = async (body: unknown) => { const res: Response = await chat.handle(req("snl-chat", body), deps); return { status: res.status, body: await res.json() }; };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const ask = async () => { const r = await post({ action: "ask", question: "Do Calloway file separate forms?" }); await settle(); return r.body.jobId as string; };
  return { clock, db, sp, claude, deps, post, settle, ask, job: (id: string) => db.jobs.get(id)! };
}
const lookup = (id: string) => toolUse(id, "resolve_entity", { query: "calloway" });

// ---------- at the step limit the next reply must be the answer ----------
{
  let forced: any;
  const w = world([
    ...Array.from({ length: LIMITS.rounds }, (_, i) => ({ content: [lookup(`t${i}`)] })),
    (body) => { forced = body; return { content: [say("An answer from what was found.")] }; },
    NO_TABLE,
  ]);
  const id = await w.ask();
  const steps = w.claude.calls.filter((c) => c.body.tools);
  ok("until the limit, Claude is free to look things up", steps.slice(0, LIMITS.rounds).every((c) => c.body.tool_choice === undefined));
  ok("once the step limit is reached the next request allows no more lookups, so an answer must come back", forced.tool_choice?.type === "none" && forced.tools.length === 7, forced.tool_choice);
  ok("the answer is kept, not thrown away", w.job(id).status === "done" && (w.job(id).result as any).answer[0].text === "An answer from what was found.", w.job(id).error);
  ok("and it says the limit was reached", (w.job(id).result as any).caps.some((c: string) => c === `Claude stopped at the limit of ${LIMITS.rounds} steps for one question. Ask a narrower question to go further.`), (w.job(id).result as any).caps);
  ok("no lookup ran after the limit", (w.job(id).result as any).lookups.length === LIMITS.rounds && steps.length === LIMITS.rounds + 1);
}

// ---------- Claude sees the same system prompt on every step, even after a pause ----------
{
  const w = world([
    () => { w.clock.now += 111_000; return { content: [lookup("t1")] }; },   // the time slice runs out during this reply
    { content: [say("Done.")] }, NO_TABLE,
  ]);
  const id = await w.ask();
  ok("the answer paused", w.job(id).status === "paused");
  // S&P's saved reference list changes between the two function calls
  await w.db.putStore({ id: "ref:typeOfInsurance", kind: "reference", label: "typeOfInsurance", doc: { options: [{ id: 99, name: "Changed since the answer began" }] } });
  await w.post({ action: "continue", jobId: id });
  await w.settle();
  const [first, second] = w.claude.calls;
  ok("the resumed answer finishes", w.job(id).status === "done", w.job(id).error);
  ok("the system prompt after the pause is exactly the one before it", JSON.stringify(second.body.system) === JSON.stringify(first.body.system) && !JSON.stringify(second.body.system).includes("Changed since"));
  ok("and the conversation so far is sent back unchanged", JSON.stringify(second.body.messages.slice(0, 1)) === JSON.stringify(first.body.messages));
}

// ---------- a final write that fails ----------
{
  const w = world([{ content: [say("The answer.")] }, NO_TABLE]);
  const update = w.db.updateJob.bind(w.db);
  let failures = 2;
  w.db.updateJob = async (id, patch) => { if (patch.status === "done" && failures-- > 0) throw new Error("connection reset"); return update(id, patch); };
  const id = await w.ask();
  ok("a final write that fails twice is tried a third time and the answer is saved", w.job(id).status === "done" && (w.job(id).result as any).answer[0].text === "The answer." && !w.db.states.has(id), w.job(id));
}
{
  const w = world([{ content: [toolUse("r1", "read_filing_document", { document_id: 70000001, filing_version_id: null })] }, { content: [say("The answer.")] }, NO_TABLE, NO_TABLE]);
  const update = w.db.updateJob.bind(w.db);
  let broken = true;
  w.db.updateJob = async (id, patch) => { if (broken && (patch.status === "done" || patch.status === "error")) throw new Error("database unavailable"); return update(id, patch); };
  const id = await quiet(() => w.ask());
  ok("when the result can't be written at all, the answer is not marked finished", w.job(id).status === "running" && w.job(id).result === null);
  ok("its saved place and its uploaded document are kept, so nothing is lost", w.db.states.has(id) && w.claude.uploads.length === 1 && w.claude.deleted.length === 0);
  broken = false;
  w.clock.now += 46_000;   // the page sees the answer has gone quiet and asks to carry on
  const again = await w.post({ action: "continue", jobId: id });
  await w.settle();
  ok("carrying on writes the finished answer without asking Claude for it again", again.body.resumed === true && w.job(id).status === "done" && (w.job(id).result as any).answer[0].text === "The answer." && w.claude.calls.filter((c) => c.body.tools).length === 2, { status: w.job(id).status, error: w.job(id).error });
  ok("and only then are the document and the saved place cleared", w.claude.deleted.join() === "file_test1" && !w.db.states.has(id));
}

// ---------- leftovers are cleared when anyone opens the app ----------
{
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), claude = fakeAnthropic([]);
  const stale = (await db.createJob("someone", "An abandoned question"))!;
  Object.assign(db.jobs.get(stale)!, { status: "paused", heartbeat_at: new Date(clock.now - 2 * 3_600_000).toISOString() });
  await db.putJobState(stale, { docs: [{ fileId: "file_left1" }], orphans: ["file_left2"] });
  db.states.get(stale)!.updated_at = new Date(clock.now - 2 * 3_600_000).toISOString();
  const ancient = (await db.createJob("someone", "A question from long ago"))!;
  Object.assign(db.jobs.get(ancient)!, { status: "done", created_at: new Date(clock.now - 31 * 86_400_000).toISOString() });
  const lastWeek = (await db.createJob("someone", "A question from last week"))!;
  Object.assign(db.jobs.get(lastWeek)!, { status: "done", created_at: new Date(clock.now - 7 * 86_400_000).toISOString() });
  const call = (secrets: Record<string, string>) => filings.handle(req("snl-filings", { action: "status" }), { env: env(secrets), fetch: fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep });
  const before = await call({});
  ok("without a Claude key, opening the app clears nothing (there is nothing of Claude's to clear)", before.status === 200 && claude.deleted.length === 0 && db.states.has(stale));
  const res = await call({ ANTHROPIC_API_KEY: "sk-ant-test" });
  ok("opening the app deletes the documents an abandoned answer left on Anthropic", res.status === 200 && claude.deleted.sort().join() === "file_left1,file_left2" && !db.states.has(stale), claude.deleted);
  ok("the abandoned answer is marked as stopped", db.jobs.get(stale)?.status === "error" && db.jobs.get(stale)?.error === "This answer stopped before it finished. Ask the question again.");
  ok("finished answers over 30 days old are removed, newer ones kept", !db.jobs.has(ancient) && db.jobs.has(lastWeek));
}

// ---------- a document S&P says is over the size limit is never read ----------
{
  let pulled = 0, cancelled = false;
  const huge = (inner: typeof fetch) => (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (!String(input).includes("/api/v1/download")) return inner(input, init);
    await inner(input, init);   // so the request is still counted by the fake
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(LIMITS.docBytes + 1) } });
  }) as typeof fetch;
  let read: any;
  const w = world([
    { content: [toolUse("r1", "read_filing_document", { document_id: 70000001, filing_version_id: null })] },
    (body) => { read = toolResults(body).r1; return { content: [say("Done.")] }; }, NO_TABLE,
  ], huge);
  const id = await w.ask();
  ok("a document over the size limit is refused from its stated length, without downloading it", read.isError === true && /too large to read here/.test(read.value.error) && pulled === 0 && cancelled && w.claude.uploads.length === 0, { read, pulled, cancelled });
  ok("and the answer says so", (w.job(id).result as any).caps.some((c: string) => c === `Filing document 70000001 is ${Math.ceil((LIMITS.docBytes + 1) / 1e6)} MB, too large for Claude to read here (the limit is ${LIMITS.docBytes / 1e6} MB a document). Open it from the Filings view to read it yourself.`), (w.job(id).result as any).caps);
}
{
  // no length given: reading stops as soon as the limit is passed
  let pulled = 0;
  const chunk = 4_000_000;
  const endless = (inner: typeof fetch) => (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (!String(input).includes("/api/v1/download")) return inner(input, init);
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(chunk)); } }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  let read: any;
  const w = world([
    { content: [toolUse("r1", "read_filing_document", { document_id: 70000001, filing_version_id: null })] },
    (body) => { read = toolResults(body).r1; return { content: [say("Done.")] }; }, NO_TABLE,
  ], endless);
  await w.ask();
  ok("a document with no stated length stops being read once it passes the limit", read.isError === true && /too large/.test(read.value.error) && pulled <= Math.ceil(LIMITS.docBytes / chunk) + 2 && w.claude.uploads.length === 0, { pulled });
}

// ---------- a statutory query: saved results, set-up errors and the time budget ----------
{
  const clock = fakeClock(), db = memoryDb(clock);
  const field = (view: string) => ({ view, entity: { company: "CO_CODE" }, year: "YR", value: "AMT" });
  const mapping = { fields: { surplus: field("V_SURPLUS"), loss_ratio: field("V_LOSS"), expense_ratio: field("V_EXPENSE"), combined_ratio: field("V_COMBINED") } };
  const q = { kind: "company" as const, codes: ["91001"], fromYear: 2021, toYear: 2025 };
  const fields = ["surplus", "loss_ratio", "expense_ratio", "combined_ratio"];
  const waits: number[] = [];
  // A stand-in Snowflake where each statement takes 60 seconds
  const slow = { query: async (statement: string, _b: unknown, waitMs: number) => {
    if (statement.includes("LOADTRACKER")) return { columns: [], rows: [], truncated: false, statementHandle: null };
    waits.push(waitMs); clock.now += 60_000;
    return { columns: [], rows: [{ CODE: "91001", NAME: "Calloway Insurance Co", YR: "2024", LINE: null, STATE: null, VAL: "12.5" }], truncated: false, statementHandle: null };
  } };
  const start = clock.now;
  const cut = await savedOrFreshStatutory(slow as any, db, "DB", "SCH", mapping, q, fields, { now: start, deadline: start + 100_000, clock: clock.fn });
  ok("fields that fit in the time are answered", cut.fields[0].rows.length === 1 && cut.fields[0].error === null && cut.fields[1].rows.length === 1);
  ok("fields that don't fit are reported as not run, in plain words, instead of running past the limit", cut.fields[2].rows.length === 0 && cut.fields[2].error === "Not run: the query ran out of time. Run it again, or ask for fewer fields." && cut.fields[3].error?.startsWith("Not run:") && waits.length === 2, cut.fields.map((f: any) => f.error));
  ok("each statement is given no longer than the time that is left", waits[0] === 100_000 && waits[1] === 40_000, waits);
  ok("a result cut short for time is not saved", cut.saved === false && ![...db.store.values()].some((r) => r.kind === "statutory"));

  const fast = { query: async (statement: string) => ({ columns: [], rows: statement.includes("LOADTRACKER") ? [] : [{ CODE: "91001", NAME: null, YR: "2024", LINE: null, STATE: null, VAL: "1" }], truncated: false, statementHandle: null }) };
  const fresh = await savedOrFreshStatutory(fast as any, db, "DB", "SCH", mapping, q, fields, { now: clock.now });
  const reopened = await savedOrFreshStatutory(null, db, "DB", "SCH", mapping, q, fields, { now: clock.now });
  ok("a complete result is saved and reopens without Snowflake", fresh.saved === true && fresh.fromStore === false && reopened.fromStore === true && reopened.fields.length === 4);
  const thrown = async (work: Promise<unknown>) => { try { await work; return null; } catch (e) { return e as InstanceType<typeof SnowflakeError>; } };
  const off = await thrown(savedOrFreshStatutory(null, db, "DB", "SCH", mapping, { ...q, codes: ["92001"] }, fields, { now: clock.now }));
  ok("a query that isn't saved, with Snowflake not set up, says it isn't set up", off instanceof SnowflakeError && off.code === "not_configured" && off.message === SNOWFLAKE_NOT_CONFIGURED);
  const unmapped = await thrown(savedOrFreshStatutory(fast as any, db, "DB", "SCH", { fields: {} }, q, fields, { now: clock.now }));
  ok("with nothing mapped it says the fields aren't mapped, and Snowflake isn't asked", unmapped instanceof SnowflakeError && unmapped.code === "not_mapped" && unmapped.message === NOT_MAPPED);
}

done();
