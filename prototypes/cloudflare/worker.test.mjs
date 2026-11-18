// PROTOTYPE ONLY. Checks prototypes/cloudflare/worker.js with fake Access keys and a fake Supabase.
// Run: node prototypes/cloudflare/worker.test.mjs   (Node 22, no packages). Not part of npm test.

import { makeWorker, decodeJwt, b64url } from "./worker.js";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`); } };

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const enc = new TextEncoder();
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const TEAM = "https://made-up-team.cloudflareaccess.com";
const AUD = "made-up-aud-tag";
const SB = "https://madeupref.supabase.co";
const USER_ID = "11111111-2222-4333-8444-555555555555";

async function rsa(kid) {
  const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey), pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, priv: { ...priv, kid }, pub: { kty: "RSA", n: pub.n, e: pub.e, kid, alg: "RS256", use: "sig" } };
}
async function sign(key, kid, payload) {
  const h = b64url.encode(enc.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
  const p = b64url.encode(enc.encode(JSON.stringify(payload)));
  return `${h}.${p}.${b64url.encode(await crypto.subtle.sign(ALG, key, enc.encode(`${h}.${p}`)))}`;
}

const access = await rsa("access-1"), stranger = await rsa("access-1"), broker = await rsa("broker-1");
const t = Math.floor(NOW / 1000);
const good = { iss: TEAM, aud: [AUD], email: "Analyst@Example.com", sub: "access-user-1", iat: t - 10, exp: t + 3600 };

const calls = [];
const fetchFn = async (input, init = {}) => {
  const url = String(input);
  if (url === `${TEAM}/cdn-cgi/access/certs`) { calls.push({ url }); return Response.json({ keys: [access.pub] }); }
  if (url.startsWith(SB)) {
    const body = init.body ? await new Response(init.body).text() : null;
    calls.push({ url, method: init.method, headers: new Headers(init.headers), body });
    return new Response("streamed-document-bytes", { status: 200, headers: { "content-type": "application/pdf", "set-cookie": "x=1" } });
  }
  return new Response("unexpected", { status: 599 });
};
const profiles = new Map([["email:analyst@example.com", JSON.stringify({ id: USER_ID, role: "corpdev" })]]);
const env = {
  TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_made_up",
  ISSUER: "https://broker.example.workers.dev", SIGNING_JWK: JSON.stringify(broker.priv),
  PROFILES: { get: async (k, type) => (profiles.has(k) ? (type === "json" ? JSON.parse(profiles.get(k)) : profiles.get(k)) : null) },
};
const worker = makeWorker({ fetchFn, now: () => NOW });
const call = (path, { token, method = "POST", body, headers = {} } = {}) =>
  worker.fetch(new Request(`https://app.example.workers.dev${path}`, { method, body, headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...headers } }), env);

// Refusals
let r = await call("/sb/functions/v1/snl-filings");
check("no Access token is 401", r.status === 401);
r = await call("/sb/functions/v1/snl-filings", { token: await sign(access.pair.privateKey, "access-1", { ...good, aud: ["other-app"] }) });
check("token for another application is 403", r.status === 403);
r = await call("/sb/functions/v1/snl-filings", { token: await sign(access.pair.privateKey, "access-1", { ...good, iss: "https://other.cloudflareaccess.com" }) });
check("token from another team is 403", r.status === 403);
r = await call("/sb/functions/v1/snl-filings", { token: await sign(access.pair.privateKey, "access-1", { ...good, exp: t - 3600 }) });
check("expired token is 401", r.status === 401);
r = await call("/sb/functions/v1/snl-filings", { token: await sign(stranger.pair.privateKey, "access-1", good) });
check("token signed by someone else's key is 401", r.status === 401);
r = await call("/sb/functions/v1/snl-filings", { token: await sign(access.pair.privateKey, "access-1", { ...good, email: "nobody@example.com" }) });
check("email with no profile is 403", r.status === 403 && (await r.json()).error === "no_profile");
r = await call("/sb/auth/v1/token", { token: await sign(access.pair.privateKey, "access-1", good) });
check("Supabase Auth is never forwarded", r.status === 404);
check("no refused request reached Supabase", !calls.some((c) => c.url.startsWith(SB)));

// A good call is forwarded with a minted token and stripped headers, and the answer streams back
const accessToken = await sign(access.pair.privateKey, "access-1", good);
r = await call("/sb/functions/v1/snl-filings?x=1", { token: accessToken, body: JSON.stringify({ action: "status" }), headers: { cookie: "CF_Authorization=secret", authorization: "Bearer forged", "content-type": "application/json" } });
check("good call is 200", r.status === 200, String(r.status));
check("answer body passes through", (await r.text()) === "streamed-document-bytes");
check("set-cookie from Supabase is dropped", !r.headers.get("set-cookie"));
const sent = calls.filter((c) => c.url.startsWith(SB)).at(-1);
check("path and query rewritten to Supabase", sent?.url === `${SB}/functions/v1/snl-filings?x=1`, sent?.url);
check("body forwarded", sent?.body === JSON.stringify({ action: "status" }));
check("Access token and cookie not forwarded", !sent.headers.get("cf-access-jwt-assertion") && !sent.headers.get("cookie"));
check("publishable key sent as apikey", sent.headers.get("apikey") === "sb_publishable_made_up");
const minted = decodeJwt(sent.headers.get("authorization").replace(/^Bearer /, ""));
check("browser's own Authorization replaced", minted !== null);
check("minted sub is the existing auth.users id", minted.payload.sub === USER_ID);
check("minted role is authenticated, app role carried", minted.payload.role === "authenticated" && minted.payload.app_role === "corpdev");
check("minted issuer and lifetime", minted.payload.iss === env.ISSUER && minted.payload.exp - minted.payload.iat === 300);
check("email lower-cased", minted.payload.email === "analyst@example.com");

// The published keys verify the minted token, as Supabase would
const disc = await (await call("/.well-known/openid-configuration", { method: "GET" })).json();
check("discovery names the issuer and its keys", disc.issuer === env.ISSUER && disc.jwks_uri === `${env.ISSUER}/.well-known/jwks.json`);
const jwks = await (await call("/.well-known/jwks.json", { method: "GET" })).json();
check("JWKS publishes no private parts", jwks.keys.length === 1 && !("d" in jwks.keys[0]) && jwks.keys[0].kid === "broker-1");
const pub = await crypto.subtle.importKey("jwk", jwks.keys[0], ALG, false, ["verify"]);
check("minted token verifies against the published key", await crypto.subtle.verify(ALG, pub, minted.signature, minted.signed));
check("minted token header names the key", minted.header.kid === "broker-1" && minted.header.alg === "RS256");

// Access certs are fetched once and reused
await call("/sb/rest/v1/snl_store?select=id", { token: accessToken, method: "GET" });
check("Access keys cached", calls.filter((c) => c.url.endsWith("/cdn-cgi/access/certs")).length === 1);
check("GET forwarded without a body", calls.at(-1).method === "GET" && calls.at(-1).body === null);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
