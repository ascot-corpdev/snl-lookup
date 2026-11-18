// Watchlist marks (flagFiling in supabase/functions/_shared/watch.ts): every rule with rows that should and
// should not match, mixed case and punctuation, missing fields, hostile descriptions, the rate threshold on both
// sides, marks worked out for rows stored before marks existed, the email's order and wording, the wider window
// after a gap in checks (and the request cap still holding), the "not set up yet" answers the card relies on.
// Every company, id and filing here is made up.
(globalThis as any).__SNL_TEST__ = true;
const watchFn = await import(new URL("../../supabase/functions/snl-watch/index.ts", import.meta.url).href);
import type { FoundFiling, WatchRun } from "../../supabase/functions/_shared/db.ts";
import { forgetTokens } from "../../supabase/functions/_shared/spgmi.ts";
import {
  catchUpWindow, type FilingFlag, flagFiling, flagSentence, LARGE_RATE_CHANGE_PCT, markFound, missingTables, NO_TABLES, rateChange,
  WATCH_CATCHUP_DAYS, WATCH_GAP_DAYS, WATCH_KEEP_DAYS, WATCH_MAX_REQUESTS, WATCH_WINDOW_DAYS, watchEmail,
} from "../../supabase/functions/_shared/watch.ts";
import { checks, env, fakeClock, J, memoryDb, reader } from "./helpers/fakes.ts";
import { filing, spPage, spStub } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86_400_000;
const kinds = (fl: FilingFlag[]) => fl.map((f) => f.kind);
/** A stored row as migration 0003 keeps it (no marks column). */
const ROW = (i: number, over: Partial<FoundFiling> = {}): FoundFiling => ({
  filing_version_id: `0E0E0E0E-0000-4000-8000-${String(i).padStart(12, "0")}`, run_id: null, first_seen_at: "2026-11-13T06:24:00Z", baseline: false,
  companies: ["Calloway Insurance Co"], state: "FL", state_name: "Florida", filing_type: "Rate", type_of_insurance: "Homeowners", sub_type_of_insurance: "Owner occupied homeowners",
  filing_status: "Pending", date_submitted: "2026-10-28", publish_date: "2026-11-10", effective_new: null, effective_renewal: null, rate_impact: "4.5%",
  description: `Made-up homeowners rate revision ${i}.`, tracking_number: `CALL-FL-${i}`, document_id: 72000000 + i, ...over,
});
const desc = (d: string | null, over: Partial<FoundFiling> = {}) => flagFiling(ROW(1, { description: d, ...over }));

// ---------- new program or product ----------
{
  for (const d of ["New program for high value homes.", "NEW-PROGRAM!!", "Calloway Select: a new homeowners program", "New   auto  product.", "Adds a new line of business",
    "Introduces the Calloway Select program", "Introduction of a private client offering", "Launches a renters product", "Rolling out a condo program: roll out in phases",
    "Initial filing of rates, rules and forms", "INITIAL SUBMISSION", "initial rates", "First filing for this line", "New Products"]) {
    const f = desc(d);
    ok(`new program: "${d}"`, kinds(f)[0] === "new_program" && f[0].label === "New program" && f[0].reason.startsWith("the description says \""), f);
  }
  for (const d of ["Homeowner Program rate revision.", "This is not a new program; revised rates.", "No new product is introduced here.", "New business effective 1 Jan 2027.",
    "Revised program rules", "Non initial", "Program renewal", "", "Introductory"]) {
    ok(`not a new program: "${d}"`, !kinds(desc(d)).includes("new_program"), desc(d));
  }
  ok("the filing type can say it: New Program", same(kinds(desc(null, { filing_type: "New Program" })), ["new_program"]) && desc(null, { filing_type: "New Program" })[0].reason === 'the filing type is "New Program"');
  ok("the filing type can say it: initial", kinds(desc(null, { filing_type: "Form/Rate - INITIAL" })).includes("new_program"));
  ok("plain filing types say nothing", ["Form", "Rate", "Rule", "Rate/Rule", "Form/Rate/Rule"].every((t) => !desc(null, { filing_type: t }).length));
  const sub = desc("Rate revision.", { sub_type_of_insurance: "New Program - Owner occupied homeowners" });
  ok("the sub-type of insurance can say it, and the reason names that field", same(kinds(sub), ["new_program"]) && sub[0].reason === 'the sub-type of insurance says "new program"', sub);
  ok("the type of insurance can say it too", desc("Rate revision.", { type_of_insurance: "Homeowners (new product)" })[0]?.reason === 'the type of insurance says "new product"');
}

// ---------- a company new to the state ----------
{
  for (const d of ["Company is entering the Florida market.", "Expansion into Georgia.", "Calloway is new to the state.", "New entrant homeowners filing", "Newly licensed company",
    "Newly admitted insurer", "Begins writing homeowners in FL", "Starting to offer personal auto", "Enter the state with a new program"]) {
    ok(`new to the state: "${d}"`, kinds(desc(d)).includes("new_state"), desc(d));
  }
  for (const d of ["Expanding coverage in the state for roofs.", "Enter into an agreement with a vendor.", "State amendatory endorsement", "Not entering the market."]) {
    ok(`not new to the state: "${d}"`, !kinds(desc(d)).includes("new_state"), desc(d));
  }
}

// ---------- a new form or coverage ----------
{
  for (const d of ["New policy form SH-HO 01 (12 25) and endorsements.", "Introduces a new endorsement for water backup.", "Adds an optional coverage for jewelry.",
    "Adding endorsement CHO 04 90.", "Introduction of form CHO 30 01.", "Initial forms", "NEW FORMS: CHO-1, CHO-2", "New identity theft coverage"]) {
    const f = desc(d);
    ok(`new form: "${d}"`, same(kinds(f), ["new_form"]) && f[0].label === "New form", f);
  }
  for (const d of ["Revised policy form CHO 30 01 (06 25) and mandatory endorsements.", "Form revision.", "Added language to the form.", "Withdraws no forms.",
    "No new forms are filed.", "New business forms"]) {
    ok(`not a new form: "${d}"`, !kinds(desc(d)).includes("new_form"), desc(d));
  }
  ok("a new program with new forms is marked once, as a new program", same(kinds(desc("New program with new policy forms.")), ["new_program"]));
}

// ---------- withdrawal ----------
{
  const st = desc("Rate revision.", { filing_status: "Closed - Withdrawn", rate_impact: null });
  ok("status withdrawn", same(kinds(st), ["withdrawal"]) && st[0].label === "Withdrawal" && st[0].reason === 'the status is "Closed - Withdrawn"', st);
  ok("status WITHDRAWAL, any case", kinds(desc(null, { filing_status: "WITHDRAWAL" })).includes("withdrawal"));
  ok("filing type withdrawal", desc(null, { filing_type: "Withdrawal" })[0]?.reason === 'the filing type is "Withdrawal"');
  for (const d of ["Withdrawal of the condo program.", "Company withdraws from the homeowners line.", "Discontinue the renters product.", "Ceasing writing new business in FL.",
    "No longer offering earthquake coverage.", "Book in run-off.", "Runoff of the program", "Exiting the Florida market.", "Non-renewal of all policies in the program."]) {
    ok(`withdrawal: "${d}"`, kinds(desc(d)).includes("withdrawal"), desc(d));
  }
  for (const d of ["Rate revision.", "Will not discontinue any coverage.", "Closed - Approved", "Leave of absence rule"]) {
    ok(`not a withdrawal: "${d}"`, !kinds(desc(d)).includes("withdrawal"), desc(d));
  }
  ok("an approved status says nothing", !desc(null, { filing_status: "Closed - Approved" }).length && !desc(null, { filing_status: "Pending" }).length);
}

// ---------- a large rate change: the threshold on both sides ----------
{
  ok("the threshold is 10%", LARGE_RATE_CHANGE_PCT === 10);
  const r = (v: string | null) => kinds(desc("Rate revision.", { rate_impact: v }));
  ok("+10.0% is large", same(r("10.000%"), ["large_rate"]) && desc("x", { rate_impact: "10.000%" })[0].reason === "the overall rate impact is +10.0%");
  ok("9.9% is not", same(r("9.999%"), []) && same(r("9.9"), []));
  ok("-10% is large, and said with its sign", same(r("-10%"), ["large_rate"]) && desc("x", { rate_impact: "-10%" })[0].reason === "the overall rate impact is -10.0%");
  ok("-9.9% is not", same(r("-9.9%"), []));
  ok("a number without a percent sign reads as percentage points", same(r("12.5"), ["large_rate"]) && same(r("6.5"), []));
  ok("accounting brackets are a cut", rateChange("(15.0%)") === -15 && same(r("(15.0%)"), ["large_rate"]));
  ok("a unicode minus and a plus sign", rateChange("−11%") === -11 && rateChange("+12%") === 12);
  ok("a range: the change furthest from zero; a dash after a number is a range, not a minus", rateChange("-5% to 12%") === 12 && rateChange("5-12%") === 12 && rateChange("-14% to 3%") === -14);
  ok("missing or unreadable rate impact: no mark", same(r(null), []) && same(r("n/d"), []) && same(r(""), []) && rateChange("N/A") === null && rateChange(undefined) === null && rateChange({}) === null);
  ok("a number given directly", rateChange(6.5) === 6.5 && rateChange(Number.NaN) === null);
  ok("the fixture's 6.500% and -2.000% are not large", rateChange("6.500%") === 6.5 && rateChange("-2.000%") === -2 && same(r("6.500%"), []));
}

// ---------- missing fields, hostile text ----------
{
  ok("nothing at all: no marks, no error", same(flagFiling(null), []) && same(flagFiling(undefined), []) && same(flagFiling({}), []) && same(flagFiling("x" as unknown as FoundFiling), []));
  ok("fields of the wrong type are ignored", same(flagFiling({ description: 42 as unknown as string, filing_status: ["Withdrawn"] as unknown as string, rate_impact: { v: 50 } as unknown as string }), []));
  const evil = desc('<img src=x onerror="window.__x=1"> New program <script>alert(1)</script> $& $1');
  ok("hostile description: the quote back is plain words only", evil.length === 1 && evil[0].reason === 'the description says "new program"' && !/[<>"&$]/.test(evil[0].reason.replace(/^the description says "|"$/g, "")), evil);
  const ctl = desc("New\u0000‮program\nfor\tFL");
  ok("control and direction characters don't hide a phrase or reach the reason", same(kinds(ctl), ["new_program"]) && ctl[0].reason === 'the description says "new program"', ctl);
  const t0 = performance.now();
  const bomb = desc(("new " + "a ".repeat(40)).repeat(200) + "x".repeat(5000));
  const bomb2 = desc("enter ".repeat(3000) + "add ".repeat(3000));
  ok("a long, repetitive description is read quickly (no runaway matching)", performance.now() - t0 < 500 && Array.isArray(bomb) && Array.isArray(bomb2), performance.now() - t0);
  const long = desc("x ".repeat(100) + "Introducing the Calloway Select private client homeowners program for very high value homes in coastal counties");
  ok("a long matched phrase is cut in the reason", long[0].reason.length < 80, long);
  ok("accents and full-width letters read as plain letters", kinds(desc("Nouveau: new prógram")).includes("new_program") && kinds(desc("ＮＥＷ ＰＲＯＧＲＡＭ")).includes("new_program"));
  const status = flagFiling(ROW(1, { filing_status: 'Withdrawn <b>"x"</b>' }));
  ok("a status quoted back is the stored text (the page escapes it)", status[0].reason === 'the status is "Withdrawn <b>"x"</b>"');
  ok("several marks at once, in a fixed order", same(kinds(desc("Entering the Florida market with a new program; withdraws the old one.", { rate_impact: "-18%" })), ["new_program", "new_state", "withdrawal", "large_rate"]));
  ok("the sentence form says may be", flagSentence(desc("New program.")[0]) === 'May be a new program or product: the description says "new program".');
}

// ---------- marks are worked out from the stored rows, marked ones first ----------
{
  const rows = [ROW(1), ROW(2, { description: "New program." }), ROW(3), ROW(4, { rate_impact: "-12%" })];
  const m = markFound(rows);
  ok("marked first, each group keeping its order", same(m.map((r) => r.tracking_number), ["CALL-FL-2", "CALL-FL-4", "CALL-FL-1", "CALL-FL-3"]) && same(m[2].flags, []), m.map((r) => r.tracking_number));
  ok("the rows themselves are not changed", !("flags" in rows[1]));
}

// ---------- the email: marked filings first, under their own heading ----------
{
  const rows = [ROW(1), ROW(2, { description: "Introduces the Calloway Select program.", filing_type: "Form", rate_impact: null }), ROW(3, { companies: ["Tarrow Mutual Insurance Co"], state: "GA", rate_impact: "11.0%" })];
  const mail = watchEmail(rows, { now: Date.parse("2026-11-14T06:23:00Z"), site: "https://example.github.io/snl/" });
  const lines = mail.text.split("\n");
  ok("subject says how many, and how many are worth a closer look", mail.subject === "SNL lookup: 3 new filings on the watchlist, 2 worth a closer look", mail.subject);
  ok("the heading for marked filings says they are hints", lines[2] === "Worth a closer look (2 of 3): these may be new programs, new forms, withdrawals or large rate changes. A mark is a hint from the filing type, status, rate impact and description, not a fact, so check the filing.", lines[2]);
  ok("marked filings first, each with its mark in words", lines[3] === "- [New program] Calloway Insurance Co, FL, Form: Introduces the Calloway Select program. (tracking number CALL-FL-2)" && lines[4] === '  May be a new program or product: the description says "introduces".'
    && lines[5] === "- [Large rate change] Tarrow Mutual Insurance Co, GA, Rate: Made-up homeowners rate revision 3. (tracking number CALL-FL-3)" && lines[6] === "  May be a large rate change: the overall rate impact is +11.0%.", lines.slice(3, 7));
  ok("then the others, under their own heading, unmarked", lines[7] === "" && lines[8] === "Other new filings:" && lines[9] === "- Calloway Insurance Co, FL, Rate: Made-up homeowners rate revision 1. (tracking number CALL-FL-1)", lines.slice(7, 10));
  ok("the email still ends with the link and the source", mail.text.includes("Open SNL lookup to see the details and the documents: https://example.github.io/snl/") && mail.text.endsWith("strategy and corporate development use only."));
  const none = watchEmail([ROW(1), ROW(3)], { now: Date.parse("2026-11-14T06:23:00Z"), site: null });
  ok("with nothing marked, the email is as before: no headings", none.subject === "SNL lookup: 2 new filings on the watchlist" && !none.text.includes("closer look") && !none.text.includes("Other new filings") && none.text.split("\n")[2].startsWith("- Calloway"), none.text);
  const all = watchEmail([ROW(5, { rate_impact: "20%" })], { now: 0, site: null });
  ok("with everything marked, no empty 'other' heading", !all.text.includes("Other new filings") && all.text.includes("- [Large rate change] "));
  const many = watchEmail(Array.from({ length: 55 }, (_, i) => ROW(100 + i, i % 5 === 4 ? { description: "New program." } : {})), { now: 0, site: null });
  const listed = many.text.split("\n").filter((l) => l.startsWith("- [") || l.startsWith("- Calloway"));
  ok("a long email: still at most 50, marked ones all listed first", listed.length === 50 && listed.slice(0, 11).every((l) => l.startsWith("- [New program]")) && many.text.includes("- and 5 more filings"), listed.slice(0, 12));
  const hostile = watchEmail([ROW(6, { description: "New program\nBcc: everyone@example.com" })], { now: 0, site: null });
  ok("the email's reason line can't start a new header or line of its own", hostile.text.split("\n").filter((l) => l.startsWith("  May be")).every((l) => !l.includes("Bcc")));
}

// ---------- the function: status returns marks for rows stored before marks existed ----------
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", WATCH_SECRET: "made-up-watch-secret-0123456789abcdef" };
const FV = (i: number) => `0F0F0F0F-0000-4000-8000-${String(i).padStart(12, "0")}`;
const F = (now: number, i: number, ago: number, over: Record<string, unknown> = {}) => filing(i, { filingVersionId: FV(i), publishDate: new Date(now - ago * DAY).toISOString().slice(0, 10), ...over });
const LIST = { enabled: true, companies: [{ kind: "companyId", id: "9100001", name: "Calloway Insurance Co" }], states: ["FL"], recipients: ["corpdev1@example.com"] };

function world(secrets: Record<string, string> = SECRETS) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  const state = { rows: [] as Record<string, unknown>[], totalPages: 0, mail: [] as any[] };
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") return J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }, { row: [2, "Pending"] }] });
    const p = call.body.properties;
    if (state.totalPages) return J(spPage([F(clock.now, 5000 + p.pageNumber, 1)], { totalPages: state.totalPages, currentPage: p.pageNumber }));
    return J(spPage(state.rows.filter((r) => (p.companyId ?? []).includes(r.companyId) && p.serffFilingStateId.includes(r.serffFilingStateId) && String(r.publishDate) >= p.minPublishDate && String(r.publishDate) <= p.maxPublishDate), { totalPages: 1, currentPage: 1 }));
  });
  const mailFetch = (async (_u: string, init: RequestInit = {}) => { state.mail.push(JSON.parse(String(init.body))); return J({ id: "email-1" }); }) as unknown as typeof fetch;
  const deps = { env: env(secrets), fetch: sp.fetch, mailFetch, now: clock.fn, whoIs: async () => ({ id: "u-cd", role: "corpdev" }), db, sleep: clock.sleep };
  const call = async (body: unknown, over: Record<string, unknown> = {}) => {
    const res: Response = await watchFn.handle(new Request("https://x.supabase.co/functions/v1/snl-watch", { method: "POST", headers: { Authorization: "Bearer u" }, body: JSON.stringify(body) }), { ...deps, ...over });
    return { status: res.status, body: await res.json() };
  };
  db.settings.set("watchlist", structuredClone(LIST));
  const t = db as unknown as { runs: WatchRun[]; found: Map<string, FoundFiling> };
  return { clock, db, sp, state, call, runs: t.runs, found: t.found, searches: () => sp.calls("/api/v1/search") };
}

{
  const w = world();
  // rows saved by the check before this change: exactly the columns of migration 0003, no marks
  await w.db.addFoundFilings([ROW(1), ROW(2, { description: "Initial filing for the Calloway Select program." }), ROW(3, { filing_status: "Closed - Withdrawn" })]);
  const s = await w.call({ action: "status" }, { whoIs: reader });
  ok("status: marks worked out for rows stored before marks existed", s.status === 200 && same(s.body.found.map((r: any) => [r.tracking_number, r.flags.map((f: FilingFlag) => f.label)]), [["CALL-FL-2", ["New program"]], ["CALL-FL-3", ["Withdrawal"]], ["CALL-FL-1", []]]), s.body.found);
  ok("nothing about marks is stored", [...w.found.values()].every((r) => !("flags" in r)));
  const first = await w.call({ action: "run" });
  ok("a check's found rows have no marks column (so no migration is needed)", first.body.run.status === "ok" && [...w.found.values()].every((r) => !("flags" in r)));
}

// ---------- the card's "not set up yet" answers ----------
{
  const w = world({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" });
  let s = await w.call({ action: "status" });
  ok("without WATCH_SECRET, status says the schedule isn't ready", s.body.scheduleReady === false && s.body.scheduleQuiet === true && s.body.lastScheduled === null, s.body);
  const ok2 = world();
  s = await ok2.call({ action: "status" });
  ok("with WATCH_SECRET, the schedule is ready; nothing has run yet, so it is quiet", s.body.scheduleReady === true && s.body.scheduleQuiet === true);
  await ok2.db.addWatchRun({ status: "skipped", trigger: "schedule", started_at: new Date(ok2.clock.now - 10 * 3600_000).toISOString(), finished_at: null, requests: 0, found: 0, new_count: 0, baseline: false, complete: true, emailed: 0, message: "off", scope: null });
  s = await ok2.call({ action: "status" });
  ok("a scheduled call in the last day and a half: not quiet, and when it was", s.body.scheduleQuiet === false && s.body.lastScheduled === new Date(ok2.clock.now - 10 * 3600_000).toISOString());
  ok2.clock.now += 2 * DAY;
  s = await ok2.call({ action: "status" });
  ok("two days without a scheduled call: quiet again", s.body.scheduleQuiet === true);

  const broken = world();
  const gone = new Error("Couldn't read the record of checks: Could not find the table 'public.snl_watch_runs' in the schema cache");
  broken.db.watchRuns = async () => { throw gone; };
  broken.db.addWatchRun = async () => { throw new Error("Couldn't record the check: relation \"public.snl_watch_runs\" does not exist"); };
  broken.db.startWatchRun = async () => { throw new Error("Couldn't record the check: relation \"public.snl_watch_runs\" does not exist"); };
  s = await broken.call({ action: "status" });
  ok("migration 0003 not run: status says which step is missing", s.status === 503 && s.body.error === "no_tables" && s.body.message === NO_TABLES && NO_TABLES.includes("0003_watchlist.sql"), s.body);
  const r = await broken.call({ action: "run" });
  ok("migration 0003 not run: Check now says the same, and asks S&P nothing", r.status === 503 && r.body.error === "no_tables" && broken.sp.log.length === 0, r.body);
  ok("other database faults are not mistaken for it", !missingTables(new Error("Couldn't read the record of checks: made-up fault")) && !missingTables(new Error("relation \"public.other\" does not exist")) && missingTables(gone));
  broken.db.watchRuns = async () => { throw new Error("made-up fault"); };
  ok("…and still answer as a failure", (await broken.call({ action: "status" })).status === 500);
}

// ---------- a wider window after a gap in complete checks ----------
{
  const NOW = Date.parse("2026-11-13T12:00:00Z");
  const run = (ago: number, over: Partial<WatchRun> = {}): WatchRun => ({ id: `r${ago}`, status: "ok", trigger: "schedule", started_at: new Date(NOW - ago * DAY).toISOString(), finished_at: null, requests: 1, found: 0, new_count: 0, baseline: false, complete: true, emailed: 0, message: null, scope: { companies: [], states: [], filters: "" }, ...over });
  ok("the numbers: a gap of more than 3 days; at most 60 days; well under the 90 days filings are kept", WATCH_GAP_DAYS === 3 && WATCH_CATCHUP_DAYS === 60 && WATCH_CATCHUP_DAYS < WATCH_KEEP_DAYS && WATCH_WINDOW_DAYS === 14);
  ok("first check: the normal 14 days", catchUpWindow(false, [], NOW).days === 14);
  ok("daily checks: 14 days", catchUpWindow(true, [run(1)], NOW).days === 14 && catchUpWindow(true, [run(3)], NOW).days === 14);
  ok("a gap of 3.5 days: 18 days, back to 14 days before that check", catchUpWindow(true, [run(3.5)], NOW).days === 18);
  ok("a gap of 10 days: 24 days", same(catchUpWindow(true, [run(10)], NOW), { days: 24, since: run(10).started_at }));
  ok("a gap of 50 days: capped at 60", catchUpWindow(true, [run(50)], NOW).days === 60);
  ok("failed, skipped and incomplete checks don't count as complete", catchUpWindow(true, [run(0.5, { status: "failed" }), run(1, { status: "skipped" }), run(1.5, { complete: false }), run(8)], NOW).days === 22);
  ok("no complete check among the recent ones: the widest window", same(catchUpWindow(true, [run(1, { status: "failed" })], NOW), { days: 60, since: null }));

  const w = world({ ...SECRETS, RESEND_API_KEY: "re_test" });
  const N = () => w.clock.now;
  w.state.rows.push(F(N(), 1, 2));
  await w.call({ action: "run" });   // the starting point
  ok("first check asks for 14 days", w.searches()[0].body.properties.minPublishDate === "2026-10-31");
  w.clock.now += DAY;
  await w.call({ action: "run" });
  ok("the next day: still 14 days", w.searches().at(-1)!.body.properties.minPublishDate === "2026-11-01");
  // switched off (or failing) for 20 days. Meanwhile: a filing published in the gap 18 days ago; one S&P added late
  // with a publish date 30 days ago (before the last check); one 40 days ago; one yesterday.
  w.clock.now += 20 * DAY;
  w.state.rows.push(F(N(), 2, 18, { filingDescription: "New program for high value homes." }), F(N(), 5, 30), F(N(), 3, 40), F(N(), 4, 1));
  const r = (await w.call({ action: "run" })).body.run;
  const props = w.searches().at(-1)!.body.properties;
  ok("after a 20-day gap: one search, looking back 34 days (14 days before the last complete check)", props.minPublishDate === "2026-11-01" && props.maxPublishDate === "2026-12-04" && r.windowDays === 34 && r.requests === 1, { props, r });
  ok("filings published in the gap, and one added late, are found as new; one older than the window isn't asked for", w.found.get(FV(2))?.baseline === false && w.found.get(FV(4))?.baseline === false && w.found.get(FV(5))?.baseline === false && r.newCount === 3 && !w.found.has(FV(3)), [...w.found.keys()]);
  ok("the check says it looked back further, and why", r.message === "Found 3 new filings. The last complete check was on 14 Nov, so this check looked back 34 days instead of 14, to catch filings published in between.", r.message);
  ok("the email puts the filing in the gap first, with its mark", w.state.mail.length === 1 && w.state.mail[0].text.split("\n")[3].startsWith("- [New program] ") && w.state.mail[0].subject.endsWith(", 1 worth a closer look"), w.state.mail[0]);
  w.clock.now += DAY;
  await w.call({ action: "run" });
  ok("back to daily: back to 14 days", w.searches().at(-1)!.body.properties.minPublishDate === "2026-11-22");

  // the request cap still holds with a wide window
  const cap = world();
  await cap.call({ action: "run" });
  cap.clock.now += 40 * DAY;
  cap.state.totalPages = 100;
  const c = (await cap.call({ action: "run" })).body.run;
  ok("a wide window with many pages: never more than the budget of S&P requests", c.windowDays === 55 && c.requests <= WATCH_MAX_REQUESTS && cap.sp.log.length - 3 <= WATCH_MAX_REQUESTS && c.complete === false && c.message.includes("may have missed some filings"), { c, n: cap.sp.log.length });
}

done();
