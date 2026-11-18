// SNL Insurance Product Filings: reference lists, the filing search, and document download.
//
// Confirmed by S&P's documents: the endpoints, the request body {"properties": {...}}, the required and optional
// search filters and their limits (10 ids and 365 days a request), the result columns, and the response
// {numCols, numRows, currentPageSize, currentPage, totalPages, headers[], rows[{row[]}]}.
// Rows are always read by header name, never by position.
//
// NOT confirmed (each kept in one marked function below, and listed in the README):
//   resolveEntity     S&P's filings API has no company search, so names resolve only against the company list
//                     loaded into the app and companies it has already seen in results
//   resolveMany       the same, for several names and groups at once (Claude's market questions)
//   groupChoices      the same, for whole groups in the Filings view's company finder
//   dedupe            one filing version has one document, state and set of dates
// Seen in the Live check on 18 Nov 2026, on a small sample (the reference lists, one live search of one company in
// Florida that returned 10 rows, and one 17-page document), so true for that sample, and the code still copes
// either way: which reference list column is the id and which the name (referenceOptions); ids are whole numbers
// and filters are lists (parseSearch); paging fields in the answer and pages numbered from 1 (searchFilings); dates
// like 2026-01-31; what a filingVersionId and a documentId look like (parseDocRef); trackingNumber empty and
// sfcNumber filled on every row (filingNumber).

import { type Db, type Entity, isNaicCode, oneEach, type StoreRow } from "./db.ts";
import { shortHash } from "./http.ts";
import { NOT_CONFIGURED, Spgmi, SpgmiError } from "./spgmi.ts";

export const REFERENCE_FIELDS = ["typeOfInsurance", "filingStatus", "serffFilingState", "serffFilingType"] as const;
export type ReferenceField = typeof REFERENCE_FIELDS[number];

export const SEARCH_COLUMNS = [
  "serffFilingEntityEventId", "serffFilingEventId", "trackingNumber", "sfcNumber", "institutionId", "spStatEntityId",
  "naicCompanyCode", "companyId", "companyName", "naicGroupCode", "naicGroupName", "serffFilingStateId", "serffFilingState",
  "typeOfInsuranceId", "typeOfInsurance", "subTypeOfInsurance", "dateSubmitted", "publishDate", "renewBusReqEffDate",
  "newBusReqEffDate", "filingStatusId", "filingStatus", "serffFilingTypeId", "serffFilingType", "overallRateImpact",
  "dispOverallRateImpact", "filingDescription", "documentId", "filingVersionId", "pages",
] as const;
export type Cell = string | number | boolean | null;
/** One filing: S&P's columns by name, plus every company named on the same filing version. */
export type FilingCompany = { companyId: Cell; companyName: Cell; naicCompanyCode: Cell; institutionId?: Cell; spStatEntityId?: Cell };
export type Filing = { [column: string]: Cell | FilingCompany[] | undefined; companies?: FilingCompany[] };

const CANON = new Map<string, string>(SEARCH_COLUMNS.map((c) => [c.toLowerCase(), c]));

/** Turns S&P's {headers, rows: [{row}]} into one object per row, keyed by header name. */
export function mapRows(resp: unknown): Record<string, Cell>[] {
  const r = resp as { headers?: unknown; rows?: unknown };
  const headers = Array.isArray(r?.headers) ? r.headers.map((h) => String(h)) : [];
  const rows = Array.isArray(r?.rows) ? r.rows : [];
  const names = headers.map((h) => CANON.get(h.toLowerCase()) ?? h);
  return rows.map((item) => {
    const cells = Array.isArray(item) ? item : Array.isArray((item as { row?: unknown })?.row) ? (item as { row: unknown[] }).row : [];
    const out: Record<string, Cell> = {};
    names.forEach((name, i) => {
      const v = cells[i];
      out[name] = v === undefined || v === null || v === "" ? null : (typeof v === "object" ? JSON.stringify(v) : v as Cell);
    });
    return out;
  });
}

// ---------- a filing's number ----------
// Live results (18 Nov 2026, 10 rows from one company in Florida) had trackingNumber empty on every row and sfcNumber,
// S&P's own number for the filing (three letters and seven digits), on every row. So a filing is named by its
// tracking number when it has one and by S&P's number otherwise, marked so the reader can tell which it is. The
// S&P number is never sent to S&P as a tracking number.

/** The mark put before S&P's own filing number wherever a filing is named by it. */
export const SP_NUMBER_MARK = "S&P no.";
/** A filing's number as people see and quote it: its tracking number, or S&P's filing number (sfcNumber) when it
    has none. null when it has neither. Control characters and extra spaces are taken out; at most 50 characters. */
export function filingNumber(row: unknown): { kind: "tracking" | "sp"; value: string } | null {
  const r = row && typeof row === "object" ? row as { trackingNumber?: unknown; sfcNumber?: unknown } : null;
  const clean = (v: unknown) => (v === null || v === undefined || typeof v === "object" || typeof v === "boolean" ? "" : String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50).trim());
  const tracking = clean(r?.trackingNumber), sp = clean(r?.sfcNumber);
  return tracking ? { kind: "tracking", value: tracking } : sp ? { kind: "sp", value: sp } : null;
}
/** The same as one piece of text: "CALL-123456" or "S&P no. ABC1234567"; null when the filing has neither number. */
export function filingNumberText(row: unknown): string | null {
  const n = filingNumber(row);
  return !n ? null : n.kind === "sp" ? `${SP_NUMBER_MARK} ${n.value}` : n.value;
}

/** Whether two ids are the same id, whichever came as text and whichever as a number: "1" and 1 match (live result
    rows sent serffFilingTypeId as text while the reference list sends it as a number), and so do "fl" and "FL" for a
    state. Missing or empty ids never match. */
export function sameId(a: unknown, b: unknown): boolean {
  const x = idText(a), y = idText(b);
  return x !== null && x === y;
}
const idText = (v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === "object" || typeof v === "boolean") return null;
  const s = String(v).trim();
  return !s ? null : /^[+-]?\d{1,15}(\.0+)?$/.test(s) ? String(Number(s)) : s.toUpperCase();
};

// ---------- reference lists ----------

export type RefOption = { id: string | number; name: string };
export type Reference = { field: ReferenceField; options: RefOption[]; headers: string[]; rows: Record<string, Cell>[]; fetchedAt: string; fromStore: boolean };

/** S&P's documents don't give the columns of a reference list. This picks the id column as the first header ending
    in "Id" (or "Code"), and the name as the first other column. The raw rows are kept alongside so nothing is lost
    if the guess is wrong. Seen in the Live check on 18 Nov 2026: the guess held for all four lists (one fetch of
    each). */
export function referenceOptions(headers: string[], rows: Record<string, Cell>[]): RefOption[] {
  if (!headers.length) return [];
  const idCol = headers.find((h) => /id$/i.test(h)) ?? headers.find((h) => /code$/i.test(h)) ?? headers[0];
  const nameCol = headers.find((h) => h !== idCol && /(name|desc|description|value)$/i.test(h)) ?? headers.find((h) => h !== idCol) ?? idCol;
  const seen = new Set<string>(), out: RefOption[] = [];
  for (const row of rows) {
    const id = row[idCol];
    if (id === null || id === undefined || typeof id === "boolean" || seen.has(String(id))) continue;
    seen.add(String(id));
    out.push({ id, name: String(row[nameCol] ?? id) });
  }
  return out;
}

const REF_MAX_AGE_MS = 30 * 24 * 3600_000;

/** A reference list, from the store when it is under 30 days old, otherwise from S&P (one request). */
export async function getReference(api: Spgmi | null, db: Db, field: ReferenceField, opts: { refresh?: boolean; now: number }): Promise<Reference | null> {
  const saved = await db.getStore(`ref:${field}`);
  const fresh = saved && opts.now - Date.parse(saved.fetched_at) < REF_MAX_AGE_MS;
  if (saved && (!api || (fresh && !opts.refresh))) return fromSaved(field, saved);
  if (!api) return null;
  const resp = await api.json("GET", "/api/v1/reference", { query: { referenceField: field } });
  const headers = Array.isArray(resp.headers) ? resp.headers.map(String) : [];
  const rows = mapRows(resp);
  const doc = { field, headers, rows, options: referenceOptions(headers, rows) };
  await db.putStore({ id: `ref:${field}`, kind: "reference", label: field, doc });
  return { ...doc, fetchedAt: new Date(opts.now).toISOString(), fromStore: false };
}

function fromSaved(field: ReferenceField, saved: StoreRow): Reference {
  const d = saved.doc as { headers?: string[]; rows?: Record<string, Cell>[]; options?: RefOption[] };
  return { field, options: d.options ?? [], headers: d.headers ?? [], rows: d.rows ?? [], fetchedAt: saved.fetched_at, fromStore: true };
}

// ---------- search ----------

export type SearchParams = {
  companyIds: number[]; institutionIds: number[];
  states: string[]; filingStatusIds: number[];
  typeOfInsuranceIds: number[]; filingTypeIds: number[];
  spStatEntityIds: string[]; trackingNumbers: string[];
  from: string; to: string;
};

export const MAX_IDS_PER_REQUEST = 10;   // S&P: companyId (limit 10) or institutionId (limit 10)
export const MAX_WINDOW_DAYS = 364;      // S&P: 365 days a request; 364 days apart is safe however S&P counts it
export const PAGE_SIZE = 500;            // the page size in S&P's own example
// MAX_IDS: companies in one search. 100 takes any insurer group in the owner's list (the largest has 69) in one
// search; what S&P is asked stays bounded by MAX_SEARCH_REQUESTS, which refuses a search before it starts.
export const MAX_IDS = 100, MAX_YEARS = 10;

const DAY = 86_400_000;
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))
  && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Splits a date range into windows S&P accepts, newest first, with no day covered twice. */
export function dateWindows(from: string, to: string, spanDays = MAX_WINDOW_DAYS): [string, string][] {
  const start = Date.parse(from + "T00:00:00Z"), end = Date.parse(to + "T00:00:00Z");
  const out: [string, string][] = [];
  for (let hi = end; hi >= start; hi -= (spanDays + 1) * DAY) out.push([ymd(Math.max(start, hi - spanDays * DAY)), ymd(hi)]);
  return out;
}

export function batches<T>(items: T[], size = MAX_IDS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const ints = (v: unknown, max: number): number[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  const out = v.map((x) => (typeof x === "string" && /^\d{1,12}$/.test(x.trim()) ? Number(x) : x));
  return out.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 1e12) ? [...new Set(out as number[])] : null;
};
const strs = (v: unknown, max: number, re: RegExp): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  const out = v.map((x) => (typeof x === "string" ? x.trim() : ""));
  return out.every((x) => re.test(x)) ? [...new Set(out)] : null;
};

/** Checks a search the page or Claude sent. Returns the cleaned search, or the reason it can't run.
    Every id is a whole number and every filter a list: S&P's specification gives no types, so this follows its
    examples. Seen in the Live check on 18 Nov 2026 (the four reference lists and 10 result rows): the reference
    lists' ids are whole numbers and the states two-letter codes. In result rows serffFilingTypeId came back as
    digits in text ("1") while every other id was a number, so wherever a row's id is matched with a list's id or
    the user's choice, "1" and 1 are the same id (sameId). Ids sent to S&P stay whole numbers. */
export function parseSearch(b: Record<string, unknown>, today: string): { ok: true; params: SearchParams } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  const tooMany = `Search at most ${MAX_IDS} companies at a time. Remove some companies, or split them into two searches.`;
  if ((Array.isArray(b.companyIds) ? b.companyIds.length : 0) + (Array.isArray(b.institutionIds) ? b.institutionIds.length : 0) > MAX_IDS) return bad(tooMany);
  const companyIds = ints(b.companyIds, MAX_IDS), institutionIds = ints(b.institutionIds, MAX_IDS);
  if (!companyIds || !institutionIds) return bad("Company and institution ids must be whole numbers.");
  if (!companyIds.length && !institutionIds.length) return bad("Choose at least one company. S&P needs a company id or an institution id for every search.");
  if (companyIds.length + institutionIds.length > MAX_IDS) return bad(tooMany);
  const states = strs(Array.isArray(b.states) ? b.states.map((s) => String(s).toUpperCase()) : b.states, 60, /^[A-Z]{2}$/);
  if (!states || !states.length) return bad("Choose at least one state, as a two-letter code like FL.");
  const filingStatusIds = ints(b.filingStatusIds, 50), typeOfInsuranceIds = ints(b.typeOfInsuranceIds, 100), filingTypeIds = ints(b.filingTypeIds, 50);
  if (!filingStatusIds || !typeOfInsuranceIds || !filingTypeIds) return bad("Filing status, type of insurance and filing type must be ids from S&P's reference lists.");
  const spStatEntityIds = strs(b.spStatEntityIds, 20, /^[A-Za-z0-9-]{1,20}$/), trackingNumbers = strs(b.trackingNumbers, 20, /^[A-Za-z0-9 ._\/-]{1,60}$/);
  if (!spStatEntityIds || !trackingNumbers) return bad("Statutory entity ids and tracking numbers must be short text values.");
  const to = b.to === undefined || b.to === null || b.to === "" ? today : b.to;
  if (!isDate(to)) return bad("Dates must look like 2026-01-31.");
  const from = b.from === undefined || b.from === null || b.from === "" ? ymd(Date.parse(String(to) + "T00:00:00Z") - MAX_WINDOW_DAYS * DAY) : b.from;
  if (!isDate(from) || !isDate(to)) return bad("Dates must look like 2026-01-31.");
  if (from > to) return bad("The start date is after the end date.");
  if (Date.parse(to) - Date.parse(from) > MAX_YEARS * 366 * DAY) return bad(`Search at most ${MAX_YEARS} years at a time.`);
  return { ok: true, params: { companyIds, institutionIds, states, filingStatusIds, typeOfInsuranceIds, filingTypeIds, spStatEntityIds, trackingNumbers, from, to } };
}

/** The same search always gets the same id, whatever order its lists were given in. */
export async function searchKey(p: SearchParams): Promise<string> {
  const sorted = <T>(a: T[]) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return "search:" + await shortHash(JSON.stringify([sorted(p.companyIds), sorted(p.institutionIds), sorted(p.states), sorted(p.filingStatusIds),
    sorted(p.typeOfInsuranceIds), sorted(p.filingTypeIds), sorted(p.spStatEntityIds), sorted(p.trackingNumbers), p.from, p.to]));
}

/** Every request body the search needs before paging: one for each batch of 10 ids and each date window. */
export function planSearch(p: SearchParams): Record<string, unknown>[] {
  const groups: Record<string, number[]>[] = [
    ...batches(p.companyIds).map((ids) => ({ companyId: ids })),
    ...batches(p.institutionIds).map((ids) => ({ institutionId: ids })),
  ];
  const out: Record<string, unknown>[] = [];
  for (const [min, max] of dateWindows(p.from, p.to)) for (const g of groups) {
    out.push({
      ...g, minPublishDate: min, maxPublishDate: max, serffFilingStateId: p.states, filingStatusId: p.filingStatusIds,
      ...(p.typeOfInsuranceIds.length ? { typeOfInsuranceId: p.typeOfInsuranceIds } : {}),
      ...(p.filingTypeIds.length ? { serffFilingTypeId: p.filingTypeIds } : {}),
      ...(p.spStatEntityIds.length ? { spStatEntityId: p.spStatEntityIds } : {}),
      ...(p.trackingNumbers.length ? { trackingNumber: p.trackingNumbers } : {}),
    });
  }
  return out;
}

export type SearchResult = {
  rows: Filing[]; total: number; requests: number; capped: boolean;
  byState: { state: string; rows: number }[];
  byCompany: { kind: "companyId" | "institutionId"; id: number; name: string | null; rows: number }[];
  notes: string[];
};

/** Keeps one row per filing version, and lists on it every company S&P named for that version.
    UNCONFIRMED: that rows sharing a filingVersionId differ only by company. The first row's other columns
    (document, state, dates) are the ones kept. */
export function dedupe(rows: Record<string, Cell>[]): Filing[] {
  const byKey = new Map<string, Filing>();
  for (const r of rows) {
    const key = r.filingVersionId !== null && r.filingVersionId !== undefined ? `v:${r.filingVersionId}`
      : r.serffFilingEntityEventId !== null && r.serffFilingEntityEventId !== undefined ? `e:${r.serffFilingEntityEventId}` : `j:${JSON.stringify(r)}`;
    const company = { companyId: r.companyId ?? null, companyName: r.companyName ?? null, naicCompanyCode: r.naicCompanyCode ?? null, institutionId: r.institutionId ?? null, spStatEntityId: r.spStatEntityId ?? null };
    const kept = byKey.get(key);
    if (!kept) { byKey.set(key, { ...r, companies: [company] }); continue; }
    if (!kept.companies!.some((c) => String(c.companyId) === String(company.companyId) && c.companyName === company.companyName)) kept.companies!.push(company);
  }
  return [...byKey.values()];
}

export const MAX_SEARCH_REQUESTS = 60;   // S&P requests one search may use
export const tooWide = (needed: number, allowed: number, p?: SearchParams) =>
  `This search needs at least ${needed} S&P requests (one for each batch of 10 companies and each year of dates), more than the ${allowed} one search may use. Choose fewer companies or a shorter date range.${p ? " " + widthAdvice(p, allowed) : ""}`;

/** What would fit in one search, in plain words: how many years of dates these companies can cover, and how many
    companies these dates can take. Counts as planSearch does: each 10 ids of a kind and each 365 days of dates. */
export function widthAdvice(p: SearchParams, allowed: number): string {
  const n = p.companyIds.length + p.institutionIds.length, windows = dateWindows(p.from, p.to).length;
  const perYear = Math.ceil(p.companyIds.length / MAX_IDS_PER_REQUEST) + Math.ceil(p.institutionIds.length / MAX_IDS_PER_REQUEST);
  const years = Math.floor(allowed / Math.max(1, perYear)), fit = Math.min(MAX_IDS, Math.floor(allowed / windows) * MAX_IDS_PER_REQUEST);
  const cos = (k: number) => `${k} ${k === 1 ? "company" : "companies"}`;
  const days = (k: number) => `${(k * 365).toLocaleString("en-US")} days of dates, a little under ${k} ${k === 1 ? "year" : "years"}`;
  const forDates = fit >= MAX_IDS_PER_REQUEST ? `over these dates, one search can take up to ${cos(fit)}` : "these dates are too long for even 10 companies";
  return years >= 1 ? `With ${n === 1 ? "this company" : `these ${cos(n)}`}, one search can cover up to ${days(years)}; ${forDates}.` : `Choose fewer companies: ${forDates}.`;
}

export const emptyStateNote = (state: string) =>
  `S&P returned no filings for ${state} in this search. That means none are in S&P's data for these companies, dates and filters. It doesn't prove that none were filed.`;

/** Runs a search: every batch and window, every page, one S&P request a second (the api's gate), duplicates
    removed. Stops at maxRequests and says so. knownStates is S&P's own list of filing states, when the app has it.
    Pages are numbered from 1 and the answer carries totalPages: seen in the Live check on 18 Nov 2026, on one live
    search of one company; without totalPages a full page still means there may be another. */
export async function searchFilings(api: Spgmi, p: SearchParams, opts: { maxRequests?: number; pageSize?: number; knownStates?: string[]; deadline?: number; now?: () => number } = {}): Promise<SearchResult> {
  const maxRequests = opts.maxRequests ?? MAX_SEARCH_REQUESTS, pageSize = opts.pageSize ?? PAGE_SIZE;
  const raw: Record<string, Cell>[] = [];
  let requests = 0, capped = false, slow = false;
  outer: for (const base of planSearch(p)) {
    for (let page = 1; ; page++) {
      if (requests >= maxRequests) { capped = true; break outer; }
      // A function call may only run so long: stop while there is still time to answer with what came back.
      if (opts.deadline !== undefined && (opts.now ?? Date.now)() > opts.deadline) { capped = slow = true; break outer; }
      const resp = await api.json("POST", "/api/v1/search", { body: { properties: { ...base, pageNumber: page, pageSize } } });
      requests++;
      const rows = mapRows(resp);
      raw.push(...rows);
      const totalPages = Number(resp.totalPages);
      // S&P's totalPages decides when it is there; without it, a full page means there may be another.
      if (Number.isFinite(totalPages) && totalPages > 0 ? page >= totalPages : rows.length < pageSize) break;
    }
  }
  const rows = dedupe(raw).sort((a, b) => String(b.publishDate ?? "").localeCompare(String(a.publishDate ?? "")));

  const byState = p.states.map((state) => ({ state, rows: rows.filter((r) => sameId(r.serffFilingStateId, state)).length }));
  const named = (kind: "companyId" | "institutionId", id: number) =>
    rows.filter((r) => r.companies!.some((c) => sameId(c[kind], id)));
  const byCompany = [
    ...p.companyIds.map((id) => ({ kind: "companyId" as const, id })),
    ...p.institutionIds.map((id) => ({ kind: "institutionId" as const, id })),
  ].map(({ kind, id }) => {
    const hits = named(kind, id);
    const name = hits[0]?.companies!.find((c) => sameId(c[kind], id))?.companyName;
    return { kind, id, name: name === null || name === undefined ? null : String(name), rows: hits.length };
  });

  const notes: string[] = [];
  if (slow) notes.push(`S&P was answering slowly, so the search stopped after ${requests} S&P requests to stay inside the time limit. These results are incomplete. Narrow the dates, states or companies and search again.`);
  else if (capped) notes.push(`The search stopped after ${maxRequests} S&P requests to stay inside the time limit, so these results are incomplete. Narrow the dates, states or companies and search again.`);
  for (const s of byState) {
    if (s.rows) continue;
    if (opts.knownStates?.length && !opts.knownStates.includes(s.state)) notes.push(`${s.state} isn't in S&P's list of filing states, so S&P's data may not cover it. An empty result for ${s.state} says nothing about whether filings exist.`);
    else if (!s.rows && !capped) notes.push(emptyStateNote(s.state));
  }
  for (const c of byCompany) if (!c.rows && !capped && rows.length) notes.push(`S&P returned nothing for ${c.kind === "companyId" ? "company" : "institution"} id ${c.id} in this search. Check the id; an empty result doesn't prove no filings exist.`);
  return { rows, total: rows.length, requests, capped, byState, byCompany, notes };
}

export const SOURCE = "S&P Global Market Intelligence, SNL Insurance Product Filings";
export type SearchAnswer = SearchResult & { params: SearchParams & { allStatuses: boolean }; source: string; fetchedAt: string; fromStore: boolean; saved: boolean; unlisted?: boolean };

/** A search as the page and Claude both run it: the saved result when there is one (unless refresh), otherwise
    S&P. With no filing status chosen it uses every status in S&P's list, because S&P needs one on every search.
    Companies in the results are remembered, and a complete result is saved. api is null when S&P isn't set up.
    unlisted: a search kept out of the shared Recent searches list. It is kept on the saved result, not in the search
    itself, so the saved result's id stays the hash of the search. It follows whoever last asked S&P: a search that
    opens from a saved result changes nothing, so an earlier unlisted result stays unlisted, and a listed one stays
    listed; a fresh fetch (a new search or Refresh) is saved listed or unlisted as that request asks. */
export async function savedOrFreshSearch(api: Spgmi | null, db: Db, params: SearchParams, opts: { now: number; refresh?: boolean; maxRequests?: number; deadline?: number; clock?: () => number; unlisted?: boolean }): Promise<SearchAnswer> {
  const allStatuses = !params.filingStatusIds.length;
  const p = { ...params };
  if (allStatuses) {
    const statuses = await getReference(api, db, "filingStatus", { now: opts.now });
    const ids = (statuses?.options ?? []).map((o) => Number(o.id)).filter((n) => Number.isInteger(n));
    if (ids.length) p.filingStatusIds = ids;
  }
  const id = await searchKey({ ...p, filingStatusIds: allStatuses ? [] : p.filingStatusIds });
  const saved = opts.refresh ? null : await db.getStore(id);
  if (saved) return { ...(saved.doc as unknown as SearchAnswer), fetchedAt: saved.fetched_at, fromStore: true, saved: true };
  if (!api) throw new SpgmiError("not_configured", NOT_CONFIGURED);
  if (!p.filingStatusIds.length) throw new SpgmiError("server", "S&P's list of filing statuses came back empty, and S&P needs a status on every search. Refresh the reference lists on the Filings view and try again.");
  // A search that can't finish inside its request limit is refused before any request is spent on it.
  const needed = planSearch(p).length, allowed = opts.maxRequests ?? MAX_SEARCH_REQUESTS;
  if (needed > allowed) throw new SpgmiError("bad_request", tooWide(needed, allowed, p));

  const states = await getReference(api, db, "serffFilingState", { now: opts.now });
  const knownStates = (states?.options ?? []).map((o) => String(o.id).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));
  const result = await searchFilings(api, p, { maxRequests: opts.maxRequests, knownStates, deadline: opts.deadline, now: opts.clock });
  await db.putEntities(entitiesFrom(result.rows));
  const doc = { params: { ...p, allStatuses }, ...result, source: SOURCE, ...(opts.unlisted ? { unlisted: true } : {}) };
  // A search that was cut short isn't saved, so the next try asks S&P again.
  const wasSaved = result.capped ? false : await db.putStore({ id, kind: "search", label: `${p.states.join(",")} ${p.from} to ${p.to}`.slice(0, 400), doc });
  return { ...doc, fetchedAt: new Date(opts.now).toISOString(), fromStore: false, saved: wasSaved };
}

/** The companies named in a set of results, so later searches can find them by name or NAIC code. */
export function entitiesFrom(rows: Filing[]): Entity[] {
  const out = new Map<string, Entity>();
  const text = (v: unknown) => (v === null || v === undefined || v === "" || typeof v === "object" ? null : String(v));
  for (const r of rows) for (const c of r.companies ?? [{ companyId: r.companyId, companyName: r.companyName, naicCompanyCode: r.naicCompanyCode, institutionId: r.institutionId, spStatEntityId: r.spStatEntityId }] as FilingCompany[]) {
    const id = text(c.companyId), name = text(c.companyName);
    if (!id || !name || out.has(id)) continue;
    const same = String(r.companyId) === id;
    out.set(id, {
      companyId: id, companyName: name, naicCompanyCode: text(c.naicCompanyCode),
      institutionId: text(c.institutionId) ?? (same ? text(r.institutionId) : null), spStatEntityId: text(c.spStatEntityId) ?? (same ? text(r.spStatEntityId) : null),
      naicGroupCode: text(r.naicGroupCode), naicGroupName: text(r.naicGroupName),
    });
  }
  return [...out.values()];
}

// ---------- resolve ----------

export const NO_MATCH = (q: string) =>
  `No saved company matches "${q}". S&P's filings API has no company search, so the app only knows companies loaded from a company list or seen in earlier results. Search by the company's S&P company id or institution id instead; the app remembers the name after that.`;

/** UNCONFIRMED: S&P's Physical Documents API has no endpoint that turns a name or NAIC code into a companyId.
    Until S&P confirms one (or Snowflake's Entity view is mapped), this looks only at companies loaded from a
    company list (scripts/companies.mjs) or saved from earlier search results. It never calls S&P. Up to 50
    matches come back; a whole group, however large, comes from groupChoices. */
export async function resolveEntity(db: Db, q: string, limit = 50): Promise<{ query: string; matches: Entity[]; note: string | null }> {
  const query = q.trim().slice(0, 100);
  const matches = query.length >= 2 || /^\d+$/.test(query) ? await db.findEntities(query, limit) : [];
  return { query, matches, note: matches.length ? null : NO_MATCH(query) };
}

// ---------- whole groups for the company finder ----------

export const GROUP_SCAN = 400;          // companies read to find the groups a name matches; more means the name is too loose
export const MAX_GROUP_CHOICES = 5;     // groups offered for one name
/** A whole insurer group, as the company finder offers it: every member company in the company list, at most
    MAX_IDS of them (the most one search takes), with the S&P requests one year of dates costs for them. */
export type GroupChoice = {
  name: string | null; code: string | null; companies: number; searchable: number; tooBig: boolean; requestsPerYear: number;
  members: { companyName: string; companyId: string | null; institutionId: string | null }[];
};

/** UNCONFIRMED, for the same reason as resolveEntity: looks only in the app's company list, never at S&P. The
    groups whose name contains q (or whose NAIC group code is q), each with all its member companies, so the page
    can add a whole group in one click. Groups are matched by NAIC group code when the list has one, otherwise by
    group name, as the Statutory view's finder groups them. */
export async function groupChoices(db: Db, q: string): Promise<{ groups: GroupChoice[]; groupNote: string | null }> {
  const query = cleanName(q);
  const rows = /^\d{1,6}$/.test(query) ? await db.entitiesInGroup(query, GROUP_SCAN + 1) : query.length >= 3 ? await db.entitiesInGroupName(query, GROUP_SCAN + 1) : [];
  if (rows.length > GROUP_SCAN) return { groups: [], groupNote: `More than ${GROUP_SCAN} companies are in groups whose name matches "${query}", so no whole group is offered. Type more of the group's name.` };
  const byKey = new Map<string, Entity[]>();
  for (const e of oneEach(rows)) {
    const code = isNaicCode(e.naicGroupCode) ? e.naicGroupCode : null, name = e.naicGroupName ? String(e.naicGroupName) : null;
    if (!code && !name) continue;
    const key = code ?? "name:" + name!.toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), e]);
  }
  const all = [...byKey.values()].map((list): GroupChoice => {
    const ids = list.filter((e) => idOf(e.companyId) !== null || idOf(e.institutionId) !== null);
    const members = ids.slice(0, MAX_IDS).map((e) => ({ companyName: e.companyName, companyId: idOf(e.companyId) === null ? null : String(idOf(e.companyId)), institutionId: idOf(e.companyId) === null ? String(idOf(e.institutionId)) : null }));
    const byCompany = ids.filter((e) => idOf(e.companyId) !== null).length;
    return {
      name: list.find((e) => e.naicGroupName)?.naicGroupName ?? null, code: list.find((e) => isNaicCode(e.naicGroupCode))?.naicGroupCode ?? null,
      companies: list.length, searchable: ids.length, tooBig: ids.length > MAX_IDS, members,
      requestsPerYear: Math.ceil(byCompany / MAX_IDS_PER_REQUEST) + Math.ceil((ids.length - byCompany) / MAX_IDS_PER_REQUEST),
    };
  });
  const groups = all.filter((g) => g.searchable).slice(0, MAX_GROUP_CHOICES);
  const more = all.filter((g) => g.searchable).length - groups.length;
  return { groups, groupNote: more > 0 ? `${more} more ${more === 1 ? "group matches" : "groups match"} "${query}". Type more of the group's name to see ${more === 1 ? "it" : "them"}.` : null };
}

// ---------- resolve several names and groups at once (Claude's market questions) ----------

export const MAX_LOOKUP_NAMES = 20;   // names and groups together in one look-up
export const MATCHES_PER_NAME = 10;   // companies listed for one name; more means the name is too loose
export const MAX_MEMBERS = MAX_IDS;   // group members listed in one look-up: one search's worth, more than any group in the owner's list

/** A company as a look-up shows it to Claude: its name, the ids a search takes, and its group. */
export type FoundCompany = { companyName: string; companyId: number | null; institutionId: number | null; naicCompanyCode: string | null; group: string | null; searchable: boolean };
export type SearchBatch = { company_ids: number[]; institution_ids: number[]; requestsPerYear: number };
export type ResolveMany = {
  names: { name: string; matches: FoundCompany[]; more: boolean }[];
  groups: { group: string; groupNames: string[]; members: FoundCompany[]; cut: boolean }[];
  notFound: string[]; notLookedUp: string[]; searchBatches: SearchBatch[]; notes: string[];
};

const idOf = (v: unknown): number | null => (v !== null && v !== undefined && /^\d{1,12}$/.test(String(v)) ? Number(v) : null);
/** A name as it is looked up: control characters out, spaces tidied, at most 100 characters. Always data. */
const cleanName = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

function found(e: Entity): FoundCompany {
  const companyId = idOf(e.companyId), institutionId = idOf(e.institutionId);
  return { companyName: e.companyName, companyId, institutionId, naicCompanyCode: e.naicCompanyCode ?? null, group: e.naicGroupName ?? null, searchable: companyId !== null || institutionId !== null };
}

/** Every searchable company found, once, split into searches S&P can take: at most MAX_IDS ids each, by company
    id when there is one, otherwise by institution id. requestsPerYear is the S&P requests that search needs for
    each 364 days of dates (one for each 10 ids of a kind), before any extra pages. */
export function searchBatches(companies: FoundCompany[]): SearchBatch[] {
  const seen = new Set<string>(), ids: { kind: "c" | "i"; id: number }[] = [];
  for (const c of companies) {
    const k = c.companyId !== null ? { kind: "c" as const, id: c.companyId } : c.institutionId !== null ? { kind: "i" as const, id: c.institutionId } : null;
    if (!k || seen.has(k.kind + k.id)) continue;
    seen.add(k.kind + k.id);
    ids.push(k);
  }
  return batches(ids, MAX_IDS).map((b) => {
    const company_ids = b.filter((x) => x.kind === "c").map((x) => x.id), institution_ids = b.filter((x) => x.kind === "i").map((x) => x.id);
    return { company_ids, institution_ids, requestsPerYear: Math.ceil(company_ids.length / MAX_IDS_PER_REQUEST) + Math.ceil(institution_ids.length / MAX_IDS_PER_REQUEST) };
  });
}

/** UNCONFIRMED, for the same reason as resolveEntity: S&P's filings API has no company search, so this looks only
    in the app's directory (the company list loaded with scripts/companies.mjs, and companies seen in earlier
    results). It never calls S&P. Looks up several company names and groups in one go, so Claude can check a
    market with one look-up: each group name (or NAIC group code) brings every member company in the directory.
    Says which names matched nothing, and stops listing at MAX_LOOKUP_NAMES names, MATCHES_PER_NAME companies a
    name and MAX_MEMBERS group members, saying so each time. */
export async function resolveMany(db: Db, rawNames: unknown[], rawGroups: unknown[]): Promise<ResolveMany> {
  const out: ResolveMany = { names: [], groups: [], notFound: [], notLookedUp: [], searchBatches: [], notes: [] };
  const asked = new Set<string>();
  const take = (list: unknown[], kind: "name" | "group") => {
    const kept: string[] = [];
    for (const raw of list) {
      const n = cleanName(raw);
      if (!n || asked.has(kind + n.toLowerCase())) continue;
      asked.add(kind + n.toLowerCase());
      if (asked.size > MAX_LOOKUP_NAMES) out.notLookedUp.push(n); else kept.push(n);
    }
    return kept;
  };
  const names = take(rawNames, "name"), groups = take(rawGroups, "group");
  const all: FoundCompany[] = [];

  for (const name of names) {
    const matches = name.length >= 2 || /^\d+$/.test(name) ? await db.findEntities(name, MATCHES_PER_NAME + 1) : [];
    const shown = matches.slice(0, MATCHES_PER_NAME).map(found);
    out.names.push({ name, matches: shown, more: matches.length > MATCHES_PER_NAME });
    if (!shown.length) out.notFound.push(name);
    all.push(...shown);
  }

  let listed = 0;
  for (const group of groups) {
    const room = MAX_MEMBERS - listed;
    if (room <= 0) { out.notLookedUp.push(group); continue; }
    const members = oneEach(isNaicCode(group) ? await db.entitiesInGroup(group, room + 1) : await db.entitiesInGroupName(group, room + 1));
    const shown = members.slice(0, room).map(found);
    listed += shown.length;
    out.groups.push({ group, groupNames: [...new Set(shown.map((m) => m.group).filter((g): g is string => !!g))], members: shown, cut: members.length > room });
    if (!shown.length) out.notFound.push(group);
    all.push(...shown);
  }

  out.searchBatches = searchBatches(all);
  if (out.notFound.length) out.notes.push(`Not in the company list: ${out.notFound.join("; ")}. The app's company list is the list the owner loaded plus companies seen in earlier results. Tell the user they can add a company on the Filings view by its S&P company id or institution id. Don't guess ids.`);
  for (const n of out.names) if (n.more) out.notes.push(`More than ${MATCHES_PER_NAME} companies match "${n.name}"; only the first ${MATCHES_PER_NAME} are listed. Use a fuller name, or the group name, to find the one you mean.`);
  for (const g of out.groups) if (g.cut) out.notes.push(`"${g.group}" has more member companies in the list than one look-up returns (at most ${MAX_MEMBERS} members in all); only ${plain(g.members.length, "is", "are")} listed, by name. Search these, and look up any other member you need by name.`);
  if (out.notLookedUp.length) out.notes.push(`One look-up takes at most ${MAX_LOOKUP_NAMES} names and groups, and lists at most ${MAX_MEMBERS} group members. These weren't looked up: ${out.notLookedUp.join("; ")}. Look them up in another call if they matter.`);
  const unsearchable = all.filter((c) => !c.searchable).length;
  if (unsearchable) out.notes.push(`${unsearchable === 1 ? "One company found has" : `${unsearchable} companies found have`} only a NAIC code, so search_filings can't search ${unsearchable === 1 ? "it" : "them"}; query_statutory can.`);
  if (out.searchBatches.length) out.notes.push(`searchBatches holds every searchable company found, once, in lists search_filings takes (at most ${MAX_IDS} ids a search). Drop any match that isn't a carrier you meant before you search.`);
  return out;
}
const plain = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------- documents ----------

export type DocRef = { documentId?: number; filingVersionId?: string };

export function parseDocRef(b: Record<string, unknown>): DocRef | null {
  const id = typeof b.documentId === "string" && /^\d{1,15}$/.test(b.documentId) ? Number(b.documentId) : b.documentId;
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return { documentId: id };
  // The shape of a filingVersionId: S&P's example is a 36-character id; anything of 8 to 64 letters, digits, dots,
  // underscores and dashes is passed on as it is. Seen in the Live check on 18 Nov 2026 (10 rows): filingVersionId
  // and documentId fitted these shapes (documentId a whole number).
  if (typeof b.filingVersionId === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(b.filingVersionId)) return { filingVersionId: b.filingVersionId };
  return null;
}

/** One document from S&P, as S&P sends it (usually a PDF). One S&P request. Nothing is kept. */
export function downloadDocument(api: Spgmi, ref: DocRef): Promise<Response> {
  return api.call("POST", "/api/v1/download", { body: { properties: ref.documentId !== undefined ? { documentId: ref.documentId } : { filingVersionId: ref.filingVersionId } } });
}
