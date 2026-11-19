// "Narrow it down" by filing type and status on the filings profile deck (web/profile-slides.js), from the made-up
// sample narrowed to rate filings (tests/fixtures/morefilters_profile_facts.json, pinned by
// tests/functions/morefilters_profile_test.ts): the cover and every source line name the scope; the slides whose figures
// need form or rule filings are left out with a reason naming the narrowing, never "S&P returned nothing"; the summary's
// tiles say left out, never 0; a profile narrowed to form filings leaves out the rate slides the same way, and one
// narrowed to some statuses the share approved; the empty result names every kind of narrowing; a real build.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const RATE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/morefilters_profile_facts.json"), "utf8"));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/deckfilings_sample_answer.json"), "utf8"));
const MAPSRC = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8").match(/const US_MAP = \{[\s\S]*?\n\};/)[0];
const copy = o => JSON.parse(JSON.stringify(o)), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 900)); } };
const texts = it => { const out = []; const walk = x => { if (!x || typeof x !== "object") return; if (typeof x.text === "string") out.push(x.text); if (Array.isArray(x.items)) x.items.forEach(walk); if (Array.isArray(x.paras)) x.paras.forEach(pa => (pa.runs || []).forEach(r => out.push(r.text))); }; it.forEach(walk); return out; };
const names = it => { const out = []; const walk = x => { if (!x || typeof x !== "object") return; if (x.name) out.push(x.name); if (Array.isArray(x.items)) x.items.forEach(walk); }; it.forEach(walk); return out; };
const scoped = s => /rate filings/i.test(s);

(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage(); p.on("pageerror", e => errs.push(String(e)));
  await p.setContent("<html><body></body></html>");
  await p.addScriptTag({ path: path.join(ROOT, "node_modules/jszip/dist/jszip.min.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/deck.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/profile-slides.js") });
  await p.addScriptTag({ content: MAPSRC.replace("const US_MAP", "window.MAP_FOR_TEST") });
  const plan = v => p.evaluate(f => SNLProfile.filingsPlan(f, { usMap: window.MAP_FOR_TEST }), v.facts);
  const spec = v => p.evaluate(([f, t]) => SNLProfile.filingsSpec(f, t, { usMap: window.MAP_FOR_TEST }), [v.facts, v.text]);

  // ----- narrowed to rate filings -----
  const s = await spec(RATE), content = s.slides.filter(x => x.kind === "content"), pl = await plan(RATE);
  ok("the cover names the scope", /\| rate filings$/.test(s.slides[0].kicker) && /^Rate filings: /.test(s.slides[0].subtitle), [s.slides[0].kicker, s.slides[0].subtitle]);
  const srcs = content.map(x => (x.items.find(i => i.type === "source") || {}).text || "");
  ok("every source line names the scope", srcs.length && srcs.every(scoped), srcs.filter(x => !scoped(x)));
  const out = pl.filter(r => !r.included);
  ok("the plan leaves out the form and rule slide and programs, naming the narrowing", same(out.map(r => r.id).sort(), ["forms", "programs"]) && out.every(r => r.reason === "The profile was narrowed to rate filings, so form and rule filings weren't searched."), out);
  ok("…and builds the rate slides", ["rates", "rateMap", "exposure", "adequacy"].every(id => pl.find(r => r.id === id).included));
  const sum = content.find(x => x.id === "summary"), tiles = sum.items.filter(i => i.type === "tile").map(i => `${i.value}|${i.label}`);
  // (the rule and form tiles give way to what saved summaries add when there is some, as on any profile)
  const kindTiles = tiles.filter(x => /\|(Rule|Form) filings/.test(x));
  ok("the summary's tiles for form and rule filings, where shown, say left out, never 0", kindTiles.every(x => /^Left out\|(Rule|Form) filings: not searched, as the profile was narrowed$/.test(x)) && !tiles.some(x => /^0\|/.test(x)), tiles);
  ok("no slide says S&P returned no form or rule filings", !JSON.stringify(s).match(/returned no (form|rule)/));

  // ----- narrowed to form filings: the rate slides are left out -----
  const form = copy(RATE), f = form.facts;
  f.scope = { ...f.scope, filingTypes: [{ id: 11, name: "Form" }], words: "form filings", short: "form filings", leftOut: { rate: true, rule: true, form: false, approved: false, unapproved: false, statuses: false } };
  Object.assign(f.totals, { rate: 0, rule: 0, form: f.totals.filings }); f.largest = null; f.approval = { rateFilings: 0, approved: 0, share: null };
  f.rates = { filings: 0, withImpact: 0, notApproved: 0, noDate: 0, lo: null, hi: null, points: [], pointsTotal: 0, rows: [], rowsTotal: 0 };
  f.states.rows.forEach(r => { r.rate = 0; r.latest = null; }); f.exposure = { rows: [], total: 0, latest: [], latestPremium: null, latestPolicyholders: null, summarised: 0 }; f.adequacy = { rows: [], total: 0, summarised: 0 };
  f.summaries.rate = { filings: 0, withDocument: 0, summarised: 0, older: 0 }; f.latest = { rows: [{ company: "Calloway Home Co", state: "FL", toi: "Homeowners", type: "Form", status: "Approved", published: "2026-10-01", filingNo: "S&P no. CAL1000001" }], total: 1 };
  const fp = await plan(form), fo = fp.filter(r => !r.included);
  ok("form only: rate changes, the rate map, exposure and adequacy are left out, naming the narrowing", ["rates", "rateMap", "exposure", "adequacy"].every(id => fo.some(r => r.id === id && r.reason === "The profile was narrowed to form filings, so rate filings weren't searched.")), fo);
  const fs2 = await spec(form), ft = fs2.slides.find(x => x.id === "summary").items.filter(i => i.type === "tile").map(i => `${i.value}|${i.label}`);
  ok("…the rate tile and the largest rate change say left out, never 0 or n/d", ft.includes("Left out|Rate filings: not searched, as the profile was narrowed") && ft.includes("Left out|Largest overall rate change: rate filings weren't searched"), ft);
  const st = copy(RATE); st.facts.scope = { ...st.facts.scope, statuses: [{ id: 2, name: "Pending" }], words: "rate filings; pending", short: "rate filings; pending", leftOut: { ...st.facts.scope.leftOut, approved: true, statuses: true } };
  const stt = (await spec(st)).slides.find(x => x.id === "summary").items.filter(i => i.type === "tile").map(i => `${i.value}|${i.label}`);
  ok("narrowed to a status: the share approved is left out, not 0%", stt.includes("Left out|Rate filings approved: not every status was searched"), stt);

  // ----- nothing returned for a search with all four -----
  const none = copy(RATE), n = none.facts;
  n.scope = { narrowed: true, states: ["FL"], types: [{ id: 101, name: "Homeowners" }], filingTypes: [{ id: 12, name: "Rate" }], statuses: [{ id: 2, name: "Pending" }], words: "Florida; homeowners; rate filings; pending", short: "FL; homeowners; rate filings; pending", leftOut: { rate: false, rule: true, form: true, approved: true, unapproved: false, statuses: true } };
  Object.assign(n.totals, { filings: 0, rate: 0, rule: 0, form: 0, other: 0, states: 0, latest: null, undated: 0 });
  const np = await plan(none);
  ok("nothing returned: every reason names the full scope and says nothing about other states, types, filing types or statuses", np.filter(r => !r.included).every(r => r.reason === "S&P returned nothing for this search of Florida; homeowners; rate filings; pending, so there are no filings to show. That says nothing about other states, types of insurance, filing types or statuses, and doesn't prove nothing was filed."), np.filter(r => !r.included)[0]);
  const box = texts((await spec(none)).slides.find(x => x.id === "summary").items).join(" | ");
  ok("nothing returned: the summary's box says the same", box.includes("S&P returned nothing for this search (FL; homeowners; rate filings; pending)") && box.includes("That says nothing about other states, types of insurance, filing types or statuses"), box.slice(0, 400));

  // ----- a real build on the stand-in template -----
  const built = await p.evaluate(async ([t, sp]) => { const o = await SNLDeck.build(Uint8Array.from(atob(t), ch => ch.charCodeAt(0)), sp);
    let x = ""; for (let i = 0; i < o.length; i += 0x8000) x += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000)); return btoa(x); }, [TEMPLATE.toString("base64"), s]);
  const buf = Buffer.from(built, "base64"), zip = await JSZip.loadAsync(buf);
  const slides = await Promise.all(Object.keys(zip.files).filter(x => /^ppt\/slides\/slide\d+\.xml$/.test(x)).map(x => zip.file(x).async("string")));
  ok("the built deck opens with the slides planned, each naming rate filings", slides.length === pl.filter(r => r.included).length && slides.every(x => /rate filings/i.test(x)), slides.length);
  fs.mkdirSync(path.join(__dirname, "../out"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "../out/morefilters-deck.pptx"), buf);

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
