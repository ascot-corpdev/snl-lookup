// Sign-in as S&P's Authenticate specification describes it (supabase/functions/_shared/spgmi.ts): a new token
// shortly before the stated expiry, the refresh call and its fall-back to a full sign-in, the 423 account lock and
// its cool-off, no repeated wrong-password sign-ins, and the throttle and counter on every one of those calls.
// Then the one-click connection check (snl-filings, action "check", supabase/functions/_shared/connection.ts) in
// every branch. Every call goes to the fake S&P in helpers/fakes.ts.
(globalThis as any).__SNL_TEST__ = true;
const filings = await import(new URL("../../supabase/functions/snl-filings/index.ts", import.meta.url).href);
import { forgetTokens, LOCK_COOL_OFF_MS, makeGate, PLAN_LIMITS, REFRESH_URL, REFUSED_COOL_OFF_MS, Spgmi, SpgmiError, TOKEN_URL, explain } from "../../supabase/functions/_shared/spgmi.ts";
import { CHECK_NOT_CONFIGURED, hasFlorida } from "../../supabase/functions/_shared/connection.ts";
import { checks, corpdev, env, fakeAuth, fakeClock, fakeSpgmi, J, memoryDb, nobody, reader, req } from "./helpers/fakes.ts";
import { spError } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const caught = async (p: Promise<unknown>): Promise<any> => { try { await p; return null; } catch (e) { return e; } };
const CREDS = { username: "api-user", password: "api-pass" };
const TOKEN = "/gdsapi/rest/authenticate/api/v1/token", REFRESH = "/gdsapi/rest/authenticate/api/v1/tokenRefresh", REF = "/api/v1/reference";
const MIN = 60_000, HOUR = 3600_000;

/** A client against the fake S&P with the fuller sign-in switched on. */
function setup(auth = fakeAuth(), o: { creds?: { username?: string; password?: string }; limits?: { hour: number; day: number }; keep?: boolean } = {}) {
  if (!o.keep) forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock, { auth });
  const client = (creds = o.creds ?? CREDS) => new Spgmi(creds, { fetch: sp.fetch, gate: makeGate(db, o.limits ?? PLAN_LIMITS.trial, clock.sleep), sleep: clock.sleep, now: clock.fn });
  const api = client();
  const get = () => api.json("GET", REF, { query: { referenceField: "filingStatus" } });
  const paths = () => sp.log.map((c) => c.path);
  const dataCalls = () => sp.log.filter((c) => c.path === REF).length;
  return { clock, db, sp, auth, api, client, get, paths, dataCalls };
}

// ---------- the specification's addresses ----------
ok("the sign-in and refresh addresses are the ones in S&P's specification", TOKEN_URL.endsWith("/gdsapi/rest/authenticate/api/v1/token") && REFRESH_URL === "https://api-ciq.marketintelligence.spglobal.com/gdsapi/rest/authenticate/api/v1/tokenRefresh");

// ---------- a new token shortly before it expires ----------
{
  const w = setup(fakeAuth({ lifeSeconds: "600", refresh: false }));
  await w.get();
  const t0 = w.sp.log[0].at;
  w.clock.now = t0 + 8 * MIN;
  await w.get();
  ok("a token is kept while it has well over a minute left", w.auth.signIns === 1 && w.sp.log.at(-1)!.auth === "Bearer tok-1", w.paths());
  w.clock.now = t0 + 9 * MIN + 1000;
  await w.get();
  ok("with under a minute left, the app signs in again before the call", w.auth.signIns === 2 && w.sp.log.at(-1)!.auth === "Bearer tok-2" && w.paths().slice(-2).join() === `${TOKEN},${REF}`, w.paths());
  ok("so S&P never had to refuse an expired token", w.sp.log.filter((c) => c.path === REF).length === 3, w.paths());
}
{
  const w = setup(fakeAuth({ lifeSeconds: 600, refresh: false }));
  await w.get(); w.clock.now += 9.5 * MIN; await w.get();
  ok("expires_in_seconds sent as a number is read too", w.auth.signIns === 2, w.paths());
}
{
  const w = setup(fakeAuth({ lifeSeconds: "60", refresh: false }));
  await w.get(); const t0 = w.sp.log[0].at;
  w.clock.now = t0 + 25_000; await w.get();
  ok("a one-minute token is used for its first half", w.auth.signIns === 1, w.paths());
  w.clock.now = t0 + 31_000; await w.get();
  ok("and replaced after it", w.auth.signIns === 2, w.paths());
}
for (const life of [null, "soon", "0", "-5", ""]) {
  const w = setup(fakeAuth({ lifeSeconds: life, refresh: false }));
  await w.get(); w.clock.now += 5 * HOUR; await w.get();
  ok(`with expires_in_seconds ${life === null ? "missing" : `"${life}"`} the token is kept until S&P turns it down`, w.auth.signIns === 1 && w.sp.log.at(-1)!.auth === "Bearer tok-1", w.paths());
}
{
  // the safety net: S&P turns a token down early
  const w = setup(fakeAuth({ lifeSeconds: "3600", refresh: false }));
  await w.get();
  w.sp.expireTokens();
  await w.get();
  ok("a token turned down before its stated expiry is still replaced once", w.auth.signIns === 2 && w.paths().join() === [TOKEN, REF, REF, TOKEN, REF].join(), w.paths());
}

// ---------- the refresh call ----------
{
  const w = setup(fakeAuth({ lifeSeconds: "600" }));
  await w.get();
  w.clock.now += 9.5 * MIN;
  await w.get();
  const r = w.sp.log.find((c) => c.path === REFRESH)!;
  ok("near expiry, a held refresh token is used instead of a full sign-in", w.auth.signIns === 1 && w.auth.refreshes === 1 && w.paths().join() === [TOKEN, REF, REFRESH, REF].join(), w.paths());
  ok("the refresh sends exactly refreshToken as a form, with no bearer token and no password", same(r.body, { refreshToken: "rt-1" }) && r.auth === null && !JSON.stringify(r.body).includes("api-pass"), r);
  ok("the refreshed token is the one sent next", w.sp.log.at(-1)!.auth === "Bearer tok-2");
  w.clock.now += 9.5 * MIN;
  await w.get();
  ok("the same refresh token is used again when S&P doesn't send a new one", w.auth.refreshes === 2 && w.sp.log.filter((c) => c.path === REFRESH).every((c) => c.body.refreshToken === "rt-1") && w.auth.signIns === 1, w.sp.log.filter((c) => c.path === REFRESH).map((c) => c.body));
}
{
  const w = setup(fakeAuth({ lifeSeconds: "600", rotate: true }));
  await w.get(); w.clock.now += 9.5 * MIN; await w.get(); w.clock.now += 9.5 * MIN; await w.get();
  const sent = w.sp.log.filter((c) => c.path === REFRESH).map((c) => c.body.refreshToken);
  ok("when a refresh answer carries a new refresh token, that one is used next", same(sent, ["rt-1", "rt-2"]) && w.auth.signIns === 1, sent);
}
for (const [status, why] of [[401, "refused"], [500, "failing"], [405, "answering 405"]] as const) {
  const w = setup(fakeAuth({ lifeSeconds: "600" }));
  await w.get();
  w.auth.refreshFail.push({ status, message: "User unauthorized" });
  w.clock.now += 9.5 * MIN;
  const e = await caught(w.get());
  ok(`with the refresh ${why} (${status}), the app falls back to a full sign-in and the call works`, e === null && w.paths().join() === [TOKEN, REF, REFRESH, TOKEN, REF].join() && w.auth.signIns === 2, { e: e?.message, paths: w.paths() });
}
{
  const w = setup(fakeAuth({ lifeSeconds: "600" }));
  await w.get();
  w.auth.refreshFail.push({ status: 401 });
  w.clock.now += 9.5 * MIN; await w.get();      // refresh refused, signed in again: rt-2 now held
  w.clock.now += 9.5 * MIN; await w.get();
  ok("after a refused refresh, the refresh token from the new sign-in is the one used", w.sp.log.filter((c) => c.path === REFRESH).map((c) => c.body.refreshToken).join() === "rt-1,rt-2", w.sp.log.filter((c) => c.path === REFRESH).map((c) => c.body));
}
{
  const w = setup(fakeAuth({ lifeSeconds: "600" }));
  await w.get();
  w.clock.now += 9.5 * MIN;
  const realFetch = w.sp.fetch;
  const api = new Spgmi(CREDS, { fetch: (async (u: string, i: RequestInit) => { if (String(u) === REFRESH_URL) throw new TypeError("reset"); return realFetch(u, i); }) as typeof fetch, gate: makeGate(w.db, PLAN_LIMITS.trial, w.clock.sleep), sleep: w.clock.sleep, now: w.clock.fn });
  const e = await caught(api.json("GET", REF, { query: { referenceField: "filingStatus" } }));
  ok("S&P unreachable at the refresh is a plain network failure", e instanceof SpgmiError && e.code === "network" && e.message === "Couldn't reach S&P to sign in. Try again in a few minutes.", e?.message);
}
{
  // a 401 on a data call while a refresh token is held: the refresh comes first
  const w = setup(fakeAuth({ lifeSeconds: "3600" }));
  await w.get();
  w.sp.expireTokens();
  await w.get();
  ok("a token turned down early is replaced through the refresh token when one is held", w.paths().join() === [TOKEN, REF, REF, REFRESH, REF].join() && w.auth.signIns === 1, w.paths());
}
{
  // the refresh token's own limits: 24 hours idle, 7 days in all
  const w = setup(fakeAuth({ lifeSeconds: "3600" }));
  await w.get();
  w.clock.now += 22 * HOUR; await w.get();
  ok("a refresh token idle for 22 hours is still used", w.auth.refreshes === 1 && w.auth.signIns === 1, w.paths());
  w.clock.now += 23.5 * HOUR; await w.get();
  ok("one idle for nearly 24 hours isn't sent: a full sign-in instead", w.auth.refreshes === 1 && w.auth.signIns === 2, w.paths());
  const v = setup(fakeAuth({ lifeSeconds: "3600" }));
  await v.get();
  const kinds: string[] = [];
  for (let h = 20; h <= 180; h += 20) {
    v.clock.now = v.sp.log[0].at + h * HOUR;
    const before = v.sp.log.length;
    await v.get();
    kinds.push(v.sp.log.slice(before).some((c) => c.path === REFRESH) ? "r" : v.sp.log.slice(before).some((c) => c.path === TOKEN) ? "s" : "-");
  }
  ok("a refresh token kept in use is sent for up to 7 days less an hour, then a full sign-in", kinds.join("") === "rrrrrrrrs", kinds.join(""));
}

// ---------- the throttle and the counter on refresh calls ----------
{
  const w = setup(fakeAuth({ lifeSeconds: "600" }));
  await w.get(); w.clock.now += 9.5 * MIN; await w.get();
  ok("the refresh took a throttle slot and was counted", w.db.slots.length === 4 && (await w.db.usage()).hour === 4, w.db.slots);
  const r = w.sp.log.findIndex((c) => c.path === REFRESH);
  ok("the data call after a refresh waits a second after it", w.sp.log[r + 1].at - w.sp.log[r].at >= 1000, w.sp.log.map((c) => c.at));
}
{
  const w = setup(fakeAuth({ lifeSeconds: "600" }), { limits: { hour: 2, day: 100 } });
  await w.get();
  w.clock.now += 9.5 * MIN;
  const e = await caught(w.get());
  ok("when the hourly limit is used up, the refresh isn't sent either", e?.code === "limit" && !w.paths().includes(REFRESH) && w.sp.log.length === 2, { e: e?.message, paths: w.paths() });
}

// ---------- 423: the account is locked ----------
{
  const w = setup();
  w.auth.signInFail.push({ status: 423, message: "Account Locked", requestId: "req-lock-1" });
  const e = await caught(w.get());
  ok("a 423 at sign-in is a plain locked message with S&P's reference", e instanceof SpgmiError && e.code === "locked" && e.status === 423 && e.requestId === "req-lock-1"
    && e.message.startsWith("S&P has locked the API account (423 Account Locked). This usually happens after repeated failed sign-ins. Ask S&P to unlock it.") && e.message.includes("S&P reference: req-lock-1."), e?.message);
  ok("it says the app has stopped trying, and until when", e.message.includes("The app has stopped trying and won't sign in again before 12:30 UTC"), e.message);
  ok("no data call follows a lock", w.dataCalls() === 0 && w.auth.signIns === 1);
  const calls = w.sp.log.length, slots = w.db.slots.length;
  for (let i = 0; i < 5; i++) await caught(w.get());
  const again = await caught(w.get());
  ok("while locked, further calls don't reach S&P at all and take no slot", w.sp.log.length === calls && w.db.slots.length === slots && again?.code === "locked" && again.requestId === "req-lock-1", { calls: w.sp.log.length - calls });
  const other = await caught(w.client({ username: "api-user", password: "a-new-password" }).json("GET", REF, { query: { referenceField: "filingStatus" } }));
  ok("a changed password doesn't lift the lock: only S&P can", other?.code === "locked" && w.sp.log.length === calls, other?.message);
  w.clock.now = w.sp.log[0].at + LOCK_COOL_OFF_MS - 1000;
  ok("the lock holds for the whole cool-off", (await caught(w.get()))?.code === "locked" && w.sp.log.length === calls);
  w.clock.now = w.sp.log[0].at + LOCK_COOL_OFF_MS + 1000;
  ok("after the cool-off the app tries once more", (await caught(w.get())) === null && w.auth.signIns === 2, w.paths());
  ok("the cool-off is 30 minutes", LOCK_COOL_OFF_MS === 30 * MIN);
}
{
  const w = setup();
  w.auth.signInFail.push({ status: 423 });
  await caught(w.get());
  forgetTokens();
  ok("forgetTokens clears a remembered lock", (await caught(w.get())) === null && w.auth.signIns === 2);
  const u = setup();
  u.auth.signInFail.push({ status: 423 });
  await caught(u.get());
  const second = await caught(u.client({ username: "second-user", password: "x" }).json("GET", REF, { query: { referenceField: "filingStatus" } }));
  ok("a lock is remembered for that username only", second?.code === "signin" && u.auth.signIns === 2, second?.message);
}
{
  const w = setup(fakeAuth({ lifeSeconds: "600" }));
  await w.get();
  w.auth.refreshFail.push({ status: 423, message: "Account Locked" });
  w.clock.now += 9.5 * MIN;
  const e = await caught(w.get());
  ok("a 423 at the refresh is the locked message, with no fall-back sign-in", e?.code === "locked" && w.auth.signIns === 1 && w.paths().at(-1) === REFRESH, { e: e?.message, paths: w.paths() });
  const n = w.sp.log.length;
  ok("and the lock is remembered", (await caught(w.get()))?.code === "locked" && w.sp.log.length === n);
}
{
  const x = explain(423, "Account Locked", "req-9");
  ok("a 423 anywhere reads as the locked account", x.code === "locked" && x.message.includes("Ask S&P to unlock it.") && x.message.endsWith("S&P reference: req-9."), x.message);
  ok("a locked message reaches the page as an S&P failure with its own code", same(filings.spgmiAnswer(x), { status: 502, body: { error: "spgmi_locked", message: x.message, requestId: "req-9" } }), filings.spgmiAnswer(x));
}

// ---------- a wrong password isn't sent again and again ----------
for (const status of [401, 400]) {
  const w = setup(fakeAuth(), { creds: { username: "api-user", password: "wrong" } });
  w.auth.signInFail.push({ status, message: "User unauthorized", requestId: `req-${status}` });
  const e = await caught(w.get());
  ok(`a refused sign-in (${status}) fails with the usual message`, e?.code === "signin" && e.message.startsWith(`S&P didn't accept the API sign-in (${status}).`), e?.message);
  const n = w.sp.log.length, slots = w.db.slots.length;
  let last: any = null;
  for (let i = 0; i < 10; i++) last = await caught(w.get());
  ok(`after one refused sign-in (${status}), ten more calls send nothing to S&P and take no slot`, w.sp.log.length === n && w.db.slots.length === slots && w.auth.signIns === 1, { sent: w.sp.log.length - n });
  ok(`and each says why, without trying (${status})`, last?.code === "signin" && last.message.startsWith(`S&P refused this API sign-in a moment ago (${status})`) && last.message.includes("Check SPGMI_API_USERNAME and SPGMI_API_PASSWORD") && last.message.includes("or at once when the password is changed") && !last.message.includes("wrong"), last?.message);
  ok(`the remembered refusal keeps S&P's reference (${status})`, last.requestId === `req-${status}` && last.message.endsWith(`S&P reference: req-${status}.`), last.message);
}
{
  const w = setup(fakeAuth(), { creds: { username: "api-user", password: "wrong" } });
  await caught(w.get());
  const t0 = w.sp.log[0].at;
  const msg = (await caught(w.get()))?.message ?? "";
  ok("the message says when the app will try again", msg.includes("The app tries again after 12:05 UTC"), msg);
  w.clock.now = t0 + REFUSED_COOL_OFF_MS - 1000;
  await caught(w.get());
  ok("the same password isn't sent again within five minutes", w.auth.signIns === 1);
  w.clock.now = t0 + REFUSED_COOL_OFF_MS + 1000;
  await caught(w.get());
  ok("after five minutes it is tried once more", w.auth.signIns === 2);
  ok("the short wait is five minutes", REFUSED_COOL_OFF_MS === 5 * MIN);
}
{
  const w = setup(fakeAuth(), { creds: { username: "api-user", password: "wrong" } });
  await caught(w.get());
  const fixed = await caught(w.client(CREDS).json("GET", REF, { query: { referenceField: "filingStatus" } }));
  ok("a corrected password is tried at once", fixed === null && w.auth.signIns === 2, fixed?.message);
  const v = setup(fakeAuth(), { creds: { username: "api-user", password: "wrong" } });
  await caught(v.get());
  forgetTokens();
  await caught(v.get());
  ok("forgetTokens clears a remembered refusal", v.auth.signIns === 2);
  const s = setup();
  s.auth.signInFail.push({ status: 503 });
  await caught(s.get());
  ok("an S&P outage at sign-in isn't held against the password: the next call tries again", (await caught(s.get())) === null && s.auth.signIns === 2);
}

// ---------- the connection check, through the function ----------
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" };
function world(secrets: Record<string, string> = SECRETS, o: { auth?: ReturnType<typeof fakeAuth>; keep?: boolean } = {}) {
  if (!o.keep) forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock, { auth: o.auth ?? fakeAuth() });
  const deps = { env: env(secrets), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown = { action: "check" }, over: Record<string, unknown> = {}) => { const res: Response = await filings.handle(req("snl-filings", body), { ...deps, ...over }); return { status: res.status, body: await res.json() }; };
  return { clock, db, sp, deps, call, paths: () => sp.log.map((c) => c.path) };
}
const ids = (b: any) => b.steps.map((s: any) => `${s.id}:${s.ok ? "ok" : "failed"}`).join(",");

{
  const w = world({});
  const r = await w.call();
  ok("not set up: the check answers 200 with a calm report", r.status === 200 && r.body.configured === false && same(r.body.steps, []) && r.body.florida === null && r.body.summary === CHECK_NOT_CONFIGURED, r.body);
  ok("not set up: nothing is sent to S&P", w.sp.log.length === 0 && r.body.requests === 0 && r.body.used.hour === 0);
  ok("not set up: the report says what to set and what to do next", CHECK_NOT_CONFIGURED.includes("SPGMI_API_USERNAME") && CHECK_NOT_CONFIGURED.includes("SPGMI_API_PASSWORD") && CHECK_NOT_CONFIGURED.includes("click Check S&P connection again"));
  ok("not set up: it still says which limits apply", r.body.account === "trial" && same(r.body.limits, { hour: 500, day: 12000 }) && r.body.checkedAt === "2026-11-13T12:00:00.000Z", r.body);
  const half = world({ SPGMI_API_USERNAME: "api-user" });
  ok("a username without a password is not set up either", (await half.call()).body.configured === false && half.sp.log.length === 0);
}
{
  const w = world();
  const r = await w.call();
  ok("all good: four steps, all done, in order", r.status === 200 && ids(r.body) === "signin:ok,entitlement:ok,states:ok,lists:ok", r.body.steps);
  ok("all good: Florida is found and the summary says the first search can run", r.body.florida === true && r.body.summary.startsWith("The S&P connection works.") && r.body.summary.includes("Florida is in the state list"), r.body.summary);
  ok("all good: the state step gives the count and Florida", r.body.steps[2].detail === "3 states. Florida (FL) is in the list.", r.body.steps[2]);
  ok("all good: the lists step gives each count", r.body.steps[3].detail === "Types of insurance 2, filing types 4, statuses 3.", r.body.steps[3]);
  ok("all good: the entitlement step names the product", r.body.steps[1].title === "Entitled to SNL Insurance Product Filings" && r.body.steps[1].detail.includes("INSPRODFILINGS_DOCUMENTS_API"), r.body.steps[1]);
  ok("all good: one sign-in and four lists, nothing more", same(w.paths(), [TOKEN, REF, REF, REF, REF]) && same(w.sp.calls(REF).map((c) => c.query.referenceField), ["serffFilingState", "typeOfInsurance", "serffFilingType", "filingStatus"]), w.paths());
  ok("all good: the report counts the five requests it used, and the totals", r.body.requests === 5 && r.body.used.hour === 5 && r.body.used.day === 5 && r.body.account === "trial", r.body);
  ok("all good: the calls were a second apart", w.sp.log.every((c, i) => i === 0 || c.at - w.sp.log[i - 1].at >= 1000));
  ok("the report never carries the password", !JSON.stringify(r.body).includes("api-pass"));
  const refs = await w.call({ action: "reference" });
  ok("the lists it loaded are saved for the rest of the app", same(Object.keys(refs.body.lists), ["typeOfInsurance", "filingStatus", "serffFilingState", "serffFilingType"]) && Object.values(refs.body.lists).every((l: any) => l.fromStore === true) && w.sp.log.length === 5, w.sp.log.length);
  const again = await w.call();
  ok("a second check signs in afresh, so it tests the credentials each time, and still asks S&P for the lists", again.body.requests === 5 && w.sp.log.slice(5).map((c) => c.path).join() === [TOKEN, REF, REF, REF, REF].join(), w.paths().slice(5));
}
{
  const w = world();
  await w.call({ action: "reference", field: "filingStatus" });   // a token is now held
  const n = w.sp.log.length;
  const r = await w.call(undefined, { whoIs: reader });
  ok("any signed-in login may run the check", r.status === 200 && ids(r.body) === "signin:ok,entitlement:ok,states:ok,lists:ok");
  ok("with a token already held, the check still makes exactly one sign-in", w.sp.log.slice(n).filter((c) => c.path === TOKEN).length === 1 && r.body.requests === 5, w.paths().slice(n));
  ok("signed out: the check is refused", (await w.call(undefined, { whoIs: nobody })).status === 401);
  const prod = world({ ...SECRETS, SPGMI_ACCOUNT: "production" });
  const p = await prod.call();
  ok("a production account reports the production limits", p.body.account === "production" && same(p.body.limits, { hour: 2000, day: 48000 }), p.body);
  const bad = await w.call({ action: "nope" });
  ok("an unknown action lists check among the actions", bad.status === 400 && bad.body.message.includes("document or check"), bad.body);
}
{
  const w = world({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "wrong" });
  const r = await w.call();
  ok("wrong password: the sign-in step fails and the check stops there", ids(r.body) === "signin:failed" && r.body.steps[0].title === "Couldn't sign in to S&P" && r.body.steps[0].detail.includes("SPGMI_API_USERNAME"), r.body.steps);
  ok("wrong password: one request, no data call", r.body.requests === 1 && same(w.paths(), [TOKEN]) && r.body.florida === null, w.paths());
  ok("wrong password: the summary leads with what happened", r.body.summary === "The S&P connection isn't working yet. Couldn't sign in to S&P. The step below says what to do.", r.body.summary);
  const again = await w.call();
  ok("checking again at once doesn't resend the refused password", again.body.requests === 0 && w.sp.log.length === 1 && again.body.steps[0].detail.includes("a moment ago"), again.body.steps[0]);
}
{
  const auth = fakeAuth();
  auth.signInFail.push({ status: 401, message: "User unauthorized", requestId: "req-signin-7" });
  const w = world(SECRETS, { auth });
  const r = await w.call();
  ok("a refused sign-in carries S&P's reference number", r.body.steps[0].requestId === "req-signin-7" && r.body.steps[0].detail.includes("S&P reference: req-signin-7."), r.body.steps[0]);
}
{
  const auth = fakeAuth();
  auth.signInFail.push({ status: 423, message: "Account Locked", requestId: "req-lock-2" });
  const w = world(SECRETS, { auth });
  const r = await w.call();
  ok("locked account: the sign-in step says so, with what to ask S&P", ids(r.body) === "signin:failed" && r.body.steps[0].detail.includes("S&P has locked the API account") && r.body.steps[0].detail.includes("Ask S&P to unlock it.") && r.body.steps[0].requestId === "req-lock-2", r.body.steps[0]);
  const again = await w.call();
  ok("locked account: checking again doesn't call S&P", again.body.requests === 0 && w.sp.log.length === 1 && again.body.steps[0].detail.includes("won't sign in again before"), again.body.steps[0]);
}
{
  const w = world();
  w.sp.failNext.push({ status: 403 });
  const r = await w.call();
  ok("not entitled: signed in, then the entitlement step fails", ids(r.body) === "signin:ok,entitlement:failed", r.body.steps);
  const s = r.body.steps[1];
  ok("not entitled: it says exactly what to ask S&P for, with S&P's reference", s.detail.includes("Ask S&P to add the INSPRODFILINGS_DOCUMENTS_API entitlement") && s.detail.includes("403") && s.requestId === "req-forced", s);
  ok("not entitled: the summary points at the entitlement", r.body.summary.includes("can't use SNL Insurance Product Filings yet") && r.body.summary.includes("Ask S&P for the entitlement"), r.body.summary);
  ok("not entitled: two requests, and the other lists aren't asked for", r.body.requests === 2 && w.sp.calls(REF).length === 1);
}
{
  const w = world();
  w.sp.failNext.push({ status: 500 });
  const r = await w.call();
  ok("S&P failing on the state list: the state step fails with S&P's reference, and entitlement isn't claimed", ids(r.body) === "signin:ok,states:failed" && r.body.steps[1].detail.startsWith("S&P's service failed (500).") && r.body.steps[1].requestId === "req-forced", r.body.steps);
}
{
  const w = world();
  w.sp.failNext.push({ status: 429, headers: { "retry-after": "2" } });
  const r = await w.call();
  ok("a 429 during the check isn't retried: the step fails and says to wait", ids(r.body) === "signin:ok,states:failed" && r.body.steps[1].detail.includes("(429)") && r.body.requests === 2 && w.clock.slept.every((ms) => ms !== 2000), { steps: r.body.steps, slept: w.clock.slept });
}
{
  const w = world();
  w.sp.failNext.push({ status: 401 });
  const r = await w.call();
  ok("a 401 straight after signing in isn't retried: the check reports it", ids(r.body) === "signin:ok,states:failed" && r.body.steps[1].detail.startsWith("S&P didn't accept the API sign-in (401).") && r.body.requests === 2, r.body.steps);
}
{
  const w = world();
  w.sp.failNext.push({ status: 200, body: { numCols: 2, numRows: 0, headers: ["serffFilingStateId", "serffFilingState"], rows: [] } });
  const r = await w.call();
  ok("an empty state list is a failure, worded as S&P returning nothing", ids(r.body) === "signin:ok,entitlement:ok,states:failed" && r.body.steps[2].detail.startsWith("S&P returned nothing for the list of states"), r.body.steps);
}
{
  const w = world();
  w.sp.failNext.push({ status: 200, body: { numCols: 2, numRows: 2, headers: ["serffFilingStateId", "serffFilingState"], rows: [{ row: ["TX", "Texas"] }, { row: ["GA", "Georgia"] }] } });
  const r = await w.call();
  ok("no Florida: the check still passes, but says so plainly", ids(r.body) === "signin:ok,entitlement:ok,states:ok,lists:ok" && r.body.florida === false && r.body.steps[2].detail.includes("isn't in the list") && r.body.summary.includes("Florida (FL) isn't in S&P's state list"), r.body);
}
{
  const ref = (options: { id: string | number; name: string }[], rows: Record<string, string | number | null>[] = []) => ({ field: "serffFilingState", options, headers: [], rows, fetchedAt: "", fromStore: false }) as any;
  ok("Florida is found by code, by name, or in any column", hasFlorida(ref([{ id: "FL", name: "FL" }])) && hasFlorida(ref([{ id: 12, name: "Florida" }])) && hasFlorida(ref([{ id: 12, name: "x" }], [{ a: 12, b: " fl " }])) && !hasFlorida(ref([{ id: "FLA", name: "Floridaland" }])));
}
{
  const w = world();
  const real = w.sp.fetch;
  w.deps.fetch = (async (u: string, i: RequestInit) => (String(u).includes("referenceField=serffFilingType") ? spError(500, "Unknown Error", "req-ft-1") : real(u, i))) as typeof fetch;
  const r = await w.call();
  ok("a list failing: the lists step names which list and gives S&P's reference", ids(r.body) === "signin:ok,entitlement:ok,states:ok,lists:failed" && r.body.steps[3].title === "Couldn't load S&P's list of filing types" && r.body.steps[3].requestId === "req-ft-1", r.body.steps[3]);
  ok("it stops at the failure: the statuses list isn't asked for", !w.sp.calls(REF).some((c) => c.query.referenceField === "filingStatus") && r.body.requests === 4, r.body.requests);
}
{
  const w = world();
  const real = w.sp.fetch;
  w.deps.fetch = (async (u: string, i: RequestInit) => (String(u).includes("referenceField=filingStatus") ? J({ numCols: 2, numRows: 0, headers: ["filingStatusId", "filingStatus"], rows: [] }) : real(u, i))) as typeof fetch;
  const r = await w.call();
  ok("an empty list among the other three is a failure", ids(r.body) === "signin:ok,entitlement:ok,states:ok,lists:failed" && r.body.steps[3].title === "S&P's list of statuses came back empty" && r.body.steps[3].detail.includes("types of insurance 2, filing types 4"), r.body.steps[3]);
}
{
  const w = world();
  w.deps.fetch = (async () => { throw new TypeError("dns"); }) as typeof fetch;
  const r = await w.call();
  ok("S&P unreachable: the sign-in step says so plainly", ids(r.body) === "signin:failed" && r.body.steps[0].detail === "Couldn't reach S&P to sign in. Try again in a few minutes.", r.body.steps);
}
{
  // the hour's limit: two requests left
  const w = world();
  for (let i = 0; i < 498; i++) await w.db.takeSlot(PLAN_LIMITS.trial);
  const r = await w.call();
  ok("the check respects the hourly limit: it stops before asking S&P", ids(r.body) === "signin:ok,entitlement:ok,states:ok,lists:failed" && r.body.steps[3].title === "Stopped before asking S&P: a request limit is used up" && r.body.steps[3].detail.includes("this hour's limit of 500"), r.body.steps);
  ok("and counts only the requests that went out", r.body.requests === 2 && w.sp.log.length === 2 && r.body.used.hour === 500, r.body);
  const none = await w.call();
  ok("with the limit used up, the check sends nothing at all", ids(none.body) === "signin:failed" && none.body.requests === 0 && w.sp.log.length === 2 && none.body.steps[0].detail.startsWith("The app stopped before asking S&P"), none.body.steps);
}
done();
