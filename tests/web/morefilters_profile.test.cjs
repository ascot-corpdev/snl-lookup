// "Narrow it down" by filing type and status on the filings profile form (Profile view): untouched, the request is as
// before; filing types and statuses chosen go into filings_facts and filings_draft; what it covers says which status is
// in force; a profile narrowed to rate filings (the function's own facts, tests/fixtures/morefilters_profile_facts.json)
// shows its scope, says form and rule filings were left out (tiles, saved summaries, the plan's reasons), never 0; Ask
// Claude is told them; the deck built in the browser says so on its slides; S&P's lists not loaded; 1440px and 390px.
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
  const RATE = FIX("morefilters_profile_facts.json");
  const RATE_ANS = () => ({ status: 200, body: { facts: copy(RATE.facts), text: copy(RATE.text), spRequests: 6, search: { ...copy(SEARCH), filingTypeIds: [12] } } });
  const pick = async (p, w, ...ids) => { await p.click(`#nw_fp_${w}b`); for (const id of ids) await p.click(`#nw_fp_${w}s input[data-id="${id}"]`); await p.click(`#nw_fp_${w}Done`); await p.waitForTimeout(80); };

  // ----- the default: as before -----
  let t = await open({ template: true }); let p = t.p;
  ok("the form has filing type and status, every status in force", (await t.txt("#nw_fp_allft")) === "All filing types" && (await t.txt("#nw_fp_allfs")) === "All statuses" && (await t.txt("#nw_fp_fsnote")) === "No status chosen: every status in S&P's list is searched.");
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="1"]'); await p.waitForTimeout(100);
  await p.click("#fp_get"); await p.waitForTimeout(400);
  const b0 = t.of("filings_facts")[0].body;
  ok("untouched, the request has no filing type or status", !("filingTypeIds" in b0) && !("filingStatusIds" in b0) && (await t.txt("#fp_dates")).endsWith("every filing type and status."), b0);
  await ctx_close(t);

  // ----- narrowed to rate filings, approved -----
  t = await open({ template: true }, { facts: RATE_ANS, draft: () => { const a = RATE_ANS(); a.body.text.by = "claude"; a.body.jobId = "job-mf"; a.body.usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }; return a; } }); p = t.p;
  await t.find("Calloway"); await p.click('[data-act="fp-group"][data-i="0"]'); await p.waitForTimeout(100);
  await pick(p, "ft", "12"); await pick(p, "fs", "1", "2");
  ok("what it covers names the filing type and statuses, and that every slide will say so", (await t.txt("#fp_dates")).endsWith("rate filings, approved or pending only. Every slide will say so.") && (await t.txt("#nw_fp_fsnote")) === "Only filings with these statuses are searched.", await t.txt("#fp_dates"));
  await p.click("#fp_get"); await p.waitForTimeout(600);
  const b1 = t.of("filings_facts").at(-1).body;
  ok("filings_facts carries them by S&P's id", same(b1.filingTypeIds, [12]) && same(b1.filingStatusIds, [1, 2]) && b1.kind === "group", b1);
  ok("the heading names the scope, from the facts", (await t.txt("#fpScope")) === "rate filings" && (await t.txt("#fpMeta")).includes("narrowed to rate filings"), await t.txt("#fpMeta"));
  ok("the saved summaries say form filings were left out, never '0 of 0'", (await t.txt("#fpSumHave")).includes("form filings left out by the narrowing") && !(await t.txt("#fpSumHave")).includes("0 of 0"), await t.txt("#fpSumHave"));
  ok("…and offer to summarise rate filings only", !(await t.txt("#fpSumWhich")).includes("form filing"), await t.txt("#fpSumWhich"));
  const plan = await p.$$eval("#fpPlan li", e => e.map(x => x.textContent.replace(/\s+/g, " ").trim()));
  ok("the plan: the form and rule slide and programs are left out, naming the narrowing", plan.some(x => /^Latest form and rule filings\s*Left out: The profile was narrowed to rate filings, so form and rule filings weren't searched\.$/.test(x)) && plan.some(x => /^Programs and forms\s*Left out: The profile was narrowed to rate filings, so form and rule filings weren't searched\.$/.test(x)), plan);
  ok("…and no reason says S&P returned nothing for them", !plan.some(x => /returned no (form|rule)/.test(x)));
  ok("Ask Claude is told the filing type searched", await p.evaluate(() => JSON.stringify(fpScreen().search.filingTypeIds) === "[12]"));
  await p.click("#fp_buildBtn"); await p.waitForTimeout(300);
  ok("filings_draft carries the same filing type and statuses", same(t.of("filings_draft").at(-1).body.filingTypeIds, [12]) && same(t.of("filings_draft").at(-1).body.filingStatusIds, [1, 2]));
  await ctx_close(t);

  // ----- S&P's lists not loaded -----
  t = await open({}, {}); p = t.p;
  await p.evaluate(() => { delete S.refs.serffFilingType; delete S.refs.filingStatus; S.pf.fp.nw.ftypes = ["12"]; render(); });
  ok("without S&P's lists: each says the filter is left out", (await t.txt("#nw_fp_ftoff")) === "S&P's lists aren't loaded yet, so this filter is left out of the search." && (await t.txt("#nw_fp_fsoff")) === "S&P's lists aren't loaded yet, so this filter is left out of the search.");
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="1"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(400);
  ok("…and a filing type chosen earlier isn't sent", !("filingTypeIds" in t.of("filings_facts").at(-1).body));
  await ctx_close(t);

  // ----- 1440px and 390px -----
  for (const width of [1440, 390]) {
    t = await open({}, { width }); p = t.p;
    await pick(p, "ft", "11", "12"); await pick(p, "fs", "1");
    ok(`${width}px: no sideways scroll`, await t.noScroll(), await p.evaluate(() => document.documentElement.scrollWidth));
    await (await p.$("#nw_fp")).screenshot({ path: OUTDIR + `/morefilters-profile-${width}.png` });
    await ctx_close(t);
  }

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  async function ctx_close(x) { await x.ctx.close(); }
})().catch(e => { console.error(e); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
