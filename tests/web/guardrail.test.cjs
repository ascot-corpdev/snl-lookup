// The guardrail on Claude's bill, on the page: the sentence under each answer led by what it cost, the quiet line
// under the question box with the questions asked today and what they cost, and the box switched off, with the
// reason and when it comes back, once the daily limit is reached. Everything here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), JOB=FIX("web_ask_result.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const NOW=Date.parse("2026-11-13T12:00:00Z"), RESETS="2026-11-14T00:00:00.000Z";
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const LOOKED="Looked up: Filings: 3 companies, FL, 2021 to 2026; CALL-134000001, pages 1 to 10; CALL-134000002, pages 1 to 18; TARR-134000777, pages 1 to 12.";
const day=(asked, limit=40, cost=null)=>({status:200, body:{configured:true, askedToday:asked, dailyLimit:limit, costToday:cost, resetsAt:RESETS}});
(async()=>{
  const b=await chromium.launch(); const errs=[];
  // chat: what the questions function's status action answers; ask: what ask answers
  async function open(over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date(NOW));
    const t={p, ctx, calls:[], jobs:0, chat:()=>day(7,40,3.1), ask:()=>({status:202, body:{jobId:"job-"+(++t.jobs)}}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev", claude:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory" && body.action==="status") return J(200,{configured:false});
        if(fn==="snl-chat" && body.action==="status"){ const a=t.chat(); return J(a.status,a.body); }
        if(fn==="snl-chat" && body.action==="ask"){ const a=t.ask(body); return J(a.status,a.body); }
        if(fn==="snl-chat" && body.action==="continue") return J(202,{jobId:body.jobId,resumed:false});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(450);
    await p.evaluate(()=>{ TIMING.poll=100; });
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.of=(fn,a)=>t.calls.filter(c=>c.fn===fn && c.body.action===a);
    t.openPanel=async()=>{ await p.click("#askFab"); await p.waitForTimeout(250); };
    t.job=async(id,patch)=>{ await p.evaluate(([i,pa])=>{ __mock.setJob(i,pa); },[id,patch]); await p.waitForTimeout(300); };
    t.say=async q=>{ await p.fill("#ask_input",q); await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(300); };
    t.noScroll=async()=>p.evaluate(()=>{ const b=document.getElementById("askBody"); return document.documentElement.scrollWidth<=window.innerWidth && (!b || b.scrollWidth<=b.clientWidth); });
    return t;
  }
  const withUsage=u=>{ const r=copy(JOB.result); r.usage=u; return r; };

  // ----- the cost sentence under an answer, in each case -----
  let t=await open(); let p=t.p;
  ok("before the panel is opened, the questions function isn't asked where the login stands", t.of("snl-chat","status").length===0);
  await t.openPanel();
  ok("opening the panel asks the questions function once, with the login's token", t.of("snl-chat","status").length===1 && t.of("snl-chat","status")[0].auth==="Bearer t" && same(t.of("snl-chat","status")[0].body,{action:"status"}));
  ok("the quiet line under the box: questions today against the limit, and what they cost", (await t.txt("#askDaily"))==="7 of 40 questions today, about $3.10" && await p.isEnabled("#ask_input") && !(await p.$("#askLimit")), await t.txt("#askDaily"));
  const cases=[
    ["a priced answer leads with its cost", {inputTokens:48210, outputTokens:1432, spRequests:9, costUsd:0.42}, "This answer cost about $0.42 (48,210 tokens read, 1,432 written) and used 9 S&P requests."],
    ["an answer under a cent says less than $0.01", {inputTokens:2000, outputTokens:300, spRequests:0, costUsd:0}, "This answer cost less than $0.01 (2,000 tokens read, 300 written) and used 0 S&P requests."],
    ["a fraction of a cent is still less than $0.01", {inputTokens:2000, outputTokens:300, spRequests:1, costUsd:0.004}, "This answer cost less than $0.01 (2,000 tokens read, 300 written) and used 1 S&P request."],
    ["an unknown cost says cost n/d", {inputTokens:48210, outputTokens:1432, spRequests:9, costUsd:null}, "This answer cost n/d (48,210 tokens read, 1,432 written) and used 9 S&P requests."],
    ["an answer from before costs were tracked says cost n/d", {inputTokens:48210, outputTokens:1432, spRequests:9}, "This answer cost n/d (48,210 tokens read, 1,432 written) and used 9 S&P requests."],
    ["a large cost has commas and cents", {inputTokens:9000000, outputTokens:120000, spRequests:150, costUsd:1234.5}, "This answer cost about $1,234.50 (9,000,000 tokens read, 120,000 written) and used 150 S&P requests."],
    ["a cost that isn't a number is n/d, and shows as text", {inputTokens:10, outputTokens:5, spRequests:2, costUsd:"<b>9</b>"}, "This answer cost n/d (10 tokens read, 5 written) and used 2 S&P requests."],
    ["with no S&P count, just the cost", {inputTokens:10, outputTokens:5, costUsd:0.01}, "This answer cost about $0.01 (10 tokens read, 5 written)."],
  ];
  for(let i=0;i<cases.length;i++){
    const [name, usage, want]=cases[i];
    await t.say("Question "+(i+1)); await t.job("job-"+(i+1),{status:"done", result:withUsage(usage)});
    const got=await t.txt(`.ccmsg.done >> nth=${i} >> .look`);
    ok(name, got===`${LOOKED} ${want} Model: claude-example-1.`, got);
  }
  ok("the lookups part comes first and is unchanged; the old token sentence is gone", !(await p.evaluate(()=>document.body.innerText)).includes("Claude read") && !(await p.$(".look b")));
  ok("the line is refreshed after each answer", t.of("snl-chat","status").length===1+cases.length, t.of("snl-chat","status").length);
  await p.$eval("#askBody",e=>{ e.scrollTop=e.scrollHeight; });
  await p.screenshot({path:OUTDIR+"/guardrail-cost-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: the cost sentences and the daily line fit with no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/guardrail-cost-390.png"});
  await t.ctx.close();

  // ----- the daily line: counted on ask, refreshed when the answer is done -----
  t=await open(); p=t.p; await t.openPanel();
  t.chat=()=>day(8,40,3.52);
  await t.say("How many homeowners filings did Calloway make?");
  ok("asking counts the question at once", (await t.txt("#askDaily"))==="8 of 40 questions today, about $3.10", await t.txt("#askDaily"));
  await t.job("job-1",{status:"done", result:withUsage({inputTokens:1000, outputTokens:100, spRequests:0, costUsd:0.42})});
  ok("when the answer is done the line shows the day's new total", (await t.txt("#askDaily"))==="8 of 40 questions today, about $3.52", await t.txt("#askDaily"));
  t.chat=()=>day(9,40,3.52);
  await t.say("And Tarrow?"); await t.job("job-2",{status:"error", error:"Claude is busy. Wait a minute and ask again."});
  ok("a failed answer refreshes the line too", (await t.txt("#askDaily"))==="9 of 40 questions today, about $3.52" && t.of("snl-chat","status").length===3, await t.txt("#askDaily"));
  await t.ctx.close();

  for(const [name, answer, want] of [
    ["no limit set: the questions today and the cost", day(7,null,3.1), "7 questions today, about $3.10"],
    ["nothing priced yet: just the count", day(0,40,null), "0 of 40 questions today"],
    ["a day's cost under a cent", day(1,40,0), "1 of 40 questions today, less than $0.01"],
    ["one question allowed a day", day(0,1,null), "0 of 1 question today"],
  ]){
    t=await open({chat:()=>answer}); await t.openPanel();
    ok(name, (await t.txt("#askDaily"))===want, await t.txt("#askDaily"));
    await t.ctx.close();
  }
  for(const [name, answer] of [["an older questions function with no status action", {status:400, body:{error:"bad", message:"Unknown action. Use ask or continue."}}], ["Claude not connected", {status:200, body:{configured:false, askedToday:null, dailyLimit:40, costToday:null, resetsAt:null}}], ["a failing status", {status:500, body:{error:"server", message:"made-up fault"}}]]){
    t=await open({chat:()=>answer}); p=t.p; await t.openPanel();
    ok(`${name}: no line, no error, and the box still works`, !(await p.$("#askDaily")) && !(await p.$("#askLimit")) && await p.isEnabled("#ask_input") && !(await p.$("#askBody .banner")), await t.txt(".ask-f"));
    await t.ctx.close();
  }
  t=await open(); p=t.p; await t.openPanel(); await p.click("#askClose"); await p.waitForTimeout(100); await t.openPanel();
  ok("opening the panel again within a minute doesn't ask again", t.of("snl-chat","status").length===1);
  await t.ctx.close();

  // ----- at the limit -----
  t=await open({chat:()=>day(40,40,12.4)}); p=t.p; await t.openPanel();
  ok("at the limit the box is off and says why and when it comes back", (await t.txt("#askLimit"))==="Questions are off until midnight UTC (00:00 your time). You've asked 40 questions today and the limit is 40 a day for each login. Today's answers cost about $12.40. The site owner can change the limit." && (await p.getAttribute("#askLimit","role"))==="status" && !(await p.$("#askDaily")), await t.txt("#askLimit"));
  ok("the question box and the Ask button are disabled", !(await p.isEnabled("#ask_input")) && !(await p.isEnabled('button[data-act="ask-send"]')));
  await p.evaluate(()=>{ S.ask.draft="Sneaking one in"; askQuestion(); }); await p.waitForTimeout(200);
  ok("nothing is sent at the limit, even from the keyboard", t.of("snl-chat","ask").length===0);
  ok("no em dashes in the panel", !(await p.$eval("#askPanel",e=>e.innerText)).includes("—"));
  await p.screenshot({path:OUTDIR+"/guardrail-limit-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: the at-limit box fits with no sideways scroll", await t.noScroll() && await p.isVisible("#askLimit"));
  await p.screenshot({path:OUTDIR+"/guardrail-limit-390.png"});
  await p.clock.setFixedTime(new Date(Date.parse(RESETS)+1000)); await p.evaluate(()=>renderAsk()); await p.waitForTimeout(100);
  ok("after midnight UTC the box comes back on", await p.isEnabled("#ask_input") && !(await p.$("#askLimit")));
  await t.ctx.close();

  // ----- ask refused with 429: the turn says so calmly, the question is kept, and the box goes off -----
  const MSG="You've asked 40 questions today, and the limit is 40 a day for each login. You can ask again after midnight UTC, in about 12 hours. The site owner can change the limit.";
  t=await open({chat:()=>day(39,40,11.9), ask:()=>({status:429, body:{error:"daily_limit", message:MSG, askedToday:40, dailyLimit:40, resetsAt:RESETS}})}); p=t.p; await t.openPanel();
  ok("one question left: the box is on", (await t.txt("#askDaily"))==="39 of 40 questions today, about $11.90" && await p.isEnabled("#ask_input"));
  t.chat=()=>day(40,40,11.9);
  await t.say("Which Calloway forms changed?"); await p.waitForTimeout(200);
  ok("a refused question shows the function's message as a notice, not a fault", (await t.txt(".ask-calm"))===MSG && !(await p.$(".ccmsg.err")), await t.txt(".turn"));
  ok("the question is kept in the box for later", (await p.inputValue("#ask_input"))==="Which Calloway forms changed?");
  ok("the page asks where the login stands, and switches the box off", t.of("snl-chat","status").length===2 && !(await p.isEnabled("#ask_input")) && (await t.txt("#askLimit")).startsWith("Questions are off until midnight UTC"), await t.txt(".ask-f"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll after a refusal", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/guardrail-refused-390.png"});
  await t.ctx.close();

  // ----- signing out forgets the day's figures -----
  t=await open(); p=t.p; await t.openPanel();
  await p.evaluate(()=>signOut()); await p.waitForTimeout(200);
  ok("signing out clears the day's figures", await p.evaluate(()=>S.chatUse===null && S.chatUseAt===0));
  await t.ctx.close();

  ok("no script errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
