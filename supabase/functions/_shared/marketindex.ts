// The market index: filing details for chosen states, swept from S&P for every company in the app's company list and
// kept in the app's own database (migration 0006), so a question about a market can be answered over every company
// in the list, at no S&P cost, instead of over the ten or fifteen carriers someone thought to check.
//
// Why a sweep, and what it costs. S&P's filings search always needs companies named: one request takes at most 10
// company ids (or 10 institution ids) and 365 days of publish dates, and returns up to 500 rows a page. So a sweep of
// one state asks for every company in the list, 10 at a time: for the owner's list of about 2,700 companies that is
// about 270 requests for each year of dates, plus one for each further page of 500 rows. The trial account allows 1
// request a second, 500 an hour and 12,000 a day, shared with everything else the team does, and a Supabase function
// call ends after 150 seconds. So a sweep:
//   - runs in steps that each fit in one function call, and saves its place after every batch of 10 companies;
//   - is carried on by the page while Corp Dev has it open (as an Ask Claude answer is), or by a schedule
//     (supabase/index_schedule.sql); closing the tab only pauses it;
//   - sends every request through the same throttle and counters as the rest of the app (makeGate in spgmi.ts);
//   - leaves room for people: it waits for the next hour when fewer than HOUR_RESERVE requests are left in the hour,
//     and for the next day when fewer than DAY_RESERVE are left in the day, and says when it will carry on;
//   - is refused before it starts when it could not finish inside one day's allowance for sweeps;
//   - retries a failed batch once, then records it and its companies as not covered and moves on.
// Only one sweep is unfinished at a time (a unique index in migration 0006). A step whose function call was stopped
// is closed and the sweep carries on from the last saved batch; after MAX_STALLS such stops in a row the sweep is
// closed as failed with the reason.
//
// No new S&P endpoints or columns: a sweep is the filing search the Filings view runs (searchFilings in filings.ts),
// one batch of 10 companies and one window of dates at a time, with every filing status in S&P's list.

import type { Db, Entity, IndexGroup, IndexQueryParams, IndexQueryResult, IndexRow, IndexState, IndexSweep, MissedBatch, PlanCompany, SweepPlan } from "./db.ts";
import { type Cell, dateWindows, type Filing, filingNumberText, getReference, MAX_IDS_PER_REQUEST, MAX_WINDOW_DAYS, PAGE_SIZE, searchFilings, type SearchParams, SOURCE } from "./filings.ts";
import type { Env } from "./http.ts";
import { NOT_CONFIGURED, type Spgmi, SpgmiError } from "./spgmi.ts";

// ---------- the numbers ----------

export const PERIODS = { this_year: "This year", last_12_months: "Last 12 months", last_3_years: "Last 3 years" } as const;
export type Period = keyof typeof PERIODS;

/** Requests left in the hour that a sweep never uses: 150 is the most one Ask Claude question may use
    (LIMITS.spRequests in chat.ts), and more than two of the widest Filings searches (60 each, MAX_SEARCH_REQUESTS),
    so someone can always ask a full question or run a wide search while a sweep is going. On the trial account that
    leaves a sweep 350 requests an hour, enough for a one-year sweep of one state (about 300) inside one hour. */
export const HOUR_RESERVE = 150;
/** Requests left in the day that sweeps never use: a quarter of the trial's 12,000, about twenty full Ask Claude
    questions or fifty wide searches. With the hourly reserve, sweeps can use at most 8,400 a day on the trial. */
export const DAY_RESERVE = 3_000;
/** S&P's spacing between requests in the app (GAP_MS in db.ts): a little over one a second. */
export const SECONDS_PER_REQUEST = 1.1;
/** A step stops starting new batches after this long: short when the page is waiting on it, so the progress it
    shows stays fresh, and longer from the schedule, still well inside Supabase's 150 seconds. */
export const STEP_MS_PAGE = 40_000, STEP_MS_SCHEDULE = 100_000;
/** A batch already under way may run on this long past the step's end before it is given up and asked again. */
export const STEP_SPARE_MS = 30_000;
/** A "running" sweep with no sign of life for this long had its function call stopped by Supabase. */
export const STALE_MS = 4 * 60_000;
/** Stopped steps in a row, with no batch finished in between, before the sweep is closed as failed. */
export const MAX_STALLS = 3;
/** An unfinished sweep nobody has carried on for this long is closed, so it can't block a new one forever. */
export const ABANDON_DAYS = 7;
/** Pages one batch and window may use: 20 pages is 10,000 filings for 10 companies in one state and one year. */
export const MAX_PAGES = 20;
/** The estimate of extra pages: 10% more requests than one per batch and window. */
export const PAGE_MARGIN = 0.1;
/** Requests a sweep spends besides the batches: one sign-in and S&P's list of filing statuses. */
export const OVERHEAD = 2;
/** Companies read from the list for a sweep: far more than the owner's 2,700. */
export const MAX_LIST = 50_000;
/** Measured: 500 bytes a filing row with its indexes, on 50,000 made-up rows shaped like real ones (no description,
    one or two companies); 600 allows for some descriptions. */
export const BYTES_PER_ROW = 600;
/** The index stops taking new states at this many filings, about 300 MB, so it stays well inside the free plan's
    500 MB database with room for everything else. */
export const INDEX_ROW_LIMIT = 500_000;
/** Days after which the schedule tops up an indexed state (INDEX_TOPUP_DAYS; 0 switches automatic top-ups off). */
export const TOPUP_DAYS = 7;
/** Rows one answer returns, at most; groups one answer returns, at most; rows Claude sees from one question. */
export const MAX_QUERY_ROWS = 500, QUERY_PAGE = 50, MAX_GROUPS = 100, CLAUDE_ROWS = 40;
/** The longest top-up: past this, start a new sweep. */
export const MAX_TOPUP_DAYS = 3 * 365;

const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const n = (x: number) => x.toLocaleString("en-US");
const plural = (k: number, one: string, many = one + "s") => `${n(k)} ${k === 1 ? one : many}`;
const pct1 = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const shortDay = (s: string | number) => {
  const d = new Date(typeof s === "number" ? s : s.length === 10 ? s + "T00:00:00Z" : s);
  return Number.isNaN(d.getTime()) ? "n/d" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";
const STATE = /^[A-Z]{2}$/;
const clean = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined || typeof v === "object" || typeof v === "boolean") return null;
  const s = String(v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max).trim() : null;
};

/** The publish dates a period covers, up to today (UTC). */
export function periodDates(period: Period, today: string): { from: string; to: string } {
  const t = Date.parse(today + "T00:00:00Z");
  if (period === "this_year") return { from: today.slice(0, 4) + "-01-01", to: today };
  if (period === "last_12_months") return { from: ymd(t - MAX_WINDOW_DAYS * DAY), to: today };
  return { from: ymd(t - (3 * (MAX_WINDOW_DAYS + 1) - 1) * DAY), to: today };
}

// ---------- the plan: every company with an S&P id, in a fixed order, 10 at a time ----------

const idOf = (v: unknown): number | null => (v !== null && v !== undefined && /^\d{1,12}$/.test(String(v).trim()) ? Number(v) : null);

/** Every company in the list that a filing search can take, once: by company id when it has one, otherwise by
    institution id. Company ids first, then institution ids, each in order of id, so the same list always gives the
    same order and a paused sweep resumes exactly where it stopped. unsearchable: companies with neither id. */
export function planCompanies(list: Entity[]): { companies: PlanCompany[]; unsearchable: number } {
  const seen = new Set<string>(), c: PlanCompany[] = [], i: PlanCompany[] = [];
  let unsearchable = 0;
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const cid = idOf(e.companyId), iid = idOf(e.institutionId), name = clean(e.companyName, 80) ?? "n/d";
    if (cid !== null) { if (!seen.has("c" + cid)) { seen.add("c" + cid); c.push(["c", cid, name]); } }
    else if (iid !== null) { if (!seen.has("i" + iid)) { seen.add("i" + iid); i.push(["i", iid, name]); } }
    else unsearchable++;
  }
  const byId = (a: PlanCompany, b: PlanCompany) => a[1] - b[1];
  return { companies: [...c.sort(byId), ...i.sort(byId)], unsearchable };
}

/** Batches of 10 companies, never mixing the two kinds of id. */
export function planBatches(companies: PlanCompany[]): PlanCompany[][] {
  const out: PlanCompany[][] = [];
  for (const kind of ["c", "i"] as const) {
    const list = companies.filter((x) => x[0] === kind);
    for (let k = 0; k < list.length; k += MAX_IDS_PER_REQUEST) out.push(list.slice(k, k + MAX_IDS_PER_REQUEST));
  }
  return out;
}

/** The units a sweep works through: each batch of companies, and for each batch each window of dates. */
export const unitCount = (plan: SweepPlan) => planBatches(plan.companies).length * plan.windows.length;

/** One unit: which batch of companies and which window of dates. */
export function unitAt(plan: SweepPlan, u: number): { batch: PlanCompany[]; kind: "companyId" | "institutionId"; window: [string, string] } | null {
  const batches = planBatches(plan.companies), w = plan.windows.length;
  if (!w || u < 0 || u >= batches.length * w) return null;
  const batch = batches[Math.floor(u / w)];
  return { batch, kind: batch[0][0] === "c" ? "companyId" : "institutionId", window: plan.windows[u % w] };
}

// ---------- what a sweep costs ----------

export type Limits = { plan?: string; hour: number; day: number };
export type Cost = {
  companies: number; batches: number; windows: number; minimum: number; estimate: number;
  minutes: number; shareOfHour: number; shareOfDay: number; perHour: number; hours: number; allowance: number; fits: boolean;
  todayLeft: number | null; finishesToday: boolean | null;
};

/** The most requests sweeps may use in one day: what the day's reserve leaves, and no more than 24 hours at what the
    hourly reserve leaves. */
export const dailyAllowance = (l: Limits) => Math.max(0, Math.min(l.day - DAY_RESERVE, 24 * (l.hour - HOUR_RESERVE)));

/** What a sweep of these companies over these windows costs: the minimum (one request for each batch of 10 companies
    of a kind and each window of up to 365 days), the estimate (plus OVERHEAD and PAGE_MARGIN for further pages),
    minutes of S&P time at the app's spacing, its share of an hour's and a day's limit, the clock hours it spans when
    it leaves room for people, and whether it fits in a day's allowance (and, given today's usage, finishes today). */
export function sweepCost(count: { c: number; i: number }, windows: number, limits: Limits, usage?: { hour: number; day: number }): Cost {
  const batches = Math.ceil(count.c / MAX_IDS_PER_REQUEST) + Math.ceil(count.i / MAX_IDS_PER_REQUEST);
  // rounded first, so 810 × 1.1 is 891, not 892 from floating-point error
  const minimum = batches * windows, estimate = minimum ? Math.ceil(Math.round(minimum * (1 + PAGE_MARGIN) * 1e6) / 1e6) + OVERHEAD : 0;
  const perHour = Math.max(0, limits.hour - HOUR_RESERVE), allowance = dailyAllowance(limits);
  const todayLeft = usage ? Math.max(0, limits.day - DAY_RESERVE - usage.day) : null;
  return {
    companies: count.c + count.i, batches, windows, minimum, estimate,
    minutes: Math.max(1, Math.ceil(estimate * SECONDS_PER_REQUEST / 60)),
    shareOfHour: limits.hour ? estimate / limits.hour : 0, shareOfDay: limits.day ? estimate / limits.day : 0,
    perHour, hours: perHour ? Math.max(1, Math.ceil(estimate / perHour)) : Infinity, allowance, fits: estimate <= allowance,
    todayLeft, finishesToday: todayLeft === null ? null : estimate <= todayLeft,
  };
}

/** The cost in words, for the page and for a refusal. */
export function costWords(c: Cost, l: Limits): string {
  const spread = c.hours <= 1 ? "It fits inside one hour." : `Leaving ${n(HOUR_RESERVE)} requests an hour for people, it runs over about ${plural(c.hours, "hour")}.`;
  return `About ${n(c.estimate)} S&P requests (at least ${n(c.minimum)}: ${plural(c.batches, "batch", "batches")} of up to 10 companies × ${plural(c.windows, "window")} of dates, plus extra pages and ${OVERHEAD} to sign in): `
    + `about ${plural(c.minutes, "minute")} of S&P time at one request a second, ${pct1(c.shareOfHour)} of an hour's limit of ${n(l.hour)} and ${pct1(c.shareOfDay)} of a day's limit of ${n(l.day)}. ${spread}`;
}

/** Why a sweep can't finish inside a day's allowance, and what to choose instead. null when it fits. */
export function tooBigForADay(count: { c: number; i: number }, period: Period | "top_up", windows: number, limits: Limits, today: string): string | null {
  const c = sweepCost(count, windows, limits);
  if (c.fits) return null;
  // the longest period that fits
  const smaller = (["last_3_years", "last_12_months", "this_year"] as Period[]).filter((p) => p !== period).map((p) => {
    const d = periodDates(p, today);
    return { p, cost: sweepCost(count, dateWindows(d.from, d.to).length, limits) };
  }).find((x) => x.cost.fits);
  const instead = smaller ? `Choose "${PERIODS[smaller.p]}" instead (about ${n(smaller.cost.estimate)} requests).`
    : `Even the shortest period is too big: the company list has ${plural(c.companies, "company", "companies")} with an S&P id. Ask for a production S&P account (SPGMI_ACCOUNT=production allows 48,000 a day), or load a shorter company list.`;
  return `This sweep needs about ${n(c.estimate)} S&P requests, more than the ${n(c.allowance)} sweeps may use in one day (the app keeps ${n(DAY_RESERVE)} a day and ${n(HOUR_RESERVE)} an hour for people). ${instead} Nothing was asked of S&P.`;
}

// ---------- leaving room for people ----------

const nextHour = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000 + 3_600_000;
const nextDay = (ms: number) => Math.floor(ms / DAY) * DAY + DAY;

/** When the sweep must wait for people's sake: fewer than DAY_RESERVE requests left today (wait for midnight UTC),
    or fewer than HOUR_RESERVE left this hour (wait for the top of the hour). null when it may go on. */
export function reserveWait(used: { hour: number; day: number }, l: Limits, now: number): { until: number; message: string } | null {
  if (used.day >= l.day - DAY_RESERVE) {
    const until = nextDay(now) + 60_000;
    return { until, message: `Waiting to leave room for people: ${n(used.day)} of today's ${n(l.day)} S&P requests are used, and sweeps leave the last ${n(DAY_RESERVE)} for searches and questions. It carries on after midnight UTC (${shortDay(until)} ${utcTime(until)}).` };
  }
  if (used.hour >= l.hour - HOUR_RESERVE) {
    const until = nextHour(now) + 60_000;
    return { until, message: `Waiting to leave room for people: ${n(used.hour)} of this hour's ${n(l.hour)} S&P requests are used, and sweeps leave the last ${n(HOUR_RESERVE)} for searches and questions. It carries on after ${utcTime(until)}.` };
  }
  return null;
}

// ---------- filings as the index keeps them ----------

const dateOf = (v: unknown): string | null => {
  const s = clean(v, 30);
  const m = s ? s.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/) : null;
  if (!m) return null;
  const d = new Date(m[1] + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === m[1] ? m[1] : null;
};
const intOf = (v: unknown, max = 2_147_483_647): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{1,15}\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(x) && x >= 0 && x <= max ? x : null;
};
const KEY_PART = /^[A-Za-z0-9._-]{1,64}$/;

/** S&P's overall rate impact as percentage points, or null. A number is taken as it is; text like "6.5" or "-2.4%"
    is read; anything else (or beyond ±1,000) is left out. Seen in the Live check on 18 Nov 2026: overallRateImpact was
    a number in percentage points on 6 of 10 rows. */
export function ratePoints(v: unknown): number | null {
  const x = typeof v === "number" ? v : typeof v === "string" && /^\s*[-+]?\d{1,4}(\.\d{1,6})?\s*%?\s*$/.test(v) ? Number(v.replace("%", "")) : NaN;
  return Number.isFinite(x) && Math.abs(x) <= 1000 ? Math.round(x * 1000) / 1000 : null;
}

/** One search row (after dedupe) as the index keeps it, or null when it has neither a filing version id nor an event
    id to tell it apart, or isn't in the state swept. */
export function indexRow(f: Filing, state: string, sweepId: string | null, at: string): IndexRow | null {
  const st = clean(f.serffFilingStateId as Cell, 2)?.toUpperCase();
  if (st && st !== state) return null;
  const fv = clean(f.filingVersionId as Cell, 64), ev = clean(f.serffFilingEntityEventId as Cell, 64);
  const key = fv && KEY_PART.test(fv) ? "v:" + fv : ev && KEY_PART.test(ev) ? "e:" + ev : null;
  if (!key) return null;
  const list = Array.isArray(f.companies) && f.companies.length ? f.companies : [{ companyId: f.companyId as Cell, companyName: f.companyName as Cell, institutionId: f.institutionId as Cell }];
  const companies = list.map((c) => ({ n: clean(c.companyName, 120), c: idOf(c.companyId), i: idOf(c.institutionId) })).filter((c) => c.n || c.c !== null || c.i !== null);
  const doc = intOf(f.documentId, 1e15 - 1);
  return {
    state, filing_key: key, filing_version_id: fv && KEY_PART.test(fv) ? fv : null, document_id: doc && doc > 0 ? doc : null, companies,
    type_of_insurance_id: intOf(f.typeOfInsuranceId), type_of_insurance: clean(f.typeOfInsurance as Cell, 120), sub_type_of_insurance: clean(f.subTypeOfInsurance as Cell, 120),
    filing_type_id: intOf(f.serffFilingTypeId), filing_type: clean(f.serffFilingType as Cell, 80), filing_status_id: intOf(f.filingStatusId), filing_status: clean(f.filingStatus as Cell, 80),
    date_submitted: dateOf(f.dateSubmitted), publish_date: dateOf(f.publishDate), effective_new: dateOf(f.newBusReqEffDate), effective_renewal: dateOf(f.renewBusReqEffDate),
    rate_impact: ratePoints(f.overallRateImpact), rate_impact_text: clean(f.dispOverallRateImpact as Cell, 40), description: clean(f.filingDescription as Cell, 1000),
    tracking_number: clean(f.trackingNumber as Cell, 60), sfc_number: clean(f.sfcNumber as Cell, 60), pages: intOf(f.pages, 1_000_000),
    sweep_id: sweepId, seen_at: at,
  };
}

/** Rows made into one per (state, filing): the same filing named in two pages or two batches keeps every company. */
export function mergeRows(rows: IndexRow[]): IndexRow[] {
  const by = new Map<string, IndexRow>();
  for (const r of rows) {
    const k = r.state + "|" + r.filing_key, kept = by.get(k);
    if (!kept) { by.set(k, { ...r, companies: [...r.companies] }); continue; }
    for (const c of r.companies) if (!kept.companies.some((x) => x.n === c.n && x.c === c.c && x.i === c.i)) kept.companies.push(c);
  }
  return [...by.values()];
}

// ---------- the record of a sweep, as the page and Claude see it ----------

export type PublicSweep = Omit<IndexSweep, "plan"> & { percent: number; companiesMissed: number };
const missedCompanies = (missed: MissedBatch[]) => {
  const out = new Map<string, { kind: "companyId" | "institutionId"; id: number; name: string }>();
  for (const b of missed) b.ids.forEach((id, k) => { const key = b.kind + id; if (!out.has(key)) out.set(key, { kind: b.kind, id, name: b.names[k] ?? "n/d" }); });
  return [...out.values()];
};
export function publicSweep(s: IndexSweep | null): PublicSweep | null {
  if (!s) return null;
  const { plan: _plan, ...rest } = s;
  return { ...rest, missed: s.missed.slice(-50), percent: s.units_total ? Math.min(100, Math.floor((s.next_unit / s.units_total) * 100)) : 0, companiesMissed: missedCompanies(s.missed).length };
}

// ---------- what the index covers ----------

export type Coverage = {
  state: string; from: string; to: string; lastComplete: string; companiesCovered: number; companiesMissed: number; missed: string[]; sentence: string;
};
export function coverageOf(s: IndexState): Coverage {
  return {
    state: s.state, from: s.from_date, to: s.to_date, lastComplete: s.last_complete_at, companiesCovered: s.companies_covered, companiesMissed: s.companies_missed,
    missed: (s.missed ?? []).slice(0, 20).map((m) => m.name),
    sentence: `The market index of ${s.state} holds filings published ${shortDay(s.from_date)} to ${shortDay(s.to_date)}, from a sweep of every company in the app's company list last completed ${shortDay(s.last_complete_at)}: `
      + `${plural(s.companies_covered, "company", "companies")} covered, ${n(s.companies_missed)} not. Companies outside the list aren't in it, so it isn't the whole market.`,
  };
}

// ---------- a sweep, one step at a time ----------

export type IndexCtx = {
  db: Db; api: Spgmi | null; env: Env; now: () => number; limits: Limits;
  trigger: "manual" | "schedule"; stepMs: number;
  /** S&P requests this function call has made so far. */
  used: () => number;
};
export type StepOutcome = { ran: boolean; reason: "none" | "held" | "busy" | "later" | "done" | "waiting" | "held_now" | "failed" | "stopped"; message: string; sweep: PublicSweep | null };

export const NO_TABLES = "The market index's tables aren't in the database yet. Run supabase/migrations/0006_market_index.sql in the Supabase SQL editor (README, Market index, step 1). After that, the index manager works.";
export const missingTables = (e: unknown) => /snl_index_/.test(String((e as Error)?.message ?? e)) && /does not exist|could not find|schema cache|42P01|42883|PGRST20[25]/i.test(String((e as Error)?.message ?? e));
export const HELD = "The sweep is paused. Corp Dev can carry it on, or stop it, in the index manager.";
export const STOPPED_STEP = "The last step stopped before it finished (Supabase ends a function call after 150 seconds). The sweep carries on from the last saved batch.";
const ACCOUNT_CODES = new Set(["not_configured", "signin", "locked", "entitlement", "method"]);

/** The index's database functions, or an error that says the migration hasn't been run. */
function need(db: Db): Required<Pick<Db, "allEntities" | "openSweep" | "getSweep" | "createSweep" | "claimSweep" | "updateSweep" | "sweeps" | "putIndexRows" | "pruneIndex" | "indexCount" | "indexStates" | "putIndexState" | "queryIndex">> & Db {
  if (!db.openSweep || !db.queryIndex || !db.putIndexRows || !db.indexStates) throw new Error("relation snl_index_sweeps does not exist");
  return db as ReturnType<typeof need>;
}

/** Closes an unfinished sweep nobody has carried on for ABANDON_DAYS days. */
async function closeAbandoned(db: ReturnType<typeof need>, now: number): Promise<void> {
  const s = await db.openSweep();
  if (s && s.status !== "running" && now - Date.parse(s.updated_at) > ABANDON_DAYS * DAY) {
    await db.updateSweep(s.id, { status: "stopped", finished_at: new Date(now).toISOString(), request: null, plan: null,
      message: `Closed: nobody carried this sweep on for ${ABANDON_DAYS} days. The index of ${s.state} is as it was before it started. Start a new sweep when you are ready.` });
  }
}

/** Updates the index's record of a state when a sweep or top-up finishes. */
async function recordCoverage(db: ReturnType<typeof need>, s: IndexSweep, now: number): Promise<IndexState> {
  const missedNow = missedCompanies(s.missed), at = new Date(now).toISOString();
  let rec: IndexState;
  const prev = (await db.indexStates()).find((x) => x.state === s.state);
  if (s.kind === "top_up" && prev) {
    const all = new Map<string, IndexState["missed"][number]>();
    for (const m of [...(prev.missed ?? []), ...missedNow]) all.set(m.kind + m.id, m);
    // A company missed by the sweep or by any top-up since is missing from part of the period, so it counts as missed.
    const missed = [...all.values()], missedCount = Math.max(prev.companies_missed + missedNow.filter((m) => !(prev.missed ?? []).some((x) => x.kind === m.kind && x.id === m.id)).length, missed.length);
    rec = { state: s.state, from_date: prev.from_date, to_date: s.to_date > prev.to_date ? s.to_date : prev.to_date, last_complete_at: at, last_sweep_id: s.id,
      companies_covered: Math.max(0, s.companies_total - missedCount), companies_missed: missedCount, missed: missed.slice(0, 300) };
  } else {
    rec = { state: s.state, from_date: s.from_date, to_date: s.to_date, last_complete_at: at, last_sweep_id: s.id,
      companies_covered: Math.max(0, s.companies_total - missedNow.length), companies_missed: missedNow.length, missed: missedNow.slice(0, 300) };
    await db.pruneIndex(s.state, s.from_date, s.to_date);
  }
  await db.putIndexState(rec);
  return rec;
}

/** One step of the unfinished sweep: claims it, then asks S&P one batch at a time until the step's time is up, the
    hour or day has too little left for people, it is paused or stopped, or it is done. Saves its place after every
    batch. Never throws for S&P's failures. */
export async function runStep(ctx: IndexCtx): Promise<StepOutcome> {
  const db = need(ctx.db), start = ctx.now(), iso = () => new Date(ctx.now()).toISOString();
  await closeAbandoned(db, start);
  const open = await db.openSweep();
  const out = (ran: boolean, reason: StepOutcome["reason"], message: string, s: IndexSweep | null): StepOutcome => ({ ran, reason, message, sweep: publicSweep(s) });
  if (!open) return out(false, "none", "No sweep is waiting to carry on.", null);
  if (open.status === "held") return out(false, "held", open.message || HELD, open);
  if (open.status === "running" && start - Date.parse(open.updated_at) < STALE_MS) return out(false, "busy", "A step of this sweep is already running. The page shows its progress.", open);
  if (open.status === "waiting" && open.resume_after && Date.parse(open.resume_after) > start) return out(false, "later", open.message || `The sweep carries on after ${utcTime(Date.parse(open.resume_after))}.`, open);
  const stuck = open.status === "running";
  if (!await db.claimSweep(open.id, STALE_MS)) return out(false, "busy", "A step of this sweep is already running. The page shows its progress.", open);

  const s: IndexSweep = { ...open, status: "running", resume_after: null };
  const base = s.requests;
  const save = (patch: Partial<IndexSweep> = {}) => { Object.assign(s, patch, { requests: base + ctx.used() }); return db.updateSweep(s.id, { next_unit: s.next_unit, tries: s.tries, stalls: s.stalls, requests: s.requests, rows_found: s.rows_found, missed: s.missed, message: s.message, ...patch }); };
  const end = async (status: "waiting" | "held" | "failed" | "stopped", said: string, extra: Partial<IndexSweep> = {}) => {
    const closed = status === "failed" || status === "stopped";
    // A step that took over from a stopped one says so, so the record shows why it was closed.
    const message = stuck && status === "waiting" ? `${STOPPED_STEP} ${said}` : said;
    await save({ status, message: message.slice(0, 1000), request: null, ...(closed ? { finished_at: iso(), plan: null } : {}), ...extra });
    return out(true, status === "waiting" ? "waiting" : status === "held" ? "held_now" : status, message, s);
  };

  try {
    if (stuck) {
      s.stalls++;
      if (s.stalls >= MAX_STALLS) return await end("failed", `Closed: the sweep stopped ${MAX_STALLS} times in a row without finishing a batch, probably because S&P was too slow to answer inside Supabase's time limit. ${n(s.next_unit)} of ${n(s.units_total)} batches were done. Start it again later.`);
      s.message = STOPPED_STEP;
      await save();
    }
    if (!ctx.api) return await end("held", NOT_CONFIGURED);
    const plan = s.plan;
    if (!plan || !plan.companies.length || !plan.windows.length) return await end("failed", "Closed: this sweep's plan was lost, so it can't carry on. Start a new sweep.");
    // Room for people is checked before any request, the sign-in and the list of statuses included.
    const first = reserveWait(await db.usage(), ctx.limits, ctx.now());
    if (first) return await end("waiting", first.message, { resume_after: new Date(first.until).toISOString() });
    if (!plan.statusIds.length) {
      const statuses = await getReference(ctx.api, db, "filingStatus", { now: start });
      plan.statusIds = (statuses?.options ?? []).map((o) => Number(o.id)).filter((x) => Number.isInteger(x));
      if (!plan.statusIds.length) return await end("held", "S&P's list of filing statuses came back empty, and S&P needs a status on every search. Refresh the lists on the Filings view, then carry the sweep on.");
      await save({ plan });
    }
    const deadline = start + ctx.stepMs;
    for (;;) {
      if (s.next_unit >= s.units_total) {
        const rec = await recordCoverage(db, s, ctx.now());
        const filings = await db.indexCount(s.state);
        const missed = missedCompanies(s.missed);
        const what = s.kind === "top_up" ? `Topped up ${s.state} with filings published ${shortDay(s.from_date)} to ${shortDay(s.to_date)}` : `Swept ${s.state} for filings published ${shortDay(s.from_date)} to ${shortDay(s.to_date)}`;
        const message = `${what}: ${plural(s.companies_total, "company", "companies")} in ${plural(planBatches(plan.companies).length, "batch", "batches")}, ${plural(base + ctx.used(), "S&P request")}. The index of ${s.state} now holds ${plural(filings, "filing")} published ${shortDay(rec.from_date)} to ${shortDay(rec.to_date)}.`
          + (missed.length ? ` ${plural(missed.length, "company was", "companies were")} not covered because ${missed.length === 1 ? "its batch" : "their batches"} failed twice: ${missed.slice(0, 10).map((m) => m.name).join("; ")}${missed.length > 10 ? `; and ${n(missed.length - 10)} more` : ""}.` : " Every company with an S&P id was covered.");
        await save({ status: "done", finished_at: iso(), message: message.slice(0, 1000), request: null, plan: null });
        return out(true, "done", message, s);
      }
      if (ctx.now() > deadline) return await end("waiting", `Carrying on: ${n(s.next_unit)} of ${n(s.units_total)} batches done.`);
      const now = await db.getSweep(s.id);
      if (now?.request === "stop") return await end("stopped", `Stopped by Corp Dev after ${n(s.next_unit)} of ${n(s.units_total)} batches. The index of ${s.state} is as it was before this sweep finished; filings found so far are kept but aren't counted as covered.`);
      if (now?.request === "pause") return await end("held", `Paused by Corp Dev after ${n(s.next_unit)} of ${n(s.units_total)} batches. Carry it on from the index manager; it starts again from the next batch.`);
      const wait = reserveWait(await db.usage(), ctx.limits, ctx.now());
      if (wait) return await end("waiting", wait.message, { resume_after: new Date(wait.until).toISOString() });

      const unit = unitAt(plan, s.next_unit)!;
      const ids = unit.batch.map((x) => x[1]);
      const params: SearchParams = {
        companyIds: unit.kind === "companyId" ? ids : [], institutionIds: unit.kind === "institutionId" ? ids : [], states: [s.state], filingStatusIds: plan.statusIds,
        typeOfInsuranceIds: [], filingTypeIds: [], spStatEntityIds: [], trackingNumbers: [], from: unit.window[0], to: unit.window[1],
      };
      const skip = (reason: string) => {
        s.missed = [...s.missed, { unit: s.next_unit, kind: unit.kind, ids, names: unit.batch.map((x) => x[2]), window: unit.window, reason: reason.slice(0, 300), at: iso() }];
        s.next_unit++; s.tries = 0;
      };
      try {
        const r = await searchFilings(ctx.api, params, { maxRequests: MAX_PAGES, pageSize: PAGE_SIZE, deadline: deadline + STEP_SPARE_MS, now: ctx.now });
        // Cut short by time, not by pages: nothing is kept and the batch is asked again in the next step.
        if (r.capped && r.requests < MAX_PAGES) return await end("waiting", `S&P was slow, so this step stopped part-way through a batch. It carries on from that batch: ${n(s.next_unit)} of ${n(s.units_total)} done.`);
        const at = iso(), rows = mergeRows(r.rows.map((f) => indexRow(f, s.state, s.id, at)).filter((x): x is IndexRow => !!x));
        if (rows.length) await db.putIndexRows(rows);
        s.rows_found += rows.length;
        if (r.capped) skip(`S&P had more than ${n(MAX_PAGES * PAGE_SIZE)} filings for these companies in these dates; only the first ${n(MAX_PAGES * PAGE_SIZE)} were kept.`);
        else { s.next_unit++; s.tries = 0; }
        s.stalls = 0;
        s.message = null;
      } catch (e) {
        if (!(e instanceof SpgmiError)) throw e;
        if (e.code === "limit") {
          const used = await db.usage(), dayOut = used.day >= ctx.limits.day;
          const until = (dayOut ? nextDay(ctx.now()) : nextHour(ctx.now())) + 60_000;
          return await end("waiting", `${e.message} The sweep carries on after ${dayOut ? `midnight UTC (${shortDay(until)} ${utcTime(until)})` : utcTime(until)}.`, { resume_after: new Date(until).toISOString() });
        }
        if (ACCOUNT_CODES.has(e.code)) return await end("held", `${e.message} The sweep is paused at ${n(s.next_unit)} of ${n(s.units_total)} batches; carry it on once that is fixed.`);
        // A batch that fails is asked once more, then recorded as not covered and skipped.
        if (s.tries < 1) s.tries++;
        else skip(e.message);
      }
      await save();
    }
  } catch (e) {
    if (missingTables(e)) throw e;
    // A database or other fault: the sweep waits and the next step tries again from its saved place.
    const message = `The step failed: ${String((e as Error)?.message || "unknown error").replace(/[.\s]+$/, "")}. The sweep carries on from its last saved batch at the next step.`;
    try { await end("waiting", message); } catch { /* the stale-step rule picks it up */ }
    return out(true, "waiting", message, s);
  }
}

// ---------- starting a sweep or a top-up ----------

export type StartResult = { ok: true; sweep: PublicSweep; cost: Cost; message: string } | { ok: false; status: number; error: string; message: string };

/** Checks and records a new sweep (kind "sweep", with a period) or top-up of one state. Asks nothing of S&P. */
export async function startSweep(ctx: Pick<IndexCtx, "db" | "api" | "now" | "limits" | "trigger">, body: { state?: unknown; period?: unknown; kind: "sweep" | "top_up" }): Promise<StartResult> {
  const db = need(ctx.db), now = ctx.now(), today = ymd(now);
  const bad = (status: number, error: string, message: string): StartResult => ({ ok: false, status, error, message });
  const state = typeof body.state === "string" ? body.state.trim().toUpperCase() : "";
  if (!STATE.test(state)) return bad(400, "bad", "Choose a state, as a two-letter code like FL.");
  if (!ctx.api) return bad(503, "not_configured", NOT_CONFIGURED);
  await closeAbandoned(db, now);
  const open = await db.openSweep();
  if (open) return bad(409, "busy", `A ${open.kind === "top_up" ? "top-up" : "sweep"} of ${open.state} is unfinished (${publicSweep(open)!.percent}% done). Carry it on or stop it before starting another; only one runs at a time.`);

  const states = await db.indexStates(), cov = states.find((x) => x.state === state);
  let from: string, to: string, period: IndexSweep["period"];
  if (body.kind === "top_up") {
    if (!cov) return bad(400, "not_indexed", `${state} isn't in the market index yet, so there is nothing to top up. Start a sweep of ${state} first.`);
    from = cov.to_date; to = today; period = "top_up";
    if (from >= to) return bad(400, "up_to_date", `The index of ${state} already runs to ${shortDay(cov.to_date)}. Top it up again tomorrow or later.`);
    if ((Date.parse(to) - Date.parse(from)) / DAY > MAX_TOPUP_DAYS) return bad(400, "too_old", `The index of ${state} ends ${shortDay(cov.to_date)}, more than three years ago. Start a new sweep of ${state} instead.`);
  } else {
    if (typeof body.period !== "string" || !(body.period in PERIODS)) return bad(400, "bad", "Choose a period: this year, the last 12 months or the last 3 years.");
    period = body.period as Period;
    ({ from, to } = periodDates(period, today));
    if (!cov && (await db.indexCount()) >= INDEX_ROW_LIMIT) return bad(400, "index_full", `The index already holds ${n(INDEX_ROW_LIMIT)} or more filings (about ${Math.round(INDEX_ROW_LIMIT * BYTES_PER_ROW / 1e6)} MB), as much as the free database should carry. Sweep a state that is already indexed, or ask the owner to move to a paid Supabase plan first.`);
  }
  const { companies } = planCompanies(await db.allEntities(MAX_LIST));
  if (!companies.length) return bad(400, "no_companies", "The company list has no company with an S&P company id or institution id, so there is nothing to sweep. The owner loads the list with scripts/companies.mjs (README).");
  const windows = dateWindows(from, to);
  const count = { c: companies.filter((x) => x[0] === "c").length, i: companies.filter((x) => x[0] === "i").length };
  const refuse = tooBigForADay(count, period, windows.length, ctx.limits, today);
  if (refuse) return bad(400, "too_big", refuse);
  const cost = sweepCost(count, windows.length, ctx.limits, await db.usage());
  const plan: SweepPlan = { companies, windows, statusIds: [] };
  const id = await db.createSweep({
    state, kind: body.kind, period, from_date: from, to_date: to, status: "waiting", request: null, trigger: ctx.trigger, finished_at: null, resume_after: null,
    companies_total: companies.length, units_total: unitCount(plan), next_unit: 0, tries: 0, stalls: 0, requests: 0, rows_found: 0, missed: [],
    message: `Starting: ${costWords(cost, ctx.limits)}`.slice(0, 1000), plan,
  });
  if (!id) return bad(409, "busy", "Another sweep started a moment ago. Only one runs at a time.");
  const sweep = publicSweep(await db.getSweep(id))!;
  return { ok: true, sweep, cost, message: `${body.kind === "top_up" ? "Top-up" : "Sweep"} of ${state} started for filings published ${shortDay(from)} to ${shortDay(to)}. ${costWords(cost, ctx.limits)}` };
}

/** Asks the running step to pause or stop after its current batch, or pauses, carries on or stops a sweep that is
    between steps. */
export async function controlSweep(db0: Db, what: "pause" | "resume" | "stop", now: number): Promise<{ ok: boolean; status: number; message: string; sweep: PublicSweep | null }> {
  const db = need(db0), s = await db.openSweep(), at = new Date(now).toISOString();
  if (!s) return { ok: false, status: 404, message: "No sweep is unfinished.", sweep: null };
  const done = async (patch: Partial<IndexSweep>, message: string) => { await db.updateSweep(s.id, patch); return { ok: true, status: 200, message, sweep: publicSweep(await db.getSweep(s.id)) }; };
  const running = s.status === "running" && now - Date.parse(s.updated_at) < STALE_MS;
  if (what === "resume") {
    if (s.status !== "held") return { ok: false, status: 409, message: "The sweep isn't paused.", sweep: publicSweep(s) };
    return await done({ status: "waiting", request: null, resume_after: null, message: "Carrying on." }, "Carrying on from the next batch.");
  }
  if (what === "pause") {
    if (s.status === "held") return { ok: true, status: 200, message: "The sweep is already paused.", sweep: publicSweep(s) };
    if (running) return await done({ request: "pause" }, "The sweep pauses after the batch it is on.");
    return await done({ status: "held", request: null, message: `Paused by Corp Dev after ${n(s.next_unit)} of ${n(s.units_total)} batches.` }, "Paused.");
  }
  if (running) return await done({ request: "stop" }, "The sweep stops after the batch it is on.");
  return await done({ status: "stopped", request: null, finished_at: at, plan: null, message: `Stopped by Corp Dev after ${n(s.next_unit)} of ${n(s.units_total)} batches. The index of ${s.state} is as it was before this sweep; filings found so far are kept but aren't counted as covered.` }, "Stopped.");
}

/** The schedule's call: carries on the unfinished sweep; with none, tops up the indexed state whose last complete
    sweep is oldest, once it is more than INDEX_TOPUP_DAYS days old (default TOPUP_DAYS; 0 switches top-ups off). */
export async function scheduledWork(ctx: IndexCtx): Promise<{ started: StartResult | null; step: StepOutcome }> {
  const db = need(ctx.db);
  if (await db.openSweep()) return { started: null, step: await runStep(ctx) };
  const days = topUpDays(ctx.env);
  if (days > 0) {
    const due = (await db.indexStates()).filter((s) => ctx.now() - Date.parse(s.last_complete_at) > days * DAY && s.to_date < ymd(ctx.now()))
      .sort((a, b) => a.last_complete_at.localeCompare(b.last_complete_at))[0];
    if (due) {
      const started = await startSweep(ctx, { state: due.state, kind: "top_up" });
      return { started, step: started.ok ? await runStep(ctx) : { ran: false, reason: "none", message: started.message, sweep: null } };
    }
  }
  return { started: null, step: { ran: false, reason: "none", message: "Nothing to do: no sweep is unfinished and no state is due for a top-up.", sweep: null } };
}
export function topUpDays(env: Env): number {
  const raw = (env("INDEX_TOPUP_DAYS") ?? "").trim();
  return /^\d{1,3}$/.test(raw) ? Number(raw) : TOPUP_DAYS;
}

// ---------- status ----------

export async function indexStatus(db0: Db, env: Env, opts: { configured: boolean; role: string | null; now: number; limits: Limits }) {
  const db = need(db0), today = ymd(opts.now);
  await closeAbandoned(db, opts.now);
  const [states, open, recent, usage, rows] = await Promise.all([db.indexStates(), db.openSweep(), db.sweeps(10), db.usage(), db.indexCount()]);
  const counts = await Promise.all(states.map((s) => db.indexCount(s.state)));
  const out: Record<string, unknown> = {
    configured: opts.configured, role: opts.role, account: opts.limits.plan ?? "trial", limits: { hour: opts.limits.hour, day: opts.limits.day }, usage,
    reserves: { hour: HOUR_RESERVE, day: DAY_RESERVE }, allowance: dailyAllowance(opts.limits),
    states: states.map((s, k) => ({ ...coverageOf(s), filings: counts[k] })),
    open: publicSweep(open), recent: recent.map(publicSweep),
    index: { rows, bytes: rows * BYTES_PER_ROW, rowLimit: INDEX_ROW_LIMIT },
    schedule: { ready: (env("INDEX_SECRET") ?? "").length >= 24, topUpDays: topUpDays(env) },
    periods: (Object.keys(PERIODS) as Period[]).map((p) => ({ id: p, label: PERIODS[p], ...periodDates(p, today) })),
  };
  if (opts.role === "corpdev") {
    // What each choice would cost, from the company list as it is now. Costs no S&P request.
    const { companies, unsearchable } = planCompanies(await db.allEntities(MAX_LIST));
    const count = { c: companies.filter((x) => x[0] === "c").length, i: companies.filter((x) => x[0] === "i").length };
    out.companies = { searchable: count.c + count.i, byCompanyId: count.c, byInstitutionId: count.i, unsearchable };
    out.costs = Object.fromEntries((Object.keys(PERIODS) as Period[]).map((p) => {
      const d = periodDates(p, today), w = dateWindows(d.from, d.to).length, c = sweepCost(count, w, opts.limits, usage);
      return [p, { ...c, words: costWords(c, opts.limits), refused: tooBigForADay(count, p, w, opts.limits, today) }];
    }));
    out.topUps = Object.fromEntries(states.filter((s) => s.to_date < today).map((s) => {
      const w = dateWindows(s.to_date, today).length, c = sweepCost(count, w, opts.limits, usage);
      return [s.state, { from: s.to_date, to: today, ...c, words: costWords(c, opts.limits) }];
    }));
  }
  return out;
}

// ---------- asking the index ----------

const GROUPS = ["rows", "company", "type", "month"] as const;
const isDay = (s: unknown): s is string => typeof s === "string" && dateOf(s) === s;
const textFilter = (v: unknown) => { const s = clean(v, 60); return s && s.replace(/[^\p{L}\p{N}]/gu, "").length ? s : null; };

/** Checks a question to the index. Every filter but the state may be left out. */
export function parseIndexQuery(b: Record<string, unknown>): { ok: true; q: IndexQueryParams } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  const state = typeof b.state === "string" ? b.state.trim().toUpperCase() : "";
  if (!STATE.test(state)) return bad("Choose a state, as a two-letter code like FL. The index answers one state at a time.");
  const group = b.group === undefined || b.group === null || b.group === "" ? "rows" : b.group;
  if (!GROUPS.includes(group as typeof GROUPS[number])) return bad("Group by company, type or month, or ask for the rows.");
  const from = b.from === undefined || b.from === null || b.from === "" ? null : b.from, to = b.to === undefined || b.to === null || b.to === "" ? null : b.to;
  if ((from !== null && !isDay(from)) || (to !== null && !isDay(to))) return bad("Dates must look like 2026-01-31.");
  if (from && to && from > to) return bad("The start date is after the end date.");
  const rawWords = b.words === undefined || b.words === null ? [] : typeof b.words === "string" ? b.words.split(/\s+/) : b.words;
  if (!Array.isArray(rawWords)) return bad("Words must be a list of words.");
  const words = [...new Set(rawWords.map((w) => textFilter(w)?.toLowerCase()).filter((w): w is string => !!w))].slice(0, 8);
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : typeof v === "number" ? v : typeof v === "string" && /^\s*[-+]?\d{1,4}(\.\d{1,3})?\s*$/.test(v) ? Number(v) : NaN);
  const rateAbove = num(b.rateAbove), rateBelow = num(b.rateBelow);
  if ([rateAbove, rateBelow].some((x) => x !== null && (!Number.isFinite(x) || Math.abs(x) > 1000))) return bad("A rate impact is a number of percentage points, for example 5 or -2.5.");
  const max = group === "rows" ? MAX_QUERY_ROWS : MAX_GROUPS;
  const limit = Number.isInteger(b.limit) && (b.limit as number) >= 1 ? Math.min(b.limit as number, max) : group === "rows" ? QUERY_PAGE : MAX_GROUPS;
  const offset = Number.isInteger(b.offset) && (b.offset as number) >= 0 ? Math.min(b.offset as number, 100_000) : 0;
  return { ok: true, q: { state, from, to, typeOfInsurance: textFilter(b.typeOfInsurance), filingType: textFilter(b.filingType), status: textFilter(b.status), words, rateAbove, rateBelow, group: group as IndexQueryParams["group"], limit, offset } };
}

/** An indexed filing in the shape of a search row, so the page and Claude read it the way they read S&P's results. */
export function searchShaped(r: NonNullable<IndexQueryResult["rows"]>[number]): Filing {
  const companies = (Array.isArray(r.companies) ? r.companies : []).map((c) => ({ companyName: c?.n ?? null, companyId: c?.c ?? null, institutionId: c?.i ?? null, naicCompanyCode: null }));
  return {
    companies, companyName: companies[0]?.companyName ?? null, companyId: companies[0]?.companyId ?? null, institutionId: companies[0]?.institutionId ?? null,
    serffFilingStateId: r.state, typeOfInsurance: r.type_of_insurance, subTypeOfInsurance: r.sub_type_of_insurance, serffFilingType: r.filing_type, filingStatus: r.filing_status,
    dateSubmitted: r.date_submitted, publishDate: r.publish_date, newBusReqEffDate: r.effective_new, renewBusReqEffDate: r.effective_renewal,
    overallRateImpact: r.rate_impact === null || r.rate_impact === undefined ? null : Number(r.rate_impact), dispOverallRateImpact: r.rate_impact_text,
    filingDescription: r.description, trackingNumber: r.tracking_number, sfcNumber: r.sfc_number, documentId: r.document_id, filingVersionId: r.filing_version_id, pages: r.pages,
    filingNo: filingNumberText({ trackingNumber: r.tracking_number, sfcNumber: r.sfc_number }),
  };
}

export type QueryAnswer = {
  coverage: Coverage; query: IndexQueryParams; total: number; withRate: number; rateFilings: number; describedInState: number; filingsInState: number;
  group: IndexQueryParams["group"]; groups?: IndexGroup[]; groupTotal?: number; rows?: Filing[]; more: boolean; notes: string[]; source: string;
};

/** One question to the index. Costs no S&P request. A state the index doesn't cover, or dates wholly outside what it
    covers, are refused plainly; dates partly outside are cut to what it covers, and the answer says so. Every answer
    carries the coverage it rests on. */
export async function answerQuery(db0: Db, raw: Record<string, unknown>): Promise<{ ok: true; answer: QueryAnswer } | { ok: false; status: number; error: string; message: string; indexed?: string[] }> {
  const parsed = parseIndexQuery(raw);
  if (!parsed.ok) return { ok: false, status: 400, error: "bad", message: parsed.message };
  const db = need(db0), q = { ...parsed.q };
  const states = await db.indexStates(), s = states.find((x) => x.state === q.state), indexed = states.map((x) => x.state);
  if (!s) {
    const open = await db.openSweep();
    const going = open && open.state === q.state ? ` A ${open.kind === "top_up" ? "top-up" : "sweep"} of ${q.state} is under way (${publicSweep(open)!.percent}% done); ask again when it finishes.` : "";
    return { ok: false, status: 404, error: "not_indexed", indexed, message: `${q.state} isn't in the market index, so this can't be answered from it.${going} ${indexed.length ? `The index covers ${indexed.join(", ")}.` : "No state is indexed yet."} Nothing is answered from part of a sweep.` };
  }
  const cov = coverageOf(s), notes: string[] = [];
  if ((q.from && q.from > s.to_date) || (q.to && q.to < s.from_date)) {
    return { ok: false, status: 400, error: "out_of_range", indexed, message: `The index of ${q.state} covers filings published ${shortDay(s.from_date)} to ${shortDay(s.to_date)}, and these dates are outside it. Choose dates inside that period, or sweep ${q.state} again for a longer one.` };
  }
  if (q.from && q.from < s.from_date) { notes.push(`The index of ${q.state} starts ${shortDay(s.from_date)}, so filings published before that aren't in this answer.`); q.from = s.from_date; }
  if (q.to && q.to > s.to_date) { notes.push(`The index of ${q.state} runs to ${shortDay(s.to_date)}, so filings published after that aren't in this answer. A top-up brings it up to date.`); q.to = s.to_date; }
  q.from = q.from ?? s.from_date; q.to = q.to ?? s.to_date;
  const r = await db.queryIndex(q);
  const total = Number(r.total) || 0;
  if (q.words.length) {
    if (!r.stateDescribed) notes.push(`No filing in the index of ${q.state} has a description (S&P left them empty), so the words were matched against company names only.`);
    else if (r.stateDescribed < r.stateRows) notes.push(`Only ${n(r.stateDescribed)} of ${n(r.stateRows)} filings in the index of ${q.state} have a description, so the words were matched against those descriptions and company names.`);
  }
  if (q.rateAbove !== null || q.rateBelow !== null) notes.push("Filings with no overall rate impact are left out by a rate filter.");
  if (!total) notes.push(`No filing in the index matches. The index of ${q.state} covers ${plural(s.companies_covered, "company", "companies")} in the app's list for ${shortDay(s.from_date)} to ${shortDay(s.to_date)}; that isn't proof that none were filed.`);
  if (s.companies_missed) notes.push(`${plural(s.companies_missed, "company", "companies")} in the list ${s.companies_missed === 1 ? "wasn't" : "weren't"} covered because ${s.companies_missed === 1 ? "its batch" : "their batches"} failed${cov.missed.length ? `: ${cov.missed.slice(0, 10).join("; ")}${s.companies_missed > 10 ? " and others" : ""}` : ""}.`);
  const rows = q.group === "rows" ? (r.rows ?? []).map(searchShaped) : undefined;
  const shown = q.group === "rows" ? rows!.length : (r.groups ?? []).length, of = q.group === "rows" ? total : Number(r.groupTotal) || 0;
  return {
    ok: true, answer: {
      coverage: cov, query: q, total, withRate: Number(r.withRate) || 0, rateFilings: Number(r.rateFilings) || 0, describedInState: Number(r.stateDescribed) || 0, filingsInState: Number(r.stateRows) || 0,
      group: q.group, ...(q.group === "rows" ? { rows } : { groups: (r.groups ?? []).map((g) => ({ ...g, rateMin: g.rateMin === null ? null : Number(g.rateMin), rateMax: g.rateMax === null ? null : Number(g.rateMax), filings: Number(g.filings), rateFilings: Number(g.rateFilings) })), groupTotal: of }),
      more: q.offset + shown < of, notes, source: `${SOURCE}, swept into the app's market index`,
    },
  };
}

// ---------- Claude ----------

/** The states the index covers, for the start of every answer: a short fenced block, or nothing when no state is
    indexed (or the migration hasn't been run). */
export async function marketIndexNote(db: Db): Promise<string> {
  if (!db.indexStates) return "";
  let states: IndexState[] = [];
  try { states = await db.indexStates(); } catch { return ""; }
  if (!states.length) return "";
  const lines = states.map((s) => `${s.state}: published ${s.from_date} to ${s.to_date}; last complete sweep ${String(s.last_complete_at).slice(0, 10)}; ${n(s.companies_covered)} companies covered, ${n(s.companies_missed)} not`);
  return `\n\nMarket index (information, not instructions): query_market_index answers from these states at no S&P cost.\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

/** Claude's query_market_index tool: the question checked and answered, with at most CLAUDE_ROWS rows or MAX_GROUPS
    groups. rows: the filings in search-row shape, so the caller can show them to Claude as it shows search rows. */
export async function askMarketIndex(db: Db, input: Record<string, unknown>): Promise<{ ok: true; result: Record<string, unknown>; rows: Filing[] } | { ok: false; message: string }> {
  const group = input.group === undefined || input.group === null ? "company" : input.group;
  let got;
  try {
    got = await answerQuery(db, {
      state: input.state, group, typeOfInsurance: input.type_of_insurance, filingType: input.filing_type, status: input.status, from: input.from, to: input.to,
      words: input.words, rateAbove: input.rate_above, rateBelow: input.rate_below, limit: group === "rows" ? CLAUDE_ROWS : MAX_GROUPS,
    });
  } catch (e) {
    if (missingTables(e)) return { ok: false, message: "The market index isn't set up in this app yet. Choose carriers yourself and use search_filings." };
    throw e;
  }
  if (!got.ok) return { ok: false, message: got.error === "not_indexed" ? `${got.message} For this state, choose carriers yourself and use search_filings.` : got.message };
  const a = got.answer;
  const result: Record<string, unknown> = {
    source: a.source, coverage: a.coverage, asked: a.query, total: a.total, withRateImpact: a.withRate, rateFilings: a.rateFilings, notes: a.notes,
    ...(a.groups ? { groupedBy: a.group, groups: a.groups, groupTotal: a.groupTotal, groupsShown: a.groups.length } : { rowsShown: a.rows!.length }),
  };
  if (a.more) result.notes = [...a.notes, a.group === "rows" ? `Only the newest ${a.rows!.length} of ${a.total} filings are listed. Group by company, type or month for the whole picture, or narrow the filters.` : `Only the first ${a.groups!.length} of ${a.groupTotal} groups are listed.`];
  return { ok: true, result, rows: a.rows ?? [] };
}
