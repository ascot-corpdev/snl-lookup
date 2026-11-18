// The filings profile on the Profile view: shown first while statutory data isn't ready, the switch between the two
// kinds of profile, choosing one company or a whole group from the company list by name (no NAIC code), the period
// and what it costs in S&P requests, the refusal of a profile over the cap with what to choose instead, the figures and
// the slides in or out, Claude's draft (on by default, kept, partly replaced, refused, limit, busy), building the real
// deck on the stand-in template and opening the file, the sample, errors said plainly, nothing returned, a search that
// stopped early, what Ask Claude is told, hostile text, and the 1440px and 390px layouts. The page runs with the real
// zip library, deck.js and profile-slides.js; the functions are stand-ins. Nothing touches the network.
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

  // ----- Corp Dev, statutory data not ready, S&P and Claude set up, a template uploaded -----
  let t = await open({ template: { text: "PK", updated_at: "2026-11-05T09:30:00Z" } }); let p = t.p;
  ok("the filings profile shows first while statutory data isn't ready", (await p.getAttribute('[data-act="pf-mode"][data-m="filings"]', "aria-pressed")) === "true" && !!(await p.$("#fpForm")) && !(await p.$("#pfForm")) && (await t.txt(".action-title")) === "Company profile as a PowerPoint file");
  ok("the switch names both kinds of profile", same(await t.list('[data-act="pf-mode"]'), ["Filings profile", "Full profile (needs statutory data)"]));
  ok("both samples are offered on the template card", (await t.txt('[data-act="pf-sample"]')) === "Build a sample profile" && (await t.txt('[data-act="fp-sample"]')) === "Build a sample filings profile");
  ok("no NAIC code box in the filings profile: companies and groups are chosen by name", !(await p.$("#fpForm input[inputmode=numeric]")) && !!(await p.$("#fp_find")));
  ok("the period: last year, 3 or 5 years, 3 chosen; the dates it covers", same(await t.list('[data-act="fp-years"]'), ["Last year", "Last 3 years", "Last 5 years"]) && (await p.getAttribute('[data-act="fp-years"][data-y="3"]', "aria-pressed")) === "true" && (await t.txt("#fp_dates")) === "Filings published 20 Nov 2023 to 18 Nov, in every state in S&P's list, every filing type and status.", await t.txt("#fp_dates"));
  await p.click("#fp_get"); await p.waitForTimeout(100);
  ok("nothing chosen: says what to do, asks nothing", (await t.txt("#fpFormErr")) === "Choose a company or a group first: find it by name above." && t.of("filings_facts").length === 0);
  await t.find("Calloway");
  ok("find by name: the same look-up as the Filings view", same(t.calls.filter(c => c.body.action === "resolve").map(c => [c.fn, c.body]), [["snl-filings", { action: "resolve", q: "Calloway" }]]));
  ok("whole groups first, with how many companies have S&P ids, then companies", same((await t.list("#fp_matches li .t1")).slice(0, 4), [G, "Nonesuch Group", "Tarrow Mutual Group", "Calloway Insurance Co"]) && (await t.list("#fp_matches li .t2"))[0] === "Group · 3 companies with S&P ids (1 without)", await t.list("#fp_matches li .t2"));
  ok("a company with no S&P id can't be chosen, and says why", (await t.txt("#fp_matches li:last-child")).includes("Can't be used: the company list has no S&P id for it"));
  await p.click('[data-act="fp-co"][data-i="1"]'); await p.waitForTimeout(100);
  ok("choosing a company: named with its S&P id and group", (await t.txt("#fp_chosen")) === `Chosen: Calloway Home Co S&P company id 9100002 · part of ${G} Clear` && !(await p.$("#fp_matches")));
  ok("what it costs: about 3 S&P requests over 3 years, the overhead, the cap of 60, and that a saved search costs none", (await t.txt("#fp_cost")) === "About 3 S&P requests (one for each 10 companies and each year of dates), plus up to 3 for signing in and S&P's lists, and more if S&P has over 500 filings in a year. One filings profile may use at most 60. None if the same search was run before, here or on the Snapshot view, and saved.", await t.txt("#fp_cost"));
  await p.click('[data-act="fp-years"][data-y="5"]'); await p.waitForTimeout(100);
  ok("5 years: about 5", (await t.txt("#fp_cost")).startsWith("About 5 S&P requests") && (await t.txt("#fp_dates")).startsWith("Filings published 20 Nov 2021 to 18 Nov"));
  await t.find("Calloway"); await p.click('[data-act="fp-group"][data-i="0"]'); await p.waitForTimeout(100);
  ok("choosing a whole group: every member with an S&P id, the one without left out", (await t.txt("#fp_chosen")) === `Chosen: ${G} group of 3 companies with S&P ids in the company list; 1 company has no S&P id and is left out Clear`, await t.txt("#fp_chosen"));
  ok("a group of one company id and two institution ids over 5 years: (1 + 1) x 5 = about 10", (await t.txt("#fp_cost")).startsWith("About 10 S&P requests"));
  await t.find("Nonesuch"); await p.click('[data-act="fp-group"][data-i="1"]'); await p.waitForTimeout(100);
  const over = "A filings profile of Nonesuch Group over the last 5 years needs at least 55 S&P requests (one for each 10 companies and each year of dates), more than the 50 one filings profile may plan. Choose the last 3 years instead.";
  ok("over the cap: refused before anything is asked, saying what to choose instead", (await t.txt("#fp_tooBig")) === over && (await p.getAttribute("#fp_tooBig", "role")) === "alert", await t.txt("#fp_tooBig"));
  await p.click("#fp_get"); await p.waitForTimeout(100);
  ok("…and Get the filings says the same, asking nothing", (await t.txt("#fpFormErr")) === over && t.of("filings_facts").length === 0);
  await p.click('[data-act="fp-years"][data-y="3"]'); await p.waitForTimeout(100);
  ok("the same group over 3 years: about 33, allowed", !(await p.$("#fp_tooBig")) && (await t.txt("#fp_cost")).startsWith("About 33 S&P requests"));
  await t.find("Tarrow"); await p.click('[data-act="fp-group"][data-i="2"]'); await p.waitForTimeout(100);
  ok("a group of more than 100 companies: profile one of its companies instead", (await t.txt("#fp_tooBig")) === "Tarrow Mutual Group has more than 100 companies with S&P ids in the company list, and one filings profile covers at most 100. Profile one of its companies instead.");
  await p.screenshot({ path: OUTDIR + "/deckfilings-choose-1440.png", fullPage: true });

  // the figures
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="1"]'); await p.waitForTimeout(100);
  t.delay.filings_facts = 400;
  await p.click("#fp_get"); await p.waitForTimeout(150);
  ok("getting the filings: says so, by name, and that it can take a minute or two", (await t.txt("#fpBusy")) === "Getting the filings of Calloway Home Co… A new search asks S&P about one request a second, so this can take a minute or two." && await p.isDisabled("#fp_get"));
  await p.waitForTimeout(1200); t.delay.filings_facts = 0;
  ok("asks for the company by its S&P id and the period: no figures, no NAIC code", same(t.of("filings_facts").map(c => c.body), [{ action: "filings_facts", kind: "company", years: 3, companyId: "9100002" }]), t.of("filings_facts").map(c => c.body));
  ok("the name, what it covers and the headline counts", (await t.txt("#fpName")) === "Calloway Insurance Co" && (await t.txt("#fpMeta")) === "Company · filings published 20 Nov 2023 to 18 Nov" && same(await p.$$eval("#fpHead .pftile", e => e.map(x => [x.querySelector("span").textContent, x.querySelector("b").textContent])), [["Filings", "7"], ["Rate filings", "4"], ["States with filings", "3"]]), await t.txt("#fpMeta"));
  ok("the slides: the nine these filings fill, and the four that need saved summaries or the market index left out, saying why", same((await t.list("#fpPlan li")).map(x => x.replace(/Left out: .*/, "Left out")), ["CoverIncluded", "Executive summaryIncluded", "Where it files (map)Included", "Latest rate change by state (map)Included", "Rate changesIncluded",
    "Premium and policyholders the rate filings stateLeft out", "Rate adequacy and loss costsLeft out", "Programs and formsLeft out", "Against the marketLeft out", "Filings by year and typeIncluded", "Latest form and rule filingsIncluded", "Time with the regulatorIncluded", "Key diligence questionsIncluded"]), await t.list("#fpPlan li"));
  ok("the source, what rate impacts are, and the S&P requests used", (await t.txt("#fpSource")) === "Source: S&P Global Market Intelligence, SNL Insurance Product Filings. Rate impacts are S&P's overall figure for each filing, not weighted by premium; for a filing that isn't approved it may be the change asked for. 6 S&P requests used.", await t.txt("#fpSource"));
  ok("Claude's draft is on by default, counted as one of today's questions", await p.isChecked("#fp_draft") && (await t.txt("#fpDraftCost")).startsWith("Counts as one of today's questions to Claude. You've asked 2 of 20 questions today") && (await t.txt("#fp_buildBtn")) === "Draft with Claude and build");
  ok("Ask Claude is told the search behind the profile", same(await p.evaluate(() => askScreen()), { view: "filings", search: { companyIds: [9100002], institutionIds: [], states: ["FL", "GA", "TX"], from: "2023-11-20", to: "2026-11-18", typeOfInsuranceIds: [], filingTypeIds: [], filingStatusIds: [] }, total: 7, companies: ["Calloway Insurance Co"] }));
  ok("headings and buttons are in sentence case", (await p.$$eval("#view h2,#view h3,#view button", e => e.map(x => x.textContent.trim()).filter(s => s && /\s[A-Z][a-z]+/.test(s.replace(/\b(S&P|Claude|Corp Dev|PowerPoint|Calloway [A-Z][a-z]+ Co|Nonesuch Group|Tarrow Mutual Group)\b/g, "x"))))).length === 0);
  await p.screenshot({ path: OUTDIR + "/deckfilings-contents-1440.png", fullPage: true });
  t.delay.filings_draft = 400;
  let dl = await t.download(async () => { await p.click("#fp_buildBtn"); await p.waitForTimeout(150);
    ok("drafting: says it can take up to two minutes", (await t.txt("#fpDrafting")) === "Claude is drafting the slide text… This can take up to two minutes. Keep this tab open." && await p.isDisabled("#fp_draft")); });
  t.delay.filings_draft = 0; await p.waitForTimeout(200);
  ok("the draft is asked for with who and the period only", same(t.of("filings_draft").map(c => c.body), [{ action: "filings_draft", kind: "company", years: 3, companyId: "9100002" }]));
  ok("the draft is saved as a past answer and counted as seen", (await p.evaluate(() => localStorage.getItem("snl.seenAnswer"))) === "job-fp-1");
  ok("the file: named after the company, the kind of profile and the day", dl.name === "Calloway-Insurance-Co-filings-profile-2026-11-18.pptx", dl.name);
  let sl = await slidesOf(dl.zip);
  ok("a real PowerPoint file of nine slides with Claude's title and the source on each", sl.length === 9 && sl[0].includes("Calloway Insurance Co: filings profile") && sl[1].includes("Seven filings; the largest change 9.8%, pending") && sl.slice(1).every(x => x.includes("SNL Insurance Product Filings")) && sl.some(x => x.includes("S&amp;P no. ABC1234567")));
  ok("built: says so, and that the file went nowhere; the draft's cost is shown", (await t.txt("#fpBuilt")) === "Your filings profile is ready. Calloway-Insurance-Co-filings-profile-2026-11-18.pptx was saved to your downloads. It was made in this browser and isn't stored or sent anywhere. Built on the standard template.Download again" && (await t.txt("#fpDrafted")) === "Claude has drafted the text for these filings. It cost about $0.08 (9,100 tokens read, 1,800 written).", await t.txt("#fpDrafted"));
  dl = await t.download(() => p.click('[data-act="fp-again"]'));
  ok("Download again: the same file, no new draft", dl.name === "Calloway-Insurance-Co-filings-profile-2026-11-18.pptx" && t.of("filings_draft").length === 1);
  await p.click("#fp_draft"); await p.waitForTimeout(100);
  dl = await t.download(() => p.click("#fp_buildBtn")); sl = await slidesOf(dl.zip);
  ok("draft switched off: the plain text, no new draft", sl[1].includes("7 filings in 3 states over the last 3 years") && t.of("filings_draft").length === 1);
  // the switch
  await p.click('[data-act="pf-mode"][data-m="full"]'); await p.waitForTimeout(100);
  ok("switching to the full profile: it works as before, saying statutory data isn't set up", (await t.txt("#pfOff")).startsWith("Statutory data isn't set up yet") && !(await p.$("#fpForm")) && (await p.evaluate(() => askScreen())) === null);
  await p.click('[data-act="pf-mode"][data-m="filings"]'); await p.waitForTimeout(100);
  ok("…and back: the filings profile is still there", (await t.txt("#fpName")) === "Calloway Insurance Co" && !!(await p.$("#fpBuilt")));
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the filings shown", await t.noScroll());
  await p.screenshot({ path: OUTDIR + "/deckfilings-contents-390.png", fullPage: true });
  await t.find("Calloway");
  ok("phone: no sideways scroll with the matches listed", await t.noScroll());
  await p.click('[data-act="fp-group"][data-i="1"]'); await p.waitForTimeout(100); await p.click('[data-act="fp-years"][data-y="5"]'); await p.waitForTimeout(100);
  ok("phone: no sideways scroll with the refusal shown", await t.noScroll() && !!(await p.$("#fp_tooBig")));
  await p.screenshot({ path: OUTDIR + "/deckfilings-refused-390.png", fullPage: true });
  await t.ctx.close();

  // ----- a group, and Claude's draft partly replaced or refused -----
  const groupFacts = () => { const a = FACTS_ANS(); a.body.facts.entity = { kind: "group", name: G, groupName: G, companies: 3, noId: 1 }; return a; };
  t = await open({ template: { text: "PK" } }, { facts: groupFacts, draft: () => { const d = DRAFT_ANS(); d.body.facts = groupFacts().body.facts; d.body.text.note = "Some of Claude's text was replaced with the plain text because a figure in it couldn't be matched to the filings' figures."; return d; } }); p = t.p;
  await t.find("Calloway"); await p.click('[data-act="fp-group"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(800);
  ok("a group is asked for by its name in the company list", same(t.of("filings_facts")[0].body, { action: "filings_facts", kind: "group", years: 3, group: G }));
  ok("a group's meta counts its companies and those left out", (await t.txt("#fpMeta")) === "Group of 3 companies, 1 more without S&P ids left out · filings published 20 Nov 2023 to 18 Nov");
  dl = await t.download(() => p.click("#fp_buildBtn")); await p.waitForTimeout(200);
  ok("a draft partly replaced: says some slides use plain text, and why", (await t.txt("#fpNote")) === "Some slides use plain text. Some of Claude's text was replaced with the plain text because a figure in it couldn't be matched to the filings' figures." && dl.name === "Calloway-Group-SNL-P-C-Group-filings-profile-2026-11-18.pptx", dl.name);
  await t.ctx.close();
  for (const [name, ans, says, retry] of [
    ["the daily limit", { status: 429, body: { error: "limit", message: "x" } }, "You've reached today's limit of questions to Claude, so it can't draft the text now. Build with plain text instead, or try again tomorrow.", false],
    ["an answer in progress", { status: 409, body: { error: "busy", message: "x", jobId: "j" } }, "You already have an answer in progress in Ask Claude, and Claude takes one at a time for each login. Build with plain text, or try the draft again when that answer has finished.", true],
    ["Claude failing", { status: 502, body: { error: "upstream", message: "Claude couldn't be reached." } }, "Claude couldn't draft the text. Claude couldn't be reached. You can build with plain text instead.", true]]) {
    t = await open({ template: { text: "PK" } }, { draft: () => ans }); p = t.p;
    await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(800);
    await p.click("#fp_buildBtn"); await p.waitForTimeout(400);
    ok(`draft refused (${name}): said plainly, with Build with plain text${retry ? " and Try the draft again" : ""}`, (await t.txt("#fpDraftErr")) === says + "Build with plain text" + (retry ? "Try the draft again" : ""), await t.txt("#fpDraftErr"));
    ok(`…(${name}) the company is asked for by its institution id`, same(t.of("filings_facts")[0].body, { action: "filings_facts", kind: "company", years: 3, institutionId: "6000001" }));
    dl = await t.download(() => p.click('[data-act="fp-build-plain"]'));
    ok(`…(${name}) building with plain text works`, (await slidesOf(dl.zip))[1].includes("7 filings in 3 states"));
    await t.ctx.close();
  }

  // ----- errors, nothing returned, a search that stopped early -----
  for (const [name, ans, sel, says] of [
    ["too big, from the function", { status: 400, body: { error: "too_big", message: "A filings profile of Calloway Group over the last 5 years needs at least 55 S&P requests." } }, "#fpErr", "A filings profile of Calloway Group over the last 5 years needs at least 55 S&P requests."],
    ["not in the company list", { status: 404, body: { error: "not_found", message: "This company isn't in the app's company list under that S&P id any more. Find it by name again and choose it." } }, "#fpErr", "This company isn't in the app's company list under that S&P id any more. Find it by name again and choose it."],
    ["S&P not set up", { status: 503, body: { error: "not_configured", message: "S&P API access isn't set up yet." } }, "#fpErr", "S&P API access isn't set up yet."],
    ["S&P failing", { status: 502, body: { error: "spgmi_server", message: "S&P answered with an error (500). S&P reference: req-1." } }, "#fpErr", "Couldn't get the filings. S&P answered with an error (500). S&P reference: req-1.Try again"]]) {
    t = await open({ template: { text: "PK" } }, { facts: () => ans }); p = t.p;
    await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(500);
    ok(`facts error (${name}): said plainly`, (await t.txt(sel)) === says && !(await p.$("#fp_buildBtn")), await t.txt(sel));
    await t.ctx.close();
  }
  const nothing = () => { const a = FACTS_ANS(); Object.assign(a.body.facts.totals, { filings: 0, rate: 0, rule: 0, form: 0, states: 0, latest: null, undated: 0 }); a.body.facts.rates = { filings: 0, withImpact: 0, notApproved: 0, noDate: 0, lo: null, hi: null, points: [], pointsTotal: 0, rows: [], rowsTotal: 0 };
    a.body.facts.states = { rows: [], noState: 0 }; a.body.facts.years.totals = [0, 0, 0, 0]; a.body.facts.latest = { rows: [], total: 0 }; a.body.facts.regulator = { rows: [], all: null, left: 0 }; a.body.facts.largest = null; return a; };
  t = await open({ template: { text: "PK" } }, { facts: nothing }); p = t.p;
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(800);
  ok("nothing returned: S&P returned nothing for this search, never that nothing was filed", (await t.txt("#fpNothing")) === "S&P returned nothing for this search. No filings came back for Calloway Insurance Co in any state over the last 3 years. That doesn't prove nothing was filed. Check the choice, or try a longer period." && !/no filings exist/i.test(await t.txt("#fpOut")));
  ok("…and the slides that need filings are left out, saying why", (await t.list("#fpPlan li")).filter(x => x.includes("Left out: S&P returned nothing for this search")).length === 10);
  await t.ctx.close();
  t = await open({ template: { text: "PK" } }, { facts: () => { const a = FACTS_ANS(); a.body.facts.search.capped = true; a.body.spRequests = 60; return a; } }); p = t.p;
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(800);
  ok("a search that stopped early: said, with what to do", (await t.txt("#fpCapped")) === "The search stopped early, so these filings may be incomplete and the slides say so. Choose a shorter period or one company for a complete profile." && (await t.txt("#fpSource")).endsWith("60 S&P requests used."));
  await t.ctx.close();

  // ----- the sample, statutory ready, S&P not set up, Claude not set up, no template -----
  t = await open({ template: { text: "PK" } }); p = t.p;
  dl = await t.download(() => p.click('[data-act="fp-sample"]')); await p.waitForTimeout(200);
  ok("the sample filings profile: asked for and built in one click", same(t.of("filings_sample").map(c => c.body), [{ action: "filings_sample" }]) && dl.name === "Calloway-Group-filings-profile-sample-2026-11-18.pptx" && (await slidesOf(dl.zip)).length === 13, dl.name);
  ok("the sample says it is made up, has no draft, and nothing is told to Claude", (await t.txt("#fpSample")).startsWith("This is a sample filings profile.") && (await t.txt("#fpDraftNote")) === "The sample uses plain text written from its figures." && (await p.evaluate(() => askScreen())) === null);
  await p.click('[data-act="pf-sample"]'); await p.waitForTimeout(400);
  ok("the full profile's sample switches to the full profile", (await p.getAttribute('[data-act="pf-mode"][data-m="full"]', "aria-pressed")) === "true");
  await t.ctx.close();
  t = await open({}, { pstatus: () => PSTATUS({ statutory: { configured: true, mapped: true, fields: [] } }) }); p = t.p;
  ok("statutory data ready: the full profile shows first, and the filings profile is one click away", !!(await p.$("#pfForm")) && (await p.getAttribute('[data-act="pf-mode"][data-m="filings"]', "aria-pressed")) === "false");
  await t.ctx.close();
  t = await open({ role: "reader" }, { pstatus: () => PSTATUS({ filings: { configured: false }, claude: { configured: false } }) }); p = t.p;
  ok("S&P filings not set up: said calmly; saved searches still open", (await t.txt("#fpOff")) === "S&P filings aren't set up yet, so a new filings profile can't be searched. A profile whose search was run before still opens from its saved result. You can build the sample below meanwhile.");
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(800);
  ok("Claude not set up: plain titles, no draft choice", (await t.txt("#fpDraftNote")) === "Claude isn't set up, so the slides use plain titles and points written from the filings." && !(await p.$("#fp_draft")) && (await t.txt("#fp_buildBtn")) === "Build the PowerPoint file");
  ok("no template, a reader: the button builds on the built-in plain template", !(await p.isDisabled("#fp_buildBtn")) && !(await p.$("#fpNoTplNote")) && (await t.txt("#pfTplState")) === "The built-in plain template: nobody has uploaded one yet.");
  await t.ctx.close();

  // ----- hostile text, and the session ending -----
  const X = '<img src=x onerror="window.__xss=1">';
  t = await open({ template: { text: "PK" } }, { resolve: q => { const r = RESOLVE(q); r.groups[0].name = G + X; r.matches[0].companyName = "Calloway " + X; return r; },
    facts: () => { const a = FACTS_ANS(); a.body.facts.entity.name = "Calloway " + X; return a; }, draft: () => { const d = DRAFT_ANS(); d.body.text.by = "plain"; d.body.text.note = X; return d; } }); p = t.p;
  await t.find(X); await t.find("Calloway");
  ok("hostile names in the matches stay text", (await t.list("#fp_matches li .t1"))[0] === G + X && !(await p.evaluate(() => window.__xss)));
  await p.click('[data-act="fp-group"][data-i="0"]'); await p.waitForTimeout(100);
  ok("…in the chosen line", (await t.txt("#fp_chosen")).includes(G + X) && !(await p.evaluate(() => window.__xss)));
  await p.click("#fp_get"); await p.waitForTimeout(800);
  dl = await t.download(() => p.click("#fp_buildBtn")); await p.waitForTimeout(150);
  ok("…in the facts and a draft's note, and in the file", (await t.txt("#fpName")) === "Calloway " + X && (await t.txt("#fpNote")) === "The slides use plain text. " + X && !(await slidesOf(dl.zip)).join("").includes("<img") && !(await p.evaluate(() => window.__xss)));
  await t.ctx.close();
  t = await open({ template: { text: "PK" } }, { draft: () => ({ status: 401, body: { message: "Your session has ended. Sign in again." } }) }); p = t.p;
  await t.find("Calloway"); await p.click('[data-act="fp-co"][data-i="0"]'); await p.waitForTimeout(100); await p.click("#fp_get"); await p.waitForTimeout(800);
  await p.click("#fp_buildBtn"); await p.waitForTimeout(500);
  ok("session ended while drafting: back to sign-in, nothing built, the profile dropped", (await t.txt(".login .err")) === "Your session has ended. Sign in again." && await p.evaluate(() => S.pf.fp.res === null && S.pf.tpl.bytes === null));
  await t.ctx.close();

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });
