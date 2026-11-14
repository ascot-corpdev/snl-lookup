// The watchlist check (supabase/functions/snl-watch and _shared/watch.ts): who may run it and the scheduler's
// secret, the first check as the starting point, later checks finding exactly the new filings, nothing new, the
// budget refusal before any request, S&P not set up, switched off, failed checks recorded with their reason, old
// findings cleared, the email (with a fake Resend), a hostile watchlist document, and the throttle and counter.
// Every company, id and filing here is made up.
(globalThis as any).__SNL_TEST__ = true;
const watchFn = await import(new URL("../../supabase/functions/snl-watch/index.ts", import.meta.url).href);
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { type FoundFiling, supabaseDb, type WatchRun } from "../../supabase/functions/_shared/db.ts";
import { forgetTokens, NOT_CONFIGURED } from "../../supabase/functions/_shared/spgmi.ts";
import {
  BUSY, isEmail, MAX_CHECK_COMPANIES, NOTHING_WATCHED, parseWatchlist, RESEND_URL, sameSecret, siteUrl, STOPPED, SWITCHED_OFF, tooBig,
  WATCH_MAX_REQUESTS, WATCH_STALE_MS, watchCost, watchEmail,
} from "../../supabase/functions/_shared/watch.ts";
import { checks, corpdev, env, fakeClock, J, memoryDb, nobody, reader } from "./helpers/fakes.ts";
import { filing, spPage, spStub } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SECRET = "made-up-watch-secret-0123456789abcdef";
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", WATCH_SECRET: SECRET };
const DAY = 86_400_000;
const FV = (i: number) => `0C0C0C0C-0000-4000-8000-${String(i).padStart(12, "0")}`;
const CO = (id: number, name: string) => ({ kind: "companyId", id: String(id), name });
const LIST = { enabled: true, companies: [CO(9100001, "Calloway Insurance Co"), CO(9200001, "Tarrow Mutual Insurance Co")], states: ["FL", "GA"], recipients: ["corpdev1@example.com"] };
/** A made-up filing published `ago` days before the test clock's day. */
const F = (i: number, ago: number, over: Record<string, unknown> = {}) => filing(i, { filingVersionId: FV(i), publishDate: new Date(Date.parse("2026-11-13") - ago * DAY).toISOString().slice(0, 10), ...over });
type Rows = Record<string, unknown>[];
type W = ReturnType<typeof world>;
const tables = (db: unknown) => db as { runs: WatchRun[]; found: Map<string, FoundFiling> };

/** A made-up S&P that answers searches from `rows` the way S&P filters them, a fake Resend, and the in-memory db. */
function world(secrets: Record<string, string> = SECRETS, rows: Rows = []) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  const state = { rows, searchFail: 0, totalPages: 0 as number, slow: 0, mail: [] as { url: string; auth: string | null; body: any }[], mailStatus: 200 };
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") return J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }, { row: [2, "Pending"] }] });
    if (state.slow) clock.now += state.slow;
    if (state.searchFail) { state.searchFail--; return J({ status: 500, timestamp: "2026-11-13T12:00:00Z", requestId: "req-watch-1", error: "Error", message: "Unknown Error" }, 500); }
    const p = call.body.properties;
    const hit = state.rows.filter((r) => ((p.companyId ?? []).includes(r.companyId) || (p.institutionId ?? []).includes(r.institutionId))
      && p.serffFilingStateId.includes(r.serffFilingStateId) && p.filingStatusId.includes(r.filingStatusId)
      && String(r.publishDate) >= p.minPublishDate && String(r.publishDate) <= p.maxPublishDate
      && (!p.typeOfInsuranceId || p.typeOfInsuranceId.includes(r.typeOfInsuranceId)) && (!p.serffFilingTypeId || p.serffFilingTypeId.includes(r.serffFilingTypeId)));
    if (state.totalPages) return J(spPage([F(5000 + p.pageNumber, 1)], { totalPages: state.totalPages, currentPage: p.pageNumber }));
    return J(spPage(hit, { totalPages: 1, currentPage: 1 }));
  });
  const mailFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    state.mail.push({ url: String(input), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return J(state.mailStatus === 200 ? { id: "email-test-1" } : { message: "made-up refusal" }, state.mailStatus);
  }) as typeof fetch;
  const deps = { env: env(secrets), fetch: sp.fetch, mailFetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const send = async (r: Request, over: Record<string, unknown> = {}) => { const res: Response = await watchFn.handle(r, { ...deps, ...over }); return { status: res.status, body: await res.json() }; };
  const call = (body: unknown, over: Record<string, unknown> = {}) =>
    send(new Request("https://x.supabase.co/functions/v1/snl-watch", { method: "POST", headers: { Authorization: "Bearer u", apikey: "k" }, body: JSON.stringify(body) }), over);
  const cron = (secret: string | null, body: unknown = { action: "run" }, over: Record<string, unknown> = {}) =>
    send(new Request("https://x.supabase.co/functions/v1/snl-watch", { method: "POST", headers: { "Content-Type": "application/json", ...(secret === null ? {} : { "x-watch-secret": secret }) }, body: body === undefined ? undefined : JSON.stringify(body) }), over);
  const setList = (doc: unknown) => db.settings.set("watchlist", structuredClone(doc) as Record<string, unknown>);
  const searches = () => sp.calls("/api/v1/search");
  return { clock, db, sp, state, deps, call, cron, setList, searches, runs: tables(db).runs, found: tables(db).found };
}
const run = (w: W, over: Record<string, unknown> = {}) => w.call({ action: "run" }, over);
const status = (w: W, over: Record<string, unknown> = {}) => w.call({ action: "status" }, over);
const START_ROWS = () => [F(1, 2), F(2, 10, { companyId: 9200001, institutionId: 820001, companyName: "Tarrow Mutual Insurance Co", serffFilingStateId: "GA" }), F(3, 13), F(4, 20), F(5, 3, { serffFilingStateId: "TX" }), F(6, 1, { companyId: 9300001, companyName: "Nonesuch Insurance Co" })];

// ---------- who may run a check, and the scheduler's secret ----------
{
  const w = world(SECRETS, START_ROWS());
  w.setList(LIST);
  ok("no login and no secret: asked to sign in", (await w.call({ action: "run" }, { whoIs: nobody })).status === 401 && w.sp.log.length === 0);
  const r = await run(w, { whoIs: reader });
  ok("a reader can't run a check", r.status === 403 && r.body.message === "Only Corp Dev logins can run a check. Once it is set up, it runs by itself every day." && w.sp.log.length === 0 && w.runs.length === 0, r.body);
  const s = await status(w, { whoIs: reader });
  ok("a reader can see the status", s.status === 200 && s.body.role === "reader" && s.body.enabled === true && s.body.watchlist.companies.length === 2, s.body);
  const c = await run(w);
  ok("a Corp Dev login can check now", c.status === 200 && c.body.run.status === "ok" && w.runs.length === 1 && w.runs[0].trigger === "manual", c.body);
  ok("unknown actions are refused", (await w.call({ action: "delete" })).status === 400);

  const bad = await w.cron("made-up-wrong-secret-0123456789abcdef");
  ok("the scheduler with the wrong secret is refused, and nothing runs", bad.status === 403 && bad.body.error === "secret" && w.runs.length === 1, bad.body);
  ok("a secret one character short is refused", (await w.cron(SECRET.slice(0, -1))).status === 403 && (await w.cron(SECRET + "x")).status === 403 && (await w.cron("")).status === 403 && w.runs.length === 1);
  w.clock.now += DAY;
  const good = await w.cron(SECRET);
  ok("the scheduler with the right secret runs a check, without a login", good.status === 200 && good.body.run.status === "ok" && w.runs.length === 2 && w.runs.at(-1)!.trigger === "schedule", good.body);
  w.clock.now += DAY;
  const bare = await w.cron(SECRET, undefined);
  ok("the scheduler may send no body at all: a run is meant", bare.status === 200 && bare.body.run.status === "ok" && w.runs.length === 3, bare.body);
  ok("the scheduler can't ask for the status", (await w.cron(SECRET, { action: "status" })).status === 400);
  ok("the secret path never asks who the caller is", (await w.cron(SECRET, { action: "run" }, { whoIs: () => { throw new Error("whoIs called"); } })).status === 200);

  const off = world({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" });
  off.setList(LIST);
  const n = await off.cron(SECRET);
  ok("without WATCH_SECRET, scheduler calls are refused, whatever they send", n.status === 403 && n.body.message === watchFn.NO_SECRET && off.runs.length === 0 && off.sp.log.length === 0, n.body);
  ok("without WATCH_SECRET, an empty secret header is refused too", (await off.cron("")).status === 403 && off.runs.length === 0);
  const short = world({ ...SECRETS, WATCH_SECRET: "too-short" });
  ok("a WATCH_SECRET under 24 characters counts as unset", (await short.cron("too-short")).status === 403 && short.runs.length === 0);
  ok("Check now still works for Corp Dev without WATCH_SECRET", (await run(off)).body.run.status === "ok");

  ok("secrets are compared whole: equal", sameSecret("abc", "abc") && !sameSecret("abc", "abd") && !sameSecret("abc", "abcd") && !sameSecret("", "a") && sameSecret("", ""));
  ok("the function's CORS headers don't let a browser send the secret header", !(await watchFn.handle(new Request("https://x.supabase.co/functions/v1/snl-watch", { method: "OPTIONS" }), w.deps)).headers.get("access-control-allow-headers")!.includes("x-watch-secret"));
}

// ---------- the first check is the starting point; later checks find exactly the new filings ----------
{
  const w = world({ ...SECRETS, RESEND_API_KEY: "re_test", SITE_URL: "https://example.github.io/snl/" }, START_ROWS());
  w.setList(LIST);
  const first = await run(w);
  const b = first.body.run;
  ok("first check: recorded, nothing reported as new", b.status === "ok" && b.baseline === true && b.newCount === 0 && b.found === 3 && b.complete === true, b);
  ok("first check: only filings in the last 14 days, for watched companies and states", same([...w.found.keys()].sort(), [FV(1), FV(2), FV(3)]), [...w.found.keys()]);
  ok("first check: every one is marked as the starting point", [...w.found.values()].every((r) => r.baseline === true && r.run_id === w.runs[0].id));
  ok("first check: says what happened in plain words", b.message === "First check: 3 filings published in the last 14 days were recorded as the starting point. From the next check, only filings that appear after this show as new.", b.message);
  ok("first check: no email", w.state.mail.length === 0);
  const sr = w.searches();
  ok("one search for both companies, the last 14 days, every state watched and every status", sr.length === 1 && same(sr[0].body.properties.companyId, [9100001, 9200001]) && sr[0].body.properties.minPublishDate === "2026-10-31" && sr[0].body.properties.maxPublishDate === "2026-11-13" && same(sr[0].body.properties.serffFilingStateId, ["FL", "GA"]) && same(sr[0].body.properties.filingStatusId, [1, 2]), sr.map((c) => c.body));
  ok("first check: one sign-in, S&P's list of statuses, one search", b.requests === 3 && w.sp.log.length === 3 && first.body.used.hour === 3, { b, log: w.sp.log.map((c) => c.path) });
  const kept = w.found.get(FV(1))!;
  ok("a found filing keeps what the page needs to show and open it", same(kept.companies, ["Calloway Insurance Co"]) && kept.state === "FL" && kept.filing_type === "Form" && kept.type_of_insurance === "Homeowners" && kept.filing_status === "Closed - Approved"
    && kept.publish_date === "2026-11-11" && kept.date_submitted === "2026-01-10" && kept.effective_new === "2026-05-01" && kept.tracking_number === "TEST-000001" && kept.document_id === 71000001 && kept.filing_version_id === FV(1) && kept.first_seen_at.startsWith("2026-11-13T12:00:"), kept);
  const st0 = await status(w);
  ok("status after the first check: the check, and no new filings", st0.body.lastRun.status === "ok" && st0.body.lastRun.baseline === true && st0.body.lastCheck.requests === 3 && same(st0.body.found, []) && st0.body.running === false && st0.body.lastRun.scope === null, st0.body);

  // a day later: two new filings, and the old ones again
  w.clock.now += DAY;
  w.state.rows.push(F(7, 0, { filingDescription: "Made-up homeowners form update.\nSecond line." }), F(8, 0, { companyId: 9200001, companyName: "Tarrow Mutual Insurance Co", serffFilingStateId: "GA", serffFilingType: "Rate", trackingNumber: "TARR-GA-0008", documentId: null }));
  const second = (await run(w)).body.run;
  ok("a later check finds exactly the new filings", second.status === "ok" && second.newCount === 2 && second.baseline === false && second.found === 4 && second.message === "Found 2 new filings.", second);
  ok("the new ones are recorded as new; the old ones aren't recorded twice", w.found.size === 5 && w.found.get(FV(7))!.baseline === false && w.found.get(FV(8))!.baseline === false && w.found.get(FV(1))!.run_id === w.runs[0].id);
  ok("a later check costs one request: the sign-in and the list of statuses are reused", second.requests === 1, second);
  const st1 = await status(w);
  ok("status lists the new filings, the latest first, and not the starting point", same(st1.body.found.map((r: FoundFiling) => r.filing_version_id).sort(), [FV(7), FV(8)]) && st1.body.lastRun.new_count === 2, st1.body.found);
  ok("one email to the watchlist's recipients", w.state.mail.length === 1 && w.state.mail[0].url === RESEND_URL && w.state.mail[0].auth === "Bearer re_test" && same(w.state.mail[0].body.to, ["corpdev1@example.com"]) && second.emailed === 1, w.state.mail);
  const mail = w.state.mail[0].body;
  ok("the email: subject says how many", mail.subject === "SNL lookup: 2 new filings on the watchlist", mail.subject);
  ok("the email lists company, state, filing type, a line of description and the tracking number", mail.text.includes("- Calloway Insurance Co, FL, Form: Made-up homeowners form update. Second line. (tracking number TEST-000007)") && mail.text.includes("- Tarrow Mutual Insurance Co, GA, Rate: Made-up filing 8. (tracking number TARR-GA-0008)"), mail.text);
  ok("the email links to the app", mail.text.includes("Open SNL lookup to see the details and the documents: https://example.github.io/snl/"));
  ok("the email is plain text, with nothing else from S&P in it", mail.html === undefined && !mail.text.includes("71000007") && !mail.text.includes(FV(7)) && !mail.text.includes("Homeowners") && !mail.text.includes("Closed - Approved"), mail.text);

  // and again: nothing new
  w.clock.now += DAY;
  const third = (await run(w)).body.run;
  ok("nothing new: said as nothing new, never as no filings", third.status === "ok" && third.newCount === 0 && third.message === "Nothing new since the last check." && third.found === 4, third);
  ok("nothing new: no email", w.state.mail.length === 1);
  ok("status still shows what earlier checks found", (await status(w)).body.found.length === 2);

  // a company added later: what it already has is its starting point, not new
  w.clock.now += DAY;
  w.setList({ ...LIST, companies: [...LIST.companies, CO(9300001, "Nonesuch Insurance Co")] });
  const fourth = (await run(w)).body.run;
  ok("a newly added company's recent filings are its starting point, not new", fourth.newCount === 0 && w.found.get(FV(6))!.baseline === true && fourth.message === "Nothing new since the last check. 1 filing for newly added companies, states or filters was recorded as the starting point, not as new.", fourth);
  ok("no email for a starting point", w.state.mail.length === 1);
  w.clock.now += DAY;
  w.state.rows.push(F(9, 0, { companyId: 9300001, companyName: "Nonesuch Insurance Co" }));
  const fifth = (await run(w)).body.run;
  ok("after that, its new filings are new", fifth.newCount === 1 && w.found.get(FV(9))!.baseline === false && w.state.mail.length === 2, fifth);

  // a state added later, and a filter changed
  w.clock.now += DAY;
  w.state.rows.push(F(10, 0, { serffFilingStateId: "TX" }));
  w.setList({ ...LIST, companies: [...LIST.companies, CO(9300001, "Nonesuch Insurance Co")], states: ["FL", "GA", "TX"] });
  const sixth = (await run(w)).body.run;
  ok("a newly added state's filings are its starting point too", sixth.newCount === 0 && w.found.get(FV(10))!.baseline === true && w.found.get(FV(5))!.baseline === true, sixth);
  w.clock.now += DAY;
  w.state.rows.push(F(11, 0));
  w.setList({ ...LIST, companies: [...LIST.companies, CO(9300001, "Nonesuch Insurance Co")], states: ["FL", "GA", "TX"], typeOfInsuranceIds: [4] });
  const seventh = (await run(w)).body.run;
  ok("changing the filters makes the next check a starting point, so nothing floods in", seventh.newCount === 0 && w.found.get(FV(11))!.baseline === true, seventh);
  ok("the filter is sent to S&P", same(w.searches().at(-1)!.body.properties.typeOfInsuranceId, [4]));
}

// ---------- the email: only in the right cases ----------
{
  const scenario = async (secrets: Record<string, string>, list: Record<string, unknown>) => {
    const w = world({ ...SECRETS, ...secrets }, START_ROWS());
    w.setList(list);
    await run(w);
    w.clock.now += DAY;
    w.state.rows.push(F(20, 0));
    const r = (await run(w)).body.run;
    return { w, r };
  };
  let s = await scenario({}, LIST);
  ok("no RESEND_API_KEY: no email, and the check is fine", s.r.newCount === 1 && s.w.state.mail.length === 0 && s.r.emailed === 0 && s.r.message === "Found 1 new filing.", s.r);
  s = await scenario({ RESEND_API_KEY: "re_test" }, { ...LIST, recipients: [] });
  ok("no recipients: no email", s.r.newCount === 1 && s.w.state.mail.length === 0);
  s = await scenario({ RESEND_API_KEY: "re_test", WATCH_FROM: "SNL lookup <watch@example.com>", ALLOWED_ORIGIN: "https://example.github.io/snl/,http://localhost:8000" }, { ...LIST, recipients: ["a@example.com", "b@example.com"] });
  ok("one email to all recipients, from WATCH_FROM", s.w.state.mail.length === 1 && same(s.w.state.mail[0].body.to, ["a@example.com", "b@example.com"]) && s.w.state.mail[0].body.from === "SNL lookup <watch@example.com>" && s.r.emailed === 2, s.w.state.mail);
  ok("without SITE_URL the link is the first address in ALLOWED_ORIGIN", s.w.state.mail[0].body.text.includes("https://example.github.io/snl/"));
  const w = world({ ...SECRETS, RESEND_API_KEY: "re_test" }, START_ROWS());
  w.setList(LIST); await run(w); w.clock.now += DAY; w.state.rows.push(F(21, 0)); w.state.mailStatus = 403;
  const r = (await run(w)).body.run;
  ok("Resend refuses: the check still succeeds and says the email wasn't sent", r.status === "ok" && r.newCount === 1 && r.emailed === 0 && r.message === "Found 1 new filing. The email couldn't be sent: Resend answered 403. Check RESEND_API_KEY and WATCH_FROM on Supabase. The new filings are on the Filings view.", r.message);
  ok("the default sender is Resend's test address", w.state.mail[0].body.from === "SNL lookup <onboarding@resend.dev>");

  ok("site address: SITE_URL first", siteUrl(env({ SITE_URL: "https://a.example/x", ALLOWED_ORIGIN: "https://b.example" })) === "https://a.example/x");
  ok("site address: only https, never a made-up scheme", siteUrl(env({ SITE_URL: "javascript:alert(1)", ALLOWED_ORIGIN: "http://b.example" })) === null && siteUrl(env({})) === null && siteUrl(env({ ALLOWED_ORIGIN: "*" })) === null);
  const many = Array.from({ length: 53 }, (_, i) => ({ companies: ["Calloway Home Co"], state: "FL", filing_type: "Form", description: "x".repeat(200), tracking_number: `T-${i}` }) as unknown as FoundFiling);
  const big = watchEmail(many, { now: Date.parse("2026-11-14T06:23:00Z"), site: null });
  ok("a long email: 50 listed, the rest counted, descriptions cut to one line", big.text.split("\n").filter((l) => l.startsWith("- Calloway")).length === 50 && big.text.includes("- and 3 more filings") && big.text.includes("x".repeat(139) + "…") && !big.text.includes("x".repeat(141)) && big.text.startsWith("The daily watchlist check on 14 Nov found 53 new filings:"), big.text.slice(0, 200));
  ok("missing values read n/d", watchEmail([{ companies: [], state: null, filing_type: null, description: null, tracking_number: null } as unknown as FoundFiling], { now: 0, site: null }).text.includes("- Company n/d, n/d, filing type n/d: No description (tracking number n/d)"));
}

// ---------- refused or skipped before any S&P request ----------
{
  const w = world({ WATCH_SECRET: SECRET }, START_ROWS());
  w.setList(LIST);
  const r = (await run(w)).body.run;
  ok("S&P not set up: says so, asks S&P nothing", r.status === "skipped" && r.reason === "not_configured" && r.message === NOT_CONFIGURED && w.sp.log.length === 0 && w.db.slots.length === 0, r);
  ok("S&P not set up: recorded, so the page can say so", w.runs.length === 1 && w.runs[0].status === "skipped" && w.runs[0].message === NOT_CONFIGURED);
  const s = await status(w);
  ok("status says S&P isn't set up and the check was skipped", s.body.configured === false && s.body.lastRun.status === "skipped" && s.body.lastCheck === null, s.body);

  const e = world(SECRETS, START_ROWS());
  let x = (await run(e)).body.run;
  ok("no watchlist yet: says nothing is watched, asks S&P nothing", x.status === "skipped" && x.reason === "empty" && x.message === NOTHING_WATCHED && e.sp.log.length === 0, x);
  e.setList({ ...LIST, states: [] });
  x = (await run(e)).body.run;
  ok("companies but no states: nothing to check", x.reason === "empty" && e.sp.log.length === 0);
  e.setList({ ...LIST, companies: [] });
  ok("states but no companies: nothing to check", (await run(e)).body.run.reason === "empty" && e.sp.log.length === 0);
  e.setList({ ...LIST, enabled: false });
  x = (await run(e)).body.run;
  ok("switched off: says so, asks S&P nothing", x.status === "skipped" && x.reason === "off" && x.message === SWITCHED_OFF && e.sp.log.length === 0, x);
  e.setList({ ...LIST, enabled: "yes" });
  ok("only true switches it on", (await run(e)).body.run.reason === "off" && e.sp.log.length === 0);
  ok("scheduled calls while switched off ask S&P nothing either", (await e.cron(SECRET)).body.run.reason === "off" && e.sp.log.length === 0);

  const big = world(SECRETS, START_ROWS());
  big.setList({ ...LIST, companies: Array.from({ length: 290 }, (_, i) => CO(9500000 + i, "")) });
  const t = await run(big);
  ok("too big for the budget: refused before any request, with how to shrink it", t.body.run.status === "failed" && t.body.run.reason === "too_big" && big.sp.log.length === 0 && big.db.slots.length === 0 && t.body.run.requests === 0, t.body.run);
  ok("the refusal in plain words", t.body.run.message === "The watchlist is too big to check: it needs at least 31 S&P requests (one for each batch of 10 companies, plus 2 to sign in and read S&P's list of filing statuses), more than the 30 one check may use. Remove at least 10 companies; a check covers up to 280 companies. Nothing was asked of S&P.", t.body.run.message);
  const bs = await status(big);
  ok("the refusal is recorded as the last check's reason", bs.body.lastRun.status === "failed" && bs.body.lastRun.message === t.body.run.message && bs.body.tooBig === t.body.run.message && bs.body.cost === 31 && bs.body.budget === WATCH_MAX_REQUESTS, bs.body);
  const mixed = parseWatchlist({ companies: [...Array.from({ length: 275 }, (_, i) => CO(9500000 + i, "")), ...Array.from({ length: 6 }, (_, i) => ({ kind: "institutionId", id: String(8500000 + i) }))], states: ["FL"] }).list;
  ok("the fewest companies to remove is worked out across company and institution ids", watchCost(mixed) === 31 && tooBig(mixed)!.includes("Remove at least 5 companies;"), tooBig(mixed));
  const fits = parseWatchlist({ companies: Array.from({ length: MAX_CHECK_COMPANIES }, (_, i) => CO(9500000 + i, "")), states: ["FL"] }).list;
  ok("280 companies fit exactly", MAX_CHECK_COMPANIES === 280 && watchCost(fits) === 30 && tooBig(fits) === null);
}

// ---------- failures are recorded with their reason ----------
{
  const w = world(SECRETS, START_ROWS());
  w.setList(LIST);
  w.state.searchFail = 1;   // S&P answers the search with a 500 (a 500 is not retried)
  const r = (await run(w)).body.run;
  ok("S&P fails: the check is recorded as failed, with S&P's reason", r.status === "failed" && r.reason === "server" && r.message === "S&P's service failed (500). Try again in a few minutes. S&P reference: req-watch-1." && w.runs[0].status === "failed" && w.runs[0].message === r.message, r);
  ok("a failed check records nothing as found, and how many requests it used", w.found.size === 0 && w.runs[0].requests === r.requests && r.requests === w.db.slots.length, { r, slots: w.db.slots.length });
  const s = await status(w);
  ok("status gives the failure's plain reason", s.body.lastRun.status === "failed" && s.body.lastRun.message === r.message && s.body.lastCheck === null);
  w.clock.now += DAY;
  const again = (await run(w)).body.run;
  ok("the next check after a failure is still the starting point", again.status === "ok" && again.baseline === true && again.newCount === 0, again);

  const empty = world(SECRETS, START_ROWS());
  empty.setList(LIST);
  const spNoStatus = spStub(empty.clock, (call) => call.path === "/api/v1/reference" ? J({ headers: ["filingStatusId", "filingStatus"], rows: [] }) : J(spPage([])));
  const r2 = (await run(empty, { fetch: spNoStatus.fetch })).body.run;
  ok("S&P's list of statuses empty: failed with how to fix it, no search sent", r2.status === "failed" && r2.message.startsWith("S&P's list of filing statuses came back empty") && spNoStatus.calls("/api/v1/search").length === 0, r2);

  const crash = world(SECRETS, START_ROWS());
  crash.setList(LIST);
  crash.db.addFoundFilings = async () => { throw new Error("Couldn't save the filings found: made-up fault"); };
  const r3 = (await run(crash)).body.run;
  ok("a database fault is recorded as a failed check with its reason", r3.status === "failed" && r3.message === "The check failed: Couldn't save the filings found: made-up fault. It will try again at the next check." && crash.runs[0].status === "failed", r3);

  const limit = world(SECRETS, START_ROWS());
  limit.setList(LIST);
  for (let i = 0; i < 500; i++) await limit.db.takeSlot({ hour: 500, day: 12_000 });
  const r4 = (await run(limit)).body.run;
  ok("the hour's S&P limit used up: failed with that reason, nothing sent to S&P", r4.status === "failed" && r4.reason === "limit" && r4.message.startsWith("The app stopped before asking S&P: this hour's limit of 500 S&P requests is used up.") && limit.sp.log.length === 0 && r4.requests === 0, r4);
}

// ---------- one check at a time ----------
{
  const w = world(SECRETS, START_ROWS());
  w.setList(LIST);
  const held = await w.db.startWatchRun("schedule", WATCH_STALE_MS, STOPPED);
  const r = await run(w);
  ok("a check while another runs is refused, and asks S&P nothing", r.status === 409 && r.body.error === "busy" && r.body.message === BUSY && w.sp.log.length === 0, r.body);
  ok("status shows a check running", (await status(w)).body.running === true);
  w.clock.now += WATCH_STALE_MS + 1000;
  ok("status stops showing a check that has been running too long", (await status(w)).body.running === false);
  const later = await run(w);
  ok("a check stuck for over five minutes is closed with a reason, and the new one runs", later.status === 200 && later.body.run.status === "ok" && w.runs.find((x) => x.id === held)!.status === "failed" && w.runs.find((x) => x.id === held)!.message === STOPPED, w.runs);
}

// ---------- old findings and old checks are cleared ----------
{
  const w = world(SECRETS, START_ROWS());
  w.setList(LIST);
  const old = (fv: string, days: number) => ({ filing_version_id: fv, run_id: null, first_seen_at: new Date(w.clock.now - days * DAY).toISOString(), baseline: false, companies: ["Calloway Home Co"], state: "FL", state_name: null, filing_type: "Rate", type_of_insurance: null, sub_type_of_insurance: null, filing_status: null, date_submitted: null, publish_date: null, effective_new: null, effective_renewal: null, rate_impact: null, description: null, tracking_number: null, document_id: null });
  await w.db.addFoundFilings([old("OLD-91-DAYS-0001", 91), old("KEEP-89-DAYS-001", 89)]);
  await w.db.addWatchRun({ status: "ok", trigger: "schedule", started_at: new Date(w.clock.now - 91 * DAY).toISOString(), finished_at: null, requests: 1, found: 0, new_count: 0, baseline: true, complete: true, emailed: 0, message: "old", scope: null });
  await w.db.addWatchRun({ status: "ok", trigger: "schedule", started_at: new Date(w.clock.now - 89 * DAY).toISOString(), finished_at: null, requests: 1, found: 0, new_count: 0, baseline: true, complete: true, emailed: 0, message: "kept", scope: null });
  await run(w);
  ok("found filings over 90 days old are cleared during a check; younger ones stay", !w.found.has("OLD-91-DAYS-0001") && w.found.has("KEEP-89-DAYS-001"));
  ok("checks over 90 days old are cleared too", !w.runs.some((r) => r.message === "old") && w.runs.some((r) => r.message === "kept"));
  const off = world({ WATCH_SECRET: SECRET });
  await off.db.addFoundFilings([old("OLD-91-DAYS-0002", 91)]);
  await off.cron(SECRET);
  ok("they are cleared even while S&P isn't set up", off.found.size === 0);
}

// ---------- the throttle, the counter and the budget ----------
{
  const w = world(SECRETS, START_ROWS());
  w.setList({ ...LIST, companies: [...Array.from({ length: 55 }, (_, i) => CO(9100001 + i, "")), { kind: "institutionId", id: "820001", name: "Tarrow Group" }] });
  const r = (await run(w)).body.run;
  const sizes = w.searches().map((c) => [c.body.properties.companyId ? "c" : "i", (c.body.properties.companyId ?? c.body.properties.institutionId).length]);
  ok("55 company ids and one institution id: batches of at most 10, seven S&P search requests", r.status === "ok" && same(sizes, [["c", 10], ["c", 10], ["c", 10], ["c", 10], ["c", 10], ["c", 5], ["i", 1]]) && watchCost(parseWatchlist(w.db.settings.get("watchlist")).list) === 9, sizes);
  ok("every company id is asked about exactly once", same(w.searches().flatMap((c) => c.body.properties.companyId ?? []).sort(), Array.from({ length: 55 }, (_, i) => 9100001 + i)));
  ok("every S&P request took a slot from the shared counter", w.db.slots.length === w.sp.log.length && r.requests === w.sp.log.length && (await w.db.usage()).hour === w.sp.log.length, { slots: w.db.slots.length, log: w.sp.log.length, r });
  ok("S&P requests were at least a second apart", w.db.slots.every((s, i) => i === 0 || s - w.db.slots[i - 1] >= 1000) && w.sp.log.every((c, i) => i === 0 || c.at - w.sp.log[i - 1].at >= 1000), w.sp.log.map((c) => c.at));

  const pages = world(SECRETS, START_ROWS());
  pages.setList(LIST);
  pages.state.totalPages = 100;   // S&P says there are 100 pages: the check must stop at its budget
  const p = (await run(pages)).body.run;
  ok("a check never uses more than its budget of S&P requests", p.requests === WATCH_MAX_REQUESTS && pages.sp.log.length === WATCH_MAX_REQUESTS && pages.db.slots.length === WATCH_MAX_REQUESTS, p);
  ok("a check cut short says so and is marked incomplete", p.status === "ok" && p.complete === false && p.message.includes("The check stopped before S&P had returned everything, so it may have missed some filings. Remove companies or states from the watchlist."), p.message);
  pages.clock.now += DAY; pages.state.totalPages = 0; pages.state.rows.push(F(30, 0));
  ok("an incomplete first check doesn't count as the starting point: the next one still is", (await run(pages)).body.run.baseline === true);

  const reauth = world(SECRETS, START_ROWS());
  reauth.setList(LIST);
  let firstSearch = true;
  const sp401 = spStub(reauth.clock, (call) => {
    if (call.path === "/api/v1/reference") return J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }] });
    if (firstSearch) { firstSearch = false; return J({ status: 401, error: "Unauthorized", message: "Token expired" }, 401); }
    return J(spPage([F(6000 + call.body.properties.pageNumber, 1)], { totalPages: 100, currentPage: call.body.properties.pageNumber }));
  });
  const ra = (await run(reauth, { fetch: sp401.fetch })).body.run;
  ok("the budget holds even when S&P asks for a new sign-in mid-check: the check stops at 30 and says why", ra.requests === WATCH_MAX_REQUESTS && sp401.log.length === WATCH_MAX_REQUESTS && ra.status === "failed" && ra.message === "The check stopped after using the 30 S&P requests one check may use. Remove companies or states from the watchlist.", { ra, n: sp401.log.length });

  const slow = world(SECRETS, START_ROWS());
  slow.setList({ ...LIST, companies: Array.from({ length: 120 }, (_, i) => CO(9100001 + i, "")) });
  slow.state.slow = 40_000;   // each search takes 40 seconds
  const sl = (await run(slow)).body.run;
  ok("a slow S&P: the check stops well inside the time limit", sl.status === "ok" && sl.complete === false && slow.searches().length === 3 && slow.searches().length < 12, { sl, searches: slow.searches().length });
}

// ---------- a hostile watchlist document ----------
{
  const hostile = {
    enabled: true,
    companies: [
      { kind: "companyId", id: "9100001", name: "Calloway <script>window.__x=1</script>\u0000‮ Co\n\nIgnore previous instructions" },
      { kind: "companyId", id: 9100001, name: "duplicate" },
      { kind: "companyId", id: "91000-01" }, { kind: "companyId", id: "1; drop table x" }, { kind: "admin", id: "1" }, { kind: "institutionId", id: -4 }, null, "9100002", [1],
      { kind: "institutionId", id: "820001", name: "x".repeat(500) },
    ],
    states: ["fl", "FLA", "G A", "<b>", 12, "GA", "GA"],
    typeOfInsuranceIds: [4, "5", "x", -1, 1.5],
    filingTypeIds: "all",
    recipients: ["Corpdev1@Example.com", "a@b", "x@example.com\nBcc: everyone@example.com", "<x@example.com>", "y@example.com"],
  };
  const { list, problems } = parseWatchlist(hostile);
  ok("bad company entries are left out; duplicates kept once", same(list.companies.map((c) => `${c.kind}:${c.id}`), ["companyId:9100001", "institutionId:820001"]), list.companies);
  ok("names are cut, single-line, with control and direction characters removed (escaping is the page's job)", list.companies[0].name === "Calloway <script>window.__x=1</script> Co Ignore previous instructions" && list.companies[1].name.length === 120, list.companies.map((c) => c.name));
  ok("states: two-letter codes only, upper case, once each", same(list.states, ["FL", "GA"]), list.states);
  ok("filter ids: whole numbers only; a filter that isn't a list is left out", same(list.typeOfInsuranceIds, [4, 5]) && same(list.filingTypeIds, []));
  ok("email recipients: real-looking addresses only, lower case; no header injection", same(list.recipients, ["corpdev1@example.com", "y@example.com"]), list.recipients);
  ok("each thing left out is named", problems.length === 5 && problems[0] === "7 companies were left out because their S&P id isn't a whole number." && problems.includes("4 states were left out because they aren't a two-letter code like FL.") && problems.includes("The filing types in the saved watchlist aren't a list, so they were left out.") && problems.includes("3 email addresses were left out because they don't look like an email address."), problems);
  ok("not an object at all: read as empty and switched off", same(parseWatchlist("drop table").list, { enabled: false, companies: [], states: [], typeOfInsuranceIds: [], filingTypeIds: [], recipients: [] }) && parseWatchlist([1, 2]).problems.length === 1 && parseWatchlist(null).problems.length === 0);
  const huge = parseWatchlist({ companies: Array.from({ length: 700 }, (_, i) => CO(i + 1, "")), states: Array.from({ length: 80 }, (_, i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26))), recipients: Array.from({ length: 15 }, (_, i) => `p${i}@example.com`) });
  ok("too many of anything: the first ones are used, and that is said", huge.list.companies.length === 500 && huge.list.states.length === 60 && huge.list.recipients.length === 10 && huge.problems.includes("Only the first 500 companies are used.") && huge.problems.includes("Only the first 60 states are used."), huge.problems);
  ok("email check", isEmail("a.b+c@example.co.uk") && !isEmail("a@b") && !isEmail("a @example.com") && !isEmail("a@example.com>"));

  const w = world(SECRETS, START_ROWS());
  w.setList(hostile);
  const r = await run(w);
  ok("a check with a hostile document runs on what is usable", r.status === 200 && r.body.run.status === "ok" && same(w.searches()[0].body.properties.serffFilingStateId, ["FL", "GA"]), r.body);
  const s = await status(w);
  ok("status gives the cleaned watchlist and the problems", s.body.watchlist.companies.length === 2 && s.body.problems.length === 5 && s.body.enabled === true, s.body);
  ok("a found filing's text is kept single-line and cut", (() => {
    w.state.rows.push(F(40, 0, { filingDescription: "a\u0000b\n" + "y".repeat(400), companyName: "Calloway‮ Co" }));
    return true;
  })());
  w.clock.now += DAY;
  await run(w);
  const kept = w.found.get(FV(40))!;
  ok("…description at most 300 characters, ending in an ellipsis; no control characters", kept.description!.length === 300 && kept.description!.endsWith("…") && kept.description!.startsWith("a b y") && same(kept.companies, ["Calloway Co"]), kept);
}

// ---------- the real database adapter's watchlist queries ----------
{
  type Op = { table: string; calls: unknown[][] };
  const fakeSb = (answer: (op: Op) => { data?: unknown; error?: { message: string; code?: string } | null }) => {
    const ops: Op[] = [];
    const chain = (op: Op): any => new Proxy(() => {}, {
      get: (_t, k) => (k === "then" ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => answer(op)).then((a) => ({ data: null, error: null, ...a })).then(res, rej)
        : (...args: unknown[]) => { op.calls.push([String(k), ...args]); return chain(op); }),
    });
    return { ops, client: { from: (table: string) => { const op = { table, calls: [] as unknown[][] }; ops.push(op); return chain(op); } } as unknown as SupabaseClient };
  };
  const NOW = Date.parse("2026-11-13T12:00:00Z");
  let sb = fakeSb((op) => (op.calls.some((c) => c[0] === "insert") ? { data: { id: "run-1" } } : {}));
  let id = await supabaseDb(sb.client, () => NOW).startWatchRun("manual", WATCH_STALE_MS, STOPPED);
  ok("starting a check: stuck checks are closed first, then one running row is inserted", id === "run-1" && sb.ops.length === 2 && sb.ops.every((o) => o.table === "snl_watch_runs")
    && same(sb.ops[0].calls.find((c) => c[0] === "update")![1], { status: "failed", finished_at: "2026-11-13T12:00:00.000Z", message: STOPPED }) && same(sb.ops[0].calls.find((c) => c[0] === "lt"), ["lt", "started_at", "2026-11-13T11:55:00.000Z"])
    && same(sb.ops[1].calls.find((c) => c[0] === "insert")![1], { status: "running", trigger: "manual", started_at: "2026-11-13T12:00:00.000Z" }), sb.ops);
  sb = fakeSb((op) => (op.calls.some((c) => c[0] === "insert") ? { error: { message: "duplicate key value violates unique constraint", code: "23505" } } : {}));
  id = await supabaseDb(sb.client, () => NOW).startWatchRun("schedule", WATCH_STALE_MS, STOPPED);
  ok("another check running (the unique index refuses the row): null, not an error", id === null);
  sb = fakeSb(() => ({ error: { message: "made-up fault" } }));
  let threw = "";
  try { await supabaseDb(sb.client, () => NOW).startWatchRun("schedule", WATCH_STALE_MS, STOPPED); } catch (e) { threw = (e as Error).message; }
  ok("any other failure to record a check is an error with the reason", threw === "Couldn't record the check: made-up fault", threw);
  sb = fakeSb(() => ({ data: [] }));
  await supabaseDb(sb.client, () => NOW).foundFilings(100);
  ok("new filings: only those not part of the starting point, latest first", same(sb.ops[0].calls.find((c) => c[0] === "eq"), ["eq", "baseline", false]) && same(sb.ops[0].calls.find((c) => c[0] === "order"), ["order", "first_seen_at", { ascending: false }]) && sb.ops[0].table === "snl_watch_found");
  sb = fakeSb(() => ({ data: [{ filing_version_id: "A" }] }));
  const seen = await supabaseDb(sb.client, () => NOW).seenFilings(Array.from({ length: 450 }, (_, i) => `FV${i}`));
  ok("seen filings are looked up in batches of 200", sb.ops.length === 3 && same(seen, ["A", "A", "A"]) && (sb.ops[0].calls.find((c) => c[0] === "in")![2] as string[]).length === 200);
  sb = fakeSb(() => ({}));
  await supabaseDb(sb.client, () => NOW).addFoundFilings([{ filing_version_id: "A" } as FoundFiling]);
  ok("found filings are added once: a filing seen before is left as it was", same(sb.ops[0].calls.find((c) => c[0] === "upsert")![2], { onConflict: "filing_version_id", ignoreDuplicates: true }));
  sb = fakeSb(() => ({ data: [{ scope: { companies: ["c:1"], states: ["FL"], filters: "[[],[]]" } }] }));
  const scope = await supabaseDb(sb.client, () => NOW).lastWatchScope();
  ok("the last scope comes from the latest complete, successful check", same(scope, { companies: ["c:1"], states: ["FL"], filters: "[[],[]]" }) && same(sb.ops[0].calls.filter((c) => c[0] === "eq"), [["eq", "status", "ok"], ["eq", "complete", true]]));
  sb = fakeSb(() => ({}));
  await supabaseDb(sb.client, () => NOW).dropOldWatch("2026-08-15T12:00:00.000Z");
  ok("clearing: found filings by when first seen, and finished checks by when started", sb.ops.length === 2 && sb.ops[0].table === "snl_watch_found" && same(sb.ops[0].calls.find((c) => c[0] === "lt"), ["lt", "first_seen_at", "2026-08-15T12:00:00.000Z"]) && sb.ops[1].table === "snl_watch_runs" && same(sb.ops[1].calls.find((c) => c[0] === "neq"), ["neq", "status", "running"]));
}

done();
