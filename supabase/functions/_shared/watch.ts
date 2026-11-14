// The watchlist: companies and states the team follows, checked once a day for new rate, rule and form filings.
// What is watched is the shared setting "watchlist" in public.snl_settings (migration 0001), which Corp Dev edits on
// the Filings view. What each check found, and the record of checks, are in migration 0003.
//
// A check always asks S&P afresh (a saved result would hide new filings), through the same throttle and request
// counter as every other S&P call, inside a fixed budget of S&P requests. A watchlist too big for the budget is
// refused before any request is spent. The first check only records what is already there as the starting point.
//
// No new S&P endpoints or columns: a check is the same filing search the Filings view runs (filings.ts), over the
// last WATCH_WINDOW_DAYS days of publish dates. Filings are told apart by S&P's filingVersionId.

import type { Db, FoundFiling, WatchRun, WatchScope } from "./db.ts";
import { batches, type Cell, entitiesFrom, type Filing, getReference, MAX_IDS, MAX_IDS_PER_REQUEST, searchFilings, type SearchParams } from "./filings.ts";
import { type Env } from "./http.ts";
import { NOT_CONFIGURED, Spgmi, SpgmiError } from "./spgmi.ts";

export const WATCH_ID = "watchlist";
export const WATCH_WINDOW_DAYS = 14;      // a check looks at filings published in the last 14 days
export const WATCH_MAX_REQUESTS = 30;     // S&P requests one check may use, sign-in included
export const WATCH_OVERHEAD = 2;          // one sign-in and S&P's list of filing statuses (saved for 30 days)
export const WATCH_KEEP_DAYS = 90;        // found filings and the record of checks are kept this long
export const WATCH_TIME_MS = 100_000;     // a check stops asking S&P after this, well inside Supabase's 150 seconds
export const WATCH_STALE_MS = 5 * 60_000; // a check still "running" after this was stopped by Supabase
export const MAX_WATCH_COMPANIES = 500, MAX_WATCH_STATES = 60, MAX_RECIPIENTS = 10, MAX_EMAIL_ITEMS = 50;
const NAME_MAX = 120, DESC_MAX = 300;
const DAY = 86_400_000;

export type WatchCompany = { kind: "companyId" | "institutionId"; id: string; name: string };
export type Watchlist = { enabled: boolean; companies: WatchCompany[]; states: string[]; typeOfInsuranceIds: number[]; filingTypeIds: number[]; recipients: string[] };

// ---------- what is watched ----------

const clean = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v) : "")
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

/** Reads the watchlist document, which people type. Anything that can't be used is left out, and each thing left
    out is named in problems. Never throws. */
export function parseWatchlist(raw: unknown): { list: Watchlist; problems: string[] } {
  const problems: string[] = [];
  const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (raw !== null && raw !== undefined && doc !== raw) problems.push("The saved watchlist isn't in the expected shape, so it was read as empty.");
  const arr = (v: unknown, what: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    problems.push(`The ${what} in the saved watchlist aren't a list, so they were left out.`);
    return [];
  };

  const companies: WatchCompany[] = [], seen = new Set<string>();
  let badCo = 0;
  for (const c of arr(doc.companies, "companies")) {
    const o = c && typeof c === "object" ? c as Record<string, unknown> : {};
    const kind = o.kind === "companyId" || o.kind === "institutionId" ? o.kind : null;
    const id = typeof o.id === "number" && Number.isInteger(o.id) && o.id >= 0 ? String(o.id) : typeof o.id === "string" ? o.id.trim() : "";
    if (!kind || !/^\d{1,12}$/.test(id)) { badCo++; continue; }
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({ kind, id: String(Number(id)), name: clean(o.name, NAME_MAX) });
  }
  if (badCo) problems.push(`${badCo} ${badCo === 1 ? "company was" : "companies were"} left out because ${badCo === 1 ? "its" : "their"} S&P id isn't a whole number.`);
  if (companies.length > MAX_WATCH_COMPANIES) {
    problems.push(`Only the first ${MAX_WATCH_COMPANIES} companies are used.`);
    companies.length = MAX_WATCH_COMPANIES;
  }

  const states: string[] = [];
  let badSt = 0;
  for (const s of arr(doc.states, "states")) {
    const v = typeof s === "string" ? s.trim().toUpperCase() : "";
    if (!/^[A-Z]{2}$/.test(v)) { badSt++; continue; }
    if (!states.includes(v)) states.push(v);
  }
  if (badSt) problems.push(`${badSt} ${badSt === 1 ? "state was" : "states were"} left out because ${badSt === 1 ? "it isn't" : "they aren't"} a two-letter code like FL.`);
  if (states.length > MAX_WATCH_STATES) { problems.push(`Only the first ${MAX_WATCH_STATES} states are used.`); states.length = MAX_WATCH_STATES; }

  const ids = (v: unknown, what: string, max: number): number[] => {
    const out: number[] = [];
    let bad = 0;
    for (const x of arr(v, what)) {
      const n = typeof x === "string" && /^\d{1,12}$/.test(x.trim()) ? Number(x) : x;
      if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 1e12) { if (!out.includes(n)) out.push(n); } else bad++;
    }
    if (bad) problems.push(`Some ${what} were left out because they aren't ids from S&P's lists.`);
    if (out.length > max) { problems.push(`Only the first ${max} ${what} are used.`); out.length = max; }
    return out;
  };
  const typeOfInsuranceIds = ids(doc.typeOfInsuranceIds, "types of insurance", 100), filingTypeIds = ids(doc.filingTypeIds, "filing types", 50);

  const recipients: string[] = [];
  let badMail = 0;
  for (const r of arr(doc.recipients, "email recipients")) {
    const v = typeof r === "string" ? r.trim().toLowerCase() : "";
    if (!isEmail(v)) { badMail++; continue; }
    if (!recipients.includes(v)) recipients.push(v);
  }
  if (badMail) problems.push(`${badMail} email ${badMail === 1 ? "address was" : "addresses were"} left out because ${badMail === 1 ? "it doesn't" : "they don't"} look like an email address.`);
  if (recipients.length > MAX_RECIPIENTS) { problems.push(`Only the first ${MAX_RECIPIENTS} email recipients are used.`); recipients.length = MAX_RECIPIENTS; }

  return { list: { enabled: doc.enabled === true, companies, states, typeOfInsuranceIds, filingTypeIds, recipients }, problems };
}

// ---------- what a check costs ----------

const idsOf = (l: Watchlist, kind: WatchCompany["kind"]) => l.companies.filter((c) => c.kind === kind).map((c) => Number(c.id));
const batchCount = (c: number, i: number) => Math.ceil(c / MAX_IDS_PER_REQUEST) + Math.ceil(i / MAX_IDS_PER_REQUEST);

/** The fewest S&P requests a check of this watchlist needs: one search for each batch of 10 company ids and each
    batch of 10 institution ids (14 days is one date window), plus the sign-in and the list of filing statuses.
    A search with more than one page of results costs one more request for each further page. */
export function watchCost(l: Watchlist): number {
  return batchCount(idsOf(l, "companyId").length, idsOf(l, "institutionId").length) + WATCH_OVERHEAD;
}

/** The most companies a check can cover. */
export const MAX_CHECK_COMPANIES = (WATCH_MAX_REQUESTS - WATCH_OVERHEAD) * MAX_IDS_PER_REQUEST;

/** Why a watchlist is too big for one check, in words that say how to shrink it. null when it fits. */
export function tooBig(l: Watchlist): string | null {
  const need = watchCost(l);
  if (need <= WATCH_MAX_REQUESTS) return null;
  const c = idsOf(l, "companyId").length, i = idsOf(l, "institutionId").length, room = WATCH_MAX_REQUESTS - WATCH_OVERHEAD;
  let remove = 0;
  for (let r = 1; r <= c + i && !remove; r++) for (let rc = 0; rc <= Math.min(r, c); rc++) if (r - rc <= i && batchCount(c - rc, i - (r - rc)) <= room) { remove = r; break; }
  return `The watchlist is too big to check: it needs at least ${need} S&P requests (one for each batch of 10 companies, plus ${WATCH_OVERHEAD} to sign in and read S&P's list of filing statuses), more than the ${WATCH_MAX_REQUESTS} one check may use. Remove at least ${remove} ${remove === 1 ? "company" : "companies"}; a check covers up to ${MAX_CHECK_COMPANIES} companies. Nothing was asked of S&P.`;
}

/** What a check covered: which companies and states, and with which filters. A filing counts as new only when the
    last complete check already covered its company and state with the same filters. */
export function scopeOf(l: Watchlist): WatchScope {
  return {
    companies: l.companies.map((c) => `${c.kind === "companyId" ? "c" : "i"}:${c.id}`),
    states: [...l.states],
    filters: JSON.stringify([[...l.typeOfInsuranceIds].sort((a, b) => a - b), [...l.filingTypeIds].sort((a, b) => a - b)]),
  };
}

function covered(prev: WatchScope | null, now: WatchScope, f: Filing): boolean {
  if (!prev || prev.filters !== now.filters) return false;
  const state = String(f.serffFilingStateId ?? "").toUpperCase();
  if (!prev.states.includes(state)) return false;
  const keys: string[] = [];
  for (const c of f.companies ?? []) {
    if (c.companyId !== null && c.companyId !== undefined) keys.push(`c:${c.companyId}`);
    if (c.institutionId !== null && c.institutionId !== undefined) keys.push(`i:${c.institutionId}`);
  }
  return keys.some((k) => prev.companies.includes(k) && now.companies.includes(k));
}

// ---------- found filings ----------

const text = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined || v === "" || typeof v === "object") return null;
  const s = clean(v, max + 1);
  return s ? (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s) : null;
};
const FVID = /^[A-Za-z0-9._-]{1,64}$/;

/** What is kept of a filing: enough to show it and open its document, with a shortened description. */
export function foundRow(f: Filing, runId: string, at: string, baseline: boolean): FoundFiling | null {
  const fvid = text(f.filingVersionId, 64);
  if (!fvid || !FVID.test(fvid)) return null;
  const names = [...new Set((f.companies ?? []).map((c) => text(c.companyName, NAME_MAX)).filter((n): n is string => !!n))];
  if (!names.length && text(f.companyName, NAME_MAX)) names.push(text(f.companyName, NAME_MAX)!);
  const doc = typeof f.documentId === "number" ? f.documentId : typeof f.documentId === "string" && /^\d{1,15}$/.test(f.documentId) ? Number(f.documentId) : null;
  const state = text(f.serffFilingStateId, 2)?.toUpperCase() ?? null;
  return {
    filing_version_id: fvid, run_id: runId, first_seen_at: at, baseline, companies: names.slice(0, 20),
    state: state && /^[A-Z]{2}$/.test(state) ? state : null, state_name: text(f.serffFilingState, 60),
    filing_type: text(f.serffFilingType, 80), type_of_insurance: text(f.typeOfInsurance, 120), sub_type_of_insurance: text(f.subTypeOfInsurance, 120),
    filing_status: text(f.filingStatus, 80), date_submitted: text(f.dateSubmitted, 30), publish_date: text(f.publishDate, 30),
    effective_new: text(f.newBusReqEffDate, 30), effective_renewal: text(f.renewBusReqEffDate, 30),
    rate_impact: text(f.dispOverallRateImpact, 40) ?? text(f.overallRateImpact as Cell, 40),
    description: text(f.filingDescription, DESC_MAX), tracking_number: text(f.trackingNumber, 60),
    document_id: doc !== null && Number.isInteger(doc) && doc > 0 && doc < 1e15 ? doc : null,
  };
}

// ---------- the email ----------

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const shortDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** The site address for the email: SITE_URL, or the first address in ALLOWED_ORIGIN. Only an https address. */
export function siteUrl(env: Env): string | null {
  for (const v of [env("SITE_URL"), (env("ALLOWED_ORIGIN") ?? "").split(",")[0]]) {
    const s = (v ?? "").trim();
    try { const u = new URL(s); if (u.protocol === "https:" && !u.username && !u.password) return u.href; } catch { /* not an address */ }
  }
  return null;
}

/** One plain, short email: company, state, filing type, a line of description and the tracking number for each new
    filing, and a link to the app. Nothing else from S&P goes in it. */
export function watchEmail(rows: FoundFiling[], opts: { now: number; site: string | null }): { subject: string; text: string } {
  const shown = rows.slice(0, MAX_EMAIL_ITEMS);
  const line = (r: FoundFiling) => {
    const desc = r.description ? (r.description.length > 140 ? r.description.slice(0, 139).trimEnd() + "…" : r.description) : "No description";
    return `- ${r.companies.join("; ") || "Company n/d"}, ${r.state ?? "n/d"}, ${r.filing_type ?? "filing type n/d"}: ${desc} (tracking number ${r.tracking_number ?? "n/d"})`;
  };
  const text = [
    `The daily watchlist check on ${shortDay(opts.now)} found ${plural(rows.length, "new filing")}:`, "",
    ...shown.map(line),
    ...(rows.length > shown.length ? [`- and ${plural(rows.length - shown.length, "more filing")}`] : []), "",
    opts.site ? `Open SNL lookup to see the details and the documents: ${opts.site}` : "Open SNL lookup to see the details and the documents.",
    "", "Source: S&P Global Market Intelligence, SNL Insurance Product Filings. Confidential: strategy and corporate development use only.",
  ].join("\n");
  return { subject: `SNL lookup: ${plural(rows.length, "new filing")} on the watchlist`, text };
}

export const RESEND_URL = "https://api.resend.com/emails";

/** Sends the email through Resend. Returns how many it went to, or the reason it wasn't sent. */
export async function sendEmail(fetchFn: typeof fetch, env: Env, to: string[], mail: { subject: string; text: string }): Promise<{ sent: number } | { error: string }> {
  const from = (env("WATCH_FROM") || "").trim() || "SNL lookup <onboarding@resend.dev>";
  let res: Response;
  try {
    res = await fetchFn(RESEND_URL, { method: "POST", headers: { "Authorization": `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to, subject: mail.subject, text: mail.text }) });
  } catch { return { error: "The email couldn't be sent: Resend didn't answer." }; }
  await res.body?.cancel();
  return res.ok ? { sent: to.length } : { error: `The email couldn't be sent: Resend answered ${res.status}. Check RESEND_API_KEY and WATCH_FROM on Supabase.` };
}

// ---------- a check ----------

export type RunOutcome = {
  status: "ok" | "failed" | "skipped" | "busy"; reason: string | null; message: string;
  requests: number; found: number; newCount: number; baseline: boolean; complete: boolean; emailed: number; runId: string | null;
};

export const STOPPED = "The check stopped before it finished, probably because it ran out of time. The next check will try again.";
export const NOTHING_WATCHED = "Nothing is watched yet. Corp Dev can add companies and states on the Filings view.";
export const SWITCHED_OFF = "The watchlist is switched off, so nothing was checked. Corp Dev can switch it on on the Filings view.";
export const BUSY = "A check is already running. Wait a minute, then look again.";

export type RunCtx = {
  db: Db; api: Spgmi | null; env: Env; mailFetch: typeof fetch; now: () => number;
  trigger: "schedule" | "manual"; used: () => number;
};

/** One check. Records what it did (unless another check is running) and never throws for S&P's failures: a failed
    check is recorded with its reason. */
export async function runWatch(ctx: RunCtx): Promise<RunOutcome> {
  const { db } = ctx, start = ctx.now(), at = () => new Date(ctx.now()).toISOString();
  const outcome = (o: Partial<RunOutcome> & Pick<RunOutcome, "status" | "message">): RunOutcome =>
    ({ reason: null, requests: ctx.used(), found: 0, newCount: 0, baseline: false, complete: true, emailed: 0, runId: null, ...o });
  // Old findings and old checks are cleared on every call, so the tables stay bounded even while S&P isn't set up.
  await db.dropOldWatch(new Date(start - WATCH_KEEP_DAYS * DAY).toISOString());

  const { list } = parseWatchlist(await db.getSetting(WATCH_ID));
  const skip = async (reason: string, message: string, status: "skipped" | "failed" = "skipped") => {
    await db.addWatchRun({ status, trigger: ctx.trigger, started_at: at(), finished_at: at(), requests: 0, found: 0, new_count: 0, baseline: false, complete: true, emailed: 0, message, scope: null });
    return outcome({ status, reason, message, requests: 0 });
  };
  if (!ctx.api) return skip("not_configured", NOT_CONFIGURED);
  if (!list.companies.length || !list.states.length) return skip("empty", NOTHING_WATCHED);
  if (!list.enabled) return skip("off", SWITCHED_OFF);
  const big = tooBig(list);
  if (big) return skip("too_big", big, "failed");

  const runId = await db.startWatchRun(ctx.trigger, WATCH_STALE_MS, STOPPED);
  if (!runId) return outcome({ status: "busy", reason: "busy", message: BUSY, requests: 0 });
  const scope = scopeOf(list);
  try {
    const statuses = await getReference(ctx.api, db, "filingStatus", { now: start });
    const filingStatusIds = (statuses?.options ?? []).map((o) => Number(o.id)).filter((n) => Number.isInteger(n));
    if (!filingStatusIds.length) throw new SpgmiError("server", "S&P's list of filing statuses came back empty, and S&P needs a status on every search. Refresh the lists on the Filings view and check again.");

    const to = new Date(start).toISOString().slice(0, 10), from = new Date(start - (WATCH_WINDOW_DAYS - 1) * DAY).toISOString().slice(0, 10);
    const base: Omit<SearchParams, "companyIds" | "institutionIds"> = { states: list.states, filingStatusIds, typeOfInsuranceIds: list.typeOfInsuranceIds, filingTypeIds: list.filingTypeIds, spStatEntityIds: [], trackingNumbers: [], from, to };
    const searches: SearchParams[] = [
      ...batches(idsOf(list, "companyId"), MAX_IDS).map((ids) => ({ ...base, companyIds: ids, institutionIds: [] })),
      ...batches(idsOf(list, "institutionId"), MAX_IDS).map((ids) => ({ ...base, companyIds: [], institutionIds: ids })),
    ];
    const first = (p: SearchParams) => Math.ceil(p.companyIds.length / MAX_IDS_PER_REQUEST) + Math.ceil(p.institutionIds.length / MAX_IDS_PER_REQUEST);
    const byVersion = new Map<string, Filing>();
    let capped = false, noVersion = 0;
    for (let k = 0; k < searches.length; k++) {
      // Each search may use what is left of the budget, less one request for each search still to come.
      const later = searches.slice(k + 1).reduce((n, p) => n + first(p), 0);
      const allowed = Math.max(first(searches[k]), WATCH_MAX_REQUESTS - ctx.used() - later);
      const r = await searchFilings(ctx.api, searches[k], { maxRequests: allowed, deadline: start + WATCH_TIME_MS, now: ctx.now });
      capped ||= r.capped;
      for (const f of r.rows) {
        const v = f.filingVersionId;
        if (v === null || v === undefined || v === "") { noVersion++; continue; }
        if (!byVersion.has(String(v))) byVersion.set(String(v), f);
      }
      if (r.capped) break;
    }
    const rows = [...byVersion.values()];
    await db.putEntities(entitiesFrom(rows));

    const prev = await db.lastWatchScope();
    const seen = new Set(await db.seenFilings(rows.map((f) => String(f.filingVersionId))));
    const seenAt = at();
    const fresh = rows.filter((f) => !seen.has(String(f.filingVersionId)))
      .map((f) => foundRow(f, runId, seenAt, !covered(prev, scope, f))).filter((r): r is FoundFiling => !!r);
    await db.addFoundFilings(fresh);
    const news = fresh.filter((r) => !r.baseline).sort((a, b) => String(b.publish_date ?? "").localeCompare(String(a.publish_date ?? "")));
    const startPoint = fresh.length - news.length;

    const parts: string[] = [];
    if (!prev) parts.push(rows.length
      ? `First check: ${plural(rows.length, "filing")} published in the last ${WATCH_WINDOW_DAYS} days ${rows.length === 1 ? "was" : "were"} recorded as the starting point. From the next check, only filings that appear after this show as new.`
      : `First check: S&P returned nothing for the last ${WATCH_WINDOW_DAYS} days. From the next check, new filings show here.`);
    else {
      parts.push(news.length ? `Found ${plural(news.length, "new filing")}.` : "Nothing new since the last check.");
      if (startPoint) parts.push(`${plural(startPoint, "filing")} for newly added companies, states or filters ${startPoint === 1 ? "was" : "were"} recorded as the starting point, not as new.`);
    }
    if (capped) parts.push("The check stopped before S&P had returned everything, so it may have missed some filings. Remove companies or states from the watchlist.");
    if (noVersion) parts.push(`${plural(noVersion, "filing")} came back without a filing version id, so ${noVersion === 1 ? "it" : "they"} can't be tracked.`);

    let emailed = 0;
    if (news.length && prev && ctx.env("RESEND_API_KEY") && list.recipients.length) {
      const sent = await sendEmail(ctx.mailFetch, ctx.env, list.recipients, watchEmail(news, { now: start, site: siteUrl(ctx.env) }));
      if ("sent" in sent) emailed = sent.sent; else parts.push(sent.error + " The new filings are on the Filings view.");
    }
    const message = parts.join(" ");
    await db.finishWatchRun(runId, { status: "ok", requests: ctx.used(), found: rows.length, new_count: news.length, baseline: !prev, complete: !capped, emailed, message, scope });
    return outcome({ status: "ok", message, found: rows.length, newCount: news.length, baseline: !prev, complete: !capped, emailed, runId });
  } catch (e) {
    const message = e instanceof SpgmiError ? e.message : `The check failed: ${String((e as Error)?.message || "unknown error").replace(/[.\s]+$/, "")}. It will try again at the next check.`;
    try { await db.finishWatchRun(runId, { status: "failed", requests: ctx.used(), message: message.slice(0, 1000), scope }); } catch { /* the stale-run rule closes it later */ }
    return outcome({ status: "failed", reason: e instanceof SpgmiError ? e.code : "server", message, runId });
  }
}

// ---------- status ----------

export type WatchStatus = {
  configured: boolean; emailConfigured: boolean; enabled: boolean; watchlist: Watchlist; problems: string[];
  cost: number; budget: number; maxCompanies: number; tooBig: string | null; windowDays: number; keepDays: number;
  running: boolean; lastRun: WatchRun | null; lastCheck: WatchRun | null; found: FoundFiling[];
};

const publicRun = (r: WatchRun | undefined): WatchRun | null => (r ? { ...r, scope: null } : null);

/** What the page shows: what is watched, the last check and the last complete one, and the new filings found. */
export async function watchStatus(db: Db, env: Env, configured: boolean, now: number): Promise<WatchStatus> {
  const { list, problems } = parseWatchlist(await db.getSetting(WATCH_ID));
  const runs = await db.watchRuns(20);
  const running = runs.some((r) => r.status === "running" && now - Date.parse(r.started_at) < WATCH_STALE_MS);
  return {
    configured, emailConfigured: !!env("RESEND_API_KEY"), enabled: list.enabled, watchlist: list, problems,
    cost: watchCost(list), budget: WATCH_MAX_REQUESTS, maxCompanies: MAX_CHECK_COMPANIES, tooBig: tooBig(list), windowDays: WATCH_WINDOW_DAYS, keepDays: WATCH_KEEP_DAYS,
    running, lastRun: publicRun(runs.find((r) => r.status !== "running")), lastCheck: publicRun(runs.find((r) => r.status === "ok")),
    found: await db.foundFilings(100),
  };
}

/** Compares two secrets in time that doesn't depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
