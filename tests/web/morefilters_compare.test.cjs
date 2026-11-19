// "Narrow it down" by filing type and status on the Compare view, and status on Programs and forms: the default is
// unchanged; the filing types and statuses chosen go into every search of the comparison alike, and the page says so;
// the heading, what was searched, the empty-result note, the export, the hand-offs (Snapshot, Filings), Ask Claude and
// the comparisons kept in this browser name the full scope; the summary, the rate chart and the tables say "left out by
// the narrowing" for a kind left out, never 0 or "S&P returned nothing"; after a comparison the two narrow what is shown
// with "Show everything", and a wider choice offers a new search; Programs and forms sends the statuses chosen; 1440px
// and 390px. Nothing touches the network.
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
// the compare fixture's filing type ids differ from web_reference.json's: the made-up S&P gives each row the list's id
const FTID=Object.fromEntries(REFS.lists.serffFilingType.options.map(o=>[o.name,o.id]));
function answer(body){
  const a=copy(SEARCH), ids=body.typeOfInsuranceIds||[], ft=body.filingTypeIds||[], fs=body.filingStatusIds||[];
  a.rows.forEach(r=>{ r.serffFilingTypeId = r.serffFilingType===null ? null : String(FTID[r.serffFilingType]); });   // as text, as the Live check saw it
  a.rows=a.rows.filter(r=>body.states.includes(r.serffFilingStateId) && (!ids.length || ids.some(id=>TOI[id]===r.typeOfInsurance)) && (!ft.length || ft.includes(Number(r.serffFilingTypeId))) && (!fs.length || fs.includes(r.filingStatusId)));
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
    t.pick=async(w, ...ids)=>{ if(!(await p.$(`#nw_cmp_${w}p`))) await p.click(`#nw_cmp_${w}b`); for(const id of ids) await p.click(`#nw_cmp_${w}s input[data-id="${id}"]`); await p.click(`#nw_cmp_${w}Done`); await p.waitForTimeout(80); };
    t.types=async(...ids)=>{ if(!(await p.$("#nw_cmp_toip"))) await p.click("#nw_cmp_toib"); for(const id of ids) await p.click(`#nw_cmp_tois input[data-id="${id}"]`); await p.click("#nw_cmp_toiDone"); await p.waitForTimeout(80); };
    return t;
  }

  const ROWS=answer({states:MAIN.states}).body.rows, uniq=rows=>new Set(rows.map(r=>r.filingVersionId||r.serffFilingEntityEventId)).size;
  const OURS=ROWS.filter(r=>r.institutionId!==5999999);   // a row naming none of the chosen companies is left out of every figure

  // ----- the default: as before -----
  let t=await open(); let p=t.p;
  ok("the box has filing type and status, every status in force", (await t.txt("#nw_cmp_allft"))==="All filing types" && (await t.txt("#nw_cmp_allfs"))==="All statuses" && (await t.txt("#nw_cmp_fsnote"))==="No status chosen: every status in S&P's list is searched.");
  ok("the box says every carrier is searched alike", (await t.txt("#nw_cmp_note")).startsWith("Every carrier is searched for the same states, types, filing types and statuses, so the comparison is like with like."));
  await t.four(); await t.run();
  ok("untouched, the comparison's search is exactly as before", same(t.searches(),[MAIN]), t.searches());

  // ----- before the search: rate filings, approved -----
  await t.pick("ft","12"); await t.pick("fs","1");
  ok("the estimate names them, for every carrier alike", (await t.txt("#cm_dates")).endsWith("in all 6 states in S&P's list, rate filings, approved only, for every carrier alike.") && (await t.txt("#cm_cost")).includes("Narrowing the states, types, filing types or statuses doesn't change the number of S&P requests"), await t.txt("#cm_dates"));
  ok("after a comparison of everything, the choice narrows what is shown at once", (await t.txt("#cmpShown")).startsWith("Showing rate filings; approved:"), await t.txt("#cmpShown"));
  await t.run();
  const s1=t.searches().at(-1);
  ok("the search carries them, for every carrier alike", same(s1,{...MAIN, filingTypeIds:[12], filingStatusIds:[1]}), s1);
  ok("the heading, what was searched and 'alike' name the scope", (await t.txt("#cmScope"))==="rate filings; approved" && (await t.txt("#cmMeta")).includes("6 states searched · rate filings, approved only") && (await t.txt("#cmAlike"))==="Every carrier was searched for rate filings; approved alike, so the tables and charts below compare like with like.", [await t.txt("#cmMeta"), await t.txt("#cmAlike")]);
  const sum=await p.$$eval("#cmSumTable tbody tr",tr=>tr.map(r=>[...r.querySelectorAll("td")].map(td=>td.textContent.replace(/\s+/g," ").trim())));
  ok("the summary: rule and form columns say left out for every carrier fetched, never 0", sum.every(r=>r[3]==="Left out" && r[4]==="Left out"), sum);
  ok("…and the note under it says why", (await t.txt("#cmSumOut"))==="Left out by the narrowing: this comparison was narrowed to rate filings, so rule and form filings weren't searched.", await t.txt("#cmSumOut"));
  ok("the rate chart says every rate impact here may be the change asked for only when a status that isn't approved is chosen", !(await p.$("#cmRateStatus")));
  const dl=p.waitForEvent("download"); await p.click('[data-act="export"][data-what="cmp"][data-tbl="summary"][data-fmt="csv"]'); const f1=await dl;
  const csv=fs.readFileSync(await f1.path(),"utf8").trim().split("\r\n");
  ok("the export's name carries the scope; rule and form are empty with the reason, never 0", /-rate-filings-approved-summary-2026-11-13\.csv$/.test(f1.suggestedFilename()) && csv[1].split('","')[5]==="" && csv[1].split('","')[6]==="" && csv[1].includes("Left out by the narrowing: this comparison was narrowed to rate filings, so rule and form filings weren't searched."), [f1.suggestedFilename(), csv[1]]);
  ok("Ask Claude is told the filing type and status of the comparison's one search", await p.evaluate(()=>JSON.stringify(cmpScreen().search.filingTypeIds)==="[12]" && JSON.stringify(cmpScreen().search.filingStatusIds)==="[1]"));
  ok("the comparison kept in this browser names its scope", (await t.txt("#cm_recent li >> nth=0")).includes("rate filings; approved"));
  await p.click('[data-act="cmp-filings"] >> nth=0'); await p.waitForTimeout(300);
  ok("See every filing on the Filings view carries the filing type and status", await p.evaluate(()=>JSON.stringify(S.f.ftype)==='["12"]' && JSON.stringify(S.f.fstatus)==='["1"]'));
  await p.goto(BASE+"#compare"); await p.waitForTimeout(400);
  await p.click('[data-act="cmp-recent"] >> nth=0'); await p.waitForTimeout(500);
  await p.click('[data-act="cmp-snap"] >> nth=0'); await p.waitForTimeout(500);
  ok("Open its snapshot takes the filing type and status to the Snapshot", await p.evaluate(()=>JSON.stringify(S.snap.nw.ftypes)==='["12"]' && JSON.stringify(S.snap.nw.fstats)==='["1"]') && same(t.searches().at(-1).filingTypeIds,[12]) && same(t.searches().at(-1).filingStatusIds,[1]), t.searches().at(-1));
  await t.ctx.close();

  // ----- an empty result with all four -----
  t=await open(); p=t.p;
  await t.four(); await t.states("NY"); await t.types("101"); await t.pick("ft","13"); await t.pick("fs","3");
  t.search=body=>{ const a=answer(body); a.body.rows=[]; a.body.total=0; return a; };
  await t.run();
  ok("nothing returned: names the full scope and that it says nothing about other states, types, filing types or statuses", (await t.txt("#cmEmpty b")).startsWith("S&P returned nothing for this comparison of New York; homeowners; rule filings; withdrawn")
    && (await t.txt("#cmEmpty")).includes("so it says nothing about other states, types of insurance, filing types or statuses.") && (await t.txt("#cmEmpty")).includes("a wider choice of states, types, filing types and statuses"), await t.txt("#cmEmpty"));
  await t.ctx.close();

  // ----- after the comparison: narrowing what is shown -----
  t=await open(); p=t.p;
  await t.four(); await t.run();
  const allN=uniq(OURS), calls=t.searches().length;
  await t.pick("ft","11");
  const forms=OURS.filter(r=>r.serffFilingType==="Form");
  ok("a filing type narrows every carrier at once, without asking S&P, with the filing that has no type counted", t.searches().length===calls && (await t.txt("#cmpShown")).startsWith(`Showing form filings: ${uniq(forms)} of ${allN} filings.`) && (await t.txt("#cmpShown")).includes("1 filing has no filing type in S&P's data and isn't shown."), await t.txt("#cmpShown"));
  ok("rate changes: left out by the narrowing on this page, never 'no rate impact'", (await t.txt("#cmNoRates")).startsWith("Left out by the narrowing: this comparison is narrowed to form filings, so rate filings aren't shown."), await t.txt("#cmNoRates"));
  await p.click('#nw_cmp [data-act="nw-ft-none"] >> nth=0'); await p.waitForTimeout(100);
  await t.pick("fs","3");
  const sum2=await p.$$eval("#cmSumTable tbody tr",tr=>tr.map(r=>[...r.querySelectorAll("td")].map(td=>td.textContent.replace(/\s+/g," ").trim())));
  ok("a status narrows too: a carrier with filings, none withdrawn, says 'None in withdrawn', never 'S&P returned nothing'", sum2[0][1]==="None in withdrawn" && sum2[3][1]==="S&P returned nothing", sum2.map(r=>r[1]));
  ok("…and the notes under the summary say which is which", (await t.txt("#cmHiddenFor")).startsWith("None of the filings of Calloway Insurance Co and Nonesuch Coastal Co is in withdrawn.") && (await t.txt("#cmNothingFor")).startsWith("S&P returned nothing for Nonesuch Quiet Co"), [await t.txt("#cmHiddenFor"), await t.txt("#cmNothingFor")]);
  ok("the table by state says 'none shown', never 'none returned'", await p.evaluate(()=>[...document.querySelectorAll("#cmStatesTable .cmna")].every(x=>x.textContent==="none shown")) && (await t.list("#cmStatesTableKey li")).some(x=>x.startsWith("None shown: none of that carrier's filings there is in withdrawn")));
  await p.click('#cmpShown [data-act="nw-show-all"]'); await p.waitForTimeout(150);
  ok("Show everything clears it", !(await p.$("#cmpShown")) && (await t.txt("#nw_cmp_allfs"))==="All statuses");
  await t.pick("fs","1"); await p.click('#cm_run'); await p.waitForTimeout(500);
  await t.pick("fs","2");
  ok("a status that wasn't searched offers a new search, naming it", (await t.txt("#cmpWider")).startsWith("You've chosen more than this comparison searched: pending."), await t.txt("#cmpWider"));
  await t.ctx.close();

  // ----- Programs and forms: status -----
  t=await open({hash:"#forms"}); p=t.p;
  ok("Programs and forms offers status under Narrow it down, every status to start with", (await t.txt("#nw_fc_allfs"))==="All statuses" && (await t.txt("#nw_fc_fsnote"))==="No status chosen: forms of every status are searched." && !(await p.$("#nw_fc_ftb")));
  ok("…and says what it covers as before", (await t.txt("#fc_dates")).includes("every status"));
  await p.click("#nw_fc_fsb"); await p.waitForTimeout(100); await p.click('#nw_fc_fss input[data-id="1"]'); await p.click("#nw_fc_fsDone"); await p.waitForTimeout(80);
  ok("a status chosen is said in what it covers and in the box", (await t.txt("#fc_dates")).includes("approved only") && (await t.txt("#nw_fc_fsnote")).startsWith("Only filings with this status are searched"), await t.txt("#fc_dates"));
  await p.evaluate(()=>{ S.fc.picks=[{kind:"company", name:"Calloway Insurance Co", group:"", ids:[{kind:"institutionId", id:"5000001", name:"Calloway Insurance Co"}], noId:0, cut:false},{kind:"company", name:"Tarrow Mutual Insurance Co", group:"", ids:[{kind:"institutionId", id:"5100001", name:"Tarrow Mutual Insurance Co"}], noId:0, cut:false}]; S.fc.state="FL"; S.fc.toi="101"; render(); });
  await p.click("#fc_run"); await p.waitForTimeout(600);
  ok("the Programs and forms search carries the status, and still only form filing types", same(t.searches().at(-1).filingStatusIds,[1]) && same(t.searches().at(-1).filingTypeIds,[11]), t.searches().at(-1));
  ok("…and Ask Claude is told it", await p.evaluate(()=>{ const s=fcScreen&&fcScreen(); return !s || JSON.stringify(s.search.filingStatusIds)==="[1]"; }));
  await t.ctx.close();

  // ----- 1440px and 390px -----
  for(const width of [1440, 390]){
    t=await open({width}); p=t.p;
    await t.four(); await t.pick("ft","11","12","13"); await t.pick("fs","1","2");
    await p.click("#nw_cmp_fsb"); await p.waitForTimeout(120);
    ok(`${width}px: no sideways scroll with the chips and a list open`, await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
    await p.click("#nw_cmp_fsb"); await p.waitForTimeout(80);
    await (await p.$("#nw_cmp")).screenshot({path:OUTDIR+`/morefilters-compare-${width}.png`});
    await t.run();
    ok(`${width}px: no sideways scroll with the result`, await t.noScroll());
    await t.ctx.close();
  }

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
