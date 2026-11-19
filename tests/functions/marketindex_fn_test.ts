// The snl-index function: every action, who may use each, one sweep at a time, a stuck step and a stuck sweep, pause,
// resume and stop, the scheduler's secret and what the schedule does, the query's filters, groupings and caps, the
// coverage carried on every answer, and the refusals (a state or dates outside the index, a sweep too big for a day,
// a full index, the migration not run). Every company, id and filing here is made up.
import type { IndexRow, IndexState, IndexSweep } from "../../supabase/functions/_shared/db.ts";
import { HOUR_RESERVE, INDEX_ROW_LIMIT, MAX_STALLS, STALE_MS, STOPPED_STEP } from "../../supabase/functions/_shared/marketindex.ts";
import { checks, nobody, reader } from "./helpers/fakes.ts";
import { F, FV, listRow, same, SECRET, SECRETS, world } from "./helpers/marketindex.ts";

const { ok, done } = checks();
const sweepsOf = (db: unknown) => (db as { sweepRows: IndexSweep[] }).sweepRows;
const idx = (db: unknown) => db as { filingRows: Map<string, any>; stateRows: Map<string, IndexState>; queries: any[]; putIndexRows(r: IndexRow[]): Promise<void>; putIndexState(s: IndexState): Promise<void> };
const MIN = 60_000;

/** Runs continue until the sweep is done (or stops for another reason). */
async function finish(w: ReturnType<typeof world>, max = 20) {
  let last: any = null;
  for (let k = 0; k < max; k++) {
    last = await w.call({ action: "continue" });
    if (last.body.step?.reason !== "waiting") break;
  }
  return last;
}

// ---------- who may do what ----------
{
  const w = world();
  ok("no login: refused", (await w.call({ action: "status" }, { whoIs: nobody })).status === 401);
  const rs = await w.call({ action: "status" }, { whoIs: reader });
  ok("a reader sees the status, without the sweep costs", rs.status === 200 && rs.body.role === "reader" && same(rs.body.states, []) && rs.body.open === null && !("costs" in rs.body) && !("companies" in rs.body), rs.body);
  for (const action of ["start", "top_up", "continue", "pause", "resume", "stop"]) {
    const r = await w.call({ action, state: "FL", period: "last_12_months" }, { whoIs: reader });
    ok(`a reader can't ${action}`, r.status === 403 && r.body.message === "Only Corp Dev logins can run sweeps. Anyone can search the index.", r);
  }
  ok("nobody runs the schedule's action by hand", (await w.call({ action: "scheduled" })).status === 403);
  ok("an unknown action is refused", (await w.call({ action: "drop" })).status === 400);
  ok("nothing was asked of S&P", w.sp.log.length === 0 && sweepsOf(w.db).length === 0);
  const cs = await w.call({ action: "status" });
  ok("Corp Dev sees what each period would cost, from the company list, at no S&P cost", cs.status === 200 && same(cs.body.companies, { searchable: 400, byCompanyId: 130, byInstitutionId: 270, unsearchable: 3 })
    && cs.body.costs.last_12_months.minimum === 40 && cs.body.costs.last_3_years.minimum === 120 && cs.body.costs.this_year.windows === 1 && cs.body.costs.last_12_months.words.includes("About 46 S&P requests") && cs.body.costs.last_3_years.refused === null && w.sp.log.length === 0, cs.body.costs);
  ok("the status carries the limits, the reserves and the day's allowance for sweeps", same(cs.body.limits, { hour: 500, day: 12000 }) && same(cs.body.reserves, { hour: HOUR_RESERVE, day: 3000 }) && cs.body.allowance === 8400 && cs.body.account === "trial");
  ok("and whether the schedule can run", cs.body.schedule.ready === true && cs.body.schedule.topUpDays === 7);
}

// ---------- a sweep through the function: start, continue, one at a time ----------
const ROWS = [
  F(1, { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }, { typeOfInsurance: "Homeowners", subTypeOfInsurance: "High value homes", serffFilingType: "Rate", overallRateImpact: 12.5, publishDate: "2026-03-10" }),
  F(2, { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }, { typeOfInsurance: "Homeowners", serffFilingType: "Form", overallRateImpact: null, publishDate: "2026-04-02", filingStatus: "Pending", filingStatusId: 2 }),
  F(3, { institutionId: 930005, name: "Nonesuch Carrier No. 5 Co" }, { typeOfInsurance: "Private Passenger Auto", subTypeOfInsurance: "Personal auto", serffFilingType: "Rate", overallRateImpact: -3, publishDate: "2026-04-20" }),
  F(4, { institutionId: 930005, name: "Nonesuch Carrier No. 5 Co" }, { typeOfInsurance: "Homeowners", serffFilingType: "Rate/Rule", overallRateImpact: 6, publishDate: "2026-10-01" }),
  F(5, { institutionId: 930006, name: "Nonesuch Carrier No. 6 Co" }, { typeOfInsurance: "Homeowners", serffFilingType: "Form", overallRateImpact: null, publishDate: "2026-10-15" }),
];
{
  const w = world({ rows: ROWS, byInstitution: 570 });   // 700 companies, 70 batches: more than one step from the page
  ok("a state must be two letters", (await w.call({ action: "start", state: "Florida", period: "last_12_months" })).status === 400);
  ok("a period must be one of the three", (await w.call({ action: "start", state: "FL", period: "forever" })).body.message === "Choose a period: this year, the last 12 months or the last 3 years.");
  const s = await w.call({ action: "start", state: "fl", period: "last_12_months" });
  ok("Corp Dev starts a sweep: recorded as waiting, nothing asked of S&P yet", s.status === 200 && s.body.sweep.state === "FL" && s.body.sweep.status === "waiting" && s.body.sweep.percent === 0 && !("plan" in s.body.sweep) && s.body.cost.estimate === 79 && w.sp.log.length === 0, s.body);
  ok("the start says what it will cost", s.body.message.startsWith("Sweep of FL started for filings published 19 Nov 2025 to 18 Nov 2026. About 79 S&P requests"), s.body.message);
  const two = await w.call({ action: "start", state: "GA", period: "this_year" });
  ok("a second sweep is refused while one is unfinished", two.status === 409 && two.body.error === "busy" && two.body.message.includes("A sweep of FL is unfinished (0% done)") && sweepsOf(w.db).length === 1, two.body);
  const q0 = await w.call({ action: "query", state: "FL" });
  ok("the index isn't answered from part of a sweep", q0.status === 404 && q0.body.error === "not_indexed" && q0.body.message.includes("A sweep of FL is under way (0% done); ask again when it finishes.") && q0.body.message.includes("Nothing is answered from part of a sweep."), q0.body);
  const c1 = await w.call({ action: "continue" });
  ok("continue runs one step and reports it, with the request counts", c1.status === 200 && c1.body.step.ran && c1.body.step.reason === "waiting" && c1.body.step.sweep.percent > 0 && c1.body.step.sweep.percent < 100 && typeof c1.body.used.hour === "number" && c1.body.limits.hour === 500, c1.body.step);
  ok("each step from the page stops after about 40 seconds", c1.body.step.sweep.next_unit >= 30 && c1.body.step.sweep.next_unit <= 40, c1.body.step.sweep.next_unit);
  const end = await finish(w);
  ok("the page's continues carry it to the end", end.body.step.reason === "done" && end.body.step.sweep.status === "done" && end.body.step.sweep.percent === 100, end.body.step);
  const slots = (w.db as any).slots as number[];
  ok("every S&P request went through the shared throttle, a second apart", slots.length === w.sp.log.length && slots.every((t, k) => k === 0 || t - slots[k - 1] >= 1000), { slots: slots.length, log: w.sp.log.length });
  const st = await w.call({ action: "status" }, { whoIs: reader });
  ok("the status lists FL as indexed, with its coverage and filings", st.body.states.length === 1 && st.body.states[0].state === "FL" && st.body.states[0].filings === 5 && st.body.states[0].companiesCovered === 700 && st.body.states[0].from === "2025-11-19" && st.body.open === null && st.body.recent[0].status === "done" && !("plan" in st.body.recent[0]), st.body.states);
  ok("its coverage sentence never claims the whole market", st.body.states[0].sentence.includes("700 companies covered, 0 not") && st.body.states[0].sentence.includes("isn't the whole market"));
  ok("the index's size is reported", st.body.index.rows === 5 && st.body.index.bytes === 3000 && st.body.index.rowLimit === INDEX_ROW_LIMIT);

  // ----- asking the index: filters, groups, coverage on every answer; no S&P request -----
  const before = w.sp.log.length;
  const ask = (q: Record<string, unknown>) => w.call({ action: "query", state: "FL", ...q }, { whoIs: reader });
  const all = await ask({});
  ok("a reader can ask; rows newest first, in the search's own shape", all.status === 200 && all.body.total === 5 && same(all.body.rows.map((r: any) => r.filingVersionId), [FV(5), FV(4), FV(3), FV(2), FV(1)]) && all.body.rows[0].companies[0].companyName === "Nonesuch Carrier No. 6 Co" && all.body.rows[0].filingNo === "S&P no. ZZZ1000005" && all.body.rows[0].trackingNumber === null, all.body.rows?.[0]);
  const cov = all.body.coverage;
  ok("every answer carries its coverage: state, period, last complete sweep, companies covered and not", cov.state === "FL" && cov.from === "2025-11-19" && cov.to === "2026-11-18" && cov.lastComplete.startsWith("2026-11-18") && cov.companiesCovered === 700 && cov.companiesMissed === 0 && cov.sentence.startsWith("The market index of FL holds filings published 19 Nov 2025 to 18 Nov 2026"), cov);
  const check = async (name: string, q: Record<string, unknown>, want: number[]) => {
    const r = await ask(q);
    ok(name, r.status === 200 && same(r.body.rows.map((x: any) => x.filingVersionId).sort(), want.map(FV).sort()) && r.body.total === want.length && r.body.coverage.state === "FL", { q, got: r.body.rows?.map((x: any) => x.filingVersionId), b: r.body.message });
  };
  await check("type of insurance, any letter case, the sub-type too", { typeOfInsurance: "HOMEOWNERS" }, [1, 2, 4, 5]);
  await check("words in the sub-type of insurance", { typeOfInsurance: "high value" }, [1]);
  await check("filing type", { filingType: "rate" }, [1, 3, 4]);
  await check("status", { status: "pend" }, [2]);
  await check("publish dates", { from: "2026-04-01", to: "2026-04-30" }, [2, 3]);
  await check("rate impact above", { rateAbove: 5 }, [1, 4]);
  await check("rate impact below", { rateBelow: 0 }, [3]);
  await check("rate impact between", { rateAbove: 0, rateBelow: 10 }, [4]);
  await check("words in a company name", { words: ["carrier", "no. 5"] }, [3, 4]);
  await check("filters together", { typeOfInsurance: "home", filingType: "rate", from: "2026-01-01" }, [1, 4]);
  const words = await ask({ words: ["program"] });
  ok("a search by words says when the state's filings have no description", words.body.total === 0 && words.body.notes.some((n: string) => n === "No filing in the index of FL has a description (S&P left them empty), so the words were matched against company names only."), words.body.notes);
  ok("an empty answer is never 'no filings exist'", words.body.notes.some((n: string) => n.includes("No filing in the index matches.") && n.includes("that isn't proof that none were filed")));
  const rated = await ask({ rateAbove: 1 });
  ok("a rate filter says it leaves out filings with no rate impact", rated.body.notes.includes("Filings with no overall rate impact are left out by a rate filter."));
  const byCo = await ask({ group: "company" });
  ok("by company: most filings first, with rate filings and their range", byCo.status === 200 && byCo.body.groupTotal === 3 && same(byCo.body.groups.map((g: any) => [g.name, g.filings, g.rateFilings, g.rateMin, g.rateMax]), [["Nonesuch Carrier No. 5 Co", 2, 2, -3, 6], ["Nonesuch Mutual No. 0 Co", 2, 1, 12.5, 12.5], ["Nonesuch Carrier No. 6 Co", 1, 0, null, null]]) && byCo.body.coverage.state === "FL", byCo.body.groups);
  const byType = await ask({ group: "type" });
  ok("by type of insurance", same(byType.body.groups.map((g: any) => [g.name, g.filings]), [["Homeowners", 4], ["Private Passenger Auto", 1]]) && byType.body.coverage);
  const byMonth = await ask({ group: "month" });
  ok("by month, in order", same(byMonth.body.groups.map((g: any) => [g.name, g.filings]), [["2026-03", 1], ["2026-04", 2], ["2026-10", 2]]) && byMonth.body.withRate === 3 && byMonth.body.rateFilings === 3);
  const paged = await ask({ limit: 2, offset: 2 });
  ok("rows come a page at a time", same(paged.body.rows.map((r: any) => r.filingVersionId), [FV(3), FV(2)]) && paged.body.more === true && (await ask({ limit: 2, offset: 4 })).body.more === false);
  ok("the question as answered is echoed back", paged.body.query.state === "FL" && paged.body.query.limit === 2 && paged.body.query.from === "2025-11-19" && paged.body.query.to === "2026-11-18");
  await ask({ limit: 100000 }); await ask({ group: "company", limit: 100000 });
  const qs = idx(w.db).queries;
  ok("the hard caps: 500 rows, 100 groups in one answer", qs.at(-2).limit === 500 && qs.at(-1).limit === 100);
  const outside = await ask({ from: "2024-01-01", to: "2024-12-31" });
  ok("dates wholly outside the index are refused plainly", outside.status === 400 && outside.body.error === "out_of_range" && outside.body.message.includes("covers filings published 19 Nov 2025 to 18 Nov 2026"), outside.body);
  const partly = await ask({ from: "2025-01-01" });
  ok("dates partly outside are cut to the index, and the answer says so", partly.status === 200 && partly.body.query.from === "2025-11-19" && partly.body.notes.some((n: string) => n.includes("starts 19 Nov 2025, so filings published before that aren't in this answer")), partly.body.notes);
  const ga = await ask({ state: "GA" });
  ok("a state outside the index is refused, naming the states it covers", ga.status === 404 && ga.body.error === "not_indexed" && same(ga.body.indexed, ["FL"]) && ga.body.message.startsWith("GA isn't in the market index, so this can't be answered from it.") && ga.body.message.includes("The index covers FL."), ga.body);
  ok("bad questions are refused with a reason", (await ask({ state: "" })).status === 400 && (await ask({ group: "zip" })).body.message === "Group by company, type, filing type, status or month, or ask for the rows." && (await ask({ from: "2026-13-01" })).body.message === "Dates must look like 2026-01-31." && (await ask({ rateAbove: "lots" })).body.message.includes("percentage points"));
  ok("asking the index used no S&P request", w.sp.log.length === before);

  // ----- top-up through the function -----
  ok("a top-up on the same day is refused: the index already runs to today", (await w.call({ action: "top_up", state: "FL" })).body.error === "up_to_date");
  w.clock.now += 8 * 86_400_000;
  const t = await w.call({ action: "top_up", state: "FL" });
  ok("a week later Corp Dev can top it up; it costs about as much as a year's sweep", t.status === 200 && t.body.sweep.kind === "top_up" && t.body.sweep.from_date === "2026-11-18" && t.body.cost.minimum === 70, t.body);
  ok("a reader's status shows it as unfinished", (await w.call({ action: "status" }, { whoIs: reader })).body.open.kind === "top_up");
}

// ---------- pause, resume and stop ----------
{
  const w = world({ byInstitution: 570 });
  await w.call({ action: "start", state: "FL", period: "last_12_months" });
  await w.call({ action: "continue" });
  const p = await w.call({ action: "pause" });
  ok("pausing a sweep between steps holds it at once", p.status === 200 && p.body.sweep.status === "held" && p.body.message === "Paused.", p.body);
  const n = w.sp.log.length;
  const c = await w.call({ action: "continue" });
  ok("a paused sweep isn't carried on, by the page or the schedule", !c.body.step.ran && c.body.step.reason === "held" && (await w.cron(SECRET)).body.step.reason === "held" && w.sp.log.length === n);
  ok("resuming a sweep that isn't paused is refused", (await w.call({ action: "pause" })).body.message === "The sweep is already paused." && true);
  const r = await w.call({ action: "resume" });
  ok("resume makes it ready to carry on", r.status === 200 && r.body.sweep.status === "waiting");
  ok("resume again is refused: it isn't paused", (await w.call({ action: "resume" })).status === 409);
  // a pause or stop asked while a step is running is taken at the next batch
  const sw = sweepsOf(w.db)[0];
  sw.status = "running"; sw.updated_at = new Date(w.clock.now).toISOString();
  const pr = await w.call({ action: "pause" });
  ok("pausing a running sweep asks its step to pause after the batch it is on", pr.body.message === "The sweep pauses after the batch it is on." && sweepsOf(w.db)[0].request === "pause" && sweepsOf(w.db)[0].status === "running");
  sw.status = "waiting";
  const at = sw.next_unit, step = await w.call({ action: "continue" });
  ok("the step sees the request and holds the sweep before asking S&P again", step.body.step.reason === "held_now" && step.body.step.sweep.status === "held" && step.body.step.sweep.next_unit === at && step.body.step.message.startsWith("Paused by Corp Dev after"), step.body.step);
  await w.call({ action: "resume" });
  const s = await w.call({ action: "stop" });
  ok("stop closes it, keeping what was found but not counting it as covered", s.status === 200 && s.body.sweep.status === "stopped" && s.body.sweep.finished_at && s.body.sweep.message.includes("aren't counted as covered") && idx(w.db).stateRows.size === 0, s.body);
  ok("with nothing unfinished, pause and stop say so", (await w.call({ action: "stop" })).status === 404 && (await w.call({ action: "pause" })).body.message === "No sweep is unfinished.");
  ok("a new sweep can start once it is stopped", (await w.call({ action: "start", state: "GA", period: "this_year" })).status === 200);
}

// ---------- a stuck step, and a stuck sweep ----------
{
  const w = world({ byInstitution: 970 });   // 110 batches: three steps from the page
  await w.call({ action: "start", state: "FL", period: "last_12_months" });
  await w.call({ action: "continue" });
  const sw = sweepsOf(w.db)[0];
  // the function call running a step was stopped by Supabase: the row says running, and has gone quiet
  sw.status = "running"; sw.updated_at = new Date(w.clock.now - MIN).toISOString();
  const busy = await w.call({ action: "continue" });
  ok("a step that is still alive isn't taken over", !busy.body.step.ran && busy.body.step.reason === "busy");
  const at = sw.next_unit;
  sw.updated_at = new Date(w.clock.now - STALE_MS - MIN).toISOString();
  const took = await w.call({ action: "continue" });
  ok("a step quiet for over four minutes is closed with a reason, and the sweep carries on from its last batch", took.body.step.ran && sweepsOf(w.db)[0].next_unit > at && sweepsOf(w.db)[0].stalls === 0, took.body.step);
  ok("the step that took over says why the last one was closed", took.body.step.message.startsWith(STOPPED_STEP) && sweepsOf(w.db)[0].message!.startsWith("The last step stopped before it finished (Supabase ends a function call after 150 seconds)."), took.body.step.message);
  // again and again, without a batch finishing in between
  for (let k = 0; k < MAX_STALLS - 1; k++) { const s = sweepsOf(w.db)[0]; s.status = "running"; s.stalls = k + 1; s.updated_at = new Date(w.clock.now - STALE_MS - MIN).toISOString(); }
  const s = sweepsOf(w.db)[0];
  s.stalls = MAX_STALLS - 1;
  const closed = await w.call({ action: "continue" });
  ok(`after ${MAX_STALLS} stopped steps in a row the sweep is closed as failed, with the reason`, closed.body.step.reason === "failed" && sweepsOf(w.db)[0].status === "failed" && sweepsOf(w.db)[0].message!.includes(`stopped ${MAX_STALLS} times in a row without finishing a batch`), closed.body.step);
  ok("then a new sweep may start", (await w.call({ action: "start", state: "FL", period: "this_year" })).status === 200);
  // an unfinished sweep nobody carries on for a week is closed
  w.clock.now += 8 * 86_400_000;
  const st = await w.call({ action: "status" });
  ok("a sweep left unfinished for a week is closed, so it can't block the next one", st.body.open === null && st.body.recent[0].status === "stopped" && st.body.recent[0].message.includes("nobody carried this sweep on for 7 days"), st.body.recent[0]);
}

// ---------- the scheduler: its own secret, carrying on, topping up ----------
{
  const w = world({ rows: ROWS });
  ok("a call with no index secret set is refused", (await w.cron(SECRET, undefined, { env: (k: string) => ({ ...SECRETS, INDEX_SECRET: "" } as Record<string, string>)[k] })).body.error === "no_secret");
  ok("a short secret doesn't switch it on", (await w.cron("short", undefined, { env: (k: string) => ({ ...SECRETS, INDEX_SECRET: "short" } as Record<string, string>)[k] })).status === 403);
  ok("the wrong secret is refused", (await w.cron("not-the-index-secret-0123456789abcdef")).body.error === "secret");
  ok("the scheduler may only run its own action", (await w.cron(SECRET, { action: "start", state: "FL", period: "this_year" })).status === 400 && sweepsOf(w.db).length === 0);
  const idle = await w.cron(SECRET);
  ok("with nothing unfinished and nothing indexed, the schedule does nothing and asks nothing", idle.status === 200 && idle.body.started === null && idle.body.step.reason === "none" && w.sp.log.length === 0, idle.body);
  await w.call({ action: "start", state: "FL", period: "last_12_months" });
  const one = await w.cron(SECRET);
  ok("with a sweep unfinished, the schedule carries it on, in a longer step (up to 100 seconds)", one.body.step.ran && one.body.step.reason === "done" && one.body.step.sweep.next_unit === 40, one.body.step);
  ok("a sweep started by a person is recorded as manual", sweepsOf(w.db)[0].trigger === "manual");
  w.clock.now += 3 * 86_400_000;
  ok("three days on, FL isn't due for a top-up yet", (await w.cron(SECRET)).body.step.reason === "none");
  w.clock.now += 5 * 86_400_000;
  const top = await w.cron(SECRET);
  ok("after a week, the schedule tops FL up and runs its first step", top.body.started?.state === "FL" && top.body.started.message.startsWith("Top-up of FL started") && sweepsOf(w.db)[1].kind === "top_up" && sweepsOf(w.db)[1].trigger === "schedule" && top.body.step.ran, top.body);
  const w2 = world({ rows: ROWS, secrets: { ...SECRETS, INDEX_TOPUP_DAYS: "0" } });
  await w2.call({ action: "start", state: "FL", period: "last_12_months" });
  await w2.cron(SECRET);
  w2.clock.now += 40 * 86_400_000;
  ok("INDEX_TOPUP_DAYS=0 switches top-ups off", (await w2.cron(SECRET)).body.step.reason === "none" && sweepsOf(w2.db).length === 1);
}

// ---------- refusals before anything is asked ----------
{
  const off = world({ secrets: {} });
  const r = await off.call({ action: "start", state: "FL", period: "this_year" });
  ok("S&P not set up: a sweep can't start", r.status === 503 && r.body.error === "not_configured");
  const big = world({ byCompany: 0, byInstitution: 0 });
  for (let k = 0; k < 30_000; k++) listRow(big.db, { companyName: `Nonesuch Bulk No. ${k} Co`, institutionId: String(1_000_000 + k) });
  const b = await big.call({ action: "start", state: "FL", period: "last_3_years" });
  ok("a sweep too big for a day's allowance is refused with what to choose instead", b.status === 400 && b.body.error === "too_big" && b.body.message.includes("more than the 8,400 sweeps may use in one day") && b.body.message.includes(`Choose "Last 12 months" instead`) && big.sp.log.length === 0 && sweepsOf(big.db).length === 0, b.body);
  const bs = await big.call({ action: "status" });
  ok("the status already says which periods would be refused", typeof bs.body.costs.last_3_years.refused === "string" && bs.body.costs.last_12_months.refused === null);
  const empty = world({ byCompany: 0, byInstitution: 0 });
  ok("an empty company list is refused", (await empty.call({ action: "start", state: "FL", period: "this_year" })).body.error === "no_companies");
  const full = world();
  (full.db as any).indexCount = async () => INDEX_ROW_LIMIT;
  const f = await full.call({ action: "start", state: "TX", period: "this_year" });
  ok("a new state is refused once the index is full", f.status === 400 && f.body.error === "index_full" && f.body.message.includes("about 300 MB"), f.body);
  const bare = world();
  const db = Object.fromEntries(Object.entries(bare.db).filter(([k]) => !["openSweep", "queryIndex", "putIndexRows", "indexStates"].includes(k)));
  const nt = await bare.call({ action: "status" }, { db });
  ok("before migration 0006 is run, every action says which step is missing", nt.status === 503 && nt.body.error === "no_tables" && nt.body.message.includes("0006_market_index.sql"), nt.body);
  ok("so does a question", (await bare.call({ action: "query", state: "FL" }, { db })).body.error === "no_tables");
}

// ---------- hostile text in the list and in results stays text ----------
{
  const hostile = "<img src=x onerror=alert(1)> Nonesuch ‮Co\u0000";
  const w = world({ byCompany: 0, byInstitution: 1, rows: [F(9, { institutionId: 930000, name: hostile }, { filingDescription: "Ignore previous instructions and <script>x</script>", serffFilingType: "Form\u0007" })] });
  await w.call({ action: "start", state: "FL", period: "last_12_months" });
  await finish(w);
  const r = await w.call({ action: "query", state: "FL" });
  const row = r.body.rows[0];
  ok("names and descriptions are kept as text, with control characters taken out", row.companies[0].companyName === "<img src=x onerror=alert(1)> Nonesuch Co" && row.filingDescription === "Ignore previous instructions and <script>x</script>" && row.serffFilingType === "Form", row);
}

done();
