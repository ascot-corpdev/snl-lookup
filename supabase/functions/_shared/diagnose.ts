// The Live check (snl-filings, action "diagnose", Corp Dev logins only): looks at real answers from S&P and reports
// only their shapes and counts, so the owner can send the report to whoever maintains the app without sending any
// S&P data. Each finding says what was found and whether it matches what the code assumes, and names the place in
// the code that would change if it doesn't.
//
// What it reads, in this order:
//   free:  the saved reference lists, the most recent saved searches (at most SAVED_SEARCHES, SAVED_ROWS rows), and
//          the company list's id fields (never the names);
//   S&P:   a full sign-in, any of the two lists a search needs that isn't saved, one small live search (page 1 and,
//          when S&P says there is more than one page, the last page), one document; then any other missing list.
// At most MAX_REQUESTS S&P requests, every one through the usual gate (the 1-a-second spacing and the hourly and
// daily counter) and each tried once. It stops at the first refusal, before a limit is reached, or when time runs
// short, and reports what it learned. Nothing is saved except reference lists it had to fetch, as the connection
// check does: no search, no company, no document.
//
// THE REDACTION: every value S&P sends reaches the report only through redact() (a value becomes words or a mask
// that describe its shape; a column or key name passes only if it is a plain field name), and every piece of text
// put into a sentence passes through say(), which drops anything equal to a value S&P sent. Numbers in the report
// are counts, shares, page counts and rate impacts worked out here, never ids.

import type { Db, EntityFields, StoreRow, Usage } from "./db.ts";
import { countPdfPages } from "./chat.ts";
import { type Cell, downloadDocument, type DocRef, getReference, mapRows, parseDocRef, type Reference, REFERENCE_FIELDS, type ReferenceField, SEARCH_COLUMNS } from "./filings.ts";
import { type Gate, type Plan, Spgmi, type SpgmiCreds, SpgmiError, TOKEN_URL } from "./spgmi.ts";

export const MAX_REQUESTS = 6;               // S&P requests one Live check may send
export const SAVED_SEARCHES = 8;             // the most recent saved searches it reads
export const SAVED_ROWS = 3000;              // rows it reads from them at most
const PER_SEARCH_ROWS = 1000;                // and from any one of them
export const LIVE_PAGE_SIZE = 20;            // rows a page in the live search
export const NEAR_LIMIT = 20;                // fewer S&P requests than this left in the hour or day: S&P isn't asked
export const SEND_BY_MS = 80_000;            // no new S&P request after this long
const HARD_STOP_MS = 120_000;                // and none may still be waiting after this long (Supabase allows 150 s)
const REQUEST_TIMEOUT_MS = 30_000;
const DOC_MAX_BYTES = 40 * 1024 * 1024;
export const PDF_BUDGET_MS = 1200;           // processing time the file may take (Supabase allows about 2 s of CPU a call)
const DIRECTORY_MAX = 20_000;

export const US_STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"];
const TERRITORIES = ["PR", "VI", "GU", "AS", "MP"];
/** The standard SERFF section headings, as the report names them, and the letters looked for in the file. */
export const SERFF_HEADINGS: [string, string][] = [
  ["Filing at a glance", "filingataglance"], ["General information", "generalinformation"], ["Company and contact", "companyandcontact"],
  ["Filing fees", "filingfees"], ["Correspondence summary", "correspondencesummary"], ["Disposition", "disposition"],
  ["Rate information", "rateinformation"], ["Rate/rule schedule", "rateruleschedule"], ["Form schedule", "formschedule"],
  ["Supporting documentation", "supportingdocument"],
];
const DATE_COLUMNS = ["dateSubmitted", "publishDate", "renewBusReqEffDate", "newBusReqEffDate"];
/** Columns that name a company: rows of one filing version may differ in these and still be one filing. */
const COMPANY_COLUMNS = new Set(["companyId", "companyName", "naicCompanyCode", "institutionId", "spStatEntityId", "naicGroupCode", "naicGroupName", "serffFilingEntityEventId"]);

export type Outcome = "holds" | "differs" | "unknown" | "info";
export type GroupId = "signin" | "lists" | "search" | "document" | "directory";
export const GROUPS: Record<GroupId, string> = { signin: "Signing in", lists: "Reference lists", search: "Search results", document: "A filing document", directory: "Company list" };
/** One finding: what was found, in words; whether it matches the code; and where the code would change. */
export type Finding = { id: string; group: GroupId; title: string; outcome: Outcome; found: string; verdict: string; where: string };
export type ColumnShape = { name: string; filled: string; shapes: string };
export type DiagnoseReport = {
  configured: boolean; ranAt: string; account: Plan; limits: Usage; used: Usage;
  requests: number; maxRequests: number; seconds: number;
  /** Why it stopped before the end, in plain words; null when it ran to the end. */
  stopped: string | null;
  /** What the report rests on: saved searches and rows, live rows, companies, the document. */
  basis: string;
  summary: string;
  counts: Record<Outcome, number>;
  findings: Finding[];
  /** The value types of every result column. */
  columns: ColumnShape[];
  /** What this check can't settle, on purpose. */
  notCovered: string[];
};

export const DIAGNOSE_NOT_CONFIGURED = "S&P isn't set up yet, so the Live check asked S&P nothing. When the S&P secrets are set (README, step 5), run it again. Below is what it could read from results the app has already saved and from the company list.";
export const NOT_COVERED = [
  "What S&P answers to a wrong password, and whether a refused sign-in carries an S&P reference: this check never sends a wrong password, so it can't lock the account.",
  "How long S&P locks an account, and how long a refresh token stays usable: these take a lock or several days to see.",
  "How S&P counts requests and when its day starts: only S&P can say (any limit figures S&P sends with an answer are listed under search results).",
  "Whether S&P limits access to fixed IP addresses, and everything about Snowflake.",
];

type Row = Record<string, Cell>;

// ---------- the redaction ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** THE REDACTION. Turns one value from S&P into words that describe its shape ("YYYY-MM-DD", "digits only, as
    text", "number followed by %", a mask such as "AAAA-999999999" for a short code), or, with as "name", passes a
    column or key name only when it is a plain field name (letters, digits, "_" and "-", starting with a letter, at
    most 48 characters). Nothing else S&P sends can reach the report: a mask keeps no letter or digit, only A, a and
    9 in their place and the punctuation - _ . / : #; anything longer, or with spaces, is just "text". */
export function redact(v: unknown, as: "value" | "name" = "value"): string {
  if (as === "name") return typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(v) ? v : "(a name that isn't a plain field name)";
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "boolean") return "yes/no";
  if (typeof v === "number") return Number.isInteger(v) ? "whole number" : Number.isFinite(v) ? "decimal number" : "not a number";
  if (typeof v !== "string") return "a list or object";
  const s = v.trim();
  if (!s) return "empty";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "YYYY-MM-DD";
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return "YYYY-MM-DD with a time";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return "M/D/YYYY";
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(s)) return "D-Mon-YYYY";
  if (/^\d{8}$/.test(s) && /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(s)) return "YYYYMMDD";
  if (/^[-+]?\d+(\.\d+)?\s?%$/.test(s)) return "number followed by %";
  if (/^\([-+]?\d+(\.\d+)?\s?%\)$/.test(s)) return "number followed by %, in brackets";
  if (/^[-+]?\d+$/.test(s)) return "digits only, as text";
  if (/^[-+]?(\d+\.\d*|\.\d+)$/.test(s)) return "decimal number, as text";
  if (UUID.test(s)) return "36-character id (8-4-4-4-12 letters and digits)";
  if (/^(true|false|yes|no|y|n)$/i.test(s)) return "yes/no, as text";
  if (/^[\[{]/.test(s)) { try { JSON.parse(s); return "a list or object"; } catch { /* text */ } }
  if (s.length <= 24 && !/\s/.test(s) && /\d/.test(s)) return s.replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "9").replace(/[^Aa9\-_./:#]/g, "?");
  return "text";
}

/** Letters and digits only, lower case: how values are compared for the last check against leaks. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Every value S&P sent in this run, so say() can drop any piece of text that is one of them. */
function seenValues() {
  const set = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string") { const n = norm(v); if (n.length >= 5) set.add(n); }
    else if (typeof v === "number" && Number.isFinite(v)) { const n = String(Math.abs(v)).replace(/\D/g, ""); if (n.length >= 5) set.add(n); }
  };
  return {
    add, has: (s: string) => { const n = norm(s); return n.length >= 5 && set.has(n); },
    rows(rows: Iterable<Record<string, unknown>>) { for (const r of rows) for (const v of Object.values(r)) { if (Array.isArray(v)) for (const c of v) if (c && typeof c === "object") this.rows([c as Record<string, unknown>]); else add(v); else add(v); } },
  };
}

// ---------- small sums ----------

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const share = (n: number, of: number) => (of ? `${(Math.round((n / of) * 1000) / 10).toFixed(1)}%` : "n/d");
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\s*[-+]?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : null);
const isWhole = (v: unknown) => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^\d{1,15}$/.test(v.trim()));
const filled = (v: unknown) => v !== null && v !== undefined && v !== "";
function quantile(sorted: number[], q: number): number { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : NaN; }
const oneDp = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
const dp3 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many = one + "s") => `${fmt(n)} ${n === 1 ? one : many}`;

/** The shapes of one column's values: "YYYY-MM-DD (98.0%); empty (2.0%)", with lengths for text and digits. */
export function describeColumn(values: unknown[]): { filled: string; shapes: string } {
  const by = new Map<string, { n: number; min: number; max: number }>();
  let present = 0;
  for (const v of values) {
    const label = redact(v);
    if (label !== "empty") present++;
    const size = typeof v === "string" ? (/^[-+]?\d+$/.test(v.trim()) ? v.trim().replace(/\D/g, "").length : v.trim().length) : typeof v === "number" && Number.isInteger(v) ? String(Math.abs(v)).length : 0;
    const e = by.get(label) ?? { n: 0, min: Infinity, max: 0 };
    e.n++; e.min = Math.min(e.min, size); e.max = Math.max(e.max, size);
    by.set(label, e);
  }
  const top = [...by.entries()].sort((a, b) => b[1].n - a[1].n);
  const words = top.slice(0, 4).map(([label, e]) => {
    const range = e.min === e.max ? `${e.min}` : `${e.min} to ${e.max}`;
    const size = label === "text" ? `, ${range} character${range === "1" ? "" : "s"}` : label === "digits only, as text" || label === "whole number" ? `, ${range} digit${range === "1" ? "" : "s"}` : "";
    return `${label}${size} (${share(e.n, values.length)})`;
  });
  if (top.length > 4) words.push(`${top.length - 4} other patterns`);
  return { filled: share(present, values.length), shapes: words.join("; ") };
}

// ---------- reading a PDF without a library ----------

export type PdfFacts = {
  counted: number | null; treePages: number | null; pagesRead: number; textPages: number; readablePages: number;
  headings: { name: string; pages: number[] }[]; encrypted: boolean; ms: number; stoppedEarly: boolean;
};

async function inflate(data: Uint8Array, max: number): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream("deflate");
    const w = ds.writable.getWriter();
    w.write(data as unknown as BufferSource).catch(() => {});
    w.close().catch(() => {});
    const r = ds.readable.getReader(), parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      let x: ReadableStreamReadResult<Uint8Array>;
      try { x = await r.read(); } catch { break; }
      if (x.done) break;
      parts.push(x.value); n += x.value.length;
      if (n > max) { r.cancel().catch(() => {}); break; }
    }
    if (!n) return null;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p.subarray(0, Math.min(p.length, n - at)), at); at += p.length; if (at >= n) break; }
    return out;
  } catch { return null; }
}

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const refsIn = (s: string) => [...s.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));

/** The text the page's content draws, as plain letters, from literal and hex strings. Fonts with their own codes
    give letters that mean nothing; then no heading is found, and the report says the text couldn't be read. */
function drawnText(c: string): { ops: boolean; letters: string } {
  const ops = /\bBT\b/.test(c) && /(\)|>|\])\s*(Tj|TJ|'|")/.test(c);
  if (!ops) return { ops, letters: "" };
  let out = "";
  for (const m of c.matchAll(/\((?:\\[\s\S]|[^\\()])*\)|<([0-9A-Fa-f\s]*)>/g)) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s/g, "");
      if (hex.length % 4 === 0 && hex.length && /^(00[0-9A-Fa-f]{2})+$/.test(hex)) for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      else for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    } else out += m[0].slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e === "n" || e === "r" || e === "t" ? " " : e.length === 1 && "()\\".includes(e) ? e : "");
    if (out.length > 40_000) break;
  }
  return { ops, letters: out.toLowerCase().replace(/[^a-z]/g, "") };
}

/** Pages, text and SERFF headings in a PDF, read with the same page count Claude's limits use (countPdfPages in
    chat.ts) plus a small reader of the page tree. Stops at budgetMs of processing and says so. */
export async function pdfFacts(bytes: Uint8Array, budgetMs = PDF_BUDGET_MS): Promise<PdfFacts> {
  const t0 = performance.now(), over = () => performance.now() - t0 > budgetMs;
  const s = latin1(bytes);
  const facts: PdfFacts = { counted: countPdfPages(bytes), treePages: null, pagesRead: 0, textPages: 0, readablePages: 0, headings: [], encrypted: /\/Encrypt\s/.test(s), ms: 0, stoppedEarly: false };
  type Obj = { dict: string; ds?: number; de?: number };
  const objs = new Map<number, Obj>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  for (let m: RegExpExecArray | null; (m = re.exec(s));) {
    const start = m.index + m[0].length, end = s.indexOf("endobj", start);
    const si = s.indexOf("stream", start);
    if (si !== -1 && (end === -1 || si < end) && s.slice(start, si).includes("<<")) {
      let ds = si + 6;
      if (s[ds] === "\r") ds++;
      if (s[ds] === "\n") ds++;
      const dict = s.slice(start, si);
      const len = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let de = len ? ds + Number(len[1]) : -1;
      if (de < 0 || de > s.length || s.slice(de, de + 20).indexOf("endstream") === -1) de = s.indexOf("endstream", ds);
      if (de === -1) break;
      objs.set(Number(m[1]), { dict: dict.slice(0, 4000), ds, de });
      re.lastIndex = de;
    } else {
      objs.set(Number(m[1]), { dict: s.slice(start, end === -1 ? Math.min(s.length, start + 4000) : Math.min(end, start + 20_000)) });
      if (end !== -1) re.lastIndex = end;
    }
  }
  const data = async (o: Obj): Promise<string | null> => {
    if (o.ds === undefined || o.de === undefined) return null;
    const raw = bytes.subarray(o.ds, o.de);
    const filter = o.dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] ?? "";
    if (!filter) return latin1(raw);
    if (!/^(\/FlateDecode|\[\s*\/FlateDecode\s*\])$/.test(filter.trim())) return null;
    const out = await inflate(raw, 8 * 1024 * 1024);
    return out ? latin1(out) : null;
  };
  // Objects packed inside object streams (PDF 1.5 and later): page objects often live there.
  for (const [, o] of [...objs]) {
    if (over()) break;
    if (!/\/Type\s*\/ObjStm\b/.test(o.dict)) continue;
    const text = await data(o);
    const first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1] ?? NaN), n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1] ?? NaN);
    if (!text || !Number.isFinite(first) || !Number.isFinite(n)) continue;
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < Math.min(n, nums.length / 2); i++) {
      const num = nums[2 * i], at = first + nums[2 * i + 1], next = i + 1 < n && 2 * i + 3 < nums.length ? first + nums[2 * i + 3] : text.length;
      if (!objs.has(num)) objs.set(num, { dict: text.slice(at, Math.min(next, at + 20_000)) });
    }
  }
  // The pages, in order, from the page tree.
  const pages: number[] = [], seen = new Set<number>();
  const walk = (n: number, depth: number) => {
    const o = objs.get(n);
    if (!o || seen.has(n) || depth > 60 || pages.length >= 10_000) return;
    seen.add(n);
    if (/\/Type\s*\/Pages\b/.test(o.dict)) for (const k of refsIn(o.dict.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] ?? "")) walk(k, depth + 1);
    else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(n);
  };
  const catalog = [...objs.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
  const root = catalog?.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/)?.[1];
  if (root) walk(Number(root), 0);
  else for (const [n, o] of objs) if (/\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent\b/.test(o.dict)) walk(n, 0);
  facts.treePages = pages.length || null;
  if (facts.encrypted) { facts.ms = Math.round(performance.now() - t0); return facts; }
  // Each page's text, while the budget lasts.
  const found = new Map<string, number[]>();
  for (let i = 0; i < pages.length; i++) {
    if (over()) { facts.stoppedEarly = true; break; }
    const p = objs.get(pages[i])!;
    let refs: number[] = [];
    const arr = p.dict.match(/\/Contents\s*\[([^\]]*)\]/), one = p.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (arr) refs = refsIn(arr[1]);
    else if (one) { const c = objs.get(Number(one[1])); refs = c && c.ds === undefined && c.dict.trim().startsWith("[") ? refsIn(c.dict) : [Number(one[1])]; }
    let ops = false, letters = "";
    for (const r of refs.slice(0, 50)) {
      const o = objs.get(r);
      const text = o ? await data(o) : null;
      if (!text) continue;
      const d = drawnText(text);
      ops ||= d.ops; letters += d.letters;
    }
    facts.pagesRead++;
    if (ops) facts.textPages++;
    if (letters.length >= 20) facts.readablePages++;
    for (const [name, key] of SERFF_HEADINGS) if (letters.includes(key)) { const l = found.get(name) ?? []; if (l.length < 5) l.push(i + 1); found.set(name, l); }
  }
  facts.headings = SERFF_HEADINGS.map(([name]) => ({ name, pages: found.get(name) ?? [] }));
  facts.ms = Math.round(performance.now() - t0);
  return facts;
}

// ---------- the check ----------

class Halt extends Error {}

type SignInShape = { keys: string[]; expiresType: string; expiresMinutes: number | null; refreshType: string; tokenType: boolean } | null;
type DocInfo = { type: string; size: number; cut: boolean; headerNames: string[]; named: boolean; ext: string | null; rowPages: number | null; pdf: PdfFacts | null; isPdf: boolean };
type LiveSearch = { keys: string[]; headers: string[]; responseHeaders: [string, string][]; asked: number; rows: Row[]; totalPages: number | null; currentPage: unknown };

async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const r = res.body?.getReader();
  if (!r) return { bytes: new Uint8Array(0), cut: false };
  const parts: Uint8Array[] = [];
  let n = 0, cut = false;
  for (;;) {
    const x = await r.read();
    if (x.done) break;
    parts.push(x.value); n += x.value.length;
    if (n > max) { cut = true; r.cancel().catch(() => {}); break; }
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return { bytes: out, cut };
}

export async function diagnose(o: {
  creds: SpgmiCreds; db: Db; gate: Gate; fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number;
  plan: Plan; limits: Usage; pdfBudgetMs?: number;
}): Promise<DiagnoseReport> {
  const started = o.now();
  const seen = seenValues();
  /** Every sentence is written with this: a piece of text that is a value S&P sent is dropped. Numbers are ours. */
  const say = (parts: TemplateStringsArray, ...vals: unknown[]) =>
    parts.reduce((out, p, i) => out + p + (i < vals.length ? (typeof vals[i] === "number" ? String(vals[i]) : seen.has(String(vals[i])) ? "[removed]" : String(vals[i])) : ""), "");
  /** A column or key name for a sentence: redacted, and dropped if it is a value S&P sent. */
  const nm = (k: unknown) => { const r = redact(k, "name"); return seen.has(r) ? "[removed]" : r; };
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "verdict"> & { verdict?: string }) => findings.push({
    ...f, verdict: f.verdict ?? (f.outcome === "holds" ? "As the app assumes." : f.outcome === "info" ? "For the record." : f.outcome === "unknown" ? "Couldn't tell." : "Differs."),
  });
  const holds = "As the app assumes.";
  let requests = 0, stopped: string | null = null;
  const configured = Spgmi.configured(o.creds);
  const used0 = await o.db.usage();

  // ----- free: what the app already holds -----
  const refs: Partial<Record<ReferenceField, Reference>> = {};
  for (const f of REFERENCE_FIELDS) { const r = await getReference(null, o.db, f, { now: started }); if (r) { refs[f] = r; seen.rows(r.rows); } }
  const searches: StoreRow[] = o.db.recentStore ? await o.db.recentStore("search", SAVED_SEARCHES) : [];
  const saved: Row[] = [];
  const savedPerSearch: Row[][] = [];
  for (const s of searches) {
    const rows = Array.isArray((s.doc as { rows?: unknown }).rows) ? ((s.doc as { rows: Row[] }).rows) : [];
    const take = rows.slice(0, Math.min(PER_SEARCH_ROWS, SAVED_ROWS - saved.length)).filter((r) => r && typeof r === "object");
    if (!take.length) continue;
    saved.push(...take); savedPerSearch.push(take);
    seen.rows(take);
    const params = (s.doc as { params?: Record<string, unknown> }).params;
    if (params) seen.rows([params]);
    if (saved.length >= SAVED_ROWS) break;
  }
  const directory: EntityFields[] = o.db.entityFields ? await o.db.entityFields(DIRECTORY_MAX) : [];
  seen.rows(directory as unknown as Record<string, unknown>[]);

  // ----- S&P, at most MAX_REQUESTS requests -----
  let signin: SignInShape = null, signinTried = false;
  let live: LiveSearch | null = null, lastPage: LiveSearch | null = null, liveTried = false;
  let doc = null as DocInfo | null, docTried = false;
  const fetched: ReferenceField[] = [];
  const stopWith = (where: string, e: unknown) => {
    if (e instanceof Halt) { stopped = e.message; return; }
    if (!(e instanceof SpgmiError)) throw e;
    const ref = e.requestId && /^[A-Za-z0-9._:-]{1,64}$/.test(e.requestId) ? say` S&P reference: ${e.requestId}.` : "";
    const what: Record<string, string> = {
      limit: "The app stopped before asking S&P: a request limit is used up.",
      signin: `S&P didn't accept the API sign-in (${e.status || "no status"}).`,
      locked: "S&P has locked the API account (423). Ask S&P to unlock it; the app won't sign in for 30 minutes.",
      entitlement: "S&P refused filings data (403, entitlement needed). Run Check S&P connection for what to ask S&P.",
      rate_limited: "S&P said too many requests were sent (429). Wait a minute and run it again.",
      network: "S&P didn't answer, or didn't answer in time.",
      not_configured: DIAGNOSE_NOT_CONFIGURED,
    };
    stopped = `Stopped at ${where}: ${what[e.code] ?? `S&P refused the request (${e.status || "no answer"}).`}${ref} What it learned before that is below.`;
  };

  if (!configured) stopped = DIAGNOSE_NOT_CONFIGURED;
  else if (o.limits.hour - used0.hour < NEAR_LIMIT || o.limits.day - used0.day < NEAR_LIMIT) {
    stopped = `S&P wasn't asked: fewer than ${NEAR_LIMIT} S&P requests are left ${o.limits.hour - used0.hour < NEAR_LIMIT ? "this hour" : "today"}, and the Live check leaves them for searches. Run it again ${o.limits.hour - used0.hour < NEAR_LIMIT ? "after the top of the hour" : "tomorrow"}. What it could read from saved results is below.`;
  } else {
    const gate: Gate = async () => {
      if (requests >= MAX_REQUESTS) throw new Halt(`The Live check stopped at its limit of ${MAX_REQUESTS} S&P requests.`);
      if (o.now() - started > SEND_BY_MS) throw new Halt("The Live check stopped to stay inside the time a function may run. What it learned is below; run it again for the rest.");
      await o.gate();
      requests++;
    };
    const watched: typeof fetch = async (input, init) => {
      const left = Math.max(1000, started + HARD_STOP_MS - o.now());
      const res = await o.fetch(input, { ...(init ?? {}), signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left)) });
      if (String(input instanceof Request ? input.url : input) === TOKEN_URL && res.ok) {
        try {
          const b = await res.clone().json();
          const exp = b?.expires_in_seconds, life = typeof exp === "number" ? exp : typeof exp === "string" && /^\s*\d+(\.\d+)?\s*$/.test(exp) ? Number(exp) : null;
          signin = {
            keys: b && typeof b === "object" ? Object.keys(b).map((k) => redact(k, "name")) : [],
            expiresType: exp === undefined ? "missing" : typeof exp === "string" ? (life !== null ? "text of digits" : "text that isn't a number") : typeof exp === "number" ? "a number" : "something else",
            expiresMinutes: life !== null && life > 0 ? Math.round(life / 60) : null,
            refreshType: b?.refresh_token === undefined || b?.refresh_token === null || b?.refresh_token === "" ? "missing" : typeof b.refresh_token === "string" ? "text" : "something else",
            tokenType: typeof b?.token_type === "string",
          };
        } catch { signin = { keys: [], expiresType: "unreadable", expiresMinutes: null, refreshType: "unreadable", tokenType: false }; }
      }
      return res;
    };
    const api = new Spgmi(o.creds, { fetch: watched, gate, sleep: o.sleep, now: o.now, once: true });
    const go = async (where: string, step: () => Promise<void>) => { if (stopped) return; try { await step(); } catch (e) { stopWith(where, e); } };

    // 1. A full sign-in, to see what S&P sends back with the token.
    await go("the sign-in", async () => { signinTried = true; await api.signInNow(); });
    // 2. The two lists a search needs, if they aren't saved.
    for (const f of ["filingStatus", "serffFilingState"] as ReferenceField[]) {
      if (refs[f]) continue;
      await go(`S&P's list of ${f === "filingStatus" ? "statuses" : "states"}`, async () => {
        const r = await getReference(api, o.db, f, { now: o.now(), refresh: true });
        if (r) { refs[f] = r; fetched.push(f); seen.rows(r.rows); }
      });
    }
    // 3. One small live search: page 1, then the last page when S&P says there is more than one.
    const plan = livePlan(searches, directory, refs, started);
    if (plan) {
      const page = async (n: number): Promise<LiveSearch> => {
        const res = await api.call("POST", "/api/v1/search", { body: { properties: { ...plan, pageNumber: n, pageSize: LIVE_PAGE_SIZE } } });
        const responseHeaders = [...res.headers.entries()].filter(([k]) => /rate|limit|remaining|quota|retry|reset/i.test(k)).map(([k, v]) => [redact(k, "name"), /^\d{1,9}$/.test(v.trim()) ? v.trim() : redact(v)] as [string, string]);
        let body: Record<string, unknown> = {};
        try { const b = await res.json(); if (b && typeof b === "object") body = b; } catch { /* unreadable: counted as no rows */ }
        const rows = mapRows(body);
        seen.rows(rows);
        const tp = numOf(body.totalPages);
        return { keys: Object.keys(body).map((k) => redact(k, "name")), headers: Array.isArray(body.headers) ? body.headers.map((h) => redact(String(h), "name")) : [], responseHeaders, asked: n, rows, totalPages: tp !== null && tp >= 0 ? tp : null, currentPage: body.currentPage };
      };
      await go("the live search", async () => { liveTried = true; live = await page(1); });
      const tp = (live as LiveSearch | null)?.totalPages ?? null;
      if (live && tp !== null && tp >= 2) await go("the live search's last page", async () => { lastPage = await page(tp); });
    }
    // 4. One document.
    const pick = pickDocument([...((live as LiveSearch | null)?.rows ?? []), ...((lastPage as LiveSearch | null)?.rows ?? []), ...saved]);
    if (pick) await go("the document download", async () => {
      docTried = true;
      const res = await downloadDocument(api, pick.ref);
      const { bytes, cut } = await readCapped(res, DOC_MAX_BYTES);
      const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const isPdf = latin1(bytes.subarray(0, 8)).startsWith("%PDF");
      const name = res.headers.get("content-disposition") ?? "";
      const ext = name.match(/filename\*?=[^;]*?(\.[A-Za-z0-9]{1,5})["']?\s*(;|$)/)?.[1]?.toLowerCase() ?? null;
      doc = {
        type: /^[a-z]+\/[a-z0-9.+-]{1,60}$/.test(ct) ? ct : ct ? "an unusual type" : "none given", size: bytes.length, cut,
        headerNames: [...res.headers.keys()].map((k) => redact(k, "name")), named: /filename/i.test(name), ext,
        rowPages: pick.pages, isPdf, pdf: isPdf && !cut ? await pdfFacts(bytes, o.pdfBudgetMs ?? PDF_BUDGET_MS) : null,
      };
    });
    // 5. Any other list that isn't saved, while requests are left.
    for (const f of REFERENCE_FIELDS) {
      if (refs[f] || requests >= MAX_REQUESTS || stopped) continue;
      await go(`S&P's list of ${f}`, async () => { const r = await getReference(api, o.db, f, { now: o.now(), refresh: true }); if (r) { refs[f] = r; fetched.push(f); seen.rows(r.rows); } });
    }
  }
  const sp = { live: live as LiveSearch | null, lastPage: lastPage as LiveSearch | null, signin: signin as SignInShape, doc: doc as DocInfo | null };
  const why = (tried: boolean, what: string) => stopped ? say`Not reached: ${stopped}` : tried ? "S&P's answer couldn't be read." : `There was nothing to ${what}.`;

  // ----- signing in -----
  if (sp.signin) {
    const si = sp.signin;
    add({ id: "signin.expiry", group: "signin", title: "How long a token lasts (expires_in_seconds)", where: "lifetimeMs and keep in _shared/spgmi.ts",
      outcome: si.expiresType === "text of digits" || si.expiresType === "a number" ? "holds" : "differs",
      found: `It came back as ${si.expiresType}${si.expiresMinutes !== null ? `, about ${plural(si.expiresMinutes, "minute")}` : ""}. The sign-in answer's keys: ${list(si.keys.map(nm))}.`,
      verdict: si.expiresType === "text of digits" || si.expiresType === "a number" ? holds : "Differs: the app expects seconds as text (or a number). Without them it keeps the token until S&P turns it down, which still works but costs a refused request each time." });
    add({ id: "signin.refresh", group: "signin", title: "A refresh token with the sign-in", where: "keep and refresh in _shared/spgmi.ts",
      outcome: si.refreshType === "text" ? "holds" : "differs",
      found: si.refreshType === "text" ? "A refresh token came back, as text." : `No usable refresh token came back (${si.refreshType}).`,
      verdict: si.refreshType === "text" ? holds : "Differs: the app signs in in full each time the token runs out instead of refreshing. That works, at one sign-in an hour or so." });
  } else {
    for (const [id, title, where] of [["signin.expiry", "How long a token lasts (expires_in_seconds)", "lifetimeMs and keep in _shared/spgmi.ts"], ["signin.refresh", "A refresh token with the sign-in", "keep and refresh in _shared/spgmi.ts"]]) {
      add({ id, group: "signin", title, where, outcome: "unknown", found: why(signinTried, "sign in to"), verdict: "Couldn't tell: the sign-in wasn't seen." });
    }
  }

  // ----- reference lists -----
  const LIST_NAMES: Record<ReferenceField, string> = { typeOfInsurance: "Types of insurance", filingStatus: "Statuses", serffFilingState: "States", serffFilingType: "Filing types" };
  for (const f of REFERENCE_FIELDS) {
    const r = refs[f];
    const base = { id: `lists.${f}`, group: "lists" as const, title: `${LIST_NAMES[f]}: which column is the id and which the name`, where: "referenceOptions in _shared/filings.ts" };
    if (!r || !r.rows.length) { add({ ...base, outcome: "unknown", found: r ? "The saved list is empty." : why(false, "read: the list isn't saved and wasn't fetched"), verdict: "Couldn't tell: no list to look at." }); continue; }
    const { idCol, nameCol, best } = listColumns(r);
    const cols = r.headers.map((h) => nm(h));
    const idVals = idCol ? r.rows.map((x) => x[idCol]) : [];
    const dupIds = idVals.filter(filled).length - new Set(idVals.filter(filled).map(String)).size, emptyIds = idVals.filter((v) => !filled(v)).length;
    const ok = !!idCol && !!nameCol && idCol !== nameCol && !dupIds && !emptyIds && (!best || best === idCol);
    const idShape = describeColumn(idVals).shapes;
    add({ ...base, outcome: ok ? "holds" : "differs",
      found: say`${plural(r.rows.length, "row")}${r.fromStore ? " (saved)" : " (fetched now)"}. Columns: ${list(cols)}. The app takes ${idCol ? nm(idCol) : "no column"} as the id (${idShape}) and ${nameCol ? nm(nameCol) : "no column"} as the name.${best && best !== idCol ? ` The column that looks most like an id is ${nm(best)}.` : ""}`,
      verdict: ok ? holds : say`Differs: ${!idCol ? "the app found no id column" : dupIds ? `${plural(dupIds, "row repeats an id", "rows repeat an id")}, so only the first is kept` : emptyIds ? `${plural(emptyIds, "row has", "rows have")} no id` : best && best !== idCol ? "another column looks more like the id" : "the name column is the id column"}. Change referenceOptions to pick the right columns.` });
  }
  {
    const numeric: [ReferenceField, string][] = [["typeOfInsurance", "types of insurance"], ["filingStatus", "statuses"], ["serffFilingType", "filing types"]];
    const looked = numeric.filter(([f]) => refs[f]?.options.length);
    const textIds = looked.filter(([f]) => !refs[f]!.options.every((x) => isWhole(x.id)));
    const st = refs.serffFilingState?.options ?? [];
    const stateText = st.length && !st.every((x) => typeof x.id === "string" && /^[A-Za-z]{2}$/.test(x.id));
    add({ id: "lists.idTypes", group: "lists", title: "Ids are whole numbers; states are two-letter codes", where: "ints and the state check in parseSearch, _shared/filings.ts (and the state list in web/index.html, stateOptions)",
      outcome: !looked.length && !st.length ? "unknown" : textIds.length || stateText ? "differs" : "holds",
      found: !looked.length && !st.length ? "No list to look at." : `${looked.map(([f, n]) => `Ids of ${n}: ${describeColumn(refs[f]!.options.map((x) => x.id)).shapes}.`).join(" ")}${st.length ? ` State ids: ${describeColumn(st.map((x) => x.id)).shapes}.` : ""}`.trim(),
      verdict: !looked.length && !st.length ? "Couldn't tell: no list to look at." : textIds.length || stateText ? say`Differs: ${textIds.length ? `${list(textIds.map(([, n]) => n))} ids aren't whole numbers, so searches filtered by them are refused` : "state ids aren't two-letter codes, so the state list falls back to the built-in one"}. Change parseSearch to take them as S&P sends them.` : holds });
    if (st.length) {
      const codes = new Set(st.flatMap((x) => [String(x.id).trim().toUpperCase(), String(x.name).trim().toUpperCase()]));
      const missing = US_STATES.filter((c) => !codes.has(c)), extra = TERRITORIES.filter((c) => codes.has(c));
      const others = st.length - (US_STATES.length - missing.length) - extra.length;
      const fl = codes.has("FL") || [...codes].some((c) => c === "FLORIDA");
      add({ id: "lists.florida", group: "lists", title: "Florida, and the 50 states and DC, in S&P's state list", where: "the first live search (README); stateOptions in web/index.html",
        outcome: fl ? "holds" : "differs",
        found: `${plural(st.length, "state")} in the list. ${missing.length ? `Missing of the 50 states and DC: ${missing.join(", ")}.` : "All 50 states and DC are there."}${extra.length ? ` Also: ${extra.join(", ")}.` : ""}${others > 0 ? ` ${plural(others, "other entry", "other entries")}.` : ""}`,
        verdict: fl ? holds : "Differs: Florida isn't in S&P's list. Ask S&P whether the account covers Florida filings." });
    } else add({ id: "lists.florida", group: "lists", title: "Florida, and the 50 states and DC, in S&P's state list", where: "the first live search (README); stateOptions in web/index.html", outcome: "unknown", found: why(false, "read: the state list isn't saved"), verdict: "Couldn't tell: no state list." });
  }

  // ----- search results -----
  const liveRows = [...(sp.live?.rows ?? []), ...(sp.lastPage?.rows ?? [])];
  const all: Row[] = [...saved, ...liveRows];
  const searchWhy = (what: string) => why(liveTried, what);
  // Columns
  {
    const head = sp.live?.headers ?? [];
    const keys = head.length ? head : [...new Set(saved.flatMap((r) => Object.keys(r)).filter((k) => k !== "companies"))];
    if (!keys.length) add({ id: "search.columns", group: "search", title: "The result columns", where: "SEARCH_COLUMNS and mapRows in _shared/filings.ts", outcome: "unknown", found: searchWhy("search: no saved search and no live search"), verdict: "Couldn't tell: no results to look at." });
    else {
      const canon = new Map<string, string>(SEARCH_COLUMNS.map((c) => [c.toLowerCase(), c]));
      const missing = SEARCH_COLUMNS.filter((c) => !keys.some((k) => k.toLowerCase() === c.toLowerCase()));
      const extra = keys.filter((k) => !canon.has(k.toLowerCase()));
      const cased = keys.filter((k) => canon.has(k.toLowerCase()) && canon.get(k.toLowerCase()) !== k);
      add({ id: "search.columns", group: "search", title: "The result columns", where: "SEARCH_COLUMNS and mapRows in _shared/filings.ts",
        outcome: missing.length || extra.length ? "differs" : "holds",
        found: say`${plural(keys.length, "column")} ${head.length ? "in the live answer" : "in saved results"}.${missing.length ? ` Not there: ${list(missing)}.` : " Every column the app reads is there."}${extra.length ? ` Not known to the app: ${list(extra.map((k) => nm(k)))}.` : ""}${cased.length ? ` ${plural(cased.length, "column differs", "columns differ")} only in letter case, which the app handles.` : ""}`,
        verdict: missing.length || extra.length ? say`Differs: ${missing.length ? `the app reads ${plural(missing.length, "column")} S&P didn't send, shown as n/d` : "S&P sends columns the app doesn't show"}. Update SEARCH_COLUMNS.` : holds });
    }
  }
  // Paging fields
  if (sp.live) {
    const want = ["numCols", "numRows", "currentPageSize", "currentPage", "totalPages", "headers", "rows"];
    const has = want.filter((k) => sp.live!.keys.includes(k));
    const paging = ["currentPage", "totalPages"].every((k) => has.includes(k));
    add({ id: "search.paging", group: "search", title: "Paging fields in the answer (totalPages and so on)", where: "searchFilings in _shared/filings.ts",
      outcome: paging ? "holds" : "differs",
      found: `Top-level keys: ${list(sp.live.keys.map(nm))}. ${paging ? `totalPages came back as ${sp.live.totalPages === null ? "something that isn't a number" : `${fmt(sp.live.totalPages)}`}.` : "No totalPages or currentPage."}`,
      verdict: paging ? holds : "Differs: without totalPages the app asks for another page whenever a page comes back full. That works, at one extra request for a search whose last page is exactly full." });
  } else add({ id: "search.paging", group: "search", title: "Paging fields in the answer (totalPages and so on)", where: "searchFilings in _shared/filings.ts", outcome: "unknown", found: searchWhy("search: no company to search for"), verdict: "Couldn't tell: no live search." });
  // Pages numbered from 1
  {
    const base = { id: "search.pageBase", group: "search" as const, title: "Pages of results are numbered from 1", where: "the page loop (let page = 1) in searchFilings, _shared/filings.ts" };
    const L = sp.live;
    if (!L) add({ ...base, outcome: "unknown", found: searchWhy("search"), verdict: "Couldn't tell: no live search." });
    else if (L.totalPages === 1 && L.rows.length > 0) add({ ...base, outcome: "holds", found: `Asked for page 1 of ${LIVE_PAGE_SIZE} rows: ${plural(L.rows.length, "row")} came back and S&P said there is 1 page. Numbered from 0, page 1 would have been empty.` });
    else if (L.totalPages !== null && L.totalPages >= 2 && sp.lastPage) {
      const P = sp.lastPage, firstKeys = new Set(L.rows.map((r) => JSON.stringify(r)));
      const repeats = P.rows.filter((r) => firstKeys.has(JSON.stringify(r))).length;
      const ok = P.rows.length > 0 && P.rows.length <= LIVE_PAGE_SIZE && !repeats;
      add({ ...base, outcome: ok ? "holds" : "differs",
        found: `S&P said ${fmt(L.totalPages)} pages of ${LIVE_PAGE_SIZE}. Page 1 had ${plural(L.rows.length, "row")}; page ${fmt(L.totalPages)}, the last if pages start at 1, had ${plural(P.rows.length, "row")}${repeats ? `, ${fmt(repeats)} of them the same as on page 1` : ""}.${typeof L.currentPage === "number" ? ` For page 1, currentPage said ${fmt(L.currentPage)}.` : ""}`,
        verdict: ok ? holds : P.rows.length ? "Differs: the pages overlap. Look at how S&P pages before changing the page loop." : "Differs: the last page by S&P's count came back empty, which means pages start at 0. Start the page loop at 0 and stop at totalPages - 1, or every search misses its first page." });
    } else if (L.totalPages !== null && L.totalPages >= 2) add({ ...base, outcome: "unknown", found: `S&P said ${fmt(L.totalPages)} pages; the last page wasn't asked for.`, verdict: say`Couldn't tell: ${stopped ?? "the last page wasn't fetched"}` });
    else add({ ...base, outcome: "unknown", found: L.rows.length ? `${plural(L.rows.length, "row")} came back, with ${L.totalPages === null ? "no page count" : "a page count of 0"}.` : "The live search came back empty.", verdict: L.rows.length ? "Couldn't tell without S&P's page count." : "Couldn't tell: S&P returned nothing for the live search, so there was nothing to page through." });
  }
  // Dates
  {
    const looked = DATE_COLUMNS.filter((c) => all.some((r) => filled(r[c])));
    const bad = looked.filter((c) => !all.every((r) => !filled(r[c]) || /^YYYY-MM-DD/.test(redact(r[c]))));
    add({ id: "search.dates", group: "search", title: "Dates look like 2026-01-31", where: "the newest-first sort in searchFilings (_shared/filings.ts), dateOf in _shared/profile.ts, parseDay in web/index.html",
      outcome: !looked.length ? "unknown" : bad.length ? "differs" : "holds",
      found: looked.length ? looked.map((c) => `${c}: ${describeColumn(all.map((r) => r[c])).shapes}.`).join(" ") : (all.length ? "Every date column was empty." : searchWhy("search")),
      verdict: !looked.length ? "Couldn't tell: no dates to look at." : bad.length ? say`Differs: ${list(bad)} ${bad.length === 1 ? "isn't" : "aren't"} always YYYY-MM-DD. The page reads M/D/YYYY too, but the newest-first sort and the profile's dates need YYYY-MM-DD; convert them in mapRows.` : holds });
  }
  // Rate impact
  {
    const both = all.map((r) => ({ o: numOf(r.overallRateImpact), d: dispNumber(r.dispOverallRateImpact) })).filter((x) => x.o !== null && x.d !== null) as { o: number; d: number }[];
    const nonzero = both.filter((x) => Math.abs(x.o) > 1e-9 || Math.abs(x.d) > 1e-9);
    const equal = nonzero.filter((x) => Math.abs(x.o - x.d) <= 0.051).length, hundred = nonzero.filter((x) => Math.abs(x.o * 100 - x.d) <= 0.06 && !(Math.abs(x.o - x.d) <= 0.051)).length;
    const onlyOverall = all.filter((r) => numOf(r.overallRateImpact) !== null && !filled(r.dispOverallRateImpact)).length;
    const nums = all.map((r) => numOf(r.overallRateImpact)).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const dispShape = describeColumn(all.map((r) => r.dispOverallRateImpact)).shapes, overShape = describeColumn(all.map((r) => r.overallRateImpact)).shapes;
    const outcome: Outcome = !nonzero.length ? "unknown" : equal >= 0.9 * nonzero.length ? "holds" : "differs";
    add({ id: "search.rateImpact", group: "search", title: "Rate impact: overallRateImpact is in percentage points, like the display value", where: "rateImpact and the rate sort in web/index.html; rateImpactOf in _shared/profile.ts",
      outcome,
      found: all.length ? say`overallRateImpact: ${overShape}${nums.length ? ` (lowest ${dp3(nums[0])}, median ${dp3(quantile(nums, 0.5))}, highest ${dp3(nums[nums.length - 1])})` : ""}. dispOverallRateImpact: ${dispShape}. Of ${plural(nonzero.length, "row")} with both and not zero, ${fmt(equal)} have the same number, ${fmt(hundred)} have the display value 100 times overallRateImpact. ${plural(onlyOverall, "row has", "rows have")} overallRateImpact with no display value.` : searchWhy("search"),
      verdict: outcome === "holds" ? holds : outcome === "unknown" ? "Couldn't tell: no row has both a rate impact and a display value." : hundred >= 0.9 * nonzero.length ? "Differs: overallRateImpact is a fraction (0.045 for 4.5%). Multiply it by 100 where it is shown without the display value and in the rate sort." : "Differs: the two don't match in a simple way. Show only the display value until S&P explains the difference." });
  }
  // One filing version on several rows
  {
    const groups = new Map<string, Row[]>();
    for (const r of liveRows) if (filled(r.filingVersionId)) { const k = String(r.filingVersionId); groups.set(k, [...(groups.get(k) ?? []), r]); }
    const multi = [...groups.values()].filter((g) => g.length > 1);
    const differing = new Set<string>();
    for (const g of multi) for (const col of new Set(g.flatMap((r) => Object.keys(r)))) if (new Set(g.map((r) => JSON.stringify(r[col] ?? null))).size > 1) differing.add(col);
    const nonCompany = [...differing].filter((c) => !COMPANY_COLUMNS.has(c));
    const savedMulti = saved.filter((r) => Array.isArray((r as { companies?: unknown }).companies) && ((r as unknown as { companies: unknown[] }).companies.length > 1)).length;
    add({ id: "search.versions", group: "search", title: "Rows that share a filingVersionId differ only by company", where: "dedupe in _shared/filings.ts",
      outcome: multi.length ? (nonCompany.length ? "differs" : "holds") : "unknown",
      found: say`${liveRows.length ? `In the live search, ${fmt(multi.reduce((n, g) => n + g.length, 0))} of ${plural(liveRows.length, "row")} share a filingVersionId with another row${multi.length ? `; between them these columns differ: ${list([...differing].sort().map((c) => nm(c))) || "none"}` : ""}.` : "No live rows."} ${saved.length ? `In saved results, ${fmt(savedMulti)} of ${plural(saved.length, "filing")} (${share(savedMulti, saved.length)}) name more than one company.` : ""}`.trim(),
      verdict: !multi.length ? "Couldn't tell: no two live rows shared a filingVersionId." : nonCompany.length ? say`Differs: ${list(nonCompany.map((c) => nm(c)))} also differ${nonCompany.length === 1 ? "s" : ""}, and dedupe keeps only the first row's. Keep one filing per filingVersionId and state, or list the differing values.` : holds });
  }
  // The shape of filingVersionId and documentId
  {
    const fv = all.map((r) => r.filingVersionId).filter(filled), dc = all.map((r) => r.documentId).filter(filled);
    const fvOk = fv.filter((v) => parseDocRef({ filingVersionId: v }) !== null).length, dcOk = dc.filter((v) => parseDocRef({ documentId: v }) !== null).length;
    add({ id: "search.ids", group: "search", title: "What filingVersionId and documentId look like", where: "parseDocRef in _shared/filings.ts",
      outcome: !fv.length && !dc.length ? "unknown" : fvOk === fv.length && dcOk === dc.length ? "holds" : "differs",
      found: all.length ? say`filingVersionId on ${share(fv.length, all.length)} of rows: ${describeColumn(fv).shapes}. documentId on ${share(dc.length, all.length)}: ${describeColumn(dc).shapes}. The app accepts ${fmt(fvOk)} of ${fmt(fv.length)} filingVersionIds and ${fmt(dcOk)} of ${fmt(dc.length)} documentIds.` : searchWhy("search"),
      verdict: !fv.length && !dc.length ? "Couldn't tell: no ids to look at." : fvOk === fv.length && dcOk === dc.length ? holds : "Differs: some ids wouldn't open their document. Widen the patterns in parseDocRef." });
  }
  // pages
  {
    const p = all.map((r) => numOf(r.pages)).filter((x): x is number => x !== null).sort((a, b) => a - b);
    add({ id: "search.pages", group: "search", title: "The pages column", where: "read in _shared/chat.ts (Claude's page limits); LIMITS.docPages",
      outcome: all.length ? "info" : "unknown",
      found: all.length ? (p.length ? `On ${share(p.length, all.length)} of rows. Lowest ${fmt(p[0])}, median ${fmt(quantile(p, 0.5))}, 90th percentile ${fmt(quantile(p, 0.9))}, highest ${fmt(p[p.length - 1])}. Over 100 pages: ${share(p.filter((x) => x > 100).length, p.length)}; over 600: ${share(p.filter((x) => x > 600).length, p.length)}.` : "Empty on every row.") : searchWhy("search"),
      verdict: all.length ? "For the record. Whether it is the document's page count is checked under the document below." : "Couldn't tell: no results." });
  }
  // Rows per company per year
  {
    const counts: number[] = [];
    for (const rows of savedPerSearch) {
      const m = new Map<string, number>();
      for (const r of rows) {
        const year = String(r.publishDate ?? "").slice(0, 4);
        const cos = Array.isArray((r as { companies?: unknown }).companies) ? (r as unknown as { companies: Record<string, unknown>[] }).companies : [r];
        for (const c of cos) { const k = `${c.companyId ?? ""}|${c.institutionId ?? ""}|${year}`; m.set(k, (m.get(k) ?? 0) + 1); }
      }
      counts.push(...m.values());
    }
    counts.sort((a, b) => a - b);
    add({ id: "search.perCompanyYear", group: "search", title: "Filings per company per year", where: "PAGE_SIZE and MAX_SEARCH_REQUESTS in _shared/filings.ts",
      outcome: counts.length ? "info" : "unknown",
      found: counts.length ? `Across ${plural(counts.length, "company-year")} in saved results: median ${fmt(quantile(counts, 0.5))}, 90th percentile ${fmt(quantile(counts, 0.9))}, highest ${fmt(counts[counts.length - 1])}. A search asks for 500 rows a page.` : "No saved searches to count.",
      verdict: counts.length ? "For the record." : "Couldn't tell: no saved searches." });
  }
  // Company identifiers in results, against the company list
  {
    const rows = all;
    const cnt = (c: string) => rows.filter((r) => filled(r[c])).length;
    const instWhole = rows.filter((r) => filled(r.institutionId)).every((r) => isWhole(r.institutionId)), coWhole = rows.filter((r) => filled(r.companyId)).every((r) => isWhole(r.companyId));
    const statOk = rows.filter((r) => filled(r.spStatEntityId)).every((r) => /^[A-Za-z0-9-]{1,20}$/.test(String(r.spStatEntityId)));
    const topMask = (vals: unknown[]) => describeColumn(vals.filter(filled)).shapes.split("; ")[0]?.replace(/ \([\d.]+%\)$/, "") ?? "";
    const dirStat = directory.map((d) => d.spStatEntityId).filter(filled), resStat = rows.map((r) => r.spStatEntityId).filter(filled);
    const alike = dirStat.length && resStat.length ? topMask(dirStat) === topMask(resStat) : null;
    const dirInst = new Set(directory.map((d) => String(d.institutionId ?? "")).filter(Boolean));
    const resInst = [...new Set(rows.map((r) => String(r.institutionId ?? "")).filter(Boolean))];
    const inDir = resInst.filter((i) => dirInst.has(i)).length;
    const coShare = rows.length ? cnt("companyId") / rows.length : 0;
    const ok = rows.length > 0 && instWhole && coWhole && statOk && coShare >= 0.99;
    add({ id: "search.companyIds", group: "search", title: "Company ids in results: companyId, institutionId, NAIC code and statutory key", where: "entitiesFrom (companies are remembered by companyId) and the byCompany count in searchFilings, _shared/filings.ts; spStatEntityIds in parseSearch",
      outcome: rows.length ? (ok ? "holds" : "differs") : "unknown",
      found: rows.length ? say`Filled on: companyId ${share(cnt("companyId"), rows.length)}, institutionId ${share(cnt("institutionId"), rows.length)}, naicCompanyCode ${share(cnt("naicCompanyCode"), rows.length)}, spStatEntityId ${share(cnt("spStatEntityId"), rows.length)}. companyId ${coWhole ? "is" : "isn't"} always a whole number; institutionId ${instWhole ? "is" : "isn't"}. spStatEntityId: ${describeColumn(resStat).shapes || "none"}${alike === null ? "" : alike ? "; it looks like the statutory keys in the company list" : `; it doesn't look like the company list's statutory keys (${describeColumn(dirStat).shapes})`}. ${dirInst.size ? `${fmt(inDir)} of ${plural(resInst.length, "institution id")} in results are in the company list.` : ""}`.trim() : searchWhy("search"),
      verdict: !rows.length ? "Couldn't tell: no results." : ok ? holds : say`Differs: ${coShare < 0.99 ? `companyId is empty on ${share(rows.length - cnt("companyId"), rows.length)} of rows, so entitiesFrom doesn't remember those companies (it keys them by companyId); key them by institutionId too` : !instWhole || !coWhole ? "an id isn't a whole number, so the byCompany count compares text; compare as numbers" : "some statutory keys wouldn't pass parseSearch's pattern"}.` });
  }
  // Limit figures S&P sends with an answer
  if (sp.live?.responseHeaders.length) add({ id: "search.limits", group: "search", title: "Limit figures S&P sends with an answer", where: "makeGate in _shared/spgmi.ts", outcome: "info",
    found: `${list(sp.live.responseHeaders.map(([k, v]) => `${nm(k)}: ${seen.has(v) ? "[removed]" : v}`))}.`, verdict: "For the record: these may say how S&P counts requests." });

  // ----- the document -----
  {
    const D = sp.doc;
    const dwhy = docTried ? why(true, "") : stopped ? why(false, "") : "No row had a document to download.";
    if (!D) {
      add({ id: "doc.type", group: "document", title: "What a document download is", where: "the document action in snl-filings/index.ts; read in _shared/chat.ts", outcome: "unknown", found: dwhy, verdict: "Couldn't tell: no document." });
      add({ id: "doc.pages", group: "document", title: "The pages column is the document's page count", where: "read in _shared/chat.ts (it takes the larger of the two)", outcome: "unknown", found: dwhy, verdict: "Couldn't tell: no document." });
    } else {
      const pdfType = D.type === "application/pdf";
      add({ id: "doc.type", group: "document", title: "What a document download is", where: "the document action in snl-filings/index.ts; read in _shared/chat.ts",
        outcome: pdfType && D.isPdf ? "holds" : "differs",
        found: say`Content type ${D.type}; ${D.size >= 1048576 ? `${oneDp(D.size / 1048576)} MB` : `${fmt(Math.max(1, D.size / 1024))} KB`}${D.cut ? " (stopped reading at 40 MB)" : ""}; ${D.isPdf ? "the file is a PDF" : "the file isn't a PDF"}. ${D.named ? `A file name came with it${D.ext ? `, ending ${D.ext}` : ""}.` : "No file name came with it."} Answer headers: ${list(D.headerNames.map(nm))}.`,
        verdict: pdfType && D.isPdf ? holds : "Differs: the app expects PDFs. Claude reads PDFs and plain text only; anything else opens from the Filings view." });
      const own = D.pdf?.counted ?? null, tree = D.pdf?.treePages ?? null, counted = own ?? tree, row = D.rowPages;
      add({ id: "doc.pages", group: "document", title: "The pages column is the document's page count", where: "read in _shared/chat.ts (it takes the larger of the two); countPdfPages in _shared/chat.ts",
        outcome: counted === null || row === null ? "unknown" : counted === row ? "holds" : "differs",
        found: `The row said ${row === null ? "nothing" : plural(row, "page")}; the file has ${counted === null ? "a page count this check couldn't read" : plural(counted, "page")}${own === null && tree !== null ? ", by its page tree. The app's own count (countPdfPages) found none, because the pages are packed in compressed object streams, so the app relies on the pages column for this kind of file" : tree !== null && tree !== own ? ` by the app's own count, ${plural(tree, "page")} by its page tree` : ""}.`,
        verdict: counted === null || row === null ? "Couldn't tell: one of the two counts is missing." : counted === row ? holds : `Differs by ${plural(Math.abs(counted - row), "page")}. The app already uses the larger number for Claude's limits; say what pages means before relying on it elsewhere.` });
      if (D.pdf) {
        const P = D.pdf;
        add({ id: "doc.text", group: "document", title: "Whether the PDF has text Claude can read", where: "read in _shared/chat.ts", outcome: "info",
          found: P.encrypted ? "The PDF is encrypted, so its text couldn't be looked at." : `Text is drawn on ${fmt(P.textPages)} of the ${plural(P.pagesRead, "page")} read, and readable as letters on ${fmt(P.readablePages)}.${P.stoppedEarly ? ` Reading stopped after ${plural(P.pagesRead, "page")} to stay inside the time a function may use.` : ""} Reading it took about ${fmt(P.ms)} ms.`,
          verdict: P.textPages ? "For the record: a text layer is there." : "For the record: no text layer, so Claude reads the page images only." });
        const hit = P.headings.filter((h) => h.pages.length);
        add({ id: "doc.sections", group: "document", title: "SERFF section headings and the pages they are on", where: "document prompt text in _shared/chat.ts", outcome: "info",
          found: P.readablePages ? `${hit.length ? list(hit.map((h) => `${h.name} on page ${h.pages.join(", ")}`)) : "None of the standard headings were found"}. Not found: ${list(P.headings.filter((h) => !h.pages.length).map((h) => h.name)) || "none"}.` : "No readable text, so headings couldn't be looked for.",
          verdict: "For the record." });
      }
    }
  }

  // ----- the company list -----
  {
    const n = directory.length;
    const c = (k: keyof EntityFields) => directory.filter((d) => filled(d[k])).length;
    const groups = new Map<string, number>();
    for (const d of directory) { const g = d.naicGroupName ?? d.naicGroupCode; if (filled(g)) groups.set(String(g).trim().toLowerCase(), (groups.get(String(g).trim().toLowerCase()) ?? 0) + 1); }
    const sizes = [...groups.values()].sort((a, b) => b - a);
    const searchable = directory.filter((d) => filled(d.companyId) || filled(d.institutionId)).length;
    add({ id: "dir.counts", group: "directory", title: "What the company list holds", where: "scripts/companies-lib.mjs; resolveEntity and resolveMany in _shared/filings.ts", outcome: n ? "info" : "unknown",
      found: n ? `${plural(n, "company", "companies")}. With a company id ${fmt(c("companyId"))}, an institution id ${fmt(c("institutionId"))}, a statutory key ${fmt(c("spStatEntityId"))}, a NAIC company code ${fmt(c("naicCompanyCode"))}, a group code ${fmt(c("naicGroupCode"))}, a group name ${fmt(c("naicGroupName"))}. ${fmt(searchable)} can be searched for filings. ${plural(sizes.length, "group")}; the largest have ${list(sizes.slice(0, 5).map(fmt))} companies; ${fmt(sizes.filter((x) => x > 50).length)} have more than 50.` : "The company list is empty, or this database can't list it.",
      verdict: n ? "For the record." : "Couldn't tell: no company list." });
  }

  // ----- the summary -----
  const counts: Record<Outcome, number> = { holds: 0, differs: 0, unknown: 0, info: 0 };
  for (const f of findings) counts[f.outcome]++;
  const checked = counts.holds + counts.differs;
  const summary = !configured ? DIAGNOSE_NOT_CONFIGURED
    : `${fmt(counts.holds)} of ${plural(checked, "assumption")} checked ${counts.holds === 1 ? "holds" : "hold"}; ${fmt(counts.differs)} ${counts.differs === 1 ? "differs" : "differ"}.${counts.unknown ? ` ${fmt(counts.unknown)} couldn't be checked this time.` : ""}`;
  const columnsSeen = [...new Set([...SEARCH_COLUMNS, ...all.flatMap((r) => Object.keys(r))])].filter((k) => k !== "companies");
  const columns: ColumnShape[] = all.length ? columnsSeen.map((k) => ({ name: say`${nm(k)}`, ...describeColumn(all.map((r) => r[k] ?? null)) })) : [];
  const basis = [
    searches.length ? `${plural(savedPerSearch.length, "saved search", "saved searches")} (${plural(saved.length, "row")})` : "no saved searches",
    sp.live ? `${plural(liveRows.length, "row")} from one live search` : "no live search",
    `${plural(directory.length, "company", "companies")} in the company list`,
    sp.doc ? "one document" : "no document",
  ];
  const used = await o.db.usage();
  return {
    configured, ranAt: new Date(started).toISOString(), account: o.plan, limits: { hour: o.limits.hour, day: o.limits.day }, used,
    requests, maxRequests: MAX_REQUESTS, seconds: Math.round((o.now() - started) / 1000), stopped, basis: `Based on ${list(basis)}.${fetched.length ? ` ${plural(fetched.length, "reference list was", "reference lists were")} fetched and saved, as the connection check does.` : ""}`,
    summary, counts, findings, columns, notCovered: NOT_COVERED,
  };
}

/** The display value as a number of percentage points: "4.5%", "(4.5%)" (negative), "-4.5", 4.5. */
function dispNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim(), neg = /^\(.*\)$/.test(s), m = s.replace(/[()%\s+]/g, "").match(/^-?\d+(\.\d+)?$/);
  return m ? Number(m[0]) * (neg ? -1 : 1) : null;
}

/** Which header holds the ids the app took (the options' ids), which the names, and which looks most like an id:
    unique, always filled, whole numbers or short codes. Found from the data, so it follows referenceOptions. */
function listColumns(r: Reference): { idCol: string | null; nameCol: string | null; best: string | null } {
  const ids = new Set(r.options.map((x) => String(x.id))), names = new Set(r.options.map((x) => x.name));
  const vals = (h: string) => r.rows.map((x) => x[h]);
  const idCol = r.headers.find((h) => { const v = vals(h).filter(filled).map(String); return v.length > 0 && v.every((x) => ids.has(x)) && new Set(v).size === ids.size; }) ?? null;
  const nameCol = r.headers.find((h) => h !== idCol && vals(h).filter(filled).every((x) => names.has(String(x)))) ?? (idCol && r.options.every((x) => String(x.id) === x.name) ? idCol : null);
  const idLike = (h: string) => { const v = vals(h); return v.every(filled) && new Set(v.map(String)).size === v.length && v.every((x) => isWhole(x) || (typeof x === "string" && /^[A-Za-z0-9]{1,6}$/.test(x))); };
  const best = r.headers.find((h) => idLike(h) && /(id|code)$/i.test(h)) ?? r.headers.find(idLike) ?? null;
  return { idCol, nameCol, best };
}

/** The live search: the company with the most filings in the most recent saved search, its states, statuses and
    dates (at most 364 days); or, with no saved search, a company from the list, every state and status in S&P's
    lists and the last 364 days. Null when there is nothing to search. */
function livePlan(searches: StoreRow[], directory: EntityFields[], refs: Partial<Record<ReferenceField, Reference>>, now: number): Record<string, unknown> | null {
  const DAY = 86_400_000, ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const statusIds = (refs.filingStatus?.options ?? []).map((x) => x.id).filter(isWhole).map(Number);
  const stateIds = (refs.serffFilingState?.options ?? []).map((x) => String(x.id).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));
  for (const s of searches) {
    const d = s.doc as { params?: Record<string, unknown>; byCompany?: { kind: string; id: number; rows: number }[] };
    const p = d.params;
    if (!p) continue;
    const by = [...(d.byCompany ?? [])].filter((b) => isWhole(b.id)).sort((a, b) => b.rows - a.rows)[0];
    const co: Record<string, number[]> | null = by ? { [by.kind === "institutionId" ? "institutionId" : "companyId"]: [Number(by.id)] }
      : Array.isArray(p.companyIds) && p.companyIds.length ? { companyId: [Number(p.companyIds[0])] } : Array.isArray(p.institutionIds) && p.institutionIds.length ? { institutionId: [Number(p.institutionIds[0])] } : null;
    const states = Array.isArray(p.states) ? p.states.map(String).filter((x) => /^[A-Z]{2}$/.test(x)) : [];
    const statuses = Array.isArray(p.filingStatusIds) && p.filingStatusIds.length ? p.filingStatusIds.map(Number) : statusIds;
    const to = typeof p.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.to) ? p.to : ymd(now);
    const from0 = typeof p.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.from) ? p.from : ymd(Date.parse(to) - 364 * DAY);
    const from = from0 < ymd(Date.parse(to) - 364 * DAY) ? ymd(Date.parse(to) - 364 * DAY) : from0;
    if (co && Object.values(co)[0].every((x) => Number.isInteger(x) && x >= 0) && states.length && statuses.length) return { ...co, minPublishDate: from, maxPublishDate: to, serffFilingStateId: states, filingStatusId: statuses };
  }
  const e = directory.find((x) => isWhole(x.institutionId)) ?? directory.find((x) => isWhole(x.companyId));
  if (!e || !statusIds.length) return null;
  const co = isWhole(e.institutionId) ? { institutionId: [Number(e.institutionId)] } : { companyId: [Number(e.companyId)] };
  return { ...co, minPublishDate: ymd(now - 365 * DAY), maxPublishDate: ymd(now - DAY), serffFilingStateId: stateIds.length ? stateIds : US_STATES, filingStatusId: statusIds };
}

/** A document to download: one with a page count near 30 (a whole SERFF filing, but not a huge one), from the
    live rows first. */
function pickDocument(rows: Row[]): { ref: DocRef; pages: number | null } | null {
  let best: { ref: DocRef; pages: number | null; score: number } | null = null;
  for (const r of rows) {
    const ref = parseDocRef({ documentId: r.documentId ?? undefined }) ?? parseDocRef({ filingVersionId: r.filingVersionId ?? undefined });
    if (!ref) continue;
    const pages = numOf(r.pages);
    const score = pages === null ? 1000 : pages < 3 || pages > 150 ? 500 + Math.abs(pages - 30) : Math.abs(pages - 30);
    if (!best || score < best.score) best = { ref, pages, score };
    if (score === 0) break;
  }
  return best ? { ref: best.ref, pages: best.pages } : null;
}
