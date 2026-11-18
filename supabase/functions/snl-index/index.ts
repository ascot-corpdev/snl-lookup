// The market index for SNL lookup: filing details for chosen states, swept from S&P for every company in the app's
// company list and kept in the app's own database (migration 0006), so a market question can be answered over every
// company in the list at no S&P cost. See _shared/marketindex.ts for how a sweep works and what it costs.
//
// Two ways in:
//   - a login: any login for status and query; a Corp Dev login to start, top up, carry on, pause, resume or stop;
//   - Supabase Cron (supabase/index_schedule.sql), with the header x-index-secret equal to the INDEX_SECRET secret and
//     no login, for the action "scheduled" only. Without INDEX_SECRET, scheduled calls are refused.
//
// Secrets (supabase secrets set ...): the S&P ones snl-filings uses. Optional: INDEX_SECRET (at least 24 characters,
// for the schedule), INDEX_TOPUP_DAYS (days before the schedule tops up an indexed state; default 7, 0 for never),
// SPGMI_ACCOUNT, ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-index --no-verify-jwt
//
// POST /functions/v1/snl-index  {"action": ...}
//   status                          (any login) what is indexed, the unfinished sweep, recent sweeps; for Corp Dev
//                                   also what each period would cost. No S&P request.
//   query     {state, ...filters}   (any login) an answer from the index, with its coverage. No S&P request.
//   start     {state, period}       (Corp Dev) records a sweep (this_year, last_12_months or last_3_years)
//   top_up    {state}               (Corp Dev) records a top-up: filings published since the index's last day
//   continue                        (Corp Dev) one step of the unfinished sweep
//   pause | resume | stop           (Corp Dev)
//   scheduled                       (the secret only) carries on the unfinished sweep, or tops up a state that is due

import { adminClient, type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { type Gate, makeGate, planLimits, Spgmi } from "../_shared/spgmi.ts";
import { sameSecret } from "../_shared/watch.ts";
import {
  answerQuery, controlSweep, type IndexCtx, indexStatus, missingTables, NO_TABLES, runStep, scheduledWork, startSweep, STEP_MS_PAGE, STEP_MS_SCHEDULE,
} from "../_shared/marketindex.ts";

export type Deps = { env: Env; fetch: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; gate?: Gate; sleep?: (ms: number) => Promise<void> };

export const SECRET_HEADER = "x-index-secret";
export const NO_SECRET = "Scheduled sweeps are switched off: INDEX_SECRET isn't set on Supabase (use at least 24 characters). See the README, Market index.";
const CORP_DEV_ONLY = "Only Corp Dev logins can run sweeps. Anyone can search the index.";

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The market index function", (json) => serve(req, deps, json));
}

async function serve(req: Request, deps: Deps, json: Json): Promise<Response> {
  const sent = req.headers.get(SECRET_HEADER);
  let trigger: "schedule" | "manual" = "manual", role: string | null = null;
  if (sent !== null) {
    // The scheduler: no login, only the shared secret.
    const secret = deps.env("INDEX_SECRET") ?? "";
    if (secret.length < 24) return json(403, { error: "no_secret", message: NO_SECRET });
    if (!sameSecret(sent, secret)) return json(403, { error: "secret", message: "The index secret doesn't match INDEX_SECRET." });
    trigger = "schedule";
  } else {
    const who = await (deps.whoIs ?? whoIs(deps.env))(req);
    if (!who) return json(401, { error: "signin", message: "Sign in again." });
    role = who.role;
  }
  const body = (await readBody(req)) ?? (trigger === "schedule" ? {} : null);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });
  const action = body.action ?? (trigger === "schedule" ? "scheduled" : undefined);
  if (trigger === "schedule" && action !== "scheduled") return json(400, { error: "bad", message: "The scheduler may only carry on a sweep or top up a state." });
  if (trigger === "manual" && action === "scheduled") return json(403, { error: "forbidden", message: "Only the schedule runs this." });

  const clock = deps.now ?? Date.now;
  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, clock) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const creds = Spgmi.creds(deps.env), configured = Spgmi.configured(creds), limits = planLimits(deps.env);

  // Every S&P call goes through the shared throttle and counters; this call counts its own requests too.
  const wait = deps.sleep ?? sleep, inner = deps.gate ?? makeGate(db, limits, wait);
  let used = 0;
  const gate: Gate = async () => { await inner(); used++; };
  const api = configured ? new Spgmi(creds, { fetch: deps.fetch, gate, sleep: wait, now: clock }) : null;
  const ctx: IndexCtx = { db, api, env: deps.env, now: clock, limits, trigger, stepMs: trigger === "schedule" ? STEP_MS_SCHEDULE : STEP_MS_PAGE, used: () => used };
  const withUsage = async (o: Record<string, unknown>) => ({ ...o, used: await db.usage(), limits: { hour: limits.hour, day: limits.day }, account: limits.plan });

  try {
    switch (action) {
      case "status":
        return json(200, await indexStatus(db, deps.env, { configured, role, now: clock(), limits }));
      case "query": {
        const r = await answerQuery(db, body);
        return r.ok ? json(200, r.answer) : json(r.status, { error: r.error, message: r.message, ...(r.indexed ? { indexed: r.indexed } : {}) });
      }
      case "start":
      case "top_up": {
        if (role !== "corpdev") return json(403, { error: "forbidden", message: CORP_DEV_ONLY });
        const r = await startSweep(ctx, { state: body.state, period: body.period, kind: action === "top_up" ? "top_up" : "sweep" });
        return r.ok ? json(200, await withUsage({ sweep: r.sweep, cost: r.cost, message: r.message })) : json(r.status, { error: r.error, message: r.message });
      }
      case "continue": {
        if (role !== "corpdev") return json(403, { error: "forbidden", message: CORP_DEV_ONLY });
        return json(200, await withUsage({ step: await runStep(ctx) }));
      }
      case "pause":
      case "resume":
      case "stop": {
        if (role !== "corpdev") return json(403, { error: "forbidden", message: CORP_DEV_ONLY });
        const r = await controlSweep(db, action as "pause" | "resume" | "stop", clock());
        return json(r.status, r.ok ? { message: r.message, sweep: r.sweep } : { error: r.status === 404 ? "none" : "state", message: r.message, sweep: r.sweep });
      }
      case "scheduled": {
        const r = await scheduledWork(ctx);
        return json(200, await withUsage({ started: r.started && (r.started.ok ? { state: r.started.sweep.state, message: r.started.message } : { error: r.started.error, message: r.started.message }), step: r.step }));
      }
      default:
        return json(400, { error: "bad", message: "Unknown action. Use status, query, start, top_up, continue, pause, resume or stop." });
    }
  } catch (e) {
    if (missingTables(e)) return json(503, { error: "no_tables", message: NO_TABLES });
    throw e;
  }
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
