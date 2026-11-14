// Ask Claude, the panel that opens beside Filings and Statutory: the button and its states, opening and closing,
// what the page sends (the question, earlier turns, and a description of what is on screen), how it follows a
// background answer (steps, text so far, paused and quiet answers), the finished answer with its citations, sources,
// table and exports, follow-up questions, errors, and the conversation surviving a closed panel and a change of view.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), JOB=FIX("web_ask_result.json"), SEARCH=FIX("web_search.json"), STAT=FIX("web_statutory.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const NOW=Date.parse("2026-11-13T12:00:00Z");
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  // One page per scenario. over: answers from the made-up functions; at: the view to start on, whether the panel
  // starts open, and anything to run before the page loads.
  async function open(opts={}, over={}, at={}){
    const {hash="#filings", panel=true, init=null}=at;
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date(NOW));
    const t={p, ctx, calls:[], jobs:0, delay:0, abortAsk:false, claude:true,
      ask:()=>({status:202, body:{jobId:"job-"+(++t.jobs)}}),
      cont:body=>({status:202, body:{jobId:body.jobId, resumed:true}}),
      search:()=>copy(SEARCH), statStatus:()=>copy(STAT.statusMapped), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"], apikey:req.headers()["apikey"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev", claude:{configured:t.claude}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-filings" && body.action==="resolve") return J(200,{query:body.q, matches:[], note:"No saved company matches."});
        if(fn==="snl-filings" && body.action==="search") return J(200,t.search(body));
        if(fn==="snl-statutory" && body.action==="status") return J(200,t.statStatus());
        if(fn==="snl-statutory" && body.action==="query") return J(200,copy(STAT.query));
        if(fn==="snl-filings" && body.action==="document") return r.fulfill({status:200,contentType:"application/pdf",headers:{"access-control-allow-origin":"*"},body:"%PDF-1.4 made-up "+(body.documentId||body.filingVersionId)});
        if(fn==="snl-chat" && body.action==="ask"){ if(t.abortAsk) return r.abort(); if(t.delay) await new Promise(res=>setTimeout(res,t.delay)); const a=t.ask(body); return J(a.status,a.body); }
        if(fn==="snl-chat" && body.action==="continue"){ const a=t.cont(body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; window.__opened=[];
      window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; },opts);
    if(init) await p.addInitScript(init);
    await p.goto(BASE+hash); await p.waitForTimeout(450);
    await p.evaluate(()=>{ TIMING.poll=100; });   // check the job ten times a second instead of every two seconds
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    // neither the page nor the panel scrolls sideways
    t.noScroll=async()=>p.evaluate(()=>{ const b=document.getElementById("askBody"); return document.documentElement.scrollWidth<=window.innerWidth && (!b || b.scrollWidth<=b.clientWidth); });
    t.box=async sel=>p.$eval(sel,e=>{ const r=e.getBoundingClientRect(); return {left:Math.round(r.left), right:Math.round(r.right), top:Math.round(r.top), bottom:Math.round(r.bottom), width:Math.round(r.width), height:Math.round(r.height)}; });
    t.openPanel=async()=>{ await p.click("#askFab"); await p.waitForTimeout(120); };
    t.closePanel=async()=>{ await p.click("#askClose"); await p.waitForTimeout(120); };
    t.fab=async()=>p.$eval("#askFab",e=>({text:e.textContent.trim(), cls:e.className.replace("askfab","").trim(), hidden:e.hidden, expanded:e.getAttribute("aria-expanded")}));
    // puts a filings result, or statutory figures, on screen
    t.searchFilings=async()=>{ await p.fill("#f_q","4000001"); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click("#byId button >> nth=0"); await p.click('#states [data-s="FL"]'); await p.click('button[data-act="search"]'); await p.waitForTimeout(450); };
    t.showFigures=async()=>{ await p.fill("#st_codes","90001, 90107"); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(450); };
    if(panel) await t.openPanel();
    t.of=a=>t.calls.filter(c=>c.body.action===a);
    t.job=async(id,patch)=>{ await p.evaluate(([i,pa])=>{ __mock.setJob(i,pa); },[id,patch]); await p.waitForTimeout(280); };
    t.say=async q=>{ await p.fill("#ask_input",q); await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(250); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    return t;
  }
  const Q1="Which Calloway companies filed homeowners forms in Florida since 2021?";
  // the finished answer, with a cap notice, a citation to a source that isn't listed, and hostile text in every part
  const RESULT=copy(JOB.result);
  RESULT.answer.push({text:"One more point <script>window.__xss=1</script> with no source listed.", cites:[9]});
  RESULT.sources.push({n:4, documentId:880009, filingVersionId:null, title:"<script>window.__xss=1</script>", company:"Calloway <b>Home</b> Co", state:"FL", trackingNumber:"CALL-134000009", pages:"2, 5", startPage:2, quote:'<img src=x onerror="window.__xss=1">'});
  RESULT.table.rows.push(["<script>window.__xss=1</script>", "", null, "Private client", "n/d", "CALL-134000009"]);
  RESULT.caps=["Claude stopped at the limit of 12 lookups for one question, so the answer may be incomplete.", "<b>Second notice</b>"];
  const ANSWER_TEXT=RESULT.answer.map(s=>s.text).join("\n");

  // ----- the button, and the panel it opens -----
  let t=await open({}, {}, {panel:false}); let p=t.p;
  ok("Ask is a button on the page, not a tab", same(await t.all("nav.tabs a"),["Filings","Statutory"]) && same(await t.fab(),{text:"Ask Claude",cls:"",hidden:false,expanded:"false"}) && !(await p.$("#askPanel")), await t.fab());
  ok("the button is fixed at the bottom right", await p.evaluate(()=>{ const r=document.getElementById("askFab").getBoundingClientRect(); return getComputedStyle(document.getElementById("askFab")).position==="fixed" && Math.round(innerWidth-r.right)===16 && Math.round(innerHeight-r.bottom)===16; }));
  await p.evaluate(()=>window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(80);
  ok("scrolled to the foot, the button sits below the last thing on the page", await p.evaluate(()=>{ const f=[...document.querySelectorAll("footer.foot span")].pop().getBoundingClientRect(), a=document.getElementById("askFab").getBoundingClientRect(); return f.bottom<=a.top; }));
  await p.evaluate(()=>window.scrollTo(0,0));
  await t.openPanel();
  ok("the button opens a labelled dialog that doesn't lock the page", (await p.getAttribute("#askPanel","role"))==="dialog" && (await p.getAttribute("#askPanel","aria-label"))==="Ask Claude" && (await p.getAttribute("#askPanel","aria-modal"))==="false" && !(await p.$(".scrim")) && (await t.txt("#askPanel h2"))==="Ask Claude");
  ok("the cursor goes to the question box, and the button gives way to the panel", await p.evaluate(()=>document.activeElement.id==="ask_input") && (await t.fab()).hidden && (await t.fab()).expanded==="true");
  let panel=await t.box("#askPanel"), page=await t.box("main .wrap");
  ok("desktop: a drawer on the right, 480px wide and the full height", panel.width===480 && panel.right===1440 && panel.top===0 && panel.height===900, panel);
  ok("desktop: the page stays visible beside it, and makes room on a wide window", page.right<=panel.left && page.width>=800, page);
  await p.click('#states [data-s="TX"]'); await p.waitForTimeout(100);
  ok("the page still works with the panel open", (await p.getAttribute('#states [data-s="TX"]',"aria-pressed"))==="true" && await p.isVisible("#askPanel"));
  await p.click("#askWide"); await p.waitForTimeout(120);
  panel=await t.box("#askPanel");
  ok("Wider takes most of the window, with the page still showing at the side", (await t.txt("#askWide"))==="Narrower" && panel.width>=1150 && panel.left>0 && panel.right===1440 && await p.evaluate(()=>document.activeElement.id==="askWide"), panel);
  await p.screenshot({path:OUTDIR+"/ask-panel-wide-empty-1440.png"});
  await p.click("#askWide"); await p.waitForTimeout(120);
  ok("Narrower puts it back", (await t.txt("#askWide"))==="Wider" && (await t.box("#askPanel")).width===480);
  await t.closePanel();
  ok("Close shuts the panel and puts the cursor back on the button", !(await p.$("#askPanel")) && await p.evaluate(()=>document.activeElement.id==="askFab") && same(await t.fab(),{text:"Ask Claude",cls:"",hidden:false,expanded:"false"}) && (await t.box("main .wrap")).right>1300);
  await p.keyboard.press("Enter"); await p.waitForTimeout(120);
  ok("the button works from the keyboard", await p.isVisible("#askPanel") && await p.evaluate(()=>document.activeElement.id==="ask_input"));
  await p.keyboard.press("Escape"); await p.waitForTimeout(120);
  ok("Esc closes the panel and puts the cursor back on the button", !(await p.$("#askPanel")) && await p.evaluate(()=>document.activeElement.id==="askFab"));
  await t.openPanel(); await p.focus("#f_q"); await p.keyboard.press("Escape"); await p.waitForTimeout(120);
  ok("Esc in a box on the page belongs to that box: the panel stays", await p.isVisible("#askPanel"));
  await p.focus('#states [data-s="FL"]'); await p.keyboard.press("Escape"); await p.waitForTimeout(120);
  ok("Esc from elsewhere on the page closes the panel", !(await p.$("#askPanel")));
  await p.setViewportSize({width:1100,height:800}); await t.openPanel();
  panel=await t.box("#askPanel");
  ok("a narrower window: the drawer lies over the page, which still shows beside it", panel.width===480 && panel.left===620 && (await t.box("main .wrap")).right>panel.left && await p.evaluate(()=>getComputedStyle(document.body).paddingRight==="0px") && await t.noScroll(), panel);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  panel=await t.box("#askPanel");
  ok("phone: a full-screen sheet", panel.left===0 && panel.top===0 && panel.width===390 && panel.height===844 && !(await p.isVisible("#askWide")) && await p.isVisible("#askClose"), panel);
  ok("phone: neither the page nor the sheet scrolls sideways", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/ask-panel-empty-390.png"});
  await t.closePanel();
  ok("phone: the button is back, inside the screen", await p.evaluate(()=>{ const r=document.getElementById("askFab").getBoundingClientRect(); return r.left>=0 && Math.round(innerWidth-r.right)===16; }) && await t.noScroll());
  await p.setViewportSize({width:1440,height:900});
  await p.click('nav.tabs a[data-view="statutory"]'); await p.waitForTimeout(400);
  ok("the button is on Statutory too", same(await t.fab(),{text:"Ask Claude",cls:"",hidden:false,expanded:"false"}) && (await t.txt(".action-title"))==="Statutory financials by NAIC company or group");
  await t.openPanel();
  ok("and opens the same panel there", await p.isVisible("#askPanel") && await p.isVisible("#statForm"));
  await t.ctx.close();

  t=await open(); p=t.p;
  // ----- before asking -----
  ok("says what Claude sees", (await t.txt("#askSees"))==="Claude sees only your question, a short description of what is on this screen, and what S&P returns for it: nothing else from this site or from Ascot. Check figures against the source before you use them.");
  ok("a hint for the first question, and no conversation yet", (await t.txt("#askHint")).startsWith("For example:") && !(await p.$("#askLog")) && !(await p.$('button[data-act="ask-new"]')) && (await p.getAttribute("#ask_input","maxlength"))==="4000");
  ok("nothing on screen: says Claude starts from the question alone, and offers no starting points", (await t.txt("#askTold"))==="Nothing is on screen yet, so Claude starts from your question alone." && !(await p.$("#askSuggest")));
  await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(100);
  ok("empty question refused", (await t.txt("#toastRoot"))==="Type a question first." && t.of("ask").length===0);
  await p.evaluate(()=>{ S.ask.draft="x".repeat(4001); askQuestion(); }); await p.waitForTimeout(100);
  ok("an over-long question refused", (await t.txt("#toastRoot"))==="Keep the question under 4,000 characters." && t.of("ask").length===0);
  await p.evaluate(()=>{ S.ask.draft=""; render(); });

  // ----- asking -----
  t.delay=400; await p.fill("#ask_input",Q1); await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(150);
  ok("the question shows at once, with a waiting line", (await t.txt(".ccmsg.u"))===Q1 && (await t.txt(".ccmsg.run")).startsWith("Sending your question…") && (await p.inputValue("#ask_input"))==="");
  ok("says to keep the tab open", (await t.txt(".ccmsg.run")).includes("Keep this tab open until the answer finishes."));
  ok("Ask waits while an answer runs", await p.isDisabled('button[data-act="ask-send"]') && (await t.txt('button[data-act="ask-send"]'))==="Answering…");
  await p.waitForTimeout(500); t.delay=0;
  const a0=t.of("ask")[0];
  ok("nothing on screen: sends the question alone, with the login's token and the publishable key", same(a0.body,{action:"ask",question:Q1}) && !("screen" in a0.body) && a0.fn==="snl-chat" && a0.auth==="Bearer t" && a0.apikey==="sb_publishable_k", a0);
  ok("and the question carries no note about the screen", !(await p.$(".turn .told")));
  ok("accepted: waiting to start", (await t.txt(".ccmsg.run")).startsWith("Waiting to start…"));
  ok("the page reads the job row itself", (await p.evaluate(()=>__mock.jobReads))>0 && t.of("continue").length===0);

  // ----- following the answer -----
  await t.job("job-1",{status:"queued", question:Q1});
  ok("queued: still waiting", (await t.txt(".ccmsg.run")).startsWith("Waiting to start…") && !(await p.$(".steps")));
  await t.job("job-1",{status:"running", progress:[JOB.progress[0], {at:"2026-11-13T12:00:21Z", text:'Reading filing <img src=x onerror="window.__xss=1"> (42 pages)'}]});
  ok("running: each step in plain English, with the time", (await t.txt(".ccmsg.run")).startsWith("Claude is working on this.") && same(await t.all(".steps li"),["Searching S&P filings: 3 companies, FL, 2021 to 202612:00",'Reading filing <img src=x onerror="window.__xss=1"> (42 pages)12:00']), await t.all(".steps li"));
  ok("a hostile step shows as text", !(await p.$(".steps img")) && await p.evaluate(()=>window.__xss===undefined));
  await t.job("job-1",{progress:JOB.progress.slice(0,3), partial:"**Yes.** Calloway uses separate forms.\n- First point <script>window.__xss=1</script>"});
  ok("the answer so far shows under the steps", (await p.$$(".steps li")).length===3 && (await t.txt(".partial b"))==="Yes." && (await t.txt(".partial li"))==="First point <script>window.__xss=1</script>" && !(await p.$(".partial script")));
  await p.fill("#ask_input","half-typed follow-up"); await p.focus("#ask_input");
  await t.job("job-1",{progress:JOB.progress});
  ok("typing a follow-up survives the live updates", (await p.$$(".steps li")).length===4 && (await p.inputValue("#ask_input"))==="half-typed follow-up" && await p.evaluate(()=>document.activeElement.id==="ask_input"));
  await p.press("#ask_input","Enter"); await p.waitForTimeout(150);
  ok("a second question can't start while one runs", t.of("ask").length===1 && (await p.inputValue("#ask_input"))==="half-typed follow-up");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll while an answer runs", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/ask-running-390.png"});
  await p.setViewportSize({width:1440,height:900});
  await p.screenshot({path:OUTDIR+"/ask-running-1440.png"});

  // ----- paused, and gone quiet: ask the function to pick the answer up again -----
  await t.job("job-1",{status:"paused"}); await p.waitForTimeout(500);
  ok("paused: continue called once, and polling goes on", same(t.of("continue").map(c=>c.body),[{action:"continue",jobId:"job-1"}]) && t.of("continue")[0].fn==="snl-chat" && t.of("continue")[0].auth==="Bearer t" && (await t.txt(".ccmsg.run")).startsWith("Claude is picking this up again."), t.of("continue").map(c=>c.body));
  const reads=await p.evaluate(()=>__mock.jobReads); await p.waitForTimeout(300);
  ok("still polling while paused", (await p.evaluate(()=>__mock.jobReads))>reads);
  await t.job("job-1",{status:"running", heartbeat_at:new Date(NOW-1000).toISOString()}); await p.waitForTimeout(300);
  ok("running with a fresh heartbeat: left alone", t.of("continue").length===1);
  await t.job("job-1",{heartbeat_at:new Date(NOW-60000).toISOString()}); await p.waitForTimeout(300);
  ok("quiet, but continue was sent under 30 seconds ago: not sent again", t.of("continue").length===1);
  await p.clock.setFixedTime(new Date(NOW+31000)); await p.waitForTimeout(400);
  ok("quiet for over 45 seconds: continue sent", t.of("continue").length===2 && same(t.of("continue")[1].body,{action:"continue",jobId:"job-1"}));
  await p.waitForTimeout(400);
  ok("and at most once in 30 seconds", t.of("continue").length===2);
  await t.job("job-1",{heartbeat_at:new Date(NOW+31000+31000-40000).toISOString()});
  await p.clock.setFixedTime(new Date(NOW+62000)); await p.waitForTimeout(400);
  ok("a heartbeat 40 seconds old is not quiet yet", t.of("continue").length===2);
  t.cont=()=>({status:500, body:{error:"server",message:"The questions function failed: made-up fault"}});
  await t.job("job-1",{status:"paused"}); await p.waitForTimeout(300);
  ok("continue failed: says so and keeps going", t.of("continue").length===3 && (await t.txt(".runnote"))==="Couldn't pick the answer up again: The questions function failed: made-up fault The page will try again shortly.", await t.txt(".runnote"));
  t.cont=body=>({status:202, body:{jobId:body.jobId, resumed:true}});
  await p.evaluate(()=>{ __mock.failJobs=true; }); await p.waitForTimeout(300);
  ok("can't read the job: says so and keeps trying", (await t.txt(".runnote"))==="Couldn't check on the answer just now. Still trying.");
  await p.evaluate(()=>{ __mock.failJobs=false; });
  await t.job("job-1",{status:"running", heartbeat_at:new Date(NOW+62000).toISOString()});
  ok("back in touch: the note goes", !(await p.$(".runnote")) && (await t.txt(".ccmsg.run")).startsWith("Claude is working on this."));

  // ----- the finished answer -----
  const stB=t.of("status").filter(c=>c.fn==="snl-filings").length;
  await t.job("job-1",{status:"done", partial:null, result:RESULT}); await p.waitForTimeout(200);
  ok("status asked again when the answer is done", t.of("status").filter(c=>c.fn==="snl-filings").length===stB+1);
  ok("a finished answer shows from its top, with the question above it", await p.evaluate(()=>{ const b=document.getElementById("askBody").getBoundingClientRect(), q=document.querySelector("#turn-0 .ccmsg.u").getBoundingClientRect(); return q.top>=b.top && q.bottom<=b.bottom; }));
  const ans=await p.$eval(".ccmsg.done .ans",e=>e.innerHTML);
  ok("answer: paragraphs and bullets, bold only where Claude marked it", ans.includes("<p><b>Yes.</b> Calloway uses separate homeowners forms") && (await p.$$(".ans li")).length===2 && (await t.txt(".ans li >> nth=0 >> b"))==="Middle market:", ans.slice(0,300));
  ok("numbered markers after each part, inside its line", same(await t.all(".ans .cite"),["[1]","[2]","[1]","[2]","[3]","[9]"]) && (await p.$$(".ans p .cites")).length===3 && same(await t.all(".ans li .cites"),["[1]","[2]"]));
  ok("bullets that arrive as separate parts read as one list", (await p.$$(".ans ul")).length===1 && same(await p.$eval(".ans",e=>[...e.children].map(c=>c.tagName)),["P","UL","P","P"]));
  ok("a marker with no source listed is plain text, not a link", (await p.$$(".ans button.cite")).length===5 && (await t.txt(".ans span.cite.off"))==="[9]");
  ok("hostile text in the answer shows as text", ans.includes("&lt;script&gt;window.__xss=1&lt;/script&gt;") && !(await p.$(".ccmsg.done script,.ccmsg.done img")) && await p.evaluate(()=>window.__xss===undefined));
  const src=await p.$$eval(".srcs li",l=>l.map(x=>({n:x.value, t1:x.querySelector(".t1").textContent, t2:(x.querySelector(".t2")||{}).textContent, q:(x.querySelector(".quote")||{}).textContent, btn:(x.querySelector("button")||{}).textContent})));
  ok("sources: numbered as cited, with title, company, state, tracking number and pages", same(src.map(s=>s.n),[1,2,3,4]) && src[0].t1==="Homeowners HO-3 middle market policy form" && src[0].t2==="Calloway Insurance Co · FL · CALL-134000001 · pages 3-4" && src[1].t2==="Calloway Home Co · FL · CALL-134000002 · page 7" && src[2].t2==="Tarrow Mutual Insurance Co · FL · TARR-134000777" && src[3].t2==="Calloway <b>Home</b> Co · FL · CALL-134000009 · pages 2, 5", src);
  ok("sources: the quote in small text, and a button for the cited page", src[0].q==="“This form applies to dwellings insured under the Calloway middle market program.”" && src[2].q===undefined && same(src.map(s=>s.btn),["Open at page 3","Open at page 7","Open document","Open at page 2"]) && src[3].t1==="<script>window.__xss=1</script>" && src[3].q==='“<img src=x onerror="window.__xss=1">”', src);
  await p.click(".ans p >> nth=0 >> button.cite >> nth=1"); await p.waitForTimeout(100);
  ok("a marker takes you to its source", await p.evaluate(()=>document.getElementById("src-0-2").classList.contains("hit") && document.querySelectorAll(".srcs li.hit").length===1 && document.activeElement.textContent==="Open at page 7"));
  await p.click("#src-0-1 button"); await p.waitForTimeout(300);
  const dc=t.of("document");
  ok("a source opens the document at the cited page", same(dc.map(c=>c.body),[{action:"document",documentId:880001}]) && dc[0].auth==="Bearer t" && await p.evaluate(()=>/^blob:.+#page=3$/.test(__opened[0].location.href)), await p.evaluate(()=>__opened.map(w=>w.location.href)));
  await p.click("#src-0-1 button"); await p.waitForTimeout(200);
  ok("the same document again costs no second S&P request", t.of("document").length===1 && await p.evaluate(()=>__opened.length===2 && __opened[1].location.href===__opened[0].location.href));
  await p.click("#src-0-3 button"); await p.waitForTimeout(300);
  ok("a source with no document id opens by filing version, at the start", same(t.of("document")[1].body,{action:"document",filingVersionId:"fv-00000004"}) && await p.evaluate(()=>/^blob:[^#]+$/.test(__opened[2].location.href)));
  const tbl=await p.$eval(".anstable",e=>({title:e.querySelector("h3").textContent, head:[...e.querySelectorAll("th")].map(x=>x.textContent), rows:[...e.querySelectorAll("tbody tr")].map(r=>[...r.children].map(c=>c.textContent)), notes:[...e.querySelectorAll(".source")].map(x=>x.textContent)}));
  ok("comparison table: title, columns, rows and notes", tbl.title==="Homeowners form filings in Florida" && same(tbl.head,RESULT.table.columns) && tbl.rows.length===4 && same(tbl.rows[0],RESULT.table.rows[0]) && same(tbl.notes,RESULT.table.notes), tbl);
  ok("table: an empty cell reads n/d, hostile text is text", same(tbl.rows[3],["<script>window.__xss=1</script>","n/d","n/d","Private client","n/d","CALL-134000009"]), tbl.rows[3]);
  const csv=await t.download(()=>p.click('.anstable button[data-fmt="csv"]')); const lines=csv.text.split("\r\n");
  ok("table CSV: the columns, the rows, then the notes", csv.name==="snl-answer-table-2026-11-13.csv" && lines.length===7 && lines[0].slice(1)==='"Company","Form number","Product","Segment","Effective date","Source filing"' && lines[1]==='"Calloway Insurance Co","CAL-HO3-MM (06 25)","Homeowners HO-3","Middle market","1 Jan 2026","CALL-134000001"' && lines[5]==='"","","","","",""' && lines[6].startsWith('"Note: Segment is taken from each form\'s title page.'), lines);
  const xl=await t.download(()=>p.click('.anstable button[data-fmt="xlsx"]')); const wb=JSON.parse(xl.text);
  ok("table XLSX: the same rows, on a sheet named for the table", xl.name==="snl-answer-table-2026-11-13.xlsx" && wb.sheets[0].name==="Homeowners form filings in Flor" && wb.sheets[0].aoa.length===7 && same(wb.sheets[0].aoa[2],RESULT.table.rows[1]), wb.sheets[0]);
  ok("caps show as plain notices", (await p.$eval(".caps",e=>e.innerText.split("\n").filter(Boolean))).join("|")==="Claude stopped at the limit of 12 lookups for one question, so the answer may be incomplete.|<b>Second notice</b>" && (await p.getAttribute(".caps","role"))==="status");
  ok("a small line with the lookups and token counts", (await t.txt(".ccmsg.done .look"))==="Looked up: Filings: 3 companies, FL, 2021 to 2026; CALL-134000001, pages 1 to 10; CALL-134000002, pages 1 to 18; TARR-134000777, pages 1 to 12. This answer cost n/d (48,210 tokens read, 1,432 written) and used 9 S&P requests. Model: claude-example-1.", await t.txt(".ccmsg.done .look"));
  const r2=await p.evaluate(()=>__mock.jobReads), c2=t.of("continue").length; await p.waitForTimeout(400);
  ok("polling stops when the answer is done", (await p.evaluate(()=>__mock.jobReads))===r2 && t.of("continue").length===c2);
  ok("Ask is ready for a follow-up", await p.isEnabled('button[data-act="ask-send"]') && (await p.getAttribute("#ask_input","placeholder"))==="Ask a follow-up question" && await p.isVisible('button[data-act="ask-new"]'));
  ok("no em dashes in the view", !(await p.evaluate(()=>document.body.innerText)).includes("—"));
  await p.$eval("#askBody",e=>{ e.scrollTop=0; });
  await p.screenshot({path:OUTDIR+"/ask-done-1440.png"});
  ok("in the drawer, the table scrolls inside its own box, never the panel or the page", await t.noScroll() && await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth>e.clientWidth));
  await p.$eval(".anstable .tbl-wrap",e=>{ e.scrollLeft=120; }); await p.evaluate(()=>{ S.ask.draft="x"; renderAsk(); });
  ok("the table keeps its place when the panel redraws", (await p.$eval(".anstable .tbl-wrap",e=>e.scrollLeft))===120);
  await p.evaluate(()=>{ S.ask.draft=""; renderAsk(); });
  await p.click("#askWide"); await p.waitForTimeout(150);
  ok("widened, the whole table fits", await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth<=e.clientWidth) && await t.noScroll());
  await p.screenshot({path:OUTDIR+"/ask-done-wide-1440.png"});
  await p.click("#askWide"); await p.waitForTimeout(150);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on a finished answer; the table scrolls inside its own box", await t.noScroll() && await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth>e.clientWidth), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/ask-done-390.png"});
  await p.setViewportSize({width:1440,height:900});

  // ----- follow-up questions carry the conversation -----
  await p.fill("#ask_input","line one"); await p.press("#ask_input","Shift+Enter"); await p.waitForTimeout(100);
  ok("Shift+Enter makes a new line, doesn't send", t.of("ask").length===1 && (await p.inputValue("#ask_input"))==="line one\n");
  await p.fill("#ask_input","And in Georgia?"); await p.press("#ask_input","Enter"); await p.waitForTimeout(250);
  ok("Enter sends; the earlier question and answer go along as text", same(t.of("ask")[1].body,{action:"ask",question:"And in Georgia?",history:[{question:Q1,answer:ANSWER_TEXT}]}), t.of("ask")[1].body);
  await t.job("job-2",{status:"error", error:"Claude couldn't finish: this hour's S&P requests are used up. Try again after the top of the hour."});
  ok("a failed answer: the function's message, in red", (await t.txt(".ccmsg.err[role=alert]"))==="Claude couldn't finish: this hour's S&P requests are used up. Try again after the top of the hour." && await p.isEnabled('button[data-act="ask-send"]'));
  const r3=await p.evaluate(()=>__mock.jobReads); await p.waitForTimeout(300);
  ok("polling stops on an error", (await p.evaluate(()=>__mock.jobReads))===r3);
  await t.say("Third question");
  ok("a failed turn isn't sent as history", same(t.of("ask")[2].body.history,[{question:Q1,answer:ANSWER_TEXT}]));
  await t.job("job-3",{status:"done", result:{answer:[{text:"Nothing more to add.\n", cites:[]}], sources:[], table:null, lookups:[], caps:[], model:"claude-example-1", usage:{inputTokens:1200, outputTokens:null, spRequests:0}}});
  ok("an answer with no table or sources shows neither", (await p.$$(".ccmsg.done")).length===2 && (await p.$$(".anstable")).length===1 && (await p.$$(".srcs")).length===1 && (await t.txt(".ccmsg.done >> nth=1 >> .ans"))==="Nothing more to add." && (await t.txt(".ccmsg.done >> nth=1 >> .look"))==="This answer cost n/d (1,200 tokens read, n/d written) and used 0 S&P requests. Model: claude-example-1.", await t.txt(".ccmsg.done >> nth=1"));
  await t.say("Fourth question");
  await t.job("job-4",{status:"done", result:{answer:[], sources:[], table:null}});
  ok("an empty answer says so", (await t.txt(".ccmsg.done >> nth=2 >> .ans"))==="No answer came back. Try rephrasing the question.");
  await p.evaluate(()=>{ S.ask.turns=Array.from({length:8},(_,i)=>({question:"Q"+i, status:"done", progress:[], partial:"", result:{answer:[{text:"A"+i, cites:[]}]}})); render(); });
  await t.say("Ninth question");
  ok("at most the last six turns go along", same(t.of("ask").pop().body.history,[2,3,4,5,6,7].map(i=>({question:"Q"+i,answer:"A"+i}))), t.of("ask").pop().body.history);

  await p.evaluate(()=>{ S.ask.turns=[{question:"Long one", status:"done", progress:[], partial:"", result:{answer:[{text:"y".repeat(30000), cites:[]}]}}, {question:"Blank one", status:"done", progress:[], partial:"", result:{answer:[]}}]; render(); });
  await t.say("After a long answer");
  ok("a very long earlier answer is cut to what the function accepts; an empty one is left out", (h=>h.length===1 && h[0].question==="Long one" && h[0].answer.length===20000)(t.of("ask").pop().body.history), t.of("ask").pop().body.history.map(h=>[h.question,h.answer.length]));

  // ----- new conversation -----
  const r4=await p.evaluate(()=>__mock.jobReads);
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(350);
  ok("New conversation clears the page and stops following the old answer", !(await p.$("#askLog")) && await p.isVisible("#askHint") && (await p.evaluate(()=>__mock.jobReads))<=r4+1 && await p.isEnabled('button[data-act="ask-send"]'));
  await t.say("Fresh start");
  ok("and the next question carries no history", same(t.of("ask").pop().body,{action:"ask",question:"Fresh start"}));
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(100);

  // ----- problems when asking -----
  t.ask=()=>({status:503, body:{error:"not_configured",message:"Claude isn't connected yet. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6)."}});
  await t.say("Is it set up?");
  ok("Claude not set up: the message as a calm state, and the question kept", (await t.txt(".ask-calm"))==="Claude isn't connected yet. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6)." && !(await p.$("#askLog [role=alert]")) && (await p.inputValue("#ask_input"))==="Is it set up?" && await p.isEnabled('button[data-act="ask-send"]'));
  t.ask=()=>({status:429, body:{error:"busy",message:"Claude is busy. Wait a minute and try again."}});
  await t.say("Busy?");
  ok("Claude busy: the message, in red", (await t.all(".ccmsg.err")).pop()==="Claude is busy. Wait a minute and try again.");
  t.abortAsk=true; await t.say("Offline?");
  ok("no connection: says so plainly", (await t.all(".ccmsg.err")).pop()==="Couldn't reach the questions function. Check your connection and try again.");
  t.abortAsk=false; t.ask=()=>({status:202, body:{}});
  await t.say("No job id?");
  ok("accepted but no job started: says so", (await t.all(".ccmsg.err")).pop()==="The question was sent but no answer was started. Try again.");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with errors showing", await t.noScroll());
  await t.ctx.close();

  // ----- not set up, per the status -----
  t=await open({}, {claude:false}); p=t.p;
  ok("questions not set up: Corp Dev is told what to set", (await t.txt("#askOff"))==="Questions aren't set up yet. Set ANTHROPIC_API_KEY on Supabase and deploy the snl-chat function (see the README)." && (await p.getAttribute("#askOff","role"))==="status");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on the not set up state", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/ask-off-390.png",fullPage:true});
  await t.ctx.close();
  t=await open({role:"reader"}, {claude:false}); p=t.p;
  ok("questions not set up: a reader is told to ask Corp Dev", (await t.txt("#askOff"))==="Questions aren't set up yet. Ask Corp Dev to finish the set-up.");

  // ----- signing out while an answer runs -----
  t.claude=true; await t.say(Q1); await t.job("job-1",{status:"running", progress:JOB.progress});
  ok("a reader can ask too", (await p.$$(".steps li")).length===4);
  await p.evaluate(()=>signOut()); await p.waitForTimeout(300);
  const r5=await p.evaluate(()=>__mock.jobReads); await p.waitForTimeout(350);
  ok("sign out clears the conversation and stops following the answer", await p.evaluate(()=>S.ask.turns.length===0 && !S.ask.timer) && (await p.evaluate(()=>__mock.jobReads))===r5 && (await t.txt(".login h2"))==="Sign in to SNL lookup");
  ok("signed out: no panel and no button", !(await p.$("#askPanel")) && !(await p.$("#askFab")) && await p.evaluate(()=>!document.body.classList.contains("ask-docked")));
  await t.ctx.close();

  // ----- an answer stuck waiting to start is picked up -----
  t=await open(); p=t.p;
  await t.say(Q1); await p.waitForTimeout(300);
  await t.job("job-1",{status:"queued", heartbeat_at:new Date(NOW-1000).toISOString()}); await p.waitForTimeout(300);
  ok("queued with a fresh heartbeat: left alone", t.of("continue").length===0);
  await t.job("job-1",{status:"queued", heartbeat_at:new Date(NOW-60000).toISOString()}); await p.waitForTimeout(400);
  ok("queued but quiet for over 45 seconds: the page asks the function to carry on", t.of("continue").length===1 && same(t.of("continue")[0].body,{action:"continue",jobId:"job-1"}), t.of("continue").map(c=>c.body));
  await t.ctx.close();

  // ----- Claude is told what is on screen: a filings result -----
  const F_SCREEN={view:"filings", search:{companyIds:[4000001,4000002,4000107], institutionIds:[], states:["FL","GA"], from:"2021-01-01", to:"2026-11-13", typeOfInsuranceIds:[101], filingTypeIds:[], filingStatusIds:[]}, total:6, companies:["Calloway Insurance Co","Calloway Home Co","Tarrow Mutual Insurance Co"]};
  const F_TOLD="6 filings for 3 companies in FL, GA, 1 Jan 2021 to 13 Nov.";
  t=await open({}, {}, {panel:false}); p=t.p;
  await t.searchFilings(); await t.openPanel();
  ok("filings on screen: one plain line says what Claude will be told", (await t.txt("#askTold"))==="Claude will be told what is on screen: "+F_TOLD, await t.txt("#askTold"));
  const sug=await t.all("#askSuggest .chip");
  ok("filings on screen: starting points about these filings, in place of the general hint", same(sug,["Which of these are form filings, and what changed in each?","Summarise the rate changes in these filings, company by company.","Which of these filings had the largest rate impact, and what reason was given?"]) && !(await p.$("#askHint")), sug);
  await p.screenshot({path:OUTDIR+"/ask-panel-filings-1440.png"});
  await p.click("#askSuggest .chip >> nth=0"); await p.waitForTimeout(150);
  ok("a starting point fills the question box and doesn't send", (await p.inputValue("#ask_input"))===sug[0] && t.of("ask").length===0 && await p.evaluate(()=>document.activeElement.id==="ask_input") && !(await p.$("#askLog")));
  await p.click('#states [data-s="TX"]'); await p.fill("#f_from","2024-06-01"); await p.waitForTimeout(100);   // the form is edited after the search
  await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(300);
  ok("the request carries the search that produced what is on screen, not the edited form", same(t.of("ask")[0].body,{action:"ask",question:sug[0],screen:F_SCREEN}), t.of("ask")[0].body);
  ok("the question shows what Claude was told", (await t.txt("#turn-0 .told"))==="Claude was told what was on screen: "+F_TOLD);
  ok("starting points go once the conversation has begun", !(await p.$("#askSuggest")));
  await t.job("job-1",{status:"done", result:{answer:[{text:"Two of them are form filings.", cites:[]}], sources:[], table:null}});
  // a follow-up from the same screen carries both the history and the screen
  await t.say("And the rest?");
  ok("a follow-up carries the earlier turn and the screen", same(t.of("ask")[1].body,{action:"ask",question:"And the rest?",history:[{question:sug[0],answer:"Two of them are form filings."}],screen:F_SCREEN}), t.of("ask")[1].body);
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(150);
  // statuses chosen, a company with no name, more than 20 companies, an institution, many states
  t.search=()=>({...copy(SEARCH), params:{...SEARCH.params, institutionIds:[5000001], states:["AL","AK","AZ","AR","CA","CO","CT"], allStatuses:false, filingStatusIds:[1,2]}, total:1234,
    byCompany:[{kind:"companyId",id:1,name:null,rows:0}, ...Array.from({length:25},(_,i)=>({kind:"companyId",id:100+i,name:"Calloway Unit "+(i+1),rows:1})), {kind:"companyId",id:100,name:"Calloway Unit 1",rows:1}]});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("the line counts companies and institutions, and many states as a number", (await t.txt("#askTold"))==="Claude will be told what is on screen: 1,234 filings for 3 companies and 1 institution in 7 states, 1 Jan 2021 to 13 Nov.", await t.txt("#askTold"));
  await t.say("Which statuses?");
  const sc2=t.of("ask").pop().body.screen;
  ok("chosen statuses are sent; unnamed companies are left out; at most 20 names, none twice", same(sc2.search.filingStatusIds,[1,2]) && same(sc2.search.institutionIds,[5000001]) && sc2.total===1234 && sc2.companies.length===20 && sc2.companies[0]==="Calloway Unit 1" && sc2.companies[19]==="Calloway Unit 20" && same(Object.keys(sc2),["view","search","total","companies"]) && same(Object.keys(sc2.search),["companyIds","institutionIds","states","from","to","typeOfInsuranceIds","filingTypeIds","filingStatusIds"]), sc2);
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(150);
  t.search=()=>({...copy(SEARCH), rows:[], total:0, byCompany:[{kind:"companyId",id:4000001,name:null,rows:0}], notes:[]});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("an empty result is still what is on screen", (await t.txt("#askTold"))==="Claude will be told what is on screen: 0 filings for 3 companies in FL, GA, 1 Jan 2021 to 13 Nov." && await p.isVisible("#askSuggest"));
  await t.say("Why nothing?");
  ok("and is sent as such", (s=>s.total===0 && same(s.companies,[]))(t.of("ask").pop().body.screen), t.of("ask").pop().body.screen);
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(150);
  // the view they are on decides: Statutory with no figures yet, though a filings result exists
  await p.click('nav.tabs a[data-view="statutory"]'); await p.waitForTimeout(450);
  ok("on Statutory with no figures yet: nothing is on screen, whatever Filings holds", (await t.txt("#askTold"))==="Nothing is on screen yet, so Claude starts from your question alone." && await p.isVisible("#askHint") && await p.isVisible("#askPanel"));
  await t.say("Anything?");
  ok("so no screen is sent", same(t.of("ask").pop().body,{action:"ask",question:"Anything?"}));
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(150);

  // ----- Claude is told what is on screen: statutory figures -----
  const S_SCREEN={view:"statutory", query:{kind:"company", codes:["90001","90107"], fromYear:2021, toYear:2025}, companies:["Calloway Insurance Co","Tarrow Mutual Insurance Co"]};
  await t.showFigures();
  ok("statutory figures on screen: the line says so", (await t.txt("#askTold"))==="Claude will be told what is on screen: statutory figures for NAIC 90001 and 90107, 2021 to 2025.", await t.txt("#askTold"));
  const sug2=await t.all("#askSuggest .chip");
  ok("statutory figures on screen: starting points about these companies", same(sug2,["How do these companies compare on combined ratio over the period?","Which lines of business grew fastest for these companies?","How has policyholder surplus moved against premiums written?"]), sug2);
  ok("the panel sits beside the figures", (await t.box("#statResults")).right<=(await t.box("#askPanel")).left && await t.noScroll());
  await p.screenshot({path:OUTDIR+"/ask-panel-statutory-1440.png"});
  await p.click("#askSuggest .chip >> nth=1"); await p.waitForTimeout(150); await p.press("#ask_input","Enter"); await p.waitForTimeout(300);
  ok("the request carries the question on screen and its companies", same(t.of("ask").pop().body,{action:"ask",question:sug2[1],screen:S_SCREEN}), t.of("ask").pop().body);
  ok("and the question shows what Claude was told", (await t.txt("#turn-0 .told"))==="Claude was told what was on screen: statutory figures for NAIC 90001 and 90107, 2021 to 2025.");
  const told=await p.evaluate(()=>[askToldText({view:"statutory",query:{kind:"group",codes:["9001"],fromYear:2025,toYear:2025},companies:[]}), askToldText({view:"statutory",query:{kind:"group",codes:["9001","9002","9003"],fromYear:2020,toYear:2025},companies:[]}), askToldText({view:"filings",search:{companyIds:[1],institutionIds:[],states:["FL"],from:"2025-01-01",to:"2025-12-31"},total:1,companies:[]}), askToldText(null), askToldText(null,true)]);
  ok("the line for group codes, one year, one filing, and nothing", same(told,["Claude will be told what is on screen: statutory figures for NAIC group 9001, 2025.","Claude will be told what is on screen: statutory figures for NAIC groups 9001, 9002 and 9003, 2020 to 2025.","Claude will be told what is on screen: 1 filing for 1 company in FL, 1 Jan 2025 to 31 Dec 2025.","Nothing is on screen yet, so Claude starts from your question alone.",""]), told);
  await p.click('nav.tabs a[data-view="filings"]'); await p.waitForTimeout(350);
  ok("back on Filings the line follows the view", (await t.txt("#askTold")).startsWith("Claude will be told what is on screen: 0 filings for 3 companies"));
  await t.ctx.close();
  // statutory not set up: the view has nothing on screen
  t=await open({}, {statStatus:()=>copy(STAT.statusOff)}, {hash:"#statutory"}); p=t.p;
  ok("Statutory not set up: nothing on screen, and the panel still opens there", (await t.txt("#askTold"))==="Nothing is on screen yet, so Claude starts from your question alone." && await p.isVisible("#statOff"));
  await t.ctx.close();

  // ----- the conversation outlives a closed panel and a change of view; the button says what Claude is doing -----
  t=await open({}, {}, {panel:false}); p=t.p;
  await t.searchFilings(); await t.openPanel();
  await t.say(Q1); await t.job("job-1",{status:"running", question:Q1, progress:JOB.progress.slice(0,2)});
  await t.closePanel();
  ok("closed while an answer runs: the button says Claude is working", same(await t.fab(),{text:"Claude is working…",cls:"working",hidden:false,expanded:"false"}), await t.fab());
  await p.locator("#askFab").screenshot({path:OUTDIR+"/ask-button-working.png"});
  await p.screenshot({path:OUTDIR+"/ask-button-working-1440.png"});
  const rA=await p.evaluate(()=>__mock.jobReads); await p.waitForTimeout(350);
  ok("the answer is still followed with the panel closed", (await p.evaluate(()=>__mock.jobReads))>rA);
  await p.click('nav.tabs a[data-view="statutory"]'); await p.waitForTimeout(400);
  const rB=await p.evaluate(()=>__mock.jobReads); await p.waitForTimeout(350);
  ok("and after a change of view", (await t.txt(".action-title"))==="Statutory financials by NAIC company or group" && (await p.evaluate(()=>__mock.jobReads))>rB && (await t.fab()).text==="Claude is working…");
  await t.job("job-1",{status:"paused"}); await p.waitForTimeout(300);
  ok("a paused answer is picked up again with the panel closed", same(t.of("continue").map(c=>c.body),[{action:"continue",jobId:"job-1"}]));
  await t.job("job-1",{status:"running", progress:JOB.progress});
  await t.openPanel();
  ok("reopened mid-answer: the question and every step so far, on the other view", (await t.txt("#turn-0 .ccmsg.u"))===Q1 && (await p.$$(".steps li")).length===4 && (await t.txt(".ccmsg.run")).includes("You can close this panel and carry on working.") && await p.isVisible("#statForm"));
  await t.closePanel();
  const stC=t.of("status").filter(c=>c.fn==="snl-filings").length;
  await t.job("job-1",{status:"done", partial:null, result:JOB.result}); await p.waitForTimeout(250);
  ok("finished while closed: the button says an answer is ready", same(await t.fab(),{text:"Answer ready",cls:"ready",hidden:false,expanded:"false"}) && t.of("status").filter(c=>c.fn==="snl-filings").length===stC+1, await t.fab());
  await p.locator("#askFab").screenshot({path:OUTDIR+"/ask-button-ready.png"});
  await p.click('nav.tabs a[data-view="filings"]'); await p.waitForTimeout(350);
  ok("the mark stays until the answer is looked at", (await t.fab()).text==="Answer ready" && (await p.$$("#resTable tbody tr")).length===6);
  await t.openPanel();
  ok("opening shows the finished answer from its top", (await p.$$(".ccmsg.done")).length===1 && (await p.$$(".anstable tbody tr")).length===3 && await p.evaluate(()=>{ const b=document.getElementById("askBody").getBoundingClientRect(), q=document.querySelector("#turn-0 .ccmsg.u").getBoundingClientRect(); return q.top>=b.top && q.bottom<=b.bottom; }));
  await p.screenshot({path:OUTDIR+"/ask-panel-answer-filings-1440.png"});
  await t.closePanel();
  ok("looked at: the mark is gone", same(await t.fab(),{text:"Ask Claude",cls:"",hidden:false,expanded:"false"}));
  await p.locator("#askFab").screenshot({path:OUTDIR+"/ask-button-idle.png"});
  await t.openPanel(); await t.say("And in Georgia?"); await t.closePanel();
  await t.job("job-2",{status:"error", error:"Claude couldn't finish: this hour's S&P requests are used up."});
  ok("failed while closed: the button says so", same(await t.fab(),{text:"Claude couldn't answer",cls:"failed",hidden:false,expanded:"false"}), await t.fab());
  await p.locator("#askFab").screenshot({path:OUTDIR+"/ask-button-failed.png"});
  await t.openPanel();
  ok("opening shows why, with the earlier answer still above it", (await t.txt(".ccmsg.err"))==="Claude couldn't finish: this hour's S&P requests are used up." && (await p.$$(".ccmsg.done")).length===1 && (await p.$$(".turn")).length===2);
  await t.say("Third"); await t.job("job-3",{status:"done", result:{answer:[{text:"Done in view.", cites:[]}], sources:[], table:null}});
  await t.closePanel();
  ok("an answer that finished in view leaves no mark", (await t.fab()).text==="Ask Claude");
  // the panel leaves the page's own boxes alone: typing in the page while an answer updates
  await t.openPanel(); await t.say("Fourth"); await p.fill("#f_filter","call"); await p.focus("#f_filter");
  await t.job("job-4",{status:"running", progress:JOB.progress.slice(0,1)});
  ok("typing on the page isn't disturbed by the answer updating beside it", (await p.inputValue("#f_filter"))==="call" && await p.evaluate(()=>document.activeElement.id==="f_filter") && (await p.$$(".steps li")).length===1);
  await t.ctx.close();

  // ----- this login already has an answer in progress -----
  const BUSY="You already have an answer in progress. Wait for it to finish, then ask again. If you closed its tab, you can ask again in ten minutes.";
  t=await open({}, {ask:()=>({status:409, body:{error:"busy", message:BUSY, jobId:"job-elsewhere"}})}); p=t.p;
  await t.say("One more?");
  ok("409 busy: the function's message, the question kept, and nothing followed", (await t.txt(".ccmsg.err[role=alert]"))===BUSY && (await p.inputValue("#ask_input"))==="One more?" && await p.isEnabled('button[data-act="ask-send"]') && (await p.evaluate(()=>__mock.jobReads))===0 && (await t.txt('button[data-act="ask-send"]'))==="Ask");
  await t.closePanel(); await p.evaluate(()=>{ S.ask.draft="Again?"; askQuestion(); }); await p.waitForTimeout(300);
  ok("refused while the panel is closed: the button says so", (await t.fab()).text==="Claude couldn't answer");
  await t.ctx.close();

  // ----- a wide table in the phone sheet -----
  const WIDE={answer:[{text:"**Eight columns.** Here is the comparison.", cites:[1]}], sources:[JOB.result.sources[0]],
    table:{title:"Homeowners forms compared", columns:["Company","Form number","Product","Segment","Effective date","Rate impact","Status","Source filing"],
      rows:[["Calloway Insurance Co","CAL-HO3-MM (06 25)","Homeowners HO-3","Middle market","1 Jan 2026","n/d","Approved","CALL-134000001"],["Tarrow Mutual Insurance Co","TMI-HO-01 (01 24)","Homeowners","n/d","1 Mar 2024","(2.4%)","Approved","TARR-134000777"]], notes:["A-very-long-unbroken-note-"+"x".repeat(120)]},
    lookups:[{tool:"search_filings", detail:"Filings: 2 companies, FL, 2021 to 2026"}], caps:[], model:"claude-example-1", usage:{inputTokens:900, outputTokens:120, spRequests:2}};
  t=await open({}, {}, {panel:false}); p=t.p;
  await p.setViewportSize({width:390,height:844}); await t.searchFilings(); await t.openPanel();
  ok("phone, filings on screen: the sheet with starting points fits", await t.noScroll() && (await p.$$("#askSuggest .chip")).length===3 && (await t.box("#askPanel")).width===390);
  await p.screenshot({path:OUTDIR+"/ask-panel-filings-390.png"});
  await t.say("Compare the forms"); await t.job("job-1",{status:"done", result:WIDE}); await p.waitForTimeout(150);
  ok("phone: an 8-column table scrolls inside its own box; the sheet and the page don't scroll sideways", (await p.$$(".anstable th")).length===8 && await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth>e.clientWidth+200) && await t.noScroll(), await p.evaluate(()=>[document.documentElement.scrollWidth, document.getElementById("askBody").scrollWidth, document.getElementById("askBody").clientWidth]));
  ok("phone: the question box and Ask stay on screen under the answer", await p.evaluate(()=>{ const r=document.querySelector('button[data-act="ask-send"]').getBoundingClientRect(); return r.bottom<=innerHeight && r.top>0; }) && (await t.box("#askPanel")).height===844);
  await p.screenshot({path:OUTDIR+"/ask-sheet-answer-390.png"});
  await p.$eval("#askBody",e=>{ e.scrollTop=e.scrollHeight; }); await p.waitForTimeout(80);
  await p.screenshot({path:OUTDIR+"/ask-sheet-answer-foot-390.png"});
  await t.closePanel();
  ok("phone: closed, the page is back with the button", await p.isVisible("#resTable") && (await t.fab()).text==="Ask Claude" && await t.noScroll());
  await p.setViewportSize({width:1440,height:900}); await t.openPanel();
  ok("desktop drawer: the same 8-column table scrolls inside its box", await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth>e.clientWidth) && await t.noScroll());
  await p.click("#askWide"); await p.waitForTimeout(150);
  await p.screenshot({path:OUTDIR+"/ask-panel-wide-1440.png"});
  ok("widened: the table has room, and the page still shows at the side", await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth<=e.clientWidth) && (await t.box("#askPanel")).left>100 && await t.noScroll());
  await t.ctx.close();

  // ----- old links and an old saved view -----
  t=await open({}, {}, {hash:"", panel:false, init:()=>{ try{ localStorage.setItem("snl.view","ask"); }catch{} }}); p=t.p;
  ok("a saved last view of the old Ask tab falls back to Filings", (await t.txt(".action-title"))==="Search rate, rule and form filings" && (await p.getAttribute('nav.tabs a[data-view="filings"]',"aria-current"))==="page" && !(await p.$("#askPanel")) && (await p.evaluate(()=>localStorage.getItem("snl.view")))==="filings");
  await t.ctx.close();
  t=await open({}, {}, {hash:"#ask", panel:false}); p=t.p;
  ok("an old link to the Ask tab opens Filings with the panel open", (await t.txt(".action-title"))==="Search rate, rule and form filings" && await p.isVisible("#askPanel") && (await t.fab()).hidden);
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
