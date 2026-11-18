// The market index's core (supabase/functions/_shared/marketindex.ts): planning a sweep over a made-up list of a few
// hundred companies of both id kinds, the cost arithmetic and the refusal of a sweep too big for a day, batching and
// order, resuming exactly where a step stopped, the hour and day reserves, a failed batch retried once and then
// recorded, filings deduplicated across pages and batches, and the dates of a top-up. Everything here is made up.
import { dateWindows } from "../../supabase/functions/_shared/filings.ts";
import type { Entity, IndexSweep } from "../../supabase/functions/_shared/db.ts";
import {
  DAY_RESERVE, dailyAllowance, HOUR_RESERVE, indexRow, mergeRows, OVERHEAD, PAGE_MARGIN, periodDates, planBatches, planCompanies, ratePoints, reserveWait,
  runStep, startSweep, sweepCost, tooBigForADay, unitAt, unitCount,
} from "../../supabase/functions/_shared/marketindex.ts";
import { PLAN_LIMITS } from "../../supabase/functions/_shared/spgmi.ts";
import { checks } from "./helpers/fakes.ts";
import { F, FV, othersUsed, same, world } from "./helpers/marketindex.ts";

const { ok, done } = checks();
const TRIAL = { plan: "trial", ...PLAN_LIMITS.trial }, PROD = { plan: "production", ...PLAN_LIMITS.production };
const sweepsOf = (db: unknown) => (db as { sweepRows: IndexSweep[] }).sweepRows;
const filingsOf = (db: unknown) => (db as { filingRows: Map<string, any> }).filingRows;
const statesOf = (db: unknown) => (db as { stateRows: Map<string, any> }).stateRows;

// ---------- planning: which companies, in which order, in which batches ----------
{
  const w = world();
  const list = await w.db.allEntities!(20_000);
  const { companies, unsearchable } = planCompanies(list);
  ok("every company with an S&P id is planned once; the NAIC-only ones are counted as unsearchable", companies.length === 400 && unsearchable === 3, { n: companies.length, unsearchable });
  ok("company ids come first, then institution ids, each in order of id", companies.slice(0, 130).every((c, k) => c[0] === "c" && c[1] === 9300000 + k) && companies.slice(130).every((c, k) => c[0] === "i" && c[1] === 930000 + k));
  const shuffled = planCompanies([...list].reverse()).companies;
  ok("the order doesn't depend on the order of the list (a resumed sweep finds the same batches)", same(shuffled, companies));
  const dup = planCompanies([...list, { ...list[0] }, { companyId: "9300001", institutionId: "777", companyName: "Same company, both ids", naicCompanyCode: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null } as Entity]);
  ok("a company listed twice, or with both ids, is planned once, by company id", dup.companies.length === 400);
  const batches = planBatches(companies);
  ok("batches of at most 10, never mixing the two kinds of id", batches.length === 13 + 27 && batches.every((b) => b.length <= 10 && b.every((x) => x[0] === b[0][0])) && batches[12].length === 10 && batches[12][0][0] === "c" && batches[13][0][0] === "i", batches.map((b) => b.length));
  const plan = { companies, windows: dateWindows("2023-11-20", "2026-11-18"), statusIds: [1] };
  ok("three years of dates are three windows; units are batches × windows", plan.windows.length === 3 && unitCount(plan) === 120);
  const u0 = unitAt(plan, 0)!, u1 = unitAt(plan, 1)!, u3 = unitAt(plan, 3)!, last = unitAt(plan, 119)!;
  ok("a batch takes every window before the next batch starts", same(u0.batch, u1.batch) && u0.window !== u1.window && !same(u3.batch, u0.batch) && same(u3.window, u0.window) && u0.kind === "companyId" && last.kind === "institutionId");
  ok("past the last unit there is nothing", unitAt(plan, 120) === null && unitAt(plan, -1) === null);
}

// ---------- periods and dates ----------
{
  const t = "2026-11-18";
  ok("this year runs from 1 January", same(periodDates("this_year", t), { from: "2026-01-01", to: t }));
  ok("the last 12 months is one window of 365 days", same(periodDates("last_12_months", t), { from: "2025-11-19", to: t }) && dateWindows("2025-11-19", t).length === 1);
  const three = periodDates("last_3_years", t);
  ok("the last 3 years is exactly three windows", three.from === "2023-11-20" && dateWindows(three.from, t).length === 3 && dateWindows("2023-11-19", t).length === 4, three);
}

// ---------- the cost arithmetic ----------
{
  const c = sweepCost({ c: 0, i: 2700 }, 1, TRIAL);
  ok("2,700 companies by institution id over one year: 270 batches, at least 270 requests", c.batches === 270 && c.minimum === 270 && c.companies === 2700);
  ok("the estimate adds 10% for further pages and 2 to sign in", c.estimate === Math.ceil(270 * (1 + PAGE_MARGIN)) + OVERHEAD && c.estimate === 299, c);
  ok("minutes of S&P time at the app's spacing of 1.1 seconds", c.minutes === Math.ceil(299 * 1.1 / 60) && c.minutes === 6);
  ok("shares of the hour and the day", Math.abs(c.shareOfHour - 299 / 500) < 1e-9 && Math.abs(c.shareOfDay - 299 / 12000) < 1e-9);
  ok("it fits inside one hour, leaving 150 for people", c.perHour === 350 && c.hours === 1 && c.fits);
  const three = sweepCost({ c: 0, i: 2700 }, 3, TRIAL);
  ok("three years: 810 requests at least, about 893, over 3 hours", three.minimum === 810 && three.estimate === 893 && three.hours === 3 && three.fits, three);
  const mixed = sweepCost({ c: 5, i: 11 }, 2, TRIAL);
  ok("each kind of id is batched on its own: 5 + 11 companies are 3 batches", mixed.batches === 3 && mixed.minimum === 6);
  ok("the day's allowance for sweeps: the day less its reserve, and no more than 24 hours less the hour's reserve", dailyAllowance(TRIAL) === Math.min(12000 - DAY_RESERVE, 24 * (500 - HOUR_RESERVE)) && dailyAllowance(TRIAL) === 8400 && dailyAllowance(PROD) === 44400);
  const today = sweepCost({ c: 0, i: 2700 }, 1, TRIAL, { hour: 10, day: 8900 });
  ok("with today's usage: what is left today for sweeps, and whether it finishes today", today.todayLeft === 100 && today.finishesToday === false && sweepCost({ c: 0, i: 2700 }, 1, TRIAL, { hour: 0, day: 0 }).finishesToday === true);
  const big = tooBigForADay({ c: 0, i: 30000 }, "last_3_years", 3, TRIAL, "2026-11-18");
  ok("a sweep that can't finish inside a day's allowance is refused, with what to choose instead", !!big && big.includes("about 9,902 S&P requests") && big.includes("more than the 8,400 sweeps may use in one day") && big.includes(`Choose "Last 12 months" instead (about 3,302 requests)`) && big.includes("Nothing was asked of S&P."), big);
  const huge = tooBigForADay({ c: 0, i: 90000 }, "this_year", 1, TRIAL, "2026-11-18");
  ok("when no period fits, it says why and what would help", !!huge && huge.includes("Even the shortest period is too big") && huge.includes("SPGMI_ACCOUNT=production"), huge);
  ok("a sweep that fits is not refused; a production account takes far more", tooBigForADay({ c: 0, i: 2700 }, "last_3_years", 3, TRIAL, "2026-11-18") === null && tooBigForADay({ c: 0, i: 30000 }, "last_3_years", 3, PROD, "2026-11-18") === null);
}

// ---------- the reserves ----------
{
  const now = Date.parse("2026-11-18T14:20:00Z");
  ok("below both reserves, the sweep may go on", reserveWait({ hour: 349, day: 8999 }, TRIAL, now) === null);
  const h = reserveWait({ hour: 350, day: 400 }, TRIAL, now)!;
  ok("at 350 of 500 this hour, it waits for the next hour and says so", !!h && h.until === Date.parse("2026-11-18T15:01:00Z") && h.message.includes("350 of this hour's 500") && h.message.includes("leave the last 150") && h.message.includes("after 15:01 UTC"), h);
  const d = reserveWait({ hour: 10, day: 9000 }, TRIAL, now)!;
  ok("at 9,000 of 12,000 today, it waits for midnight UTC and says so", !!d && d.until === Date.parse("2026-11-19T00:01:00Z") && d.message.includes("9,000 of today's 12,000") && d.message.includes("last 3,000") && d.message.includes("midnight UTC"), d);
}

// ---------- filings as the index keeps them ----------
{
  const r = indexRow({ ...F(1, { institutionId: 930001, name: "Nonesuch Carrier No. 1 Co" }), companies: [{ companyId: null, companyName: "Nonesuch Carrier No. 1 Co\u0007", naicCompanyCode: null, institutionId: 930001 }] } as any, "FL", "sw-1", "2026-11-18T09:00:00.000Z")!;
  ok("a search row becomes an index row keyed by its filing version", r.filing_key === "v:" + FV(1) && r.state === "FL" && r.publish_date === "2026-06-01" && r.rate_impact === 4.5 && r.sfc_number === "ZZZ1000001" && r.tracking_number === null && r.description === null);
  ok("company names lose control characters", same(r.companies, [{ n: "Nonesuch Carrier No. 1 Co", c: null, i: 930001 }]));
  ok("a row from another state is left out", indexRow(F(2, { institutionId: 1, name: "x" }, { serffFilingStateId: "GA" }) as any, "FL", null, "x") === null);
  ok("a row with no version id falls back to its event id; with neither it is left out", indexRow(F(3, { institutionId: 1, name: "x" }, { filingVersionId: null }) as any, "FL", null, "x")!.filing_key === "e:600003" && indexRow(F(4, { institutionId: 1, name: "x" }, { filingVersionId: null, serffFilingEntityEventId: null }) as any, "FL", null, "x") === null);
  const odd = indexRow(F(5, { institutionId: 1, name: "x" }, { publishDate: "2026-02-30", dateSubmitted: "11/05/2026", overallRateImpact: "-2.5%", pages: "x", documentId: "71000005" }) as any, "FL", null, "x")!;
  ok("dates that aren't real are left empty; rate text is read; odd numbers are left out", odd.publish_date === null && odd.date_submitted === null && odd.rate_impact === -2.5 && odd.pages === null && odd.document_id === 71000005);
  ok("rate impact: numbers and plain text read, anything else or beyond ±1,000 left out", ratePoints(6.5) === 6.5 && ratePoints("-11") === -11 && ratePoints("12%") === 12 && ratePoints("n/a") === null && ratePoints(5000) === null && ratePoints(null) === null);
  const a = indexRow(F(9, { institutionId: 930001, name: "A Co" }) as any, "FL", null, "x")!, b = indexRow(F(9, { companyId: 9300002, name: "B Co" }) as any, "FL", null, "x")!;
  const m = mergeRows([a, b, a]);
  ok("the same filing twice in one save is one row naming every company", m.length === 1 && same(m[0].companies.map((c) => c.n), ["A Co", "B Co"]));
}

// ---------- a sweep: batches in order, every one once, resumed exactly where it stopped ----------
{
  const rows = [
    F(1, { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }), F(2, { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }, { publishDate: "2026-01-05" }),
    F(3, { institutionId: 930005, name: "Nonesuch Carrier No. 5 Co" }, { serffFilingType: "Form", overallRateImpact: null }),
    // one filing named for a company-id company and an institution-id company: two batches, one row
    F(50, { companyId: 9300002, name: "Nonesuch Mutual No. 2 Co" }), F(50, { institutionId: 930001, name: "Nonesuch Carrier No. 1 Co" }),
    // published outside the 12 months, or in another state: not asked for
    F(60, { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }, { publishDate: "2025-01-05" }), F(61, { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }, { serffFilingStateId: "GA" }),
  ];
  const w = world({ rows });
  const started = await startSweep(w.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  ok("starting a sweep asks nothing of S&P and records it as waiting", started.ok && w.sp.log.length === 0 && started.sweep.status === "waiting" && started.sweep.units_total === 40 && started.sweep.companies_total === 400, started);
  ok("the start says what it costs", started.ok && started.message.includes("About 46 S&P requests (at least 40") && started.message.includes("9.2% of an hour's limit of 500"), started.ok && started.message);
  const c1 = w.ctx({ stepMs: 15_000 });
  const s1 = await runStep(c1);
  const after1 = sweepsOf(w.db)[0];
  ok("a step stops when its time is up and saves its place", s1.ran && s1.reason === "waiting" && after1.status === "waiting" && after1.next_unit > 5 && after1.next_unit < 40 && after1.resume_after === null, { s1, next: after1.next_unit });
  const firstBatches = w.searches().length;
  ok("each finished batch was one request (no extra pages here), one sign-in and one list of statuses besides", firstBatches === after1.next_unit && w.sp.log.filter((c) => c.path === "token").length === 1 && w.sp.calls("/api/v1/reference").length === 1);
  ok("the sweep counts the requests it used", after1.requests === c1.used() && after1.requests === firstBatches + 2);
  const s2 = await runStep(w.ctx());
  const all = w.searches(), fin = sweepsOf(w.db)[0];
  ok("the next step carries on to the end", s2.reason === "done" && fin.status === "done" && fin.next_unit === 40 && fin.finished_at !== null && fin.plan === null);
  const asked = all.map((p) => `${p.companyId ? "c" : "i"}:${(p.companyId ?? p.institutionId).join(",")}`);
  const planned = planBatches(planCompanies(await w.db.allEntities!(20000)).companies).map((b) => `${b[0][0]}:${b.map((x) => x[1]).join(",")}`);
  ok("every batch was asked exactly once, in the planned order, across the two steps", same(asked, planned), { asked: asked.length, planned: planned.length });
  ok("each request is one state, the 12 months, every filing status, 500 rows a page", all.every((p) => same(p.serffFilingStateId, ["FL"]) && p.minPublishDate === "2025-11-19" && p.maxPublishDate === "2026-11-18" && same(p.filingStatusId, [1, 2, 3]) && p.pageSize === 500 && p.pageNumber === 1 && !p.typeOfInsuranceId));
  const kept = filingsOf(w.db);
  ok("the index holds each filing once, counted in its state", kept.size === 4 && [...kept.values()].every((r) => r.state === "FL"), [...kept.keys()]);
  ok("a filing found through two batches names both companies", same(kept.get("FL|v:" + FV(50)).companies.map((c: any) => c.n), ["Nonesuch Carrier No. 1 Co", "Nonesuch Mutual No. 2 Co"]));
  const cov = statesOf(w.db).get("FL");
  ok("the coverage of FL is recorded: the period, every company covered, none missed", cov && cov.from_date === "2025-11-19" && cov.to_date === "2026-11-18" && cov.companies_covered === 400 && cov.companies_missed === 0 && cov.last_sweep_id === fin.id);
  ok("the finished sweep says what it did", fin.message!.includes("Swept FL for filings published 19 Nov 2025 to 18 Nov 2026: 400 companies in 40 batches") && fin.message!.includes("now holds 4 filings") && fin.message!.includes("Every company with an S&P id was covered."), fin.message);
  const again = await runStep(w.ctx());
  ok("with nothing unfinished a step does nothing and asks nothing", !again.ran && again.reason === "none" && w.searches().length === all.length);
}

// ---------- paging: further pages are asked, and a filing on two pages is kept once ----------
{
  const who = { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }, other = { companyId: 9300001, name: "Nonesuch Mutual No. 1 Co" };
  const rows = [F(1, who), F(2, who), F(3, who), F(3, other), F(4, who), F(5, other)];
  const w = world({ rows, byCompany: 2, byInstitution: 0 });
  w.state.pageSize = 2;
  await startSweep(w.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  const s = await runStep(w.ctx());
  ok("a batch with three pages takes three requests", s.reason === "done" && w.searches().length === 3 && same(w.searches().map((p) => p.pageNumber), [1, 2, 3]));
  const kept = filingsOf(w.db);
  ok("the filing on two pages is one row with both companies", kept.size === 5 && same(kept.get("FL|v:" + FV(3)).companies.map((c: any) => c.n), ["Nonesuch Mutual No. 0 Co", "Nonesuch Mutual No. 1 Co"]));
}

// ---------- the hour's and the day's reserves ----------
{
  const w = world();
  const setOthers = othersUsed(w.db, { hour: 330, day: 1000 });
  await startSweep(w.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  const s = await runStep(w.ctx());
  const sw = sweepsOf(w.db)[0];
  ok("with 330 of 500 used by others this hour, the sweep stops before the last 150 and waits for the next hour", s.reason === "waiting" && sw.status === "waiting" && sw.resume_after === "2026-11-18T10:01:00.000Z" && w.searches().length === 18 && sw.next_unit === 18, { n: w.searches().length, sw: sw.resume_after, next: sw.next_unit });
  ok("it says why and when it carries on", sw.message!.includes("Waiting to leave room for people: 350 of this hour's 500") && sw.message!.includes("after 10:01 UTC"), sw.message);
  const early = await runStep(w.ctx());
  ok("a step before that time does nothing", !early.ran && early.reason === "later" && w.searches().length === 18);
  w.clock.now = Date.parse("2026-11-18T10:01:30Z"); setOthers({ hour: 0, day: 9000 - 20 - 18 });
  const s2 = await runStep(w.ctx());
  const sw2 = sweepsOf(w.db)[0];
  ok("in the next hour it carries on until only the day's reserve is left, then waits for midnight UTC", s2.reason === "waiting" && sw2.resume_after === "2026-11-19T00:01:00.000Z" && sw2.message!.includes("of today's 12,000") && sw2.next_unit > 18 && sw2.next_unit < 40, { r: sw2.resume_after, n: sw2.next_unit, m: sw2.message });
  w.clock.now = Date.parse("2026-11-19T00:02:00Z"); setOthers({ hour: 0, day: 0 });
  const s3 = await runStep(w.ctx());
  ok("the next day it finishes, every batch asked once", s3.reason === "done" && sweepsOf(w.db)[0].next_unit === 40 && new Set(w.searches().map((p) => JSON.stringify([p.companyId, p.institutionId]))).size === 40 && w.searches().length === 40);
}

// ---------- with the day nearly used up, nothing is asked; the throttle's own limit stops a sweep without loss ----------
{
  const w = world();
  othersUsed(w.db, { hour: 0, day: 12000 - 5 });
  await startSweep(w.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  const s = await runStep(w.ctx());
  const sw = sweepsOf(w.db)[0];
  ok("when the day's reserve is reached the sweep waits for midnight without asking S&P anything, not even to sign in", s.reason === "waiting" && w.sp.log.length === 0 && sw.resume_after === "2026-11-19T00:01:00.000Z" && sw.next_unit === 0, { log: w.sp.log.length, r: sw.resume_after });

  const v = world();
  await startSweep(v.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  await runStep(v.ctx({ stepMs: 5_000 }));
  const at = sweepsOf(v.db)[0].next_unit, take = v.db.takeSlot.bind(v.db);
  // someone else's requests fill the hour between the reserve check and the request (the throttle refuses the slot)
  v.db.takeSlot = async (l) => ({ allowed: false, waitMs: 0, hour: l.hour, day: 600 });
  const r = await runStep(v.ctx());
  const sv = sweepsOf(v.db)[0];
  ok("when the throttle refuses a request the sweep keeps its place and waits for the next hour", r.reason === "waiting" && sv.next_unit === at && sv.resume_after === "2026-11-18T10:01:00.000Z" && sv.message!.includes("this hour's limit of 500 S&P requests is used up") && sv.message!.includes("carries on after 10:01 UTC"), { at, n: sv.next_unit, r: sv.resume_after, m: sv.message });
  v.db.takeSlot = take;
}

// ---------- a failed batch is retried once, then recorded and skipped ----------
{
  const rows = [F(1, { institutionId: 930015, name: "Nonesuch Carrier No. 15 Co" }), F(2, { institutionId: 930025, name: "Nonesuch Carrier No. 25 Co" })];
  const w = world({ rows });
  w.state.failIds.add(930015);   // the batch of institution ids 930010 to 930019 fails every time
  await startSweep(w.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  w.state.fail = 1;              // and the very first request fails once
  const s = await runStep(w.ctx({ stepMs: 100_000 }));
  const sw = sweepsOf(w.db)[0];
  const forUnit = (id: number) => w.searches().filter((p) => (p.companyId ?? p.institutionId).includes(id)).length;
  ok("a batch that fails once is asked again and kept", forUnit(9300000) === 2 && !sw.missed.some((m) => m.ids.includes(9300000)));
  ok("a batch that fails twice is recorded and skipped; the sweep goes on", s.reason === "done" && forUnit(930015) === 2 && sw.missed.length === 1 && same(sw.missed[0].ids, [930010, 930011, 930012, 930013, 930014, 930015, 930016, 930017, 930018, 930019]) && sw.missed[0].kind === "institutionId" && sw.missed[0].reason.includes("S&P's service failed (500)"), sw.missed);
  ok("the companies it holds are named", sw.missed[0].names[5] === "Nonesuch Carrier No. 15 Co");
  ok("the result says which companies were not covered", sw.message!.includes("10 companies were not covered because their batches failed twice: Nonesuch Carrier No. 10 Co;"), sw.message);
  const cov = statesOf(w.db).get("FL");
  ok("the coverage counts them as not covered", cov.companies_covered === 390 && cov.companies_missed === 10 && cov.missed.length === 10 && cov.missed[0].name === "Nonesuch Carrier No. 10 Co");
  ok("the filings of the other batches are in the index; the failed batch's aren't", filingsOf(w.db).has("FL|v:" + FV(2)) && !filingsOf(w.db).has("FL|v:" + FV(1)));
}

// ---------- top-up dates ----------
{
  const w = world({ rows: [F(1, { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" }, { publishDate: "2026-11-25" })] });
  await startSweep(w.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  await runStep(w.ctx({ stepMs: 100_000 }));
  ok("before a week has passed the index already runs to today", statesOf(w.db).get("FL").to_date === "2026-11-18");
  const early = await startSweep(w.ctx(), { state: "FL", kind: "top_up" });
  ok("a top-up on the day the index ends is refused", !early.ok && early.error === "up_to_date" && early.message.includes("already runs to 18 Nov 2026"), early);
  w.clock.now = Date.parse("2026-11-27T09:00:00Z");
  const before = w.searches().length;
  const t = await startSweep(w.ctx(), { state: "FL", kind: "top_up" });
  ok("a top-up asks only for filings published since the index's last day", t.ok && t.sweep.from_date === "2026-11-18" && t.sweep.to_date === "2026-11-27" && t.sweep.period === "top_up" && t.sweep.kind === "top_up", t);
  ok("and costs as many requests as a sweep of a year: one per batch", t.ok && t.cost.minimum === 40 && t.cost.windows === 1);
  await runStep(w.ctx({ stepMs: 100_000 }));
  const asked = w.searches().slice(before);
  ok("its requests ask for 18 Nov to 27 Nov", asked.length === 40 && asked.every((p) => p.minPublishDate === "2026-11-18" && p.maxPublishDate === "2026-11-27"));
  const cov = statesOf(w.db).get("FL");
  ok("after the top-up the index runs from the sweep's first day to the top-up's last", cov.from_date === "2025-11-19" && cov.to_date === "2026-11-27" && cov.last_complete_at.startsWith("2026-11-27") && cov.last_sweep_id === sweepsOf(w.db)[1].id, cov);
  ok("the new filing is in the index and the old ones are kept", filingsOf(w.db).has("FL|v:" + FV(1)) && sweepsOf(w.db).length === 2);
  w.clock.now = Date.parse("2030-01-10T09:00:00Z");
  const old = await startSweep(w.ctx(), { state: "FL", kind: "top_up" });
  ok("a top-up of an index more than three years old is refused: sweep again", !old.ok && old.error === "too_old" && old.message.includes("Start a new sweep of FL instead"), old);
  const none = await startSweep(w.ctx(), { state: "GA", kind: "top_up" });
  ok("a state that isn't indexed can't be topped up", !none.ok && none.error === "not_indexed");
}

done();
