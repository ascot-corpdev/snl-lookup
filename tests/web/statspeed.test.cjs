// Statutory figures that come in over several calls (stat-speed): when an answer says some figures are still pending,
// the Statutory view and the profile's Get figures show what arrived and ask again by themselves (the same body, never
// refresh after the first call) while each call brings more, up to six calls, with the shared progress bar ("12 of 18
// figures") and Stop. When a call brings nothing new they stop and say so, with Carry on. A complete first answer
// behaves as before. No sideways scroll at 390px. Every company, code and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), ANSWER=FIX("profilepage_answer.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const FAKE_SLIDES=`window.SNLProfile={plan:f=>[{id:"cover",label:"Cover",included:true,reason:""}], spec:(f,t)=>({fileName:"x.pptx", slides:[]})};`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const NOT_RUN="Not run: the query ran out of time. Run it again, or ask for fewer fields.";

/* A statutory answer with the first `left` mapped figures... no: with the LAST `pending` mapped figures not run yet. */
function statAnswer(pending, over={}){
  const q={...copy(STAT.query), fromStore:false, saved:pending===0, pending, fetchedAt:"2026-11-13T11:59:00Z", ...over};
  const mapped=q.fields.filter(f=>f.mapped!==false);
  for(const f of mapped.slice(mapped.length-pending)){ f.error=NOT_RUN; f.rows=[]; }
  return q;
}
/* An answer with n mapped figures, of which pending are still to come (for the six-call limit). */
function manyAnswer(n, pending){
  const fields=Array.from({length:n},(_,i)=>({id:"surplus", label:`Figure ${i+1}`, unit:"usd", by:"year", mapped:true, error:i>=n-pending?NOT_RUN:null, rows:i>=n-pending?[]:[{code:"90001", year:2025, line:null, state:null, value:1e6}]}));
  return {...copy(STAT.query), fields, pending, fromStore:false, saved:pending===0};
}
const FACTS=ANSWER.facts, TEXT=ANSWER.text;
function pfAnswer(pending){
  const facts=copy(FACTS);
  if(pending) facts.missing=[...facts.missing, {field:"surplus", label:"Policyholder surplus", reason:NOT_RUN}, {field:"net_income", label:"Net income", reason:NOT_RUN}].slice(0, facts.missing.length+pending);
  return pending ? {facts, text:copy(TEXT), pending, figures:{done:18-pending, of:18}} : {facts, text:copy(TEXT)};
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, query:()=>({status:200, body:statAnswer(0)}), facts:()=>({status:200, body:pfAnswer(0)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev", statutory:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2, resetsAt:"2026-11-14T00:00:00Z"});
        if(fn==="snl-statutory"){ if(body.action==="status") return J(200, copy(STAT.statusMapped));
          if(body.action==="query"){ const n=t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query").length; if(t.delay) await new Promise(res=>setTimeout(res,typeof t.delay==="function"?t.delay(n):t.delay)); const a=t.query(body, n); return J(a.status, a.body); } }
        if(fn==="snl-profile"){ if(body.action==="status") return J(200,{statutory:{configured:true, mapped:true, fields:[]}, claude:{configured:false}, filings:{configured:true}});
          if(body.action==="facts"){ const n=t.calls.filter(c=>c.fn==="snl-profile"&&c.body.action==="facts").length; if(t.delay) await new Promise(res=>setTimeout(res,typeof t.delay==="function"?t.delay(n):t.delay)); const a=t.facts(body, n); return J(a.status, a.body); } }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===JSZIP_URL) return r.fulfill({contentType:"application/javascript",body:'window.JSZip=function(){};'});
      if(u===BASE+"deck.js") return r.fulfill({contentType:"application/javascript",body:'window.SNLDeck={inspect:async()=>({ok:true}),build:async()=>new Uint8Array(1)};'});
      if(u===BASE+"profile-slides.js") return r.fulfill({contentType:"application/javascript",body:FAKE_SLIDES});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(()=>{ window.__opts={}; });
    await p.goto(BASE+(over.hash||"#statutory")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.queries=()=>t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query").map(c=>c.body);
    t.facts_=()=>t.calls.filter(c=>c.fn==="snl-profile"&&c.body.action==="facts").map(c=>c.body);
    t.run=async codes=>{ await p.fill("#st_codes",codes); await p.click('button[data-act="stat-search"]'); };
    t.bar=async sel=>p.$eval(sel+' [role="progressbar"]',e=>({now:e.getAttribute("aria-valuenow"), text:e.getAttribute("aria-valuetext"), label:e.getAttribute("aria-label")})).catch(()=>null);
    t.until=async (cond, ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await cond()) return true; await p.waitForTimeout(40); } return false; };
    return t;
  }
  const BODY={action:"query", kind:"company", codes:["90001","90002"], fromYear:2021, toYear:2025};

  // ----- Statutory: a complete first answer behaves exactly as before -----
  let t=await open(); let p=t.p;
  await t.run("90001, 90002"); await p.waitForTimeout(500);
  ok("a complete first answer: one call, no carrying on, no bar left behind", same(t.queries(),[BODY]) && !(await p.$("#statCarry")) && !(await p.$("#statPending")) && !(await p.$("#statStop")) && !(await p.$('#view [role="progressbar"]')), t.queries());
  ok("and its figures show as before", (await p.$$(".statblk table")).length===4 && !(await p.$(".statpend")));
  await t.ctx.close();

  // ----- Statutory: carries on by itself while each call brings more -----
  t=await open({delay:350, query:(body,n)=>({status:200, body:statAnswer(n===1?3:n===2?1:0)})}); p=t.p;
  await t.run("90001, 90002");
  ok("the first call: fetching, no fraction yet", await t.until(async()=>(await t.txt("#view")).includes("Fetching statutory data from Snowflake")));
  ok("after it, what arrived is shown and the rest is asked for at once, with a bar of figures", await t.until(async()=>!!(await p.$("#statCarry"))) && (await t.txt("#statCarry")).startsWith("Getting the rest of the figures… 3 of 6 figures so far. The ones that came back are shown below and kept."), await t.txt("#statCarry"));
  let bar=await t.bar("#statCarry");
  ok("the bar says how far it has got, as a fraction", bar && bar.now==="50" && bar.text==="3 of 6 figures" && bar.label==="Statutory figures", bar);
  ok("figures that arrived are on the page while the rest come", (await p.$$(".statblk table")).length>=2 && (await t.txt('.statblk[data-field="combined_ratio"] .statpend'))==="Still to come: it is being asked for again now.", await t.txt('.statblk[data-field="combined_ratio"]'));
  ok("Stop is offered while it carries on", await p.isVisible("#statStop"));
  await p.screenshot({path:OUTDIR+"/statspeed-carry-1440.png",fullPage:true});
  ok("then 5 of 6", await t.until(async()=>(await t.txt("#statCarry")).includes("5 of 6 figures so far")));
  ok("and it finishes on its own after three calls", await t.until(async()=>t.queries().length===3 && !(await p.$("#statCarry"))) && !(await p.$("#statPending")) && !(await p.$(".statpend")), t.queries().length);
  ok("each call is the same question, never refresh", same(t.queries(),[BODY,BODY,BODY]));
  ok("every figure is there at the end", (await p.$$(".statblk table")).length===4);
  await t.ctx.close();

  // ----- Statutory: a call that brings nothing new stops, and says so -----
  t=await open({delay:150, query:(body,n)=>({status:200, body:statAnswer(n<=2?3:0)})}); p=t.p;
  await t.run("90001, 90002");
  ok("a second call that brings no more figures stops it: two calls, no third", await t.until(async()=>!!(await p.$("#statPending"))) && (await p.waitForTimeout(500), t.queries().length===2), t.queries().length);
  ok("it says plainly that some figures didn't arrive, and offers Carry on", (await t.txt("#statPending")).startsWith("Some figures didn't arrive. 3 of 6 figures didn't come back in time, so they show as not fetched below. Carry on to ask for them again: the figures that arrived are kept, so it carries on from where it stopped.")
    && (await t.txt("#statPendingCarry"))==="Carry on" && (await p.getAttribute("#statPending","role"))==="alert", await t.txt("#statPending"));
  bar=await t.bar("#statPending");
  ok("its bar stays where it got to, marked as not finished", bar && bar.now==="50" && /^Stopped\./.test(bar.text), bar);
  ok("each figure still to come says so, calmly", (await t.txt('.statblk[data-field="combined_ratio"] .statpend'))==="Not fetched yet: it didn't come back in time. Carry on above to ask for it again." && !(await p.$('.statblk[data-field="combined_ratio"] .err')));
  await p.screenshot({path:OUTDIR+"/statspeed-pending-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with figures still to come", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/statspeed-pending-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);
  await p.click("#statPendingCarry");
  ok("Carry on asks the same question again, and it completes", await t.until(async()=>t.queries().length===3 && !(await p.$("#statPending")) && !(await p.$("#statCarry"))) && same(t.queries()[2], BODY) && (await p.$$(".statblk table")).length===4, t.queries());
  await t.ctx.close();

  // ----- Statutory: at most six calls -----
  t=await open({query:(body,n)=>({status:200, body:manyAnswer(12, 12-n)})}); p=t.p;
  await t.run("90001, 90002");
  ok("while each call brings a figure, it asks at most six times, then stops and offers Carry on", await t.until(async()=>!!(await p.$("#statPending"))) && (await p.waitForTimeout(400), t.queries().length===6) && (await t.txt("#statPending")).includes("6 of 12 figures didn't come back in time"), { n:t.queries().length, text:await t.txt("#statPending") });
  await t.ctx.close();

  // ----- Statutory: Stop -----
  t=await open({delay:n=>n===1?50:1200, query:(body,n)=>({status:200, body:statAnswer(n===1?3:0)})}); p=t.p;
  await t.run("90001, 90002");
  ok("Stop is there while the rest is asked for", await t.until(async()=>!!(await p.$("#statStop"))));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("phone: no sideways scroll while it carries on", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/statspeed-carry-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.click("#statStop"); await p.waitForTimeout(150);
  ok("Stop ends it at once: what arrived stays, and it says you stopped, with Carry on", (await t.txt("#statPending")).startsWith("You stopped getting the figures. 3 of 6 figures weren't fetched") && !(await p.$("#statCarry")) && (await p.$$(".statblk table")).length===2, await t.txt("#statPending"));
  await p.waitForTimeout(1400);
  ok("and nothing more is asked, nor does the late answer replace what is shown", t.queries().length===2 && !!(await p.$("#statPending")), t.queries().length);
  await t.ctx.close();

  // ----- Statutory: Refresh asks afresh only on its first call -----
  t=await open({query:(body,n)=>({status:200, body:n===1?{...statAnswer(0), fromStore:true}:statAnswer(n===2?2:0)})}); p=t.p;
  await t.run("90001, 90002"); await p.waitForTimeout(400);
  await p.click('[data-act="stat-refresh"]');
  ok("a refresh that leaves figures to come carries on without refresh", await t.until(async()=>t.queries().length===3 && !(await p.$("#statCarry"))) && same(t.queries(),[BODY,{...BODY, refresh:true},BODY]), t.queries());
  await t.ctx.close();

  // ----- Profile: Get figures carries on the same way -----
  t=await open({hash:"#profile", delay:350, facts:(body,n)=>({status:200, body:pfAnswer(n===1?2:0)})}); p=t.p;
  await p.fill("#pf_code","90001"); await p.click("#pf_get");
  ok("profile: after the first call, it says how far it got and carries on by itself", await t.until(async()=>(await t.txt("#pfBusy")).startsWith("Getting the rest of the figures for NAIC company 90001… 16 of 18 figures so far. The ones that came back are kept.")), await t.txt("#pfBusy"));
  bar=await t.bar("#pfBusy");
  ok("profile: with the shared bar, as a fraction, and Stop", bar && bar.now==="89" && bar.text==="16 of 18 figures" && await p.isVisible("#pfStop"), bar);
  ok("profile: it finishes on its own, the same question twice", await t.until(async()=>!!(await p.$("#pfContents"))) && same(t.facts_(),[{action:"facts",kind:"company",code:"90001"},{action:"facts",kind:"company",code:"90001"}]) && !(await p.$("#pfPending")), t.facts_());
  await t.ctx.close();

  t=await open({hash:"#profile", facts:()=>({status:200, body:pfAnswer(2)})}); p=t.p;
  await p.fill("#pf_code","90001"); await p.click("#pf_get");
  ok("profile: a call that brings nothing new stops after two calls", await t.until(async()=>!!(await p.$("#pfPending"))) && (await p.waitForTimeout(400), t.facts_().length===2), t.facts_().length);
  ok("profile: says plainly what is missing and offers Carry on, above what the profile will hold", (await t.txt("#pfPending")).startsWith("Some figures didn't arrive. 2 of 18 figures didn't come back in time, so the profile below doesn't have them yet and the slides that need them are left out. Carry on to ask for them again")
    && !!(await p.$("#pfPending + #pfContents")) && (await t.txt("#pfPendingCarry"))==="Carry on", await t.txt("#pfPending"));
  ok("profile: figures still to come aren't listed as needing to be mapped", !(await t.txt("#pfMissing")).includes("Not run") && (await t.txt("#pfMissing")).includes("Net loss and LAE reserves"), await t.txt("#pfMissing"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("profile phone: no sideways scroll with figures still to come", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/statspeed-profile-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);
  await p.screenshot({path:OUTDIR+"/statspeed-profile-1440.png",fullPage:true});
  t.facts=()=>({status:200, body:pfAnswer(0)});
  await p.click("#pfPendingCarry");
  ok("profile: Carry on asks again and the banner goes once everything is in", await t.until(async()=>t.facts_().length===3 && !(await p.$("#pfPending")) && !!(await p.$("#pfContents"))), t.facts_().length);
  await t.ctx.close();

  t=await open({hash:"#profile", delay:n=>n===1?50:1500, facts:(body,n)=>({status:200, body:pfAnswer(n===1?2:0)})}); p=t.p;
  await p.fill("#pf_code","90001"); await p.click("#pf_get");
  ok("profile: Stop is there while it carries on", await t.until(async()=>!!(await p.$("#pfStop"))));
  await p.click("#pfStop"); await p.waitForTimeout(150);
  ok("profile: Stop keeps what arrived and says you stopped", (await t.txt("#pfPending")).startsWith("You stopped getting the figures. 2 of 18 figures weren't fetched") && !!(await p.$("#pfContents")) && !(await p.$("#pfBusy")), await t.txt("#pfPending"));
  await p.waitForTimeout(1500);
  ok("profile: nothing more is asked after Stop", t.facts_().length===2 && !!(await p.$("#pfPending")));
  await t.ctx.close();

  t=await open({hash:"#profile"}); p=t.p;
  await p.fill("#pf_code","90001"); await p.click("#pf_get"); await p.waitForTimeout(500);
  ok("profile: a complete first answer behaves as before: one call, no banner", t.facts_().length===1 && !!(await p.$("#pfContents")) && !(await p.$("#pfPending")) && !(await p.$("#pfStop")));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.log("FAIL harness "+(e&&e.stack||e)); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
