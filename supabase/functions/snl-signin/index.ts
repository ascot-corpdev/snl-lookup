// Cloudflare sign-on for SNL lookup: turns a Cloudflare Access sign-in into a short Supabase session.
// Called only by the site's Cloudflare Worker (worker/index.js), which passes on the Cf-Access-Jwt-Assertion header
// Access gave it. This function checks that token itself; see _shared/access.ts for what it checks and returns.
//
// Secrets (supabase secrets set ...): CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, SNL_ADMIN_EMAILS.
// Needs Authentication > Sign In / Providers > Email switched on (the session is minted through an email
// sign-in link that is never sent). "Allow new users to sign up" can stay off: users are created with the admin key.
// Deploy: supabase functions deploy snl-signin --no-verify-jwt
//
// POST /functions/v1/snl-signin  header Cf-Access-Jwt-Assertion: <token>   body {"action":"session"} or {}
//   -> 200 {accessToken, expiresAt, expiresIn, profile: {id, email, username, displayName, role}}
//   -> 503 not_configured | 401 signin | 403 no_email | 503 unavailable | 500 server, each {error, message}

import { type Env, readBody, withCors } from "../_shared/http.ts";
import { KeyStore, type SigninStore, signIn, supabaseSigninStore } from "../_shared/access.ts";

export type Deps = { env: Env; fetch: typeof fetch; now?: () => number; store?: SigninStore | null; keys?: KeyStore };

export const TOKEN_HEADER = "Cf-Access-Jwt-Assertion";
let sharedKeys: KeyStore | null = null;

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The sign-in function", async (json, cors) => {
    const body = (await readBody(req)) ?? {};
    if (body.action !== undefined && body.action !== "session") return json(400, { error: "bad", message: "Unknown action. Use session." });
    const now = deps.now ?? Date.now;
    const keys = deps.keys ?? (sharedKeys ??= new KeyStore(deps.fetch, now));
    const store = deps.store !== undefined ? deps.store : supabaseSigninStore(deps.env, deps.fetch, now);
    const r = await signIn(req.headers.get(TOKEN_HEADER), { env: deps.env, store, keys, now: now() });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  });
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
