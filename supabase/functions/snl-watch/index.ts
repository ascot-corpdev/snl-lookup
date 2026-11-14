// The watchlist check for SNL lookup: looks for new rate, rule and form filings by the companies and states the
// team watches (the "watchlist" setting, edited on the Filings view). Found filings and the record of checks are in
// migration 0003. See _shared/watch.ts for how a check works and what it costs in S&P requests.
//
// Two ways in:
//   - a Corp Dev login ("Check now" on the Filings view), or any login for status;
//   - Supabase Cron once a day (supabase/watch_schedule.sql), with the header x-watch-secret equal to the
//     WATCH_SECRET secret and no login. Without WATCH_SECRET, scheduled calls are refused.
//
// Secrets (supabase secrets set ...): WATCH_SECRET (at least 24 characters), plus the S&P ones snl-filings uses.
// Optional: RESEND_API_KEY and WATCH_FROM (email the new filings to the watchlist's recipients), SITE_URL (the link
// in the email; otherwise the first address in ALLOWED_ORIGIN), SPGMI_ACCOUNT, ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-watch --no-verify-jwt
//
// POST /functions/v1/snl-watch  {"action": ...}
//   status  (any login)                     -> what is watched, the last check, the new filings found
//   run     (Corp Dev login, or the secret)  -> one check now: {run: {status, message, requests, newCount, ...}}

import { adminClient, type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { type Gate, makeGate, planLimits, Spgmi, SpgmiError } from "../_shared/spgmi.ts";
import { runWatch, sameSecret, WATCH_MAX_REQUESTS, watchStatus } from "../_shared/watch.ts";

export type Deps = { env: Env; fetch: typeof fetch; mailFetch?: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; gate?: Gate; sleep?: (ms: number) => Promise<void> };

export const SECRET_HEADER = "x-watch-secret";
export const NO_SECRET = "Scheduled checks are switched off: WATCH_SECRET isn't set on Supabase (use at least 24 characters). See the README, Watchlist.";

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The watchlist function", (json) => serve(req, deps, json));
}

async function serve(req: Request, deps: Deps, json: Json): Promise<Response> {
  const sent = req.headers.get(SECRET_HEADER);
  let trigger: "schedule" | "manual" = "manual", role: string | null = null;
  if (sent !== null) {
    // The scheduler: no login, only the shared secret.
    const secret = deps.env("WATCH_SECRET") ?? "";
    if (secret.length < 24) return json(403, { error: "no_secret", message: NO_SECRET });
    if (!sameSecret(sent, secret)) return json(403, { error: "secret", message: "The watch secret doesn't match WATCH_SECRET." });
    trigger = "schedule";
  } else {
    const who = await (deps.whoIs ?? whoIs(deps.env))(req);
    if (!who) return json(401, { error: "signin", message: "Sign in again." });
    role = who.role;
  }
  const body = (await readBody(req)) ?? (trigger === "schedule" ? {} : null);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });
  const action = body.action ?? (trigger === "schedule" ? "run" : undefined);

  const clock = deps.now ?? Date.now;
  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, clock) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const creds = Spgmi.creds(deps.env), configured = Spgmi.configured(creds);

  switch (action) {
    case "status": {
      if (trigger === "schedule") return json(400, { error: "bad", message: "The scheduler may only run a check." });
      return json(200, { ...(await watchStatus(db, deps.env, configured, clock())), role });
    }
    case "run": {
      if (trigger === "manual" && role !== "corpdev") return json(403, { error: "forbidden", message: "Only Corp Dev logins can run a check. Once it is set up, it runs by itself every day." });
      // Every S&P call goes through the shared throttle and counter, and through this check's own budget.
      const wait = deps.sleep ?? sleep, limits = planLimits(deps.env), inner = deps.gate ?? makeGate(db, limits, wait);
      let used = 0;
      const gate: Gate = async () => {
        if (used >= WATCH_MAX_REQUESTS) throw new SpgmiError("limit", `The check stopped after using the ${WATCH_MAX_REQUESTS} S&P requests one check may use. Remove companies or states from the watchlist.`);
        await inner();
        used++;
      };
      const api = configured ? new Spgmi(creds, { fetch: deps.fetch, gate, sleep: wait }) : null;
      const run = await runWatch({ db, api, env: deps.env, mailFetch: deps.mailFetch ?? deps.fetch, now: clock, trigger, used: () => used });
      if (run.status === "busy") return json(409, { error: "busy", message: run.message, run });
      return json(200, { run, used: await db.usage(), limits: { hour: limits.hour, day: limits.day }, account: limits.plan });
    }
    default:
      return json(400, { error: "bad", message: "Unknown action. Use status or run." });
  }
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
