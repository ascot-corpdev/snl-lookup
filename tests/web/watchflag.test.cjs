// Watchlist marks on the Filings view: each marked filing's label and its reason in words (not only on hover),
// marked filings first, the count, the filter to show only marked filings beside "Show all N", what a reader sees,
// hostile text in labels and reasons, an older function that sends no marks, the "not set up yet" states that say
// which step is missing, the note about who can see the watchlist, and the 390px layout. Every company, id and
// filing here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), RESOLVE=FIX("web_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

const LIST={enabled:true, companies:[{kind:"companyId",id:"4000001",name:"Calloway Insurance Co"},{kind:"institutionId",id:"5000001",name:"Calloway Group"}], states:["FL","GA"], recipients:["corpdev1@example.com"]};
const FOUND=(i,over={})=>({filing_version_id:`0D0D0D0D-0000-4000-8000-${String(i).padStart(12,"0")}`, run_id:"run-2", first_seen_at:"2026-11-13T06:24:00Z", baseline:false, companies:["Calloway Insurance Co"], state:"FL", state_name:"Florida",
  filing_type:"Rate", type_of_insurance:"Homeowners", sub_type_of_insurance:null, filing_status:"Pending", date_submitted:"2026-10-28", publish_date:"2026-11-10", effective_new:"2027-01-01", effective_renewal:null,
  rate_impact:"4.5%", description:`Made-up homeowners rate revision ${i}.`, tracking_number:`CALL-FL-${i}`, document_id:72000000+i, flags:[], ...over});
const FL={
  program:{kind:"new_program", label:"New program", reason:'the description says "new program"'},
  form:{kind:"new_form", label:"New form", reason:'the description says "new policy form"'},
  withdrawn:{kind:"withdrawal", label:"Withdrawal", reason:'the status is "Closed - Withdrawn"'},
  rate:{kind:"large_rate", label:"Large rate change", reason:"the overall rate impact is +12.5%"},
};
// eight new filings, the latest found first; three are marked (the 3rd, 6th and 8th)
const EIGHT=()=>Array.from({length:8},(_, i)=>FOUND(i+1, i===2?{flags:[FL.program], description:"Made-up new program for high value homes.", filing_type:"Form"}
  : i===5?{flags:[FL.form, FL.rate], rate_impact:"12.5%"} : i===7?{flags:[FL.withdrawn], filing_status:"Closed - Withdrawn"} : {}));
const RUN=(over={})=>({id:"run-2", status:"ok", trigger:"schedule", started_at:"2026-11-13T06:23:00Z", finished_at:"2026-11-13T06:24:00Z", requests:2, found:8, new_count:8, baseline:false, complete:true, emailed:0, message:"Found 8 new filings.", scope:null, ...over});
const WSTATUS=(over={})=>({configured:true, emailConfigured:true, enabled:true, watchlist:LIST, problems:[], cost:3, budget:30, maxCompanies:280, tooBig:null, windowDays:14, keepDays:90, running:false,
  lastRun:RUN(), lastCheck:RUN(), found:EIGHT(), scheduleReady:true, lastScheduled:"2026-11-13T06:23:00Z", scheduleQuiet:false, role:"corpdev", ...over});

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], watch:()=>({status:200, body:WSTATUS()}), run:()=>({status:200, body:{run:{status:"ok", message:"Nothing new since the last check.", requests:1, newCount:0}, used:{hour:13,day:41}, limits:{hour:500,day:12000}, account:"trial"}}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const cors={"access-control-allow-origin":"*"};
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:cors,body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-watch"){
          if(body.action==="status"){ const a=t.watch(); return a.empty ? r.fulfill({status:a.status,body:""}) : J(a.status,a.body); }
          if(body.action==="run"){ const a=t.run(); return J(a.status,a.body); }
          return J(400,{error:"bad",message:"Unknown action."}); }
        if(body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve") return J(200,{...copy(RESOLVE), query:body.q});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+"#filings"); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.tns=async()=>t.all('#watchTable tbody td[data-label="Tracking number"]');
    return t;
  }
  const seed=doc=>({seed:[["snl_settings","watchlist",{doc}]]});

  // ----- a reader: marks, reasons, count, order, filter -----
  let t=await open({role:"reader", ...seed(LIST)}, {watch:()=>({status:200, body:WSTATUS({role:"reader"})})}); let p=t.p;
  ok("the count: how many of the new filings are marked", (await t.txt("#wMarked"))==="3 of 8 may be worth a closer look: a new program or form, a company new to a state, a withdrawal or a large rate change. Show only the 3 marked", await t.txt("#wMarked"));
  ok("a mark is called a hint, and an unmarked filing can still matter", (await t.txt("#wMarkNote"))==="A mark is a hint from the filing type, status, rate impact and description, not a fact: it says which words or figures triggered it, so check the filing. A filing without a mark can still matter.");
  ok("marked filings first, each group in the order found; five at first", same(await t.tns(),["CALL-FL-3","CALL-FL-6","CALL-FL-8","CALL-FL-1","CALL-FL-2"]), await t.tns());
  ok("the list's lead-in says marked ones come first", (await t.txt("#watchWrap >> xpath=preceding-sibling::div[1]"))==="New filings found in the last 90 days, marked ones first, then the latest found first:", await t.txt("#watchWrap >> xpath=preceding-sibling::div[1]"));
  ok("each mark as a small label", same(await t.all("#watchTable tbody tr >> nth=0 >> .pill.mark"),["New program"]) && same(await t.all("#watchTable tbody tr >> nth=1 >> .pill.mark"),["New form","Large rate change"]) && same(await t.all("#watchTable tbody tr >> nth=2 >> .pill.mark"),["Withdrawal"]));
  ok("the reason in words, saying may be", same(await t.all("#watchTable tbody tr >> nth=1 >> .wmark"),['New formMay be a new form or coverage: the description says "new policy form".',"Large rate changeMay be a large rate change: the overall rate impact is +12.5%."]), await t.all("#watchTable tbody tr >> nth=1 >> .wmark"));
  ok("the reason is on the page, not only on hover", await p.evaluate(()=>{ const e=document.querySelector("#watchTable .wmark .t2"); const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && !document.querySelector("#watchTable [title*='May be']"); }));
  ok("an unmarked filing shows no label, and its company as before", (await p.$$("#watchTable tbody tr >> nth=3 >> .wmarks")).length===0 && (await t.txt("#watchTable tbody tr >> nth=3 >> .c-co"))==="Calloway Insurance Co");
  ok("the marked filing still shows its company", (await t.txt("#watchTable tbody tr >> nth=0 >> .c-co")).endsWith("Calloway Insurance Co"));
  ok("Show all counts every new filing", (await t.txt('[data-act="w-all"]'))==="Show all 8");
  await p.click('[data-act="w-marked"]'); await p.waitForTimeout(120);
  ok("the filter: only the marked filings", same(await t.tns(),["CALL-FL-3","CALL-FL-6","CALL-FL-8"]) && (await p.getAttribute('[data-act="w-marked"]',"aria-pressed"))==="true" && (await t.txt('[data-act="w-marked"]'))==="Show all 8 new filings", await t.tns());
  ok("…with no Show all button (three fit), and a lead-in that says so", !(await p.$('[data-act="w-all"]')) && (await t.txt("#watchWrap >> xpath=preceding-sibling::div[1]"))==="Showing 3 marked new filings, the latest found first:");
  await p.click('[data-act="w-marked"]'); await p.waitForTimeout(120);
  await p.click('[data-act="w-all"]'); await p.waitForTimeout(120);
  ok("filter off, Show all: all eight, marked first", same(await t.tns(),["CALL-FL-3","CALL-FL-6","CALL-FL-8","CALL-FL-1","CALL-FL-2","CALL-FL-4","CALL-FL-5","CALL-FL-7"]) && (await t.txt('[data-act="w-all"]'))==="Show fewer", await t.tns());
  await p.click('[data-act="w-marked"]'); await p.waitForTimeout(120);
  ok("switching the filter on starts from the short list again", same(await t.tns(),["CALL-FL-3","CALL-FL-6","CALL-FL-8"]) && await p.evaluate(()=>S.w.showAll===false));
  await p.click('[data-act="w-marked"]'); await p.waitForTimeout(120);
  ok("…and off again shows five", (await p.$$("#watchTable tbody tr")).length===5 && (await t.txt('[data-act="w-all"]'))==="Show all 8");
  ok("a reader sees the marks but not Manage or the visibility note", !(await p.$('[data-act="w-manage"]')) && !(await p.$("#wVisible")) && (await p.$$("#watchTable .pill.mark")).length===4);
  ok("never reads as 'no filings exist'", !/no filings|0 filings/i.test(await t.txt("#watch")));
  await p.screenshot({path:OUTDIR+"/watchflag-reader-1440.png",fullPage:false});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with marks", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  ok("phone: the reason is shown in full on the card", await p.evaluate(()=>{ const e=document.querySelector("#watchTable .wmark .t2"); const r=e.getBoundingClientRect(); return r.width>0 && r.right<=window.innerWidth && e.scrollWidth<=e.clientWidth+1; }));
  await p.locator("#watch").screenshot({path:OUTDIR+"/watchflag-reader-390.png"});
  await t.ctx.close();

  // ----- nothing marked; one filing; an older function that sends no marks -----
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({found:[FOUND(1),FOUND(2)]})})}); p=t.p;
  ok("nothing marked: said, with no filter button", (await t.txt("#wMarked"))==="None of the 2 new filings is marked as a new program, new form, withdrawal or large rate change." && !(await p.$('[data-act="w-marked"]')) && !!(await p.$("#wMarkNote")));
  await t.ctx.close();
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({found:[FOUND(1)]})})}); p=t.p;
  ok("one filing, not marked: said in the singular", (await t.txt("#wMarked"))==="The new filing isn't marked as a new program, new form, withdrawal or large rate change.");
  await t.ctx.close();
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({found:[FOUND(1,{flags:[FL.program]})]})})}); p=t.p;
  await p.click('[data-act="w-marked"]'); await p.waitForTimeout(120);
  ok("one marked filing, filtered: the lead-in in the singular", (await t.txt("#watchWrap >> xpath=preceding-sibling::div[1]"))==="Showing 1 marked new filing, the latest found first:");
  await t.ctx.close();
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({found:[FOUND(1),FOUND(2)].map(r=>{ const x={...r}; delete x.flags; return x; })})})}); p=t.p;
  ok("an older function with no marks: no count, no note, the table as before", !(await p.$("#wMarked")) && !(await p.$("#wMarkNote")) && (await p.$$("#watchTable tbody tr")).length===2 && !(await p.$("#watchTable .wmarks")));
  await t.ctx.close();

  // ----- hostile text in labels and reasons -----
  const evil='<img src=x onerror="window.__xss=1">';
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({found:[FOUND(1,{flags:[{kind:"new_program", label:"New "+evil, reason:"the description says $& $' $1 "+evil}, {kind:"made_up", label:"Odd", reason:""}, {label:""}, null, "x"]}), FOUND(2,{flags:"not a list"})]})})}); p=t.p;
  ok("hostile label and reason show as text, $ patterns kept as typed", same(await t.all("#watchTable tbody tr >> nth=0 >> .wmark"),["New "+evil+"May be a new program or product: the description says $& $' $1 "+evil+".", "OddMay be worth a closer look."]) && !(await p.$("#watch img")) && await p.evaluate(()=>window.__xss===undefined), await t.all("#watchTable tbody tr >> nth=0 >> .wmark"));
  ok("flags that aren't a list are ignored", (await p.$$("#watchTable tbody tr >> nth=1 >> .wmarks")).length===0 && (await t.txt("#wMarked")).startsWith("1 of 2 "));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with hostile marks", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await t.ctx.close();

  // ----- switching it on: each "not set up yet" state says which step is missing -----
  t=await open(seed(LIST), {watch:()=>({status:503, body:{error:"no_tables", message:"The watchlist's tables aren't in the database yet. Run supabase/migrations/0003_watchlist.sql in the Supabase SQL editor (README, Watchlist, step 1). After that, this card shows the last check and Check now works."}})}); p=t.p;
  ok("migration not run: Corp Dev is told the step, calmly; the list still shows", (await t.txt("#wNoTables"))==="The daily check isn't set up yet. The watchlist's tables aren't in the database yet. Run supabase/migrations/0003_watchlist.sql in the Supabase SQL editor (README, Watchlist, step 1). After that, this card shows the last check and Check now works." && (await p.getAttribute("#wNoTables","role"))==="status" && (await p.$$("#wCos .cchip")).length===2, await t.txt("#wNoTables"));
  ok("migration not run: no Check now (it couldn't work yet)", !(await p.$("#wCheck")));
  await t.ctx.close();
  t=await open({role:"reader", ...seed(LIST)}, {watch:()=>({status:503, body:{error:"no_tables", message:"x"}})}); p=t.p;
  ok("migration not run: a reader is told Corp Dev can set it up", (await t.txt("#wNoTables"))==="The daily check isn't set up yet. Corp Dev can set it up; what is watched still shows here.");
  await t.ctx.close();
  t=await open(seed(LIST), {watch:()=>({status:404, empty:true})}); p=t.p;
  ok("function not deployed: no Check now", !(await p.$("#wCheck")) && (await t.txt("#wNoFn")).startsWith("The daily check isn't set up yet: the watchlist function isn't deployed."));
  await t.ctx.close();
  t=await open({role:"reader", ...seed(LIST)}, {watch:()=>({status:404, empty:true})}); p=t.p;
  ok("function not deployed: a reader is told Corp Dev can set it up", (await t.txt("#wNoFn"))==="The daily check isn't set up yet. Corp Dev can set it up; what is watched still shows here.");
  await t.ctx.close();
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({scheduleReady:false, scheduleQuiet:true, lastScheduled:null})})}); p=t.p;
  ok("no WATCH_SECRET: says checks happen only on Check now, and which steps are missing", (await t.txt("#wNoSchedule"))==="Daily checks aren't set up yet, so the list is checked only when you click Check now. Missing: WATCH_SECRET on Supabase (README, Watchlist, step 2), then the daily schedule (step 4, supabase/watch_schedule.sql). After both, a check runs by itself every day." && !(await p.$("#wQuiet")), await t.txt("#wNoSchedule"));
  ok("…and the summary doesn't claim a daily check", (await t.txt("#wSummary")).startsWith("On Checked when Corp Dev clicks Check now, for filings published in the last 14 days."), await t.txt("#wSummary"));
  await t.ctx.close();
  t=await open({role:"reader", ...seed(LIST)}, {watch:()=>({status:200, body:WSTATUS({scheduleReady:false, scheduleQuiet:true, role:"reader"})})}); p=t.p;
  ok("no WATCH_SECRET, a reader: told plainly, no set-up detail", (await t.txt("#wNoSchedule"))==="Daily checks aren't set up yet, so the list is checked only when Corp Dev clicks Check now.");
  await t.ctx.close();
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({scheduleQuiet:true, lastScheduled:null})})}); p=t.p;
  ok("secret set but no scheduled check yet: says what step 4 does and when", (await t.txt("#wQuiet"))==="No daily check has run yet. If step 4 of the README's Watchlist section (supabase/watch_schedule.sql) is done, the next one runs at the time set there (06:23 UTC unless you changed it). If not, run that file in the Supabase SQL editor.", await t.txt("#wQuiet"));
  await t.ctx.close();
  t=await open(seed(LIST), {watch:()=>({status:200, body:WSTATUS({scheduleQuiet:true, lastScheduled:"2026-11-10T06:23:00Z"})})}); p=t.p;
  ok("the schedule went quiet: says since when", (await t.txt("#wQuiet")).startsWith("No daily check has run since 10 Nov at 06:23."));
  await t.ctx.close();
  t=await open(seed({...LIST, enabled:false}), {watch:()=>({status:200, body:WSTATUS({enabled:false, scheduleReady:false, scheduleQuiet:true})})}); p=t.p;
  ok("switched off: only the switched-off note, not the schedule notes", !!(await p.$("#wOff")) && !(await p.$("#wNoSchedule")) && !(await p.$("#wQuiet")));
  await t.ctx.close();
  t=await open({role:"reader", ...seed(LIST)}, {watch:()=>({status:200, body:WSTATUS({scheduleQuiet:true, role:"reader"})})}); p=t.p;
  ok("a quiet schedule isn't shown to readers (they can't act on it)", !(await p.$("#wQuiet")));
  await t.ctx.close();

  // ----- Manage: who can see the watchlist -----
  t=await open(seed(LIST)); p=t.p;
  await p.click('[data-act="w-manage"]'); await p.waitForTimeout(120);
  ok("Manage says every login can see the list, and to leave off a name the team wouldn't want shown", (await t.txt("#wVisible"))==="Every login on the site can see this watchlist, so it shows which companies the team follows. Leave off any company the team would not want named." && (await t.txt("#wVisible")).split(". ").length===2);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with Manage open and marks", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.locator("#watch").screenshot({path:OUTDIR+"/watchflag-manage-390.png"});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
