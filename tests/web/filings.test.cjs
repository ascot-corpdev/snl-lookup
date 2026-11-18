// The Filings view: the search form and its checks, finding companies and adding them by S&P id, what the page sends,
// how results, notes and missing values show, saved results and Refresh, opening documents, and the exports.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("web_search.json"), RESOLVE=FIX("web_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
// A stand-in for SheetJS: same calls, and the "file" it writes is JSON, so a test can read what was exported.
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const NO_MATCH=q=>`No saved company matches "${q}". S&P's filings API has no company search, so the app only knows companies loaded from a company list or seen in earlier results. Search by the company's S&P company id or institution id instead; the app remembers the name after that.`;
const NOT_SET_UP="S&P API access isn't set up yet. It needs API credentials from S&P. When they arrive, the owner sets SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase (README, step 5). Saved results still open.";
const GA_NOTE=SEARCH.notes[0], FL_NOTE=GA_NOTE.replace("for GA","for FL");
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    // What the made-up functions answer. A test changes these between steps.
    const t={p, ctx, calls:[], used:{hour:12,day:40}, statusDelay:0, delay:0, refs:copy(REFS), refsStatus:200, xlsx:"ok", xlsxLoads:0, abortSearch:false,
      resolve:q=>/calloway/i.test(q) ? {...copy(RESOLVE), query:q} : {query:q, matches:[], note:NO_MATCH(q)},
      search:()=>({status:200, body:copy(SEARCH)}),
      doc:body=>({status:200, type:"application/pdf", raw:"%PDF-1.4 made-up "+(body.documentId||body.filingVersionId)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"], apikey:req.headers()["apikey"]});
        const cors={"access-control-allow-origin":"*","access-control-expose-headers":"Content-Disposition"};
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:cors,body:JSON.stringify(o)}).catch(()=>{});
        if(body.action==="status"){ if(t.statusDelay) await new Promise(res=>setTimeout(res,t.statusDelay)); return J(200,{...copy(STATUS), role:opts.role||"corpdev", filings:{...STATUS.filings, used:t.used}}); }
        if(body.action==="reference") return t.refsStatus===200 ? J(200,t.refs) : J(t.refsStatus,{error:"server",message:"The filings function failed: made-up fault"});
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        if(body.action==="search"){ if(t.abortSearch) return r.abort(); if(t.delay) await new Promise(res=>setTimeout(res,t.delay)); const a=t.search(body); if(a.status===200 && a.body.used) t.used=a.body.used; return a.empty ? r.fulfill({status:a.status,body:""}) : J(a.status,a.body); }
        if(body.action==="document"){ if(t.delay) await new Promise(res=>setTimeout(res,t.delay)); const a=t.doc(body); return a.raw!==undefined ? r.fulfill({status:200,contentType:a.type,headers:{...cors,...(a.headers||{})},body:a.raw}) : J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)){ t.xlsxLoads++; return t.xlsx==="ok" ? r.fulfill({contentType:"application/javascript",body:FAKE_XLSX}) : r.fulfill({status:404,body:""}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o;
      // new tabs are recorded instead of opened, so a test can see where each was pointed
      window.__opened=[]; window.__blockPopups=false;
      window.open=url=>{ if(window.__blockPopups) return null; const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; },opts);
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.body.action===a);
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    // adds a company by its S&P id, chooses states and searches
    t.quick=async(states=["FL"], id="4000001")=>{ await p.fill("#f_q",id); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click('#byId button >> nth=0'); for(const s of states) await p.click(`#states [data-s="${s}"]`); await p.click('button[data-act="search"]'); await p.waitForTimeout(450); };
    return t;
  }

  let t=await open(); let p=t.p;
  // ----- the form as it opens -----
  ok("form and a hint, no results yet", await p.isVisible("#searchForm") && (await t.txt("#noSearch")).startsWith("Choose companies, states and dates, then search."));
  ok("reference lists asked once, without refresh", same(t.of("reference").map(c=>c.body),[{action:"reference"}]));
  ok("S&P's lists fill the three filters", (await p.$$("#chk_toi input")).length===14 && (await p.$$("#chk_ftype input")).length===4 && (await p.$$("#chk_fstatus input")).length===4);
  ok("states come from S&P's list, each with its name", same(await t.all("#states button .stc"),["CA","FL","GA","NY","SC","TX"]) && (await t.txt('#states [data-s="FL"]'))==="Florida FL");
  ok("dates default to the last 12 months, one S&P request wide", (await p.inputValue("#f_from"))==="2025-11-14" && (await p.inputValue("#f_to"))==="2026-11-13");

  // ----- checks before anything is sent -----
  await p.click('button[data-act="search"]'); await p.waitForTimeout(100);
  ok("no company: refused with the reason", (await t.txt("#formErr"))==="Choose at least one company. S&P needs a company for every search." && t.of("search").length===0);

  // ----- finding companies -----
  await p.click('button[data-act="co-find"]'); await p.waitForTimeout(100);
  ok("empty company box: says what to type", (await t.txt("#searchForm .err"))==="Type a company name, a NAIC code or an S&P id." && t.of("resolve").length===0);
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  ok("Enter looks the company up, and doesn't run the search", same(t.of("resolve").map(c=>c.body),[{action:"resolve",q:"Calloway"}]) && t.of("search").length===0 && t.of("resolve")[0].auth==="Bearer t" && t.of("resolve")[0].apikey==="sb_publishable_k");
  ok("matches listed with NAIC code, S&P id and group", (await p.$$("#matches li")).length===3 && (await t.txt("#matches li >> nth=0 >> .t1"))==="Calloway Insurance Co" && (await t.txt("#matches li >> nth=0 >> .t2"))==="NAIC 90001 · S&P company id 4000001 · group Calloway Group", await t.txt("#matches li >> nth=0"));
  ok("a hostile company name shows as text", (await t.txt("#matches li >> nth=2")).includes("Calloway <script>window.__xss=1</script> Co") && !(await p.$("#matches script")) && await p.evaluate(()=>window.__xss===undefined));
  await p.screenshot({path:OUTDIR+"/filings-matches-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("phone: no sideways scroll with matches listed", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.setViewportSize({width:1440,height:900});
  await p.click('#matches li >> nth=0 >> button[data-kind="companyId"]'); await p.waitForTimeout(100);
  ok("Add makes a chip and clears the box", same(await t.all("#chips .cchip b"),["Calloway Insurance Co"]) && (await t.txt("#chips")).includes("company id 4000001") && (await p.inputValue("#f_q"))==="" && !(await p.$("#matches")));
  await p.click('button[data-act="search"]'); await p.waitForTimeout(100);
  ok("no state: refused with the reason", (await t.txt("#formErr"))==="Choose at least one state." && t.of("search").length===0);

  await p.fill("#f_q","Zennor Mutual"); await p.click('button[data-act="co-find"]'); await p.waitForTimeout(250);
  ok("no match: the function's note, and how to add by id", (await t.txt("#resolveNote"))===NO_MATCH("Zennor Mutual")+" Type the id (a whole number) in the box above to add it." && !(await p.$("#matches")), await t.txt("#resolveNote"));
  await p.fill("#f_q","4000107"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  ok("a whole number can be added as a company id or an institution id", (await t.txt("#resolveNote"))===NO_MATCH("4000107") && same(await t.all("#byId button"),["Add as company id","Add as institution id"]));
  await p.click('#byId button >> nth=0'); await p.waitForTimeout(100);
  await p.fill("#f_q","5000001"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  await p.click('#byId button >> nth=1'); await p.waitForTimeout(100);
  ok("chips for ids added directly say which kind of id", same(await t.all("#chips .cchip b"),["Calloway Insurance Co","Company 4000107","Institution 5000001"]) && same(await p.evaluate(()=>S.f.chips.map(c=>c.kind+":"+c.id)),["companyId:4000001","companyId:4000107","institutionId:5000001"]));
  await p.fill("#f_q","4000107"); await p.press("#f_q","Enter"); await p.waitForTimeout(250); await p.click('#byId button >> nth=0'); await p.waitForTimeout(100);
  ok("the same company can't be added twice", (await p.$$("#chips .cchip")).length===3 && (await t.txt("#toastRoot"))==="That company is already chosen.");
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  ok("a match with an institution id offers that too", (await t.txt('#matches li >> nth=0 >> button[data-kind="institutionId"]'))==="Add by institution id 5000001" && !(await p.$('#matches li >> nth=1 >> button[data-kind="institutionId"]')));
  await p.click('#matches li >> nth=1 >> button[data-kind="companyId"]'); await p.waitForTimeout(100);
  await p.click('#chips .cchip >> nth=3 >> button'); await p.waitForTimeout(100);
  ok("a chip can be removed", (await p.$$("#chips .cchip")).length===3);

  // ----- a whole group at once, and a company known only by its institution id -----
  const keepResolve=t.resolve;
  t.resolve=q=>({query:q, note:null, matches:[...copy(RESOLVE).matches.slice(0,2), {companyId:null, companyName:"Calloway Coastal Co", naicCompanyCode:"90003", institutionId:"5000003", spStatEntityId:null, naicGroupCode:"9001", naicGroupName:"Calloway Group"}]});
  await p.fill("#f_q","Calloway Group"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  ok("a company with no company id shows its institution id, and Add uses it", (await t.txt("#matches li >> nth=2 >> .t2"))==="NAIC 90003 · S&P institution id 5000003 · group Calloway Group"
    && same(await p.$$eval("#matches li:nth-child(3) button",b=>b.map(x=>[x.textContent,x.dataset.kind,x.dataset.id])),[["Add","institutionId","5000003"]]), await t.txt("#matches li >> nth=2"));
  ok("several matches offer to add the whole group", (await t.txt("#addAll"))==="Add all 3 to search a whole group at once.");
  await p.click('button[data-act="co-add-all"]'); await p.waitForTimeout(150);
  ok("Add all adds every match not already chosen, each by the id it has", same(await p.evaluate(()=>S.f.chips.map(c=>c.kind+":"+c.id)),["companyId:4000001","companyId:4000107","institutionId:5000001","companyId:4000002","institutionId:5000003"])
    && (await t.txt("#toastRoot"))==="Added 2 companies." && !(await p.$("#matches")) && (await p.inputValue("#f_q"))==="", await p.evaluate(()=>S.f.chips));
  ok("the added companies carry their names", same((await t.all("#chips .cchip b")).slice(3),["Calloway Home Co","Calloway Coastal Co"]));
  await p.fill("#f_q","Calloway Group"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  await p.click('button[data-act="co-add-all"]'); await p.waitForTimeout(150);
  ok("Add all a second time adds nothing and says so", (await p.$$("#chips .cchip")).length===5 && (await t.txt("#toastRoot"))==="Those companies are already chosen.");
  await p.setViewportSize({width:390,height:844}); await p.fill("#f_q","Calloway Group"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  ok("phone: no sideways scroll with Add all showing", !!(await p.$("#addAll")) && await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.setViewportSize({width:1440,height:900}); await p.fill("#f_q","");
  await p.click('#chips .cchip >> nth=4 >> button'); await p.waitForTimeout(80); await p.click('#chips .cchip >> nth=3 >> button'); await p.waitForTimeout(80);
  t.resolve=keepResolve;
  ok("back to three chosen companies", (await p.$$("#chips .cchip")).length===3);

  // ----- states, dates, filters -----
  await p.click('button[data-act="state-all"]'); await p.waitForTimeout(80);
  ok("Choose all picks every state", (await p.$$('#states [aria-pressed="true"]')).length===6);
  await p.click('button[data-act="state-none"]'); await p.waitForTimeout(80);
  await p.click('#states [data-s="GA"]'); await p.click('#states [data-s="FL"]'); await p.waitForTimeout(80);
  ok("states toggle, and the count says so", same(await t.all('#states [aria-pressed="true"] .stc'),["FL","GA"]) && (await t.txt("#searchForm")).includes("States 2 chosen"));
  ok("estimate: one year, a batch of companies and a batch of institutions", (await t.txt("#f_est"))==="About 2 S&P requests, more if there are many results. A search someone has already run costs none.", await t.txt("#f_est"));
  await p.click('button[data-act="range"][data-y="5"]'); await p.waitForTimeout(80);
  ok("quick range: last 5 years", (await p.inputValue("#f_from"))==="2021-11-13" && (await p.inputValue("#f_to"))==="2026-11-13" && (await t.txt("#f_est")).startsWith("About 12 S&P requests"), await t.txt("#f_est"));
  await p.click('button[data-act="range"][data-y="1"]'); await p.waitForTimeout(80);
  ok("quick range: last 12 months", (await p.inputValue("#f_from"))==="2025-11-14");
  await p.fill("#f_from","2026-12-01"); await p.click('button[data-act="search"]'); await p.waitForTimeout(100);
  ok("start after end: refused", (await t.txt("#formErr"))==="The start date is after the end date.");
  await p.fill("#f_from","2010-01-01"); await p.click('button[data-act="search"]'); await p.waitForTimeout(100);
  ok("more than 10 years: refused", (await t.txt("#formErr"))==="Search at most 10 years at a time.");
  await p.fill("#f_from",""); await p.click('button[data-act="search"]'); await p.waitForTimeout(100);
  ok("a missing date: refused", (await t.txt("#formErr"))==="Choose a start date and an end date.");
  await p.focus("#f_from"); await p.fill("#f_from","2021-01-01"); await p.waitForTimeout(80);
  ok("typing a date updates the estimate without losing the cursor", (await t.txt("#f_est")).startsWith("About 12 S&P requests") && await p.evaluate(()=>document.activeElement.id==="f_from"), await t.txt("#f_est"));
  await p.fill("#f_toiFilter","auto"); await p.waitForTimeout(100);
  ok("a long list can be filtered as you type, keeping the cursor", same(await t.all("#chk_toi label"),["Private passenger auto","Commercial auto"]) && await p.evaluate(()=>document.activeElement.id==="f_toiFilter"));
  await p.fill("#f_toiFilter","home"); await p.waitForTimeout(100); await p.check("#chk_toi input"); await p.fill("#f_toiFilter",""); await p.waitForTimeout(100);
  ok("a tick survives the filter", await p.isChecked('#chk_toi input[data-id="101"]') && (await p.$$("#chk_toi input")).length===14);
  await p.check('#chk_ftype input[data-id="11"]'); await p.check('#chk_ftype input[data-id="12"]'); await p.check('#chk_ftype input[data-id="13"]'); await p.uncheck('#chk_ftype input[data-id="13"]');
  await p.fill("#f_tracking","bad*number"); await p.click('button[data-act="search"]'); await p.waitForTimeout(100);
  ok("an odd tracking number: refused", (await t.txt("#formErr")).startsWith("Tracking numbers can use letters, numbers") && t.of("search").length===0);
  await p.fill("#f_tracking","CALL-134000001, TARR-134000777");

  // ----- the search -----
  const withInst=()=>{ const d=copy(SEARCH); d.byCompany.push({kind:"institutionId",id:5000001,name:"Calloway Group",rows:4}); return {status:200, body:d}; };
  t.search=withInst; t.delay=400; t.statusDelay=700;
  const statusBefore=t.of("status").length;
  await p.click('button[data-act="search"]'); await p.waitForTimeout(150);
  ok("while searching: says so, and the button waits", (await t.txt("#searching")).startsWith("Searching S&P's filings") && await p.isDisabled('button[data-act="search"]') && (await t.txt('button[data-act="search"]'))==="Searching…");
  await p.waitForTimeout(500);
  const sent=t.of("search")[0];
  ok("what the page sends: ids as numbers, states sorted, only the ticked filters", same(sent.body,{action:"search",companyIds:[4000001,4000107],institutionIds:[5000001],states:["FL","GA"],from:"2021-01-01",to:"2026-11-13",typeOfInsuranceIds:[101],filingTypeIds:[11,12],trackingNumbers:["CALL-134000001","TARR-134000777"]}), sent.body);
  ok("sent with the login's token and the publishable key", sent.auth==="Bearer t" && sent.apikey==="sb_publishable_k");
  ok("strip takes the request counts from the search answer", (await t.txt("#s_usage"))==="S&P requests: 24 of 500 this hour, 52 of 12,000 today (trial account)", await t.txt("#s_usage"));
  await p.waitForTimeout(700); t.statusDelay=0;
  ok("status asked again after the search", t.of("status").length===statusBefore+1 && (await t.txt("#s_usage")).startsWith("S&P requests: 24 of 500"));
  ok("summary: how many, the dates and the states", (await t.txt("#resSummary"))==="6 filings published from 1 Jan 2021 to 13 Nov in FL, GA.", await t.txt("#resSummary"));
  ok("every note shows, above the table", (await t.txt("#notes"))==="Read this before you rely on the results"+GA_NOTE && await p.evaluate(()=>!!(document.getElementById("notes").compareDocumentPosition(document.getElementById("resTable")) & Node.DOCUMENT_POSITION_FOLLOWING)), await t.txt("#notes"));
  ok("counts by state and by company", same(await t.all("#byState span"),["FL 6","GA 0"]) && same(await t.all("#byCompany span"),["Calloway Insurance Co 3","Calloway Home Co 3","Tarrow Mutual Insurance Co 2","Calloway Group 4"]), await t.all("#byCompany span"));
  ok("chips added by id take their names from the results", same(await t.all("#chips .cchip b"),["Calloway Insurance Co","Tarrow Mutual Insurance Co","Calloway Group"]));
  const rows=async()=>p.$$eval("#resTable tbody tr",trs=>trs.map(tr=>[...tr.children].map(td=>td.innerText.replace(/\s+/g," ").trim())));
  let R=await rows();
  ok("six rows, newest first, the one with no date last", R.length===6 && same(R.map(r=>r[8]),["CALL-134000001","CALL-134000002","CALL-134000003","TARR-134000777","CALL-134000006","n/d"]), R.map(r=>r[8]));
  ok("every company on a filing is listed", R[0][0]==="Calloway Insurance Co NAIC 90001 Calloway Home Co NAIC 90002", R[0][0]);
  ok("columns: state, filing type, type and sub-type, status", same(R[0].slice(1,5),["FL","Form","Homeowners HO-3 middle market","Approved"]), R[0].slice(1,5));
  ok("dates as 5 Nov, with the year when it isn't this year, n/d when missing", R[0][5]==="Submitted 4 Mar Published 9 Mar Effective, new 1 Jan Effective, renewal 1 Feb" && R[1][5]==="Submitted 20 Aug 2025 Published 2 Sept 2025 Effective, new 1 Oct 2025 Effective, renewal n/d", [R[0][5],R[1][5]]);
  ok("rate impact: S&P's wording, else the number, else n/d", same([R[2][6],R[3][6],R[0][6],R[4][6]],["+6.5%","(2.4%)","n/d","0.0%"]), R.map(r=>r[6]));
  ok("a row with nothing in it reads n/d throughout, and unreadable dates are n/d", same(R[5].slice(3,6),["n/d","n/d","Submitted n/d Published n/d Effective, new n/d Effective, renewal n/d"]) && R[5][8]==="n/d" && R[5][9]==="No document", R[5]);
  ok("hostile text from S&P shows as text and runs nothing", R[5][0]==="Tarrow <script>window.__xss=1</script> Exchange" && R[5][7].includes('<img src=x onerror="window.__xss=1">') && !(await p.$("#resTable script,#resTable img")) && await p.evaluate(()=>window.__xss===undefined), R[5]);
  ok("a long description is cut, with a way to read the rest", R[0][7].endsWith("… more") && R[0][7].length<190 && R[1][7]==="Private client homeowners form CAL-HO5-PC (03 25).", R[0][7]);
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="desc-toggle"]'); await p.waitForTimeout(80);
  ok("more shows the whole description; less puts it back", (await rows())[0][7]===SEARCH.rows[0].filingDescription+" less");
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="desc-toggle"]'); await p.waitForTimeout(80);
  ok("less cuts it again", (await rows())[0][7].endsWith("… more"));
  ok("many companies: the first three, then the rest on request", R[4][0]==="Calloway Insurance Co NAIC 90001 Calloway Home Co NAIC 90002 Calloway Coastal Co NAIC 90003 and 2 more", R[4][0]);
  await p.click('#resTable tbody tr >> nth=4 >> button[data-act="co-toggle"]'); await p.waitForTimeout(80);
  ok("the rest of the companies open up", (await rows())[4][0].endsWith("Calloway Specialty Co NAIC 90004 Calloway Lloyds NAIC 90005 Show fewer"));
  ok("document column: a button, the page count and the Summary control", R[0][9]==="Open document 42 pages Summary" && R[2][9]==="Open document 1 page Summary", [R[0][9],R[2][9]]);
  ok("count and source line", (await t.txt("#resCount"))==="Showing 6 of 6" && (await t.txt("#results .source")).startsWith("Source: S&P Global Market Intelligence, SNL Insurance Product Filings, fetched 13 Nov."));
  ok("no dashes or shouting in the view", !(await p.evaluate(()=>document.body.innerText)).includes("—"));
  await p.screenshot({path:OUTDIR+"/filings-results-1440.png",fullPage:true});

  // ----- filter and sort -----
  await p.fill("#f_filter","private client"); await p.waitForTimeout(120);
  ok("filter narrows the rows as you type, keeping the cursor", (await rows()).length===1 && (await t.txt("#resCount"))==="1 of 6 match; showing 1" && await p.evaluate(()=>document.activeElement.id==="f_filter"));
  const csvF=await t.download(()=>p.click('button[data-what="filings"][data-fmt="csv"]'));
  ok("CSV holds the rows on screen", csvF.text.split("\r\n").length===2 && csvF.text.includes('"CALL-134000002"'));
  await p.fill("#f_filter","zzzz"); await p.waitForTimeout(120);
  ok("nothing matches the filter: says so", (await t.txt("#results .empty"))==="No filings in these results match the filter." && !(await p.$("#resTable")));
  await p.fill("#f_filter",""); await p.waitForTimeout(120);
  await p.click('#resTable .sorth[data-k="company"]'); await p.waitForTimeout(100);
  ok("sort by company", (await rows())[0][0].startsWith("Calloway Home Co") && (await p.getAttribute("#resTable th >> nth=0","aria-sort"))==="ascending");
  await p.click('#resTable .sorth[data-k="rate"]'); await p.waitForTimeout(100);
  ok("sort by rate impact, largest first, blanks last", same((await rows()).map(r=>r[6]),["+6.5%","0.0%","(2.4%)","n/d","n/d","n/d"]), (await rows()).map(r=>r[6]));
  await p.click('#resTable .sorth[data-k="rate"]'); await p.waitForTimeout(100);
  ok("sort the other way, blanks still last", same((await rows()).map(r=>r[6]),["(2.4%)","0.0%","+6.5%","n/d","n/d","n/d"]));
  await p.click('#resTable .sorth[data-k="publishDate"]'); await p.waitForTimeout(100);

  // ----- exports -----
  const csv=await t.download(()=>p.click('button[data-what="filings"][data-fmt="csv"]'));
  const lines=csv.text.split("\r\n");
  ok("CSV: named for the day, with a byte order mark and a header row", csv.name==="snl-filings-2026-11-13.csv" && csv.text.charCodeAt(0)===0xFEFF && lines[0].slice(1).startsWith('"Company","NAIC company code","S&P company id","All companies on the filing"') && lines.length===7, [csv.name, lines[0].slice(0,80), lines.length]);
  ok("CSV: every company, plain dates, the raw rate number", lines[1].includes('"Calloway Insurance Co; Calloway Home Co"') && lines[1].includes('"2026-03-04","2026-03-09","2026-01-01","2026-02-01"') && lines[3].includes('"+6.5%","6.5"') && lines[4].includes('"(2.4%)","-2.4"'), lines[3]);
  ok("CSV: missing values are empty, unreadable dates stay as S&P sent them", lines[6].includes('"not a date","","2022-13-45",""') && lines[6].includes('"n/d",""'), lines[6]);
  ok("CSV: text that a spreadsheet would run as a formula is defused", lines[6].includes('"\'=HYPERLINK(""http://example.invalid"",""x"")'), lines[6]);
  ok("SheetJS not fetched until asked for", t.xlsxLoads===0);
  const x1=await t.download(()=>p.click('button[data-what="filings"][data-fmt="xlsx"]'));
  const wb=JSON.parse(x1.text);
  ok("XLSX: SheetJS loaded on the first click, from the pinned address", t.xlsxLoads===1 && x1.name==="snl-filings-2026-11-13.xlsx" && same(wb.opts,{bookType:"xlsx",type:"array"}));
  ok("XLSX: one sheet with the same header and rows, numbers as numbers", wb.sheets.length===1 && wb.sheets[0].name==="Filings" && wb.sheets[0].aoa.length===7 && wb.sheets[0].aoa[0][0]==="Company" && wb.sheets[0].aoa[1][21]===42 && wb.sheets[0].aoa[3][15]===6.5 && wb.sheets[0].aoa[6][19]==="" && wb.sheets[0].aoa[6][16].startsWith("=HYPERLINK"), wb.sheets[0].aoa[1]);
  await t.download(()=>p.click('button[data-what="filings"][data-fmt="xlsx"]'));
  ok("XLSX: the library is fetched once", t.xlsxLoads===1);

  // ----- opening documents -----
  t.delay=400; const docsBefore=t.of("document").length, stB=t.of("status").length;
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="open-doc"]'); await p.waitForTimeout(150);
  ok("the tab opens on the click, before the document arrives", await p.evaluate(()=>__opened.length===1 && __opened[0].location.href==="" && __opened[0].document.body.textContent==="Opening the document from S&P…" && __opened[0].opener===null));
  ok("busy while it downloads", (await t.txt('#resTable tbody tr >> nth=0 >> button[data-act="open-doc"]'))==="Opening…" && await p.isDisabled('#resTable tbody tr >> nth=0 >> button[data-act="open-doc"]'));
  await p.waitForTimeout(600); t.delay=0;
  const d0=t.of("document")[docsBefore];
  ok("asks the function for the document by id, with the login", same(d0.body,{action:"document",documentId:880001}) && d0.auth==="Bearer t" && d0.apikey==="sb_publishable_k", d0);
  const href=await p.evaluate(()=>__opened[0].location.href);
  ok("the tab is pointed at the document held in memory", href.startsWith("blob:") && (await p.evaluate(async u=>{ const r=await fetch(u); return (await r.blob()).type+"|"+await (await fetch(u)).text(); },href))==="application/pdf|%PDF-1.4 made-up 880001", href);
  ok("status asked again, since a document costs a request", t.of("status").length===stB+1);
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="open-doc"]'); await p.waitForTimeout(250);
  ok("opening it again costs no second S&P request", t.of("document").length===docsBefore+1 && await p.evaluate(()=>__opened.length===2 && __opened[1].location.href===__opened[0].location.href));
  await p.click('#resTable tbody tr >> nth=3 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("a filing with no document id is asked for by its filing version", same(t.of("document").pop().body,{action:"document",filingVersionId:"fv-00000004"}));
  t.doc=()=>({status:502, body:{error:"spgmi_unavailable",message:"S&P's service isn't answering. Try again in a few minutes.",requestId:"req-made-up-1"}});
  await p.click('#resTable tbody tr >> nth=1 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("a failed download: the message, S&P's reference, the tab closed", (await t.txt("#resTable tbody tr >> nth=1 >> .doc-err"))==="S&P's service isn't answering. Try again in a few minutes. S&P reference: req-made-up-1." && await p.evaluate(()=>__opened[__opened.length-1].closed) && await p.isEnabled('#resTable tbody tr >> nth=1 >> button[data-act="open-doc"]'));
  t.doc=()=>({status:404, body:{error:"spgmi_not_found",message:"S&P has no document with that id."}});
  await p.click('#resTable tbody tr >> nth=1 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("S&P says there is no such document: that message, not a set-up hint", (await t.txt("#resTable tbody tr >> nth=1 >> .doc-err"))==="S&P has no document with that id.");
  t.doc=b=>({status:200, type:"application/pdf", raw:"%PDF-1.4 made-up "+b.documentId});
  await p.click('#resTable tbody tr >> nth=1 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("trying again works and clears the error", !(await p.$("#resTable .doc-err")) && await p.evaluate(()=>__opened[__opened.length-1].location.href.startsWith("blob:")));
  // not a PDF: offered as a download, with S&P's file name
  t.doc=()=>({status:200, type:"application/zip", headers:{"content-disposition":'attachment; filename="CALL-134000003 forms.zip"'}, raw:"PK made-up zip"});
  const nDocs=t.of("document").length;
  const z=await t.download(()=>p.click('#resTable tbody tr >> nth=2 >> button[data-act="open-doc"]')); await p.waitForTimeout(150);
  ok("not a PDF: saved as a download under S&P's file name, and the tab closed", z.name==="CALL-134000003 forms.zip" && z.text==="PK made-up zip" && await p.evaluate(()=>__opened[__opened.length-1].closed) && (await t.txt("#toastRoot"))==="This document isn't a PDF, so it was saved to your downloads as CALL-134000003 forms.zip.");
  const z2=await t.download(()=>p.click('#resTable tbody tr >> nth=2 >> button[data-act="open-doc"]'));
  ok("downloading it again costs no second S&P request", z2.name==="CALL-134000003 forms.zip" && t.of("document").length===nDocs+1);
  t.doc=()=>({status:200, type:"application/zip", raw:"PK made-up zip 2"});
  const z3=await t.download(()=>p.click('#resTable tbody tr >> nth=4 >> button[data-act="open-doc"]'));
  ok("no file name from S&P: a plain one", z3.name==="snl-document-880006.zip", z3.name);
  await t.ctx.close();

  // pop-ups blocked
  t=await open(); p=t.p; await t.quick();
  await p.evaluate(()=>{ window.__blockPopups=true; });
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("pop-ups blocked: says how to fix it, and keeps the document", (await t.txt("#toastRoot"))==="Your browser blocked the new tab. Allow pop-ups for this site, then click again." && t.of("document").length===1);
  await p.evaluate(()=>{ window.__blockPopups=false; });
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="open-doc"]'); await p.waitForTimeout(200);
  ok("clicking again opens it without asking S&P again", t.of("document").length===1 && await p.evaluate(()=>__opened.length===1 && __opened[0].location.href.startsWith("blob:")));
  t.doc=()=>({status:503, body:{error:"not_configured",message:NOT_SET_UP}});
  await p.click('#resTable tbody tr >> nth=1 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("documents not set up: the function's message beside the row", (await t.txt("#resTable .doc-err"))===NOT_SET_UP);

  // ----- saved results and Refresh -----
  t.search=body=>({status:200, body:{...copy(SEARCH), fromStore:!body.refresh, fetchedAt:body.refresh?"2026-11-13T12:00:00Z":"2026-11-12T09:00:00Z"}});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("saved results say when they were fetched and offer Refresh", (await t.txt("#fromStore"))==="From the last fetch on 12 Nov.Refresh");
  await p.fill("#f_tracking","EDITED-AFTER-SEARCH");
  t.delay=400; await p.click('button[data-act="search-refresh"]'); await p.waitForTimeout(150);
  ok("while refreshing: says the rows are the old ones", (await t.txt("#refreshing")).startsWith("Asking S&P again… The results below are from 12 Nov") && (await p.$$("#resTable tbody tr")).length===6);
  await p.waitForTimeout(600); t.delay=0;
  const two=t.of("search").slice(-2).map(c=>c.body);
  ok("Refresh sends the same search again with refresh, not the edited form", same(two[1],{...two[0],refresh:true}) && !two[1].trackingNumbers, two);
  ok("fresh results drop the saved note", !(await p.$("#fromStore")) && (await p.$$("#resTable tbody tr")).length===6);
  t.search=body=>body.refresh ? {status:429, body:{error:"spgmi_limit",message:"This hour's S&P requests are used up. Try again after the top of the hour."}} : {status:200, body:{...copy(SEARCH), fromStore:true, fetchedAt:"2026-11-12T09:00:00Z"}};
  await p.fill("#f_tracking",""); await p.click('button[data-act="search"]'); await p.waitForTimeout(400); await p.click('button[data-act="search-refresh"]'); await p.waitForTimeout(400);
  ok("a failed refresh keeps the saved rows and says why", (await t.txt("#results .banner"))==="Couldn't refresh the search. This hour's S&P requests are used up. Try again after the top of the hour.Try again" && (await p.$$("#resTable tbody tr")).length===6);

  // ----- cut short -----
  t.search=()=>({status:200, body:{...copy(SEARCH), capped:true, saved:false, notes:["The search stopped after 60 S&P requests to stay inside the time limit, so these results are incomplete. Narrow the dates, states or companies and search again."]}});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("a search that was cut short says so clearly", (await t.txt("#capped")).startsWith("These results are incomplete.") && (await p.getAttribute("#capped","role"))==="alert" && (await t.txt("#notes")).includes("stopped after 60 S&P requests"));
  t.search=()=>({status:200, body:{...copy(SEARCH), saved:false}});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("results that couldn't be saved say so", (await t.txt("#notSaved"))==="These results couldn't be saved, so the next search will ask S&P again.");

  // ----- nothing came back -----
  const none=notes=>()=>({status:200, body:{...copy(SEARCH), rows:[], total:0, byState:[{state:"FL",rows:0},{state:"GA",rows:0}], byCompany:[{kind:"companyId",id:4000001,name:null,rows:0}], notes}});
  t.search=none([FL_NOTE, GA_NOTE]);
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  const emptyText=await t.txt("#results");
  ok("no rows: the notes take the place of the table", (await t.txt("#notes"))==="Nothing came back, and that isn't proof that nothing was filed"+FL_NOTE+GA_NOTE && !(await p.$("#resTable")) && !(await p.$('button[data-what="filings"]')) && (await t.txt("#resSummary"))==="S&P returned nothing for filings published from 1 Jan 2021 to 13 Nov in FL, GA.", await t.txt("#resSummary"));
  ok("no rows: the headline never counts zero filings", !/\b0 filings\b/.test(emptyText), emptyText);
  ok("no rows: never reads as 'no filings exist'", !/no results|no filings (exist|found|were filed)|nothing (was )?found/i.test(emptyText) && same(await t.all("#byCompany span"),["Company id 4000001 0"]), emptyText);
  await p.screenshot({path:OUTDIR+"/filings-empty-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on the empty result", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/filings-empty-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  t.search=none([]);
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("no rows and no notes: the page still says what an empty result means", (await t.txt("#notes li"))==="S&P returned no filings for this search. That means none are in S&P's data for these companies, states, dates and filters. It doesn't prove that none were filed.");

  // ----- problems -----
  t.search=()=>({status:503, body:{error:"not_configured",message:NOT_SET_UP}});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("S&P not set up: the message as a calm state, not an error", (await t.txt("#results .info"))===NOT_SET_UP && !(await p.$("#results [role=alert]")) && !(await p.$("#resTable")));
  t.search=()=>({status:429, body:{error:"spgmi_rate_limited",message:"S&P is asking the app to slow down. Wait a minute and try again.",requestId:"req-made-up-2"}});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("a limit: the function's message, S&P's reference and Try again", (await t.txt("#results .banner[role=alert]"))==="Couldn't run the search. S&P is asking the app to slow down. Wait a minute and try again. S&P reference: req-made-up-2.Try again");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on an error", await t.noScroll());
  await p.setViewportSize({width:1440,height:900});
  t.search=()=>({status:200, body:copy(SEARCH)}); const nS=t.of("search").length;
  await p.click('button[data-act="search-retry"]'); await p.waitForTimeout(450);
  ok("Try again runs the search again", t.of("search").length===nS+1 && (await p.$$("#resTable tbody tr")).length===6);
  t.search=()=>({status:400, body:{error:"bad",message:"Search at most 10 years at a time."}});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("the function's own check shows as it is", (await t.txt("#results .banner")).startsWith("Couldn't run the search. Search at most 10 years at a time."));
  t.search=()=>({status:404, empty:true});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("function not deployed: Corp Dev gets the command", (await t.txt("#results .banner")).includes("The filings function isn't deployed yet. Run: supabase functions deploy snl-filings --no-verify-jwt (see the README)."));
  t.abortSearch=true;
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("no connection: says so plainly", (await t.txt("#results .banner")).startsWith("Couldn't run the search. Couldn't reach the filings function. Check your connection and try again."));
  t.abortSearch=false;
  await p.press("#f_tracking","Enter"); await p.waitForTimeout(450);
  ok("Enter in the form runs the search", (await t.txt("#results .banner")).includes("isn't deployed yet"));
  await t.ctx.close();

  t=await open({role:"reader"}); p=t.p; t.search=()=>({status:404, empty:true}); await t.quick();
  ok("function not deployed: a reader is told to ask Corp Dev", (await t.txt("#results .banner"))==="Couldn't run the search. This part of the site isn't set up yet. Ask Corp Dev.Try again");
  await t.ctx.close();

  // ----- S&P's lists not loaded yet -----
  const noLists={lists:{typeOfInsurance:null,filingStatus:null,serffFilingState:null,serffFilingType:null}, missing:["typeOfInsurance","filingStatus","serffFilingState","serffFilingType"], message:NOT_SET_UP, used:{hour:0,day:0}, limits:{hour:500,day:12000}, account:"trial"};
  t=await open({}, {refs:noLists}); p=t.p;
  ok("no lists: each filter says so and the form still works", same(await t.all(".nolist"),Array(3).fill("S&P's lists aren't loaded yet, so this filter is left out of the search.")) && (await t.txt("#refsMsg"))===NOT_SET_UP && await p.isEnabled('button[data-act="search"]'));
  const built=await t.all("#states button .stc");
  ok("no lists: the built-in states, two letters each, with DC", built.length===51 && built.includes("DC") && built.includes("FL") && built.every(s=>/^[A-Z]{2}$/.test(s)), built.length);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with all 51 states", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/filings-nolists-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await t.quick(["FL","DC"]);
  ok("no lists: the search leaves the three filters out", same(t.of("search")[0].body,{action:"search",companyIds:[4000001],institutionIds:[],states:["DC","FL"],from:"2025-11-14",to:"2026-11-13"}), t.of("search")[0].body);
  t.refs=copy(REFS);
  await p.click('button[data-act="refs-refresh"]'); await p.waitForTimeout(350);
  ok("Refresh lists asks S&P again and fills the filters", same(t.of("reference").pop().body,{action:"reference",refresh:true}) && (await p.$$("#chk_toi input")).length===14 && !(await p.$(".nolist")) && (await t.txt("#toastRoot"))==="Lists refreshed from S&P." && (await p.$$("#states button")).length===6);
  t.refsStatus=500;
  await p.click('button[data-act="refs-refresh"]'); await p.waitForTimeout(350);
  ok("a failed refresh keeps the lists and says why", (await t.txt("#refsMsg"))==="The filings function failed: made-up fault" && (await p.$$("#chk_toi input")).length===14);
  await t.ctx.close();

  t=await open({}, {refsStatus:500}); p=t.p;
  ok("lists failed to load: the reason, and the form still works with built-in states", (await t.txt("#refsMsg"))==="The filings function failed: made-up fault" && (await p.$$("#states button")).length===51 && (await p.$$(".nolist")).length===3);
  await t.ctx.close();

  // ----- a long result: shown a page at a time, exported whole -----
  const many={...copy(SEARCH), rows:Array.from({length:250},(_,i)=>({...copy(SEARCH.rows[1]), filingVersionId:"fv-1"+String(i).padStart(7,"0"), documentId:900000+i, trackingNumber:"CALL-2"+String(i).padStart(8,"0")})), total:250, byState:[{state:"FL",rows:250}], byCompany:[], notes:[]};
  t=await open({}, {search:()=>({status:200, body:many})}); p=t.p; await t.quick();
  ok("250 filings: the first 100, and no note box when there are no notes", (await p.$$("#resTable tbody tr")).length===100 && (await t.txt("#resCount"))==="Showing 100 of 250" && !(await p.$("#notes")) && (await t.txt("#resSummary")).startsWith("250 filings"));
  await p.click('button[data-act="more-rows"]'); await p.waitForTimeout(150);
  ok("Show 100 more", (await p.$$("#resTable tbody tr")).length===200 && (await t.txt('button[data-act="more-rows"]'))==="Show 50 more");
  await p.click('button[data-act="more-rows"]'); await p.waitForTimeout(150);
  ok("all shown: the button goes", (await p.$$("#resTable tbody tr")).length===250 && !(await p.$('button[data-act="more-rows"]')));
  const big=await t.download(()=>p.click('button[data-what="filings"][data-fmt="csv"]'));
  ok("the export holds every row, not just the page on screen", big.text.split("\r\n").length===251);
  t.xlsx="404";
  await p.click('button[data-what="filings"][data-fmt="xlsx"]'); await p.waitForTimeout(350);
  ok("SheetJS can't be fetched: says to use CSV", (await t.txt("#toastRoot"))==="Couldn't load the Excel export. Check your connection, or use Export CSV.");
  t.xlsx="ok";
  const again=await t.download(()=>p.click('button[data-what="filings"][data-fmt="xlsx"]'));
  ok("and works on the next click", JSON.parse(again.text).sheets[0].aoa.length===251 && t.xlsxLoads===2);
  await t.ctx.close();

  // ----- phone -----
  t=await open(); p=t.p; await p.setViewportSize({width:390,height:844}); await t.quick(["FL","GA"]);
  ok("phone: no sideways scroll on the results", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.evaluate(()=>window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(80);
  ok("phone: the Ask Claude button is there, and the last filing scrolls clear of it", (await t.txt("#askFab"))==="Ask Claude" && await p.evaluate(()=>{ const a=document.getElementById("askFab").getBoundingClientRect(), last=[...document.querySelectorAll("#results *")].pop().getBoundingClientRect(); return last.bottom<=a.top && a.right<=innerWidth; }));
  await p.evaluate(()=>window.scrollTo(0,0));
  ok("phone: each filing is a card with labelled lines", await p.evaluate(()=>getComputedStyle(document.querySelector("#resTable thead")).display==="none" && getComputedStyle(document.querySelector("#resTable tbody tr")).display==="grid" && getComputedStyle(document.querySelector('#resTable td[data-label="Rate impact"]'),"::before").content==='"Rate impact"'));
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="desc-toggle"]'); await p.click('#resTable tbody tr >> nth=4 >> button[data-act="co-toggle"]'); await p.waitForTimeout(100);
  ok("phone: still no sideways scroll with a long description and every company open", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/filings-results-390.png",fullPage:true});
  t.doc=()=>({status:502, body:{error:"spgmi_unavailable",message:"S&P's service isn't answering. Try again in a few minutes.",requestId:"req-made-up-1"}});
  await p.click('#resTable tbody tr >> nth=0 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  ok("phone: no sideways scroll with a document error showing", await t.noScroll() && await p.isVisible("#resTable .doc-err"));
  // ----- small helpers the view leans on -----
  const H=await p.evaluate(()=>({us:fmtDay("11/05/2026"), stamp:fmtDay("2025-11-05T00:00:00"), bad:fmtDay("2026-02-30"), none:fmtDay(null), word:fmtDay("soon"),
    star:docName("attachment; filename*=UTF-8''CALL%20forms%20v2.pdf","d:1","application/pdf"), path:docName('attachment; filename="../../evil.pdf"',"d:1","application/pdf"), plain:docName(null,"v:fv-00000004","application/pdf"), odd:docName("","d:7","image/tiff"),
    csv:[csvCell("=1+1"),csvCell("@cmd"),csvCell("-5.2%"),csvCell("+6.5%"),csvCell(-3),csvCell('say "hi"'),csvCell(null),csvCell(0)]}));
  ok("dates: S&P's other date shape reads too, impossible or wordy dates are n/d", H.us==="5 Nov" && H.stamp==="5 Nov 2025" && H.bad==="n/d" && H.none==="n/d" && H.word==="n/d", H);
  ok("document names: S&P's name made safe, or a plain one by type", H.star==="CALL forms v2.pdf" && !/[\/\\]/.test(H.path) && H.path.endsWith("evil.pdf") && H.plain==="snl-document-fv-00000004.pdf" && H.odd==="snl-document-7.bin", H);
  ok("CSV cells: formulas defused, numbers and percentages left alone, quotes doubled", same(H.csv,['"\'=1+1"','"\'@cmd"','"-5.2%"','"+6.5%"','"-3"','"say ""hi"""','""','"0"']), H.csv);
  for(const w of [320,768,1024]){ await p.setViewportSize({width:w,height:800}); await p.waitForTimeout(120); ok(`no sideways scroll at ${w}px`, await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth)); }
  t.doc=b=>({status:200, type:"application/pdf", raw:"%PDF-1.4 made-up "+b.documentId});
  await p.click('#resTable tbody tr >> nth=1 >> button[data-act="open-doc"]'); await p.waitForTimeout(300);
  const held=await p.evaluate(()=>S.docs["d:880002"].url);
  await p.evaluate(()=>signOut()); await p.waitForTimeout(300);
  ok("sign out forgets the search and lets go of the documents held in memory", held.startsWith("blob:") && await p.evaluate(u=>fetch(u).then(()=>false,()=>true),held) && await p.evaluate(()=>Object.keys(S.docs).length===0 && !S.f.res && !S.f.chips.length));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
