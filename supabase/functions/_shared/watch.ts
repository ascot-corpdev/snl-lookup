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
import { batches, type Cell, entitiesFrom, type Filing, filingNumberText, getReference, SP_NUMBER_MARK, MAX_IDS, MAX_IDS_PER_REQUEST, searchFilings, type SearchParams } from "./filings.ts";
import { STEP_ROWS } from "./filings.ts";
import { type Env } from "./http.ts";
import { NOT_CONFIGURED, Spgmi, SpgmiError } from "./spgmi.ts";
import { sendEmail } from "./mail.ts";

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
    // The tracking number, or "S&P no." and S&P's own filing number when the filing has none (live results so far
    // have had none); the page and the email read the mark back, so no new column is needed.
    description: text(f.filingDescription, DESC_MAX), tracking_number: text(filingNumberText(f), 60),
    document_id: doc !== null && Number.isInteger(doc) && doc > 0 && doc < 1e15 ? doc : null,
  };
}

// ---------- marks: filings that may introduce something ----------
// A mark is a hint for someone watching competitors, worked out from what the search row already carries: the
// filing type, the type and sub-type of insurance, the status, the overall rate impact and the description. It is
// never stored: it is worked out each time the found filings are read back, so changing the rules below re-marks
// every kept filing with no migration. A filing with no mark is not thereby unimportant.

export type FlagKind = "new_program" | "new_state" | "new_form" | "withdrawal" | "large_rate";
/** label: a word or two for the page; reason: which field or words triggered it, for the reader to judge. */
export type FilingFlag = { kind: FlagKind; label: string; reason: string };
export type MarkedFiling = FoundFiling & { flags: FilingFlag[] };

/** A rate change at or beyond 10% either way counts as large. Most personal and small commercial rate revisions
    land in low or middle single digits; a change in double digits is uncommon and usually means a repricing, a
    program being rebuilt, or an exit in all but name. Several states also start closer review of a rate change
    around this size. Tune it after the first live results. */
export const LARGE_RATE_CHANGE_PCT = 10;

/** What each mark means, in the words "May be …" takes on the page and in the email. */
export const FLAG_MEANING: Record<FlagKind, string> = {
  new_program: "a new program or product", new_state: "a company new to the state", new_form: "a new form or coverage",
  withdrawal: "a withdrawal", large_rate: "a large rate change",
};
const FLAG_LABEL: Record<FlagKind, string> = { new_program: "New program", new_state: "New to state", new_form: "New form", withdrawal: "Withdrawal", large_rate: "Large rate change" };

/** Lower case, accents dropped, everything that isn't a letter or digit turned into one space, so "New-Program!",
    "NEW  PROGRAM" and "new program" read alike. What a mark quotes back comes from this, so it is plain words only. */
const words = (v: unknown): string => typeof v === "string" ? v.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 600) : "";

/** The overall rate impact as a number of percentage points, or null. Reads "6.500%", "-2.4", "+12%", "(5.0%)" and
    a range such as "-5% to 12%" (the change furthest from zero). */
export function rateChange(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.slice(0, 60);
  let best: number | null = null;
  for (const m of s.matchAll(/(\(\s*)?([-+−–]\s*)?(\d{1,4}(?:\.\d{1,6})?)(\s*%?\s*\))?/g)) {
    // A dash straight after a number is a range ("5-12%"), not a minus sign.
    const before = s.slice(0, m.index).trimEnd().slice(-1);
    const minus = !!m[2] && !m[2].startsWith("+") && !/[\d%]/.test(before);
    const n = Number(m[3]) * ((m[1] && m[4]) || minus ? -1 : 1);
    if (Number.isFinite(n) && (best === null || Math.abs(n) > Math.abs(best))) best = n;
  }
  return best;
}
const signedPct = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(1)}%`;

const NEW_THING = String.raw`\bnew (?!business\b)(?:[a-z0-9]+ ){0,3}?`;
/** "no", "not", "without" or "never" up to three words before a phrase cancels it ("no new product is introduced"). */
const NEGATED = /\b(?:no|not|non|without|never)\s+(?:[a-z0-9]+\s+){0,3}$/;

/** UNCONFIRMED: S&P's exact filing type names, status names and how companies word descriptions are not known, so
    every rule that marks a filing lives in this one function, written to be tolerant (case, punctuation, common
    phrasings). Tune it after the first live results; see LARGE_RATE_CHANGE_PCT for the rate threshold.
      New program   filing type says new or initial; or the description, type or sub-type of insurance says "new …
                    program", "new … product", "new line of business", "introduc…", "launch…", "roll out",
                    "initial filing / submission / program / rates", "first filing" (not "no new program")
      New to state  description says "entering / expanding … the state or market", "expansion into", "new to the
                    state", "new entrant / company / carrier / insurer", "newly licensed / admitted",
                    "begin / start writing or offering"
      New form      description says "new … form / endorsement / coverage / rider / application", "adds … endorsement
                    or coverage", "introduc… a form", "initial forms" (left out when it is already a new program)
      Withdrawal    status or filing type says withdraw…; or the description says "withdraw…", "discontinu…",
                    "cease / stop writing or offering", "no longer writ… / offer…", "run off", "exit… the state or
                    market", "non-renewal of all"
      Large rate    the overall rate impact is LARGE_RATE_CHANGE_PCT or more, up or down (read by rateChange, which
                    takes S&P's figure as percentage points: "6.500%" and 6.5 both mean 6.5%)
    Each mark carries the field and the words that triggered it. */
export function flagFiling(r: Partial<FoundFiling> | null | undefined): FilingFlag[] {
  if (!r || typeof r !== "object") return [];
  const desc = words(r.description), type = words(r.filing_type), status = words(r.filing_status);
  const kinds = [["the description", desc], ["the type of insurance", words(r.type_of_insurance)], ["the sub-type of insurance", words(r.sub_type_of_insurance)]] as const;
  const quote = (s: string) => `"${s.length > 48 ? s.slice(0, 47).trimEnd() + "…" : s}"`;
  /** The first match in s that isn't negated just before it ("no new program"). */
  const find = (s: string, re: RegExp): string | null => {
    for (const m of s.matchAll(new RegExp(re.source, "g"))) {
      const from = m.index! > 40 ? s.indexOf(" ", m.index! - 40) + 1 : 0;   // whole words only
      if (!NEGATED.test(" " + s.slice(from, m.index))) return m[0];
    }
    return null;
  };
  const out: FilingFlag[] = [];
  const add = (kind: FlagKind, reason: string) => out.push({ kind, label: FLAG_LABEL[kind], reason });

  // New program or product
  const FORMISH = String.raw`(?:policy )?(?:forms?|endorsements?|coverages?|riders?|applications?)\b`;
  const program = [
    new RegExp(NEW_THING + String.raw`(?:programs?|products?|lines? of business)\b`),
    new RegExp(String.raw`\b(?:introduc(?:e|es|ed|ing|tion)|launch(?:es|ed|ing)?|roll(?:s|ed|ing)? out)\b(?! (?:[a-z0-9]+ ){0,2}?` + FORMISH + ")"),
    /\binitial (?:filing|filings|submission|program|product|rates?|rate and rule|offering)\b/,
    /\bfirst (?:time )?filing\b/,
  ];
  let hit: string | null = null;
  if (type && /\b(?:new|initial|introduc\w*)\b/.test(type)) add("new_program", `the filing type is "${clean(r.filing_type, 80)}"`);
  else for (const [where, s] of kinds) {
    for (const re of program) if (s && (hit = find(s, re))) break;
    if (hit) { add("new_program", `${where} says ${quote(hit)}`); break; }
  }

  // A company new to the state
  const entry = [
    /\b(?:enter|enters|entering|entry into|expand|expands|expanding|expansion)(?: [a-z0-9]+){0,2}? (?:state|states|market|markets)\b/,
    /\bexpan(?:d|ds|ding|sion) into\b/,
    /\bnew (?:to (?:the |this )?(?:state|market)|entrant|company|carrier|insurer|writer)\b/,
    /\bnewly (?:licensed|admitted|formed|authori[sz]ed)\b/,
    /\b(?:begin|begins|beginning|start|starts|starting|commence|commences|commencing) (?:writing|to write|offering|to offer)\b/,
  ];
  for (const re of entry) if (desc && (hit = find(desc, re))) { add("new_state", `the description says ${quote(hit)}`); break; }

  // A new form or coverage, unless it is already marked as a new program
  if (!out.some((f) => f.kind === "new_program")) {
    const form = [
      new RegExp(NEW_THING + FORMISH),
      new RegExp(String.raw`\b(?:add|adds|added|adding|addition of)(?: [a-z0-9]+){0,2}? (?:optional )?(?:endorsements?|coverages?|forms?|riders?)\b`),
      new RegExp(String.raw`\bintroduc(?:e|es|ed|ing|tion)(?: of)? (?:[a-z0-9]+ ){0,2}?` + FORMISH),
      /\binitial (?:policy )?forms?\b/,
    ];
    for (const re of form) if (desc && (hit = find(desc, re))) { add("new_form", `the description says ${quote(hit)}`); break; }
  }

  // A withdrawal: the filing, a program, or the company leaving a market
  const WITHDRAW = /\bwithdr(?:aw|ew)[a-z]*\b/;
  if (WITHDRAW.test(status)) add("withdrawal", `the status is "${clean(r.filing_status, 80)}"`);
  else if (WITHDRAW.test(type)) add("withdrawal", `the filing type is "${clean(r.filing_type, 80)}"`);
  else {
    const leave = [
      WITHDRAW, /\bdiscontinu(?:e|es|ed|ing|ance|ation)\b/,
      /\b(?:cease|ceases|ceased|ceasing|stop|stops|stopped|stopping) (?:writing|offering|to write|to offer|selling)\b/,
      /\bno longer (?:writ|offer|sell|available|be offered)[a-z]*\b/, /\brun ?off\b/,
      /\b(?:exit|exits|exited|exiting|leave|leaves|leaving)(?: the)?(?: [a-z0-9]+)? (?:state|market|line|business)\b/,
      /\bnon ?renew(?:al|als|ing)? of (?:all|the entire|its entire)\b/,
    ];
    for (const re of leave) if (desc && (hit = find(desc, re))) { add("withdrawal", `the description says ${quote(hit)}`); break; }
  }

  // A large rate change
  const rate = rateChange(r.rate_impact);
  if (rate !== null && Math.abs(rate) >= LARGE_RATE_CHANGE_PCT) add("large_rate", `the overall rate impact is ${signedPct(rate)}`);
  return out;
}

/** "May be a new form: the description says "new policy form"." */
export const flagSentence = (f: FilingFlag) => `May be ${FLAG_MEANING[f.kind] ?? "worth a look"}: ${f.reason}.`;

/** Found filings with their marks, marked ones first, each group in the order given. */
export function markFound(rows: FoundFiling[]): MarkedFiling[] {
  const all = rows.map((r) => ({ ...r, flags: flagFiling(r) }));
  return [...all.filter((r) => r.flags.length), ...all.filter((r) => !r.flags.length)];
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

/** How the email names a found filing: "tracking number CALL-1", "S&P no. ABC1234567", or "tracking number n/d". */
const numberWords = (v: string | null | undefined) => (!v ? "tracking number n/d" : v.startsWith(SP_NUMBER_MARK + " ") ? v : `tracking number ${v}`);

/** One plain, short email: company, state, filing type, a line of description and the tracking number for each new
    filing, and a link to the app. Nothing else from S&P goes in it. */
export function watchEmail(rows: FoundFiling[], opts: { now: number; site: string | null }): { subject: string; text: string } {
  // Filings that may introduce something come first, under their own heading, each with its mark in words.
  const all = markFound(rows), nMarked = all.filter((r) => r.flags.length).length;
  const shown = all.slice(0, MAX_EMAIL_ITEMS);
  const line = (r: MarkedFiling) => {
    const desc = r.description ? (r.description.length > 140 ? r.description.slice(0, 139).trimEnd() + "…" : r.description) : "No description";
    const tag = r.flags.length ? `[${r.flags.map((f) => f.label).join(", ")}] ` : "";
    return [`- ${tag}${r.companies.join("; ") || "Company n/d"}, ${r.state ?? "n/d"}, ${r.filing_type ?? "filing type n/d"}: ${desc} (${numberWords(r.tracking_number)})`,
      ...r.flags.map((f) => `  ${flagSentence(f)}`)];
  };
  const marked = shown.filter((r) => r.flags.length), rest = shown.filter((r) => !r.flags.length);
  const text = [
    `The daily watchlist check on ${shortDay(opts.now)} found ${plural(rows.length, "new filing")}:`, "",
    ...(nMarked ? [
      `Worth a closer look (${nMarked.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")}): these may be new programs, new forms, withdrawals or large rate changes. A mark is a hint from the filing type, status, rate impact and description, not a fact, so check the filing.`,
      ...marked.flatMap(line), "", ...(rest.length ? ["Other new filings:"] : []),
    ] : []),
    ...rest.flatMap(line),
    ...(rows.length > shown.length ? [`- and ${plural(rows.length - shown.length, "more filing")}`] : []), "",
    opts.site ? `Open SNL lookup to see the details and the documents: ${opts.site}` : "Open SNL lookup to see the details and the documents.",
    "", "Source: S&P Global Market Intelligence, SNL Insurance Product Filings. Confidential: strategy and corporate development use only.",
  ].join("\n");
  return { subject: `SNL lookup: ${plural(rows.length, "new filing")} on the watchlist${nMarked ? `, ${nMarked.toLocaleString("en-US")} worth a closer look` : ""}`, text };
}

// Sending through Resend lives in mail.ts, shared with sign-in notices; named here too, as before.
export { RESEND_URL, sendEmail } from "./mail.ts";

// ---------- a check ----------

export type RunOutcome = {
  status: "ok" | "failed" | "skipped" | "busy"; reason: string | null; message: string;
  requests: number; found: number; newCount: number; baseline: boolean; complete: boolean; emailed: number; runId: string | null;
  windowDays?: number;
};

/** A gap of more than this many days since the last complete check widens the next check's window. */
export const WATCH_GAP_DAYS = 3;
/** The widest a check looks back. Kept well under WATCH_KEEP_DAYS, so every filing in the window that an earlier
    check saw is still on record as seen and can't come back as new. */
export const WATCH_CATCHUP_DAYS = 60;
const CATCH_UP_RUNS = 20;

/** How many days of publish dates a check asks S&P for. Normally WATCH_WINDOW_DAYS. When the last complete check
    is more than WATCH_GAP_DAYS old, from WATCH_WINDOW_DAYS before that check up to today, at most
    WATCH_CATCHUP_DAYS. No complete check among the recent ones means a long gap. The first check (nothing complete
    on record) keeps the normal window: it is only the starting point. */
export function catchUpWindow(hasPrev: boolean, recent: WatchRun[], now: number): { days: number; since: string | null } {
  if (!hasPrev) return { days: WATCH_WINDOW_DAYS, since: null };
  const last = recent.find((r) => r.status === "ok" && r.complete && r.scope);
  const at = last ? Date.parse(last.started_at) : NaN;
  const gap = Number.isFinite(at) ? (now - at) / DAY : Infinity;
  if (gap <= WATCH_GAP_DAYS) return { days: WATCH_WINDOW_DAYS, since: last?.started_at ?? null };
  return { days: Math.min(WATCH_CATCHUP_DAYS, Math.ceil(gap) + WATCH_WINDOW_DAYS), since: last?.started_at ?? null };
}

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

    // After a gap in complete checks (switched off, failing, Supabase paused), look back further so filings
    // published in the gap are still found. One search covers up to 364 days, so this costs no more requests.
    const prev = await db.lastWatchScope();
    const win = catchUpWindow(prev !== null, prev ? await db.watchRuns(CATCH_UP_RUNS) : [], start);
    const to = new Date(start).toISOString().slice(0, 10), from = new Date(start - (win.days - 1) * DAY).toISOString().slice(0, 10);
    const base: Omit<SearchParams, "companyIds" | "institutionIds"> = { states: list.states, filingStatusIds, typeOfInsuranceIds: list.typeOfInsuranceIds, filingTypeIds: list.filingTypeIds, spStatEntityIds: [], trackingNumbers: [], from, to };
    const searches: SearchParams[] = [
      ...batches(idsOf(list, "companyId"), MAX_IDS).map((ids) => ({ ...base, companyIds: ids, institutionIds: [] })),
      ...batches(idsOf(list, "institutionId"), MAX_IDS).map((ids) => ({ ...base, companyIds: [], institutionIds: ids })),
    ];
    const first = (p: SearchParams) => Math.ceil(p.companyIds.length / MAX_IDS_PER_REQUEST) + Math.ceil(p.institutionIds.length / MAX_IDS_PER_REQUEST);
    const byVersion = new Map<string, Filing>();
    let capped = false, noVersion = 0, atBound = false;
    for (let k = 0; k < searches.length; k++) {
      // Each search may use what is left of the budget, less one request for each search still to come.
      const later = searches.slice(k + 1).reduce((n, p) => n + first(p), 0);
      const allowed = Math.max(first(searches[k]), WATCH_MAX_REQUESTS - ctx.used() - later);
      // One check holds at most STEP_ROWS filings (filings.ts): each search may hold what the earlier ones left room for.
      const r = await searchFilings(ctx.api, searches[k], { maxRequests: allowed, deadline: start + WATCH_TIME_MS, now: ctx.now, maxRows: STEP_ROWS - byVersion.size });
      capped ||= r.capped;
      atBound ||= r.atBound === true;
      for (const f of r.rows) {
        const v = f.filingVersionId;
        if (v === null || v === undefined || v === "") { noVersion++; continue; }
        if (!byVersion.has(String(v))) byVersion.set(String(v), f);
      }
      if (r.capped) break;
    }
    const rows = [...byVersion.values()];
    await db.putEntities(entitiesFrom(rows));

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
      if (win.days > WATCH_WINDOW_DAYS) parts.push(`The last complete check was ${win.since ? `on ${shortDay(Date.parse(win.since))}` : "a while ago"}, so this check looked back ${win.days} days instead of ${WATCH_WINDOW_DAYS}, to catch filings published in between.`);
    }
    if (capped && atBound) parts.push(`The check found more filings than it can hold at once (${STEP_ROWS.toLocaleString("en-US")}), so it stopped before S&P had returned everything and may have missed some filings. Remove companies or states from the watchlist.`);
    else if (capped) parts.push("The check stopped before S&P had returned everything, so it may have missed some filings. Remove companies or states from the watchlist.");
    if (noVersion) parts.push(`${plural(noVersion, "filing")} came back without a filing version id, so ${noVersion === 1 ? "it" : "they"} can't be tracked.`);

    let emailed = 0;
    if (news.length && prev && ctx.env("RESEND_API_KEY") && list.recipients.length) {
      const sent = await sendEmail(ctx.mailFetch, ctx.env, list.recipients, watchEmail(news, { now: start, site: siteUrl(ctx.env) }));
      if ("sent" in sent) emailed = sent.sent; else parts.push(sent.error + " The new filings are on the Filings view.");
    }
    const message = parts.join(" ");
    await db.finishWatchRun(runId, { status: "ok", requests: ctx.used(), found: rows.length, new_count: news.length, baseline: !prev, complete: !capped, emailed, message, scope });
    return outcome({ status: "ok", message, found: rows.length, newCount: news.length, baseline: !prev, complete: !capped, emailed, runId, windowDays: win.days });
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
  running: boolean; lastRun: WatchRun | null; lastCheck: WatchRun | null; found: MarkedFiling[];
  /** Whether WATCH_SECRET is set (24 characters or more), so the daily schedule can run checks. */
  scheduleReady: boolean;
  /** When the daily schedule last called (any outcome), from the recent checks; null when none is on record. */
  lastScheduled: string | null;
  /** True when the recent checks span more than a day and a half and none came from the schedule. */
  scheduleQuiet: boolean;
};

/** Said instead of a database error when migration 0003 hasn't been run, so the card can say which step is missing. */
export const NO_TABLES = "The watchlist's tables aren't in the database yet. Run supabase/migrations/0003_watchlist.sql in the Supabase SQL editor (README, Watchlist, step 1). After that, this card shows the last check and Check now works.";
/** A database error that means migration 0003 hasn't been run. */
export const missingTables = (e: unknown) => /snl_watch_(runs|found)/.test(String((e as Error)?.message ?? e)) && /does not exist|could not find|schema cache|42P01|PGRST205/i.test(String((e as Error)?.message ?? e));

const publicRun = (r: WatchRun | undefined): WatchRun | null => (r ? { ...r, scope: null } : null);

/** What the page shows: what is watched, the last check and the last complete one, and the new filings found. */
export async function watchStatus(db: Db, env: Env, configured: boolean, now: number): Promise<WatchStatus> {
  const { list, problems } = parseWatchlist(await db.getSetting(WATCH_ID));
  const runs = await db.watchRuns(20);
  const running = runs.some((r) => r.status === "running" && now - Date.parse(r.started_at) < WATCH_STALE_MS);
  const lastScheduled = runs.find((r) => r.trigger === "schedule")?.started_at ?? null;
  const oldest = runs.length ? Date.parse(runs[runs.length - 1].started_at) : now;
  const quietSince = now - 36 * 3600_000;
  return {
    configured, emailConfigured: !!env("RESEND_API_KEY"), enabled: list.enabled, watchlist: list, problems,
    cost: watchCost(list), budget: WATCH_MAX_REQUESTS, maxCompanies: MAX_CHECK_COMPANIES, tooBig: tooBig(list), windowDays: WATCH_WINDOW_DAYS, keepDays: WATCH_KEEP_DAYS,
    running, lastRun: publicRun(runs.find((r) => r.status !== "running")), lastCheck: publicRun(runs.find((r) => r.status === "ok")),
    // Marks are worked out here, from the stored rows, so changing flagFiling re-marks every kept filing.
    found: markFound(await db.foundFilings(100)),
    scheduleReady: (env("WATCH_SECRET") ?? "").length >= 24, lastScheduled,
    scheduleQuiet: !(lastScheduled && Date.parse(lastScheduled) >= quietSince) && (runs.length < 20 || oldest < quietSince),
  };
}

/** Compares two secrets in time that doesn't depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
