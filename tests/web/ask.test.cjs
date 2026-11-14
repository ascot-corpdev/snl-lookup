// The Ask view: what the page sends, how it follows a background answer (steps, text so far, paused and quiet
// answers), the finished answer with its citations, sources, table and exports, follow-up questions, and errors.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), JOB=FIX("web_ask_result.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const NOW=Date.parse("2026-11-13T12:00:00Z");
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date(NOW));
    const t={p, ctx, calls:[], jobs:0, delay:0, abortAsk:false, claude:true,
      ask:()=>({status:202, body:{jobId:"job-"+(++t.jobs)}}),
      cont:body=>({status:202, body:{jobId:body.jobId, resumed:true}}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"], apikey:req.headers()["apikey"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev", claude:{configured:t.claude}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
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
    await p.goto(BASE+"#ask"); await p.waitForTimeout(400);
    await p.evaluate(()=>{ TIMING.poll=100; });   // check the job ten times a second instead of every two seconds
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
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

  let t=await open(); let p=t.p;
  // ----- before asking -----
  ok("says what Claude sees", (await t.txt("#askSees"))==="Claude sees only your question and what S&P returns for it: nothing else from this site or from Ascot. Check figures against the source before you use them.");
  ok("a hint for the first question, and no conversation yet", (await t.txt("#askHint")).startsWith("For example:") && !(await p.$("#askLog")) && !(await p.$('button[data-act="ask-new"]')) && (await p.getAttribute("#ask_input","maxlength"))==="4000");
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
  ok("sends the question alone, with the login's token and the publishable key", same(a0.body,{action:"ask",question:Q1}) && a0.fn==="snl-chat" && a0.auth==="Bearer t" && a0.apikey==="sb_publishable_k", a0);
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
  await p.screenshot({path:OUTDIR+"/ask-running-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.screenshot({path:OUTDIR+"/ask-running-1440.png",fullPage:true});

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
  const stB=t.of("status").length;
  await t.job("job-1",{status:"done", partial:null, result:RESULT}); await p.waitForTimeout(200);
  ok("status asked again when the answer is done", t.of("status").length===stB+1);
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
  ok("a small line with the lookups and token counts", (await t.txt(".ccmsg.done .look"))==="Looked up: Filings: 3 companies, FL, 2021 to 2026; CALL-134000001, pages 1 to 10; CALL-134000002, pages 1 to 18; TARR-134000777, pages 1 to 12. 9 S&P requests. Claude read 48,210 tokens and wrote 1,432. Model: claude-example-1.", await t.txt(".ccmsg.done .look"));
  const r2=await p.evaluate(()=>__mock.jobReads), c2=t.of("continue").length; await p.waitForTimeout(400);
  ok("polling stops when the answer is done", (await p.evaluate(()=>__mock.jobReads))===r2 && t.of("continue").length===c2);
  ok("Ask is ready for a follow-up", await p.isEnabled('button[data-act="ask-send"]') && (await p.getAttribute("#ask_input","placeholder"))==="Ask a follow-up question" && await p.isVisible('button[data-act="ask-new"]'));
  ok("no em dashes in the view", !(await p.evaluate(()=>document.body.innerText)).includes("—"));
  await p.screenshot({path:OUTDIR+"/ask-done-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on a finished answer; the table scrolls inside its own box", await t.noScroll() && await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth>e.clientWidth), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/ask-done-390.png",fullPage:true});
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
  ok("an answer with no table or sources shows neither", (await p.$$(".ccmsg.done")).length===2 && (await p.$$(".anstable")).length===1 && (await p.$$(".srcs")).length===1 && (await t.txt(".ccmsg.done >> nth=1 >> .ans"))==="Nothing more to add." && (await t.txt(".ccmsg.done >> nth=1 >> .look"))==="0 S&P requests. Claude read 1,200 tokens and wrote n/d. Model: claude-example-1.", await t.txt(".ccmsg.done >> nth=1"));
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
  await t.ctx.close();

  // ----- an answer stuck waiting to start is picked up -----
  t=await open(); p=t.p;
  await t.say(Q1); await p.waitForTimeout(300);
  await t.job("job-1",{status:"queued", heartbeat_at:new Date(NOW-1000).toISOString()}); await p.waitForTimeout(300);
  ok("queued with a fresh heartbeat: left alone", t.of("continue").length===0);
  await t.job("job-1",{status:"queued", heartbeat_at:new Date(NOW-60000).toISOString()}); await p.waitForTimeout(400);
  ok("queued but quiet for over 45 seconds: the page asks the function to carry on", t.of("continue").length===1 && same(t.of("continue")[0].body,{action:"continue",jobId:"job-1"}), t.of("continue").map(c=>c.body));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
