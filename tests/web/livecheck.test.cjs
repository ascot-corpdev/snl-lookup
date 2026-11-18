// The "Live check" link in the status strip (Corp Dev only) and the report it shows: busy, every finding matching,
// some differing, stopped part-way, not set up, the function failing, the plain-text copy for whoever maintains the
// app (and the fallback when the clipboard is refused), and the layouts at 1440px and 390px. The snl-filings
// function is answered by the test with made-up reports (tests/fixtures/livecheck_reports.json).
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), LIVE=FIX("livecheck_reports.json"), CONN=FIX("connection_reports.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co/",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const clone=o=>JSON.parse(JSON.stringify(o));
(async()=>{
  const b=await chromium.launch(); const errs=[];
  // t.live: how the function answers {action:"diagnose"}: {status, body, delay}
  async function open(opts={}, {viewport={width:1440,height:900}, clipboard="ok", hash=""}={}){
    const ctx=await b.newContext({viewport, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:30Z"));
    const t={p, ctx, calls:[], status:{...clone(STATUS), role:opts.role||"corpdev"}, live:{status:200, body:clone(LIVE.ok), delay:0}};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)});
        if(fn==="snl-filings" && body.action==="status") return J(200,t.status);
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-filings" && body.action==="check") return J(200,clone(CONN.ok));
        if(fn==="snl-filings" && body.action==="diagnose"){ if(t.live.delay) await new Promise(res=>setTimeout(res,t.live.delay)); return J(t.live.status,t.live.body); }
        if(fn==="snl-statutory" && body.action==="status") return J(200,STAT.statusOff);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.addInitScript(mode=>{ window.__copied=null; Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async s=>{ if(mode==="blocked") throw new Error("NotAllowedError"); window.__copied=s; }}}); }, clipboard);
    await p.goto(BASE+hash); await p.waitForTimeout(350);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.run=async(wait=300)=>{ await p.click("#liveBtn"); await p.waitForTimeout(wait); };
    t.items=async()=>p.$$eval("#livePanel li[data-id]",e=>e.map(x=>({id:x.dataset.id, outcome:x.dataset.outcome, mark:x.querySelector(".mk").textContent, cls:x.querySelector(".mk").className, text:x.textContent.replace(/\s+/g," ").trim()})));
    return t;
  }

  // ----- the link: Corp Dev only, beside the connection check, and nothing runs until it is clicked -----
  let t=await open(); let p=t.p;
  ok("Corp Dev: the strip has a Live check link", (await t.txt("#s_live"))==="Live check" && await p.isVisible("#liveBtn"));
  ok("it sits right after Check S&P connection", await p.evaluate(()=>document.getElementById("s_conn").nextElementSibling===document.getElementById("s_live")));
  ok("it is a link-sized control", await p.$eval("#liveBtn",e=>e.classList.contains("lnk") && e.getBoundingClientRect().height<24));
  ok("opening the page doesn't run it", !t.calls.some(c=>c.body.action==="diagnose") && !(await p.$("#livePanel")));

  // ----- every finding matching -----
  t.live.delay=500;
  await p.click("#liveBtn"); await p.waitForTimeout(150);
  ok("busy: the link says so and can't be clicked twice", (await t.txt("#liveBtn"))==="Running live check…" && await p.$eval("#liveBtn",e=>e.disabled));
  ok("busy: the panel says what it is doing and how long it takes", (await t.txt("#livePanel")).startsWith("Running the Live check. It signs in to S&P, runs one small search and opens one document, using at most six S&P requests. This can take a minute."), await t.txt("#livePanel"));
  await p.click("#liveBtn",{force:true}).catch(()=>{}); await p.waitForTimeout(600);
  ok("only one Live check was sent, as {action:\"diagnose\"} to the filings function", t.calls.filter(c=>c.body.action==="diagnose").length===1 && JSON.stringify(t.calls.find(c=>c.body.action==="diagnose").body)==='{"action":"diagnose"}' && t.calls.find(c=>c.body.action==="diagnose").fn==="snl-filings");
  ok("all hold: the short summary comes first", (await t.txt("#liveSummary"))===LIVE.ok.summary && (await p.$eval("#livePanel > div",e=>e.firstElementChild.id))==="liveSummary", await t.txt("#liveSummary"));
  ok("all hold: a calm panel that takes focus", await p.$eval("#livePanel",e=>e.classList.contains("info") && e.getAttribute("role")==="status") && await p.evaluate(()=>document.activeElement&&document.activeElement.id==="livePanel"));
  ok("all hold: findings are grouped under plain headings, in order", JSON.stringify(await p.$$eval("#livePanel h3",e=>e.map(x=>x.textContent)))===JSON.stringify(["Signing in","Reference lists","Search results","A filing document","Company list"]));
  const it=await t.items();
  ok("all hold: one line per finding", it.length===LIVE.ok.findings.length, it.length);
  ok("all hold: each says As the app assumes in words, coloured", it.filter(x=>x.outcome==="holds").every(x=>x.mark==="As the app assumes:" && x.cls==="mk ok") && it.filter(x=>x.outcome==="holds").length===LIVE.ok.counts.holds, it.slice(0,3));
  ok("for-the-record findings say so", it.filter(x=>x.outcome==="info").every(x=>x.mark==="For the record:" && x.cls==="mk rec"));
  ok("a finding reads: mark, title, what was found", it.find(x=>x.id==="signin.refresh").text==="As the app assumes: A refresh token with the sign-in. A refresh token came back, as text.", it.find(x=>x.id==="signin.refresh"));
  ok("the value types of every column are tucked away until opened", await p.$eval("#liveCols",e=>!e.open) && (await t.txt("#liveCols summary"))==="Value types of every result column (30)");
  ok("requests used and when it ran come last", (await t.txt("#liveMeta")).endsWith("Trial account. This check used 3 of at most 6 S&P requests and took 2 seconds. Ran 13 Nov at 12:00.") && (await t.txt("#liveMeta")).startsWith("Based on 1 saved search"), await t.txt("#liveMeta"));
  ok("the strip's request count follows the check, and the status is read again", t.calls.filter(c=>c.body.action==="status").length>=2);
  await p.screenshot({path:OUTDIR+"/livecheck-ok-1440.png",fullPage:true});
  await p.click("#liveCols summary"); await p.waitForTimeout(100);
  ok("the column list opens", await p.$eval("#liveCols",e=>e.open) && (await p.$$("#liveCols li")).length===30);
  await p.screenshot({path:OUTDIR+"/livecheck-cols-1440.png",fullPage:true});

  // ----- copy for developer -----
  await p.click('[data-act="live-copy"]'); await p.waitForTimeout(150);
  const copied=await p.evaluate(()=>window.__copied);
  const L=copied?copied.split("\n"):[];
  ok("copy: a plain-text report with what it is and when it ran", L[0]==="Live check of S&P answers (SNL lookup)" && L[1]==="Ran: 13 Nov 2026, 12:00 UTC" && L[2]==="Account: trial (500 requests an hour, 12,000 a day). S&P requests used: 3 of at most 6. Took 2 seconds." && L[3]==="Result: "+LIVE.ok.summary, L.slice(0,4));
  ok("copy: says it holds no S&P data", copied.includes("This report holds no S&P data: only column names, value types, counts, shares and patterns."));
  ok("copy: every finding, grouped, with its mark and the code to change", LIVE.ok.findings.every(f=>copied.includes(`: ${f.title}. ${f.found}`) && copied.includes(`  Code: ${f.where}`)) && copied.includes("\nSigning in:\n- As the app assumes: How long a token lasts"), copied.slice(0,600));
  ok("copy: the column types and what isn't checked", copied.includes("Value types of every result column:\n- serffFilingEntityEventId: filled 100.0%.") && copied.includes("Not checked, on purpose:\n- What S&P answers to a wrong password"));
  ok("copy: no HTML, no em dashes", !/[<>]|&amp;/.test(copied) && !copied.includes("—"));
  ok("copy: says so", (await t.txt("#toastRoot"))==="Copied. Paste it into a message to whoever maintains the app.");
  await p.click('#livePanel [data-act="live-close"]'); await p.waitForTimeout(100);
  ok("Close removes the report and returns focus to the link", !(await p.$("#livePanel")) && await p.evaluate(()=>document.activeElement&&document.activeElement.id==="liveBtn"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  t.live.delay=0; await t.run();
  await p.click("#liveCols summary"); await p.waitForTimeout(100);
  ok("all hold, phone, columns open: no sideways scroll", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/livecheck-ok-390.png",fullPage:true});
  // both panels at once
  await p.click("#connBtn"); await p.waitForTimeout(300);
  ok("the connection check and the Live check can be open together", await p.isVisible("#connPanel") && await p.isVisible("#livePanel") && await t.noScroll());
  await t.ctx.close();

  // ----- some differ -----
  t=await open({}, {viewport:{width:390,height:844}}); p=t.p;
  t.live.body=clone(LIVE.differs);
  await t.run();
  const d=await t.items();
  ok("differs: the summary counts what differs", (await t.txt("#liveSummary"))===LIVE.differs.summary && /\d+ differ\./.test(LIVE.differs.summary));
  ok("differs: each says Differs in words and colour, with what to change", d.filter(x=>x.outcome==="differs").length===LIVE.differs.counts.differs && d.filter(x=>x.outcome==="differs").every(x=>x.mark==="Differs:" && x.cls==="mk no" && x.text.includes("Differs")), d.filter(x=>x.outcome==="differs").map(x=>x.text.slice(0,80)));
  ok("differs: the verdict line names the change", d.find(x=>x.id==="search.rateImpact").text.endsWith("Differs: overallRateImpact is a fraction (0.045 for 4.5%). Multiply it by 100 where it is shown without the display value and in the rate sort."), d.find(x=>x.id==="search.rateImpact").text);
  ok("couldn't tell: said in words, in grey", d.filter(x=>x.outcome==="unknown").every(x=>x.mark==="Couldn't tell:" && x.cls==="mk unk"));
  const red=await p.$eval('#livePanel li[data-outcome="differs"] .mk',e=>getComputedStyle(e).color), blue=await p.$eval('#livePanel li[data-outcome="holds"] .mk',e=>getComputedStyle(e).color);
  ok("differs and holds are different colours", red!==blue, {red, blue});
  ok("differs, phone: no sideways scroll", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/livecheck-differs-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);
  await p.screenshot({path:OUTDIR+"/livecheck-differs-1440.png",fullPage:true});
  await p.click('[data-act="live-copy"]'); await p.waitForTimeout(150);
  ok("differs: the copy marks each one Differs", (await p.evaluate(()=>window.__copied)).includes("- Differs: Rate impact: overallRateImpact is in percentage points"));
  await t.ctx.close();

  // ----- stopped part-way -----
  t=await open(); p=t.p;
  t.live.body=clone(LIVE.stopped);
  await t.run();
  ok("stopped: why, plainly, under the summary", (await t.txt("#liveStopped"))===LIVE.stopped.stopped && (await t.txt("#liveStopped")).includes("S&P reference: req-forced."));
  ok("stopped: the findings not reached say so", (await t.items()).find(x=>x.id==="doc.type").text.includes("Not reached: Stopped at the live search"));
  await p.click('[data-act="live-copy"]'); await p.waitForTimeout(150);
  ok("stopped: the copy carries the reason", (await p.evaluate(()=>window.__copied)).includes("Stopped: "+LIVE.stopped.stopped));
  await t.ctx.close();

  // ----- not set up -----
  t=await open(); p=t.p;
  t.status.filings={...t.status.filings, configured:false};
  t.live.body=clone(LIVE.notConfigured);
  const statusBefore=t.calls.filter(c=>c.body.action==="status").length;
  await t.run();
  ok("not set up: a calm panel that says so first", await p.$eval("#livePanel",e=>e.classList.contains("info")) && (await t.txt("#liveSummary"))===LIVE.notConfigured.summary && !(await p.$("#liveStopped")));
  ok("not set up: no S&P request used", (await t.txt("#liveMeta")).includes("This check used 0 of at most 6 S&P requests"));
  ok("not set up: the status isn't reloaded for nothing", t.calls.filter(c=>c.body.action==="status").length===statusBefore);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("not set up, phone: no sideways scroll", await t.noScroll());
  await t.ctx.close();

  // ----- the function fails, then the clipboard is refused -----
  t=await open({}, {clipboard:"blocked"}); p=t.p;
  t.live={status:502, body:{error:"server", message:"The filings function failed: made-up fault"}, delay:0};
  await t.run();
  ok("the function failing: a plain problem with Try again", (await t.txt("#livePanel")).startsWith("Couldn't run the Live check. The filings function failed: made-up fault") && await p.$eval("#livePanel",e=>e.getAttribute("role")==="alert"), await t.txt("#livePanel"));
  ok("and the link is back", (await t.txt("#liveBtn"))==="Live check" && !(await p.$eval("#liveBtn",e=>e.disabled)));
  t.live={status:200, body:clone(LIVE.ok), delay:0};
  await p.click('#livePanel [data-act="live-check"]'); await p.waitForTimeout(300);
  ok("Try again runs it again", (await t.items()).length===LIVE.ok.findings.length && t.calls.filter(c=>c.body.action==="diagnose").length===2);
  await p.click('[data-act="live-copy"]'); await p.waitForTimeout(150);
  const shown=await p.$eval("#liveText",e=>({v:e.value, focused:document.activeElement===e, ro:e.readOnly})).catch(()=>null);
  ok("clipboard refused: the text is shown, selected, to copy by hand", shown && shown.ro && shown.focused && shown.v.startsWith("Live check of S&P answers (SNL lookup)"), shown&&shown.v.slice(0,60));
  ok("clipboard refused: says what to do", (await t.txt("#toastRoot"))==="Couldn't copy here. Select the text below and copy it.");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("copy text shown, phone: no sideways scroll", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.click('#livePanel [data-act="live-check"]'); await p.waitForTimeout(300);
  ok("Run again is there after a result", t.calls.filter(c=>c.body.action==="diagnose").length===3);
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);
  await p.click("#signoutBtn"); await p.waitForTimeout(300);
  ok("signing out clears the report", !(await p.$("#livePanel")) && (await p.$eval("#liveRoot",e=>e.innerHTML))==="");
  await t.ctx.close();

  // ----- readers don't see it -----
  t=await open({role:"reader"}); p=t.p;
  ok("a reader login has no Live check link", !(await p.$("#liveBtn")) && await p.isVisible("#connBtn"));
  await p.evaluate(()=>{ S.live={report:{summary:"made-up", findings:[], columns:[], notCovered:[]}}; render(); });
  ok("and no panel, even if state had one", !(await p.$("#livePanel")));
  await t.ctx.close();

  // ----- the statutory view has it too -----
  t=await open({}, {hash:"#statutory"}); p=t.p;
  ok("the link is on the Statutory view as well", await p.isVisible("#liveBtn"));
  await t.run();
  ok("on Statutory the lists aren't loaded for the Filings form", (await t.items()).length>0 && !t.calls.some(c=>c.body.action==="reference"));
  await t.ctx.close();

  const SRC=fs.readFileSync(WEB+"/index.html","utf8");
  ok("no em dashes in the page", !SRC.includes("—"));
  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
