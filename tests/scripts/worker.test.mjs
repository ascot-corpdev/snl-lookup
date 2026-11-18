// cloudflare/bridge.js, the Cloudflare Access sign-in bridge (cloudflare/worker.js is its entry point). Checks the
// Access token (signature, audience, issuer, expiry), maps the admin email to corpdev and everyone else to reader,
// finds or creates the Supabase login and its profile, and mints the Supabase token. Against made-up Access keys and
// an in-memory stand-in for Supabase's admin and data APIs, on this machine only. Every email, id and key is made up.
import { adminList, b64url, BridgeError, configScript, decodeJwt, makeWorker, missingSettings, mintToken, roleFor, tokenSeconds, usernameFor } from "../../cloudflare/bridge.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };

const enc = new TextEncoder();
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0), T = Math.floor(NOW / 1000);
const TEAM = "https://made-up-team.cloudflareaccess.com";
const AUD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SB = "https://madeupref.supabase.co";
const SECRET_KEY = "sb_secret_made_up_for_tests";
const JWT_SECRET = "a-made-up-legacy-jwt-secret-that-is-long-enough-1234";
const ADMIN = "owner@example.com";

async function rsaPair(kid) {
  const pair = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey), priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pair, pub: { kty: "RSA", n: pub.n, e: pub.e, kid, alg: "RS256", use: "sig" }, priv: { ...priv, kid } };
}
async function accessJwt(key, kid, payload, alg = "RS256") {
  const h = b64url.encode(enc.encode(JSON.stringify({ alg, kid, typ: "JWT" }))), p = b64url.encode(enc.encode(JSON.stringify(payload)));
  return `${h}.${p}.${b64url.encode(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${h}.${p}`)))}`;
}
const access = await rsaPair("access-key-1"), rotated = await rsaPair("access-key-2"), stranger = await rsaPair("access-key-1");
const claims = (email, more = {}) => ({ aud: [AUD], email, exp: T + 3600, iat: T - 5, nbf: T - 5, iss: TEAM, type: "app", sub: "made-up-access-user", ...more });

// ---------- an in-memory Supabase: admin users and public.profiles ----------
function fakeSupabase() {
  const S = { users: [], profiles: {}, calls: [], certsServed: [access.pub], certsReads: 0, failList: false, raceEmail: null, nextId: 1 };
  const newId = () => `00000000-0000-4000-8000-${String(S.nextId++).padStart(12, "0")}`;
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  S.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = (init.method || "GET").toUpperCase(), h = new Headers(init.headers || {});
    if (url.origin === TEAM && url.pathname === "/cdn-cgi/access/certs") { S.certsReads++; return reply(200, { keys: S.certsServed, public_cert: {}, public_certs: [] }); }
    if (url.origin !== SB) return reply(599, { message: "unexpected host" });
    S.calls.push({ method, path: url.pathname + url.search, apikey: h.get("apikey"), auth: h.get("authorization"), body: init.body ? JSON.parse(init.body) : null });
    if (h.get("apikey") !== SECRET_KEY || h.get("authorization") !== `Bearer ${SECRET_KEY}`) return reply(401, { message: "Invalid API key" });
    if (url.pathname === "/auth/v1/admin/users" && method === "GET") {
      if (S.failList) return reply(500, { msg: "database is down" });
      // Supabase matches `email LIKE %filter%`, so _ is a wildcard: a near miss can come back too
      const f = url.searchParams.get("filter") || "", re = new RegExp(f.split("").map((c) => (c === "_" ? "." : c === "%" ? ".*" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join(""));
      return reply(200, { users: S.users.filter((u) => re.test(u.email)), aud: "authenticated" });
    }
    if (url.pathname === "/auth/v1/admin/users" && method === "POST") {
      const b = JSON.parse(init.body);
      if (S.raceEmail === b.email) { S.users.push({ id: newId(), email: b.email }); S.raceEmail = null; }
      if (S.users.some((u) => u.email === b.email)) return reply(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      const u = { id: newId(), email: b.email, email_confirmed_at: b.email_confirm ? new Date(NOW).toISOString() : null, user_metadata: b.user_metadata };
      S.users.push(u); return reply(200, u);
    }
    if (url.pathname === "/rest/v1/profiles") {
      const idEq = (url.searchParams.get("id") || "").replace(/^eq\./, "");
      if (method === "GET") return reply(200, S.profiles[idEq] ? [{ id: idEq, username: S.profiles[idEq].username, role: S.profiles[idEq].role }] : []);
      if (method === "PATCH") { if (!S.profiles[idEq]) return reply(404, {}); Object.assign(S.profiles[idEq], JSON.parse(init.body)); return reply(204); }
      if (method === "POST") {
        const row = JSON.parse(init.body);
        if (S.profiles[row.id] || Object.values(S.profiles).some((p) => p.username === row.username)) return reply(409, { code: "23505", message: "duplicate key value violates unique constraint" });
        if (!/^[a-z0-9._-]{2,40}$/.test(row.username) || !["corpdev", "reader"].includes(row.role)) return reply(400, { code: "23514", message: "violates check constraint" });
        S.profiles[row.id] = { ...row }; return reply(201);
      }
    }
    return reply(404, { message: "no route " + method + " " + url.pathname });
  };
  return S;
}

const baseEnv = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ADMIN_EMAILS: ` ${ADMIN.toUpperCase()} , second.admin@example.com`, SUPABASE_URL: SB + "/", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_made_up", SUPABASE_SECRET_KEY: SECRET_KEY, SUPABASE_JWT_SECRET: JWT_SECRET, ORG_NAME: "Made-up Insurance Group" };
function harness(envOver = {}, nowFn = () => NOW) {
  const S = fakeSupabase();
  const worker = makeWorker({ fetchFn: S.fetch, now: nowFn });
  const env = { ...baseEnv, ...envOver };
  const call = (path, { token, cookie, method = "GET" } = {}) => worker.fetch(new Request(`https://snl-lookup.made-up.workers.dev${path}`, { method, headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...(cookie ? { cookie } : {}) } }), env);
  return { S, worker, env, call };
}
const hmacOk = async (token, secret) => {
  const j = decodeJwt(token), key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, j.signature, j.signed);
};

// ---------- who is an admin ----------
ok("ADMIN_EMAILS is read in any case, with commas, semicolons or spaces between", JSON.stringify(adminList(" A@x.com, b@Y.com;c@z.com  d@w.com ,, nope")) === JSON.stringify(["a@x.com", "b@y.com", "c@z.com", "d@w.com"]));
ok("an admin email maps to corpdev, in any case", roleFor("Owner@Example.com", baseEnv.ADMIN_EMAILS) === "corpdev" && roleFor("second.admin@example.com", baseEnv.ADMIN_EMAILS) === "corpdev");
ok("everyone else maps to reader", roleFor("analyst@example.com", baseEnv.ADMIN_EMAILS) === "reader");
ok("a near miss is not an admin", roleFor("owner@example.co", baseEnv.ADMIN_EMAILS) === "reader" && roleFor("xowner@example.com", baseEnv.ADMIN_EMAILS) === "reader");
ok("with ADMIN_EMAILS unset nobody is an admin", roleFor(ADMIN, undefined) === "reader" && roleFor(ADMIN, "") === "reader");

// ---------- usernames ----------
ok("a username is the part before the @", (await usernameFor("jane.doe@example.com")) === "jane.doe");
ok("characters a username can't hold become dashes", (await usernameFor("Jane+Doe O'Neil@example.com")) === "jane-doe-o-neil");
ok("a too-short name becomes user", (await usernameFor("j@example.com")) === "user");
const clash = await usernameFor("jane.doe@example.com", true);
ok("a clash adds a suffix from the email, still a valid username", /^jane\.doe-[0-9a-f]{6}$/.test(clash) && clash !== (await usernameFor("jane.doe@other.example", true)), clash);
const long = await usernameFor("a".repeat(60) + "@example.com", true);
ok("a long name is cut to fit 40 characters", long.length <= 40 && /^[a-z0-9._-]{2,40}$/.test(long), long);

// ---------- settings ----------
ok("missing settings are named", JSON.stringify(missingSettings({})) === JSON.stringify(["TEAM_DOMAIN", "POLICY_AUD", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_JWT_SECRET or SUPABASE_SIGNING_JWK"]));
ok("nothing is missing in the test settings", missingSettings(baseEnv).length === 0);
ok("token lifetime: 15 minutes by default, 5 to 60 allowed", tokenSeconds({}) === 900 && tokenSeconds({ TOKEN_MINUTES: "30" }) === 1800 && tokenSeconds({ TOKEN_MINUTES: "2" }) === 900 && tokenSeconds({ TOKEN_MINUTES: "600" }) === 900);

// ---------- the Access token ----------
{
  const { call, S } = harness();
  const fails = async (name, token, status, code) => {
    const r = await call("/access/session", { token }); const b = await r.json();
    ok(name, r.status === status && b.error === code, { status: r.status, b });
  };
  await fails("no Access token: 401", undefined, 401, "no_access");
  await fails("not a JWT: 401", "not-a-token", 401, "no_access");
  await fails("wrong audience: 403", await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN, { aud: ["another-application"] })), 403, "access_aud");
  await fails("wrong issuer: 403", await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN, { iss: "https://other-team.cloudflareaccess.com" })), 403, "access_iss");
  await fails("expired: 401", await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN, { exp: T - 120 })), 401, "access_expired");
  await fails("not valid yet: 401", await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN, { nbf: T + 600 })), 401, "access_token");
  await fails("signed by a key that isn't the team's: 401", await accessJwt(stranger.pair.privateKey, "access-key-1", claims(ADMIN)), 401, "access_token");
  await fails("a key id the team doesn't publish: 401", await accessJwt(rotated.pair.privateKey, "access-key-2", claims(ADMIN)), 401, "access_token");
  await fails("not RS256: 401", await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN), "HS256"), 401, "access_token");
  await fails("a service token with no email: 403", await accessJwt(access.pair.privateKey, "access-key-1", claims(undefined, { email: undefined, common_name: "made-up.access" })), 403, "access_email");
  ok("no refused request reached Supabase", S.calls.length === 0, S.calls);
  ok("an expiry within a minute's clock difference still counts", (await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("late@example.com", { exp: T - 30 })) })).status === 200);
  const before = S.certsReads;
  S.certsServed = [access.pub, rotated.pub];
  ok("a rotated Access key is fetched once and accepted", (await call("/access/session", { token: await accessJwt(rotated.pair.privateKey, "access-key-2", claims("rotated@example.com")) })).status === 200 && S.certsReads === before + 1);
  ok("the CF_Authorization cookie works when the header is missing", (await call("/access/session", { cookie: `other=1; CF_Authorization=${await accessJwt(access.pair.privateKey, "access-key-1", claims("cookie@example.com"))}; x=2` })).status === 200);
}

// ---------- ctx.access: a Worker protected by Access, with no token on the request ----------
{
  const { worker, env, S } = harness();
  const req = () => new Request("https://snl-lookup.made-up.workers.dev/access/session");
  const ctxFor = (aud, email) => ({ access: { aud, getIdentity: async () => (email === undefined ? {} : { email, name: "Made-up Person" }) } });
  let r = await worker.fetch(req(), env, ctxFor(AUD, "CtxUser@Example.com"));
  let b = await r.json();
  ok("ctx.access with this application's audience signs in by its email", r.status === 200 && b.user?.email === "ctxuser@example.com" && b.role === "reader", b);
  ok("ctx.access needs no Access key fetch", S.certsReads === 0);
  r = await worker.fetch(req(), env, ctxFor([AUD], ADMIN));
  ok("ctx.access with the audience in a list, admin email: corpdev", (await r.json()).role === "corpdev");
  r = await worker.fetch(req(), env, ctxFor("another-application", ADMIN));
  ok("ctx.access for another application: 403", r.status === 403 && (await r.json()).error === "access_aud");
  r = await worker.fetch(req(), env, ctxFor(AUD, undefined));
  ok("ctx.access with no email: 403", r.status === 403 && (await r.json()).error === "access_email");
  r = await worker.fetch(new Request("https://snl-lookup.made-up.workers.dev/access/session", { headers: { "cf-access-jwt-assertion": await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN, { aud: ["another-application"] })) } }), env, ctxFor(AUD, ADMIN));
  ok("a token on the request is checked even when ctx.access is there", r.status === 403 && (await r.json()).error === "access_aud");
  r = await worker.fetch(req(), env, {});
  ok("no token and no ctx.access: 401", r.status === 401 && (await r.json()).error === "no_access");
}

// ---------- first sign-in: the login and profile are made, the token is minted ----------
{
  const { call, S } = harness();
  const r = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("Owner@Example.com")) });
  const b = await r.json();
  ok("the admin's first sign-in answers 200, not cached", r.status === 200 && r.headers.get("cache-control") === "no-store", { status: r.status, b });
  ok("the Supabase login was created, email confirmed, with no password given", S.users.length === 1 && S.users[0].email === "owner@example.com" && !!S.users[0].email_confirmed_at && S.calls.some((c) => c.method === "POST" && c.path === "/auth/v1/admin/users" && !("password" in c.body)), S.users);
  ok("every Supabase call carried the secret key as supabase-js sends it", S.calls.every((c) => c.apikey === SECRET_KEY && c.auth === `Bearer ${SECRET_KEY}`));
  const id = S.users[0].id;
  ok("the admin's profile has the corpdev role, the email as name", S.profiles[id]?.role === "corpdev" && S.profiles[id]?.username === "owner" && S.profiles[id]?.display_name === "owner@example.com", S.profiles[id]);
  ok("the answer gives the user, role, username and times", b.user?.id === id && b.user?.email === "owner@example.com" && b.role === "corpdev" && b.username === "owner" && b.token_type === "bearer" && b.expires_in === 900 && b.expires_at === T + 900);
  const j = decodeJwt(b.access_token);
  ok("HS256 with no key id, so Supabase Auth checks it with the legacy secret", j.header.alg === "HS256" && !("kid" in j.header) && j.header.typ === "JWT", j.header);
  ok("the signature verifies with the legacy secret", await hmacOk(b.access_token, JWT_SECRET));
  ok("and not with another secret", !(await hmacOk(b.access_token, JWT_SECRET + "x")));
  const p = j.payload;
  ok("sub is the Supabase login's id, so auth.uid() and the profiles look-up work", p.sub === id);
  ok("role authenticated and aud authenticated, as Supabase Auth's own tokens", p.role === "authenticated" && p.aud === "authenticated");
  ok("issuer is the project's auth address", p.iss === `${SB}/auth/v1`, p.iss);
  ok("15 minutes from now", p.iat === T && p.exp === T + 900);
  ok("email, not anonymous, aal1", p.email === "owner@example.com" && p.is_anonymous === false && p.aal === "aal1");
  ok("app_metadata says how and with which app role", p.app_metadata?.provider === "cloudflare_access" && p.app_metadata?.app_role === "corpdev");
  ok("no session id, so Supabase Auth doesn't look for a session", !("session_id" in p));
  ok("the answer holds no secret", !JSON.stringify(b).includes(SECRET_KEY) && !JSON.stringify(b).includes(JWT_SECRET));

  // A user, then the same user again
  const r2 = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("analyst@example.com")) });
  const b2 = await r2.json();
  ok("a non-admin gets the reader role", r2.status === 200 && b2.role === "reader" && S.profiles[b2.user.id]?.role === "reader" && decodeJwt(b2.access_token).payload.app_metadata.app_role === "reader");
  const n = S.calls.length;
  const r3 = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("analyst@example.com")) });
  ok("signing in again within 10 minutes mints a token without asking Supabase", r3.status === 200 && S.calls.length === n && (await r3.json()).user.id === b2.user.id);
  ok("one login each", S.users.length === 2);
}

// ---------- an existing login: found by exact email, role brought in line ----------
{
  const { call, S } = harness();
  S.users.push({ id: "00000000-0000-4000-8000-0000000000aa", email: "anna_lee@example.com" }, { id: "00000000-0000-4000-8000-0000000000bb", email: "annaxlee@example.com" });
  S.profiles["00000000-0000-4000-8000-0000000000bb"] = { username: "annaxlee", display_name: "Anna X", role: "corpdev" };
  const r = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("annaxlee@example.com")) });
  const b = await r.json();
  ok("the login with exactly that email is used, not a wildcard near miss", b.user?.id === "00000000-0000-4000-8000-0000000000bb", b);
  ok("no new login is made for an existing email", S.users.length === 2);
  ok("a corpdev profile whose email isn't in ADMIN_EMAILS becomes reader", S.profiles["00000000-0000-4000-8000-0000000000bb"].role === "reader" && b.role === "reader");
  ok("its username and name are kept", S.profiles["00000000-0000-4000-8000-0000000000bb"].username === "annaxlee" && S.profiles["00000000-0000-4000-8000-0000000000bb"].display_name === "Anna X");
  const r2 = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("anna_lee@example.com")) });
  const b2 = await r2.json();
  ok("a login with an existing user but no profile gets one", b2.user?.id === "00000000-0000-4000-8000-0000000000aa" && S.profiles["00000000-0000-4000-8000-0000000000aa"]?.role === "reader", b2);
}

// ---------- awkward cases ----------
{
  const { call, S } = harness();
  S.profiles["someone-else"] = { username: "owner", display_name: "Someone", role: "reader" };
  const b = await (await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN)) })).json();
  ok("a taken username gets the suffix", /^owner-[0-9a-f]{6}$/.test(b.username) && S.profiles[b.user.id]?.username === b.username, b);

  S.raceEmail = "racer@example.com";   // the login appears between the look-up and the create
  const r = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("racer@example.com")) });
  const b2 = await r.json();
  ok("a login made meanwhile is found and used", r.status === 200 && S.users.filter((u) => u.email === "racer@example.com").length === 1 && b2.user.id === S.users.find((u) => u.email === "racer@example.com").id, b2);

  S.failList = true;
  const r3 = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims("down@example.com")) });
  const b3 = await r3.json();
  ok("Supabase failing answers 502 with its reason", r3.status === 502 && b3.error === "supabase" && /database is down/.test(b3.message), b3);
}
{
  const { call, S } = harness({ SUPABASE_SECRET_KEY: "sb_secret_wrong" });
  const b = await (await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN)) })).json();
  ok("a wrong secret key says to check it", b.error === "supabase" && /SUPABASE_SECRET_KEY/.test(b.message), b);
  ok("and creates nothing", S.users.length === 0);
}
{
  const { call } = harness({ SUPABASE_JWT_SECRET: "", SUPABASE_SECRET_KEY: "" });
  const r = await call("/access/session", { token: await accessJwt(access.pair.privateKey, "access-key-1", claims(ADMIN)) });
  const b = await r.json();
  ok("missing settings: 500 naming them, before any Access or Supabase call", r.status === 500 && b.error === "not_configured" && /SUPABASE_SECRET_KEY/.test(b.message) && /SUPABASE_JWT_SECRET or SUPABASE_SIGNING_JWK/.test(b.message), b);
}
{
  const { call } = harness();
  ok("only GET", (await call("/access/session", { method: "POST" })).status === 405);
  ok("other /access/ addresses are 404", (await call("/access/other")).status === 404);
}

// ---------- the asymmetric signing key ----------
{
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ecJwk = { ...(await crypto.subtle.exportKey("jwk", ec.privateKey)), kid: "made-up-ec-kid" };
  const m = await mintToken({ SUPABASE_URL: SB, SUPABASE_SIGNING_JWK: JSON.stringify(ecJwk), SUPABASE_JWT_SECRET: JWT_SECRET }, { id: "00000000-0000-4000-8000-000000000001", email: "a@example.com", role: "reader" }, NOW);
  const j = decodeJwt(m.token);
  ok("ES256: the key's kid in the header, preferred over the legacy secret", j.header.alg === "ES256" && j.header.kid === "made-up-ec-kid", j.header);
  ok("ES256: a 64-byte signature that verifies with the public key", j.signature.length === 64 && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey, j.signature, j.signed));
  const rs = await rsaPair("made-up-rs-kid");
  const m2 = await mintToken({ SUPABASE_URL: SB, SUPABASE_SIGNING_JWK: JSON.stringify(rs.priv) }, { id: "00000000-0000-4000-8000-000000000001", email: "a@example.com", role: "corpdev" }, NOW);
  const j2 = decodeJwt(m2.token);
  ok("RS256: kid in the header and the signature verifies", j2.header.alg === "RS256" && j2.header.kid === "made-up-rs-kid" && await crypto.subtle.verify("RSASSA-PKCS1-v1_5", rs.pair.publicKey, j2.signature, j2.signed));
  let err = null;
  try { await mintToken({ SUPABASE_URL: SB, SUPABASE_SIGNING_JWK: JSON.stringify({ kty: "EC", crv: "P-256", x: ecJwk.x, y: ecJwk.y, kid: "pub-only" }) }, { id: "x", email: "a@example.com", role: "reader" }, NOW); } catch (e) { err = e; }
  ok("a public key alone is refused with a reason", err instanceof BridgeError && /private key/.test(err.message));
}

// ---------- the page's settings ----------
{
  const { call } = harness();
  const r = await call("/config.js");
  const text = await r.text();
  ok("config.js is JavaScript and not cached", /javascript/.test(r.headers.get("content-type")) && r.headers.get("cache-control") === "no-store");
  const cfg = (() => { const window = {}; new Function("window", text)(window); return window.SNL_CONFIG; })();
  ok("it switches the page to Access sign-in", cfg.accessLogin === true && cfg.accessSessionUrl === "/access/session" && cfg.logoutUrl === "/cdn-cgi/access/logout", cfg);
  ok("it carries the Supabase address and publishable key, and the org name", cfg.supabaseUrl === SB && cfg.supabaseAnonKey === "sb_publishable_made_up" && cfg.orgName === "Made-up Insurance Group", cfg);
  ok("it never carries a secret", !text.includes(SECRET_KEY) && !text.includes(JWT_SECRET) && !text.includes(ADMIN) && !text.includes(AUD));
  ok("a secret key put in the publishable key's place is not served", JSON.parse(configScript({ SUPABASE_PUBLISHABLE_KEY: "sb_secret_oops" }).replace(/^window\.SNL_CONFIG = |;\n$/g, "")).supabaseAnonKey === "");
}
{
  const { worker, env } = harness();
  const seen = [];
  env.ASSETS = { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response("<!doctype html>site", { headers: { "content-type": "text/html" } }); } };
  const r = await worker.fetch(new Request("https://snl-lookup.made-up.workers.dev/index.html"), env);
  ok("everything else is the site's static files", (await r.text()) === "<!doctype html>site" && JSON.stringify(seen) === JSON.stringify(["/index.html"]));
}

// ---------- the committed Worker settings name nothing about the deployment ----------
{
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../../cloudflare/wrangler.toml", import.meta.url), "utf8");
  ok("wrangler.toml has no [vars], emails or keys", !/\[vars\]/.test(toml) && !/@[a-z0-9-]+\.[a-z]/i.test(toml.replace(/wrangler@[\d.]+/g, "")) && !/sb_(secret|publishable)_/.test(toml));
  ok("the Worker runs first only for its own two addresses", /run_worker_first\s*=\s*\["\/config\.js",\s*"\/access\/\*"\]/.test(toml));
  // The Workers runtime refuses to start when the entry module exports anything but handlers (seen with wrangler dev).
  const entry = await import("../../cloudflare/worker.js");
  ok("the entry module exports only the handler", JSON.stringify(Object.keys(entry)) === JSON.stringify(["default"]) && typeof entry.default.fetch === "function");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
