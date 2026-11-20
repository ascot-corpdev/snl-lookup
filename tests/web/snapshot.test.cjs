// The Snapshot view: choosing a company or a group (every member in the company list) and a period, what it will cost
// in S&P requests and when a group or period is too big, the one search it sends, and every figure on the page worked
// out by hand from the made-up fixture: the tiles, the map (by count and by latest rate impact) and its table, the rate
// chart and table, filings by year and type, the latest form and rule filings, time with the regulator. Then the
// exports, the hand-off to the Filings view, what Ask Claude is told, snapshots reopened from this browser, every
// "not ready" state (not set up, no S&P id, refused, too wide, partial, nothing returned, session ended), hostile text,
// and the 1440px and 390px layouts. Nothing touches the network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("snapshot_search.json"), RES=FIX("snapshot_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const NOT_SET_UP="S&P API access isn't set up yet. It needs API credentials from S&P. When they arrive, the owner sets SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase (README, step 5). Saved results still open.";
const TOO_WIDE="This search needs at least 75 S&P requests (one for each batch of 10 companies and each year of dates), more than the 60 one search may use. Choose fewer companies or a shorter date range.";
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
// the search the page should send for the group over the last 3 years, worked out by hand: every state in S&P's list,
// no filters, and dates exactly 3 x 365 days ending today (13 Nov 2026), so it is 3 date windows
const GROUP_SEARCH={action:"search", companyIds:[], institutionIds:[5000001,5000002,5000003], states:["CA","FL","GA","NY","SC","TX"], from:"2023-11-15", to:"2026-11-13"};
const member=(i, group)=>({companyId:null, companyName:`Nonesuch Member ${i} Co`, naicCompanyCode:null, institutionId:String(6000000+i), spStatEntityId:null, naicGroupCode:null, naicGroupName:group});

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", deviceScaleFactor:width<500?2:1}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, xlsxLoads:0, status:()=>copy(STATUS),
      resolve:q=>/group/i.test(q) ? copy(RES.byGroup) : /calloway/i.test(q) ? copy(RES.byName) : {query:q, matches:[], note:"No saved company matches."},
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
    await p.goto(BASE+(over.hash||"#snapshot")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.cells=async sel=>p.$$eval(sel+" tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.fn==="snl-filings" && c.body.action===a);
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    t.find=async q=>{ await p.fill("#sn_find",q); await p.press("#sn_find","Enter"); await p.waitForTimeout(200); };
    t.group=async()=>{ await t.find("Calloway"); await p.click('[data-act="snap-group"] >> nth=0'); await p.waitForTimeout(250); };
    t.run=async()=>{ await p.click("#sn_run"); await p.waitForTimeout(450); };
    return t;
  }

  // ----- the view as it opens -----
  let t=await open(); let p=t.p;
  ok("a fourth view in the nav, beside Filings, and it is the one open", same(await t.list("nav.tabs a"),["Filings","Snapshot","Compare","Market","Earnings","Statutory","Profile"]) && (await p.getAttribute('nav.tabs a[data-view="snapshot"]',"aria-current"))==="page" && (await t.txt(".action-title"))==="Filings snapshot for a company or group");
  ok("S&P's lists are loaded once, for the states", same(t.of("reference").map(c=>c.body),[{action:"reference"}]));
  ok("nothing chosen yet, the 3 years shown by default", (await t.txt("#sn_chosen"))==="Nothing chosen yet." && (await p.getAttribute('[data-act="snap-years"][data-y="3"]',"aria-pressed"))==="true");
  ok("says what the snapshot covers: the dates, every state in S&P's list, every type and status", (await t.txt("#sn_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in all 6 states in S&P's list, every filing type and status.", await t.txt("#sn_dates"));
  ok("no estimate before something is chosen, and no snapshot", !(await p.$("#sn_cost")) && !(await p.$("#snHead")));
  await p.click("#sn_run"); await p.waitForTimeout(100);
  ok("run with nothing chosen: says what to do, sends nothing", (await t.txt("#sn_formErr"))==="Choose a company or a group first: find it by name above." && t.of("search").length===0);
  await p.click('[data-act="snap-find"]'); await p.waitForTimeout(100);
  ok("find with an empty box: says what to type", (await t.txt("#sn_findErr"))==="Type part of a company or group name." && t.of("resolve").length===0);
  await t.find("Zzz");
  ok("no match: says so in plain words", (await t.txt("#sn_noMatch"))==='No company in the app\'s company list matches "Zzz". Try a shorter part of the name.');

  // ----- finding: groups first, then companies; a company without an S&P id can't be used -----
  await t.find("Calloway");
  ok("looks the name up in the company list", same(t.of("resolve").map(c=>c.body.q),["Zzz","Calloway"]));
  ok("groups first, each to be chosen whole, then the companies", same(await t.list("#sn_matches li .t1"),["Calloway Group (SNL P&C Group)","Nonesuch <b>Group</b>","Calloway Insurance Co","Calloway Home Co","Calloway Re Co","Calloway <script>window.__xss=1</script> Co"]), await t.list("#sn_matches li .t1"));
  ok("a group says how many companies matched and that it takes every member", (await t.txt("#sn_matches li >> nth=0 >> .t2"))==="Group · 3 matching companies; choosing it takes every member in the company list" && (await p.$$('#sn_matches [data-act="snap-group"]')).length===2);
  ok("a company shows the S&P id the search will use", (await t.txt("#sn_matches li >> nth=2 >> .t2"))==="S&P institution id 5000001 · group Calloway Group (SNL P&C Group)");
  ok("a company with no S&P id can't be chosen, and says why", (await t.txt("#sn_matches li >> nth=4 >> .noadd"))==="Can't be used: the company list has no S&P id for it, so its filings can't be searched." && (await p.$$('#sn_matches [data-act="snap-co"]')).length===3);
  ok("hostile names show as text", !(await p.$("#sn_matches script")) && !(await p.$("#sn_matches b")) && await p.evaluate(()=>window.__xss===undefined));

  // ----- a company, and what each period costs -----
  await p.click('#sn_matches li >> nth=2 >> [data-act="snap-co"]'); await p.waitForTimeout(100);
  ok("choosing a company names it, its id and its group", (await t.txt("#sn_chosen"))==="Chosen: Calloway Insurance Co S&P institution id 5000001 · part of Calloway Group (SNL P&C Group) Clear" && !(await p.$("#sn_matches")));
  ok("a company over 3 years: 3 S&P requests, and reopening costs nothing", (await t.txt("#sn_cost"))==="About 3 S&P requests (one for each 10 companies for each year of dates), more if S&P has many filings. Once it has run, the result is saved: reopening it below costs no S&P requests.", await t.txt("#sn_cost"));
  await p.click('[data-act="snap-years"][data-y="1"]'); await p.waitForTimeout(80);
  ok("the last year: 1 request, dates 365 days back", (await t.txt("#sn_cost")).startsWith("About 1 S&P request (") && (await t.txt("#sn_dates")).startsWith("Filings published 14 Nov 2025 to 13 Nov,"), await t.txt("#sn_dates"));
  await p.click('[data-act="snap-years"][data-y="5"]'); await p.waitForTimeout(80);
  ok("the last 5 years: 5 requests", (await t.txt("#sn_cost")).startsWith("About 5 S&P requests (") && (await t.txt("#sn_dates")).startsWith("Filings published 15 Nov 2021 to 13 Nov,"), await t.txt("#sn_dates"));
  ok("the estimate follows the function's rule: one request per 10 ids of a kind per 365 days", await p.evaluate(()=>{
    const ids=(n,k)=>Array.from({length:n},(_,i)=>({kind:k, id:String(i+1)}));
    return [snapCost(ids(1,"institutionId"),"2023-11-15","2026-11-13"), snapCost(ids(10,"institutionId"),"2025-11-14","2026-11-13"), snapCost(ids(11,"institutionId"),"2025-11-14","2026-11-13"),
      snapCost(ids(23,"institutionId").concat(ids(4,"companyId")),"2021-11-15","2026-11-13"), snapCost(ids(1,"companyId"),"2025-11-13","2026-11-13")]; }).then(v=>same(v,[3,1,2,20,2])));
  await p.click('[data-act="snap-clear"]'); await p.waitForTimeout(80);
  ok("Clear forgets the choice", (await t.txt("#sn_chosen"))==="Nothing chosen yet.");
  await p.click('[data-act="snap-years"][data-y="3"]');

  // ----- a group: every member in the company list, looked up by the group's name -----
  await t.group();
  ok("choosing a group looks up its members by the plain part of its name", same(t.of("resolve").map(c=>c.body.q).slice(-1),["Calloway Group"]));
  ok("the group's members with S&P ids, once each; the one without an id left out and counted; another group's company not taken",
    (await t.txt("#sn_chosen"))==="Chosen: Calloway Group (SNL P&C Group) group of 3 companies with S&P ids in the company list; 1 company has no S&P id and is left out Clear", await t.txt("#sn_chosen"));
  ok("the group over 3 years: 3 requests (3 companies is one batch)", (await t.txt("#sn_cost")).startsWith("About 3 S&P requests ("));
  ok("the members are exactly the three", same(await p.evaluate(()=>S.snap.pick.ids.map(c=>c.kind+":"+c.id)),["institutionId:5000001","institutionId:5000002","institutionId:5000003"]));

  // ----- running it -----
  t.delay=400;
  await p.click("#sn_run"); await p.waitForTimeout(150);
  ok("loading: says so, by name, and the button waits", (await t.txt("#snBusy"))==="Getting Calloway Group (SNL P&C Group)'s filings… A long period can take a minute. After that the result is saved, so it opens at once next time." && await p.isDisabled("#sn_run"));
  await p.waitForTimeout(450); t.delay=0;
  ok("one search: the group's ids, every state in S&P's list, the last 3 years, no filters", same(t.of("search").map(c=>c.body),[GROUP_SEARCH]), t.of("search").map(c=>c.body));
  ok("heading and what was searched", (await t.txt("#snName"))==="Calloway Group (SNL P&C Group)" && (await t.txt("#snMeta"))==="Group of 3 companies with S&P ids; 1 company without one left out · filings published 15 Nov 2023 to 13 Nov · 6 states searched · every filing type and status", await t.txt("#snMeta"));

  // tiles, by hand: 19 rows, filing 1 twice -> 18 filings; rate 1,2,3,4,5,7,12 = 7; rule 3,8,11,16 = 4;
  // form 6,9,10,13,14,15,18 = 7; states CA FL GA SC TX = 5 of 6; latest publish date 5 Nov (filing 10)
  ok("tiles", same(await p.$$eval("#snTiles .sntile",e=>e.map(x=>[x.dataset.k, x.querySelector("b").textContent])),[["n","18"],["rate","7"],["rule","4"],["form","7"],["states","5"],["latest","5 Nov"]]), await p.$$eval("#snTiles .sntile",e=>e.map(x=>x.textContent)));
  ok("tile notes: states searched, latest published", same(await t.list('#snTiles [data-k="states"] span'),["States with filings","of 6 states searched"]) && same(await t.list('#snTiles [data-k="latest"] span'),["Latest filing","published"]));
  ok("says how filings are counted, and the one with no type", (await t.txt("#snTileNote"))==="Each filing version counts once, however many of the companies are on it. A filing of more than one type, such as rate and rule, counts in each. 1 filing is of another type or has none given.");
  ok("a group: filings naming each company", same(await t.list("#snByCompany span"),["Calloway Insurance Co 11","Calloway Home Co 5","Calloway Coastal Co 3"]), await t.list("#snByCompany span"));
  ok("the empty state's note is on the map, not repeated as a caveat", !(await p.$("#snNotes")));
  ok("the filing sent twice is one filing, naming both companies", await p.evaluate(()=>{ const f=snapFilings(S.snap.res.rows).filter(x=>x.filingVersionId==="snapver-0001-0000-made-up"); return f.length===1 && f[0].companies.map(c=>c.companyName).join("|")==="Calloway Insurance Co|Calloway Home Co"; }));

  // map by count: CA 2, FL 6, GA 5, SC 2, TX 3; most is 6, so steps of 2: 1-2, 3-4, 5-6
  const fills=async()=>p.$$eval("#snMapSvg path",e=>Object.fromEntries(e.map(x=>[x.dataset.s, x.getAttribute("class")||x.style.fill])));
  let f=await fills();
  ok("map by count: shaded in steps, darkest for most", f.FL==="rgb(0, 83, 158)" && f.GA==="rgb(0, 83, 158)" && f.TX==="rgb(79, 149, 204)" && f.CA==="rgb(156, 195, 227)" && f.SC==="rgb(156, 195, 227)", f);
  ok("map: a searched state with no rows is drawn as 'returned nothing', never as zero; a state not in S&P's list as not searched", f.NY==="none" && f.WA==="ns" && f.AK==="ns");
  ok("map: each state says what it shows", (await p.textContent('#snMapSvg path[data-s="FL"] title'))==="Florida (FL): 6 filings" && (await p.textContent('#snMapSvg path[data-s="NY"] title'))==="New York (NY): S&P returned nothing for this search");
  ok("map legend in words and numbers", same(await t.list("#snMapKey li"),["1 to 2 filings","3 to 4 filings","5 to 6 filings","Dashed outline: S&P returned nothing for this search","Not searched: not in S&P's list of states"]), await t.list("#snMapKey li"));
  ok("the same figures as a table, most filings first, with the latest rate impact, date and status", same(await t.cells("#snStateTable"),[
    ["Florida (FL)","6","3","9.8%20 Oct, Pending"],["Georgia (GA)","5","2","0.0%1 Aug 2025, Disapproved"],["Texas (TX)","3","1","(4.0%)date n/d, Withdrawn"],["California (CA)","2","1","12.5%30 Sept 2025, Approved"],["South Carolina (SC)","2","0","n/d"]]), await t.cells("#snStateTable"));
  ok("states S&P returned nothing for are named, and it isn't 'no filings'", (await t.txt("#snStateNone"))==="S&P returned nothing for this search in NY. That isn't proof that nothing was filed there.");
  await p.click('[data-act="snap-map"][data-by="rate"]'); await p.waitForTimeout(100);
  f=await fills();
  ok("map by latest rate impact: up 5% or more, no change, down, and filings with no rate impact", f.CA==="rgb(235, 0, 140)" && f.FL==="rgb(235, 0, 140)" && f.GA==="rgb(201, 203, 214)" && f.TX==="rgb(140, 203, 198)" && f.SC==="nrate" && f.NY==="none", f);
  ok("map by rate: the legend and each state's words", same(await t.list("#snMapKey li"),["Down 5.0% or more","Down by less than 5.0%","No change","Up by less than 5.0%","Up 5.0% or more","Filings, but none with a rate impact","Dashed outline: S&P returned nothing for this search","Not searched: not in S&P's list of states"])
    && (await p.textContent('#snMapSvg path[data-s="FL"] title'))==="Florida (FL): latest rate impact 9.8%, 20 Oct, Pending" && (await p.getAttribute('[data-act="snap-map"][data-by="rate"]',"aria-pressed"))==="true");
  await p.click('[data-act="snap-map"][data-by="count"]'); await p.waitForTimeout(80);

  // rate chart: filings with a rate impact and a publish date: 1 (6.2), 2 (-2.5), 3 (9.8 pending), 4 (3.0), 5 (0, disapproved), 12 (12.5)
  const marks=await p.$$eval("#snRateChart .mk",e=>e.map(x=>({c:x.getAttribute("class"), t:x.querySelector("title").textContent})));
  ok("rate chart: one mark per filing, oldest first; up, down and no change look different; only approved filled", same(marks.map(m=>m.c),["mk up","mk dn","mk z open","mk up","mk up","mk up open"]) && marks[5].t==="20 Oct, FL Homeowners: 9.8%, Pending" && marks[1].t==="31 Mar 2025, FL Homeowners: (2.5%), Approved", marks);
  ok("rate chart: a scale either side of zero, negatives in parentheses, and years", same(await p.$$eval("#snRateChart text",e=>e.map(x=>x.textContent)),["15.0%","7.5%","0.0%","(7.5%)","(15.0%)","2024","2025","2026"]));
  ok("the note: not weighted by premium, pending may be what was asked for, nothing averaged", (await t.txt("#snRateNote"))==="Each mark is one filing's overall rate impact as S&P gives it. It isn't weighted by premium, and for a filing that isn't approved it may be what the company asked for rather than what was approved. Each filing's status is shown, and nothing here is averaged.");
  ok("the chart's key in words", same(await t.list("#snRateKey li"),["▲Increase","▼Decrease","●No change","■Filled: approved","□Hollow: any other status, such as pending or withdrawn"]));
  ok("the filing with no publish date is named as left off the chart", (await t.txt("#snRateNoDate"))==="1 filing with a rate impact has no publish date in S&P's data, so it isn't on the chart. It is in the tables.");
  ok("the chart's figures as text, newest first", same(await t.cells("#snRatePts table"),[["20 Oct","FL","Homeowners","Rate and rule","9.8%","Pending"],["11 May","FL","Homeowners","Rate","6.2%","Approved"],["30 Sept 2025","CA","Commercial property","Rate","12.5%","Approved"],["1 Aug 2025","GA","Private passenger auto","Rate","0.0%","Disapproved"],["31 Mar 2025","FL","Homeowners","Rate","(2.5%)","Approved"],["15 Apr 2024","GA","Private passenger auto","Rate","3.0%","Approved"],["n/d","TX","Homeowners","Rate","(4.0%)","Withdrawn"]]), await t.cells("#snRatePts table"));
  ok("rate table by state and type: count, range, latest with date and status", same(await t.cells("#snRateTable"),[
    ["CA","Commercial property","1","1","12.5%","12.5%","30 Sept 2025","Approved"],["FL","Homeowners","3","3","(2.5%) to 9.8%","9.8%","20 Oct","Pending"],
    ["GA","Private passenger auto","2","2","0.0% to 3.0%","0.0%","1 Aug 2025","Disapproved"],["TX","Homeowners","1","1","(4.0%)","(4.0%)","n/d","Withdrawn"]]), await t.cells("#snRateTable"));

  // by year published and type: 2023 F1; 2024 Rate1 Form1 n/d1; 2025 Rate3 Rule2 Form1; 2026 Rate1 Rule1 Form4 Rate-and-rule1; filing 7 undated
  ok("by year and type: S&P's types, rate, rule and form first, then the rest, then none given", same(await t.list("#snYearTable thead th"),["Year","Rate","Rule","Form","Rate and rule","Type n/d","All"]));
  ok("by year and type: the counts", same(await t.cells("#snYearTable"),[["2023","0","0","1","0","0","1"],["2024","1","0","1","0","1","3"],["2025","3","2","1","0","0","6"],["2026","1","1","4","1","0","7"]]), await t.cells("#snYearTable"));
  ok("by year: the stacked columns hold the same counts", (await p.$$("#snYearChart rect")).length===11 && same(await p.$$eval("#snYearChart text.tot",e=>e.map(x=>x.textContent)),["1","3","6","7"]) && (await p.textContent("#snYearChart rect title"))==="2023, Form: 1 filing");
  ok("by year: part years and the undated filing are said", (await t.txt("#snYears .sngrid > div:last-child p"))==="By the year S&P published each filing; the first and last years are part years. 1 filing has no publish date and isn't counted here.");
  ok("by year: legend", same(await t.list("#snYearKey li"),["Rate","Rule","Form","Rate and rule","Type n/d"]));

  // latest form and rule filings: 11 in all, the ten newest by publish date
  ok("latest form and rule filings: the ten newest of eleven", (await t.txt("#snLatest > p"))==="The 10 most recent of 11, newest first by the date S&P published them." && same(await p.$$eval("#snLatestTable tbody tr",rs=>rs.map(r=>r.querySelector(".c-tn").textContent.trim())),
    ["CALL-SNAP-0010","CALL-SNAP-0003","CALL-SNAP-0016","CALL-SNAP-0009","CALL-SNAP-0014","CALL-SNAP-0006","CALL-SNAP-0008","CALL-SNAP-0015","CALL-SNAP-0011","CALL-SNAP-0013"]));
  ok("each with state, type of insurance, description, status and dates", (await t.txt("#snLatestTable tbody tr >> nth=0"))
    .startsWith("Calloway Home Co SC Form Homeowners Pending Submitted1 OctPublished5 Nov"), await t.txt("#snLatestTable tbody tr >> nth=0"));
  ok("hostile description shows as text", (await t.txt("#snLatestTable tbody tr >> nth=3 >> .c-desc")).startsWith('<img src=x onerror="window.__xss=1"> Commercial auto form & schedule update') && !(await p.$("#snLatestTable img")) && await p.evaluate(()=>window.__xss===undefined));
  await p.click('#snLatestTable tbody tr >> nth=0 >> [data-act="open-doc"]'); await p.waitForTimeout(250);
  ok("Open document opens the filing's document", same(t.of("document").map(c=>c.body),[{action:"document", documentId:8800010}]));

  // time with the regulator, by hand: CA 241,50; FL 70,80,49,29,42,19; GA 70,61,28,19,15; SC 35,45; TX 35; filings 7 and 8 lack a date
  ok("time with the regulator: approximate, and says what is left out", (await t.txt("#snDaysNote"))==="Days from the date a filing was submitted to the date S&P published it, which is close to, but not always the same as, the date the regulator decided it. Read these as approximate. 2 filings don't have both dates and are left out." && (await t.txt("#snDaysH"))==="Time with the regulator, approximately");
  ok("time with the regulator: median and range by state, and all states", same(await t.cells("#snDaysTable"),[["California (CA)","2","146","50 to 241"],["Florida (FL)","6","46","19 to 80"],["Georgia (GA)","5","28","15 to 70"],["South Carolina (SC)","2","40","35 to 45"],["Texas (TX)","1","35","35"],["All states","16","44","15 to 241"]]), await t.cells("#snDaysTable"));
  ok("source line", (await t.txt("#snSource"))==="Source: S&P Global Market Intelligence, SNL Insurance Product Filings, fetched 13 Nov. Worked out in this browser from the filings S&P returned. Opening a document uses one S&P request the first time.");
  { const names=["Calloway Group (SNL P&C Group)","Calloway Insurance Co","Calloway Home Co","Calloway Coastal Co","Filings view","S&P"," Nov"," Claude"], loud=(await t.list("#view h2,#view h3,#view button,nav a")).filter(s=>/\s[A-Z][a-z]+/.test(names.reduce((a,n)=>a.split(n).join("x"),s)));
    ok("headings and buttons are in sentence case", loud.length===0, loud); }
  ok("no page errors so far", errs.length===0, errs);
  await p.screenshot({path:OUTDIR+"/snapshot-1440.png",fullPage:true});
  await p.screenshot({path:"/tmp/claude-0/-workspace/53a3716b-de6d-55ad-8392-70c70b8d61ed/scratchpad/snapshot-1440.png",fullPage:true}).catch(()=>{});

  // ----- exports -----
  let d=await t.download(()=>p.click('#snMap [data-act="export"][data-fmt="csv"]'));
  const csvRows=s=>s.replace(/^﻿/,"").split("\r\n");
  ok("states CSV: every searched state, the empty one marked", d.name==="snl-snapshot-calloway-group-snl-p-c-group-states-2026-11-13.csv" && same(csvRows(d.text),[
    '"State","State name","Filings","Rate filings","Latest rate impact (%)","Latest rate impact, date published","Latest rate impact, status","Note"',
    '"CA","California","2","1","12.5","2025-09-30","Approved",""','"FL","Florida","6","3","9.8","2026-10-20","Pending",""','"GA","Georgia","5","2","0","2025-08-01","Disapproved",""',
    '"NY","New York","0","0","","","","S&P returned nothing for this search"','"SC","South Carolina","2","0","","","",""','"TX","Texas","3","1","-4","","Withdrawn",""']), d);
  d=await t.download(()=>p.click('#snRates [data-act="export"][data-fmt="csv"]'));
  ok("rate changes CSV", same(csvRows(d.text).slice(0,3),['"State","Type of insurance","Rate filings","With a rate impact","Lowest rate impact (%)","Highest rate impact (%)","Latest rate impact (%)","Latest, date published","Latest, status"','"CA","Commercial property","1","1","12.5","12.5","12.5","2025-09-30","Approved"','"FL","Homeowners","3","3","-2.5","9.8","9.8","2026-10-20","Pending"']), csvRows(d.text));
  d=await t.download(()=>p.click('#snDays [data-act="export"][data-fmt="csv"]'));
  ok("time with the regulator CSV, with all states", csvRows(d.text).length===7 && csvRows(d.text)[6]==='"All states","16","43.5","15","241"' && csvRows(d.text)[1]==='"CA","2","145.5","50","241"', csvRows(d.text));
  d=await t.download(()=>p.click('#snLatest [data-act="export"][data-fmt="csv"]'));
  ok("latest forms and rules CSV: ten rows, hostile text kept as text", csvRows(d.text).length===11 && csvRows(d.text)[4].includes('"<img src=x onerror=""window.__xss=1""> Commercial auto form & schedule update"'), csvRows(d.text)[4]);
  d=await t.download(()=>p.click('#snHead [data-act="export"][data-fmt="csv"]'));
  ok("all filings CSV: 18 filings, newest first, both companies on the shared one", csvRows(d.text).length===19 && csvRows(d.text)[1].includes('"CALL-SNAP-0010"') && csvRows(d.text).some(l=>l.includes('"Calloway Insurance Co; Calloway Home Co"')), csvRows(d.text).slice(0,2));
  d=await t.download(()=>p.click('#snYears [data-act="export"][data-fmt="xlsx"]'));
  const wb=JSON.parse(d.text);
  ok("by year Excel: the same table, numbers as numbers", d.name==="snl-snapshot-calloway-group-snl-p-c-group-by-year-2026-11-13.xlsx" && wb.sheets[0].name==="By year and type" && same(wb.sheets[0].aoa,[["Year","Rate","Rule","Form","Rate and rule","Type n/d","All"],[2023,0,0,1,0,0,1],[2024,1,0,1,0,1,3],[2025,3,2,1,0,0,6],[2026,1,1,4,1,0,7]]) && t.xlsxLoads===1, wb);

  // ----- Ask Claude starts from the snapshot -----
  await p.click("#askFab"); await p.waitForTimeout(200);
  ok("Ask Claude says it starts from this carrier and period", (await t.txt("#askTold"))==="Claude starts from this carrier and period: Calloway Group (SNL P&C Group) and its 3 companies, filings published 15 Nov 2023 to 13 Nov in 6 states, every filing type and status. 18 filings on screen.", await t.txt("#askTold"));
  await p.fill("#ask_input","What has this group been filing?"); await p.press("#ask_input","Enter"); await p.waitForTimeout(300);
  const ask=t.calls.find(c=>c.fn==="snl-chat" && c.body.action==="ask");
  ok("the question goes with the search behind the snapshot and the companies' names", !!ask && same(ask.body.screen,{view:"filings", search:{companyIds:[], institutionIds:[5000001,5000002,5000003], states:["CA","FL","GA","NY","SC","TX"], from:"2023-11-15", to:"2026-11-13", typeOfInsuranceIds:[], filingTypeIds:[], filingStatusIds:[]}, total:18, companies:["Calloway Group (SNL P&C Group)","Calloway Insurance Co","Calloway Home Co","Calloway Coastal Co"], snapshot:{name:"Calloway Group (SNL P&C Group)", kind:"group", years:3, capped:false}}), ask&&ask.body.screen);
  await p.click("#askClose"); await p.waitForTimeout(100);

  // ----- the same search on the Filings view -----
  const before=t.of("search").length;
  await p.click("#sn_toFilings"); await p.waitForTimeout(500);
  ok("opens the Filings view with the form filled in", (await p.getAttribute('nav.tabs a[data-view="filings"]',"aria-current"))==="page" && same(await t.list("#chips .cchip b"),["Calloway Insurance Co","Calloway Home Co","Calloway Coastal Co"])
    && same(await p.$$eval('#states [aria-pressed="true"]',e=>e.map(x=>x.dataset.s)),["CA","FL","GA","NY","SC","TX"]) && (await p.inputValue("#f_from"))==="2023-11-15" && (await p.inputValue("#f_to"))==="2026-11-13");
  // the Filings view shows the rows as the function sends them (the function keeps one per filing version; the fixture sends one twice on purpose)
  ok("and runs the very same search, so every row shows", t.of("search").length===before+1 && same(t.of("search").slice(-1)[0].body,GROUP_SEARCH) && (await p.$$("#resTable tbody tr")).length===SEARCH.rows.length, [t.of("search").length, before, t.of("search").slice(-1)[0].body, (await p.$$("#resTable tbody tr")).length]);
  await p.click('nav.tabs a[data-view="snapshot"]'); await p.waitForTimeout(250);
  ok("back on Snapshot, the snapshot is still there", (await t.txt("#snName"))==="Calloway Group (SNL P&C Group)");

  // ----- snapshots run before, reopened from this browser -----
  ok("the snapshot is listed to reopen", same(await t.list("#sn_recent li"),["Calloway Group (SNL P&C Group) 15 Nov 2023 to 13 Nov"]));
  await p.reload(); await p.waitForTimeout(500);
  t.search=()=>({status:200, body:{...copy(SEARCH), fromStore:true, fetchedAt:"2026-11-13T11:00:00Z"}});
  await p.click('[data-act="snap-recent"]'); await p.waitForTimeout(400);
  ok("after a reload, reopening sends the same search, which opens from the saved result", same(t.of("search").slice(-1)[0].body,GROUP_SEARCH) && (await t.txt("#snFromStore"))==="From the saved result fetched 13 Nov, so opening it used no S&P requests.Refresh from S&P" && (await t.txt("#sn_chosen")).startsWith("Chosen: Calloway Group (SNL P&C Group)"), [t.of("search").slice(-1)[0].body, await t.txt("#snFromStore"), await t.txt("#sn_chosen")]);
  t.search=()=>({status:200, body:copy(SEARCH)});
  await p.click('[data-act="snap-refresh"]'); await p.waitForTimeout(400);
  ok("Refresh asks S&P again for the same search", same(t.of("search").slice(-1)[0].body,{...GROUP_SEARCH, refresh:true}) && !(await p.$("#snFromStore")));

  // ----- phone -----
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(250);
  ok("phone: no sideways scroll with a full snapshot", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  ok("phone: the charts are redrawn for the width", (await p.getAttribute("#snRateChart","viewBox"))==="0 0 360 230" && (await p.getAttribute("#snYearChart","viewBox"))==="0 0 360 220");
  ok("phone: tiles two to a row", await p.evaluate(()=>{ const t=[...document.querySelectorAll("#snTiles .sntile")].map(x=>x.getBoundingClientRect()); return t[0].top===t[1].top && t[2].top>t[0].top; }));
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(200);
  ok("wide again: charts drawn wide", (await p.getAttribute("#snRateChart","viewBox"))==="0 0 1240 300");
  await ctx_close(t);

  // ----- the phone screenshot for the owner, at twice the pixels -----
  t=await open({}, {width:390}); p=t.p;
  await t.group(); await t.run();
  ok("phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/snapshot-390.png",fullPage:true});
  await p.screenshot({path:"/tmp/claude-0/-workspace/53a3716b-de6d-55ad-8392-70c70b8d61ed/scratchpad/snapshot-390.png",fullPage:true}).catch(()=>{});
  await ctx_close(t);

  // ----- partial: the search stopped at its limit -----
  t=await open({}, {search:()=>({status:200, body:{...copy(SEARCH), capped:true, saved:false, notes:["The search stopped after 60 S&P requests to stay inside the time limit, so these results are incomplete. Narrow the dates, states or companies and search again."]}})}); p=t.p;
  await t.group(); await t.run();
  ok("partial: says the snapshot is partial and what to choose instead", (await t.txt("#snPartial"))==="This snapshot is partial. The search stopped at its limit before S&P had returned everything, so every count below is lower than it should be. Choose a shorter period or one of the group's companies and run it again.");
  ok("partial: S&P's note is shown, and the figures still are", (await t.txt("#snNotes")).startsWith("Read this before you rely on the snapshotThe search stopped after 60 S&P requests") && (await t.txt('#snTiles [data-k="n"] b'))==="18");
  ok("partial: not listed to reopen, since it wasn't saved", !(await p.$("#sn_recent")));
  await p.screenshot({path:OUTDIR+"/snapshot-partial-1440.png",fullPage:true});
  let n0=t.of("search").length;
  await p.click("#sn_toFilings"); await p.waitForTimeout(400);
  ok("partial: the Filings view gets the form filled, but no search is run for the reader", t.of("search").length===n0 && (await p.inputValue("#f_from"))==="2023-11-15" && (await p.$$("#chips .cchip")).length===3 && !(await p.$("#resTable")));
  await p.setViewportSize({width:390,height:844}); await p.click('nav.tabs a[data-view="snapshot"]'); await p.waitForTimeout(250);
  ok("partial, phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/snapshot-partial-390.png",fullPage:true});
  await ctx_close(t);

  // ----- nothing returned -----
  t=await open({}, {search:()=>({status:200, body:{...copy(SEARCH), rows:[], total:0, byCompany:SEARCH.byCompany.map(c=>({...c, rows:0})), notes:["S&P returned no filings for CA in this search. That means none are in S&P's data for these companies, dates and filters. It doesn't prove that none were filed."]}})}); p=t.p;
  await t.find("Calloway"); await p.click('#sn_matches [data-act="snap-co"] >> nth=0'); await t.run();
  ok("nothing returned: 'S&P returned nothing', never 'no filings exist'", (await t.txt("#snEmpty")).startsWith("S&P returned nothing for this search, and that isn't proof that nothing was filed") && (await t.txt("#snEmpty")).includes("It doesn't prove that none were filed.") && !(await p.$("#snTiles")) && !(await p.$("#snMap")), await t.txt("#snEmpty"));
  ok("nothing returned: one search for the one company", same(t.of("search").map(c=>c.body.institutionIds),[[5000001]]));
  await p.screenshot({path:OUTDIR+"/snapshot-empty-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("nothing returned, phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/snapshot-empty-390.png",fullPage:true});
  await ctx_close(t);

  // ----- rows with gaps only: no rate impact, no dates, no state -----
  const gaps=copy(SEARCH); gaps.rows=gaps.rows.filter(r=>r.serffFilingType==="Form").map(r=>({...r, publishDate:null, dateSubmitted:null}));
  gaps.rows.push({...copy(SEARCH.rows[0]), filingVersionId:"snapver-9999-0000-made-up", serffFilingStateId:null, serffFilingType:"Rate", overallRateImpact:null, publishDate:null, dateSubmitted:null});
  t=await open({}, {search:()=>({status:200, body:gaps})}); p=t.p;
  await t.group(); await t.run();
  ok("gaps: n/d for the latest date, and the blocks say what isn't there", (await t.txt('#snTiles [data-k="latest"] b'))==="n/d" && (await t.txt("#snNoRates"))==="None of the 1 rate filing carries an overall rate impact in S&P's data, so there is nothing to chart. The table below still lists them." && !(await p.$("#snRateChart"))
    && (await t.txt("#snNoDays"))==="None of these filings has both a submitted date and a publish date in S&P's data." && !(await p.$("#snYearChart")), [await t.txt("#snNoRates")]);
  ok("gaps: a filing with no state is counted, not put on the map", (await t.txt('#snTiles [data-k="n"] b'))==="8" && same(await t.cells("#snRateTable"),[["n/d","Homeowners","1","0","n/d","n/d","n/d","n/d"]]));
  ok("gaps: no page errors", errs.length===0, errs);
  await ctx_close(t);

  // ----- S&P not set up, refused, too wide, a limit -----
  t=await open({}, {status:()=>({...copy(STATUS), filings:{...STATUS.filings, configured:false, message:NOT_SET_UP}}), search:()=>({status:503, body:{error:"not_configured", message:NOT_SET_UP}})}); p=t.p;
  ok("not set up: says a new snapshot can't run, saved ones still open", (await t.txt("#snOff"))==="S&P filings aren't set up yet, so a new snapshot can't be run. Snapshots run before still open from their saved results.");
  await t.group(); await t.run();
  ok("not set up: the function's answer is a calm note, not an error", (await t.txt("#snErr"))===NOT_SET_UP && !(await p.$("#snErr .banner")));
  await ctx_close(t);
  t=await open({}, {search:()=>({status:400, body:{error:"spgmi_bad_request", message:TOO_WIDE}})}); p=t.p;
  await t.group(); await t.run();
  ok("too wide: the function's refusal, in its words, with no Try again", (await t.txt("#snErr"))==="This snapshot is too big for one search. "+TOO_WIDE && !(await p.$('#snErr [data-act="snap-retry"]')), await t.txt("#snErr"));
  await ctx_close(t);
  let n=0;
  t=await open({}, {search:()=>(++n===1 ? {status:429, body:{error:"spgmi_limit", message:"This hour's 500 S&P requests are used up. Try again after the hour.", requestId:"req-9"}} : {status:200, body:copy(SEARCH)})}); p=t.p;
  await t.group(); await t.run();
  ok("refused by S&P: says so with S&P's reference, and offers Try again", (await t.txt("#snErr"))==="Couldn't get the snapshot. This hour's 500 S&P requests are used up. Try again after the hour. S&P reference: req-9.Try again", await t.txt("#snErr"));
  await p.click('[data-act="snap-retry"]'); await p.waitForTimeout(400);
  ok("Try again sends the same search, and the snapshot shows", same(t.of("search").map(c=>c.body),[GROUP_SEARCH, GROUP_SEARCH]) && (await t.txt('#snTiles [data-k="n"] b'))==="18");
  await ctx_close(t);

  // ----- a whole large group, from the filings function's own list of the group's members -----
  {
    const many=n=>Array.from({length:n},(_,i)=>member(i+1,"Nonesuch Group"));
    const whole=(n, extra={})=>({name:"Nonesuch Group", code:null, companies:n+2, searchable:n, tooBig:false, requestsPerYear:Math.ceil(n/10), members:many(n).map(m=>({companyName:m.companyName, companyId:null, institutionId:String(m.institutionId)})), ...extra});
    t=await open({}, {resolve:q=>/nonesuch group/i.test(q) ? {query:q, matches:many(50), groups:[whole(69)], groupNote:null} : {query:q, matches:many(3)}}); p=t.p;
    await t.find("Nonesuch"); await p.click('[data-act="snap-group"]'); await p.waitForTimeout(250);
    ok("a 69-company group is taken whole, and the members without an S&P id are counted", !(await p.$("#sn_tooBig")) && (await t.txt("#sn_chosen")).includes("69 companies") && (await t.txt("#sn_chosen")).includes("2 companies have no S&P id"), await t.txt("#sn_chosen"));
    ok("its cost over 3 years: 7 batches of ten for each year", (await t.txt("#sn_cost")).startsWith("About 21 S&P requests ("), await t.txt("#sn_cost"));
    await t.run();
    ok("the search carries all 69 companies once each", t.of("search").length===1 && t.of("search")[0].body.institutionIds.length===69 && new Set(t.of("search")[0].body.institutionIds).size===69);
    await ctx_close(t);
    t=await open({}, {resolve:q=>/nonesuch group/i.test(q) ? {query:q, matches:many(50), groups:[whole(100,{companies:140, searchable:140, tooBig:true})], groupNote:null} : {query:q, matches:many(3)}}); p=t.p;
    await t.find("Nonesuch"); await p.click('[data-act="snap-group"]'); await p.waitForTimeout(250);
    ok("a group too big for one search: says so and what to choose instead", (await t.txt("#sn_tooBig"))==="Nonesuch Group has more than 100 companies with S&P ids in the company list, and one snapshot covers at most 100. Choose one of its companies instead, or search the group in parts on the Filings view.", await t.txt("#sn_tooBig"));
    await p.click("#sn_run"); await p.waitForTimeout(100);
    ok("too big for one search: nothing is sent", t.of("search").length===0);
    await ctx_close(t);
  }

  // ----- groups and companies that can't be snapshotted -----
  const big=Array.from({length:55},(_,i)=>member(i+1,"Nonesuch Group"));
  t=await open({}, {resolve:q=>/nonesuch group/i.test(q) ? {query:q, matches:big.slice(0,50)} : /tarrow group/i.test(q) ? {query:q, matches:[member(1,"Tarrow Group"),member(2,"Tarrow Group")]} : /tarrow/i.test(q) ? {query:q, matches:[{...member(1,"Tarrow Group"), institutionId:null}, {...member(2,"Tarrow Group"), institutionId:null}]} : {query:q, matches:big.slice(0,3)}}); p=t.p;
  await t.find("Nonesuch"); await p.click('[data-act="snap-group"]'); await p.waitForTimeout(250);
  ok("a group the look-up may have cut: says why it can't be snapshotted and what to choose instead", (await t.txt("#sn_tooBig"))==="Nonesuch Group has more companies in the company list than one look-up returns (50), so a snapshot can't be sure to cover all of it. Choose one of its companies instead, or search the group in parts on the Filings view.", await t.txt("#sn_tooBig"));
  await p.click("#sn_run"); await p.waitForTimeout(100);
  ok("too big: refused before anything is sent", t.of("search").length===0 && (await t.txt("#sn_formErr")).startsWith("Nonesuch Group has more companies"));
  t.resolve=q=>({query:q, matches:/group/i.test(q)?[member(1,"Tarrow Group")]:[{...member(1,"Tarrow Group"), companyName:"Tarrow Mutual Insurance Co", institutionId:null}]});
  await t.find("Tarrow"); await p.click('[data-act="snap-group"]'); await p.waitForTimeout(250);
  ok("a group whose only id comes from the members' look-up is still taken", (await t.txt("#sn_chosen")).startsWith("Chosen: Tarrow Group group of 1 company with S&P ids in the company list; 1 company has no S&P id and is left out"), await t.txt("#sn_chosen"));
  t.resolve=q=>({query:q, matches:[{...member(1,"Tarrow Group"), companyName:"Tarrow Mutual Insurance Co", institutionId:null}]});
  await t.find("Tarrow"); await p.click('[data-act="snap-group"]'); await p.waitForTimeout(250);
  ok("a group with no S&P id at all: says its filings can't be searched", (await t.txt("#sn_tooBig"))==="None of the companies in Tarrow Group has an S&P id in the company list, so the group's filings can't be searched. Its companies can be added on the Filings view by S&P id.");
  ok("too many companies, and too many requests, from the limits as they are", await p.evaluate(()=>{
    const ids=n=>Array.from({length:n},(_,i)=>({kind:"institutionId", id:String(i+1)}));
    const over=snapTooBig({kind:"group", name:"Nonesuch Group", ids:ids(MAX_COMPANIES+1), noId:0, cut:false}, 3);
    const req5=snapTooBig({kind:"group", name:"Nonesuch Group", ids:ids(150), noId:0, cut:false}, 5, 200);
    const req1=snapTooBig({kind:"group", name:"Nonesuch Group", ids:ids(700), noId:0, cut:false}, 1, 1000);
    return [over, req5, req1, snapTooBig({kind:"group", name:"x", ids:ids(MAX_COMPANIES), noId:0, cut:false}, 5)].concat([MAX_COMPANIES]); }).then(v=>same(v.slice(0,4),[
      `Nonesuch Group has ${v[4]+1} companies with S&P ids in the company list, and one snapshot covers at most ${v[4]}. Choose one of its companies instead, or search the group in parts on the Filings view.`,
      "This snapshot needs at least 75 S&P requests, more than the 60 one search may use. Choose the last 3 years instead.",
      "This snapshot needs at least 70 S&P requests, more than the 60 one search may use. Choose one of its companies instead.", ""]) || console.log(v)));
  ok("the company limit comes from the one constant the Filings view uses, written nowhere else", /maxIds=MAX_COMPANIES/.test(fs.readFileSync(WEB+"/index.html","utf8")) && !/covers at most 50|SNAP_MAX_COMPANIES/.test(fs.readFileSync(WEB+"/index.html","utf8")));
  await ctx_close(t);

  // ----- the session ends mid-way -----
  t=await open({}, {search:()=>({status:401, body:{error:"signin", message:"Your session has ended. Sign in again."}})}); p=t.p;
  await t.group(); await t.run();
  ok("session ended during the search: back to sign-in with the message, nothing kept", await p.isVisible("#loginForm") && (await t.txt(".login .err"))==="Your session has ended. Sign in again." && await p.evaluate(()=>S.snap.res===null && S.snap.pick===null));
  await ctx_close(t);
  t=await open({}, {}); p=t.p; t.delay=500;
  await t.group(); await p.click("#sn_run"); await p.waitForTimeout(100);
  await p.evaluate(()=>__mock.fire("SIGNED_OUT")); await p.waitForTimeout(700);
  ok("signed out while it ran: the late answer is dropped", await p.isVisible("#loginForm") && await p.evaluate(()=>S.snap.res===null && S.snap.busy===false) && errs.length===0);
  await ctx_close(t);

  // ----- a reader can use it too -----
  t=await open({role:"reader"}); p=t.p;
  await t.group(); await t.run();
  ok("a reader gets the same snapshot", (await t.txt('#snTiles [data-k="n"] b'))==="18");
  await ctx_close(t);

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
  async function ctx_close(x){ await x.ctx.close(); }
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
