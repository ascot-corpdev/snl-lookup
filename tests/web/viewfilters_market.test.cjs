// "Narrow it down" on the Market view: the first indexed state chosen to start with and any type, asked exactly as
// before; several states (only those the index holds; the map says why others can't be chosen) and several types (the
// index's own names, from every state chosen) asked as lists; a coverage line for each state answered and a state the
// index doesn't hold named, never dropped; the summary and the export name the scope; a function or database from
// before narrowing is said plainly, never answered wider; 1440px and 390px. Nothing touches the network.
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

  // the index answers several states and types (migration 0009): one coverage line for each state answered
  const MANY=(q,over={})=>{ const a=ANSWER({...q, limit:50, offset:0}); const sts=q.states||[q.state];
    return {...a, coverage:COV(sts[0]), coverages:sts.filter(s=>s!=="NY").map(s=>COV(s)), notIndexed:sts.filter(s=>s==="NY"), outOfRange:[],
      query:{...a.query, typeOfInsurance:null, states:sts.filter(s=>s!=="NY"), types:q.typesOfInsurance||[], scope:sts.map(s=>({state:s, from:"2025-11-19", to:"2026-11-18"}))}, notes:sts.includes("NY")?["NY isn't in the market index, so it isn't in this answer (not answered as empty). The index covers FL, GA."]:[], ...over}; };
  const TYPES_GA=q=>q.state==="GA" ? {coverage:COV("GA"), total:9, group:"type", groupTotal:2, groups:[{name:"Homeowners", filings:5},{name:"Farmowners", filings:4}], notes:[]} : TYPES(q);

  // ----- the default: one state, any type, asked exactly as before -----
  let t=await open({role:"reader"}); let p=t.p;
  ok("Narrow it down on the Market: the first indexed state chosen, every type", same(await t.all("#nw_mk .nwcol >> nth=0 >> .cchip b"),["Florida"]) && (await t.txt("#nw_mk_alltoi"))==="All types of insurance");
  ok("the coverage line of the state chosen is on screen", (await t.txt("#mkCov")).startsWith("The market index of FL"));
  await p.click("#mk_go"); await p.waitForTimeout(400);
  const q0=t.queries("rows")[0];
  ok("untouched, the question is the one-state question it always was", q0.state==="FL" && q0.typeOfInsurance===null && !("states" in q0) && !("typesOfInsurance" in q0), q0);
  await ctx_close(t);

  // ----- several states and types -----
  t=await open({role:"reader"}, {query:q=>({status:200, body:q.group==="type"?TYPES_GA(q):q.group==="company"?BYCO(q):MANY(q)})}); p=t.p;
  await p.click("#nw_mk_stb"); await p.waitForTimeout(150);
  ok("the map: a state the index doesn't hold can't be chosen, and says why", await p.evaluate(()=>{ const x=[...document.querySelectorAll("#nw_mk_map path")].find(e=>/Texas \(TX\)/.test(e.textContent)); return !!x && x.classList.contains("off") && /isn't in the market index/.test(x.textContent); }));
  ok("no region shortcuts: the index holds few states", !(await p.$('#nw_mk [data-act="nw-region"]')));
  await p.click('#nw_mk_states [data-s="GA"]'); await p.click("#nw_mk_stDone"); await p.waitForTimeout(300);
  ok("adding Georgia loads its types from the index, at no S&P cost", t.queries("type").some(q=>q.state==="GA"));
  ok("a coverage line for each state chosen, before any search", (await t.txt("#mkCov")).startsWith("The market index of FL") && (await t.txt("#mkCov_GA")).startsWith("The market index of GA"));
  await p.click("#nw_mk_toib"); await p.waitForTimeout(100);
  ok("the types are the index's own, from both states", same(await t.all("#nw_mk_tois label"),["Commercial Auto","Farmowners","Homeowners"]));
  await p.click('#nw_mk_tois input[data-id="Homeowners"]'); await p.click('#nw_mk_tois input[data-id="Farmowners"]'); await p.click("#nw_mk_toiDone"); await p.waitForTimeout(100);
  await p.click("#mk_go"); await p.waitForTimeout(400);
  const q1=t.queries("rows").at(-1), c1=t.queries("company").at(-1);
  ok("the question carries both states and both types", same(q1.states,["FL","GA"]) && same(q1.typesOfInsurance,["Homeowners","Farmowners"]) && q1.state==="FL" && q1.typeOfInsurance===null && same(c1.states,["FL","GA"]), q1);
  ok("the results show a coverage line for each state answered", same(await p.$$eval("#mkOut .mkcov",e=>e.map(x=>x.id)),["mkCov","mkCov_GA"]));
  ok("the summary names what was asked", (await t.txt("#mkSummary")).startsWith("60 filings in the index for Florida and Georgia, homeowners and farmowners"), await t.txt("#mkSummary"));
  const dl=p.waitForEvent("download"); await p.click('[data-act="mk-export"][data-fmt="csv"]'); const f=await dl;
  ok("the export asks the same question and names the scope", same(t.queries("rows").at(-1).states,["FL","GA"]) && f.suggestedFilename()==="snl-market-fl-and-ga-homeowners-and-farmowners-2026-11-18.csv", f.suggestedFilename());
  await p.click('#nw_mk [data-act="nw-st-x"][data-id="GA"]'); await p.waitForTimeout(150);
  ok("changing the states clears the old results", !(await p.$("#mkTable")));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  await p.click("#nw_mk_toib"); await p.waitForTimeout(100);
  ok("390px: no sideways scroll with the types open", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/viewfilters-market-390.png", fullPage:true});
  await p.setViewportSize({width:1440,height:900}); await p.click("#nw_mk_toib"); await p.waitForTimeout(100);
  await p.screenshot({path:OUTDIR+"/viewfilters-market-1440.png"});
  await ctx_close(t);

  // ----- a state the index doesn't hold is named; an old function or database is said plainly -----
  const NYSTATUS=()=>({status:200, body:MSTATUS({states:[COV("FL"), COV("GA"), COV("NY")]})});
  t=await open({role:"reader"}, {status:NYSTATUS, query:q=>({status:200, body:q.group==="type"?TYPES(q):q.group==="company"?BYCO(q):MANY(q)})}); p=t.p;
  await p.click("#nw_mk_stb"); await p.click('#nw_mk_states [data-s="NY"]'); await p.click("#nw_mk_stDone"); await p.click("#mk_go"); await p.waitForTimeout(400);
  ok("a state left out of the answer is named, not dropped", (await t.txt("#mkNotes")).includes("NY isn't in the market index, so it isn't in this answer (not answered as empty)") && !(await p.$("#mkCov_NY")));
  await ctx_close(t);
  t=await open({role:"reader"}, {query:q=>({status:200, body:q.group==="type"?TYPES_GA(q):q.group==="company"?BYCO(q):ANSWER(q)})}); p=t.p;
  await p.click("#nw_mk_stb"); await p.click('#nw_mk_states [data-s="GA"]'); await p.click("#nw_mk_stDone"); await p.click("#mk_go"); await p.waitForTimeout(400);
  ok("a market index function from before: several states aren't shown as if answered", (await t.txt("#mkRefused")).startsWith("The market index function on this site can only search one state and one type of insurance at a time.") && !(await p.$("#mkTable")));
  t.query=q=>q.group==="type"?{status:200, body:TYPES(q)}:{status:400, body:{error:"needs_update", message:"Searching several states or types of insurance at once needs the database update in supabase/migrations/0009_market_filters.sql: run it in the Supabase SQL editor (README, Market index). Until then, choose one state and one type of insurance."}};
  await p.click("#mk_go"); await p.waitForTimeout(400);
  ok("a database without migration 0009: says what to run, calmly", (await t.txt("#mkRefused")).includes("0009_market_filters.sql"));
  await ctx_close(t);

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
  async function ctx_close(x){ await x.ctx.close(); }
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
