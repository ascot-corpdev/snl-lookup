// "Narrow it down" by filing type and status on the Snapshot view: the default is unchanged (no filing type, no status:
// the same search as before, and the box says every status is searched); choosing filing types and statuses from S&P's
// lists as chips; the search carries filingTypeIds and filingStatusIds; every wording names the full scope (what it
// covers, the heading, what was searched, the empty-result note with all four filters, Ask Claude, the export, the
// Filings hand-off, the snapshots kept in this browser); the sections that depend on a filing type or status left out say
// "left out by the narrowing", never a zero or "S&P returned nothing"; after a search the two narrow what is shown, rows
// matched by S&P's id whether it comes as text or a number, rows with no filing type or status counted and left out,
// "Show everything" and the offer to search again; S&P's lists not loaded; hostile names; 1440px and 390px.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("snapshot_search.json"), RES=FIX("snapshot_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o)), same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const GROUP_SEARCH={action:"search", companyIds:[], institutionIds:[5000001,5000002,5000003], states:["CA","FL","GA","NY","SC","TX"], from:"2023-11-15", to:"2026-11-13"};
const TOI=Object.fromEntries(REFS.lists.typeOfInsurance.options.map(o=>[o.id,o.name]));
// S&P, made up: the fixture's rows for what was asked; textIds: serffFilingTypeId as text, as the Live check saw it
function answer(body, textIds){
  const a=copy(SEARCH), ids=body.typeOfInsuranceIds||[], ft=body.filingTypeIds||[], fs=body.filingStatusIds||[];
  a.rows=a.rows.filter(r=>body.states.includes(r.serffFilingStateId) && (!ids.length || ids.some(id=>TOI[id]===r.typeOfInsurance)) && (!ft.length || ft.includes(r.serffFilingTypeId)) && (!fs.length || fs.includes(r.filingStatusId)));
  if(textIds) a.rows.forEach(r=>{ if(r.serffFilingTypeId!==null) r.serffFilingTypeId=String(r.serffFilingTypeId); });
  a.params={...a.params, states:body.states, typeOfInsuranceIds:ids, filingTypeIds:ft, ...(fs.length?{filingStatusIds:fs, allStatuses:false}:{})}; a.total=a.rows.length;
  return {status:200, body:a};
}
const uniq=rows=>new Set(rows.map(r=>r.filingVersionId||r.serffFilingEntityEventId)).size;

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", deviceScaleFactor:width<500?2:1, acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], refs:()=>copy(REFS), resolve:q=>/group/i.test(q) ? copy(RES.byGroup) : copy(RES.byName), search:b=>answer(b), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(body.action==="status") return J(200,copy(STATUS));
        if(body.action==="reference") return J(200,t.refs());
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        if(body.action==="search"){ const a=t.search(body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.goto(BASE+(over.hash||"#snapshot")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.searches=()=>t.calls.filter(c=>c.fn==="snl-filings" && c.body.action==="search").map(c=>c.body);
    t.group=async()=>{ await p.fill("#sn_find","Calloway"); await p.press("#sn_find","Enter"); await p.waitForTimeout(200); await p.click('[data-act="snap-group"] >> nth=0'); await p.waitForTimeout(250); };
    t.run=async()=>{ await p.click("#sn_run"); await p.waitForTimeout(450); };
    t.pick=async(w, ...ids)=>{ if(!(await p.$(`#nw_snap_${w}p`))) await p.click(`#nw_snap_${w}b`); for(const id of ids) await p.click(`#nw_snap_${w}s input[data-id="${id}"]`); await p.click(`#nw_snap_${w}Done`); await p.waitForTimeout(80); };
    t.states=async(...ss)=>{ if(!(await p.$("#nw_snap_stp"))) await p.click("#nw_snap_stb"); for(const s of ss) await p.click(`#nw_snap_states [data-s="${s}"]`); await p.click("#nw_snap_stDone"); await p.waitForTimeout(80); };
    t.types=async(...ids)=>{ if(!(await p.$("#nw_snap_toip"))) await p.click("#nw_snap_toib"); for(const id of ids) await p.click(`#nw_snap_tois input[data-id="${id}"]`); await p.click("#nw_snap_toiDone"); await p.waitForTimeout(80); };
    t.chips=async w=>p.$$eval(`#nw_snap_${w}l ~ .chips .cchip b`,e=>e.map(x=>x.textContent));
    return t;
  }

  // ----- the default: as before -----
  let t=await open(); let p=t.p;
  ok("the box has filing type and status, each saying nothing is narrowed", (await t.txt("#nw_snap_allft"))==="All filing types" && (await t.txt("#nw_snap_allfs"))==="All statuses" && (await t.txt("#nw_snap_ftl"))==="Filing type" && (await t.txt("#nw_snap_fsl"))==="Status");
  ok("the box says plainly which status is in force: every status", (await t.txt("#nw_snap_fsnote"))==="No status chosen: every status in S&P's list is searched.");
  await t.group();
  ok("what it covers reads as before", (await t.txt("#sn_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in all 6 states in S&P's list, every filing type and status.");
  await t.run();
  ok("untouched, the search is exactly as before: no filing type, no status", same(t.searches(),[GROUP_SEARCH]), t.searches());

  // ----- choosing filing types and statuses -----
  await p.click("#nw_snap_ftb"); await p.waitForTimeout(100);
  ok("Choose filing types opens S&P's list as checkboxes; focus goes into it", (await p.getAttribute("#nw_snap_ftb","aria-expanded"))==="true" && same(await t.list("#nw_snap_fts label"),["Form","Rate","Rule","Rate and rule"]) && await p.evaluate(()=>document.activeElement.matches("#nw_snap_fts input")));
  await p.click('#nw_snap_fts input[data-id="12"]'); await p.click("#nw_snap_ftDone"); await p.waitForTimeout(80);
  ok("the filing type is a chip; Done closes the list and gives focus back", same(await t.chips("ft"),["Rate"]) && !(await p.$("#nw_snap_ftp")) && await p.evaluate(()=>document.activeElement.id==="nw_snap_ftb"));
  ok("what it covers names the filing type, and every status", (await t.txt("#sn_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in all 6 states in S&P's list, rate filings only, every status.", await t.txt("#sn_dates"));
  await t.pick("fs","1");
  ok("a status chosen: the box says only that status is searched", same(await t.chips("fs"),["Approved"]) && (await t.txt("#nw_snap_fsnote"))==="Only filings with this status are searched.");
  ok("what it covers names both", (await t.txt("#sn_dates")).endsWith("rate filings, approved only.") && (await t.txt("#sn_cost")).includes("Narrowing the states, types, filing types or statuses doesn't change that number"), await t.txt("#sn_dates"));
  await t.run();
  const s1=t.searches().at(-1);
  ok("the search carries the filing type and status by S&P's id", same(s1,{...GROUP_SEARCH, filingTypeIds:[12], filingStatusIds:[1]}), s1);
  const rateOk=SEARCH.rows.filter(r=>r.serffFilingTypeId===12 && r.filingStatusId===1);
  ok("the snapshot counts what came back", (await t.txt('#snTiles [data-k="n"] b'))===String(uniq(rateOk)));
  ok("the heading and what was searched name the scope", (await t.txt("#snScope"))==="rate filings; approved" && (await t.txt("#snMeta")).includes("6 states searched · rate filings, approved only"), [await t.txt("#snScope"), await t.txt("#snMeta")]);
  // left out by the narrowing, never zero
  ok("rule and form tiles say left out by the narrowing, never 0", (await t.txt('#snTiles [data-k="rule"] b'))==="Left out" && (await t.txt('#snTiles [data-k="form"] b'))==="Left out" && (await t.txt('#snTiles [data-k="rule"]')).includes("by the narrowing"));
  ok("…and the note under the tiles says why", (await t.txt("#snTileNote")).includes("Left out by the narrowing: this snapshot was narrowed to rate filings, so rule and form filings weren't searched."), await t.txt("#snTileNote"));
  ok("latest form and rule filings: left out by the narrowing, never 'S&P returned no form or rule filings'", (await t.txt("#snNoForms")).startsWith("Left out by the narrowing: this snapshot was narrowed to rate filings, so form and rule filings weren't searched.") && !(await t.txt("#snLatest")).includes("returned no"), await t.txt("#snNoForms"));
  ok("time with the regulator says what it is counted over", (await t.txt("#snDaysScope"))==="Counted over the filings in rate filings; approved only.");
  // the hand-offs and Ask Claude
  const dl=p.waitForEvent("download"); await p.click('[data-act="export"][data-what="snap"][data-tbl="filings"][data-fmt="csv"]'); const file=await dl;
  ok("the export's name carries the scope", /-rate-filings-approved-filings-2026-11-13\.csv$/.test(file.suggestedFilename()), file.suggestedFilename());
  ok("Ask Claude is told the filing type and status searched", await p.evaluate(()=>{ const s=snapScreen(); return JSON.stringify(s.search.filingTypeIds)==="[12]" && JSON.stringify(s.search.filingStatusIds)==="[1]"; }));
  ok("the line under the question names them", await p.evaluate(()=>/in 6 states, rate filings, approved only\. /.test(snapToldText(snapScreen(), false))), await p.evaluate(()=>snapToldText(snapScreen(), false)));
  await p.click("#sn_ask"); await p.waitForTimeout(200);
  ok("Ask about this names the scope", /since Nov 2023 in rate filings; approved/.test(await p.inputValue("#ask_input")), await p.inputValue("#ask_input"));
  await p.evaluate(()=>{ S.ask.open=false; render(); });
  ok("the snapshot kept in this browser names its scope", (await t.txt("#sn_recent li >> nth=0")).includes("rate filings; approved"));
  await p.click("#sn_toFilings"); await p.waitForTimeout(300);
  ok("See every filing on the Filings view carries the filing type and status", await p.evaluate(()=>JSON.stringify(S.f.ftype)==='["12"]' && JSON.stringify(S.f.fstatus)==='["1"]') && same(t.searches().at(-1),s1));
  await p.goto(BASE+"#snapshot"); await p.waitForTimeout(400);
  await p.click('[data-act="snap-recent"] >> nth=0'); await p.waitForTimeout(450);
  ok("reopening a kept snapshot chooses its filing type and status again", same(await t.chips("ft"),["Rate"]) && same(await t.chips("fs"),["Approved"]) && same(t.searches().at(-1),s1));
  await t.ctx.close();

  // ----- all four, and an empty result -----
  t=await open(); p=t.p;
  await t.group(); await t.states("FL"); await t.types("101"); await t.pick("ft","12"); await t.pick("fs","4");
  ok("all four read as one line", (await t.txt("#sn_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in Florida, homeowners only, rate filings, disapproved only.", await t.txt("#sn_dates"));
  t.search=body=>{ const a=answer(body); a.body.rows=[]; a.body.total=0; return a; };
  await t.run();
  ok("the search carries all four", same(t.searches().at(-1),{...GROUP_SEARCH, states:["FL"], typeOfInsuranceIds:[101], filingTypeIds:[12], filingStatusIds:[4]}));
  ok("nothing returned: names the full scope and that it says nothing about other states, types, filing types or statuses", (await t.txt("#snEmpty b")).startsWith("S&P returned nothing for this search of Florida; homeowners; rate filings; disapproved")
    && (await t.txt("#snEmpty")).includes("so it says nothing about other states, types of insurance, filing types or statuses.") && (await t.txt("#snEmpty")).includes("or a wider choice of states, types, filing types and statuses"), await t.txt("#snEmpty"));
  ok("…and the heading's scope", (await t.txt("#snScope"))==="FL; homeowners; rate filings; disapproved");
  await t.ctx.close();

  // ----- after a search: narrowing what is shown, matched by S&P's id sent as text -----
  t=await open({search:b=>answer(b, true)}); p=t.p;
  await t.group(); await t.run();
  const n0=await t.txt('#snTiles [data-k="n"] b'), calls=t.searches().length;
  await t.pick("ft","11");
  const forms=SEARCH.rows.filter(r=>r.serffFilingTypeId===11), noType=SEARCH.rows.filter(r=>r.serffFilingTypeId===null && r.serffFilingType===null);
  ok("a filing type narrows what is shown at once, matching ids that came as text, without asking S&P", t.searches().length===calls && (await t.txt('#snTiles [data-k="n"] b'))===String(uniq(forms)), await t.txt('#snTiles [data-k="n"] b'));
  ok("…says so, naming it, with the filings that have no filing type counted and left out", (await t.txt("#snapShown")).startsWith(`Showing form filings: ${uniq(forms)} of ${n0} filings.`) && (await t.txt("#snapShown")).includes(`${uniq(noType)} filing has no filing type in S&P's data and isn't shown.`), await t.txt("#snapShown"));
  ok("rate and rule are left out on the page: 'aren't shown', never 0", (await t.txt('#snTiles [data-k="rate"] b'))==="Left out" && (await t.txt("#snTileNote")).includes("this snapshot is narrowed to form filings, so rate and rule filings aren't shown."), await t.txt("#snTileNote"));
  ok("rate changes: left out by the narrowing, offering Show everything, never 'S&P returned no rate filings'", (await t.txt("#snNoRates")).startsWith("Left out by the narrowing: this snapshot is narrowed to form filings, so rate filings aren't shown. Choose Show everything") && !(await t.txt("#snRates")).includes("returned no"), await t.txt("#snNoRates"));
  ok("a state with filings, none of them forms, is drawn as 'none in what is shown', never 'S&P returned nothing'", await p.evaluate(()=>[...document.querySelectorAll("#snMapSvg path.none title")].every(x=>!/S&P returned nothing/.test(x.textContent) && /none of the filings searched there is in form filings/.test(x.textContent))));
  await t.pick("fs","2");
  const fp=forms.filter(r=>r.filingStatusId===2);
  ok("a status narrows too", (await t.txt("#snapShown")).startsWith(`Showing form filings; pending: ${uniq(fp)} of ${n0} filings.`) && t.searches().length===calls, await t.txt("#snapShown"));
  await p.click('#snapShown [data-act="nw-show-all"]'); await p.waitForTimeout(150);
  ok("Show everything clears both: every filing, the chips gone", (await t.txt('#snTiles [data-k="n"] b'))===n0 && !(await p.$("#snapShown")) && (await t.txt("#nw_snap_allft"))==="All filing types" && (await t.txt("#nw_snap_allfs"))==="All statuses");
  // a search narrowed to rate filings, then wider choices
  await t.pick("ft","12"); await t.run();
  await t.pick("ft","11");
  ok("a filing type that wasn't searched: offers a new search, naming it", (await t.txt("#snapWider")).startsWith("You've chosen more than this snapshot searched: form filings. What is below covers only what was searched.") && !(await p.$("#snapShown")), await t.txt("#snapWider"));
  await p.click('#snapWider [data-act="nw-research"]'); await p.waitForTimeout(450);
  ok("Search again asks S&P for both", same(t.searches().at(-1).filingTypeIds,[11,12]) && !(await p.$("#snapWider")));
  await t.pick("fs","1"); await t.run();
  await p.click('#nw_snap [data-act="nw-fs-none"] >> nth=0'); await p.waitForTimeout(100);
  ok("every status, after a search narrowed to one, is wider too", (await t.txt("#snapWider")).includes("every status"), await t.txt("#snapWider"));
  await t.ctx.close();

  // ----- S&P's lists not loaded; hostile names; keyboard -----
  t=await open({refs:()=>{ const r=copy(REFS); delete r.lists.serffFilingType; delete r.lists.filingStatus; return r; }}); p=t.p;
  ok("without S&P's lists: each says the filter is left out, and its button can't open it", (await t.txt("#nw_snap_ftoff"))==="S&P's lists aren't loaded yet, so this filter is left out of the search." && (await t.txt("#nw_snap_fsoff"))==="S&P's lists aren't loaded yet, so this filter is left out of the search."
    && await p.$eval("#nw_snap_ftb",e=>e.disabled) && await p.$eval("#nw_snap_fsb",e=>e.disabled));
  await p.evaluate(()=>{ S.snap.nw.ftypes=["12"]; S.snap.nw.fstats=["1"]; render(); });
  await t.group(); await t.run();
  ok("…and choices made earlier aren't sent", !("filingTypeIds" in t.searches().at(-1)) && !("filingStatusIds" in t.searches().at(-1)));
  await t.ctx.close();
  t=await open({refs:()=>{ const r=copy(REFS); r.lists.serffFilingType.options.push({id:19, name:'<img src=x onerror="window.__xss=1">Boat'}); r.lists.filingStatus.options.push({id:9, name:'<b>Odd</b>'}); return r; }}); p=t.p;
  await t.pick("ft","19"); await t.pick("fs","9");
  ok("hostile names show as text, in the list and the chip", !(await p.$("#nw_snap img")) && !(await p.$("#nw_snap .cchip b b")) && (await t.chips("ft"))[0].startsWith("<img") && (await t.chips("fs"))[0]==="<b>Odd</b>" && await p.evaluate(()=>window.__xss===undefined));
  ok("…and in what it covers", (await t.txt("#sn_dates")).includes('<img src=x onerror="window.__xss=1">Boat filings, <b>Odd</b> only'), await t.txt("#sn_dates"));
  await p.focus("#nw_snap_fsb"); await p.keyboard.press("Enter"); await p.waitForTimeout(100);
  await p.focus('#nw_snap_fss input[data-id="2"]'); await p.keyboard.press("Space"); await p.waitForTimeout(100);
  ok("keyboard: Enter opens the statuses, Space ticks one", same(await t.chips("fs"),["Pending","<b>Odd</b>"]) || same((await t.chips("fs")).sort(),["<b>Odd</b>","Pending"]));
  ok("screen readers: each list is a labelled group, and the button says what it controls", (await p.getAttribute("#nw_snap_fsp","aria-label"))==="Choose statuses" && (await p.getAttribute("#nw_snap_fsb","aria-controls"))==="nw_snap_fsp" && (await p.getAttribute("#nw_snap_fsb","aria-expanded"))==="true");
  await t.ctx.close();

  // ----- 1440px and 390px -----
  for(const width of [1440, 390]){
    t=await open({width}); p=t.p;
    await t.group();
    await t.states("FL","TX","GA","SC"); await t.types("101","102"); await t.pick("ft","11","12","13","14"); await t.pick("fs","1","2","3");
    await p.click("#nw_snap_ftb"); await p.waitForTimeout(150);
    ok(`${width}px: no sideways scroll with every chip and a list open`, await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
    const box=await p.$eval("#nw_snap",e=>{ const r=e.getBoundingClientRect(); return {w:r.width, cols:[...e.querySelectorAll(".nwcol")].map(c=>Math.round(c.getBoundingClientRect().left))}; });
    ok(`${width}px: the four filters sit in ${width<700?"one column":"two columns"}`, width<700 ? new Set(box.cols).size===1 : new Set(box.cols).size===2, box);
    await p.click("#nw_snap_ftb"); await p.waitForTimeout(80);
    await (await p.$("#nw_snap")).screenshot({path:OUTDIR+`/morefilters-snapshot-${width}.png`});
    await t.run();
    ok(`${width}px: no sideways scroll with a narrowed result`, await t.noScroll());
    await t.ctx.close();
  }

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
