// Earnings: for one company on the team's earnings watchlist and one quarter, find the quarter's results documents.
//   From SEC EDGAR: the 10-Q (10-K or 20-F for the fourth quarter), the first results 8-K after quarter end (item 2.02)
//   with its EX-99 exhibits, and for foreign filers the quarter's results 6-K.
//   From the company's investor-relations pages (a plain fetch, no browser): the financial supplement and the investor
//   presentation; a 10-Q PDF when one is posted; for London-listed names with no SEC filings, the interim or annual
//   report and the results release or trading update.
//
// The rules are ported from the owner's desktop script (earnings_downloader.py), where they were worked out by trial on
// real sites; each ported function names the one it comes from. The script drives a real browser, which a Supabase
// function cannot, so here an investor site that refuses plain requests, or fills its lists with JavaScript, is
// reported as exactly that, with the page's address. An empty result is never "no supplement exists".
//
// What is watched is the shared setting "earnings_watchlist" in public.snl_settings (migration 0001): every login reads
// it, Corp Dev edits it on the Earnings view. Every address in it, and every link found on a fetched page, is treated
// as hostile (safeFetch below). Results are saved in public.snl_store under kind "discover" (the kinds the table
// allows are fixed by migration 0001; "discover" is the one nothing lists or counts), ids "discover:earn.<...>".

import type { Db } from "./db.ts";
import type { Env } from "./http.ts";

export const WATCH_SETTING = "earnings_watchlist";
export const MAX_COMPANIES = 60;
export const MAX_IR_URLS = 6, MAX_TEMPLATES = 6, URL_MAX = 500, NAME_MAX = 80;
/** The script's own settings (BUILT_IN_CONFIG), unchanged. */
export const MAX_PAGES_PER_COMPANY = 14;
export const FOLLOW_KEYWORDS = "presentation|events|investor day|quarterly results|quarterly earnings|financial results|financial information|financials|results|reports";
export const NO_FOLLOW_KEYWORDS = "press-release|news-release|press release|/news/|email-alert|email alerts|rss|ir-calendar|investor-calendar|showevents=future|sec filings|sec-filings|governance|stock-info|stock info|news-and-events";
export type DocType = "10q" | "supplement" | "deck" | "report" | "release";
export const DOC_TYPES: Record<DocType, { keywords: string; keywords_q4?: string; exclude: string; extensions: string[]; pages?: boolean }> = {
  "10q": {
    keywords: String.raw`\b10-?q\b|form 10-?q|quarterly report on form`,
    keywords_q4: String.raw`\b10-?k\b|form 10-?k|annual report on form`,
    exclude: String.raw`transcript|presentation|slides|supplement|press release|earnings release|10-?[qk]/a\b|amendment`,
    extensions: [".pdf"],
  },
  supplement: {
    keywords: String.raw`supplement|supplemental|statistical|financial data|data ?book|fact ?book|financial information package`,
    exclude: String.raw`transcript|audio|replay|remarks|\bpresentations?\b|\bslides?\b|\bdeck\b|earnings release|press release|news release|10-k|10-q|annual report|proxy|sustainability|esg|tax|cookie|privacy|\d{10}-\d{2}-\d{6}`,
    extensions: [".pdf", ".xlsx", ".xls"],
  },
  deck: {
    keywords: String.raw`\bpresentations?\b|\bslides?\b|slide deck|investor deck|\bdeck\b|investor day`,
    exclude: String.raw`transcript|audio|replay|remarks|earnings release|press release|news release|supplement|trading statement|interim statement|interim report|financial statements|fact ?sheet|profile|ratings|contact the board|terms of use|responsibility|sustainability|esg|tax|pfic|proxy|10-k|10-q|annual report|cookie|privacy|succession|\d{10}-\d{2}-\d{6}|trading[\s_-]*update|results[\s_-]*for[\s_-]*the|six[\s_-]*months[\s_-]*ended|nine[\s_-]*months[\s_-]*ended`,
    extensions: [".pdf"],
  },
  report: {
    keywords: String.raw`annual[\s_-]*report|report[\s_-]*and[\s_-]*accounts|annual[\s_-]*accounts|interim[\s_-]*report|interim[\s_-]*statement|half[\s_-]*year[\s_-]*report|interim[\s_-]*consolidated|interim[\s_-]*financial`,
    exclude: String.raw`syndicate|sfcr|solvency|financial[\s_-]*condition|\bdac\b|debt|notice|agm|annual[\s_-]*general|proxy|sustainab|esg|tcfd|climate|remuneration|governance|presentation|slides|summary|subsidiar|pillar|slavery|gender|tax|transcript`,
    extensions: [".pdf"],
  },
  release: {
    keywords: String.raw`press[\s_-]*release|results[\s_-]*for|results[\s_-]*announcement|trading[\s_-]*statement|trading[\s_-]*update|management[\s_-]*statement|half[\s_-]*year[\s_-]*results|full[\s_-]*year[\s_-]*results|year[\s_-]*end[\s_-]*results|preliminary[\s_-]*results|interim[\s_-]*results|reports?[\s_-]*(?:first|second|third|fourth|half|full|interim|q[1-4])|preliminary[\s_-]*(?:financial[\s_-]*statements|announcement)`,
    exclude: String.raw`presentation|slides|deck|transcript|webcast|recording|listen|watch|annual[\s_-]*report|interim[\s_-]*report|report[\s_-]*and[\s_-]*accounts|sfcr|syndicate|notice|agm|annual[\s_-]*general|calendar|subscribe|alert|login|to[\s_-]*announce|will[\s_-]*announce|results[\s_-]*date|date[\s_-]*of|conference[\s_-]*call|register`,
    extensions: [".pdf"],
    pages: true,
  },
};
/** The script's columns: 10-Q (10-K), 8-K, supplement, presentation. */
export type Col = "10q" | "8k" | "supplement" | "deck";
export const COLS: Col[] = ["10q", "8k", "supplement", "deck"];
export const TYPE_NAMES: Record<string, string> = { "10q": "10-Q", "8k": "8-K", supplement: "Supplement", deck: "Presentation", report: "Report", release: "Release" };
/** London names (no SEC filings): the interim or annual report fills the 10-Q column, the results release or trading
    update the 8-K column (the script's NONSEC_COLUMN). */
export const NONSEC_COLUMN: Partial<Record<DocType, Col>> = { report: "10q", release: "8k" };
const FILE_HINTS = ["/static-files/", "/doc_presentations/", "/doc_presentation/", "/files/doc_"];
const YEAR_RE = /(?<!\d)(20[1-3]\d)(?!\d)/g;

// ---------- small ports of Python's standard library, so the script's rules behave the same ----------

/** urllib.parse.unquote: percent-decoding that leaves a broken sequence as it is (never throws). */
export function unquote(s: string): string {
  try { return decodeURIComponent(s); } catch { /* piece by piece below */ }
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
}
/** urllib.parse.urlparse, for the parts the script reads: netloc, path and query, from the text as it is (a URL object
    would encode spaces and change what the rules see). */
export function urlparse(u: string): { scheme: string; netloc: string; path: string; query: string } {
  const m = String(u).match(/^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/s);
  return m ? { scheme: (m[1] ?? "").toLowerCase(), netloc: m[2] ?? "", path: m[3] ?? "", query: m[4] ?? "" } : { scheme: "", netloc: "", path: "", query: "" };
}
/** pathlib's .name of a path (the last part, a trailing slash ignored). */
export function pyName(path: string): string { const parts = path.split("/").filter(Boolean); return parts.length ? parts[parts.length - 1] : ""; }
/** pathlib's .stem: the name without its last suffix (a name that starts with its only dot keeps it). */
export function pyStem(name: string): string { const i = name.lastIndexOf("."); return i > 0 ? name.slice(0, i) : name; }
/** pathlib's .suffix. */
export function pySuffix(name: string): string { const i = name.lastIndexOf("."); return i > 0 && i < name.length - 1 ? name.slice(i) : ""; }

// ---------- quarters (parse_quarter and the script's tables) ----------

export const QUARTER_END: Record<number, [number, number]> = { 1: [3, 31], 2: [6, 30], 3: [9, 30], 4: [12, 31] };
const ORD: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth" };
const RESULT_MONTHS: Record<number, [string[], number]> = { 1: [["apr", "may"], 0], 2: [["jul", "aug"], 0], 3: [["oct", "nov"], 0], 4: [["jan", "feb"], 1] };

/** parse_quarter: "3Q26", "Q3 2026", "q3-26", "2026Q3" -> {q: 3, y: 2026}; null when it can't be read. */
export function parseQuarter(text: unknown): { q: number; y: number } | null {
  if (typeof text !== "string" || text.length > 20) return null;
  const t = text.trim().toUpperCase().replace(/ /g, "").replace(/-/g, "");
  let m = t.match(/^([1-4])Q(\d{2}|\d{4})$/) ?? t.match(/^Q([1-4])(\d{2}|\d{4})$/), q: number, y: number;
  if (m) { q = Number(m[1]); y = Number(m[2]); }
  else {
    m = t.match(/^(\d{4})Q([1-4])$/);
    if (!m) return null;
    y = Number(m[1]); q = Number(m[2]);
  }
  return { q, y: y < 100 ? y + 2000 : y };
}
/** "3Q26", the script's quarter_name. */
export const quarterName = (q: number, y: number) => `${q}Q${String(y % 100).padStart(2, "0")}`;
export const quarterEnd = (q: number, y: number) => `${y}-${String(QUARTER_END[q][0]).padStart(2, "0")}-${QUARTER_END[q][1]}`;
/** The most recent quarter that has ended on the given day (UTC). */
export function lastEndedQuarter(now: number): { q: number; y: number } {
  const d = new Date(now), y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3);   // quarters fully ended this year
  return q === 0 ? { q: 4, y: y - 1 } : { q, y };
}
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

// ---------- quarter matching for investor-site files (quarter_tokens, matches_quarter, matches_quarter_loose) ----------

const SEP = String.raw`[\s_\-+.,/]*`, NB = String.raw`(?<![a-z0-9])`;
const tokenCache = new Map<string, RegExp>();
/** quarter_tokens: every way a file name or link text names this quarter. */
export function quarterTokens(q: number, y: number): RegExp {
  const key = `${q}/${y}`, hit = tokenCache.get(key);
  if (hit) return hit;
  const yy = String(y % 100).padStart(2, "0"), yr = String.raw`(?:20)?${yy}(?!\d)`;
  const pats = [`${NB}q${q}${SEP}${yr}`, `${NB}${q}q${SEP}${yr}`, `${NB}${y}${SEP}q${q}(?![0-9])`, `${NB}${y}${SEP}${q}q`,
    `${ORD[q]}${SEP}quarter${SEP}(?:of${SEP})?${y}`, `${NB}${y}/q${q}/`, `/${y}/q${q}/`];
  const [mon, day] = ({ 1: ["mar", 31], 2: ["jun", 30], 3: ["sep", 30], 4: ["dec", 31] } as Record<number, [string, number]>)[q];
  const mm = ({ 1: "03", 2: "06", 3: "09", 4: "12" } as Record<number, string>)[q];
  pats.push(`${NB}${day}(?:st|th)?${SEP}${mon}[a-z]*${SEP}${y}`, `(?<![a-z])${mon}[a-z]*${SEP}${day}(?:st|th)?${SEP}${y}`,   // period-end date
    String.raw`${NB}(?:20)?${yy}[-_.]?${mm}[-_.]?${day}(?!\d)`);                                                              // e.g. 26-06-30
  if (q === 2) pats.push(`${NB}h1${SEP}${yr}`, `${NB}${y}${SEP}h1`, `half${SEP}year[^0-9]{0,25}${y}`, `interim[^0-9]{0,25}${y}`, `six${SEP}months[^0-9]{0,30}${y}`, `${NB}hy${SEP}${yr}`);
  if (q === 3) pats.push(`nine${SEP}months[^0-9]{0,40}${y}`);
  if (q === 4) pats.push(`${NB}h2${SEP}${yr}`, `full${SEP}year${SEP}${y}`, `${NB}fy${SEP}${yr}`,
    String.raw`year${SEP}end(?:ed)?[^0-9]{0,25}(?:\d{1,2}[^0-9]{1,15})?${y}`,
    `preliminary${SEP}results[^0-9]{0,25}${y}`, `${NB}${y}${SEP}(?:fy|full${SEP}year)`,
    `annual${SEP}report[^0-9]{0,25}${y}`, `report${SEP}and${SEP}accounts[^0-9]{0,25}${y}`,
    `${NB}${y}${SEP}annual${SEP}report`);
  const re = new RegExp(pats.join("|"), "i");
  tokenCache.set(key, re);
  return re;
}
export const ANY_QUARTER = new RegExp(String.raw`(?<![a-z0-9])(?:q[1-4][\s_\-+.,/]*(?:20)?\d{2}(?!\d)|[1-4]q[\s_\-+.,/]*(?:20)?\d{2}(?!\d)|` +
  String.raw`20\d{2}[\s_\-+.,/]*q[1-4](?![0-9])|h[12][\s_\-+.,/]*(?:20)?\d{2}(?!\d)|` +
  String.raw`(?:first|second|third|fourth)[\s_\-]*quarter)`, "i");

/** matches_quarter: the quarter is named; or no quarter is named and the results month of this quarter, with its year,
    is (the script's RESULT_MONTHS: a third quarter's results come out in October or November). */
export function matchesQuarter(label: string, url: string, q: number, y: number): boolean {
  const hay = `${label} ${unquote(url)}`;
  if (quarterTokens(q, y).test(hay)) return true;
  if (ANY_QUARTER.test(hay)) return false;
  const [months, add] = RESULT_MONTHS[q];
  return new RegExp(String.raw`(?<![a-z])(?:${months.join("|")})[a-z]*[\s_\-.,]*(?:\d{1,2}(?:st|nd|rd|th)?[\s_\-.,]*)?${y + add}`, "i").test(hay);
}
const QWORD: Record<number, RegExp> = {
  1: /(?<![a-z0-9])q1(?![0-9])|first[\s_-]*quarter|three[\s_-]*months/i,
  2: /(?<![a-z0-9])(?:q2|h1|hy)(?![0-9])|half[\s_-]*year|interim|six[\s_-]*months/i,
  3: /(?<![a-z0-9])q3(?![0-9])|third[\s_-]*quarter|nine[\s_-]*months/i,
  4: /(?<![a-z0-9])(?:q4|h2|fy)(?![0-9])|full[\s_-]*year|year[\s_-]*end|preliminary|annual/i,
};
/** matches_quarter_loose: for London reports and releases, which often name the period loosely ("Q3 Trading Update"
    under a 2026 page): a word for this quarter, the year, and no other quarter's words. */
export function matchesQuarterLoose(label: string, url: string, q: number, y: number): boolean {
  if (matchesQuarter(label, url, q, y)) return true;
  const hay = `${label} ${unquote(url)}`.replace(/_/g, " ");
  if (!QWORD[q].test(hay) || !new RegExp(`(?<!\\d)${y}(?!\\d)`).test(hay)) return false;
  return ![1, 2, 3, 4].some((o) => o !== q && QWORD[o].test(hay));
}
/** too_old: the text names years and the latest is before min_year. */
export function tooOld(text: string, url: string, minYear: number): boolean {
  const years = [...`${text} ${unquote(url)}`.matchAll(YEAR_RE)].map((m) => Number(m[1]));
  return years.length > 0 && Math.max(...years) < minYear;
}

// ---------- links (link_ext, url_stem, clean_label, excl_hay, pick) ----------

/** link_ext: ".pdf", ".xlsx" or ".xls" from the address; "unknown" for a download link without one; null for a page. */
export function linkExt(url: string): string | null {
  const p = urlparse(url), path = unquote(p.path).toLowerCase();
  for (const ext of [".pdf", ".xlsx", ".xls"]) if (path.endsWith(ext)) return ext;
  if (FILE_HINTS.some((h) => path.includes(h)) || p.query.toLowerCase().includes("format=pdf")) return "unknown";
  return null;
}
const NOISE = /external_?link|\(?opens in (a )?new window\)?|open event link|,?\s*pdf file,?|download( as)? pdf|view now|\s+,/gi;
/** url_stem: the last meaningful part of an address ("news-details/2026/Some-results/default.aspx" -> "Some-results"). */
export function urlStem(href: string): string {
  const parts = unquote(urlparse(href).path).split("/").filter(Boolean);
  while (parts.length && /^(default|index)(\.\w+)?$/i.test(parts[parts.length - 1])) parts.pop();
  return parts.length ? pyStem(parts[parts.length - 1]).replace(/_/g, " ").replace(/\+/g, " ") : urlparse(href).netloc;
}
const stripChars = (s: string, chars: string) => { let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b); };
const words = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
/** clean_label: link text without "opens in a new window" and the like; a bare "Download" becomes the file's name, a
    short label gains it. */
export function cleanLabel(text: string, href: string): string {
  const stem = urlStem(href);
  const label = stripChars(words(words(text).replace(NOISE, " ")), " ,-");
  if (/^(download|view|open|pdf|file|here|click here|link)?$/i.test(label)) return stem;
  if (label.length < 12 || (!/\d/.test(label) && label.length < 25)) return `${label} ${stem}`;
  return label;
}
export const PRIORITY = /quarterly[ -]results|quarterly[ -]earnings|financial[ -]information|financial[ -]results|financial[ -]supplement|\/financials/i;
const CONTAINER = /^(?:(?=.*(result|event|report|investor|financial))(?=.*present).*|(?:press|news)?[-_ ]?releases?)$/i;

/** A link found on an investor page: the script's file dict. via: the label of the link that led to the page;
    generic: the link's own text said nothing ("Download"); page: a web page, not a file. */
export type Found = { url: string; label: string; via: string; generic: boolean; ext?: string | null; page?: boolean };
/** excl_hay: the text exclusion words are checked against: the link text and the address, minus folder names such as
    "Results_Report_Presentations" or "events-and-presentations" that only describe the section of the site. */
export function exclHay(f: Pick<Found, "url" | "label">): string {
  const u = urlparse(unquote(f.url));
  const segs = u.path.split("/").filter((x) => x && !CONTAINER.test(x));
  return `${f.label} ${u.netloc}/${segs.join("/")}?${u.query}`.replace(/_/g, " ");
}
/** pick: the investor-site files of one type for the quarter, {url: label}, in the order they were found. */
export function pick(files: Found[], dtype: DocType, q: number, y: number): Map<string, string> {
  const t = DOC_TYPES[dtype];
  const want = new RegExp(q === 4 && t.keywords_q4 ? t.keywords_q4 : t.keywords, "i"), skip = new RegExp(t.exclude, "i");
  const match = dtype in NONSEC_COLUMN ? matchesQuarterLoose : matchesQuarter;
  const out = new Map<string, string>();
  for (let f of files) {
    if (f.page) { if (!t.pages) continue; }
    else {
      const ext = f.ext || linkExt(f.url);
      if (![...t.extensions, "unknown"].includes(ext as string)) continue;
    }
    // The file's own name is the most reliable clue: a file named "...Investor-Presentation...pdf" is a deck even if
    // the link says "Presentation of Q2 2026 Press Release".
    const fname = pyName(unquote(urlparse(f.url).path)).replace(/_/g, " ");
    let ok: boolean;
    if (want.test(fname) && !skip.test(exclHay({ ...f, label: "" }))) ok = true;
    else if (skip.test(exclHay(f))) continue;
    else ok = want.test(exclHay(f));
    if (!ok && dtype === "deck" && f.generic && f.via && want.test(f.via) && !/presentations\b|[,&]|\band\b/i.test(f.via)) {   // not a section like "Reports, Presentations and Webinars"
      ok = true; f = { ...f, label: f.via };            // a bare "Download" link on a deck's own page
    }
    if (ok && match(f.label, f.url, q, y)) out.set(f.url, f.label);
  }
  return out;
}

// ---------- reading links out of a page (the script's plain-download route: BeautifulSoup over a[href]) ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", hellip: "..." };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const attr = (attrs: string, name: string) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
};
export const MAX_LINKS_PER_PAGE = 4000;
/** Every link on a page as [absolute address, text], as the script's get_text: the text inside the link, or its title
    or aria-label. Addresses other than http(s) are left out. Text is data: it is only ever matched and escaped. */
export function extractLinks(html: string, pageUrl: string): [string, string][] {
  const out: [string, string][] = [];
  const baseTag = html.match(/<base\b([^>]*)>/i), baseHref = baseTag ? attr(baseTag[1], "href") : null;
  let base = pageUrl;
  try { if (baseHref) base = new URL(baseHref, pageUrl).href; } catch { /* the page's own address */ }
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (let m: RegExpExecArray | null; (m = re.exec(html)) && out.length < MAX_LINKS_PER_PAGE;) {
    const href = attr(m[1], "href");
    if (!href) continue;
    let abs: string;
    try { abs = new URL(href.trim(), base).href; } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    let text = words(decodeEntities(m[2].replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")));
    if (!text) text = words(attr(m[1], "title") ?? attr(m[1], "aria-label") ?? "");
    out.push([abs, text.slice(0, 300)]);
  }
  return out;
}

// ---------- fetching other people's sites safely ----------

/** Why an address may not be fetched, or null when it may. https only, on the standard port, no user name or password;
    no IP-literal host; no localhost, .local, .internal or single-label host; nothing over URL_MAX characters. */
export function checkUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "there is no address";
  if (raw.length > URL_MAX) return `the address is longer than ${URL_MAX} characters`;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return "it isn't a web address"; }
  if (u.protocol !== "https:") return "only https addresses are fetched";
  if (u.username || u.password) return "the address carries a user name or password";
  if (u.port && u.port !== "443") return "the address names a port";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "the address has no site";
  if (host.startsWith("[") || host.includes(":") || /^[\d.]+$/.test(host)) return "the address is an IP number, not a site name";
  if (!host.includes(".")) return "the site name has no dot (a local name)";
  if (host === "localhost" || /\.(localhost|local|internal|intranet|lan|home\.arpa|corp)$/.test(host)) return "the site name is a local or reserved one";
  return null;
}
/** Whether an IP address (from DNS) is private, local or otherwise not on the public internet. */
export function privateIp(ip: string): boolean {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && Number(v4[3]) === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (!s.includes(":")) return true;   // not an address at all: refuse
  if (s === "::" || s === "::1") return true;
  if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s)) return true;
  if (s.startsWith("::ffff:")) { const h = s.slice(7).split(":"); if (h.length === 2) { const n = parseInt(h[0], 16); return privateIp(`${n >> 8}.${n & 255}.0.0`); } return true; }
  if (s.startsWith("64:ff9b:") || s.startsWith("2001:db8") || s.startsWith("100::")) return true;
  return false;
}
export type Resolve = (host: string) => Promise<string[]>;
/** The platform's DNS look-up. UNCONFIRMED whether Supabase's Edge Runtime offers Deno.resolveDns; without it each hop
    is still checked by name, and an empty answer lets the fetch go on (it fails by itself when the name doesn't exist). */
export const denoResolve: Resolve = async (host) => {
  const d = (globalThis as { Deno?: { resolveDns?: (h: string, t: string) => Promise<string[]> } }).Deno;
  if (!d?.resolveDns) return [];
  const [a, b] = await Promise.all([d.resolveDns(host, "A").catch(() => [] as string[]), d.resolveDns(host, "AAAA").catch(() => [] as string[])]);
  return [...a, ...b];
};
/** The browser the script presents itself as (its UA constant), for investor sites only. */
export const IR_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0";
export type FetchOpts = {
  fetch: typeof fetch; resolve?: Resolve; headers: Record<string, string>; timeoutMs: number;
  /** Hosts a hop may go to (the SEC client allows only the SEC's). */
  allowHost?: (host: string) => boolean; maxRedirects?: number;
};
export type Hop = { ok: true; res: Response; url: string; done: () => void } | { ok: false; kind: "blocked" | "failed" | "timeout"; url: string; reason: string };
export const MAX_REDIRECTS = 4;
/** One GET of an untrusted address. Redirects are followed here, at most MAX_REDIRECTS, each hop's address checked
    (checkUrl, the allowed hosts, and its DNS answer) before it is asked. Only the given headers are sent: no cookies,
    no keys. The time limit covers the whole exchange, body included, until done() is called. */
export async function safeFetch(url: string, o: FetchOpts): Promise<Hop> {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  const done = () => clearTimeout(timer);
  let at = url;
  try {
    for (let hop = 0; hop <= (o.maxRedirects ?? MAX_REDIRECTS); hop++) {
      const why = checkUrl(at);
      if (why) { done(); return { ok: false, kind: "blocked", url: at, reason: why }; }
      const host = new URL(at).hostname.toLowerCase().replace(/\.$/, "");
      if (o.allowHost && !o.allowHost(host)) { done(); return { ok: false, kind: "blocked", url: at, reason: "it leads to a site this request may not go to" }; }
      if (o.resolve) {
        const ips = await o.resolve(host).catch(() => [] as string[]);
        if (ips.some(privateIp)) { done(); return { ok: false, kind: "blocked", url: at, reason: "the site name leads to a private or local address" }; }
      }
      const res = await o.fetch(at, { method: "GET", headers: o.headers, redirect: "manual", signal: ctl.signal, credentials: "omit" } as RequestInit);
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        try { at = new URL(res.headers.get("location")!, at).href; } catch { done(); return { ok: false, kind: "failed", url: at, reason: "it redirects to an address that can't be read" }; }
        continue;
      }
      // from here the timer covers reading the body; a body never read must not hold the process open
      (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno?.unrefTimer?.(timer as unknown as number);
      return { ok: true, res, url: at, done };
    }
    done();
    return { ok: false, kind: "failed", url: at, reason: `it redirects more than ${o.maxRedirects ?? MAX_REDIRECTS} times` };
  } catch (e) {
    done();
    return ctl.signal.aborted ? { ok: false, kind: "timeout", url: at, reason: `it didn't answer within ${Math.max(1, Math.round(o.timeoutMs / 1000))} second${Math.max(1, Math.round(o.timeoutMs / 1000)) === 1 ? "" : "s"}` } : { ok: false, kind: "failed", url: at, reason: `it couldn't be reached (${String((e as Error)?.message ?? e).slice(0, 80)})` };
  }
}
/** Reads a body up to max bytes. null bytes when it is bigger (declared or found while reading). */
export async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array | null; tooBig: boolean }> {
  const said = res.headers.get("content-length"), declared = said && /^\d{1,15}$/.test(said.trim()) ? Number(said) : null;
  if (declared !== null && declared > max) { await res.body?.cancel().catch(() => {}); return { bytes: null, tooBig: true }; }
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), tooBig: false };
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); return { bytes: null, tooBig: true }; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return { bytes: out, tooBig: false };
}
/** file_ext: what a file is from its first bytes (a PDF, an Excel workbook, an old Excel file), if allowed. */
export function fileExt(head: Uint8Array, allowed = [".pdf", ".xlsx", ".xls"]): string | null {
  const is = (m: number[]) => m.every((b, i) => head[i] === b);
  if (is([0x25, 0x50, 0x44, 0x46]) && allowed.includes(".pdf")) return ".pdf";
  if (is([0x50, 0x4b, 0x03, 0x04]) && allowed.includes(".xlsx")) return ".xlsx";
  if (is([0xd0, 0xcf, 0x11, 0xe0]) && allowed.includes(".xls")) return ".xls";
  return null;
}
/** Statuses that mean a site turned an automated request away, rather than that the page is missing. */
const REFUSED = new Set([401, 403, 405, 406, 409, 418, 429, 451, 503, 999]);
const CHALLENGE = /cf-chl|challenge-platform|just a moment\.\.\.|attention required|captcha|access denied|request unsuccessful|incapsula|enable javascript and cookies|bot detection/i;

// ---------- the SEC (EDGAR) ----------

export const SEC_HOSTS = new Set(["www.sec.gov", "sec.gov", "data.sec.gov"]);
/** The SEC asks automated tools to say who they are: SEC_CONTACT names the organisation and a contact address. It is
    sent to the SEC and to no one else, and never to the page. null when it isn't set or isn't usable. */
export function secContact(env: Env): string | null {
  const v = (env("SEC_CONTACT") ?? "").trim();
  return v.length >= 6 && v.length <= 200 && /^[\x20-\x7e]+$/.test(v) && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(v) && /[A-Za-z]{2,}.*\s/.test(v) ? v : null;
}
export const NOT_SET_UP = "Earnings isn't set up yet: the owner sets SEC_CONTACT on Supabase (README, Earnings). Until then nothing is fetched from the SEC or investor sites.";
/** At most 5 requests a second to the SEC: one every 200 ms, across calls on the same server. */
export const SEC_GAP_MS = 200;
/** The script's patient retry (sec_get): when the SEC is busy (429 or 5xx) or doesn't answer, try again after 3, 8 and
    20 seconds. */
export const SEC_PAUSES = [0, 3_000, 8_000, 20_000];
const BUSY = new Set([429, 500, 502, 503, 504]);
let lastSec = -Infinity;
export const resetSecPacing = () => { lastSec = -Infinity; };
export class SecError extends Error { constructor(message: string, readonly kind: "busy" | "refused" | "missing" | "failed") { super(message); } }

export type SecDeps = { fetch: typeof fetch; contact: string; now: () => number; sleep: (ms: number) => Promise<void>; deadline: number; resolve?: Resolve; count: { n: number } };
/** One request to the SEC, paced and retried, its body not yet read (call done() when finished with it). Throws
    SecError. The contact goes in the User-Agent of SEC requests only: safeFetch refuses a hop to any other host. */
export async function secOpen(d: SecDeps, url: string): Promise<{ res: Response; url: string; done: () => void }> {
  let last = "";
  for (const pause of SEC_PAUSES) {
    if (pause) {
      if (d.now() + pause + 5_000 > d.deadline) break;   // no time left for a retry inside this call
      await d.sleep(pause);
    }
    const wait = lastSec + SEC_GAP_MS - d.now();
    if (wait > 0) await d.sleep(wait);
    lastSec = d.now();
    d.count.n++;
    const hop = await safeFetch(url, { fetch: d.fetch, resolve: d.resolve, timeoutMs: Math.max(5_000, Math.min(60_000, d.deadline - d.now())), allowHost: (h) => SEC_HOSTS.has(h), headers: { "User-Agent": d.contact, "Accept-Encoding": "gzip, deflate" } });
    if (!hop.ok) { if (hop.kind === "blocked") throw new SecError(`The SEC address was refused: ${hop.reason}.`, "failed"); last = hop.reason; continue; }
    const res = hop.res, drop = async () => { await res.body?.cancel().catch(() => {}); hop.done(); };
    if (BUSY.has(res.status)) { await drop(); last = `it answered ${res.status}`; continue; }
    if (res.status === 403) { await drop(); throw new SecError("The SEC turned the request away (403). Check SEC_CONTACT names the organisation and an email address.", "refused"); }
    if (res.status === 404) { await drop(); throw new SecError("The SEC has no such page (404).", "missing"); }
    if (!res.ok) { await drop(); throw new SecError(`The SEC answered ${res.status}.`, "failed"); }
    return { res, url: hop.url, done: hop.done };
  }
  throw new SecError(`The SEC was busy and didn't answer after retries (${last || "no answer"}). Try again in a few minutes.`, "busy");
}
/** One SEC answer read whole, up to maxBytes. */
export async function secGet(d: SecDeps, url: string, maxBytes: number): Promise<{ bytes: Uint8Array; url: string }> {
  const o = await secOpen(d, url);
  try {
    const got = await readCapped(o.res, maxBytes);
    if (!got.bytes) throw new SecError(`The SEC's answer is larger than ${Math.round(maxBytes / 1_000_000)} MB.`, "failed");
    return { bytes: got.bytes, url: o.url };
  } finally { o.done(); }
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);

export const TICKERS_ID = "discover:earn.tickers", TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const TICKERS_KEEP_DAYS = 7;
/** find_cik: the watchlist's CIK, or the ticker (then each other ticker) in the SEC's company tickers file, which is
    saved in the store and fetched again after TICKERS_KEEP_DAYS. */
export async function findCik(co: Company, d: SecDeps, db: Db): Promise<number | null> {
  if (co.cik) return Number(co.cik);
  const tickers = [co.ticker, ...co.otherTickers].filter((t): t is string => !!t);
  if (!tickers.length) return null;
  let map: Record<string, number> | null = null;
  const saved = await db.getStore(TICKERS_ID).catch(() => null);
  if (saved && Date.parse(saved.fetched_at) > d.now() - TICKERS_KEEP_DAYS * 86_400_000 && saved.doc && typeof saved.doc.tickers === "object") map = saved.doc.tickers as Record<string, number>;
  if (!map) {
    const got = await secGet(d, TICKERS_URL, 12_000_000);
    let raw: unknown;
    try { raw = JSON.parse(text(got.bytes)); } catch { throw new SecError("The SEC's list of tickers couldn't be read.", "failed"); }
    map = {};
    for (const v of Object.values(raw && typeof raw === "object" ? raw as Record<string, unknown> : {})) {
      const o = v as { ticker?: unknown; cik_str?: unknown };
      if (typeof o?.ticker === "string" && /^\d{1,10}$/.test(String(o.cik_str))) { const k = o.ticker.toUpperCase(); if (!(k in map)) map[k] = Number(o.cik_str); }
    }
    await db.putStore({ id: TICKERS_ID, kind: "discover", label: "SEC company tickers", doc: { tickers: map } }).catch(() => false);
  }
  for (const t of tickers) if (Object.hasOwn(map, t.toUpperCase())) return map[t.toUpperCase()];
  return null;
}
export type Filing = { form: string; filingDate: string; reportDate: string; accessionNumber: string; primaryDocument: string; items: string };
/** edgar_filings: the company's recent filings from its submissions file. */
export async function edgarFilings(cik: number, d: SecDeps): Promise<Filing[]> {
  const got = await secGet(d, `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, 15_000_000);
  let rec: Record<string, unknown[]>;
  try { rec = JSON.parse(text(got.bytes)).filings.recent; } catch { throw new SecError("The SEC's list of the company's filings couldn't be read.", "failed"); }
  const forms = Array.isArray(rec?.form) ? rec.form : [];
  const s = (k: string, i: number) => { const a = rec[k]; return Array.isArray(a) && a[i] !== null && a[i] !== undefined ? String(a[i]) : ""; };
  return forms.map((_, i) => ({ form: s("form", i), filingDate: s("filingDate", i), reportDate: s("reportDate", i), accessionNumber: s("accessionNumber", i), primaryDocument: s("primaryDocument", i), items: s("items", i) }));
}
const ACC = /^\d{10}-\d{2}-\d{6}$/;
/** filing_docs: [type, description, address] for every document in a filing, from its index page. */
export async function filingDocs(cik: number, acc: string, d: SecDeps): Promise<[string, string, string][]> {
  if (!ACC.test(acc)) throw new SecError("A filing number from the SEC isn't in the expected form.", "failed");
  const got = await secGet(d, `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${acc}-index.htm`, 3_000_000);
  return parseFilingIndex(text(got.bytes));
}
/** The rows of table.tableFile on a filing's index page (every such table's rows after the first, as the script's
    select("table.tableFile tr")[1:]): a row needs four cells and a link in the third. */
export function parseFilingIndex(html: string): [string, string, string][] {
  const rows: [string, string, string][] = [];
  const tables = [...html.matchAll(/<table\b[^>]*class\s*=\s*["'][^"']*\btableFile\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
  const trs = tables.flatMap((t) => [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|$)/gi)].map((m) => m[1])).slice(1);
  const cellText = (c: string) => words(decodeEntities(c.replace(/<[^>]*>/g, " ")));
  for (const tr of trs) {
    const td = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)(?:<\/td>|(?=<td\b)|$)/gi)].map((m) => m[1]);
    if (td.length < 4) continue;
    const a = td[2].match(/<a\b([^>]*)>/i), href = a ? attr(a[1], "href") : null;
    if (!href) continue;
    let abs: string;
    try { abs = new URL(href.replace("/ix?doc=", ""), "https://www.sec.gov").href; } catch { continue; }
    if (!SEC_HOSTS.has(new URL(abs).hostname)) continue;
    rows.push([cellText(td[3]), cellText(td[1]), abs]);
  }
  return rows;
}
/** edgar_targets: the quarter's 10-Q (10-K or 20-F for the fourth quarter) by its report date, and the first 8-K with
    item 2.02 filed after the quarter end, within 120 days. */
export function edgarTargets(filings: Filing[], q: number, y: number, types: ("10q" | "8k")[]): { "10q"?: Filing; "8k"?: Filing } {
  const qend = quarterEnd(q, y), last = addDays(qend, 120), out: { "10q"?: Filing; "8k"?: Filing } = {};
  if (types.includes("10q")) {
    const forms = q === 4 ? ["10-K", "20-F"] : ["10-Q"];     // 20-F: the annual report of foreign filers
    const f = filings.find((f) => forms.includes(f.form) && f.reportDate === qend);
    if (f) out["10q"] = f;
  }
  if (types.includes("8k")) {
    const win = filings.filter((f) => f.form === "8-K" && (f.items || "").includes("2.02") && f.filingDate > qend && f.filingDate <= last);
    if (win.length) out["8k"] = win.reduce((a, b) => (b.filingDate < a.filingDate ? b : a));   // the first results 8-K after quarter end
  }
  return out;
}
/** The script's run_sec, picking documents: [column, filing, documents, kind]. A foreign filer with no 10-Q or 8-K gets
    the quarter's results 6-K: its financial statements count as the 10-Q, the 6-K itself as the 8-K. */
export type SecJob = { col: "10q" | "8k"; filing: Filing; docs: [string, string, string][]; kind: string };
export const MAX_SIX_KS = 8;   // 6-K index pages read at most for one company (each is an SEC request)
export async function secJobs(cik: number, filings: Filing[], q: number, y: number, d: SecDeps): Promise<SecJob[]> {
  const qend = quarterEnd(q, y), targets = edgarTargets(filings, q, y, ["10q", "8k"]), jobs: SecJob[] = [];
  for (const col of ["10q", "8k"] as const) {
    const f = targets[col];
    if (!f) continue;
    const docs = await filingDocs(cik, f.accessionNumber, d);
    if (col === "10q") jobs.push({ col, filing: f, docs: docs.filter((x) => x[0] === f.form).slice(0, 1), kind: f.form });
    else jobs.push({ col, filing: f, docs: docs.filter((x) => x[0] === "8-K" || x[0].toUpperCase().startsWith("EX-99")), kind: "8-K" });
  }
  const missing = (["10q", "8k"] as const).filter((t) => !targets[t]) as ("10q" | "8k")[];
  if (missing.length) {
    const stamp = qend.replace(/-/g, ""), last = addDays(qend, 120);
    const sixKs = filings.filter((f) => f.form === "6-K" && f.filingDate > qend && f.filingDate <= last).sort((a, b) => a.filingDate.localeCompare(b.filingDate)).slice(0, MAX_SIX_KS);
    for (const f of sixKs) {
      const docs = await filingDocs(cik, f.accessionNumber, d);
      const names = docs.map(([t, desc, u]) => `${t} ${desc} ${pyName(urlparse(u).path)}`).join(" ").toLowerCase();
      if (!/earning|result|press/.test(names) && !names.includes(stamp)) continue;
      const fin = docs.filter((x) => pyName(urlparse(x[2]).path).includes(stamp));
      if (missing.includes("10q") && fin.length) { jobs.push({ col: "10q", filing: f, docs: fin.slice(0, 1), kind: "6-K Financial Statements" }); missing.splice(missing.indexOf("10q"), 1); }
      if (missing.includes("8k")) {
        jobs.push({ col: "8k", filing: f, docs: docs.filter((x) => x !== fin[0] && (x[0] === "6-K" || x[0].toUpperCase().startsWith("EX-99"))), kind: "6-K" });
        missing.splice(missing.indexOf("8k"), 1);
      }
      if (!missing.length) break;
    }
  }
  return jobs;
}

// ---------- the watchlist ----------

export type Company = {
  id: string; name: string; ticker: string | null; otherTickers: string[]; cik: string | null; irUrls: string[]; sec: boolean; folder: string | null;
  /** Known file addresses with the script's placeholders {q}, {yy}, {yyyy}: keys are a type ("supplement") or a type for
      one quarter ("deck_q2"). */
  fileUrls: Record<string, string[]>;
};
export type Problem = { at: number; name: string; message: string; dropped: boolean };
const clean = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v) : "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** safe_name: a file or folder name without characters Windows refuses. */
export function safeName(s: string, limit = 120): string {
  return s.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/[<>:"/\\|?*\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit).trim();
}
const TICKER = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const FILE_KEY = /^(10q|supplement|deck|report|release)(_q[1-4])?$/;
export function companyId(name: string): string {
  let h = 7;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return "e-" + h.toString(36);
}
/** Fills a known file address's placeholders as the script does: {q} 3, {yy} 26, {yyyy} 2026. */
export const fillTemplate = (t: string, q: number, y: number) => t.replace(/\{q\}/g, String(q)).replace(/\{yy\}/g, String(y % 100).padStart(2, "0")).replace(/\{yyyy\}/g, String(y));
/** Reads the watchlist, or a list pasted from the script (its "companies" list, the whole config, or one company), in
    the script's own field names (other_tickers, ir_urls, file_urls) or the app's. Every entry is untrusted: what can't
    be used is left out and named in problems (dropped: the whole entry was left out). Never throws. */
export function cleanWatchlist(raw: unknown): { companies: Company[]; problems: Problem[] } {
  const problems: Problem[] = [], companies: Company[] = [], names = new Set<string>(), ids = new Set<string>();
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.companies)) list = o.companies;
    else if (typeof o.name === "string") list = [o];
    else if (Object.keys(o).length) problems.push({ at: 0, name: "", message: "There is no list of companies in it (the script's list is called \"companies\").", dropped: true });
  } else if (raw !== null && raw !== undefined) problems.push({ at: 0, name: "", message: "It isn't a list of companies.", dropped: true });
  list.forEach((e, i) => {
    const at = i + 1, o = e && typeof e === "object" && !Array.isArray(e) ? e as Record<string, unknown> : null;
    const name = o ? clean(o.name, NAME_MAX) : "";
    const say = (message: string, dropped = false) => problems.push({ at, name, message, dropped });
    if (!o) return say("It isn't a company (it needs at least a name).", true);
    if (!name) return say("It has no name.", true);
    if (names.has(name.toLowerCase())) return say("A company of the same name is already on the list.", true);
    if (companies.length >= MAX_COMPANIES) return say(`The list holds at most ${MAX_COMPANIES} companies.`, true);
    const tick = (v: unknown) => { const t = clean(v, 12).toUpperCase(); return TICKER.test(t) ? t : null; };
    let ticker: string | null = null;
    if (o.ticker !== undefined && o.ticker !== null && o.ticker !== "") { ticker = tick(o.ticker); if (!ticker) say("Its ticker isn't a ticker (letters, digits, dots and dashes, up to 10), so it was left out."); }
    const others: string[] = [];
    const rawOthers = o.other_tickers ?? o.otherTickers;
    for (const t of Array.isArray(rawOthers) ? rawOthers.slice(0, 5) : rawOthers ? [rawOthers] : []) { const x = tick(t); if (x && x !== ticker && !others.includes(x)) others.push(x); else if (!x) say("One of its other tickers isn't a ticker, so it was left out."); }
    let cik: string | null = null;
    if (o.cik !== undefined && o.cik !== null && o.cik !== "") { const c = clean(o.cik, 12); if (/^\d{1,10}$/.test(c) && Number(c) > 0) cik = String(Number(c)); else say("Its CIK isn't a number of up to 10 digits, so it was left out."); }
    const sec = o.sec === false || o.sec === "false" ? false : true;
    const irUrls: string[] = [];
    const rawIr = o.ir_urls ?? o.irUrls;
    for (const u of Array.isArray(rawIr) ? rawIr : rawIr ? [rawIr] : []) {
      const s = typeof u === "string" ? u.trim() : "", why = checkUrl(s);
      if (why) { say(`The investor page ${s ? `"${clean(s, 80)}"` : "(blank)"} can't be used: ${why}. It was left out.`); continue; }
      if (irUrls.length >= MAX_IR_URLS) { say(`It lists more than ${MAX_IR_URLS} investor pages; the rest were left out.`); break; }
      if (!irUrls.includes(s)) irUrls.push(s);
    }
    const fileUrls: Record<string, string[]> = {};
    const rawF = o.file_urls ?? o.fileUrls;
    if (rawF && typeof rawF === "object" && !Array.isArray(rawF)) {
      for (const [k, v] of Object.entries(rawF as Record<string, unknown>)) {
        if (!FILE_KEY.test(k)) { say(`Its known file addresses under "${clean(k, 30)}" were left out: the kinds are supplement, deck, 10q, report and release, each optionally for one quarter (deck_q2).`); continue; }
        const keep: string[] = [];
        for (const u of Array.isArray(v) ? v : [v]) {
          const s = typeof u === "string" ? u.trim() : "";
          const bad = /\{(?!q\}|yy\}|yyyy\})/.test(s) ? "it has a placeholder other than {q}, {yy} and {yyyy}" : checkUrl(fillTemplate(s, 3, 2026));
          if (bad) { say(`A known file address ${s ? `"${clean(s, 80)}"` : "(blank)"} can't be used: ${bad}. It was left out.`); continue; }
          if (keep.length < MAX_TEMPLATES && !keep.includes(s)) keep.push(s);
        }
        if (keep.length) fileUrls[k] = keep;
      }
    } else if (rawF !== undefined && rawF !== null) say("Its known file addresses aren't in the script's form, so they were left out.");
    const folderRaw = o.folder !== undefined && o.folder !== null ? safeName(clean(o.folder, 80), 60) : "";
    let id = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : companyId(name);
    while (ids.has(id)) id = companyId(name + "|" + at + id);
    if (sec && !ticker && !others.length && !cik) say("It files with the SEC but has no ticker or CIK, so its SEC filings can't be found. Add one.");
    if (!sec && !irUrls.length) say("It doesn't file with the SEC and lists no investor pages, so nothing can be found for it. Add a page.");
    names.add(name.toLowerCase()); ids.add(id);
    companies.push({ id, name, ticker, otherTickers: others, cik, irUrls, sec, folder: folderRaw || null, fileUrls });
  });
  return { companies, problems };
}
export async function readWatchlist(db: Db): Promise<{ companies: Company[]; problems: Problem[] }> {
  return cleanWatchlist(await db.getSetting(WATCH_SETTING));
}

// ---------- one company, one quarter ----------

export type CellState = "found" | "in_8k" | "not_filed" | "not_found_sec" | "not_found" | "refused" | "none_listed" | "no_cik" | "error";
export type Cell = { state: CellState; docs: string[]; kind?: string; note?: string; refused?: string[] };
export type Doc = {
  id: string; col: Col; type: string; title: string; filed: string | null; source: "sec" | "ir"; host: string; url: string;
  /** The script's file name for it, without the extension. */
  name: string; ext: string; page: boolean; firstSeen: string; via?: string;
};
export type PageNote = { url: string; outcome: "read" | "refused" | "failed" | "blocked" | "file" | "not_read"; status?: number; reason?: string; links?: number };
export type Result = {
  v: 1; company: { id: string; name: string; ticker: string | null; folder: string }; quarter: string; q: number; y: number; madeAt: string;
  cik: number | null; sec: boolean; london: boolean; cells: Record<Col, Cell>; docs: Doc[]; pages: PageNote[]; notes: string[];
  secRequests: number; pagesRead: number;
};
export const resultId = (quarter: string, id: string) => `discover:earn.${quarter}.${id}`;
export const DOWNLOAD_MAX_BYTES = 60_000_000;
export const PAGE_MAX_BYTES = 3_000_000;
export const PAGE_TIMEOUT_MS = 15_000;
/** One call stays well inside Supabase's 150 seconds: the SEC part first, then investor pages while time is left. */
export const CALL_MS = 120_000, IR_STOP_MS = 25_000;

export type RunDeps = { fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>; resolve?: Resolve; contact: string; db: Db; deadline: number; pageTimeoutMs?: number };

async function docId(col: string, url: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${col}|${url}`));
  return "d" + [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
const secExt = (u: string) => { const s = pySuffix(pyName(urlparse(u).path)).toLowerCase(); return s === ".html" ? ".htm" : [".htm", ".pdf", ".txt"].includes(s) ? s : s || ""; };

/** Reads the investor pages (the script's crawl), with a plain fetch. Pages are opened in the script's order; links to
    other pages on the same site are followed by its keyword rules, quarterly results pages first, up to its page
    limit, and while time is left. */
export async function crawl(urls: string[], o: { pageWords: string; collectPages: boolean; minYear: number; run: RunDeps; stopAt: number }): Promise<{ files: Found[]; pages: PageNote[] }> {
  const follow = new RegExp(FOLLOW_KEYWORDS + "|" + o.pageWords, "i"), nofollow = new RegExp(NO_FOLLOW_KEYWORDS, "i");
  const files = new Map<string, Found>(), pages = new Map<string, Found>(), visited = new Set<string>(), notes: PageNote[] = [];
  const queue: [string, string, string][] = urls.map((u) => [u, "", ""]);
  while (queue.length && visited.size < MAX_PAGES_PER_COMPANY) {
    const [url, , via] = queue.shift()!;
    const key = url.split("#")[0];
    if (visited.has(key)) continue;
    if (o.run.now() > o.stopAt) { notes.push({ url: key, outcome: "not_read", reason: "the time one look may take ran out" }); continue; }
    visited.add(key);
    const hop = await safeFetch(key, { fetch: o.run.fetch, resolve: o.run.resolve, timeoutMs: o.run.pageTimeoutMs ?? Math.min(PAGE_TIMEOUT_MS, Math.max(3_000, o.stopAt + 10_000 - o.run.now())), headers: { "User-Agent": IR_UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en" } });
    if (!hop.ok) { notes.push({ url: key, outcome: hop.kind === "blocked" ? "blocked" : "failed", reason: hop.reason }); continue; }
    let html: string;
    try {
      const res = hop.res;
      if (REFUSED.has(res.status)) { await res.body?.cancel().catch(() => {}); notes.push({ url: key, outcome: "refused", status: res.status }); continue; }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); notes.push({ url: key, outcome: "failed", status: res.status, reason: `it answered ${res.status}` }); continue; }
      const type = (res.headers.get("content-type") ?? "html").toLowerCase();
      if (!type.includes("html")) {   // the "page" is a file download (the script's IsAFile)
        await res.body?.cancel().catch(() => {});
        if (!files.has(key)) files.set(key, { url: key, label: via, via: "", generic: false, ext: "unknown" });
        notes.push({ url: key, outcome: "file" });
        continue;
      }
      const got = await readCapped(res, PAGE_MAX_BYTES);
      if (!got.bytes) { notes.push({ url: key, outcome: "failed", reason: `the page is larger than ${PAGE_MAX_BYTES / 1_000_000} MB` }); continue; }
      html = new TextDecoder().decode(got.bytes);
    } catch (e) {
      notes.push({ url: key, outcome: "failed", reason: `it stopped answering (${String((e as Error)?.message ?? e).slice(0, 60)})` });
      continue;
    } finally { hop.done(); }
    if (html.length < 20_000 && CHALLENGE.test(html)) { notes.push({ url: key, outcome: "refused", status: 200, reason: "it showed a check for robots instead of the page" }); continue; }
    const links = extractLinks(html, hop.url);
    notes.push({ url: key, outcome: "read", links: links.length });
    const host = urlparse(hop.url).netloc;
    for (const [href, txt] of links) {
      if (!href.startsWith("https:") || checkUrl(href)) continue;   // https only and safe addresses, here as everywhere
      let label = cleanLabel(txt, href);
      const hkey = href.split("#")[0];
      if (!linkExt(href) && o.collectPages && !pages.has(hkey)) pages.set(hkey, { url: hkey, label, via, generic: false, ext: null, page: true });
      const stem = pyStem(pyName(unquote(urlparse(href).path))).replace(/_/g, " ");
      if (linkExt(href)) {
        const generic = label === cleanLabel("", href);
        if (!label.toLowerCase().includes(stem.toLowerCase()) && !/\d/.test(label)) label = `${label} ${stem}`;   // "Statistical Supplement" -> add the file name
        if (!files.has(hkey)) files.set(hkey, { url: hkey, label, via, generic });
      } else {
        const hay = `${label} ${unquote(href)}`;
        if (urlparse(href).netloc === host && follow.test(hay) && !nofollow.test(hay) && !tooOld(label, href, o.minYear)) {
          if (PRIORITY.test(hay)) queue.unshift([href, txt, label]);   // quarterly results pages first
          else queue.push([href, txt, label]);
        }
      }
    }
  }
  for (const [u] of queue) if (!visited.has(u.split("#")[0]) && !notes.some((n) => n.url === u.split("#")[0])) notes.push({ url: u.split("#")[0], outcome: "not_read", reason: `the ${MAX_PAGES_PER_COMPANY} pages one look reads were used` });
  return { files: [...files.values(), ...pages.values()], pages: notes };
}

/** Whether a known file address answers with a file of an allowed type (the script tries each until one works). Reads
    only the first bytes. */
async function probeFile(url: string, allowed: string[], run: RunDeps): Promise<boolean> {
  const hop = await safeFetch(url, { fetch: run.fetch, resolve: run.resolve, timeoutMs: run.pageTimeoutMs ?? PAGE_TIMEOUT_MS, headers: { "User-Agent": IR_UA, "Referer": `https://${hostOf(url)}/` } });
  if (!hop.ok) return false;
  try {
    if (!hop.res.ok) { await hop.res.body?.cancel().catch(() => {}); return false; }
    const r = hop.res.body?.getReader();
    if (!r) return false;
    const first = await r.read();
    await r.cancel().catch(() => {});
    return !first.done && !!fileExt(first.value, allowed);
  } catch { return false; } finally { hop.done(); }
}

/** The kind of document the script names a file by (run_company). */
export function irKind(dtype: DocType, q: number): string {
  if (dtype === "report") return ({ 2: "Interim Report", 4: "Annual Report" } as Record<number, string>)[q] ?? "Report";
  if (dtype === "release") return q === 2 || q === 4 ? "Results Release" : "Trading Update";
  return dtype === "10q" && q === 4 ? "10-K" : TYPE_NAMES[dtype];
}
/** The script's name for an SEC document (run_sec): the form, or the form and exhibit with its description. */
export function secPart(kind: string, typ: string, desc: string): string {
  const isExhibit = typ.toUpperCase().startsWith("EX-");
  if (kind === "6-K Financial Statements" || !isExhibit) return kind;
  const extra = desc && desc.toUpperCase() !== typ.toUpperCase() ? desc : "";
  return `${kind} ${typ.toUpperCase().replace("EX-", "Ex ")}` + (extra ? ` - ${extra}` : "");
}

/** One company, one quarter: what the SEC and the company's investor pages have. Never throws for a site's failure:
    each column says what happened. prev: the result saved before, so documents keep when they were first seen. */
export async function runCompany(co: Company, q: number, y: number, run: RunDeps, prev: Result | null): Promise<Result> {
  const qn = quarterName(q, y), qend = quarterEnd(q, y), nowIso = new Date(run.now()).toISOString();
  const folder = safeName(co.folder || co.name, 60) || "Company", prefix = `${folder} ${qn}`;
  const london = co.sec === false;
  const docs: Doc[] = [], notes: string[] = [], count = { n: 0 };
  const seen = new Map((prev?.docs ?? []).map((d) => [d.id, d.firstSeen]));
  const cells = Object.fromEntries(COLS.map((c) => [c, { state: "not_found", docs: [] } as Cell])) as Record<Col, Cell>;
  const add = async (d: Omit<Doc, "id" | "firstSeen">) => {
    const id = await docId(d.col, d.url);
    if (docs.some((x) => x.id === id)) return id;
    docs.push({ ...d, id, firstSeen: seen.get(id) ?? nowIso });
    return id;
  };
  let cik: number | null = null;

  // 1. SEC EDGAR: the 10-Q or 10-K and the earnings 8-K (or the results 6-K)
  let secFound: Partial<Record<"10q" | "8k", boolean>> = {}, inEight: string[] = [];
  if (!london) {
    const d: SecDeps = { fetch: run.fetch, contact: run.contact, now: run.now, sleep: run.sleep, deadline: run.deadline, resolve: run.resolve, count };
    try {
      cik = await findCik(co, d, run.db);
      if (!cik) {
        cells["10q"] = { state: "no_cik", docs: [], note: "Not found at the SEC by its ticker. Add its CIK to the watchlist." };
        cells["8k"] = { state: "no_cik", docs: [], note: cells["10q"].note };
      } else {
        const filings = await edgarFilings(cik, d);
        const jobs = await secJobs(cik, filings, q, y, d);
        const supp = new RegExp(DOC_TYPES.supplement.keywords, "i");
        for (const j of jobs) {
          for (const [typ, desc, url] of j.docs) {
            const fname = pyName(urlparse(url).path);
            const part = secPart(j.kind, typ, desc);
            const id = await add({ col: j.col, type: typ.toUpperCase().startsWith("EX-") ? typ.toUpperCase() : j.kind, title: desc && desc.toUpperCase() !== typ.toUpperCase() ? desc : part, filed: j.filing.filingDate || null, source: "sec", host: hostOf(url), url, name: safeName(`${prefix} ${part}`, 150), ext: secExt(url), page: false });
            cells[j.col].docs.push(id);
            secFound[j.col] = true;
            if (typ.toUpperCase().startsWith("EX-") && supp.test(`${desc} ${fname}`)) inEight.push(id);   // a supplement filed as an 8-K exhibit
          }
        }
        for (const col of ["10q", "8k"] as const) {
          if (secFound[col]) cells[col].state = "found";
          else cells[col] = { state: run.now() <= Date.parse(addDays(qend, 120) + "T23:59:59Z") ? "not_filed" : "not_found_sec", docs: [] };
        }
      }
    } catch (e) {
      const msg = e instanceof SecError ? e.message : `The SEC part failed: ${String((e as Error)?.message ?? e).slice(0, 120)}.`;
      for (const col of ["10q", "8k"] as const) if (!secFound[col]) cells[col] = { state: "error", docs: cells[col].docs, note: msg };
      notes.push(msg);
    }
  }

  // 2. Investor pages: presentation and supplement; a 10-Q PDF for SEC filers; London names' report and release
  const jobs: [DocType, Col][] = [["deck", "deck"], ["supplement", "supplement"]];
  if (!london) jobs.push(["10q", "10q"]);
  else jobs.push(["report", "10q"], ["release", "8k"]);
  let files: Found[] = [], pageNotes: PageNote[] = [];
  if (co.irUrls.length) {
    const pageWords = jobs.map(([d]) => DOC_TYPES[d].keywords).join("|");
    const got = await crawl(co.irUrls, { pageWords, collectPages: jobs.some(([d]) => DOC_TYPES[d].pages), minYear: y, run, stopAt: run.deadline - IR_STOP_MS });
    files = got.files; pageNotes = got.pages;
  }
  const read = pageNotes.filter((p) => p.outcome === "read" || p.outcome === "file").length;
  const refused = pageNotes.filter((p) => p.outcome === "refused").map((p) => p.url);
  for (const [dtype, col] of jobs) {
    const found = pick(files, dtype, q, y);
    // known file addresses ("file_urls"), for sites the crawl can't reach: only when the pages gave nothing
    if (!found.size) {
      for (const tmpl of [...(co.fileUrls[`${dtype}_q${q}`] ?? []), ...(co.fileUrls[dtype] ?? [])]) {
        if (run.now() > run.deadline - 10_000) break;
        const url = fillTemplate(tmpl, q, y);
        if (await probeFile(url, DOC_TYPES[dtype].extensions, run)) { found.set(url, pyStem(pyName(unquote(urlparse(url).path)))); break; }
      }
    }
    const kind = irKind(dtype, q), isLondon = dtype in NONSEC_COLUMN;
    let n = 0;
    for (const [url, label] of found) {
      if (isLondon && n >= 1) break;                         // one report and one release a quarter is enough (sites post the same one twice)
      if (dtype === "10q" && n >= 1) break;                  // one 10-Q copy from the site
      const f = files.find((x) => x.url === url);
      const page = !!f?.page, ext = page ? "" : (linkExt(url) === "unknown" ? "" : linkExt(url) ?? "");
      const id = await add({ col, type: page ? `${kind} (web page)` : kind, title: label, filed: null, source: "ir", host: hostOf(url), url, name: safeName(`${prefix} ${kind}` + (dtype !== "10q" ? ` - ${label}` : ""), 150), ext, page, via: f?.via || undefined });
      cells[col].docs.push(id);
      n++;
    }
    if (isLondon) cells[col].kind = kind;
    if (london || dtype !== "10q") {
      const c = cells[col];
      if (c.docs.length) c.state = "found";
      else if (!co.irUrls.length) c.state = "none_listed";
      else if (read) { c.state = "not_found"; if (refused.length) c.refused = refused; }
      else if (refused.length) { c.state = "refused"; c.refused = refused; }
      else c.state = "error";
    } else if (cells["10q"].docs.length && cells["10q"].state !== "found") {
      cells["10q"] = { ...cells["10q"], state: "found" };   // the SEC part failed or found nothing, but the site has the 10-Q
    }
  }
  if (cells.supplement.state !== "found" && inEight.length) cells.supplement = { state: "in_8k", docs: inEight };
  if (pageNotes.some((p) => p.outcome === "read" && (p.links ?? 0) < 3)) notes.push("A page read had almost no links: the site may fill its lists with JavaScript, which a plain fetch can't see. Open the page yourself, or use the desktop script.");
  return {
    v: 1, company: { id: co.id, name: co.name, ticker: co.ticker, folder }, quarter: qn, q, y, madeAt: nowIso, cik, sec: !london, london,
    cells, docs, pages: pageNotes.slice(0, 30), notes, secRequests: count.n, pagesRead: read,
  };
}
