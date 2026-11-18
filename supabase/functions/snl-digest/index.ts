// Filing summaries for SNL lookup: a filing's facts read once by Claude and saved (migration 0005), so later questions
// are answered from what was saved instead of reading the filing again. See _shared/digest.ts for what a summary holds
// and how Claude's answer is checked. Ask Claude also saves summaries of the filings it reads (chat.ts).
// Any signed-in login may call it.
//
// Secrets: the S&P and Anthropic secrets snl-filings and snl-chat use. Optional: CLAUDE_MODEL, CHAT_DAILY_LIMIT (making
// a summary counts as one question), ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-digest --no-verify-jwt
//
// POST /functions/v1/snl-digest  {"action": ...}
//   status                                      -> {claude: {configured}, filings: {configured}, saved: n}
//   get {filings: [{documentId?, filingVersionId?}]} (at most 50)
//                                               -> {digests: [...], missing: [{documentId?, filingVersionId?}]}. Free.
//   make {filing: {documentId?, filingVersionId?, ...the search row's fields}, refresh?}
//                                               -> {digest, usage, fromStore}. Reads the front of the document (1 S&P
//     request, one Claude request) unless a summary is saved. One filing a call; counts as one question for the daily
//     limit and is kept as a finished answer in snl_jobs, as a profile's text is. Errors: not_configured, limit, busy,
//     too_large, unreadable, claude.
//   search {q, state?, limit?}                  -> {matches: [{digest, where, snippet}], total}. Free.
//   A missing table (migration 0005 not run) answers 503 {error: "no_tables"}.

import { adminClient, type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { type Gate, makeGate, NOT_CONFIGURED, planLimits, Spgmi, SpgmiError } from "../_shared/spgmi.ts";
import { downloadDocument, parseDocRef } from "../_shared/filings.ts";
import { LIMITS, readUpTo } from "../_shared/chat.ts";
import { cleanDigest, DIGEST, type Digest, digestOf, frontPages, makeDigest, type Match, metaFrom, parseQuery, readText, saveDigest, savedDigests, whereMatched } from "../_shared/digest.ts";

export type Deps = {
  env: Env; fetch: typeof fetch; anthropicFetch?: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; gate?: Gate;
  sleep?: (ms: number) => Promise<void>;
  /** How long Claude may take (DIGEST_TIME_MS). Tests make it short. */
  claudeMs?: number;
};

export const CLAUDE_NOT_CONFIGURED = "Claude isn't connected yet. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6). Saved summaries still open.";
export const NO_TABLES = "Saved summaries aren't set up yet: their table isn't in the database. Run supabase/migrations/0005_filing_digests.sql in the Supabase SQL editor (README, Filing summaries, step 1).";
const BUSY_MS = 10 * 60_000;      // as snl-chat: a login's unfinished answer blocks a new one for this long
const KEEP_DAYS = 30;             // as snl-chat: finished answers are removed after 30 days
export const DEFAULT_DAILY_LIMIT = 40;
/** The whole call stays inside this, well inside the 150 seconds Supabase allows on its free plan. Claude gets what
    is left after the download, up to DIGEST_TIME_MS. */
export const DIGEST_CALL_MS = 140_000;
export const DIGEST_TIME_MS = 110_000;
/** S&P requests one summary may use: the download, a sign-in, and a retry of each. */
export const MAKE_MAX_REQUESTS = 4;

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The summaries function", (json) => serve(req, deps, json));
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
  return `You've asked ${asked.toLocaleString("en-US")} ${asked === 1 ? "question" : "questions"} today, and the limit is ${limit.toLocaleString("en-US")} a day for each login. Making a summary counts as a question. `
    + `You can make one again after midnight UTC, ${when}. Saved summaries still open.`;
}

/** A database error that means migration 0005 hasn't been run. */
export const missingTable = (e: unknown) => /snl_digests/.test(String((e as Error)?.message ?? e)) && /does not exist|could not find|schema cache|42P01|PGRST205/i.test(String((e as Error)?.message ?? e));

/** One filing reference from the page: a document id, a filing version id, or both. null when neither is usable. */
function refOf(v: unknown): { documentId: number | null; filingVersionId: string | null } | null {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  if (!o) return null;
  const a = parseDocRef({ documentId: o.documentId }), b = parseDocRef({ filingVersionId: o.filingVersionId });
  const out = { documentId: a?.documentId ?? null, filingVersionId: b?.filingVersionId ?? null };
  return out.documentId !== null || out.filingVersionId !== null ? out : null;
}
const refText = (r: { documentId: number | null; filingVersionId: string | null }) => ({ ...(r.documentId !== null ? { documentId: r.documentId } : {}), ...(r.filingVersionId ? { filingVersionId: r.filingVersionId } : {}) });

/** S&P failures as the filings function gives them. */
function spgmiAnswer(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(e instanceof SpgmiError)) return null;
  const status = e.code === "not_configured" ? 503 : e.code === "limit" || e.code === "rate_limited" ? 429 : e.code === "bad_request" ? 400 : e.code === "not_found" ? 404 : 502;
  return { status, body: { error: e.code === "not_configured" ? "not_configured" : `spgmi_${e.code}`, message: e.message, requestId: e.requestId } };
}

async function serve(req: Request, deps: Deps, json: Json): Promise<Response> {
  const who = await (deps.whoIs ?? whoIs(deps.env))(req);
  if (!who) return json(401, { error: "signin", message: "Sign in again." });
  const body = await readBody(req);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });
  const clock = deps.now ?? Date.now, start = clock();
  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, clock) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const spCreds = Spgmi.creds(deps.env), spConfigured = Spgmi.configured(spCreds);
  const claude = !!deps.env("ANTHROPIC_API_KEY");
  if (!db.getDigests || !db.putDigest || !db.searchDigests || !db.countDigests) return json(503, { error: "no_tables", message: NO_TABLES });

  try {
    switch (body.action) {
      case "status":
        return json(200, { claude: { configured: claude }, filings: { configured: spConfigured }, saved: await db.countDigests() });

      case "get": {
        const list = Array.isArray(body.filings) ? body.filings : null;
        if (!list || !list.length) return json(400, { error: "bad", message: "Send filings: a list of {documentId} or {filingVersionId}." });
        if (list.length > DIGEST.getMax) return json(400, { error: "bad", message: `Ask for at most ${DIGEST.getMax} filings at once.` });
        const refs = list.map(refOf);
        if (refs.some((r) => !r)) return json(400, { error: "bad", message: "Each filing needs a documentId (a number) or a filingVersionId." });
        const saved = await savedDigestsOrThrow(db, refs as NonNullable<ReturnType<typeof refOf>>[]);
        const digests: Digest[] = [], missing: Record<string, unknown>[] = [];
        for (const r of refs as NonNullable<ReturnType<typeof refOf>>[]) {
          const d = digestOf(saved, r);
          if (d) { if (!digests.includes(d)) digests.push(d); } else missing.push(refText(r));
        }
        return json(200, { digests, missing });
      }

      case "search": {
        const q = parseQuery(body.q);
        if (!q) return json(400, { error: "bad", message: "Type a form number or some words to search for." });
        const state = typeof body.state === "string" && body.state.trim() ? body.state.trim().toUpperCase() : null;
        if (state !== null && !/^[A-Z]{2}$/.test(state)) return json(400, { error: "bad", message: "A state is a two-letter code, for example FL." });
        const limit = Number.isInteger(body.limit) && (body.limit as number) >= 1 ? Math.min(body.limit as number, DIGEST.searchMax) : 20;
        const rows = await db.searchDigests({ formKey: q.key, words: q.words, state, limit: 200 });
        const matches: Match[] = [], seen = new Set<string>();
        for (const row of rows) {
          const d = cleanDigest(row.doc);
          if (!d || (state && d.state !== state)) continue;
          const key = d.filingVersionId ? `v:${d.filingVersionId}` : `d:${d.documentId}`;
          if (seen.has(key)) continue;
          const m = whereMatched(d, q);
          if (m) { seen.add(key); matches.push(m); }
        }
        matches.sort((a, b) => b.digest.madeAt.localeCompare(a.digest.madeAt));
        return json(200, { matches: matches.slice(0, limit), total: matches.length });
      }

      case "make":
        return await make(body, deps, db, json, who.id, clock, start, claude, spConfigured, spCreds);

      default:
        return json(400, { error: "bad", message: "Unknown action. Use status, get, make or search." });
    }
  } catch (e) {
    if (missingTable(e)) return json(503, { error: "no_tables", message: NO_TABLES });
    throw e;
  }
}

/** savedDigests hides read failures (a summary must never stop an answer); here a failure is the answer. */
const savedDigestsOrThrow = (db: Db, refs: { documentId: number | null; filingVersionId: string | null }[]) => savedDigests(db, refs, { strict: true });

async function make(body: Record<string, unknown>, deps: Deps, db: Db, json: Json, owner: string, clock: () => number, start: number, claude: boolean, spConfigured: boolean, spCreds: ReturnType<typeof Spgmi.creds>): Promise<Response> {
  const row = body.filing && typeof body.filing === "object" && !Array.isArray(body.filing) ? body.filing as Record<string, unknown> : null;
  const ref = refOf(row);
  if (!row || !ref) return json(400, { error: "bad", message: "Send filing: the search row, with its documentId or filingVersionId." });
  const refresh = body.refresh === true;
  const saved = digestOf(await savedDigestsOrThrow(db, [ref]), ref);
  // A saved summary is given back at no cost unless the reader asks for a new one.
  if (saved && !refresh) return json(200, { digest: saved, usage: null, fromStore: true });
  if (!claude) return json(503, { error: "not_configured", message: CLAUDE_NOT_CONFIGURED });
  if (!spConfigured) return json(503, { error: "not_configured", message: NOT_CONFIGURED });

  // One answer at a time and a daily limit, as for questions to Claude. Checked before any work, so a refused summary
  // costs nothing and is never counted.
  const going = await db.activeJob(owner, new Date(clock() - BUSY_MS).toISOString());
  if (going) return json(409, { error: "busy", message: "You already have an answer in progress. Wait for it to finish, then try again. If you closed its tab, you can try again in ten minutes.", jobId: going });
  const limit = dailyLimit(deps.env);
  if (limit !== null) {
    const day = utcDay(clock()), asked = await db.countJobsSince(owner, day.start);
    if (asked >= limit) return json(429, { error: "limit", message: limitMessage(asked, limit, clock()), askedToday: asked, dailyLimit: limit, resetsAt: day.resetsAt });
  }

  // One document request, through the shared throttle and counter; plus a sign-in when no token is held, and S&P's own
  // one retry after an expired token or "too many requests", which go through the same counter.
  const wait = deps.sleep ?? sleep, inner = deps.gate ?? makeGate(db, planLimits(deps.env), wait);
  let used = 0;
  const gate: Gate = async () => {
    if (used >= MAKE_MAX_REQUESTS) throw new SpgmiError("limit", `Making a summary stopped after the ${MAKE_MAX_REQUESTS} S&P requests one summary may use.`);
    await inner();
    used++;
  };
  const api = new Spgmi(spCreds, { fetch: deps.fetch, gate, sleep: wait, now: clock });
  const meta = { ...metaFrom(row), ...(ref.documentId !== null ? { documentId: ref.documentId } : {}), ...(ref.filingVersionId ? { filingVersionId: ref.filingVersionId } : {}) };
  let res: Response;
  try { res = await downloadDocument(api, ref.documentId !== null ? { documentId: ref.documentId } : { filingVersionId: ref.filingVersionId! }); }
  catch (e) { const a = spgmiAnswer(e); if (a) return json(a.status, a.body); throw e; }
  const got = await readUpTo(res, LIMITS.docBytes);
  if (!got.bytes) {
    const size = got.declared !== null ? `${Math.ceil(got.declared / 1_000_000).toLocaleString("en-US")} MB` : `more than ${Math.floor(LIMITS.docBytes / 1_000_000)} MB`;
    return json(413, { error: "too_large", message: `This document is ${size}, over the ${Math.floor(LIMITS.docBytes / 1_000_000)} MB a summary can be made from. Open it from the Filings view to read it yourself.` });
  }
  const front = await frontPages(got.bytes, LIMITS.sendBytes);
  if (!front.ok) return json(front.code === "too_large" ? 413 : 422, { error: front.code, message: front.message });

  // Recorded as one of the login's answers: it counts against the daily limit and its cost is in the day's total. The
  // row is created only now, so a document that couldn't be read isn't counted.
  const name = meta.filingNo ?? (meta.documentId ? `document ${meta.documentId}` : `version ${meta.filingVersionId}`);
  const again = await db.activeJob(owner, new Date(clock() - BUSY_MS).toISOString());
  if (again) return json(409, { error: "busy", message: "You already have an answer in progress. Wait for it to finish, then try again. If you closed its tab, you can try again in ten minutes.", jobId: again });
  const jobId = await db.createJob(owner, `Summary of filing ${name}`.slice(0, 300));
  if (!jobId) return json(500, { error: "server", message: "The summary couldn't be started. Try again." });
  await db.claimJob(jobId, ["queued"]);
  const left = start + DIGEST_CALL_MS - clock();
  const out = await makeDigest(front, meta, { env: deps.env, anthropicFetch: deps.anthropicFetch, timeMs: Math.max(1_000, Math.min(deps.claudeMs ?? DIGEST_TIME_MS, left)), now: clock, spRequests: used });
  let savedOk = false;
  if (out.digest) {
    try { await saveDigest(db, out.digest, saved); savedOk = true; }
    catch (e) { console.error("couldn't save the summary", (e as Error)?.message); }
  }
  const pagesRead = readText(front.read, out.digest?.pages ?? front.pages);
  const result = {
    answer: [{ text: out.digest ? `Summary of filing ${name}, made by Claude from ${pagesRead}. ${out.digest.summary}` : `Claude couldn't summarise filing ${name}: ${out.problem}`, cites: [] }],
    sources: [], table: null,
    lookups: [{ tool: "read_filing_document", detail: `${name}, ${pagesRead}` }],
    caps: out.digest && !savedOk ? ["The summary couldn't be saved, so it shows only now."] : [], model: out.model, usage: out.usage,
  };
  try { await db.updateJob(jobId, { status: "done", partial: "", result }); }
  catch (e) { console.error("couldn't record the summary", (e as Error)?.message); }
  try { await db.dropOldJobs(new Date(clock() - KEEP_DAYS * 86_400_000).toISOString()); } catch { /* housekeeping: tried again next time */ }
  if (!out.digest) return json(502, { error: "claude", message: out.problem, usage: out.usage });
  return json(200, { digest: out.digest, usage: out.usage, fromStore: false, ...(savedOk ? {} : { note: "The summary couldn't be saved, so it shows only now." }) });
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
