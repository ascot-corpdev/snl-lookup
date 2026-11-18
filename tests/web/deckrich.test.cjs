// The richer filings profile's slides (web/profile-slides.js) and the freeform shapes and groups they need (web/deck.js):
// a freeform from path data (its geometry worked out by hand, its XML in schema order, a hatch, a group's frame), the
// two US maps from the page's own US_MAP outlines (one shape per state, shaded by filings and by the latest rate change,
// a state S&P returned nothing for hatched, labels and the small states' callouts, the key), exposure, rate adequacy,
// programs and forms and the market slides with every figure from the hand-worked facts of
// tests/functions/deckrich_core_test.ts (tests/fixtures/deckrich_facts.json), the slides left out and why (with what
// summarising would cost), hostile text, everything inside the content area, and the made-up sample built on the
// stand-in template, opened in python-pptx. Every company, filing and figure is made up.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path"); const { execFileSync } = require("child_process");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../.."), OUT = path.join(__dirname, "../out"); fs.mkdirSync(OUT, { recursive: true });
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const RICH = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/deckrich_facts.json"), "utf8"));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/deckfilings_sample_answer.json"), "utf8"));
const MAPSRC = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8").match(/const US_MAP = \{[\s\S]*?\n\};/)[0];
const copy = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 900)); } };
const NAVY = "262166", MAG = "EB008C", TEAL = "00857C", EMU = 914400;
const W = (() => { const w = {}, set = (c, v) => { for (const ch of c) w[ch] = v; };
  set("ijl'", 222); set(" ft.,:;!|/[]\\", 278); set("r()-`", 333); set("\"", 355); set("*", 389); set("^", 469); set("ckszvxyJ_", 500); set("abdeghnopqu0123456789$#?L~+=<>", 556); set("FTZ", 611); set("ABEKPSVXY&", 667);
  set("wCDHNRU", 722); set("GOQ", 778); set("mM", 833); set("%", 889); set("W", 944); set("@", 1015); set("I", 278); return w; })();
const width10 = s => [...s].reduce((a, ch) => a + (W[ch] || 580), 0) / 1000 * 10 / 72;

// ----- variants of the hand-worked facts -----
function noSummaries() { const v = copy(RICH), f = v.facts; f.summaries.rate = { filings: 4, withDocument: 3, summarised: 0, older: 0 }; f.summaries.form = { filings: 2, withDocument: 2, summarised: 0, older: 0 };
  f.exposure = { rows: [], total: 0, latest: [], latestPremium: null, latestPolicyholders: null, summarised: 0 }; f.adequacy = { rows: [], total: 0, summarised: 0 }; f.programs = { programs: [], programsTotal: 0, forms: [], formsTotal: 0, summaries: 0 };
  f.market = { checked: true, reason: "No state is in the market index yet, so the company can't be set against the market. Corp Dev can sweep a state on the Market tab.", rows: [], coverage: [], indexed: [] }; return v; }
function olderOnly() { const v = noSummaries(); v.facts.summaries.rate = { filings: 4, withDocument: 3, summarised: 2, older: 2 }; return v; }
function notLooked() { const v = noSummaries(); v.facts.summaries = { checked: false, note: "Saved summaries couldn't be read just now, so none are used.", version: 2, rate: v.facts.summaries.rate, form: v.facts.summaries.form }; return v; }
function oldFacts() { const v = copy(RICH); ["map", "summaries", "exposure", "adequacy", "programs", "market"].forEach(k => delete v.facts[k]); return v; }
function smallStates() { const v = copy(RICH); v.facts.states.rows.push({ state: "MA", n: 2, rate: 1, latest: { date: "2026-05-01", state: "MA", toi: "Homeowners", rate: 6.1, status: "Approved", approved: true } }, { state: "RI", n: 1, rate: 0, latest: null }); v.facts.map.searched.push("MA", "RI"); return v; }
const EVIL = '<script>window.__xss=1</script> & "q" \u0001';
function hostile() { const v = copy(RICH); v.facts.programs.programs[0].name = EVIL; v.facts.adequacy.rows[0].lossCostRef = EVIL; v.facts.programs.forms[0].title = EVIL; v.facts.market.rows[0].toi = EVIL; v.text.exposure.points[0] = { lead: EVIL, text: EVIL }; return v; }

(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage(); p.on("pageerror", e => errs.push(String(e)));
  await p.setContent("<html><body></body></html>");
  await p.addScriptTag({ path: path.join(ROOT, "node_modules/jszip/dist/jszip.min.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/deck.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/profile-slides.js") });
  await p.addScriptTag({ content: MAPSRC.replace("const US_MAP", "window.MAP_FOR_TEST") });
  const plan = (v, map = true) => p.evaluate(([f, m]) => SNLProfile.filingsPlan(f, m ? { usMap: window.MAP_FOR_TEST } : {}), [v.facts, map]);
  const spec = (v, map = true) => p.evaluate(([f, t, m]) => SNLProfile.filingsSpec(f, t, m ? { usMap: window.MAP_FOR_TEST } : {}), [v.facts, v.text, map]);
  const build = sp => p.evaluate(async ([t, sp]) => { const out = await SNLDeck.build(Uint8Array.from(atob(t), ch => ch.charCodeAt(0)), sp);
    let x = ""; for (let i = 0; i < out.length; i += 0x8000) x += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(x); }, [TEMPLATE.toString("base64"), sp]).then(s => Buffer.from(s, "base64"));
  const tryBuild = sp => p.evaluate(async ([t, sp]) => { try { await SNLDeck.build(Uint8Array.from(atob(t), ch => ch.charCodeAt(0)), sp); return ""; } catch (e) { return e.message; } }, [TEMPLATE.toString("base64"), sp]);
  const slide = (s, id) => s.slides.find(x => x.id === id);
  const items = (s, id, type) => slide(s, id).items.filter(i => i.type === type);
  const one = (s, id, type, name) => items(s, id, type).find(i => !name || i.name === name);
  const cells = t => t.rows.map(r => r.map(c => c && typeof c === "object" ? c.text : c));
  const src = (s, id) => one(s, id, "source").text;
  const slidesOf = async zip => Promise.all(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).map(n => zip.file(n).async("string")));

  // ----- deck.js: a freeform and a group, worked out by hand -----
  const content = its => ({ slides: [{ kind: "content", title: "Freeform test", items: its }] });
  let z = await JSZip.loadAsync(await build(content([{ type: "group", name: "Shapes", items: [
    { type: "freeform", name: "Triangle", path: "M0 0L10 0L10 10Z", view: [0, 0, 10, 10], x: 1, y: 1, w: 2, h: 2, fill: "#eb008c", line: { color: "FFFFFF", width: 0.75 } },
    { type: "freeform", name: "Box", path: "m5 5h5v5h-5z", view: [0, 0, 10, 10], x: 1, y: 1, w: 2, h: 2, pattern: { prst: "ltUpDiag", fg: "A6A6BF", bg: "FFFFFF" }, line: { color: "A6A6BF", dash: true } },
    { type: "text", name: "Label", x: 3.5, y: 1.2, w: 0.6, h: 0.3, paras: [{ runs: [{ text: "FL", size: 10, bold: true }] }] }] }])));
  let xml = (await slidesOf(z))[0];
  const tri = xml.match(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="Triangle"\/>[\s\S]*?<\/p:sp>/)[0], box = xml.match(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="Box"\/>[\s\S]*?<\/p:sp>/)[0];
  // the triangle fills the whole 2 in box: off 1 in, ext 2 in; points (0,0), (2 in, 0), (2 in, 2 in), closed
  ok("freeform: placed on its outline's bounds in EMU, its path points relative to them, closed", tri.includes(`<a:off x="${EMU}" y="${EMU}"/><a:ext cx="${2 * EMU}" cy="${2 * EMU}"/>`) && tri.includes(`<a:path w="${2 * EMU}" h="${2 * EMU}"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="${2 * EMU}" y="0"/></a:lnTo><a:lnTo><a:pt x="${2 * EMU}" y="${2 * EMU}"/></a:lnTo><a:close/></a:path>`), tri);
  // the box: relative path from (5,5) to (10,10) of a 10-unit view on 2 in: 1 in square at 2 in, 2 in
  ok("freeform: a relative path (m h v z) lands at 2 in, 2 in, 1 in square", box.includes(`<a:off x="${2 * EMU}" y="${2 * EMU}"/><a:ext cx="${EMU}" cy="${EMU}"/>`) && box.includes(`<a:lnTo><a:pt x="${EMU}" y="${EMU}"/></a:lnTo>`));
  // each part found after the one before it (so "<a:ln " is the line, not a path's "<a:lnTo>")
  const order = s => { let at = 0; return ["<p:nvSpPr>", "<p:spPr>", "<a:xfrm>", "<a:custGeom>", "<a:avLst/>", "<a:gdLst/>", "<a:ahLst/>", "<a:cxnLst/>", "<a:rect ", "<a:pathLst>", "</a:custGeom>", "Fill>", "<a:ln ", "</p:spPr>"].map(t => { const i = s.indexOf(t, at); at = i < 0 ? at : i + 1; return i; }); };
  ok("freeform XML in schema order: nvSpPr, spPr (xfrm, custGeom (avLst, gdLst, ahLst, cxnLst, rect, pathLst), fill, line)", [tri, box].every(s => { const o = order(s); return o.every(i => i >= 0) && o.every((v, i) => !i || v > o[i - 1]); }), [order(tri), order(box)]);
  ok("freeform colours: a solid fill in upper case, a white line; a hatch with its two colours and a dashed line", tri.includes('<a:solidFill><a:srgbClr val="EB008C"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/>') && box.includes('<a:pattFill prst="ltUpDiag"><a:fgClr><a:srgbClr val="A6A6BF"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>') && box.includes('<a:prstDash val="dash"/>'));
  const grp = xml.match(/<p:grpSp>[\s\S]*<\/p:grpSp>/)[0];
  // the group's frame: from (1, 1) to the label's right and bottom (4.1, 3): ext 3.1 x 2 in; children in slide inches
  ok("group: one p:grpSp holding the three shapes, its frame the bounds of what it holds, children in slide units", /^<p:grpSp><p:nvGrpSpPr><p:cNvPr id="\d+" name="Shapes"\/><p:cNvGrpSpPr\/><p:nvPr\/><\/p:nvGrpSpPr><p:grpSpPr><a:xfrm>/.test(grp)
    && grp.includes(`<a:off x="${EMU}" y="${EMU}"/><a:ext cx="${Math.round(3.1 * EMU)}" cy="${2 * EMU}"/><a:chOff x="${EMU}" y="${EMU}"/><a:chExt cx="${Math.round(3.1 * EMU)}" cy="${2 * EMU}"/>`) && (grp.match(/<p:sp>/g) || []).length === 3, grp.slice(0, 400));
  ok("the slide is well-formed XML", await p.evaluate(x => !new DOMParser().parseFromString(x, "application/xml").getElementsByTagName("parsererror").length, xml));
  ok("a path the builder can't read is refused in a plain sentence", /^The slide plan has a problem: slide 1, item 1 has a shape outline the builder can't read\.$/.test(await tryBuild(content([{ type: "freeform", path: "M0 0 C1 1 2 2 3 3", x: 1, y: 1, w: 1, h: 1 }]))));
  ok("a group can't hold a chart", /a group can't hold \(chart\)/.test(await tryBuild(content([{ type: "group", items: [{ type: "chart", kind: "column" }] }]))));
  fs.writeFileSync(path.join(OUT, "deckrich-freeform.pptx"), await build(content([{ type: "group", name: "Shapes", items: [{ type: "freeform", name: "Triangle", path: "M0 0L10 0L10 10Z", view: [0, 0, 10, 10], x: 1, y: 1, w: 2, h: 2, fill: MAG }] }])));

  // ----- the plan -----
  const ALL = ["cover", "summary", "states", "rateMap", "rates", "exposure", "adequacy", "programs", "market", "years", "forms", "regulator", "questions"];
  let pl = await plan(RICH);
  ok("plan: thirteen slides, every one filled from the hand-worked facts", same(pl.map(r => r.id), ALL) && pl.every(r => r.included && r.reason === ""), pl.filter(r => !r.included));
  const why = (pl, id) => pl.find(r => r.id === id).reason;
  pl = await plan(noSummaries());
  // 3 of the 4 rate filings have a document: 3 summaries, 3 S&P requests, 3 x $2.30 = $6.90 to 3 x $3.50 = $10.50
  ok("no summaries: exposure and adequacy left out, saying what summarising would cost", why(pl, "exposure") === "None of the 4 rate filings has a saved summary yet. Summarising the latest 3 would take 3 S&P requests and about $6.90 to $10.50 of Claude reading; choose it below to include this slide." && why(pl, "adequacy") === why(pl, "exposure"), why(pl, "exposure"));
  // 2 form filings with documents: $4.60 to $7.00
  ok("no summaries: programs and forms left out, with the form filings' cost", why(pl, "programs") === "None of the 2 form filings has a saved summary yet. Summarising the latest 2 would take 2 S&P requests and about $4.60 to $7.00 of Claude reading; choose it below to include this slide.", why(pl, "programs"));
  ok("no index: the market slide left out with the function's reason", why(pl, "market") === "No state is in the market index yet, so the company can't be set against the market. Corp Dev can sweep a state on the Market tab.");
  pl = await plan(olderOnly());
  ok("only older summaries: says they were made before these figures were read and what refreshing costs", why(pl, "exposure") === "The 2 summarised rate filings don't state the premium or policyholders they affect. 2 of them were summarised before these figures were read; refreshing them would take 2 S&P requests and about $4.60 to $7.00 of Claude reading.", why(pl, "exposure"));
  pl = await plan(notLooked());
  ok("summaries that couldn't be read: the reason, and that the slide needs them", why(pl, "exposure") === "Saved summaries couldn't be read just now, so none are used. This slide needs them.");
  pl = await plan(RICH, false);
  ok("no map outlines: the rate map left out, saying the states are a bar chart instead", /outlines of the states didn't load/.test(why(pl, "rateMap")) && pl.find(r => r.id === "states").included);
  pl = await plan(oldFacts());
  ok("facts from before these slides: the new slides left out plainly, nothing breaks", ["exposure", "adequacy", "programs", "market"].every(id => !pl.find(r => r.id === id).included) && pl.find(r => r.id === "rateMap").included);
  ok("reasons are plain sentences, no ids, no em dashes", (await Promise.all([noSummaries(), olderOnly(), notLooked()].map(v => plan(v)))).flat().every(r => !/_/.test(r.reason) && !r.reason.includes("—") && (r.reason === "" || /^[A-Z].*\.$/.test(r.reason))));
  ok("the page can show the same cost: filingsCost", await p.evaluate(() => SNLProfile.filingsCost(5)) === "5 S&P requests and about $11.50 to $17.50 of Claude reading");

  // ----- the maps -----
  const s = await spec(RICH);
  ok("spec: thirteen slides in deck order", same(s.slides.map(x => x.id || x.kind), ["cover", ...ALL.slice(1)]));
  const map = one(s, "states", "group", "Map of filings by state"), shapes = map.items.filter(i => i.type === "freeform");
  ok("map: one freeform for each state and DC, from the page's own outlines, in the US_MAP drawing", shapes.length === 51 && shapes.every(x => same(x.view, [0, 0, 975, 610])) && shapes.find(x => x.name.startsWith("Florida")).path === await p.evaluate(() => window.MAP_FOR_TEST.FL[0]));
  // FL 3, TX 2, GA 1: most 3, so steps of 1: 1, 2, 3 shaded light, middle and navy
  const st = n => shapes.find(x => x.name.startsWith(n));
  ok("shaded by filings: FL 3 navy, TX 2 the middle shade, GA 1 the lightest; named with the figure", st("Florida").fill === NAVY && st("Texas").fill === "847CC0" && st("Georgia").fill === "DCDAF0" && st("Florida").name === "Florida: 3", [st("Florida"), st("Texas"), st("Georgia")].map(x => [x.name, x.fill]));
  ok("a state searched where S&P returned nothing is hatched, never shaded as zero", st("Alabama").pattern && st("Alabama").pattern.prst === "ltUpDiag" && !st("Alabama").fill && st("Alabama").name === "Alabama: S&P returned nothing");
  ok("a state that wasn't searched is grey and named so", st("New York").fill === "BFBFBF" && st("New York").name === "New York: not searched");
  const lab = c => map.items.find(i => i.name === "Label " + c);
  ok("labels: the code and the figure, white on the dark shade, the code alone where nothing came back", same(lab("FL").paras.map(q => q.runs[0].text), ["FL", "3"]) && lab("FL").paras[0].runs[0].color === "FFFFFF" && same(lab("AL").paras.map(q => q.runs[0].text), ["AL"]) && lab("TX").paras[1].runs[0].color === NAVY);
  const key = one(s, "states", "group", "Key: filings");
  ok("the key: each shade's range, then S&P returned nothing (hatched) and not searched", same(key.items.filter(i => i.type === "text").map(i => i.paras[0].runs[0].text), ["1 filing", "2 filings", "3 filings", "S&P returned nothing", "Not searched"]) && key.items.find(i => i.name === "Key S&P returned nothing").pattern);
  ok("the map slide's table: state, filings, rate filings, the latest rate (unapproved starred)", same(cells(one(s, "states", "table")), [["State", "Filings", "Rate filings", "Latest rate (%)"], ["FL", "3", "2", "9.8*"], ["TX", "2", "2", "(3.5)"], ["GA", "1", "0", "n/d"]]));
  ok("the map slide's source line says what hatching means", /Hatched: (S&P returned nothing|nothing returned)/.test(src(s, "states")), src(s, "states"));
  const rmap = one(s, "rateMap", "group", "Map of latest rate change by state"), rs = n => rmap.items.find(x => x.type === "freeform" && x.name.startsWith(n));
  // FL latest 9.8 (pending): over 5 to 10; TX latest (3.5): down under 5; GA no rate impact
  ok("rate map: FL 9.8% pending in the over 5 to 10 shade, TX (3.5) light teal, GA pale grey for no rate impact", rs("Florida").fill === "F062B5" && rs("Florida").name === "Florida: 9.8*" && rs("Texas").fill === "8FD0CA" && rs("Georgia").fill === "EEEEF5" && rs("Georgia").name === "Georgia: no rate impact" && rs("Alabama").pattern);
  ok("rate map table: highest first, with date and status, decreases in teal", same(cells(one(s, "rateMap", "table")), [["State", "Latest (%)", "Published", "Status"], ["FL", "9.8*", "5 Nov", "Pending"], ["TX", "(3.5)", "1 Mar 2025", "Approved"]]) && one(s, "rateMap", "table").rows[2][1].color === TEAL);
  ok("rate map title from the text", slide(s, "rateMap").title === RICH.text.rateMap.title);
  const sm = await spec(smallStates()), smap = one(sm, "states", "group", "Map of filings by state");
  const call = smap.items.find(i => i.name === "Label MA"), lead = smap.items.find(i => i.name === "Leader MA");
  ok("a small north-eastern state with filings is labelled beside the map, with a leader line from it", call && same(call.paras[0].runs.map(r => r.text), ["MA ", "2"]) && lead && lead.type === "line" && call.x > lead.x1, call);
  ok("…and so is one with filings but no rate impact; one with nothing gets no callout", !!smap.items.find(i => i.name === "Label RI") && !smap.items.find(i => i.name === "Label NH"));
  const bars = await spec(RICH, false);
  ok("without the outlines, filings by state is the bar chart and no rate map is drawn", one(bars, "states", "chart").kind === "bar" && !slide(bars, "rateMap"));

  // ----- exposure -----
  ok("exposure: the one line on what these figures are", one(s, "exposure", "text", "What these figures are").paras[0].runs[0].text === "What each rate filing states for the book it covers, from its own pages: not statutory premium, and not the company's whole book.");
  ok("exposure table: each filing's own figures with its filing and page, newest first", same(cells(one(s, "exposure", "table")), [
    ["Published", "State", "Type of insurance", "Premium ($M)", "Policyholders", "Exposures", "Overall rate (%)", "Filing", "Page"],
    ["10 Oct", "FL", "Homeowners", "48.2", "61,400", "63,000", "4.5", "S&P no. CAL0000101", "3, 4"], ["1 Mar 2025", "TX", "Homeowners", "31.7", "44,900", "n/d", "(3.5)", "S&P no. CAL0000103", "5"]]), cells(one(s, "exposure", "table")));
  const ec = items(s, "exposure", "chart");
  ok("exposure charts: by state and type (the latest, largest first) and over time (date order), $M, only figures in the table", same(ec[0].categories, ["FL Homeowners", "TX Homeowners"]) && same(ec[0].series[0].values, [48.2, 31.7]) && same(ec[1].categories, ["TX Mar 2025", "FL Oct 2026"]) && same(ec[1].series[0].values, [31.7, 48.2]), ec.map(c => [c.categories, c.series[0].values]));
  ok("exposure: the title says the summed figure; the source says it's derived and not statutory", slide(s, "exposure").title === "Latest rate filings state $79.9M of premium affected" && /totals.*\(derived\)/.test(src(s, "exposure")) && /states them|own figures/.test(src(s, "exposure")), src(s, "exposure"));

  // ----- adequacy -----
  const ac = one(s, "adequacy", "chart");
  ok("adequacy chart: indicated, filed and approved by filing in date order, never averaged", same(ac.categories, ["TX Mar 2025", "FL Oct 2026"]) && same(ac.series.map(x => [x.name, x.values]), [["Indicated", [null, 9.1]], ["Filed", [-3.5, 4.5]], ["Approved", [null, 4.5]]]), ac.series);
  const at = one(s, "adequacy", "table");
  ok("adequacy table: columns no filing fills are left out; indicated above filed in magenta; every page", same(cells(at), [
    ["State", "Published", "Indicated", "Filed", "Approved", "LCM", "Trend", "Target LR", "Expenses", "Filing number", "Pages"],
    ["FL", "10 Oct", "9.1", "4.5", "4.5", "1.250", "6.5", "62.5", "27.4", "S&P no. CAL0000101", "3, 9, 14, 15, 16"],
    ["TX", "1 Mar 2025", "n/d", "(3.5)", "n/d", "n/d", "n/d", "n/d", "n/d", "S&P no. CAL0000103", "5"]]) && at.rows[1][2].color === MAG, cells(at));
  ok("adequacy: the one line defining indicated, filed and approved; the source line says what magenta marks", /^Indicated: the change the filing's own analysis supports\./.test(one(s, "adequacy", "text").paras[0].runs[0].text) && /indicated above filed/.test(src(s, "adequacy")), src(s, "adequacy"));

  // ----- programs and forms -----
  ok("programs table: the program, its segment, where and when, the filing and page", same(cells(one(s, "programs", "table", "Table programs")), [["Program", "Segment", "State", "Published", "Filing", "Page"], ["Calloway Signature Home", "private client", "FL", "15 Jun 2025", "S&P no. CAL0000104", "4"]]));
  ok("form schedule: newest filing first, each with its filing and page", same(cells(one(s, "programs", "table", "Table forms")), [["Form", "Edition", "Title", "Action", "State", "Published", "Filing", "Page"],
    ["CHO 30 01", "06 25", "Homeowners policy", "New", "FL", "15 Jun 2025", "S&P no. CAL0000104", "12"], ["CHO 31 07", "06 25", "Water backup endorsement", "Replaced", "FL", "15 Jun 2025", "S&P no. CAL0000104", "13"], ["CHO 04 90", "01 24", "Scheduled personal property", "Revised", "GA", "10 Feb 2024", "S&P no. CAL0000105", "10"]]));
  ok("programs: the segment is said to be Claude's judgement", /segment is (Claude's judgement|a judgement)/.test(src(s, "programs")));

  // ----- the market -----
  // share 28.5714 shows 28.6; quartiles 3.375, 5.25 and 8.85 show 3.4, 5.3 and 8.8 (8.85 is stored just under 8.85)
  const mc = items(s, "market", "chart");
  ok("market charts: its share, and the index's quartiles and median against its latest", same(mc[0].series[0].values, [28.6]) && same(mc[1].series.map(x => [x.name, x.values]), [["Lower quartile", [3.375]], ["Median", [5.25]], ["Upper quartile", [8.85]], ["Its latest", [9.8]]]), mc.map(c => c.series));
  ok("market table: the same state, type and dates, index and company side by side", same(cells(one(s, "market", "table")), [["State and type", "Published", "Filings", "Companies", "Its filings", "Share (%)", "Its rank", "Index range (%)", "Middle half (%)", "Median (%)", "Its latest (%)"],
    ["FL Homeowners", "Nov 2024 to Nov 2026", "7", "4", "2", "28.6", "2 of 4", "(1.0) to 12.0", "3.4 to 8.8", "5.3", "9.8*"]]), cells(one(s, "market", "table")));
  ok("market: the index's coverage line on the slide, and that it isn't the whole market", one(s, "market", "text", "Index coverage").paras[0].runs[1].text === "FL: filings published 19 Nov 2024 to 18 Nov 2026, 2,712 companies in the app's list covered, 3 not. Companies outside the app's list aren't in it, so it isn't the whole market." && /median \(derived\)/.test(src(s, "market")));

  // ----- the summary -----
  const tiles = items(s, "summary", "tile").map(t => [t.value, t.label]);
  ok("summary tiles: what the summaries and the index add replaces the rule and form counts and the latest date", same(tiles.slice(2, 4), [["$79.9M", "Premium the latest rate filings state, summed (derived; not statutory)"], ["1 of 1", "Rate filings filed below their own indicated change"]]) && same(tiles[5], ["28.6%", "Share of indexed FL homeowners filings (derived)"]), tiles);
  ok("summary takeaways: bold-led, the new points included", same(one(s, "summary", "bullets").items.map(i => i.runs[0].text), ["Filings: ", "States: ", "Largest rate change: ", "Exposure: ", "Rate adequacy: ", "Against the market: "]));

  // ----- fit, sources, hostile text -----
  const bottom = it => it.type === "table" ? it.y + (Array.isArray(it.rowH) ? it.rowH.reduce((a, c) => a + c, 0) : it.rowH * it.rows.length) : it.type === "header" ? it.y + 0.32 : it.type === "line" ? Math.max(it.y1, it.y2) : it.type === "group" ? Math.max(...it.items.map(bottom)) : it.y + (it.h || 0);
  const right = it => it.type === "table" ? it.x + it.colW.reduce((a, c) => a + c, 0) : it.type === "line" ? Math.max(it.x1, it.x2) : it.type === "group" ? Math.max(...it.items.map(right)) : it.x + it.w;
  const left = it => it.type === "group" ? Math.min(...it.items.map(left)) : it.type === "line" ? Math.min(it.x1, it.x2) : it.x;
  const top = it => it.type === "group" ? Math.min(...it.items.map(top)) : it.type === "line" ? Math.min(it.y1, it.y2) : it.y;
  for (const [name, v] of [["hand-worked", RICH], ["sample", SAMPLE], ["small states", smallStates()], ["hostile", hostile()], ["no summaries", noSummaries()]]) {
    const sp = await spec(v), out = [], wide = [];
    sp.slides.slice(1).forEach(x => x.items.filter(i => i.type !== "source").forEach(i => { if (bottom(i) > 6.6 + 1e-9 || right(i) > 12.8 + 1e-9 || left(i) < 0.52 - 1e-9 || top(i) < 1.3 - 1e-9) out.push([x.id, i.type, i.name || i.text, bottom(i), right(i)]); }));
    sp.slides.slice(1).forEach(x => { const t = src(sp, x.id); if (width10(t) > 11.7) wide.push([x.id, t]); });
    ok("fit (" + name + "): every block, the maps' groups included, inside x 0.52 to 12.80 and y 1.3 to 6.6", out.length === 0, out);
    ok("fit (" + name + "): every source line on one line, titles at most 65 characters, no em dashes", wide.length === 0 && sp.slides.slice(1).every(x => x.title.length <= 65) && !JSON.stringify(sp).includes("—"), wide);
  }
  const hs = await spec(hostile());
  z = await JSZip.loadAsync(await build(hs));
  const all = (await Promise.all(Object.keys(z.files).filter(n => /\.(xml|rels)$/.test(n)).map(n => z.file(n).async("string")))).join("");
  ok("hostile text from a summary or the index is escaped in the built deck and never runs", !all.includes("<script>") && all.includes("&lt;script&gt;window.__xss=1&lt;/script&gt;") && !all.includes("\u0001") && await p.evaluate(() => window.__xss === undefined));

  // ----- the made-up sample, built with the maps, opened in python-pptx -----
  const ss = await spec(SAMPLE), bytes = await build(ss), file = path.join(OUT, "deckrich-sample.pptx");
  fs.writeFileSync(file, bytes);
  z = await JSZip.loadAsync(bytes);
  const sl = await slidesOf(z);
  ok("sample build: thirteen slides, each well-formed, the maps as groups of 51 freeforms", sl.length === 13 && (await p.evaluate(xs => xs.every(x => !new DOMParser().parseFromString(x, "application/xml").getElementsByTagName("parsererror").length), sl)) && (sl[2].match(/<a:custGeom>/g) || []).length >= 51 && (sl[3].match(/<a:custGeom>/g) || []).length >= 51);
  ok("sample build: every content slide made-up and sourced", sl.slice(1).every(x => /made-up/i.test(x) && x.includes("SNL Insurance Product Filings")));
  // The same structure, read from the slides' own XML, so it is checked on every machine.
  const maps = await p.evaluate(xs => xs.map(x => {
    const d = new DOMParser().parseFromString(x, "application/xml"), P = "http://schemas.openxmlformats.org/presentationml/2006/main", A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    return [...d.getElementsByTagNameNS(P, "grpSp")].map(g => {
      const nv = g.getElementsByTagNameNS(P, "nvGrpSpPr")[0], nm = nv && nv.getElementsByTagNameNS(P, "cNvPr")[0];
      const kids = [...g.children].filter(c => c.namespaceURI === P && (c.localName === "sp" || c.localName === "cxnSp" || c.localName === "grpSp" || c.localName === "pic"));
      return [nm ? nm.getAttribute("name") : "", kids.filter(c => c.localName === "sp" && c.getElementsByTagNameNS(A, "custGeom").length).length, kids.length];
    });
  }), sl);
  const mapOn = (i, name) => maps[i].filter(m => m[0] === name && m[1] === 51 && m[2] >= 51).length === 1;
  ok("each map is one named group holding 51 freeform shapes and their labels", mapOn(2, "Map of filings by state") && mapOn(3, "Map of latest rate change by state"), [maps[2], maps[3]]);
  // And opened by another program, python-pptx, where it is installed. GitHub's test run installs it, so there it
  // always runs; on a computer without it this one check is left out and says so.
  let hasPptx = true;
  try { execFileSync("python3", ["-I", "-c", "import pptx"], { stdio: "ignore" }); } catch { hasPptx = false; }
  if (!hasPptx && !process.env.CI) console.log("note: python-pptx isn't installed here, so the check that it opens the deck was left out (pip install python-pptx to run it)");
  else {
    let py = "";
    try {
      py = execFileSync("python3", ["-I", "-c", "import sys\nfrom pptx import Presentation\nfrom pptx.enum.shapes import MSO_SHAPE_TYPE as T\np=Presentation(sys.argv[1])\nfor i,s in enumerate(p.slides,1):\n  for g in s.shapes:\n    if g.shape_type==T.GROUP: print(i,g.name,sum(1 for x in g.shapes if x.shape_type==T.FREEFORM),len(g.shapes))\nprint('slides',len(p.slides))", file], { encoding: "utf8" });
    } catch (e) { py = "ERROR " + e.message; }
    ok("python-pptx opens the deck and reads each map as a group of 51 freeform shapes with their labels", /slides 13/.test(py) && /^3 Map of filings by state 51 \d+$/m.test(py) && /^4 Map of latest rate change by state 51 \d+$/m.test(py), py);
  }

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL crashed " + (e && e.stack)); console.log(pass + " passed, " + (fail + 1) + " failed"); process.exit(1); });
