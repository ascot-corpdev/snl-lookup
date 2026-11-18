// SNL lookup behind Cloudflare Access. See the README, "Sign-in with Cloudflare Access".
//
// Cloudflare Access signs people in (a one-time code by email) before any request reaches this Worker. The Worker
// serves the site in web/ as static assets and adds two addresses of its own:
//   GET /config.js       the site's settings, with accessLogin on, so the page skips its password form
//   GET /access/session  checks the Access sign-in (the Access token, verified against the team's keys, or the
//                        Workers runtime's ctx.access), finds or creates the Supabase user for that email, sets their
//                        role (corpdev for an email in ADMIN_EMAILS, reader for everyone else) and hands the page a
//                        short-lived Supabase token signed the way Supabase signs its own. Row-level security,
//                        auth.uid() and the functions' login check (auth.getUser) work on it unchanged.
// Every other address is the site itself.
//
// Settings (all set with `wrangler secret put NAME`, so nothing about the deployment is in this public repository):
//   TEAM_DOMAIN               https://<team>.cloudflareaccess.com
//   POLICY_AUD                the Access application's audience (AUD) tag
//   ADMIN_EMAILS              the admin's email, or several separated by commas: these logins get the corpdev role
//   SUPABASE_URL              https://<project-ref>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  sb_publishable_... (the same key the site already uses)
//   SUPABASE_SECRET_KEY       sb_secret_... (or the legacy service_role key): finds and creates logins
//   SUPABASE_JWT_SECRET       the project's legacy JWT secret (signs HS256), or instead
//   SUPABASE_SIGNING_JWK      a private ES256 or RS256 key as a JWK with a kid, imported into Supabase as its
//                             current signing key
//   Optional: ORG_NAME, USERNAME_DOMAIN, TOKEN_MINUTES (default 15, 5 to 60)
//
// No packages: WebCrypto and fetch only, so the same file runs in Workers and in Node for the tests. worker.js is the
// Worker's entry point (an entry module may export only handlers, so everything else lives here).

const enc = new TextEncoder(), dec = new TextDecoder();
const CERTS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW = 60;
const PROFILE_TTL_MS = 10 * 60 * 1000;
export const REQUIRED = ["TEAM_DOMAIN", "POLICY_AUD", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"];
export const ROLE_ADMIN = "corpdev", ROLE_USER = "reader";

export const b64url = {
  encode: (bytes) => { const b = new Uint8Array(bytes); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
const b64json = (o) => b64url.encode(enc.encode(JSON.stringify(o)));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const trimUrl = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/(rest|auth)\/v1$/, "");

/** A JWT's header, payload, the signed bytes and the signature. null when it isn't one. */
export function decodeJwt(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(dec.decode(b64url.decode(parts[0]))), payload: JSON.parse(dec.decode(b64url.decode(parts[1]))), signed: enc.encode(`${parts[0]}.${parts[1]}`), signature: b64url.decode(parts[2]) };
  } catch { return null; }
}

/** An answer the page shows as is. */
export class BridgeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// ---------- who is an admin ----------

/** The emails in ADMIN_EMAILS, in lower case. Commas, semicolons or spaces separate them. */
export function adminList(setting) {
  return String(setting || "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
}
/** corpdev for an email in ADMIN_EMAILS, reader for everyone else the Access policy lets in. */
export function roleFor(email, setting) {
  return adminList(setting).includes(String(email || "").trim().toLowerCase()) ? ROLE_ADMIN : ROLE_USER;
}
/** A username for public.profiles (2 to 40 of a-z 0-9 . _ -) from the part of the email before the @. With clash, a
    suffix from a hash of the whole email, for when another login already has that name. */
export async function usernameFor(email, clash = false) {
  let base = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (base.length < 2) base = "user";
  if (!clash) return base.slice(0, 40);
  const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(String(email).toLowerCase()))).slice(0, 6);
  return `${base.slice(0, 33).replace(/[-.]+$/, "")}-${h}`;
}

// ---------- the Access token ----------

/** The Access token the request carries: the Cf-Access-Jwt-Assertion header, or the CF_Authorization cookie. */
export function accessToken(req) {
  const h = req.headers.get("cf-access-jwt-assertion");
  if (h) return h.trim();
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1].trim() : "";
}

/** Checks Access tokens against the team's published keys (fetched once an hour, again when a key id is new). */
export function makeAccessCheck({ fetchFn, now }) {
  let certs = { at: 0, team: "", keys: [] };
  async function keys(team, force) {
    if (!force && certs.team === team && now() - certs.at < CERTS_TTL_MS) return certs.keys;
    let res;
    try { res = await fetchFn(`${team}/cdn-cgi/access/certs`); } catch { res = null; }
    if (!res || !res.ok) throw new BridgeError(502, "access_keys", `Couldn't read Cloudflare Access's signing keys from ${team} (${res ? res.status : "no answer"}). Check TEAM_DOMAIN.`);
    const body = await res.json().catch(() => null);
    certs = { at: now(), team, keys: Array.isArray(body?.keys) ? body.keys : [] };
    return certs.keys;
  }
  /** The signed-in email, or a BridgeError. The Access token (header or cookie) is checked here when one comes with
      the request. Without one, a Worker protected by Access still has ctx.access, which the Workers runtime fills
      only for a request Access has signed in; its audience must still be this application's. */
  return async function check(req, env, ctx) {
    const team = trimUrl(env.TEAM_DOMAIN), wanted = String(env.POLICY_AUD).trim();
    const raw = accessToken(req);
    if (!raw && ctx && ctx.access) {
      const auds = Array.isArray(ctx.access.aud) ? ctx.access.aud : [ctx.access.aud];
      if (!auds.includes(wanted)) throw new BridgeError(403, "access_aud", "Cloudflare Access signed this request in for another application. Check POLICY_AUD.");
      let identity = null;
      try { identity = await ctx.access.getIdentity(); } catch { identity = null; }
      const email = typeof identity?.email === "string" ? identity.email.trim().toLowerCase() : "";
      if (!email || !email.includes("@")) throw new BridgeError(403, "access_email", "This Cloudflare Access sign-in carries no email (a service token can't use the site).");
      return email;
    }
    const jwt = decodeJwt(raw);
    if (!jwt) throw new BridgeError(401, "no_access", "No Cloudflare Access sign-in came with this request. Cloudflare Access must be switched on for this site; tell the site owner.");
    if (jwt.header.alg !== "RS256" || typeof jwt.header.kid !== "string") throw new BridgeError(401, "access_token", "The Cloudflare Access token isn't signed the way Access signs (RS256 with a key id).");
    let jwk = (await keys(team, false)).find((k) => k.kid === jwt.header.kid);
    if (!jwk) jwk = (await keys(team, true)).find((k) => k.kid === jwt.header.kid);   // Access rotates its keys
    if (!jwk) throw new BridgeError(401, "access_token", "The Cloudflare Access token was signed with a key this team doesn't publish. Check TEAM_DOMAIN.");
    let good = false;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, jwt.signature, jwt.signed);
    } catch { good = false; }
    if (!good) throw new BridgeError(401, "access_token", "The Cloudflare Access token's signature doesn't match.");
    const p = jwt.payload, t = Math.floor(now() / 1000);
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(wanted)) throw new BridgeError(403, "access_aud", "The Cloudflare Access token is for another application. Check POLICY_AUD.");
    if (trimUrl(p.iss) !== team) throw new BridgeError(403, "access_iss", "The Cloudflare Access token is from another team. Check TEAM_DOMAIN.");
    if (typeof p.exp !== "number" || p.exp + CLOCK_SKEW < t) throw new BridgeError(401, "access_expired", "Your Cloudflare Access sign-in has expired. Sign in again.");
    if (typeof p.nbf === "number" && p.nbf - CLOCK_SKEW > t) throw new BridgeError(401, "access_token", "The Cloudflare Access token isn't valid yet. Check this computer's clock.");
    const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) throw new BridgeError(403, "access_email", "This Cloudflare Access sign-in carries no email (a service token can't use the site).");
    return email;
  };
}

// ---------- the Supabase token ----------

export function tokenSeconds(env) {
  const m = Number(env.TOKEN_MINUTES);
  return (Number.isFinite(m) && m >= 5 && m <= 60 ? Math.round(m) : 15) * 60;
}

/** How tokens are signed: the private JWK (ES256 or RS256, with its kid) or the legacy JWT secret (HS256, no kid,
    which Supabase Auth checks against the legacy secret). */
async function signerFor(env) {
  if (env.SUPABASE_SIGNING_JWK) {
    let jwk;
    try { jwk = JSON.parse(env.SUPABASE_SIGNING_JWK); } catch { jwk = null; }
    if (!jwk || !jwk.d || !jwk.kid) throw new BridgeError(500, "not_configured", "SUPABASE_SIGNING_JWK must be a private key as a JWK with a kid (the one imported into Supabase).");
    if (jwk.kty === "EC" && jwk.crv === "P-256") {
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return { header: { alg: "ES256", typ: "JWT", kid: jwk.kid }, sign: (b) => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, b) };
    }
    if (jwk.kty === "RSA") {
      const { kty, n, e, d, p, q, dp, dq, qi } = jwk;
      const key = await crypto.subtle.importKey("jwk", { kty, n, e, d, p, q, dp, dq, qi, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      return { header: { alg: "RS256", typ: "JWT", kid: jwk.kid }, sign: (b) => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, b) };
    }
    throw new BridgeError(500, "not_configured", "SUPABASE_SIGNING_JWK must be an EC P-256 (ES256) or RSA (RS256) key.");
  }
  if (env.SUPABASE_JWT_SECRET) {
    const key = await crypto.subtle.importKey("raw", enc.encode(env.SUPABASE_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return { header: { alg: "HS256", typ: "JWT" }, sign: (b) => crypto.subtle.sign("HMAC", key, b) };
  }
  throw new BridgeError(500, "not_configured", "Set SUPABASE_JWT_SECRET (the legacy JWT secret) or SUPABASE_SIGNING_JWK on the Worker. See the README.");
}

/** A Supabase access token for this login, shaped like the ones Supabase Auth issues, without a session id (so no
    Supabase session or refresh token stands behind it; the page asks this Worker for a new one before it runs out). */
export async function mintToken(env, who, nowMs) {
  const signer = await signerFor(env);
  const t = Math.floor(nowMs / 1000), life = tokenSeconds(env);
  const payload = {
    iss: `${trimUrl(env.SUPABASE_URL)}/auth/v1`, sub: who.id, aud: "authenticated", exp: t + life, iat: t,
    email: who.email, phone: "", role: "authenticated", aal: "aal1", is_anonymous: false,
    app_metadata: { provider: "cloudflare_access", providers: ["cloudflare_access"], app_role: who.role }, user_metadata: {},
  };
  const body = `${b64json(signer.header)}.${b64json(payload)}`;
  return { token: `${body}.${b64url.encode(await signer.sign(enc.encode(body)))}`, payload };
}

// ---------- the Supabase login and profile ----------

/** Calls Supabase with the secret key, as supabase-js does for admin work. */
function supabase(env, fetchFn) {
  const base = trimUrl(env.SUPABASE_URL), key = String(env.SUPABASE_SECRET_KEY || "").trim();
  return async (path, init = {}) => {
    let res;
    try {
      res = await fetchFn(base + path, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json", ...(init.headers || {}) } });
    } catch (e) {
      throw new BridgeError(502, "supabase", `Couldn't reach Supabase (${String(e?.message || e)}).`);
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, ok: res.ok, body };
  };
}
const why = (r) => String(r.body?.msg || r.body?.message || r.body?.error_description || r.body?.error || `HTTP ${r.status}`);

/** The id of the Supabase login with this email, or null. Supabase's admin list matches the text anywhere in the
    email (and _ or % as wildcards), so only an exact match counts. */
async function findUserId(sb, email) {
  for (let page = 1; page <= 20; page++) {
    const r = await sb(`/auth/v1/admin/users?filter=${encodeURIComponent(email)}&page=${page}&per_page=100`);
    if (!r.ok) throw new BridgeError(502, "supabase", `Supabase didn't list logins: ${why(r)}. Check SUPABASE_SECRET_KEY.`);
    const users = Array.isArray(r.body?.users) ? r.body.users : [];
    const hit = users.find((u) => String(u?.email || "").toLowerCase() === email);
    if (hit?.id) return String(hit.id);
    if (users.length < 100) return null;
  }
  return null;
}

/** Creates the Supabase login: email confirmed, a random password nobody is told, so it can only be used through
    Access. null when a login with that email appeared meanwhile. */
async function createUser(sb, email) {
  const r = await sb("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, email_confirm: true, user_metadata: { signed_in_with: "cloudflare_access" } }) });
  if (r.ok && r.body?.id) return String(r.body.id);
  if (r.status === 422 && /email_exists|already been registered|already registered/i.test(`${r.body?.code || ""} ${r.body?.error_code || ""} ${why(r)}`)) return null;
  throw new BridgeError(502, "supabase", `Supabase didn't create the login for ${email}: ${why(r)}.`);
}

/** Makes sure public.profiles has this login with this role. Returns the username. */
async function ensureProfile(sb, id, email, role) {
  const got = await sb(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,username,role`);
  if (!got.ok) throw new BridgeError(502, "supabase", `Supabase didn't read the login's profile: ${why(got)}.`);
  const row = Array.isArray(got.body) ? got.body[0] : null;
  if (row) {
    if (row.role !== role) {
      const up = await sb(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ role }) });
      if (!up.ok) throw new BridgeError(502, "supabase", `Supabase didn't change the login's role: ${why(up)}.`);
    }
    return String(row.username);
  }
  for (const clash of [false, true]) {
    const username = await usernameFor(email, clash);
    const ins = await sb("/rest/v1/profiles", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify({ id, username, display_name: email, role }) });
    if (ins.ok) return username;
    if (ins.status !== 409) throw new BridgeError(502, "supabase", `Supabase didn't save the login's profile: ${why(ins)}.`);
  }
  throw new BridgeError(502, "supabase", "Supabase didn't save the login's profile: the username is taken.");
}

// ---------- the Worker ----------

export function missingSettings(env) {
  const out = REQUIRED.filter((k) => !String(env[k] || "").trim());
  if (!env.SUPABASE_JWT_SECRET && !env.SUPABASE_SIGNING_JWK) out.push("SUPABASE_JWT_SECRET or SUPABASE_SIGNING_JWK");
  return out;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The site's settings for the page. Only what the page already has on GitHub Pages, plus accessLogin. */
export function configScript(env) {
  const key = String(env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  const c = {
    supabaseUrl: trimUrl(env.SUPABASE_URL), supabaseAnonKey: key.startsWith("sb_secret_") ? "" : key,
    usernameDomain: String(env.USERNAME_DOMAIN || "").trim() || "snl-lookup.local", orgName: String(env.ORG_NAME || "").trim(),
    accessLogin: true, accessSessionUrl: "/access/session", logoutUrl: "/cdn-cgi/access/logout",
  };
  return `window.SNL_CONFIG = ${JSON.stringify(c, null, 2)};\n`;
}

export function makeWorker({ fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const checkAccess = makeAccessCheck({ fetchFn, now });
  const known = new Map();   // email -> {id, role, username, at}: skips the Supabase look-ups for a while

  async function session(req, env, ctx) {
    const missing = missingSettings(env);
    if (missing.length) throw new BridgeError(500, "not_configured", `The sign-in bridge isn't set up: set ${missing.join(", ")} on the Worker (wrangler secret put NAME). See the README.`);
    const email = await checkAccess(req, env, ctx);
    const role = roleFor(email, env.ADMIN_EMAILS);
    let who = known.get(email);
    if (!who || who.role !== role || now() - who.at > PROFILE_TTL_MS) {
      const sb = supabase(env, fetchFn);
      const id = (await findUserId(sb, email)) ?? (await createUser(sb, email)) ?? (await findUserId(sb, email));
      if (!id) throw new BridgeError(502, "supabase", `Supabase has no login for ${email} and didn't create one.`);
      const username = await ensureProfile(sb, id, email, role);
      who = { id, role, username, at: now() };
      known.set(email, who);
    }
    const minted = await mintToken(env, { id: who.id, email, role }, now());
    return json(200, {
      access_token: minted.token, token_type: "bearer", expires_in: minted.payload.exp - minted.payload.iat, expires_at: minted.payload.exp,
      user: { id: who.id, email }, role, username: who.username,
    });
  }

  return {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/config.js") {
          return new Response(configScript(env), { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" } });
        }
        if (url.pathname === "/access/session") {
          if (req.method !== "GET") return json(405, { error: "method", message: "Use GET." });
          return await session(req, env, ctx);
        }
        if (url.pathname.startsWith("/access/")) return json(404, { error: "not_found", message: "Not found." });
        return env.ASSETS ? await env.ASSETS.fetch(req) : json(404, { error: "not_found", message: "Not found." });
      } catch (e) {
        if (e instanceof BridgeError) return json(e.status, { error: e.code, message: e.message });
        console.error(e);
        return json(500, { error: "server", message: `The sign-in bridge failed: ${String(e?.message || e)}. Tell the site owner.` });
      }
    },
  };
}

