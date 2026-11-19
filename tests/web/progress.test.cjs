// Progress bars (progress): the one bar the site draws wherever the reader waits. The component on its own (a
// fraction, no fraction, stopped, failed, a total that grows, never past the end, what a screen reader is told in
// each state, less motion, no bar for a short wait, the time so far, polite announcements at steps); a Filings search
// in parts (no fraction before the first part, then parts in, Stop and Carry on, a part asked for again, a part that
// fails, a search that fails, Refresh, a saved copy that opens with no bar); the Snapshot through parts; Compare and
// Programs and forms by searches; summaries made one at a time; every wait without a fraction (profile, statutory,
// Ask Claude, market, watchlist, Live and connection checks, look-ups, S&P's lists, a summary being made); the market
// sweep drawn by the same bar; the timer stopped on leaving the view and on sign-out; 1440px and 390px with no sideways
// scroll. Every company and filing is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

// ----- a made-up wide search in three parts, in the shape the function answers (as in bigsearch.test.cjs) -----
const CO=(id,name)=>({companyId:id, companyName:name, naicCompanyCode:null, institutionId:null, spStatEntityId:null});
const row=(i, o={})=>({serffFilingEntityEventId:80000000+i, trackingNumber:null, sfcNumber:"ZZB"+String(1000000+i), companyId:4000001, companyName:"Calloway Insurance Co", serffFilingStateId:i%2?"GA":"FL", serffFilingType:"Rate",
  typeOfInsurance:"Homeowners", filingStatus:"Approved", publishDate:`2026-${String(1+(i%10)).padStart(2,"0")}-0${1+(i%9)}`, overallRateImpact:null, filingDescription:null, documentId:72000000+i, filingVersionId:"V-"+i, pages:10,
  companies:[CO(4000001,"Calloway Insurance Co")], ...o});
const P=[Array.from({length:80},(_,i)=>row(i)), Array.from({length:40},(_,i)=>row(80+i)), Array.from({length:30},(_,i)=>row(120+i))];
const PARAMS={companyIds:[4000001,4000002], institutionIds:[], states:["FL","GA"], filingStatusIds:[1,2,3,4], typeOfInsuranceIds:[], filingTypeIds:[], spStatEntityIds:[], trackingNumbers:[], from:"2025-11-14", to:"2026-11-13", allStatuses:true};
function part(k, o={}){
  const n=o.parts||3, more=k<n, sofar=P.slice(0,k).reduce((a,x)=>a+x.length,0);
  return {params:PARAMS, rows:P[k-1]||[], total:sofar, requests:k*4, capped:more, byState:[], byCompany:[], notes:[],
    source:"S&P Global Market Intelligence, SNL Insurance Product Filings", fetchedAt:"2026-11-13T11:00:00Z", fromStore:!!o.fromStore, saved:!more, part:k, parts:more&&!o.fromStore?null:n, partsAbout:o.about?o.about(k):n, more, cursor:more?{run:"abc123", part:k+1}:null,
    used:{hour:12+k*4, day:40+k*4}, limits:{hour:500, day:12000}, account:"trial"};
}
const parted=(o={})=>body=>{ const k=body.cursor?body.cursor.part:1, f=o.fail&&o.fail(k); return f || {status:200, body:part(k, o)}; };

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}, hash="#filings"){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", reducedMotion:over.reducedMotion||"no-preference"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, search:parted(), resolve:null, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve"){ const d=t.resolveDelay||0; if(d) await new Promise(res=>setTimeout(res,d)); return J(200, t.resolve ? t.resolve(body) : {query:body.q, matches:[], note:"No saved company matches."}); }
        if(fn==="snl-filings" && body.action==="search"){ const d=typeof t.delay==="function"?t.delay(body):t.delay; if(d) await new Promise(res=>setTimeout(res,d)); const a=t.search(body); return J(a.status,a.body); }
        return J(503,{error:"not_configured", message:"Not set up in this test."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+hash); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.body.action===a).map(c=>c.body);
    // what a bar says to a screen reader, and how it looks: the first bar inside sel
    t.bar=async sel=>p.evaluate(s=>{ const w=document.querySelector(s); const el=w&&(w.matches(".pb")?w:w.querySelector(".pb")); if(!el) return null;
      const tr=el.querySelector('[role="progressbar"]'), fill=el.querySelector(".pb-fill"), cs=getComputedStyle(tr), fs=getComputedStyle(fill), a=n=>tr.getAttribute(n);
      return {cls:el.className, trCls:tr.className, ind:el.classList.contains("pb-ind"), label:a("aria-label"), min:a("aria-valuemin"), max:a("aria-valuemax"), now:a("aria-valuenow"), vt:a("aria-valuetext"),
        width:fill.style.width, text:(el.querySelector(".pb-text")||{textContent:""}).textContent.replace(/\s+/g," ").trim(), visible:cs.visibility==="visible", anim:fs.animationName, bg:fs.backgroundImage, color:fs.backgroundColor, border:cs.borderTopColor}; }, sel);
    // a bar drawn by the component on its own, in a box of its own on the page (render() doesn't touch it)
    t.lab=async(key, o)=>{ await p.evaluate(([k,o])=>{ let d=document.getElementById("pbLab"); if(!d){ d=document.createElement("div"); d.id="pbLab"; d.style.cssText="padding:16px;background:#fff"; document.body.appendChild(d); } d.innerHTML=pbHTML(k,o); }, [key, o]); await p.waitForTimeout(20); return t.bar("#pbLab"); };
    // two companies by S&P id, Florida and Georgia, then Search
    t.start=async()=>{ for(const id of ["4000001","4000002"]){ await p.fill("#f_q",id); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click('#byId button >> nth=0'); await p.waitForTimeout(60); }
      for(const s of ["FL","GA"]) await p.click(`#states [data-s="${s}"]`); await p.click('button[data-act="search"]'); };
    return t;
  }

  // ===== the component on its own =====
  let t=await open(); let p=t.p;
  let x=await t.lab("c1", {name:"Filings search", done:3, of:8, text:"3 of 8 parts, 6,400 filings so far."});
  ok("a fraction: a progress bar with its range and value, and the same in words", x.label==="Filings search" && x.min==="0" && x.max==="100" && x.now==="38" && x.width==="38%" && x.vt==="3 of 8 parts, 6,400 filings so far." && x.text==="3 of 8 parts, 6,400 filings so far." && !x.ind, x);
  x=await t.lab("c2", {name:"Statutory query"});
  ok("no fraction: a moving band, none of the three value attributes, and 'Working' in words", x.ind && x.min===null && x.max===null && x.now===null && x.vt==="Working" && x.anim==="pbslide" && x.width==="", x);
  await p.waitForTimeout(900); x=await t.bar("#pbLab");
  ok("…and no time is shown in the first seconds", x.text==="" && x.vt==="Working", x);
  x=await t.lab("c3", {name:"Filings search", done:1, of:3, state:"stopped", say:"The search was stopped after 1 of about 3 parts."});
  ok("stopped: stays where it got to, grey, and says Stopped in words as well as colour", x.now==="33" && x.text==="Stopped" && /pb-stopped/.test(x.cls) && x.color==="rgb(102, 102, 102)" && x.vt.startsWith("Stopped. The search was stopped after 1 of about 3 parts"), x);
  x=await t.lab("c4", {name:"Filings search", done:2, of:3, state:"failed", say:"Part 3 of about 3 couldn't be fetched."});
  ok("failed: stays where it got to, hatched magenta, says it didn't finish, never full", x.now==="67" && x.text==="Didn't finish" && /repeating-linear-gradient/.test(x.bg) && x.border==="rgb(235, 0, 140)" && x.vt.startsWith("Didn't finish."), x);
  x=await t.lab("c5", {name:"Filings search", done:3, of:3, state:"failed"});
  ok("…even a failure on the last part is not a full bar of the going colour", /pb-failed/.test(x.cls) && x.color!=="rgb(0, 83, 158)", x);
  // an estimated total that grows: held where it was, never back
  const grow=[];
  for(const [d,o] of [[2,4],[2,8],[3,8],[5,8],[7,7]]) grow.push((await t.lab("grow", {name:"Search", done:d, of:o, exact:false, text:`${d} of about ${o} parts`})).now);
  ok("an estimate that grows: the bar holds where it was and never goes back, then moves on", JSON.stringify(grow)==='["50","50","50","63","88"]', grow);
  x=await t.lab("cap1", {name:"Search", done:5, of:4, exact:false});
  ok("an estimate that is passed: below the end until the search ends", +x.now<100 && +x.now>=80, x);
  x=await t.lab("cap2", {name:"Search", done:9, of:8});
  const x2=await t.lab("cap3", {name:"Search", frac:1.7}), x3=await t.lab("cap4", {name:"Search", frac:-0.2});
  ok("never past the end, never below the start", x.now==="100" && x.width==="100%" && x2.now==="100" && x3.now==="0", [x.now, x2.now, x3.now]);
  // a short wait shows no bar: hidden for its first PB_SHOW_MS
  x=await t.lab("fresh", {name:"Search"});
  const hiddenFirst=!x.visible; await p.waitForTimeout(950); x=await t.bar("#pbLab");
  ok("a new wait's bar stays hidden for its first 800 ms, then shows", hiddenFirst && x.visible, x);
  // time so far, from 3 seconds; the timer runs only while a wait's bar is on the page
  await p.evaluate(()=>{ PB.w.fresh.t0-=3200; }); await p.waitForTimeout(1100); x=await t.bar("#pbLab");
  ok("after a few seconds the words say how long so far, once a second, and the screen reader text too", /^\d seconds so far$/.test(x.text) && /^Working, \d seconds so far$/.test(x.vt) && await p.evaluate(()=>pbTicking()), x);
  await p.evaluate(()=>{ PB.w.fresh.t0-=60000; }); await p.waitForTimeout(1100); x=await t.bar("#pbLab");
  ok("…in minutes and seconds after a minute", /^1 minute \d+ seconds so far$/.test(x.text), x.text);
  await p.evaluate(()=>{ document.getElementById("pbLab").innerHTML=""; }); await p.waitForTimeout(1200);
  ok("when the bar goes, the timer stops and the short wait is forgotten", !(await p.evaluate(()=>pbTicking())) && !(await p.evaluate(()=>"fresh" in PB.w)));
  // what a screen reader hears: one polite line, at each quarter, not at every step
  const say=await p.evaluate(async()=>{ const el=document.getElementById("pbSay"), heard=[]; const mo=new MutationObserver(()=>heard.push(el.textContent)); mo.observe(el,{childList:true,characterData:true,subtree:true});
    const lab=document.getElementById("pbLab")||document.body.appendChild(Object.assign(document.createElement("div"),{id:"pbLab"}));
    for(let d=1; d<=8; d++){ lab.innerHTML=pbHTML("q", {name:"Filings search", done:d, of:8, text:`${d} of 8 parts.`}); lab.innerHTML=pbHTML("q", {name:"Filings search", done:d, of:8, text:`${d} of 8 parts.`}); await new Promise(r=>setTimeout(r,5)); }
    lab.innerHTML=pbHTML("q", {name:"Filings search", done:3, of:8, text:"3 of 8 parts.", state:"retry", note:"Part 4 didn't come back, so it is being asked for again."});
    await new Promise(r=>setTimeout(r,5)); mo.disconnect();
    return {heard, role:el.getAttribute("role"), live:el.getAttribute("aria-live"), sr:el.className}; });
  ok("one polite line, heard at each quarter and when a part is asked again, not at every part or redraw", say.role==="status" && say.live==="polite" && say.sr==="sr" && JSON.stringify(say.heard)===JSON.stringify(["Filings search: 2 of 8 parts.","Filings search: 4 of 8 parts.","Filings search: 6 of 8 parts.","Filings search: Part 4 didn't come back, so it is being asked for again."]), say.heard);
  await p.evaluate(()=>{ document.getElementById("pbLab").innerHTML=pbHTML("long", {name:"Statutory query"}); }); await p.waitForTimeout(50);
  await p.evaluate(()=>{ PB.w.long.t0-=31000; }); await p.waitForTimeout(1150);
  ok("a long wait without a fraction is announced at 30 seconds, not every second", /^Statutory query: still working, 3\d seconds so far\.$/.test(await t.txt("#pbSay")), await t.txt("#pbSay"));
  await p.evaluate(()=>{ document.getElementById("pbLab").innerHTML=""; });
  await t.ctx.close();

  // less motion: the band stands still and still reads as working
  t=await open({}, {reducedMotion:"reduce"}); p=t.p;
  x=await t.lab("rm", {name:"Statutory query"});
  ok("less motion: no moving band, a still striped bar that reads as working", x.anim==="none" && /repeating-linear-gradient/.test(x.bg) && x.vt==="Working" && x.now===null, x);
  await t.ctx.close();

  // ===== Filings: a search in parts =====
  t=await open({}, {delay:600}); p=t.p;
  await t.start(); await p.waitForTimeout(250);
  x=await t.bar("#searching");
  ok("before the first part: a bar without a fraction, hidden while the wait is short, beside Stop", x && x.ind && x.now===null && !x.visible && x.label==="Filings search" && await p.isVisible("#searchStop"), x);
  await p.waitForTimeout(650); x=await t.bar("#searching");
  ok("after part 1 of about 3: a third, and the words beside it", x && !x.ind && x.now==="33" && x.visible && (await t.txt("#bsProg"))==="1 of about 3 parts, 80 filings so far." && x.vt==="1 of about 3 parts, 80 filings so far.", x);
  await p.screenshot({path:OUTDIR+"/progress-search-1440.png"});
  await p.locator("#searching").screenshot({path:OUTDIR+"/progress-search-banner-1440.png"});
  await p.waitForTimeout(600); x=await t.bar("#searching");
  ok("after part 2: two thirds", x && x.now==="67" && (await t.txt("#bsProg"))==="2 of about 3 parts, 120 filings so far.", x);
  ok("the timer runs while the search does", await p.evaluate(()=>pbTicking()));
  await p.waitForTimeout(800);
  ok("finished: the bar goes with the wait, the result takes its place, the timer stops", !(await p.$("#results .pb")) && (await t.txt("#resSummary")).startsWith("150 filings") && !(await p.evaluate(()=>pbTicking())));
  // Refresh: the same bar beside "Asking S&P again"
  await p.evaluate(()=>{ runSearch(true); }); await p.waitForTimeout(150);
  x=await t.bar("#refreshing");
  ok("Refresh: a bar beside 'Asking S&P again', with the old result below", !!x && (await t.txt("#refreshing")).startsWith("Asking S&P again…") && !!(await p.$("#resSummary")), [x, await t.txt("#results")]);
  await p.waitForTimeout(2200);
  await t.ctx.close();

  // a search in one part: no fraction at any time, gone when it is done
  t=await open({}, {delay:1200, search:parted({parts:1})}); p=t.p;
  await t.start(); await p.waitForTimeout(1000); x=await t.bar("#searching");
  ok("a search in one part: a moving bar only, shown once it has lasted a moment", x && x.ind && x.now===null && x.visible, x);
  await p.waitForTimeout(600);
  ok("…and gone with the result", !(await p.$("#results .pb")) && !!(await p.$("#resSummary")));
  await t.ctx.close();

  // a saved copy that opens at once: no bar ever shows
  t=await open({}, {delay:60, search:parted({parts:1, fromStore:true})}); p=t.p;
  await p.evaluate(()=>{ window.__seen=false; const look=()=>{ for(const e of document.querySelectorAll(".pb-track")) if(getComputedStyle(e).visibility==="visible") window.__seen=true; requestAnimationFrame(look); }; requestAnimationFrame(look); });
  await t.start(); await p.waitForTimeout(500);
  ok("a result from a saved copy: no bar flashes up", !(await p.evaluate(()=>window.__seen)) && (await t.txt("#fromStore")).startsWith("From the last fetch"), await p.evaluate(()=>window.__seen));
  await t.ctx.close();

  // Stop: the bar stays where it was, stopped, with Carry on; Carry on picks it up again
  t=await open({}, {delay:b=>b.cursor&&b.cursor.part===2?1500:100}); p=t.p;
  await t.start(); await p.waitForTimeout(500); await p.click("#searchStop"); await p.waitForTimeout(200);
  x=await t.bar("#incomplete");
  ok("Stop: a stopped bar at 1 of about 3 parts, in words as well as grey, beside Carry on", x && x.now==="33" && /pb-stopped/.test(x.cls) && x.text==="Stopped" && x.visible && x.vt.startsWith("Stopped. The search was stopped after 1 of about 3 parts") && (await t.txt("#searchResume"))==="Carry on", x);
  ok("…and no timer is left running", !(await p.evaluate(()=>pbTicking())));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(80);
  ok("phone: the stopped bar fits, no sideways scroll", await t.noScroll());
  await p.locator("#incomplete").screenshot({path:OUTDIR+"/progress-stopped-390.png"});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(1500);
  t.delay=700; await p.click("#searchResume"); await p.waitForTimeout(250);
  x=await t.bar("#refreshing");
  ok("Carry on: the bar starts again from where it stopped", x && x.now==="33" && (await t.txt("#refreshing")).startsWith("Carrying on with the search…"), x);
  await p.waitForTimeout(1700);
  ok("…and goes when the search is whole", !(await p.$("#results .pb")) && (await t.txt("#resSummary")).startsWith("150 filings"));
  await t.ctx.close();

  // a part asked for again: said beside the bar while it waits, then the search finishes
  let once=0;
  t=await open({}, {delay:150, search:parted({fail:k=>k===2&&once++<1 ? {status:503, body:{error:"server", message:"Made-up fault."}} : null})}); p=t.p;
  await t.start(); await p.waitForTimeout(1000);
  x=await t.bar("#searching");
  ok("a part asked for again: the bar stays at what is in, and says which part is asked again", x && x.now==="33" && /pb-retry/.test(x.cls) && (await t.txt("#bsRetry"))==="Part 2 didn't come back, so it is being asked for again." && x.vt.includes("Part 2 didn't come back"), x);
  await p.waitForTimeout(1500);
  ok("…then it finishes and nothing more is said", !(await p.$("#results .pb")) && (await t.txt("#resSummary")).startsWith("150 filings") && !(await p.$("#incomplete")));
  await t.ctx.close();
  once=0;
  t=await open({}, {delay:150, search:b=>once++<1 ? {status:503, body:{error:"server", message:"Made-up fault."}} : parted({parts:1})(b)}); p=t.p;
  await t.start(); await p.waitForTimeout(700);
  ok("the first answer asked for again: said without a part number", (await t.txt("#bsRetry"))==="The answer didn't come back, so it is being asked for again.", await t.txt("#searching"));
  await p.waitForTimeout(1500);
  await t.ctx.close();

  // a part that fails twice: the bar stops there, marked as not finished, never full
  let fails=0;
  t=await open({}, {search:parted({fail:k=>k===3&&fails++<2 ? {status:502, body:{error:"spgmi_server", message:"S&P had a problem answering. Try again in a few minutes."}} : null})}); p=t.p;
  await t.start(); await p.waitForTimeout(2700);
  x=await t.bar("#incomplete");
  ok("a failed part: a hatched bar at 2 of about 3 parts that says it didn't finish, beside the message and Try again", x && x.now==="67" && /pb-failed/.test(x.cls) && x.text==="Didn't finish" && (await t.txt("#incomplete")).startsWith("Not all of the search came back.") && (await t.txt("#searchResume"))==="Try again", x);
  await t.ctx.close();
  // a search that fails as a whole: the failure message, no bar
  t=await open({}, {search:()=>({status:400, body:{error:"spgmi_bad_request", message:"This search needs at least 70 S&P requests, more than the 60 one search may use."}})}); p=t.p;
  await t.start(); await p.waitForTimeout(500);
  ok("a search that fails: the message shows and no bar is left", (await t.txt("#results .banner")).startsWith("Couldn't run the search.") && !(await p.$("#results .pb")) && !(await p.evaluate(()=>pbTicking())));
  await t.ctx.close();

  // ===== the timer stops when the reader leaves the view and on sign-out; the wait's time carries on =====
  t=await open({}, {delay:9000, search:parted({parts:1})}); p=t.p;
  await t.start(); await p.waitForTimeout(300);
  ok("a search running: the timer runs", await p.evaluate(()=>pbTicking()));
  await p.evaluate(()=>{ location.hash="#statutory"; }); await p.waitForTimeout(200);
  ok("leaving the view stops the timer", !(await p.evaluate(()=>pbTicking())));
  await p.waitForTimeout(3000);
  await p.evaluate(()=>{ location.hash="#filings"; }); await p.waitForTimeout(1200);
  x=await t.bar("#searching");
  ok("coming back: the timer runs again, the bar shows at once and the time counts from when the search started", await p.evaluate(()=>pbTicking()) && x.visible && /^[45] seconds so far$/.test(x.text), x);
  await p.click("#signoutBtn"); await p.waitForTimeout(300);
  ok("signing out stops the timer and forgets every wait", !(await p.evaluate(()=>pbTicking())) && await p.evaluate(()=>Object.keys(PB.w).length===0));
  await t.ctx.close();

  // ===== Snapshot: through parts =====
  t=await open({}, {delay:300}, "#snapshot"); p=t.p;
  await p.evaluate(()=>{ S.snap.pick={kind:"company", name:"Calloway Insurance Co", group:"", ids:[{kind:"companyId", id:"4000001", name:"Calloway Insurance Co"}], noId:0, cut:false}; render(); });
  await p.click("#sn_run"); await p.waitForTimeout(150);
  x=await t.bar("#snBusy");
  ok("Snapshot: no fraction before the first part, and the wording as it was", x && x.ind && (await t.txt("#snBusy"))==="Getting Calloway Insurance Co's filings… A long period can take a minute. After that the result is saved, so it opens at once next time.", await t.txt("#snBusy"));
  await p.waitForTimeout(350); x=await t.bar("#snBusy");
  ok("…then parts in, as a fraction", x && x.now==="33" && (await t.txt("#snBusy #bsProg"))==="1 of about 3 parts, 80 filings so far." && x.label==="Snapshot search", x);
  await p.waitForTimeout(900);
  ok("…gone when the snapshot shows", !(await p.$("#view .pb")) && await p.evaluate(()=>S.snap.res&&S.snap.res.rows.length===150));
  await t.ctx.close();

  // ===== Compare and Programs and forms: searches done of searches planned, plus the share of parts in =====
  t=await open(); p=t.p;
  const cmp=async(step, prog, n)=>{ await p.evaluate(([step,prog,n])=>{ let d=document.getElementById("pbLab"); if(!d){ d=document.createElement("div"); d.id="pbLab"; document.body.appendChild(d); }
    d.innerHTML=cmpProgressHTML({parts:Array.from({length:n},(_,i)=>({payload:{companyIds:[4000001+i], institutionIds:[]}, state:step&&i<step.at-1?"ok":step&&i===step.at-1?"running":"wait"})), step, prog}); }, [step, prog, n]); await p.waitForTimeout(20); return t.bar("#pbLab"); };
  x=await cmp({at:1, of:3}, null, 3);
  ok("Compare: search 1 of 3, nothing in yet: an empty bar with a fraction", x.now==="0" && x.label==="Comparison" && (await t.txt("#cmBusy")).startsWith("Searching 1 of 3…"), x);
  x=await cmp({at:2, of:3}, {done:1, of:2, exact:true, filings:40}, 3);
  ok("Compare: search 2 of 3 with 1 of its 2 parts in: half way", x.now==="50" && (await t.txt("#bsProg"))==="1 of 2 parts, 40 filings so far.", x);
  x=await cmp({at:3, of:3}, null, 3);
  ok("Compare: search 3 of 3 starting: two thirds", x.now==="67", x);
  x=await cmp({at:1, of:1}, null, 1);
  ok("Compare: one search of unknown length: no fraction, the time instead", x.ind && x.now===null, x);
  await p.evaluate(()=>pbStart("cmp"));   // a new comparison
  x=await cmp({at:1, of:1}, {done:1, of:4, exact:false, filings:2000}, 1);
  ok("Compare: one search in parts: by parts", x.now==="25" && (await t.txt("#bsProg"))==="1 of about 4 parts, 2,000 filings so far.", x);
  // Programs and forms draws its searches with the same helper as its view: bsBarHTML("fc", prog, name, {at, of})
  const fcb=async(step, prog)=>{ await p.evaluate(([s,pr])=>{ document.getElementById("pbLab").innerHTML=`<div class="info" id="fcLab">${bsBarHTML("fc", pr, "Finding the filings", s)}</div>`; }, [step, prog]); await p.waitForTimeout(20); return t.bar("#fcLab"); };
  x=await fcb({at:2, of:4}, null);
  ok("Programs and forms: search 2 of 4: a quarter", x.now==="25" && x.label==="Finding the filings", x);
  x=await fcb(null, null);
  ok("Programs and forms: one search: no fraction", x.ind, x);
  // the views themselves draw these bars
  ok("the Compare and Programs and forms views draw the bar in their busy lines", await p.evaluate(()=>/bsBarHTML\("cmp"/.test(cmpProgressHTML.toString()) && /bsBarHTML\("fc"/.test(fcOutHTML.toString())));
  await t.ctx.close();

  // ===== summaries made one at a time (Programs and forms, and the filings profile) =====
  t=await open(); p=t.p;
  const mkBanner=async(fn, i, n, stop)=>{ await p.evaluate(([fn,i,n,stop])=>{ const mk={busy:true, stop, i, n, cur:null, items:[]}; let d=document.getElementById("pbLab"); if(!d){ d=document.createElement("div"); d.id="pbLab"; document.body.appendChild(d); }
    d.innerHTML=pbHTML(fn, {name:"Summaries", done:Math.max(0, mk.i-1), of:mk.n, say:`${Math.max(0, mk.i-1)} of ${mk.n} summaries done`}); }, [fn,i,n,stop]); await p.waitForTimeout(20); return t.bar("#pbLab"); };
  x=await mkBanner("fc-make", 1, 4, false);
  ok("summaries: the first of 4 being made: none done yet", x.now==="0" && x.vt==="0 of 4 summaries done" && x.text==="", x);
  x=await mkBanner("fc-make", 3, 4, false);
  ok("summaries: the third of 4 being made: half done", x.now==="50" && x.vt==="2 of 4 summaries done", x);
  ok("both summary banners (Programs and forms, filings profile) draw this bar beside Stop", (fs.readFileSync(WEB+"/index.html","utf8").match(/Stopping after this one…":"Stop"\}<\/button>\$\{pbHTML\("f[cp]-make", \{name:"Summaries", done:Math\.max\(0, mk\.i-1\), of:mk\.n/g)||[]).length===2);
  await t.ctx.close();

  // ===== every wait without a fraction, in its view =====
  t=await open(); p=t.p;
  const ind=async(sel, setup, hash)=>{ if(hash){ await p.evaluate(h=>{ location.hash=h; }, hash); await p.waitForTimeout(250); } await p.evaluate(setup); await p.waitForTimeout(40); return t.bar(sel); };
  const isInd=(x,label)=>!!x && x.ind && x.now===null && x.min===null && x.label===label;
  x=await ind("#connBusy", ()=>{ S.conn={busy:true}; pbStart("conn"); render(); });
  ok("connection check: a moving bar under what it does", isInd(x,"Connection check") && (await t.txt("#connBusy")).startsWith("Checking the S&P connection."), x);
  await p.evaluate(()=>{ S.conn=null; render(); });
  x=await ind("#livePanel", ()=>{ S.live={busy:true}; pbStart("live"); render(); });
  ok("Live check: a moving bar", isInd(x,"Live check"), x);
  await p.evaluate(()=>{ S.live=null; render(); });
  x=await ind("#searchForm", ()=>{ S.f.resolving=true; render(); });
  ok("a company look-up: a small moving bar beside 'Looking for the company…'", isInd(x,"Looking up companies") && /\bsm\b/.test(x.cls), x);
  await p.evaluate(()=>{ S.f.resolving=false; S.refsLoading=true; render(); }); x=await t.bar('[data-pb="refs"]');
  ok("S&P's lists loading: a small moving bar beside Refresh lists", isInd(x,"Loading S&P's lists"), x);
  await p.evaluate(()=>{ S.refsLoading=false; render(); });
  x=await ind("#dgDrawer", ()=>{ dgOf().dr={key:"d:72000001", row:{documentId:72000001}, making:true}; pbStart("dg-make"); render(); });
  ok("a summary being made: a moving bar in the drawer", isInd(x,"Making the summary") && (await t.txt("#dgMaking")).startsWith("Claude is reading the filing."), x);
  await p.evaluate(()=>{ dgOf().dr=null; render(); });
  x=await ind("#view", ()=>{ S.st.status={configured:true, mapped:true, fields:[]}; S.st.busy=true; S.st.res=null; pbStart("stat"); render(); }, "#statutory");
  ok("Statutory: a moving bar while Snowflake answers", isInd(x,"Statutory query"), x);
  await p.evaluate(()=>{ S.st.busy=false; render(); });
  x=await ind(".ccmsg.a.run", ()=>{ S.ask.open=true; S.ask.turns.push({question:"What changed?", told:"", status:"running", progress:[{text:"Searching filings", at:"2026-11-13T12:00:00Z"}], partial:"", result:null, error:"", calm:false, jobId:"j1", lastContinue:0, note:"", contNote:"", t0:performance.now()-4000}); renderAsk(); }, "#filings");
  await p.waitForTimeout(1100); x=await t.bar(".ccmsg.a.run");
  ok("Ask Claude: a moving bar under the steps, with the time since the question was asked", isInd(x,"Claude's answer") && /^[45] seconds so far$/.test(x.text), x);
  await p.evaluate(()=>{ S.ask.turns[0].t0=undefined; renderAsk(); }); await p.waitForTimeout(1100); x=await t.bar(".ccmsg.a.run");
  ok("…an answer picked up after a reload: no time, since the page didn't see it start", isInd(x,"Claude's answer") && x.text==="", x);
  await p.evaluate(()=>{ S.ask.turns=[]; S.ask.open=false; renderAsk(); });
  x=await ind("#view", ()=>{ S.w.loaded=true; S.w.checking=true; pbStart("watch"); render(); });
  x=await t.bar("#wRunning");
  ok("watchlist Check now: a moving bar under 'A check is running'", isInd(x,"Watchlist check") && (await t.txt("#wRunning")).startsWith("A check is running."), [x, await t.txt("#watch")]);
  await p.evaluate(()=>{ S.w.checking=false; render(); });
  // the view functions themselves, each with its wait set, drawn into a box of their own
  const view=async(fn, setup)=>{ await p.evaluate(([fn, setup])=>{ (new Function(setup))(); let d=document.getElementById("pbLab"); if(!d){ d=document.createElement("div"); d.id="pbLab"; document.body.appendChild(d); } d.innerHTML=window[fn](); }, [fn, setup]); await p.waitForTimeout(20); return t.bar("#pbLab"); };
  const waits=[
    ["pfOutHTML", 'S.pf.busy="facts"; S.pf.asked={kind:"company", code:"10001", name:"Calloway Insurance Co"}; pbStart("pf-facts");', "Getting the figures", "#pfBusy"],
    ["pfOutHTML", 'S.pf.busy="sample"; S.pf.asked=null; pbStart("pf-sample");', "Getting the sample figures", "#pfBusy"],
    ["fpOutHTML", 'S.pf.busy=""; S.pf.fp.busy="facts"; S.pf.fp.asked={pick:{name:"Calloway Group"}, years:3}; pbStart("fp-facts");', "Getting the filings", "#fpBusy"],
    ["fpOutHTML", 'S.pf.fp.busy="sample"; S.pf.fp.asked=null; pbStart("fp-sample");', "Getting the sample filings", "#fpBusy"],
    ["mkResultsHTML", 'S.pf.fp.busy=""; S.mk.busy=true; S.mk.res=null; pbStart("mk-search");', "Market index search", "#mkSearching"],
    ["setupHTML", 'S.mk.busy=false; S.st.setup.view="PREMIUMS"; S.st.setup.colsBusy=true;', "Listing the columns", "#setup"]];
  for(const [fn, setup, label, sel] of waits){ x=await view(fn, setup); ok(`${label}: a moving bar in its own line`, isInd(x, label) && !!(await p.$("#pbLab "+sel)), [label, x]); }
  await p.evaluate(()=>{ S.st.setup.colsBusy=false; S.st.setup.viewsBusy=true; });
  x=await view("setupHTML", "");
  ok("Listing the views: a small moving bar beside the button", isInd(x, "Listing the views"), x);
  await p.evaluate(()=>{ S.st.setup.viewsBusy=false; document.getElementById("pbLab").innerHTML=""; });
  ok("Claude's draft, building the file and working out the figures again draw the same moving bar (in the result's own lines)", ["pf-draft","pf-build","fp-draft","fp-build","fp-refresh"].every(k=>fs.readFileSync(WEB+"/index.html","utf8").includes(`pbHTML("${k}", {name:`)));
  await t.ctx.close();

  // ===== the market sweep: the same bar =====
  t=await open(); p=t.p;
  const sweep=async o=>{ await p.evaluate(o=>{ let d=document.getElementById("pbLab"); if(!d){ d=document.createElement("div"); d.id="pbLab"; document.body.appendChild(d); } d.innerHTML=mkOpenHTML({kind:"sweep", state:"TX", from_date:"2025-11-19", to_date:"2026-11-18", next_unit:12, units_total:30, requests:40, rows_found:900, companiesMissed:0, ...o}); }, o); await p.waitForTimeout(20); return t.bar("#mkOpen"); };
  x=await sweep({status:"running", percent:40});
  ok("sweep: the site's one bar, filled to the batches done, shown at once (no wait to hide)", x.now==="40" && x.label==="Sweep progress" && /mkbar/.test(x.trCls) && x.visible && x.vt==="12 of 30 batches of companies (40%)", x);
  x=await sweep({status:"held", percent:40});
  ok("sweep paused: the stopped bar, with the status in words beside it", /pb-stopped/.test(x.cls) && x.now==="40" && (await t.txt("#mkOpenStatus"))==="Paused", x);
  x=await sweep({status:"failed", percent:55});
  ok("sweep failed: the failed bar, never full", /pb-failed/.test(x.cls) && x.now==="55", x);
  ok("one bar on the site: the old sweep bar's own styles are gone", !/\.mkbar\{/.test(fs.readFileSync(WEB+"/index.html","utf8")));
  await t.ctx.close();

  // ===== 1440px and 390px: no sideways scroll; pictures of each kind of bar in each state =====
  for(const width of [1440, 390]){
    t=await open({}, {width}); p=t.p;
    await p.evaluate(()=>{ const d=document.createElement("div"); d.id="pbGallery"; d.style.cssText="padding:16px;display:flex;flex-direction:column;gap:12px;background:#fff";
      const row=(title, html)=>`<div><p class="t2" style="margin:0 0 4px">${title}</p>${html}</div>`;
      d.innerHTML=[
        row("Searching, nothing known yet (moving band)", `<div class="banner" role="status"><span>Searching S&amp;P's filings… A long date range can take a minute.</span><button class="btn sm">Stop</button>${pbHTML("g1",{name:"Filings search"})}</div>`),
        row("A search in parts, about 8 parts", `<div class="banner" role="status"><span>Searching S&amp;P's filings… A long date range can take a minute.</span><button class="btn sm">Stop</button>${pbHTML("g2",{name:"Filings search", done:3, of:8, exact:false, text:"3 of about 8 parts, 6,400 filings so far."})}</div>`),
        row("A part asked for again", `<div class="banner" role="status"><span>Searching S&amp;P's filings…</span>${pbHTML("g3",{name:"Filings search", done:3, of:8, exact:false, state:"retry", text:"3 of about 8 parts, 6,400 filings so far.", note:"Part 4 didn't come back, so it is being asked for again."})}</div>`),
        row("Stopped by the reader", `<div class="banner" role="alert"><span><b>You stopped the search.</b> The search was stopped after 3 of about 8 parts, so these results are incomplete.</span><button class="btn sm">Carry on</button>${pbHTML("g4",{name:"Filings search", now:true, done:3, of:8, state:"stopped"})}</div>`),
        row("Failed", `<div class="banner" role="alert"><span><b>Not all of the search came back.</b> Part 4 of about 8 couldn't be fetched.</span><button class="btn sm">Try again</button>${pbHTML("g5",{name:"Filings search", now:true, done:3, of:8, state:"failed"})}</div>`),
        row("Summaries, one at a time", `<div class="banner" role="status"><span><b>Summarising 3 of 5:</b> S&amp;P no. ZZB1000003 (Calloway Home Co)… Each takes a minute or two.</span><button class="btn sm">Stop</button>${pbHTML("g6",{name:"Summaries", done:2, of:5})}</div>`),
        row("One call that takes a while, after 12 seconds", `<div class="info" role="status"><span><b>Claude is drafting the slide text…</b> This can take up to two minutes.</span>${pbHTML("g7",{name:"Claude's draft", t0:performance.now()-12400})}</div>`),
        row("Market sweep", `<div class="mkopen">${pbHTML("g8",{name:"Sweep progress", now:true, frac:0.4, cls:"mkbar"})}<p class="t2" style="margin:0">12 of 30 batches of companies (40%), 40 S&amp;P requests so far.</p></div>`),
        row("A look-up", `<p class="t2">Looking for matches…${pbHTML("g9",{name:"Looking up companies", small:true})}</p>`)
      ].join(""); document.getElementById("view").prepend(d); });
    await p.waitForTimeout(1300);
    ok(`${width}px: the gallery of bars fits with no sideways scroll`, await t.noScroll());
    if(width<500) ok("390px: the words go under the bar", await p.evaluate(()=>{ const pb=document.querySelector('[data-pb="g2"]'), tr=pb.querySelector(".pb-track"), tx=pb.querySelector(".pb-text"); return tx.getBoundingClientRect().top>=tr.getBoundingClientRect().bottom-1; }));
    else ok("1440px: the words sit beside the bar", await p.evaluate(()=>{ const pb=document.querySelector('[data-pb="g2"]'), tr=pb.querySelector(".pb-track"), tx=pb.querySelector(".pb-text"); return tx.getBoundingClientRect().left>tr.getBoundingClientRect().right; }));
    await p.locator("#pbGallery").screenshot({path:OUTDIR+`/progress-bars-${width}.png`, animations:"disabled"});
    await p.evaluate(()=>document.getElementById("pbGallery").remove());
    t.delay=900; await t.start(); await p.waitForTimeout(1300);
    ok(`${width}px: a search in parts mid-way, no sideways scroll`, await t.noScroll() && (await t.bar("#searching")).now==="33");
    await p.locator("#searching").screenshot({path:OUTDIR+`/progress-search-${width}.png`});
    await p.waitForTimeout(2200);
    await t.ctx.close();
  }

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
