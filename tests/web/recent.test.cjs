// Recent searches on the Filings view: what the page asks the database for (never the whole saved result), how each
// saved search is described, reopening one (the form filled, the same search sent without refresh), the list
// refreshing after a new search, the loading, empty and failed states, Show more, hostile names, and the phone layout.
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

// ----- made-up saved searches, in the shape savedOrFreshSearch stores them -----
const P=o=>({companyIds:[], institutionIds:[], states:["FL"], filingStatusIds:[1,2,3,4], typeOfInsuranceIds:[], filingTypeIds:[], spStatEntityIds:[], trackingNumbers:[], from:"2025-11-14", to:"2026-11-13", allStatuses:true, ...o});
const BIG=Array.from({length:40},(_,i)=>({trackingNumber:"BIG-"+i, filingDescription:"made-up row ".repeat(20)}));   // stands for the megabytes of rows
const saved=(id, at, params, more)=>["snl_store", id, {kind:"search", label:`${params.states.join(",")} ${params.from} to ${params.to}`, fetched_at:at,
  doc:{params, rows:BIG, total:6, requests:2, capped:false, byState:[], byCompany:[], notes:[], source:"S&P Global Market Intelligence, SNL Insurance Product Filings", ...more}}];
const co=(id,name,kind)=>({kind:kind||"companyId", id, name, rows:1});
const HOSTILE='Calloway <img src=x onerror="window.__xss=1"> Co';
const A=P({companyIds:[4000001,4000002,4000107], states:["FL","GA"], typeOfInsuranceIds:[101], from:"2021-01-01"});
const F=P({companyIds:[4000001], institutionIds:[5000009], states:["GA"], filingStatusIds:[1], allStatuses:false, filingTypeIds:[11,12], trackingNumbers:["CALL-134000001"], from:"2026-01-01", to:"2026-06-30"});
const SEED=[
  saved("search:a", "2026-11-12T09:00:00.000Z", A, {byCompany:[co(4000001,"Calloway Insurance Co"), co(4000002,"Calloway Home Co"), co(4000107,null)]}),
  saved("search:b", "2026-11-11T09:00:00.000Z", P({companyIds:[4000001,4000002,4000003,4000004,4000005]}), {byCompany:[co(4000001,"Calloway Insurance Co"), co(4000002,"Calloway Home Co"), co(4000003,"Calloway Coastal Co"), co(4000004,"Calloway Specialty Co"), co(4000005,"Calloway Lloyds")], total:12}),
  saved("search:c", "2026-11-10T09:00:00.000Z", P({companyIds:[4000777], states:["TX"]}), {byCompany:[co(4000777,"Tarrow Mutual Insurance Co")], total:0, rows:[]}),
  saved("search:d", "2026-11-09T09:00:00.000Z", P({companyIds:[4000001]}), {byCompany:[co(4000001,"Calloway Insurance Co")], total:40, capped:true}),
  saved("search:e", "2026-11-08T09:00:00.000Z", P({companyIds:[4000666]}), {byCompany:[co(4000666,HOSTILE)], total:1}),
  saved("search:f", "2026-11-07T09:00:00.000Z", F, {byCompany:[co(4000001,"Calloway Insurance Co"), co(5000009,null,"institutionId")], total:2}),
  saved("search:g", "2026-11-06T09:00:00.000Z", P({companyIds:[4000001], typeOfInsuranceIds:[999], states:["CA","FL","GA","NY","SC","TX","AL","AK","AZ","AR"]}), {byCompany:[co(4000001,"Calloway Insurance Co")], total:1}),
  ...Array.from({length:6},(_,i)=>saved("search:old"+i, `2025-10-0${i+1}T09:00:00.000Z`, P({companyIds:[4000100+i]}), {byCompany:[co(4000100+i,`Nonesuch Mutual ${i+1}`)], total:i+1})),
  ["snl_store", "search:broken", {kind:"search", label:"x", fetched_at:"2024-01-01T00:00:00.000Z", doc:{rows:[]}}],
  ["snl_store", "ref:filingStatus", {kind:"reference", label:"filingStatus", fetched_at:"2026-11-13T00:00:00.000Z", doc:{options:[]}}]
];

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, search:()=>({status:200, body:copy(SEARCH)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const body=JSON.parse(req.postData()||"{}"); t.calls.push({body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="search"){ if(t.delay) await new Promise(res=>setTimeout(res,t.delay)); const a=t.search(body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.body.action===a);
    t.reads=async()=>p.evaluate(()=>__mock.storeReads);
    t.items=async()=>p.$$eval("#recentList .recent-i",e=>e.map(x=>[...x.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    return t;
  }

  let t=await open({seed:SEED}); let p=t.p;
  // ----- collapsed at first, and nothing read until it is opened -----
  ok("a compact Recent searches bar above the form, closed", (await t.txt("#recentToggle"))==="▶Recent searches" && (await p.getAttribute("#recentToggle","aria-expanded"))==="false" && !(await p.$("#recentList"))
    && await p.evaluate(()=>!!(document.getElementById("recent").compareDocumentPosition(document.getElementById("searchForm")) & Node.DOCUMENT_POSITION_FOLLOWING)));
  ok("says these are the team's searches and cost nothing to reopen", (await t.txt("#recent .recent-h .t2"))==="Searches anyone on the team has run. Reopening one uses no S&P requests.");
  ok("closed: the bar is short", await p.evaluate(()=>document.getElementById("recent").getBoundingClientRect().height<70), await p.evaluate(()=>document.getElementById("recent").getBoundingClientRect().height));
  ok("nothing read from the database until it is opened", (await t.reads()).length===0);

  // ----- loading, then the query -----
  await p.evaluate(()=>{ __mock.storeDelay=400; });
  await p.click("#recentToggle"); await p.waitForTimeout(120);
  ok("while it loads: says so", (await t.txt("#recentLoading"))==="Loading recent searches…" && (await p.getAttribute("#recentToggle","aria-expanded"))==="true");
  await p.waitForTimeout(450); await p.evaluate(()=>{ __mock.storeDelay=0; });
  const q=(await t.reads())[0];
  ok("one read, of saved searches only, newest first, ten and one more to know if there are more", (await t.reads()).length===1 && same(q.eqs,[["kind","search"]]) && same(q.ord,["fetched_at",false]) && q.lim===11, q);
  const cols=q.cols.split(",").map(s=>s.trim());
  ok("asks only for what the list needs, never the whole saved result", same(cols,["id","fetched_at","params:doc->params","total:doc->total","byCompany:doc->byCompany","capped:doc->capped"]) && !cols.includes("doc") && !cols.includes("*") && !cols.some(c=>/doc->rows|doc->notes/.test(c)), q.cols);
  ok("the rows of each saved search never reach the page", await p.evaluate(()=>S.f.recent.list.every(r=>r.rows===undefined && r.doc===undefined && Array.isArray(r.byCompany))));

  // ----- the wording of each entry -----
  let I=await t.items();
  ok("ten entries, newest first, with Show more", I.length===10 && (await t.txt("#recentMore"))==="Show more", I.length);
  ok("names from the results, a missing name as its id, states, dates, filters, count and when", same(I[0],["Calloway Insurance Co, Calloway Home Co and company id 4000107","in FL, GA · 1 Jan 2021 to 13 Nov · type of insurance: Homeowners · 6 filings · fetched 12 Nov"]), I[0]);
  ok("many companies: the first three, then how many more", I[1][0]==="Calloway Insurance Co, Calloway Home Co, Calloway Coastal Co and 2 more" && I[1][1]==="in FL · 14 Nov 2025 to 13 Nov · 12 filings · fetched 11 Nov", I[1]);
  ok("nothing came back: says S&P returned nothing, never 0 filings", I[2][1]==="in TX · 14 Nov 2025 to 13 Nov · S&P returned nothing · fetched 10 Nov" && !/\b0 filings\b/.test(await t.txt("#recentList")), I[2]);
  ok("a search that was cut short says it is incomplete", I[3][1].includes("40 filings, incomplete"), I[3]);
  ok("a hostile company name shows as text and runs nothing", I[4][0]===HOSTILE && !(await p.$("#recentList img")) && await p.evaluate(()=>window.__xss===undefined), I[4]);
  ok("an institution with no name, chosen statuses, filing types and a tracking number", I[5][0]==="Calloway Insurance Co and institution id 5000009" && I[5][1]==="in GA · 1 Jan to 30 Jun · filing types: Form and Rate · status: Approved · tracking number CALL-134000001 · 2 filings · fetched 7 Nov", I[5]);
  ok("every status (none chosen) is not listed as a filter", !I[0][1].includes("status"));
  ok("a filter id S&P's list doesn't name, and a long list of states", I[6][1].startsWith("in CA, FL, GA, NY, SC, TX, AL, AK and 2 more · ") && I[6][1].includes("type of insurance: id 999"), I[6]);
  ok("an old search shows its year", I[7][1].endsWith("fetched 6 Oct 2025"), I[7]);
  ok("no dashes in the list", !(await t.txt("#recent")).includes("—"));
  await p.screenshot({path:OUTDIR+"/recent-open-1440.png",fullPage:false});

  // ----- Show more -----
  await p.click("#recentMore"); await p.waitForTimeout(200);
  const q2=(await t.reads()).pop();
  ok("Show more asks for ten more, the same way", q2.lim===21 && q2.cols===q.cols && same(q2.eqs,[["kind","search"]]), q2);
  I=await t.items();
  ok("Show more: every saved search, a broken one and saved reference lists left out, and the button goes", I.length===13 && I[12][0]==="Nonesuch Mutual 1" && !(await p.$("#recentMore")), I.length);

  // ----- reopening a search: the form, the body sent, no S&P request -----
  t.search=body=>({status:200, body:{...copy(SEARCH), params:A, fromStore:!body.refresh, fetchedAt:body.refresh?"2026-11-13T12:00:00Z":"2026-11-12T09:00:00Z"}});
  const readsBefore=(await t.reads()).length;
  t.delay=300;
  await p.click("#recentList .recent-i >> nth=0"); await p.waitForTimeout(100);
  ok("the form is filled at once: companies with their names and kind of id, a missing name left blank", same(await p.evaluate(()=>S.f.chips.map(c=>[c.kind,c.id,c.name])),[["companyId","4000001","Calloway Insurance Co"],["companyId","4000002","Calloway Home Co"],["companyId","4000107",""]])
    && same(await t.all("#chips .cchip b"),["Calloway Insurance Co","Calloway Home Co","Company 4000107"]) && (await p.isVisible("#searching")), await p.evaluate(()=>S.f.chips));
  await p.waitForTimeout(400); t.delay=0;
  const sent=t.of("search").pop().body;
  ok("reopening sends the saved search, with no refresh and no status ids when every status was used", same(sent,{action:"search",companyIds:[4000001,4000002,4000107],institutionIds:[],states:["FL","GA"],from:"2021-01-01",to:"2026-11-13",typeOfInsuranceIds:[101]}), sent);
  ok("the form is filled: states, dates and the ticked filter", same(await t.all('#states [aria-pressed="true"]'),["FL","GA"]) && (await p.inputValue("#f_from"))==="2021-01-01" && (await p.inputValue("#f_to"))==="2026-11-13"
    && await p.isChecked('#chk_toi input[data-id="101"]') && (await p.$$("#chk_toi input:checked")).length===1 && (await p.$$("#chk_fstatus input:checked")).length===0 && (await p.$$("#chk_ftype input:checked")).length===0 && (await p.inputValue("#f_tracking"))==="");
  ok("the saved result opens with the usual line and its Refresh button", (await t.txt("#fromStore"))==="From the last fetch on 12 Nov.Refresh" && (await p.$$("#resTable tbody tr")).length===6);
  ok("opening a saved result doesn't reload the list", (await t.reads()).length===readsBefore);
  ok("the results are scrolled into view", await p.evaluate(()=>document.getElementById("results").getBoundingClientRect().top<innerHeight));
  await p.click('button[data-act="search-refresh"]'); await p.waitForTimeout(400);
  const ref=t.of("search").pop().body;
  ok("Refresh then asks S&P for the same search", same(ref,{...sent, refresh:true}), ref);
  ok("after a refresh the list is read again", (await t.reads()).length===readsBefore+1 && (await t.reads()).pop().lim===21);

  // a search with chosen statuses, an institution and a tracking number
  t.search=()=>({status:200, body:{...copy(SEARCH), params:F, fromStore:true, fetchedAt:"2026-11-07T09:00:00Z"}});
  await p.click("#recentList .recent-i >> nth=5"); await p.waitForTimeout(400);
  const sentF=t.of("search").pop().body;
  ok("chosen statuses, filing types, tracking numbers and an institution id are sent as saved", same(sentF,{action:"search",companyIds:[4000001],institutionIds:[5000009],states:["GA"],from:"2026-01-01",to:"2026-06-30",filingStatusIds:[1],filingTypeIds:[11,12],trackingNumbers:["CALL-134000001"]}), sentF);
  ok("the form shows them: chips by kind, ticked statuses and filing types, the tracking number", same(await p.evaluate(()=>S.f.chips.map(c=>c.kind+":"+c.id)),["companyId:4000001","institutionId:5000009"])
    && same(await t.all("#chips .cchip b"),["Calloway Insurance Co","Institution 5000009"]) && await p.isChecked('#chk_fstatus input[data-id="1"]') && (await p.$$("#chk_fstatus input:checked")).length===1
    && await p.isChecked('#chk_ftype input[data-id="11"]') && await p.isChecked('#chk_ftype input[data-id="12"]') && (await p.inputValue("#f_tracking"))==="CALL-134000001" && same(await t.all('#states [aria-pressed="true"]'),["GA"]), await t.all("#chips .cchip b"));
  ok("the chosen companies' count and the estimate follow the form", (await t.txt("#f_est")).startsWith("About 2 S&P requests"), await t.txt("#f_est"));

  // ----- a new search: the list is read again and shows it first -----
  await p.evaluate(()=>{ __mock.store.snl_store["search:new"]={id:"search:new", kind:"search", label:"FL", fetched_at:"2026-11-13T12:00:00.000Z",
    doc:{params:{companyIds:[4000002],institutionIds:[],states:["FL"],filingStatusIds:[1,2,3,4],typeOfInsuranceIds:[],filingTypeIds:[],spStatEntityIds:[],trackingNumbers:[],from:"2025-11-14",to:"2026-11-13",allStatuses:true}, rows:[], total:3, capped:false, byCompany:[{kind:"companyId",id:4000002,name:"Calloway Home Co",rows:3}]}}; });
  t.search=()=>({status:200, body:{...copy(SEARCH), fromStore:false, fetchedAt:"2026-11-13T12:00:00Z"}});
  t.delay=300; const rN=(await t.reads()).length;
  await p.click('button[data-act="search"]'); await p.waitForTimeout(120);
  ok("while a search runs, the entries wait", await p.isDisabled("#recentList .recent-i >> nth=0"));
  await p.waitForTimeout(500); t.delay=0;
  ok("after a new search the list is read again, and it is first", (await t.reads()).length===rN+1 && same((await t.items())[0],["Calloway Home Co","in FL · 14 Nov 2025 to 13 Nov · 3 filings · fetched 13 Nov"]) && await p.isEnabled("#recentList .recent-i >> nth=0"), (await t.items())[0]);
  // closed: not read until it opens again, then read fresh
  await p.click("#recentToggle"); await p.waitForTimeout(100);
  ok("closing it hides the list", !(await p.$("#recentList")) && (await p.getAttribute("#recentToggle","aria-expanded"))==="false");
  const rC=(await t.reads()).length;
  await p.click('button[data-act="search"]'); await p.waitForTimeout(400);
  ok("a search while it is closed reads nothing", (await t.reads()).length===rC);
  await p.click("#recentToggle"); await p.waitForTimeout(200);
  ok("opening it again reads the list fresh, as many as were shown before", (await t.reads()).length===rC+1 && (await t.items()).length===14, [(await t.reads()).length, rC, (await t.items()).length]);
  ok("reopening it with nothing new in between doesn't read it again", await (async()=>{ await p.click("#recentToggle"); await p.click("#recentToggle"); await p.waitForTimeout(150); return (await t.reads()).length===rC+1; })());

  // ----- phone -----
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  await p.evaluate(()=>window.scrollTo(0,0));
  ok("phone: no sideways scroll with the list open", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  ok("phone: each entry fits the screen", await p.evaluate(()=>[...document.querySelectorAll("#recentList .recent-i")].every(e=>e.getBoundingClientRect().right<=innerWidth)));
  await p.screenshot({path:OUTDIR+"/recent-open-390.png",fullPage:false});
  await p.click("#recentToggle"); await p.waitForTimeout(100);
  ok("phone: closed, the bar stays short and no sideways scroll", await t.noScroll() && await p.evaluate(()=>document.getElementById("recent").getBoundingClientRect().height<90), await p.evaluate(()=>document.getElementById("recent").getBoundingClientRect().height));
  await p.screenshot({path:OUTDIR+"/recent-closed-390.png",fullPage:false});
  await p.setViewportSize({width:1440,height:900});

  await p.evaluate(()=>signOut()); await p.waitForTimeout(300);
  ok("sign out forgets the list", await p.evaluate(()=>S.f.recent===undefined));
  await t.ctx.close();

  // ----- none yet -----
  t=await open(); p=t.p;
  await p.click("#recentToggle"); await p.waitForTimeout(200);
  ok("none yet: says so plainly, with no list and no Show more", (await t.txt("#recentNone"))==="No searches have been run yet. When anyone on the team runs one, it shows here and opens again without using S&P requests." && !(await p.$("#recentList")) && !(await p.$("#recentMore")));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("phone: no sideways scroll with none yet", await t.noScroll());
  await t.ctx.close();

  // ----- could not load -----
  t=await open({seed:SEED}); p=t.p;
  await p.evaluate(()=>{ __mock.failStore="TypeError: Failed to fetch"; });
  await p.click("#recentToggle"); await p.waitForTimeout(200);
  ok("no connection: the plain reason and Try again", (await t.txt("#recentErr"))==="Couldn't load recent searches. The page couldn't reach the database. Check your connection and try again.Try again" && (await p.getAttribute("#recentErr","role"))==="alert" && !(await p.$("#recentLoading")), await t.txt("#recentErr"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("phone: no sideways scroll with the error", await t.noScroll());
  await p.setViewportSize({width:1440,height:900});
  await p.evaluate(()=>{ __mock.failStore="permission denied for table snl_store"; });
  await p.click('#recentErr button[data-act="recent-retry"]'); await p.waitForTimeout(200);
  ok("the database's own reason when it gives one", (await t.txt("#recentErr"))==="Couldn't load recent searches. The database answered: permission denied for table snl_store.Try again", await t.txt("#recentErr"));
  await p.evaluate(()=>{ __mock.failStore=""; });
  await p.click('#recentErr button[data-act="recent-retry"]'); await p.waitForTimeout(200);
  ok("Try again loads the list and clears the error", !(await p.$("#recentErr")) && (await t.items()).length===10);
  await p.evaluate(()=>{ __mock.failStore="TypeError: Failed to fetch"; });
  await p.click("#recentMore"); await p.waitForTimeout(200);
  ok("Show more failing keeps the list and says why", (await t.items()).length===10 && (await t.txt("#recentErr")).startsWith("Couldn't load recent searches."));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
