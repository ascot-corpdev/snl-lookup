// PROTOTYPE ONLY. Not wired into the app, not deployed, not used by web/ or supabase/.
// See docs/hosting-and-logins-options.md, option A3 ("Worker as identity broker").
//
// What it does, on a Worker behind Cloudflare Access:
//   1. Checks the Access token (Cf-Access-Jwt-Assertion): RS256, signed by one of the team's keys, right aud and iss,
//      not expired.
//   2. Looks up the signed-in email in a KV map of profiles: "email:<lower-case email>" -> {"id": "<auth.users uuid>",
//      "role": "corpdev" | "reader"}. The login script would write this map; the Worker holds no Supabase secret key.
//   3. Mints a short-lived RS256 token that Supabase can trust as a custom OIDC issuer: sub is the existing auth.users
//      id (so auth.uid(), app_role() and today's RLS keep working), role is "authenticated", app_role is the app role.
//   4. Forwards /sb/functions/v1/*, /sb/rest/v1/* and /sb/storage/v1/* to Supabase with that token, streaming the
//      answer back. /sb/auth/v1/* is refused: there are no Supabase Auth sessions in this design.
//   5. Serves /.well-known/openid-configuration and /.well-known/jwks.json, which Supabase reads to check the tokens.
//      Those two paths must bypass Access (Supabase fetches them without a login).
// Everything else (the static site) is left to the assets binding, which Access protects at the edge.
//
// No packages: WebCrypto only, so the same file runs in Workers and in Node 22 for the test.
//
// Bindings (wrangler.toml): TEAM_DOMAIN, POLICY_AUD, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ISSUER (vars);
// SIGNING_JWK (secret: the private RSA key as a JWK with a "kid"); PROFILES (KV); ASSETS (static assets, optional).

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const TOKEN_SECONDS = 300;
const CLOCK_SKEW = 60;
const CERTS_TTL_MS = 60 * 60 * 1000;
const FORWARD = /^\/sb\/(functions\/v1|rest\/v1|storage\/v1)(\/|$)/;
// Never sent on to Supabase: the Access token and cookie, and whatever the browser claimed as its identity.
const DROP = ["cookie", "authorization", "apikey", "cf-access-jwt-assertion", "cf-access-authenticated-user-email", "host"];

const enc = new TextEncoder(), dec = new TextDecoder();
export const b64url = {
  encode: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Splits and decodes a JWT. null when it isn't one. */
export function decodeJwt(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(dec.decode(b64url.decode(parts[0]))), payload: JSON.parse(dec.decode(b64url.decode(parts[1]))), signed: enc.encode(`${parts[0]}.${parts[1]}`), signature: b64url.decode(parts[2]) };
  } catch { return null; }
}

/** The handler, with fetch and the clock passed in so the test can fake Access, Supabase and time. */
export function makeWorker({ fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let certs = { at: 0, team: "", keys: [] };
  const minted = new Map();   // email -> {token, exp}: one signature per person per few minutes, not per request
  let signer = null;          // {jwkJson, key, publicJwk}

  async function teamKeys(team, force) {
    if (!force && certs.team === team && now() - certs.at < CERTS_TTL_MS) return certs.keys;
    const res = await fetchFn(`${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs answered ${res.status}`);
    const body = await res.json();
    certs = { at: now(), team, keys: Array.isArray(body?.keys) ? body.keys : [] };
    return certs.keys;
  }

  /** The Access identity ({email, sub}) or a reason. */
  async function checkAccess(req, env) {
    const team = String(env.TEAM_DOMAIN || "").replace(/\/+$/, "");
    if (!team || !env.POLICY_AUD) return { error: 500, reason: "TEAM_DOMAIN and POLICY_AUD aren't set." };
    const jwt = decodeJwt(req.headers.get("cf-access-jwt-assertion"));
    if (!jwt) return { error: 401, reason: "No Access token. Sign in through Cloudflare Access." };
    if (jwt.header.alg !== "RS256" || !jwt.header.kid) return { error: 401, reason: "The Access token isn't RS256 with a key id." };
    let jwk = (await teamKeys(team, false)).find((k) => k.kid === jwt.header.kid);
    if (!jwk) jwk = (await teamKeys(team, true)).find((k) => k.kid === jwt.header.kid);   // keys rotate
    if (!jwk) return { error: 401, reason: "The Access token was signed with an unknown key." };
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, ALG, false, ["verify"]);
    if (!(await crypto.subtle.verify(ALG, key, jwt.signature, jwt.signed))) return { error: 401, reason: "The Access token's signature doesn't match." };
    const p = jwt.payload, t = Math.floor(now() / 1000);
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(env.POLICY_AUD)) return { error: 403, reason: "The Access token is for another application." };
    if (p.iss !== team) return { error: 403, reason: "The Access token is from another team." };
    if (typeof p.exp !== "number" || p.exp + CLOCK_SKEW < t) return { error: 401, reason: "The Access token has expired. Reload the page." };
    if (typeof p.nbf === "number" && p.nbf - CLOCK_SKEW > t) return { error: 401, reason: "The Access token isn't valid yet." };
    const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
    if (!email) return { error: 403, reason: "The Access token carries no email (a service token can't use the app)." };
    return { email, sub: p.sub };
  }

  async function getSigner(env) {
    if (signer && signer.jwkJson === env.SIGNING_JWK) return signer;
    const jwk = JSON.parse(env.SIGNING_JWK || "null");
    if (!jwk || jwk.kty !== "RSA" || !jwk.d || !jwk.kid) throw new Error("SIGNING_JWK must be a private RSA JWK with a kid.");
    const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, ALG, false, ["sign"]);
    const publicJwk = { kty: "RSA", n: jwk.n, e: jwk.e, kid: jwk.kid, alg: "RS256", use: "sig" };
    signer = { jwkJson: env.SIGNING_JWK, key, publicJwk };
    return signer;
  }

  async function mint(env, email, profile) {
    const t = Math.floor(now() / 1000), hit = minted.get(email);
    if (hit && hit.exp - 60 > t && hit.id === profile.id && hit.role === profile.role) return hit.token;
    const s = await getSigner(env);
    const header = { alg: "RS256", typ: "JWT", kid: s.publicJwk.kid };
    const payload = { iss: env.ISSUER, sub: profile.id, aud: "authenticated", role: "authenticated", app_role: profile.role, email, iat: t, exp: t + TOKEN_SECONDS };
    const body = `${b64url.encode(enc.encode(JSON.stringify(header)))}.${b64url.encode(enc.encode(JSON.stringify(payload)))}`;
    const token = `${body}.${b64url.encode(await crypto.subtle.sign(ALG, s.key, enc.encode(body)))}`;
    minted.set(email, { token, exp: payload.exp, id: profile.id, role: profile.role });
    return token;
  }

  async function forward(req, env, url, token) {
    const target = String(env.SUPABASE_URL || "").replace(/\/+$/, "") + url.pathname.slice("/sb".length) + url.search;
    const headers = new Headers(req.headers);
    for (const h of DROP) headers.delete(h);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("apikey", env.SUPABASE_PUBLISHABLE_KEY || "");
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const res = await fetchFn(target, { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual", ...(hasBody ? { duplex: "half" } : {}) });
    const out = new Headers(res.headers);
    out.delete("set-cookie");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }

  return {
    async fetch(req, env) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/.well-known/openid-configuration") {
          return json(200, { issuer: env.ISSUER, jwks_uri: `${String(env.ISSUER).replace(/\/+$/, "")}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["id_token"], subject_types_supported: ["public"] });
        }
        if (url.pathname === "/.well-known/jwks.json") return json(200, { keys: [(await getSigner(env)).publicJwk] });
        if (url.pathname === "/sb" || url.pathname.startsWith("/sb/")) {
          if (!FORWARD.test(url.pathname)) return json(404, { error: "not_forwarded", message: "Only functions, rest and storage are forwarded. Sign-in is through Cloudflare Access." });
          const who = await checkAccess(req, env);
          if (who.error) return json(who.error, { error: "access", message: who.reason });
          const profile = env.PROFILES ? await env.PROFILES.get(`email:${who.email}`, "json") : null;
          if (!profile || typeof profile.id !== "string" || !["corpdev", "reader"].includes(profile.role)) {
            return json(403, { error: "no_profile", message: "This sign-in has no role on this site yet. Ask Corp Dev to add you." });
          }
          return await forward(req, env, url, await mint(env, who.email, profile));
        }
        return env.ASSETS ? env.ASSETS.fetch(req) : json(404, { error: "not_found" });
      } catch (e) {
        return json(502, { error: "broker", message: `The sign-in broker failed: ${String(e?.message || e)}` });
      }
    },
  };
}

export default makeWorker();
