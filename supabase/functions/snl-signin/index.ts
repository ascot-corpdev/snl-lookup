// Cloudflare sign-on for SNL lookup: turns a Cloudflare Access sign-in into a short Supabase session.
// Called only by the site's Cloudflare Worker (worker/index.js), which passes on the Cf-Access-Jwt-Assertion header
// Access gave it. This function checks that token itself; see _shared/access.ts for what it checks and returns.
//
// Secrets (supabase secrets set ...): CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, SNL_ADMIN_EMAILS.
// Needs Authentication > Sign In / Providers > Email switched on (the session is minted through an email
// sign-in link that is never sent). "Allow new users to sign up" can stay off: users are created with the admin key.
// Deploy: supabase functions deploy snl-signin --no-verify-jwt
//
// Sign-in notices (_shared/signins.ts): after the session is minted, the sign-in is recorded in public.snl_signins
// (migration 0011) and, for a new session of someone not in SNL_ADMIN_EMAILS, the owner is emailed. This runs in the
// background where Supabase allows it, otherwise for at most a few seconds, and never changes the answer.
// Optional secrets: SNL_NOTIFY_EMAILS, SNL_SIGNIN_NOTICES (off), RESEND_API_KEY, WATCH_FROM.
//
// POST /functions/v1/snl-signin  header Cf-Access-Jwt-Assertion: <token>   body {"action":"session"} or {}
//   -> 200 {accessToken, expiresAt, expiresIn, profile: {id, email, username, displayName, role}}
//   -> 503 not_configured | 401 signin | 403 no_email | 503 unavailable | 500 server, each {error, message}
// POST /functions/v1/snl-signin  header Authorization: Bearer <a Corp Dev login's token>   body {"action":"status"}
//   -> 200 {recorded, notices: {on, why, recipients, fromSet}, keepDays}   (counts only, never an address or key)
//   -> 401 signin | 403 forbidden

import { type Env, readBody, whoIs as realWhoIs, type WhoIs, withCors } from "../_shared/http.ts";
import { KeyStore, type SigninStore, signIn, supabaseSigninStore } from "../_shared/access.ts";
import { recordSignin, SIGNIN_WAIT_MS, type SigninLog, signinStatus, supabaseSigninLog, within } from "../_shared/signins.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export type Deps = {
  env: Env; fetch: typeof fetch; now?: () => number; store?: SigninStore | null; keys?: KeyStore;
  /** The record of sign-ins; null for none. Default: public.snl_signins with the service key. */
  log?: SigninLog | null;
  /** Hands work on to run after the answer (Supabase's EdgeRuntime.waitUntil by default); null to wait for it here. */
  background?: ((work: Promise<unknown>) => void) | null;
  /** Without background work, how long the answer waits for the record and the email at most. */
  recordWaitMs?: number;
  /** Session keys handled lately by this running function. */
  seen?: Map<string, number>;
  whoIs?: WhoIs;
};

export const TOKEN_HEADER = "Cf-Access-Jwt-Assertion";
let sharedKeys: KeyStore | null = null;
const sharedSeen = new Map<string, number>();

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The sign-in function", async (json, cors) => {
    const body = (await readBody(req)) ?? {};
    if (body.action === "status") {
      const who = await (deps.whoIs ?? realWhoIs(deps.env))(req);
      if (!who) return json(401, { error: "signin", message: "Sign in again." });
      if (who.role !== "corpdev") return json(403, { error: "forbidden", message: "Only Corp Dev can see sign-in notices." });
      const log = deps.log !== undefined ? deps.log : supabaseSigninLog(deps.env, deps.fetch);
      return json(200, await signinStatus(log, deps.env));
    }
    if (body.action !== undefined && body.action !== "session") return json(400, { error: "bad", message: "Unknown action. Use session." });
    const now = deps.now ?? Date.now;
    const keys = deps.keys ?? (sharedKeys ??= new KeyStore(deps.fetch, now));
    const store = deps.store !== undefined ? deps.store : supabaseSigninStore(deps.env, deps.fetch, now);
    const r = await signIn(req.headers.get(TOKEN_HEADER), { env: deps.env, store, keys, now: now() });
    if (r.status === 200 && r.who) {
      // After the session is minted: recorded, and the owner told, without holding the answer up.
      try {
        const log = deps.log !== undefined ? deps.log : supabaseSigninLog(deps.env, deps.fetch);
        const work = recordSignin({ log, env: deps.env, fetch: deps.fetch, now, seen: deps.seen ?? sharedSeen }, r.who);
        const background = deps.background !== undefined ? deps.background : typeof EdgeRuntime !== "undefined" ? (w: Promise<unknown>) => EdgeRuntime!.waitUntil(w) : null;
        if (background) background(work); else await within(work, deps.recordWaitMs ?? SIGNIN_WAIT_MS);
      } catch { console.error("snl-signin: sign-in not recorded (error)"); }
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  });
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
