// End to end, against made-up fixtures: one question asked in the Ask Claude panel and followed to its answer,
// comparison table, page citations and export; then, with the panel still open beside it, the same search run by
// hand in the Filings view, where one state returns nothing and the page says so plainly; then a follow-up that
// tells Claude what is on screen. The functions are faked here; the page is the real one.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("web_search.json"), RESOLVE=FIX("web_resolve.json"), JOB=FIX("web_ask_result.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

// The filings S&P "holds" in this story: the two Calloway homeowners forms from the search fixture, and one Tarrow
// homeowners form (the fixture's Tarrow filing, recast as a form filing). All are in Florida; Georgia has none.
const HELD=[SEARCH.rows[0], SEARCH.rows[1], {...SEARCH.rows[3], serffFilingTypeId:11, serffFilingType:"Form", overallRateImpact:null, filingDescription:"Homeowners policy form TMI-HO-01 (01 24) for all customers."}];
const emptyNote=s=>`S&P returned no filings for ${s} in this search. That means none are in S&P's data for these companies, dates and filters. It doesn't prove that none were filed.`;
// A small stand-in for the search function: filters the held filings the way S&P would and writes the notes.
function fakeSearch(body){
  const rows=HELD.filter(r=>body.states.includes(r.serffFilingStateId) && r.companies.some(c=>body.companyIds.includes(c.companyId))
    && (!body.filingTypeIds || body.filingTypeIds.includes(r.serffFilingTypeId)) && (!body.typeOfInsuranceIds || body.typeOfInsuranceIds.includes(r.typeOfInsuranceId))
    && String(r.publishDate).slice(0,10)>=body.from && String(r.publishDate).slice(0,10)<=body.to);
  const byState=body.states.map(s=>({state:s, rows:rows.filter(r=>r.serffFilingStateId===s).length}));
  const byCompany=body.companyIds.map(id=>{ const hit=rows.filter(r=>r.companies.some(c=>c.companyId===id)); return {kind:"companyId", id, name:hit.length?hit[0].companies.find(c=>c.companyId===id).companyName:null, rows:hit.length}; });
  return {params:{...body, action:undefined}, rows, total:rows.length, requests:6, capped:false, byState, byCompany, notes:byState.filter(s=>!s.rows).map(s=>emptyNote(s.state)),
    source:SEARCH.source, fetchedAt:"2026-11-13T12:00:00Z", fromStore:false, saved:true, used:{hour:18,day:46}, limits:{hour:500,day:12000}, account:"trial"};
}
(async()=>{
  const b=await chromium.launch(); const errs=[];
  const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
  await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
  const calls=[]; const of=a=>calls.filter(c=>c.body.action===a); let used=STATUS.filings.used;
  await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
    if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); calls.push({fn, body, auth:req.headers()["authorization"]});
      const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)});
      if(fn==="snl-filings" && body.action==="status") return J(200,{...STATUS, filings:{...STATUS.filings, used}});
      if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
      if(fn==="snl-filings" && body.action==="resolve") return J(200,/calloway/i.test(body.q)?{...RESOLVE,query:body.q}:{query:body.q,matches:[],note:"No saved company matches."});
      if(fn==="snl-filings" && body.action==="search"){ const a=fakeSearch(body); used=a.used; return J(200,a); }
      if(fn==="snl-filings" && body.action==="document") return r.fulfill({status:200,contentType:"application/pdf",headers:{"access-control-allow-origin":"*"},body:"%PDF-1.4 made-up "+(body.documentId||body.filingVersionId)});
      if(fn==="snl-chat" && body.action==="ask") return J(202,{jobId:of("ask").length===1?"job-e2e":"job-e2e-"+of("ask").length});
      if(fn==="snl-chat" && body.action==="continue") return J(202,{jobId:body.jobId,resumed:true});
      return J(400,{error:"bad",message:"Unknown action."}); }
    if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
    if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
    if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
    if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
  await p.addInitScript(()=>{ window.__opened=[]; window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; });
  const txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
  const all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
  const noScroll=async()=>p.evaluate(()=>{ const b=document.getElementById("askBody"); return document.documentElement.scrollWidth<=window.innerWidth && (!b || b.scrollWidth<=b.clientWidth); });
  const job=async(patch,id="job-e2e")=>{ await p.evaluate(([i,pa])=>{ __mock.setJob(i,pa); },[id,patch]); await p.waitForTimeout(280); };
  const download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };

  // ===== 1. the question, in the Ask Claude panel, before anything is on screen =====
  await p.goto(BASE+"#filings"); await p.waitForTimeout(400); await p.evaluate(()=>{ TIMING.poll=100; });
  await p.click("#askFab"); await p.waitForTimeout(150);
  ok("Ask Claude opens beside the Filings view", await p.isVisible("#askPanel") && await p.isVisible("#searchForm") && (await txt("#askTold"))==="Nothing is on screen yet, so Claude starts from your question alone.");
  await p.fill("#ask_input",JOB.question); await p.press("#ask_input","Enter"); await p.waitForTimeout(300);
  ok("the question goes to the questions function, on its own", same(of("ask").map(c=>c.body),[{action:"ask",question:JOB.question}]) && of("ask")[0].fn==="snl-chat" && of("ask")[0].auth==="Bearer t");
  ok("the page waits, and says to keep the tab open", (await txt(".ccmsg.u"))===JOB.question && (await txt(".ccmsg.run")).includes("Keep this tab open until the answer finishes."));
  await job({status:"running", question:JOB.question, progress:JOB.progress.slice(0,1)});
  ok("first step: the search Claude ran", same(await all(".steps li"),["Searching S&P filings: 3 companies, FL, 2021 to 202612:00"]));
  await job({progress:JOB.progress.slice(0,3)});
  ok("then the filings it is reading", (await all(".steps li")).slice(1).join("|")==="Reading filing CALL-134000001 (42 pages)12:00|Reading filing CALL-134000002 (18 pages)12:00");
  await job({status:"paused"}); await p.waitForTimeout(200);
  ok("the function ran out of time: the page asks it to carry on", same(of("continue").map(c=>c.body),[{action:"continue",jobId:"job-e2e"}]));
  await job({status:"running", progress:JOB.progress, partial:JOB.partial});
  ok("the answer starts to appear while Claude is still reading", (await p.$$(".steps li")).length===4 && (await txt(".partial"))==="Yes. Calloway uses separate homeowners forms for its two customer groups in Florida.");
  await job({status:"done", partial:null, result:JOB.result}); await p.waitForTimeout(200);

  const answer=await p.$eval(".ccmsg.done .ans",e=>e.innerText.replace(/\s+/g," ").trim());
  ok("the answer: yes, with one form for each customer group", answer.startsWith("Yes. Calloway uses separate homeowners forms for its two customer groups in Florida. [1][2]") && answer.includes("Middle market: form CAL-HO3-MM (06 25), filed by Calloway Insurance Co, effective 1 Jan 2026. [1]") && answer.includes("Private client: form CAL-HO5-PC (03 25), filed by Calloway Home Co, effective 1 Oct 2025. [2]") && answer.endsWith("Tarrow Mutual Insurance Co files one homeowners form for all customers. [3]"), answer);
  const tbl=await p.$eval(".anstable",e=>({title:e.querySelector("h3").textContent, head:[...e.querySelectorAll("th")].map(x=>x.textContent), rows:[...e.querySelectorAll("tbody tr")].map(r=>[...r.children].map(c=>c.textContent)), notes:[...e.querySelectorAll(".source")].map(x=>x.textContent)}));
  ok("the comparison table: company, form number, product, segment, effective date, source filing", tbl.title==="Homeowners form filings in Florida" && same(tbl.head,["Company","Form number","Product","Segment","Effective date","Source filing"]), tbl.head);
  ok("one row a form; Calloway's two are middle market and private client", same(tbl.rows,[
    ["Calloway Insurance Co","CAL-HO3-MM (06 25)","Homeowners HO-3","Middle market","1 Jan 2026","CALL-134000001"],
    ["Calloway Home Co","CAL-HO5-PC (03 25)","Homeowners HO-5","Private client","1 Oct 2025","CALL-134000002"],
    ["Tarrow Mutual Insurance Co","TMI-HO-01 (01 24)","Homeowners","n/d","1 Mar 2024","TARR-134000777"]]) && same(tbl.notes,["Segment is taken from each form's title page. Tarrow's form doesn't name a segment."]), tbl.rows);
  const src=await p.$$eval(".srcs li",l=>l.map(x=>[x.value, x.querySelector(".t2").textContent, (x.querySelector("button")||{}).textContent]));
  ok("page citations: each source names its filing and pages", same(src,[[1,"Calloway Insurance Co · FL · CALL-134000001 · pages 3-4","Open at page 3"],[2,"Calloway Home Co · FL · CALL-134000002 · page 7","Open at page 7"],[3,"Tarrow Mutual Insurance Co · FL · TARR-134000777","Open document"]]), src);
  ok("the quotes that support the answer are shown", (await all(".srcs .quote")).join("|")==="“This form applies to dwellings insured under the Calloway middle market program.”|“Private client: for dwellings with a replacement cost of $1,500,000 or more.”");
  await p.click(".ans li:last-child button.cite"); await p.waitForTimeout(100);
  ok("a citation leads to its source", await p.evaluate(()=>document.getElementById("src-0-2").classList.contains("hit")));
  await p.click("#src-0-2 button"); await p.waitForTimeout(300);
  await p.click("#src-0-1 button"); await p.waitForTimeout(300);
  ok("each source opens its document at the cited page", same(of("document").map(c=>c.body),[{action:"document",documentId:880002},{action:"document",documentId:880001}]) && await p.evaluate(()=>/^blob:.+#page=7$/.test(__opened[0].location.href) && /^blob:.+#page=3$/.test(__opened[1].location.href)), await p.evaluate(()=>__opened.map(w=>w.location.href)));
  ok("and what opens is the document S&P sent", (await p.evaluate(async()=>await (await fetch(__opened[1].location.href.split("#")[0])).text()))==="%PDF-1.4 made-up 880001");
  const csv=await download(()=>p.click('.anstable button[data-fmt="csv"]'));
  ok("the table exports to CSV as shown, with its note", csv.name==="snl-answer-table-2026-11-13.csv" && csv.text==="﻿"+[
    '"Company","Form number","Product","Segment","Effective date","Source filing"',
    '"Calloway Insurance Co","CAL-HO3-MM (06 25)","Homeowners HO-3","Middle market","1 Jan 2026","CALL-134000001"',
    '"Calloway Home Co","CAL-HO5-PC (03 25)","Homeowners HO-5","Private client","1 Oct 2025","CALL-134000002"',
    '"Tarrow Mutual Insurance Co","TMI-HO-01 (01 24)","Homeowners","n/d","1 Mar 2024","TARR-134000777"',
    '"","","","","",""',
    '"Note: Segment is taken from each form\'s title page. Tarrow\'s form doesn\'t name a segment.","","","","",""'].join("\r\n"), csv.text);
  const xl=await download(()=>p.click('.anstable button[data-fmt="xlsx"]')); const wb=JSON.parse(xl.text);
  ok("and to XLSX", xl.name==="snl-answer-table-2026-11-13.xlsx" && same(wb.sheets[0].aoa.slice(0,4),[JOB.result.table.columns, ...JOB.result.table.rows]));
  ok("what it took is on the page", (await txt(".ccmsg.done .look")).endsWith("This answer cost n/d (48,210 tokens read, 1,432 written) and used 9 S&P requests. Model: claude-example-1."));
  await p.$eval("#askBody",e=>{ e.scrollTop=0; });
  await p.screenshot({path:OUTDIR+"/e2e-ask-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: the answer fills the screen as a sheet, with no sideways scroll", await noScroll() && await p.$eval("#askPanel",e=>{ const r=e.getBoundingClientRect(); return r.left===0 && r.width===390; }), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/e2e-ask-390.png"});
  await p.setViewportSize({width:1440,height:900});

  // ===== 2. the same search by hand, in the Filings view, with the answer still open beside it =====
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  await p.click('#matches li >> nth=0 >> button[data-kind="companyId"]'); await p.waitForTimeout(100);
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  await p.click('#matches li >> nth=1 >> button[data-kind="companyId"]'); await p.waitForTimeout(100);
  await p.fill("#f_q","4000107"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);   // Tarrow isn't saved yet: add it by its S&P id
  await p.click('#byId button >> nth=0'); await p.waitForTimeout(100);
  await p.click('#states [data-s="FL"]'); await p.click('#states [data-s="GA"]');
  await p.fill("#f_from","2021-01-01");
  await p.check('#chk_toi input[data-id="101"]'); await p.check('#chk_ftype input[data-id="11"]');
  await p.click('button[data-act="search"]'); await p.waitForTimeout(500);
  ok("the search: three companies, Florida and Georgia, homeowners forms since 2021", same(of("search")[0].body,{action:"search",companyIds:[4000001,4000002,4000107],institutionIds:[],states:["FL","GA"],from:"2021-01-01",to:"2026-11-13",typeOfInsuranceIds:[101],filingTypeIds:[11]}), of("search")[0].body);
  const rows=await p.$$eval("#resTable tbody tr",trs=>trs.map(tr=>[...tr.children].map(td=>td.innerText.replace(/\s+/g," ").trim())));
  ok("the filings found are the ones the answer cited", same(rows.map(r=>r[8]).sort(),JOB.result.table.rows.map(r=>r[5]).sort()) && rows.every(r=>r[1]==="FL" && r[2]==="Form"), rows.map(r=>r[8]));
  ok("the sub-types show the two customer groups", rows.find(r=>r[8]==="CALL-134000001")[3]==="Homeowners HO-3 middle market" && rows.find(r=>r[8]==="CALL-134000002")[3]==="Homeowners Private client");
  ok("Georgia returned nothing, and the page says so plainly above the results", (await txt("#notes"))==="Read this before you rely on the results"+emptyNote("GA") && same(await all("#byState span"),["FL 3","GA 0"]) && (await txt("#resSummary"))==="3 filings published from 1 Jan 2021 to 13 Nov in FL, GA.", await txt("#notes"));
  ok("the company added by id now has its name", same(await all("#chips .cchip b"),["Calloway Insurance Co","Calloway Home Co","Tarrow Mutual Insurance Co"]));
  ok("the strip shows the requests the search used", (await txt("#s_usage"))==="S&P requests: 18 of 500 this hour, 46 of 12,000 today (trial account)", await txt("#s_usage"));
  const nDocs=of("document").length;
  await p.click('#resTable tbody tr[data-key="vfv-00000001"] button[data-act="open-doc"]'); await p.waitForTimeout(250);
  ok("a document already opened from the answer costs no second S&P request here", of("document").length===nDocs && await p.evaluate(()=>/^blob:[^#]+$/.test(__opened[__opened.length-1].location.href)));
  ok("the answer and the results it rests on are on screen together", (await p.$$(".ccmsg.done")).length===1 && (await p.$$(".anstable tbody tr")).length===3 && await p.isVisible("#resTable") && await p.evaluate(()=>document.getElementById("results").getBoundingClientRect().right<=document.getElementById("askPanel").getBoundingClientRect().left) && await noScroll());
  await p.screenshot({path:OUTDIR+"/e2e-filings-1440.png"});

  // ===== 3. a follow-up, now that the search is on screen =====
  ok("the panel says what Claude will now be told", (await txt("#askTold"))==="Claude will be told what is on screen: 3 filings for 3 companies in FL, GA, 1 Jan 2021 to 13 Nov.", await txt("#askTold"));
  await p.fill("#ask_input","Which of these changed the hurricane deductible?"); await p.press("#ask_input","Enter"); await p.waitForTimeout(300);
  const answerText=JOB.result.answer.map(s=>s.text).join("\n");
  ok("the follow-up carries the first answer and the search on screen", same(of("ask")[1].body,{action:"ask",question:"Which of these changed the hurricane deductible?",history:[{question:JOB.question,answer:answerText}],
    screen:{view:"filings",search:{companyIds:[4000001,4000002,4000107],institutionIds:[],states:["FL","GA"],from:"2021-01-01",to:"2026-11-13",typeOfInsuranceIds:[101],filingTypeIds:[11],filingStatusIds:[]},total:3,companies:["Calloway Insurance Co","Calloway Home Co","Tarrow Mutual Insurance Co"]}}), of("ask")[1].body);
  await job({status:"running", progress:[{at:"2026-11-13T12:05:00Z", text:"Reading filing CALL-134000001 (42 pages)"}]},"job-e2e-2");
  await p.click("#askClose"); await p.waitForTimeout(150);
  ok("closed, the button says Claude is working while the results stay in use", (await txt("#askFab"))==="Claude is working…" && !(await p.$("#askPanel")) && (await p.$$("#resTable tbody tr")).length===3);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: the results fit with no sideways scroll", await noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.setViewportSize({width:1440,height:900});

  // Georgia on its own: nothing comes back, and the page doesn't claim nothing was filed
  await p.click('#states [data-s="FL"]'); await p.click('button[data-act="search"]'); await p.waitForTimeout(500);
  const empty=await txt("#results");
  ok("Georgia alone: no table, the note in its place", same(of("search")[1].body.states,["GA"]) && !(await p.$("#resTable")) && (await txt("#notes"))==="Nothing came back, and that isn't proof that nothing was filed"+emptyNote("GA") && (await txt("#resSummary"))==="S&P returned nothing for filings published from 1 Jan 2021 to 13 Nov in GA.", empty);
  ok("and it never reads as 'no filings exist'", !/no results|no filings (exist|found|were filed)/i.test(empty) && empty.includes("It doesn't prove that none were filed."), empty);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: the empty result fits with no sideways scroll", await noScroll());
  await p.screenshot({path:OUTDIR+"/e2e-filings-empty-390.png",fullPage:true});

  // the follow-up finishes while the panel is closed; opening it shows both answers
  await p.setViewportSize({width:1440,height:900});
  await job({status:"done", result:{answer:[{text:"Only the middle market form did.", cites:[1]}], sources:[JOB.result.sources[0]], table:null, lookups:[], caps:[], model:"claude-example-1", usage:{inputTokens:5200, outputTokens:90, spRequests:1}}},"job-e2e-2");
  ok("the button says the answer is ready", (await txt("#askFab"))==="Answer ready");
  await p.click("#askFab"); await p.waitForTimeout(200);
  ok("opening the panel shows the new answer under the first, and clears the mark", (await p.$$(".ccmsg.done")).length===2 && (await p.$$(".anstable tbody tr")).length===3 && (await txt("#turn-1 .ans"))==="Only the middle market form did. [1]" && (await txt("#turn-1 .told"))==="Claude was told what was on screen: 3 filings for 3 companies in FL, GA, 1 Jan 2021 to 13 Nov.");
  await p.click("#askClose"); await p.waitForTimeout(150);
  ok("and the button is back to Ask Claude", (await txt("#askFab"))==="Ask Claude");

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
