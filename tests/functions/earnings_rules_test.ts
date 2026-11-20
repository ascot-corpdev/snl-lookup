// The earnings rules ported from the owner's desktop script, each with made-up cases that pass and fail it: quarter
// parsing; quarter matching (strict, loose for London names, the fourth quarter's words, results months); link labels;
// the section-folder rule; the file-name-first rule; generic "Download" links; the exclusion words; known file
// addresses; the SEC's 10-Q, 10-K and 20-F by report date and the 8-K window; filing index pages; the file names the
// script gives; safe addresses; and the watchlist as pasted from the script, entry by entry, hostile entries included.
// Every company, ticker, CIK and address here is made up.
import * as E from "../../supabase/functions/_shared/earnings.ts";
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const F = (url: string, label: string, over: Partial<E.Found> = {}): E.Found => ({ url, label, via: "", generic: false, ...over });
const picked = (files: E.Found[], t: E.DocType, q: number, y: number) => [...E.pick(files, t, q, y).keys()];
const SITE = "https://investors.calloway.example";

// ---------- quarters ----------
{
  ok("3Q26, Q3 2026, q3-26 and 2026Q3 all read as the third quarter of 2026", ["3Q26", "Q3 2026", "q3-26", "2026Q3", " 3q2026 ", "Q3-2026"].every((t) => same(E.parseQuarter(t), { q: 3, y: 2026 })));
  ok("a quarter outside 1 to 4, a bare year or words don't read", [null, "", "5Q26", "Q0 2026", "2026", "third quarter", "3Q", 42, "3Q026", "Q3 2026 extra"].every((t) => E.parseQuarter(t) === null));
  ok("as in the script, spaces are dropped first, so 'Q3 26 26' reads as 2626 (a quarter that hasn't ended, which the function refuses)", same(E.parseQuarter("Q3 26 26"), { q: 3, y: 2626 }));
  ok("quarter names and ends as the script writes them", E.quarterName(3, 2026) === "3Q26" && E.quarterName(1, 2030) === "1Q30" && E.quarterEnd(2, 2026) === "2026-06-30" && E.quarterEnd(4, 2025) === "2025-12-31");
  ok("the latest ended quarter: 19 Nov 2026 is 3Q26; 15 Jan 2027 is 4Q26; 1 Apr 2026 is 1Q26", same(E.lastEndedQuarter(Date.parse("2026-11-19T12:00:00Z")), { q: 3, y: 2026 }) && same(E.lastEndedQuarter(Date.parse("2027-01-15T00:00:00Z")), { q: 4, y: 2026 }) && same(E.lastEndedQuarter(Date.parse("2026-04-01T00:00:00Z")), { q: 1, y: 2026 }));
}

// ---------- matches_quarter ----------
{
  const m = (label: string, url = SITE + "/x.pdf", q = 3, y = 2026) => E.matchesQuarter(label, url, q, y);
  ok("named quarters match: Q3 2026, 3Q26, 2026 Q3, third quarter of 2026", ["Q3 2026 Financial Supplement", "3Q26 supplement", "2026 Q3 slides", "Third Quarter of 2026 Results", "Third quarter 2026 deck", "3Q_2026"].every((l) => m(l)));
  ok("the period end matches: 30 September 2026, Sep 30 2026, 26-09-30", m("Results for the period ended 30 September 2026") && m("Sep 30, 2026 investor deck") && m("deck", SITE + "/files/calloway-26-09-30.pdf"));
  ok("an address with the quarter in its folders matches", m("Download", SITE + "/2026/q3/supplement.pdf") && m("Download", SITE + "/docs/2026/Q3/deck.pdf"));
  ok("another quarter or year doesn't: Q2 2026, Q3 2025, 3Q25, Q3 2027", ["Q2 2026 supplement", "Q3 2025 supplement", "3Q25 deck", "Q3 2027 deck", "Second quarter 2026"].every((l) => !m(l)));
  ok("Q3 2026 isn't read inside other numbers (Q32026 is, 2Q3 2026 isn't)", m("Q32026 deck") && !m("12Q3 2026x") === true);
  ok("with no quarter named, the results month and year count (October or November 2026 for a third quarter)", m("Financial Supplement November 2026") && m("Investor presentation, 29 Oct 2026") && !m("Investor presentation, August 2026"));
  ok("results months for the fourth quarter are January and February of the next year", E.matchesQuarter("Investor presentation February 2027", SITE + "/a.pdf", 4, 2026) && !E.matchesQuarter("Investor presentation February 2026", SITE + "/a.pdf", 4, 2026));
  ok("a named other quarter beats a results month: Q2 2026 results, October 2026", !m("Q2 2026 results presentation, October 2026"));
  ok("second quarter: H1 2026, half year 2026, interim 2026, six months to June 2026", ["H1 2026 results", "Half year results 2026", "Interim results 2026", "Six months ended 30 June 2026", "HY26 deck"].every((l) => E.matchesQuarter(l, SITE + "/a.pdf", 2, 2026)) && !E.matchesQuarter("H1 2025 results", SITE + "/a.pdf", 2, 2026));
  ok("fourth quarter: FY26, full year 2026, year ended 31 December 2026, preliminary results 2026, annual report 2026", ["FY26 results", "Full year 2026 results", "Results for the year ended 31 December 2026", "Preliminary results 2026", "Annual Report 2026", "Report and accounts 2026", "2026 Annual Report"].every((l) => E.matchesQuarter(l, SITE + "/a.pdf", 4, 2026)) && !E.matchesQuarter("Full year 2025 results", SITE + "/a.pdf", 4, 2026));
  ok("third quarter: nine months to 30 September 2026", m("Nine months ended 30 September 2026 statements"));
  ok("percent-encoded addresses are read decoded", m("Download", SITE + "/files/Q3%202026%20Supplement.pdf"));
}

// ---------- matches_quarter_loose (London names) ----------
{
  const u = SITE + "/investors/2026/trading-update.pdf";
  ok("a London 'Q3 Trading Update' under a 2026 address: not by the strict rule, yes by the loose one", !E.matchesQuarter("Q3 Trading Update", u, 3, 2026) && E.matchesQuarterLoose("Q3 Trading Update", u, 3, 2026));
  ok("loose: the word for the quarter is needed, and the year", !E.matchesQuarterLoose("Trading Update", u, 3, 2026) && !E.matchesQuarterLoose("Q3 Trading Update", SITE + "/investors/trading-update.pdf", 3, 2026));
  ok("loose: another quarter's words rule it out (Q3 and half year together)", !E.matchesQuarterLoose("Q3 Trading Update and half year", u, 3, 2026));
  ok("loose: 'Interim management statement' under 2026 is the second quarter, not the third", E.matchesQuarterLoose("Interim management statement", u, 2, 2026) && !E.matchesQuarterLoose("Interim management statement", u, 3, 2026));
  ok("loose: underscores count as spaces (Q3_Trading_Update_2026)", E.matchesQuarterLoose("Download", SITE + "/x/Q3_Trading_Update_2026_final.pdf", 3, 2026));
}

// ---------- too_old, link_ext, url_stem, clean_label ----------
{
  ok("too old: a page naming only 2024 is skipped for 2026; one naming 2026, or no year, isn't", E.tooOld("2024 results", SITE + "/results/2024", 2026) && !E.tooOld("Results 2026", SITE + "/results/2024-2026", 2026) && !E.tooOld("Quarterly results", SITE + "/results", 2026));
  ok("link_ext: .pdf, .xlsx, .xls from the address; a known download folder or format=pdf is 'unknown'; a page is null",
    E.linkExt(SITE + "/a/Deck.PDF") === ".pdf" && E.linkExt(SITE + "/a/supp.xlsx?v=2") === ".xlsx" && E.linkExt(SITE + "/a/supp.xls") === ".xls" &&
    E.linkExt(SITE + "/static-files/0a1b2c3d") === "unknown" && E.linkExt(SITE + "/files/doc_financials/2026/q3/x") === "unknown" && E.linkExt(SITE + "/download?id=4&format=PDF") === "unknown" && E.linkExt(SITE + "/events/default.aspx") === null);
  ok("url_stem: the last meaningful part, without default.aspx or index.html", E.urlStem(SITE + "/news-details/2026/Calloway-third-quarter-results/default.aspx") === "Calloway-third-quarter-results" && E.urlStem(SITE + "/x/Q3_2026_Supplement.pdf") === "Q3 2026 Supplement" && E.urlStem(SITE + "/") === "investors.calloway.example");
  ok("clean_label: a bare Download or PDF becomes the file's name", E.cleanLabel("Download", SITE + "/x/Q3_2026_Supplement.pdf") === "Q3 2026 Supplement" && E.cleanLabel("  PDF ", SITE + "/x/deck-3q26.pdf") === "deck-3q26" && E.cleanLabel("", SITE + "/x/a.pdf") === "a");
  ok("clean_label: noise like 'opens in a new window' and 'PDF file' goes", E.cleanLabel("Third Quarter 2026 Investor Presentation (opens in a new window), PDF file", SITE + "/a.pdf") === "Third Quarter 2026 Investor Presentation");
  ok("clean_label: a short label, or one with no number under 25 characters, gains the file's name", E.cleanLabel("Slides", SITE + "/x/3Q26-deck.pdf") === "Slides 3Q26-deck" && E.cleanLabel("Statistical Supplement", SITE + "/x/s.pdf") === "Statistical Supplement s");
}

// ---------- pick: supplements ----------
{
  const files = [
    F(SITE + "/files/doc_financials/2026/q3/Q3-2026-Financial-Supplement.pdf", "Q3 2026 Financial Supplement"),
    F(SITE + "/files/2026/Q3-2026-Financial-Supplement.xlsx", "Financial Supplement (Excel) Q3 2026"),
    F(SITE + "/files/2026/Q2-2026-Financial-Supplement.pdf", "Q2 2026 Financial Supplement"),
    F(SITE + "/files/2026/Q3-2026-Earnings-Call-Transcript.pdf", "Q3 2026 Earnings Call Transcript supplement"),
    F(SITE + "/files/2026/Q3-2026-Supplement.docx", "Q3 2026 Supplement (Word)"),
    F(SITE + "/files/2026/esg-supplement-q3-2026.pdf", "ESG supplement Q3 2026"),
    F(SITE + "/Archives/0001999001-26-000123.pdf", "Q3 2026 supplement 0001999001-26-000123"),
  ];
  ok("supplements: this quarter's PDF and Excel; not another quarter, a transcript, a Word file, an ESG one or an SEC accession copy", same(picked(files, "supplement", 3, 2026), [files[0].url, files[1].url]), picked(files, "supplement", 3, 2026));
  ok("Excel files are supplements only, never presentations", !picked([files[1]], "deck", 3, 2026).length);
  // section folder names: 'Results_Report_Presentations' and 'events-and-presentations' only name the section
  const inSection = F(SITE + "/Results_Report_Presentations/2026/q3-2026-financial-supplement.pdf", "Download q3-2026-financial-supplement");
  const inSection2 = F(SITE + "/events-and-presentations/q3-2026-statistical-supplement.pdf", "Statistical supplement Q3 2026");
  const inDecks = F(SITE + "/presentations/q3-2026-financial-supplement.pdf", "Q3 2026 financial supplement");
  ok("a supplement inside a 'Results_Report_Presentations' or 'events-and-presentations' folder is still a supplement", same(picked([inSection, inSection2], "supplement", 3, 2026), [inSection.url, inSection2.url]));
  ok("but a plain '/presentations/' folder is not a section name, so the word excludes it", !picked([inDecks], "supplement", 3, 2026).length);
  ok("excl_hay leaves the section folders out and keeps the rest", E.exclHay(inSection) === "Download q3-2026-financial-supplement investors.calloway.example/2026/q3-2026-financial-supplement.pdf?" && E.exclHay(F(SITE + "/press-releases/x.pdf", "x")).includes("/x.pdf") && !E.exclHay(F(SITE + "/press-releases/x.pdf", "x")).includes("press-releases"));
  ok("a 'unknown' download link (static files) can be a supplement", same(picked([F(SITE + "/static-files/9f8e7d", "Q3 2026 Financial Supplement")], "supplement", 3, 2026), [SITE + "/static-files/9f8e7d"]));
}

// ---------- pick: presentations, the file-name-first rule and generic links ----------
{
  const namedDeck = F(SITE + "/files/Calloway-Q2-2026-Investor-Presentation.pdf", "Presentation of Q2 2026 Press Release");
  ok("file name first: a file named '...Investor-Presentation...pdf' is a deck though its link says 'Press Release'", same(picked([namedDeck], "deck", 2, 2026), [namedDeck.url]));
  const release = F(SITE + "/files/Calloway-Q2-2026-Press-Release.pdf", "Presentation of Q2 2026 Press Release");
  ok("without the file name, 'press release' in the link excludes it", !picked([release], "deck", 2, 2026).length);
  const decks = [
    F(SITE + "/files/3q26-earnings-presentation.pdf", "Third Quarter 2026 Earnings Presentation"),
    F(SITE + "/files/3q26-slides.pdf", "3Q26 Slides"),
    F(SITE + "/files/3q26-call-transcript.pdf", "Third Quarter 2026 Presentation transcript"),
    F(SITE + "/files/3q26-presentation-replay.pdf", "Q3 2026 presentation replay"),
    F(SITE + "/files/2025-investor-day.pdf", "Investor Day 2025"),
    F(SITE + "/files/q3-2026-supplement.pdf", "Q3 2026 financial supplement and presentation"),
  ];
  ok("presentations: this quarter's deck and slides; not a transcript, a replay, an old investor day or the supplement", same(picked(decks, "deck", 3, 2026), [decks[0].url, decks[1].url]), picked(decks, "deck", 3, 2026));
  const bare = F(SITE + "/static-files/1a2b3c", "1a2b3c", { generic: true, via: "Third Quarter 2026 Investor Presentation" });
  ok("a bare 'Download' link on a deck's own page takes the page's title, and is picked", same([...E.pick([bare], "deck", 3, 2026)], [[bare.url, "Third Quarter 2026 Investor Presentation"]]));
  const section = F(SITE + "/static-files/4d5e6f", "4d5e6f", { generic: true, via: "Reports, Presentations and Webinars Q3 2026" });
  const section2 = F(SITE + "/static-files/4d5e70", "4d5e70", { generic: true, via: "Q3 2026 Results & Presentation" });
  ok("but not on a section page such as 'Reports, Presentations and Webinars', or one with '&'", !picked([section, section2], "deck", 3, 2026).length);
  ok("a generic link whose page names another quarter isn't picked", !picked([F(SITE + "/static-files/7a", "7a", { generic: true, via: "Second Quarter 2026 Investor Presentation" })], "deck", 3, 2026).length);
  ok("a link that wasn't generic doesn't borrow the page's title", !picked([F(SITE + "/static-files/7b", "Webcast", { via: "Third Quarter 2026 Investor Presentation" })], "deck", 3, 2026).length);
  ok("a London 'Results for the six months ended' document is excluded as a deck (it's a release)", !picked([F(SITE + "/f/hy-2026.pdf", "Results for the six months ended 30 June 2026 presentation")], "deck", 2, 2026).length);
}

// ---------- pick: the fourth quarter's keywords (10-K), London reports and releases ----------
{
  const tenK = F(SITE + "/files/form-10-k-2026.pdf", "Form 10-K 2026 annual report on form 10-K, full year 2026");
  const tenQ = F(SITE + "/files/form-10-q-q3-2026.pdf", "Form 10-Q Q3 2026");
  ok("a 10-Q PDF on the site counts for the third quarter; a 10-K doesn't", same(picked([tenK, tenQ], "10q", 3, 2026), [tenQ.url]));
  ok("for the fourth quarter the 10-K keywords are used instead", same(picked([tenK, tenQ], "10q", 4, 2026), [tenK.url]));
  ok("an amended 10-Q (10-Q/A) isn't picked by its link text", !picked([F(SITE + "/files/amended-quarterly-filing-q3-2026.pdf", "Form 10-Q/A Q3 2026")], "10q", 3, 2026).length);
  ok("but, as in the script, the file-name-first rule takes a file named form-10-q-a (the /A is only seen in text)", picked([F(SITE + "/files/form-10-q-a-q3-2026.pdf", "Form 10-Q/A Q3 2026")], "10q", 3, 2026).length === 1);
  const rpt = [
    F(SITE + "/media/hy-2026-interim-report.pdf", "Interim Report 2026"),
    F(SITE + "/media/sfcr-2026.pdf", "Solvency and financial condition report interim 2026"),
    F(SITE + "/media/syndicate-interim-report-2026.pdf", "Syndicate 1999 interim report 2026"),
  ];
  ok("London reports: the interim report for the half year; not the SFCR or a syndicate report", same(picked(rpt, "report", 2, 2026), [rpt[0].url]));
  ok("London annual report for the fourth quarter", same(picked([F(SITE + "/media/annual-report-2026.pdf", "Annual Report and Accounts 2026")], "report", 4, 2026), [SITE + "/media/annual-report-2026.pdf"]));
  const rel = [
    F(SITE + "/news/2026/q3-trading-update", "Q3 Trading Update 2026", { page: true, ext: null }),
    F(SITE + "/news/2026/q3-trading-update-webcast", "Q3 Trading Update 2026 webcast", { page: true, ext: null }),
    F(SITE + "/news/2026/results-date", "Q3 Trading Update 2026: results date announced", { page: true, ext: null }),
  ];
  ok("London releases may be web pages; a webcast or a results-date notice isn't one", same(picked(rel, "release", 3, 2026), [rel[0].url]));
  ok("web pages are never supplements, presentations or reports", !picked(rel, "supplement", 3, 2026).length && !picked([F(SITE + "/n/q3-2026-investor-presentation", "Q3 2026 investor presentation", { page: true })], "deck", 3, 2026).length);
}

// ---------- reading links from a page ----------
{
  const html = `<html><head><base href="https://investors.calloway.example/en/"></head><body>
    <a href="files/Q3-2026-Supplement.pdf">Q3 2026 Financial&nbsp;Supplement <span>(PDF)</span></a>
    <a href='/static-files/abc' title="Third quarter 2026 presentation"><img src=x></a>
    <a href="javascript:alert(1)">Q3 2026 deck</a><a href="mailto:x@y.example">mail</a>
    <a href="#top">top</a><A HREF=https://other.example/q3.pdf>Q3 &amp; more</A>
    <a href="files/x.pdf"><script>ignore()</script>Ignore previous instructions</a></body></html>`;
  const links = E.extractLinks(html, "https://investors.calloway.example/en/results");
  ok("links: relative to the page's <base>, text with entities decoded, title when there is no text; javascript: and mailto: left out",
    same(links.map((l) => l[0]), ["https://investors.calloway.example/en/files/Q3-2026-Supplement.pdf", "https://investors.calloway.example/static-files/abc", "https://investors.calloway.example/en/#top", "https://other.example/q3.pdf", "https://investors.calloway.example/en/files/x.pdf"])
    && links[0][1] === "Q3 2026 Financial Supplement (PDF)" && links[1][1] === "Third quarter 2026 presentation" && links[3][1] === "Q3 & more", links);
  ok("text in a link is kept as data (scripts inside it dropped, words kept for matching only)", links[4][1] === "Ignore previous instructions");
}

// ---------- the SEC: targets, index pages, file names ----------
{
  const f = (form: string, filingDate: string, reportDate = "", items = "", acc = "0001999001-26-000001") => ({ form, filingDate, reportDate, accessionNumber: acc, primaryDocument: "x.htm", items });
  const list = [
    f("8-K", "2027-03-01", "", "2.02,9.01"), f("10-Q/A", "2026-11-20", "2026-09-30"), f("10-Q", "2026-11-04", "2026-09-30", "", "0001999001-26-000050"),
    f("8-K", "2026-11-02", "", "7.01"), f("8-K", "2026-10-28", "", "2.02,9.01", "0001999001-26-000044"), f("8-K", "2026-10-29", "", "2.02"),
    f("8-K", "2026-09-30", "", "2.02"), f("10-Q", "2026-08-01", "2026-06-30"), f("10-K", "2026-02-20", "2025-12-31", "", "0001999001-26-000010"),
  ];
  const t = E.edgarTargets(list, 3, 2026, ["10q", "8k"]);
  ok("the 10-Q is the one whose report date is the quarter end (not the amendment)", t["10q"]?.accessionNumber === "0001999001-26-000050");
  ok("the 8-K is the first with item 2.02 filed after the quarter end", t["8k"]?.accessionNumber === "0001999001-26-000044" && t["8k"]?.filingDate === "2026-10-28");
  ok("an 8-K filed on the quarter end itself, or without item 2.02, isn't it", E.edgarTargets([list[6], list[3]], 3, 2026, ["8k"])["8k"] === undefined);
  ok("the 8-K window ends 120 days after the quarter end (28 Jan 2027 for 3Q26)", E.edgarTargets([f("8-K", "2027-01-28", "", "2.02")], 3, 2026, ["8k"])["8k"]?.filingDate === "2027-01-28" && E.edgarTargets([f("8-K", "2027-01-29", "", "2.02")], 3, 2026, ["8k"])["8k"] === undefined);
  ok("the fourth quarter takes the 10-K by its report date", E.edgarTargets(list, 4, 2025, ["10q"])["10q"]?.form === "10-K");
  ok("and a foreign filer's 20-F for the fourth quarter", E.edgarTargets([f("20-F", "2027-03-30", "2026-12-31")], 4, 2026, ["10q"])["10q"]?.form === "20-F");
  ok("a 20-F never stands for a third quarter", E.edgarTargets([f("20-F", "2026-11-30", "2026-09-30")], 3, 2026, ["10q"])["10q"] === undefined);
  const idx = `<table class="tableFile" summary="Document Format Files"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
    <tr class="blueRow"><td>1</td><td>FORM 8-K</td><td><a href="/ix?doc=/Archives/edgar/data/1999001/000199900126000044/clw-20261028.htm">clw-20261028.htm</a></td><td>8-K</td><td>40000</td></tr>
    <tr><td>2</td><td>PRESS RELEASE &amp; RESULTS</td><td><a href="/Archives/edgar/data/1999001/000199900126000044/ex991.htm">ex991.htm</a></td><td>EX-99.1</td><td>90000</td></tr>
    <tr><td>3</td><td>Financial Supplement</td><td><a href="/Archives/edgar/data/1999001/000199900126000044/ex992.pdf">ex992.pdf</a></td><td>EX-99.2</td><td>1</td></tr>
    <tr><td>4</td><td>elsewhere</td><td><a href="https://other.example/x.htm">x</a></td><td>EX-99.3</td><td>1</td></tr></table>
    <table class="tableFile" summary="Data Files"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
    <tr><td>5</td><td>XBRL SCHEMA</td><td><a href="/Archives/edgar/data/1999001/000199900126000044/clw.xsd">clw.xsd</a></td><td>EX-101.SCH</td><td>1</td></tr></table>`;
  const rows = E.parseFilingIndex(idx);
  ok("an index page: each document's type, description and address; /ix?doc= taken off; another host left out",
    same(rows.map((r) => r[0]), ["8-K", "EX-99.1", "EX-99.2", "EX-101.SCH"]) && rows[0][2] === "https://www.sec.gov/Archives/edgar/data/1999001/000199900126000044/clw-20261028.htm" && rows[1][1] === "PRESS RELEASE & RESULTS", rows);
  ok("SEC file names as the script writes them", E.secPart("8-K", "8-K", "FORM 8-K") === "8-K" && E.secPart("8-K", "EX-99.1", "PRESS RELEASE") === "8-K Ex 99.1 - PRESS RELEASE" && E.secPart("8-K", "ex-99.2", "EX-99.2") === "8-K Ex 99.2" && E.secPart("6-K Financial Statements", "EX-99.2", "x") === "6-K Financial Statements" && E.secPart("10-Q", "10-Q", "QUARTERLY REPORT") === "10-Q");
  ok("investor-site kinds as the script names them", E.irKind("report", 2) === "Interim Report" && E.irKind("report", 4) === "Annual Report" && E.irKind("report", 3) === "Report" && E.irKind("release", 4) === "Results Release" && E.irKind("release", 3) === "Trading Update" && E.irKind("10q", 4) === "10-K" && E.irKind("deck", 3) === "Presentation");
  ok("safe_name takes out what Windows refuses and control characters", E.safeName('Cal<lo>way: "Q3"/2026\\a|b?c*\u0000\n', 60) === "Cal lo way Q3 2026 a b c" && E.safeName("x".repeat(200), 150).length === 150);
  ok("known file addresses: {q}, {yy} and {yyyy} filled as the script does", E.fillTemplate("https://www.nonesuch.example/ir/{yyyy}/supp-{q}q{yy}.pdf", 3, 2026) === "https://www.nonesuch.example/ir/2026/supp-3q26.pdf");
}

// ---------- safe addresses ----------
{
  const bad = ["http://investors.calloway.example/", "https://127.0.0.1/", "https://10.0.0.5/x", "https://[::1]/", "https://2130706433/", "https://0x7f.1/", "https://localhost/", "https://printer.local/", "https://wiki.internal/x", "https://intranet/x",
    "https://user:pw@investors.calloway.example/", "https://investors.calloway.example:8443/", "javascript:alert(1)", "file:///etc/passwd", "ftp://x.example/", "", "https://x.example/" + "a".repeat(600), "https://a.localhost/", "https://router.home.arpa/"];
  ok("every hostile kind of address is refused, each with a reason", bad.every((u) => typeof E.checkUrl(u) === "string"), bad.filter((u) => !E.checkUrl(u)));
  ok("an ordinary https address passes, with or without a trailing dot", E.checkUrl("https://investors.calloway.example/events-and-presentations/default.aspx") === null && E.checkUrl("https://ir.nonesuch.example./") === null);
  ok("private, local and reserved IP answers are spotted; public ones aren't", ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1"].every(E.privateIp) && !["93.184.216.34", "2606:2800:220:1::1", "8.8.8.8"].some(E.privateIp));
}

// ---------- the watchlist, as pasted from the script ----------
{
  const pasted = { quarter: "3Q26", companies: [
    { name: "Calloway Insurance Co", ticker: "clwy", ir_urls: [SITE + "/events-and-presentations/default.aspx", SITE + "/financial-information/quarterly-results/default.aspx"] },
    { name: "Tarrow Mutual", ticker: "TRWM", other_tickers: ["TRWX"], ir_urls: ["https://ir.tarrow.example/"], folder: "Tarrow/Mutual" },
    { name: "Nonesuch Holdings plc", sec: false, ir_urls: ["https://www.nonesuch.example/investors/results"], file_urls: { deck_q2: ["https://www.nonesuch.example/ir/{yyyy}/hy-results-{yyyy}.pdf"], deck_q4: ["https://www.nonesuch.example/ir/{yyyy}/full-year-results-{yyyy}.pdf"] } },
    { name: "Nonesuch Re Ltd", cik: "0001999777", ir_urls: [] },
  ] };
  const r = E.cleanWatchlist(pasted);
  ok("the script's whole config is read: four companies, no problems", r.companies.length === 4 && r.problems.length === 0, r.problems);
  const [a, b, c, d] = r.companies;
  ok("fields are taken from the script's names: ticker in capitals, other tickers, investor pages, folder made safe", a.ticker === "CLWY" && a.irUrls.length === 2 && a.sec === true && same(b.otherTickers, ["TRWX"]) && b.folder === "Tarrow Mutual");
  ok("a London name keeps sec: false and its known file addresses by quarter", c.sec === false && same(Object.keys(c.fileUrls), ["deck_q2", "deck_q4"]));
  ok("a CIK is kept without its leading zeros", d.cik === "1999777");
  ok("each company has a stable id from its name", a.id === E.companyId("Calloway Insurance Co") && E.cleanWatchlist(pasted).companies[0].id === a.id && new Set(r.companies.map((x) => x.id)).size === 4);
  ok("the bare companies list and the app's own field names read the same", same(E.cleanWatchlist(pasted.companies).companies, r.companies) && same(E.cleanWatchlist({ companies: r.companies }).companies, r.companies));
  const hostile = E.cleanWatchlist([
    { name: "Calloway Insurance Co", ticker: "CLWY", ir_urls: ["http://plain.example/", "https://169.254.169.254/latest/meta-data/", "https://localhost/admin", "https://ok.calloway.example/ir"] },
    { name: "calloway insurance co", ticker: "X" },
    { ticker: "NONAME" },
    "Tarrow Mutual",
    { name: "<img src=x onerror=alert(1)>", ticker: "DROP TABLE;", cik: "12345678901", ir_urls: "https://ok.tarrow.example/" },
    { name: "Nonesuch Templates", sec: false, ir_urls: ["https://ok.nonesuch.example/"], file_urls: { supplement: ["https://ok.nonesuch.example/{yyyy}/{secret}.pdf", "http://ok.nonesuch.example/{q}.pdf", "https://ok.nonesuch.example/{yyyy}/s{q}.pdf"], transcript: ["https://ok.nonesuch.example/t.pdf"] } },
    { name: "Nonesuch Nothing", sec: false },
    { name: "Nonesuch No Ticker" },
    { name: "Nonesuch‮\u0007 Controls", ticker: "NCTL" },
  ]);
  const msgs = (n: number) => hostile.problems.filter((p) => p.at === n).map((p) => p.message);
  ok("bad investor addresses are left out one by one, each named; the good one stays", same(hostile.companies[0].irUrls, ["https://ok.calloway.example/ir"]) && msgs(1).length === 3 && msgs(1).every((m) => /can't be used/.test(m)), msgs(1));
  ok("a repeated name, a missing name and a bare string are each left out with a message", msgs(2)[0] === "A company of the same name is already on the list." && msgs(3)[0] === "It has no name." && /isn't a company/.test(msgs(4)[0]) && hostile.problems.filter((p) => p.dropped).length === 3);
  const h5 = hostile.companies.find((x) => x.name.startsWith("<img"))!;
  ok("hostile text is kept as plain text (escaped where shown); a bad ticker and CIK are dropped with messages", !!h5 && h5.ticker === null && h5.cik === null && same(h5.irUrls, ["https://ok.tarrow.example/"]) && msgs(5).some((m) => /ticker/.test(m)) && msgs(5).some((m) => /CIK/.test(m)), msgs(5));
  const h6 = hostile.companies.find((x) => x.name === "Nonesuch Templates")!;
  ok("known file addresses: unknown placeholders, http and unknown kinds are left out", same(h6.fileUrls, { supplement: ["https://ok.nonesuch.example/{yyyy}/s{q}.pdf"] }) && msgs(6).length === 3, msgs(6));
  ok("a company that can't be found anywhere is kept with a message saying what to add", /lists no investor pages/.test(msgs(7)[0]) && /no ticker or CIK/.test(msgs(8)[0]));
  ok("control and direction characters are taken out of names", hostile.companies.some((x) => x.name === "Nonesuch Controls"));
  ok("not a list: one message, nothing loaded", E.cleanWatchlist("nonsense").companies.length === 0 && E.cleanWatchlist("nonsense").problems.length === 1 && E.cleanWatchlist({ quarter: "3Q26" }).problems[0].message.includes('"companies"') && same(E.cleanWatchlist(null), { companies: [], problems: [] }));
  const many = E.cleanWatchlist(Array.from({ length: 70 }, (_, i) => ({ name: `Nonesuch ${i} Co`, ticker: `NS${i}` })));
  ok(`at most ${E.MAX_COMPANIES} companies; the rest are named as left out`, many.companies.length === E.MAX_COMPANIES && many.problems.length === 10 && many.problems.every((p) => p.dropped));
}

done();
