// "Narrow it down" on the filings profile deck (web/profile-slides.js), from the made-up sample narrowed to Florida and
// Texas, homeowners (tests/fixtures/viewfilters_profile_facts.json, pinned by tests/functions/viewfilters_profile_test.ts):
// the cover, every title that fits, every source line and the map headers name the scope; states that weren't
// searched are drawn as not searched (never as zero or as "S&P returned nothing"); the plan's reasons and the empty
// result name the scope; a profile that wasn't narrowed says nothing new; a real build on the stand-in template.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const NARROW = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/viewfilters_profile_facts.json"), "utf8"));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/deckfilings_sample_answer.json"), "utf8"));
const MAPSRC = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8").match(/const US_MAP = \{[\s\S]*?\n\};/)[0];
const copy = o => JSON.parse(JSON.stringify(o));
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 900)); } };
const texts = it => { const out = []; const walk = x => { if (!x || typeof x !== "object") return; if (typeof x.text === "string") out.push(x.text); if (Array.isArray(x.items)) x.items.forEach(walk); if (Array.isArray(x.paras)) x.paras.forEach(pa => (pa.runs || []).forEach(r => out.push(r.text))); }; it.forEach(walk); return out; };
const names = it => { const out = []; const walk = x => { if (!x || typeof x !== "object") return; if (x.name) out.push(x.name); if (Array.isArray(x.items)) x.items.forEach(walk); }; it.forEach(walk); return out; };
const scoped = s => /\b(FL|TX)\b|Florida|Texas/.test(s) && /homeowners/i.test(s);

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

  // ----- the narrowed sample -----
  const s = await spec(NARROW), content = s.slides.filter(x => x.kind === "content");
  ok("every slide is built", s.slides.length === 13, s.slides.map(x => x.id));
  ok("the cover names the scope: in the line above the title and the subtitle", /\| FL and TX, homeowners$/.test(s.slides[0].kicker) && /^FL and TX, homeowners: /.test(s.slides[0].subtitle), [s.slides[0].kicker, s.slides[0].subtitle]);
  const srcs = content.map(x => (x.items.find(i => i.type === "source") || {}).text || "");
  ok("every source line names the scope", srcs.length === 12 && srcs.every(scoped), srcs.filter(x => !scoped(x)));
  ok("…in words where it fits", srcs.some(x => x.includes("20 Nov 2021 to 18 Nov 2026, Florida and Texas, homeowners only.")), srcs[0]);
  const titles = content.map(x => x.title);
  const bare = content.filter(x => !scoped(x.title)).map(x => x.id);
  ok("every title names the scope, but the two too long to take it, and none is cut short", JSON.stringify(bare) === '["exposure","programs"]' && titles.every(t => !t.endsWith("\u2026")), titles);
  ok("the slides whose titles can't take it say it in their source line", bare.every(id => scoped((content.find(c => c.id === id).items.find(i => i.type === "source") || {}).text || "")));
  for (const id of ["states", "rateMap"]) {
    const x = content.find(c => c.id === id), all = texts(x.items).join(" | "), n = names(x.items);
    ok(`${id} map: the header names the scope`, x.items.some(i => i.type === "header" && /\(FL and TX, homeowners\)$/.test(i.text)), x.items.filter(i => i.type === "header").map(i => i.text));
    ok(`${id} map: a state not searched is drawn as not searched, never as zero or as nothing returned`, n.some(v => /^Georgia.*: not searched$/.test(v)) && !n.some(v => /^Georgia.*S&P returned nothing/.test(v)) && n.some(v => /^Florida/.test(v) && !/not searched/.test(v)), n.filter(v => /Georgia|Florida/.test(v)));
    ok(`${id} map: the key says what grey means`, all.includes("Not searched (outside the scope)"), all.slice(0, 400));
  }
  const q = content.find(c => c.id === "questions");
  ok("the diligence questions name the scope", scoped(q.title) && texts(q.items).some(t => /Florida and Texas, homeowners/.test(t)), [q.title, texts(q.items)]);
  const pl = await plan(NARROW);
  ok("the plan: every slide can be filled", pl.length === 13 && pl.every(r => r.included), pl.filter(r => !r.included));

  // ----- nothing returned for the narrowed search -----
  const none = copy(NARROW), f = none.facts;
  Object.assign(f.totals, { filings: 0, rate: 0, rule: 0, form: 0, other: 0, states: 0, latest: null, undated: 0 }); f.largest = null; f.approval = { rateFilings: 0, approved: 0, share: null };
  f.rates = { filings: 0, withImpact: 0, notApproved: 0, noDate: 0, lo: null, hi: null, points: [], pointsTotal: 0, rows: [], rowsTotal: 0 }; f.states = { rows: [], noState: 0 };
  f.latest = { rows: [], total: 0 }; f.regulator = { rows: [], all: null, left: 0 };
  const np = await plan(none);
  ok("nothing returned: the plan's reasons name the scope and what it doesn't say", np.filter(r => !r.included).every(r => /^S&P returned nothing for this search of Florida and Texas, homeowners, so there are no filings to show\. That says nothing about other states or types of insurance/.test(r.reason)), np.filter(r => !r.included).map(r => r.reason)[0]);
  const ns = await spec(none), box = texts(ns.slides.find(x => x.id === "summary").items).join(" | ");
  ok("nothing returned: the summary's box names the scope", box.includes("S&P returned nothing for this search (FL and TX, homeowners)") && box.includes("were searched in Florida and Texas, homeowners only. That says nothing about other states or types of insurance"), box.slice(0, 500));

  // ----- a profile that wasn't narrowed says nothing new -----
  const plainSpec = await spec(SAMPLE);
  const ps = plainSpec.slides.filter(x => x.kind === "content").map(x => (x.items.find(i => i.type === "source") || {}).text || "");
  ok("not narrowed: no scope on the cover or in any source line", !/\|.*\|/.test(plainSpec.slides[0].kicker) && ps.every(x => !/ only\.|homeowners\./.test(x)), ps[0]);
  ok("not narrowed: the map key says 'Not searched' as before", JSON.stringify(plainSpec).includes('"Not searched"') || !JSON.stringify(plainSpec).includes("Not searched ("));

  // ----- a real build on the stand-in template -----
  const out = await p.evaluate(async ([t, sp]) => { const o = await SNLDeck.build(Uint8Array.from(atob(t), ch => ch.charCodeAt(0)), sp);
    let x = ""; for (let i = 0; i < o.length; i += 0x8000) x += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000)); return btoa(x); }, [TEMPLATE.toString("base64"), s]);
  const buf = Buffer.from(out, "base64"), zip = await JSZip.loadAsync(buf);
  const slides = await Promise.all(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map(n => zip.file(n).async("string")));
  ok("the built deck opens with every slide, and its text carries the scope", slides.length === 13 && slides.filter(x => x.includes("Florida and Texas, homeowners only") || x.includes("FL and TX, homeowners")).length === 13);
  fs.mkdirSync(path.join(__dirname, "../out"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "../out/viewfilters-deck.pptx"), buf);

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
