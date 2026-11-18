// "Narrow it down" on the Compare view, and its look on Programs and forms: the default is unchanged; the states and
// types chosen go into every search of the comparison alike; the estimate says what is true; the heading, what was
// searched, "every carrier alike", the empty-result note, the export, the hand-offs (Snapshot, Filings), Ask Claude and
// the comparisons kept in this browser name the scope; after a comparison, a narrower choice narrows the tables and
// charts at once with "Show everything", and a wider one offers a new search; Programs and forms keeps its one state and
// one type under the same heading; 1440px and 390px. Nothing touches the network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("compare_search.json"), RES=FIX("compare_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const copy=o=>JSON.parse(JSON.stringify(o)), same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const MAIN={action:"search", companyIds:[], institutionIds:[5000001,5100001,5100002,5200001,5300001], states:["CA","FL","GA","NY","SC","TX"], from:"2023-11-15", to:"2026-11-13"};
const TOI=Object.fromEntries(REFS.lists.typeOfInsurance.options.map(o=>[o.id,o.name]));
function answer(body){
  const a=copy(SEARCH), ids=body.typeOfInsuranceIds||[];
  a.rows=a.rows.filter(r=>body.states.includes(r.serffFilingStateId) && (!ids.length || ids.some(id=>TOI[id]===r.typeOfInsurance)));
  a.params={...a.params, states:body.states, typeOfInsuranceIds:ids}; a.total=a.rows.length;
  return {status:200, body:a};
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", deviceScaleFactor:width<500?2:1, acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], search:answer,
      resolve:q=>{ const l=q.toLowerCase(); return copy(l==="tarrow group" ? RES.tarrowGroup : l.startsWith("tarrow") ? RES.tarrow : l.startsWith("nonesuch") ? RES.nonesuch : l.startsWith("calloway") ? RES.calloway : {query:q, matches:[], note:"No saved company matches.", groups:[], groupNote:null}); }, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(fn==="snl-digest") return J(200,{claude:{configured:true}, filings:{configured:true}, saved:0, digests:[], missing:[]});
        if(body.action==="status") return J(200,copy(STATUS));
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        if(body.action==="search"){ const a=t.search(body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.goto(BASE+(over.hash||"#compare")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.searches=()=>t.calls.filter(c=>c.fn==="snl-filings" && c.body.action==="search").map(c=>c.body);
    t.find=async q=>{ await p.fill("#cm_find",q); await p.press("#cm_find","Enter"); await p.waitForTimeout(200); };
    t.addCo=async (q,i)=>{ await t.find(q); await p.click(`#cm_matches [data-act="cmp-co"] >> nth=${i}`); await p.waitForTimeout(100); };
    t.addGroup=async q=>{ await t.find(q); await p.click('#cm_matches [data-act="cmp-group"] >> nth=0'); await p.waitForTimeout(300); };
    t.four=async()=>{ await t.addCo("Calloway",0); await t.addGroup("Tarrow"); await t.addCo("Nonesuch",0); await t.addCo("Nonesuch",1); };
    t.run=async()=>{ await p.click("#cm_run"); await p.waitForTimeout(500); };
    t.states=async(...ss)=>{ if(!(await p.$("#nw_cmp_stp"))) await p.click("#nw_cmp_stb"); for(const s of ss) await p.click(`#nw_cmp_states [data-s="${s}"]`); await p.click("#nw_cmp_stDone"); await p.waitForTimeout(80); };
    t.types=async(...ids)=>{ if(!(await p.$("#nw_cmp_toip"))) await p.click("#nw_cmp_toib"); for(const id of ids) await p.click(`#nw_cmp_tois input[data-id="${id}"]`); await p.click("#nw_cmp_toiDone"); await p.waitForTimeout(80); };
    return t;
  }

  // ----- the default: as before -----
  let t=await open(); let p=t.p;
  ok("the form has Narrow it down, with every state and every type to start with", (await t.txt("#nw_cmp_allst"))==="All states" && (await t.txt("#nw_cmp_alltoi"))==="All types of insurance");
  await t.four();
  ok("the estimate reads as before", (await t.txt("#cm_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in all 6 states in S&P's list, every filing type and status." && !(await t.txt("#cm_cost")).includes("Narrowing"));
  await t.run();
  ok("untouched, the comparison's search is exactly as before", same(t.searches(),[MAIN]), t.searches());
  ok("…and nothing says it was narrowed", !(await p.$("#cmScope")) && !(await p.$("#cmAlike")) && !(await p.$("#cmpShown")));
  const sumAll=await t.list("#cmSumTable tbody tr td:nth-child(2)");

  // ----- after the comparison: narrowing what is shown, for every carrier alike -----
  await t.states("FL");
  const n=t.searches().length;
  ok("choosing Florida narrows the tables at once, without asking S&P", t.searches().length===n && (await t.txt("#cmpShown")).startsWith("Showing FL, all types: ") && (await t.txt("#cmpShown")).includes("without asking S&P again"), await t.txt("#cmpShown"));
  ok("…every table follows: only Florida in the carrier by state table", same(await p.$$eval("#cmStatesTable tbody tr td:first-child",e=>e.map(x=>x.textContent.trim())),["Florida (FL)"]));
  ok("…and the summary's counts change", !same(await t.list("#cmSumTable tbody tr td:nth-child(2)"), sumAll));
  const ex=p.waitForEvent("download"); await p.click('[data-act="export"][data-what="cmp"][data-tbl="summary"][data-fmt="csv"]'); const ef=await ex;
  ok("the export of a narrowed comparison says so in its name", /^snl-compare-4-carriers-fl-all-types-summary-2026-11-13\.csv$/.test(ef.suggestedFilename()), ef.suggestedFilename());
  await p.click('#cmpShown [data-act="nw-show-all"]'); await p.waitForTimeout(150);
  ok("Show everything puts every filing back", !(await p.$("#cmpShown")) && same(await t.list("#cmSumTable tbody tr td:nth-child(2)"), sumAll));

  // ----- narrowing the search itself: Florida and Texas, homeowners -----
  await t.states("FL","TX"); await t.types("101");
  ok("the estimate says the scope, every carrier alike, and that the requests don't fall", (await t.txt("#cm_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in Florida and Texas, homeowners only, every filing type and status, for every carrier alike."
    && (await t.txt("#cm_cost")).includes("Narrowing the states or types doesn't change the number of S&P requests, which depends on the companies and years; it means fewer filings come back."), await t.txt("#cm_dates"));
  await t.run();
  ok("every search of the comparison carries the states and the type", t.searches().slice(-1).every(s=>same(s,{...MAIN, states:["FL","TX"], typeOfInsuranceIds:[101]})), t.searches().slice(-1));
  ok("the heading, what was searched, and every carrier alike", (await t.txt("#cmScope"))==="FL and TX, homeowners" && (await t.txt("#cmMeta")).includes("searched in Florida and Texas · homeowners only") && (await t.txt("#cmAlike"))==="Every carrier was searched for Florida and Texas, homeowners alike, so the tables and charts below compare like with like.", await t.txt("#cmMeta"));
  ok("the kept comparison names its scope", (await t.txt("#cm_recent li >> nth=0")).includes("FL and TX, homeowners"));
  ok("Ask Claude is told the type of insurance", await p.evaluate(()=>JSON.stringify(cmpScreen().search.typeOfInsuranceIds)==="[101]"));
  // a wider choice
  await t.types("102");
  ok("a type that wasn't searched: offers a new search", (await t.txt("#cmpWider")).startsWith("You've chosen more than this comparison searched: private passenger auto."), await t.txt("#cmpWider"));
  await p.click('#cmpWider [data-act="nw-research"]'); await p.waitForTimeout(500);
  ok("Search again asks for both types", same(t.searches().at(-1).typeOfInsuranceIds,[101,102]) && !(await p.$("#cmpWider")));
  // hand-offs
  await p.click('[data-act="cmp-filings"] >> nth=0'); await p.waitForTimeout(300);
  ok("See every filing on the Filings view carries the states and the types", await p.evaluate(()=>JSON.stringify(S.f.states)==='["FL","TX"]' && JSON.stringify(S.f.toi)==='["101","102"]'));
  await p.goto(BASE+"#compare"); await p.waitForTimeout(400);
  await p.click('[data-act="cmp-snap"] >> nth=0'); await p.waitForTimeout(400);
  ok("a carrier's Snapshot is chosen with the same scope", await p.evaluate(()=>JSON.stringify(S.snap.nw.states)==='["FL","TX"]' && JSON.stringify(S.snap.nw.tois)==='["101","102"]') && (await t.txt("#sn_dates")).includes("in Florida and Texas, homeowners and private passenger auto only"), await t.txt("#sn_dates"));
  await ctx_close(t);

  // ----- nothing returned for a narrowed comparison -----
  t=await open({search:body=>{ const a=answer(body); a.body.rows=[]; a.body.total=0; return a; }}); p=t.p;
  await t.four(); await t.states("NY"); await t.types("113"); await t.run();
  ok("S&P returned nothing: the note names the scope and what it doesn't say", (await t.txt("#cmEmpty b")).startsWith("S&P returned nothing for this comparison of New York, flood") && (await t.txt("#cmEmpty")).includes("so it says nothing about other states or types of insurance"), await t.txt("#cmEmpty"));
  await ctx_close(t);

  // ----- Programs and forms: the same heading, the same behaviour -----
  t=await open({hash:"#forms"}); p=t.p;
  ok("Programs and forms puts its state and type under Narrow it down", (await t.txt("#fc_narrowH"))==="Narrow it down" && !!(await p.$("#fc_narrow #fc_state")) && !!(await p.$("#fc_narrow #fc_toi")) && (await t.txt("#fc_narrow .nwhead .t2")).startsWith("one state and one type of insurance"));
  ok("…and still takes one of each", (await p.$eval("#fc_state",e=>e.tagName))==="SELECT" && !(await p.$("#nw_fc")));
  await p.screenshot({path:OUTDIR+"/viewfilters-forms-1440.png"});
  await ctx_close(t);

  // ----- 1440px and 390px -----
  for(const width of [1440, 390]){
    t=await open({width}); p=t.p;
    await t.four(); await t.states("FL","TX","GA"); await t.types("101","109");
    await p.screenshot({path:OUTDIR+`/viewfilters-compare-${width}.png`, fullPage:width<500});
    await p.click("#nw_cmp_toib"); await p.waitForTimeout(100);
    ok(`${width}px: no sideways scroll with the list of types open`, await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
    await p.click("#nw_cmp_toiDone"); await t.run(); await t.states("GA");
    ok(`${width}px: no sideways scroll with a narrowed comparison`, await t.noScroll() && !!(await p.$("#cmpShown")));
    await ctx_close(t);
  }

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
  async function ctx_close(x){ await x.ctx.close(); }
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
