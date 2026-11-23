// Programs and forms (#forms): choosing two to four carriers (a company or a whole group), one state, a type of
// insurance and a period; what the search costs; the searches it sends (one when the limits allow, several in turn
// otherwise); every filing found per carrier; the saved summaries it asks for (snl-digest "get"); summarising only when
// the reader chooses, with the cost first, progress, Stop and what was and wasn't made and why; and the comparison
// (programs by segment, forms by number with earlier editions underneath, rate and eligibility notes), every cell and
// sentence checked against values worked out by hand from the made-up fixtures. Then the exports, Ask Claude, saved
// carrier sets present and absent, every "not ready" state (summaries function not deployed, Claude not set up, S&P not
// set up, nothing found for a carrier, no summaries yet, failures, the daily limit part-way, empty lists, hostile text,
// the session ending), and the 1440px and 390px layouts. snl-digest doesn't exist in this worktree: it is mocked here
// in the shape Contract B gives. Nothing touches the network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const SCRATCH="/tmp/claude-0/-workspace/53a3716b-de6d-55ad-8392-70c70b8d61ed/scratchpad";
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), ROWS=FIX("formcompare_search.json").rows, RES=FIX("formcompare_resolve.json"), DIG=FIX("formcompare_digests.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const NOT_SET_UP="S&P API access isn't set up yet. It needs API credentials from S&P. When they arrive, the owner sets SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase (README, step 5). Saved results still open.";
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// the same value whatever order an object's keys are in
const canon=v=>Array.isArray(v)?v.map(canon):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const deq=(a,b)=>same(canon(a),canon(b));
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

const CAL="Calloway Group (SNL P&C Group)", TAR="Tarrow Mutual Insurance Co", NON="Nonesuch Mutual Insurance Co";
// worked out by hand: today is 13 Nov 2026; 3 years is 3 x 365 days ending today, so from 15 Nov 2023 (3 date windows).
// Calloway's three members and Tarrow are 4 institution ids: one batch of 10, so 3 S&P requests in one search.
const SEARCH={action:"search", companyIds:[], institutionIds:[5000001,5000002,5000003,5100001], states:["FL"], from:"2023-11-15", to:"2026-11-13", typeOfInsuranceIds:[101], filingTypeIds:[11]};
// every filing found, newest first per carrier (C2 is sent twice, one row a company, and asked for once)
const GET={action:"get", filings:[{documentId:9100001, filingVersionId:"fcver-c1"},{documentId:9100002, filingVersionId:"fcver-c2"},{documentId:9100003, filingVersionId:"fcver-c3"},{filingVersionId:"fcver-c4"},{documentId:9100005, filingVersionId:"fcver-c5"},
  {documentId:9200001, filingVersionId:"fcver-t1"},{documentId:9200002, filingVersionId:"fcver-t2"},{documentId:9200003, filingVersionId:"fcver-t3"}]};
const FC_ASK="Do these carriers have separate programs or forms for different kinds of customer, such as private client and middle market? Use their form filings in this search and cite the pages.";
// what a summary request carries: the search row's fields (no bare tracking number), its companies and the labelled number
const makeBody=(r)=>{ const keep=["documentId","filingVersionId","serffFilingEntityEventId","sfcNumber","companyId","companyName","institutionId","naicGroupName","serffFilingStateId","serffFilingState","typeOfInsuranceId","typeOfInsurance","subTypeOfInsurance","serffFilingTypeId","serffFilingType","filingStatusId","filingStatus","dateSubmitted","publishDate","newBusReqEffDate","renewBusReqEffDate","overallRateImpact","filingDescription","pages"];
  const o={}; for(const k of keep) if(r[k]!==null&&r[k]!==undefined&&r[k]!=="") o[k]=r[k]; o.companies=r.companies.map(c=>({companyId:c.companyId, companyName:c.companyName, institutionId:c.institutionId})); return o; };
const row=v=>ROWS.find(r=>r.filingVersionId===v);
const bigGroup=n=>({name:"Nonesuch Group", code:null, companies:n, searchable:n, tooBig:false, requestsPerYear:Math.ceil(n/10), members:Array.from({length:n},(_,i)=>({companyName:`Nonesuch Member ${i+1} Co`, companyId:null, institutionId:String(6000001+i)}))});

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", deviceScaleFactor:width<500?2:1}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:{}, xlsxLoads:0, asked:1, saved:copy(DIG.saved), makes:[], status:()=>copy(STATUS),
      resolve:q=>/nonesuch group/i.test(q) ? {query:q, matches:[], groups:[bigGroup(98)]} : /calloway/i.test(q) ? copy(RES.calloway) : /tarrow/i.test(q) ? copy(RES.tarrow) : /nonesuch/i.test(q) ? copy(RES.nonesuch) : {query:q, matches:[], groups:[], note:"No saved company matches."},
      search:body=>({status:200, body:answer(body)}),
      dstatus:()=>({status:200, body:{claude:{configured:true}, filings:{configured:true}, saved:4}}),
      get:body=>{ const ds=[], miss=[]; for(const f of body.filings){ const d=f.documentId!==undefined && t.saved[String(f.documentId)]; if(d) ds.push(copy(d)); else miss.push(f); } return {status:200, body:{digests:ds, missing:miss}}; },
      make:body=>{ const a=t.makes.shift(); if(a) return a; const d=DIG.made[String(body.filing.documentId)]; return d ? {status:200, body:{digest:copy(d), usage:{inputTokens:465000, outputTokens:900, costUsd:2.41, spRequests:1}, fromStore:false}} : {status:500, body:{error:"server", message:"Made-up failure."}}; },
      ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(t.delay[fn+":"+body.action]) await new Promise(res=>setTimeout(res,t.delay[fn+":"+body.action]));
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:t.asked, dailyLimit:20, costToday:0.2*t.asked, resetsAt:"2026-11-14T00:00:00Z"});
        if(fn==="snl-chat" && body.action==="ask") return J(200,{jobId:"job-fc-1"});
        if(fn==="snl-chat") return J(400,{error:"bad", message:"Unknown action."});
        if(fn==="snl-digest"){
          if(t.digestGone) return r.fulfill({status:404, body:""}).catch(()=>{});
          const a=body.action==="status" ? t.dstatus(body) : body.action==="get" ? t.get(body) : body.action==="make" ? t.make(body) : {status:400, body:{error:"bad", message:"Unknown action."}};
          if(body.action==="make" && a.status===200) t.asked++;
          return J(a.status, a.body); }
        if(body.action==="status") return J(200,t.status());
        if(body.action==="reference") return J(200,REFS);
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        if(body.action==="search"){ const a=t.search(body); return J(a.status,a.body); }
        if(body.action==="document") return r.fulfill({status:200,contentType:"application/pdf",headers:{"access-control-allow-origin":"*"},body:"%PDF-1.4 made-up"});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)){ t.xlsxLoads++; return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; window.__opened=[]; window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; };
      if(o.sets){ window.__setCalls=[]; window.setPickHTML=target=>{ window.__setCalls.push(target); return `<div id="setPick" data-target="${target}">Use a saved set</div>`; }; window.SET_TARGETS={}; } },opts);
    await p.goto(BASE+(over.hash||"#forms")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.cells=async sel=>p.$$eval(sel+" tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=(fn,a)=>t.calls.filter(c=>c.fn===fn && c.body.action===a);
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    t.find=async q=>{ await p.fill("#fc_find",q); await p.press("#fc_find","Enter"); await p.waitForTimeout(200); };
    t.pickCalloway=async()=>{ await t.find("Calloway"); await p.click('#fc_matches [data-act="fc-group"] >> nth=0'); await p.waitForTimeout(150); };
    t.pickTarrow=async()=>{ await t.find("Tarrow"); await p.click('#fc_matches [data-act="fc-co"] >> nth=0'); await p.waitForTimeout(150); };
    t.pickNonesuch=async()=>{ await t.find("Nonesuch"); await p.click('#fc_matches [data-act="fc-co"] >> nth=0'); await p.waitForTimeout(150); };
    t.choose=async()=>{ await p.selectOption("#fc_state","FL"); await p.waitForTimeout(80); await p.selectOption("#fc_toi","101"); await p.waitForTimeout(80); };
    t.run=async(ms)=>{ await p.click("#fc_run"); await p.waitForTimeout(ms||500); };
    t.setN=async n=>{ await p.selectOption("#fc_n",String(n)); await p.waitForTimeout(100); };
    t.ready=async()=>{ await t.pickCalloway(); await t.pickTarrow(); await t.choose(); await t.run(); };
    return t;
  }
  // a search answer, in the function's shape, with the rows that name a company searched
  function answer(body){
    const ids=new Set([...(body.institutionIds||[]).map(x=>"i"+x), ...(body.companyIds||[]).map(x=>"c"+x)]);
    const rows=copy(ROWS).filter(r=>ids.has("i"+r.institutionId) || r.companies.some(c=>ids.has("i"+c.institutionId)));
    return {params:{companyIds:body.companyIds, institutionIds:body.institutionIds, states:body.states, filingStatusIds:[1,2,3,4], typeOfInsuranceIds:body.typeOfInsuranceIds, filingTypeIds:body.filingTypeIds, spStatEntityIds:[], trackingNumbers:[], from:body.from, to:body.to, allStatuses:true},
      rows, total:rows.length, requests:3, capped:false, byState:[{state:"FL", rows:rows.length}], byCompany:[], notes:[], source:"S&P Global Market Intelligence, SNL Insurance Product Filings", fetchedAt:"2026-11-13T11:00:00.000Z", fromStore:false, saved:true, used:{hour:15, day:43}, limits:{hour:500, day:12000}};
  }

  // ----- the view as it opens -----
  let t=await open(); let p=t.p;
  ok("the view opens at #forms as the second page of the Compare tab", (await t.txt(".action-title"))==="Programs and forms side by side" && same(await t.list("nav.tabs a"),["Filings","Snapshot","Compare","Market","Earnings","Statutory","Combination","Profile"]) && (await p.getAttribute('nav.tabs a[href="#compare"]',"aria-current"))==="page" && (await p.$$('nav.tabs a[aria-current="page"]')).length===1);
  ok("a switch at the top goes between the two Compare pages, and marks this one", same(await t.list("#cmpSwitch a"),["Rates and filings","Programs and forms"]) && (await p.getAttribute('#cmpSwitch a[href="#forms"]',"aria-current"))==="page" && (await p.getAttribute('#cmpSwitch a[href="#compare"]',"aria-current"))===null);
  ok("on opening: S&P's lists once, the summaries function's status once, and the day's questions", same(t.of("snl-filings","reference").map(c=>c.body),[{action:"reference"}]) && same(t.of("snl-digest","status").map(c=>c.body),[{action:"status"}]) && t.of("snl-chat","status").length===1 && t.of("snl-digest","get").length===0);
  ok("nothing chosen; no state, no type of insurance, with a plain prompt to choose one; 3 years", (await t.txt("#fc_none"))==="No carriers chosen yet." && (await p.inputValue("#fc_state"))==="" && (await p.inputValue("#fc_toi"))==="" && (await t.txt("#fc_toiHint"))==="Choose one, such as Homeowners: the comparison is for one type of insurance." && (await p.getAttribute('[data-act="fc-years"][data-y="3"]',"aria-pressed"))==="true");
  ok("type of insurance offers S&P's list", same((await t.list("#fc_toi option")).slice(0,3),["Choose a type of insurance","Homeowners","Private passenger auto"]) && (await p.$$("#fc_toi option")).length===REFS.lists.typeOfInsurance.options.length+1);
  ok("says what will be searched: form filings, the dates, every status, and S&P's form type", (await t.txt("#fc_dates"))==="Form filings published 15 Nov 2023 to 13 Nov, every status (S&P's filing type Form).", await t.txt("#fc_dates"));
  ok("no cost before two carriers are chosen", !(await p.$("#fc_cost")) && !(await p.$("#fcHead")));
  await p.click("#fc_run"); await p.waitForTimeout(100);
  ok("run with nothing chosen: says what to do, sends nothing", (await t.txt("#fc_formErr"))==="Choose at least 2 carriers to compare: find each by name above." && t.of("snl-filings","search").length===0);
  await p.click('[data-act="fc-find"]'); await p.waitForTimeout(100);
  ok("find with an empty box: says what to type", (await t.txt("#fc_findErr"))==="Type part of a company or group name." && t.of("snl-filings","resolve").length===0);
  await t.find("Zzz");
  ok("no match: plain words", (await t.txt("#fc_noMatch"))==='No company in the app\'s company list matches "Zzz". Try a shorter part of the name.');
  ok("with no saved sets: no saved-set control, and no errors", !(await p.$("#setpick_forms")) && errs.length===0, errs);

  // ----- choosing carriers -----
  await t.find("Calloway");
  ok("a whole group first, with its companies, then each company", same(await t.list("#fc_matches li .t1"),[CAL,"Calloway Insurance Co","Calloway Home Co","Calloway Coastal Co"]) && (await t.txt("#fc_matches li >> nth=0 >> .t2"))==="Group · 3 companies with S&P ids; choosing it takes every member in the company list", await t.list("#fc_matches li .t2"));
  await p.click('#fc_matches [data-act="fc-group"]'); await p.waitForTimeout(150);
  ok("choosing the group takes its members from the look-up, with no second look-up", same(t.of("snl-filings","resolve").map(c=>c.body),[{action:"resolve", q:"Zzz"},{action:"resolve", q:"Calloway"}]) && same(await p.evaluate(()=>S.fc.picks[0].ids.map(c=>c.kind+":"+c.id)),["institutionId:5000001","institutionId:5000002","institutionId:5000003"]));
  ok("the chosen group says how many companies and how many are left out", same(await t.list("#fc_chips .cchip > span"),[`${CAL} group of 3 companies; 1 without an S&P id left out`]));
  await p.click("#fc_run"); await p.waitForTimeout(80);
  ok("one carrier isn't a comparison", (await t.txt("#fc_formErr"))==="Choose at least 2 carriers to compare: find each by name above.");
  await t.find("Tarrow");
  ok("hostile names show as text; a company with no S&P id can't be chosen and says why", same(await t.list("#fc_matches li .t1"),["Tarrow Mutual Insurance Co","Tarrow <b>Re</b> Co"]) && !(await p.$("#fc_matches b")) && (await t.txt("#fc_matches li >> nth=1 >> .noadd"))==="Can't be used: the company list has no S&P id for it, so its filings can't be searched." && (await p.$$('#fc_matches [data-act="fc-co"]')).length===1);
  await p.click('#fc_matches [data-act="fc-co"]'); await p.waitForTimeout(150);
  ok("two carriers chosen", same(await t.list("#fc_chips .cchip > span"),[`${CAL} group of 3 companies; 1 without an S&P id left out`,`${TAR} S&P institution id 5100001`]));
  ok("the cost: 4 companies over 3 years is 3 requests, in one search", (await t.txt("#fc_cost"))==="About 3 S&P requests in one search (one for each 10 companies for each year of dates), more if S&P has many filings. A search someone has already run costs none.", await t.txt("#fc_cost"));
  await t.find("Tarrow"); await p.click('#fc_matches [data-act="fc-co"]'); await p.waitForTimeout(150);
  ok("the same carrier twice is refused", (await p.$$("#fc_chips .cchip")).length===2);
  await p.click("#fc_run"); await p.waitForTimeout(80);
  ok("no state: says so", (await t.txt("#fc_formErr"))==="Choose a state." && t.of("snl-filings","search").length===0);
  await p.selectOption("#fc_state","FL"); await p.waitForTimeout(80);
  await p.click("#fc_run"); await p.waitForTimeout(80);
  ok("no type of insurance: says so", (await t.txt("#fc_formErr"))==="Choose a type of insurance." && t.of("snl-filings","search").length===0);
  await p.selectOption("#fc_toi","101"); await p.waitForTimeout(80);
  ok("the state and type of insurance join the description, and the prompt goes", (await t.txt("#fc_dates"))==="Form filings published 15 Nov 2023 to 13 Nov in Florida, Homeowners, every status (S&P's filing type Form)." && !(await p.$("#fc_toiHint")));
  await p.check("#fc_wide"); await p.waitForTimeout(80);
  ok("the tick widens to rule and rate filings: every type naming a form, rule or rate", (await t.txt("#fc_dates"))==="Form, rule and rate filings published 15 Nov 2023 to 13 Nov in Florida, Homeowners, every status (S&P's filing types Form, Rate, Rule, Rate and rule).", await t.txt("#fc_dates"));
  await p.uncheck("#fc_wide"); await p.waitForTimeout(80);
  await p.click('[data-act="fc-years"][data-y="1"]'); await p.waitForTimeout(80);
  ok("the last year: 1 request, from 14 Nov 2025", (await t.txt("#fc_cost")).startsWith("About 1 S&P request in one search (") && (await t.txt("#fc_dates")).startsWith("Form filings published 14 Nov 2025 to 13 Nov"));
  await p.click('[data-act="fc-years"][data-y="5"]'); await p.waitForTimeout(80);
  ok("the last 5 years: 5 requests, from 15 Nov 2021", (await t.txt("#fc_cost")).startsWith("About 5 S&P requests in one search (") && (await t.txt("#fc_dates")).startsWith("Form filings published 15 Nov 2021 to 13 Nov"));
  await p.click('[data-act="fc-years"][data-y="3"]'); await p.waitForTimeout(80);
  ok("the form-filing types are picked out by name in one function, and the edition dates read as month and year", await p.evaluate(()=>[fcFilingTypes(false).map(t=>t.id), fcFilingTypes(true).map(t=>t.id), fcEdition("06 25"), fcEdition("03/2020"), fcEdition("1 99"), fcEdition("Ed. 2024"), fcEdition("13 25")]).then(v=>same(v,[[11],[11,12,13,14],202506,202003,199901,null,null]) || console.log(v)));
  ok("UNCONFIRMED is marked on the form-type matching", /UNCONFIRMED: which of S&P's filing types are form filings[\s\S]{0,600}function fcFilingTypes\(wide\)/.test(fs.readFileSync(WEB+"/index.html","utf8")));

  // ----- finding the filings -----
  t.delay["snl-filings:search"]=400;
  await p.click("#fc_run"); await p.waitForTimeout(150);
  ok("while it runs: says so and the button waits", (await t.txt("#fcBusy"))==="Finding the filings… A long period can take a minute. Each search is saved, so the same one opens at once next time." && await p.isDisabled("#fc_run"));
  await p.waitForTimeout(600); t.delay={};
  ok("one search: the four companies, Florida, Homeowners, form filings, the last 3 years, every status", same(t.of("snl-filings","search").map(c=>c.body),[SEARCH]), t.of("snl-filings","search").map(c=>c.body));
  ok("then one free request for the saved summaries of every filing found, each once, newest first by carrier", same(t.of("snl-digest","get").map(c=>c.body),[GET]), t.of("snl-digest","get").map(c=>c.body));
  ok("heading: the carriers and what was searched", (await t.txt("#fcName"))===`${CAL}, ${TAR}` && (await t.txt("#fcMeta"))==="Form filings in Florida · Homeowners · published 15 Nov 2023 to 13 Nov · every status", await t.txt("#fcMeta"));
  ok("per carrier: how many found, newest first, and how many have a saved summary", same(await t.list("#fcFound [data-count]"),["5 filings, newest first; 3 with a saved summary, 2 without.","3 filings, newest first; 1 with a saved summary, 2 without."]));
  const C1SUM="Introduces a private client homeowners program and revises the standard homeowners forms. Rests on pages 1 to 150 of 624.";
  ok("Calloway's filings: S&P's number when there's no tracking number, type, status, dates, pages, the summary and the pages it rests on", same(await t.cells("#fcFiled0"),[
    ["S&P no. FCS-C-0001","Form","Approved","1 Aug","10 Oct","624",C1SUM,"Open document"],
    ["CALL-FORM-0002","Form","Approved","2 Apr","15 Jun","210","Revises the high-value homes policy and adds a water backup endorsement. Rests on pages 1 to 150 of 210.","Open document"],
    ["S&P no. FCS-C-0003","Form","Approved","1 Oct 2025","20 Nov 2025","88","Updates a policyholder notice. Rests on pages 1 to 88 of 88.","Open document"],
    ["CALL-FORM-0004","Form","Pending","15 Oct 2024","1 Dec 2024","n/d","No saved summary.","Open document"],
    ["CALL-FORM-0005","Form","Withdrawn","20 Jan 2024","3 Mar 2024","40","No saved summary.","Open document"]]), await t.cells("#fcFiled0"));
  ok("Tarrow's filings", same(await t.cells("#fcFiled1"),[
    ["TARR-FORM-0001","Form","Approved","1 Jul","1 Sept","300","Replaces the homeowners special form with a new edition. Rests on pages 1 to 150 of 300.","Open document"],
    ["TARR-FORM-0002","Form","Approved","1 Mar 2025","5 May 2025","150","No saved summary.","Open document"],
    ["TARR-FORM-0003","Form","Approved","1 May 2024","7 Jul 2024","60","No saved summary.","Open document"]]), await t.cells("#fcFiled1"));
  ok("the filing sent twice, once for each company, is one filing", await p.evaluate(()=>fcCarriers(S.fc)[0].list.filter(f=>f.r.filingVersionId==="fcver-c2").length===1 && fcCarriers(S.fc)[0].list.find(f=>f.r.filingVersionId==="fcver-c2").r.companies.length===2));

  // ----- summaries: counts, and the cost before anything is made -----
  ok("saved summaries per carrier, and how many without", same(await t.list("#fcHave span"),[`${CAL}: 3 of 5, 2 without`,`${TAR}: 1 of 3, 2 without`]));
  ok("the choice is the latest 2 by default, at most 5", (await p.inputValue("#fc_n"))==="2" && same(await t.list("#fc_n option"),["1","2","3","4","5"]));
  // the latest 2: Calloway's both have summaries; Tarrow's T2 hasn't (150 pages: $2.30 to $3.50)
  ok("latest 2: one new summary, its requests and dollars, and that it is an estimate", (await t.txt("#fcMakeCost"))==="1 new summary: 1 S&P request and roughly $2.30 to $3.50 of Claude reading. An estimate: up to the first 150 pages of each filing (150 pages in all), at the README's rate of $2.30 to $3.50 for 150 pages. What it really cost shows when it is done.", await t.txt("#fcMakeCost"));
  ok("and that each counts as one of the day's questions", (await t.txt("#fcMakeDaily"))==="You've asked 1 of 20 questions today; these would add 1." && (await t.txt("#fc_make"))==="Summarise 1 filing");
  await t.setN(3);
  // latest 3: T2 (150 pages) and T3 (60): 210 pages, 210 x 2.30 / 150 = 3.22 and 210 x 3.50 / 150 = 4.90
  ok("latest 3: two new summaries, 210 pages, $3.22 to $4.90", (await t.txt("#fcMakeCost")).startsWith("2 new summaries: 2 S&P requests and roughly $3.22 to $4.90 of Claude reading. An estimate: up to the first 150 pages of each filing (210 pages in all),"), await t.txt("#fcMakeCost"));
  await t.setN(5);
  // latest 5: C4 (no page count, so 150), C5 (40), T2 (150), T3 (60): 400 pages, $6.13 to $9.33
  ok("latest 5: four new summaries, a filing with no page count counted as 150, $6.13 to $9.33", (await t.txt("#fcMakeCost"))==="4 new summaries: 4 S&P requests and roughly $6.13 to $9.33 of Claude reading. An estimate: up to the first 150 pages of each filing (400 pages in all, counting 1 filing with no page count as 150), at the README's rate of $2.30 to $3.50 for 150 pages. What it really cost shows when it is done.", await t.txt("#fcMakeCost"));
  ok("nothing is summarised until the reader chooses", t.of("snl-digest","make").length===0);

  // ----- the comparison, from saved summaries -----
  ok("what it rests on: summarised out of found per carrier, the pages, and that segments are judgements", same(await t.list("#fcRests li"),[`${CAL}: 3 of 5 filings found are summarised.`,`${TAR}: 1 of 3 filings found is summarised.`,
    "Each summary rests only on the pages stated in it, often the first 150 of a much longer filing, so a program or form on other pages may be missing.","The segments (private client, middle market, standard, other) are judgements made when each filing was summarised. The words each rests on are quoted beside it."]), await t.list("#fcRests li"));
  ok("programs: a column per carrier, a row per segment", same(await t.list("#fcProgTable thead th"),["Segment",CAL,TAR]) && same(await p.$$eval("#fcProgTable tbody tr",rs=>rs.map(r=>r.dataset.seg||"say")),["say","private client","middle market","standard"]));
  ok("programs: what the summaries show, one sentence a carrier, never stated as fact", same((await t.cells("#fcProgTable"))[0],["What the summaries show","Two programs found: one private client, one middle market.","One program found (standard); the summaries do not show a separate private client program."]), (await t.cells("#fcProgTable"))[0]);
  ok("programs: each with the words it rests on, its filing, date and page, and a link to that page; the same program in two filings lists both", same((await t.cells("#fcProgTable")).slice(1),[
    ["Private client","Calloway Signature Home“for dwellings with a replacement cost of $1,000,000 or more”S&P no. FCS-C-0001, 10 Oct, page 4Open at page 4“the high-value homes program”CALL-FORM-0002, 15 Jun, page 2Open at page 2","None in the summaries"],
    ["Middle market","Calloway Homeowners Advantage“owner-occupied homes with Coverage A from $250,000 to $999,999”S&P no. FCS-C-0001, 10 Oct, page 5Open at page 5","None in the summaries"],
    ["Standard","None in the summaries","Tarrow Homeowners“the company's homeowners program for owner-occupied dwellings”TARR-FORM-0001, 1 Sept, page 6Open at page 6"]]), (await t.cells("#fcProgTable")).slice(1));
  ok("forms: by form number, latest edition first, earlier editions collapsed", same(await t.cells("#fcForms0"),[
    ["CHO 04 10","06 25","Water backup endorsement","Replaced; replaces CHO 04 10 01 22","Calloway Homeowners Advantage","S&P no. FCS-C-0001","10 Oct","20","Open at page 20Show 1 earlier edition"],
    ["CHO 30 01","06 25","Signature homeowners policy","New","Not linked","S&P no. FCS-C-0001","10 Oct","12","Open at page 12Show 1 earlier edition"],
    ["CHO 30 02","06 25","Advantage homeowners policy","Revised","Not linked","S&P no. FCS-C-0001","10 Oct","14","Open at page 14"]]), await t.cells("#fcForms0"));
  ok("forms: the same columns for each carrier", same(await t.list("#fcForms0 thead th"),["Form","Edition","Title","What the filing did","Program","Filing","Published","Page","Document"]));
  ok("forms: Tarrow's, a dated edition before an older one and one whose edition isn't a date", same(await t.cells("#fcForms1"),[
    ["TM HO 3","09 24","Homeowners 3 special form","New","Not linked","TARR-FORM-0001","1 Sept","10","Open at page 10Show 1 earlier edition"],
    ["TM HO 04 90","Ed. 2024","Personal property replacement cost","n/d","Not linked","TARR-FORM-0001","1 Sept","15","Open at page 15"]]), await t.cells("#fcForms1"));
  await p.click('#fcForms0 [data-act="fc-more"] >> nth=0'); await p.waitForTimeout(100);
  ok("an earlier edition opens underneath, from the older filing", same((await t.cells("#fcForms0")).slice(0,2),[
    ["CHO 04 10","06 25","Water backup endorsement","Replaced; replaces CHO 04 10 01 22","Calloway Homeowners Advantage","S&P no. FCS-C-0001","10 Oct","20","Open at page 20Hide 1 earlier edition"],
    ["CHO 04 10","01 22","Water backup endorsement","New","Not linked","CALL-FORM-0002","15 Jun","11","Open at page 11"]]) && (await p.$$("#fcForms0 tr[data-old]")).length===1, (await t.cells("#fcForms0")).slice(0,2));
  ok("rate and eligibility notes, with filing and page", same(await t.list("#fcNotes0 li"),[
    "Rate: Effective for new business 1 Jan 2027.S&P no. FCS-C-0001, 10 Oct, page 3Open at page 3",
    "Rate: Overall rate change 4.5%; effective for new business 1 Aug.CALL-FORM-0002, 15 Jun, page 3Open at page 3",
    "Eligibility: Signature Home requires a monitored central station alarm.S&P no. FCS-C-0001, 10 Oct, page 21Open at page 21",
    "Also: Water backup cover moves to an endorsement.S&P no. FCS-C-0001, 10 Oct, page 31Open at page 31"]) && same(await t.list("#fcNotes1 li"),["Eligibility: Homes must be owner-occupied.TARR-FORM-0001, 1 Sept, page 22Open at page 22"]), [await t.list("#fcNotes0 li"), await t.list("#fcNotes1 li")]);
  await p.click('#fcProgTable [data-act="open-doc"][data-page="4"]'); await p.waitForTimeout(250);
  ok("Open at page opens the filing's document at that page", same(t.of("snl-filings","document").map(c=>c.body),[{action:"document", documentId:9100001}]) && await p.evaluate(()=>window.__opened.length===1 && /#page=4$/.test(window.__opened[0].location.href)));
  await p.click('#fcFiled0 tr[data-dk="v:fcver-c4"] [data-act="open-doc"]'); await p.waitForTimeout(250);
  ok("a filing with only a version id opens by its version id", deq(t.of("snl-filings","document").slice(-1)[0].body,{action:"document", filingVersionId:"fcver-c4"}));
  { const names=[CAL,TAR,"S&P","Claude","README"], loud=(await t.list("#view h2,#view h3,#view h4,#view button,#view th")).filter(s=>/\s[A-Z][a-z]+/.test(names.reduce((a,n)=>a.split(n).join("x"),s)));
    ok("headings, buttons and column heads in sentence case", loud.length===0, loud); }
  ok("no page errors so far", errs.length===0, errs);
  await p.screenshot({path:OUTDIR+"/formcompare-1440.png",fullPage:true});
  await p.screenshot({path:SCRATCH+"/formcompare-1440.png",fullPage:true}).catch(()=>{});

  // ----- exports -----
  const csvRows=s=>s.replace(/^﻿/,"").split("\r\n");
  let d=await t.download(()=>p.click('#fcCompare [data-what="forms"][data-tbl="programs"][data-fmt="csv"]'));
  ok("programs CSV: every program and every filing it rests on", d.name==="snl-programs-fl-homeowners-2026-11-13.csv" && same(csvRows(d.text),[
    '"Carrier","Program","Segment","Basis (words from the filing)","Filing","Date published","Page","Document id","Filing version id"',
    `"${CAL}","Calloway Signature Home","private client","for dwellings with a replacement cost of $1,000,000 or more","S&P no. FCS-C-0001","2026-10-10","4","9100001","fcver-c1"`,
    `"${CAL}","Calloway Signature Home","private client","the high-value homes program","CALL-FORM-0002","2026-06-15","2","9100002","fcver-c2"`,
    `"${CAL}","Calloway Homeowners Advantage","middle market","owner-occupied homes with Coverage A from $250,000 to $999,999","S&P no. FCS-C-0001","2026-10-10","5","9100001","fcver-c1"`,
    `"${TAR}","Tarrow Homeowners","standard","the company's homeowners program for owner-occupied dwellings","TARR-FORM-0001","2026-09-01","6","9200001","fcver-t1"`]), csvRows(d.text));
  d=await t.download(()=>p.click('#fcCompare [data-tbl="forms"][data-fmt="csv"]'));
  ok("forms CSV: every edition, the latest marked", d.name==="snl-forms-fl-homeowners-2026-11-13.csv" && same(csvRows(d.text),[
    '"Carrier","Form number","Edition","Latest edition","Title","What the filing did","Replaces","Program","Filing","Date published","Page","Document id","Filing version id"',
    `"${CAL}","CHO 04 10","06 25","Yes","Water backup endorsement","replaced","CHO 04 10 01 22","Calloway Homeowners Advantage","S&P no. FCS-C-0001","2026-10-10","20","9100001","fcver-c1"`,
    `"${CAL}","CHO 04 10","01 22","No","Water backup endorsement","new","","","CALL-FORM-0002","2026-06-15","11","9100002","fcver-c2"`,
    `"${CAL}","CHO 30 01","06 25","Yes","Signature homeowners policy","new","","","S&P no. FCS-C-0001","2026-10-10","12","9100001","fcver-c1"`,
    `"${CAL}","CHO 30 01","01 22","No","Signature homeowners policy","revised","","","CALL-FORM-0002","2026-06-15","9","9100002","fcver-c2"`,
    `"${CAL}","CHO 30 02","06 25","Yes","Advantage homeowners policy","revised","","","S&P no. FCS-C-0001","2026-10-10","14","9100001","fcver-c1"`,
    `"${TAR}","TM HO 3","09 24","Yes","Homeowners 3 special form","new","","","TARR-FORM-0001","2026-09-01","10","9200001","fcver-t1"`,
    `"${TAR}","TM HO 3","03/2020","No","Homeowners 3 special form","withdrawn","","","TARR-FORM-0001","2026-09-01","11","9200001","fcver-t1"`,
    `"${TAR}","TM HO 04 90","Ed. 2024","Yes","Personal property replacement cost","","","","TARR-FORM-0001","2026-09-01","15","9200001","fcver-t1"`]), csvRows(d.text));
  d=await t.download(()=>p.click('#fcCompare [data-tbl="programs"][data-fmt="xlsx"]'));
  const wb=JSON.parse(d.text);
  ok("programs Excel: the same rows, pages and ids as numbers", d.name==="snl-programs-fl-homeowners-2026-11-13.xlsx" && wb.sheets[0].name==="Programs" && wb.sheets[0].aoa.length===5 && same(wb.sheets[0].aoa[1].slice(-3),[4,9100001,"fcver-c1"]) && t.xlsxLoads===1, wb.sheets[0].aoa[1]);

  // ----- Ask Claude, told the search as the Filings view tells it -----
  await p.click("#fc_ask"); await p.waitForTimeout(200);
  ok("Ask Claude about this: opens the panel with a question to start from, and says what Claude will be told", await p.isVisible("#askPanel") && (await p.inputValue("#ask_input"))===FC_ASK && (await t.txt("#askTold"))==="Claude will be told what is on screen: 8 filings for 4 institutions in FL, 15 Nov 2023 to 13 Nov.", await t.txt("#askTold"));
  await p.click('[data-act="ask-send"]'); await p.waitForTimeout(300);
  const ask=t.of("snl-chat","ask")[0];
  ok("the question goes with the search in the Filings view's shape, and the carriers' and companies' names", !!ask && ask.body.question===FC_ASK && same(ask.body.screen,{view:"filings", search:{companyIds:[], institutionIds:[5000001,5000002,5000003,5100001], states:["FL"], from:"2023-11-15", to:"2026-11-13", typeOfInsuranceIds:[101], filingTypeIds:[11], filingStatusIds:[]}, total:8, companies:[CAL,TAR,"Calloway Insurance Co","Calloway Home Co","Calloway Coastal Co"]}), ask&&ask.body.screen);
  await p.click("#askClose"); await p.waitForTimeout(100);

  // ----- summarising: one at a time, keeps going past failures, says what was and wasn't made -----
  // latest 5, in turn by carrier: C4, T2, C5, T3. C4 is too large, T2 is made, C5 finds another answer running, T3 hits the limit.
  t.makes=[{status:413, body:{error:"too_large", message:"That document is too large."}}, null, {status:409, body:{error:"busy", message:"Another answer is running."}}, {status:429, body:{error:"limit", message:"Today's limit is reached."}}];
  t.make=(body)=>{ const a=t.makes.shift(); if(a) return a; const dd=DIG.made[String(body.filing.documentId)]; return {status:200, body:{digest:copy(dd), usage:{inputTokens:465000, outputTokens:900, costUsd:2.41, spRequests:1}, fromStore:false}}; };
  t.delay["snl-digest:make"]=300;
  const chatBefore=t.of("snl-chat","status").length;
  await p.click("#fc_make"); await p.waitForTimeout(150);
  ok("progress: which one of how many, by number and carrier, with Stop", (await t.txt("#fcMaking"))===`Summarising 1 of 4: CALL-FORM-0004 (${CAL})… Each takes a minute or two. Keep this tab open.Stop` && await p.isDisabled("#fc_run"), await t.txt("#fcMaking"));
  ok("the filing being summarised says so in its row", (await t.txt('#fcFiled0 tr[data-dk="v:fcver-c4"] .c-sum'))==="Summarising…");
  await p.waitForTimeout(1500); t.delay={};
  ok("one filing a call, in turn by carrier, each with its search row's fields and labelled number", t.of("snl-digest","make").length===4 && t.of("snl-digest","make").every((c,i)=>deq(c.body,{action:"make", filing:{...makeBody(row(["fcver-c4","fcver-t2","fcver-c5","fcver-t3"][i])), filingNo:["CALL-FORM-0004","TARR-FORM-0002","CALL-FORM-0005","TARR-FORM-0003"][i]}})), t.of("snl-digest","make").map(c=>c.body));
  ok("no bare tracking number is passed on", t.of("snl-digest","make").every(c=>!("trackingNumber" in c.body.filing)));
  ok("what was and wasn't made, and why, in plain words; and what it really cost", (await t.txt("#fcMade >> b"))==="1 of 4 summaries made." && (await t.txt("#fcMade")).includes("These cost about $2.41 and used 1 S&P request.") && same(await t.list("#fcMadeList li"),[
    `CALL-FORM-0004 (${CAL}): not summarised: the document is too large to read.`,`TARR-FORM-0002 (${TAR}): summarised.`,
    `CALL-FORM-0005 (${CAL}): not summarised: another summary or answer for your login was running. Try again in a minute.`,`TARR-FORM-0003 (${TAR}): not summarised: today's limit on questions is reached (each summary counts as one). Try again after midnight UTC.`]), await t.list("#fcMadeList li"));
  ok("the rows say the same", (await t.txt('#fcFiled0 tr[data-dk="v:fcver-c4"] .c-sum'))==="Not summarised: the document is too large to read." && (await t.txt('#fcFiled1 tr[data-dk="d:9200002"] .c-sum'))==="Adds a high-value homes endorsement package. Rests on pages 1 to 150 of 150.");
  ok("the day's questions are checked again afterwards", t.of("snl-chat","status").length>chatBefore);
  ok("the new summary joins the comparison: Tarrow now has a private client program", same((await t.cells("#fcProgTable"))[0],["What the summaries show","Two programs found: one private client, one middle market.","Two programs found: one private client, one standard; the summaries do not show a separate middle market program."]) && (await t.cells("#fcProgTable"))[1][2]==="Tarrow Estate Plus“an endorsement package for homes valued over $1,500,000”TARR-FORM-0002, 5 May 2025, page 3Open at page 3", (await t.cells("#fcProgTable")).slice(0,2));
  ok("and its form edition sits under the latest, newer filing first", same((await t.cells("#fcForms1"))[0].slice(-1),["Open at page 10Show 2 earlier editions"]) && same(await t.list("#fcHave span"),[`${CAL}: 3 of 5, 2 without`,`${TAR}: 2 of 3, 1 without`]));
  await p.click('#fcForms1 [data-act="fc-more"]'); await p.waitForTimeout(100);
  ok("editions: 09 24, then the two 03/2020 entries, the newer filing's first", same((await t.cells("#fcForms1")).slice(0,3).map(r=>[r[1],r[3],r[5]]),[["09 24","New","TARR-FORM-0001"],["03/2020","Withdrawn","TARR-FORM-0001"],["03/2020","Unchanged","TARR-FORM-0002"]]));
  // the daily limit part-way: the first of three hits it, the rest aren't started
  t.makes=[{status:429, body:{error:"limit", message:"Today's limit is reached."}}];
  ok("again: three left without a summary in the latest 5", (await t.txt("#fc_make"))==="Summarise 3 filings");
  await p.click("#fc_make"); await p.waitForTimeout(500);
  ok("the daily limit reached part-way: stops there and says the rest weren't started", t.of("snl-digest","make").length===5 && same(await t.list("#fcMadeList li"),[
    `CALL-FORM-0004 (${CAL}): not summarised: today's limit on questions is reached (each summary counts as one). Try again after midnight UTC.`,`TARR-FORM-0003 (${TAR}): not started: today's limit on questions was reached.`,`CALL-FORM-0005 (${CAL}): not started: today's limit on questions was reached.`])
    && (await t.txt("#fcMade >> b"))==="0 of 3 summaries made.", await t.list("#fcMadeList li"));
  ok("no page errors", errs.length===0, errs);
  await ctx_close(t);

  // ----- Stop -----
  t=await open(); p=t.p;
  await t.ready(); await t.setN(5); t.delay["snl-digest:make"]=400;
  await p.click("#fc_make"); await p.waitForTimeout(150);
  await p.click('[data-act="fc-stop"]'); await p.waitForTimeout(80);
  ok("Stop: waits for the one running", (await t.txt('#fcMaking [data-act="fc-stop"]'))==="Stopping after this one…");
  await p.waitForTimeout(600);
  ok("Stop: the one running finishes; the rest aren't started, and say so", t.of("snl-digest","make").length===1 && same(await t.list("#fcMadeList li"),[`CALL-FORM-0004 (${CAL}): not summarised: Made-up failure.`,`TARR-FORM-0002 (${TAR}): not started: you pressed Stop.`,`CALL-FORM-0005 (${CAL}): not started: you pressed Stop.`,`TARR-FORM-0003 (${TAR}): not started: you pressed Stop.`]), await t.list("#fcMadeList li"));
  await ctx_close(t);

  // ----- the phone, with a full comparison -----
  t=await open({}, {width:390}); p=t.p;
  await t.ready();
  ok("phone: no sideways scroll with a full comparison", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  ok("phone: the filings lists become cards; the wide tables scroll inside their own box", await p.evaluate(()=>getComputedStyle(document.querySelector("#fcFiled0 thead")).display==="none" && ["fcProgWrap","fcFormsWrap0"].every(id=>{ const e=document.getElementById(id); return getComputedStyle(e).overflowX==="auto" && e.getBoundingClientRect().right<=window.innerWidth; })));
  await p.screenshot({path:OUTDIR+"/formcompare-390.png",fullPage:true});
  await p.screenshot({path:SCRATCH+"/formcompare-390.png",fullPage:true}).catch(()=>{});
  await ctx_close(t);

  // ----- the summaries function isn't deployed -----
  for(const role of ["corpdev","reader"]){
    t=await open({role}, {digestGone:true, status:()=>({...copy(STATUS), role})}); p=t.p;
    await t.ready();
    ok(`not deployed (${role}): says the summaries function isn't set up, and that the filings and documents still work`, (await t.txt("#fcDigestOff"))===`Summaries aren't set up yet: the summaries function isn't on this site${role==="corpdev"?" (deploy snl-digest; see the README)":""}. The filings found are listed below, and each document opens.`, await t.txt("#fcDigestOff"));
    ok(`not deployed (${role}): the filings are listed, no summaries are asked for, nothing to summarise or compare`, (await p.$$("#fcFiled0 tbody tr")).length===5 && t.of("snl-digest","get").length===0 && !(await p.$("#fcMake")) && !(await p.$("#fcCompare")));
    await p.click('#fcFiled1 [data-act="open-doc"] >> nth=0'); await p.waitForTimeout(250);
    ok(`not deployed (${role}): a document still opens`, same(t.of("snl-filings","document").map(c=>c.body),[{action:"document", documentId:9200001}]));
    if(role==="corpdev"){ await p.screenshot({path:OUTDIR+"/formcompare-nodigest-1440.png",fullPage:true}); await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150); ok("not deployed, phone: no sideways scroll", await t.noScroll()); await p.screenshot({path:OUTDIR+"/formcompare-nodigest-390.png",fullPage:true}); }
    await ctx_close(t);
  }

  // ----- Claude isn't set up -----
  t=await open({}, {dstatus:()=>({status:200, body:{claude:{configured:false}, filings:{configured:true}, saved:4}})}); p=t.p;
  await t.ready();
  ok("Claude not set up: new summaries can't be made, saved ones still show", (await t.txt("#fcDigestOff"))==="New summaries can't be made yet: Claude isn't set up on this site. Saved summaries still show." && await p.isDisabled("#fc_make") && (await t.txt("#fcMakeOff"))==="Summaries can't be made here yet (see above)." && (await p.$$("#fcProgTable tbody tr")).length===4);
  await ctx_close(t);
  t=await open({}, {dstatus:()=>({status:200, body:{claude:{configured:true}, filings:{configured:false}, saved:0}})}); p=t.p;
  await t.ready();
  ok("S&P not set up for summaries: says so, and nothing can be made", (await t.txt("#fcDigestOff"))==="New summaries can't be made yet: S&P isn't set up on this site. Saved summaries still show." && await p.isDisabled("#fc_make"));
  await ctx_close(t);
  // the function says not_configured when asked to make one
  t=await open(); p=t.p; await t.ready(); await t.setN(3);
  t.makes=[{status:503, body:{error:"not_configured", message:"Claude isn't set up yet."}}];
  await p.click("#fc_make"); await p.waitForTimeout(500);
  ok("not configured on make: says so, and the rest aren't started", same(await t.list("#fcMadeList li"),[`TARR-FORM-0002 (${TAR}): not summarised: summaries aren't set up yet. Claude isn't set up yet.`,`TARR-FORM-0003 (${TAR}): not started: summaries aren't set up yet.`]), await t.list("#fcMadeList li"));
  await ctx_close(t);

  // ----- S&P isn't set up -----
  t=await open({}, {status:()=>({...copy(STATUS), filings:{...STATUS.filings, configured:false, message:NOT_SET_UP}}), search:()=>({status:503, body:{error:"not_configured", message:NOT_SET_UP}})}); p=t.p;
  ok("S&P not set up: says a new search can't run, saved ones still open", (await t.txt("#fcOff"))==="S&P filings aren't set up yet, so a new search can't be run. Searches run before still open from their saved results.");
  await t.ready();
  ok("S&P not set up: the function's words as a calm note, not an error, and no summaries asked for", (await t.txt("#fcSearchErr"))===NOT_SET_UP && !(await p.$("#fcSearchErr.banner")) && !(await p.$("#fcFound")) && t.of("snl-digest","get").length===0);
  await ctx_close(t);

  // ----- nothing found for a carrier, and no summaries yet -----
  t=await open({}, {get:body=>({status:200, body:{digests:[], missing:body.filings}})}); p=t.p;
  await t.pickCalloway(); await t.pickNonesuch(); await t.choose(); await t.run();
  ok("nothing for a carrier: 'S&P returned nothing for this search', never that nothing was filed", (await t.txt("#fcCar1 [data-empty]"))===`S&P returned nothing for this search for ${NON}. That isn't proof that nothing was filed: check the carrier, or try a longer period or include rule and rate filings.` && (await t.txt("#fcCar1 [data-count]"))==="", await t.txt("#fcCar1 [data-empty]"));
  ok("no summaries yet: says the comparison needs them", (await t.txt("#fcNoDigests"))==="No summaries yet, so there is nothing to compare. Summarise some filings above; the comparison is built only from saved summaries." && same(await t.list("#fcHave span"),[`${CAL}: 0 of 5, 5 without`,`${NON}: 0 of 0, 0 without`]));
  ok("no summaries yet: the latest 2 of the carrier with filings", (await t.txt("#fc_make"))==="Summarise 2 filings");
  await p.screenshot({path:OUTDIR+"/formcompare-empty-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("nothing found, phone: no sideways scroll", await t.noScroll());
  await ctx_close(t);
  // a carrier with nothing found, beside one with summaries: its sentence says why
  t=await open(); p=t.p; await t.pickTarrow(); await t.pickNonesuch(); await t.choose(); await t.run();
  ok("a carrier with nothing found has nothing to summarise", (await t.cells("#fcProgTable"))[0][2]==="S&P returned nothing for this search, so there is nothing to summarise.", (await t.cells("#fcProgTable"))[0]);
  await ctx_close(t);

  // ----- a summary with empty lists -----
  t=await open(); p=t.p;
  t.saved={"9200001":{...copy(DIG.saved["9100003"]), documentId:9200001, filingVersionId:"fcver-t1"}};
  await t.ready();
  ok("empty lists: the summaries name no program, list no forms and carry no notes", (await t.cells("#fcProgTable"))[0][2]==="The summary names no program." && (await t.txt("#fcFormsCar1 [data-none]"))==="The summary lists no forms." && (await t.txt("#fcNotesCar1 [data-none]"))==="The summaries carry no rate or eligibility notes." && (await t.cells("#fcProgTable"))[0][1]==="None of its filings found has a saved summary yet, so nothing can be said about its programs.", (await t.cells("#fcProgTable"))[0]);
  await ctx_close(t);

  // ----- hostile text in every digest field -----
  t=await open(); p=t.p;
  t.saved={"9200001":copy(DIG.hostile)};
  await t.ready();
  ok("hostile: nothing runs, nothing is drawn as markup", await p.evaluate(()=>window.__xss===undefined) && !(await p.$("#fcOut img")) && !(await p.$("#fcOut script")) && !(await p.$("#fcOut svg")) && !(await p.$("#fcOut a[href]")) && !(await p.$("#fcOut u")) && !(await p.$("#fcOut i")));
  ok("hostile: the summary as text, and pages that aren't numbers aren't trusted", (await t.txt('#fcFiled1 tr[data-dk="d:9200001"] .c-sum'))==='<img src=x onerror="window.__xss=3"> Summary & more The pages it rests on aren\'t stated (the filing has 300 pages).', await t.txt('#fcFiled1 tr[data-dk="d:9200001"] .c-sum'));
  const hp=await t.cells("#fcProgTable");
  ok("hostile: a segment that isn't one of the five is 'not stated'; names, words and pages as text or n/d", same(hp.map(r=>r[0]),["What the summaries show","Private client","Middle market","Segment not stated"])
    && hp[2][2]==="Program not named“The summary gives no words for this.”".replace("“The summary gives no words for this.”","The summary gives no words for this.")+"TARR-FORM-0001, 1 Sept, page n/dOpen document"
    && hp[3][2]==='<img src=x onerror="window.__xss=4">Estate“<script>window.__xss=5</script>"quoted"”TARR-FORM-0001, 1 Sept, page n/dOpen document'
    && hp[0][2]==="Two programs found: one middle market, one segment not stated; the summaries do not show a separate private client program.", hp);
  ok("hostile: forms as text, an unknown action as n/d, a page of 0 as n/d", same(await t.cells("#fcForms1"),[
    ["<b>X 1</b>","<i>06 25</i>",'"><svg onload="window.__xss=6">',"n/d","<u>p</u>","TARR-FORM-0001","1 Sept","n/d","Open document"],
    ["42","n/d","n/d","New","Not linked","TARR-FORM-0001","1 Sept","7","Open at page 7"]]), await t.cells("#fcForms1"));
  ok("hostile: rate and eligibility as text, a fractional page as n/d, a notes field that isn't a list ignored", same(await t.list("#fcNotes1 li"),["Rate: Effective for new business <script>x</script>.TARR-FORM-0001, 1 Sept, page n/dOpen document",'Eligibility: <a href="javascript:window.__xss=7">click</a>TARR-FORM-0001, 1 Sept, page n/dOpen document']), await t.list("#fcNotes1 li"));
  d=await t.download(()=>p.click('#fcCompare [data-tbl="forms"][data-fmt="csv"]'));
  ok("hostile: the export keeps the text as text", csvRows(d.text).some(l=>l.includes('"<b>X 1</b>","<i>06 25</i>"')));
  ok("hostile: no page errors", errs.length===0, errs);
  await ctx_close(t);

  // ----- several searches when one can't take everyone -----
  t=await open(); p=t.p;
  await t.find("Nonesuch Group"); await p.click('#fc_matches [data-act="fc-group"]'); await p.waitForTimeout(150);
  await t.pickCalloway(); await t.pickTarrow(); await t.choose();
  // 98 + 3 is more than 100, so Calloway goes in a second search; Tarrow fits beside the 98 (99 ids: 10 batches x 3 years = 30)
  ok("too many companies for one search: the cost in two searches, run in turn", (await t.txt("#fc_cost"))==="About 33 S&P requests in 2 searches run one after another, since one search takes at most 100 companies and 60 requests (one for each 10 companies for each year of dates), more if S&P has many filings. A search someone has already run costs none.", await t.txt("#fc_cost"));
  let n=0; t.search=body=>(++n===2 ? {status:429, body:{error:"spgmi_limit", message:"This hour's 500 S&P requests are used up. Try again after the hour.", requestId:"req-7"}} : {status:200, body:answer(body)});
  t.delay["snl-filings:search"]=300;
  await p.click("#fc_run"); await p.waitForTimeout(150);
  ok("progress: search 1 of 2", (await t.txt("#fcBusy")).startsWith("Finding the filings: search 1 of 2…"), await t.txt("#fcBusy"));
  await p.waitForTimeout(400);
  ok("progress: search 2 of 2", (await t.txt("#fcBusy")).startsWith("Finding the filings: search 2 of 2…"));
  await p.waitForTimeout(500); t.delay={};
  const sb=t.of("snl-filings","search").map(c=>c.body);
  ok("two searches: the big group with Tarrow, then Calloway", sb.length===2 && sb[0].institutionIds.length===99 && sb[0].institutionIds[98]===5100001 && same(sb[1].institutionIds,[5000001,5000002,5000003]) && deq({...sb[1], institutionIds:[]},{...SEARCH, institutionIds:[]}), sb.map(x=>x.institutionIds.length));
  ok("a failed search: says which carrier, with S&P's reference and Try again; the others are shown", (await t.txt("#fcSearchErr"))===`Couldn't search for ${CAL}. This hour's 500 S&P requests are used up. Try again after the hour. S&P reference: req-7.Try again` && (await t.txt("#fcCar1 [data-err]")).startsWith("Its search didn't run:") && (await p.$$("#fcFiled2 tbody tr")).length===3, await t.txt("#fcSearchErr"));
  await p.click('[data-act="fc-retry"]'); await p.waitForTimeout(500);
  ok("Try again sends only the failed search, then asks for the new filings' summaries", same(t.of("snl-filings","search").slice(2).map(c=>c.body),[sb[1]]) && !(await p.$("#fcSearchErr")) && (await p.$$("#fcFiled1 tbody tr")).length===5 && t.of("snl-digest","get").length===2);
  ok("packing: as few searches as the limits allow", await p.evaluate(()=>{ const ids=(n,s)=>Array.from({length:n},(_,i)=>({kind:"institutionId", id:String(s+i)})), pk=(n,s)=>({ids:ids(n,s)});
    return [fcPlan([pk(3,1),pk(1,100)],3).length, fcPlan([pk(60,1),pk(50,100)],3).map(s=>s.cost), fcPlan([pk(70,1),pk(30,100),pk(5,200)],5).map(s=>s.carriers)]; }).then(v=>same(v,[1,[18,15],[[0,1],[2]]]) || console.log(v)));
  await ctx_close(t);

  // ----- an incomplete search, four carriers at most -----
  t=await open({}, {search:body=>({status:200, body:{...answer(body), capped:true, saved:false}})}); p=t.p;
  await t.pickCalloway(); await t.pickTarrow(); await t.pickNonesuch();
  await t.find("Nonesuch Group"); await p.click('#fc_matches [data-act="fc-group"]'); await p.waitForTimeout(150);
  await t.find("Calloway");
  ok("four carriers: every Choose button is off", (await p.$$("#fc_chips .cchip")).length===4 && await p.$$eval('#fc_matches button',bs=>bs.every(x=>x.disabled)));
  await p.evaluate(()=>fcAddPick({kind:"company", name:"Extra", group:"", ids:[{kind:"institutionId", id:"1"}], noId:0, cut:false}));
  ok("a fifth is refused", (await t.txt("#fc_pickErr"))==="You can compare at most 4 carriers. Remove one to add another." && (await p.$$("#fc_chips .cchip")).length===4);
  await p.click('#fc_chips [data-act="fc-remove"] >> nth=3'); await p.waitForTimeout(100);
  await t.choose(); await t.run();
  ok("an incomplete search: says so for its carriers", (await t.txt("[data-capped]"))===`The filings for ${CAL}, ${TAR}, ${NON} are incomplete. The search stopped at its limit before S&P had returned everything. Choose a shorter period and run it again.`, await t.txt("[data-capped]"));
  await ctx_close(t);

  // ----- saved carrier sets (Contract A), with a stand-in for the sets block -----
  t=await open({seed:[["snl_settings","carrier_sets",{doc:{sets:[{id:"s-1", name:"Florida peers", note:"", companies:[{companyName:"Calloway Home Co", companyId:null, institutionId:"5000002"}], groups:[], updatedAt:"2026-11-13T10:00:00Z"}]}}]]}); p=t.p; await p.waitForTimeout(300);
  ok("sets: the control for this view is shown", !!(await p.$('#setpick_forms [data-act="set-use"][data-target="forms"]')));
  ok("sets: this view is a target", await p.evaluate(()=>typeof SET_TARGETS.forms==="function"));
  await p.evaluate(()=>SET_TARGETS.forms([{kind:"institutionId", id:"5000002", name:"Calloway Home Co"},{kind:"institutionId", id:"5100001", name:"Tarrow Mutual Insurance Co"},{kind:"institutionId", id:"5100001", name:"Tarrow Mutual Insurance Co"},{kind:"bogus", id:"x"}],{id:"s-1", name:"Florida peers"})); await p.waitForTimeout(100);
  ok("sets: a small set gives one carrier a company", same(await t.list("#fc_chips .cchip b"),["Calloway Home Co","Tarrow Mutual Insurance Co"]));
  await p.evaluate(()=>SET_TARGETS.forms(Array.from({length:6},(_,i)=>({kind:"institutionId", id:String(7000001+i), name:`Nonesuch Member ${i+1} Co`})),{id:"s-2", name:"Six <b>peers</b>"})); await p.waitForTimeout(100);
  ok("sets: a bigger set is one carrier named after it", same(await t.list("#fc_chips .cchip > span"),["Calloway Home Co S&P institution id 5000002","Tarrow Mutual Insurance Co S&P institution id 5100001","Six <b>peers</b> saved set of 6 companies"]) && !(await p.$("#fc_chips b b")));
  await t.choose(); await t.run();
  ok("sets: the search takes every company of the set", same(t.of("snl-filings","search")[0].body.institutionIds,[5000002,5100001,7000001,7000002,7000003,7000004,7000005,7000006]));
  ok("sets: no page errors", errs.length===0, errs);
  await ctx_close(t);

  // ----- the session ends mid-way -----
  t=await open({}, {search:()=>({status:401, body:{error:"signin", message:"Your session has ended. Sign in again."}})}); p=t.p;
  await t.ready();
  ok("session ended during the search: back to sign-in, nothing kept", await p.isVisible("#loginForm") && (await t.txt(".login .err"))==="Your session has ended. Sign in again." && await p.evaluate(()=>S.fc.ran===null && S.fc.picks.length===0));
  await ctx_close(t);
  t=await open(); p=t.p; await t.ready(); await t.setN(3);
  t.makes=[{status:401, body:{error:"signin", message:"Your session has ended. Sign in again."}}];
  await p.click("#fc_make"); await p.waitForTimeout(500);
  ok("session ended while summarising: back to sign-in, nothing more is sent", await p.isVisible("#loginForm") && t.of("snl-digest","make").length===1 && await p.evaluate(()=>S.fc.mk===null && Object.keys(S.fc.digests).length===0));
  await ctx_close(t);
  t=await open(); p=t.p; await t.ready(); await t.setN(3); t.delay["snl-digest:make"]=400;
  await p.click("#fc_make"); await p.waitForTimeout(100);
  await p.evaluate(()=>__mock.fire("SIGNED_OUT")); await p.waitForTimeout(700);
  ok("signed out elsewhere while summarising: the late answer is dropped", await p.isVisible("#loginForm") && t.of("snl-digest","make").length===1 && await p.evaluate(()=>S.fc.mk===null) && errs.length===0, errs);
  await ctx_close(t);

  // ----- a problem checking the summaries, and trying again -----
  let g=0;
  t=await open({}, {get:body=>(++g===1 ? {status:500, body:{error:"server", message:"Made-up trouble."}} : {status:200, body:{digests:[copy(DIG.saved["9100001"])], missing:[]}})}); p=t.p;
  await t.ready();
  ok("a problem asking for summaries: says so, with Try again", (await t.txt("#fcGetErr"))==="Couldn't check for saved summaries. Made-up trouble.Try again");
  await p.click('[data-act="fc-get-retry"]'); await p.waitForTimeout(400);
  ok("Try again asks again and the summary shows", !(await p.$("#fcGetErr")) && (await t.txt('#fcFiled0 tr[data-dk="d:9100001"] .c-sum')).startsWith("Introduces a private client"));
  await ctx_close(t);

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
  async function ctx_close(x){ await x.ctx.close(); }
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
