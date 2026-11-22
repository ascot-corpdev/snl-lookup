// Everything the functions read from or write to Postgres, behind one small interface, so tests can swap in an
// in-memory stand-in. The real one below writes with the service role (migration 0001); logins can only read.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

export type StoreKind = "reference" | "search" | "entity" | "discover" | "statutory";
export type StoreRow = { id: string; kind: StoreKind; label: string; doc: Record<string, unknown>; fetched_at: string };

/** A company the app knows: one S&P has returned before, or one loaded from a company list
    (scripts/companies.mjs). Field names are S&P's own search columns. It has a company id, an institution id,
    or both; or, from a company list, only a NAIC company code (statutory figures only, no filing search). */
export type Entity = {
  companyId: string | null; companyName: string; naicCompanyCode: string | null; institutionId: string | null;
  spStatEntityId: string | null; naicGroupCode: string | null; naicGroupName: string | null;
};

/** A NAIC company code found for an institution id, with its NAIC group when one came with it. */
export type CodeFill = { institutionId: string; naicCompanyCode: string; naicGroupCode: string | null; naicGroupName: string | null };

/** A company row with a code filled in: the NAIC company code only when the row has none, and the group code and
    name each only where empty. null when nothing would change (the row already has a code, or another institution). */
export function filledRow(doc: Entity, f: CodeFill): Entity | null {
  const has = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";
  if (String(doc.institutionId ?? "").trim() !== f.institutionId || has(doc.naicCompanyCode) || !isNaicCode(f.naicCompanyCode)) return null;
  const out: Entity = { ...doc, naicCompanyCode: f.naicCompanyCode };
  if (!has(doc.naicGroupCode) && isNaicCode(f.naicGroupCode)) out.naicGroupCode = f.naicGroupCode;
  if (!has(doc.naicGroupName) && f.naicGroupName) out.naicGroupName = f.naicGroupName;
  return out;
}

/** A company's ids and group, without its name: what the Live check counts in the company list. */
export type EntityFields = Omit<Entity, "companyName">;

export type Slot = { allowed: boolean; waitMs: number; hour: number; day: number };
export type Usage = { hour: number; day: number };

export type JobStatus = "queued" | "running" | "paused" | "done" | "error";
export type Step = { at: string; text: string };
export type Job = {
  id: string; owner: string; status: JobStatus; question: string; progress: Step[]; partial: string;
  result: Record<string, unknown> | null; error: string | null; segments: number;
  created_at: string; updated_at: string; heartbeat_at: string;
};
export type JobPatch = Partial<Pick<Job, "status" | "progress" | "partial" | "result" | "error" | "segments">>;

/** The watchlist (migration 0003). A check and what it did; scope is what it covered (see watch.ts). */
export type WatchScope = { companies: string[]; states: string[]; filters: string };
export type WatchRun = {
  id: string; status: "running" | "ok" | "failed" | "skipped"; trigger: "schedule" | "manual"; started_at: string; finished_at: string | null;
  requests: number; found: number; new_count: number; baseline: boolean; complete: boolean; emailed: number; message: string | null; scope: WatchScope | null;
};
export type WatchRunPatch = Partial<Pick<WatchRun, "status" | "requests" | "found" | "new_count" | "baseline" | "complete" | "emailed" | "message" | "scope">>;
/** A filing a check found: enough to show it and open its document. baseline: part of the starting point, not new. */
export type FoundFiling = {
  filing_version_id: string; run_id: string | null; first_seen_at: string; baseline: boolean; companies: string[];
  state: string | null; state_name: string | null; filing_type: string | null; type_of_insurance: string | null; sub_type_of_insurance: string | null;
  filing_status: string | null; date_submitted: string | null; publish_date: string | null; effective_new: string | null; effective_renewal: string | null;
  rate_impact: string | null; description: string | null; tracking_number: string | null; document_id: number | null;
};

/** A saved filing summary (migration 0005, public.snl_digests): the digest itself (Contract B, see digest.ts) and the
    columns search uses. form_keys: the form numbers without spacing or punctuation, in capitals, space-separated with a
    space at each end; search_body: the summary, program names, form titles and points, which Postgres indexes for
    word search (the generated column search_text). */
export type DigestRow = {
  id: string; filing_version_id: string | null; document_id: number | null; state: string | null; company: string | null;
  form_keys: string; search_body: string; pages_read: number; made_at: string; doc: Record<string, unknown>;
};
/** What a search of saved summaries asks the database: a form number (letters and digits only), words, a state. */
export type DigestQuery = { formKey: string | null; words: string[]; state: string | null; limit: number };

// ---------- the market index (migration 0006; see marketindex.ts) ----------
/** A company in a sweep's plan: "c" and its S&P company id, or "i" and its institution id, and its name. */
export type PlanCompany = ["c" | "i", number, string];
/** What a sweep asks for, fixed when it starts: the companies in order, the date windows, S&P's filing statuses. */
export type SweepPlan = { companies: PlanCompany[]; windows: [string, string][]; statusIds: number[] };
/** A batch of companies a sweep could not cover: it failed twice (or came back cut short) and was skipped. */
export type MissedBatch = { unit: number; kind: "companyId" | "institutionId"; ids: number[]; names: string[]; window: [string, string]; reason: string; at: string };
export type SweepStatus = "running" | "waiting" | "held" | "done" | "failed" | "stopped";
export type IndexSweep = {
  id: string; state: string; kind: "sweep" | "top_up"; period: "this_year" | "last_12_months" | "last_3_years" | "top_up";
  from_date: string; to_date: string; status: SweepStatus; request: "pause" | "stop" | null; trigger: "schedule" | "manual";
  started_at: string; updated_at: string; finished_at: string | null; resume_after: string | null;
  companies_total: number; units_total: number; next_unit: number; tries: number; stalls: number; requests: number; rows_found: number;
  missed: MissedBatch[]; message: string | null; plan: SweepPlan | null;
};
export type IndexSweepPatch = Partial<Omit<IndexSweep, "id" | "started_at" | "updated_at">>;
/** What the index covers for one state: written when a sweep or top-up finishes. */
export type IndexState = {
  state: string; from_date: string; to_date: string; last_complete_at: string; last_sweep_id: string | null;
  companies_covered: number; companies_missed: number; missed: { kind: "companyId" | "institutionId"; id: number; name: string }[];
};
/** A company named on an indexed filing: n its name, c its company id, i its institution id. */
export type IndexCompany = { n: string | null; c: number | null; i: number | null };
/** One filing version in one state, as the index keeps it. Dates are yyyy-mm-dd. */
export type IndexRow = {
  state: string; filing_key: string; filing_version_id: string | null; document_id: number | null; companies: IndexCompany[];
  type_of_insurance_id: number | null; type_of_insurance: string | null; sub_type_of_insurance: string | null;
  filing_type_id: number | null; filing_type: string | null; filing_status_id: number | null; filing_status: string | null;
  date_submitted: string | null; publish_date: string | null; effective_new: string | null; effective_renewal: string | null;
  rate_impact: number | null; rate_impact_text: string | null; description: string | null; tracking_number: string | null; sfc_number: string | null;
  pages: number | null; sweep_id: string | null; seen_at: string;
};
/** A question to the index, as snl_index_query takes it (migration 0006). */
export type IndexQueryParams = {
  state: string; from: string | null; to: string | null; typeOfInsurance: string | null; filingType: string | null; status: string | null;
  words: string[]; rateAbove: number | null; rateBelow: number | null; group: "rows" | "company" | "type" | "month"; limit: number; offset: number;
};
export type IndexGroup = { name: string; companyId?: string | null; institutionId?: string | null; filings: number; rateFilings: number; rateMin: number | null; rateMax: number | null; latest: string | null };
export type IndexQueryResult = {
  total: number; withRate: number; rateFilings: number; stateRows: number; stateDescribed: number;
  groupTotal?: number; groups?: IndexGroup[]; rows?: (Omit<IndexRow, "sweep_id" | "seen_at"> & { company_names?: string })[];
};

export interface Db {
  /** Takes the next one-second S&P slot and counts the request (migration 0001, snl_take_slot). */
  takeSlot(limits: Usage): Promise<Slot>;
  /** S&P requests counted this hour and today (UTC). */
  usage(): Promise<Usage>;
  getStore(id: string): Promise<StoreRow | null>;
  putStore(row: { id: string; kind: StoreKind; label?: string; doc: Record<string, unknown> }): Promise<boolean>;
  /** When each kind of saved result was last fetched. */
  lastFetched(): Promise<Partial<Record<StoreKind, string>>>;
  /** Companies seen before whose name contains the text, or whose NAIC code or S&P id equals it. */
  findEntities(q: string, limit: number): Promise<Entity[]>;
  putEntities(entities: Entity[]): Promise<void>;
  /** Companies in the company list (or seen before) whose NAIC group code equals the code, for company profiles. */
  entitiesInGroup(groupCode: string, limit: number): Promise<Entity[]>;
  /** Companies in the company list (or seen before) whose group name contains the text, in any letter case
      ("Calloway Group" finds "Calloway Group (SNL P&C Group)"), for Claude's market questions. A list loaded
      without NAIC group codes still has group names. */
  entitiesInGroupName(groupName: string, limit: number): Promise<Entity[]>;
  getSetting(id: string): Promise<Record<string, unknown> | null>;
  // ---------- NAIC codes looked up on Snowflake (statutory.ts naicCodesFor); optional, so a stand-in without them still works ----------
  /** The companies in the company list with one of these institution ids, each with what any other row of the same
      company knows (a NAIC-only row with the same statutory key, say). */
  entitiesByInstitution?(ids: string[]): Promise<Entity[]>;
  /** Fills a NAIC company code (and the group code and name, each only where empty) into the company list's rows with
      this institution id and no NAIC company code. A code already there is never changed. Returns the rows changed. */
  fillEntityCodes?(fills: CodeFill[]): Promise<number>;
  // ---------- the Live check (_shared/diagnose.ts); optional, so a stand-in without them still works ----------
  /** The latest saved results of one kind, newest first. */
  recentStore?(kind: StoreKind, limit: number): Promise<StoreRow[]>;
  /** The ids and group of every company in the company list (never the names), up to limit. */
  entityFields?(limit: number): Promise<EntityFields[]>;
  // ---------- the watchlist (migration 0003) ----------
  /** Starts a check, first closing any check still "running" after staleMs (with staleMessage). Returns its id, or
      null when another check is running (only one may run at a time). */
  startWatchRun(trigger: WatchRun["trigger"], staleMs: number, staleMessage: string): Promise<string | null>;
  finishWatchRun(id: string, patch: WatchRunPatch): Promise<void>;
  /** Records a check that ended before it started (not set up, nothing watched, switched off, too big). */
  addWatchRun(run: Omit<WatchRun, "id">): Promise<void>;
  /** The latest checks, newest first. */
  watchRuns(limit: number): Promise<WatchRun[]>;
  /** What the latest complete, successful check covered. null before the first one. */
  lastWatchScope(): Promise<WatchScope | null>;
  /** Which of these filing version ids a check has found before. */
  seenFilings(ids: string[]): Promise<string[]>;
  addFoundFilings(rows: FoundFiling[]): Promise<void>;
  /** New filings found (not the starting point), the latest found first. */
  foundFilings(limit: number): Promise<FoundFiling[]>;
  /** Clears found filings and finished checks from before the given time. */
  dropOldWatch(before: string): Promise<void>;
  createJob(owner: string, question: string): Promise<string | null>;
  getJob(id: string): Promise<Job | null>;
  /** Updates a job and its heartbeat. */
  updateJob(id: string, patch: JobPatch): Promise<void>;
  /** Moves a job to "running" only if it is in one of the given states and (when given) its heartbeat is older
      than staleMs. Returns whether this caller won it, so two calls can't run the same answer. */
  claimJob(id: string, from: JobStatus[], staleMs?: number): Promise<boolean>;
  getJobState(id: string): Promise<Record<string, unknown> | null>;
  putJobState(id: string, state: Record<string, unknown>): Promise<void>;
  dropJobState(id: string): Promise<void>;
  /** Saved places of answers that haven't moved since the given time, so their leftovers can be cleared. */
  oldJobStates(before: string, limit: number): Promise<{ jobId: string; state: Record<string, unknown> }[]>;
  /** The login's answer that is still going (queued, running or paused) and has shown life since the given time. */
  activeJob(owner: string, since: string): Promise<string | null>;
  /** Removes finished answers created before the given time. */
  dropOldJobs(before: string): Promise<void>;
  /** How many questions the login has started since the given time, whatever became of them. */
  countJobsSince(owner: string, since: string): Promise<number>;
  /** The usage part of the result of each of the login's finished answers started since the given time. */
  usageSince(owner: string, since: string): Promise<Record<string, unknown>[]>;
  // ---------- the team library (migration 0007); optional, so a stand-in without them still works ----------
  /** A login's display name (profiles.display_name, or the username when that is empty). null for no profile. */
  profileName?(uid: string): Promise<string | null>;
  /** How many entries the library holds. */
  libraryCount?(): Promise<number>;
  libraryGet?(id: string): Promise<LibraryRow | null>;
  /** The entry copied from this answer, if it has been saved. */
  libraryByJob?(jobId: string): Promise<LibraryRow | null>;
  /** Adds an entry. Returns it, or null when an entry for the same answer already exists. */
  libraryAdd?(row: Omit<LibraryRow, "id" | "saved_at" | "updated_at">): Promise<LibraryRow | null>;
  /** Changes an entry's title and tags (and the search text built from them). Returns it, or null when it is gone. */
  libraryUpdate?(id: string, patch: Pick<LibraryRow, "title" | "tags" | "search_text">): Promise<LibraryRow | null>;
  /** Removes an entry. Returns whether there was one to remove. */
  libraryRemove?(id: string): Promise<boolean>;
  // ---------- saved filing summaries (migration 0005); optional, so a stand-in without them still works ----------
  /** The saved summaries of filings with these document ids or filing version ids. */
  getDigests?(ids: { documentIds: number[]; versionIds: string[] }): Promise<DigestRow[]>;
  /** Saves a summary, replacing the row with the same id. */
  putDigest?(row: DigestRow): Promise<void>;
  /** Saved summaries whose form numbers contain the form number, or whose text has the words, newest first. */
  searchDigests?(q: DigestQuery): Promise<DigestRow[]>;
  /** How many summaries are saved. */
  countDigests?(): Promise<number>;
  // ---------- the market index (migration 0006); optional, so a stand-in without them still works ----------
  /** Every company in the company list (or seen before), one row each, up to limit. */
  allEntities?(limit: number): Promise<Entity[]>;
  /** The unfinished sweep (running, waiting or held), or null. */
  openSweep?(): Promise<IndexSweep | null>;
  getSweep?(id: string): Promise<IndexSweep | null>;
  /** Records a new sweep as waiting. null when another sweep is unfinished (only one at a time). */
  createSweep?(row: Omit<IndexSweep, "id" | "started_at" | "updated_at">): Promise<string | null>;
  /** Moves a sweep to running for this caller: from waiting once resume_after has passed, or from running when it has
      shown no life for staleMs (its function call was stopped). Returns whether this caller won it. */
  claimSweep?(id: string, staleMs: number): Promise<boolean>;
  /** Changes a sweep and marks it alive (updated_at). */
  updateSweep?(id: string, patch: IndexSweepPatch): Promise<void>;
  /** The latest sweeps, newest first. */
  sweeps?(limit: number): Promise<IndexSweep[]>;
  /** Saves filings (snl_index_put): a filing already there keeps its companies and gains the new ones. */
  putIndexRows?(rows: IndexRow[]): Promise<void>;
  /** Removes a state's filings published outside from..to (or with no publish date). */
  pruneIndex?(state: string, from: string, to: string): Promise<void>;
  /** Filings in the index: for one state, or in all. */
  indexCount?(state?: string): Promise<number>;
  indexStates?(): Promise<IndexState[]>;
  putIndexState?(s: IndexState): Promise<void>;
  /** One question to the index (snl_index_query). */
  queryIndex?(q: IndexQueryParams): Promise<IndexQueryResult>;
}

/** One entry of the team library (migration 0007): a copy of a finished answer, taken when it was saved. */
export type LibraryRow = {
  id: string; job_id: string; title: string; question: string;
  answer: { answer: unknown[]; sources: unknown[]; table: unknown; caps: unknown[]; lookups: unknown[] };
  model: string | null; asked_at: string; answered_at: string;
  saved_by: string | null; saved_by_name: string; saved_at: string; updated_at: string;
  tags: string[]; companies: string[]; search_text: string;
};
/** The library table is missing (migration 0007 not run): PostgREST's "not in the schema cache", or Postgres's
    "undefined table". */
export const LIBRARY_MISSING = "library_missing";
const libraryMissing = (e: { code?: string; message?: string } | null) => !!e && (e.code === "PGRST205" || e.code === "42P01" || /snl_library/.test(e.message ?? "") && /does not exist|schema cache/.test(e.message ?? ""));
const libraryFail = (e: { code?: string; message?: string }, what: string): never => { throw new Error(libraryMissing(e) ? LIBRARY_MISSING : `${what}: ${e.message}`); };

// A saved place is kept as text inside its row. Postgres re-orders the keys of JSON it stores, and Claude must
// be sent back exactly the conversation it produced, byte for byte, when an answer is picked up again.
const pack = (state: Record<string, unknown>) => ({ json: JSON.stringify(state) });
const unpack = (v: unknown): Record<string, unknown> | null => {
  if (!v || typeof v !== "object") return null;
  const json = (v as { json?: unknown }).json;
  return typeof json === "string" ? JSON.parse(json) : v as Record<string, unknown>;
};

/** What a company is saved under: its company id, or "i." and its institution id when it has no company id, or
    "n." and its NAIC company code when it has neither. A company with only a NAIC code can't be searched for
    filings, but its statutory figures can be found by name (scripts/companies-lib.mjs keeps the same key). */
export function entityKey(e: Pick<Entity, "companyId" | "institutionId"> & Partial<Pick<Entity, "naicCompanyCode">>): string | null {
  return e.companyId ? String(e.companyId) : e.institutionId ? `i.${e.institutionId}` : isNaicCode(e.naicCompanyCode) ? `n.${e.naicCompanyCode}` : null;
}
/** A NAIC company code as the Statutory view takes it: 1 to 6 digits. */
export const isNaicCode = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,6}$/.test(v);
/** Whether a filing search can use the company: it needs an S&P company id or institution id. */
export const canSearchFilings = (e: Pick<Entity, "companyId" | "institutionId">): boolean => !!(e.companyId || e.institutionId);

export function entityLabel(e: Entity): string {
  return [e.companyName, e.naicCompanyCode ? `NAIC ${e.naicCompanyCode}` : "", e.naicGroupName ?? ""].filter(Boolean).join(" | ").slice(0, 400);
}

/** A group name as a filter: the name anywhere in the group name ("%Calloway Group%" finds "Calloway Group (SNL
    P&C Group)"). Letters, digits, spaces and a few name characters only, so the text can't change the filter. null
    when fewer than 3 letters or digits are left, which would match too much. */
export function groupNamePattern(name: string): string | null {
  const safe = name.replace(/[^\p{L}\p{N} .&'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return safe.replace(/[^\p{L}\p{N}]/gu, "").length >= 3 ? `%${safe}%` : null;
}

/** One entry for each company: repeats dropped, and rows that are the same company (a company loaded by institution
    id alone and later seen in results with its company id, say) merged into one that carries everything known about
    it (collapseEntities). Rows with no id at all are left out. */
export function oneEach(entities: Entity[]): Entity[] {
  return collapseEntities(entities.filter((e) => e && typeof e === "object" && entityKey(e)));
}

// ---------- one company, one row ----------
// A company can reach the company list twice: from a loaded list (keyed by institution id, with a group name but no
// company id or NAIC code) and from search results (keyed by company id, with a NAIC code and statutory key but no
// group name). Saving merges the two into the row already there; reading merges any pair saved before this was so.

// The S&P statutory entity key decides too: a list exported with only the key and a NAIC code lands on the row
// that has the S&P ids and the same key. It is compared without regard to letter case.
const ID_FIELDS = ["companyId", "institutionId", "naicCompanyCode", "spStatEntityId"] as const;
const OTHER_FIELDS = ["companyName", "naicGroupCode", "naicGroupName"] as const;
const FIELD_ORDER = ["companyId", "companyName", "naicCompanyCode", "institutionId", "spStatEntityId", "naicGroupCode", "naicGroupName"] as const;
/** A filled-in value as text, or null for empty, missing or not a plain value. "1" and 1 are the same id. */
const filled = (v: unknown): string | null => (v === null || v === undefined || typeof v === "object" || typeof v === "boolean" ? null : String(v).trim() || null);
/** An id as two rows are compared on it: the statutory entity key in upper case, the others as filled. */
const idOf = (e: Partial<Entity> | null | undefined, k: typeof ID_FIELDS[number]): string | null => { const v = filled(e?.[k]); return v && k === "spStatEntityId" ? v.toUpperCase() : v; };

/** Whether two rows are the same company: they share an S&P company id, an institution id, a NAIC company code or
    an S&P statutory entity key, and no id that both have differs. Two rows with different company ids are never merged. */
export function sameCompany(a: Partial<Entity> | null | undefined, b: Partial<Entity> | null | undefined): boolean {
  if (!a || !b) return false;
  let shared = false;
  for (const k of ID_FIELDS) {
    const x = idOf(a, k), y = idOf(b, k);
    if (x && y) { if (x !== y) return false; shared = true; }
  }
  return shared;
}

/** One row from two rows of the same company. older is what was saved; newer what has just been learned. Every field
    takes newer's value when it has one, and older's otherwise, so a filled-in value is never replaced by an empty
    one. keepGroup: the group code and name already saved are kept (search results carry no group name, or a
    shorter one, while a loaded list carries the one the Statutory view and group look-ups rely on). */
export function mergeEntity(older: Entity, newer: Entity, opts: { keepGroup?: boolean } = {}): Entity {
  const pick = (k: keyof Entity, first: Entity, second: Entity) => filled(first[k]) ? String(first[k]).trim() : filled(second[k]) ? String(second[k]).trim() : null;
  const out = {} as Entity;
  for (const k of FIELD_ORDER) (out as Record<string, unknown>)[k] = pick(k, newer, older);
  if (opts.keepGroup) for (const k of ["naicGroupCode", "naicGroupName"] as const) out[k] = pick(k, older, newer);
  out.companyName = out.companyName ?? "";
  return out;
}

/** How much a row knows: its filled-in fields, a company id counting most. The fuller row leads a merge. */
const fullness = (e: Entity) => [...ID_FIELDS, ...OTHER_FIELDS].filter((k) => filled(e[k])).length + (filled(e.companyId) ? 10 : 0);

/** The rows of a list grouped by company, in the order each company first appears. A row joins a group only when it
    is the same company as one row there and clashes with none. */
function companyGroups<T extends Entity>(list: T[]): T[][] {
  type G = { at: number; rows: T[] };
  const groups: G[] = [], byId = new Map<string, G>();
  const keys = (e: T) => ID_FIELDS.map((k) => (idOf(e, k) ? `${k}:${idOf(e, k)}` : null)).filter((k): k is string => !!k);
  const fits = (a: T[], b: T[]) => a.every((x) => b.every((y) => !clash(x, y)));
  for (const e of list) {
    // The groups this row shares an id with and doesn't clash with, earliest first; it joins the first, and any
    // other it links to is folded in when the two don't clash (a row with both ids joins the two halves).
    const linked = [...new Set(keys(e).map((k) => byId.get(k)).filter((g): g is G => !!g))].filter((g) => fits(g.rows, [e])).sort((a, b) => a.at - b.at);
    let home = linked[0];
    if (home) home.rows.push(e); else groups.push(home = { at: groups.length, rows: [e] });
    for (const g of linked.slice(1)) if (fits(home.rows, g.rows)) { home.rows.push(...g.rows); g.rows = []; }
    // An id already taken by another company that clashes stays with that company.
    for (const x of home.rows) for (const k of keys(x)) { const g = byId.get(k); if (!g || !g.rows.length) byId.set(k, home); }
  }
  return groups.filter((g) => g.rows.length).map((g) => g.rows);
}
const clash = (a: Entity, b: Entity) => ID_FIELDS.some((k) => { const x = idOf(a, k), y = idOf(b, k); return !!x && !!y && x !== y; });

/** One row from all the rows of one company: the fullest leads, the others fill in what it lacks. */
function mergeGroup(g: Entity[]): Entity {
  const [lead, ...rest] = [...g].sort((a, b) => fullness(b) - fullness(a));
  return rest.reduce((acc, e) => mergeEntity(e, acc), mergeEntity(lead, lead));
}

/** One row for each company in a list read from the company list, everything known about it merged (see
    companyGroups and mergeGroup), in the order each company first appears. */
export function collapseEntities(list: Entity[]): Entity[] {
  return companyGroups(list.filter((e) => e && typeof e === "object")).map((g) => g.length === 1 ? g[0] : mergeGroup(g));
}

/** Which saved row a company lives in when several are the same company: the loaded list's row (keyed "i." and the
    institution id) first, then a company id key, then a NAIC key, so a list loaded again lands on the same row. */
const homeRank = (id: string) => (id.startsWith("entity:i.") ? 0 : /^entity:\d/.test(id) ? 1 : id.startsWith("entity:n.") ? 2 : 3);

/** What saving companies does to the rows already saved: each company is merged into the row already there for the
    same company (or gets a new row under entityKey), and any other row for that company, merged into it, is
    removed. existing: the saved rows that may be the same companies. fromList: the companies come from a loaded list,
    whose group name wins; from search results the saved group is kept. */
export function planEntityWrites(existing: { id: string; doc: Entity }[], incoming: Entity[], opts: { fromList?: boolean } = {}): { rows: { id: string; doc: Entity }[]; drop: string[] } {
  let saved = existing.filter((r) => r && typeof r.id === "string" && r.doc && typeof r.doc === "object");
  const rows = new Map<string, Entity>(), drop = new Set<string>();
  for (const e of collapseEntities(incoming.filter((e) => e && entityKey(e)))) {
    // The saved rows of this company: each shares an id with it, or with what the rows already found add to it, and
    // clashes with none of them.
    const same: { id: string; doc: Entity }[] = [], order = [...saved].sort((a, b) => homeRank(a.id) - homeRank(b.id) || a.id.localeCompare(b.id));
    for (let grew = true, cur = e; grew;) {
      grew = false;
      for (const r of order) {
        if (same.includes(r) || !sameCompany(r.doc, cur) || clash(r.doc, e) || same.some((x) => clash(x.doc, r.doc))) continue;
        same.push(r); cur = mergeGroup([e, ...same.map((x) => x.doc)]); grew = true;
      }
    }
    // A saved row under the very id this company would get (the same company id, say, with another statutory key) is
    // merged into as before, never overwritten.
    const taken = saved.find((r) => r.id === `entity:${entityKey(e)}`);
    if (!same.length && taken) same.push(taken);
    const known = same.length ? mergeGroup(same.map((r) => r.doc)) : null;
    const doc = known ? mergeEntity(known, e, { keepGroup: !opts.fromList }) : mergeEntity(e, e);
    const ids = [...new Set(same.map((r) => r.id))].sort((a, b) => homeRank(a) - homeRank(b) || a.localeCompare(b));
    const home = ids[0] ?? `entity:${entityKey(doc)}`;
    rows.set(home, doc);
    for (const id of ids.slice(1)) { drop.add(id); rows.delete(id); }
    drop.delete(home);
    saved = [...saved.filter((r) => !ids.includes(r.id)), { id: home, doc }];
  }
  return { rows: [...rows].map(([id, doc]) => ({ id, doc })), drop: [...drop] };
}

/** The companies found, in their order, each merged with the other rows (partners) that are the same company.
    Partners that match no company found are left out. */
export function withSameCompanies(found: Entity[], partners: Entity[]): Entity[] {
  const mine = new Set(found);
  return companyGroups([...found, ...partners]).filter((g) => g.some((e) => mine.has(e))).map((g) => g.length === 1 ? g[0] : mergeGroup(g));
}

/** The ids to look for saved rows of the same companies by: company ids, institution ids and NAIC codes, digits only,
    and statutory entity keys, letters and digits only. */
export function entityIdsOf(list: Partial<Entity>[]): { companyId: string[]; institutionId: string[]; naicCompanyCode: string[]; spStatEntityId: string[] } {
  const pick = (k: typeof ID_FIELDS[number], re: RegExp) => [...new Set(list.map((e) => filled(e?.[k])).filter((v): v is string => !!v && re.test(v)))];
  return { companyId: pick("companyId", /^\d{1,12}$/), institutionId: pick("institutionId", /^\d{1,12}$/), naicCompanyCode: pick("naicCompanyCode", /^\d{1,6}$/), spStatEntityId: [...new Set(pick("spStatEntityId", STAT_KEY).flatMap((v) => [v, v.toUpperCase(), v.toLowerCase()]))] };
}

/** A statutory entity key as the company list holds it: letters and digits, at most 20 (filings.ts takes the same). */
const STAT_KEY = /^[A-Za-z0-9]{1,20}$/;

// A little over S&P's one second, because the wait is measured in the database and slept in the function.
const GAP_MS = 1100;

const hourStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString();
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

export function supabaseDb(sb: SupabaseClient, now: () => number = Date.now): Db {
  const nowIso = () => new Date(now()).toISOString();
  /** Saved company rows whose company id, institution id or NAIC company code is one of these, with their row ids. */
  const rowsByIds = async (ids: ReturnType<typeof entityIdsOf>): Promise<{ id: string; doc: Entity }[]> => {
    const out = new Map<string, { id: string; doc: Entity }>();
    for (const k of ["companyId", "institutionId", "naicCompanyCode", "spStatEntityId"] as const) {
      for (let i = 0; i < (ids[k] ?? []).length; i += 100) {
        const { data, error } = await sb.from("snl_store").select("id,doc").eq("kind", "entity").in(`doc->>${k}`, ids[k].slice(i, i + 100)).limit(1000);
        if (error) throw new Error(`Couldn't read the company list: ${error.message}`);
        for (const r of (data ?? []) as { id?: unknown; doc?: unknown }[]) if (typeof r?.id === "string" && r.doc && typeof r.doc === "object") out.set(r.id, { id: r.id, doc: r.doc as Entity });
      }
    }
    return [...out.values()];
  };
  /** Companies found by a look-up, each merged with any other saved row of the same company (by institution id or
      NAIC code), so a pair saved before saving merged them reads as one company. A failed read gives the rows found. */
  const withPartners = async (found: Entity[], limit: number): Promise<Entity[]> => {
    const list = found.filter((e) => e && typeof e === "object" && entityKey(e));
    let partners: Entity[] = [];
    try {
      const ids = entityIdsOf(list);
      if (ids.institutionId.length || ids.naicCompanyCode.length || ids.spStatEntityId.length) partners = (await rowsByIds({ companyId: [], institutionId: ids.institutionId, naicCompanyCode: ids.naicCompanyCode, spStatEntityId: ids.spStatEntityId })).map((r) => r.doc);
    } catch { /* the rows as found */ }
    return withSameCompanies(list, partners).slice(0, limit);
  };
  return {
    async takeSlot(limits) {
      const { data, error } = await sb.rpc("snl_take_slot", { p_hour_limit: limits.hour, p_day_limit: limits.day, p_gap_ms: GAP_MS });
      if (error) throw new Error(`The S&P request counter didn't answer: ${error.message}`);
      const r = Array.isArray(data) ? data[0] : data;
      return { allowed: !!r?.allowed, waitMs: Number(r?.wait_ms ?? 0), hour: Number(r?.hour_count ?? 0), day: Number(r?.day_count ?? 0) };
    },
    async usage() {
      const d = new Date(now());
      const { data } = await sb.from("snl_usage").select("bucket,starts_at,requests").in("starts_at", [hourStart(d), dayStart(d)]);
      const find = (bucket: string, at: string) => Number((data ?? []).find((r) => r.bucket === bucket && new Date(r.starts_at).toISOString() === at)?.requests ?? 0);
      return { hour: find("hour", hourStart(d)), day: find("day", dayStart(d)) };
    },
    async getStore(id) {
      const { data } = await sb.from("snl_store").select("id,kind,label,doc,fetched_at").eq("id", id).maybeSingle();
      return (data as StoreRow | null) ?? null;
    },
    async putStore(row) {
      try {
        const { error } = await sb.from("snl_store").upsert({ id: row.id, kind: row.kind, label: row.label ?? "", doc: row.doc, fetched_at: nowIso() }, { onConflict: "id" });
        return !error;
      } catch { return false; }
    },
    async lastFetched() {
      const out: Partial<Record<StoreKind, string>> = {};
      for (const kind of ["reference", "search", "statutory"] as StoreKind[]) {
        const { data } = await sb.from("snl_store").select("fetched_at").eq("kind", kind).order("fetched_at", { ascending: false }).limit(1);
        if (data?.[0]?.fetched_at) out[kind] = data[0].fetched_at;
      }
      return out;
    },
    async findEntities(q, limit) {
      const text = q.trim();
      if (!text) return [];
      // Letters, digits, spaces and a few name characters only, so the text can't change the filter.
      const safe = text.replace(/[^\p{L}\p{N} .&'-]/gu, " ").replace(/\s+/g, " ").trim();
      const byId = /^[0-9]{1,12}$/.test(text)
        ? await sb.from("snl_store").select("doc").eq("kind", "entity").or(`doc->>naicCompanyCode.eq.${text},doc->>companyId.eq.${text},doc->>institutionId.eq.${text}`).limit(limit)
        : { data: [] as { doc: Entity }[] };
      const byName = safe.length >= 2
        ? await sb.from("snl_store").select("doc").eq("kind", "entity").ilike("label", `%${safe.replace(/[%_]/g, " ")}%`).order("label").limit(limit)
        : { data: [] as { doc: Entity }[] };
      // A company saved twice (loaded from a list, then seen in results before saving merged the two) is listed once,
      // with everything both rows know; so is one loaded by NAIC code alone and later seen with an S&P id.
      return await withPartners([...(byId.data ?? []), ...(byName.data ?? [])].map((r) => r.doc as Entity), limit);
    },
    async putEntities(entities) {
      if (!entities.length) return;
      const incoming = entities.filter((e) => e && entityKey(e));
      if (!incoming.length) return;
      try {
        // Each company is merged into the row already saved for it (a loaded list keys it by institution id), and
        // any second row of it saved before merging was done is folded in and removed, after the merged row is saved.
        // If the saved rows can't be read, each company is saved under its own key as before; look-ups still read
        // the two rows as one company.
        let saved: { id: string; doc: Entity }[] | null = null;
        try { saved = await rowsByIds(entityIdsOf(incoming)); } catch { saved = null; }
        const plan = saved ? planEntityWrites(saved, incoming) : { rows: incoming.map((e) => ({ id: `entity:${entityKey(e)}`, doc: e })), drop: [] as string[] };
        const rows = plan.rows.map((r) => ({ id: r.id, kind: "entity", label: entityLabel(r.doc), doc: r.doc, fetched_at: nowIso() }));
        const { error } = await sb.from("snl_store").upsert(rows, { onConflict: "id" });
        if (!error && plan.drop.length) await sb.from("snl_store").delete().eq("kind", "entity").in("id", plan.drop);
      } catch { /* the directory is a convenience; a failed save never fails a search */ }
    },
    async entitiesInGroup(groupCode, limit) {
      if (!isNaicCode(groupCode)) return [];
      const { data } = await sb.from("snl_store").select("doc").eq("kind", "entity").eq("doc->>naicGroupCode", groupCode).order("label").limit(limit);
      return await withPartners((data ?? []).map((r) => r.doc as Entity), limit);
    },
    async entitiesInGroupName(groupName, limit) {
      const pattern = groupNamePattern(groupName);
      if (!pattern) return [];
      const { data } = await sb.from("snl_store").select("doc").eq("kind", "entity").ilike("doc->>naicGroupName", pattern).order("label").limit(limit);
      return await withPartners((data ?? []).map((r) => r.doc as Entity), limit);
    },
    async entitiesByInstitution(ids) {
      const inst = [...new Set(ids.filter((i) => /^\d{1,12}$/.test(i)))];
      if (!inst.length) return [];
      return await withPartners((await rowsByIds({ companyId: [], institutionId: inst, naicCompanyCode: [], spStatEntityId: [] })).map((r) => r.doc), 1000);
    },
    async fillEntityCodes(fills) {
      // Written with the function's own service access: logins may only read the company list (migration 0001).
      const inst = fills.map((f) => f.institutionId).filter((i) => /^\d{1,12}$/.test(i));
      if (!inst.length) return 0;
      try {
        const rows = await rowsByIds({ companyId: [], institutionId: inst, naicCompanyCode: [], spStatEntityId: [] });
        const out: { id: string; kind: string; label: string; doc: Entity; fetched_at: string }[] = [];
        for (const r of rows) {
          const f = fills.find((x) => x.institutionId === String(r.doc.institutionId ?? "").trim());
          const doc = f ? filledRow(r.doc, f) : null;
          if (doc) out.push({ id: r.id, kind: "entity", label: entityLabel(doc), doc, fetched_at: nowIso() });
        }
        if (!out.length) return 0;
        const { error } = await sb.from("snl_store").upsert(out, { onConflict: "id" });
        return error ? 0 : out.length;
      } catch { return 0; /* the codes are still shown; the next search asks again */ }
    },
    async getSetting(id) {
      const { data } = await sb.from("snl_settings").select("doc").eq("id", id).maybeSingle();
      return (data?.doc as Record<string, unknown> | undefined) ?? null;
    },
    async recentStore(kind, limit) {
      const { data, error } = await sb.from("snl_store").select("id,kind,label,doc,fetched_at").eq("kind", kind).order("fetched_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`Couldn't read the saved results: ${error.message}`);
      return (data ?? []) as StoreRow[];
    },
    async entityFields(limit) {
      // Only the ids and the group, a thousand rows at a time (the most PostgREST returns in one answer).
      const out: EntityFields[] = [];
      for (let from = 0; from < limit; from += 1000) {
        const { data, error } = await sb.from("snl_store")
          .select("companyId:doc->>companyId,institutionId:doc->>institutionId,spStatEntityId:doc->>spStatEntityId,naicCompanyCode:doc->>naicCompanyCode,naicGroupCode:doc->>naicGroupCode,naicGroupName:doc->>naicGroupName")
          .eq("kind", "entity").order("id").range(from, Math.min(limit, from + 1000) - 1);
        if (error) throw new Error(`Couldn't read the company list: ${error.message}`);
        out.push(...((data ?? []) as EntityFields[]));
        if ((data ?? []).length < 1000) break;
      }
      return out;
    },
    async startWatchRun(trigger, staleMs, staleMessage) {
      await sb.from("snl_watch_runs").update({ status: "failed", finished_at: nowIso(), message: staleMessage }).eq("status", "running").lt("started_at", new Date(now() - staleMs).toISOString());
      const { data, error } = await sb.from("snl_watch_runs").insert({ status: "running", trigger, started_at: nowIso() }).select("id").single();
      if (error?.code === "23505") return null;   // the one-running-check index: another check holds it
      if (error) throw new Error(`Couldn't record the check: ${error.message}`);
      return data.id as string;
    },
    async finishWatchRun(id, patch) {
      const { error } = await sb.from("snl_watch_runs").update({ ...patch, finished_at: nowIso() }).eq("id", id);
      if (error) throw new Error(`Couldn't record the end of the check: ${error.message}`);
    },
    async addWatchRun(run) {
      const { error } = await sb.from("snl_watch_runs").insert(run);
      if (error) throw new Error(`Couldn't record the check: ${error.message}`);
    },
    async watchRuns(limit) {
      const { data, error } = await sb.from("snl_watch_runs").select("*").order("started_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`Couldn't read the record of checks: ${error.message}`);
      return (data ?? []) as WatchRun[];
    },
    async lastWatchScope() {
      const { data, error } = await sb.from("snl_watch_runs").select("scope").eq("status", "ok").eq("complete", true).not("scope", "is", null).order("started_at", { ascending: false }).limit(1);
      if (error) throw new Error(`Couldn't read the last check: ${error.message}`);
      return (data?.[0]?.scope as WatchScope | undefined) ?? null;
    },
    async seenFilings(ids) {
      const out: string[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from("snl_watch_found").select("filing_version_id").in("filing_version_id", ids.slice(i, i + 200));
        if (error) throw new Error(`Couldn't read the filings found before: ${error.message}`);
        out.push(...(data ?? []).map((r) => r.filing_version_id as string));
      }
      return out;
    },
    async addFoundFilings(rows) {
      if (!rows.length) return;
      const { error } = await sb.from("snl_watch_found").upsert(rows, { onConflict: "filing_version_id", ignoreDuplicates: true });
      if (error) throw new Error(`Couldn't save the filings found: ${error.message}`);
    },
    async foundFilings(limit) {
      const { data, error } = await sb.from("snl_watch_found").select("*").eq("baseline", false).order("first_seen_at", { ascending: false }).order("publish_date", { ascending: false }).limit(limit);
      if (error) throw new Error(`Couldn't read the filings found: ${error.message}`);
      return (data ?? []) as FoundFiling[];
    },
    async dropOldWatch(before) {
      try {
        await sb.from("snl_watch_found").delete().lt("first_seen_at", before);
        await sb.from("snl_watch_runs").delete().neq("status", "running").lt("started_at", before);
      } catch { /* housekeeping: tried again at the next check */ }
    },
    async createJob(owner, question) {
      const { data, error } = await sb.from("snl_jobs").insert({ owner, question, status: "queued" }).select("id").single();
      return error ? null : (data.id as string);
    },
    async getJob(id) {
      const { data } = await sb.from("snl_jobs").select("*").eq("id", id).maybeSingle();
      return (data as Job | null) ?? null;
    },
    async updateJob(id, patch) {
      const { error } = await sb.from("snl_jobs").update({ ...patch, updated_at: nowIso(), heartbeat_at: nowIso() }).eq("id", id);
      if (error) throw new Error(`Couldn't save the answer's progress: ${error.message}`);
    },
    async claimJob(id, from, staleMs) {
      let q = sb.from("snl_jobs").update({ status: "running", updated_at: nowIso(), heartbeat_at: nowIso() }).eq("id", id).in("status", from);
      if (staleMs !== undefined) q = q.lt("heartbeat_at", new Date(now() - staleMs).toISOString());
      const { data, error } = await q.select("id");
      return !error && (data?.length ?? 0) === 1;
    },
    async getJobState(id) {
      const { data } = await sb.from("snl_job_state").select("state").eq("job_id", id).maybeSingle();
      return unpack(data?.state);
    },
    async putJobState(id, state) {
      const { error } = await sb.from("snl_job_state").upsert({ job_id: id, state: pack(state), updated_at: nowIso() }, { onConflict: "job_id" });
      if (error) throw new Error(`Couldn't save the answer's place: ${error.message}`);
    },
    async dropJobState(id) {
      await sb.from("snl_job_state").delete().eq("job_id", id);
    },
    async oldJobStates(before, limit) {
      const { data } = await sb.from("snl_job_state").select("job_id,state").lt("updated_at", before).order("updated_at").limit(limit);
      return (data ?? []).map((r) => ({ jobId: r.job_id as string, state: unpack(r.state) ?? {} }));
    },
    async activeJob(owner, since) {
      const { data } = await sb.from("snl_jobs").select("id").eq("owner", owner).in("status", ["queued", "running", "paused"]).gte("heartbeat_at", since).order("created_at", { ascending: false }).limit(1);
      return (data?.[0]?.id as string | undefined) ?? null;
    },
    async dropOldJobs(before) {
      try { await sb.from("snl_jobs").delete().in("status", ["done", "error"]).lt("created_at", before); } catch { /* housekeeping: tried again next time */ }
    },
    async countJobsSince(owner, since) {
      const { count, error } = await sb.from("snl_jobs").select("id", { count: "exact", head: true }).eq("owner", owner).gte("created_at", since);
      // Not knowing the count must never let a question through uncounted.
      if (error) throw new Error(`Couldn't count today's questions: ${error.message}`);
      return count ?? 0;
    },
    async usageSince(owner, since) {
      // Only the usage part of each result is read, not the answers themselves.
      const { data, error } = await sb.from("snl_jobs").select("usage:result->usage").eq("owner", owner).eq("status", "done").gte("created_at", since);
      if (error) throw new Error(`Couldn't add up today's costs: ${error.message}`);
      return (data ?? []).map((r) => (r as { usage?: unknown }).usage).filter((u): u is Record<string, unknown> => !!u && typeof u === "object" && !Array.isArray(u));
    },
    // ---------- the team library (migration 0007) ----------
    async profileName(uid) {
      const { data } = await sb.from("profiles").select("username,display_name").eq("id", uid).maybeSingle();
      const name = String(data?.display_name || data?.username || "").trim();
      return name || null;
    },
    async libraryCount() {
      const { count, error } = await sb.from("snl_library").select("id", { count: "exact", head: true });
      if (error) libraryFail(error, "Couldn't count the library");
      return count ?? 0;
    },
    async libraryGet(id) {
      const { data, error } = await sb.from("snl_library").select("*").eq("id", id).maybeSingle();
      if (error) libraryFail(error, "Couldn't read the library");
      return (data as LibraryRow | null) ?? null;
    },
    async libraryByJob(jobId) {
      const { data, error } = await sb.from("snl_library").select("*").eq("job_id", jobId).maybeSingle();
      if (error) libraryFail(error, "Couldn't read the library");
      return (data as LibraryRow | null) ?? null;
    },
    async libraryAdd(row) {
      const { data, error } = await sb.from("snl_library").insert({ ...row, saved_at: nowIso(), updated_at: nowIso() }).select("*").single();
      if (error?.code === "23505") return null;   // one entry per answer: someone saved it a moment ago
      if (error) libraryFail(error, "Couldn't save to the library");
      return data as LibraryRow;
    },
    async libraryUpdate(id, patch) {
      const { data, error } = await sb.from("snl_library").update({ ...patch, updated_at: nowIso() }).eq("id", id).select("*");
      if (error) libraryFail(error, "Couldn't change the library entry");
      return ((data ?? [])[0] as LibraryRow | undefined) ?? null;
    },
    async libraryRemove(id) {
      const { data, error } = await sb.from("snl_library").delete().eq("id", id).select("id");
      if (error) libraryFail(error, "Couldn't remove the library entry");
      return (data?.length ?? 0) > 0;
    },
    // ---------- saved filing summaries (migration 0005) ----------
    async getDigests(ids) {
      const cols = "id,filing_version_id,document_id,state,company,form_keys,search_body,pages_read,made_at,doc";
      const out = new Map<string, DigestRow>();
      // Two plain filters rather than one combined one, so no id has to be written into a filter's text.
      for (let i = 0; i < ids.documentIds.length; i += 100) {
        const { data, error } = await sb.from("snl_digests").select(cols).in("document_id", ids.documentIds.slice(i, i + 100)).limit(1000);
        if (error) throw new Error(`Couldn't read the saved summaries: ${error.message}`);
        for (const r of (data ?? []) as DigestRow[]) out.set(r.id, r);
      }
      for (let i = 0; i < ids.versionIds.length; i += 100) {
        const { data, error } = await sb.from("snl_digests").select(cols).in("filing_version_id", ids.versionIds.slice(i, i + 100)).limit(1000);
        if (error) throw new Error(`Couldn't read the saved summaries: ${error.message}`);
        for (const r of (data ?? []) as DigestRow[]) out.set(r.id, r);
      }
      return [...out.values()];
    },
    async putDigest(row) {
      const { error } = await sb.from("snl_digests").upsert(row, { onConflict: "id" });
      if (error) throw new Error(`Couldn't save the summary: ${error.message}`);
    },
    async searchDigests(q) {
      const cols = "id,filing_version_id,document_id,state,company,form_keys,search_body,pages_read,made_at,doc";
      const out = new Map<string, DigestRow>();
      const take = (res: { data: unknown[] | null; error: { message: string } | null }) => {
        if (res.error) throw new Error(`Couldn't search the saved summaries: ${res.error.message}`);
        for (const r of (res.data ?? []) as DigestRow[]) out.set(r.id, r);
      };
      // A form number: letters and digits only, so it can't change the filter.
      if (q.formKey && /^[A-Z0-9]{1,40}$/.test(q.formKey)) {
        let b = sb.from("snl_digests").select(cols).ilike("form_keys", `%${q.formKey}%`);
        if (q.state) b = b.eq("state", q.state);
        take(await b.order("made_at", { ascending: false }).limit(q.limit));
      }
      // Words: Postgres's own word search over the generated column, any of them (the function decides where all match).
      const words = q.words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
      if (words.length) {
        let b = sb.from("snl_digests").select(cols).textSearch("search_text", words.join(" or "), { type: "websearch", config: "english" });
        if (q.state) b = b.eq("state", q.state);
        take(await b.order("made_at", { ascending: false }).limit(q.limit));
      }
      return [...out.values()].sort((a, b) => String(b.made_at).localeCompare(String(a.made_at))).slice(0, q.limit);
    },
    async countDigests() {
      const { count, error } = await sb.from("snl_digests").select("id", { count: "exact", head: true });
      if (error) throw new Error(`Couldn't count the saved summaries: ${error.message}`);
      return count ?? 0;
    },
    // ---------- the market index (migration 0006) ----------
    async allEntities(limit) {
      const out: Entity[] = [];
      for (let from = 0; from < limit; from += 1000) {
        const { data, error } = await sb.from("snl_store").select("doc").eq("kind", "entity").order("id").range(from, Math.min(limit, from + 1000) - 1);
        if (error) throw new Error(`Couldn't read the company list: ${error.message}`);
        out.push(...((data ?? []) as { doc: Entity }[]).map((r) => r.doc));
        if ((data ?? []).length < 1000) break;
      }
      return oneEach(out);
    },
    async openSweep() {
      const { data, error } = await sb.from("snl_index_sweeps").select("*").in("status", ["running", "waiting", "held"]).order("started_at", { ascending: false }).limit(1);
      if (error) throw new Error(`Couldn't read the sweeps: ${error.message}`);
      return (data?.[0] as IndexSweep | undefined) ?? null;
    },
    async getSweep(id) {
      const { data, error } = await sb.from("snl_index_sweeps").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`Couldn't read the sweep: ${error.message}`);
      return (data as IndexSweep | null) ?? null;
    },
    async createSweep(row) {
      const { data, error } = await sb.from("snl_index_sweeps").insert({ ...row, started_at: nowIso(), updated_at: nowIso() }).select("id").single();
      if (error?.code === "23505") return null;   // the one-open-sweep index: another sweep is unfinished
      if (error) throw new Error(`Couldn't record the sweep: ${error.message}`);
      return data.id as string;
    },
    async claimSweep(id, staleMs) {
      const at = nowIso();
      const waiting = await sb.from("snl_index_sweeps").update({ status: "running", updated_at: at }).eq("id", id).eq("status", "waiting")
        .or(`resume_after.is.null,resume_after.lte.${at}`).select("id");
      if (!waiting.error && (waiting.data?.length ?? 0) === 1) return true;
      const stuck = await sb.from("snl_index_sweeps").update({ status: "running", updated_at: at }).eq("id", id).eq("status", "running")
        .lt("updated_at", new Date(now() - staleMs).toISOString()).select("id");
      return !stuck.error && (stuck.data?.length ?? 0) === 1;
    },
    async updateSweep(id, patch) {
      const { error } = await sb.from("snl_index_sweeps").update({ ...patch, updated_at: nowIso() }).eq("id", id);
      if (error) throw new Error(`Couldn't save the sweep's progress: ${error.message}`);
    },
    async sweeps(limit) {
      const { data, error } = await sb.from("snl_index_sweeps").select("*").order("started_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`Couldn't read the sweeps: ${error.message}`);
      return (data ?? []) as IndexSweep[];
    },
    async putIndexRows(rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.rpc("snl_index_put", { p_rows: rows.slice(i, i + 500) });
        if (error) throw new Error(`Couldn't save filings to the index: ${error.message}`);
      }
    },
    async pruneIndex(state, from, to) {
      const { error } = await sb.from("snl_index_filings").delete().eq("state", state).or(`publish_date.is.null,publish_date.lt.${from},publish_date.gt.${to}`);
      if (error) throw new Error(`Couldn't tidy the index: ${error.message}`);
    },
    async indexCount(state) {
      let q = sb.from("snl_index_filings").select("state", { count: "exact", head: true });
      if (state) q = q.eq("state", state);
      const { count, error } = await q;
      if (error) throw new Error(`Couldn't count the index: ${error.message}`);
      return count ?? 0;
    },
    async indexStates() {
      const { data, error } = await sb.from("snl_index_states").select("*").order("state");
      if (error) throw new Error(`Couldn't read what the index covers: ${error.message}`);
      return (data ?? []) as IndexState[];
    },
    async putIndexState(s) {
      const { error } = await sb.from("snl_index_states").upsert(s, { onConflict: "state" });
      if (error) throw new Error(`Couldn't record what the index covers: ${error.message}`);
    },
    async queryIndex(q) {
      const { data, error } = await sb.rpc("snl_index_query", { p: q });
      if (error) throw new Error(`Couldn't ask the index: ${error.message}`);
      return data as IndexQueryResult;
    },
  };
}
