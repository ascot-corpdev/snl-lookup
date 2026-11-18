// The site's Cloudflare Worker (worker/index.js), run under Node with a stand-in for the static files and for every
// outside call. It must fail closed in every way, serve the site only to a valid Cloudflare Access sign-in, write
// config.js safely, and pass only the Access token on to snl-signin. Every name, address and key is made up.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWorker, configScript, settingsProblem, teamHost, TEXT } from "../../worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };

// ---- a made-up Access team: keys made here, tokens signed as Access signs them
const TEAM = "team.example.cloudflareaccess.com", AUD = "aud-calloway-0001", NOW = Date.parse("2026-11-13T12:00:00Z");
const b64u = (b) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");
const newPair = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const keys = [{ kid: "kid-1", pair: await newPair() }], published = new Set(["kid-1"]);
async function token({ kid = "kid-1", claims = {}, header = {}, drop = [], pair } = {}) {
  const s = Math.floor(clock.now / 1000);
  const c = { aud: [AUD], email: "jane.doe@calloway.example", exp: s + 3600, iat: s, nbf: s, iss: `https://${TEAM}`, type: "app", sub: "made-up-sub", ...claims };
  for (const d of drop) delete c[d];
  const head = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header })) + "." + b64u(JSON.stringify(c));
  const k = pair ?? keys.find((x) => x.kid === kid).pair;
  return head + "." + b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.privateKey, new TextEncoder().encode(head)));
}

// ---- stand-ins: the clock, every outside call, and the static files
const clock = { now: NOW };
const calls = [];
let certsDown = false, fnAnswer = null;
const SB = "https://a.supabase.co";
async function fakeFetch(input, init = {}) {
  const r = input instanceof Request ? input : new Request(String(input), init);
  const body = r.method === "POST" ? await r.text() : null;
  calls.push({ url: r.url, method: r.method, headers: Object.fromEntries(r.headers), body });
  if (r.url === `https://${TEAM}/cdn-cgi/access/certs`) {
    if (certsDown) return new Response("down", { status: 502 });
    const out = [];
    for (const k of keys.filter((x) => published.has(x.kid))) { const j = await crypto.subtle.exportKey("jwk", k.pair.publicKey); out.push({ kid: k.kid, kty: "RSA", alg: "RS256", use: "sig", e: j.e, n: j.n }); }
    return Response.json({ keys: out });
  }
  if (r.url === `${SB}/functions/v1/snl-signin`) {
    if (fnAnswer instanceof Error) throw fnAnswer;
    const a = fnAnswer ?? { status: 200, body: { accessToken: "access-made-up", expiresAt: 1, expiresIn: 3600, refresh_token: "refresh-SECRET", refreshToken: "refresh-SECRET", extra: "x", profile: { id: "u1", email: "jane.doe@calloway.example", username: "jane.doe", displayName: "Jane Doe", role: "reader", secret: "x" } } };
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }
  throw new Error("unexpected fetch " + r.url);
}
const assetCalls = [];
const ASSETS = { async fetch(req) { assetCalls.push(new URL(req.url).pathname); return new Response("<!doctype html><title>SNL lookup</title>", { headers: { "content-type": "text/html", "cache-control": "public, max-age=0, must-revalidate", etag: '"abc"' } }); } };
const ENV = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_made_up", ORG_NAME: "Calloway Group", ASSETS };
let worker = createWorker({ fetch: fakeFetch, now: () => clock.now });
const go = async (path, { method = "GET", tok, headers = {}, env = ENV, body } = {}) => {
  const h = { ...headers }; if (tok) h["Cf-Access-Jwt-Assertion"] = tok;
  const res = await worker.fetch(new Request("https://snl-lookup.calloway.workers.dev" + path, { method, headers: h, body }), env);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, status: res.status, text, json, h: (k) => res.headers.get(k) };
};

// ---- the configuration file
const toml = readFileSync(join(here, "../../wrangler.toml"), "utf8");
ok("wrangler.toml: the Worker runs before every request, and serves web/ through the ASSETS binding", /\[assets\][^[]*directory = "\.\/web"/.test(toml) && /binding = "ASSETS"/.test(toml) && /run_worker_first = true/.test(toml) && /main = "worker\/index\.js"/.test(toml));
ok("wrangler.toml: Version URLs off, dashboard variables kept on deploy, and no settings written in it", /preview_urls = false/.test(toml) && /keep_vars = true/.test(toml) && !/\[vars\]/.test(toml) && !/supabase\.co|cloudflareaccess\.com\b(?!\s*\()/.test(toml.replace(/<team>\.cloudflareaccess\.com/g, "")));

// ---- fails closed
const good = await token();
for (const [label, env] of [["no settings", { ASSETS }], ["no audience", { ...ENV, POLICY_AUD: "" }], ["no team domain", { ...ENV, TEAM_DOMAIN: "" }], ["a team domain that isn't a host name", { ...ENV, TEAM_DOMAIN: "team example" }], ["an audience of only commas", { ...ENV, POLICY_AUD: " , " }]]) {
  const r = await go("/", { tok: good, env });
  ok(`${label}: 403, a short plain page, nothing served and nothing fetched`, r.status === 403 && /Not set up yet/.test(r.text) && r.text.includes("TEAM_DOMAIN and POLICY_AUD") && assetCalls.length === 0 && calls.length === 0 && r.h("content-type").startsWith("text/html") && r.h("cache-control") === "no-store", { status: r.status, text: r.text });
}
// ---- the team domain however it was pasted, and a page that names the setting at fault
ok("team domain: a pasted sign-in address, quotes or the team name alone all come to the bare host", teamHost("https://team.cloudflareaccess.com/cdn-cgi/access/login/x?y=1") === "team.cloudflareaccess.com" && teamHost('"team.cloudflareaccess.com"') === "team.cloudflareaccess.com" && teamHost("my-team") === "my-team.cloudflareaccess.com" && teamHost("team example") === null && teamHost("http://team.example") === null && teamHost("team.example:8443") === null);
ok("which setting is at fault: missing, malformed, or the audience; never the value", settingsProblem({}) === "TEAM_DOMAIN is missing. POLICY_AUD is missing." && settingsProblem({ TEAM_DOMAIN: "team example", POLICY_AUD: "a" }) === "TEAM_DOMAIN is set, but it isn't a team domain. It should look like your-team.cloudflareaccess.com." && settingsProblem({ TEAM_DOMAIN: "team.example", POLICY_AUD: " , " }) === "POLICY_AUD is missing." && settingsProblem({ TEAM_DOMAIN: "team.example", POLICY_AUD: "a" }) === "");
{
  const r = await go("/", { tok: good, env: { ...ENV, TEAM_DOMAIN: "team example secret-looking" } });
  ok("a malformed team domain: the page says so and how it should look, without showing the value", r.status === 403 && r.text.includes("TEAM_DOMAIN is set, but it isn&#39;t a team domain. It should look like your-team.cloudflareaccess.com.") && !r.text.includes("secret-looking"), r.text);
  const j = await go("/auth/session", { tok: good, env: { ...ENV, POLICY_AUD: "" }, method: "POST" });
  ok("a missing audience on /auth/session: JSON, 403, names POLICY_AUD", j.status === 403 && /POLICY_AUD is missing\./.test(j.text) && /not_configured/.test(j.text), j.text);
}
const before = calls.length;
const refused = [
  ["no token (Access switched off)", undefined], ["an empty token", ""], ["garbage", "not-a-token"], ["two parts", "a.b"], ["four parts", good + ".x"],
  ["a token over 16 KB", "a".repeat(17000)], ["an expired token", await token({ claims: { exp: Math.floor(NOW / 1000) - 1 } })],
  ["a token not valid yet", await token({ claims: { nbf: Math.floor(NOW / 1000) + 600 } })], ["a token for another application", await token({ claims: { aud: ["aud-other"] } })],
  ["a token from another team", await token({ claims: { iss: "https://other.cloudflareaccess.com" } })], ["a token with no exp", await token({ drop: ["exp"] })],
  ["alg none", await token({ header: { alg: "none" } })], ["HS256", await token({ header: { alg: "HS256" } })], ["a token with no key id", await token({ header: { kid: undefined } })],
  ["a tampered payload", (() => { const [h, , s] = good.split("."); return `${h}.${b64u(JSON.stringify({ aud: [AUD], email: "owner@calloway.example", exp: 9999999999, iss: `https://${TEAM}` }))}.${s}`; })()],
  ["a signature from another key", await token({ pair: await newPair() })], ["an unknown key id", await token({ kid: "kid-1", header: { kid: "kid-unknown" } })],
];
for (const [label, tok] of refused) {
  const r = await go("/index.html", { tok });
  ok(`${label}: 403 with the plain sign-in page, and nothing served`, r.status === 403 && r.text.includes("You need to sign in through Cloudflare") && assetCalls.length === 0, { status: r.status, text: r.text.slice(0, 200) });
}
ok("checks that fail on the token's own fields never fetch Cloudflare's keys", calls.slice(before).every((c) => c.url.endsWith("/cdn-cgi/access/certs")) && calls.slice(before).length <= 2, calls.slice(before).map((c) => c.url));
for (const p of ["/config.js", "/auth/signout"]) {
  const r = await go(p, {});
  ok(`${p} without a sign-in is refused too`, r.status === 403 && !r.text.includes("SNL_CONFIG") && !r.h("location"));
}
const apiRefused = await go("/auth/session", { method: "POST" });
ok("/auth/session without a sign-in: 403 in JSON, and snl-signin is never called", apiRefused.status === 403 && apiRefused.json?.error === "signin" && !calls.some((c) => c.url.includes("snl-signin")));

// ---- the keys: fetched once, fetched again for a new key, unreachable means closed
worker = createWorker({ fetch: fakeFetch, now: () => clock.now }); calls.length = 0;
await go("/", { tok: good }); await go("/", { tok: good }); await go("/", { tok: good });
ok("Cloudflare's keys are fetched once and reused", calls.filter((c) => c.url.endsWith("/certs")).length === 1);
keys.push({ kid: "kid-2", pair: await newPair() });
const t2 = await token({ kid: "kid-2" });
ok("a token signed by a key not yet published is refused", (await go("/", { tok: t2 })).status === 403);
published.add("kid-2"); clock.now += 11_000;
const rotated = await go("/", { tok: await token({ kid: "kid-2" }) });
ok("after Cloudflare rotates its keys, the new key is fetched and works", rotated.status === 200 && calls.filter((c) => c.url.endsWith("/certs")).length === 2, { status: rotated.status, certs: calls.filter((c) => c.url.endsWith("/certs")).length });
clock.now = NOW;
worker = createWorker({ fetch: fakeFetch, now: () => clock.now }); certsDown = true; assetCalls.length = 0;
const down = await go("/", { tok: good });
ok("when Cloudflare's keys can't be fetched: 503, a plain page, nothing served", down.status === 503 && down.text.includes("couldn&#39;t be reached") && assetCalls.length === 0, { status: down.status, assets: assetCalls });
const downApi = await go("/auth/session", { method: "POST", tok: good });
ok("... and /auth/session answers 503 in JSON without calling snl-signin", downApi.status === 503 && downApi.json?.error === "unavailable" && !calls.some((c) => c.url.includes("snl-signin")));
certsDown = false;
const throwing = createWorker({ fetch: async () => { throw new TypeError("network down"); }, now: () => clock.now });
ok("a network failure fetching the keys serves nothing", (await throwing.fetch(new Request("https://snl-lookup.calloway.workers.dev/", { headers: { "Cf-Access-Jwt-Assertion": good } }), ENV)).status === 503);
worker = createWorker({ fetch: fakeFetch, now: () => clock.now });

// ---- signed in: the site
assetCalls.length = 0;
const home = await go("/", { tok: good });
ok("signed in: the page is served from the static files", home.status === 200 && home.text.includes("<title>SNL lookup</title>") && JSON.stringify(assetCalls) === '["/"]');
ok("signed in: no shared cache may keep it, and the browser checks for a newer copy", home.h("cache-control") === "private, no-cache" && home.h("etag") === '"abc"');
ok("signed in: it can't be framed or sniffed, and sends no referrer elsewhere", home.h("x-frame-options") === "DENY" && home.h("x-content-type-options") === "nosniff" && home.h("referrer-policy") === "same-origin");
ok("signed in: a POST to a page is refused", (await go("/", { tok: good, method: "POST", body: "x" })).status === 405);
ok("an address under /auth/ that isn't a route is 404, not a file", (await go("/auth/other", { tok: good })).status === 404 && assetCalls.length === 1);
const noAssets = await go("/", { tok: good, env: { ...ENV, ASSETS: undefined } });
ok("without the static files attached: a plain page, not a crash", noAssets.status === 503 && noAssets.text.includes("files aren&#39;t attached"));

// ---- /config.js
const cfg = await go("/config.js", { tok: good });
const run = (src) => { const w = {}; new Function("window", src)(w); return w.SNL_CONFIG; };
ok("/config.js: written from the Worker's settings, with the Cloudflare sign-on marker", cfg.status === 200 && JSON.stringify(run(cfg.text)) === JSON.stringify({ supabaseUrl: SB, supabaseAnonKey: "sb_publishable_made_up", orgName: "Calloway Group", signOn: "cloudflare" }) && assetCalls.length === 1, cfg.text);
ok("/config.js: a script, never cached", cfg.h("content-type") === "application/javascript; charset=utf-8" && cfg.h("cache-control") === "no-store");
const hostile = configScript({ SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x"};alert(1);//', ORG_NAME: '</script><script>alert(1)</script>\u2028x"\\' });
ok("/config.js: hostile values can't break out of the string or the script", !hostile.includes("</script") && !hostile.includes("<") && !/\u2028/.test(hostile) && run(hostile).orgName === '</script><script>alert(1)</script>\u2028x"\\' && run(hostile).supabaseAnonKey === 'sb_publishable_x"};alert(1);//' && hostile.split("\n").filter(Boolean).length === 1, hostile);
ok("/config.js: the address is trimmed to the project's own (as the GitHub workflow does)", run(configScript({ SUPABASE_URL: " https://a.supabase.co/rest/v1/ " })).supabaseUrl === SB && run(configScript({ SUPABASE_URL: "https://a.supabase.co/auth/v1" })).supabaseUrl === SB);
ok("/config.js: an address that isn't plain https is left blank", ["http://a.supabase.co", "javascript:alert(1)", "https://a.supabase.co/x", "https://a.supabase.co/?x=1", "https://u:p@a.supabase.co", "not a url"].every((u) => run(configScript({ SUPABASE_URL: u })).supabaseUrl === ""));
const secret = run(configScript({ SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: "sb_secret_made_up" }));
ok("/config.js: a secret key set by mistake is never served, and the page is told why", secret.supabaseAnonKey === "" && secret.configProblem === "secret_key");
ok("/config.js: missing settings give blanks, with the marker still there", JSON.stringify(run(configScript({}))) === JSON.stringify({ supabaseUrl: "", supabaseAnonKey: "", orgName: "", signOn: "cloudflare" }));

// ---- /auth/session
calls.length = 0;
const s = await go("/auth/session", { method: "POST", tok: good, headers: { Cookie: "CF_Authorization=made-up-cookie; other=1", Authorization: "Bearer someone-else", "X-Forwarded-For": "203.0.113.9", "User-Agent": "made-up" }, body: JSON.stringify({ action: "session", email: "owner@calloway.example" }) });
const sent = calls.find((c) => c.url.includes("snl-signin"));
ok("/auth/session: calls snl-signin on the project's own address", sent?.url === `${SB}/functions/v1/snl-signin` && sent.method === "POST");
ok("/auth/session: passes on only the Access token, the publishable key and the content type", JSON.stringify(Object.keys(sent.headers).sort()) === '["apikey","cf-access-jwt-assertion","content-type"]' && sent.headers["cf-access-jwt-assertion"] === good && sent.headers.apikey === "sb_publishable_made_up", sent.headers);
ok("/auth/session: nothing the browser sent in the body goes on", sent.body === '{"action":"session"}');
ok("/auth/session: answers only the token, its expiry and the profile (no refresh token, nothing extra)", s.status === 200 && JSON.stringify(s.json) === JSON.stringify({ accessToken: "access-made-up", expiresAt: 1, expiresIn: 3600, profile: { id: "u1", email: "jane.doe@calloway.example", username: "jane.doe", displayName: "Jane Doe", role: "reader" } }) && !s.text.includes("refresh") && !s.text.includes("secret"), s.json);
ok("/auth/session: never cached", s.h("cache-control") === "no-store");
ok("/auth/session: only POST", (await go("/auth/session", { tok: good })).status === 405);
for (const [label, answer, status, error] of [
  ["sign-in not set up on Supabase", { status: 503, body: { error: "not_configured", message: "Cloudflare let you in, but sign-in isn't set up on Supabase yet." } }, 503, "not_configured"],
  ["the function refuses the token", { status: 401, body: { error: "signin", message: "Your Cloudflare sign-in couldn't be confirmed." } }, 401, "signin"],
  ["a Supabase failure", { status: 500, body: { error: "server", message: "Your session couldn't be started." } }, 500, "server"],
]) {
  fnAnswer = answer;
  const r = await go("/auth/session", { method: "POST", tok: good });
  ok(`/auth/session: ${label} is passed on with its plain message`, r.status === status && r.json?.error === error && r.json?.message === answer.body.message, r.json);
}
fnAnswer = { status: 404, body: "" };
ok("/auth/session: snl-signin not deployed says the site isn't set up yet", (await go("/auth/session", { method: "POST", tok: good })).json?.error === "not_configured");
fnAnswer = { status: 200, body: "<html>oops</html>" };
ok("/auth/session: an answer that isn't JSON is 'can't be reached', not passed on", (await go("/auth/session", { method: "POST", tok: good })).json?.message === TEXT.unreachable);
fnAnswer = { status: 200, body: { hello: "there" } };
ok("/auth/session: a 200 without a token is not passed on as a session", (await go("/auth/session", { method: "POST", tok: good })).status === 502);
fnAnswer = new TypeError("fetch failed");
const unreachable = await go("/auth/session", { method: "POST", tok: good });
ok("/auth/session: Supabase unreachable gives 502 and a plain message", unreachable.status === 502 && unreachable.json?.error === "unreachable" && unreachable.json.message === TEXT.unreachable);
fnAnswer = null; calls.length = 0;
const noSb = await go("/auth/session", { method: "POST", tok: good, env: { ...ENV, SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" } });
ok("/auth/session: without the Supabase settings, 'not set up yet' and no call", noSb.status === 503 && noSb.json?.error === "not_configured" && /Cloudflare let you in, but the site isn't set up yet/.test(noSb.json.message) && !calls.some((c) => c.url.includes("snl-signin")));
const secretKey = await go("/auth/session", { method: "POST", tok: good, env: { ...ENV, SUPABASE_PUBLISHABLE_KEY: "sb_secret_made_up" } });
ok("/auth/session: a secret key set by mistake is never sent anywhere", secretKey.status === 503 && !calls.some((c) => JSON.stringify(c.headers).includes("sb_secret")));

// ---- sign out
const out = await go("/auth/signout", { tok: good });
ok("/auth/signout: sends the browser to Access's own logout address", out.status === 302 && out.h("location") === "/cdn-cgi/access/logout" && out.h("cache-control") === "no-store");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
