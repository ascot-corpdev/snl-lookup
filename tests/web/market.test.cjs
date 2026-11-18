// The market index page at #market: the search (state from the indexed ones, type of insurance, filing type, status,
// dates, words), results as a table of filings and a summary by company, the coverage line always on screen, CSV
// export, opening a document; the index manager for Corp Dev (states indexed, a sweep's cost, start, progress carried
// on while the page is open, pause, carry on, stop, top up, what wasn't covered) and its absence for readers; every
// "not ready" state; hostile text; and the 390px layout. Every company, id and filing here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

const COV=(state,over={})=>({state, from:"2025-11-19", to:"2026-11-18", lastComplete:"2026-11-18T09:05:00Z", companiesCovered:2690, companiesMissed:10, missed:["Nonesuch Carrier No. 10 Co","Nonesuch Carrier No. 11 Co"],
  sentence:`The market index of ${state} holds filings published 19 Nov 2025 to 18 Nov 2026, from a sweep of every company in the app's company list last completed 18 Nov 2026: 2,690 companies covered, 10 not. Companies outside the list aren't in it, so it isn't the whole market.`, filings:812, ...over});
const SWEEP=(over={})=>({id:"sw-1", state:"TX", kind:"sweep", period:"last_12_months", from_date:"2025-11-19", to_date:"2026-11-18", status:"waiting", request:null, trigger:"manual", started_at:"2026-11-18T09:00:00Z", updated_at:"2026-11-18T09:00:40Z",
  finished_at:null, resume_after:null, companies_total:2700, units_total:270, next_unit:0, tries:0, stalls:0, requests:0, rows_found:0, missed:[], message:null, percent:0, companiesMissed:0, ...over});
const COSTS={
  this_year:{minimum:270, estimate:299, words:"About 299 S&P requests (at least 270: 270 batches of up to 10 companies × 1 window of dates, plus extra pages and 2 to sign in): about 6 minutes of S&P time at one request a second, 59.8% of an hour's limit of 500 and 2.5% of a day's limit of 12,000. It fits inside one hour.", refused:null, finishesToday:true},
  last_12_months:{minimum:270, estimate:299, words:"About 299 S&P requests (at least 270: 270 batches of up to 10 companies × 1 window of dates, plus extra pages and 2 to sign in): about 6 minutes of S&P time at one request a second, 59.8% of an hour's limit of 500 and 2.5% of a day's limit of 12,000. It fits inside one hour.", refused:null, finishesToday:true},
  last_3_years:{minimum:810, estimate:893, words:"About 893 S&P requests (at least 810: 270 batches of up to 10 companies × 3 windows of dates, plus extra pages and 2 to sign in): about 17 minutes of S&P time at one request a second, 178.6% of an hour's limit of 500 and 7.4% of a day's limit of 12,000. Leaving 150 requests an hour for people, it runs over about 3 hours.", refused:null, finishesToday:true},
};
const MSTATUS=(over={})=>({configured:true, role:"reader", account:"trial", limits:{hour:500, day:12000}, usage:{hour:12, day:140}, reserves:{hour:150, day:3000}, allowance:8400,
  states:[COV("FL"), COV("GA",{companiesCovered:2700, companiesMissed:0, missed:[], filings:301, sentence:"The market index of GA holds filings published 19 Nov 2025 to 18 Nov 2026, from a sweep of every company in the app's company list last completed 18 Nov 2026: 2,700 companies covered, 0 not. Companies outside the list aren't in it, so it isn't the whole market."})],
  open:null, recent:[SWEEP({id:"sw-0", state:"FL", status:"done", percent:100, message:"Swept FL for filings published 19 Nov 2025 to 18 Nov 2026: 2,700 companies in 270 batches, 301 S&P requests."})],
  index:{rows:1113, bytes:667800, rowLimit:500000}, schedule:{ready:false, topUpDays:7}, ...over});
const CD=(over={})=>MSTATUS({role:"corpdev", companies:{searchable:2700, byCompanyId:0, byInstitutionId:2700, unsearchable:0}, costs:copy(COSTS), topUps:{FL:{from:"2026-11-18", to:"2026-11-25", words:"About 299 S&P requests (at least 270: ...)."}}, ...over});
const ROW=(i,over={})=>({companies:[{companyName:i%2?"Calloway Home Co":"Tarrow Mutual Insurance Co", companyId:null, institutionId:940000+(i%2), naicCompanyCode:null}], serffFilingStateId:"FL",
  typeOfInsurance:"Homeowners", subTypeOfInsurance:null, serffFilingType:i%3?"Rate":"Form", filingStatus:"Approved", dateSubmitted:"2026-01-02", publishDate:`2026-0${1+(i%9)}-1${i%10}`, newBusReqEffDate:null, renewBusReqEffDate:null,
  overallRateImpact:i%3?(i%2?6.5:-2.1):null, dispOverallRateImpact:null, filingDescription:null, trackingNumber:null, sfcNumber:`QQQ${1000000+i}`, documentId:74000000+i, filingVersionId:`0F0F0F0F-0000-4000-8000-${String(i).padStart(12,"0")}`, pages:600, filingNo:`S&P no. QQQ${1000000+i}`, ...over});
const ANSWER=(q,over={})=>{ const rows=Array.from({length:Math.min(q.limit||50, 60-(q.offset||0))},(_,k)=>ROW((q.offset||0)+k+1));
  return {coverage:COV(q.state), query:{state:q.state, from:q.from||"2025-11-19", to:q.to||"2026-11-18", typeOfInsurance:q.typeOfInsurance||null, filingType:q.filingType||null, status:q.status||null, words:[], rateAbove:null, rateBelow:null, group:"rows", limit:q.limit, offset:q.offset||0},
    total:60, withRate:40, rateFilings:40, describedInState:0, filingsInState:812, group:"rows", rows, more:(q.offset||0)+rows.length<60, notes:[], source:"S&P Global Market Intelligence, SNL Insurance Product Filings, swept into the app's market index", ...over}; };
const BYCO=q=>({coverage:COV(q.state), total:60, withRate:40, rateFilings:40, group:"company", groupTotal:2, more:false, notes:[], groups:[
  {name:"Calloway Home Co", companyId:null, institutionId:"940001", filings:30, rateFilings:20, rateMin:6.5, rateMax:6.5, latest:"2026-09-19"},
  {name:"Tarrow Mutual Insurance Co", companyId:null, institutionId:"940000", filings:30, rateFilings:20, rateMin:-2.1, rateMax:-2.1, latest:"2026-09-18"}]});
const TYPES=q=>({coverage:COV(q.state), total:60, group:"type", groupTotal:2, groups:[{name:"Homeowners", filings:50},{name:"Commercial Auto", filings:10}], notes:[]});

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}, hash="#market"){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-18T12:00:00Z"));
    const t={p, ctx, calls:[], status:()=>({status:200, body:opts.role==="reader"?MSTATUS():CD()}), query:q=>({status:200, body:q.group==="company"?BYCO(q):q.group==="type"?TYPES(q):ANSWER(q)}),
      act:(a,body)=>({status:200, body:{message:"Done.", sweep:SWEEP()}}), step:()=>({status:200, body:{step:{ran:true, reason:"waiting", message:"Carrying on.", sweep:SWEEP()}, used:{hour:50,day:200}, limits:{hour:500,day:12000}, account:"trial"}}), stepDelay:0,
      doc:body=>({status:200, type:"application/pdf", raw:"%PDF-1.4 made-up "+(body.documentId||body.filingVersionId)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const cors={"access-control-allow-origin":"*","access-control-expose-headers":"Content-Disposition"};
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:cors,body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-index"){
          if(body.action==="status"){ const a=t.status(); return a.empty ? r.fulfill({status:a.status,body:""}) : J(a.status,a.body); }
          if(body.action==="query"){ const a=t.query(body); return J(a.status,a.body); }
          if(body.action==="continue"){ if(t.stepDelay) await new Promise(res=>setTimeout(res,t.stepDelay)); const a=t.step(); return J(a.status,a.body); }
          const a=t.act(body.action, body); return J(a.status,a.body); }
        if(body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(body.action==="document"){ const a=t.doc(body); return r.fulfill({status:200,contentType:a.type,headers:cors,body:a.raw}); }
        return J(200,{}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; window.__opened=[];
      window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; },opts);
    await p.goto(BASE+hash); await p.waitForTimeout(500);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.icalls=a=>t.calls.filter(c=>c.fn==="snl-index" && c.body.action===a);
    t.queries=g=>t.calls.filter(c=>c.fn==="snl-index" && c.body.action==="query" && (!g || c.body.group===g)).map(c=>c.body);
    return t;
  }

  // ----- a reader: search, results, coverage, by company, export, documents; no manager -----
  let t=await open({role:"reader"}); let p=t.p;
  ok("#market shows the market index, and its tab is the one lit", (await t.txt("#view h2.action-title"))==="Market index" && (await p.getAttribute('nav.tabs a[href="#market"]',"aria-current"))==="page" && (await p.$$('nav.tabs a[aria-current="page"]')).length===1);
  ok("the status is asked once, and the types of insurance for the first state", t.icalls("status").length===1 && same(t.queries("type").map(q=>q.state),["FL"]));
  ok("a reader sees no index manager", !(await p.$("#mkMgr")) && !(await p.$('[data-act="mk-start"]')) && !(await p.$('[data-act="mk-topup"]')));
  ok("the state list holds the indexed states only", same(await p.$$eval("#mk_state option",o=>o.map(x=>x.value)),["FL","GA"]) && (await t.txt("#mk_state option >> nth=0"))==="FL Florida");
  ok("the types of insurance come from the index", same(await p.$$eval("#mk_toi option",o=>o.map(x=>x.value)),["","Homeowners","Commercial Auto"]));
  ok("the coverage line is on screen before any search", (await t.txt("#mkCov")).startsWith("The market index of FL holds filings published 19 Nov 2025 to 18 Nov 2026") && (await t.txt("#mkCov")).includes("isn't the whole market") && (await t.txt("#mkCov")).includes("Not covered: Nonesuch Carrier No. 10 Co; Nonesuch Carrier No. 11 Co and 8 more."), await t.txt("#mkCov"));
  ok("no S&P request is suggested: the search says it costs none", (await t.txt("#mkForm")).includes("Costs no S&P requests."));
  await p.selectOption("#mk_toi","Homeowners"); await p.selectOption("#mk_ftype","Rate"); await p.fill("#mk_status","approved"); await p.fill("#mk_from","2026-01-01");
  await p.click("#mk_go"); await p.waitForTimeout(400);
  const asked=t.queries("rows")[0], askedCo=t.queries("company")[0];
  ok("a search asks for the filings and the summary by company, with the filters chosen", !!asked && asked.state==="FL" && asked.typeOfInsurance==="Homeowners" && asked.filingType==="Rate" && asked.status==="approved" && asked.from==="2026-01-01" && asked.to===null && asked.words===null && asked.limit===50 && asked.offset===0 && !!askedCo && askedCo.typeOfInsurance==="Homeowners", {asked, askedCo});
  ok("the summary says how many filings and rate filings", (await t.txt("#mkSummary"))==="60 filings in the index for FL, published 1 Jan to 18 Nov. 40 are rate filings.", await t.txt("#mkSummary"));
  ok("the results carry the coverage line, once", (await p.$$("#mkCov")).length===1 && (await t.txt("#mkOut #mkCov")).startsWith("The market index of FL"));
  ok("50 filings are shown first", (await p.$$("#mkTable tbody tr")).length===50 && (await t.txt("#mkCount")).startsWith("Showing 50 of 60"));
  ok("the columns: company, type, filing type, status, published, rate impact, filing number, document; no empty description column", same(await t.all("#mkTable thead th"),["Company","Type of insurance","Filing type","Status","Published","Rate impact","Filing number","Document"]) && (await t.txt("#mkNoDesc"))==="S&P gave no description for these filings, so there is no description column.", await t.all("#mkTable thead th"));
  const first='#mkTable tbody tr >> nth=0';
  ok("a row: company, dates as 5 Nov, rate impact to one decimal, S&P's own number marked", (await t.txt(first+" >> .c-co"))==="Calloway Home Co" && (await t.txt(first+' >> td[data-label="Published"]'))==="11 Feb" && (await t.txt(first+' >> td[data-label="Rate impact"]'))==="6.5%" && (await t.txt(first+' >> td[data-label="Filing number"]'))==="S&P no. QQQ1000001", await t.txt(first));
  ok("a negative rate impact in parentheses; none reads n/d", (await t.txt('#mkTable tbody tr >> nth=1 >> td[data-label="Rate impact"]'))==="(2.1%)" && (await t.txt('#mkTable tbody tr >> nth=2 >> td[data-label="Rate impact"]'))==="n/d");
  await p.click('[data-act="mk-more"]'); await p.waitForTimeout(300);
  ok("Show more loads the next page", t.queries("rows").at(-1).offset===50 && (await p.$$("#mkTable tbody tr")).length===60 && !(await p.$('[data-act="mk-more"]')));
  await p.click(first+' >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("Open document opens it through the filings function", same(t.calls.filter(c=>c.body.action==="document").map(c=>c.body),[{action:"document",documentId:74000001}]) && await p.evaluate(()=>window.__opened.length===1));
  const dl=p.waitForEvent("download"); await p.click('[data-act="mk-export"][data-fmt="csv"]'); const file=await dl; const csv=fs.readFileSync(await file.path(),"utf8");
  ok("CSV export asks for up to 500 rows of the same search and saves them", t.queries("rows").at(-1).limit===500 && file.suggestedFilename()==="snl-market-FL-2026-11-18.csv" && csv.split("\r\n").length===61 && csv.includes('"S&P no. QQQ1000001"') && csv.replace(/^\uFEFF/,"").split("\r\n")[0].startsWith('"Companies","State","Type of insurance"'), file.suggestedFilename());
  await p.click('[data-act="mk-tab"][data-tab="company"]'); await p.waitForTimeout(150);
  ok("by company: companies with the most filings, rate filings and their range", same(await t.all("#mkCoTable tbody tr .c-co"),["Calloway Home Co","Tarrow Mutual Insurance Co"]) && (await t.txt('#mkCoTable tbody tr >> nth=1 >> td[data-label="Rate impact"]'))==="(2.1%)" && (await t.txt('#mkCoTable tbody tr >> nth=0 >> td[data-label="Rate filings"]'))==="20" && (await t.txt("#mkCoCount"))==="2 companies, most filings first.");
  const dl2=p.waitForEvent("download"); await p.click('[data-act="mk-export"][data-fmt="csv"]'); const f2=await dl2;
  ok("the summary by company exports too", f2.suggestedFilename()==="snl-market-FL-2026-11-18-by-company.csv" && fs.readFileSync(await f2.path(),"utf8").includes('"Calloway Home Co"'));
  await p.screenshot({path:OUTDIR+"/market-reader-1440.png",fullPage:false});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: no sideways scroll with the summary by company", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.click('[data-act="mk-tab"][data-tab="rows"]'); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the filings as cards", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/market-reader-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  // a search by words on a state whose filings have no description says so
  t.query=q=>({status:200, body:q.group==="rows"?ANSWER(q,{total:0, rows:[], more:false, notes:["No filing in the index of GA has a description (S&P left them empty), so the words were matched against company names only.","No filing in the index matches. The index of GA covers 2,700 companies in the app's list for 19 Nov 2025 to 18 Nov 2026; that isn't proof that none were filed."]}):q.group==="type"?TYPES(q):BYCO(q)});
  await p.selectOption("#mk_state","GA"); await p.waitForTimeout(250);
  ok("choosing another state shows its coverage and clears the old results", (await t.txt("#mkCov")).startsWith("The market index of GA") && !(await p.$("#mkTable")) && t.queries("type").at(-1).state==="GA");
  await p.fill("#mk_words","high value"); await p.press("#mk_words","Enter"); await p.waitForTimeout(300);
  ok("Enter in the words box searches; the words are sent", t.queries("rows").at(-1).words==="high value" && t.queries("rows").at(-1).state==="GA");
  ok("an empty answer says it isn't proof, and says the descriptions are empty", (await t.txt("#mkSummary")).startsWith("No filing in the index matches for GA") && (await t.txt("#mkNotes")).includes("S&P left them empty") && (await t.txt("#mkNotes")).includes("that isn't proof that none were filed") && !/no filings exist/i.test(await t.txt("#mkOut")));
  t.query=q=>q.group==="rows"?{status:404, body:{error:"not_indexed", message:"GA isn't in the market index, so this can't be answered from it. The index covers FL. Nothing is answered from part of a sweep.", indexed:["FL"]}}:{status:200, body:TYPES(q)};
  await p.click("#mk_go"); await p.waitForTimeout(300);
  ok("a refusal from the index is shown calmly, in its own words", (await t.txt("#mkRefused"))==="GA isn't in the market index, so this can't be answered from it. The index covers FL. Nothing is answered from part of a sweep.");
  t.query=q=>({status:500, body:{error:"server", message:"The market index function failed: boom. Try again."}});
  await p.click("#mk_go"); await p.waitForTimeout(300);
  ok("a failure says so with Try again", (await t.txt("#mkOut .banner")).startsWith("Couldn't search the index.") && !!(await p.$('#mkOut [data-act="mk-search"]')));
  ok("no page errors", errs.length===0, errs);
  await t.ctx.close();

  // ----- every "not ready" state -----
  t=await open({role:"reader"}, {status:()=>({status:404, empty:true})}); p=t.p;
  ok("not deployed, for a reader: ask Corp Dev", (await t.txt("#mkNotDeployed"))==="This part of the site isn't set up yet. Ask Corp Dev.");
  await t.ctx.close();
  t=await open({role:"corpdev"}, {status:()=>({status:404, empty:true})}); p=t.p;
  ok("not deployed, for Corp Dev: the command to deploy it", (await t.txt("#mkNotDeployed"))==="The market index function isn't deployed yet. Run: supabase functions deploy snl-index --no-verify-jwt (see the README).", await t.txt("#mkNotDeployed"));
  await t.ctx.close();
  t=await open({role:"corpdev"}, {status:()=>({status:503, body:{error:"no_tables", message:"The market index's tables aren't in the database yet. Run supabase/migrations/0006_market_index.sql in the Supabase SQL editor (README, Market index, step 1). After that, the index manager works."}})}); p=t.p;
  ok("migration not run, for Corp Dev: which step is missing", (await t.txt("#mkNoTables")).includes("0006_market_index.sql"));
  await t.ctx.close();
  t=await open({role:"reader"}, {status:()=>({status:503, body:{error:"no_tables", message:"x"}})}); p=t.p;
  ok("migration not run, for a reader: ask Corp Dev", (await t.txt("#mkNoTables"))==="The market index isn't set up yet. Ask Corp Dev.");
  await t.ctx.close();
  let fails=1;
  t=await open({role:"reader"}, {status:()=>fails-- > 0 ? {status:500, body:{error:"server", message:"The market index function failed: boom. Try again."}} : {status:200, body:MSTATUS()}}); p=t.p;
  ok("a failed status says so, with Try again", (await t.txt("#view .banner")).startsWith("Couldn't load the market index."));
  await p.click('[data-act="mk-retry"]'); await p.waitForTimeout(350);
  ok("Try again loads it", !!(await p.$("#mkForm")) && t.icalls("status").length===2);
  await t.ctx.close();
  t=await open({role:"reader"}, {status:()=>({status:200, body:MSTATUS({states:[], recent:[], open:SWEEP({state:"FL", percent:40})})})}); p=t.p;
  ok("nothing indexed yet, with a sweep under way: says so, no search form", (await t.txt("#mkNone"))==="No state is indexed yet. A sweep of FL is under way (40% done); its filings can be searched when it finishes. Corp Dev can sweep a state; until then, use the Filings view or Ask Claude." && !(await p.$("#mkForm")), await t.txt("#mkNone"));
  ok("a reader's page never carries a sweep on", t.icalls("continue").length===0);
  await t.ctx.close();
  t=await open({role:"corpdev"}, {status:()=>({status:200, body:CD({states:[], recent:[], topUps:{}, configured:false})})}); p=t.p;
  ok("S&P not set up: Corp Dev is told, and Start is off", (await t.txt("#mkOff")).startsWith("S&P filings aren't set up yet") && await p.$eval("#mkStartBtn",b=>b.disabled) && (await t.txt("#mkNone")).endsWith("Start a sweep in the index manager below."));
  await t.ctx.close();

  // ----- Corp Dev: the manager, a sweep's cost, start, progress, pause, carry on, stop, top up -----
  let st=CD();
  t=await open({role:"corpdev"}, {status:()=>({status:200, body:st})}); p=t.p;
  ok("Corp Dev sees the index manager below the search", !!(await p.$("#mkMgr")) && !!(await p.$("#mkForm")));
  ok("the states indexed, with period, last completed, filings and coverage", same(await t.all("#mkIndexed .mkli > span:first-child"),["FL 19 Nov 2025 to 18 Nov, last completed 18 Nov: 812 filings, 2,690 companies covered, 10 not","GA 19 Nov 2025 to 18 Nov, last completed 18 Nov: 301 filings, 2,700 companies covered, 0 not"]), await t.all("#mkIndexed .mkli > span:first-child"));
  ok("what wasn't covered is listed", (await p.textContent('#mkIndexed li[data-state="FL"] .mkmiss')).includes("Nonesuch Carrier No. 10 Co; Nonesuch Carrier No. 11 Co and 8 more."));
  ok("a top-up offers its cost and says to top up weekly or monthly", (await t.txt('#mkIndexed li[data-state="FL"] .mkcost')).includes("filings published since 18 Nov") && (await t.txt('#mkIndexed li[data-state="FL"] .mkcost')).includes("so top up weekly or monthly, not daily") && (await t.txt('#mkIndexed li[data-state="GA"] .mkli'))
    .endsWith("Up to date"));
  ok("the cost of the chosen period is shown before starting", (await t.txt("#mkCost")).startsWith("What it costs: About 299 S&P requests") && (await t.txt("#mkCost")).includes("59.8% of an hour's limit of 500 and 2.5% of a day's limit of 12,000"));
  await p.click('[data-act="mk-period"][data-p="last_3_years"]'); await p.waitForTimeout(100);
  ok("a different period shows its own cost", (await t.txt("#mkCost")).includes("About 893 S&P requests") && (await t.txt("#mkCost")).includes("runs over about 3 hours") && await p.getAttribute('[data-act="mk-period"][data-p="last_3_years"]',"aria-pressed")==="true");
  ok("without a schedule, it says a sweep only runs while the page is open", (await t.txt("#mkSchedule")).startsWith("No schedule: a sweep only runs while this page is open."));
  await p.click("#mkStartBtn"); await p.waitForTimeout(150);
  ok("starting needs a state", (await t.txt("#mkMgrErr"))==="Choose a state to sweep." && t.icalls("start").length===0);
  await p.selectOption("#mk_mstate","TX");
  // after the start, the status shows the sweep waiting; each step moves it on
  let n=0;
  t.act=(a,body)=>{ if(a==="start"){ st=CD({open:SWEEP({period:"last_3_years"})}); return {status:200, body:{sweep:SWEEP(), message:"Sweep of TX started for filings published 20 Nov 2023 to 18 Nov 2026."}}; } return {status:200, body:{message:"Done."}}; };
  t.step=()=>{ n++; const done=n>=3; st=CD({usage:{hour:100*n, day:300}, open:done?null:SWEEP({status:"waiting", next_unit:n*90, percent:Math.floor(n*90/270*100), requests:n*92, rows_found:n*100}), recent:done?[SWEEP({status:"done", percent:100, message:"Swept TX for filings published 20 Nov 2023 to 18 Nov 2026: 2,700 companies in 270 batches, 893 S&P requests."})]:[]});
    return {status:200, body:{step:{ran:true, reason:done?"done":"waiting", message:"x"}, used:{hour:100*n, day:300}, limits:{hour:500, day:12000}, account:"trial"}}; };
  t.stepDelay=150;
  await p.click("#mkStartBtn"); await p.waitForTimeout(250);
  ok("Start sends the state and period", same(t.icalls("start").map(c=>c.body),[{action:"start", state:"TX", period:"last_3_years"}]));
  ok("while a step runs, the page says what is happening and shows progress", !!(await p.$("#mkOpen")) && (await t.txt("#mkStepping")).startsWith("Asking S&P for the next batches") && (await p.getAttribute(".mkbar","aria-valuenow"))!==null);
  await p.waitForTimeout(1200);
  ok("the page carries the sweep on, step after step, until it finishes", t.icalls("continue").length===3 && !(await p.$("#mkOpen")) && (await t.txt("#mkRecent")).includes("Swept TX"), {c:t.icalls("continue").length});
  ok("the S&P usage strip follows the steps", (await t.txt("#s_usage")).includes("300 of 500 this hour"), await t.txt("#s_usage"));
  await p.click('#mkIndexed li[data-state="FL"] [data-act="mk-topup"]'); await p.waitForTimeout(200);
  ok("Top up sends the state", same(t.icalls("top_up").map(c=>c.body),[{action:"top_up", state:"FL"}]));
  await t.ctx.close();

  // a sweep in progress: progress, pause, carry on, stop
  st=CD({open:SWEEP({status:"waiting", next_unit:108, percent:40, requests:110, rows_found:420, missed:[{unit:3,kind:"institutionId",ids:[1],names:["Nonesuch Carrier No. 10 Co"],window:["2025-11-19","2026-11-18"],reason:"x",at:"x"}], companiesMissed:10})});
  let steps=0;
  t=await open({role:"corpdev"}, {status:()=>({status:200, body:st}), step:()=>{ steps++; return {status:200, body:{step:{ran:true, reason:"waiting", message:"x"}, used:{hour:1,day:1}, limits:{hour:500,day:12000}}}; }, stepDelay:400}); p=t.p;
  ok("the unfinished sweep: what, progress, requests, filings and companies not covered", (await t.txt("#mkOpen .blk-h > div"))==="Sweep of TX published 19 Nov 2025 to 18 Nov" && (await t.txt("#mkOpenStatus"))==="Waiting to carry on" && (await t.txt("#mkProgress"))==="108 of 270 batches of companies (40%), 110 S&P requests so far, 420 filings found. 10 companies not covered so far." && (await p.getAttribute(".mkbar","aria-valuenow"))==="40", await t.txt("#mkOpen .blk-h > div"));
  ok("Start is off while a sweep is unfinished", await p.$eval("#mkStartBtn",b=>b.disabled) && (await t.txt("#mkStart")).includes("One sweep runs at a time."));
  t.act=(a)=>{ if(a==="pause") st=CD({open:SWEEP({status:"held", next_unit:108, percent:40, message:"Paused by Corp Dev after 108 of 270 batches."})}); if(a==="resume") st=CD({open:SWEEP({status:"held", percent:40})}); if(a==="stop") st=CD({open:null}); return {status:200, body:{message:a==="pause"?"Paused.":a==="stop"?"Stopped.":"Carrying on from the next batch."}}; };
  await p.waitForTimeout(150);
  await p.click("#mkPause"); await p.waitForTimeout(700);
  ok("Pause holds it; the page stops carrying it on and offers Carry on", t.icalls("pause").length===1 && (await t.txt("#mkOpenStatus"))==="Paused" && !!(await p.$("#mkResume")) && (await t.txt("#mkMgrNote"))==="Paused." && (await t.txt("#mkOpenMsg"))==="Paused by Corp Dev after 108 of 270 batches.");
  const before=steps; await p.waitForTimeout(600);
  ok("a paused sweep isn't carried on by the page", steps===before);
  await p.click("#mkResume"); await p.waitForTimeout(300);
  ok("Carry on asks to resume", t.icalls("resume").length===1);
  await p.click("#mkStop"); await p.waitForTimeout(400);
  ok("Stop closes it", t.icalls("stop").length===1 && !(await p.$("#mkOpen")) && (await t.txt("#mkMgrNote"))==="Stopped.");
  await t.ctx.close();

  // waiting to leave room for people: the page waits, and says until when
  st=CD({open:SWEEP({status:"waiting", resume_after:"2026-11-18T13:01:00Z", percent:30, message:"Waiting to leave room for people: 350 of this hour's 500 S&P requests are used, and sweeps leave the last 150 for searches and questions. It carries on after 13:01 UTC."})});
  t=await open({role:"corpdev"}, {status:()=>({status:200, body:st})}); p=t.p;
  await p.waitForTimeout(400);
  ok("a sweep waiting for the next hour isn't asked to carry on before then", t.icalls("continue").length===0 && (await t.txt("#mkOpenStatus"))==="Waiting to carry on until 13:01" && (await t.txt("#mkOpenMsg")).includes("leave room for people"), await t.txt("#mkOpenStatus"));
  await t.ctx.close();

  // a step that fails: said, nothing lost, Try again; leaving the view stops the steps
  st=CD({open:SWEEP({status:"waiting", percent:10})});
  t=await open({role:"corpdev"}, {status:()=>({status:200, body:st}), step:()=>({status:500, body:{error:"server", message:"The market index function failed: boom. Try again."}})}); p=t.p;
  await p.waitForTimeout(400);
  ok("a failed step says so and that nothing is lost, and the page stops asking", (await t.txt("#mkStepErr"))==="The sweep couldn't carry on: The market index function failed: boom. Try again. It hasn't lost its place." && t.icalls("continue").length===1 && !!(await p.$("#mkStepAgain")));
  t.step=()=>({status:200, body:{step:{ran:true, reason:"waiting"}, used:{hour:1,day:1}, limits:{hour:500,day:12000}}});
  t.stepDelay=300;
  await p.click("#mkStepAgain"); await p.waitForTimeout(100);
  await p.evaluate(()=>{ location.hash="#filings"; }); await p.waitForTimeout(900);
  const c=t.icalls("continue").length;
  await p.waitForTimeout(600);
  ok("leaving the view stops carrying the sweep on (closing the tab only pauses it)", t.icalls("continue").length===c && c<=3, c);
  await t.ctx.close();

  // a refused period, and refusals from the function
  st=CD({costs:{...copy(COSTS), last_3_years:{...COSTS.last_3_years, refused:"This sweep needs about 9,902 S&P requests, more than the 8,400 sweeps may use in one day (the app keeps 3,000 a day and 150 an hour for people). Choose \"Last 12 months\" instead (about 3,302 requests). Nothing was asked of S&P."}}});
  t=await open({role:"corpdev"}, {status:()=>({status:200, body:st}), act:()=>({status:409, body:{error:"busy", message:"A sweep of FL is unfinished (40% done). Carry it on or stop it before starting another; only one runs at a time."}})}); p=t.p;
  await p.click('[data-act="mk-period"][data-p="last_3_years"]'); await p.waitForTimeout(100);
  ok("a period too big for a day is refused on the page, with what to choose instead, and Start is off", (await t.txt("#mkRefusedCost")).includes('Choose "Last 12 months" instead') && await p.$eval("#mkStartBtn",b=>b.disabled));
  await p.click('[data-act="mk-period"][data-p="this_year"]'); await p.selectOption("#mk_mstate","FL"); await p.waitForTimeout(100);
  ok("choosing an indexed state says a new sweep replaces its period", (await t.txt("#mkStart")).includes("FL is already indexed: a new sweep replaces its period when it finishes. To add only new filings, top it up instead."));
  await p.click("#mkStartBtn"); await p.waitForTimeout(300);
  ok("a refusal from the function is shown in its own words", (await t.txt("#mkMgrErr"))==="A sweep of FL is unfinished (40% done). Carry it on or stop it before starting another; only one runs at a time.");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: no sideways scroll in the index manager", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/market-corpdev-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(150);
  await p.screenshot({path:OUTDIR+"/market-corpdev-1440.png",fullPage:true});
  await t.ctx.close();

  // ----- hostile text stays text -----
  const H='<img src=x onerror="window.__pwned=1">';
  st=CD({states:[COV("FL",{sentence:"Coverage "+H, missed:[H]})], open:SWEEP({state:"FL", message:"Note "+H}), recent:[SWEEP({status:"failed", message:"Failed "+H})]});
  t=await open({role:"corpdev"}, {status:()=>({status:200, body:st}), step:()=>({status:200, body:{step:{ran:false, reason:"busy"}}}), query:q=>({status:200, body:q.group==="rows"?ANSWER(q,{rows:[ROW(1,{companies:[{companyName:H}], serffFilingType:H, filingDescription:"Desc "+H, trackingNumber:H})], total:1, more:false, notes:["Note "+H]}):q.group==="type"?{groups:[{name:H}]}:BYCO(q)})}); p=t.p;
  const covText=await t.txt("#mkCov");
  await p.click("#mk_go"); await p.waitForTimeout(400);
  ok("names, messages, notes and descriptions are shown as text, never run", await p.evaluate(()=>!window.__pwned && !document.querySelector("#view img")) && covText.includes('Coverage <img src=x onerror="window.__pwned=1">') && (await t.txt("#mkTable tbody tr >> nth=0 >> .c-co")).includes("<img") && (await t.txt("#mkOpenMsg")).includes("<img") && (await t.txt("#mkNotes")).includes("<img"));
  ok("a step that didn't run (someone else's was running) isn't asked again at once", t.icalls("continue").length===1, t.icalls("continue").length);
  ok("a row with a description gets the description column", (await t.all("#mkTable thead th")).includes("Description") && !(await p.$("#mkNoDesc")));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with long hostile text", await t.noScroll());
  ok("no page errors", errs.length===0, errs);
  await t.ctx.close();

  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
