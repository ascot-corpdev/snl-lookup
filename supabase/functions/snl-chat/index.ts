// Claude for SNL lookup. A user asks in plain English; Claude uses the filing search, filing documents and
// statutory data as tools and answers with sources and a comparison table (see ../_shared/chat.ts).
// Any signed-in login may call it. Claude sees only the question and S&P's results, never Ascot deal data.
//
// An answer runs as a background task and writes its progress and result to public.snl_jobs; the page polls
// that row. Supabase stops a function call after 150 seconds (free plan) or 400 seconds (paid), background
// task included, so a long answer runs in slices: "ask" starts it, and the page calls "continue" when the row
// says "paused" or has gone quiet.
//
// Secrets: ANTHROPIC_API_KEY, plus the S&P and Snowflake secrets the other two functions use.
// Optional: CLAUDE_MODEL (default claude-opus-5-5), CHAT_SLICE_SECONDS (default 110; set 360 on a paid
// Supabase plan), ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-chat --no-verify-jwt
//
// POST /functions/v1/snl-chat
//   {"action": "ask", "question": "...", "history": [{"question", "answer"}]}  -> 202 {jobId}
//   {"action": "continue", "jobId": "..."}                                     -> 202 {jobId, resumed}

import { adminClient, type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { type ChatCtx, clearOld, deleteFiles, fileIdsOf, LIMITS, makeClient, newState, runJob, type Turn } from "../_shared/chat.ts";
import type { Gate } from "../_shared/spgmi.ts";

export type Deps = {
  env: Env; fetch: typeof fetch; anthropicFetch?: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; gate?: Gate;
  sleep?: (ms: number) => Promise<void>;
  /** Keeps the function call alive until the work finishes. Tests pass their own to wait for it. */
  background?: (work: Promise<unknown>) => void;
};

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export const CLAUDE_NOT_CONFIGURED = "Claude isn't connected yet. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6).";
const MAX_QUESTION = 4000, MAX_HISTORY = 6, MAX_ANSWER = 20_000;
const QUIET_MS = 45_000;          // a "running" answer with no heartbeat for this long has lost its function call
const BUSY_MS = 10 * 60_000;      // a login's unfinished answer blocks a new one for this long after it last showed life

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The chat function", (json) => serve(req, deps, json));
}

function sliceMs(env: Env): number {
  const s = Number(env("CHAT_SLICE_SECONDS"));
  return (Number.isFinite(s) && s >= 20 && s <= 380 ? s : 110) * 1000;
}

async function serve(req: Request, deps: Deps, json: Json): Promise<Response> {
  const who = await (deps.whoIs ?? whoIs(deps.env))(req);
  if (!who) return json(401, { error: "signin", message: "Sign in again." });
  const body = await readBody(req);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });
  if (!deps.env("ANTHROPIC_API_KEY")) return json(503, { error: "not_configured", message: CLAUDE_NOT_CONFIGURED });

  const nowFn = deps.now ?? Date.now;
  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, nowFn) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const ctx: ChatCtx = { db, env: deps.env, fetch: deps.fetch, anthropicFetch: deps.anthropicFetch, gate: deps.gate, now: nowFn, sleep: deps.sleep ?? sleep, sliceMs: sliceMs(deps.env) };
  const background = deps.background ?? ((work) => { if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); });
  const run = (work: Promise<unknown>) => background(work.catch((e) => console.error(e)));

  if (body.action === "ask") {
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question || question.length > MAX_QUESTION) return json(400, { error: "bad", message: `Type a question of up to ${MAX_QUESTION.toLocaleString("en-US")} characters.` });
    const history = body.history === undefined ? [] : body.history;
    if (!Array.isArray(history) || history.length > MAX_HISTORY || history.some((t) => !t || typeof t.question !== "string" || typeof t.answer !== "string"
        || !t.question.trim() || !t.answer.trim() || t.question.length > MAX_QUESTION || t.answer.length > MAX_ANSWER))
      return json(400, { error: "bad", message: "This conversation is too long to continue. Start a new conversation." });
    const turns: Turn[] = history.map((t) => ({ question: t.question.trim(), answer: t.answer.trim() }));

    // One answer at a time for each login, so one person can't use up the hour's S&P requests or run up the bill.
    const going = await db.activeJob(who.id, new Date(nowFn() - BUSY_MS).toISOString());
    if (going) return json(409, { error: "busy", message: "You already have an answer in progress. Wait for it to finish, then ask again. If you closed its tab, you can ask again in ten minutes.", jobId: going });
    const jobId = await db.createJob(who.id, question);
    if (!jobId) return json(500, { error: "server", message: "The answer couldn't be started. Try again." });
    await db.putJobState(jobId, newState(question, turns, new Date(nowFn()).toISOString().slice(0, 10)) as unknown as Record<string, unknown>);
    run((async () => {
      await clearOld(db, ctx);
      if (await db.claimJob(jobId, ["queued"])) await runJob(jobId, ctx);
    })());
    return json(202, { jobId });
  }

  if (body.action === "continue") {
    const jobId = typeof body.jobId === "string" && /^[0-9a-f-]{8,64}$/i.test(body.jobId) ? body.jobId : null;
    const job = jobId ? await db.getJob(jobId) : null;
    if (!job || job.owner !== who.id) return json(404, { error: "not_found", message: "That answer wasn't found. Ask the question again." });
    if (job.status === "done" || job.status === "error") return json(202, { jobId: job.id, resumed: false });
    // Only one caller wins the claim, so two tabs can't run the same answer twice.
    const claimed = job.status === "paused" ? await db.claimJob(job.id, ["paused"]) : await db.claimJob(job.id, ["running", "queued"], QUIET_MS);
    if (!claimed) return json(202, { jobId: job.id, resumed: false });
    if (job.segments + 1 >= LIMITS.segments) {
      await db.updateJob(job.id, { status: "error", error: "This answer needed more time than one question is allowed. Ask a narrower question, for example fewer companies or fewer documents." });
      run(clearOne(db, ctx, job.id));
      return json(202, { jobId: job.id, resumed: false });
    }
    await db.updateJob(job.id, { segments: job.segments + 1 });
    run(runJob(job.id, ctx));
    return json(202, { jobId: job.id, resumed: true });
  }

  return json(400, { error: "bad", message: "Unknown action. Use ask or continue." });
}

/** Deletes an abandoned answer's uploaded documents and its saved place. */
async function clearOne(db: Db, ctx: ChatCtx, jobId: string): Promise<void> {
  const ids = fileIdsOf(await db.getJobState(jobId));
  if (ids.length) await deleteFiles(makeClient(ctx), ids);
  await db.dropJobState(jobId);
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
