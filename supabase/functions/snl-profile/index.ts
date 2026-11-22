// Company profiles for SNL lookup: the figures, the plain text and Claude's text for a profile deck of one insurer,
// by NAIC company or group code. The page builds the PowerPoint file itself, on the team's template (kept in
// private storage, migration 0004). See _shared/profile.ts for what goes into a profile.
// Any signed-in login may call it. Built ready to switch on: until Snowflake is set up, "facts" and "draft" answer
// "not set up yet" (a saved result still opens), and "sample" always works.
//
// Secrets: the Snowflake, S&P and Anthropic secrets the other functions use. Optional: CLAUDE_MODEL,
// CHAT_DAILY_LIMIT (a draft counts as one question), ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-profile --no-verify-jwt
//
// POST /functions/v1/snl-profile  {"action": ...}
//   status                       -> {statutory: {configured, mapped, fields}, claude: {configured}, filings: {configured}}
//   sample                       -> {facts, text}: made-up figures, no S&P, Snowflake or Claude call
//   facts {kind, code, toYear?}  -> {facts, text}: the plain text
//   draft {kind, code, toYear?}  -> {facts, text, usage, jobId}: Claude's text, or the plain text with a note
//     A draft counts as one of the login's questions for the day and is kept as a finished answer in snl_jobs, so the
//     day's count and cost, "Past answers" and the 30-day clean-up all include it.
//   When some statutory figures didn't fit in the call, facts and draft also carry pending (how many are still to
//   come) and figures {done, of}; asking again carries on from where it stopped. A draft with figures pending isn't
//   sent to Claude, isn't counted and isn't saved: it gives the plain text with a note saying so.
// The filings profile, from S&P filings alone (no statutory data). who is {kind:"company", companyId | institutionId}
// or {kind:"group", group: the group's name in the company list}; years is 1, 3 or 5:
//   filings_sample                     -> {facts, text}: a made-up group, no S&P or Claude call
//   filings_facts {who..., years}      -> {facts, text, spRequests, search, candidates}: refused (400 too_big, 404 not_found)
//                                         before any S&P request when it can't be built; at most FP_MAX_SP_REQUESTS S&P requests
//   filings_draft {who..., years}      -> {facts, text, usage, jobId, spRequests, search, candidates}: as draft, counted and
//                                         saved the same way
//   The facts include what the saved filing summaries (migration 0005) and the market index (migration 0006) add, read
//   from the database at no S&P cost; candidates lists the company's rate and form filings that have no current summary,
//   newest first, for the page to offer to summarise (snl-digest "make", one at a time, only when the reader chooses).

import { adminClient, type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { credsReady, Snowflake, snowflakeCreds, SnowflakeError } from "../_shared/snowflake.ts";
import { fieldStatus, getMapping } from "../_shared/statutory.ts";
import { companiesMapped } from "../_shared/statutory.ts";
import { type Gate, makeGate, planLimits, Spgmi, SpgmiError } from "../_shared/spgmi.ts";
import { answerLines, buildFacts, clean, DRAFT_TIME_MS, draftText, NOTES, plainText, PROFILE_CALL_MS, PROFILE_MAX_SP_REQUESTS, PROFILE_QUERY_YEARS, sampleFacts } from "../_shared/profile.ts";
import { buildFilingsFacts, draftFilingsText, filingsAnswerLines, filingsPlainText, filingsSampleFacts, FP_DRAFT_SEARCH_MS, FP_MAX_SP_REQUESTS, FP_SEARCH_MS, FpRefused, parseFilingsProfile } from "../_shared/profile.ts";

export type Deps = {
  env: Env; fetch: typeof fetch; anthropicFetch?: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; gate?: Gate;
  sleep?: (ms: number) => Promise<void>;
  /** How long Claude may take (DRAFT_TIME_MS). Tests make it short. */
  draftMs?: number;
};

export const CLAUDE_NOT_CONFIGURED = "Claude isn't connected yet. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6). The plain text still works.";
const BUSY_MS = 10 * 60_000;      // as snl-chat: a login's unfinished answer blocks a new one for this long
const KEEP_DAYS = 30;             // as snl-chat: finished answers are removed after 30 days
export const DEFAULT_DAILY_LIMIT = 40;

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The profile function", (json) => serve(req, deps, json));
}

/** As snl-chat: CHAT_DAILY_LIMIT questions a login may start in a UTC day, null for no limit (0). */
export function dailyLimit(env: Env): number | null {
  const raw = (env("CHAT_DAILY_LIMIT") ?? "").trim();
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : DEFAULT_DAILY_LIMIT;
  return n === 0 ? null : n;
}
function utcDay(now: number) {
  const d = new Date(now), start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: new Date(start).toISOString(), resetsAt: new Date(start + 86_400_000).toISOString() };
}
export function limitMessage(asked: number, limit: number, now: number): string {
  const hours = (Date.parse(utcDay(now).resetsAt) - now) / 3_600_000, h = Math.round(hours);
  const when = hours < 1 ? "in less than an hour" : `in about ${h} ${h === 1 ? "hour" : "hours"}`;
  return `You've asked ${asked.toLocaleString("en-US")} ${asked === 1 ? "question" : "questions"} today, and the limit is ${limit.toLocaleString("en-US")} a day for each login. Claude's profile text counts as a question. `
    + `You can ask again after midnight UTC, ${when}. Until then, build the profile with the plain text.`;
}

/** Snowflake failures as snl-statutory gives them. */
function snowflakeAnswer(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(e instanceof SnowflakeError)) return null;
  const plain = e.code === "not_configured" || e.code === "not_mapped";
  return { status: e.code === "not_configured" ? 503 : e.code === "not_mapped" ? 409 : e.code === "busy" ? 429 : 502, body: { error: plain ? e.code : `snowflake_${e.code}`, message: e.message } };
}

/** kind, code and toYear from the body, or the reason they can't be used. */
export function parseProfile(b: Record<string, unknown>, thisYear: number): { ok: true; kind: "company" | "group"; code: string; toYear: number } | { ok: false; message: string } {
  if (b.kind !== "company" && b.kind !== "group") return { ok: false, message: 'kind must be "company" or "group".' };
  const code = typeof b.code === "string" || typeof b.code === "number" ? String(b.code).trim() : "";
  if (!/^[0-9]{1,6}$/.test(code)) return { ok: false, message: "Give a NAIC code: a number of up to 6 digits." };
  const toYear = b.toYear === undefined || b.toYear === null ? thisYear - 1 : typeof b.toYear === "string" && /^\d{4}$/.test(b.toYear.trim()) ? Number(b.toYear) : b.toYear;
  if (typeof toYear !== "number" || !Number.isInteger(toYear) || toYear - (PROFILE_QUERY_YEARS - 1) < 1990 || toYear > thisYear) return { ok: false, message: `The last year must be a whole year from ${1990 + PROFILE_QUERY_YEARS - 1} to ${thisYear}.` };
  return { ok: true, kind: b.kind, code, toYear };
}

async function serve(req: Request, deps: Deps, json: Json): Promise<Response> {
  const who = await (deps.whoIs ?? whoIs(deps.env))(req);
  if (!who) return json(401, { error: "signin", message: "Sign in again." });
  const body = await readBody(req);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });

  const clock = deps.now ?? Date.now, start = clock();
  if (body.action === "sample") {
    const facts = sampleFacts(new Date(start).toISOString().slice(0, 10));
    return json(200, { facts, text: plainText(facts) });
  }
  if (body.action === "filings_sample") {
    const facts = filingsSampleFacts(new Date(start).toISOString().slice(0, 10));
    return json(200, { facts, text: filingsPlainText(facts) });
  }

  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, clock) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const sfCreds = snowflakeCreds(deps.env), sfConfigured = credsReady(sfCreds);
  const spCreds = Spgmi.creds(deps.env), spConfigured = Spgmi.configured(spCreds);
  const claude = !!deps.env("ANTHROPIC_API_KEY");
  const mapping = await getMapping(db);

  if (body.action === "status") {
    const fields = fieldStatus(mapping);
    return json(200, { statutory: { configured: sfConfigured, mapped: fields.some((f) => f.mapped), fields: fields.map((f) => ({ id: f.id, label: f.label, mapped: f.mapped })), ...(companiesMapped(mapping) ? { codes: true } : {}) }, claude: { configured: claude }, filings: { configured: spConfigured } });
  }
  if (body.action === "filings_facts" || body.action === "filings_draft") return await serveFilings(body, { deps, json, db, who, clock, start, claude, spCreds, spConfigured });
  if (body.action !== "facts" && body.action !== "draft") return json(400, { error: "bad", message: "Unknown action. Use status, sample, facts or draft, or for a filings profile filings_sample, filings_facts or filings_draft." });

  const drafting = body.action === "draft";
  if (drafting && !claude) return json(503, { error: "not_configured", message: CLAUDE_NOT_CONFIGURED });
  const parsed = parseProfile(body, new Date(start).getUTCFullYear());
  if (!parsed.ok) return json(400, { error: "bad", message: parsed.message });

  // One answer at a time and a daily limit, as for questions to Claude. Checked before any work, so a refused
  // draft is never counted.
  const busy = async () => {
    const going = await db.activeJob(who.id, new Date(clock() - BUSY_MS).toISOString());
    return going ? json(409, { error: "busy", message: "You already have an answer in progress. Wait for it to finish, then try again. If you closed its tab, you can try again in ten minutes.", jobId: going }) : null;
  };
  if (drafting) {
    const b = await busy();
    if (b) return b;
    const limit = dailyLimit(deps.env);
    if (limit !== null) {
      const day = utcDay(clock()), asked = await db.countJobsSince(who.id, day.start);
      if (asked >= limit) return json(429, { error: "limit", message: limitMessage(asked, limit, clock()), askedToday: asked, dailyLimit: limit, resetsAt: day.resetsAt });
    }
  }

  // Every S&P call goes through the shared throttle and counter, and through this profile's own budget.
  const wait = deps.sleep ?? sleep, inner = deps.gate ?? makeGate(db, planLimits(deps.env), wait);
  let used = 0;
  const gate: Gate = async () => {
    if (used >= PROFILE_MAX_SP_REQUESTS) throw new SpgmiError("limit", `The filing search stopped after the ${PROFILE_MAX_SP_REQUESTS} S&P requests one profile may use.`);
    await inner();
    used++;
  };
  const api = spConfigured ? new Spgmi(spCreds, { fetch: deps.fetch, gate, sleep: wait, now: clock }) : null;
  const sf = sfConfigured ? new Snowflake(sfCreds, { fetch: deps.fetch, now: clock, sleep: wait }) : null;

  let facts;
  const figures: { done?: number; of?: number; pending?: number } = {};
  try {
    facts = await buildFacts({ db, sf, database: sfCreds.database, schema: sfCreds.schema, mapping, api, now: clock, start }, parsed, figures);
  } catch (e) {
    const answer = snowflakeAnswer(e);
    if (answer) return json(answer.status, answer.body);
    throw e;
  }
  // Figures that didn't fit in this call: the answer says how many are still to come (the page asks again, and the
  // figures that came back are kept, so it carries on). Claude isn't asked to write from figures still missing.
  const pending = figures.pending ? { pending: figures.pending, figures: { done: figures.done, of: figures.of } } : {};
  if (!drafting) return json(200, { facts, text: plainText(facts), ...pending });
  if (figures.pending) return json(200, { facts, text: { ...plainText(facts), note: NOTES.pending }, ...pending });

  // The draft is recorded as one of the login's answers: it counts against the daily limit, and its cost is in the
  // day's total. The row is created only now, so a profile that couldn't be built isn't counted.
  const b = await busy();
  if (b) return b;
  const name = facts.entity.name ?? `NAIC ${parsed.kind} ${parsed.code}`;
  const jobId = await db.createJob(who.id, `Profile text for ${clean(name, 200)}`);
  if (!jobId) return json(500, { error: "server", message: "The profile text couldn't be started. Try again." });
  await db.claimJob(jobId, ["queued"]);
  const left = start + PROFILE_CALL_MS - clock();
  const out = await draftText(facts, { env: deps.env, anthropicFetch: deps.anthropicFetch, timeMs: Math.max(1_000, Math.min(deps.draftMs ?? DRAFT_TIME_MS, left)), spRequests: used });
  const Y = facts.years;
  const result = {
    answer: answerLines(facts, out.text), sources: [], table: null,
    lookups: [{ tool: "profile", detail: `NAIC ${parsed.kind} ${parsed.code}, ${Y.length ? `${Y[0]} to ${Y[Y.length - 1]}` : "years n/d"}` }],
    caps: out.text.note ? [out.text.note] : [], model: out.model, usage: out.usage,
    profile: { kind: parsed.kind, code: parsed.code, by: out.text.by },
  };
  try { await db.updateJob(jobId, { status: "done", partial: "", result }); }
  catch (e) { console.error("couldn't record the profile text", (e as Error)?.message); }
  try { await db.dropOldJobs(new Date(clock() - KEEP_DAYS * 86_400_000).toISOString()); } catch { /* housekeeping: tried again next time */ }
  return json(200, { facts, text: out.text, usage: out.usage, jobId });
}

/** S&P failures as snl-filings answers them (spgmiAnswer there). */
function spAnswer(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(e instanceof SpgmiError)) return null;
  const status = e.code === "not_configured" ? 503 : e.code === "limit" || e.code === "rate_limited" ? 429 : e.code === "bad_request" ? 400 : e.code === "not_found" ? 404 : 502;
  return { status, body: { error: e.code === "not_configured" ? "not_configured" : `spgmi_${e.code}`, message: e.message, requestId: e.requestId } };
}

type FilingsCtx = { deps: Deps; json: Json; db: Db; who: { id: string }; clock: () => number; start: number; claude: boolean; spCreds: ReturnType<typeof Spgmi.creds>; spConfigured: boolean };
/** The filings profile: facts from S&P filings alone (filings_facts), or with Claude's text (filings_draft). The page
    sends who (a company's S&P id or a group's name from the company list) and the period, never figures. */
async function serveFilings(body: Record<string, unknown>, c: FilingsCtx): Promise<Response> {
  const { deps, json, db, who, clock, start } = c;
  const drafting = body.action === "filings_draft";
  if (drafting && !c.claude) return json(503, { error: "not_configured", message: CLAUDE_NOT_CONFIGURED });
  const parsed = parseFilingsProfile(body);
  if (!parsed.ok) return json(400, { error: "bad", message: parsed.message });
  const ask = parsed.ask;

  // As the full profile: one answer at a time and the daily limit, checked before any work.
  const busy = async () => {
    const going = await db.activeJob(who.id, new Date(clock() - BUSY_MS).toISOString());
    return going ? json(409, { error: "busy", message: "You already have an answer in progress. Wait for it to finish, then try again. If you closed its tab, you can try again in ten minutes.", jobId: going }) : null;
  };
  if (drafting) {
    const b = await busy();
    if (b) return b;
    const limit = dailyLimit(deps.env);
    if (limit !== null) {
      const day = utcDay(clock()), asked = await db.countJobsSince(who.id, day.start);
      if (asked >= limit) return json(429, { error: "limit", message: limitMessage(asked, limit, clock()), askedToday: asked, dailyLimit: limit, resetsAt: day.resetsAt });
    }
  }

  // Every S&P call goes through the shared throttle and counter, and through this profile's hard cap.
  const wait = deps.sleep ?? sleep, inner = deps.gate ?? makeGate(db, planLimits(deps.env), wait);
  let used = 0;
  const gate: Gate = async () => {
    if (used >= FP_MAX_SP_REQUESTS) throw new SpgmiError("limit", `The filings profile stopped after the ${FP_MAX_SP_REQUESTS} S&P requests one profile may use. Choose a shorter period or one company, and try again.`);
    await inner();
    used++;
  };
  const api = c.spConfigured ? new Spgmi(c.spCreds, { fetch: deps.fetch, gate, sleep: wait, now: clock }) : null;

  let facts, search, candidates;
  try {
    ({ facts, search, candidates } = await buildFilingsFacts({ db, api, now: clock, start, deadline: start + (drafting ? FP_DRAFT_SEARCH_MS : FP_SEARCH_MS) }, ask));
  } catch (e) {
    if (e instanceof FpRefused) return json(e.code === "not_found" ? 404 : 400, { error: e.code, message: e.message });
    const answer = spAnswer(e);
    if (answer) return json(answer.status, answer.body);
    throw e;
  }
  if (!drafting) return json(200, { facts, text: filingsPlainText(facts), spRequests: used, search, candidates });

  const b = await busy();
  if (b) return b;
  const jobId = await db.createJob(who.id, `Filings profile text for ${clean(facts.entity.name, 200)}`);
  if (!jobId) return json(500, { error: "server", message: "The profile text couldn't be started. Try again." });
  await db.claimJob(jobId, ["queued"]);
  const left = start + PROFILE_CALL_MS - clock();
  const out = await draftFilingsText(facts, { env: deps.env, anthropicFetch: deps.anthropicFetch, timeMs: Math.max(1_000, Math.min(deps.draftMs ?? DRAFT_TIME_MS, left)), spRequests: used });
  const result = {
    answer: filingsAnswerLines(facts, out.text), sources: [], table: null,
    lookups: [{ tool: "profile", detail: `Filings profile, ${facts.entity.kind === "group" ? "group" : "company"}, ${facts.period.from} to ${facts.period.to}` }],
    caps: out.text.note ? [out.text.note] : [], model: out.model, usage: out.usage,
    profile: { kind: facts.entity.kind, filings: true, by: out.text.by },
  };
  try { await db.updateJob(jobId, { status: "done", partial: "", result }); }
  catch (e) { console.error("couldn't record the profile text", (e as Error)?.message); }
  try { await db.dropOldJobs(new Date(clock() - KEEP_DAYS * 86_400_000).toISOString()); } catch { /* housekeeping: tried again next time */ }
  return json(200, { facts, text: out.text, usage: out.usage, jobId, spRequests: used, search, candidates });
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
