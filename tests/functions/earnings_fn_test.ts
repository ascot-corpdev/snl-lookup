// The snl-earnings function against a made-up web: logins and roles; the watchlist read by any login and checked for
// Corp Dev only; no SEC_CONTACT (nothing is called); one company a call, its result saved and reopened without asking
// anyone until Refresh; the SEC part (tickers file saved, the 10-Q and the results 8-K with exhibits, a supplement
// filed with the 8-K, the 6-K route, a ticker not found, a busy SEC with the script's patient retries, the pacing and
// the User-Agent on every SEC request and on no other); investor pages (following links by the script's rules, a site
// that refuses, a page filled by JavaScript, London names, known file addresses); safe fetching (hostile addresses,
// redirects checked at every hop, DNS answers, size and time limits); and downloads (streamed, the SEC's web pages
// with a note and a base address, a file too big, a refused source, a web page instead of a PDF).
(globalThis as any).__SNL_TEST__ = true;
const fn = await import(new URL("../../supabase/functions/snl-earnings/index.ts", import.meta.url).href);
import * as E from "../../supabase/functions/_shared/earnings.ts";
import { checks, corpdev, env, fakeClock, memoryDb, nobody, reader, req } from "./helpers/fakes.ts";
import { CAL, CONTACT, docUrl, fakeWeb, hang, idx, indexPage, IR, makeRoutes, NONESUCH, NSRE, pdf, R, type Route, WATCHLIST } from "./helpers/earnings_web.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isSec = (u: string) => /^https:\/\/(www\.|data\.)?sec\.gov\//.test(u);

function setup(o: { contact?: string | null; who?: () => Promise<{ id: string; role: string } | null>; routes?: Map<string, Route>; watch?: unknown; resolve?: E.Resolve; now?: string } = {}) {
  E.resetSecPacing();
  const clock = fakeClock(o.now ?? "2026-11-19T12:00:00Z"), db = memoryDb(clock), routes = o.routes ?? makeRoutes(), web = fakeWeb(routes, clock.fn);
  db.settings.set(E.WATCH_SETTING, (o.watch ?? WATCHLIST) as Record<string, unknown>);
  const vars: Record<string, string> = o.contact === null ? {} : { SEC_CONTACT: o.contact ?? CONTACT };
  const deps = { env: env(vars), fetch: web.fetch, now: clock.fn, sleep: clock.sleep, db, whoIs: o.who ?? reader, resolve: o.resolve ?? (async () => ["93.184.216.34"]), pageTimeoutMs: 200 };
  const call = async (body: unknown) => { const res = await fn.handle(req("snl-earnings", body), deps); const type = res.headers.get("content-type") ?? ""; return { status: res.status, res, body: type.includes("json") ? await res.json() : null }; };
  const ids = E.cleanWatchlist(o.watch ?? WATCHLIST).companies.map((c) => c.id);
  return { clock, db, routes, web, deps, call, ids };
}
const cellStates = (r: E.Result) => E.COLS.map((c) => r.cells[c].state);
const docsOf = (r: E.Result, col: E.Col) => r.cells[col].docs.map((id) => r.docs.find((d) => d.id === id)!);

// ---------- logins, roles, the watchlist, not set up ----------
{
  const t = setup({ who: nobody });
  ok("no login: 401 and nothing called", (await t.call({ action: "list" })).status === 401 && t.web.seen.length === 0);
  const r = setup({ contact: null });
  const st = await r.call({ action: "status" });
  ok("status: not set up without SEC_CONTACT, the watchlist's size, the latest ended quarter", st.status === 200 && st.body.configured === false && st.body.companies === 5 && st.body.quarter === "3Q26" && st.body.role === "reader", st.body);
  const list = await r.call({ action: "list" });
  ok("a reader reads the watchlist, as the app cleans it", list.status === 200 && list.body.companies.length === 5 && list.body.companies[0].name === "Calloway Insurance Co" && list.body.configured === false);
  const f = await r.call({ action: "find", company: r.ids[0], quarter: "3Q26" });
  ok("without SEC_CONTACT a find says not set up yet and calls nothing at all", f.status === 503 && f.body.error === "not_configured" && /SEC_CONTACT/.test(f.body.message) && r.web.seen.length === 0, f.body);
  const dl = await r.call({ action: "download", company: r.ids[0], quarter: "3Q26", doc: "d000000000000" });
  ok("nor a download", dl.status === 503 && r.web.seen.length === 0);
  const weird = setup({ contact: "just a name" });
  ok("a SEC_CONTACT with no email address counts as not set", (await weird.call({ action: "find", company: weird.ids[0], quarter: "3Q26" })).body.error === "not_configured" && weird.web.seen.length === 0);
  ok("the contact is never sent to the page", !JSON.stringify(st.body).includes("nonesuch.example") && !JSON.stringify(list.body).includes("test-contact"));
  const chk = await r.call({ action: "check", list: JSON.stringify(WATCHLIST) });
  ok("a reader can't check (edit) the watchlist", chk.status === 403 && chk.body.error === "forbidden");
  const cd = setup({ who: corpdev });
  const c1 = await cd.call({ action: "check", list: JSON.stringify(WATCHLIST.companies) });
  ok("Corp Dev pastes the script's list: checked and given back clean", c1.status === 200 && c1.body.companies.length === 5 && c1.body.problems.length === 0);
  const c2 = await cd.call({ action: "check", list: "{ not json" });
  ok("text that isn't JSON: a plain message saying what to copy", c2.status === 400 && /opening \[/.test(c2.body.message));
  const c3 = await cd.call({ action: "check", list: [{ name: "Calloway Insurance Co", ticker: "CLWY", ir_urls: ["https://127.0.0.1/"] }, { name: "" }] });
  ok("each bad entry gets its own message", c3.status === 200 && c3.body.problems.length === 2 && c3.body.problems[1].dropped === true);
  ok("a pasted list over the size limit is refused", (await cd.call({ action: "check", list: "x".repeat(200_001) })).status === 400);
  ok("checking calls no outside site", cd.web.seen.length === 0);
}

// ---------- one company, the SEC and the investor site ----------
{
  const t = setup();
  const r1 = await t.call({ action: "find", company: t.ids[0], quarter: "3Q26" });
  const res: E.Result = r1.body.result;
  ok("one company a call: only Calloway's hosts and the SEC are asked", r1.status === 200 && r1.body.fromStore === false && t.web.seen.every((s) => isSec(s.url) || s.url.startsWith(IR)), t.web.seen.map((s) => s.url));
  ok("every column found for Calloway", same(cellStates(res), ["found", "found", "found", "found"]), res.cells);
  const tenq = docsOf(res, "10q");
  ok("10-Q: the SEC filing (address without /ix?doc=, filed date) and the site's 10-Q PDF", tenq.length === 2 && tenq.some((d) => d.source === "sec" && d.url === docUrl(CAL.cik, CAL.tenQ, "clwy-20260930.htm") && d.filed === "2026-11-04" && d.type === "10-Q" && d.ext === ".htm" && d.name === "Calloway 3Q26 10-Q")
    && tenq.some((d) => d.source === "ir" && d.name === "Calloway 3Q26 10-Q" && d.ext === ".pdf"), tenq);
  const ek = docsOf(res, "8k");
  ok("8-K: the first results 8-K after quarter end with its EX-99 exhibits, not the 7.01 one or the cover page", same(ek.map((d) => d.type), ["8-K", "EX-99.1", "EX-99.2"]) && ek.every((d) => d.filed === "2026-10-28") && same(ek.map((d) => d.name), ["Calloway 3Q26 8-K", "Calloway 3Q26 8-K Ex 99.1 - PRESS RELEASE", "Calloway 3Q26 8-K Ex 99.2 - FINANCIAL SUPPLEMENT"]), ek.map((d) => [d.type, d.name]));
  const supp = docsOf(res, "supplement"), deck = docsOf(res, "deck");
  ok("supplement: this quarter's Excel and PDF from the quarterly results page (followed from the section page); not the transcript", same(supp.map((d) => d.url.split("/").pop()), ["Q3-2026-Financial-Supplement.xlsx", "Q3-2026-Financial-Supplement.pdf"]) && supp[0].name.startsWith("Calloway 3Q26 Supplement - "), supp);
  ok("presentation: this quarter's deck only, its link noise cleaned", deck.length === 1 && deck[0].title === "Third Quarter 2026 Investor Presentation" && deck[0].name === "Calloway 3Q26 Presentation - Third Quarter 2026 Investor Presentation");
  const asked = t.web.seen.map((s) => s.url);
  ok("links followed by the script's rules: quarterly results yes; press releases, governance, an old year and another site no", asked.includes(`${IR}/financial-information/quarterly-results/default.aspx`) && !asked.some((u) => /press-releases|governance|2024|calloway-cdn/.test(u)));
  ok("an IP-literal or plain-http link on the page is never picked or fetched", !res.docs.some((d) => /169\.254|http:\/\//.test(d.url)) && !asked.some((u) => /169\.254|^http:/.test(u)));
  ok("no file is downloaded while finding: only pages and the SEC's lists", !asked.some((u) => /\.(pdf|xlsx)$/.test(u)));
  const secSeen = t.web.seen.filter((s) => isSec(s.url)), irSeen = t.web.seen.filter((s) => !isSec(s.url));
  ok("every SEC request carries the contact as its User-Agent", secSeen.length === 4 && secSeen.every((s) => s.headers["user-agent"] === CONTACT), secSeen.map((s) => s.url));
  ok("no other request carries it, or any key or cookie", irSeen.length > 0 && irSeen.every((s) => s.headers["user-agent"] !== CONTACT && !JSON.stringify(s.headers).includes("test-contact") && !s.headers.authorization && !s.headers.apikey && !s.headers.cookie), irSeen.map((s) => s.headers));
  const gaps = secSeen.slice(1).map((s, i) => s.at - secSeen[i].at);
  ok("SEC requests are at least 200 ms apart (no more than 5 a second)", gaps.every((g) => g >= 200), gaps);
  ok("the result counts its SEC requests and pages read", res.secRequests === 4 && res.pagesRead === 2 && res.cik === CAL.cik);
  ok("the SEC's tickers file is saved for later calls", !!t.db.store.get(E.TICKERS_ID) && (t.db.store.get(E.TICKERS_ID)!.doc as any).tickers.CLWY === CAL.cik);
  ok("the result is saved under the quarter and company", !!t.db.store.get(E.resultId("3Q26", t.ids[0])) && t.db.store.get(E.resultId("3Q26", t.ids[0]))!.kind === "discover");

  // saved: reopened without asking anyone
  const n = t.web.seen.length;
  const r2 = await t.call({ action: "find", company: t.ids[0], quarter: "Q3 2026" });
  ok("the same company and quarter again: from the store, nobody asked", r2.body.fromStore === true && t.web.seen.length === n && same(r2.body.result, res));
  const sv = await t.call({ action: "saved", quarter: "3Q26" });
  ok("saved: every result kept for the quarter in one call, nobody asked", sv.status === 200 && sv.body.results.length === 1 && sv.body.results[0].company.name === "Calloway Insurance Co" && t.web.seen.length === n);
  // Refresh: asks again; documents seen before keep when they were first seen, a new one is new
  t.clock.now += 3 * 86_400_000;
  t.routes.set(`${IR}/financial-information/quarterly-results/default.aspx`, () => R(`<a href="/files/doc_financials/2026/q3/Q3-2026-Financial-Supplement.pdf">Q3 2026 Financial Supplement</a><a href="/files/doc_financials/2026/q3/Q3-2026-Supplement-Revised.pdf">Q3 2026 Financial Supplement (revised)</a>`));
  const r3 = await t.call({ action: "find", company: t.ids[0], quarter: "3Q26", refresh: true });
  const old = r3.body.result.docs.find((d: E.Doc) => d.url.endsWith("Q3-2026-Financial-Supplement.pdf")), fresh = r3.body.result.docs.find((d: E.Doc) => d.url.endsWith("Revised.pdf"));
  ok("Refresh asks again", r3.body.fromStore === false && t.web.seen.length > n);
  ok("a document seen before keeps when it was first seen; a new one is dated now", old.firstSeen === res.madeAt && fresh.firstSeen === r3.body.result.madeAt && fresh.firstSeen !== old.firstSeen, [old.firstSeen, fresh.firstSeen]);
  ok("the tickers file isn't asked for again within a week", t.web.seen.slice(n).filter((s) => s.url.endsWith("company_tickers.json")).length === 0);
  t.clock.now += 8 * 86_400_000;
  await t.call({ action: "find", company: t.ids[0], quarter: "3Q26", refresh: true });
  ok("after a week it is fetched again", t.web.seen.filter((s) => s.url.endsWith("company_tickers.json")).length === 2);
  // other quarters
  t.routes.set(idx(CAL.cik, "0001999001-26-000030"), () => R(indexPage(CAL.cik, "0001999001-26-000030", [["10-Q", "QUARTERLY REPORT", "clwy-20260630.htm"]])));
  t.routes.set(idx(CAL.cik, CAL.oldEightK), () => R(indexPage(CAL.cik, CAL.oldEightK, [["8-K", "FORM 8-K", "clwy-20260729.htm"], ["EX-99.1", "PRESS RELEASE", "ex991.htm"]])));
  const q2 = await t.call({ action: "find", company: t.ids[0], quarter: "2Q26" });
  ok("another quarter is another result: Q2's 10-Q and 8-K", q2.body.result.quarter === "2Q26" && q2.body.result.cells["8k"].state === "found" && docsOf(q2.body.result, "deck")[0].url.includes("Q2-2026"));
  ok("a quarter that hasn't ended is refused before anything is asked", (await t.call({ action: "find", company: t.ids[0], quarter: "4Q26" })).status === 400 && (await t.call({ action: "find", company: t.ids[0], quarter: "Q5" })).status === 400);
  ok("a company not on the watchlist: 404", (await t.call({ action: "find", company: "e-nothere", quarter: "3Q26" })).body.error === "unknown_company");
}

// ---------- SEC: ticker not found, other tickers, a filing not yet made, the 6-K route, a supplement in the 8-K ----------
{
  const t = setup();
  const nope: E.Result = (await t.call({ action: "find", company: t.ids[4], quarter: "3Q26" })).body.result;
  ok("ticker not found at the SEC: 'no CIK' in both SEC columns, with what to do", nope.cells["10q"].state === "no_cik" && nope.cells["8k"].state === "no_cik" && /Add its CIK/.test(nope.cells["10q"].note!));
  ok("a page with almost no links: nothing found on the pages read, and a note that it may need JavaScript", nope.cells.deck.state === "not_found" && nope.notes.some((n) => /JavaScript/.test(n)));
  const tar: E.Result = (await t.call({ action: "find", company: t.ids[1], quarter: "3Q26" })).body.result;
  ok("other tickers are tried when the first isn't known", tar.cik === 1999002 && t.web.seen.some((s) => s.url.endsWith("CIK0001999002.json")));
  ok("no 10-Q or 8-K yet, within 120 days of the quarter end: not filed yet", tar.cells["10q"].state === "not_filed" && tar.cells["8k"].state === "not_filed");
  const late = setup({ now: "2027-03-01T12:00:00Z" });
  const tl: E.Result = (await late.call({ action: "find", company: late.ids[1], quarter: "3Q26" })).body.result;
  ok("after 120 days: not found at the SEC", tl.cells["10q"].state === "not_found_sec");
  const re: E.Result = (await t.call({ action: "find", company: t.ids[3], quarter: "3Q26" })).body.result;
  ok("a foreign filer: the results 6-K stands for the 8-K, its financial statements for the 10-Q; the AGM 6-K is skipped", docsOf(re, "10q").map((d) => d.name).join() === "Nonesuch Re Ltd 3Q26 6-K Financial Statements" && same(docsOf(re, "8k").map((d) => d.type), ["6-K", "EX-99.1"]) && re.cells["10q"].state === "found" && re.cells["8k"].state === "found", re.docs.map((d) => d.name));
  ok("a company with no investor pages: those columns say none are listed", re.cells.deck.state === "none_listed" && re.cells.supplement.state === "none_listed");
  // a supplement filed as an 8-K exhibit, when the site has none
  const t2 = setup();
  t2.routes.set(`${IR}/financial-information/quarterly-results/default.aspx`, () => R("<p>nothing</p>"));
  const cs: E.Result = (await t2.call({ action: "find", company: t2.ids[0], quarter: "3Q26" })).body.result;
  ok("a supplement filed with the 8-K: 'in the 8-K', pointing at that exhibit", cs.cells.supplement.state === "in_8k" && docsOf(cs, "supplement")[0].type === "EX-99.2");
}

// ---------- SEC busy: the script's patient retry ----------
{
  const t = setup();
  let n = 0;
  const sub = t.routes.get("https://data.sec.gov/submissions/CIK0001999001.json")!;
  t.routes.set("https://data.sec.gov/submissions/CIK0001999001.json", (r) => (++n <= 2 ? R("busy", 503) : sub(r)));
  const res: E.Result = (await t.call({ action: "find", company: t.ids[0], quarter: "3Q26" })).body.result;
  ok("503 twice, then an answer: retried after 3 and 8 seconds, and found", res.cells["8k"].state === "found" && t.clock.slept.includes(3000) && t.clock.slept.includes(8000) && !t.clock.slept.includes(20000));
  const t2 = setup();
  t2.routes.set("https://data.sec.gov/submissions/CIK0001999001.json", () => R("slow down", 429));
  const r2: E.Result = (await t2.call({ action: "find", company: t2.ids[0], quarter: "3Q26" })).body.result;
  ok("busy every time: four tries (3, 8, 20 seconds apart), then an error in the SEC columns saying so", r2.cells["10q"].state === "found" && r2.cells["8k"].state === "error" && /busy/.test(r2.cells["8k"].note!) && t2.web.seen.filter((s) => s.url.includes("CIK0001999001")).length === 4 && [3000, 8000, 20000].every((p) => t2.clock.slept.includes(p)), r2.cells);
  ok("the site's 10-Q PDF still fills the 10-Q column when the SEC fails", r2.cells["10q"].docs.length === 1 && docsOf(r2, "10q")[0].source === "ir");
  const t3 = setup();
  t3.routes.set("https://data.sec.gov/submissions/CIK0001999001.json", () => R("forbidden", 403));
  const r3: E.Result = (await t3.call({ action: "find", company: t3.ids[0], quarter: "3Q26" })).body.result;
  ok("a 403 from the SEC isn't retried, and says to check SEC_CONTACT", r3.cells["8k"].state === "error" && /SEC_CONTACT/.test(r3.cells["8k"].note!) && t3.web.seen.filter((s) => s.url.includes("CIK0001999001")).length === 1);
  const t4 = setup();
  t4.routes.set("https://data.sec.gov/submissions/CIK0001999001.json", () => new Response(null, { status: 302, headers: { location: "https://evil.example/collect" } }));
  const r4: E.Result = (await t4.call({ action: "find", company: t4.ids[0], quarter: "3Q26" })).body.result;
  ok("an SEC answer that redirects elsewhere is not followed, so the contact never leaves the SEC", r4.cells["8k"].state === "error" && !t4.web.seen.some((s) => s.url.includes("evil.example")));
}

// ---------- investor sites: refused, London names, known file addresses ----------
{
  const t = setup();
  const tar: E.Result = (await t.call({ action: "find", company: t.ids[1], quarter: "3Q26" })).body.result;
  ok("a site that refuses (403) or shows a robot check: 'site refused', with the pages to open", tar.cells.deck.state === "refused" && tar.cells.supplement.state === "refused" && same(tar.cells.deck.refused, ["https://ir.tarrow.example/", "https://ir.tarrow.example/results"]) && tar.pages.every((p) => p.outcome === "refused"), tar.cells.deck);
  const lon: E.Result = (await t.call({ action: "find", company: t.ids[2], quarter: "3Q26" })).body.result;
  ok("a London name asks no SEC", lon.london === true && lon.secRequests === 0 && lon.cik === null);
  ok("London: the 8-K column holds the trading update (a web page, matched loosely), labelled", lon.cells["8k"].state === "found" && lon.cells["8k"].kind === "Trading Update" && docsOf(lon, "8k")[0].page === true && docsOf(lon, "8k")[0].url.endsWith("/q3-trading-update"));
  ok("London: the 10-Q column is the report; the half-year interim report isn't the third quarter's", lon.cells["10q"].kind === "Report" && lon.cells["10q"].state === "not_found");
  ok("London presentation found", lon.cells.deck.state === "found");
  ok("a known file address fills in when the pages give nothing: probed, not downloaded whole", lon.cells.supplement.state === "found" && docsOf(lon, "supplement")[0].url === `${NONESUCH}/ir/2026/supp-3q26.pdf` && docsOf(lon, "supplement")[0].title === "supp-3q26");
}

// ---------- safe fetching ----------
{
  const resolve = async (h: string) => h === "rebind.calloway.example" ? ["10.0.0.7"] : ["93.184.216.34"];
  const W = (urls: string[]) => ({ companies: [{ name: "Calloway Insurance Co", ticker: "CLWY", ir_urls: urls.slice(0, 6) }, { name: "Calloway Home Co", sec: false, ir_urls: urls.slice(6) }] });
  const steps: [string, Route][] = [
    [`${IR}/a`, () => new Response(null, { status: 301, headers: { location: "http://investors.calloway.example/b" } })],
    [`${IR}/c`, () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } })],
    [`${IR}/d`, () => new Response(null, { status: 302, headers: { location: "https://rebind.calloway.example/x" } })],
    [`${IR}/e`, () => new Response(null, { status: 302, headers: { location: `${IR}/e` } })],
    [`${IR}/f`, () => new Response(null, { status: 302, headers: { location: "/financial-information/quarterly-results/default.aspx" } })],
    [`${IR}/g`, hang],
    [`${IR}/h`, () => R("x".repeat(E.PAGE_MAX_BYTES + 10))],
    [`${IR}/i`, () => R("small", 200, "text/html", { "content-length": String(E.PAGE_MAX_BYTES + 1) })],
  ];
  const routes = makeRoutes();
  for (const [u, r] of steps) routes.set(u, r);
  const t = setup({ routes, resolve, watch: W(steps.map((s) => s[0])) });
  const res: E.Result = (await t.call({ action: "find", company: t.ids[0], quarter: "3Q26" })).body.result;
  const res2: E.Result = (await t.call({ action: "find", company: t.ids[1], quarter: "3Q26" })).body.result;
  const page = (u: string) => [...res.pages, ...res2.pages].find((p) => p.url === u)!;
  ok("a redirect to http is refused at that hop", page(`${IR}/a`).outcome === "blocked" && /https/.test(page(`${IR}/a`).reason!) && !t.web.seen.some((s) => s.url.startsWith("http:")));
  ok("a redirect to an IP address is refused, and never asked", page(`${IR}/c`).outcome === "blocked" && !t.web.seen.some((s) => s.url.includes("127.0.0.1")));
  ok("a name that resolves to a private address is refused before it is asked", page(`${IR}/d`).outcome === "blocked" && /private/.test(page(`${IR}/d`).reason!) && !t.web.seen.some((s) => s.url.includes("rebind")));
  ok("a redirect loop stops after a few hops", page(`${IR}/e`).outcome === "failed" && /redirects more than/.test(page(`${IR}/e`).reason!) && t.web.seen.filter((s) => s.url === `${IR}/e`).length === E.MAX_REDIRECTS + 1);
  ok("a good redirect is followed, and the page read", page(`${IR}/f`).outcome === "read" && res.cells.supplement.state === "found");
  ok("a page that never answers is given up at the time limit", page(`${IR}/g`).outcome === "failed" && /didn't answer within/.test(page(`${IR}/g`).reason!));
  ok("a page larger than the limit, found while reading or declared, isn't read", /larger than/.test(page(`${IR}/h`).reason!) && /larger than/.test(page(`${IR}/i`).reason!));
  // a hostile entry written straight into the setting is cleaned when read: never fetched
  const t2 = setup({ watch: { companies: [{ name: "Calloway Insurance Co", ticker: "CLWY", ir_urls: ["https://169.254.169.254/latest/", "https://localhost/", "http://x.example/"] }] } });
  await t2.call({ action: "find", company: t2.ids[0], quarter: "3Q26" });
  ok("hostile addresses saved straight into the setting are never fetched", t2.web.seen.every((s) => isSec(s.url)));
  // safeFetch on its own: time limit and headers
  const seen: string[][] = [];
  const f2 = (async (_u: string, init: RequestInit) => { seen.push(Object.keys(init.headers as Record<string, string>)); return hang({ url: "", headers: {}, signal: init.signal! }); }) as unknown as typeof fetch;
  const h = await E.safeFetch("https://slow.nonesuch.example/", { fetch: f2, headers: { "User-Agent": "x" }, timeoutMs: 30 });
  ok("safeFetch: gives up at its time limit and sends only the headers given", !h.ok && h.kind === "timeout" && same(seen, [["User-Agent"]]));
}

// ---------- downloads ----------
{
  const t = setup();
  const res: E.Result = (await t.call({ action: "find", company: t.ids[0], quarter: "3Q26" })).body.result;
  const pick = (f: (d: E.Doc) => boolean) => res.docs.find(f)!;
  const secQ = pick((d) => d.source === "sec" && d.type === "10-Q"), irDeck = docsOf(res, "deck")[0], xl = docsOf(res, "supplement")[0], exPdf = pick((d) => d.type === "EX-99.2");
  const dl = (doc: string, extra = {}) => t.call({ action: "download", company: t.ids[0], quarter: "3Q26", doc, ...extra });
  let n = t.web.seen.length;
  const a = await dl(secQ.id);
  const txt = await a.res.text();
  ok("an SEC filing comes as .htm, with a note and a base address so its images and links load from sec.gov", a.status === 200 && /\.htm"/.test(a.res.headers.get("content-disposition")!) && a.res.headers.get("content-disposition")!.includes('filename="Calloway 3Q26 10-Q.htm"') && txt.startsWith("<!-- Saved by SNL lookup from https://www.sec.gov/") && txt.includes(`<base href="https://www.sec.gov/Archives/edgar/data/${CAL.cik}/000199900126000050/">`) && txt.includes("quarterly report") && txt.includes('<img src="logo.jpg">'), txt.slice(0, 300));
  ok("the SEC download carries the contact; images are not fetched", t.web.seen.slice(n).length === 1 && t.web.seen[n].headers["user-agent"] === CONTACT);
  const b = await dl(exPdf.id);
  ok("an SEC PDF exhibit passes through as .pdf", b.status === 200 && b.res.headers.get("content-type") === "application/pdf" && (await b.res.text()).startsWith("%PDF"));
  n = t.web.seen.length;
  const c = await dl(irDeck.id);
  const cb = new Uint8Array(await c.res.arrayBuffer());
  ok("an investor-site PDF passes through, named as the script names it", c.status === 200 && cb[0] === 0x25 && c.res.headers.get("content-disposition")!.includes("Calloway 3Q26 Presentation - Third Quarter 2026 Investor Presentation.pdf") && t.web.seen[n].headers["user-agent"] !== CONTACT && !!t.web.seen[n].headers.referer);
  const d = await dl(xl.id);
  ok("an Excel supplement passes through as .xlsx", d.status === 200 && /\.xlsx"/.test(d.res.headers.get("content-disposition")!));
  ok("the page can't name an address: one sent is ignored, only the saved document's is fetched", (await dl(irDeck.id, { url: "https://evil.example/x.pdf" })).status === 200 && !t.web.seen.some((s) => s.url.includes("evil")));
  ok("an id that isn't in the saved result: 404", (await dl("d123456789abc")).body.error === "unknown_doc");
  // the source changes under us
  t.routes.set(irDeck.url, () => R("<html>please enable javascript</html>"));
  const e = await dl(irDeck.id);
  ok("a web page where a PDF should be: refused with a plain message", e.status === 415 && e.body.error === "not_file" && /Open it from its link/.test(e.body.message));
  t.routes.set(irDeck.url, () => R("denied", 403));
  const f = await dl(irDeck.id);
  ok("a site that refuses the download: 'refused', open it in your browser", f.status === 502 && f.body.error === "refused" && /browser/.test(f.body.message));
  t.routes.set(irDeck.url, () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "content-type": "application/pdf", "content-length": String(E.DOWNLOAD_MAX_BYTES + 1) } }));
  const g = await dl(irDeck.id);
  ok("a file declared over 60 MB: too big, before anything is passed on", g.status === 413 && g.body.error === "too_big" && /60 MB/.test(g.body.message));
  // a file that turns out too big while streaming: the stream is cut off with an error the page sees
  let sent = 0;
  t.routes.set(irDeck.url, () => new Response(new ReadableStream({ pull(c) { if (sent === 0) c.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46])); else c.enqueue(new Uint8Array(8_000_000)); sent++; } }), { status: 200, headers: { "content-type": "application/pdf" } }));
  const h = await dl(irDeck.id);
  let cut = false;
  try { await h.res.arrayBuffer(); } catch { cut = true; }
  ok("a file that turns out over 60 MB while passing through is cut off, never held whole", h.status === 200 && cut && sent <= 10, sent);
  // a London trading update is a web page: it isn't downloaded
  const lon: E.Result = (await t.call({ action: "find", company: t.ids[2], quarter: "3Q26" })).body.result;
  const w = await t.call({ action: "download", company: t.ids[2], quarter: "3Q26", doc: docsOf(lon, "8k")[0].id });
  ok("a web page on the company's site isn't passed through: open it from its link", w.status === 400 && w.body.error === "web_page");
}

done();
