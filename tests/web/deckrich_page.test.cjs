// Summarising before building, on the Profile view's filings profile: how many of the company's rate and form filings
// have a saved summary, the choice "Summarise the latest N rate filings and the latest M form filings" with its cost in
// S&P requests, dollars and questions stated first (worked out by hand), the summaries made one at a time with progress
// and Stop, the figures worked out again afterwards (the slides that needed them come in), the daily limit, the
// summaries function not set up, the sample (nothing made), hostile text, the deck built with the maps, and the 1440px
// and 390px layouts. The page runs with the real zip library, deck.js and profile-slides.js; the functions are
// stand-ins. Nothing touches the network. Every company, filing and figure is made up.
const OUTDIR = require("path").join(__dirname, "../out"); require("fs").mkdirSync(OUTDIR, { recursive: true });
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path"); const JSZip = require("jszip");
const WEB = path.join(__dirname, "../../web"), ROOT = path.join(__dirname, "../.."); const MOCK = fs.readFileSync(__dirname + "/mock-supabase.js", "utf8"); const BASE = "http://localhost:8123/";
const FIX = n => JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures", n), "utf8"));
const STATUS = FIX("web_status.json"), REFS = FIX("web_reference.json"), RICH = FIX("deckrich_facts.json"), SAMPLE = FIX("deckfilings_sample_answer.json");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const ZIPLIB = fs.readFileSync(path.join(ROOT, "node_modules/jszip/dist/jszip.min.js"), "utf8");
const FNS = "https://a.supabase.co/functions/v1/";
const CONFIG = 'window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const copy = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 700)); } };

const RESOLVE = q => ({ query: q, note: null, groups: [], matches: [{ companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: "6000001", spStatEntityId: null, naicGroupCode: null, naicGroupName: "Calloway Group" }] });
const SEARCH = { companyIds: [], institutionIds: [6000001], states: ["AL", "FL", "GA", "TX"], from: "2023-11-20", to: "2026-11-18" };
// before: no summary yet and no index; after: the hand-worked facts (tests/functions/deckrich_core_test.ts)
function before() {
  const f = copy(RICH.facts);
  f.summaries.rate = { filings: 4, withDocument: 3, summarised: 0, older: 0 }; f.summaries.form = { filings: 2, withDocument: 2, summarised: 0, older: 0 };
  f.exposure = { rows: [], total: 0, latest: [], latestPremium: null, latestPolicyholders: null, summarised: 0 }; f.adequacy = { rows: [], total: 0, summarised: 0 }; f.programs = { programs: [], programsTotal: 0, forms: [], formsTotal: 0, summaries: 0 };
  f.market = { checked: true, reason: "No state is in the market index yet, so the company can't be set against the market. Corp Dev can sweep a state on the Market tab.", rows: [], coverage: [], indexed: [] };
  return f;
}
const cand = (no, kind, older, pages, doc) => ({ kind, older, filingNo: no, state: "FL", toi: "Homeowners", published: "2026-11-05", pages, row: { documentId: doc, filingVersionId: null, sfcNumber: no.replace("S&P no. ", ""), serffFilingType: kind === "rate" ? "Rate" : "Form", pages, filingNo: no } });
// three rate filings without a current summary: 120 pages, 400 pages (an older summary), no page count; one form filing of 40 pages
const CANDS = () => ({ rate: [cand("S&P no. CAL0000102", "rate", false, 120, 102), cand("S&P no. CAL0000103", "rate", true, 400, 103), cand("S&P no. CAL0000107", "rate", false, null, 107)], form: [cand("S&P no. CAL0000105", "form", true, 40, 105)] });
const FACTS_ANS = facts => ({ status: 200, body: { facts, text: copy(RICH.text), spRequests: 0, search: copy(SEARCH), candidates: CANDS() } });
const PSTATUS = () => ({ statutory: { configured: false, mapped: false, fields: [] }, claude: { configured: true }, filings: { configured: true } });
const DIGEST = r => ({ filingVersionId: null, documentId: r.documentId, filingNo: r.filingNo, read: [{ from: 1, to: 150 }], madeAt: "2026-11-18T12:00:00Z", by: "claude", summary: "Made-up.", programs: [], forms: [], eligibility: [], notable: [], rate: {}, v: 2 });

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open(opts = {}, over = {}) {
    opts = { template: { text: "PK" }, ...opts };
    const width = over.width || 1440;
    const ctx = await b.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, timezoneId: "UTC", acceptDownloads: true }); const p = await ctx.newPage(); p.on("pageerror", e => errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-18T12:00:00Z"));
    const t = { p, ctx, calls: [], asked: 2, makeDelay: 0, factsN: 0,
      facts: () => FACTS_ANS(t.factsN++ ? copy(RICH.facts) : before()),
      dstatus: () => ({ status: 200, body: { claude: { configured: true }, filings: { configured: true }, saved: 3 } }),
      make: body => ({ status: 200, body: { digest: DIGEST(body.filing), usage: { costUsd: 1.2, spRequests: 1 }, fromStore: false } }), ...over };
    await p.route("**/*", async r => { const req = r.request(), u = req.url();
      if (u.startsWith(FNS)) { const fn = u.slice(FNS.length), body = JSON.parse(req.postData() || "{}"); t.calls.push({ fn, body });
        const J = (status, o) => r.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(o) }).catch(() => {});
        if (fn === "snl-profile") {
          const a = body.action === "status" ? { status: 200, body: PSTATUS() } : body.action === "filings_facts" ? t.facts(body) : body.action === "filings_sample" ? { status: 200, body: copy(SAMPLE) } : { status: 400, body: { error: "bad", message: "Unknown action." } };
          return J(a.status, a.body); }
        if (fn === "snl-digest") {
          if (body.action === "status") { const a = t.dstatus(); return a.status === 404 ? r.fulfill({ status: 404, body: "" }) : J(a.status, a.body); }
          if (body.action === "make") { if (t.makeDelay) await new Promise(res => setTimeout(res, t.makeDelay)); const a = t.make(body); if (a.status === 200) t.asked++; return J(a.status, a.body); }
        }
        if (fn === "snl-chat" && body.action === "status") return J(200, { configured: true, askedToday: t.asked, dailyLimit: t.limit || 20, costToday: 0.1 * t.asked, resetsAt: "2026-11-19T00:00:00Z" });
        if (fn === "snl-filings" && body.action === "status") return J(200, { ...copy(STATUS), role: "corpdev" });
        if (fn === "snl-filings" && body.action === "reference") return J(200, REFS);
        if (fn === "snl-filings" && body.action === "resolve") return J(200, RESOLVE(body.q));
        return J(400, { error: "bad", message: "Unknown action." }); }
      if (u === JSZIP_URL) return r.fulfill({ contentType: "application/javascript", body: ZIPLIB });
      if (u === BASE + "deck.js" || u === BASE + "profile-slides.js") return r.fulfill({ contentType: "application/javascript", body: fs.readFileSync(path.join(WEB, u.slice(BASE.length)), "utf8") });
      if (/supabase\.js/.test(u)) return r.fulfill({ contentType: "application/javascript", body: MOCK });
      if (/config\.js/.test(u)) return r.fulfill({ contentType: "application/javascript", body: CONFIG });
      if (u.startsWith(BASE)) return r.fulfill({ contentType: "text/html", body: fs.readFileSync(WEB + "/index.html", "utf8") }); return r.fulfill({ status: 404, body: "" }); });
    await p.addInitScript(o => { window.__opts = o; }, opts);
    await p.goto(BASE + "#profile"); await p.waitForTimeout(500);
    await p.evaluate(b64 => { __mock.storage.buckets["snl-template"]["template.pptx"].bytes = Array.from(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); }, TEMPLATE.toString("base64"));
    t.txt = async sel => ((await p.textContent(sel).catch(() => "")) || "").replace(/\s+/g, " ").trim();
    t.list = async sel => p.$$eval(sel, e => e.map(x => x.textContent.replace(/\s+/g, " ").trim()));
    t.noScroll = async () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    t.of = (fn, a) => t.calls.filter(c => c.fn === fn && c.body.action === a);
    t.get = async () => { await p.fill("#fp_find", "Calloway"); await p.press("#fp_find", "Enter"); await p.waitForTimeout(250); await p.click('[data-act="fp-co"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(900); };
    t.download = async click => { const [d] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), click()]); return { name: d.suggestedFilename(), zip: await JSZip.loadAsync(fs.readFileSync(await d.path())) }; };
    return t;
  }

  // ----- before: what is saved, the plan, the choice and its cost -----
  let t = await open({ template: { text: "PK" } }); let p = t.p;
  await t.get();
  ok("the counts: none of the 4 rate filings or 2 form filings has a summary; saved ones are free", (await t.txt("#fpSumHave")) === "Saved summaries: 0 of 4 rate filings and 0 of 2 form filings. Saved summaries cost nothing to use.", await t.txt("#fpSumHave"));
  const plan = await t.list("#fpPlan li");
  ok("the plan: the exposure slide left out, saying what including it would cost", plan.some(x => x === "Premium and policyholders the rate filings stateLeft out: None of the 4 rate filings has a saved summary yet. Summarising the latest 3 would take 3 S&P requests and about $6.90 to $10.50 of Claude reading; choose it below to include this slide."), plan);
  ok("the summaries function's status is checked once, for free", t.of("snl-digest", "status").length === 1 && t.of("snl-digest", "make").length === 0);
  ok("the choice: the latest 3 rate filings (all there are) and the latest 1 form filing, by default", (await p.inputValue("#fp_nRate")) === "3" && (await p.inputValue("#fp_nForm")) === "1" && (await t.txt(".fpsumpick")) === "Summarise the latest0123rate filings and the latest01form filings", await t.txt(".fpsumpick"));
  // 120 + 150 (400 pages, the first 150 read) + 150 (no page count) + 40 = 460 pages; 460 x $2.30 / 150 = $7.05, 460 x $3.50 / 150 = $10.73
  ok("the cost first: 4 summaries, 4 S&P requests, $7.05 to $10.73, 4 of today's questions; the pages it rests on", (await t.txt("#fpSumCost")).startsWith("4 new summaries: 4 S&P requests, roughly $7.05 to $10.73 of Claude reading, and 4 of today's questions. An estimate: up to the first 150 pages of each filing (460 pages in all, counting 1 filing with no page count as 150).") && (await t.txt("#fp_sumMake")) === "Summarise 4 filings", await t.txt("#fpSumCost"));
  await p.selectOption("#fp_nRate", "1"); await p.selectOption("#fp_nForm", "0"); await p.waitForTimeout(100);
  // 120 pages: 120 x 2.30 / 150 = $1.84; 120 x 3.50 / 150 = $2.80
  ok("one rate filing: 1 summary, $1.84 to $2.80, 1 question", (await t.txt("#fpSumCost")).startsWith("1 new summary: 1 S&P request, roughly $1.84 to $2.80 of Claude reading, and 1 of today's questions.") && (await t.txt("#fp_sumMake")) === "Summarise 1 filing", await t.txt("#fpSumCost"));
  await p.selectOption("#fp_nRate", "0"); await p.waitForTimeout(100);
  ok("nothing chosen: the button is off and the profile builds from what is saved", (await t.txt("#fpSumCost")) === "Nothing chosen: the profile is built from the summaries already saved." && await p.isDisabled("#fp_sumMake"));
  await p.screenshot({ path: path.join(OUTDIR, "deckrich-1440.png"), fullPage: true });
  ok("no sideways scroll at 1440px", await t.noScroll());

  // ----- making them: one at a time, then the figures again -----
  await p.selectOption("#fp_nRate", "2"); await p.selectOption("#fp_nForm", "1"); await p.waitForTimeout(100);
  t.makeDelay = 300;
  await p.click("#fp_sumMake"); await p.waitForTimeout(150);
  ok("progress: which of how many, the filing, and Stop", /^Summarising 1 of 3: S&P no\. CAL0000102 \(FL, Homeowners\)… Each takes a minute or two\. Keep this tab open\.Stop$/.test(await t.txt("#fpSumMaking")) && await p.isDisabled("#fp_buildBtn"), await t.txt("#fpSumMaking"));
  await p.waitForTimeout(1600);
  const mk = t.of("snl-digest", "make");
  ok("each filing is summarised once, in order, with its own row; an older summary is made again", mk.length === 3 && same(mk.map(c => [c.body.filing.documentId, c.body.refresh === true]), [[102, false], [103, true], [105, true]]) && mk.every(c => !("filingDescription" in c.body.filing)), mk.map(c => c.body));
  ok("afterwards the figures are worked out again from the saved search", t.of("snl-profile", "filings_facts").length === 2 && same(t.of("snl-profile", "filings_facts")[1].body, t.of("snl-profile", "filings_facts")[0].body));
  ok("what was made and what it cost: $3.60, 3 S&P requests", (await t.txt("#fpSumMade")).startsWith("All 3 summaries made. These cost about $3.60 and used 3 S&P requests.") && (await t.list("#fpSumList li")).length === 3, await t.txt("#fpSumMade"));
  const plan2 = await t.list("#fpPlan li");
  ok("the slides that needed summaries now come in", plan2.filter(x => /Included$/.test(x)).length === 13 && (await t.txt("#fpSumHave")).startsWith("Saved summaries: 2 of 4 rate filings and 2 of 2 form filings; 2 were made before"), [plan2, await t.txt("#fpSumHave")]);
  await p.click("#fp_draft"); await p.waitForTimeout(100);   // plain text: no draft asked for here
  let dl = await t.download(() => p.click("#fp_buildBtn"));
  const names = Object.keys(dl.zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const all = (await Promise.all(names.map(n => dl.zip.file(n).async("string")))).join("");
  ok("the deck: thirteen slides, the two maps as native freeform shapes, the exposure figures with their filing", names.length === 13 && (all.match(/<a:custGeom>/g) || []).length >= 102 && all.includes("S&amp;P no. CAL0000101") && all.includes("<a:t>48.2</a:t>"), names.length);
  await t.ctx.close();

  // ----- Stop -----
  t = await open(); p = t.p; await t.get();
  t.makeDelay = 400;
  await p.click("#fp_sumMake"); await p.waitForTimeout(150); await p.click('[data-act="fp-sum-stop"]'); await p.waitForTimeout(100);
  ok("Stop: says it stops after this one", (await t.txt('[data-act="fp-sum-stop"]')) === "Stopping after this one…");
  await p.waitForTimeout(1200);
  ok("…only the one under way is made; the rest say you pressed Stop", t.of("snl-digest", "make").length === 1 && (await t.list("#fpSumList li")).filter(x => x.endsWith("not started: you pressed Stop.")).length === 3 && (await t.txt("#fpSumMade")).startsWith("1 of 4 summaries made."), await t.list("#fpSumList li"));
  await t.ctx.close();

  // ----- the daily limit -----
  t = await open({}, { make: () => ({ status: 429, body: { error: "limit", message: "You've asked 20 questions today." } }) }); p = t.p; await t.get();
  await p.click("#fp_sumMake"); await p.waitForTimeout(900);
  ok("the limit: the first says why; the rest aren't started; the figures aren't asked again", t.of("snl-digest", "make").length === 1 && (await t.list("#fpSumList li"))[0].includes("today's limit on questions is reached") && (await t.list("#fpSumList li")).slice(1).every(x => x.endsWith("not started: today's limit on questions was reached.")) && t.of("snl-profile", "filings_facts").length === 1, await t.list("#fpSumList li"));
  await t.ctx.close();
  t = await open({}, { asked: 19 }); p = t.p; await t.get();
  ok("one question left today: said before anything is made", (await t.txt("#fpSumDaily")) === "Only 1 question is left today, so at most 1 of these can be made today; the rest will say why.", await t.txt("#fpSumDaily"));
  await t.ctx.close();

  // ----- the summaries function not set up -----
  t = await open({}, { dstatus: () => ({ status: 404 }) }); p = t.p; await t.get();
  ok("no summaries function: said, and nothing can be made", /the summaries function isn't on this site \(deploy snl-digest; see the README\)\./.test(await t.txt("#fpSumOff")) && await p.isDisabled("#fp_sumMake"), await t.txt("#fpSumOff"));
  await t.ctx.close();
  t = await open({}, { dstatus: () => ({ status: 200, body: { claude: { configured: false }, filings: { configured: true }, saved: 0 } }) }); p = t.p; await t.get();
  ok("Claude not set up: said, nothing can be made", (await t.txt("#fpSumOff")) === "New summaries can't be made yet: Claude isn't set up on this site." && await p.isDisabled("#fp_sumMake"));
  await t.ctx.close();

  // ----- the sample, and hostile text -----
  t = await open(); p = t.p;
  await p.click('[data-act="fp-sample"]'); await p.waitForTimeout(600);
  ok("the sample: says its summaries are made up; nothing is offered or asked", (await t.txt("#fpSumSample")) === "The sample's filing summaries are made up, so none are made or saved." && !(await p.$("#fp_sumMake")) && t.of("snl-digest", "status").length === 0);
  await t.ctx.close();
  t = await open({}, { facts: () => { const a = FACTS_ANS(before()); a.body.candidates.rate[0].filingNo = '<img src=x onerror="window.__xss=1">'; a.body.candidates.rate[0].toi = "<b>bold</b>"; return a; } }); p = t.p; await t.get();
  t.makeDelay = 300; await p.click("#fp_sumMake"); await p.waitForTimeout(150);
  ok("hostile text in a filing number is shown as text, never run", (await t.txt("#fpSumMaking")).includes('<img src=x onerror="window.__xss=1">') && await p.evaluate(() => window.__xss === undefined && !document.querySelector("#fpSumMaking img")));
  await p.waitForTimeout(1500); await t.ctx.close();

  // ----- 390px -----
  t = await open({}, { width: 390 }); p = t.p; await t.get();
  await p.screenshot({ path: path.join(OUTDIR, "deckrich-390.png"), fullPage: true });
  ok("no sideways scroll at 390px, the choice and its cost on screen", await t.noScroll() && await p.isVisible("#fp_nRate") && await p.isVisible("#fpSumCost"));
  await t.ctx.close();

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL crashed " + (e && e.stack)); console.log(pass + " passed, " + (fail + 1) + " failed"); process.exit(1); });
