// The Screener view (Corp Dev only): a plain form that finds the companies fitting a description across every statutory
// filer, through the statutory function's screen action. Covers: the tab and who sees it; not set up, not mapped and
// not deployed; S&P's line names for the year (loaded, failed, not mapped); the form, the request it sends and the
// read-back; results with n/d, sorting on the page, the cut list and "Run again sorted this way"; the three open-in
// buttons; CSV and XLSX exports; running with Stop, took too long, failed, can't run, nothing matched; nothing kept in
// browser storage or sent to Ask Claude; keyboard use; 1440 and 390 wide. Every company, code and figure is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), SC=FIX("screener_answers.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG=`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};`;
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const SCREEN_INFO=copy(SC.screenStatus);
const STATUS_MAPPED={...copy(STAT.statusMapped), companies:{mapped:true, problem:null}, screen:SCREEN_INFO};
const J200=o=>({status:200, body:o});

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], role:over.role||"corpdev", delay:()=>0, stat:()=>copy(STATUS_MAPPED),
      lines:()=>J200({year:2025, lines:["Commercial auto","Homeowners","Workers comp"], cut:false}),
      screen:()=>J200(copy(SC.answer)), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:t.role, statutory:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2, resetsAt:"2026-11-14T00:00:00Z"});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(fn==="snl-profile") return J(200,{configured:true, statutory:{configured:true, mapped:true}, template:null});
        if(fn==="snl-statutory"){
          if(body.action==="status") return J(200, t.stat());
          const d=t.delay(body); if(d) await new Promise(res=>setTimeout(res,d));
          if(body.action==="screen-lines"){ const a=t.lines(body); return J(a.status, a.body); }
          if(body.action==="screen"){ const a=t.screen(body); return J(a.status, a.body); }
          if(body.action==="query") return J(200,{kind:"company", codes:body.codes, fromYear:body.fromYear, toYear:body.toYear, entities:[], fields:[], loaded:[], truncated:false, fetchedAt:"2026-11-13T11:59:00Z", fromStore:false, saved:true, pending:0});
        }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; }, {role:t.role});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    if(over.go!==false){ await p.evaluate(()=>{ location.hash="#screener"; }); await p.waitForTimeout(350); }
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.screens=()=>t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="screen").map(c=>c.body);
    t.until=async (cond, ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await cond()) return true; await p.waitForTimeout(40); } return false; };
    t.pick=async (kind, v)=>{ await p.check(`[data-sc-pick="${kind}"][value="${v}"]`); await p.waitForTimeout(60); };
    t.addFilter=async (field, min, max)=>{ await p.click("#scAddFilter"); await p.waitForTimeout(60); const i=(await p.$$(".scfrow")).length-1;
      await p.selectOption(`#sc_f${i}_field`, field); await p.waitForTimeout(60); if(min!==undefined) await p.fill(`#sc_f${i}_min`, String(min)); if(max!==undefined) await p.fill(`#sc_f${i}_max`, String(max)); };
    t.go=async ()=>{ await p.click("#scGo"); await t.until(async()=>!(await p.$("#scBusy"))); await p.waitForTimeout(80); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    t.colText=async c=>p.$$eval(`#scTable tbody td[data-c="${c}"]`, tds=>tds.map(td=>td.textContent.trim()));
    t.names=async ()=>p.$$eval("#scTable tbody tr td:first-child .t1", e=>e.map(x=>x.textContent.trim()));
    return t;
  }

  // ===== the tab, the form and a first screen =====
  let t=await open(); let p=t.p;
  ok("Corp Dev sees a Screener tab, after Combination", same(await p.$$eval("nav.tabs a:not([hidden])",as=>as.map(a=>a.dataset.view)),["filings","snapshot","compare","market","earnings","statutory","combination","screener","profile"]) && (await p.getAttribute('nav.tabs a[data-view="screener"]',"aria-current"))==="page");
  ok("the title says what it is for", (await t.txt("#view .action-title"))==="Screener: find companies that fit a description");
  await t.until(async()=>(await p.$$('[data-sc-pick="lines"]')).length===3);
  ok("S&P's line names for last year are asked for once, with one call", same(t.calls.filter(c=>c.body.action==="screen-lines").map(c=>c.body), [{action:"screen-lines", year:2025}]));
  ok("the line picker lists S&P's names", same(await p.$$eval('[data-sc-pick="lines"]',e=>e.map(x=>x.value)), ["Commercial auto","Homeowners","Workers comp"]));
  ok("the state picker lists the 50 states and DC by name", (await p.$$('[data-sc-pick="states"]')).length===51 && (await t.txt("#sc_states_box")).startsWith("Alabama Alaska Arizona"));
  ok("with no filter yet, the form says what a screen without filters does", (await t.txt("#scNoFilters"))==="No filters yet: every company with premium in view is listed, largest first.");
  ok("the group choice is offered when the look-up has group codes", await p.isVisible("#sc_group") && !(await p.$("#scGroupOff")));
  ok("an unmapped figure can't be chosen for a filter", await p.evaluate(()=>{ document.getElementById("scAddFilter").click(); return true; }) && await p.waitForTimeout(80).then(()=>true) && await p.$eval('#sc_f0_field option[value="rbc_ratio"]', o=>o.disabled && /not mapped/.test(o.textContent)));
  await p.click('[data-act="sc-filter-remove"]'); await p.waitForTimeout(60);
  ok("Remove takes the filter away", (await p.$$(".scfrow")).length===0);
  await t.pick("states","FL"); await t.pick("lines","Homeowners");
  ok("chosen states and lines show as chips", (await t.txt("#sc_states .chips"))==="Florida FL×" && (await t.txt("#sc_lines .chips"))==="Homeowners×", [await t.txt("#sc_states .chips"), await t.txt("#sc_lines .chips")]);
  await t.addFilter("premium", 50, 300); await t.addFilter("combined_ratio", undefined, 100);
  await t.addFilter("surplus", 300, 100);
  await p.click("#scGo"); await p.waitForTimeout(100);
  ok("a minimum above a maximum is caught before anything is sent", (await t.txt("#scErr"))==="Policyholder surplus: the minimum is above the maximum." && t.screens().length===0);
  await p.click('.scfrow[data-i="2"] [data-act="sc-filter-remove"]'); await p.waitForTimeout(60);
  await t.go();
  ok("the screen is sent as small plain JSON", same(t.screens()[0], {action:"screen", year:2025, states:["FL"], lines:["Homeowners"], filters:[{field:"premium",min:50,max:300},{field:"combined_ratio",max:100}], group:"any", sort:{by:"premium",dir:"desc"}, limit:100}), t.screens()[0]);
  ok("one plain-English read-back above the results", (await t.txt("#scReadBack"))==="Screen: Direct premiums written in Florida, Homeowners, 2025, between $50M and $300M; combined ratio at most 100.0%.", await t.txt("#scReadBack"));
  ok("the companies, largest premium in view first", same(await t.names(), ["Tarrow Mutual Insurance Co","Calloway Insurance Co","Nonesuch Casualty Co"]), await t.names());
  ok("$M with commas and percentages to one decimal", same(await t.colText("premium"), ["$250M","$120M","$55M"]) && same(await t.colText("focus"), ["25.0%","60.0%","100.0%"]), [await t.colText("premium"), await t.colText("focus")]);
  ok("every company shown fits the screen: premium in range, combined ratio at most 100, gross premiums at least premium in view", same(await t.colText("combined_ratio"), ["98.0%","95.0%","88.0%"]) && same(await t.colText("gpw"), ["$1,100M","$210M","$60M"]), await t.colText("gpw"));
  ok("a company with no surplus figure shows n/d", same(await t.colText("surplus"), ["$900M","$140M","n/d"]), await t.colText("surplus"));
  ok("each row says its NAIC group, or that it has none", (await t.txt('#scTable tr[data-code="91001"] td:first-child'))==="Calloway Insurance CoNAIC group 9100 · Calloway Group" && (await t.txt('#scTable tr[data-code="92001"] td:first-child'))==="Tarrow Mutual Insurance CoNo NAIC group");
  ok("how many matched, and how they are sorted", (await t.txt("#scShown"))==="3 companies match this screen, sorted by premium in view, largest first.", await t.txt("#scShown"));
  const notes=await t.txt("#scNotes");
  ok("the notes: by legal entity, premium in view is direct premiums written, missing figures, the function's own notes, the cost", notes.startsWith("Figures are statutory, by legal entity: a group's companies are listed separately, never added up.") && notes.includes("Premium in view is direct premiums written") && notes.includes("A company missing a figure is left out by a filter on that figure, and shows n/d where it is listed.") && notes.includes("Focus is premium in view as a share of the company's total direct premiums written in 2025, from premiums by line over every line.") && notes.includes("1 company was left out: S&P's rows give it two premium figures for the same state and line in 2025.") && notes.includes("Policyholder surplus is n/d for 1 company: S&P's rows give it two figures for 2025.") && notes.endsWith("Cost: one Snowflake statement a screen, about 0.02 Snowflake credit, more for wide screens. No S&P filing requests and no Claude. Nothing about a screen is saved or sent anywhere."), notes);
  ok("no em dash anywhere on the view", !/\u2014/.test(await t.txt("#view")));
  // sorting on the page: no new query
  await p.click('#scTable [data-k="name"]'); await p.waitForTimeout(80);
  ok("sorting by a column reorders what is on screen without a new screen", same(await t.names(), ["Calloway Insurance Co","Nonesuch Casualty Co","Tarrow Mutual Insurance Co"]) && t.screens().length===1 && (await p.getAttribute('#scTable th:first-child',"aria-sort"))==="ascending");
  await p.click('#scTable [data-k="surplus"]'); await p.waitForTimeout(80);
  ok("a column of figures sorts largest first, n/d always last", same(await t.colText("surplus"), ["$900M","$140M","n/d"]));
  await p.click('#scTable [data-k="surplus"]'); await p.waitForTimeout(80);
  ok("and again, smallest first, n/d still last", same(await t.colText("surplus"), ["$140M","$900M","n/d"]));
  ok("no Run again button when the list wasn't cut", !(await p.$("#scAgain")));
  // exports
  await p.click('#scTable [data-k="premium"]'); await p.waitForTimeout(60);
  const csv=await t.download(()=>p.click('[data-act="sc-export"][data-fmt="csv"]'));
  ok("Export CSV is named snl-screen-DATE", csv.name==="snl-screen-2026-11-13.csv", csv.name);
  const lines=csv.text.replace(/^﻿/,"").split("\r\n");
  ok("the CSV header has the columns in US dollars and percent", lines[0]==='"NAIC company code","Company","NAIC group code","NAIC group","Premium in view US dollars","Focus %","Combined ratio %","Policyholder surplus US dollars","Gross premiums written US dollars"', lines[0]);
  ok("the CSV rows hold the figures, n/d where missing", lines[1]==='"92001","Tarrow Mutual Insurance Co","","","250000000","25","98","900000000","1100000000"' && lines.some(l=>/"93001".*"n\/d"/.test(l)), lines.slice(1,4));
  ok("the CSV carries the read-back, the year, what is shown and the notes", lines.some(l=>l.startsWith('"Screen","Direct premiums written in Florida, Homeowners, 2025, between $50M and $300M; combined ratio at most 100.0%."')) && lines.some(l=>l.startsWith('"Year","2025"')) && lines.some(l=>l.startsWith('"Shown","3 companies match')) && lines.filter(l=>l.startsWith('"Note"')).length>=5, lines.slice(4));
  const xl=await t.download(()=>p.click('[data-act="sc-export"][data-fmt="xlsx"]'));
  const sheet=JSON.parse(xl.text).sheets[0];
  ok("Export XLSX: one sheet, the same rows and the read-back", xl.name==="snl-screen-2026-11-13.xlsx" && sheet.name==="Screen" && sheet.aoa[1][0]==="92001" && sheet.aoa.some(r=>r[0]==="Screen" && /Florida, Homeowners/.test(r[1])), sheet.aoa.slice(0,2));
  // nothing kept, nothing told to Claude
  ok("nothing about the screen is kept in browser storage", await p.evaluate(()=>!/Homeowners|FL"|Tarrow|Calloway|combined|premium/.test(JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))));
  ok("nothing written to the database", (await p.evaluate(()=>window.__mock.log)).filter(l=>l.op==="upsert").length===0);
  ok("Ask Claude is told nothing about this view", await p.evaluate(()=>askScreen()===null));
  ok("no call carried the screen anywhere but the statutory function", t.calls.filter(c=>c.fn!=="snl-statutory").every(c=>!/Homeowners|combined_ratio/.test(JSON.stringify(c.body))));
  await p.screenshot({path:path.join(OUTDIR,"screener-1440.png"), fullPage:true});
  ok("no sideways scroll at 1440", await t.noScroll());
  // keyboard: a header reached by Tab and sorted with Enter; Enter in a bound runs the screen
  await p.focus('#scTable [data-k="code"]'); await p.keyboard.press("Enter"); await p.waitForTimeout(80);
  ok("a column header sorts from the keyboard and keeps the focus", (await p.getAttribute('#scTable th:nth-child(2)',"aria-sort"))==="ascending" && await p.evaluate(()=>document.activeElement&&document.activeElement.dataset.k==="code"));
  await p.focus('#scTable tr[data-code="91001"] [data-to="statutory"]');
  ok("the open-in buttons are reachable from the keyboard", await p.evaluate(()=>document.activeElement.textContent==="Statutory" && document.activeElement.getAttribute("aria-label")==="Open Calloway Insurance Co in Statutory"));
  await p.fill("#sc_f0_min","60"); await p.press("#sc_f0_min","Enter"); await t.until(async()=>t.screens().length===2);
  ok("Enter in a filter box runs the screen again", t.screens().length===2 && t.screens()[1].filters[0].min===60);
  await t.until(async()=>!(await p.$("#scBusy")));
  // open in Statutory: the Statutory view takes the code, the last five years to the screen's year, and runs
  await p.click('#scTable tr[data-code="91001"] [data-to="statutory"]'); await p.waitForTimeout(400);
  const q=t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query").map(c=>c.body);
  ok("Statutory opens with the company and looks it up", (await p.evaluate(()=>location.hash))==="#statutory" && (await p.inputValue("#st_codes"))==="91001" && same(q[0], {action:"query", kind:"company", codes:["91001"], fromYear:2021, toYear:2025}), q);
  await p.evaluate(()=>{ location.hash="#screener"; }); await p.waitForTimeout(300);
  ok("the last result is still there on coming back (kept in the page only)", same(await t.names(), ["Tarrow Mutual Insurance Co","Calloway Insurance Co","Nonesuch Casualty Co"]));
  await p.click('#scTable tr[data-code="92001"] [data-to="profile"]'); await p.waitForTimeout(400);
  ok("Profile opens with the company chosen, by code and name, without building anything", (await p.evaluate(()=>location.hash))==="#profile" && (await p.inputValue("#pf_code"))==="92001" && (await p.evaluate(()=>S.pf.name))==="Tarrow Mutual Insurance Co");
  await p.evaluate(()=>{ location.hash="#screener"; }); await p.waitForTimeout(300);
  await p.click('#scTable tr[data-code="93001"] [data-to="combination"]'); await p.waitForTimeout(500);
  ok("As target opens Combination with the company as the target", (await p.evaluate(()=>location.hash))==="#combination" && await p.evaluate(()=>S.cb.target.codes==="93001" && S.cb.target.names["93001"]==="Nonesuch Casualty Co" && S.cb.target.kind==="company"));
  ok("no page errors", errs.length===0, errs);
  await t.ctx.close();

  // ===== a cut list: the note, re-sorting covers only what was fetched, Run again sorted this way =====
  t=await open({screen:()=>J200({...copy(SC.answer), total:412, cut:true, limit:3})}); p=t.p;
  await t.until(async()=>(await p.$$('[data-sc-pick="lines"]')).length===3);
  await t.go();
  ok("a cut list says how many of how many", (await t.txt("#scShown"))==="Showing the largest 3 of 412 by premium in view.", await t.txt("#scShown"));
  ok("and that sorting the table only reorders those fetched", (await t.txt("#scCut")).startsWith("The list was cut at 3 companies, so sorting the table only reorders these 3, not all 412 that match.") && !(await p.$("#scAgain")));
  await p.click('#scTable [data-k="name"]'); await p.waitForTimeout(80);
  ok("once re-sorted, Run again sorted this way is offered", await p.isVisible("#scAgain") && (await t.txt("#scCut")).includes("To see the first 3 of all 412 sorted by company name, A to Z, run it again."), await t.txt("#scCut"));
  await p.click("#scAgain"); await t.until(async()=>t.screens().length===2);
  ok("it runs the screen again, sorted that way", same(t.screens()[1].sort, {by:"name", dir:"asc"}) && (await p.inputValue("#sc_sort"))==="name");
  await t.ctx.close();

  // ===== running, Stop, took too long, failed, can't run, nothing matched =====
  t=await open({delay:b=>b.action==="screen"?1500:0}); p=t.p;
  await p.click("#scGo"); await p.waitForTimeout(300);
  ok("while running: the read-back, up to a minute, a bar and Stop", (await t.txt("#scBusy")).startsWith("Running the screen across every company… A screen can take up to a minute.") && await p.isVisible('#scBusy [data-act="sc-stop"]') && (await t.txt("#scGo"))==="Running…");
  await p.click('#scBusy [data-act="sc-stop"]'); await p.waitForTimeout(100);
  ok("Stop: nothing is shown from it, and it can run again", (await t.txt("#scStopped"))==="You stopped the screen before it came back, so nothing is shown from it.Run it again");
  await p.waitForTimeout(1600);
  ok("an answer that arrives after Stop is dropped", !!(await p.$("#scStopped")) && !(await p.$("#scTable")));
  await t.ctx.close();
  t=await open({screen:()=>({status:504, body:{error:"timeout", message:"The screen didn't finish in time. Narrow it (add a state or a line) and run it again."}})}); p=t.p;
  await t.go();
  ok("took too long: says so plainly, with Try again, and no list", (await t.txt("#scTimeout"))==="The screen took too long. The screen didn't finish in time. Narrow it (add a state or a line) and run it again.Try again" && !(await p.$("#scTable")), await t.txt("#scTimeout"));
  await p.click('#scTimeout [data-act="sc-retry"]'); await t.until(async()=>t.screens().length===2);
  ok("Try again runs it again", t.screens().length===2);
  await t.ctx.close();
  t=await open({screen:()=>({status:502, body:{error:"snowflake_server", message:"Snowflake answered 500. Try again in a few minutes."}})}); p=t.p;
  await t.go();
  ok("failed: the plain reason and Try again", (await t.txt("#scFailed")).startsWith("The screen didn't run. Snowflake answered 500. Try again in a few minutes.") && await p.isVisible('#scFailed [data-act="sc-retry"]'), await t.txt("#scFailed"));
  await t.ctx.close();
  t=await open({screen:()=>({status:409, body:{error:"not_mapped", figure:"surplus", message:"Policyholder surplus isn't mapped to S&P's data yet, so a screen can't use it."}})}); p=t.p;
  await t.go();
  ok("can't run: the function's plain message, naming the figure", (await t.txt("#scCant"))==="This screen can't run yet. Policyholder surplus isn't mapped to S&P's data yet, so a screen can't use it.", await t.txt("#scCant"));
  await t.ctx.close();
  t=await open({screen:()=>J200({...copy(SC.answer), rows:[], total:0, cut:false})}); p=t.p;
  await t.go();
  ok("nothing matched is never 'no such company'", (await t.txt("#scNone"))==="S&P returned no company for this screen in 2025. That doesn't mean no such company exists. Loosen a filter, choose fewer, or check that 2025 has been filed: statements for a year come in during the spring after it.", await t.txt("#scNone"));
  ok("and the notes still show", await p.isVisible("#scNotes"));
  await t.ctx.close();

  // ===== the line names fail, or aren't mapped: the rest of the form still works =====
  t=await open({lines:()=>({status:502, body:{error:"snowflake_server", message:"Snowflake answered 500. Try again in a few minutes."}})}); p=t.p;
  await t.until(async()=>!!(await p.$("#scLinesErr")));
  ok("lines that fail to load say so, with Try again, and the rest still works", (await t.txt("#scLinesErr")).startsWith("S&P's line names for 2025 couldn't be loaded.") && (await t.txt("#scLinesErr")).includes("The rest of the form still works."));
  await t.pick("states","TX"); await t.go();
  ok("a screen by state runs without lines", same(t.screens()[0].states, ["TX"]) && same(t.screens()[0].lines, []));
  await t.ctx.close();
  const noLines=copy(STATUS_MAPPED); noLines.screen.premium.dpw_by_line="Direct premiums written by line isn't mapped to S&P's data yet, so a screen can't use it.";
  t=await open({stat:()=>copy(noLines)}); p=t.p; await p.waitForTimeout(200);
  ok("with premiums by line not mapped, the line picker says so and no line names are asked for", (await t.txt("#scLinesOff")).startsWith("Lines can't be chosen: direct premiums written by line isn't mapped yet") && !t.calls.some(c=>c.body.action==="screen-lines"));
  await t.ctx.close();
  const noSl=copy(STATUS_MAPPED); noSl.screen.premium.dpw_by_state_line="not mapped"; noSl.screen.group=false;
  t=await open({stat:()=>copy(noSl)}); p=t.p;
  await t.until(async()=>(await p.$$('[data-sc-pick="lines"]')).length===3);
  await t.pick("states","FL"); await t.pick("lines","Homeowners");
  ok("both a state and a line need premiums by state and line: the form says which figure", (await t.txt("#scPremOff")).startsWith("Direct premiums written by state and line isn't mapped yet, so a screen with both a state and a line can't run. Map dpw_by_state_line in Field set-up"), await t.txt("#scPremOff"));
  ok("without group codes, the group choice says what it needs", !(await p.$("#sc_group")) && (await t.txt("#scGroupOff")).startsWith("Choosing by NAIC group needs the company look-up"));
  await p.click("#scGo"); await p.waitForTimeout(80);
  ok("and Run is refused before anything is sent", (await t.txt("#scErr")).startsWith("Direct premiums written by state and line isn't mapped yet") && t.screens().length===0);
  await t.ctx.close();

  // ===== not set up, not mapped, not deployed; a reader =====
  t=await open({stat:()=>copy(STAT.statusOff)}); p=t.p;
  ok("before Snowflake is set up the view says so", (await t.txt("#scOff")).startsWith("Statutory data isn't set up yet, so there is nothing to screen.") && !(await p.$("#scForm")));
  await t.ctx.close();
  t=await open({stat:()=>({...copy(STAT.statusUnmapped), screen:SCREEN_INFO})}); p=t.p;
  ok("before any field is mapped the view says so", (await t.txt("#scUnmapped")).startsWith("Snowflake is connected, but the statutory fields aren't mapped yet."));
  await t.ctx.close();
  t=await open({stat:()=>{ const s=copy(STATUS_MAPPED); delete s.screen; return s; }}); p=t.p;
  ok("an older statutory function: the view says to deploy it", (await t.txt("#scNotDeployed")).includes("supabase functions deploy snl-statutory --no-verify-jwt"));
  await t.ctx.close();
  t=await open({role:"reader"}); p=t.p;
  ok("a reader has no Screener tab, and the deep link shows nothing but that", await p.isHidden('nav.tabs a[data-view="screener"]') && (await t.txt("#scOnly"))==="This view is for Corp Dev logins." && !t.calls.some(c=>/^screen/.test(c.body.action||"")));
  await t.ctx.close();

  // ===== 390 wide, and the form isn't remembered between visits =====
  // the answer to this screen (growth over 3 years at least 10%, not in a NAIC group): only companies that fit it
  const GROWN=()=>{ const a=copy(SC.answer); a.growth={years:3, min:10}; a.group="none";
    a.columns.splice(2, 0, {id:"growth", label:"Growth in premium in view over 3 years", unit:"pct"});
    a.rows=a.rows.filter(r=>!r.groupCode).map(r=>({...r, growth:r.code==="92001"?12.5:40}));
    a.total=a.rows.length; a.notes=[a.notes[0], "Growth compares premium in view in 2025 with 2022. A company with nothing in 2022 has no growth figure and doesn't pass the growth filter.", "A company the company look-up doesn't list is left out by the group choice."]; return J200(a); };
  t=await open({width:390, screen:GROWN}); p=t.p;
  await t.until(async()=>(await p.$$('[data-sc-pick="lines"]')).length===3);
  await t.pick("states","FL"); await t.pick("lines","Homeowners"); await t.addFilter("premium", 50, 300);
  await p.click('#scGrowth, #sc_growth'); await p.selectOption("#sc_growth","3"); await p.waitForTimeout(80); await p.fill("#sc_gmin","10");
  await p.selectOption("#sc_group","none");
  ok("no sideways scroll at 390 on the form", await t.noScroll());
  await t.go();
  ok("growth and group go with the screen", same(t.screens()[0].growth, {years:3, min:10}) && t.screens()[0].group==="none");
  ok("and read back", (await t.txt("#scReadBack")).endsWith("between $50M and $300M; growth over 3 years at least 10.0%; not in a NAIC group."), await t.txt("#scReadBack"));
  ok("the growth column shows, in percent", same(await t.colText("growth"), ["12.5%","40.0%"]));
  ok("no sideways scroll at 390 with results: the table scrolls in its own box", await t.noScroll() && await p.$eval("#scWrap", e=>e.scrollWidth>e.clientWidth));
  await p.screenshot({path:path.join(OUTDIR,"screener-390.png"), fullPage:true});
  await p.reload(); await p.waitForTimeout(500);
  ok("after a reload the form starts afresh and no result is shown", (await p.$$(".scfrow")).length===0 && !(await p.$("#scTable")) && (await p.$$('[data-sc-pick="states"]:checked')).length===0);
  ok("no page errors", errs.length===0, errs);
  await t.ctx.close();

  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
