// The detailed company profile's slides (web/profile-slides.js): the plan with the new slides (lines and states,
// earnings, balance sheet, accident years) on by default and left out with plain reasons when their figures aren't
// there; facts saved before this change keep the nine slides they had; the reader may leave slides out; each new and
// enriched slide with all figures, with none and with ragged mixes, always inside the content area; derived figures
// marked; hostile names kept as text; and the whole made-up sample built on the stand-in template and on the built-in
// plain template, checked as XML and, where python-pptx is installed, opened by it. Every company and reinsurer is made up.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path"); const { execFileSync } = require("child_process");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../..");
const OUTDIR = path.join(__dirname, "../out"); fs.mkdirSync(OUTDIR, { recursive: true });
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const BUILTIN = fs.readFileSync(path.join(ROOT, "web/template-builtin.pptx"));
const FULL = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/profile_sample_answer.json"), "utf8"));
const OLD = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/profile_facts.json"), "utf8"));
const copy = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 700)); } };
const MAG = "EB008C";
const IDS = ["cover", "summary", "premium", "lines", "underwriting", "earnings", "balance", "capital", "reserves", "accident", "reinsurance", "filings", "questions"];
const NEW = ["lines", "earnings", "balance", "accident"];

// ----- variants -----
const LABELS = { npe_by_line: "Net premiums earned by line", loss_lae_ratio_by_line: "Loss and LAE ratio by line", dpe_by_state: "Direct premiums earned by state", loss_ratio_by_state: "Direct loss ratio by state",
  uw_gain: "Net underwriting gain", net_inv_income: "Net investment income earned", realized_gains: "Net realized capital gains", cash_from_ops: "Net cash from operations", investment_yield: "Net yield on invested assets",
  cash_invested: "Cash and invested assets", bonds: "Bonds", stocks: "Common stocks", cash_short_term: "Cash and short-term investments", premiums_receivable: "Premiums receivable", total_liabilities: "Total liabilities",
  unearned_premiums: "Unearned premiums", ay_loss_ratio: "Net loss and LAE ratio by accident year", ay_npe: "Net premiums earned by accident year" };
/** The sample with none of the new figures: every one of them not mapped. */
function noneNew() {
  const v = copy(FULL);
  for (const k of ["assumed_pw", "ceded_pw", "losses_incurred", "uw_gain", "net_inv_income", "realized_gains", "dividends_paid", "capital_contributed", "surplus_notes", "unassigned_funds", "cash_from_ops", "cash_invested", "bonds", "stocks", "cash_short_term", "premiums_receivable", "total_liabilities", "unearned_premiums", "rbc_acl", "rbc_tac", "pyd_two_year", "commission_ratio", "investment_yield", "roae"]) delete v.facts.series[k];
  for (const k of ["gross_pw", "pyd_to_npe", "rbc_ratio_calc", "rbc_acl_implied", "invested_to_liabilities", "liabilities_to_surplus", "receivable_to_dpw", "bonds_share", "stocks_share", "cash_share", "net_capital_flow"]) delete v.facts.derived[k];
  v.facts.detail = { derived: {}, combinedRun: v.facts.detail.combinedRun };
  v.facts.missing = Object.entries(LABELS).map(([field, label]) => ({ field, label, reason: "not mapped" }));
  delete v.text.earnings; delete v.text.balance;
  return v;
}
/** No figures at all, but the facts are new (they have a detail). */
function nothing() { const v = noneNew(); v.facts.years = []; v.facts.series = {}; v.facts.derived = {}; v.facts.detail = { derived: {} }; delete v.facts.mix; delete v.facts.reinsurers; return v; }
// a deterministic pseudo-random ragged mix: some series, derived figures and parts of the detail taken out
function ragged(seed) {
  let s = seed * 9301 + 49297; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const v = copy(FULL), F = v.facts;
  for (const k of Object.keys(F.series)) if (rnd() < 0.4) delete F.series[k];
  for (const k of Object.keys(F.series)) if (rnd() < 0.2) F.series[k] = F.series[k].map((x, i) => (i % 2 ? null : x));
  for (const k of Object.keys(F.derived)) if (rnd() < 0.4) delete F.derived[k];
  for (const k of ["lines", "states", "recoverables", "accidentYears", "combinedRun"]) if (rnd() < 0.4) delete F.detail[k];
  if (F.detail.lines && rnd() < 0.5) F.detail.lines.items.forEach(l => { l.lossRatio = null; l.npw = null; });
  if (F.detail.states && rnd() < 0.5) F.detail.states.items.forEach(x => { x.dpe = null; });
  if (F.detail.recoverables && rnd() < 0.5) { F.detail.recoverables.tagged = false; F.detail.recoverables.items.forEach(r => { r.tag = null; }); }
  if (F.detail.accidentYears && rnd() < 0.5) F.detail.accidentYears.rows = F.detail.accidentYears.rows.slice(-1).map(r => ({ ...r, change: null, npe: null }));
  if (rnd() < 0.3) delete F.mix;
  if (rnd() < 0.3) delete F.reinsurers;
  if (rnd() < 0.3) { F.years = F.years.slice(2); for (const k of Object.keys(F.series)) F.series[k] = F.series[k].slice(2); for (const k of Object.keys(F.derived)) if (Array.isArray(F.derived[k])) F.derived[k] = F.derived[k].slice(2); if (F.detail.accidentYears) F.detail.accidentYears.rows.forEach(r => { r.values = r.values.slice(2); }); }
  return v;
}
const LONG = n => { let s = "", i = 0; const w = ["Florida", "homeowners", "growth", "surplus", "reinsurance", "recoverables", "premium", "development"]; while (s.length < n) s += (s ? " " : "") + w[i++ % w.length]; return s; };
function maxText() {
  const v = copy(FULL); v.text.by = "claude"; v.text.cover.subtitle = LONG(110).slice(0, 110);
  ["summary", "premium", "underwriting", "earnings", "balance", "capital", "reserves", "reinsurance", "filings"].forEach(k => {
    v.text[k] = { title: LONG(65).slice(0, 65), points: Array.from({ length: k === "summary" ? 7 : 4 }, (_, i) => ({ lead: "Lead number " + (i + 1) + " is long", text: LONG(220).slice(0, 220) })) };
  });
  return v;
}
const EVIL = '<script>window.__xss=1</script> & "q" \u0001 ]]>';
function hostile() {
  const v = copy(FULL); const X = v.facts.detail;
  X.lines.items[0].name = EVIL; X.states.items[0].state = EVIL; X.recoverables.items[0].name = EVIL; X.recoverables.items[1].tag = EVIL;
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
  const spec = (v, o) => p.evaluate(([f, t, o]) => SNLProfile.spec(f, t, o), [v.facts, v.text, o || null]);
  const slide = (s, id) => s.slides.find(x => x.id === id);
  const items = (s, id, type) => slide(s, id).items.filter(i => i.type === type);
  const cell = c => (typeof c === "string" ? c : c && c.text);
  const bottom = it => it.type === "table" ? it.y + (Array.isArray(it.rowH) ? it.rowH.reduce((a, c) => a + c, 0) : it.rowH * it.rows.length) : it.type === "header" ? it.y + 0.32 : it.y + (it.h || 0);
  const right = it => it.type === "table" ? it.x + it.colW.reduce((a, c) => a + c, 0) : it.x + it.w;

  // ----- the plan -----
  let pl = await plan(FULL);
  ok("plan: the full sample fills all thirteen slides, the new ones on by default, in deck order", same(pl.map(r => r.id), IDS) && pl.every(r => r.included && r.reason === ""), pl);
  ok("plan: the new slides' labels", same(pl.filter(r => NEW.includes(r.id)).map(r => r.label), ["Lines and states", "Earnings", "Balance sheet", "Accident years"]));
  pl = await plan(OLD);
  ok("plan: facts saved before this change keep the nine slides they had, and none of the new ones", same(pl.map(r => r.id), IDS.filter(id => !NEW.includes(id))) && pl.every(r => r.included), pl.map(r => r.id));
  pl = await plan(noneNew());
  const why = id => pl.find(r => r.id === id);
  ok("plan: with none of the new figures, the new slides are left out, each saying which figures aren't mapped", NEW.every(id => !why(id).included)
    && why("earnings").reason === "Net underwriting gain, net investment income earned, net realized capital gains, net cash from operations and net yield on invested assets aren't mapped to Snowflake yet."
    && why("accident").reason === "Net loss and LAE ratio by accident year isn't mapped to Snowflake yet."
    && why("lines").reason === "Net premiums earned by line, loss and LAE ratio by line, direct premiums earned by state and direct loss ratio by state aren't mapped to Snowflake yet.", pl.filter(r => !r.included).map(r => r.reason.slice(-80)));
  ok("plan: and every slide that was there before still is", IDS.filter(id => !NEW.includes(id)).every(id => why(id).included));
  ok("plan: reasons are plain sentences with no field ids or em dashes", pl.concat(await plan(nothing())).every(r => !/_/.test(r.reason) && !r.reason.includes("—") && (r.reason === "" || /^[A-Z].*\.$/.test(r.reason))));
  const empt = copy(noneNew()); empt.facts.missing = empt.facts.missing.map(m => ({ ...m, reason: "S&P returned nothing for it" }));
  ok("plan: a mapped figure that came back empty says S&P returned nothing", (await plan(empt)).find(r => r.id === "accident").reason === "S&P returned nothing for net loss and LAE ratio by accident year for 2021 to 2025.", (await plan(empt)).find(r => r.id === "accident"));

  // ----- the whole sample -----
  const s = await spec(FULL);
  ok("spec: thirteen slides, cover first, in plan order", s.slides.length === 13 && s.slides[0].kind === "cover" && same(s.slides.slice(1).map(x => x.id), IDS.slice(1)));
  ok("every content slide ends with a source line; the new ones say (derived) where they show worked-out figures", s.slides.slice(1).every(x => x.items[x.items.length - 1].type === "source") && ["lines", "balance", "accident", "capital", "reinsurance"].every(id => items(s, id, "source")[0].text.includes("(derived)")));
  const lt = items(s, "lines", "table");
  ok("lines and states: the five largest lines then Other, with premiums, share and loss and LAE ratio", same(lt[0].rows[0], ["Line", "DPW", "NPW", "NPE", "Share", "Loss ratio"]) && same(lt[0].rows[1].map(cell), ["Homeowners", "81.0", "52.6", "50.1", "66.1", "60.0"]) && lt[0].rows.length === 7 && cell(lt[0].rows[6][0]) === "Other" && lt[0].rows[6][5] === "n/d", lt[0].rows);
  ok("lines and states: the states with direct premiums written and earned and the direct loss ratio", same(lt[1].rows[0], ["State", "DPW", "DPE", "Share", "Loss ratio"]) && same(lt[1].rows[1].map(cell), ["FL", "70.0", "67.2", "57.1", "56.1"]), lt[1].rows);
  const lc = items(s, "lines", "chart");
  ok("lines and states: two bar charts of the loss ratios, without Other", lc.length === 2 && lc.every(c => c.kind === "bar" && c.categories.length === 5 && !c.categories.includes("Other")) && same(lc[0].series[0].values, [60, 53.4, 39.2, 66.9, 56.3]), lc.map(c => c.categories));
  const et = items(s, "earnings", "table")[0];
  ok("earnings: a chart of underwriting gain, investment income and net income, and the table by year", same(items(s, "earnings", "chart")[0].series.map(x => x.name), ["Underwriting gain", "Investment income", "Net income"]) && same(et.rows.map(r => cell(r[0])).slice(1), ["Net underwriting gain", "Net investment income", "Net realized capital gains", "Net income", "Net cash from operations", "Investment yield (%)", "ROAE (%)"]), et.rows.map(r => cell(r[0])));
  ok("earnings: losses in magenta; a reported return on equity isn't marked derived; cumulative net income in the source (derived)", same(et.rows[1][2], { text: "(2.4)", color: MAG }) && !JSON.stringify(et.rows).includes("ROAE (%, derived)") && items(s, "earnings", "source")[0].text.includes("Net income over the years shown: $11.0M (derived)."));
  const bc = items(s, "balance", "chart")[0], bt = items(s, "balance", "table");
  ok("balance sheet: cash and invested assets stacked by kind, only the largest labelled", bc.kind === "stackedColumn" && same(bc.series.map(x => x.name), ["Bonds", "Common stocks", "Cash and short-term", "Other invested assets"]) && bc.series.slice(1).every(x => x.labels === false) && same(bc.series[3].values, [3.2, 3.6, 3.7, 4.1, 4.4]), bc.series);
  ok("balance sheet: amounts by year, and liquidity and leverage (derived) in their own table", bt.length === 2 && cell(bt[0].rows[1][0]) === "Cash and invested assets" && bt[0].rows.length === 9 && same(bt[1].rows.map(r => cell(r[0])).slice(1), ["Invested assets to liabilities (x)", "Liabilities to surplus (x)", "NPW to surplus (x)", "Receivables to DPW (%)", "Bonds share (%)", "Stocks share (%)", "Cash share (%)"]) && items(s, "balance", "header").some(h => h.text === "Liquidity and leverage (derived)"), bt.map(t => t.rows.map(r => cell(r[0]))));
  const at = items(s, "accident", "table")[0];
  ok("accident years: one row each, a column for each statement year, the change and premiums earned", same(at.rows[0], ["Accident year", "2021", "2022", "2023", "2024", "2025", "Change (pts)", "NPE ($M)"]) && at.rows.length === 8 && same(at.rows[4].map(cell), ["2022", "", "70.1", "72.4", "74.7", "77.0", "+6.9", "54.1"]), at.rows);
  ok("accident years: a year not yet reported is blank, not n/d; a worsening is magenta; one statement only has no change", at.rows[7][1] === "" && same(at.rows[4][6], { text: "+6.9", color: MAG }) && at.rows[6][6] === "(0.4)" && at.rows[7][6] === "n/d");
  ok("accident years: tiles for the largest change and how many are worse, and a chart of the changes", same(items(s, "accident", "tile").map(t => t.value), ["+6.9 pts", "5 of 6"]) && items(s, "accident", "tile")[0].color === MAG && items(s, "accident", "chart")[0].categories.length === 6, items(s, "accident", "tile").map(t => [t.value, t.label]));
  const pt = items(s, "premium", "table").find(t => t.name === "Table by year");
  ok("premium: assumed and ceded premiums as reported join the table", same(pt.rows.map(r => cell(r[0])), ["$M unless shown", "Direct premiums written", "Assumed premiums written", "Gross premiums written", "Ceded premiums written", "Net premiums written", "Net premiums earned", "Ceded share (%, derived)", "DPW growth (%, derived)"]), pt.rows.map(r => cell(r[0])));
  ok("underwriting: the commission ratio, and the reported return on equity", items(s, "underwriting", "table")[0].rows.some(r => r[0] === "Commission ratio (%)") && items(s, "underwriting", "table")[0].rows.some(r => r[0] === "ROAE (%)") && !items(s, "underwriting", "source")[0].text.includes("(derived)"));
  const ct = items(s, "capital", "table");
  ok("capital: surplus notes and unassigned funds, then capital flows and RBC in their own table", ct.length === 2 && ct[0].rows.some(r => r[0] === "Surplus notes") && same(ct[1].rows.map(r => cell(r[0])).slice(1), ["Dividends to stockholders", "Capital paid in", "Paid in less dividends (derived)", "Total adjusted capital", "Authorized control level", "RBC ratio (%)"]), ct.map(t => t.rows.map(r => cell(r[0]))));
  ok("reserves: development to premiums earned and two-year development", items(s, "reserves", "table")[0].rows.some(r => r[0] === "PYD to NPE (%, derived)") && same(items(s, "reserves", "table")[0].rows.find(r => r[0] === "Two-year development").slice(1), ["(1.2)", { text: "3.4", color: MAG }, { text: "3.1", color: MAG }, { text: "0.6", color: MAG }, "(0.9)"]));
  const rt = items(s, "reinsurance", "table").find(t => t.name === "Table recoverables");
  ok("reinsurance: recoverables by reinsurer with their share of surplus and status", same(rt.rows[0], ["Reinsurer", "$M", "Share", "To surplus", "Status"]) && same(rt.rows[1].map(cell), ["Nonesuch Re", "10.0", "30.0", "17.8", "Authorized"]) && same(rt.rows[3].map(cell), ["Tarrow Re", "5.0", "15.0", "8.9", "Unauthorized"]), rt.rows);
  ok("reinsurance: a tile for the share owed by reinsurers not authorized (derived)", items(s, "reinsurance", "tile").some(t => t.value === "18.0%" && /not authorized, 2025 \(derived\)/.test(t.label)));
  ok("no em dashes anywhere", !JSON.stringify(s).includes("—"));

  // ----- the reader chooses slides -----
  const sk = await spec(FULL, { skip: ["earnings", "balance", "cover", "accident"] });
  ok("slides the reader leaves out aren't built; the cover always is", sk.slides.length === 10 && sk.slides[0].kind === "cover" && !sk.slides.some(x => ["earnings", "balance", "accident"].includes(x.id)), sk.slides.map(x => x.id || x.kind));
  ok("with nothing left out the deck is as planned", (await spec(FULL, { skip: [] })).slides.length === 13 && (await spec(FULL, { skip: "nonsense" })).slides.length === 13);

  // ----- facts saved before this change: the same nine slides -----
  const so = await spec(OLD);
  ok("old facts: nine slides, none of the new ones", same(so.slides.slice(1).map(x => x.id), IDS.slice(1).filter(id => !NEW.includes(id))));
  ok("old facts: the existing slides read as they did (no new rows, blocks or tiles)", !items(so, "capital", "table").some(t => t.rows.some(r => r[0] === "Surplus notes")) && items(so, "capital", "table").length === 1 && !items(so, "reinsurance", "table").some(t => t.name === "Table recoverables") && items(so, "reinsurance", "tile").length === 2);

  // ----- fit: with all, none and ragged figures, and the longest text -----
  const variants = [["full", FULL], ["none of the new figures", noneNew()], ["no figures", nothing()], ["longest text", maxText()], ["old facts", OLD], ["hostile names", hostile()]];
  for (let i = 1; i <= 40; i++) variants.push(["ragged " + i, ragged(i)]);
  let outside = [], longTitles = [], crashed = [], sources = [];
  for (const [name, v] of variants) {
    let sp; try { sp = await spec(v); } catch (e) { crashed.push([name, String(e).slice(0, 200)]); continue; }
    sp.slides.slice(1).forEach(x => {
      x.items.filter(i => i.type !== "source").forEach(i => { if (bottom(i) > 6.6 + 1e-9 || right(i) > 12.8 + 1e-9 || (i.x !== undefined && i.x < 0.52 - 1e-9) || (i.y !== undefined && i.y < 1.3 - 1e-9)) outside.push([name, x.id, i.type, i.name || i.text, bottom(i), right(i)]); });
      if (x.title.length > 65) longTitles.push([name, x.title]);
      const src = x.items.find(i => i.type === "source"); if (!src || src.text.length > 200) sources.push([name, x.id, src && src.text]);
      x.items.filter(i => i.type === "table").forEach(t => { if (t.rows.some(r => r.length !== t.colW.length)) outside.push([name, x.id, "table columns", t.name]); });
    });
  }
  ok(`fit: for ${variants.length} sets of figures (all, none, ragged, longest text, old) every slide is laid out`, crashed.length === 0, crashed);
  ok("fit: every block sits inside x 0.52 to 12.80, y 1.3 to 6.6, and every table row has a cell for each column", outside.length === 0, outside.slice(0, 5));
  ok("fit: titles are at most 65 characters, and every content slide has a source line of one line", longTitles.length === 0 && sources.length === 0, [longTitles.slice(0, 3), sources.slice(0, 3)]);
  const mx = await spec(maxText());
  ok("longest text: the new sections' takeaways are capped rather than shrunk", items(mx, "balance", "bullets")[0].items.length < 4 && items(mx, "earnings", "bullets")[0].size === 13 && items(mx, "balance", "bullets")[0].size === 13 && items(mx, "balance", "bullets")[0].items.length >= 1);
  const nn = await spec(noneNew());
  ok("none of the new figures: the existing slides keep their earlier shape", items(nn, "capital", "table").length === 1 && items(nn, "reinsurance", "tile").length === 2 && !items(nn, "premium", "table").some(t => t.rows.some(r => cell(r[0]) === "Assumed premiums written")));

  // ----- hostile names stay text, and the deck builds -----
  const hs = await spec(hostile());
  ok("hostile names in lines, states and recoverables are passed through as text, cut to fit", JSON.stringify(hs).includes("&quot;") === false && items(hs, "lines", "table")[0].rows[1][0].startsWith("<script>"));
  const build = (tpl, sp) => p.evaluate(async ([s, sp]) => {
    const out = await SNLDeck.build(Uint8Array.from(atob(s), c => c.charCodeAt(0)), sp);
    let t = ""; for (let i = 0; i < out.length; i += 0x8000) t += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(t);
  }, [tpl.toString("base64"), sp]);
  let z = await JSZip.loadAsync(Buffer.from(await build(TEMPLATE, hs), "base64"));
  const xml = (await Promise.all(Object.keys(z.files).filter(n => /\.(xml|rels)$/.test(n)).map(n => z.file(n).async("string")))).join("");
  ok("hostile names: the built deck has them escaped", !xml.includes("<script>") && xml.includes("&lt;script&gt;window.__xss=1") && !xml.includes("\u0001") && await p.evaluate(() => window.__xss === undefined));

  // ----- the whole sample deck, on the stand-in template and on the built-in plain template -----
  for (const [name, tpl] of [["stand-in template", TEMPLATE], ["built-in plain template", BUILTIN]]) {
    const bytes = Buffer.from(await build(tpl, s), "base64");
    const file = path.join(OUTDIR, "profiledetail-" + (tpl === BUILTIN ? "builtin" : "standin") + ".pptx"); fs.writeFileSync(file, bytes);
    z = await JSZip.loadAsync(bytes);
    const names = Object.keys(z.files), read = n => z.file(n).async("string");
    const slides = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)), charts = names.filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n));
    const ct = await read("[Content_Types].xml"), pres = await read("ppt/presentation.xml");
    ok(`${name}: thirteen slides and nine charts, each chart with its workbook`, slides.length === 13 && (pres.match(/<p:sldId /g) || []).length === 13 && charts.length === 9 && names.filter(n => /\.xlsx$/.test(n)).length === 9, { slides: slides.length, charts: charts.length });
    ok(`${name}: every slide and chart is declared, and nothing declared is missing`, slides.concat(charts).every(n => ct.includes('PartName="/' + n + '"')) && [...ct.matchAll(/PartName="\/([^"]+)"/g)].every(m => names.includes(m[1])));
    const all = (await Promise.all(slides.map(read))).join("\n");
    ok(`${name}: the new slides' titles and figures are in it`, ["Lines and states, 2025", "Earnings, 2021 to 2025", "Balance sheet, 2021 to 2025", "Accident years, 2021 to 2025", "Unauthorized", "+6.9 pts"].every(x => all.includes(x)) && (all.match(/Sample: made-up figures/g) || []).length === 12);
    const chartXml = (await Promise.all(charts.map(read))).join("\n");
    ok(`${name}: the charts carry the new figures`, chartXml.includes("<c:v>Homeowners</c:v>") && chartXml.includes("<c:v>Underwriting gain</c:v>") && chartXml.includes("<c:v>Bonds</c:v>") && chartXml.includes("<c:v>2022</c:v>"));
    // opened by another program, python-pptx, where it is installed (GitHub's test run installs it)
    let hasPptx = true;
    try { execFileSync("python3", ["-I", "-c", "import pptx"], { stdio: "ignore" }); } catch { hasPptx = false; }
    if (!hasPptx && !process.env.CI) console.log("note: python-pptx isn't installed here, so the check that it opens the deck was left out");
    else {
      let py = "";
      try { py = execFileSync("python3", ["-I", "-c", "import sys\nfrom pptx import Presentation\np=Presentation(sys.argv[1])\nfor i,s in enumerate(p.slides,1):\n  print(i,sum(1 for g in s.shapes if g.has_table),sum(1 for g in s.shapes if g.has_chart))\nprint('slides',len(p.slides))", file], { encoding: "utf8" }); } catch (e) { py = String(e); }
      ok(`${name}: python-pptx opens it, with the tables and charts on the new slides`, /slides 13/.test(py) && /^4 2 2$/m.test(py) && /^6 1 1$/m.test(py) && /^7 2 1$/m.test(py) && /^10 1 1$/m.test(py), py);
    }
  }

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL crashed " + (e && e.stack)); console.log(pass + " passed, " + (fail + 1) + " failed"); process.exit(1); });
