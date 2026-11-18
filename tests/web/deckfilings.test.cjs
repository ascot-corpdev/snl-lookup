// SNLProfile.filingsPlan and filingsSpec (web/profile-slides.js): the filings profile's slides, from the hand-worked
// facts of tests/functions/deckfilings_core_test.ts (tests/fixtures/deckfilings_facts.json) and variants made here.
// Every figure on every slide is checked against the hand-worked values; slides left out with plain reasons (nothing
// returned, no rate impact, no form or rule filings, no dates); a group; rows with no tracking number or type of
// insurance (no empty column); rate impacts never averaged and the unapproved marked; the source line on every slide
// and on one line; everything inside the content area; hostile text; and a real build of the made-up sample
// (tests/fixtures/deckfilings_sample_answer.json) on the stand-in template, opened and checked.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/deckfilings_facts.json"), "utf8"));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/deckfilings_sample_answer.json"), "utf8"));
const copy = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 700)); } };
const NAVY = "262166", MAG = "EB008C", TEAL = "00857C", PURPLE = "944599";
const IDS = ["cover", "summary", "states", "rates", "years", "forms", "regulator", "questions"];   // the eight slides filled without saved summaries, the market index or the map outlines
const ALL = ["cover", "summary", "states", "rateMap", "rates", "exposure", "adequacy", "programs", "market", "years", "forms", "regulator", "questions"];
const SRC = "Source: S&P Global Market Intelligence, SNL Insurance Product Filings, 20 Nov 2023 to 18 Nov 2026.";
// Arial advance widths, as profile-slides.js estimates them: the source line must fit 11.7 in at 10pt
const W = (() => { const w = {}, set = (c, v) => { for (const ch of c) w[ch] = v; };
  set("ijl'", 222); set(" ft.,:;!|/[]\\", 278); set("r()-`", 333); set("\"", 355); set("*", 389); set("^", 469); set("ckszvxyJ_", 500); set("abdeghnopqu0123456789$#?L~+=<>", 556); set("FTZ", 611); set("ABEKPSVXY&", 667);
  set("wCDHNRU", 722); set("GOQ", 778); set("mM", 833); set("%", 889); set("W", 944); set("@", 1015); set("I", 278); return w; })();
const width10 = s => [...s].reduce((a, ch) => a + (W[ch] || 580), 0) / 1000 * 10 / 72;

// ----- variants -----
function nothing() { const v = copy(BASE); const f = v.facts;
  Object.assign(f.totals, { filings: 0, rate: 0, rule: 0, form: 0, other: 0, states: 0, latest: null, undated: 0 }); f.largest = null; f.approval = { rateFilings: 0, approved: 0, share: null };
  f.rates = { filings: 0, withImpact: 0, notApproved: 0, noDate: 0, lo: null, hi: null, points: [], pointsTotal: 0, rows: [], rowsTotal: 0 }; f.states = { rows: [], noState: 0 };
  f.years.counts = f.years.counts.map(r => r.map(() => 0)); f.years.totals = f.years.totals.map(() => 0); f.years.byType = f.years.byType.map(() => 0);
  f.latest = { rows: [], total: 0 }; f.regulator = { rows: [], all: null, left: 0 }; return v; }
function noImpact() { const v = copy(BASE); const f = v.facts; f.largest = null; Object.assign(f.rates, { withImpact: 0, notApproved: 0, lo: null, hi: null, points: [], pointsTotal: 0 });
  f.rates.rows.forEach(r => { r.withRate = 0; r.lo = null; r.hi = null; r.latest = null; }); f.states.rows.forEach(s => { s.latest = null; }); return v; }
function noRate() { const v = noImpact(); Object.assign(v.facts.rates, { filings: 0, rows: [], rowsTotal: 0 }); return v; }
function noForms() { const v = copy(BASE); v.facts.latest = { rows: [], total: 0 }; return v; }
function noDays() { const v = copy(BASE); v.facts.regulator = { rows: [], all: null, left: 7 }; return v; }
function bare() { const v = copy(BASE); v.facts.latest.rows.forEach(r => { r.filingNo = null; r.toi = null; }); return v; }
function group() { const v = copy(BASE); v.facts.entity = { kind: "group", name: "Calloway Group", groupName: "Calloway Group", companies: 3, noId: 1 }; return v; }
function claude() { const v = copy(BASE); v.text.by = "claude"; return v; }
function capped() { const v = copy(BASE); v.facts.search.capped = true; return v; }
function crowded() {   // 30 rate points and 30 states: the chart and the tables keep to what fits, and say so
  const v = copy(BASE), f = v.facts, codes = "AK AL AR AZ CA CO CT DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH".split(" ");
  f.rates.points = Array.from({ length: 30 }, (_, i) => ({ date: `2025-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + i).padStart(2, "0")}`, state: codes[i], toi: "Homeowners", rate: i % 3 ? 1.5 + i / 10 : -(0.5 + i / 10), status: i % 4 ? "Approved" : "Pending", approved: !!(i % 4) }));
  f.rates.points.sort((a, b) => a.date.localeCompare(b.date)); f.rates.pointsTotal = 41; f.rates.withImpact = 41;
  f.rates.rows = codes.map((c, i) => ({ state: c, toi: "Commercial property", n: 30 - i, withRate: 1, lo: -1, hi: 2, latest: f.rates.points[i] })); f.rates.rowsTotal = 30;
  f.states.rows = codes.map((c, i) => ({ state: c, n: 40 - i, rate: 3, latest: f.rates.points[i] }));
  f.regulator.rows = codes.map((c, i) => ({ state: c, n: 30 - i, median: 40 + i, lo: 10, hi: 200 + i })); return v;
}
const LONG = n => { let s = "", i = 0; const w = ["Florida", "homeowners", "rate", "filings", "pending", "approved", "regulator", "programs"]; while (s.length < n) s += (s ? " " : "") + w[i++ % w.length]; return s; };
function maxText() {
  const v = claude(); v.facts.sample = true; v.text.cover.subtitle = LONG(110).slice(0, 110); v.facts.entity.name = LONG(120).slice(0, 120);
  ["summary", "rates", "states", "years", "forms", "regulator"].forEach(k => { v.text[k].title = LONG(65).slice(0, 65); v.text[k].points = Array.from({ length: k === "summary" ? 6 : 3 }, (_, i) => ({ lead: "Lead number " + (i + 1) + " is long", text: LONG(220).slice(0, 220) })); });
  v.text.questions.items = Array.from({ length: 4 }, () => ({ title: LONG(60).slice(0, 60), text: LONG(260).slice(0, 260) }));
  v.facts.latest.rows.forEach(r => { r.company = LONG(120).slice(0, 120); r.toi = LONG(120).slice(0, 120); r.status = LONG(80).slice(0, 80); });
  return v;
}
const EVIL = '<script>window.__xss=1</script> & "q" \u0001 ]]>';
function hostile() { const v = copy(BASE); v.facts.entity.name = "Calloway <b>Insurance</b> Co"; v.text.summary.points[0] = { lead: EVIL, text: EVIL }; v.facts.latest.rows[0].company = EVIL; v.facts.states.rows[0].state = EVIL; return v; }

(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage(); p.on("pageerror", e => errs.push(String(e)));
  await p.setContent("<html><body></body></html>");
  await p.addScriptTag({ path: path.join(ROOT, "node_modules/jszip/dist/jszip.min.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/deck.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/profile-slides.js") });
  const plan = v => p.evaluate(f => SNLProfile.filingsPlan(f), v.facts);
  const spec = v => p.evaluate(([f, t]) => SNLProfile.filingsSpec(f, t), [v.facts, v.text]);
  const slide = (s, id) => s.slides.find(x => x.id === id);
  const items = (s, id, type) => slide(s, id).items.filter(i => i.type === type);
  const one = (s, id, type, name) => items(s, id, type).find(i => !name || i.name === name);
  const src = (s, id) => one(s, id, "source").text;
  const cells = t => t.rows.map(r => r.map(c => c && typeof c === "object" ? c.text : c));
  const bottom = it => it.type === "table" ? it.y + (Array.isArray(it.rowH) ? it.rowH.reduce((a, c) => a + c, 0) : it.rowH * it.rows.length) : it.type === "header" ? it.y + 0.32 : it.type === "line" ? Math.max(it.y1, it.y2) : it.y + (it.h || 0);
  const right = it => it.type === "table" ? it.x + it.colW.reduce((a, c) => a + c, 0) : it.type === "line" ? Math.max(it.x1, it.x2) : it.x + it.w;

  // ----- the plan -----
  let pl = await plan(BASE);
  ok("plan: thirteen slides in deck order; the eight from the filings alone are filled", same(pl.map(r => r.id), ALL) && pl.filter(r => r.included).map(r => r.id).join() === IDS.join() && pl.filter(r => r.included).every(r => r.reason === "")
    && same(pl.filter(r => r.included).map(r => r.label), ["Cover", "Executive summary", "Where it files (map)", "Rate changes", "Filings by year and type", "Latest form and rule filings", "Time with the regulator", "Key diligence questions"]), pl);
  const why = (pl, id) => pl.find(r => r.id === id);
  pl = await plan(nothing());
  ok("plan, nothing returned: cover, summary and questions stay; the rest are left out because S&P returned nothing for this search",
    why(pl, "cover").included && why(pl, "summary").included && why(pl, "questions").included && ["rates", "states", "years", "forms", "regulator"].every(id => !why(pl, id).included && why(pl, id).reason === "S&P returned nothing for this search, so there are no filings to show. That doesn't prove nothing was filed."), pl);
  pl = await plan(noImpact());
  ok("plan, no rate impact: the rate slide is left out, saying no filing carried one", !why(pl, "rates").included && why(pl, "rates").reason === "No filing carried an overall rate impact in S&P's data, so there are no rate changes to chart." && pl.filter(r => !r.included && IDS.includes(r.id)).length === 1);
  pl = await plan(noRate());
  ok("plan, no rate filings: said as S&P's answer", why(pl, "rates").reason === "S&P returned no rate filings for this search, so there are no rate changes to show.");
  pl = await plan(noForms());
  ok("plan, no form or rule filings: that slide is left out", !why(pl, "forms").included && why(pl, "forms").reason === "S&P returned no form or rule filings for this search.");
  pl = await plan(noDays());
  ok("plan, no filing with both dates: the regulator slide is left out", !why(pl, "regulator").included && /both a submitted date and a publish date/.test(why(pl, "regulator").reason));
  ok("plan: reasons are plain sentences, no ids, no em dashes", (await Promise.all([nothing(), noImpact(), noRate(), noForms(), noDays()].map(plan))).flat().every(r => !/_/.test(r.reason) && !r.reason.includes("—") && (r.reason === "" || /^[A-Z].*\.$/.test(r.reason))));

  // ----- the spec: cover, order, file name, sources -----
  let s = await spec(BASE);
  ok("spec: eight slides, cover first", s.slides.length === 8 && s.slides[0].kind === "cover" && same(s.slides.slice(1).map(x => x.id), IDS.slice(1)));
  ok("spec: the file is named after the company, the kind of profile and the day", s.fileName === "Calloway-Insurance-Co-filings-profile-2026-11-18.pptx", s.fileName);
  ok("cover: \"<company>: filings profile\", kicker with month and year, the one-line descriptor", same(s.slides[0], { kind: "cover", kicker: "Corporate development | November 2026", title: "Calloway Insurance Co: filings profile", subtitle: "7 filings published 20 Nov 2023 to 18 Nov 2026" }), s.slides[0]);
  ok("titles: the text's action titles", same(s.slides.slice(1).map(x => x.title), ["7 filings in 3 states over the last 3 years", "Most filings in FL: 3 of 7", "Overall rate changes from (3.5%) to 9.8%", "Most filings in 2026: 2 of 7", "4 form and rule filings; latest 15 Jun 2025", "About 70 days with the regulator (median)", "Key diligence questions"]), s.slides.map(x => x.title));
  ok("every content slide ends with a source line naming S&P, SNL Insurance Product Filings and the period", s.slides.slice(1).every(x => { const l = x.items[x.items.length - 1]; return l.type === "source" && l.text.startsWith(SRC); }), s.slides.map(x => x.items && x.items.at(-1).text));
  ok("the rate slides' source lines say impacts aren't weighted by premium and may be the change asked for", /not by premium; if not approved, may be the change asked for\./.test(src(s, "rates")) && /if not approved, may be the change asked for/.test(src(s, "summary")));
  ok("the regulator's source line says the days are approximate; the forms' says what the filing number is", /approximate/.test(src(s, "regulator")) && /S&P no\./.test(src(s, "forms")) && /2 without both dates left out\./.test(src(s, "regulator")));
  ok("plain text: questions marked (inferred), no Claude note", /\(inferred\)/.test(src(s, "questions")) && !JSON.stringify(s).includes("Claude"));
  const c = await spec(claude());
  ok("Claude's text: the summary and questions source lines say so, other slides don't", /Text drafted by Claude/.test(src(c, "summary")) && /drafted by Claude/.test(src(c, "questions")) && !/Claude/.test(src(c, "rates")) && !/\(inferred\)/.test(src(c, "questions")));
  for (const [name, v] of [["plain", BASE], ["Claude", claude()], ["sample and Claude", maxText()], ["crowded", crowded()], ["capped", capped()], ["group", group()], ["bare", bare()], ["nothing", nothing()]]) {
    const sp = await spec(v), wide = sp.slides.slice(1).map(x => src(sp, x.id)).filter(t => width10(t) > 11.7);
    ok(`source lines fit on one line (${name})`, wide.length === 0, wide.map(t => [width10(t).toFixed(2), t]));
  }
  ok("no em dashes anywhere", !JSON.stringify(s).includes("—"));

  // ----- 2. summary: every tile -----
  const tiles = items(s, "summary", "tile");
  ok("summary: eight tiles: filings, rate, rule, form, states, latest, largest change and approvals", same(tiles.map(t => [t.value, t.label]), [
    ["7", "Filings published in the period"], ["4", "Rate filings"], ["2", "Rule filings"], ["2", "Form filings"], ["3", "States with filings, of 51 searched"], ["5 Nov", "Latest filing published"],
    ["9.8%", "Largest overall rate change: FL, 5 Nov, pending (may be as asked)"], ["50.0%", "Rate filings approved, 2 of 4 (derived)"]]), tiles.map(t => [t.value, t.label]));
  ok("summary: the largest change, not approved, is purple, the rest navy", tiles[6].color === PURPLE && tiles.slice(0, 6).every(t => t.color === NAVY));
  ok("summary: bold-led takeaways from the text", same(one(s, "summary", "bullets").items[0].runs, [{ text: "Filings: ", bold: true }, { text: BASE.text.summary.points[0].text }]) && one(s, "summary", "bullets").items.length === 6);
  const ap = copy(BASE); ap.facts.largest.approved = true; ap.facts.largest.status = "Approved";
  ok("summary: an approved largest change says approved, in navy", (await spec(ap)).slides[1].items.filter(i => i.type === "tile")[6].label === "Largest overall rate change: FL, 5 Nov, approved");

  // ----- 3. rate changes -----
  const rc = one(s, "rates", "chart");
  ok("rates chart: native columns, one per filing in date order, labelled with state, month and year", rc.kind === "column" && same(rc.categories, ["TX Aug 2024", "TX Mar 2025", "FL Oct 2026", "FL Nov 2026"]) && rc.catLabels === "low" && rc.legend === "top" && rc.overlap === 100, rc.categories);
  ok("rates chart: coloured by increase or decrease, and the unapproved apart: one value per column, never averaged", same(rc.series.map(x => [x.name, x.color, x.values]), [
    ["Increase, approved", MAG, [null, null, 4.5, null]], ["Decrease, approved", TEAL, [null, -3.5, null, null]], ["Not approved (may be as asked)", PURPLE, [2, null, null, 9.8]]]), rc.series);
  ok("rates chart: data labels in house style, negatives in parentheses", rc.labels.format === "0.0;(0.0);0.0");
  const rt = one(s, "rates", "table");
  ok("rates table: state and type of insurance, filings, range, the latest change with its date and status", same(cells(rt), [
    ["State", "Type of insurance", "Filings", "Range (%)", "Latest (%)", "Published", "Status"],
    ["FL", "Homeowners", "2", "4.5 to 9.8", "9.8", "5 Nov", "Pending"], ["TX", "Commercial property", "1", "(3.5)", "(3.5)", "1 Mar 2025", "Approved"], ["TX", "Homeowners", "1", "2.0", "2.0", "20 Aug 2024", "Disapproved"]]), cells(rt));
  ok("rates: takeaways beside the table", same(one(s, "rates", "bullets").items.map(i => i.runs[0].text), ["Range: ", "Not approved: ", "Latest: "]));
  const cr = await spec(crowded()), crc = one(cr, "rates", "chart");
  ok("crowded: the chart keeps the latest 20 filings and its header says of how many", crc.categories.length === 20 && same(crc.categories, crowded().facts.rates.points.slice(-20).map(x => x.state + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+x.date.slice(5, 7) - 1] + " 2025")) && items(cr, "rates", "header").some(h => h.text === "Overall rate impact of each filing, in date order (%), latest 20 of 41"), [crc.categories[0], items(cr, "rates", "header").map(h => h.text)]);
  ok("crowded: the rate table keeps the rows with the most filings that fit, and says so", items(cr, "rates", "header").some(h => /^Rate filings by state and type of insurance \(7 of 30\)$/.test(h.text)) && cells(one(cr, "rates", "table")).length === 8);

  // ----- 4. where it files -----
  const sc = one(s, "states", "chart");
  ok("states: a horizontal bar chart of filings by state, the top state in magenta (no map)", sc.kind === "bar" && same(sc.categories, ["FL", "TX", "GA"]) && same(sc.series[0].values, [3, 2, 1]) && same(sc.series[0].pointColors, { 0: MAG }) && !JSON.stringify(slide(s, "states")).includes("picture"));
  ok("states table: state, filings, rate filings, latest rate impact; the unapproved starred", same(cells(one(s, "states", "table")), [["State", "Filings", "Rate filings", "Latest rate (%)"], ["FL", "3", "2", "9.8*"], ["TX", "2", "2", "(3.5)"], ["GA", "1", "0", "n/d"]]));
  ok("states: the star is explained on the source line, with the filing that has no state", /\* Not approved: (the figure )?may be (the change asked for|as asked)\./.test(src(s, "states")) && /1 with no state left out\./.test(src(s, "states")), src(s, "states"));
  ok("crowded: 12 bars, 18 table rows, and the headers say of how many", one(cr, "states", "chart").categories.length === 12 && cells(one(cr, "states", "table")).length === 19 && items(cr, "states", "header").some(h => h.text === "By state (18 of 30)") && items(cr, "states", "header").some(h => h.text === "Filings by state (top 12 of 30)"));

  // ----- 5. filings by year and type -----
  const yc = one(s, "years", "chart");
  ok("years: a stacked column chart by year and S&P's filing types", yc.kind === "stackedColumn" && same(yc.categories, ["2023", "2024", "2025", "2026"]) && same(yc.series.map(x => [x.name, x.values]), [["Rate", [0, 1, 0, 2]], ["Rule", [0, 1, 0, 0]], ["Form", [0, 0, 1, 0]], ["Rate/Rule", [0, 0, 1, 0]]]) && yc.labels.format === "0;;;", yc.series);
  ok("years: the small table, with the total of each year in bold", same(cells(one(s, "years", "table")), [["Year", "Rate", "Rule", "Form", "Rate/Rule", "All"], ["2023", "0", "0", "0", "0", "0"], ["2024", "1", "1", "0", "0", "2"], ["2025", "0", "0", "1", "1", "2"], ["2026", "2", "0", "0", "0", "2"]]) && one(s, "years", "table").rows[2][5].bold === true);
  ok("years: part years and the undated filing said on the source line", /part years/.test(src(s, "years")) && /1 undated left out\./.test(src(s, "years")));

  // ----- 6. latest form and rule filings -----
  const ft = one(s, "forms", "table");
  ok("forms: company, state, type of insurance, filing type, status, published and the filing's number, newest first", same(cells(ft), [
    ["Company", "State", "Type of insurance", "Filing type", "Status", "Published", "Filing number"],
    ["Calloway Insurance Co", "FL", "Homeowners", "Form", "Approved", "15 Jun 2025", "S&P no. ABC1234567"], ["Calloway Insurance Co", "TX", "Commercial property", "Rate/Rule", "Approved", "1 Mar 2025", "S&P no. CAL0000003"],
    ["Calloway Insurance Co", "GA", "Inland marine", "Rule", "Withdrawn", "10 Feb 2024", "S&P no. CAL0000005"], ["Calloway Insurance Co", "n/d", "n/d", "Form", "Approved", "n/d", "n/d"]]), cells(ft));
  ok("forms: no description column, ever", !JSON.stringify(slide(s, "forms")).toLowerCase().includes("description"));
  const bt = one(await spec(bare()), "forms", "table");
  ok("rows with no filing number and no type of insurance: those columns are left out, not left empty, and the table still spans the width", same(bt.rows[0], ["Company", "State", "Filing type", "Status", "Published"]) && Math.abs(bt.colW.reduce((a, x) => a + x, 0) - 12.28) < 1e-6, bt.rows[0]);
  const mt = await spec(maxText()), mft = one(mt, "forms", "table");
  ok("forms: long names are cut to their column with an ellipsis", mft.rows.slice(1).every(r => r[0].endsWith("…") && r[2].endsWith("…")));

  // ----- 7. time with the regulator -----
  const dc = one(s, "regulator", "chart");
  ok("regulator: median days by state as bars, the slowest in magenta", dc.kind === "bar" && same(dc.categories, ["FL", "TX"]) && same(dc.series[0].values, [60, 90]) && same(dc.series[0].pointColors, { 1: MAG }));
  ok("regulator table: filings, median and range by state, and all states in bold", same(cells(one(s, "regulator", "table")), [["State", "Filings", "Median days", "Range of days"], ["FL", "3", "60", "30 to 70"], ["TX", "2", "90", "90"], ["All states", "5", "70", "30 to 90"]]) && one(s, "regulator", "table").rows[3].every(x => x.bold));
  ok("regulator: labelled approximate in the title and header", slide(s, "regulator").title === "About 70 days with the regulator (median)" && items(s, "regulator", "header").some(h => h.text === "By state, approximate"));

  // ----- 8. questions -----
  const qs = items(s, "questions", "numbered");
  ok("questions: four numbered tiles in a 2x2 grid from the text", same(qs.map(q => [q.n, q.x, q.y, q.title]), [[1, 0.52, 1.35, "Rate requests in progress"], [2, 6.89, 1.35, "Product changes"], [3, 0.52, 3.8, "Regulatory timing"], [4, 6.89, 3.8, "Rate plan"]]), qs.map(q => q.title));

  // ----- missing data and other cases -----
  const n0 = await spec(nothing());
  ok("nothing returned: cover, summary and questions; the summary says S&P returned nothing for this search, never that nothing was filed",
    same(n0.slides.map(x => x.id || x.kind), ["cover", "summary", "questions"]) && JSON.stringify(slide(n0, "summary")).includes("S&P returned nothing for this search") && !/no filings (exist|were filed)/i.test(JSON.stringify(n0)) && !items(n0, "summary", "tile").length);
  ok("no rate impact: the summary's largest-change tile says so, n/d", items(await spec(noImpact()), "summary", "tile")[6].value === "n/d");
  const g = await spec(group());
  ok("a group: titled with the group's name", g.slides[0].title === "Calloway Group: filings profile" && g.fileName === "Calloway-Group-filings-profile-2026-11-18.pptx");
  ok("a search that stopped early: every source line says so", (await spec(capped())).slides.slice(1).every(x => /Search incomplete\.|stopped early/.test(src({ slides: [x] }, x.id))));
  ok("the sample: (sample) on the cover and made-up figures on every source line", mt.slides[0].title.endsWith(": filings profile (sample)") && mt.slides.slice(1).every(x => /Made-up( figures)?\.$/i.test(src(mt, x.id))));
  ok("a very long name is cut on the cover", mt.slides[0].title.length < 80 && mt.slides[0].title.includes("…"));

  // ----- fit -----
  for (const [name, v] of [["hand-worked", BASE], ["longest text", maxText()], ["crowded", crowded()], ["nothing", nothing()], ["no impact", noImpact()], ["bare", bare()], ["sample", SAMPLE]]) {
    const sp = await spec(v), out = [];
    sp.slides.slice(1).forEach(x => x.items.filter(i => i.type !== "source").forEach(i => { if (bottom(i) > 6.6 + 1e-9 || right(i) > 12.8 + 1e-9 || (i.x !== undefined && i.x < 0.52 - 1e-9) || (i.y !== undefined && i.y < 1.3 - 1e-9)) out.push([x.id, i.type, i.name || i.text, bottom(i), right(i)]); }));
    ok("fit (" + name + "): every block inside x 0.52 to 12.80 and y 1.3 to 6.6, clear of the source line", out.length === 0, out);
    ok("fit (" + name + "): titles at most 65 characters", sp.slides.slice(1).every(x => x.title.length <= 65));
  }
  ok("longest text: takeaways are capped rather than shrunk", one(mt, "summary", "bullets").items.length < 6 && one(mt, "summary", "bullets").size === 13);

  // ----- hostile text -----
  const hs = await spec(hostile());
  ok("hostile text passes through as plain text", hs.slides[0].title === "Calloway <b>Insurance</b> Co: filings profile" && JSON.stringify(hs).includes("window.__xss"));
  ok("hostile text: the file name keeps only letters and digits", hs.fileName === "Calloway-b-Insurance-b-Co-filings-profile-2026-11-18.pptx");
  const build = sp => p.evaluate(async ([t, sp]) => { const out = await SNLDeck.build(Uint8Array.from(atob(t), ch => ch.charCodeAt(0)), sp);
    let x = ""; for (let i = 0; i < out.length; i += 0x8000) x += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(x); }, [TEMPLATE.toString("base64"), sp]);
  let z = await JSZip.loadAsync(Buffer.from(await build(hs), "base64"));
  const xml = (await Promise.all(Object.keys(z.files).filter(n => /\.(xml|rels)$/.test(n)).map(n => z.file(n).async("string")))).join("");
  ok("hostile text: escaped in the built deck", !xml.includes("<script>") && xml.includes("&lt;script&gt;window.__xss=1&lt;/script&gt;") && !xml.includes("\u0001") && await p.evaluate(() => window.__xss === undefined));

  // ----- the made-up sample, built on the stand-in template -----
  const ss = await spec(SAMPLE);
  z = await JSZip.loadAsync(Buffer.from(await build(ss), "base64"));
  const names = Object.keys(z.files);
  const slides = await Promise.all(names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).map(n => z.file(n).async("string")));
  const charts = await Promise.all(names.filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n)).map(n => z.file(n).async("string")));
  ok("sample build: twelve slides (no map outlines here, so no rate map); nine native charts (states, rate changes, exposure twice, adequacy, market twice, years, regulator), each with its workbook", slides.length === 12 && charts.length === 9 && names.filter(n => /\.xlsx$/.test(n)).length === 9, names.filter(n => /chart|xlsx/.test(n)));
  ok("sample build: the cover and the sample marker", slides[0].includes("Calloway Group: filings profile (sample)") && slides.slice(1).every(x => /made-up figures\./i.test(x)));
  ok("sample build: the rate chart is a column chart with its category labels at the bottom", charts.some(x => x.includes('<c:barDir val="col"/>') && x.includes('<c:tickLblPos val="low"/>') && x.includes("<c:v>Increase, approved</c:v>")));
  ok("sample build: the state chart is a bar chart and no slide carries a picture", charts.some(x => x.includes('<c:barDir val="bar"/>') && x.includes("<c:v>Filings</c:v>")) && !slides.some(x => x.includes("<p:pic>")));
  ok("sample build: every content slide shows its slide number", slides.slice(1).every((x, i) => x.includes('type="slidenum"><a:rPr lang="en-US"/><a:t>' + (i + 2) + "</a:t>")));

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL crashed " + (e && e.stack)); console.log(pass + " passed, " + (fail + 1) + " failed"); process.exit(1); });
