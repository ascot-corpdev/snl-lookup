// The watchlist on the Filings view: what readers and Corp Dev see, adding the companies and states chosen in the
// search form, removing them, switching it on and off, email recipients, Check now, each state (nothing watched,
// S&P not set up, last check failed, a check running, nothing new, never checked, not deployed), opening a found
// filing's document, hostile text and the 390px layout. Every company, id and filing here is made up.
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
  rate_impact:"4.5%", description:`Made-up homeowners rate revision ${i}.`, tracking_number:`CALL-FL-${i}`, document_id:72000000+i, ...over});
const RUN=(over={})=>({id:"run-2", status:"ok", trigger:"schedule", started_at:"2026-11-13T06:23:00Z", finished_at:"2026-11-13T06:24:00Z", requests:2, found:4, new_count:2, baseline:false, complete:true, emailed:0, message:"Found 2 new filings.", scope:null, ...over});
const WSTATUS=(over={})=>({configured:true, emailConfigured:true, enabled:true, watchlist:LIST, problems:[], cost:3, budget:30, maxCompanies:280, tooBig:null, windowDays:14, keepDays:90, running:false,
  lastRun:RUN(), lastCheck:RUN(), found:[FOUND(1), FOUND(2,{companies:["Tarrow Mutual Insurance Co"], state:"GA", state_name:"Georgia", filing_type:"Form", rate_impact:null, document_id:null})], role:"corpdev", ...over});

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], watch:()=>({status:200, body:WSTATUS()}), run:()=>({status:200, body:{run:{status:"ok", message:"Nothing new since the last check.", requests:1, newCount:0}, used:{hour:13,day:41}, limits:{hour:500,day:12000}, account:"trial"}}), runDelay:0,
      doc:body=>({status:200, type:"application/pdf", raw:"%PDF-1.4 made-up "+(body.documentId||body.filingVersionId)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const cors={"access-control-allow-origin":"*","access-control-expose-headers":"Content-Disposition"};
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:cors,body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-watch"){
          if(body.action==="status"){ const a=t.watch(); return a.empty ? r.fulfill({status:a.status,body:""}) : J(a.status,a.body); }
          if(body.action==="run"){ if(t.runDelay) await new Promise(res=>setTimeout(res,t.runDelay)); const a=t.run(); return J(a.status,a.body); }
          return J(400,{error:"bad",message:"Unknown action."}); }
        if(body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve") return J(200,{...copy(RESOLVE), query:body.q});
        if(body.action==="document"){ const a=t.doc(body); return r.fulfill({status:200,contentType:a.type,headers:cors,body:a.raw}); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; window.__opened=[];
      window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; },opts);
    await p.goto(BASE+"#filings"); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.wcalls=a=>t.calls.filter(c=>c.fn==="snl-watch" && c.body.action===a);
    t.saved=async()=>p.evaluate(()=>{ const r=__mock.row("snl_settings","watchlist"); return r&&r.doc; });
    t.upserts=async()=>p.evaluate(()=>__mock.log.filter(l=>l.op==="upsert" && l.id==="watchlist").length);
    return t;
  }
  const seed=doc=>({seed:[["snl_settings","watchlist",{doc}]]});

  // ----- a reader -----
  let t=await open({role:"reader", ...seed(LIST)}, {watch:()=>({status:200, body:WSTATUS({role:"reader"})})}); let p=t.p;
  ok("the watchlist sits above the search form", await p.evaluate(()=>{ const w=document.getElementById("watch"), f=document.getElementById("searchForm"); return !!w && !!f && !!(w.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); }));
  ok("status asked of the watchlist function once", t.wcalls("status").length===1 && t.wcalls("run").length===0);
  ok("a reader sees what is watched", same(await t.all("#wCos .cchip"),["Calloway Insurance Co","Calloway Group"]) && same(await t.all("#wStates .cchip"),["FL","GA"]), await t.all("#wCos .cchip"));
  ok("a reader sees that it is on and when it was last checked", (await t.txt("#wSummary"))==="On Checked every day for filings published in the last 14 days. Last checked 13 Nov at 06:23.", await t.txt("#wSummary"));
  ok("a reader sees what the last check found", (await t.txt("#wNew"))==="The last check, on 13 Nov at 06:23, found 2 new filings.", await t.txt("#wNew"));
  ok("the new filings in the usual table", (await p.$$("#watchTable tbody tr")).length===2 && (await t.txt("#watchTable tbody tr >> nth=0 >> .c-co"))==="Calloway Insurance Co" && (await t.txt('#watchTable tbody tr >> nth=0 >> td[data-label="Rate impact"]'))==="4.5%" && (await t.txt('#watchTable tbody tr >> nth=0 >> td[data-label="Tracking number"]'))==="CALL-FL-1" && (await t.txt('#watchTable tbody tr >> nth=0 >> .c-dates'))==="Submitted28 OctPublished10 NovEffective, new1 Jan 2027Effective, renewaln/d", await t.txt('#watchTable tbody tr >> nth=0 >> .c-dates'));
  ok("missing values read n/d; a filing with no document id opens by its filing version id", (await t.txt('#watchTable tbody tr >> nth=1 >> td[data-label="Rate impact"]'))==="n/d" && (await p.getAttribute('#watchTable tbody tr >> nth=1 >> [data-act="open-doc"]',"data-doc"))==="v:0D0D0D0D-0000-4000-8000-000000000002");
  ok("a reader can't manage or check now", !(await p.$('[data-act="w-manage"]')) && !(await p.$("#wCheck")) && !(await p.$('[data-act="w-co-remove"]')) && !(await p.$("#wManage")));
  await p.click('#watchTable tbody tr >> nth=0 >> button[data-act="open-doc"]'); await p.waitForTimeout(350);
  ok("Open document uses the page's document opening", same(t.calls.filter(c=>c.body.action==="document").map(c=>c.body),[{action:"document",documentId:72000001}]) && await p.evaluate(()=>window.__opened.length===1 && window.__opened[0].location.href.startsWith("blob:")));
  ok("never reads as 'no filings exist'", !/no filings|nothing (was )?found|0 filings/i.test(await t.txt("#watch")));
  ok("a reader trying to save is refused by the database, and told so", await (async()=>{ await p.evaluate(()=>{ __mock.denySettings=true; }); await p.evaluate(()=>changeWatch(l=>{ l.enabled=false; return l; },"x")); await p.waitForTimeout(150); return (await t.txt("#wErr"))==="Only Corp Dev logins can change the watchlist." && (await t.saved()).enabled===true; })());
  await p.screenshot({path:OUTDIR+"/watchlist-reader-1440.png",fullPage:false});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with found filings", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/watchlist-reader-390.png",fullPage:true});
  await t.ctx.close();

  // ----- Corp Dev, nothing watched yet: add from the search form -----
  t=await open({}, {watch:()=>({status:200, body:WSTATUS({enabled:false, watchlist:{...LIST, companies:[], states:[], enabled:false}, lastRun:null, lastCheck:null, found:[]})})}); p=t.p;
  ok("nothing watched yet: says so, and how to add", (await t.txt("#wEmpty"))==="Nothing is watched yet. Choose companies and states in the search form below, then add them here.Add the companies and states chosen below", await t.txt("#wEmpty"));
  ok("nothing watched yet: no Check now, and nothing about filings", !(await p.$("#wCheck")) && !(await p.$("#watchTable")) && !/filings? (exist|found)/i.test(await t.txt("#watch")));
  await p.click('#wEmpty [data-act="w-add"]'); await p.waitForTimeout(150);
  ok("adding with nothing chosen: says what to do, saves nothing", (await t.txt("#wErr"))==="Choose companies and states in the search form below first, then add them." && (await t.upserts())===0);
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  await p.click('#matches li >> nth=0 >> button[data-kind="companyId"]');
  await p.fill("#f_q","4000107"); await p.press("#f_q","Enter"); await p.waitForTimeout(250); await p.click('#byId button >> nth=1');
  await p.click('#states [data-s="FL"]'); await p.click('#states [data-s="TX"]');
  const stBefore=t.wcalls("status").length;
  await p.click('#wEmpty [data-act="w-add"]'); await p.waitForTimeout(300);
  ok("one click adds the chosen companies and states, and switches it on", same(await t.saved(),{enabled:true, companies:[{kind:"companyId",id:"4000001",name:"Calloway Insurance Co"},{kind:"institutionId",id:"4000107",name:""}], states:["FL","TX"], typeOfInsuranceIds:[], filingTypeIds:[], recipients:[]}), await t.saved());
  ok("says what was added", (await t.txt(".toast"))==="Added 2 companies and 2 states to the watchlist. It is switched on.", await t.txt(".toast"));
  ok("the list on the page follows, and the status is asked again", same(await t.all("#wCos .cchip b"),["Calloway Insurance Co","Institution id 4000107"]) && same(await t.all("#wStates .cchip b"),["FL","TX"]) && t.wcalls("status").length===stBefore+1, await t.all("#wCos .cchip b"));
  ok("the search form is left as it was", (await p.$$("#chips .cchip")).length===2);
  await p.click('[data-act="w-manage"]'); await p.waitForTimeout(100);
  await p.click('#wManage [data-act="w-add"]'); await p.waitForTimeout(300);
  ok("adding the same again: nothing changes, and it says so", (await t.txt(".toast"))==="Those companies and states are already watched." && (await t.upserts())===1);
  await p.click('#states [data-s="GA"]'); await p.click('#wManage [data-act="w-add"]'); await p.waitForTimeout(300);
  ok("adding again adds only what is new", (await t.txt(".toast"))==="Added 1 state to the watchlist." && same((await t.saved()).states,["FL","TX","GA"]) && (await t.saved()).companies.length===2);
  await t.ctx.close();

  // ----- Corp Dev managing a list -----
  t=await open(seed({...LIST, recipients:[]}), {watch:()=>({status:200, body:WSTATUS({emailConfigured:false})})}); p=t.p;
  ok("Corp Dev sees Manage and Check now", !!(await p.$('[data-act="w-manage"]')) && (await t.txt("#wCheck"))==="Check now");
  await p.click('[data-act="w-manage"]'); await p.waitForTimeout(100);
  ok("Manage shows remove buttons, the switch, the cost and the email box", (await p.$$('[data-act="w-co-remove"]')).length===2 && (await p.$$('[data-act="w-st-remove"]')).length===2 && (await t.txt('[data-act="w-toggle"]'))==="Switch off"
    && (await t.txt("#wCost"))==="Each check uses about 4 S&P requests (one for each batch of 10 companies, plus 2), more if S&P has many results. A check may use at most 30." && !!(await p.$("#w_recips")), await t.txt("#wCost"));
  ok("says when email isn't set up, and what an email would hold", (await t.txt("#wEmailNote"))==="Email isn't set up for the app yet (RESEND_API_KEY, README, Watchlist, step 2), so nobody is emailed. An email lists the company, state, filing type, a line of description, the tracking number and any mark of each new filing, marked ones first, with a link here. Everything shows on this page either way.");
  await p.click('[data-act="w-co-remove"][data-k="institutionId:5000001"]'); await p.waitForTimeout(300);
  ok("removing a company", same((await t.saved()).companies.map(c=>c.id),["4000001"]) && same(await t.all("#wCos .cchip b"),["Calloway Insurance Co"]) && (await t.txt(".toast"))==="Removed from the watchlist.");
  await p.click('[data-act="w-st-remove"][data-s="GA"]'); await p.waitForTimeout(300);
  ok("removing a state", same((await t.saved()).states,["FL"]) && (await t.txt(".toast"))==="GA removed from the watchlist.");
  await p.click('[data-act="w-toggle"]'); await p.waitForTimeout(300);
  ok("switching off", (await t.saved()).enabled===false && (await t.txt(".toast"))==="The watchlist is switched off." && (await t.txt("#wOff"))==="Switched off. Switch it on under Manage to check every day." && (await t.txt("#wSummary")).startsWith("Off Not being checked.") && (await t.txt('[data-act="w-toggle"]'))==="Switch on");
  await p.click('[data-act="w-toggle"]'); await p.waitForTimeout(300);
  ok("switching back on", (await t.saved()).enabled===true && !(await p.$("#wOff")) && (await t.txt(".toast"))==="The watchlist is switched on.");
  await p.fill("#w_recips","corpdev1@example.com, not-an-address"); await p.click('[data-act="w-recips-save"]'); await p.waitForTimeout(200);
  ok("a bad email address is refused before saving", (await t.txt("#wErr"))==='"not-an-address" isn\'t an email address. Separate addresses with commas.' && same((await t.saved()).recipients,[]));
  await p.fill("#w_recips","Corpdev1@Example.com; corpdev2@example.com"); await p.click('[data-act="w-recips-save"]'); await p.waitForTimeout(300);
  ok("recipients saved, cleaned", same((await t.saved()).recipients,["corpdev1@example.com","corpdev2@example.com"]) && (await t.txt(".toast"))==="Email recipients saved (2)." && (await p.inputValue("#w_recips"))==="corpdev1@example.com, corpdev2@example.com" && !(await p.$("#wErr")));
  // another Corp Dev login added a state meanwhile: a change starts from what is saved now
  await p.evaluate(()=>{ __mock.store.snl_settings.watchlist.doc.states.push("NY"); });
  await p.click('[data-act="w-toggle"]'); await p.waitForTimeout(300);
  ok("a change keeps what someone else saved meanwhile", same((await t.saved()).states,["FL","NY"]) && (await t.saved()).enabled===false);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with Manage open", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/watchlist-manage-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.screenshot({path:OUTDIR+"/watchlist-manage-1440.png",fullPage:false});
  await t.ctx.close();

  // ----- Check now -----
  t=await open(seed(LIST), {runDelay:600}); p=t.p;
  await p.click("#wCheck"); await p.waitForTimeout(200);
  ok("while a check runs: says so, and the button waits", (await t.txt("#wRunning"))==="A check is running. It asks S&P for filings published in the last 14 days. This can take a minute." && (await t.txt("#wCheck"))==="Checking…" && await p.isDisabled("#wCheck"));
  await p.waitForTimeout(700);
  ok("Check now asks the function to run, once", same(t.wcalls("run").map(c=>c.body),[{action:"run"}]));
  ok("after the check: what it found, and the requests it used", (await t.txt("#wRun"))==="Nothing new since the last check. 1 S&P request used." && !(await p.$("#wRunning")) && (await t.txt("#wCheck"))==="Check now", await t.txt("#wRun"));
  ok("after the check: the status and the usage strip are asked again", t.wcalls("status").length===2 && (await t.txt("#s_usage")).startsWith("S&P requests: 12 of 500"));
  t.run=()=>({status:200, body:{run:{status:"failed", message:"S&P's service failed (500). Try again in a few minutes. S&P reference: req-made-up-9.", requests:2}}}); t.runDelay=0;
  await p.click("#wCheck"); await p.waitForTimeout(400);
  ok("a failed check: the reason, as a problem", (await t.txt("#wRun"))==="The check didn't finish. S&P's service failed (500). Try again in a few minutes. S&P reference: req-made-up-9. 2 S&P requests used." && (await p.getAttribute("#wRun","role"))==="alert");
  t.run=()=>({status:409, body:{error:"busy", message:"A check is already running. Wait a minute, then look again."}});
  await p.click("#wCheck"); await p.waitForTimeout(400);
  ok("a check already running: said calmly", (await t.txt("#wRun"))==="A check is already running. Wait a minute, then look again." && (await p.getAttribute("#wRun","role"))==="status");
  t.run=()=>({status:200, body:{run:{status:"skipped", message:"S&P API access isn't set up yet.", requests:0}}});
  await p.click("#wCheck"); await p.waitForTimeout(400);
  ok("S&P not set up: said calmly", (await t.txt("#wRun"))==="S&P API access isn't set up yet." && (await p.getAttribute("#wRun","role"))==="status");
  await t.ctx.close();

  // ----- each state -----
  const stateOf=async(status, opts={})=>{ const x=await open({...seed(LIST), ...opts}, {watch:()=>status}); return x; };
  t=await stateOf({status:200, body:WSTATUS({configured:false, lastRun:RUN({status:"skipped", message:"S&P API access isn't set up yet.", requests:0, found:0, new_count:0}), lastCheck:null, found:[]})}); p=t.p;
  ok("S&P not set up: a calm note, the list kept, never checked", (await t.txt("#wNotSetUp"))==="Checks start once S&P API access is set up. The watchlist is kept until then." && !(await p.$("#watch [role=alert]")) && (await t.txt("#wNever"))==="The first check records the filings already there as the starting point; after that, new filings show here." && (await p.$$("#wCos .cchip")).length===2, await t.txt("#wNever"));
  await t.ctx.close();
  t=await stateOf({status:200, body:WSTATUS({lastRun:RUN({id:"run-3", status:"failed", started_at:"2026-11-13T06:23:00Z", message:"S&P didn't accept the API sign-in (401). Check SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase.", requests:1})})}); p=t.p;
  ok("last check failed: the reason, as a problem", (await t.txt("#wFailed"))==="The last check, on 13 Nov at 06:23, failed. S&P didn't accept the API sign-in (401). Check SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase." && (await p.getAttribute("#wFailed","role"))==="alert");
  ok("last check failed: earlier finds still show", (await p.$$("#watchTable tbody tr")).length===2);
  await t.ctx.close();
  t=await stateOf({status:200, body:WSTATUS({running:true})}, {role:"reader"}); p=t.p;
  ok("a check running (started by the schedule or someone else): said to everyone", (await t.txt("#wRunning")).startsWith("A check is running."));
  await t.ctx.close();
  t=await stateOf({status:200, body:WSTATUS({lastRun:RUN({new_count:0, message:"Nothing new since the last check."}), lastCheck:RUN({new_count:0}), found:[]})}); p=t.p;
  ok("nothing new: says 'Nothing new since the last check'", (await t.txt("#wNothing"))==="Nothing new since the last check on 13 Nov at 06:23." && !(await p.$("#watchTable")) && !/no filings|0 filings/i.test(await t.txt("#watch")));
  await t.ctx.close();
  t=await stateOf({status:200, body:WSTATUS({lastRun:RUN({baseline:true, found:7, new_count:0}), lastCheck:RUN({baseline:true, found:7, new_count:0}), found:[]})}); p=t.p;
  ok("after the first check: the starting point is explained", (await t.txt("#wBaseline"))==="The first check, on 13 Nov at 06:23, recorded 7 filings as the starting point. Filings that appear after it show here as new.");
  await t.ctx.close();
  t=await stateOf({status:200, body:WSTATUS({lastRun:null, lastCheck:null, found:[]})}); p=t.p;
  ok("never checked: says so", (await t.txt("#wNever"))==="Not checked yet. The first check records the filings already there as the starting point; after that, new filings show here.");
  await t.ctx.close();
  t=await stateOf({status:200, body:WSTATUS({tooBig:"The watchlist is too big to check: it needs at least 31 S&P requests. Remove at least 10 companies.", lastRun:RUN({status:"failed", message:"x"})})}); p=t.p;
  ok("too big: the reason and how to shrink it", (await t.txt("#wTooBig"))==="The watchlist is too big to check: it needs at least 31 S&P requests. Remove at least 10 companies." && !(await p.$("#wFailed")));
  await t.ctx.close();
  t=await stateOf({status:404, empty:true}); p=t.p;
  ok("the function not deployed: Corp Dev gets the missing steps and the command; the list still shows", (await t.txt("#wNoFn"))==="The daily check isn't set up yet: the watchlist function isn't deployed. Do steps 1 to 3 of the README's Watchlist section: run migration 0003, set WATCH_SECRET, then run: supabase functions deploy snl-watch --no-verify-jwt. After that, this card shows the last check and Check now works. You can choose what to watch already." && (await p.$$("#wCos .cchip")).length===2, await t.txt("#wNoFn"));
  await t.ctx.close();
  t=await stateOf({status:500, body:{error:"server", message:"The watchlist function failed: made-up fault. Try again."}}); p=t.p;
  const before=t.wcalls("status").length;
  ok("the status failing: the reason and Try again", (await t.txt("#watch .banner")).startsWith("Couldn't get the last check. The watchlist function failed: made-up fault. Try again."));
  t.watch=()=>({status:200, body:WSTATUS()});
  await p.click('#watch [data-act="w-retry"]'); await p.waitForTimeout(400);
  ok("Try again asks again", t.wcalls("status").length===before+1 && (await p.$$("#watchTable tbody tr")).length===2);
  await t.ctx.close();

  // ----- hostile text -----
  const evil='<img src=x onerror="window.__xss=1">';
  t=await open(seed({...LIST, companies:[{kind:"companyId",id:"4000001",name:"Calloway "+evil+" Co"},{kind:"companyId",id:"x<script>",name:"bad id"},"junk"], states:["FL","<b>"], recipients:["<x@y>"]}),
    {watch:()=>({status:200, body:WSTATUS({problems:["1 company was left out because "+evil], lastRun:RUN({status:"failed", message:"Made-up "+evil}), found:[FOUND(3,{companies:[evil], description:"Desc "+evil, tracking_number:evil, filing_type:evil, filing_version_id:"0D0D0D0D-0000-4000-8000-000000000003"})]})})}); p=t.p;
  ok("hostile text in the list, the problems, the reason and the found filings shows as text", (await t.txt("#wCos")).includes("Calloway "+evil+" Co") && (await t.txt("#wProblems")).includes(evil) && (await t.txt("#wFailed")).includes("Made-up "+evil) && (await t.txt("#watchTable")).includes("Desc "+evil) && !(await p.$("#watch img")) && await p.evaluate(()=>window.__xss===undefined));
  ok("unusable entries in the saved list are left out on the page too", same(await t.all("#wCos .cchip b"),["Calloway "+evil+" Co"]) && same(await t.all("#wStates .cchip b"),["FL"]));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with hostile text", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await t.ctx.close();

  // ----- many companies and many found filings -----
  const many={...LIST, companies:Array.from({length:30},(_, i)=>({kind:"companyId", id:String(4100000+i), name:`Nonesuch Insurance Co ${i+1}`}))};
  t=await open(seed(many), {watch:()=>({status:200, body:WSTATUS({watchlist:many, found:Array.from({length:8},(_, i)=>FOUND(10+i))})})}); p=t.p;
  ok("a long list shows the first 12 companies and a count of the rest", (await p.$$("#wCos .cchip")).length===12 && (await t.txt('#wCos [data-act="w-more"]'))==="and 18 more");
  await p.click('#wCos [data-act="w-more"]'); await p.waitForTimeout(100);
  ok("…and all of them on request", (await p.$$("#wCos .cchip")).length===30);
  ok("five found filings at first, then all", (await p.$$("#watchTable tbody tr")).length===5 && (await t.txt('[data-act="w-all"]'))==="Show all 8");
  await p.click('[data-act="w-all"]'); await p.waitForTimeout(100);
  ok("…all eight on request", (await p.$$("#watchTable tbody tr")).length===8);
  await p.click('[data-act="w-manage"]'); await p.waitForTimeout(100);
  ok("the cost of a long list", (await t.txt("#wCost")).startsWith("Each check uses about 5 S&P requests"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with a long list", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/watchlist-long-390.png",fullPage:true});
  await t.ctx.close();

  // ----- sign-out clears it -----
  t=await open(seed(LIST)); p=t.p;
  await p.evaluate(()=>signOut()); await p.waitForTimeout(200);
  ok("signing out clears the watchlist from the page", !(await p.$("#watch")) && await p.evaluate(()=>S.w.loaded===false && S.w.status===null));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
