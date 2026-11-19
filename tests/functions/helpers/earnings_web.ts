// A made-up web for the earnings suites: the SEC's tickers file, submissions files and filing index pages in the shapes
// the owner's script reads, and investor sites that answer, refuse, redirect, hang or send too much. Every company,
// ticker, CIK and address is made up; nothing real is called. fetch records each request with its headers and the time.

export const CONTACT = "Nonesuch Test Org test-contact@nonesuch.example";   // a stand-in: never a real person's details
const sec = (p: string) => `https://www.sec.gov${p}`;
const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

/** SEC submissions file: filings.recent as column arrays, newest first, as data.sec.gov answers. */
export function submissions(rows: { form: string; filingDate: string; reportDate?: string; acc: string; doc?: string; items?: string }[]) {
  return { cik: "x", name: "made up", filings: { recent: {
    accessionNumber: rows.map((r) => r.acc), filingDate: rows.map((r) => r.filingDate), reportDate: rows.map((r) => r.reportDate ?? ""),
    form: rows.map((r) => r.form), primaryDocument: rows.map((r) => r.doc ?? "x.htm"), items: rows.map((r) => r.items ?? ""),
  }, files: [] } };
}
/** A filing's index page: the tableFile table the script reads. */
export function indexPage(cik: number, acc: string, docs: [string, string, string][]) {
  const folder = `/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/`;
  return html(`<table class="tableFile" summary="Document Format Files"><tr><th scope="col">Seq</th><th scope="col">Description</th><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Size</th></tr>` +
    docs.map(([type, desc, file], i) => `<tr${i % 2 ? "" : ' class="blueRow"'}><td scope="row">${i + 1}</td><td scope="row">${desc}</td><td scope="row"><a href="${file.endsWith(".htm") && i === 0 ? "/ix?doc=" : ""}${folder}${file}">${file}</a></td><td scope="row">${type}</td><td scope="row">1000</td></tr>`).join("") + "</table>");
}
export const idx = (cik: number, acc: string) => sec(`/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${acc}-index.htm`);
export const docUrl = (cik: number, acc: string, file: string) => sec(`/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${file}`);

export const TICKERS = { "0": { cik_str: 1999001, ticker: "CLWY", title: "Calloway Insurance Co" }, "1": { cik_str: 1999002, ticker: "TRWX", title: "Tarrow Mutual" }, "2": { cik_str: 1999777, ticker: "NSRE", title: "Nonesuch Re Ltd" } };
export const CAL = { cik: 1999001, tenQ: "0001999001-26-000050", eightK: "0001999001-26-000044", oldEightK: "0001999001-26-000020" };
export const NSRE = { cik: 1999777, agm: "0001999777-26-000030", results: "0001999777-26-000041" };
export const IR = "https://investors.calloway.example";
export const NONESUCH = "https://www.nonesuch.example";

export const WATCHLIST = { companies: [
  { name: "Calloway Insurance Co", ticker: "CLWY", ir_urls: [`${IR}/events-and-presentations/default.aspx`], folder: "Calloway" },
  { name: "Tarrow Mutual", ticker: "TRWM", other_tickers: ["TRWX"], ir_urls: ["https://ir.tarrow.example/", "https://ir.tarrow.example/results"] },
  { name: "Nonesuch Holdings plc", sec: false, ir_urls: [`${NONESUCH}/investors/results`], file_urls: { supplement: [`${NONESUCH}/ir/{yyyy}/supp-{q}q{yy}.pdf`] } },
  { name: "Nonesuch Re Ltd", ticker: "NSRE", ir_urls: [] },
  { name: "Nonesuch Unlisted Co", ticker: "NOPE", ir_urls: ["https://js.nonesuch.example/ir"] },
] };

export type Route = (req: { url: string; headers: Record<string, string>; signal?: AbortSignal }) => Response | Promise<Response>;
const R = (body: BodyInit | null, status = 200, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": type, ...headers } });
export const pdf = (n = 2000, tag = "made-up") => R(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, ...new TextEncoder().encode(" " + tag + " ".repeat(n))]), 200, "application/pdf");
export const xlsx = () => R(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]), 200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
export { R };

/** The default made-up web. Tests change routes to make a site refuse, redirect, hang or send too much. */
export function makeRoutes(): Map<string, Route> {
  const m = new Map<string, Route>();
  m.set(sec("/files/company_tickers.json"), () => R(JSON.stringify(TICKERS), 200, "application/json"));
  m.set(`https://data.sec.gov/submissions/CIK0001999001.json`, () => R(JSON.stringify(submissions([
    { form: "10-Q", filingDate: "2026-11-04", reportDate: "2026-09-30", acc: CAL.tenQ, doc: "clwy-20260930.htm" },
    { form: "8-K", filingDate: "2026-11-02", acc: "0001999001-26-000045", items: "7.01" },
    { form: "8-K", filingDate: "2026-10-28", acc: CAL.eightK, items: "2.02,9.01" },
    { form: "10-Q", filingDate: "2026-08-03", reportDate: "2026-06-30", acc: "0001999001-26-000030" },
    { form: "8-K", filingDate: "2026-07-29", acc: CAL.oldEightK, items: "2.02,9.01" },
  ])), 200, "application/json"));
  m.set(idx(CAL.cik, CAL.tenQ), () => R(indexPage(CAL.cik, CAL.tenQ, [["10-Q", "QUARTERLY REPORT", "clwy-20260930.htm"], ["EX-31.1", "CERTIFICATION", "ex311.htm"], ["EX-101.SCH", "XBRL SCHEMA", "clwy.xsd"]])));
  m.set(idx(CAL.cik, CAL.eightK), () => R(indexPage(CAL.cik, CAL.eightK, [["8-K", "FORM 8-K", "clwy-20261028.htm"], ["EX-99.1", "PRESS RELEASE", "ex991.htm"], ["EX-99.2", "FINANCIAL SUPPLEMENT", "ex992.pdf"], ["EX-104", "COVER PAGE", "cover.htm"]])));
  m.set(docUrl(CAL.cik, CAL.tenQ, "clwy-20260930.htm"), () => R(html(`<p>Calloway Insurance Co quarterly report</p><img src="logo.jpg">`)));
  m.set(docUrl(CAL.cik, CAL.eightK, "ex992.pdf"), () => pdf(100, "sec-exhibit"));
  m.set(`https://data.sec.gov/submissions/CIK0001999002.json`, () => R(JSON.stringify(submissions([])), 200, "application/json"));
  m.set(`https://data.sec.gov/submissions/CIK0001999777.json`, () => R(JSON.stringify(submissions([
    { form: "6-K", filingDate: "2026-11-05", acc: NSRE.results }, { form: "6-K", filingDate: "2026-10-10", acc: NSRE.agm }, { form: "20-F", filingDate: "2026-03-30", reportDate: "2025-12-31", acc: "0001999777-26-000010" },
  ])), 200, "application/json"));
  m.set(idx(NSRE.cik, NSRE.agm), () => R(indexPage(NSRE.cik, NSRE.agm, [["6-K", "NOTICE OF ANNUAL GENERAL MEETING", "agm.htm"]])));
  m.set(idx(NSRE.cik, NSRE.results), () => R(indexPage(NSRE.cik, NSRE.results, [["6-K", "FORM 6-K", "nsre-6k.htm"], ["EX-99.1", "THIRD QUARTER 2026 EARNINGS PRESS RELEASE", "ex991.htm"], ["EX-99.2", "UNAUDITED FINANCIAL STATEMENTS", "nsre-20260930.htm"]])));
  // Calloway's investor site: a section page, a quarterly results page reached from it, and links that must not be followed
  m.set(`${IR}/events-and-presentations/default.aspx`, () => R(html(`
    <a href="/files/doc_presentations/2026/q3/Calloway-Q3-2026-Investor-Presentation.pdf">Third Quarter 2026 Investor Presentation (opens in a new window)</a>
    <a href="/files/doc_presentations/2026/q2/Calloway-Q2-2026-Investor-Presentation.pdf">Second Quarter 2026 Investor Presentation</a>
    <a href="/financial-information/quarterly-results/default.aspx">Quarterly results</a>
    <a href="/news/press-releases/default.aspx">Press releases</a>
    <a href="/results/2024/default.aspx">2024 results</a>
    <a href="https://other.calloway-cdn.example/results/default.aspx">Results elsewhere</a>
    <a href="https://169.254.169.254/latest/q3-2026-supplement.pdf">Q3 2026 Supplement</a>
    <a href="http://investors.calloway.example/files/q3-2026-supplement-plain.pdf">Q3 2026 Supplement (plain)</a>
    <a href="/governance/default.aspx">Governance results</a>`)));
  m.set(`${IR}/financial-information/quarterly-results/default.aspx`, () => R(html(`
    <a href="/files/doc_financials/2026/q3/Q3-2026-Financial-Supplement.xlsx">Financial Supplement (Excel)</a>
    <a href="/files/doc_financials/2026/q3/Q3-2026-Financial-Supplement.pdf">Q3 2026 Financial Supplement</a>
    <a href="/files/doc_financials/2026/q3/Calloway-Form-10-Q-Q3-2026.pdf">Form 10-Q</a>
    <a href="/files/doc_financials/2026/q3/Q3-2026-Earnings-Call-Transcript.pdf">Q3 2026 transcript</a>`)));
  for (const f of ["doc_presentations/2026/q3/Calloway-Q3-2026-Investor-Presentation.pdf", "doc_financials/2026/q3/Q3-2026-Financial-Supplement.pdf", "doc_financials/2026/q3/Calloway-Form-10-Q-Q3-2026.pdf"]) m.set(`${IR}/files/${f}`, () => pdf(500, f));
  m.set(`${IR}/files/doc_financials/2026/q3/Q3-2026-Financial-Supplement.xlsx`, () => xlsx());
  // Tarrow's site refuses automated requests
  m.set("https://ir.tarrow.example/", () => R("Access Denied", 403));
  m.set("https://ir.tarrow.example/results", () => R(html(`<div id="cf-chl">Just a moment...</div>`), 200));
  // Nonesuch Holdings (London): a results page with a trading update page and the interim report of another period
  m.set(`${NONESUCH}/investors/results`, () => R(html(`
    <a href="/investors/2026/q3-trading-update">Q3 Trading Update</a>
    <a href="/media/2026/interim-report-2026.pdf">Interim Report 2026</a>
    <a href="/media/2026/q3-2026-results-presentation.pdf">Q3 2026 results presentation</a>
    <a href="/investors/2026/q3-trading-update-webcast">Q3 Trading Update webcast</a>`)));
  m.set(`${NONESUCH}/investors/2026/q3-trading-update`, () => R(html(`<p>Trading update text</p><a href="/">Home</a>`)));
  m.set(`${NONESUCH}/media/2026/q3-2026-results-presentation.pdf`, () => pdf(300));
  m.set(`${NONESUCH}/ir/2026/supp-3q26.pdf`, () => pdf(300, "template"));
  // a site that fills its lists with JavaScript: the plain page has no links
  m.set("https://js.nonesuch.example/ir", () => R(html(`<div id="app"></div><script src="/app.js"></script>`)));
  return m;
}

export type Seen = { url: string; headers: Record<string, string>; at: number };
/** A fetch over the routes. now: the clock tests control, recorded with each request. */
export function fakeWeb(routes: Map<string, Route>, now: () => number) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(init?.headers ?? {}), headers: Record<string, string> = {};
    h.forEach((v, k) => { headers[k] = v; });
    seen.push({ url, headers, at: now() });
    const r = routes.get(url);
    if (!r) return R("not found", 404);
    return await r({ url, headers, signal: init?.signal ?? undefined });
  }) as typeof fetch;
  return { fetch: f, seen };
}
/** A route that answers only when its request is given up: for time limits. */
export const hang: Route = ({ signal }) => new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
