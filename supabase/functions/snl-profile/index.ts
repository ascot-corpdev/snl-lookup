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

import { adminClient, type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { credsReady, Snowflake, snowflakeCreds, SnowflakeError } from "../_shared/snowflake.ts";
import { fieldStatus, getMapping } from "../_shared/statutory.ts";
import { type Gate, makeGate, planLimits, Spgmi, SpgmiError } from "../_shared/spgmi.ts";
import { answerLines, buildFacts, clean, DRAFT_TIME_MS, draftText, plainText, PROFILE_CALL_MS, PROFILE_MAX_SP_REQUESTS, PROFILE_QUERY_YEARS, sampleFacts } from "../_shared/profile.ts";

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

  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, clock) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const sfCreds = snowflakeCreds(deps.env), sfConfigured = credsReady(sfCreds);
  const spCreds = Spgmi.creds(deps.env), spConfigured = Spgmi.configured(spCreds);
  const claude = !!deps.env("ANTHROPIC_API_KEY");
  const mapping = await getMapping(db);

  if (body.action === "status") {
    const fields = fieldStatus(mapping);
    return json(200, { statutory: { configured: sfConfigured, mapped: fields.some((f) => f.mapped), fields: fields.map((f) => ({ id: f.id, label: f.label, mapped: f.mapped })) }, claude: { configured: claude }, filings: { configured: spConfigured } });
  }
  if (body.action !== "facts" && body.action !== "draft") return json(400, { error: "bad", message: "Unknown action. Use status, sample, facts or draft." });

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
  try {
    facts = await buildFacts({ db, sf, database: sfCreds.database, schema: sfCreds.schema, mapping, api, now: clock, start }, parsed);
  } catch (e) {
    const answer = snowflakeAnswer(e);
    if (answer) return json(answer.status, answer.body);
    throw e;
  }
  if (!drafting) return json(200, { facts, text: plainText(facts) });

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

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
