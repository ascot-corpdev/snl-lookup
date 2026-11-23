// The Compare view: choosing two to eight carriers (a company, or a whole group as one carrier), what the comparison
// will cost and how it is split into searches, the searches run one after another with progress, and every figure on
// the page worked out by hand from the made-up fixture: the summary table, the rate chart and its list, carrier by
// state and by type of insurance (by count and by latest rate impact, and "two or more carriers"), filings by year on
// one scale, and the latest filings with their carrier filter. Then exports, hand-offs (each carrier's Snapshot, the
// Filings view, Ask Claude), comparisons reopened from this browser, saved carrier sets with and without the sets
// feature, every "not ready" state (fewer than two, no S&P id, too big, one search of several failing and its retry,
// partial, nothing returned for one carrier or all, not set up, session ended), hostile text, the nav with seven tabs
// at 390px, and the 1440px and 390px layouts. Nothing touches the network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const SCRATCH="/tmp/claude-0/-workspace/53a3716b-de6d-55ad-8392-70c70b8d61ed/scratchpad";
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("compare_search.json"), RES=FIX("compare_resolve.json");
REFS.lists.serffFilingState.options.push({id:"WA", name:"Washington"});   // a seventh state, where S&P returns nothing for anyone
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const NOT_SET_UP="S&P API access isn't set up yet. It needs API credentials from S&P. When they arrive, the owner sets SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase (README, step 5). Saved results still open.";
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const STATES=["CA","FL","GA","NY","SC","TX","WA"];
// the one search for the four carriers over the last 3 years, worked out by hand: every company once, in the order the
// carriers were chosen, every state in S&P's list, dates exactly 3 x 365 days ending today (13 Nov 2026)
const MAIN={action:"search", companyIds:[], institutionIds:[5000001,5100001,5100002,5200001,5300001], states:STATES, from:"2023-11-15", to:"2026-11-13"};
const CAR=["Calloway Insurance Co","Tarrow Group (SNL P&C Group)","Nonesuch Coastal Co","Nonesuch Quiet Co"];

// ----- big groups for the searches-in-parts tests -----
const memberOf=(group, i, base)=>({companyId:null, companyName:`${group.replace(/ Group$/,"")} Member ${i} Co`, naicCompanyCode:null, institutionId:String(base+i), spStatEntityId:null, naicGroupCode:null, naicGroupName:group});
const whole=(group, n, base)=>({name:group, code:null, companies:n, searchable:n, tooBig:false, requestsPerYear:Math.ceil(n/10), members:Array.from({length:n},(_,i)=>({companyName:memberOf(group,i+1,base).companyName, companyId:null, institutionId:String(base+i+1)}))});
const BIG="Nonesuch Big Group", WIDE="Nonesuch Wide Group";
const resolveBig=q=>/big/i.test(q) ? {query:q, matches:[memberOf(BIG,1,6000000)], groups:[whole(BIG,69,6000000)], groupNote:null}
  : /wide/i.test(q) ? {query:q, matches:[memberOf(WIDE,1,6100000)], groups:[whole(WIDE,40,6100000)], groupNote:null} : null;
const row=(n, iid, name, st, type, rate, pub)=>({...copy(SEARCH.rows[0]), filingVersionId:`bigver-${n}`, serffFilingEntityEventId:9900000+n, sfcNumber:`SFC-BIG-${n}`, trackingNumber:null, institutionId:iid, companyName:name,
  companies:[{companyId:null, companyName:name, naicCompanyCode:null, institutionId:iid, spStatEntityId:null}], serffFilingStateId:st, serffFilingType:type, overallRateImpact:rate, publishDate:pub, filingStatus:"Approved"});
const PART1={...copy(SEARCH), rows:[row(1,6000001,"Nonesuch Big Member 1 Co","FL","Rate",3,"2026-06-01"), row(2,6100001,"Nonesuch Wide Member 1 Co","GA","Form",null,"2025-06-01")], notes:[]};
const PART2={...copy(SEARCH), rows:[row(3,5000001,"Calloway Insurance Co","TX","Rate",2,"2026-01-15"), row(4,6100035,"Nonesuch Wide Member 35 Co","GA","Rate",-1,"2026-02-01")], notes:[]};

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", deviceScaleFactor:width<500?2:1}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, xlsxLoads:0, status:()=>copy(STATUS),
      resolve:q=>{ const l=q.toLowerCase(); const big=resolveBig(q); if(big) return big;
        return copy(l==="tarrow group" ? RES.tarrowGroup : l.startsWith("tarrow") ? RES.tarrow : l.startsWith("nonesuch") ? RES.nonesuch : l.startsWith("calloway") ? RES.calloway : {query:q, matches:[], note:"No saved company matches.", groups:[], groupNote:null}); },
      search:()=>({status:200, body:copy(SEARCH)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(body.action==="status") return J(200,t.status());
        if(body.action==="reference") return J(200,REFS);
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        if(body.action==="search"){ if(t.delay) await new Promise(res=>setTimeout(res,t.delay)); const a=t.search(body); return J(a.status,a.body); }
        if(body.action==="document") return r.fulfill({status:200,contentType:"application/pdf",headers:{"access-control-allow-origin":"*"},body:"%PDF-1.4 made-up"});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)){ t.xlsxLoads++; return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; window.__opened=[]; window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; },opts);
    if(over.init) await p.addInitScript(over.init);
    await p.goto(BASE+(over.hash||"#compare")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.cells=async sel=>p.$$eval(sel+" tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.fn==="snl-filings" && c.body.action===a);
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    t.find=async q=>{ await p.fill("#cm_find",q); await p.press("#cm_find","Enter"); await p.waitForTimeout(200); };
    t.addCo=async (q,i)=>{ await t.find(q); await p.click(`#cm_matches [data-act="cmp-co"] >> nth=${i}`); await p.waitForTimeout(100); };
    t.addGroup=async q=>{ await t.find(q); await p.click('#cm_matches [data-act="cmp-group"] >> nth=0'); await p.waitForTimeout(300); };
    t.four=async()=>{ await t.addCo("Calloway",0); await t.addGroup("Tarrow"); await t.addCo("Nonesuch",0); await t.addCo("Nonesuch",1); };
    t.run=async()=>{ await p.click("#cm_run"); await p.waitForTimeout(500); };
    return t;
  }
  const csvRows=s=>s.replace(/^﻿/,"").split("\r\n");
  const fills=async sel=>p.$$eval(sel+" tbody tr",rs=>rs.map(r=>[...r.children].slice(1,-1).map(c=>c.style.background||c.className)));

  // ----- the view as it opens -----
  let t=await open(); let p=t.p;
  ok("a switch at the top goes between the two Compare pages, and marks this one", same(await t.list("#cmpSwitch a"),["Rates and filings","Programs and forms"]) && (await p.getAttribute('#cmpSwitch a[href="#compare"]',"aria-current"))==="page" && (await p.getAttribute('#cmpSwitch a[href="#forms"]',"href"))==="#forms");
  ok("a Compare tab after Snapshot, and it is the one open", same(await t.list("nav.tabs a"),["Filings","Snapshot","Compare","Market","Earnings","Statutory","Combination","Profile"]) && (await p.getAttribute('nav.tabs a[data-view="compare"]',"aria-current"))==="page" && (await t.txt(".action-title"))==="Compare carriers' filings side by side");
  ok("S&P's lists are loaded once, for the states", same(t.of("reference").map(c=>c.body),[{action:"reference"}]));
  ok("nothing chosen yet, 3 years by default, and no cost until two are chosen", (await t.txt("#cm_count"))==="none chosen yet; choose 2 to 8" && (await p.getAttribute('[data-act="cmp-years"][data-y="3"]',"aria-pressed"))==="true"
    && (await t.txt("#cm_cost"))==="Choose at least 2 carriers to see what the comparison costs." && (await t.txt("#cm_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in all 7 states in S&P's list, every filing type and status.");
  ok("with no saved sets, no saved-set control shows, and Compare is still registered as a place sets can be used", !(await p.$("#setpick_compare")) && await p.evaluate(()=>typeof SET_TARGETS==="object" && typeof SET_TARGETS.compare==="function"));
  await p.click('[data-act="cmp-find"]'); await p.waitForTimeout(100);
  ok("find with an empty box: says what to type", (await t.txt("#cm_findErr"))==="Type part of a company or group name." && t.of("resolve").length===0);
  await t.find("Zzz");
  ok("no match: says so in plain words", (await t.txt("#cm_noMatch"))==='No company in the app\'s company list matches "Zzz". Try a shorter part of the name.');

  // ----- choosing: companies and groups; one without an S&P id can't be used -----
  await t.find("Calloway");
  ok("groups first, then companies; the one with no S&P id can't be added and says why", same(await t.list("#cm_matches li .t1"),["Calloway Group (SNL P&C Group)","Calloway Insurance Co","Calloway Home Co","Calloway Re Co"])
    && (await p.$$('#cm_matches [data-act="cmp-co"]')).length===2 && (await t.txt("#cm_matches li >> nth=3 >> .noadd"))==="Can't be used: the company list has no S&P id for it, so its filings can't be searched.");
  await p.click('#cm_matches [data-act="cmp-co"] >> nth=0'); await p.waitForTimeout(100);
  ok("one carrier: its name, how many companies, a remove button; asks for one more", same(await t.list("#cm_cars .cchip"),["Calloway Insurance Co 1 company×"]) && (await t.txt("#cm_count"))==="1 of 8 chosen; choose at least one more" && !!(await p.$('#cm_cars [aria-label="Remove Calloway Insurance Co"]')));
  await p.click("#cm_run"); await p.waitForTimeout(100);
  ok("fewer than two: says what to do, sends nothing", (await t.txt("#cm_formErr"))==="Choose at least 2 carriers to compare: find each by name above." && t.of("search").length===0);
  await t.addCo("Calloway",0);
  ok("the same carrier twice: says so, and keeps one", (await t.txt("#cm_pickErr"))==="Calloway Insurance Co is already chosen." && (await p.$$("#cm_cars .cchip")).length===1);
  await t.addGroup("Tarrow");
  ok("a group: looked up by its own name, added as one carrier with its members; the one without an id counted", same(t.of("resolve").map(c=>c.body.q).slice(-1),["Tarrow Group"]) && (await t.txt("#cm_cars .cchip >> nth=1"))==="Tarrow Group (SNL P&C Group) group of 2 companies; 1 without an S&P id left out×");
  await t.addCo("Nonesuch",0); await t.addCo("Nonesuch",1);
  ok("four carriers chosen", same(await p.evaluate(()=>S.cmp.carriers.map(c=>c.name)),CAR) && (await t.txt("#cm_count"))==="4 of 8 chosen");
  ok("cost before it runs: one search of 5 companies, 3 requests", (await t.txt("#cm_cost"))==="About 3 S&P requests in 1 search (one for each 10 companies for each year of dates), more if S&P has many filings. 5 companies in all. A search run before costs nothing, and once this has run, reopening it below costs no S&P requests.", await t.txt("#cm_cost"));
  await p.click('[data-act="cmp-years"][data-y="5"]'); await p.waitForTimeout(80);
  ok("5 years: 5 requests, dates 5 x 365 days back", (await t.txt("#cm_cost")).startsWith("About 5 S&P requests in 1 search") && (await t.txt("#cm_dates")).startsWith("Filings published 15 Nov 2021 to 13 Nov,"));
  await p.click('[data-act="cmp-years"][data-y="3"]'); await p.waitForTimeout(80);

  // ----- the plan: as few requests as possible, within each search's limits -----
  ok("plan: companies in batches of 10, at most 100 companies and 60 requests a search, no more requests than one search of everything", await p.evaluate(()=>{
    const car=(name,n,base,kind="institutionId")=>({kind:"group", name, ids:Array.from({length:n},(_,i)=>({kind, id:String(base+i)}))});
    const a=cmpPlan([car("A",69,1000),car("B",40,2000),car("C",1,3000)],3,["FL"]), b=cmpPlan([car("A",230,1000)],1,["FL"]), c=cmpPlan([car("A",15,1000,"companyId"),car("B",7,2000)],5,["FL"]);
    const d=cmpPlan([car("A",100,1000),car("B",100,2000)],5,["FL"]);
    const shared=cmpPlan([car("A",3,1000),{kind:"company", name:"x", ids:[{kind:"institutionId", id:"1001"}]}],3,["FL"]);
    const fits=pl=>pl.parts.every(q=>q.companyIds.length+q.institutionIds.length<=MAX_COMPANIES && snapCost(cmpPartIds(q), q.from, q.to)<=MAX_SEARCH_REQUESTS);
    return [a.parts.map(q=>q.institutionIds.length), a.requests, a.parts[1].institutionIds, b.parts.map(q=>q.institutionIds.length), b.requests, c.parts.length, c.parts[0].companyIds.length, c.parts[0].institutionIds.length, c.requests,
      d.parts.map(q=>q.institutionIds.length), d.requests, [a,b,c,d].every(fits), shared.ids.length, shared.requests]; }).then(v=>same(v,[[100,10],33,[2031,2032,2033,2034,2035,2036,2037,2038,2039,3000],[100,100,30],23,1,15,7,15,[100,100],100,true,3,3])||console.log(v)));
  ok("too big: what it costs, which period fits and which carrier to remove first", await p.evaluate(()=>{
    const g=(i,n)=>({kind:"group", name:`Nonesuch Group ${i}`, ids:Array.from({length:n},(_,k)=>({kind:"institutionId", id:String(i*1000+k)}))});
    const eight=[1,2,3,4,5,6,7,8].map(i=>g(i,60)); eight[3]=g(4,65);
    return [cmpTooBig(eight,5), cmpTooBig(eight,5,40), cmpTooBig(eight,1)]; }).then(v=>same(v,[
      "This comparison needs about 245 S&P requests in 5 searches, more than the 150 one comparison may use. Choose the last 3 years instead, or remove carriers, starting with the largest: Nonesuch Group 4 (65 companies, about 35 S&P requests on its own over these dates).",
      "This comparison needs about 245 S&P requests in 5 searches, more than the 40 one comparison may use. Remove carriers, starting with the largest: Nonesuch Group 4 (65 companies, about 35 S&P requests on its own over these dates).", ""])||console.log(v)));
  ok("too big for what is left this hour: says so before anything runs", await p.evaluate(()=>{ S.status.filings.used.hour=499; const m=cmpTooBig(S.cmp.carriers,3); S.status.filings.used.hour=12; return m; })
    .then(v=>v==="This comparison needs about 3 S&P requests, and only 1 is left this hour. Wait for the next hour, or choose a shorter period or fewer carriers."));

  // ----- running it -----
  t.delay=400;
  await p.click("#cm_run"); await p.waitForTimeout(150);
  ok("loading: says so, and the button waits", (await t.txt("#cmBusy")).startsWith("Searching… Each search can take a minute or so.") && await p.isDisabled("#cm_run"));
  await p.waitForTimeout(500); t.delay=0;
  ok("one search: every company once, every state, the last 3 years, no filters", same(t.of("search").map(c=>c.body),[MAIN]), t.of("search").map(c=>c.body));
  ok("heading and what was searched", (await t.txt("#cmName"))==="Comparing 4 carriers" && (await t.txt("#cmMeta"))==="filings published 15 Nov 2023 to 13 Nov · 7 states searched · every filing type and status · 5 companies in 1 search", await t.txt("#cmMeta"));
  ok("the cautions, once, near the top: not weighted, not averaged, counted once, shared filings marked, a stray filing left out", same(await t.list("#cmCaution li"),[
    "A rate impact is S&P's overall figure for the filing. It isn't weighted by premium, and for a filing that isn't approved it may be what the company asked for rather than what was approved.",
    "Nothing is averaged across statuses: each figure is one filing's, shown with its status.",
    "Each filing version counts once for each carrier. A filing that names companies in two of the carriers counts for both and is marked \"In 2 carriers\": 1 filing does here.",
    "1 filing S&P returned names none of the chosen companies' S&P ids, so it is left out."]), await t.list("#cmCaution li"));

  // summary, by hand (see the fixture): Calloway 1,2,3,4,5,15; Tarrow 5,6,7,8,9,10,16; Nonesuch Coastal 11-14; Nonesuch Quiet nothing
  const sum=(await t.cells("#cmSumTable")).map(r=>r.slice(1));
  ok("summary: one row per carrier, every figure by hand", same(sum,[
    ["6","3","1","2","3","3","(2.5%) to 9.8%","9.8%FL, 20 Oct, Pending","20 Oct","Open its snapshot"],
    ["7","4","1","1","5","4","(2.5%) to 12.5%","7.0%GA, 15 Sept, Withdrawn","15 Sept","Open its snapshot"],
    ["4","3","1","1","2","3","(3.0%) to 5.0%","5.0%FL, 5 Nov, Pending","5 Nov","Open its snapshot"],
    ["S&P returned nothing","n/d","n/d","n/d","n/d","n/d","n/d","n/d","n/d","Open its snapshot"]]), sum);
  ok("summary: each carrier's kind and companies", same(await t.list("#cmSumTable td.c-car .t2"),["Company · part of Calloway Group (SNL P&C Group)","Group · 2 companies","Company","Company"]));
  ok("nothing for one carrier: said, never as zero", (await t.txt("#cmNothingFor"))==="S&P returned nothing for Nonesuch Quiet Co in this comparison. That isn't proof that nothing was filed.");

  // rate chart: one lane per carrier with a rate impact; marks oldest first in each lane
  const marks=await p.$$eval("#cmRateChart .mk",e=>e.map(x=>({c:x.getAttribute("class"), t:x.querySelector("title").textContent})));
  ok("rate chart: a lane per carrier, named, with how many marks", same(await t.list("#cmRateChart text.ln"),["Calloway Insurance Co · 3 filings","Tarrow Group (SNL P&C Group) · 4 filings","Nonesuch Coastal Co · 3 filings"]));
  ok("rate chart: up, down and no change differ; only approved filled; the shared filing in both lanes", same(marks.map(m=>m.c),["mk dn","mk up","mk up open","mk up","mk dn","mk up","mk up open","mk dn open","mk z","mk up open"])
    && marks[2].t==="20 Oct, FL Homeowners: 9.8%, Pending" && marks[0].t==="1 Aug 2025, FL Homeowners: (2.5%), Approved" && marks[4].t===marks[0].t, marks);
  ok("rate chart: one scale for every lane, either side of zero, and years", same((await t.list("#cmRateChart text:not(.ln)")).filter(s=>/%/.test(s)),["15.0%","0.0%","(15.0%)","15.0%","0.0%","(15.0%)","15.0%","0.0%","(15.0%)"]) && same((await t.list("#cmRateChart text")).slice(0,3),["2024","2025","2026"]));
  ok("rate chart: the key, and the carrier with no lane named", same(await t.list("#cmRateKey li"),["▲Increase","▼Decrease","●No change","■Filled: approved","□Hollow: any other status, such as pending or withdrawn"]) && (await t.txt("#cmRateOff"))==="No row for Nonesuch Quiet Co (S&P returned nothing).");
  ok("rate chart: the figures as a list, by carrier, newest first, the shared one marked", same(await t.cells("#cmRatePts table"),[
    ["Calloway Insurance Co","20 Oct","FL","Homeowners","Rate","9.8%","Pending"],["Calloway Insurance Co","11 May","FL","Homeowners","Rate","6.2%","Approved"],["Calloway Insurance Co In 2 carriers","1 Aug 2025","FL","Homeowners","Rate","(2.5%)","Approved"],
    ["Tarrow Group (SNL P&C Group)","15 Sept","GA","Private passenger auto","Rate","7.0%","Withdrawn"],["Tarrow Group (SNL P&C Group)","30 Sept 2025","CA","Commercial property","Rate","12.5%","Approved"],["Tarrow Group (SNL P&C Group) In 2 carriers","1 Aug 2025","FL","Homeowners","Rate","(2.5%)","Approved"],["Tarrow Group (SNL P&C Group)","20 Feb 2024","FL","Homeowners","Rate","4.0%","Approved"],
    ["Nonesuch Coastal Co","5 Nov","FL","Homeowners","Rate and rule","5.0%","Pending"],["Nonesuch Coastal Co","2 Mar","FL","Homeowners","Rate","0.0%","Approved"],["Nonesuch Coastal Co","10 Oct 2024","SC","Dwelling fire","Rate","(3.0%)","Disapproved"]]), await t.cells("#cmRatePts table"));

  // carrier by state, by count: most filings first; "none returned" where S&P returned nothing, never 0
  const NR="none returned";
  ok("by state: carriers as columns", same(await t.list("#cmStatesTable thead th"),["State",...CAR,"All carriers"]));
  ok("by state: every count by hand, sorted by all carriers' filings", same(await t.cells("#cmStatesTable"),[
    ["Florida (FL)","4","2","2",NR,"7"],["California (CA)",NR,"2",NR,NR,"2"],["Georgia (GA)","1","1",NR,NR,"2"],["South Carolina (SC)",NR,NR,"2",NR,"2"],["Texas (TX)","1","1",NR,NR,"2"],["New York (NY)",NR,"1",NR,NR,"1"]]), await t.cells("#cmStatesTable"));
  ok("by state: shaded in steps, darkest for most; nothing-returned cells unshaded", same((await fills("#cmStatesTable"))[0],["rgb(0, 83, 158)","rgb(156, 195, 227)","rgb(156, 195, 227)","cmna"]) && (await fills("#cmStatesTable"))[2][0]==="rgb(214, 230, 243)" && await p.$eval("#cmStatesTable tbody tr td:nth-child(2)",e=>e.classList.contains("lt")));
  ok("by state: the key, and the state where nobody returned anything", same(await t.list("#cmStatesTableKey li"),["1 filing","2 filings","3 filings","4 filings","None returned: S&P returned nothing for that carrier there"]) && (await t.txt("#cmStateNone"))==="S&P returned nothing for any of these carriers in WA. That isn't proof that nothing was filed there.");
  await p.click('[data-act="cmp-multi"]'); await p.waitForTimeout(100);
  ok("by state: only states where two or more carriers filed", same((await t.cells("#cmStatesTable")).map(r=>r[0]),["Florida (FL)","Georgia (GA)","Texas (TX)"]) && (await p.getAttribute('[data-act="cmp-multi"]',"aria-pressed"))==="true");
  await p.click('[data-act="cmp-multi"]'); await p.click('[data-act="cmp-by"][data-by="rate"]'); await p.waitForTimeout(100);
  ok("by state, latest rate impact: each with its date and status; a state with filings but no impact says so", same(await t.cells("#cmStatesTable"),[
    ["Florida (FL)","9.8%20 Oct, Pending","(2.5%)1 Aug 2025, Approved","5.0%5 Nov, Pending",NR,"7"],["California (CA)",NR,"12.5%30 Sept 2025, Approved",NR,NR,"2"],["Georgia (GA)","1 filing, no rate impact","7.0%15 Sept, Withdrawn",NR,NR,"2"],
    ["South Carolina (SC)",NR,NR,"(3.0%)10 Oct 2024, Disapproved",NR,"2"],["Texas (TX)","1 filing, no rate impact","1 filing, no rate impact",NR,NR,"2"],["New York (NY)",NR,"1 filing, no rate impact",NR,NR,"1"]]), await t.cells("#cmStatesTable"));
  ok("by state, latest rate impact: shaded up and down", same((await fills("#cmStatesTable"))[0].slice(0,3),["rgb(235, 0, 140)","rgb(140, 203, 198)","rgb(235, 0, 140)"]) && same((await t.list("#cmStatesTableKey li")).slice(0,6),["Down 5.0% or more","Down by less than 5.0%","No change","Up by less than 5.0%","Up 5.0% or more","Filings, but none with a rate impact"]));
  await p.click('[data-act="cmp-by"][data-by="count"]'); await p.waitForTimeout(80);

  // carrier by type of insurance
  ok("by type of insurance: the lines that appear, every count by hand", same(await t.cells("#cmTypesTable"),[["Homeowners","5","3","3",NR,"10"],["Commercial property",NR,"3",NR,NR,"3"],["Private passenger auto","1","1",NR,NR,"2"],["Dwelling fire",NR,NR,"1",NR,"1"]]), await t.cells("#cmTypesTable"));
  await p.click('[data-act="cmp-toi-by"][data-by="rate"]'); await p.click('[data-act="cmp-toi-multi"]'); await p.waitForTimeout(100);
  ok("by type, latest rate impact, two or more carriers", same(await t.cells("#cmTypesTable"),[["Homeowners","9.8%20 Oct, Pending","(2.5%)1 Aug 2025, Approved","5.0%5 Nov, Pending",NR,"10"],["Private passenger auto","1 filing, no rate impact","7.0%15 Sept, Withdrawn",NR,NR,"2"]]), await t.cells("#cmTypesTable"));
  await p.click('[data-act="cmp-toi-by"][data-by="count"]'); await p.click('[data-act="cmp-toi-multi"]'); await p.waitForTimeout(80);

  // filings by year: small charts on one scale, and the table
  ok("by year: the counts by hand, with filings that have no publish date", same(await t.cells("#cmYearTable"),[["Calloway Insurance Co","0","1","2","2","1"],["Tarrow Group (SNL P&C Group)","1","1","2","3","0"],["Nonesuch Coastal Co","0","1","1","2","0"],["Nonesuch Quiet Co",NR,NR,NR,NR,NR]]), await t.cells("#cmYearTable"));
  ok("by year: one small chart per carrier with its numbers, on one shared scale", same(await p.$$eval("#cmYearCharts .cmyr",e=>e.map(x=>[...x.querySelectorAll("text.tot")].map(y=>y.textContent).join(","))),["0,1,2,2","1,1,2,3","0,1,1,2",""])
    && (await t.txt("#cmYears .snnote")).includes("every carrier on the same scale (0 to 4)") && await p.evaluate(()=>{ const h=[...document.querySelectorAll("#cmYearCharts .cmyr")].slice(0,3).map(c=>[...c.querySelectorAll("rect")].map(r=>+r.getAttribute("height"))); return h[1][3]>h[0][2] && h[0][2]===h[2][2] && h[0][0]===h[1][0] && h[0].length===3; })
    && (await t.txt('#cmYearCharts .cmyr[data-i="3"]'))==="Nonesuch Quiet CoS&P returned nothing for this carrier.");

  // latest filings
  const tn=async()=>p.$$eval("#cmLatestTable tbody tr",rs=>rs.map(r=>r.querySelector(".c-tn").textContent.replace(/\s+/g," ").trim()));
  ok("latest: no empty columns (no row has a description)", same(await t.list("#cmLatestTable thead th"),["Company","Carrier","State","Type of insurance","Filing type","Status","Published","Filing number","Document"]));
  ok("latest: the 12 newest of 16, newest first, numbered by tracking number or S&P's number", (await t.txt("#cmLatestCount"))==="The 12 most recent of 16, newest first by the date S&P published them." && same(await tn(),["S&P no. SFC-CMP-0014","CALL-CMP-0002","S&P no. SFC-CMP-0009","S&P no. SFC-CMP-0008","S&P no. SFC-CMP-0001","S&P no. SFC-CMP-0011","S&P no. SFC-CMP-0016","S&P no. SFC-CMP-0007","S&P no. SFC-CMP-0005","S&P no. SFC-CMP-0003","S&P no. SFC-CMP-0012","S&P no. SFC-CMP-0013"]), await tn());
  ok("latest: a row in full, and the shared filing marked with both carriers", same((await t.cells("#cmLatestTable"))[0],["Nonesuch Coastal Co","Nonesuch Coastal Co","FL","Homeowners","Rate and rule","Pending","5 Nov","S&P no. SFC-CMP-0014","Open document"])
    && same((await t.cells("#cmLatestTable"))[8].slice(0,2),["Calloway Insurance CoTarrow Mutual Insurance Co","Calloway Insurance CoTarrow Group (SNL P&C Group)In 2 carriers"]));
  await p.click('[data-act="cmp-more"]'); await p.waitForTimeout(100);
  ok("latest: show more, the undated one last", (await p.$$("#cmLatestTable tbody tr")).length===16 && (await tn())[15]==="S&P no. SFC-CMP-0015" && !(await p.$('[data-act="cmp-more"]')));
  await p.selectOption("#cm_who","1"); await p.waitForTimeout(150);
  ok("latest: filtered to one carrier; a filing naming both its companies shows once", same(await tn(),["S&P no. SFC-CMP-0009","S&P no. SFC-CMP-0008","S&P no. SFC-CMP-0016","S&P no. SFC-CMP-0007","S&P no. SFC-CMP-0005","S&P no. SFC-CMP-0006","S&P no. SFC-CMP-0010"]) && (await t.cells("#cmLatestTable"))[6][0]==="Tarrow Mutual Insurance CoTarrow Specialty Co");
  await p.selectOption("#cm_who","3"); await p.waitForTimeout(150);
  ok("latest: a carrier S&P returned nothing for says so", (await t.txt("#cmLatestNone"))==="S&P returned nothing for Nonesuch Quiet Co in this comparison.");
  await p.selectOption("#cm_who","1"); await p.waitForTimeout(150);
  await p.click('#cmLatestTable tbody tr >> nth=0 >> [data-act="open-doc"]'); await p.waitForTimeout(250);
  ok("Open document opens the filing's document", same(t.of("document").map(c=>c.body),[{action:"document", documentId:8810009}]));
  ok("source line", (await t.txt("#cmSource"))==="Source: S&P Global Market Intelligence, SNL Insurance Product Filings, fetched 13 Nov. Worked out in this browser from the filings S&P returned. Opening a document uses one S&P request the first time.");
  { const names=[...CAR,"Calloway Group (SNL P&C Group)","Filings view","S&P"," Nov"], loud=(await t.list("#view h2,#view h3,#view h4,#view button,nav a")).filter(s=>/\s[A-Z][a-z]+/.test(names.reduce((a,n)=>a.split(n).join("x"),s)));
    ok("headings and buttons are in sentence case", loud.length===0, loud); }
  ok("no page errors so far", errs.length===0, errs);
  await p.selectOption("#cm_who","all"); await p.waitForTimeout(150);
  await p.screenshot({path:OUTDIR+"/compare-1440.png",fullPage:true});
  await p.screenshot({path:SCRATCH+"/compare-1440.png",fullPage:true}).catch(()=>{});

  // ----- exports -----
  let d=await t.download(()=>p.click('#cmSummary [data-act="export"][data-fmt="csv"]'));
  ok("summary CSV: numbers as numbers, the empty carrier noted, not zero", d.name==="snl-compare-4-carriers-summary-2026-11-13.csv" && same(csvRows(d.text),[
    '"Carrier","Kind","Companies","Filings","Rate filings","Rule filings","Form filings","States with filings","Rate filings with an impact","Lowest rate impact (%)","Highest rate impact (%)","Latest rate change (%)","Latest rate change, state","Latest rate change, date published","Latest rate change, status","Latest filing, date published","Note"',
    '"Calloway Insurance Co","Company","1","6","3","1","2","3","3","-2.5","9.8","9.8","FL","2026-10-20","Pending","2026-10-20",""',
    '"Tarrow Group (SNL P&C Group)","Group","2","7","4","1","1","5","4","-2.5","12.5","7","GA","2026-09-15","Withdrawn","2026-09-15",""',
    '"Nonesuch Coastal Co","Company","1","4","3","1","1","2","3","-3","5","5","FL","2026-11-05","Pending","2026-11-05",""',
    '"Nonesuch Quiet Co","Company","1","","","","","","","","","","","","","","S&P returned nothing for this carrier"']), csvRows(d.text));
  d=await t.download(()=>p.click('#cmStates [data-act="export"][data-fmt="csv"]'));
  ok("by state CSV: each carrier's filings and latest rate impact, 'S&P returned nothing' where it did", csvRows(d.text).length===7 && csvRows(d.text)[1]==='"FL","Florida","7","4","9.8","2026-10-20","Pending","2","-2.5","2025-08-01","Approved","2","5","2026-11-05","Pending","S&P returned nothing","","",""' && csvRows(d.text)[0].startsWith('"State","State name","All carriers (each filing once)","Calloway Insurance Co: filings","Calloway Insurance Co: latest rate impact (%)"'), csvRows(d.text).slice(0,2));
  d=await t.download(()=>p.click('#cmYears [data-act="export"][data-fmt="xlsx"]'));
  const wb=JSON.parse(d.text);
  ok("by year Excel: the same table, numbers as numbers", d.name==="snl-compare-4-carriers-by-year-2026-11-13.xlsx" && wb.sheets[0].name==="By year" && same(wb.sheets[0].aoa,[["Carrier","2023","2024","2025","2026","No publish date","Note"],["Calloway Insurance Co",0,1,2,2,1,""],["Tarrow Group (SNL P&C Group)",1,1,2,3,0,""],["Nonesuch Coastal Co",0,1,1,2,0,""],["Nonesuch Quiet Co","","","","","","S&P returned nothing for this carrier"]]) && t.xlsxLoads===1, wb);
  d=await t.download(()=>p.click('#cmRates [data-act="export"][data-fmt="csv"]'));
  ok("rate changes CSV: every mark, the shared one marked", csvRows(d.text).length===11 && csvRows(d.text)[3]==='"Calloway Insurance Co","Calloway Insurance Co; Tarrow Mutual Insurance Co","FL","Homeowners","Rate","Approved","2025-05-01","2025-08-01","-2.5","S&P no. SFC-CMP-0005","Yes","8810005","cmpver-0005-0000-made-up"', csvRows(d.text)[3]);
  d=await t.download(()=>p.click('#cmTypes [data-act="export"][data-fmt="csv"]'));
  ok("by type CSV", csvRows(d.text).length===5 && csvRows(d.text)[1].startsWith('"Homeowners","10","5","9.8"'));
  await p.selectOption("#cm_who","1"); await p.waitForTimeout(150);
  d=await t.download(()=>p.click('#cmLatest [data-act="export"][data-fmt="csv"]'));
  ok("latest CSV follows the carrier filter, every row", csvRows(d.text).length===8);
  await p.selectOption("#cm_who","all"); await p.waitForTimeout(150);
  d=await t.download(()=>p.click('#cmHead [data-act="export"][data-fmt="csv"]'));
  ok("all filings CSV: 16, the stray one left out", csvRows(d.text).length===17 && !d.text.includes("SFC-CMP-0018"));

  // ----- Ask Claude: told what is on screen as the one search behind it -----
  await p.click("#askFab"); await p.waitForTimeout(200);
  ok("Ask Claude says what it will be told", (await t.txt("#askTold"))==="Claude will be told what is on screen: 17 filings for 5 institutions in 7 states, 15 Nov 2023 to 13 Nov.", await t.txt("#askTold"));
  await p.fill("#ask_input","Who is raising rates most?"); await p.press("#ask_input","Enter"); await p.waitForTimeout(300);
  const ask=t.calls.find(c=>c.fn==="snl-chat" && c.body.action==="ask");
  ok("the question goes with the search behind the comparison and the carriers' names", !!ask && same(ask.body.screen,{view:"filings", search:{companyIds:[], institutionIds:MAIN.institutionIds, states:STATES, from:"2023-11-15", to:"2026-11-13", typeOfInsuranceIds:[], filingTypeIds:[], filingStatusIds:[]}, total:17, companies:[...CAR,"Tarrow Mutual Insurance Co","Tarrow Specialty Co"]}), ask&&ask.body.screen);
  await p.click("#askClose"); await p.waitForTimeout(100);

  // ----- hand-offs: a carrier's own Snapshot, and the Filings view -----
  let n0=t.of("search").length;
  await p.click('#cmSumTable [data-act="cmp-snap"][data-i="1"]'); await p.waitForTimeout(400);
  ok("Open its snapshot: the Snapshot view with the carrier chosen and the same period, nothing spent until asked", (await p.getAttribute('nav.tabs a[data-view="snapshot"]',"aria-current"))==="page" && (await t.txt("#sn_chosen"))==="Chosen: Tarrow Group (SNL P&C Group) group of 2 companies with S&P ids in the company list; 1 company has no S&P id and is left out Clear"
    && (await p.getAttribute('[data-act="snap-years"][data-y="3"]',"aria-pressed"))==="true" && t.of("search").length===n0 && (await t.txt("#toastRoot"))==="Tarrow Group (SNL P&C Group) is chosen on the Snapshot view. Press Show snapshot to run it: about 3 S&P requests.", await t.txt("#toastRoot"));
  await p.click("#sn_run"); await p.waitForTimeout(450);
  const snapBody=t.of("search").slice(-1)[0].body;
  ok("the snapshot runs for the carrier's own companies", same(snapBody,{...MAIN, institutionIds:[5100001,5100002]}));
  await p.click('nav.tabs a[data-view="compare"]'); await p.waitForTimeout(250);
  ok("back on Compare, the comparison is still there", (await t.txt("#cmName"))==="Comparing 4 carriers");
  n0=t.of("search").length;
  await p.click('#cmSumTable [data-act="cmp-snap"][data-i="1"]'); await p.waitForTimeout(450);
  ok("a snapshot run before in this browser opens straight away from its saved search", t.of("search").length===n0+1 && same(t.of("search").slice(-1)[0].body,snapBody) && (await t.txt("#snName"))==="Tarrow Group (SNL P&C Group)");
  await p.click('nav.tabs a[data-view="compare"]'); await p.waitForTimeout(250);
  n0=t.of("search").length;
  await p.click("#cm_toFilings"); await p.waitForTimeout(450);
  ok("See every filing: the Filings view with the form filled and the same search run", (await p.getAttribute('nav.tabs a[data-view="filings"]',"aria-current"))==="page" && same(await t.list("#chips .cchip b"),["Calloway Insurance Co","Tarrow Mutual Insurance Co","Tarrow Specialty Co","Nonesuch Coastal Co","Nonesuch Quiet Co"])
    && t.of("search").length===n0+1 && same(t.of("search").slice(-1)[0].body,MAIN) && (await p.inputValue("#f_from"))==="2023-11-15");
  await p.click('nav.tabs a[data-view="compare"]'); await p.waitForTimeout(250);

  // ----- comparisons run before, reopened from this browser -----
  ok("the comparison is listed to reopen", same(await t.list("#cm_recent li"),["Calloway Insurance Co, Tarrow Group (SNL P&C Group), Nonesuch Coastal Co and 1 more 15 Nov 2023 to 13 Nov"]));
  await p.reload(); await p.waitForTimeout(500);
  t.search=()=>({status:200, body:{...copy(SEARCH), fromStore:true, fetchedAt:"2026-11-13T11:00:00Z"}});
  await p.click('[data-act="cmp-recent"]'); await p.waitForTimeout(400);
  ok("after a reload, reopening sends the same search, which opens from the saved result", same(t.of("search").slice(-1)[0].body,MAIN) && (await t.txt("#cmFromStore"))==="From saved results fetched 13 Nov, so opening it used no S&P requests.Refresh from S&P" && same(await p.evaluate(()=>S.cmp.carriers.map(c=>c.name)),CAR));
  t.search=()=>({status:200, body:copy(SEARCH)});
  await p.click('[data-act="cmp-refresh"]'); await p.waitForTimeout(400);
  ok("Refresh asks S&P again for the same search", same(t.of("search").slice(-1)[0].body,{...MAIN, refresh:true}) && !(await p.$("#cmFromStore")));

  // ----- phone -----
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(250);
  ok("phone: no sideways scroll with a full comparison", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  ok("phone: the charts are redrawn for the width; wide tables scroll in their own box", (await p.getAttribute("#cmRateChart","viewBox")).startsWith("0 0 360 ") && await p.evaluate(()=>{ const w=document.getElementById("cmStatesTableWrap"); return w.scrollWidth>w.clientWidth && getComputedStyle(w).overflowX==="auto"; }));
  ok("phone: every tab in sight", await p.evaluate(()=>[...document.querySelectorAll("nav.tabs a")].every(a=>{ const r=a.getBoundingClientRect(); return r.left>=0 && r.right<=window.innerWidth; })));
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(200);
  ok("wide again: charts drawn wide", (await p.getAttribute("#cmRateChart","viewBox")).startsWith("0 0 1240 "));
  await t.ctx.close();

  // ----- the phone screenshot for the owner, at twice the pixels -----
  t=await open({}, {width:390}); p=t.p;
  await t.four(); await t.run();
  ok("phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/compare-390.png",fullPage:true});
  await p.screenshot({path:SCRATCH+"/compare-390.png",fullPage:true}).catch(()=>{});
  await t.ctx.close();

  // ----- the nav with seven tabs (all seven real ones now that Earnings is a tab) -----
  for(const w of [390, 1440]){
    t=await open({}, {width:w}); p=t.p;
    await p.waitForTimeout(100);
    const geo=await p.evaluate(()=>[...document.querySelectorAll("nav.tabs a")].map(a=>{ const r=a.getBoundingClientRect(); return {l:r.left, r:r.right, t:r.top, b:r.bottom}; }));
    const overlap=geo.some((x,i)=>geo.some((y,j)=>i<j && x.l<y.r-0.5 && y.l<x.r-0.5 && x.t<y.b-0.5 && y.t<x.b-0.5));
    ok(`nav with eight tabs (a Corp Dev login) at ${w}px: every tab whole and in sight, none overlapping, no sideways scroll`, geo.length===8 && geo.every(x=>x.l>=0 && x.r<=w) && !overlap && await t.noScroll(), geo);
    ok(`nav at ${w}px: ${w<500?"two rows":"one row"}`, new Set(geo.map(x=>Math.round(x.t))).size===(w<500?2:1), geo.map(x=>x.t));
    if(w<500) await p.screenshot({path:OUTDIR+"/compare-nav7-390.png", clip:{x:0,y:0,width:390,height:220}});
    await t.ctx.close();
  }

  // ----- several searches: progress, one failing, the retry of only that one -----
  {
    let fail2=true;
    t=await open({}, {search:body=>body.institutionIds.length===100 ? {status:200, body:copy(PART1)} : fail2 ? {status:429, body:{error:"spgmi_limit", message:"This hour's 500 S&P requests are used up. Try again after the hour.", requestId:"req-7"}} : {status:200, body:copy(PART2)}}); p=t.p;
    await t.addGroup("Nonesuch Big"); await t.addGroup("Nonesuch Wide"); await t.addCo("Calloway",0);
    ok("110 companies: the cost in two searches", (await t.txt("#cm_cost"))==="About 33 S&P requests in 2 searches (one for each 10 companies for each year of dates), more if S&P has many filings. 110 companies in all. A search takes at most 100 companies, so they run one after another. A search run before costs nothing, and once this has run, reopening it below costs no S&P requests.", await t.txt("#cm_cost"));
    t.delay=400;
    await p.click("#cm_run"); await p.waitForTimeout(200);
    const first=await t.txt("#cmBusy");
    await p.waitForTimeout(450);
    const second=await t.txt("#cmBusy");
    ok("progress: searching 1 of 2, then 2 of 2, each search listed", first.startsWith("Searching 1 of 2…") && first.includes("Search 1: 100 companies running…") && second.startsWith("Searching 2 of 2…") && second.includes("Search 1: 100 companies done"), [first, second]);
    await p.waitForTimeout(500); t.delay=0;
    const sent=t.of("search").map(c=>c.body);
    ok("the two searches: the first 100 companies, then the other 10, each within its limits", sent.length===2 && sent[0].institutionIds.length===100 && same(sent[1].institutionIds,[6100032,6100033,6100034,6100035,6100036,6100037,6100038,6100039,6100040,5000001]) && sent.every(s=>same(s.states,STATES) && s.from==="2023-11-15"));
    ok("one search failed: what was got and what wasn't, with S&P's reference", (await t.txt("#cmFailed"))==="Search 2 of 2 didn't run. This hour's 500 S&P requests are used up. Try again after the hour. S&P reference: req-7. Below: Nonesuch Big Group in full. Not fetched: Calloway Insurance Co and 9 of the 40 companies in Nonesuch Wide Group.Try search 2 again", await t.txt("#cmFailed"));
    ok("one search failed: the carriers it left out say so, never as zero", same((await t.cells("#cmSumTable")).map(r=>[r[0],r[1]]),[["Nonesuch Big GroupGroup · 69 companies","1"],["Nonesuch Wide GroupGroup · 40 companiesPartly fetched: 31 of 40 companies","1"],["Calloway Insurance CoCompany · part of Calloway Group (SNL P&C Group)Not fetched","n/d"]])
      && same(await t.cells("#cmStatesTable"),[["Florida (FL)","1",NR,"not fetched","1"],["Georgia (GA)",NR,"1","not fetched","1"]]), [await t.cells("#cmSumTable"), await t.cells("#cmStatesTable")]);
    ok("one search failed: not listed to reopen, Ask Claude not told of a comparison one search can't hold", !(await p.$("#cm_recent")) && await p.evaluate(()=>askScreen()===null));
    ok("several searches: the Filings view one search at a time", same(await t.list("#cm_toFilings button"),["Search 1","Search 2"]));
    await p.screenshot({path:OUTDIR+"/compare-failed-1440.png",fullPage:true});
    fail2=false;
    await p.click('[data-act="cmp-retry"]'); await p.waitForTimeout(500);
    ok("Try again sends only the failed search, and the comparison is whole", t.of("search").length===3 && same(t.of("search")[2].body,sent[1]) && !(await p.$("#cmFailed"))
      && same(await t.cells("#cmStatesTable"),[["Georgia (GA)",NR,"2",NR,"2"],["Florida (FL)","1",NR,NR,"1"],["Texas (TX)",NR,NR,"1","1"]]) && same(await t.list("#cm_recent li b"),["Nonesuch Big Group, Nonesuch Wide Group and Calloway Insurance Co"]), await t.cells("#cmStatesTable"));
    await p.click('#cm_toFilings button >> nth=1'); await p.waitForTimeout(450);
    ok("Search 2 on the Filings view: its 10 companies, by name", (await p.$$("#chips .cchip")).length===10 && same(t.of("search").slice(-1)[0].body,sent[1]) && (await t.list("#chips .cchip b")).includes("Nonesuch Wide Member 35 Co"));
    await p.click('nav.tabs a[data-view="compare"]'); await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(250);
    ok("several searches, phone: no sideways scroll", await t.noScroll());
    await t.ctx.close();

    // the session ends during the second search
    t=await open({}, {search:body=>body.institutionIds.length===100 ? {status:200, body:copy(PART1)} : {status:401, body:{error:"signin", message:"Your session has ended. Sign in again."}}}); p=t.p;
    await t.addGroup("Nonesuch Big"); await t.addGroup("Nonesuch Wide"); await t.addCo("Calloway",0); await t.run();
    ok("session ended mid-way: back to sign-in with the message, nothing kept", await p.isVisible("#loginForm") && (await t.txt(".login .err"))==="Your session has ended. Sign in again." && await p.evaluate(()=>S.cmp.parts===null && S.cmp.carriers.length===0));
    await t.ctx.close();
  }
  t=await open({}, {}); p=t.p; t.delay=500;
  await t.addCo("Calloway",0); await t.addCo("Nonesuch",0); await p.click("#cm_run"); await p.waitForTimeout(100);
  await p.evaluate(()=>__mock.fire("SIGNED_OUT")); await p.waitForTimeout(700);
  ok("signed out while it ran: the late answer is dropped", await p.isVisible("#loginForm") && await p.evaluate(()=>S.cmp.parts===null && S.cmp.busy===false) && errs.length===0);
  await t.ctx.close();

  // ----- too big, before anything runs -----
  {
    const g=i=>whole(`Nonesuch Group ${i}`, 60, 7000000+i*1000);
    t=await open({}, {resolve:q=>{ const m=q.match(/Nonesuch Group (\d)/i); return m ? {query:q, matches:[memberOf(`Nonesuch Group ${m[1]}`,1,7000000+m[1]*1000)], groups:[g(+m[1])], groupNote:null} : {query:q, matches:[]}; }}); p=t.p;
    for(const i of [1,2,3,4,5,6,7,8]) await t.addGroup(`Nonesuch Group ${i}`);
    await p.click('[data-act="cmp-years"][data-y="5"]'); await p.waitForTimeout(100);
    ok("too big: says plainly what it costs, which period fits and what to remove", (await t.txt("#cm_tooBig"))==="This comparison needs about 240 S&P requests in 5 searches, more than the 150 one comparison may use. Choose the last 3 years instead, or remove carriers, starting with the largest: Nonesuch Group 1 (60 companies, about 30 S&P requests on its own over these dates).", await t.txt("#cm_tooBig"));
    await p.click("#cm_run"); await p.waitForTimeout(100);
    ok("too big: nothing is sent", t.of("search").length===0 && (await t.txt("#cm_formErr")).startsWith("This comparison needs about 240"));
    ok("eight carriers: the list is full and says so", (await t.txt("#cm_count"))==="8 of 8 chosen" && await p.evaluate(()=>{ cmpAdd({kind:"company", name:"Tarrow Mutual Insurance Co", ids:[{kind:"institutionId", id:"5100001"}]}); return S.cmp.pickErr; }).then(v=>v==="A comparison takes at most 8 carriers. Remove one to add Tarrow Mutual Insurance Co."));
    await t.find("Nonesuch Group 1");
    ok("eight carriers: Add is off in the finder", await p.isDisabled('#cm_matches [data-act="cmp-group"]'));
    await p.click('[data-act="cmp-years"][data-y="3"]'); await p.waitForTimeout(100);
    ok("too big: the 3 years fit, in 5 searches of 144 requests", (await t.txt("#cm_cost")).startsWith("About 144 S&P requests in 5 searches"));
    await p.setViewportSize({width:390,height:844}); await p.click('[data-act="cmp-years"][data-y="5"]'); await p.waitForTimeout(150);
    ok("too big, phone: no sideways scroll", await t.noScroll());
    await t.ctx.close();
  }

  // ----- groups that can't be one carrier -----
  t=await open({}, {resolve:q=>/paper/i.test(q) ? {query:q, matches:[{companyId:null, companyName:"Nonesuch Paper Co", institutionId:null, naicGroupName:"Nonesuch Paper Group"}], groups:[]}
    : /giant/i.test(q) ? {query:q, matches:[memberOf("Nonesuch Giant Group",1,8000000)], groups:[{...whole("Nonesuch Giant Group",100,8000000), companies:130, searchable:130, tooBig:true}]} : {query:q, matches:[]}}); p=t.p;
  await t.addGroup("Paper");
  ok("a group with no S&P id: refused, says why", (await t.txt("#cm_pickErr"))==="None of the companies in Nonesuch Paper Group has an S&P id in the company list, so its filings can't be searched or compared." && !(await p.$("#cm_cars")));
  await t.addGroup("Giant");
  ok("a group too big to list: refused, says what to do", (await t.txt("#cm_pickErr"))==="Nonesuch Giant Group has more than 100 companies with S&P ids in the company list, more than the app can list for one group. Compare some of its companies instead.");
  await t.ctx.close();

  // ----- partial, nothing returned for all, not set up -----
  t=await open({}, {search:()=>({status:200, body:{...copy(SEARCH), capped:true, saved:false, notes:["The search stopped after 60 S&P requests to stay inside the time limit, so these results are incomplete. Narrow the dates, states or companies and search again."]}})}); p=t.p;
  await t.four(); await t.run();
  ok("partial: says so, names the carriers whose counts are low, and what to do", (await t.txt("#cmPartial"))==="This comparison is partial. The search stopped at its limit before S&P had returned everything, so the counts for Calloway Insurance Co, Tarrow Group (SNL P&C Group), Nonesuch Coastal Co and Nonesuch Quiet Co are lower than they should be. Choose a shorter period or fewer carriers and run it again.", await t.txt("#cmPartial"));
  ok("partial: the figures still show, marked in the summary, and it isn't listed to reopen", (await t.cells("#cmSumTable"))[0][1]==="6" && (await t.txt("#cmSumTable tbody tr >> nth=0 >> .cmwarn"))==="Partial: the search stopped early" && !(await p.$("#cm_recent")));
  n0=t.of("search").length;
  await p.click("#cm_toFilings"); await p.waitForTimeout(400);
  ok("partial: the Filings form is filled, but nothing is run for the reader", t.of("search").length===n0 && (await p.$$("#chips .cchip")).length===5 && !(await p.$("#resTable")));
  await t.ctx.close();
  t=await open({}, {search:()=>({status:200, body:{...copy(SEARCH), rows:[], total:0}})}); p=t.p;
  await t.addCo("Calloway",0); await t.addCo("Nonesuch",0); await t.run();
  ok("nothing for any carrier: 'S&P returned nothing', never 'no filings exist'", (await t.txt("#cmEmpty")).startsWith("S&P returned nothing for this comparison, and that isn't proof that nothing was filed") && (await t.txt("#cmEmpty")).includes("It doesn't prove that none were filed.") && !(await p.$("#cmSummary")));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("nothing returned, phone: no sideways scroll", await t.noScroll());
  await t.ctx.close();
  t=await open({}, {status:()=>({...copy(STATUS), filings:{...STATUS.filings, configured:false, message:NOT_SET_UP}}), search:()=>({status:503, body:{error:"not_configured", message:NOT_SET_UP}})}); p=t.p;
  ok("not set up: says a new comparison can't run, saved ones still open", (await t.txt("#cmOff"))==="S&P filings aren't set up yet, so a new comparison can't be run. Comparisons run before still open from their saved results.");
  await t.addCo("Calloway",0); await t.addCo("Nonesuch",0); await t.run();
  ok("not set up: the function's answer is a calm note", (await t.txt("#cmErr"))===NOT_SET_UP && !(await p.$("#cmErr .banner")));
  await t.ctx.close();
  let k=0;
  // (big-searches) a search that fails on the far side is asked once more before it counts as failed
  t=await open({}, {search:()=>(++k<=2 ? {status:500, body:{error:"server", message:"The filings function failed: made-up fault"}} : {status:200, body:copy(SEARCH)})}); p=t.p;
  await t.four(); await t.run(); await p.waitForTimeout(1800);
  ok("the only search failed twice: says so with Try again", (await t.txt("#cmErr"))==="Couldn't run the comparison. The filings function failed: made-up faultTry again" && t.of("search").length===2);
  await p.click('[data-act="cmp-retry"]'); await p.waitForTimeout(450);
  ok("Try again: the same search, and the comparison shows", same(t.of("search").map(c=>c.body),[MAIN,MAIN,MAIN]) && (await t.cells("#cmSumTable"))[1][1]==="7");
  await t.ctx.close();

  // ----- the Filings form's "keep out of Recent searches" is respected -----
  t=await open(); p=t.p;
  await p.evaluate(()=>setUnlisted(true)); await t.four(); await t.run();
  ok("kept out of Recent searches when the Filings form says so", same(t.of("search")[0].body,{...MAIN, unlisted:true}));
  await t.ctx.close();

  // ----- saved carrier sets: the real control, fed from the shared "carrier_sets" setting -----
  {
    const SETS={sets:[{id:"s-ab12cd", name:"Florida homeowners peers", note:"", companies:[{companyName:"Calloway Insurance Co", companyId:null, institutionId:"5000001"}], groups:[], updatedAt:"2026-11-13T10:00:00Z"}]};
    t=await open({seed:[["snl_settings","carrier_sets",{doc:SETS}]]}); p=t.p; await p.waitForTimeout(300);
    ok("with a saved set: the control shows on Compare, and Compare is registered", !!(await p.$("#setpick_compare")) && !!(await p.$('#setpick_compare [data-act="set-use"][data-target="compare"]')) && await p.evaluate(()=>typeof SET_TARGETS.compare==="function"), await p.evaluate(()=>document.querySelector("#setpick_compare")?.outerHTML.slice(0,200)));
    const co=(name,id,extra)=>({kind:"institutionId", id:String(id), name, ...extra});
    await p.evaluate(([cs])=>SET_TARGETS.compare(cs, {id:"s-ab12cd", name:"Florida homeowners peers", leftOut:1, companies:[{companyName:"Calloway Insurance Co", companyId:null, institutionId:"5000001"},{companyName:"Nonesuch Coastal Co", companyId:null, institutionId:"5200001"}], groups:["Tarrow Group (SNL P&C Group)"]}),
      [[co("Calloway Insurance Co",5000001), co("Nonesuch Coastal Co",5200001), co("Tarrow Mutual Insurance Co",5100001), co("Tarrow Specialty Co",5100002)]]); await p.waitForTimeout(200);
    ok("a set: single companies as single carriers, its group as one carrier, and what was left out", same(await p.evaluate(()=>S.cmp.carriers.map(c=>[c.kind, c.name, c.ids.map(x=>x.id).join(",")])),[["company","Calloway Insurance Co","5000001"],["company","Nonesuch Coastal Co","5200001"],["group","Tarrow Group (SNL P&C Group)","5100001,5100002"]])
      && (await t.txt("#cm_setNote"))==='Filled from "Florida homeowners peers": 3 carriers. 1 company in the set has no S&P id and was left out.', await t.txt("#cm_setNote"));
    await t.run();
    ok("a set's comparison runs as one search", same(t.of("search")[0].body.institutionIds,[5000001,5200001,5100001,5100002]));
    const before=t.of("resolve").length;
    await p.evaluate(([cs])=>SET_TARGETS.compare(cs, {id:"s-2", name:"Two groups", companies:[], groups:["Tarrow Group (SNL P&C Group)","Calloway Group (SNL P&C Group)"]}),
      [[co("Tarrow Mutual Insurance Co",5100001), co("Calloway Insurance Co",5000001), co("Tarrow Specialty Co",5100002), co("Calloway Home Co",5000002)]]); await p.waitForTimeout(500);
    ok("a set of two groups with nothing saying whose company is whose: each group looked up by its name", same(t.of("resolve").slice(before).map(c=>c.body.q),["Tarrow Group","Calloway Group"]) && same(await p.evaluate(()=>S.cmp.carriers.map(c=>[c.name, c.ids.map(x=>x.id).join(",")])),[["Tarrow Group (SNL P&C Group)","5100001,5100002"],["Calloway Group (SNL P&C Group)","5000001,5000002"]]));
    await p.evaluate(([cs])=>SET_TARGETS.compare(cs, {id:"s-3", name:"Ten", companies:cs.filter(c=>!c.group).map(c=>({companyName:c.name, companyId:null, institutionId:c.id})), groups:["Tarrow Group (SNL P&C Group)"]}),
      [[...Array.from({length:9},(_,i)=>co(`Nonesuch Single ${i} Co`, 5400000+i)), co("Tarrow Mutual Insurance Co",5100001,{group:"Tarrow Group (SNL P&C Group)"})]]); await p.waitForTimeout(200);
    ok("a set of more than eight carriers: the first eight, and says how many were left out", (await p.evaluate(()=>S.cmp.carriers.length))===8 && (await t.txt("#cm_setNote"))==='Filled from "Ten": 8 carriers. A comparison takes at most 8 carriers, so the last 2 were left out.', await t.txt("#cm_setNote"));
    ok("sets: no page errors", errs.length===0, errs);
    await t.ctx.close();
  }

  // ----- hostile names -----
  t=await open({}, {resolve:q=>/odd/i.test(q) ? {query:q, matches:[{companyId:null, companyName:'Calloway <script>window.__xss=1</script> Co', institutionId:"5000009", naicGroupName:'Nonesuch <img src=x onerror="window.__xss=1"> Group'}], groups:[]} : copy(RES.calloway),
    search:()=>({status:200, body:{...copy(SEARCH), rows:[{...copy(SEARCH.rows[0]), institutionId:5000009, companyName:'Calloway <script>window.__xss=1</script> Co', typeOfInsurance:"<b>Bold</b> line", serffFilingStatus:"x", filingStatus:'<img src=x onerror="window.__xss=1">',
      companies:[{companyId:null, companyName:'Calloway <script>window.__xss=1</script> Co', naicCompanyCode:null, institutionId:5000009, spStatEntityId:null}]}, copy(SEARCH.rows[0])]}})}); p=t.p;
  await t.find("odd");
  ok("hostile names in the finder show as text", (await t.list("#cm_matches li .t1")).includes('Calloway <script>window.__xss=1</script> Co') && !(await p.$("#cm_matches img")));
  await p.click('#cm_matches [data-act="cmp-group"]'); await p.waitForTimeout(300); await t.addCo("Calloway",0); await t.run();
  ok("hostile names and values everywhere show as text", (await t.txt("#cmSumTable tbody tr >> nth=0 >> td >> nth=0 >> b"))==='Nonesuch <img src=x onerror="window.__xss=1"> Group' && (await t.list("#cmRateChart text.ln, #cmTypesTable tbody td")).some(s=>s.includes("<b>Bold</b> line"))
    && !(await p.$("#view img, #view script, #view td b b")) && await p.evaluate(()=>window.__xss===undefined) && (await t.list("#cm_recent li b"))[0].startsWith("Nonesuch <img"));
  await t.ctx.close();

  // ----- a reader can use it too -----
  t=await open({role:"reader"}); p=t.p;
  await t.four(); await t.run();
  ok("a reader gets the same comparison", (await t.cells("#cmSumTable"))[0][1]==="6");
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
