// Sign-in notices (supabase/functions/_shared/signins.ts and snl-signin): each Cloudflare Access session is recorded
// once, "last seen" moves at most every few minutes, the owner is emailed when someone not on the admin list starts a
// new session, and nothing about this can fail or slow a sign-in. Every person, address and key here is made up.
(globalThis as any).__SNL_TEST__ = true;
const fn = await import(new URL("../../supabase/functions/snl-signin/index.ts", import.meta.url).href);
import { KeyStore } from "../../supabase/functions/_shared/access.ts";
import { RESEND_URL, sendEmail } from "../../supabase/functions/_shared/mail.ts";
import * as watch from "../../supabase/functions/_shared/watch.ts";
import {
  MAX_NOTIFY, missingSignins, noticeEmail, noticeRecipients, noticeSetting, type Notice, sessionKey, SIGNIN_KEEP_DAYS, SIGNIN_MAIL_MS, SIGNIN_TOUCH_MS,
  SIGNIN_WAIT_MS, type SigninLog, type SigninRow, supabaseSigninLog, whenUtc,
} from "../../supabase/functions/_shared/signins.ts";
import { accessTeam, checks, corpdev, env, fakeClock, J, memorySignin, nobody, reader } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const said: string[] = [];
const keepErr = console.error;
console.error = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };

const kit = await accessTeam();
const clock = fakeClock();
const T0 = clock.now, SEC0 = Math.floor(T0 / 1000), MIN = 60_000, DAY = 86_400_000;
const OWNER = "owner@example.com", SAM = "sam.reader@example.com";
const BASE: Record<string, string> = { CF_ACCESS_TEAM_DOMAIN: kit.team, CF_ACCESS_AUD: kit.aud, SNL_ADMIN_EMAILS: "Owner@Example.com", RESEND_API_KEY: "re_test_made_up", WATCH_FROM: "SNL lookup <watch@example.com>" };

/** The record of sign-ins in memory. The insert is checked and made in one step, as the database's
    "on conflict do nothing" is, so two calls at once can't both add a row. fail: "missing" (migration 0011 not run),
    "down" (every call fails), "touch", "notice" or "trim" (only that call fails). */
function memoryLog() {
  const t = {
    rows: new Map<string, SigninRow>(), calls: [] as string[], fail: "" as "" | "missing" | "down" | "touch" | "notice" | "trim",
    gone() { const e = new Error("PGRST205 Could not find the table 'public.snl_signins' in the schema cache"); e.name = "add"; return e; },
    check(what: string) { t.calls.push(what); if (t.fail === "missing") throw t.gone(); if (t.fail === "down" || t.fail === what) throw new Error("made-up failure for made-up@example.com"); },
    async add(row: SigninRow) { await Promise.resolve(); t.check("add"); if (t.rows.has(row.session_key)) return false; t.rows.set(row.session_key, structuredClone(row)); return true; },
    async touch(k: string, at: string, before: string) { t.check("touch"); const r = t.rows.get(k); if (r && r.last_seen_at < before) r.last_seen_at = at; },
    async setNotice(k: string, n: Notice) { t.check("notice"); const r = t.rows.get(k); if (r) r.notice = n; },
    async dropOld(before: string) { t.check("trim"); for (const [k, r] of t.rows) if (r.last_seen_at < before) t.rows.delete(k); },
    async present() { t.calls.push("present"); if (t.fail === "missing") return false; if (t.fail === "down") throw new Error("down"); return true; },
    only() { return [...t.rows.values()]; },
  };
  return t;
}

/** Resend, as a fetch: records each email. mode: ok, fail (500), throw (no answer), hang (until the call's own time
    limit aborts it, if it has one). */
function resend() {
  const m = {
    sent: [] as { url: string; auth: string; body: any; signal: AbortSignal | null }[], mode: "ok" as "ok" | "fail" | "throw" | "hang", other: [] as string[],
    fetch: (async (input: Request | URL | string, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== RESEND_URL) { m.other.push(url); throw new Error("unexpected fetch " + url); }
      m.sent.push({ url, auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""), body: JSON.parse(String(init?.body)), signal: init?.signal ?? null });
      if (m.mode === "throw") throw new TypeError("network down");
      if (m.mode === "hang") return await new Promise<Response>((_, rej) => { init?.signal?.addEventListener("abort", () => rej(new DOMException("timed out", "TimeoutError"))); });
      return m.mode === "fail" ? J({ message: "made-up refusal" }, 500) : J({ id: "made-up-email-id" });
    }) as unknown as typeof fetch,
  };
  return m;
}

type Setup = { log?: ReturnType<typeof memoryLog> | null; mail?: ReturnType<typeof resend>; e?: Record<string, string>; seen?: Map<string, number>; background?: ((w: Promise<unknown>) => void) | null; recordWaitMs?: number; whoIs?: any };
function setup(o: Setup = {}) {
  const s = { log: o.log === undefined ? memoryLog() : o.log, mail: o.mail ?? resend(), store: memorySignin(clock), seen: o.seen ?? new Map<string, number>(), keys: new KeyStore(kit.fetch, () => clock.now) };
  const call = async (token: string | null, extra: Partial<Setup> = {}) => {
    const req = new Request("https://x.supabase.co/functions/v1/snl-signin", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}) }, body: JSON.stringify({ action: "session" }) });
    const deps: Record<string, unknown> = { env: env({ ...BASE, ...(o.e ?? {}), ...(extra.e ?? {}) }), fetch: s.mail.fetch, now: () => clock.now, store: s.store, keys: s.keys, log: s.log, seen: extra.seen ?? s.seen,
      background: extra.background !== undefined ? extra.background : o.background !== undefined ? o.background : null, recordWaitMs: extra.recordWaitMs ?? o.recordWaitMs };
    const res: Response = await fn.handle(req, deps);
    return { res, body: await res.json() };
  };
  return { ...s, call };
}
/** A token for this person, issued at the given second (a new Access session), valid for an hour from it. */
const tok = (email: string, iatSec = SEC0, more: Record<string, unknown> = {}) => kit.token({ claims: { email, iat: iatSec, nbf: iatSec, exp: iatSec + 3600, ...more } });

// ---------- one sign-in is one Access session ----------
{
  const s = setup();
  const t1 = await tok(SAM);
  const a = await s.call(t1);
  clock.now = T0 + 30_000;
  const b = await s.call(t1);
  ok("a sign-in answers as before: a session and the profile", a.res.status === 200 && typeof a.body.accessToken === "string" && a.body.profile.email === SAM && b.res.status === 200);
  ok("the same token twice (a reload): one row and one email", s.log!.rows.size === 1 && s.mail.sent.length === 1, { rows: s.log!.only(), mail: s.mail.sent.length });
  const fresh = setup({ log: s.log, mail: s.mail });   // another running copy of the function: nothing remembered
  await fresh.call(t1);
  ok("the same token in another running copy of the function: still one row and one email", s.log!.rows.size === 1 && s.mail.sent.length === 1);
  clock.now = T0 + 40 * MIN;
  const t2 = await tok(SAM, SEC0 + 40 * 60);
  await s.call(t2);
  ok("a new sign-in (a token with a new issue time): a new row and a new email", s.log!.rows.size === 2 && s.mail.sent.length === 2, s.log!.only());
  ok("the session key is a SHA-256 of the address and the issue time, not the token", s.log!.only().every((r) => /^[0-9a-f]{64}$/.test(r.session_key)) && s.log!.only()[0].session_key === await sessionKey(SAM, SEC0, SEC0 + 3600) && s.log!.only()[0].session_key !== s.log!.only()[1].session_key);
  ok("a token without an issue time falls back on its expiry: still one key per token", (await sessionKey(SAM, null, 99)) !== (await sessionKey(SAM, null, 100)) && (await sessionKey(SAM, null, 99)) !== (await sessionKey(SAM, 99, 99)) && (await sessionKey(" Sam.Reader@Example.com", 5, 9)) === (await sessionKey(SAM, 5, 9)));
  clock.now = T0;
}
{
  const s = setup(), t = await tok(SAM);
  await Promise.all([s.call(t), s.call(t), s.call(t)]);
  ok("three page loads at once in one running function: one row, one email", s.log!.rows.size === 1 && s.mail.sent.length === 1, { rows: s.log!.rows.size, mail: s.mail.sent.length });
  const s2 = setup(), t2 = await tok(SAM);
  await Promise.all([s2.call(t2, { seen: new Map() }), s2.call(t2, { seen: new Map() })]);
  ok("two calls at once in two running copies: the insert that does nothing on conflict makes one row and one email", s2.log!.rows.size === 1 && s2.mail.sent.length === 1, { rows: s2.log!.rows.size, mail: s2.mail.sent.length });
}

// ---------- last seen ----------
{
  const s = setup(), t = await tok(SAM);
  await s.call(t);
  const row = () => s.log!.only()[0];
  const calls0 = s.log!.calls.length;
  clock.now = T0 + 1 * MIN; await s.call(t);
  clock.now = T0 + 4 * MIN; await s.call(t);
  ok("calls within a few minutes don't reach the database at all", s.log!.calls.length === calls0 && row().last_seen_at === new Date(T0).toISOString(), s.log!.calls);
  clock.now = T0 + 6 * MIN; await s.call(t);
  ok("after a few minutes, a call moves last seen and nothing else", row().last_seen_at === new Date(T0 + 6 * MIN).toISOString() && row().first_seen_at === new Date(T0).toISOString() && s.mail.sent.length === 1 && s.log!.calls.slice(calls0).join() === "add,touch", s.log!.calls.slice(calls0));
  clock.now = T0 + 8 * MIN; await s.call(t, { seen: new Map() });
  ok("another running copy can't move it again within a few minutes either: the update only touches an older last seen", row().last_seen_at === new Date(T0 + 6 * MIN).toISOString());
  clock.now = T0 + 12 * MIN; await s.call(t, { seen: new Map() });
  ok("and moves it once that time has passed", row().last_seen_at === new Date(T0 + 12 * MIN).toISOString());
  ok("a later call never trims or sends again", s.log!.calls.filter((c) => c === "trim").length === 1 && s.mail.sent.length === 1);
  ok("last seen moves at most every five minutes", SIGNIN_TOUCH_MS === 5 * MIN);
  clock.now = T0;
}

// ---------- who is emailed ----------
{
  const s = setup();
  await s.call(await tok("OWNER@example.com"));
  ok("an admin's own sign-in is recorded, as Corp Dev, but never emailed", s.log!.rows.size === 1 && s.log!.only()[0].role === "corpdev" && s.log!.only()[0].email === OWNER && s.log!.only()[0].notice === "not_needed" && s.mail.sent.length === 0, s.log!.only());
  await s.call(await tok(SAM));
  const r = s.log!.only().find((x) => x.email === SAM)!;
  ok("a reader's sign-in is recorded as a reader and marked sent once the email went", r.role === "reader" && r.notice === "sent" && s.mail.sent.length === 1);
  ok("the email goes to the admin list when SNL_NOTIFY_EMAILS isn't set", same(s.mail.sent[0].body.to, [OWNER]) && s.mail.sent[0].auth === "Bearer re_test_made_up" && s.mail.sent[0].body.from === "SNL lookup <watch@example.com>", s.mail.sent[0].body);
}
{
  const s = setup({ e: { SNL_NOTIFY_EMAILS: " Alerts@Example.com, ,alerts@example.com,second@example.com, not-an-address " } });
  await s.call(await tok(SAM));
  ok("SNL_NOTIFY_EMAILS, when set, decides who gets it: cleaned, lower case, no repeats, no junk", same(s.mail.sent[0]?.body.to, ["alerts@example.com", "second@example.com"]), s.mail.sent[0]?.body.to);
  ok("a SNL_NOTIFY_EMAILS with no real address falls back on the admin list", same(noticeRecipients(env({ SNL_NOTIFY_EMAILS: " , nope", SNL_ADMIN_EMAILS: "a@example.com,B@example.com" })), ["a@example.com", "b@example.com"]));
  ok("at most ten recipients", noticeRecipients(env({ SNL_NOTIFY_EMAILS: Array.from({ length: 15 }, (_, i) => `p${i}@example.com`).join(",") })).length === MAX_NOTIFY && MAX_NOTIFY === 10);
}
for (const v of ["off", "OFF", " Off "]) {
  const s = setup({ e: { SNL_SIGNIN_NOTICES: v } });
  const r = await s.call(await tok(SAM));
  ok(`SNL_SIGNIN_NOTICES=${JSON.stringify(v)}: no email, the sign-in is still recorded (marked off)`, r.res.status === 200 && s.mail.sent.length === 0 && s.log!.only()[0]?.notice === "off");
}
{
  const s = setup({ e: { SNL_SIGNIN_NOTICES: "on" } });
  await s.call(await tok(SAM));
  ok("any other value of SNL_SIGNIN_NOTICES leaves notices on", s.mail.sent.length === 1);
}
{
  const s = setup({ e: { RESEND_API_KEY: "" } });
  const r = await s.call(await tok(SAM));
  ok("without RESEND_API_KEY: no email, nothing fails, the sign-in is recorded as not set up", r.res.status === 200 && s.mail.sent.length === 0 && s.mail.other.length === 0 && s.log!.only()[0]?.notice === "not_set_up");
  const n = setup({ e: { SNL_ADMIN_EMAILS: "", SNL_NOTIFY_EMAILS: "" } });
  await n.call(await tok(SAM));
  ok("with no one to send to: no email, recorded as not set up", n.mail.sent.length === 0 && n.log!.only()[0]?.notice === "not_set_up");
}

// ---------- the email ----------
{
  const s = setup();
  const t = await tok(SAM);
  await s.call(t);
  const m = s.mail.sent[0].body;
  ok("the subject says who signed in", m.subject === "SNL lookup: sam.reader@example.com signed in", m.subject);
  ok("the text says who, when in UTC, and that it was through Cloudflare sign-on", m.text.startsWith("sam.reader@example.com signed in to SNL lookup through Cloudflare sign-on on 13 Nov at 12:00 UTC, as a reader.") && /SNL_SIGNIN_NOTICES=off/.test(m.text), m.text);
  ok("plain text and simple HTML", typeof m.html === "string" && m.html.startsWith("<p><b>sam.reader@example.com</b> signed in") && !/<script|<img|<a /i.test(m.html), m.html);
  const all = JSON.stringify(m);
  ok("the email holds no token, no key, no IP address and nothing about what the person did", !all.includes(t) && !all.includes(t.split(".")[1]) && !all.includes(t.split(".")[2]) && !all.includes("re_test_made_up") && !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(all) && !/country|made-up-nonce|00000000-made-up-sub|search|filing|question/i.test(all), all);
  ok("no em dashes in the email", !/—/.test(all));
  const row = s.log!.only()[0];
  ok("the row holds exactly the email, role, first and last seen, the session key and the notice", same(Object.keys(row).sort(), ["email", "first_seen_at", "last_seen_at", "notice", "role", "session_key"]) && !JSON.stringify(row).includes(t.split(".")[1]) && !JSON.stringify(row).includes("re_test"));
  ok("the email call has its own short time limit", s.mail.sent[0].signal instanceof AbortSignal && SIGNIN_MAIL_MS <= 3000);
}
{
  const odd = "o'neil&co<x>@example.com";
  const m = noticeEmail({ email: odd, role: "reader" }, T0);
  ok("every value in the HTML is escaped", m.html!.includes("<b>o&#39;neil&amp;co&lt;x&gt;@example.com</b>") && !m.html!.includes(odd) && !/<x>/.test(m.html!), m.html);
  ok("the subject and text keep the address as it is, on one line", m.subject === `SNL lookup: ${odd} signed in` && m.text.startsWith(odd) && !/[\r\n]/.test(noticeEmail({ email: "a\r\nBcc: x@example.com", role: "reader" }, T0).subject));
  ok("the time is written plainly in UTC, with the year only when it isn't this year", whenUtc(Date.parse("2026-11-05T14:20:00Z"), T0) === "5 Nov at 14:20 UTC" && whenUtc(Date.parse("2025-12-31T23:05:00Z"), T0) === "31 Dec 2025 at 23:05 UTC");
}

// ---------- never fails or slows a sign-in ----------
const baseline = await (async () => { const s = setup({ log: null }); return await s.call(await tok(SAM)); })();
for (const mode of ["fail", "throw"] as const) {
  const s = setup(); s.mail.mode = mode;
  const r = await s.call(await tok(SAM));
  ok(`Resend ${mode === "fail" ? "refusing" : "not answering"}: the sign-in still succeeds and the row says the email failed`, r.res.status === 200 && same(Object.keys(r.body), Object.keys(baseline.body)) && s.log!.only()[0].notice === "failed");
}
{
  const s = setup(); s.mail.mode = "hang";
  const handed: Promise<unknown>[] = [];
  const t0 = performance.now();
  const r = await s.call(await tok(SAM), { background: (w) => { handed.push(w); } });
  const took = performance.now() - t0;
  ok("Resend hanging, with background work (Supabase): the sign-in answers at once and the work carries on after", r.res.status === 200 && took < 500 && handed.length === 1, took);
  await handed[0];
  ok("the hanging email is given up after its time limit and marked failed", s.log!.only()[0].notice === "failed");
}
{
  const s = setup(); s.mail.mode = "hang";
  const t0 = performance.now();
  const r = await s.call(await tok(SAM), { recordWaitMs: 300 });
  const took = performance.now() - t0;
  ok("Resend hanging, without background work: the sign-in waits no longer than its limit", r.res.status === 200 && took >= 250 && took < 1500, took);
  ok("that limit is three seconds at most", SIGNIN_WAIT_MS <= 3000 && SIGNIN_MAIL_MS <= 3000);
  const d = setup(); d.mail.mode = "hang";
  const t1 = performance.now();
  const r2 = await d.call(await tok(SAM));
  const took2 = performance.now() - t1;
  ok("with the real limits, a hanging Resend holds a sign-in up by about three seconds at most", r2.res.status === 200 && took2 < SIGNIN_WAIT_MS + 800, took2);
}
for (const fail of ["missing", "down", "touch", "notice", "trim"] as const) {
  const s = setup(); s.log!.fail = fail;
  said.length = 0;
  const t = await tok(SAM);
  const r = await s.call(t);
  clock.now = T0 + 6 * MIN; const r2 = await s.call(t); clock.now = T0;
  ok(`the record failing (${fail}) never fails a sign-in`, r.res.status === 200 && r2.res.status === 200 && same(Object.keys(r.body), Object.keys(baseline.body)) && r.body.profile.email === SAM);
  ok(`(${fail}) the log says what failed, never the address, the token or the error's text`, said.length > 0 && said.every((l) => l.startsWith("snl-signin: ") && !l.includes("@") && !l.includes(t.slice(0, 20))), said);
}
{
  const s = setup(); s.log!.fail = "missing";
  said.length = 0;
  const r = await s.call(await tok(SAM));
  ok("before migration 0011 is run: the sign-in answers exactly as without the record, and no email is sent", r.res.status === 200 && same(Object.keys(r.body).sort(), Object.keys(baseline.body).sort()) && same(r.body.profile, baseline.body.profile) && s.mail.sent.length === 0);
  ok("and the log says to run the migration", said.some((l) => l === "snl-signin: sign-in not recorded (migration 0011 not run)"), said);
  ok("a missing table is told from other failures", missingSignins(new Error("relation \"public.snl_signins\" does not exist")) && missingSignins("PGRST205 Could not find the table 'public.snl_signins' in the schema cache") && !missingSignins(new Error("relation \"public.snl_jobs\" does not exist")) && !missingSignins(new Error("timeout")));
}
{
  const s = setup();
  const r = await s.call(await kit.token({ claims: { exp: SEC0 - 1 } }));
  ok("a refused sign-in records nothing and emails no one", r.res.status === 401 && s.log!.calls.length === 0 && s.mail.sent.length === 0);
}
{
  const s = setup({ log: null });
  const r = await s.call(await tok(SAM));
  ok("outside Supabase (no record): sign-in as today, no email", r.res.status === 200 && s.mail.sent.length === 0);
}

// ---------- 90 days ----------
{
  const s = setup();
  const old = { session_key: "a".repeat(64), email: "old@example.com", role: "reader" as const, first_seen_at: new Date(T0 - 95 * DAY).toISOString(), last_seen_at: new Date(T0 - 91 * DAY).toISOString(), notice: "sent" as Notice };
  const recent = { ...old, session_key: "b".repeat(64), email: "recent@example.com", last_seen_at: new Date(T0 - 89 * DAY).toISOString() };
  s.log!.rows.set(old.session_key, old); s.log!.rows.set(recent.session_key, recent);
  await s.call(await tok(SAM));
  ok("a new sign-in clears rows not seen for 90 days and keeps the rest", !s.log!.rows.has(old.session_key) && s.log!.rows.has(recent.session_key) && s.log!.rows.size === 2 && SIGNIN_KEEP_DAYS === 90);
}

// ---------- the status action ----------
{
  const status = async (who: any, o: { e?: Record<string, string>; log?: SigninLog | null } = {}) => {
    const res: Response = await fn.handle(new Request("https://x.supabase.co/functions/v1/snl-signin", { method: "POST", headers: { Authorization: "Bearer u", apikey: "k", "content-type": "application/json" }, body: JSON.stringify({ action: "status" }) }),
      { env: env({ ...BASE, ...(o.e ?? {}) }), fetch: resend().fetch, whoIs: who, log: o.log === undefined ? memoryLog() : o.log });
    return { res, body: await res.json() };
  };
  const a = await status(corpdev, { e: { SNL_NOTIFY_EMAILS: "alerts@example.com,second@example.com" } });
  ok("status for Corp Dev: recorded, notices on, how many recipients", a.res.status === 200 && same(a.body, { recorded: true, notices: { on: true, why: null, recipients: 2, fromSet: true }, keepDays: 90 }), a.body);
  ok("status never names an address or a key", !JSON.stringify(a.body).includes("@") && !JSON.stringify(a.body).includes("re_test"));
  ok("status refuses readers", (await status(reader)).res.status === 403 && (await status(reader)).body.error === "forbidden");
  ok("status refuses a caller who isn't signed in", (await status(nobody)).res.status === 401);
  const miss = memoryLog(); miss.fail = "missing";
  ok("status before migration 0011: not recorded", (await status(corpdev, { log: miss })).body.recorded === false);
  ok("status outside Supabase: not recorded", (await status(corpdev, { log: null })).body.recorded === false);
  const down = memoryLog(); down.fail = "down";
  ok("status when the database can't be asked: can't tell (null)", (await status(corpdev, { log: down })).body.recorded === null);
  ok("status says notices are off and why: switched off, no key, no one to send to", (await status(corpdev, { e: { SNL_SIGNIN_NOTICES: "off" } })).body.notices.why === "off"
    && (await status(corpdev, { e: { RESEND_API_KEY: "" } })).body.notices.why === "no_key" && (await status(corpdev, { e: { SNL_ADMIN_EMAILS: "" } })).body.notices.why === "no_recipients"
    && (await status(corpdev, { e: { SNL_ADMIN_EMAILS: "" } })).body.notices.on === false);
  ok("status says when WATCH_FROM is missing", (await status(corpdev, { e: { WATCH_FROM: "" } })).body.notices.fromSet === false);
  ok("the notice setting reads off before a missing key", same(noticeSetting(env({ SNL_SIGNIN_NOTICES: "off" })).why, "off"));
}

// ---------- the watchlist's email is unchanged ----------
{
  const m = resend();
  const r = await sendEmail(m.fetch, env({ RESEND_API_KEY: "re_k", WATCH_FROM: "W <w@example.com>" }), ["a@example.com"], { subject: "S", text: "T" });
  ok("an email without HTML is sent exactly as the watchlist always sent it: from, to, subject and text", same(m.sent[0].body, { from: "W <w@example.com>", to: ["a@example.com"], subject: "S", text: "T" }) && m.sent[0].signal === null && same(r, { sent: 1 }));
  m.mode = "fail";
  ok("its failure message is unchanged", same(await sendEmail(m.fetch, env({ RESEND_API_KEY: "re_k" }), ["a@example.com"], { subject: "S", text: "T" }), { error: "The email couldn't be sent: Resend answered 500. Check RESEND_API_KEY and WATCH_FROM on Supabase." }));
  ok("the watchlist uses the same shared sender and address", watch.sendEmail === sendEmail && watch.RESEND_URL === RESEND_URL && RESEND_URL === "https://api.resend.com/emails");
}

// ---------- the real record: the calls supabase-js 2.119.0 makes ----------
{
  const calls: { method: string; path: string; auth: string; prefer: string; body: any }[] = [];
  let missing = false;
  const fake = (async (input: Request | URL | string, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), init);
    const u = new URL(r.url), text = r.method === "GET" || r.method === "HEAD" ? "" : await r.text();
    calls.push({ method: r.method, path: decodeURIComponent(u.pathname + u.search), auth: r.headers.get("authorization") ?? "", prefer: r.headers.get("prefer") ?? "", body: text ? JSON.parse(text) : null });
    if (missing) return J({ code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.snl_signins' in the schema cache" }, 404);
    if (r.method === "POST") return J(calls.filter((c) => c.method === "POST").length === 1 ? [{ session_key: "c".repeat(64) }] : [], 201);
    return J([], 200);
  }) as unknown as typeof fetch;
  ok("the real record needs Supabase's address and service key", supabaseSigninLog(env({}), fake) === null);
  const real = supabaseSigninLog(env({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key-made-up" }), fake)!;
  const row: SigninRow = { session_key: "c".repeat(64), email: SAM, role: "reader", first_seen_at: new Date(T0).toISOString(), last_seen_at: new Date(T0).toISOString(), notice: "pending" };
  const first = await real.add(row), second = await real.add(row);
  const post = calls[0];
  ok("add: an insert that does nothing on conflict of the session key, returning what it added", post.method === "POST" && post.path.startsWith("/rest/v1/snl_signins?") && post.path.includes("on_conflict=session_key") && /resolution=ignore-duplicates/.test(post.prefer) && /return=representation/.test(post.prefer) && same(post.body, row), post);
  ok("add: true when this call added the row, false when it was there already", first === true && second === false);
  await real.touch("c".repeat(64), "2026-11-13T12:06:00.000Z", "2026-11-13T12:01:00.000Z");
  const patch = calls[calls.length - 1];
  ok("touch: one update of last seen, only for this session and only when older", patch.method === "PATCH" && patch.path.includes("session_key=eq." + "c".repeat(64)) && patch.path.includes("last_seen_at=lt.2026-11-13T12:01:00.000Z") && same(patch.body, { last_seen_at: "2026-11-13T12:06:00.000Z" }), patch);
  await real.setNotice("c".repeat(64), "sent");
  ok("notice: an update of the notice for this session", same(calls[calls.length - 1].body, { notice: "sent" }) && calls[calls.length - 1].method === "PATCH");
  await real.dropOld("2026-08-15T12:00:00.000Z");
  const del = calls[calls.length - 1];
  ok("trim: a delete of rows last seen before the cut-off", del.method === "DELETE" && del.path.includes("last_seen_at=lt.2026-08-15T12:00:00.000Z"), del);
  ok("present: true when the table answers", (await real.present()) === true);
  ok("every call uses the service key", calls.every((c) => c.auth === "Bearer service-key-made-up"), calls.map((c) => c.auth));
  missing = true;
  ok("present: false when the table isn't there (migration 0011 not run)", (await real.present()) === false);
  let thrown: unknown = null; try { await real.add(row); } catch (e) { thrown = e; }
  ok("add before the migration throws an error that reads as a missing table", missingSignins(thrown));
}

console.error = keepErr;
done();
