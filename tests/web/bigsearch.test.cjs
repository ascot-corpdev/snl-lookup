// Searches too big for one function call (big-searches), on the page: a wide search comes in parts and reads as one
// search (progress, one result put together, counts, notes, sorting, paging, exports); Stop and Carry on; a part that
// fails is asked once more, then named, with Try again; an empty part; Refresh; a saved search in parts listed once in
// Recent searches and opened again; the Snapshot view through parts; the plain message when Supabase stops a function,
// on the Filings search and on another call; the page at 1440px and 390px. Every company and filing is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const TOO_BIG="This search was too big for the site to run in one go. Narrow the dates, states or companies, or try again.";
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

// ----- a made-up wide search in three parts, in the shape the function answers -----
const CO=(id,name)=>({companyId:id, companyName:name, naicCompanyCode:null, institutionId:null, spStatEntityId:null});
const row=(i, o={})=>({serffFilingEntityEventId:80000000+i, trackingNumber:null, sfcNumber:"ZZB"+String(1000000+i), companyId:4000001, companyName:"Calloway Insurance Co", serffFilingStateId:i%2?"GA":"FL", serffFilingType:"Rate",
  typeOfInsurance:"Homeowners", filingStatus:"Approved", publishDate:`2026-${String(1+(i%10)).padStart(2,"0")}-0${1+(i%9)}`, overallRateImpact:i%5?null:2.5, filingDescription:null, documentId:72000000+i, filingVersionId:"V-"+i, pages:10,
  companies:[CO(4000001,"Calloway Insurance Co")], ...o});
// part 1: filings 0-79 for the first company; part 2: an empty part; part 3: filings 80-149 for the second company, and
// filing 5 again, naming the second company too (the page adds it to the filing that came in part 1)
const P1=Array.from({length:80},(_,i)=>row(i)), P3=[...Array.from({length:70},(_,i)=>row(80+i,{companyId:4000002, companyName:"Calloway Home Co", companies:[CO(4000002,"Calloway Home Co")]})), row(5,{companyId:4000002, companyName:"Calloway Home Co", companies:[CO(4000002,"Calloway Home Co")]})];
const PARAMS={companyIds:[4000001,4000002], institutionIds:[], states:["FL","GA"], filingStatusIds:[1,2,3,4], typeOfInsuranceIds:[], filingTypeIds:[], spStatEntityIds:[], trackingNumbers:[], from:"2025-11-14", to:"2026-11-13", allStatuses:true};
const FINAL={total:150, byState:[{state:"FL",rows:75},{state:"GA",rows:75}], byCompany:[{kind:"companyId",id:4000001,name:"Calloway Insurance Co",rows:80},{kind:"companyId",id:4000002,name:"Calloway Home Co",rows:71}],
  notes:["A note from the last part, about the whole search."]};
function part(k, fromStore){
  const rows=[P1,[],P3][k-1], more=k<3, so_far=[80,80,150][k-1];
  return {params:PARAMS, rows, total:so_far, requests:k*4, capped:more, byState:more?[]:FINAL.byState, byCompany:more?[]:FINAL.byCompany, notes:more?["This search has more filings than one answer can hold, so it comes in parts and this is part "+k+". Reload the page to get the newest version of the site, which puts the parts together."]:FINAL.notes,
    source:"S&P Global Market Intelligence, SNL Insurance Product Filings", fetchedAt:"2026-11-13T11:00:00Z", fromStore:!!fromStore, saved:!more, part:k, parts:more&&!fromStore?null:3, partsAbout:3, more, cursor:more?{run:(fromStore?"s":"")+"abc123", part:k+1}:null,
    used:{hour:12+k*4, day:40+k*4}, limits:{hour:500, day:12000}, account:"trial"};
}
const parted=(o={})=>body=>{ const k=body.cursor?body.cursor.part:1, f=o.fail&&o.fail(k); return f || {status:200, body:part(k, o.fromStore)}; };

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}, hash="#filings"){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, search:parted(), resolve:null, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const body=JSON.parse(req.postData()||"{}"); t.calls.push({body});
        const J=(status,o,h={})=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*","access-control-expose-headers":"sb-request-id",...h},body:JSON.stringify(o)}).catch(()=>{});
        if(body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve"){ const a=t.resolve ? t.resolve(body) : {status:200, body:{query:body.q, matches:[], note:"No saved company matches."}}; return J(a.status,a.body,a.headers); }
        if(body.action==="search"){ const d=typeof t.delay==="function"?t.delay(body):t.delay; if(d) await new Promise(res=>setTimeout(res,d)); const a=t.search(body); return J(a.status,a.body,a.headers); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+hash); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.body.action===a).map(c=>c.body);
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    // two companies by S&P id, Florida and Georgia, then Search
    t.start=async()=>{ for(const id of ["4000001","4000002"]){ await p.fill("#f_q",id); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click('#byId button >> nth=0'); await p.waitForTimeout(60); }
      for(const s of ["FL","GA"]) await p.click(`#states [data-s="${s}"]`); await p.click('button[data-act="search"]'); };
    return t;
  }

  // ----- a wide search, in three parts, reads as one -----
  let t=await open({}, {delay:300}); let p=t.p;
  await t.start(); await p.waitForTimeout(450);
  ok("while it runs: the search line, how far it has got, and Stop", (await t.txt("#searching")).includes("Searching S&P's filings…") && (await t.txt("#bsProg"))==="1 of about 3 parts, 80 filings so far." && await p.isVisible("#searchStop"), await t.txt("#searching"));
  await p.screenshot({path:OUTDIR+"/bigsearch-progress-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(80);
  ok("phone: the progress line and Stop fit, no sideways scroll", await t.noScroll() && await p.isVisible("#searchStop"));
  await p.screenshot({path:OUTDIR+"/bigsearch-progress-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.waitForTimeout(900);
  const s=t.of("search");
  ok("parts are asked for one at a time: the search, then the same search with each cursor", s.length===3 && !s[0].cursor && same(s[1],{...s[0], cursor:{run:"abc123",part:2}}) && same(s[2],{...s[0], cursor:{run:"abc123",part:3}}), s);
  ok("the reader sees one search: the total, the summary, no progress left", (await t.txt("#resSummary")).startsWith("150 filings published from 14 Nov 2025 to 13 Nov") && !(await p.$("#searching")) && !(await p.$("#bsProg")) && !(await p.$("#incomplete")) && !(await p.$("#capped")), await t.txt("#resSummary"));
  ok("the counts by state and by company are the whole search's", (await t.txt("#byState"))==="By state:FL 75GA 75" && (await t.txt("#byCompany"))==="By company:Calloway Insurance Co 80Calloway Home Co 71", [await t.txt("#byState"), await t.txt("#byCompany")]);
  ok("the notes are the last part's, and no part's own note shows", (await t.txt("#notes")).includes("A note from the last part, about the whole search.") && !(await t.txt("#results")).includes("comes in parts"), await t.txt("#notes"));
  ok("rows from every part are put together, each filing once, the first page of 100 shown", (await t.txt("#resCount"))==="Showing 100 of 150" && (await p.$$("#resTable tbody tr")).length===100, await t.txt("#resCount"));
  ok("a filing that came in two parts is one row listing both companies", (await t.txt('#resTable tr[data-key="vV-5"] .c-co'))==="Calloway Insurance CoCalloway Home Co", await t.txt('#resTable tr[data-key="vV-5"] .c-co'));
  const dates=await p.$$eval("#resTable tbody tr",tr=>tr.map(x=>x.querySelector(".c-dates b:nth-of-type(2)").textContent));
  ok("put together newest first, across parts", dates[0]==="9 Oct" && dates.slice(0,6).every(d=>/Oct/.test(d)), dates.slice(0,8));
  await p.click('button[data-act="more-rows"]'); await p.waitForTimeout(150);
  ok("paging reaches every filing of the whole search", (await p.$$("#resTable tbody tr")).length===150);
  await p.click('button[data-act="fsort"][data-k="company"]'); await p.waitForTimeout(150);
  ok("sorting works on the whole result", (await t.txt("#resTable tbody tr >> nth=0 >> .c-co .t1"))==="Calloway Home Co" || (await t.txt("#resTable tbody tr >> nth=0 >> .c-co .t1"))==="Calloway Insurance Co");
  const csv=await t.download(()=>p.click('button[data-act="export"][data-fmt="csv"]'));
  ok("the export holds all 150 filings", csv.text.trim().split("\n").length===151, csv.text.split("\n").length);
  await p.screenshot({path:OUTDIR+"/bigsearch-result-1440.png"});

  // Refresh: asks afresh on the first call only, the next parts carry on from the cursor
  await p.click('button[data-act="search-refresh"]').catch(()=>{});
  t.search=parted({fromStore:true}); await p.evaluate(()=>runSearch(true)); await p.waitForTimeout(1300);
  const r=t.of("search").slice(-3);
  ok("Refresh sends refresh with the first part only, then the cursors", r[0].refresh===true && !r[0].cursor && !r[1].refresh && r[1].cursor.part===2 && !r[2].refresh && r[2].cursor.part===3, r);
  await t.ctx.close();

  // ----- Stop keeps what arrived; Carry on fetches the rest -----
  t=await open({}, {delay:b=>b.cursor&&b.cursor.part===2?1500:100}); p=t.p;
  await t.start(); await p.waitForTimeout(500);
  await p.click("#searchStop"); await p.waitForTimeout(200);
  ok("Stop: at once, what arrived is shown and said to be incomplete", (await t.txt("#incomplete")).startsWith("You stopped the search. The search was stopped after 1 of about 3 parts, so these results are incomplete. 80 filings arrived and are shown below") && (await p.$$("#resTable tbody tr")).length===80 && (await t.txt("#resSummary")).startsWith("80 filings"), await t.txt("#incomplete"));
  ok("…with no claim about empty states, and Carry on", !(await t.txt("#results")).includes("returned no filings") && (await t.txt("#searchResume"))==="Carry on" && !(await p.$("#notSaved")));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(80);
  ok("phone: the incomplete banner fits, no sideways scroll", await t.noScroll());
  await p.locator("#incomplete").screenshot({path:OUTDIR+"/bigsearch-stopped-390.png"});
  await p.setViewportSize({width:1440,height:900});
  await p.waitForTimeout(1500); const n=t.of("search").length;
  t.delay=50; await p.click("#searchResume"); await p.waitForTimeout(700);
  const c=t.of("search").slice(n);
  ok("Carry on asks for the part it stopped at, then the rest, not part 1 again", c.length===2 && c[0].cursor.part===2 && c[1].cursor.part===3 && !c[0].refresh, c.map(x=>x.cursor));
  ok("…and the whole result shows, complete", (await t.txt("#resSummary")).startsWith("150 filings") && !(await p.$("#incomplete")), await t.txt("#resSummary"));
  await t.ctx.close();

  // Stop before anything came back: nothing is lost, the form is as it was
  t=await open({}, {delay:1500}); p=t.p;
  await t.start(); await p.waitForTimeout(200); const busy=await p.isVisible("#searching"); await p.click("#searchStop"); await p.waitForTimeout(200);
  ok("Stop before the first part: the search ends quietly, nothing shown as an error", busy && !(await p.$("#results .banner")) && (await t.txt("#toastRoot"))==="Search stopped. Nothing had come back yet." && !(await p.isDisabled('button[data-act="search"]')));
  await t.ctx.close();

  // ----- a part that fails: asked once more, then named, with Try again -----
  let fails=0;
  t=await open({}, {search:parted({fail:k=>k===3&&fails++<2 ? {status:502, body:{error:"spgmi_server", message:"S&P had a problem answering. Try again in a few minutes.", requestId:"req-77"}} : null})}); p=t.p;
  await t.start(); await p.waitForTimeout(2600);
  ok("a part that fails is asked for once more before it counts as failed", t.of("search").length===4 && same(t.of("search")[2].cursor, t.of("search")[3].cursor));
  ok("then it says which part failed and why, and that the result is incomplete", (await t.txt("#incomplete")).startsWith("Not all of the search came back. Part 3 of about 3 couldn't be fetched, so these results are incomplete. S&P had a problem answering. Try again in a few minutes. S&P reference: req-77.") && (await t.txt("#searchResume"))==="Try again", await t.txt("#incomplete"));
  ok("…the filings that arrived are shown", (await p.$$("#resTable tbody tr")).length===80);
  await p.click("#searchResume"); await p.waitForTimeout(500);
  ok("Try again fetches the failed part and the result is complete", (await t.txt("#resSummary")).startsWith("150 filings") && !(await p.$("#incomplete")) && t.of("search").slice(-1)[0].cursor.part===3);
  await t.ctx.close();
  let once=0;
  t=await open({}, {search:parted({fail:k=>k===2&&once++<1 ? {status:503, body:{error:"server", message:"Made-up fault."}} : null})}); p=t.p;
  await t.start(); await p.waitForTimeout(2400);
  ok("a part that fails once and then comes back: the search finishes, nothing said", (await t.txt("#resSummary")).startsWith("150 filings") && !(await p.$("#incomplete")) && t.of("search").length===4);
  await t.ctx.close();
  // a refusal is not asked again
  t=await open({}, {search:()=>({status:400, body:{error:"spgmi_bad_request", message:"This search needs at least 70 S&P requests, more than the 60 one search may use."}})}); p=t.p;
  await t.start(); await p.waitForTimeout(500);
  ok("a search refused as too wide is refused once, before anything is asked again", t.of("search").length===1 && (await t.txt("#results .banner")).startsWith("Couldn't run the search. This search needs at least 70 S&P requests"));
  await t.ctx.close();

  // ----- Supabase stops a function -----
  t=await open({}, {search:()=>({status:546, body:{code:"WORKER_LIMIT", message:"Function failed due to not having enough compute resources (please check logs)"}, headers:{"sb-request-id":"01JD-made-up-7"}})}); p=t.p;
  await t.start(); await p.waitForTimeout(2300);
  ok("a stopped function: the plain message, with the request id, after one more try", (await t.txt("#results .banner"))===`Couldn't run the search. ${TOO_BIG} Supabase reference: 01JD-made-up-7.Try again` && t.of("search").length===2, await t.txt("#results .banner"));
  ok("…and never Supabase's own wording", !(await t.txt("#results")).includes("compute resources"));
  t.resolve=()=>({status:546, body:{code:"WORKER_RESOURCE_LIMIT", message:"Function failed due to not having enough compute resources (please check logs)"}});
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(300);
  ok("the same plain message on another call (the company finder), without a reference when none is given", (await t.txt("#searchForm .err"))===TOO_BIG, await t.txt("#searchForm .err"));
  t.resolve=()=>({status:429, body:{error:"spgmi_limit", message:"This hour's S&P requests are used up."}});
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(300);
  ok("other errors read as before", (await t.txt("#searchForm .err"))==="This hour's S&P requests are used up.", await t.txt("#searchForm .err"));
  await t.ctx.close();

  // ----- a saved search in parts: listed once, opened again from the store -----
  const SAVED=[["snl_store","search:big",{kind:"search", label:"FL,GA", fetched_at:"2026-11-12T09:00:00.000Z", doc:{params:PARAMS, total:150, requests:12, capped:false, byState:FINAL.byState, byCompany:FINAL.byCompany, notes:FINAL.notes, source:"S&P", parts:3, run:"abc123"}}],
    ...[1,2,3].map(k=>["snl_store","search:big:"+k,{kind:"search", label:"FL,GA", fetched_at:"2026-11-12T09:00:00.000Z", doc:{unlisted:true, partOf:"search:big", run:"abc123", part:k, rows:[]}}]),
    ["snl_store","search:big:run",{kind:"search", label:"FL,GA", fetched_at:"2026-11-12T09:00:00.000Z", doc:{unlisted:true, progress:true, run:"abc123", parts:3, done:true}}]];
  t=await open({seed:SAVED}, {search:parted({fromStore:true})}); p=t.p;
  await p.click("#recentToggle"); await p.waitForTimeout(400);
  ok("Recent searches lists a search saved in parts once", (await p.$$("#recentList .recent-i")).length===1 && (await t.txt("#recentList .recent-i")).includes("150 filings"), await t.txt("#recentList"));
  await p.click("#recentList .recent-i"); await p.waitForTimeout(800);
  const o=t.of("search");
  ok("opening it sends the search without refresh, then each part's cursor", o.length===3 && !o[0].refresh && o[1].cursor.run==="sabc123" && o[2].cursor.part===3, o.map(x=>x.cursor||null));
  ok("…and it reads as the saved search: every filing, from the last fetch", (await t.txt("#resSummary")).startsWith("150 filings") && (await t.txt("#fromStore")).startsWith("From the last fetch on 13 Nov"), [await t.txt("#resSummary"), await t.txt("#fromStore")]);
  await t.ctx.close();

  // ----- the Snapshot view searches through parts too -----
  t=await open({}, {search:parted(), delay:250, resolve:()=>({status:200, body:{query:"4000001", matches:[{companyName:"Calloway Insurance Co", companyId:"4000001", institutionId:null, naicCompanyCode:null, naicGroupName:null}], note:null}})}, "#snapshot"); p=t.p;
  const before=t.of("search").length;
  await p.evaluate(()=>{ S.snap.pick={kind:"company", name:"Calloway Insurance Co", group:"", ids:[{kind:"companyId", id:"4000001", name:"Calloway Insurance Co"}], noId:0, cut:false}; render(); });
  await p.click("#sn_run"); await p.waitForTimeout(400);
  ok("the Snapshot shows how far a search in parts has got", (await t.txt("#snBusy")).includes("1 of about 3 parts, 80 filings so far."), await t.txt("#snBusy"));
  await p.waitForTimeout(900);
  ok("…and is made from every part", t.of("search").length-before===3 && await p.evaluate(()=>S.snap.res && S.snap.res.rows.length===150 && !S.snap.res.capped), await p.evaluate(()=>S.snap.res&&S.snap.res.rows.length));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
