// "Narrow it down" by filing type and status on the Market view: once the index lists the filing types and statuses it
// holds (groups "ftype" and "status", migration 0010), they are chosen as chips from those names in the same box as
// states and types, the one Filing type and Status words leave the form, and the question carries filingTypes and
// statuses only when chosen (untouched, it is asked exactly as before); the box says which status is in force; the
// summary, the export and the empty-result note name the full scope; rate filings left out by the narrowing are said
// to be, never counted as 0; before 0010 (or with an older snl-index) the box says what to run and the one-choice
// boxes keep working as before; an old function is never shown as if it had answered; hostile names; 1440px and 390px.
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

  // the index's lists of filing types and statuses in a state (migration 0010)
  const HELD=q=>q.group==="ftype" ? {coverage:COV(q.state), total:60, group:"ftype", groupTotal:3, groups:[{name:"Rate", filings:40},{name:"Form", filings:15},{name:"rate", filings:5}], notes:[]}
    : {coverage:COV(q.state), total:60, group:"status", groupTotal:3, groups:[{name:"Approved", filings:50},{name:"Pending", filings:8},{name:"<b>Odd</b>", filings:2}], notes:[]};
  const MANY=(q,over={})=>{ const a=ANSWER({...q, limit:50, offset:0}); const sts=q.states||[q.state];
    return {...a, coverage:COV(sts[0]), coverages:sts.map(s=>COV(s)), notIndexed:[], outOfRange:[],
      query:{...a.query, typeOfInsurance:null, filingType:null, status:null, states:sts, types:q.typesOfInsurance||[], ...(q.filingTypes?{filingTypes:q.filingTypes}:{}), ...(q.statuses?{statuses:q.statuses}:{}), scope:sts.map(s=>({state:s, from:"2025-11-19", to:"2026-11-18"}))}, ...over}; };
  // a question narrowed to filing types that aren't rate filings has none: as the index counts them
  const noRate=q=>Array.isArray(q.filingTypes) && !q.filingTypes.some(x=>/rate/i.test(x));
  const CO=q=>{ const a=BYCO(q); if(noRate(q)) a.groups.forEach(g=>{ g.rateFilings=0; g.rateMin=null; g.rateMax=null; }); return a; };
  const NEW=q=>({status:200, body:q.group==="type"?TYPES(q):q.group==="company"?CO(q):q.group==="ftype"||q.group==="status"?HELD(q):(q.filingTypes||q.statuses||q.states)?MANY(q, noRate(q)?{rateFilings:0, withRate:0}:{}):ANSWER(q)});
  const pick=async(p, w, ...ids)=>{ if(!(await p.$(`#nw_mk_${w}p`))) await p.click(`#nw_mk_${w}b`); for(const id of ids) await p.click(`#nw_mk_${w}s input[data-id="${id}"]`); await p.click(`#nw_mk_${w}Done`); await p.waitForTimeout(100); };

  // ----- the index lists them: chips in the box, and the one-choice boxes leave the form -----
  let t=await open({role:"reader"}, {query:NEW}); let p=t.p;
  ok("the index's lists are asked for at no S&P cost", t.queries("ftype").some(q=>q.state==="FL") && t.queries("status").some(q=>q.state==="FL"));
  ok("filing type and status are in the box, with nothing chosen", (await t.txt("#nw_mk_allft"))==="All filing types" && (await t.txt("#nw_mk_allfs"))==="All statuses" && (await t.txt("#nw_mk_fsnote"))==="No status chosen: filings of every status the index holds.");
  ok("…and the one Filing type and Status words leave the form", !(await p.$("#mk_ftype")) && !(await p.$("#mk_status")));
  await p.click("#mk_go"); await p.waitForTimeout(400);
  const q0=t.queries("rows").at(-1);
  ok("untouched, the question is the one it always was: no lists, no filing type, no status", q0.state==="FL" && q0.filingType===null && q0.status===null && !("filingTypes" in q0) && !("statuses" in q0) && !("states" in q0), q0);
  await p.click("#nw_mk_ftb"); await p.waitForTimeout(100);
  ok("the filing types are the index's own names, each once whatever its letter case", same(await t.all("#nw_mk_fts label"),["Form","Rate"]));
  await p.click('#nw_mk_fts input[data-id="Form"]'); await p.click("#nw_mk_ftDone"); await p.waitForTimeout(100);
  await pick(p, "fs", "Approved", "Pending");
  ok("the box says which statuses are in force", (await t.txt("#nw_mk_fsnote"))==="Only filings with these statuses, each matched by its whole name.");
  await p.click("#mk_go"); await p.waitForTimeout(400);
  const q1=t.queries("rows").at(-1), c1=t.queries("company").at(-1);
  ok("the question carries the filing types and statuses as lists, and not the one-choice words", same(q1.filingTypes,["Form"]) && same(q1.statuses,["Approved","Pending"]) && q1.filingType===null && q1.status===null && same(c1.filingTypes,["Form"]), q1);
  ok("the summary names the full scope, and says rate filings were left out rather than counting them", (await t.txt("#mkSummary")).startsWith("60 filings in the index for Florida; form filings; approved or pending") && (await t.txt("#mkSummary")).includes("Rate filings are left out by the narrowing to form filings.") && !/are rate filings/.test(await t.txt("#mkSummary")), await t.txt("#mkSummary"));
  const dl=p.waitForEvent("download"); await p.click('[data-act="mk-export"][data-fmt="csv"]'); const f=await dl;
  ok("the export asks the same question and names the scope", same(t.queries("rows").at(-1).statuses,["Approved","Pending"]) && f.suggestedFilename()==="snl-market-fl-form-filings-approved-or-pending-2026-11-18.csv", f.suggestedFilename());
  await p.click('[data-act="mk-tab"][data-tab="company"]'); await p.waitForTimeout(150);
  ok("by company: rate filings left out, never 0", same(await t.all("#mkCoTable tbody td:nth-child(3)"),["Left out","Left out"]), await t.all("#mkCoTable tbody td:nth-child(3)"));
  // the function says nothing matched: its note is shown as it says it
  t.query=q=>q.group==="rows" ? {status:200, body:MANY(q,{total:0, rows:[], withRate:0, rateFilings:0, more:false, notes:['No filing in the index matches filing type "Form", status "Approved" or "Pending" in FL. That isn\'t proof that none were filed: the index holds the companies in the app\'s list only, and says nothing about states it doesn\'t cover, or other filing types and statuses.']})} : NEW(q);
  await p.click("#mk_go"); await p.waitForTimeout(400);
  ok("nothing matches: the summary and the note name the full scope and what it says nothing about", (await t.txt("#mkSummary")).startsWith("No filing in the index matches for Florida; form filings; approved or pending") && (await t.txt("#mkNotes")).includes("or other filing types and statuses"), [await t.txt("#mkSummary"), await t.txt("#mkNotes")]);
  // an older function, answering the lists without them in its answer: never shown as if it had answered
  t.query=q=>q.group==="rows"||q.group==="company" ? {status:200, body:q.group==="company"?BYCO(q):ANSWER(q)} : NEW(q);
  await p.click("#mk_go"); await p.waitForTimeout(400);
  ok("a market index function from before: the lists aren't shown as if answered", (await t.txt("#mkRefused")).startsWith("The market index function on this site can't search by several filing types or statuses yet.") && !(await p.$("#mkTable")), await t.txt("#mkRefused"));
  // hostile names from the index stay text
  await pick(p, "fs", "<b>Odd</b>");
  ok("a hostile status name shows as text", !(await p.$("#nw_mk .cchip b b")) && (await t.all("#nw_mk_fsl ~ .chips .cchip b")).includes("<b>Odd</b>"));
  for(const width of [1440, 390]){
    await p.setViewportSize({width, height:width<500?844:900}); await p.waitForTimeout(150);
    ok(`${width}px: no sideways scroll`, await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
    await (await p.$("#mkForm")).screenshot({path:OUTDIR+`/morefilters-market-${width}.png`});
  }
  await ctx_close(t);

  // ----- before 0010: the box says what to run, and the one-choice boxes work as before -----
  const OLD=q=>q.group==="ftype"||q.group==="status" ? {status:400, body:{error:"needs_update", message:"Searching by several filing types or statuses from the index's own lists needs the database update in supabase/migrations/0010_market_more_filters.sql: run it in the Supabase SQL editor (README, Market index). Until then, use the Filing type and Status boxes on the form."}} : {status:200, body:q.group==="type"?TYPES(q):q.group==="company"?BYCO(q):ANSWER(q)};
  t=await open({role:"reader"}, {query:OLD}); p=t.p;
  ok("before 0010: filing type and status in the box say what to run, and can't be opened", (await t.txt("#nw_mk_ftoff")).startsWith("The index can't list its filing types and statuses until the database update 0010 is run") && await p.$eval("#nw_mk_ftb",e=>e.disabled) && await p.$eval("#nw_mk_fsb",e=>e.disabled));
  ok("…and the one Filing type and Status boxes stay", !!(await p.$("#mk_ftype")) && !!(await p.$("#mk_status")));
  await p.selectOption("#mk_ftype","Rate"); await p.fill("#mk_status","Approved"); await p.click("#mk_go"); await p.waitForTimeout(400);
  const q2=t.queries("rows").at(-1);
  ok("…and are asked exactly as before", q2.filingType==="Rate" && q2.status==="Approved" && !("filingTypes" in q2) && !("statuses" in q2), q2);
  await ctx_close(t);
  // an older snl-index refuses the new groups as a bad question
  t=await open({role:"reader"}, {query:q=>q.group==="ftype"||q.group==="status" ? {status:400, body:{error:"bad", message:"Group by company, type or month, or ask for the rows."}} : OLD(q)}); p=t.p;
  ok("an older snl-index: the same plain words", (await t.txt("#nw_mk_fsoff")).includes("snl-index is deployed again") && !!(await p.$("#mk_ftype")));
  await ctx_close(t);

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
  async function ctx_close(x){ await x.ctx.close(); }
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
