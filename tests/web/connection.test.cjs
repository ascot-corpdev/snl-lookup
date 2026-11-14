// The "Check S&P connection" link in the status strip and the report it shows: the calm "not set up yet" answer, a
// connection that works, each kind of failure with S&P's reference, the plain-text copy for an email to S&P, the
// busy state, a function that fails, and the phone width. The snl-filings function is answered by the test.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), REPORTS=FIX("connection_reports.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co/",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const clone=o=>JSON.parse(JSON.stringify(o));
(async()=>{
  const b=await chromium.launch(); const errs=[];
  // t.check: how the function answers {action:"check"}: {status, body, delay}
  async function open(opts={}, {viewport={width:1440,height:900}, clipboard="ok", hash=""}={}){
    const ctx=await b.newContext({viewport, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:30Z"));
    const t={p, ctx, calls:[], status:{...clone(STATUS), role:opts.role||"corpdev"}, check:{status:200, body:clone(REPORTS.ok), delay:0}};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)});
        if(fn==="snl-filings" && body.action==="status") return J(200,t.status);
        if(fn==="snl-filings" && body.action==="reference") return J(200,{...REFS, ...(t.used?{used:t.used}:{})});
        if(fn==="snl-filings" && body.action==="check"){ if(t.check.delay) await new Promise(res=>setTimeout(res,t.check.delay)); return J(t.check.status,t.check.body); }
        if(fn==="snl-statutory" && body.action==="status") return J(200,STAT.statusOff);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    // the clipboard: "ok" records what was copied; "blocked" refuses, as some browsers do
    await p.addInitScript(mode=>{ window.__copied=null; Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async s=>{ if(mode==="blocked") throw new Error("NotAllowedError"); window.__copied=s; }}}); }, clipboard);
    await p.goto(BASE+hash); await p.waitForTimeout(350);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.run=async(wait=300)=>{ await p.click("#connBtn"); await p.waitForTimeout(wait); };
    t.steps=async()=>p.$$eval("#connSteps li",e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    return t;
  }

  // ----- the link sits in the status strip, small, and changes nothing until clicked -----
  let t=await open(); let p=t.p;
  ok("the strip has a Check S&P connection link", (await t.txt("#s_conn"))==="Check S&P connection" && await p.isVisible("#connBtn"));
  ok("it is a link-sized control, not a big button", await p.$eval("#connBtn",e=>e.classList.contains("lnk") && e.getBoundingClientRect().height<24));
  ok("opening the page doesn't run the check", !t.calls.some(c=>c.body.action==="check") && !(await p.$("#connPanel")));
  ok("the strip's other items are unchanged", (await p.$$eval("#stripIn .s-i",e=>e.length))===4);

  // ----- a connection that works -----
  const before=t.calls.length;
  t.status.filings.used=t.used={hour:17, day:45};   // what the function would say after the check's five requests
  await t.run();
  const sent=t.calls.slice(before);
  ok("clicking sends one check to the filings function", sent.filter(c=>c.body.action==="check").length===1 && sent.find(c=>c.body.action==="check").fn==="snl-filings" && JSON.stringify(sent.find(c=>c.body.action==="check").body)==='{"action":"check"}', sent);
  ok("works: a calm panel, not an alarm", await p.$eval("#connPanel",e=>e.classList.contains("info") && !e.classList.contains("banner") && e.getAttribute("role")==="status"));
  ok("works: the summary comes first", (await t.txt("#connPanel p:first-child"))===REPORTS.ok.summary, await t.txt("#connPanel p:first-child"));
  const okSteps=await t.steps();
  ok("works: each step says Done in words", okSteps.length===4 && okSteps.every(s=>s.startsWith("Done: ")) && okSteps[0]==="Done: Signed in to S&P. S&P accepted the API username and password." && okSteps[2]==="Done: Loaded S&P's list of states. 3 states. Florida (FL) is in the list.", okSteps);
  ok("works: which limits apply, what the check used, and when", (await t.txt("#connPanel .t2"))==="Trial account: 500 S&P requests an hour and 12,000 a day. This check used 5 S&P requests. Checked 13 Nov at 12:00.", await t.txt("#connPanel .t2"));
  ok("works: the panel takes focus, for keyboard and screen reader users", await p.evaluate(()=>document.activeElement&&document.activeElement.id==="connPanel"));
  ok("works: the strip's request count follows the check", (await t.txt("#s_usage")).startsWith("S&P requests: 17 of 500 this hour, 45 of 12,000 today"), await t.txt("#s_usage"));
  ok("works: the status and the lists are read again (from what the check saved)", sent.some(c=>c.body.action==="status") && sent.some(c=>c.body.action==="reference" && !c.body.refresh), sent.map(c=>c.body));
  await p.screenshot({path:OUTDIR+"/connection-ok-1440.png",fullPage:true});
  await p.click('[data-act="conn-copy"]'); await p.waitForTimeout(150);
  const copied=await p.evaluate(()=>window.__copied);
  ok("Copy for S&P copies a short plain-text version", typeof copied==="string" && copied.split("\n")[0]==="S&P API connection check (SNL lookup)" && copied.includes("Checked: 13 Nov 2026, 12:00 UTC") && copied.includes("docType INSPRODFILINGS_DOCUMENTS_API") && copied.includes("Account: trial (500 requests an hour, 12,000 a day)") && copied.includes("Result: "+REPORTS.ok.summary) && copied.includes("1. Done: Signed in to S&P.") && copied.includes("4. Done: Loaded the other three lists."), copied);
  ok("the copy has no HTML in it and no em dashes", !/[<>]|&amp;/.test(copied) && !copied.includes("—"), copied);
  ok("copying says so", (await t.txt("#toastRoot"))==="Copied. Paste it into your email to S&P support.");
  await p.click('#connPanel [data-act="conn-close"]'); await p.waitForTimeout(100);
  ok("Close removes the report and returns focus to the link", !(await p.$("#connPanel")) && await p.evaluate(()=>document.activeElement&&document.activeElement.id==="connBtn"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  await t.run();
  ok("works, phone: no sideways scroll", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/connection-ok-390.png",fullPage:true});
  await t.ctx.close();

  // ----- not set up yet: calm, no failure marks, nothing to copy -----
  t=await open(); p=t.p;
  t.status.filings={...t.status.filings, configured:false};
  t.check.body=clone(REPORTS.notConfigured);
  await t.run();
  ok("not set up: explained calmly, not as an error", await p.$eval("#connPanel",e=>e.classList.contains("info") && e.getAttribute("role")==="status") && !(await p.$("#connPanel.banner")), await p.$eval("#connPanel",e=>e.className));
  ok("not set up: says what to set and what to do next", (await t.txt("#connPanel > span"))===REPORTS.notConfigured.summary, await t.txt("#connPanel"));
  ok("not set up: no steps, no failure marks and no copy button", !(await p.$("#connSteps")) && !(await t.txt("#connPanel")).includes("Failed") && !(await p.$('[data-act="conn-copy"]')));
  ok("not set up: the lists aren't reloaded for nothing", !t.calls.some(c=>c.body.action==="reference" && t.calls.indexOf(c)>t.calls.findIndex(x=>x.body.action==="check")));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("not set up, phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/connection-notset-390.png",fullPage:true});
  await t.ctx.close();

  // ----- not entitled: a failed step with S&P's reference, for the email -----
  t=await open({role:"reader"}); p=t.p;
  ok("a reader login has the link too", await p.isVisible("#connBtn"));
  t.check.body=clone(REPORTS.entitlement);
  await t.run();
  ok("a failure stands out as a problem", await p.$eval("#connPanel",e=>e.classList.contains("banner") && e.getAttribute("role")==="alert"));
  ok("the failure summary comes first", (await t.txt("#connPanel p:first-child"))===REPORTS.entitlement.summary);
  const bad=await t.steps();
  ok("each step says Done or Failed in words, not colour alone", bad.length===2 && bad[0].startsWith("Done: ") && bad[1].startsWith("Failed: This S&P account can't use SNL Insurance Product Filings yet."), bad);
  ok("the failed step carries S&P's reference number", bad[1].endsWith("S&P reference: req-ent-77."), bad[1]);
  ok("the failed mark is also coloured", await p.$eval("#connSteps li:nth-child(2) .mk",e=>e.classList.contains("no") && e.textContent==="Failed:"));
  await p.click('[data-act="conn-copy"]'); await p.waitForTimeout(150);
  const copied2=await p.evaluate(()=>window.__copied);
  ok("the copy for S&P names the failure, what to ask for and the reference", copied2.includes("2. Failed: This S&P account can't use SNL Insurance Product Filings yet.") && copied2.includes("INSPRODFILINGS_DOCUMENTS_API entitlement") && copied2.includes("S&P reference: req-ent-77."), copied2);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("failure, phone: no sideways scroll", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/connection-failed-390.png",fullPage:true});
  await t.ctx.close();

  // ----- a reference already in S&P's words isn't repeated -----
  t=await open(); p=t.p;
  t.check.body=clone(REPORTS.signin);
  await t.run();
  const si=await t.steps();
  ok("a refused sign-in shows S&P's reference once", si.length===1 && si[0].startsWith("Failed: Couldn't sign in to S&P.") && si[0].split("req-signin-7").length===2, si);
  // the clipboard is blocked: the text is shown to copy by hand
  await t.ctx.close();
  t=await open({}, {clipboard:"blocked"}); p=t.p;
  t.check.body=clone(REPORTS.signin);
  await t.run();
  await p.click('[data-act="conn-copy"]'); await p.waitForTimeout(150);
  const shown=await p.$eval("#connText",e=>({v:e.value, focused:document.activeElement===e, ro:e.readOnly})).catch(()=>null);
  ok("clipboard blocked: the text is shown, selected, to copy by hand", shown && shown.ro && shown.focused && shown.v.startsWith("S&P API connection check (SNL lookup)") && shown.v.includes("1. Failed: Couldn't sign in to S&P."), shown);
  ok("clipboard blocked: says what to do", (await t.txt("#toastRoot"))==="Couldn't copy here. Select the text below and copy it.");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("copy text shown, phone: no sideways scroll", await t.noScroll());
  await t.ctx.close();

  // ----- busy, then the function itself fails -----
  t=await open(); p=t.p;
  t.check={status:502, body:{error:"server", message:"The filings function failed: made-up fault"}, delay:600};
  await p.click("#connBtn"); await p.waitForTimeout(150);
  ok("while checking, the link says so and can't be clicked twice", (await t.txt("#connBtn"))==="Checking S&P connection…" && await p.$eval("#connBtn",e=>e.disabled));
  await p.click("#connBtn",{force:true}).catch(()=>{}); await p.waitForTimeout(800);
  ok("only one check was sent", t.calls.filter(c=>c.body.action==="check").length===1);
  ok("the function failing: a plain problem with a way to try again", (await t.txt("#connPanel")).startsWith("Couldn't run the S&P connection check. The filings function failed: made-up fault") && await p.isVisible('#connPanel [data-act="conn-check"]'), await t.txt("#connPanel"));
  ok("and the link is back", (await t.txt("#connBtn"))==="Check S&P connection" && !(await p.$eval("#connBtn",e=>e.disabled)));
  t.check={status:200, body:clone(REPORTS.ok), delay:0};
  await p.click('#connPanel [data-act="conn-check"]'); await p.waitForTimeout(300);
  ok("Try again runs the check again", (await t.steps()).length===4 && t.calls.filter(c=>c.body.action==="check").length===2);
  await p.click('#connPanel [data-act="conn-check"]'); await p.waitForTimeout(300);
  ok("Check again is there after a result too", t.calls.filter(c=>c.body.action==="check").length===3);
  // signing out clears the report
  await p.click("#signoutBtn"); await p.waitForTimeout(300);
  ok("signing out clears the report", !(await p.$("#connPanel")) && (await p.$eval("#connRoot",e=>e.innerHTML))==="");
  await t.ctx.close();

  // ----- the statutory view has it too -----
  t=await open({}, {hash:"#statutory"}); p=t.p;
  ok("the link is on the Statutory view as well", await p.isVisible("#connBtn"));
  t.check.body=clone(REPORTS.ok);
  await t.run();
  ok("on Statutory the lists aren't loaded for the Filings form", (await t.steps()).length===4 && !t.calls.some(c=>c.body.action==="reference"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("statutory, phone: no sideways scroll", await t.noScroll());
  await t.ctx.close();

  const SRC=fs.readFileSync(WEB+"/index.html","utf8");
  ok("no em dashes in the page", !SRC.includes("—"));
  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
