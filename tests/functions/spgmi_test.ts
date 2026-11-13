// S&P's Physical Documents API client (supabase/functions/_shared/spgmi.ts): sign-in, the token cache, a new
// token once after a 401, backing off once after a 429, the plain message for each S&P error, and the gate that
// spaces calls a second apart and stops at the hourly and daily limits. Every call goes to a stand-in.
import { explain, forgetTokens, makeGate, NOT_CONFIGURED, PLAN_LIMITS, planLimits, Spgmi, SpgmiError, TOKEN_URL, DOC_TYPE, DOCS_BASE } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, env, fakeClock, fakeSpgmi, J, memoryDb } from "./helpers/fakes.ts";
import { spError, spPage, spStub } from "./helpers/more.ts";

const { ok, done } = checks();
const CREDS = { username: "api-user", password: "api-pass" };
const caught = async (p: Promise<unknown>): Promise<any> => { try { await p; return null; } catch (e) { return e; } };

/** A client on a fresh clock, database and gate. */
function setup(answer: Parameters<typeof spStub>[1], opts: { creds?: { username?: string; password?: string }; token?: (n: number) => Response; limits?: { hour: number; day: number }; backoffMs?: number } = {}) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = spStub(clock, answer, { token: opts.token });
  const api = new Spgmi(opts.creds ?? CREDS, { fetch: sp.fetch, gate: makeGate(db, opts.limits ?? PLAN_LIMITS.trial, clock.sleep), sleep: clock.sleep, backoffMs: opts.backoffMs });
  return { clock, db, sp, api };
}
const fine = () => J(spPage([]));

// ---------- sign-in ----------
{
  const { sp, api } = setup(fine, { creds: { username: "api user+1@example.test", password: "p&ss=w rd/+%" } });
  await api.json("GET", "/api/v1/reference", { query: { referenceField: "filingStatus" } });
  const t = sp.log[0];
  ok("sign-in is a POST to S&P's token address", TOKEN_URL === "https://api-ciq.marketintelligence.spglobal.com/gdsapi/rest/authenticate/api/v1/token" && t.path === "token" && t.method === "POST", t);
  ok("sign-in is sent as a form", t.contentType === "application/x-www-form-urlencoded", t.contentType);
  ok("the form carries exactly username and password, with awkward characters intact", JSON.stringify(t.body) === JSON.stringify({ username: "api user+1@example.test", password: "p&ss=w rd/+%" }) && /^username=[^&]+&password=[^&]+$/.test(t.raw), t.raw);
  ok("sign-in carries no bearer token", t.auth === null, t.auth);
  const d = sp.log[1];
  ok("the token from access_token is sent as a bearer token", d.auth === "Bearer stub-1", d.auth);
  ok("the documents call goes to /gds/documents with docType as a query parameter", DOCS_BASE.endsWith("/gds/documents") && d.path === "/api/v1/reference" && d.query.docType === "INSPRODFILINGS_DOCUMENTS_API" && DOC_TYPE === "INSPRODFILINGS_DOCUMENTS_API" && d.query.referenceField === "filingStatus", d);
  ok("a GET sends no body and no JSON content type", d.method === "GET" && d.raw === "" && d.contentType === null, d);
  await api.json("POST", "/api/v1/search", { body: { properties: { companyId: [9100001] } } });
  const s = sp.log[2];
  ok("a POST sends JSON, with docType still on the address", s.method === "POST" && s.contentType === "application/json" && s.query.docType === DOC_TYPE && s.body.properties.companyId[0] === 9100001 && !Array.isArray(s.body.properties), s);
  ok("the token is kept: a second call doesn't sign in again", sp.tokens === 1 && sp.log.length === 3, sp.log.map((c) => c.path));
  // another client object (the next function call on a warm instance) with the same username
  const clock2 = fakeClock(), db2 = memoryDb(clock2);
  const again = new Spgmi({ username: "api user+1@example.test", password: "p&ss=w rd/+%" }, { fetch: sp.fetch, gate: makeGate(db2, PLAN_LIMITS.trial, clock2.sleep), sleep: clock2.sleep });
  await again.json("GET", "/api/v1/reference");
  ok("a later function call on the same instance reuses the token", sp.tokens === 1 && sp.log.at(-1)!.auth === "Bearer stub-1", sp.tokens);
  const other = new Spgmi({ username: "second-user", password: "x" }, { fetch: sp.fetch, gate: makeGate(db2, PLAN_LIMITS.trial, clock2.sleep), sleep: clock2.sleep });
  await other.json("GET", "/api/v1/reference");
  ok("a different username signs in for its own token", sp.tokens === 2 && sp.log.at(-1)!.auth === "Bearer stub-2", sp.tokens);
  forgetTokens();
  await again.json("GET", "/api/v1/reference");
  ok("forgetting the tokens makes the next call sign in", sp.tokens === 3);
}
{
  for (const [name, creds] of [["no username", { password: "x" }], ["no password", { username: "x" }], ["neither", {}], ["blank values", { username: "", password: "" }]] as const) {
    const { sp, api, db } = setup(fine, { creds });
    const e = await caught(api.call("GET", "/api/v1/reference"));
    ok(`with ${name} the client says S&P isn't set up and calls nothing`, e instanceof SpgmiError && e.code === "not_configured" && e.message === NOT_CONFIGURED && sp.log.length === 0 && db.slots.length === 0, { code: e?.code, calls: sp.log.length });
  }
  ok("configured means both a username and a password", Spgmi.configured(CREDS) && !Spgmi.configured({ username: "a" }) && !Spgmi.configured({ password: "b" }) && !Spgmi.configured({}));
  const c = Spgmi.creds(env({ SPGMI_API_USERNAME: "u1", SPGMI_API_PASSWORD: "p1" }));
  ok("the credentials come from SPGMI_API_USERNAME and SPGMI_API_PASSWORD", c.username === "u1" && c.password === "p1", c);
  ok("the not-set-up message names the two secrets and says saved results still open", NOT_CONFIGURED.includes("SPGMI_API_USERNAME") && NOT_CONFIGURED.includes("SPGMI_API_PASSWORD") && NOT_CONFIGURED.includes("Saved results still open"));
}
{
  for (const status of [401, 400]) {
    const { sp, api } = setup(fine, { token: () => spError(status, "Invalid credentials.", "req-signin-9") });
    const e = await caught(api.call("GET", "/api/v1/reference"));
    ok(`a sign-in refused with ${status} is a plain sign-in failure with S&P's reference`, e instanceof SpgmiError && e.code === "signin" && e.message.includes("SPGMI_API_USERNAME") && e.message.includes("S&P reference: req-signin-9.") && e.requestId === "req-signin-9", e?.message);
    ok(`after a refused sign-in (${status}) no documents call is made and it isn't retried`, sp.tokens === 1 && sp.data === 0, sp.log.map((c) => c.path));
  }
  let r = setup(fine, { token: () => J({ token_type: "Bearer" }) });
  let e = await caught(r.api.call("GET", "/api/v1/reference"));
  ok("a sign-in answer with no access_token is a plain sign-in failure", e instanceof SpgmiError && e.code === "signin" && e.message.includes("without a token") && r.sp.data === 0, e?.message);
  r = setup(fine, { token: () => J({ access_token: "" }) });
  e = await caught(r.api.call("GET", "/api/v1/reference"));
  ok("an empty access_token is not used as a token", e instanceof SpgmiError && e.code === "signin" && r.sp.data === 0, e?.message);
  r = setup(fine, { token: () => J({ access_token: 12345 }) });
  e = await caught(r.api.call("GET", "/api/v1/reference"));
  ok("an access_token that isn't text is not used as a token", e instanceof SpgmiError && e.code === "signin" && r.sp.data === 0, e?.message);
  r = setup(fine, { token: () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }) });
  e = await caught(r.api.call("GET", "/api/v1/reference"));
  ok("a sign-in answer that isn't JSON is a plain sign-in failure", e instanceof SpgmiError && e.code === "signin", e?.message);
  r = setup(fine, { token: () => { throw new TypeError("connection reset"); } });
  e = await caught(r.api.call("GET", "/api/v1/reference"));
  ok("S&P unreachable at sign-in is a plain network failure", e instanceof SpgmiError && e.code === "network" && e.message === "Couldn't reach S&P to sign in. Try again in a few minutes." && !e.message.includes("connection reset"), e?.message);
  r = setup(fine, { token: () => spError(403, "Entitlement needed", "req-ent-1") });
  e = await caught(r.api.call("GET", "/api/v1/reference"));
  ok("a 403 at sign-in is the entitlement message", e instanceof SpgmiError && e.code === "entitlement" && e.requestId === "req-ent-1", e?.message);
  r = setup(fine, { token: () => new Response("upstream down", { status: 503 }) });
  e = await caught(r.api.call("GET", "/api/v1/reference"));
  ok("a 503 at sign-in is S&P's service failing, in plain words", e instanceof SpgmiError && e.code === "server" && e.message.includes("(503)") && e.requestId === null, e?.message);
}

// ---------- a new token once after a 401 ----------
{
  const { sp, api, db } = setup((_c, n) => (n === 1 ? spError(401, "Token is invalid or has expired.") : fine()));
  await api.json("GET", "/api/v1/reference");
  ok("a 401 gets a new token once and retries", sp.log.map((c) => c.path).join() === "token,/api/v1/reference,token,/api/v1/reference" && sp.log[1].auth === "Bearer stub-1" && sp.log[3].auth === "Bearer stub-2", sp.log.map((c) => [c.path, c.auth]));
  ok("the retry after a 401 repeats the same request", sp.log[3].method === sp.log[1].method && JSON.stringify(sp.log[3].query) === JSON.stringify(sp.log[1].query));
  ok("every attempt, sign-ins included, took a throttle slot", db.slots.length === 4 && (await db.usage()).hour === 4, db.slots);
  await api.json("GET", "/api/v1/reference");
  ok("the new token is kept for the next call", sp.tokens === 2 && sp.log.at(-1)!.auth === "Bearer stub-2");
}
{
  const { sp, api } = setup(() => spError(401, "Token is invalid or has expired.", "req-401-b"));
  const e = await caught(api.json("POST", "/api/v1/search", { body: { properties: {} } }));
  ok("a second 401 fails with the plain sign-in message", e instanceof SpgmiError && e.code === "signin" && e.status === 401 && e.message.startsWith("S&P didn't accept the API sign-in (401).") && e.message.includes("S&P reference: req-401-b."), e?.message);
  ok("a second 401 is not retried again: two sign-ins and two attempts in all", sp.tokens === 2 && sp.data === 2, sp.log.map((c) => c.path));
  ok("the sign-in message says a website login doesn't work", e.message.includes("A Capital IQ Pro website login doesn't work here."));
}
{
  // The saved token has expired on S&P's side between two calls (fixture-backed fake).
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock);
  const api = new Spgmi(CREDS, { fetch: sp.fetch, gate: makeGate(db, PLAN_LIMITS.trial, clock.sleep), sleep: clock.sleep });
  await api.json("GET", "/api/v1/reference", { query: { referenceField: "filingStatus" } });
  sp.expireTokens();
  const list = await api.json("GET", "/api/v1/reference", { query: { referenceField: "serffFilingType" } });
  ok("an expired token is replaced without the caller noticing", sp.tokens === 2 && (list.rows as unknown[]).length === 4 && sp.calls("/api/v1/reference").length === 3, { tokens: sp.tokens, calls: sp.log.map((c) => c.path) });
  ok("calls to S&P are at least a second apart, sign-ins included", sp.log.every((c, i) => i === 0 || c.at - sp.log[i - 1].at >= 1000), sp.log.map((c) => c.at - sp.log[0].at));
}
{
  // a 401, then the fresh sign-in itself is refused
  const { sp, api } = setup(() => spError(401, "expired"), { token: (n) => (n === 1 ? J({ access_token: "first" }) : spError(401, "Invalid credentials.", "req-relogin")) });
  const e = await caught(api.call("GET", "/api/v1/reference"));
  ok("when the new sign-in after a 401 is refused, the call fails with the sign-in message", e instanceof SpgmiError && e.code === "signin" && e.requestId === "req-relogin" && sp.tokens === 2 && sp.data === 1, { m: e?.message, tokens: sp.tokens, data: sp.data });
}

// ---------- 429: back off once ----------
{
  const tooMany = (headers: Record<string, string> = {}) => J({ status: 429, timestamp: "t", requestId: "req-429", error: "Too Many Requests", message: "Too many requests" }, 429, headers);
  let r = setup((_c, n) => (n === 1 ? tooMany({ "retry-after": "7" }) : fine()));
  await r.api.json("GET", "/api/v1/reference");
  ok("a 429 waits the Retry-After seconds S&P gives, then retries once", r.clock.slept.includes(7000) && r.sp.data === 2 && r.sp.tokens === 1, r.clock.slept);
  ok("the retry after a 429 takes its own throttle slot", r.db.slots.length === 3, r.db.slots);
  r = setup((_c, n) => (n === 1 ? tooMany() : fine()));
  await r.api.json("GET", "/api/v1/reference");
  ok("a 429 with no Retry-After waits 5 seconds", r.clock.slept.includes(5000) && r.sp.data === 2, r.clock.slept);
  r = setup((_c, n) => (n === 1 ? tooMany() : fine()), { backoffMs: 1234 });
  await r.api.json("GET", "/api/v1/reference");
  ok("the default wait can be set", r.clock.slept.includes(1234), r.clock.slept);
  for (const [value, want] of [["60", 60_000], ["1", 1000], ["0.5", 500], ["0", 5000], ["-3", 5000], ["61", 5000], ["86400", 5000], ["soon", 5000], ["Fri, 13 Nov 2026 12:30:00 GMT", 5000], ["", 5000]] as const) {
    r = setup((_c, n) => (n === 1 ? tooMany({ "retry-after": value }) : fine()));
    await r.api.json("GET", "/api/v1/reference");
    ok(`Retry-After "${value}" waits ${want / 1000} seconds`, r.clock.slept[1] === want && r.sp.data === 2, r.clock.slept);
  }
  r = setup(() => tooMany({ "retry-after": "2" }));
  const e = await caught(r.api.json("GET", "/api/v1/reference"));
  ok("a second 429 fails with a plain message and S&P's reference", e instanceof SpgmiError && e.code === "rate_limited" && e.status === 429 && e.message === "S&P says too many requests were sent (429). Wait a minute and try again. S&P reference: req-429.", e?.message);
  ok("a 429 is retried once only", r.sp.data === 2 && r.clock.slept.filter((ms) => ms === 2000).length === 1, { data: r.sp.data, slept: r.clock.slept });
  // a 429, then a 401 on the retry: each remedy is still available once
  r = setup((_c, n) => (n === 1 ? tooMany({ "retry-after": "3" }) : n === 2 ? spError(401, "expired") : fine()));
  await r.api.json("GET", "/api/v1/reference");
  ok("a 429 followed by a 401 backs off once and signs in again once", r.sp.data === 3 && r.sp.tokens === 2 && r.clock.slept.includes(3000), { data: r.sp.data, tokens: r.sp.tokens });
  // sign-in itself answered 429
  r = setup(fine, { token: (n) => (n === 1 ? tooMany({ "retry-after": "2" }) : J({ access_token: "late" })) });
  const signIn429 = await caught(r.api.json("GET", "/api/v1/reference"));
  ok("a 429 at sign-in backs off and retries once, like any other S&P call", signIn429 === null && r.sp.tokens === 2 && r.sp.data === 1, { error: signIn429?.message, tokens: r.sp.tokens, data: r.sp.data });
}

// ---------- the plain message for each S&P error ----------
{
  const cases: [number, string, string, RegExp][] = [
    [400, "bad_request", "Invalid range: companyId (limit 10)", /^S&P rejected the request \(400\)\. S&P said: Invalid range: companyId \(limit 10\)\. S&P reference: req-e\.$/],
    [401, "signin", "Token is invalid", /^S&P didn't accept the API sign-in \(401\)\..* S&P reference: req-e\.$/],
    [403, "entitlement", "Entitlement needed", /^This S&P account isn't entitled to SNL Insurance Product Filings through the API \(403, entitlement needed\)\. Ask S&P to switch it on\. S&P reference: req-e\.$/],
    [404, "not_found", "Resource not found", /^S&P couldn't find that \(404\)\. S&P said: Resource not found\. S&P reference: req-e\.$/],
    [405, "method", "Method Not Allowed", /^S&P refused the kind of request the app sent \(405\)\. This is a fault in the app, not in your search\. S&P reference: req-e\.$/],
    [429, "rate_limited", "Too many requests", /^S&P says too many requests were sent \(429\)\. Wait a minute and try again\. S&P reference: req-e\.$/],
    [500, "server", "Unknown Error", /^S&P's service failed \(500\)\. Try again in a few minutes\. S&P reference: req-e\.$/],
  ];
  for (const [status, code, said, shape] of cases) {
    const { api } = setup(() => spError(status, said, "req-e"));
    const e = await caught(api.json("POST", "/api/v1/search", { body: { properties: {} } }));
    ok(`a ${status} from S&P becomes a plain "${code}" message with S&P's reference`, e instanceof SpgmiError && e.code === code && e.status === status && e.requestId === "req-e" && shape.test(e.message), e?.message);
    const x = explain(status, said, null);
    ok(`the ${status} message reads cleanly when S&P gives no reference`, x.code === code && !x.message.includes("S&P reference") && !x.message.includes("null") && !x.message.includes("undefined") && /[.!?]$/.test(x.message), x.message);
  }
  for (const status of [502, 503, 504, 418]) {
    const { api } = setup(() => new Response("<html>Bad gateway</html>", { status, headers: { "content-type": "text/html" } }));
    const e = await caught(api.json("GET", "/api/v1/reference"));
    ok(`a ${status} with a body that isn't JSON still gets a plain message`, e instanceof SpgmiError && e.code === "server" && e.message === `S&P's service failed (${status}). Try again in a few minutes.` && e.requestId === null, e?.message);
  }
  let x = explain(400, "  Invalid\n  data   type:\tproperties  ", "r1");
  ok("S&P's own words are tidied onto one line", x.message.includes("S&P said: Invalid data type: properties.") , x.message);
  x = explain(400, "Missing parameters!", "r1");
  ok("no full stop is added after S&P's own punctuation", x.message.includes("S&P said: Missing parameters! S&P reference: r1."), x.message);
  x = explain(404, "x".repeat(900), null);
  ok("a very long S&P message is cut to 300 characters", (x.message.match(/x+/)?.[0].length ?? 0) === 300, x.message.length);
  x = explain(0, "", null);
  ok("no answer at all reads as S&P's service failing", x.code === "server" && x.message.includes("(no answer)"), x.message);
  ok("the sign-in message never repeats S&P's wording, which could name the account", !explain(401, "User api-user is locked", "r").message.includes("api-user"));
  let r = setup(() => J({ status: 400, error: "Bad Request", message: "Invalid value: referenceField" }, 400));
  let e = await caught(r.api.json("GET", "/api/v1/reference"));
  ok("an S&P error with no reference still gets its plain message", e instanceof SpgmiError && e.code === "bad_request" && e.requestId === null && e.message === "S&P rejected the request (400). S&P said: Invalid value: referenceField.", e?.message);
  r = setup(() => { throw new TypeError("dns failure for api-ciq"); });
  e = await caught(r.api.json("GET", "/api/v1/reference"));
  ok("S&P unreachable on a documents call is a plain network failure", e instanceof SpgmiError && e.code === "network" && e.message === "Couldn't reach S&P. Try again in a few minutes.", e?.message);
  r = setup(() => new Response("not json at all", { status: 200 }));
  e = await caught(r.api.json("GET", "/api/v1/reference"));
  ok("a 200 the app can't read is a plain failure, not a crash", e instanceof SpgmiError && e.code === "server" && e.message.includes("couldn't read"), e?.message);
  r = setup(() => J([1, 2, 3]));
  ok("a 200 that is a list is passed back as it is", Array.isArray(await r.api.json("GET", "/api/v1/reference")));
  r = setup(() => J(null));
  ok("a 200 that is null reads as an empty answer", JSON.stringify(await r.api.json("GET", "/api/v1/reference")) === "{}");
  r = setup(() => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf", "content-length": "4" } }));
  const res = await r.api.call("POST", "/api/v1/download", { body: { properties: { documentId: 70000001 } } });
  ok("call() hands back S&P's response untouched for a document", res.status === 200 && res.headers.get("content-type") === "application/pdf" && new Uint8Array(await res.arrayBuffer()).length === 4);
}

// ---------- the throttle and the limits ----------
{
  const { sp, api, db, clock } = setup(fine);
  const t0 = clock.now;
  for (let i = 0; i < 5; i++) await api.json("GET", "/api/v1/reference");
  ok("six calls (one sign-in, five requests) take six slots a second apart", db.slots.length === 6 && db.slots.every((s, i) => s === t0 + i * 1000), db.slots.map((s) => s - t0));
  ok("each call reaches S&P at its slot, never sooner", sp.log.every((c, i) => c.at === db.slots[i]), sp.log.map((c) => c.at - t0));
  ok("requests are counted for the hour and the day", JSON.stringify(await db.usage()) === JSON.stringify({ hour: 6, day: 6 }), await db.usage());
  clock.now += 10_000;
  const before = clock.slept.length;
  await api.json("GET", "/api/v1/reference");
  ok("after a quiet spell the next call goes at once", clock.slept.length === before && sp.log.at(-1)!.at === clock.now, clock.slept.slice(before));
}
{
  // Three function calls at the same moment share the database's slots. Time here moves only when every caller
  // is waiting, and then only to the earliest wake-up, so each caller really waits out its own slot.
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = spStub(clock, fine);
  const sleepers: { at: number; wake: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((wake) => { sleepers.push({ at: clock.now + ms, wake }); });
  const client = () => new Spgmi(CREDS, { fetch: sp.fetch, gate: makeGate(db, PLAN_LIMITS.trial, sleep), sleep });
  let finished = false;
  const all = (async () => { await client().json("GET", "/api/v1/reference"); await Promise.all([client().json("GET", "/api/v1/reference"), client().json("GET", "/api/v1/reference"), client().json("GET", "/api/v1/reference")]); })().then(() => { finished = true; });
  while (!finished) {
    await new Promise((r) => setTimeout(r, 0));
    const next = sleepers.sort((x, y) => x.at - y.at).shift();
    if (next) { clock.now = Math.max(clock.now, next.at); next.wake(); }
  }
  await all;
  const at = sp.log.map((c) => c.at).sort((x, y) => x - y);
  ok("function calls running at the same time still reach S&P a second apart", at.length === 5 && at.every((t, i) => i === 0 || t - at[i - 1] >= 1000) && new Set(db.slots).size === 5, at.map((t) => t - at[0]));
}
{
  const { sp, api, db } = setup(fine, { limits: { hour: 3, day: 100 } });
  await api.json("GET", "/api/v1/reference");            // sign-in + 1
  await api.json("GET", "/api/v1/reference");            // 3rd request this hour
  const calls = sp.log.length;
  const e = await caught(api.json("GET", "/api/v1/reference"));
  ok("when the hourly limit is used up the app stops before asking S&P", e instanceof SpgmiError && e.code === "limit" && sp.log.length === calls, { code: e?.code, calls: sp.log.length - calls });
  ok("the message says which limit and when it resets (hour)", e.message === "The app stopped before asking S&P: this hour's limit of 3 S&P requests is used up. It resets at the top of the hour.", e.message);
  ok("a refused request isn't counted", (await db.usage()).hour === 3, await db.usage());
}
{
  const { sp, api, clock } = setup(fine, { limits: { hour: 100, day: 2 } });
  await api.json("GET", "/api/v1/reference");
  const calls = sp.log.length;
  const e = await caught(api.json("GET", "/api/v1/reference"));
  ok("when the daily limit is used up the app stops before asking S&P", e instanceof SpgmiError && e.code === "limit" && sp.log.length === calls);
  ok("the message says which limit and when it resets (day)", e.message === "The app stopped before asking S&P: today's limit of 2 S&P requests is used up. It resets at midnight UTC.", e.message);
  clock.now += 3600_000;
  ok("a new hour doesn't lift the daily limit", (await caught(api.json("GET", "/api/v1/reference")))?.code === "limit");
  clock.now = Date.parse("2026-11-14T00:00:01Z");
  await api.json("GET", "/api/v1/reference");
  ok("the daily limit lifts at midnight UTC", sp.log.length === calls + 1, sp.log.length - calls);
}
{
  const { api, clock, sp } = setup(fine, { limits: { hour: 2, day: 2 } });
  await api.json("GET", "/api/v1/reference");
  const e = await caught(api.json("GET", "/api/v1/reference"));
  ok("when both limits are used up the message names the longer wait, the daily limit", e?.code === "limit" && e.message.includes("today's limit of 2") && e.message.includes("midnight UTC"), e?.message);
  clock.now = Date.parse("2026-11-13T13:00:00Z");
  ok("a new hour alone isn't enough then", (await caught(api.json("GET", "/api/v1/reference")))?.code === "limit" && sp.data === 1);
}
{
  const { sp, api, clock } = setup(fine, { limits: { hour: 2, day: 50 } });
  await api.json("GET", "/api/v1/reference");
  ok("the hourly limit holds until the top of the hour", (await caught(api.json("GET", "/api/v1/reference")))?.code === "limit");
  clock.now = Date.parse("2026-11-13T12:59:59Z");
  ok("one second before the hour it still holds", (await caught(api.json("GET", "/api/v1/reference")))?.code === "limit");
  clock.now = Date.parse("2026-11-13T13:00:00Z");
  await api.json("GET", "/api/v1/reference");
  ok("the hourly limit lifts at the top of the hour", sp.data === 2, sp.data);
}
{
  // the sign-in uses the last request of the hour: the documents call must not go out
  const { sp, api } = setup(fine, { limits: { hour: 1, day: 50 } });
  const e = await caught(api.json("GET", "/api/v1/reference"));
  ok("a limit reached between sign-in and the request still stops the request", e?.code === "limit" && sp.tokens === 1 && sp.data === 0, { tokens: sp.tokens, data: sp.data });
}
{
  const { sp, api } = setup((_c, n) => (n === 1 ? spError(401, "expired") : fine()), { limits: { hour: 3, day: 50 } });
  const e = await caught(api.json("GET", "/api/v1/reference"));   // sign-in, 401, sign-in = 3; the retry is refused
  ok("retries count against the limit too", e?.code === "limit" && sp.tokens === 2 && sp.data === 1, { code: e?.code, tokens: sp.tokens, data: sp.data });
}
{
  ok("trial limits are 500 an hour and 12,000 a day", PLAN_LIMITS.trial.hour === 500 && PLAN_LIMITS.trial.day === 12_000);
  ok("production limits are 2,000 an hour and 48,000 a day", PLAN_LIMITS.production.hour === 2_000 && PLAN_LIMITS.production.day === 48_000);
  ok("with SPGMI_ACCOUNT unset the trial limits apply", JSON.stringify(planLimits(env({}))) === JSON.stringify({ plan: "trial", hour: 500, day: 12_000 }), planLimits(env({})));
  ok("SPGMI_ACCOUNT=production applies the production limits", JSON.stringify(planLimits(env({ SPGMI_ACCOUNT: "production" }))) === JSON.stringify({ plan: "production", hour: 2_000, day: 48_000 }));
  ok("SPGMI_ACCOUNT is read whatever its case or spacing", planLimits(env({ SPGMI_ACCOUNT: "  Production " })).plan === "production");
  for (const v of ["trial", "prod", "", "PRODUCTION-EU", "yes"]) ok(`SPGMI_ACCOUNT="${v}" falls back to the lower trial limits`, planLimits(env({ SPGMI_ACCOUNT: v })).hour === 500);
  // the real numbers, in the message
  const clock = fakeClock(), db = memoryDb(clock);
  const gate = makeGate(db, PLAN_LIMITS.trial, clock.sleep);
  for (let i = 0; i < 500; i++) await db.takeSlot(PLAN_LIMITS.trial);
  let e = await caught(gate());
  ok("the trial account's 501st request in an hour is refused, with the number written with a comma where needed", e?.code === "limit" && e.message.includes("this hour's limit of 500 S&P requests"), e?.message);
  const prod = makeGate(db, PLAN_LIMITS.production, clock.sleep);
  ok("the same hour is still open on a production account", (await caught(prod())) === null);
  while ((await db.usage()).day < 12_000) await db.takeSlot({ hour: 1e9, day: 1e9 });
  clock.now = Date.parse("2026-11-13T23:30:00Z");
  e = await caught(gate());
  ok("the trial account's 12,001st request in a day is refused", e?.code === "limit" && e.message.includes("today's limit of 12,000 S&P requests"), e?.message);
}

done();
