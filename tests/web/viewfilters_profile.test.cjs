// "Narrow it down" on the filings profile form (Profile view): untouched, the request is as before; states and types
// chosen go into filings_facts and filings_draft; the estimate, the result's heading, the plan of slides, the saved
// summaries and what Ask Claude is told name the scope; nothing returned names it; S&P's lists not loaded; 1440px and
// 390px. The page runs with the real deck.js and profile-slides.js; the functions are stand-ins. Nothing touches the network.
const OUTDIR = require("path").join(__dirname, "../out"); require("fs").mkdirSync(OUTDIR, { recursive: true });
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path"); const JSZip = require("jszip");
const WEB = path.join(__dirname, "../../web"), ROOT = path.join(__dirname, "../.."); const MOCK = fs.readFileSync(__dirname + "/mock-supabase.js", "utf8"); const BASE = "http://localhost:8123/";
const FIX = n => JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures", n), "utf8"));
const STATUS = FIX("web_status.json"), REFS = FIX("web_reference.json"), FACTS = FIX("deckfilings_facts.json"), SAMPLE = FIX("deckfilings_sample_answer.json");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const ZIPLIB = fs.readFileSync(path.join(ROOT, "node_modules/jszip/dist/jszip.min.js"), "utf8");
const FNS = "https://a.supabase.co/functions/v1/";
const CONFIG = 'window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const copy = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 700)); } };

const G = "Calloway Group (SNL P&C Group)";
const mem = (name, o) => ({ companyName: name, companyId: null, institutionId: null, ...o });
const RESOLVE = q => ({ query: q, note: null,
  matches: [
    { companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: "6000001", spStatEntityId: null, naicGroupCode: null, naicGroupName: G },
    { companyId: "9100002", companyName: "Calloway Home Co", naicCompanyCode: null, institutionId: "6000002", spStatEntityId: null, naicGroupCode: null, naicGroupName: G },
    { companyId: null, companyName: "Calloway Statutory Only Co", naicCompanyCode: "90009", institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: G },
  ],
  groups: [
    { name: G, code: null, companies: 4, searchable: 3, tooBig: false, requestsPerYear: 2, members: [mem("Calloway Insurance Co", { institutionId: "6000001" }), mem("Calloway Home Co", { companyId: "9100002" }), mem("Calloway Coastal Co", { institutionId: "6000003" })] },
    { name: "Nonesuch Group", code: null, companies: 100, searchable: 100, tooBig: false, requestsPerYear: 11, members: [...Array.from({ length: 55 }, (_, k) => mem(`Nonesuch Member ${k} Co`, { companyId: String(9200000 + k) })), ...Array.from({ length: 45 }, (_, k) => mem(`Nonesuch Other ${k} Co`, { institutionId: String(6200000 + k) }))] },
    { name: "Tarrow Mutual Group", code: null, companies: 120, searchable: 120, tooBig: true, requestsPerYear: 10, members: Array.from({ length: 100 }, (_, k) => mem(`Tarrow Member ${k} Co`, { institutionId: String(7000000 + k) })) },
  ] });
const SEARCH = { companyIds: [9100002], institutionIds: [], states: ["FL", "GA", "TX"], from: "2023-11-20", to: "2026-11-18" };
const FACTS_ANS = () => ({ status: 200, body: { facts: copy(FACTS.facts), text: copy(FACTS.text), spRequests: 6, search: copy(SEARCH) } });
const CLAUDE = () => { const t = copy(FACTS.text); t.by = "claude"; t.summary.title = "Seven filings; the largest change 9.8%, pending"; return t; };
const DRAFT_ANS = () => ({ status: 200, body: { facts: copy(FACTS.facts), text: CLAUDE(), usage: { inputTokens: 9100, outputTokens: 1800, costUsd: 0.08 }, jobId: "job-fp-1", spRequests: 0, search: copy(SEARCH) } });
const PSTATUS = (over = {}) => ({ statutory: { configured: false, mapped: false, fields: [] }, claude: { configured: true }, filings: { configured: true }, ...over });

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function open(opts = {}, over = {}) {
    const width = over.width || 1440;
    const ctx = await b.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, timezoneId: "UTC", acceptDownloads: true }); const p = await ctx.newPage(); p.on("pageerror", e => errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-18T12:00:00Z"));
    const t = { p, ctx, calls: [], delay: {}, asked: 2, pstatus: () => PSTATUS(), facts: FACTS_ANS, draft: DRAFT_ANS, sample: () => ({ status: 200, body: copy(SAMPLE) }), ...over };
    await p.route("**/*", async r => { const req = r.request(), u = req.url();
      if (u.startsWith(FNS)) { const fn = u.slice(FNS.length), body = JSON.parse(req.postData() || "{}"); t.calls.push({ fn, body });
        const J = (status, o) => r.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(o) }).catch(() => {});
        if (fn === "snl-profile") {
          if (t.delay[body.action]) await new Promise(res => setTimeout(res, t.delay[body.action]));
          const a = body.action === "status" ? { status: 200, body: t.pstatus() } : body.action === "filings_facts" ? t.facts(body) : body.action === "filings_draft" ? t.draft(body) : body.action === "filings_sample" ? t.sample(body) : { status: 400, body: { error: "bad", message: "Unknown action." } };
          if (body.action === "filings_draft" && a.status === 200) t.asked++;
          return J(a.status, a.body); }
        if (fn === "snl-chat" && body.action === "status") return J(200, { configured: true, askedToday: t.asked, dailyLimit: 20, costToday: 0.1 * t.asked, resetsAt: "2026-11-19T00:00:00Z" });
        if (fn === "snl-filings" && body.action === "status") return J(200, { ...copy(STATUS), role: opts.role || "corpdev" });
        if (fn === "snl-filings" && body.action === "reference") return J(200, REFS);
        if (fn === "snl-filings" && body.action === "resolve") return J(200, t.resolve ? t.resolve(body.q) : RESOLVE(body.q));
        return J(400, { error: "bad", message: "Unknown action." }); }
      if (u === JSZIP_URL) return r.fulfill({ contentType: "application/javascript", body: ZIPLIB });
      if (u === BASE + "deck.js" || u === BASE + "profile-slides.js") return r.fulfill({ contentType: "application/javascript", body: fs.readFileSync(path.join(WEB, u.slice(BASE.length)), "utf8") });
      if (u === BASE + "template-builtin.pptx") return r.fulfill({ contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", body: fs.readFileSync(path.join(WEB, "template-builtin.pptx")) });
      if (/supabase\.js/.test(u)) return r.fulfill({ contentType: "application/javascript", body: MOCK });
      if (/config\.js/.test(u)) return r.fulfill({ contentType: "application/javascript", body: CONFIG });
      if (u.startsWith(BASE)) return r.fulfill({ contentType: "text/html", body: fs.readFileSync(WEB + "/index.html", "utf8") }); return r.fulfill({ status: 404, body: "" }); });
    await p.addInitScript(o => { window.__opts = o; }, opts);
    await p.goto(BASE + "#profile"); await p.waitForTimeout(500);
    if (opts.template) await p.evaluate(b64 => { __mock.storage.buckets["snl-template"]["template.pptx"].bytes = Array.from(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); }, TEMPLATE.toString("base64"));
    t.txt = async sel => ((await p.textContent(sel).catch(() => "")) || "").replace(/\s+/g, " ").trim();
    t.list = async sel => p.$$eval(sel, e => e.map(x => x.textContent.replace(/\s+/g, " ").trim()));
    t.noScroll = async () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    t.of = a => t.calls.filter(c => c.fn === "snl-profile" && c.body.action === a);
    t.find = async q => { await p.fill("#fp_find", q); await p.press("#fp_find", "Enter"); await p.waitForTimeout(250); };
    t.download = async click => { const [d] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), click()]); return { name: d.suggestedFilename(), zip: await JSZip.loadAsync(fs.readFileSync(await d.path())) }; };
    return t;
  }
  const slidesOf = async zip => Promise.all(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]).map(n => zip.file(n).async("string")));
  const NARROW = FIX("viewfilters_profile_facts.json");
  const NARROW_ANS = () => ({ status: 200, body: { facts: copy(NARROW.facts), text: copy(NARROW.text), spRequests: 6, search: { ...copy(SEARCH), states: ["FL", "TX"], typeOfInsuranceIds: [101] } } });
  const states = async (p, ...ss) => { await p.click("#nw_fp_stb"); for (const s of ss) await p.click(`#nw_fp_states [data-s="${s}"]`); await p.click("#nw_fp_stDone"); await p.waitForTimeout(80); };
  const types = async (p, ...ids) => { await p.click("#nw_fp_toib"); for (const id of ids) await p.click(`#nw_fp_tois input[data-id="${id}"]`); await p.click("#nw_fp_toiDone"); await p.waitForTimeout(80); };

  // ----- the default: as before -----
  let t = await open({ template: true }); let p = t.p;
  ok("the filings profile form has Narrow it down, with every state and every type", (await t.txt("#nw_fp_allst")) === "All states" && (await t.txt("#nw_fp_alltoi")) === "All types of insurance");
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="1"]'); await p.waitForTimeout(100);
  ok("what it covers reads as before", (await t.txt("#fp_dates")).endsWith("in every state in S&P's list, every filing type and status.") && !(await t.txt("#fp_cost")).includes("Narrowing"));
  await p.click("#fp_get"); await p.waitForTimeout(400);
  const b0 = t.of("filings_facts")[0].body;
  ok("untouched, the request is exactly as before: no states, no types", !("states" in b0) && !("typeOfInsuranceIds" in b0) && b0.kind === "company", b0);
  ok("…and nothing on the page says it was narrowed", !(await p.$("#fpScope")));
  await ctx_close(t);

  // ----- narrowed: Florida and Texas, homeowners -----
  t = await open({ template: true }, { facts: NARROW_ANS, draft: () => { const a = NARROW_ANS(); a.body.text.by = "claude"; a.body.jobId = "job-vf"; a.body.usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }; return a; } }); p = t.p;
  await t.find("Calloway"); await p.click('[data-act="fp-group"][data-i="0"]'); await p.waitForTimeout(100);
  await states(p, "FL", "TX"); await types(p, "101");
  ok("the estimate names the scope, says every slide will, and keeps the count", (await t.txt("#fp_dates")).endsWith("in Florida and Texas, homeowners only, every filing type and status. Every slide will say so.")
    && (await t.txt("#fp_cost")).includes("Narrowing the states or types doesn't change the number of S&P requests"), await t.txt("#fp_dates"));
  await p.click("#fp_get"); await p.waitForTimeout(500);
  const b1 = t.of("filings_facts")[0].body;
  ok("the request carries the states and the type of insurance", JSON.stringify(b1.states) === '["FL","TX"]' && JSON.stringify(b1.typeOfInsuranceIds) === "[101]", b1);
  ok("the result names its scope from the facts", (await t.txt("#fpScope")) === "FL and TX, homeowners" && (await t.txt("#fpMeta")).includes("narrowed to Florida and Texas, homeowners"));
  ok("the plan of slides says what it is filled from", (await t.txt("#fpOut .f >> nth=0")).includes("of Florida and Texas, homeowners; each slide says so"), await t.txt("#fpOut .f >> nth=0"));
  ok("the saved-summaries count names the scope", (await t.txt("#fpSumHave")).includes("in FL and TX, homeowners"), await t.txt("#fpSumHave"));
  ok("Ask Claude is told the narrowed search", await p.evaluate(() => JSON.stringify(fpScreen().search.typeOfInsuranceIds) === "[101]" && JSON.stringify(fpScreen().search.states) === '["FL","TX"]'));
  await p.click("#fp_buildBtn"); await p.waitForTimeout(2500);
  const bd = t.of("filings_draft")[0]?.body;
  ok("Claude's draft is asked for the same narrowed profile", !!bd && JSON.stringify(bd.states) === '["FL","TX"]' && JSON.stringify(bd.typeOfInsuranceIds) === "[101]", bd);
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(150);
  ok("390px: no sideways scroll with a narrowed profile", await t.noScroll());
  await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(100);
  await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: OUTDIR + "/viewfilters-profile-1440.png" });
  await ctx_close(t);

  // ----- nothing returned for a narrowed profile -----
  t = await open({}, { facts: () => { const a = NARROW_ANS(); Object.assign(a.body.facts.totals, { filings: 0 }); return a; } }); p = t.p;
  await t.find("Calloway"); await p.click('[data-act="fp-group"][data-i="0"]'); await states(p, "GA"); await p.click("#fp_get"); await p.waitForTimeout(400);
  ok("nothing returned: names the scope from the facts and what it doesn't say", (await t.txt("#fpNothing")).startsWith("S&P returned nothing for this search of Florida and Texas, homeowners.") && (await t.txt("#fpNothing")).includes("it says nothing about other states or types of insurance"), await t.txt("#fpNothing"));
  await ctx_close(t);

  // ----- lists not loaded; 390px -----
  t = await open({}, { width: 390 }); p = t.p;
  await p.evaluate(() => { S.refs = { serffFilingState: S.refs && S.refs.serffFilingState }; render(); });
  ok("without S&P's list of types: the filter is left out, and says so", (await t.txt("#nw_fp_toioff")) === "S&P's lists aren't loaded yet, so this filter is left out of the search.");
  await p.evaluate(() => { S.refs = null; S.refsLoading = false; }); await p.reload(); await p.waitForTimeout(500);
  await t.find("Calloway"); await p.click('[data-act="fp-group"][data-i="0"]'); await states(p, "FL", "TX", "GA"); await types(p, "101", "109");
  await p.click("#nw_fp_stb"); await p.waitForTimeout(100);
  ok("390px: no sideways scroll with the states open", await t.noScroll(), await p.evaluate(() => document.documentElement.scrollWidth));
  await p.screenshot({ path: OUTDIR + "/viewfilters-profile-390.png", fullPage: true });
  await ctx_close(t);

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  async function ctx_close(x) { await x.ctx.close(); }
})().catch(e => { console.error(e); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
