// The full profile's filings in detail on slides (web/profile-slides.js): the plan with the detailed filing slides in
// place of the one filings slide, each on by default and left out with its reason (no rate impact, no map outlines,
// nothing marked, facts saved before marks, the search empty or unavailable); facts saved before this change keep the
// one filings slide; the at-a-glance slide (tiles, the map of filings by state, by filing type, the takeaways); rate
// changes and the rate map from the filings profile's slides; the marked filings with the words that marked them, as
// "may be"; the latest form and rule filings (a company column only for a group with several); every state over two
// slides, "none returned" and "not searched" never shown as zero; the regulator; every block inside the content area;
// hostile text kept as text; and the made-up sample built on the stand-in and built-in templates, checked as XML and,
// where python-pptx is installed, opened by it. Every company, filing number and figure is made up.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path"); const { execFileSync } = require("child_process");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../..");
const OUTDIR = path.join(__dirname, "../out"); fs.mkdirSync(OUTDIR, { recursive: true });
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const BUILTIN = fs.readFileSync(path.join(ROOT, "web/template-builtin.pptx"));
const FULL = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/profile_sample_answer.json"), "utf8"));
const OLD = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/profile_facts.json"), "utf8"));
const MAPSRC = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8").match(/const US_MAP = \{[\s\S]*?\n\};/)[0];
const copy = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 700)); } };
const FD = ["filings", "fdRates", "fdRateMap", "fdMarks", "fdForms", "fdStates", "fdRegulator"];
const EVIL = '<script>window.__xss=1</script> & "q" \u0001 ]]>';

// ----- variants -----
function group() { const v = copy(FULL); v.facts.filingsDetail.entity = { kind: "group", name: "Calloway Group", groupName: "Calloway Group", companies: 2, noId: 0 }; v.facts.filingsDetail.marks.rows[0].company = "Calloway Insurance Co and Calloway Home Co"; return v; }
function noRate() { const v = copy(FULL), D = v.facts.filingsDetail; D.rates = { ...D.rates, withImpact: 0, points: [], pointsTotal: 0, lo: null, hi: null, rows: D.rates.rows.map(r => ({ ...r, lo: null, hi: null, withRate: 0, latest: null })) }; D.states.rows.forEach(s => { s.latest = null; }); D.largest = null; return v; }
function unmarked() { const v = copy(FULL); v.facts.filingsDetail.marks = { counts: { new_program: 0, new_state: 0, new_form: 0, withdrawal: 0, large_rate: 0 }, filings: 0, rows: [], largeRate: 0, threshold: 10 }; return v; }
function beforeMarks() { const v = copy(FULL); delete v.facts.filingsDetail.marks; delete v.facts.filingsDetail.everyState; return v; }
function emptied() {
  const v = copy(FULL), D = v.facts.filingsDetail;
  D.totals = { filings: 0, rate: 0, rule: 0, form: 0, other: 0, states: 0, latest: null, undated: 0 }; D.states = { rows: [], noState: 0 }; D.latest = { rows: [], total: 0 }; D.largest = null;
  D.rates = { ...D.rates, filings: 0, withImpact: 0, points: [], rows: [] }; D.regulator = { rows: [], all: null, left: 0 }; D.everyState.forEach(s => { s.n = 0; s.latest = null; });
  D.marks = { counts: { new_program: 0, new_state: 0, new_form: 0, withdrawal: 0, large_rate: 0 }, filings: 0, rows: [], largeRate: 0, threshold: 10 };
  return v;
}
function notSearched() { const v = copy(FULL); v.facts.filingsDetail.everyState.forEach(s => { if (["AK", "HI", "WY"].includes(s.state)) s.searched = false; }); return v; }
function hostile() { const v = copy(FULL), D = v.facts.filingsDetail; D.marks.rows[0].marks[0].reason = EVIL; D.marks.rows[0].toi = EVIL; D.everyState.find(s => s.state === "FL").latest.toi = EVIL; return v; }
function longText() { const v = copy(FULL); v.text.by = "claude"; v.text.filings = { title: "x".repeat(65), points: Array.from({ length: 4 }, (_, i) => ({ lead: "Lead " + i, text: "word ".repeat(44).trim() })) }; return v; }

(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage(); p.on("pageerror", e => errs.push(String(e)));
  await p.setContent("<html><body></body></html>");
  await p.addScriptTag({ path: path.join(ROOT, "node_modules/jszip/dist/jszip.min.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/deck.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/profile-slides.js") });
  await p.addScriptTag({ content: MAPSRC.replace("const US_MAP", "window.MAP_FOR_TEST") });
  const plan = (v, map = true) => p.evaluate(([f, m]) => SNLProfile.plan(f, m ? { usMap: window.MAP_FOR_TEST } : {}), [v.facts, map]);
  const spec = (v, o = {}, map = true) => p.evaluate(([f, t, o, m]) => SNLProfile.spec(f, t, Object.assign({}, o, m ? { usMap: window.MAP_FOR_TEST } : {})), [v.facts, v.text, o, map]);
  const slide = (s, id) => s.slides.find(x => x.id === id);
  const items = (x, type) => x.items.filter(i => i.type === type);
  const cell = c => (typeof c === "string" ? c : c && c.text);
  const bottom = it => it.type === "table" ? it.y + (Array.isArray(it.rowH) ? it.rowH.reduce((a, c) => a + c, 0) : it.rowH * it.rows.length) : it.type === "header" ? it.y + 0.32 : it.y + (it.h || 0);
  const right = it => it.type === "table" ? it.x + it.colW.reduce((a, c) => a + c, 0) : it.x + it.w;

  // ----- the plan -----
  let pl = await plan(FULL);
  const ids = pl.map(r => r.id);
  ok("plan: the detailed filing slides follow the at-a-glance slide, before the questions, all included", same(ids.slice(11, 18), FD) && ids[18] === "questions" && pl.every(r => r.included && r.reason === ""), pl.filter(r => !r.included));
  ok("plan: the labels say last 12 months", same(pl.slice(11, 18).map(r => r.label), ["Filings at a glance, last 12 months", "Rate changes, last 12 months", "Latest rate change by state (map), last 12 months", "New products and market moves, last 12 months", "Latest form and rule filings, last 12 months", "Every state, last 12 months", "Time with the regulator, last 12 months"]));
  pl = await plan(OLD);
  ok("plan: facts saved before this change keep the one filings slide, as labelled before", pl.some(r => r.id === "filings" && r.label === "Recent rate and form filings" && r.included) && !pl.some(r => /^fd/.test(r.id)));
  const reason = async (v, id, map = true) => (await plan(v, map)).find(r => r.id === id);
  ok("plan: without the state outlines, the rate map is left out saying why", !(await reason(FULL, "fdRateMap", false)).included && /outlines of the states didn't load/.test((await reason(FULL, "fdRateMap", false)).reason));
  ok("plan: with no rate impact, rate changes and the rate map are left out, saying S&P's data has none", /No filing carried an overall rate impact/.test((await reason(noRate(), "fdRates")).reason) && /nothing to shade/.test((await reason(noRate(), "fdRateMap")).reason));
  ok("plan: nothing marked, the marks slide is left out, saying a filing with no mark isn't thereby unimportant", /isn't thereby unimportant/.test((await reason(unmarked(), "fdMarks")).reason));
  ok("plan: facts saved before marks and every state existed say to get the figures again", /get the figures again/.test((await reason(beforeMarks(), "fdMarks")).reason) && /get the figures again/.test((await reason(beforeMarks(), "fdStates")).reason));
  const ep = await plan(emptied());
  ok("plan: an empty search keeps the at-a-glance slide; the rest say S&P returned nothing, never that nothing was filed", ep.find(r => r.id === "filings").included && FD.slice(1).every(id => /S&P returned nothing for this search.*doesn't prove nothing was filed/.test(ep.find(r => r.id === id).reason)));
  const un = copy(FULL); un.facts.filings = { unavailable: "S&P filings aren't set up yet, so recent filings can't be searched." };
  ok("plan: when the search couldn't run, the one filings slide is left out with its reason, and no detailed slides", (await plan(un)).some(r => r.id === "filings" && !r.included && /aren't set up yet/.test(r.reason)) && !(await plan(un)).some(r => /^fd/.test(r.id)));
  ok("plan: reasons are plain sentences with no field ids or em dashes", [FULL, noRate(), unmarked(), beforeMarks(), emptied()].length === 5 && (await Promise.all([plan(noRate()), plan(unmarked()), plan(beforeMarks()), plan(emptied())])).flat().every(r => !/_/.test(r.reason) && !r.reason.includes("\u2014") && (r.reason === "" || /^[A-Z].*\.$/.test(r.reason))));

  // ----- the slides -----
  const s = await spec(FULL);
  ok("spec: twenty slides; every state runs on to a second; the detailed ones in plan order", s.slides.length === 20 && same(s.slides.slice(11, 19).map(x => x.id), ["filings", "fdRates", "fdRateMap", "fdMarks", "fdForms", "fdStates", "fdStates", "fdRegulator"]), s.slides.map(x => x.id));
  ok("spec: every detailed slide's title says last 12 months and fits", s.slides.slice(11, 19).every(x => /last 12 months/.test(x.title) && x.title.length <= 65), s.slides.slice(11, 19).map(x => x.title));
  const g = slide(s, "filings");
  ok("at a glance: four tiles (filings, states, rate filings and approved, maybe new)", same(items(g, "tile").map(x => [x.value, x.label]), [["23", "Filings published"], ["6", "States filed in, of 51 searched"], ["10", "Rate filings, 9 approved"], ["5", "May be new products or market moves (inferred)"]]), items(g, "tile").map(x => [x.value, x.label]));
  ok("at a glance: the map of filings by state as native shapes, with a key", items(g, "group").some(x => x.name === "Map of filings by state" && x.items.filter(i => i.type === "freeform").length >= 51) && items(g, "group").some(x => x.name === "Key: filings"));
  ok("at a glance: by filing type, and the filings section's takeaways", same(items(g, "table")[0].rows.map(r => r.map(cell)), [["Rate", "Rule", "Form", "Rate/Rule"], ["9", "6", "7", "1"]]) && items(g, "bullets")[0].items.length >= 1, items(g, "table")[0].rows);
  ok("at a glance: the source says marks are inferred and none returned isn't proof", /Marks/.test(items(g, "source")[0].text) && /None returned|not proof/.test(items(g, "source")[0].text), items(g, "source")[0].text);
  const gm = await spec(FULL, {}, false);
  ok("at a glance without the outlines: a bar chart of filings by state instead", items(slide(gm, "filings"), "chart")[0].kind === "bar" && same(items(slide(gm, "filings"), "chart")[0].categories, ["FL", "LA", "TX", "AL", "GA", "SC"]));
  const r = slide(s, "fdRates");
  ok("rate changes: the filings profile's slide (chart in date order, table by state and line) with the not-weighted note", items(r, "chart")[0].kind === "column" && items(r, "table")[0].rows.length === 7 && /not by premium|unweighted|not weighted/.test(items(r, "source")[0].text) && r.title === "Overall rate changes from (1.5%) to 7.9%, last 12 months", [r.title, items(r, "source")[0].text]);
  ok("rate map: the latest change by state, shaded", items(slide(s, "fdRateMap"), "group").some(x => x.name === "Map of latest rate change by state"));
  const m = slide(s, "fdMarks"), mt = items(m, "table");
  ok("marks: counts by kind", same(mt[0].rows.map(r => r.map(cell)), [["May be", "Filings"], ["New program or product", "2"], ["New to a state", "1"], ["New form or coverage", "1"], ["Withdrawal", "1"]]), mt[0].rows);
  ok("marks: the marked filings with the words that marked them; no company column for one company", same(mt[1].rows[0], ["State", "Type of insurance", "Filing type", "Status", "Published", "Effective", "Filing number", "May be", "Why: the words that marked it"]) && same(mt[1].rows[1].map(cell).slice(0, 3), ["GA", "Inland marine", "Form"]) && cell(mt[1].rows[1][7]) === "New form" && /new endorsement/.test(cell(mt[1].rows[1][8])) && mt[1].rows.length === 6, mt[1].rows.slice(0, 2));
  ok("marks: the title and source say may be, inferred from wording", /may be/.test(m.title) && /may be new|inferred/i.test(items(m, "source")[0].text) && items(m, "bullets")[0].items.some(i => /inferred/.test(i.runs.map(x => x.text).join(""))), [m.title, items(m, "source")[0].text]);
  const gs = await spec(group());
  ok("a group with several companies keeps the company column on the marks and forms slides", cell(items(slide(gs, "fdMarks"), "table")[1].rows[0][0]) === "Company" && cell(items(slide(gs, "fdMarks"), "table")[1].rows[1][0]).startsWith("Calloway") && cell(items(slide(gs, "fdForms"), "table")[0].rows[0][0]) === "Company");
  ok("one company: no company column on the forms slide", cell(items(slide(s, "fdForms"), "table")[0].rows[0][0]) === "State");
  const es = s.slides.filter(x => x.id === "fdStates"), et = es.flatMap(x => items(x, "table"));
  const rowsOf = et.flatMap(t => t.rows.slice(1));
  ok("every state: 51 rows over three tables on two slides, the second with takeaways beside it", es.length === 2 && et.length === 3 && rowsOf.length === 51 && items(es[1], "bullets").length === 1 && es[1].title === "Every state, last 12 months (continued)");
  ok("every state: FL with filings, rate, rule, form, latest (not approved, starred), date, line and new programs", same(rowsOf.find(x => x[0] === "FL").map(cell), ["FL", "10", "4", "3", "3", "4.5*", "10 Oct", "Homeowners", "2"]), rowsOf.find(x => x[0] === "FL"));
  ok("every state: a state S&P returned nothing for says none returned, never zero filings", same(rowsOf.find(x => x[0] === "AK").map(cell), ["AK", "None returned", "", "", "", "", "", "", ""]) && rowsOf.filter(x => cell(x[1]) === "None returned").length === 45 && !rowsOf.some(x => cell(x[1]) === "0"));
  const nsr = (await spec(notSearched())).slides.filter(x => x.id === "fdStates").flatMap(x => items(x, "table")).flatMap(t => t.rows.slice(1));
  ok("every state: a state not searched says not searched", same(nsr.find(x => x[0] === "HI").map(cell).slice(0, 2), ["HI", "Not searched"]) && nsr.filter(x => cell(x[1]) === "Not searched").length === 3);
  ok("every state: the source says none returned isn't proof", es.every(x => /None returned/.test(items(x, "source")[0].text)));
  ok("regulator: the filings profile's slide", items(slide(s, "fdRegulator"), "chart")[0].kind === "bar" && /approximate|approx/i.test(items(slide(s, "fdRegulator"), "source")[0].text));
  const eg = await spec(emptied());
  ok("empty search: the at-a-glance slide says S&P returned nothing, and no detailed slide is built", items(slide(eg, "filings"), "box")[0].name === "Nothing returned" && !eg.slides.some(x => /^fd/.test(x.id)));
  const so = await spec(OLD);
  ok("facts saved before this change: the one filings slide, as it was", so.slides.filter(x => x.id === "filings").length === 1 && items(slide(so, "filings"), "table").some(t => t.name === "Table latest filings") && !so.slides.some(x => /^fd/.test(x.id)));
  const sk = await spec(FULL, { skip: ["fdStates", "fdMarks"] });
  ok("slides the reader leaves out aren't built", sk.slides.length === 17 && !sk.slides.some(x => ["fdStates", "fdMarks"].includes(x.id)));
  const noText = copy(FULL); delete noText.text.filingsDetail;
  ok("a text saved without the detailed takeaways still lays out, titled last 12 months", (await spec(noText)).slides.slice(11, 19).every(x => /last 12 months/.test(x.title)));

  // ----- fit -----
  let outside = [], crashed = [];
  for (const [name, v, map] of [["full", FULL, true], ["no map", FULL, false], ["group", group(), true], ["no rate", noRate(), true], ["unmarked", unmarked(), true], ["before marks", beforeMarks(), true], ["empty", emptied(), true], ["not searched", notSearched(), true], ["hostile", hostile(), true], ["longest text", longText(), true]]) {
    let sp; try { sp = await spec(v, {}, map); } catch (e) { crashed.push([name, String(e).slice(0, 200)]); continue; }
    sp.slides.slice(11).forEach(x => {
      x.items.filter(i => i.type !== "source").forEach(i => { if (bottom(i) > 6.6 + 1e-9 || right(i) > 12.8 + 1e-9 || (i.x !== undefined && i.x < 0.52 - 1e-9) || (i.y !== undefined && i.y < 1.3 - 1e-9)) outside.push([name, x.id, i.type, i.name || i.text, bottom(i), right(i)]); });
      x.items.filter(i => i.type === "table").forEach(t => { if (t.rows.some(r => r.length !== t.colW.length)) outside.push([name, x.id, "table columns", t.name]); });
      if (x.title.length > 65) outside.push([name, x.id, "title", x.title]);
    });
  }
  ok("fit: every variant lays out", crashed.length === 0, crashed);
  ok("fit: every block inside x 0.52 to 12.80, y 1.3 to 6.6; every table row a cell for each column; titles at most 65", outside.length === 0, outside.slice(0, 5));
  ok("no em dashes in the detailed slides", !JSON.stringify(s.slides.slice(11, 19)).includes("\u2014"));

  // ----- hostile text and the built decks -----
  const build = (tpl, sp) => p.evaluate(async ([t, sp]) => {
    const out = await SNLDeck.build(Uint8Array.from(atob(t), c => c.charCodeAt(0)), sp);
    let x = ""; for (let i = 0; i < out.length; i += 0x8000) x += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(x);
  }, [tpl.toString("base64"), sp]);
  let z = await JSZip.loadAsync(Buffer.from(await build(TEMPLATE, await spec(hostile())), "base64"));
  const xml = (await Promise.all(Object.keys(z.files).filter(n => /\.(xml|rels)$/.test(n)).map(n => z.file(n).async("string")))).join("");
  ok("hostile text: escaped in the built deck", !xml.includes("<script>") && xml.includes("&lt;script&gt;window.__xss=1") && !xml.includes("\u0001") && await p.evaluate(() => window.__xss === undefined));
  for (const [name, tpl] of [["stand-in template", TEMPLATE], ["built-in plain template", BUILTIN]]) {
    const bytes = Buffer.from(await build(tpl, s), "base64");
    const file = path.join(OUTDIR, "filingsdetail-" + (tpl === BUILTIN ? "builtin" : "standin") + ".pptx"); fs.writeFileSync(file, bytes);
    z = await JSZip.loadAsync(bytes);
    const names = Object.keys(z.files), read = n => z.file(n).async("string");
    const slides = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)), charts = names.filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n));
    const ct = await read("[Content_Types].xml"), pres = await read("ppt/presentation.xml");
    ok(`${name}: twenty slides and eleven charts, each with its workbook, all declared`, slides.length === 20 && (pres.match(/<p:sldId /g) || []).length === 20 && charts.length === 11 && names.filter(n => /\.xlsx$/.test(n)).length === 11 && slides.concat(charts).every(n => ct.includes('PartName="/' + n + '"')), { slides: slides.length, charts: charts.length });
    const all = (await Promise.all(slides.map(read))).join("\n");
    ok(`${name}: well-formed slides, with the detailed filings in them`, (await p.evaluate(xs => xs.every(x => !new DOMParser().parseFromString(x, "application/xml").getElementsByTagName("parsererror").length), await Promise.all(slides.map(read)))) && ["23 filings in 6 states, last 12 months", "Every state, last 12 months (continued)", "None returned", "may be new products or market moves", "the description says &quot;withdraw&quot;", "CALL-GA-6"].every(x => all.includes(x)), ["23 filings in 6 states, last 12 months", "Every state, last 12 months (continued)", "None returned", "may be new products or market moves", "the description says &quot;withdraw&quot;", "CALL-GA-6"].filter(x => !all.includes(x)));
    let hasPptx = true;
    try { execFileSync("python3", ["-I", "-c", "import pptx"], { stdio: "ignore" }); } catch { hasPptx = false; }
    if (!hasPptx && !process.env.CI) console.log("note: python-pptx isn't installed here, so the check that it opens the deck was left out");
    else {
      let py = "";
      try { py = execFileSync("python3", ["-I", "-c", "import sys\nfrom pptx import Presentation\np=Presentation(sys.argv[1])\nfor i,s in enumerate(p.slides,1):\n  print(i,sum(1 for g in s.shapes if g.has_table),sum(1 for g in s.shapes if g.has_chart))\nprint('slides',len(p.slides))", file], { encoding: "utf8" }); } catch (e) { py = String(e); }
      ok(`${name}: python-pptx opens it, with the tables on the detailed slides`, /slides 20/.test(py) && /^15 2 0$/m.test(py) && /^17 2 0$/m.test(py) && /^18 1 0$/m.test(py), py);
    }
  }

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL crashed " + (e && e.stack)); console.log(pass + " passed, " + (fail + 1) + " failed"); process.exit(1); });
