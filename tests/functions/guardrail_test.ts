// The guardrail on Claude's bill: what each answer cost in US dollars (priced by the model that served each
// request, cache reads and writes priced apart, across paused answers and the table request, and for places saved
// before costs were tracked), the daily limit on questions for each login, and the status action that tells the
// page where the login stands. Claude, S&P and the database are stand-ins; nothing is billed.
(globalThis as any).__SNL_TEST__ = true;
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { addUsage, answerUsage, CACHE_WRITE_FACTOR, costOf, newState, priceFor, PRICES } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
const { supabaseDb } = await import(new URL("../../supabase/functions/_shared/db.ts", import.meta.url).href);
const { forgetTokens } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
import { checks, env, fakeAnthropic, fakeClock, memoryDb, type Reply, req, say, toolUse } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;
const KEY = { ANTHROPIC_API_KEY: "test-anthropic-key" };
const USER = { id: "login-guard-1", role: "corpdev" }, OTHER = { id: "login-guard-2", role: "reader" };
const NO_TABLE = (usage?: Record<string, number>, model?: string): Reply => ({ content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))], ...(usage ? { usage } : {}), ...(model ? { model } : {}) });
const T = (u: number, w: number, r: number, o: number) => ({ uncachedInputTokens: u, cacheWriteTokens: w, cacheReadTokens: r, outputTokens: o });

function world(script: Parameters<typeof fakeAnthropic>[0], secrets: Record<string, string> = KEY, start?: string) {
  forgetTokens();
  const clock = fakeClock(start), db = memoryDb(clock), claude = fakeAnthropic(script);
  const pending: Promise<unknown>[] = [];
  const deps = { env: env(secrets), fetch: (async () => new Response("no S&P here", { status: 500 })) as typeof fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: async () => USER, db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const post = async (body: unknown, over: Record<string, unknown> = {}) => { const res: Response = await chat.handle(req("snl-chat", body), { ...deps, ...over }); return { status: res.status, body: await res.json() }; };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const ask = async (question = "Do Calloway file separate homeowners forms in Florida?", over: Record<string, unknown> = {}) => { const r = await post({ action: "ask", question }, over); await settle(); return { ...r, job: r.body.jobId ? db.jobs.get(r.body.jobId) : undefined }; };
  const cont = async (jobId: string) => { const r = await post({ action: "continue", jobId }); await settle(); return r; };
  /** A question the login started at the given moment, ended the given way. */
  const past = async (owner: string, at: string, status: "done" | "error" | "running", usage?: Record<string, unknown>) => {
    const keep = clock.now; clock.now = Date.parse(at);
    const id = (await db.createJob(owner, "An earlier question"))!;
    Object.assign(db.jobs.get(id)!, { status, result: status === "done" ? { answer: [], usage: usage ?? {} } : null });
    clock.now = keep; return id;
  };
  return { clock, db, claude, deps, post, settle, ask, cont, past, pending };
}

// ---------- the price list ----------
{
  ok("the price list has the seven models, each with input, output and cache read prices", same(Object.keys(PRICES).sort(), ["claude-fable-5-2", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5"])
    && same(PRICES["claude-opus-5-5"], { input: 4, output: 20, cacheRead: 0.2 }) && same(PRICES["claude-opus-5"], { input: 5, output: 25, cacheRead: 0.5 }) && same(PRICES["claude-opus-4-8"], { input: 5, output: 25, cacheRead: 0.5 })
    && same(PRICES["claude-sonnet-5-5"], { input: 2, output: 10, cacheRead: 0.1 }) && same(PRICES["claude-sonnet-5"], { input: 2, output: 10, cacheRead: 0.2 }) && same(PRICES["claude-fable-5-2"], { input: 8, output: 40, cacheRead: 0.2 })
    && same(PRICES["claude-haiku-5-5"], { input: 0.1, output: 0.5, cacheRead: 0.01 }) && CACHE_WRITE_FACTOR === 1.25, PRICES);
  const src = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url));
  ok("a comment says the prices are list prices at the time of writing and the Anthropic console is the record", /list prices in US dollars per million tokens, at the time of writing/.test(src) && /the Anthropic console is the record of what was actually charged/.test(src));
  ok("a model matches by its exact id", priceFor("claude-opus-5-5") === PRICES["claude-opus-5-5"] && priceFor("claude-opus-5") === PRICES["claude-opus-5"] && priceFor("claude-sonnet-5") === PRICES["claude-sonnet-5"]);
  ok("or by its id followed by a dash and a date", priceFor("claude-opus-5-5-20261101") === PRICES["claude-opus-5-5"] && priceFor("claude-opus-5-20260301") === PRICES["claude-opus-5"] && priceFor("claude-haiku-5-5-20260815") === PRICES["claude-haiku-5-5"]);
  ok("a near miss is not a match, so it is never priced on a guess", priceFor("claude-opus-5-5-preview") === null && priceFor("claude-opus-5-55") === null && priceFor("claude-opus-5-5-2026") === null && priceFor("claude-opus") === null && priceFor("claude-test-model") === null && priceFor("") === null && priceFor("xclaude-opus-5") === null);
  ok("claude-opus-5-5 is not priced as claude-opus-5", priceFor("claude-opus-5-5")!.input === 4 && priceFor("claude-opus-5")!.input === 5);
  ok("a million uncached input tokens cost the input price", near(costOf("claude-opus-5-5", T(1e6, 0, 0, 0)), 4) && near(costOf("claude-fable-5-2", T(1e6, 0, 0, 0)), 8));
  ok("a million output tokens cost the output price", near(costOf("claude-opus-5-5", T(0, 0, 0, 1e6)), 20) && near(costOf("claude-haiku-5-5", T(0, 0, 0, 1e6)), 0.5));
  ok("a cache write costs 1.25 times the input price", near(costOf("claude-opus-5-5", T(0, 1e6, 0, 0)), 5) && near(costOf("claude-sonnet-5", T(0, 1e6, 0, 0)), 2.5) && near(costOf("claude-opus-4-8", T(0, 1e6, 0, 0)), 6.25));
  ok("a cache read costs the cache read price, not the input price", near(costOf("claude-opus-5-5", T(0, 0, 1e6, 0)), 0.2) && near(costOf("claude-sonnet-5-5", T(0, 0, 1e6, 0)), 0.1) && near(costOf("claude-sonnet-5", T(0, 0, 1e6, 0)), 0.2) && near(costOf("claude-opus-5", T(0, 0, 1e6, 0)), 0.5));
  ok("an unknown model's cost is unknown (null)", costOf("claude-test-model", T(1000, 0, 0, 100)) === null);
}

// ---------- addUsage and answerUsage on a saved place ----------
{
  const st = newState("Q", [], "2026-11-13");
  addUsage(st, "claude-opus-5-5", { input_tokens: 10_000, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 100_000, output_tokens: 5_000 });
  addUsage(st, "claude-opus-5-5", { input_tokens: 1_000, cache_creation_input_tokens: null, cache_read_input_tokens: 0, output_tokens: 100 });
  ok("each kind of token is kept apart, by model, and the old totals still add up", same(st.byModel, { "claude-opus-5-5": T(11_000, 20_000, 100_000, 5_100) }) && st.inputTokens === 131_000 && st.outputTokens === 5_100 && st.unpriced === undefined, st.byModel);
  const u = answerUsage(st);
  ok("the usage keeps inputTokens, outputTokens and spRequests and adds the breakdown and the cost", u.inputTokens === 131_000 && u.outputTokens === 5_100 && u.spRequests === 0 && u.uncachedInputTokens === 11_000 && u.cacheWriteTokens === 20_000 && u.cacheReadTokens === 100_000 && u.costUsd === 0.27, u);
  // 11,000 x 4 + 20,000 x 5 + 100,000 x 0.2 + 5,100 x 20 = 266,000 millionths of a dollar
  ok("the cost is rounded to cents, and each model's share is given", u.costUsd === 0.27 && same(u.byModel, { "claude-opus-5-5": { ...T(11_000, 20_000, 100_000, 5_100), costUsd: 0.27 } }), u.byModel);
  const tiny = newState("Q", [], "2026-11-13");
  addUsage(tiny, "claude-haiku-5-5", { input_tokens: 2_000, output_tokens: 300 });
  ok("an answer under half a cent rounds to 0, which the page shows as less than $0.01", answerUsage(tiny).costUsd === 0 && answerUsage(tiny).inputTokens === 2_000, answerUsage(tiny));
  ok("an answer that has made no request yet costs 0", answerUsage(newState("Q", [], "2026-11-13")).costUsd === 0);

  // a place saved before costs were tracked: totals but no breakdown
  const old = { ...newState("Q", [], "2026-11-13"), inputTokens: 5_000, outputTokens: 300 } as any;
  delete old.byModel;
  const before = answerUsage(old);
  ok("a place saved before costs were tracked reads with its totals and an unknown cost, and doesn't break", before.inputTokens === 5_000 && before.outputTokens === 300 && before.costUsd === null && before.uncachedInputTokens === null && before.cacheWriteTokens === null && before.cacheReadTokens === null && same(before.byModel, {}), before);
  addUsage(old, "claude-opus-5-5", { input_tokens: 100, output_tokens: 10 });
  const after = answerUsage(old);
  ok("tokens added to it later are counted, but the cost stays unknown because the earlier ones can't be priced", after.inputTokens === 5_100 && after.outputTokens === 310 && after.costUsd === null && old.unpriced === true && same(old.byModel, { "claude-opus-5-5": T(100, 0, 0, 10) }), after);
}

// ---------- an answer end to end: the cost lands in result.usage ----------
{
  // the answer on the model asked for; the table request served by the fallback model under a dated id
  const w = world([
    { content: [say("Calloway files one homeowners program in Florida.")], usage: { input_tokens: 10_000, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 100_000, output_tokens: 5_000 } },
    NO_TABLE({ input_tokens: 30_000, cache_read_input_tokens: 10_000, output_tokens: 10_000 }, "claude-sonnet-5-5-20261001"),
  ]);
  const a = await w.ask();
  const u = (a.job!.result as any).usage;
  // opus 5.5: 10,000 x 4 + 20,000 x 5 + 100,000 x 0.2 + 5,000 x 20 = $0.26; sonnet 5.5: 30,000 x 2 + 10,000 x 0.1 + 10,000 x 10 = $0.161
  ok("a reply served by a fallback model is priced at that model's prices", u.byModel["claude-opus-5-5"].costUsd === 0.26 && u.byModel["claude-sonnet-5-5-20261001"].costUsd === 0.16 && same(Object.keys(u.byModel), ["claude-opus-5-5", "claude-sonnet-5-5-20261001"]), u.byModel);
  ok("the table request is counted and priced with the answer", u.costUsd === 0.42 && u.inputTokens === 170_000 && u.outputTokens === 15_000 && u.uncachedInputTokens === 40_000 && u.cacheWriteTokens === 20_000 && u.cacheReadTokens === 110_000, u);
  ok("the three fields the page relies on are still there", typeof u.inputTokens === "number" && typeof u.outputTokens === "number" && u.spRequests === 0);

  const unknown = world([{ content: [say("Fine.")] }, NO_TABLE()], { ...KEY, CLAUDE_MODEL: "claude-test-model" });
  const b = await unknown.ask();
  const ub = (b.job!.result as any).usage;
  ok("a model not in the price list: the cost is null, never a guess, and the tokens are still counted", ub.costUsd === null && ub.byModel["claude-test-model"].costUsd === null && ub.inputTokens === 2_000 && ub.outputTokens === 400, ub);
  const mixed = world([{ content: [say("Fine.")] }, NO_TABLE(undefined, "claude-test-model")]);
  const um = ((await mixed.ask()).job!.result as any).usage;
  ok("one unpriced reply makes the whole answer's cost unknown, while the priced part is still shown by model", um.costUsd === null && um.byModel["claude-opus-5-5"].costUsd === 0.01 && um.byModel["claude-test-model"].costUsd === null, um);
}

// ---------- a paused and resumed answer ends with the right total ----------
{
  const w = world([
    () => { w.clock.now += 111_000; return { content: [toolUse("t1", "resolve_entity", { query: "Calloway" })], usage: { input_tokens: 4_000, cache_creation_input_tokens: 6_000, cache_read_input_tokens: 0, output_tokens: 300 } }; },
    { content: [say("Calloway Home Co is the only match.")], usage: { input_tokens: 500, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 10_000, output_tokens: 700 }, model: "claude-opus-5-20260301" },
    NO_TABLE({ input_tokens: 2_000, cache_read_input_tokens: 0, output_tokens: 100 }),
  ]);
  const a = await w.ask();
  const saved = w.db.states.get(a.body.jobId)!.state as any;
  ok("the answer pauses with its tokens so far saved by model", a.job!.status === "paused" && same(saved.byModel, { "claude-opus-5-5": T(4_000, 6_000, 0, 300) }), { status: a.job!.status, by: saved.byModel });
  const c = await w.cont(a.body.jobId);
  const u = (w.db.jobs.get(a.body.jobId)!.result as any).usage;
  // opus 5.5: (4,000+2,000) x 4 + 6,000 x 5 + 400 x 20 = $0.062; opus 5 (fallback): 500 x 5 + 1,000 x 6.25 + 10,000 x 0.5 + 700 x 25 = $0.03125
  ok("resumed, it finishes with every request in the total", c.body.resumed === true && w.db.jobs.get(a.body.jobId)!.status === "done" && u.costUsd === 0.09 && u.inputTokens === 23_500 && u.outputTokens === 1_100
    && same(u.byModel["claude-opus-5-5"], { ...T(6_000, 6_000, 0, 400), costUsd: 0.06 }) && same(u.byModel["claude-opus-5-20260301"], { ...T(500, 1_000, 10_000, 700), costUsd: 0.03 }), u);
}
{
  // a place saved by the app before this change, picked up again after it
  const w = world([{ content: [say("Picked up after the update.")] }, NO_TABLE()]);
  const id = (await w.db.createJob(USER.id, "Asked before the update"))!;
  const old = { ...newState("Asked before the update", [], "2026-11-13"), inputTokens: 48_000, outputTokens: 900, spRequests: 3 } as any;
  delete old.byModel; delete old.unpriced;
  await w.db.putJobState(id, old);
  w.db.jobs.get(id)!.status = "paused";
  await w.cont(id);
  const job = w.db.jobs.get(id)!, u = (job.result as any)?.usage;
  ok("an answer saved before costs were tracked still finishes, with its old and new tokens and an unknown cost", job.status === "done" && u.inputTokens === 50_000 && u.outputTokens === 1_300 && u.spRequests === 3 && u.costUsd === null && u.cacheReadTokens === null, { status: job.status, error: job.error, u });
}

// ---------- the daily limit ----------
{
  ok("the limit is 40 by default, a whole number when set, and 0 means none", chat.dailyLimit(env({})) === 40 && chat.dailyLimit(env({ CHAT_DAILY_LIMIT: "5" })) === 5 && chat.dailyLimit(env({ CHAT_DAILY_LIMIT: " 12 " })) === 12 && chat.dailyLimit(env({ CHAT_DAILY_LIMIT: "0" })) === null);
  ok("a setting that isn't a whole number gives the default", ["", "abc", "-3", "2.5", "1e3", "40 questions"].every((v) => chat.dailyLimit(env({ CHAT_DAILY_LIMIT: v })) === 40));
  ok("the readme-facing comment names the setting", /CHAT_DAILY_LIMIT \(questions each login may start in a UTC day; default 40, 0 for no limit\)/.test(Deno.readTextFileSync(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url))));

  const script = Array.from({ length: 4 }, () => [{ content: [say("Fine.")] }, NO_TABLE()]).flat() as Reply[];
  const w = world(script, { ...KEY, CHAT_DAILY_LIMIT: "2" });
  await w.past(USER.id, "2026-11-12T23:59:59Z", "done");                 // yesterday: not counted
  await w.past(OTHER.id, "2026-11-13T08:00:00Z", "done");                // someone else: not counted
  ok("the first question of the day goes through", (await w.ask()).status === 202);
  const bad = await w.post({ action: "ask", question: "" });
  ok("a question refused for another reason is not counted", bad.status === 400 && (await w.db.countJobsSince(USER.id, "2026-11-13T00:00:00.000Z")) === 1);
  // one in progress: the busy refusal isn't counted either
  w.db.jobs.set("00000000-0000-4000-8000-0000000000aa", { ...w.db.jobs.get([...w.db.jobs.keys()].at(-1)!)!, id: "00000000-0000-4000-8000-0000000000aa", owner: USER.id, status: "running", created_at: "2026-11-12T20:00:00.000Z", heartbeat_at: new Date(w.clock.now).toISOString() });
  const busy = await w.post({ action: "ask", question: "Another" });
  ok("a question refused as busy is not counted", busy.status === 409 && (await w.db.countJobsSince(USER.id, "2026-11-13T00:00:00.000Z")) === 1, busy.body);
  w.db.jobs.get("00000000-0000-4000-8000-0000000000aa")!.status = "error";
  const second = await w.ask();
  ok("the second question goes through", second.status === 202 && second.job!.status === "done");
  const jobs = w.db.jobs.size, calls = w.claude.calls.length, writes = w.db.stateWrites;
  const third = await w.post({ action: "ask", question: "A third question" });
  ok("at the limit, ask answers 429 daily_limit", third.status === 429 && third.body.error === "daily_limit", third.body);
  ok("the message says how many were asked, the limit, when it resets and that the owner can change it", third.body.message === "You've asked 2 questions today, and the limit is 2 a day for each login. You can ask again after midnight UTC, in about 12 hours. The site owner can change the limit.", third.body.message);
  ok("the refusal carries the count, the limit and when it resets", third.body.askedToday === 2 && third.body.dailyLimit === 2 && third.body.resetsAt === "2026-11-14T00:00:00.000Z", third.body);
  ok("nothing is created, saved or sent for a refused question", w.db.jobs.size === jobs && w.claude.calls.length === calls && w.db.stateWrites === writes && w.pending.length === 0);
  const fourth = await w.post({ action: "ask", question: "A fourth question" });
  ok("refused questions don't count against the user: still 2 asked", fourth.status === 429 && fourth.body.askedToday === 2, fourth.body);

  w.clock.now = Date.parse("2026-11-13T23:00:00Z");
  ok("an hour before midnight it says about 1 hour", /after midnight UTC, in about 1 hour\. /.test((await w.post({ action: "ask", question: "Q" })).body.message));
  w.clock.now = Date.parse("2026-11-13T23:40:00Z");
  ok("closer than that it says less than an hour", /after midnight UTC, in less than an hour\. /.test((await w.post({ action: "ask", question: "Q" })).body.message));
  w.clock.now = Date.parse("2026-11-14T00:00:00Z");
  const fresh = await w.ask();
  ok("at midnight UTC the count starts again", fresh.status === 202 && fresh.job!.status === "done", fresh.body);
  ok("and the new day counts from there", (await w.post({ action: "status" })).body.askedToday === 1);
}
{
  const w = world([]);
  for (let i = 0; i < 40; i++) await w.past(USER.id, "2026-11-13T09:00:00Z", i % 3 ? "done" : "error");
  const r = await w.post({ action: "ask", question: "Q" });
  ok("with no setting the limit is 40, and answers that failed still count as asked", r.status === 429 && r.body.askedToday === 40 && r.body.dailyLimit === 40 && /You've asked 40 questions today, and the limit is 40 a day/.test(r.body.message), r.body);
  const paused = await w.past(USER.id, "2026-11-13T10:00:00Z", "running");
  w.db.jobs.get(paused)!.status = "paused";
  await w.db.putJobState(paused, newState("An earlier question", [], "2026-11-13"));
  w.claude.left.push({ content: [say("Carried on.")] }, NO_TABLE());
  const c = await w.cont(paused);
  ok("continue is never blocked by the limit", c.status === 202 && c.body.resumed === true && w.db.jobs.get(paused)!.status === "done", c.body);
}
{
  const w = world([{ content: [say("Fine.")] }, NO_TABLE()], { ...KEY, CHAT_DAILY_LIMIT: "0" });
  for (let i = 0; i < 60; i++) await w.past(USER.id, "2026-11-13T09:00:00Z", "done");
  ok("with CHAT_DAILY_LIMIT=0 there is no limit", (await w.ask()).status === 202);
  const s = await w.post({ action: "status" });
  ok("and status says there is none (dailyLimit null)", s.body.dailyLimit === null && s.body.askedToday === 61, s.body);
}
{
  const w = world([]);
  const keep = console.error; console.error = () => {};
  const r = await w.post({ action: "ask", question: "Q" }, { db: { ...w.db, countJobsSince: async () => { throw new Error("connection reset"); } } });
  console.error = keep;
  ok("if today's questions can't be counted, nothing is started", r.status === 500 && r.body.error === "server" && w.db.jobs.size === 0 && w.pending.length === 0, r.body);
}

// ---------- status ----------
{
  const w = world([]);
  await w.past(USER.id, "2026-11-13T01:00:00Z", "done", { inputTokens: 1, outputTokens: 1, spRequests: 0, costUsd: 1.25 });
  await w.past(USER.id, "2026-11-13T02:00:00Z", "done", { inputTokens: 1, outputTokens: 1, spRequests: 0, costUsd: 1.85 });
  await w.past(USER.id, "2026-11-13T03:00:00Z", "done", { inputTokens: 1, outputTokens: 1, spRequests: 0, costUsd: null });   // a model not in the price list
  await w.past(USER.id, "2026-11-13T04:00:00Z", "done", { inputTokens: 1, outputTokens: 1, spRequests: 0 });                  // finished before costs were tracked
  await w.past(USER.id, "2026-11-13T05:00:00Z", "error");
  await w.past(USER.id, "2026-11-13T06:00:00Z", "running");
  await w.past(USER.id, "2026-11-12T22:00:00Z", "done", { costUsd: 9 });                                                    // yesterday
  await w.past(OTHER.id, "2026-11-13T07:00:00Z", "done", { costUsd: 4 });                                                   // someone else
  const s = await w.post({ action: "status" });
  ok("status gives the caller's questions today, the limit and what today's finished answers cost", s.status === 200 && same(s.body, { configured: true, askedToday: 6, dailyLimit: 40, costToday: 3.1, resetsAt: "2026-11-14T00:00:00.000Z" }), s.body);
  const other = await w.post({ action: "status" }, { whoIs: async () => OTHER });
  ok("another login sees only its own", other.body.askedToday === 1 && other.body.costToday === 4, other.body);
  const none = world([]);
  await none.past(USER.id, "2026-11-13T03:00:00Z", "done", { costUsd: null });
  ok("when none of today's answers can be priced, costToday is null", same((await none.post({ action: "status" })).body, { configured: true, askedToday: 1, dailyLimit: 40, costToday: null, resetsAt: "2026-11-14T00:00:00.000Z" }));
  ok("with nothing asked today, 0 asked and costToday null", same((await world([]).post({ action: "status" })).body, { configured: true, askedToday: 0, dailyLimit: 40, costToday: null, resetsAt: "2026-11-14T00:00:00.000Z" }));
  const off = world([], { CHAT_DAILY_LIMIT: "7" });
  const o = await off.post({ action: "status" });
  ok("before Claude is connected, status says so instead of failing", o.status === 200 && same(o.body, { configured: false, askedToday: null, dailyLimit: 7, costToday: null, resetsAt: null }), o.body);
  const signedOut = await w.post({ action: "status" }, { whoIs: async () => null });
  ok("status needs a signed-in login", signedOut.status === 401);
  const after = world([{ content: [say("Fine.")], usage: { input_tokens: 100_000, output_tokens: 1_000 } }, NO_TABLE({ input_tokens: 0, output_tokens: 0 })]);
  await after.ask();
  ok("a finished answer shows up in status straight away", same((await after.post({ action: "status" })).body, { configured: true, askedToday: 1, dailyLimit: 40, costToday: 0.42, resetsAt: "2026-11-14T00:00:00.000Z" }));
}

// ---------- the two new database methods, against a stand-in Supabase client ----------
{
  type Op = { table: string; calls: unknown[][] };
  const fakeSb = (answer: (op: Op) => Record<string, unknown>) => {
    const ops: Op[] = [];
    const chain = (op: Op): any => new Proxy(() => {}, {
      get: (_t, k) => (k === "then" ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => ({ data: null, error: null, ...answer(op) })).then(res, rej)
        : (...args: unknown[]) => { op.calls.push([String(k), ...args]); return chain(op); }),
    });
    return { ops, client: { from: (table: string) => { const op = { table, calls: [] as unknown[][] }; ops.push(op); return chain(op); } } as unknown as SupabaseClient };
  };
  let sb = fakeSb(() => ({ count: 17 }));
  const n = await supabaseDb(sb.client).countJobsSince("login-1", "2026-11-13T00:00:00.000Z");
  ok("countJobsSince counts the login's rows since the time, without reading them", n === 17 && sb.ops[0].table === "snl_jobs" && same(sb.ops[0].calls, [["select", "id", { count: "exact", head: true }], ["eq", "owner", "login-1"], ["gte", "created_at", "2026-11-13T00:00:00.000Z"]]), sb.ops[0].calls);
  ok("no count back reads as 0", (await supabaseDb(fakeSb(() => ({ count: null })).client).countJobsSince("x", "y")) === 0);
  let threw: any = null;
  try { await supabaseDb(fakeSb(() => ({ error: { message: "permission denied" } })).client).countJobsSince("x", "y"); } catch (e) { threw = e; }
  ok("if the count fails the call fails, so no question gets through uncounted", threw?.message === "Couldn't count today's questions: permission denied", threw?.message);
  sb = fakeSb(() => ({ data: [{ usage: { costUsd: 0.5 } }, { usage: null }, { usage: "odd" }, { usage: [1] }, {}] }));
  const us = await supabaseDb(sb.client).usageSince("login-1", "2026-11-13T00:00:00.000Z");
  ok("usageSince reads only the usage part of finished answers' results", same(us, [{ costUsd: 0.5 }]) && same(sb.ops[0].calls, [["select", "usage:result->usage"], ["eq", "owner", "login-1"], ["eq", "status", "done"], ["gte", "created_at", "2026-11-13T00:00:00.000Z"]]), sb.ops[0].calls);
  threw = null;
  try { await supabaseDb(fakeSb(() => ({ error: { message: "timeout" } })).client).usageSince("x", "y"); } catch (e) { threw = e; }
  ok("if it fails the call fails with a plain message", threw?.message === "Couldn't add up today's costs: timeout");
}

done();
