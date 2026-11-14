// Past answers, and an answer that outlives a reload: the Ask Claude panel reads the login's own answers from the
// database. A reload while an answer runs follows it again (continue under the same rules); an answer that ended
// while the page was closed shows as ready; the list of the last 30 days (small columns only, Show more, empty,
// failed); opening a past answer shows every part of it; a follow-up carries it as history; sign-out and a
// different login see only their own; hostile text stays text; and nothing scrolls sideways at 390px.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), JOB=FIX("web_ask_result.json"), STAT=FIX("web_statutory.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const NOW=Date.parse("2026-11-13T12:00:00Z");
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ago=ms=>new Date(NOW-ms).toISOString();
const MIN=60000, DAYMS=86400000;
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
// a snl_jobs row as the snl-chat function writes it
const row=(id, o={})=>["snl_jobs", id, {owner:"u1", status:"done", question:"Question "+id, progress:[], partial:"", result:null, error:null, segments:0,
  created_at:ago(5*MIN), updated_at:ago(4*MIN), heartbeat_at:ago(4*MIN), ...o}];
const answerText=r=>r.answer.map(s=>s.text).join("\n");
(async()=>{
  const b=await chromium.launch(); const errs=[];
  // One browser context per scenario. opts: the made-up database (seed, users, failList). at.seen: the answer the
  // reader has already seen, as the page remembers it; at.panel: open the panel once loaded.
  async function open(opts={}, at={}){
    const {hash="#filings", panel=false, seen=null, ctx:given=null, width=1440}=at;
    const ctx=given||await b.newContext({viewport:{width,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date(NOW));
    const t={p, ctx, calls:[], jobs:0, claude:true,
      ask:()=>({status:202, body:{jobId:"job-new-"+(++t.jobs)}}),
      cont:body=>({status:202, body:{jobId:body.jobId, resumed:true}})};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev", claude:{configured:t.claude}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory" && body.action==="status") return J(200,copy(STAT.statusMapped));
        if(fn==="snl-filings" && body.action==="document") return r.fulfill({status:200,contentType:"application/pdf",headers:{"access-control-allow-origin":"*"},body:"%PDF-1.4 made-up "+(body.documentId||body.filingVersionId)});
        if(fn==="snl-chat" && body.action==="ask"){ const a=t.ask(body); return J(a.status,a.body); }
        if(fn==="snl-chat" && body.action==="continue"){ const a=t.cont(body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(([o,seen])=>{ window.__opts=o; window.__opened=[];
      if(seen!==null){ try{ localStorage.setItem("snl.seenAnswer", seen); }catch{} }
      window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; },[opts, seen]);
    await p.goto(BASE+hash); await p.waitForTimeout(450);
    await p.evaluate(()=>{ TIMING.poll=100; if(S.ask.timer) schedulePoll(); });   // check ten times a second from now on
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>{ const b=document.getElementById("askBody"); return document.documentElement.scrollWidth<=window.innerWidth && (!b || b.scrollWidth<=b.clientWidth); });
    t.openPanel=async()=>{ await p.click("#askFab"); await p.waitForTimeout(150); };
    t.closePanel=async()=>{ await p.click("#askClose"); await p.waitForTimeout(120); };
    t.fab=async()=>p.$eval("#askFab",e=>({text:e.textContent.trim(), cls:e.className.replace("askfab","").trim()}));
    t.of=a=>t.calls.filter(c=>c.body.action===a);
    t.job=async(id,patch)=>{ await p.evaluate(([i,pa])=>{ __mock.setJob(i,pa); },[id,patch]); await p.waitForTimeout(280); };
    t.say=async q=>{ await p.fill("#ask_input",q); await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(250); };
    t.mock=async f=>p.evaluate(f);
    t.listQ=async()=>p.evaluate(()=>__mock.jobQueries.filter(q=>!q.eqs.some(e=>e[0]==="id")));
    t.idQ=async()=>p.evaluate(()=>__mock.jobQueries.filter(q=>q.eqs.some(e=>e[0]==="id")));
    t.seen=async()=>p.evaluate(()=>{ try{ return localStorage.getItem("snl.seenAnswer"); }catch{ return "x"; } });
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    if(panel) await t.openPanel();
    return t;
  }
  const Q1=JOB.question;
  const HOSTILE='<img src=x onerror="window.__xss=1"><script>window.__xss=1</script> Which forms?';

  // ----- reloaded while an answer is running: followed again -----
  let t=await open({seed:[row("job-r",{status:"running", question:Q1, progress:JOB.progress.slice(0,2), partial:"**So far:** two forms found.", heartbeat_at:ago(2000), result:null})]});
  let p=t.p;
  ok("running answer: the button shows Claude working, straight after the reload", same(await t.fab(),{text:"Claude is working…",cls:"working"}), await t.fab());
  ok("and the page reads the job row by id", (await t.idQ()).some(q=>same(q.eqs.find(e=>e[0]==="id"),["id","job-r"])));
  ok("a fresh heartbeat: the function is left alone", t.of("continue").length===0);
  await t.openPanel();
  ok("opened: the question, the steps so far and the text so far", (await t.txt("#turn-0 .ccmsg.u"))===Q1 && (await p.$$(".steps li")).length===2 && (await t.txt(".partial b"))==="So far:" && (await t.txt(".ccmsg.run")).startsWith("Claude is working on this."));
  ok("Ask waits while it runs, as before the reload", await p.isDisabled('button[data-act="ask-send"]') && (await t.txt('button[data-act="ask-send"]'))==="Answering…");
  ok("an answer picked up again keeps when it was asked, for the exported answer", await p.evaluate(()=>{ const t=S.ask.turns[0]; return !!t && !t.saved && !Number.isNaN(Date.parse(t.asked)); }));
  ok("no saved-answer label on an answer picked up again, and no list over it", !(await p.$(".turn .asked")) && !(await p.$("#askPast")));
  await t.job("job-r",{progress:JOB.progress.slice(0,3)});
  ok("new steps keep arriving", (await p.$$(".steps li")).length===3);
  await t.job("job-r",{status:"paused"}); await p.waitForTimeout(300);
  ok("paused: continue sent once for this answer", same(t.of("continue").map(c=>c.body),[{action:"continue",jobId:"job-r"}]) && t.of("continue")[0].auth==="Bearer t" && (await t.txt(".ccmsg.run")).startsWith("Claude is picking this up again."), t.of("continue").map(c=>c.body));
  await t.job("job-r",{status:"running", heartbeat_at:new Date(NOW-60000).toISOString()}); await p.waitForTimeout(300);
  ok("quiet, but continue went under 30 seconds ago: not again", t.of("continue").length===1);
  await p.clock.setFixedTime(new Date(NOW+31000)); await p.waitForTimeout(400);
  ok("quiet for over 45 seconds: continue sent again", t.of("continue").length===2);
  await t.closePanel();
  await t.job("job-r",{status:"done", partial:"", result:JOB.result}); await p.waitForTimeout(200);
  ok("finished with the panel closed: Answer ready", same(await t.fab(),{text:"Answer ready",cls:"ready"}));
  await t.openPanel();
  ok("opened: the finished answer, and it now counts as seen", (await p.$$(".ccmsg.done")).length===1 && (await p.$$(".anstable tbody tr")).length===3 && (await t.seen())==="job-r");
  const r1=await t.mock(()=>__mock.jobReads); await p.waitForTimeout(350);
  ok("polling stops when it is done", (await t.mock(()=>__mock.jobReads))===r1);
  await t.ctx.close();

  // a paused answer, and one gone quiet, are picked up at once after the reload
  t=await open({seed:[row("job-p",{status:"paused", question:"Paused one", heartbeat_at:ago(20000)})]}); p=t.p;
  ok("reloaded on a paused answer: continue sent straight away", same(t.of("continue").map(c=>c.body),[{action:"continue",jobId:"job-p"}]) && (await t.fab()).text==="Claude is working…", t.of("continue").map(c=>c.body));
  await t.ctx.close();
  t=await open({seed:[row("job-q",{status:"running", question:"Quiet one", heartbeat_at:ago(90000)})]}); p=t.p;
  ok("reloaded on a quiet answer: continue sent straight away", same(t.of("continue").map(c=>c.body),[{action:"continue",jobId:"job-q"}]), t.of("continue").map(c=>c.body));
  await p.waitForTimeout(400);
  ok("and not again within 30 seconds", t.of("continue").length===1);
  await t.ctx.close();
  t=await open({seed:[row("job-w",{status:"queued", question:"Waiting one", heartbeat_at:ago(1000)})]}, {panel:true}); p=t.p;
  ok("reloaded on a queued answer: waiting to start, followed", (await t.txt(".ccmsg.run")).startsWith("Waiting to start…") && t.of("continue").length===0);
  await p.fill("#ask_input","Another?"); await p.press("#ask_input","Enter"); await p.waitForTimeout(200);
  ok("no second question while it is going", t.of("ask").length===0 && await p.isDisabled('button[data-act="ask-send"]'));
  await t.ctx.close();

  // ----- finished while the page was closed -----
  const RESULT=copy(JOB.result);
  t=await open({seed:[row("job-old",{created_at:ago(3*DAYMS), result:{answer:[{text:"Old answer.",cites:[]}]}}), row("job-d",{question:Q1, result:RESULT})]}); p=t.p;
  ok("finished unseen: Answer ready after the reload", same(await t.fab(),{text:"Answer ready",cls:"ready"}) && t.of("continue").length===0, await t.fab());
  ok("the list never asks for the answer column; the finished one is fetched whole only to show it", (await t.listQ()).every(q=>!q.cols.split(",").includes("result") && q.cols!=="*") && (await t.idQ()).length===1 && (await t.idQ())[0].cols.split(",").includes("result"), await t.listQ());
  ok("not yet seen", (await t.seen())===null);
  await t.openPanel();
  ok("opening shows that answer, from its top", (await t.txt("#turn-0 .ccmsg.u"))===Q1 && (await p.$$(".ccmsg.done")).length===1 && same(await t.all(".srcs li .t1"),RESULT.sources.map(s=>s.title)) && (await t.seen())==="job-d");
  await t.closePanel();
  ok("looked at: the mark is gone", (await t.fab()).text==="Ask Claude");
  await p.reload(); await p.waitForTimeout(450);
  ok("reloaded again: already seen, so no mark", same(await t.fab(),{text:"Ask Claude",cls:""}) && await p.evaluate(()=>S.ask.turns.length===0));
  await t.openPanel();
  ok("and the panel opens on the past answers", (await p.$$("#pastList li")).length===2 && !(await p.$("#askLog")));
  await t.ctx.close();
  // already open on load (an old #ask link): shown at once and counted as seen
  t=await open({seed:[row("job-d",{question:Q1, result:RESULT})]}, {hash:"#ask"}); p=t.p;
  ok("panel open at load: the unseen answer shows at once", (await p.$$(".ccmsg.done")).length===1 && (await t.seen())==="job-d");
  await t.ctx.close();
  // stopped while the page was closed
  t=await open({seed:[row("job-e",{status:"error", question:"Failed one", error:"This answer stopped before it finished. Ask the question again."})]}); p=t.p;
  ok("stopped unseen: the button says Claude couldn't answer", same(await t.fab(),{text:"Claude couldn't answer",cls:"failed"}));
  await t.openPanel();
  ok("opening says why", (await t.txt(".ccmsg.err"))==="This answer stopped before it finished. Ask the question again." && (await t.seen())==="job-e");
  await t.ctx.close();

  // ----- nothing in progress -----
  t=await open({}); p=t.p;
  ok("no answers at all: the plain button, no conversation", same(await t.fab(),{text:"Ask Claude",cls:""}) && await p.evaluate(()=>S.ask.turns.length===0) && t.of("continue").length===0);
  await t.openPanel();
  ok("an empty list says so", (await t.txt("#pastH"))==="Past answers" && (await t.txt("#pastEmpty"))==="No questions in the last 30 days. Your questions and Claude's answers are kept here for 30 days." && await p.isVisible("#askHint"));
  await t.ctx.close();
  t=await open({seed:[row("job-d",{result:RESULT})]}, {seen:"job-d"}); p=t.p;
  ok("the latest answer was seen before: the plain button", same(await t.fab(),{text:"Ask Claude",cls:""}) && await p.evaluate(()=>S.ask.turns.length===0) && (await t.idQ()).length===0);
  await t.ctx.close();

  // ----- the list -----
  const LONGQ="How do the Calloway companies' homeowners forms differ between the middle market and private client programmes in Florida, Georgia and the Carolinas since 2021?";
  const seed=[
    row("job-01",{question:"Latest question", created_at:"2026-11-13T11:00:00Z", result:RESULT}),
    row("job-02",{question:LONGQ, created_at:"2026-11-12T09:30:00Z", status:"error", error:"Claude couldn't finish: this hour's S&P requests are used up. Try again after the top of the hour."}),
    row("job-03",{question:"An older one still going", created_at:"2026-11-10T16:05:00Z", status:"paused"}),
    row("job-04",{question:HOSTILE, created_at:"2026-11-05T14:02:00Z", status:"error", error:'<b>Bad</b> "reason"'}),
    ...Array.from({length:8},(_,i)=>row("job-1"+i,{question:"Earlier question "+(i+1), created_at:new Date(Date.parse("2026-11-04T10:00:00Z")-i*DAYMS).toISOString(), result:{answer:[{text:"Earlier answer "+(i+1), cites:[]}]}})),
    row("job-gone",{question:"Too old to keep", created_at:ago(40*DAYMS)})];
  t=await open({seed}, {seen:"job-01"}); p=t.p;
  await t.openPanel();
  let items=await t.all("#pastList li");
  ok("ten newest first", items.length===10 && items[0].startsWith("Latest question") && items[9].startsWith("Earlier question 6"), items);
  ok("each says when it was asked and how it ended, in plain words", items[0]==="Latest question Asked 13 Nov at 11:00 · Answered" && items[2]==="An older one still going Asked 10 Nov at 16:05 · Still running" && items[1].endsWith("Asked 12 Nov at 09:30 · Stopped: Claude couldn't finish: this hour's S&P requests are used up. Try again after the top of the hour."), items.slice(0,3));
  ok("a long question is shortened", (await t.all("#pastList .pq"))[1]===LONGQ.slice(0,139).trimEnd()+"…" && LONGQ.length>140);
  const lq=(await t.listQ())[0];
  ok("the list asks for the login's own rows from the last 30 days, newest first, without the answer column", lq.cols==="id,status,question,error,created_at,updated_at,heartbeat_at" && same(lq.eqs,[["owner","u1"]]) && lq.gtes[0][0]==="created_at" && lq.gtes[0][1]===ago(30*DAYMS) && same(lq.ord,["created_at",false]) && same(lq.range,[0,10]), lq);
  ok("an answer older than 30 days isn't listed", !(await t.txt("#askPast")).includes("Too old to keep"));
  ok("Show more when there are more", (await t.txt("#pastMore"))==="Show more");
  await p.click("#pastMore"); await p.waitForTimeout(250);
  items=await t.all("#pastList li");
  ok("Show more adds the rest, and goes", items.length===12 && items[11].startsWith("Earlier question 8") && !(await p.$("#pastMore")) && same((await t.listQ()).pop().range,[10,20]), items.length);
  ok("hostile text in a question or a reason stays text", (await p.$$("#askPast img,#askPast script,#askPast b")).length===0 && (await t.all("#pastList .pq"))[3]===HOSTILE && items[3].endsWith('Stopped: <b>Bad</b> "reason"') && await p.evaluate(()=>window.__xss===undefined), items[3]);
  ok("no em dashes", !(await t.txt("#askPast")).includes("—"));
  await p.screenshot({path:OUTDIR+"/history-list-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: the list doesn't scroll sideways", await t.noScroll(), await p.evaluate(()=>[document.documentElement.scrollWidth, document.getElementById("askBody").scrollWidth]));
  await p.$eval("#askPast",e=>e.scrollIntoView());
  await p.screenshot({path:OUTDIR+"/history-list-390.png"});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);

  // ----- opening a past answer -----
  await p.click('#pastList button[data-id="job-01"]'); await p.waitForTimeout(250);
  const oq=(await t.idQ()).pop();
  ok("opening fetches that one row, whole", same(oq.eqs,[["id","job-01"],["owner","u1"]]) && oq.cols.split(",").includes("result"), oq);
  ok("dated, and marked as saved", (await t.txt(".turn .asked"))==="Asked 13 Nov at 11:00. A saved answer. Back to past answers" && (await t.txt("#turn-0 .ccmsg.u"))==="Latest question");
  ok("the answer text with its markers", (await t.txt(".ans p >> nth=0")).startsWith("Yes. Calloway uses separate homeowners forms") && same(await t.all(".ans .cite"),["[1]","[2]","[1]","[2]","[3]"]));
  const src=await p.$$eval(".srcs li",l=>l.map(x=>({t2:(x.querySelector(".t2")||{}).textContent, btn:(x.querySelector("button")||{}).textContent})));
  ok("its sources, each with the cited page", same(src.map(s=>s.btn),["Open at page 3","Open at page 7","Open document"]) && src[0].t2==="Calloway Insurance Co · FL · CALL-134000001 · pages 3-4", src);
  await p.click("#src-0-1 button"); await p.waitForTimeout(300);
  ok("a source opens the document at the cited page", same(t.of("document").map(c=>c.body),[{action:"document",documentId:880001}]) && await p.evaluate(()=>/^blob:.+#page=3$/.test(__opened[0].location.href)));
  const tbl=await p.$eval(".anstable",e=>({title:e.querySelector("h3").textContent, rows:e.querySelectorAll("tbody tr").length}));
  ok("the comparison table", tbl.title===RESULT.table.title && tbl.rows===RESULT.table.rows.length, tbl);
  const csv=await t.download(()=>p.click('.anstable button[data-fmt="csv"]'));
  ok("and its CSV export", csv.name==="snl-answer-table-2026-11-13.csv" && csv.text.split("\r\n")[1].startsWith('"Calloway Insurance Co"'), csv.name);
  const xl=await t.download(()=>p.click('.anstable button[data-fmt="xlsx"]'));
  ok("and its Excel export", xl.name==="snl-answer-table-2026-11-13.xlsx" && JSON.parse(xl.text).sheets[0].aoa[0][0]===RESULT.table.columns[0]);
  ok("the lookups line", (await t.txt(".ccmsg.done .look")).startsWith("Looked up: Filings: 3 companies, FL, 2021 to 2026;"));
  const rO=await t.mock(()=>__mock.jobReads); await p.waitForTimeout(300);
  ok("a finished past answer isn't polled", (await t.mock(()=>__mock.jobReads))===rO && t.of("continue").length===0);
  ok("ready for a follow-up", await p.isEnabled('button[data-act="ask-send"]') && (await p.getAttribute("#ask_input","placeholder"))==="Ask a follow-up question");
  await p.$eval("#askBody",e=>{ e.scrollTop=0; });
  await p.screenshot({path:OUTDIR+"/history-opened-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: an opened past answer doesn't scroll sideways; its table scrolls in its own box", await t.noScroll() && await p.$eval(".anstable .tbl-wrap",e=>e.scrollWidth>e.clientWidth));
  await p.screenshot({path:OUTDIR+"/history-opened-390.png"});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);

  // ----- follow-up from a past answer -----
  await t.say("And in Georgia?");
  ok("the follow-up carries that question and answer as history", same(t.of("ask")[0].body,{action:"ask",question:"And in Georgia?",history:[{question:"Latest question",answer:answerText(RESULT)}]}), t.of("ask")[0].body);
  ok("the saved answer stays above, without the way back while the new one runs", (await p.$$(".turn")).length===2 && !(await p.$(".turn .asked button")) && (await t.txt(".turn .asked")).startsWith("Asked 13 Nov at 11:00."));
  await t.job("job-new-1",{status:"done", result:{answer:[{text:"Georgia has one.",cites:[]}], sources:[], table:null}});
  ok("and the follow-up's answer arrives below it", (await t.txt("#turn-1 .ans"))==="Georgia has one.");

  // ----- New conversation keeps the list -----
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(250);
  ok("New conversation clears the conversation and shows the past answers", !(await p.$("#askLog")) && (await p.$$("#pastList li")).length>=10 && await p.isVisible("#askHint"));

  // opening a stopped one, and the way back
  await p.click('#pastList button[data-id="job-04"]'); await p.waitForTimeout(250);
  ok("a stopped past answer: the question as text and the reason", (await t.txt("#turn-0 .ccmsg.u"))===HOSTILE && (await t.txt(".ccmsg.err"))==='<b>Bad</b> "reason"' && (await p.$$("#askLog img,#askLog script,#askLog b")).length===0 && await p.evaluate(()=>window.__xss===undefined) && (await t.txt(".turn .asked")).startsWith("Asked 5 Nov at 14:02."));
  await p.click(".turn .asked button"); await p.waitForTimeout(250);
  ok("Back to past answers returns to the list", !(await p.$("#askLog")) && await p.isVisible("#pastList"));
  // opening one still going follows it
  await p.click('#pastList button[data-id="job-03"]'); await p.waitForTimeout(350);
  ok("a past answer still going is followed and picked up again", (await t.txt(".ccmsg.run")).length>0 && same(t.of("continue").map(c=>c.body),[{action:"continue",jobId:"job-03"}]) && await p.isDisabled('button[data-act="ask-send"]'), t.of("continue").map(c=>c.body));
  await t.closePanel();
  ok("and the button shows it working", (await t.fab()).text==="Claude is working…");
  await t.ctx.close();

  // a long past answer is cut to what the function accepts, as for any follow-up
  t=await open({seed:[row("job-long",{question:"Long one", result:{answer:[{text:"y".repeat(30000), cites:[]}]}})]}, {seen:"job-long", panel:true}); p=t.p;
  await p.click('#pastList button[data-id="job-long"]'); await p.waitForTimeout(250);
  await t.say("Shorter?");
  ok("a very long past answer goes as history cut to 20,000 characters", (h=>h.length===1 && h[0].question==="Long one" && h[0].answer.length===20000)(t.of("ask")[0].body.history||[]), (t.of("ask")[0]||{}).body);
  await t.ctx.close();

  // ----- the list fails to load -----
  t=await open({seed, failList:true}, {seen:"job-01", panel:true}); p=t.p;
  ok("can't load: says so, with Try again, and nothing else breaks", (await t.txt("#pastErr span"))==="Couldn't load your past answers. Check your connection and try again." && (await t.txt("#pastErr button"))==="Try again" &&(await p.getAttribute("#pastErr","role"))==="alert" && await p.isVisible("#askHint") && (await t.fab()).text==="Ask Claude", [await t.txt("#pastErr"), await t.fab()]);
  await t.mock(()=>{ __mock.failList=false; });
  await p.click('#pastErr button[data-act="past-retry"]'); await p.waitForTimeout(250);
  ok("Try again loads it", !(await p.$("#pastErr")) && (await p.$$("#pastList li")).length===10);
  await t.mock(()=>{ __mock.failList=true; });
  await p.click("#pastMore"); await p.waitForTimeout(250);
  ok("Show more fails: the ten stay, with the problem and Try again", (await p.$$("#pastList li")).length===10 && await p.isVisible("#pastErr") && !(await p.$("#pastMore")));
  await t.mock(()=>{ __mock.failList=false; });
  await p.click('#pastErr button[data-act="past-retry"]'); await p.waitForTimeout(250);
  ok("Try again then loads the rest", (await p.$$("#pastList li")).length===12 && !(await p.$("#pastErr")));
  await p.setViewportSize({width:390,height:844}); await t.mock(()=>{ __mock.failList=true; }); await p.click('button[data-act="ask-new"]').catch(()=>{});
  await p.evaluate(()=>{ S.past.err="Couldn't load your past answers. Check your connection and try again."; renderAsk(); }); await p.waitForTimeout(100);
  ok("phone: the problem doesn't scroll sideways", await t.noScroll());
  await t.ctx.close();

  // ----- sign-out, then another login: only the new login's answers -----
  const users={corpdev2:{id:"u2", display_name:"Corp Dev 2", role:"reader"}};
  const both=[row("a1",{question:"First login's question", created_at:"2026-11-12T10:00:00Z", result:RESULT}),
    row("b1",{owner:"u2", question:"Second login's question", created_at:"2026-11-11T10:00:00Z", result:{answer:[{text:"Second login's answer.",cites:[]}]}}),
    row("b0",{owner:"u2", question:"Second login's older question", created_at:"2026-11-01T10:00:00Z", result:{answer:[{text:"Older.",cites:[]}]}})];
  t=await open({seed:both, users}, {seen:"a1", panel:true}); p=t.p;
  ok("first login: only its own answer", same(await t.all("#pastList .pq"),["First login's question"]));
  await p.click('#pastList button[data-id="a1"]'); await p.waitForTimeout(250);
  await p.evaluate(()=>signOut()); await p.waitForTimeout(300);
  ok("sign-out clears the conversation and the list", await p.evaluate(()=>S.ask.turns.length===0 && S.past.rows===null) && !(await p.$("#askPanel")) && !(await p.$("#askFab")));
  await p.fill("#li_user","corpdev2"); await p.fill("#li_pw","made-up-password"); await p.click("#loginForm button"); await p.waitForTimeout(500);
  ok("the second login's latest unseen answer is the one marked ready", same(await t.fab(),{text:"Answer ready",cls:"ready"}));
  await t.openPanel();
  ok("and opens as theirs", (await t.txt("#turn-0 .ccmsg.u"))==="Second login's question");
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(250);
  ok("the second login's list holds only its own questions", same(await t.all("#pastList .pq"),["Second login's question","Second login's older question"]) && !(await p.evaluate(()=>document.getElementById("askRoot").innerHTML)).includes("First login"));
  const q2=(await t.listQ()).pop();
  ok("read as the second login, for the second login", q2.uid==="u2" && same(q2.eqs,[["owner","u2"]]), q2);
  await p.click('#pastList button[data-id="b0"]'); await p.waitForTimeout(250);
  ok("its own older answer opens", (await t.txt(".ans"))==="Older." );
  await t.say("Follow-up as the second login");
  ok("a follow-up goes with the second login's token", t.of("ask").pop().auth==="Bearer t-u2");
  ok("nothing of the first login is on the page", !(await p.evaluate(()=>document.body.innerHTML)).includes("First login"));
  await t.ctx.close();

  // a sign-out while the list is still loading never shows the old list to the next login
  t=await open({seed:both, users}, {seen:"a1"}); p=t.p;
  await p.evaluate(()=>{ const sb=S.sb, from=sb.from; sb.from=tb=>{ const q=from(tb); if(tb==="snl_jobs"){ const th=q.then; q.then=(res,rej)=>new Promise(r=>setTimeout(r,400)).then(()=>th.call(q,res,rej)); } return q; }; loadPast(false); });
  await p.evaluate(()=>signOut()); await p.waitForTimeout(600);
  ok("a list that arrives after sign-out is dropped", await p.evaluate(()=>S.past.rows===null && !S.session));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
