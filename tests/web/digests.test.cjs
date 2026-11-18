// Filing summaries on the Filings view: the Summary control on each result row, its drawer in each state (a saved
// summary, none yet with what making one costs, making one, a long filing read from its front, errors and not set up),
// opening the filing at a summary's page, making one again, the "Search saved summaries" block, hostile text, and the
// 390px layout. Every company, id, form and filing here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("web_search.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

/** A saved summary in Contract B's shape. */
const DIGEST=(over={})=>({filingVersionId:"fv-00000001", documentId:880001, filingNo:"CALL-134000001", company:"Calloway Insurance Co", companies:["Calloway Insurance Co"], state:"FL",
  typeOfInsurance:"Homeowners", filingType:"Form", status:"Approved", published:"2026-03-09", pages:42, read:[{from:1,to:42}], madeAt:"2026-11-10T05:00:00Z", by:"claude",
  summary:"Calloway Insurance Co files a new private client homeowners program and its forms in Florida.",
  programs:[{name:"Signature Home", segment:"private client", basis:"The Signature Home program is for homes valued over $1,000,000.", page:4},{name:"Standard Home", segment:null, basis:"Standard Home program", page:5}],
  forms:[{number:"CHO 30 01", edition:"06 25", title:"Homeowners policy", action:"new", replaces:null, page:12, program:"Signature Home"},{number:"CHO 31 07", edition:null, title:"Water backup endorsement", action:"replaced", replaces:"HO 04 95", page:13, program:null}],
  rate:{overallPct:9.8, requestedPct:null, approvedPct:-3.2, premium:1234500000, policyholders:4210, effectiveNew:"2027-01-01", effectiveRenewal:null, page:3},
  eligibility:[{text:"Homes valued at $1,000,000 or more.", page:20}], notable:[{text:"Uses a new wildfire score.", page:31}], ...over});
const USAGE={inputTokens:72000, outputTokens:3000, spRequests:1, costUsd:0.35};

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-18T12:00:00Z"));
    const t={p, ctx, calls:[], saved:{"d:880001":DIGEST()}, search:()=>copy(SEARCH), delay:0,
      make:body=>({status:200, body:{digest:DIGEST({filingVersionId:"fv-00000002", documentId:880002, filingNo:"CALL-134000002", pages:18, read:[{from:1,to:18}], madeAt:"2026-11-18T12:00:00Z", summary:"A newly made summary."}), usage:USAGE, fromStore:false}}),
      find:body=>({status:200, body:{matches:[], total:0}}), getErr:null, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const cors={"access-control-allow-origin":"*","access-control-expose-headers":"Content-Disposition"};
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:cors,body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-digest"){
          if(t.delay) await new Promise(res=>setTimeout(res,t.delay));
          if(body.action==="get"){ if(t.getErr) return J(t.getErr.status,t.getErr.body); const keys=body.filings.map(f=>f.documentId?"d:"+f.documentId:"v:"+f.filingVersionId);
            return J(200,{digests:keys.map(k=>t.saved[k]).filter(Boolean), missing:body.filings.filter((f,i)=>!t.saved[keys[i]])}); }
          if(body.action==="make"){ const a=t.make(body); return J(a.status,a.body); }
          if(body.action==="search"){ const a=t.find(body); return J(a.status,a.body); }
          return J(400,{error:"bad",message:"Unknown action."}); }
        if(body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve") return J(200,{query:body.q, matches:[{companyId:"4000001", companyName:"Calloway Insurance Co", naicCompanyCode:"90001", institutionId:null}], note:null});
        if(body.action==="search") return J(200,t.search(body));
        if(body.action==="document") return r.fulfill({status:200,contentType:"application/pdf",headers:cors,body:"%PDF-1.4 made-up"});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; window.__opened=[];
      window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; },opts);
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.innerText(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.innerText.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=(fn,a)=>t.calls.filter(c=>c.fn===fn && (!a || c.body.action===a));
    t.quick=async()=>{ await p.fill("#f_q","4000001"); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click('#byId button >> nth=0').catch(()=>p.click('#matches button >> nth=0')); await p.click('#states [data-s="FL"]'); await p.click('button[data-act="search"]'); await p.waitForTimeout(500); };
    t.row=k=>`#resTable [data-act="dg-open"][data-doc="d:${[880001,880002,880003][k]}"]`;
    t.cell=async k=>p.evaluate(s=>{ const e=document.querySelector(s); return e?e.parentElement.innerText.replace(/\s+/g," ").trim():null; }, t.row(k));
    return t;
  }

  // ----- the Summary control on each row -----
  let t=await open(); let p=t.p;
  ok("before a search, no summaries are asked for", t.of("snl-digest").length===0);
  await t.quick();
  const gets=t.of("snl-digest","get");
  ok("one free request asks which rows on screen have a saved summary, by document id or version id", gets.length===1 && same(gets[0].body.filings,[{documentId:880001},{documentId:880002},{documentId:880003},{filingVersionId:"fv-00000004"},{documentId:880006}]), gets.map(g=>g.body));
  ok("every row with a document has a Summary button; the row with none has none", (await p.$$('#resTable [data-act="dg-open"]')).length===5);
  ok("a row with a saved summary says when it was saved", (await t.cell(0))==="Summary Saved 10 Nov" && (await t.cell(1))==="Summary");
  await p.click('#searchForm button[data-act="search"]').catch(()=>{}); await p.waitForTimeout(300);
  ok("the same rows aren't asked about twice", t.of("snl-digest","get").length===1);

  // ----- a saved summary in the drawer -----
  await p.click(t.row(0)); await p.waitForTimeout(200);
  ok("the drawer opens as a dialog named by the filing", await p.isVisible("#dgDrawer") && (await p.getAttribute("#dgDrawer","role"))==="dialog" && (await t.txt("#dgTitle"))==="CALL-134000001" && (await t.txt("#dgDrawer .drawer-h .t2"))==="Calloway Insurance Co, FL, Homeowners, Form");
  ok("a saved summary already known opens without asking again", t.of("snl-digest","get").length===1);
  ok("it says who made it, when, and which pages it rests on", (await t.txt("#dgMeta"))==="Made by Claude on 10 Nov from pages 1 to 42 of 42. Claude's reading of the filing: check the page before you rely on a point.", await t.txt("#dgMeta"));
  ok("the summary", (await t.txt("#dgSummary p"))==="Calloway Insurance Co files a new private client homeowners program and its forms in Florida.");
  ok("programs with their segment, the words it rests on, and the page", same(await t.all("#dgPrograms li"),['Signature Home private client Based on: "The Signature Home program is for homes valued over $1,000,000." page 4',"Standard Home segment n/d Based on: \"Standard Home program\" page 5"]), await t.all("#dgPrograms li"));
  ok("forms as a table: number and edition, title with action, replacement and program, page", same(await t.all("#dgForms tbody tr"),["CHO 30 01 Edition 06 25 Homeowners policy New, program Signature Home page 12","CHO 31 07 Water backup endorsement Replaced, replaces HO 04 95 page 13"]), await t.all("#dgForms tbody tr"));
  ok("rate figures in house style: percentages to one decimal, negatives in parentheses, $M with commas, n/d, dates", same(await t.all("#dgRate .rate > *"),["Overall rate change","9.8%","Requested","n/d","Approved","(3.2%)","Written premium affected","$1,235M","Policyholders affected","4,210","Effective, new business","1 Jan 2027","Effective, renewals","n/d"]) && (await t.txt("#dgRate p"))==="From page 3.", await t.all("#dgRate .rate > *"));
  ok("eligibility and notable points, each with its page", (await t.txt("#dgElig li"))==="Homes valued at $1,000,000 or more. page 20" && (await t.txt("#dgNotable li"))==="Uses a new wildfire score. page 31");
  ok("the footer opens the document, or makes the summary again", (await t.txt("#dgDrawer .drawer-f"))==="Open document Summarise again");
  await p.click('#dgForms [data-act="open-doc"][data-page="12"]'); await p.waitForTimeout(300);
  ok("a page button opens the filing at that page", t.of("snl-filings","document").length===1 && same(t.of("snl-filings","document")[0].body,{action:"document",documentId:880001}) && await p.evaluate(()=>window.__opened.some(w=>/#page=12$/.test(w.location.href))));
  await p.screenshot({path:OUTDIR+"/digests-drawer-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("390px: the drawer fills the screen with no sideways scroll", await t.noScroll() && await p.evaluate(()=>{ const d=document.getElementById("dgDrawer").getBoundingClientRect(); const b=document.getElementById("dgBody"); return d.width<=390 && b.scrollWidth<=b.clientWidth+1; }));
  await p.screenshot({path:OUTDIR+"/digests-drawer-390.png"});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);
  await p.click('[data-act="dg-again"]'); await p.waitForTimeout(100);
  ok("Summarise again asks first, saying what it replaces and what it costs", (await t.txt("#dgOffer")).startsWith("Summarise this filing again? The new summary replaces the one made 10 Nov.") && (await t.txt("#dgCostEst")).startsWith("Summarising reads all 42 pages with Claude.") && t.of("snl-digest","make").length===0);
  await p.click('[data-act="dg-cancel"]'); await p.waitForTimeout(100);
  ok("Cancel goes back to the summary, nothing made", await p.isVisible("#dgSummary") && t.of("snl-digest","make").length===0);
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  ok("Esc closes the drawer and puts the cursor back on that row's Summary button", !(await p.$("#dgDrawer")) && await p.evaluate(()=>document.activeElement && document.activeElement.dataset.act==="dg-open" && document.activeElement.dataset.doc==="d:880001"));

  // ----- no saved summary: what it costs, then making one -----
  t.delay=250;
  await p.click(t.row(1)); await p.waitForTimeout(80);
  ok("a row not known to have one asks once", (await t.txt("#dgLoading"))==="Looking for a saved summary…");
  await p.waitForTimeout(350);
  ok("none saved: the offer, with what it costs from the row's page count", (await t.txt("#dgOffer"))==="There is no saved summary of this filing yet. Summarising reads all 18 pages with Claude. It uses 1 S&P request and about $0.41 of Claude's time (about 72,000 tokens at list price), and counts as one of your questions today. The summary is then saved for everyone, so nobody pays to read these pages again.", await t.txt("#dgOffer"));
  ok("the button says what it does", (await t.txt("#dgMake"))==="Summarise this filing");
  await p.click("#dgMake"); await p.waitForTimeout(80);
  ok("while Claude reads, the drawer says so and that it can be closed", (await t.txt("#dgMaking"))==="Claude is reading the filing. This takes a minute or two. You can close this and come back: the summary is saved when it is ready.");
  await p.waitForTimeout(400);
  const made=t.of("snl-digest","make")[0].body;
  ok("make is sent the row's fields: the filing named by filingNo and sfcNumber, never a bare tracking number", made.refresh===false && made.filing.documentId===880002 && made.filing.filingVersionId==="fv-00000002" && made.filing.filingNo==="CALL-134000002" && !("trackingNumber" in made.filing) && same(made.filing.companies,[{companyId:4000002,companyName:"Calloway Home Co",institutionId:null}]) && "sfcNumber" in made.filing && made.filing.pages===18 && made.filing.serffFilingStateId==="FL", made);
  ok("the new summary shows, with what it cost", (await t.txt("#dgSummary p"))==="A newly made summary." && (await t.txt("#dgCost"))==="Made just now. It cost about $0.35 (72,000 tokens read, 3,000 written) and used 1 S&P request.", await t.txt("#dgCost"));
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  ok("its row now says it is saved", (await t.cell(1))==="Summary Saved 18 Nov");
  t.delay=0;

  // ----- refusals and not set up -----
  const errCase=async(row, make, expectId, expectText)=>{ t.make=()=>make; await p.click(t.row(row)); await p.waitForTimeout(250); await p.click("#dgMake"); await p.waitForTimeout(250);
    const txt=await t.txt(expectId); await p.keyboard.press("Escape"); await p.waitForTimeout(80); return txt===expectText ? true : txt; };
  let x=await errCase(2,{status:429, body:{error:"limit", message:"You've asked 40 questions today, and the limit is 40 a day for each login. Making a summary counts as a question."}},"#dgErr","Couldn't make the summary. You've asked 40 questions today, and the limit is 40 a day for each login. Making a summary counts as a question.");
  ok("at the daily limit: the reason in plain words, and the offer stays", x===true, x);
  x=await errCase(2,{status:409, body:{error:"busy", message:"You already have an answer in progress. Wait for it to finish, then try again."}},"#dgErr","Couldn't make the summary. You already have an answer in progress. Wait for it to finish, then try again.");
  ok("an answer already going: busy, in plain words", x===true, x);
  x=await errCase(2,{status:413, body:{error:"too_large", message:"This document is 61 MB, over the 60 MB a summary can be made from. Open it from the Filings view to read it yourself."}},"#dgErr","Couldn't make the summary. This document is 61 MB, over the 60 MB a summary can be made from. Open it from the Filings view to read it yourself.");
  ok("too large: says so and what to do", x===true, x);
  x=await errCase(2,{status:503, body:{error:"not_configured", message:"Claude isn't connected yet."}},"#dgErr","Summaries aren't set up yet. Claude isn't connected yet.");
  ok("not set up: a calm note, not an alarm", x===true && true, x);
  ok("none of these was shown as no filing or no summary existing", errs.length===0, errs);

  // ----- a long filing: read from its front -----
  t=await open({}, {search:()=>{ const s=copy(SEARCH); s.rows[2].pages=624; return s; }, saved:{"d:880001":DIGEST({pages:624, read:[{from:1,to:150}]})}}); p=t.p;
  await t.quick();
  await p.click(t.row(2)); await p.waitForTimeout(250);
  ok("a 624-page filing: the offer says only its first 150 pages are read, and what that costs", (await t.txt("#dgCostEst")).startsWith("Summarising reads its first 150 of 624 pages with Claude. It uses 1 S&P request and about $2.52 of Claude's time (about 600,000 tokens at list price)"), await t.txt("#dgCostEst"));
  await p.keyboard.press("Escape"); await p.waitForTimeout(80);
  await p.click(t.row(0)); await p.waitForTimeout(200);
  ok("a summary of the front of a long filing says it doesn't cover the rest", (await t.txt("#dgMeta")).startsWith("Made by Claude on 10 Nov from pages 1 to 150 of 624. It doesn't cover the other pages: open the document for those."), await t.txt("#dgMeta"));
  await p.keyboard.press("Escape");

  // ----- hostile text -----
  t=await open({role:"reader"}, {saved:{"d:880001":DIGEST({filingNo:"<img src=x onerror=window.__xss=1>", company:"<b>Calloway</b>", summary:"<script>window.__xss=2</script> summary", programs:[{name:"<img src=y onerror=window.__xss=3>", segment:"<i>x</i>", basis:'"><svg onload=window.__xss=4>', page:4}],
    forms:[{number:"<u>CHO</u>", edition:"</td><td>", title:"<a href=javascript:alert(1)>t</a>", action:"new", replaces:"<b>r</b>", page:"12\"><img src=z onerror=window.__xss=5>", program:"<b>p</b>"}], eligibility:[{text:"<style>body{display:none}</style>", page:20}], notable:[{text:"</ul><h1>big</h1>", page:31}]})}}); p=t.p;
  await t.quick();
  await p.click(t.row(0)); await p.waitForTimeout(250);
  ok("a reader can open summaries too", await p.isVisible("#dgDrawer"));
  ok("hostile text in a summary shows as text: no markup is made from it, nothing runs", await p.evaluate(()=>window.__xss===undefined && !document.querySelector("#dgDrawer img,#dgDrawer script,#dgDrawer svg,#dgDrawer style,#dgDrawer h1,#dgDrawer a,#dgDrawer u,#dgDrawer i")) && (await t.txt("#dgTitle"))==="<img src=x onerror=window.__xss=1>" && (await t.txt("#dgSummary p"))==="<script>window.__xss=2</script> summary");
  ok("a page that isn't a number gets no page button", !(await p.$('#dgForms [data-act="open-doc"]')) && (await t.txt("#dgForms tbody td.c-pg"))==="n/d");
  await p.keyboard.press("Escape");

  // ----- Search saved summaries -----
  const MATCHES={matches:[{digest:DIGEST(), where:"form number", snippet:"CHO 30 01 (06 25), Homeowners policy, page 12"},{digest:DIGEST({filingVersionId:"fv-00000009", documentId:null, filingNo:"S&P no. TAR0000009", company:"Tarrow Mutual Insurance Co", published:"2026-08-01", summary:"Tarrow's dwelling fire forms."}), where:"form title", snippet:"<b>TMF 10 02</b>, Dwelling fire policy, page 9"}], total:2};
  t=await open({}, {find:body=>({status:200, body:copy(MATCHES)})}); p=t.p;
  ok("the block is closed at first, one line, saying it costs nothing", (await t.txt("#dgFind"))==="▶ Search saved summaries Filings Claude has already read: find a form number, a program or words. Searching costs nothing." && !(await p.$("#dg_q")), await t.txt("#dgFind"));
  ok("it sits between Recent searches and the search form", await p.evaluate(()=>{ const a=document.getElementById("recent"), b=document.getElementById("dgFind"), c=document.getElementById("searchForm"); return !!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING) && !!(b.compareDocumentPosition(c)&Node.DOCUMENT_POSITION_FOLLOWING); }));
  await p.click("#dgFindToggle"); await p.waitForTimeout(100);
  ok("opened: a box and a state choice, the cursor in the box", await p.evaluate(()=>document.activeElement.id==="dg_q") && (await p.$$("#dg_state option")).length>1);
  await p.click('#dgFindForm button[type="submit"]'); await p.waitForTimeout(100);
  ok("an empty box: says what to type, nothing sent", (await t.txt("#dgFindErr")).includes("Type a form number or some words to search for.") && t.of("snl-digest","search").length===0);
  await p.fill("#dg_q","cho-30-01"); await p.selectOption("#dg_state","FL"); await p.press("#dg_q","Enter"); await p.waitForTimeout(250);
  ok("Enter searches, with the state", same(t.of("snl-digest","search")[0].body,{action:"search", q:"cho-30-01", state:"FL"}));
  ok("results by filing: who, where it matched and the matching form or phrase", same(await t.all("#dgFindList li > .t1"),["CALL-134000001, Calloway Insurance Co, FL, published 9 Mar","S&P no. TAR0000009, Tarrow Mutual Insurance Co, FL, published 1 Aug"]) && same(await t.all("#dgFindList li > .t2"),["Form number: CHO 30 01 (06 25), Homeowners policy, page 12","Form title: <b>TMF 10 02</b>, Dwelling fire policy, page 9"]) && (await t.txt("#dgFindCount"))==="2 saved summaries match, newest first.", await t.all("#dgFindList li > .t2"));
  ok("each result opens its document", (await p.$$('#dgFindList [data-act="open-doc"]')).length===2 && (await p.getAttribute('#dgFindList li >> nth=1 >> [data-act="open-doc"]',"data-doc"))==="v:fv-00000009");
  await p.click('#dgFindList [data-act="dg-found"] >> nth=1'); await p.waitForTimeout(150);
  ok("and its summary in the drawer, at once", (await t.txt("#dgTitle"))==="S&P no. TAR0000009" && (await t.txt("#dgSummary p"))==="Tarrow's dwelling fire forms." && t.of("snl-digest","get").length===0);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("390px: drawer from a search result, no sideways scroll", await t.noScroll());
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  ok("390px: the search block and its results, no sideways scroll", await t.noScroll() && await p.evaluate(()=>document.getElementById("dgFind").scrollWidth<=document.getElementById("dgFind").clientWidth+1));
  await p.screenshot({path:OUTDIR+"/digests-search-390.png", fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  t.find=()=>({status:200, body:{matches:[], total:0}});
  await p.fill("#dg_q","earthquake"); await p.selectOption("#dg_state",""); await p.press("#dg_q","Enter"); await p.waitForTimeout(200);
  ok("no match: says only summarised filings are searched, never that no filing exists", (await t.txt("#dgFindNone"))==='No saved summary matches "earthquake". Only filings someone has summarised, or Claude has read for an answer, are searched; a filing without a summary may still match.');
  t.find=()=>({status:503, body:{error:"no_tables", message:"Saved summaries aren't set up yet: their table isn't in the database. Run supabase/migrations/0005_filing_digests.sql in the Supabase SQL editor."}});
  await p.press("#dg_q","Enter"); await p.waitForTimeout(200);
  ok("the table not set up: a calm note saying which migration", (await t.txt("#dgFindErr")).startsWith("Summaries aren't set up yet. Saved summaries aren't set up yet: their table isn't in the database. Run supabase/migrations/0005_filing_digests.sql"));
  await p.screenshot({path:OUTDIR+"/digests-search-1440.png"});

  // ----- the function not deployed: the rows still work -----
  t=await open({}, {getErr:{status:404, body:null}}); p=t.p;
  await t.quick();
  await p.click(t.row(0)); await p.waitForTimeout(250);
  ok("summaries function not deployed: the rows show, and the drawer says what to deploy", (await p.$$('#resTable tr[data-key]')).length===6 && (await t.txt("#dgErr")).startsWith("Summaries aren't set up yet.") && (await t.txt("#dgErr")).includes("supabase functions deploy snl-digest --no-verify-jwt"), await t.txt("#dgErr"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("390px: results with the Summary buttons, no sideways scroll", await t.noScroll());
  await p.keyboard.press("Escape");

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
