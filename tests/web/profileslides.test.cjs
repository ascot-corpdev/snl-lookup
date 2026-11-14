// SNLProfile (web/profile-slides.js): turns a company's figures and slide text into the slide plan SNLDeck draws.
// Runs plan and spec in a blank Chromium page on made-up fixtures (tests/fixtures/profile_facts.json) and variants
// derived here: slides left out with plain reasons, the cover and questions always present, the sample marker,
// Claude's note, number formats, title trimming, adverse figures in magenta, empty filings worded as S&P's answer,
// everything inside the content area, hostile text kept as text, and a full build on the stand-in template.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/profile_facts.json"), "utf8"));
const copy = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 600)); } };
const MAG = "EB008C";
const IDS = ["cover", "summary", "premium", "underwriting", "capital", "reserves", "reinsurance", "filings", "questions"];

// ----- variants of the fixture -----
function missingReserves() {
  const v = copy(BASE); delete v.facts.series.net_reserves; delete v.facts.series.pyd;
  ["reserves_to_npe", "reserves_to_surplus", "pyd_to_prior_surplus"].forEach(k => delete v.facts.derived[k]);
  v.facts.missing = [{ field: "net_reserves", label: "Net loss and LAE reserves", reason: "not mapped" }];
  return v;
}
function thin() {
  const v = copy(BASE); v.facts.years = [2024, 2025];
  v.facts.series = { surplus: [52600000, 61300000], combined_ratio: [97.1, 93.4] }; v.facts.derived = {};
  delete v.facts.mix; delete v.facts.reinsurers;
  v.facts.missing = [{ field: "dpw_by_line", label: "Direct premiums by line", reason: "not mapped" }, { field: "npw_by_line", label: "Net premiums by line", reason: "not mapped" },
    { field: "net_reserves", label: "Net loss and LAE reserves", reason: "no value" }];
  v.facts.filings = { unavailable: "The filings search isn't set up yet." };
  return v;
}
function nothing() { const v = copy(BASE); v.facts.years = []; v.facts.series = {}; v.facts.derived = {}; delete v.facts.mix; delete v.facts.reinsurers; v.facts.missing = []; return v; }
function noFilings() { const v = copy(BASE); v.facts.filings = { from: "2025-11-14", to: "2026-11-13", total: 0, capped: false, byType: [], byState: [], rows: [] }; return v; }
function group() { const v = copy(BASE); v.facts.entity = { kind: "group", code: "9001", name: "Calloway Group", groupName: "Calloway Group", naicGroupCode: "9001" }; return v; }
function sampleClaude() { const v = copy(BASE); v.facts.sample = true; v.text.by = "claude"; return v; }
const LONG = n => { let s = "", i = 0; const w = ["Florida", "homeowners", "growth", "surplus", "reinsurance", "recoverables", "premium", "development"]; while (s.length < n) s += (s ? " " : "") + w[i++ % w.length]; return s; };
function maxText() {
  const v = sampleClaude(); v.text.cover.subtitle = LONG(110).slice(0, 110);
  ["summary", "premium", "underwriting", "capital", "reserves", "reinsurance", "filings"].forEach(k => {
    v.text[k].title = LONG(65).slice(0, 65); v.text[k].points = Array.from({ length: k === "summary" ? 7 : 4 }, (_, i) => ({ lead: "Lead number " + (i + 1) + " is long", text: LONG(220).slice(0, 220) }));
  });
  v.text.questions.items = Array.from({ length: 4 }, () => ({ title: LONG(60).slice(0, 60), text: LONG(260).slice(0, 260) }));
  return v;
}
const EVIL = '<script>window.__xss=1</script> & "q" \u0001 ]]>';
function hostile() {
  const v = copy(BASE); v.facts.entity.name = "Calloway <b>Insurance</b> Co"; v.text.cover.subtitle = EVIL;
  v.text.summary.points[0] = { lead: EVIL, text: EVIL }; v.text.questions.items[0] = { title: EVIL, text: EVIL };
  v.facts.mix.lines[0].name = EVIL; v.facts.reinsurers.items[0].name = EVIL; v.facts.filings.rows[0].tracking = EVIL;
  return v;
}

(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage(); p.on("pageerror", e => errs.push(String(e)));
  await p.setContent("<html><body></body></html>");
  await p.addScriptTag({ path: path.join(ROOT, "node_modules/jszip/dist/jszip.min.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/deck.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/profile-slides.js") });
  const plan = v => p.evaluate(f => SNLProfile.plan(f), v.facts);
  const spec = v => p.evaluate(([f, t]) => SNLProfile.spec(f, t), [v.facts, v.text]);
  const fmt = (name, ...a) => p.evaluate(([n, a]) => SNLProfile.format[n](...a), [name, a]);
  const slide = (s, id) => s.slides.find(x => x.id === id);
  const items = (s, id, type) => slide(s, id).items.filter(i => i.type === type);
  const texts = sl => JSON.stringify(sl);
  // the bottom edge of an item, in inches (bullets and text boxes by their box; tables by their rows)
  const bottom = it => it.type === "table" ? it.y + (Array.isArray(it.rowH) ? it.rowH.reduce((a, c) => a + c, 0) : it.rowH * it.rows.length) : it.type === "header" ? it.y + 0.32 : it.type === "line" ? Math.max(it.y1, it.y2) : it.y + (it.h || 0);
  const right = it => it.type === "table" ? it.x + it.colW.reduce((a, c) => a + c, 0) : it.type === "line" ? Math.max(it.x1, it.x2) : it.x + it.w;

  // ----- plan -----
  let pl = await plan(BASE);
  ok("plan: all nine slides, in deck order, with labels", same(pl.map(r => r.id), IDS) && pl.every(r => r.included && r.reason === "") && pl[7].label === "Recent rate and form filings" && pl[8].label === "Key diligence questions", pl);
  pl = await plan(missingReserves());
  ok("plan: reserves left out when they aren't mapped, said plainly", pl.find(r => r.id === "reserves").included === false && pl.find(r => r.id === "reserves").reason === "Net loss and LAE reserves aren't mapped to Snowflake yet." && pl.filter(r => !r.included).length === 1, pl);
  pl = await plan(thin());
  const why = id => pl.find(r => r.id === id);
  ok("plan: premium out, naming both unmapped fields", !why("premium").included && why("premium").reason === "Direct premiums by line and net premiums by line aren't mapped to Snowflake yet.", why("premium"));
  ok("plan: a mapped field that came back empty says S&P returned nothing", why("reserves").reason === "S&P returned nothing for net loss and LAE reserves for 2024 to 2025.", why("reserves"));
  ok("plan: reinsurance out with the fields it needs; filings out with their own reason", !why("reinsurance").included && why("reinsurance").reason === "S&P returned nothing for ceded premiums by reinsurer, gross premiums written and reinsurance recoverables for 2024 to 2025." && why("filings").reason === "The filings search isn't set up yet.", pl);
  ok("plan: summary, underwriting and capital stay in with only surplus and combined ratio", why("summary").included && why("underwriting").included && why("capital").included);
  pl = await plan(nothing());
  ok("plan: with no figures, the cover and questions stay and the summary goes", why2(pl, "cover").included && why2(pl, "questions").included && !why2(pl, "summary").included && why2(pl, "summary").reason === "No statutory figures came back for this company, so there is nothing to sum up.", pl);
  function why2(pl, id) { return pl.find(r => r.id === id); }
  pl = await plan(noFilings());
  ok("plan: no filings in the period still keeps the filings slide", why2(pl, "filings").included);
  ok("plan: reasons are plain sentences with no field ids or em dashes", (await Promise.all([missingReserves(), thin(), nothing()].map(plan))).flat().every(r => !/_/.test(r.reason) && !r.reason.includes("\u2014") && (r.reason === "" || /^[A-Z].*\.$/.test(r.reason))));

  // ----- spec: cover, order, file name -----
  let s = await spec(BASE);
  ok("spec: nine slides, cover first, questions last", s.slides.length === 9 && s.slides[0].kind === "cover" && same(s.slides.slice(1).map(x => x.id), IDS.slice(1)));
  ok("spec: file name from the company and the day", s.fileName === "Calloway-Insurance-Co-profile-2026-11-14.pptx", s.fileName);
  ok("cover: kicker with month and year, title, subtitle", same(s.slides[0], { kind: "cover", kicker: "Corporate development | November 2026", title: "Calloway Insurance Co: company profile", subtitle: "Florida homeowners insurer with $122.5M of direct premiums in 2025" }), s.slides[0]);
  ok("content slides take Claude's or the plain titles", slide(s, "premium").title === BASE.text.premium.title && slide(s, "questions").title === "Key diligence questions");
  ok("every content slide ends with a source line naming the source and years", s.slides.slice(1).every(x => { const l = x.items[x.items.length - 1]; return l.type === "source" && /^Source: S&P Global Market Intelligence, /.test(l.text) && (/2021 to 2025/.test(l.text) || /14 Nov 2025 to 13 Nov 2026/.test(l.text)); }));
  ok("a slide with derived figures explains \"(derived)\" in its source line", items(s, "premium", "source")[0].text.includes("(derived): calculated from the reported figures.") && items(s, "underwriting", "source")[0].text.includes("(derived)"));
  ok("plain text: no Claude note; questions marked as inferred", !texts(s).includes("Claude") && items(s, "questions", "source")[0].text.includes("(inferred)"));
  ok("no em dashes anywhere in the plan", !texts(s).includes("\u2014"));
  const g = await spec(group());
  ok("a group profile is titled with the group's name", g.slides[0].title === "Calloway Group: company profile" && g.fileName === "Calloway-Group-profile-2026-11-14.pptx", g.slides[0]);
  const sc = await spec(sampleClaude());
  ok("sample: the cover title ends (sample) and the file name says so", sc.slides[0].title === "Calloway Insurance Co: company profile (sample)" && sc.fileName === "Calloway-Insurance-Co-profile-sample-2026-11-14.pptx", sc.fileName);
  ok("sample: every content slide's source line says the figures are made up", sc.slides.slice(1).every(x => x.items.find(i => i.type === "source").text.endsWith("Sample: made-up figures.")));
  ok("drafted by Claude: the summary and questions source lines say so; other slides don't", /drafted by Claude/.test(items(sc, "summary", "source")[0].text) && /drafted by Claude/.test(items(sc, "questions", "source")[0].text) && !/Claude/.test(items(sc, "premium", "source")[0].text));

  // ----- numbers -----
  ok("money: $M with commas and one decimal, negatives in parentheses, n/d for null", same(await Promise.all([fmt("money", 122500000), fmt("money", -5800000), fmt("money", 1234567890), fmt("money", null), fmt("money", -10000), fmt("money", 0)]), ["$122.5M", "($5.8M)", "$1,234.6M", "n/d", "$0.0M", "$0.0M"]));
  ok("ratios one decimal with %, multiples one decimal with x, negatives in parentheses", same(await Promise.all([fmt("pct", 98.44), fmt("pct", -1.24), fmt("pct", undefined), fmt("mult", 1.84), fmt("mult", -0.26), fmt("pctCell", -24.6), fmt("millions", -9800000), fmt("millions", 1234500000)]), ["98.4%", "(1.2%)", "n/d", "1.8x", "(0.3x)", "(24.6)", "(9.8)", "1,234.5"]));
  ok("dates: day and month, the year only when it isn't the profile's year", same(await Promise.all([fmt("shortDate", "2026-10-10", 2026), fmt("shortDate", "2027-01-01", 2026), fmt("shortDate", null, 2026), fmt("monthYear", "2026-11-14")]), ["10 Oct", "1 Jan 2027", "n/d", "November 2026"]));
  const t80 = "Combined ratio below 100% in 2024 and 2025 after three loss years and more words";
  const tr = await fmt("trimTitle", t80);
  ok("titles: trimmed to 65 characters at a word boundary", tr.length <= 65 && t80.startsWith(tr) && t80[tr.length] === " " && tr === "Combined ratio below 100% in 2024 and 2025 after three loss years", tr);
  ok("titles: a short title is left alone; wide capitals are trimmed by width", (await fmt("trimTitle", "  Premium  grew ")) === "Premium grew" && await (async () => { const w = "WWWWW WWWWW WWWWW WWWWW WWWWW WWWWW WWWWW WWWWW", t = await fmt("trimTitle", w); return t.length < 41 && w.startsWith(t) && w[t.length] === " "; })());

  // ----- slide contents -----
  const tiles = items(s, "summary", "tile");
  ok("summary: six tiles, latest premium, combined ratio, surplus, RBC, top state, five-year average", same(tiles.map(t => t.value), ["$122.5M", "93.4%", "$61.3M", "436.0%", "57.1%", "102.7%"]) &&
    same(tiles.map(t => t.label), ["Direct premiums written, 2025", "Combined ratio, 2025", "Surplus, 2025", "RBC ratio, 2025", "Share of direct premiums in FL, 2025", "Average combined ratio, 2021 to 2025 (derived)"]), tiles.map(t => [t.value, t.label]));
  ok("summary: the five-year average over 100% is magenta", tiles[5].color === MAG && tiles[1].color !== MAG);
  ok("summary: bold-led takeaways from the text", same(items(s, "summary", "bullets")[0].items[0].runs, [{ text: "Scale: ", bold: true }, { text: BASE.text.summary.points[0].text }]) && items(s, "summary", "bullets")[0].items.length === 6);
  const tt = await spec(thin());
  ok("summary: missing tiles get sensible substitutes, n/d only as a last resort", same(items(tt, "summary", "tile").map(t => t.value), ["n/d", "93.4%", "$61.3M", "n/d", "n/d", "n/d"]) && items(tt, "summary", "tile")[0].label === "Direct premiums written");
  const mr = await spec(missingReserves()), mrTiles = items(mr, "summary", "tile");
  const noMix = copy(BASE); delete noMix.facts.mix; delete noMix.facts.series.rbc_ratio;
  const nm = items(await spec(noMix), "summary", "tile");
  ok("summary: without RBC and mix, leverage and the top line share fill in", nm[3].value === "1.2x" && /Net premiums written to surplus, 2025 \(derived\)/.test(nm[3].label) && nm[4].value === "$75.9M", nm.map(t => [t.value, t.label]));
  ok("left-out slides aren't in the spec", !mr.slides.some(x => x.id === "reserves") && mr.slides.length === 8 && mrTiles.length === 6);

  const pc = items(s, "premium", "chart")[0];
  ok("premium: column chart of DPW and NPW by year in $M", pc.kind === "column" && same(pc.categories, ["2021", "2022", "2023", "2024", "2025"]) && same(pc.series.map(x => x.name), ["Direct premiums written", "Net premiums written"]) && same(pc.series[0].values, [61.2, 74.8, 88.9, 103.6, 122.5]) && pc.labels.format === "#,##0.0;(#,##0.0)");
  const ptab = items(s, "premium", "table").find(t => t.name === "Table by year");
  ok("premium: table by year with DPW, GPW, NPW, NPE, cession (derived) and growth (derived)", same(ptab.rows.map(r => typeof r[0] === "string" ? r[0] : r[0].text), ["$M unless shown", "Direct premiums written", "Gross premiums written", "Net premiums written", "Net premiums earned", "Ceded share (%, derived)", "DPW growth (%, derived)"]) &&
    same(ptab.rows[1].slice(1), ["61.2", "74.8", "88.9", "103.6", "122.5"]) && same(ptab.rows[5].slice(1), ["35.6", "37.2", "38.7", "40.2", "41.7"]) && same(ptab.rows[6].slice(1), ["n/d", "22.2", "18.9", "16.5", "18.2"]), ptab.rows);
  ok("premium: line and state mix tables", items(s, "premium", "table").some(t => t.rows[1][0] === "Homeowners" && t.rows[1][1] === "66.1") && items(s, "premium", "table").some(t => same(t.rows[1], ["FL", "70.0", "57.1"])));
  const uc = items(s, "underwriting", "chart")[0];
  ok("underwriting: stacked loss and expense ratios with the value axis kept", uc.kind === "stackedColumn" && same(uc.series.map(x => x.name), ["Loss ratio", "Expense ratio"]) && uc.valueAxis.max === 120 && uc.valueAxis.major === 20 && uc.valueAxis.min === 0);
  const ut = items(s, "underwriting", "table")[0], row = l => ut.rows.find(r => r[0] === l);
  ok("underwriting: combined ratio over 100 and losses in magenta, the rest navy", same(row("Combined ratio (%)").slice(1), [{ text: "104.7", color: MAG }, { text: "115.2", color: MAG }, { text: "103.0", color: MAG }, "97.1", "93.4"]) && same(row("Net income").slice(1, 3), [{ text: "(3.1)", color: MAG }, { text: "(9.8)", color: MAG }]) && row("ROAE (%, derived)")[1] === "n/d", ut.rows);
  ok("underwriting: the combined ratio row is the bold key row", ut.rowStyles[ut.rows.indexOf(row("Combined ratio (%)"))].bold === true);
  const ct = items(s, "capital", "table")[0];
  ok("capital: paid-in vs surplus columns and the capital table", same(items(s, "capital", "chart")[0].series.map(x => x.name), ["Paid-in capital", "Surplus"]) && same(ct.rows.map(r => r[0]).slice(1), ["Surplus", "Paid-in capital", "Accumulated deficit (derived)", "Total assets", "NPW to surplus (x, derived)", "RBC ratio (%)"]) && same(ct.rows[3][5], { text: "(18.7)", color: MAG }) && ct.rows[5][5] === "1.2x");
  ok("reserves: three tiles, adverse development in magenta in the table", same(items(s, "reserves", "tile").map(t => t.value), ["0.8x", "0.7x", "(2.1%)"]) && same(items(s, "reserves", "table")[0].rows.find(r => r[0] === "One-year development (PYD)")[2], { text: "3.4", color: MAG }));
  const rc = items(s, "reinsurance", "chart")[0];
  ok("reinsurance: horizontal bar of ceded premiums by reinsurer, tiles for cession and recoverables", rc.kind === "bar" && rc.legend === "none" && rc.categories[0] === "Nonesuch Re" && rc.series[0].values[0] === 16.8 && same(items(s, "reinsurance", "tile").map(t => t.value), ["41.7%", "94.5%"]));
  const ft = items(s, "filings", "table").find(t => t.name === "Table latest filings");
  ok("filings: counts by type and state, and the latest filings table", items(s, "filings", "table").some(t => same(t.rows[1], ["Rate", "9"])) && items(s, "filings", "table").some(t => same(t.rows[1], ["FL", "11"])) &&
    same(ft.rows[0], ["State", "Filing type", "Type of insurance", "Status", "Published", "Effective", "Rate impact", "Tracking number"]) && same(ft.rows[1], ["FL", "Rate", "Homeowners", "Approved", "10 Oct", "1 Jan 2027", "4.5%", "CALL-FL-1"]) && ft.rows[4][6] === "(2.0%)" && ft.rows.length === 9);
  ok("filings: header says how many of the total are shown", items(s, "filings", "header").some(h => h.text === "Latest filings (8 of 23)"));
  const nf = await spec(noFilings());
  ok("filings: an empty period says S&P returned nothing, never that no filings exist", texts(slide(nf, "filings")).includes("S&P returned nothing for this period") && !/no filings|none filed|no rate/i.test(texts(slide(nf, "filings"))) && !items(nf, "filings", "table").length);
  const capped = copy(BASE); capped.facts.filings.capped = true;
  ok("filings: a capped search says the counts are a floor", (await spec(capped)).slides.find(x => x.id === "filings").items.some(i => i.type === "header" && i.text === "Latest filings (8 of 23 or more)"));
  const qs = items(s, "questions", "numbered");
  ok("questions: four numbered tiles in a 2x2 grid", same(qs.map(q => q.n), [1, 2, 3, 4]) && same(qs.map(q => [q.x, q.y]), [[0.52, 1.35], [6.89, 1.35], [0.52, 3.8], [6.89, 3.8]]) && qs[0].title === "Florida concentration");

  // ----- fit: nothing runs into the source line or off the content area -----
  for (const [name, v] of [["full", BASE], ["longest text", maxText()], ["thin", thin()], ["no filings", noFilings()], ["missing reserves", missingReserves()]]) {
    const sp = await spec(v), out = [];
    sp.slides.slice(1).forEach(x => x.items.filter(i => i.type !== "source").forEach(i => { if (bottom(i) > 6.6 + 1e-9 || right(i) > 12.8 + 1e-9 || (i.x !== undefined && i.x < 0.52 - 1e-9) || (i.y !== undefined && i.y < 1.3 - 1e-9)) out.push([x.id, i.type, i.name || i.text, bottom(i), right(i)]); }));
    ok("fit (" + name + "): every block sits inside x 0.52 to 12.80, y 1.3 to 6.6", out.length === 0, out);
    ok("fit (" + name + "): titles are at most 65 characters", sp.slides.slice(1).every(x => x.title.length <= 65));
  }
  const mx = await spec(maxText());
  ok("longest text: takeaways are capped rather than shrunk", items(mx, "summary", "bullets")[0].items.length < 7 && items(mx, "summary", "bullets")[0].items.length >= 3 && items(mx, "summary", "bullets")[0].size === 13 && items(mx, "premium", "bullets")[0].items.length < 4);
  ok("longest text: a long title is trimmed at a word boundary", mx.slides.slice(1, 8).every(x => LONG(65).slice(0, 65).startsWith(x.title) && x.title.length < 65));
  ok("longest text: source lines fit on one line (Claude, sample and derived notes together)", mx.slides.slice(1).every(x => x.items.find(i => i.type === "source").text.length <= 175));

  // ----- hostile text stays text, and the deck still builds -----
  const hs = await spec(hostile());
  ok("hostile text: passed through as plain text, not escaped twice", hs.slides[0].subtitle === EVIL && texts(hs).includes("Calloway <b>Insurance</b> Co: company profile"));
  ok("hostile text: the file name keeps only letters and digits", hs.fileName === "Calloway-b-Insurance-b-Co-profile-2026-11-14.pptx", hs.fileName);
  const built = await p.evaluate(async ([s, sp]) => {
    const out = await SNLDeck.build(Uint8Array.from(atob(s), c => c.charCodeAt(0)), sp);
    let t = ""; for (let i = 0; i < out.length; i += 0x8000) t += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(t);
  }, [TEMPLATE.toString("base64"), hs]);
  let z = await JSZip.loadAsync(Buffer.from(built, "base64"));
  const xml = (await Promise.all(Object.keys(z.files).filter(n => /\.(xml|rels)$/.test(n)).map(n => z.file(n).async("string")))).join("");
  ok("hostile text: the built deck has it escaped", !xml.includes("<script>") && xml.includes("&lt;script&gt;window.__xss=1&lt;/script&gt;") && !xml.includes("\u0001") && await p.evaluate(() => window.__xss === undefined));

  // ----- the whole sample deck on the stand-in template -----
  const full = await p.evaluate(async ([s, sp]) => {
    const out = await SNLDeck.build(Uint8Array.from(atob(s), c => c.charCodeAt(0)), sp);
    let t = ""; for (let i = 0; i < out.length; i += 0x8000) t += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(t);
  }, [TEMPLATE.toString("base64"), sc]);
  z = await JSZip.loadAsync(Buffer.from(full, "base64"));
  const names = Object.keys(z.files);
  const slideXml = await Promise.all(names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).map(n => z.file(n).async("string")));
  ok("full build: nine slides, four charts each with a workbook", slideXml.length === 9 && names.filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n)).length === 4 && names.filter(n => /\.xlsx$/.test(n)).length === 4, names.filter(n => /chart|xlsx/.test(n)));
  ok("full build: the sample marker is on the cover and every content slide", slideXml[0].includes("(sample)") && slideXml.slice(1).every(x => x.includes("Sample: made-up figures.")));
  const premChart = await z.file(names.find(n => /^ppt\/charts\/chart\d+\.xml$/.test(n) && n)).async("string");
  ok("full build: the premium chart carries DPW in $M", premChart.includes("<c:v>Direct premiums written</c:v>") && premChart.includes("<c:v>122.5</c:v>"));
  ok("full build: every content slide shows its slide number", slideXml.slice(1).every((x, i) => x.includes('type="slidenum"><a:rPr lang="en-US"/><a:t>' + (i + 2) + "</a:t>")));

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL crashed " + (e && e.stack)); console.log(pass + " passed, " + (fail + 1) + " failed"); process.exit(1); });
