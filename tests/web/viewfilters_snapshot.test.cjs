// "Narrow it down" on the Snapshot view: the default is unchanged (every state, every type, the same search as before);
// choosing states (list, map, regions) and types of insurance (S&P's list, filtered as you type) as removable chips;
// the search really carries states and typeOfInsuranceIds; the estimate says what is true; every place that describes
// the result names the scope (heading, what was searched, the map, the empty-result note, Ask Claude, the export, the
// Filings hand-off, the snapshots kept in this browser); after a search, a narrower choice narrows what is shown at once
// with "Show everything", and a wider one offers a new search; S&P's lists not loaded; hostile names; keyboard; 1440px
// and 390px. Nothing touches the network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("snapshot_search.json"), RES=FIX("snapshot_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const copy=o=>JSON.parse(JSON.stringify(o)), same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const GROUP_SEARCH={action:"search", companyIds:[], institutionIds:[5000001,5000002,5000003], states:["CA","FL","GA","NY","SC","TX"], from:"2023-11-15", to:"2026-11-13"};
const TOI=Object.fromEntries(REFS.lists.typeOfInsurance.options.map(o=>[o.id,o.name]));
// S&P, made up: the fixture's rows for the states and types of insurance asked for
function answer(body){
  const a=copy(SEARCH), ids=body.typeOfInsuranceIds||[];
  a.rows=a.rows.filter(r=>body.states.includes(r.serffFilingStateId) && (!ids.length || ids.some(id=>TOI[id]===r.typeOfInsurance)));
  a.params={...a.params, states:body.states, typeOfInsuranceIds:ids}; a.total=a.rows.length;
  return {status:200, body:a};
}
const uniq=rows=>new Set(rows.map(r=>r.filingVersionId||r.serffFilingEntityEventId)).size;

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", deviceScaleFactor:width<500?2:1, acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], refs:()=>copy(REFS), resolve:q=>/group/i.test(q) ? copy(RES.byGroup) : copy(RES.byName), search:answer, ...over};
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
      if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },{});
    await p.goto(BASE+(over.hash||"#snapshot")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.searches=()=>t.calls.filter(c=>c.fn==="snl-filings" && c.body.action==="search").map(c=>c.body);
    t.group=async()=>{ await p.fill("#sn_find","Calloway"); await p.press("#sn_find","Enter"); await p.waitForTimeout(200); await p.click('[data-act="snap-group"] >> nth=0'); await p.waitForTimeout(250); };
    t.run=async()=>{ await p.click("#sn_run"); await p.waitForTimeout(450); };
    t.states=async(...ss)=>{ if(!(await p.$("#nw_snap_stp"))) await p.click("#nw_snap_stb"); for(const s of ss) await p.click(`#nw_snap_states [data-s="${s}"]`); await p.click("#nw_snap_stDone"); await p.waitForTimeout(80); };
    t.types=async(...ids)=>{ if(!(await p.$("#nw_snap_toip"))) await p.click("#nw_snap_toib"); for(const id of ids) await p.click(`#nw_snap_tois input[data-id="${id}"]`); await p.click("#nw_snap_toiDone"); await p.waitForTimeout(80); };
    return t;
  }

  // ----- the default: as before -----
  let t=await open(); let p=t.p;
  ok("the form has Narrow it down, saying plainly that nothing is narrowed", (await t.txt("#nw_snap_h"))==="Narrow it down" && (await t.txt("#nw_snap_allst"))==="All states" && (await t.txt("#nw_snap_alltoi"))==="All types of insurance");
  ok("no panel is open to start with", !(await p.$("#nw_snap_stp")) && !(await p.$("#nw_snap_toip")) && (await p.getAttribute("#nw_snap_stb","aria-expanded"))==="false");
  await t.group();
  ok("what it covers and costs reads as before", (await t.txt("#sn_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in all 6 states in S&P's list, every filing type and status." && (await t.txt("#sn_cost")).startsWith("About 3 S&P requests (") && !(await t.txt("#sn_cost")).includes("Narrowing"));
  await t.run();
  ok("untouched, the search is exactly as before: every state, no type of insurance", same(t.searches(),[GROUP_SEARCH]), t.searches());
  ok("…and the result says nothing about narrowing", !(await p.$("#snScope")) && !(await p.$("#snapShown")) && !(await p.$("#snapWider")));

  // ----- choosing states: the list, the map, a region; chips that can be removed -----
  await p.click("#nw_snap_stb"); await p.waitForTimeout(100);
  ok("Choose states opens the map and the list; the button says it is open; focus goes to the box that finds a state", (await p.getAttribute("#nw_snap_stb","aria-expanded"))==="true" && !!(await p.$("#nw_snap_map")) && await p.evaluate(()=>document.activeElement.id==="nw_snap_stq"));
  ok("the list holds S&P's states, each a toggle button", same(await p.$$eval("#nw_snap_states .strow",e=>e.map(x=>x.dataset.s+":"+x.getAttribute("aria-pressed"))),["CA:false","FL:false","GA:false","NY:false","SC:false","TX:false"]));
  ok("on the map a state not in S&P's list can't be chosen", await p.evaluate(()=>{ const w=document.querySelector('#nw_snap_map path:not([data-s])'); return !!w && w.classList.contains("off"); }));
  await p.fill("#nw_snap_stq","tex"); await p.waitForTimeout(100);
  ok("typing finds a state by name", same(await p.$$eval("#nw_snap_states .strow",e=>e.map(x=>x.dataset.s)),["TX"]));
  await p.fill("#nw_snap_stq",""); await p.waitForTimeout(80);
  await p.click('#nw_snap_states [data-s="FL"]'); await p.click('#nw_snap_map path[data-s="TX"]'); await p.waitForTimeout(80);
  ok("a row and the map both choose a state", (await p.getAttribute('#nw_snap_states [data-s="FL"]',"aria-pressed"))==="true" && (await p.getAttribute('#nw_snap_states [data-s="TX"]',"aria-pressed"))==="true");
  await p.click('[data-act="nw-region"][data-r="South"]'); await p.waitForTimeout(80);
  ok("a region adds its states that are in S&P's list", same(await p.$$eval("#nw_snap .nwcol:first-child .cchip b",e=>e.map(x=>x.textContent)),["Florida","Georgia","South Carolina","Texas"]));
  await p.click('#nw_snap [data-act="nw-st-x"][data-id="GA"]'); await p.click('#nw_snap [data-act="nw-st-x"][data-id="SC"]'); await p.waitForTimeout(80);
  ok("a chip removes its state, and says which in its label", same(await p.$$eval("#nw_snap .nwcol:first-child .cchip b",e=>e.map(x=>x.textContent)),["Florida","Texas"]) && !!(await p.$('[aria-label="Remove Florida"]')));
  ok("the estimate restates the scope, keeps the number and says why it doesn't fall", (await t.txt("#sn_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in Florida and Texas, every filing type and status." && (await t.txt("#sn_cost")).startsWith("About 3 S&P requests (")
    && (await t.txt("#sn_cost")).includes("Narrowing the states or types doesn't change that number, which depends on the companies and years; it means fewer filings come back"));

  // ----- choosing types of insurance from S&P's list -----
  await p.click("#nw_snap_toib"); await p.waitForTimeout(100);
  ok("Choose types opens S&P's list (the states panel closes) with a box that filters it", !(await p.$("#nw_snap_stp")) && (await p.$$("#nw_snap_tois label")).length===14 && await p.evaluate(()=>document.activeElement.id==="nw_snap_toiq"));
  await p.fill("#nw_snap_toiq","home"); await p.waitForTimeout(100);
  ok("typing filters the list", same(await t.list("#nw_snap_tois label"),["Homeowners"]));
  await p.click('#nw_snap_tois input[data-id="101"]'); await p.click("#nw_snap_toiDone"); await p.waitForTimeout(80);
  ok("the chosen type is a chip; Done closes the list and gives focus back", same(await p.$$eval("#nw_snap .nwcol:nth-child(2) .cchip b",e=>e.map(x=>x.textContent)),["Homeowners"]) && !(await p.$("#nw_snap_toip")) && await p.evaluate(()=>document.activeElement.id==="nw_snap_toib"));
  ok("what it covers names the type", (await t.txt("#sn_dates"))==="Filings published 15 Nov 2023 to 13 Nov, in Florida and Texas, homeowners only, every filing type and status.");
  await t.run();
  const s1=t.searches().at(-1);
  ok("the search carries the states and the type of insurance, by S&P's id", same(s1,{...GROUP_SEARCH, states:["FL","TX"], typeOfInsuranceIds:[101]}), s1);
  const want=SEARCH.rows.filter(r=>["FL","TX"].includes(r.serffFilingStateId) && r.typeOfInsurance==="Homeowners");
  ok("the snapshot counts what came back", (await t.txt('#snTiles [data-k="n"] b'))===String(uniq(want)), await t.txt('#snTiles [data-k="n"] b'));
  ok("the heading and what was searched say the scope", (await t.txt("#snScope"))==="FL and TX, homeowners" && (await t.txt("#snMeta")).includes("searched in Florida and Texas · homeowners only · every filing type and status"), await t.txt("#snMeta"));
  ok("on the map a state not searched is drawn as not searched, never as nothing returned", await p.evaluate(()=>{ const g=document.querySelector('#snMapSvg path[data-s="GA"]'); return g.classList.contains("ns") && /not searched: this snapshot was narrowed to Florida and Texas/.test(g.querySelector("title").textContent); })
    && (await t.list("#snMapKey li")).includes("Not searched: outside what this snapshot was narrowed to"));
  ok("no 'showing' line: what is shown is what was searched", !(await p.$("#snapShown")) && !(await p.$("#snapWider")));

  // the hand-offs say the same scope
  const dl=p.waitForEvent("download"); await p.click('[data-act="export"][data-what="snap"][data-tbl="filings"][data-fmt="csv"]'); const file=await dl;
  ok("the export's name carries the scope", /^snl-snapshot-calloway-group-snl-p-c-group-fl-and-tx-homeowners-filings-2026-11-13\.csv$/.test(file.suggestedFilename()), file.suggestedFilename());
  await p.click("#sn_ask"); await p.waitForTimeout(200);
  ok("Ask about this names the scope", /since Nov 2023 in Florida and Texas, homeowners/.test(await p.inputValue("#ask_input")), await p.inputValue("#ask_input"));
  ok("Ask Claude is told the search with its type of insurance", await p.evaluate(()=>{ const s=snapScreen(); return JSON.stringify(s.search.states)==='["FL","TX"]' && JSON.stringify(s.search.typeOfInsuranceIds)==="[101]"; }));
  ok("the line under the question names the scope", await p.evaluate(()=>/in Florida and Texas, homeowners only, every filing type/.test(snapToldText(snapScreen(), false))));
  await p.keyboard.press("Escape"); await p.evaluate(()=>{ S.ask.open=false; render(); });
  ok("the snapshot kept in this browser names its scope", (await t.txt("#sn_recent li >> nth=0")).includes("FL and TX, homeowners"));
  await p.click("#sn_toFilings"); await p.waitForTimeout(300);
  ok("See every filing on the Filings view carries the states and the type", await p.evaluate(()=>JSON.stringify(S.f.states)==='["FL","TX"]' && JSON.stringify(S.f.toi)==='["101"]') && same(t.searches().at(-1),s1));
  await p.goto(BASE+"#snapshot"); await p.waitForTimeout(400);

  // ----- an empty narrowed result names its scope -----
  t.search=body=>{ const a=answer(body); a.body.rows=[]; a.body.total=0; return a; };
  await p.evaluate(()=>{ S.snap.res=null; S.snap.ran=null; render(); });
  await t.run();
  ok("S&P returned nothing: the note names the scope and says it says nothing about other states or types", (await t.txt("#snEmpty b")).startsWith("S&P returned nothing for this search of Florida and Texas, homeowners")
    && (await t.txt("#snEmpty")).includes("so it says nothing about other states or types of insurance"), await t.txt("#snEmpty"));
  ok("the empty question to Claude names the scope too", await p.evaluate(()=>/which covers Florida and Texas, homeowners only/.test(snapAskQs().all)));
  await ctx_close(t);

  // ----- after a search: narrowing what is shown, Show everything, and a wider choice -----
  t=await open(); p=t.p;
  await t.group(); await t.run();
  const n0=await t.txt('#snTiles [data-k="n"] b'), calls=t.searches().length;
  await t.states("FL");
  const fl=SEARCH.rows.filter(r=>r.serffFilingStateId==="FL");
  ok("choosing a state inside what was searched narrows what is shown at once, without asking S&P", t.searches().length===calls && (await t.txt('#snTiles [data-k="n"] b'))===String(uniq(fl)));
  ok("…and says so, with the count of what was searched", (await t.txt("#snapShown")).startsWith(`Showing FL, all types: ${uniq(fl)} of ${n0} filings.`) && (await t.txt("#snapShown")).includes("without asking S&P again"), await t.txt("#snapShown"));
  ok("…the map shows the other states as not shown, and the tile counts states shown", await p.evaluate(()=>/not shown: this page is narrowed to Florida/.test(document.querySelector('#snMapSvg path[data-s="GA"] title').textContent)) && same(await t.list('#snTiles [data-k="states"] span'),["States with filings","of 1 state shown"]));
  ok("…the meta still says what was searched", (await t.txt("#snMeta")).includes("6 states searched"));
  await t.types("101");
  const flho=fl.filter(r=>r.typeOfInsurance==="Homeowners");
  ok("a type narrows too, matched by S&P's name for it", (await t.txt("#snapShown")).startsWith(`Showing FL, homeowners: ${uniq(flho)} of ${n0} filings.`) && t.searches().length===calls, await t.txt("#snapShown"));
  const dl2=p.waitForEvent("download"); await p.click('[data-act="export"][data-what="snap"][data-tbl="filings"][data-fmt="csv"]'); const f2=await dl2;
  ok("an export of a narrowed page holds what is shown, and says so in its name", /-fl-homeowners-filings-/.test(f2.suggestedFilename()) && fs.readFileSync(await f2.path(),"utf8").trim().split("\r\n").length===uniq(flho)+1, f2.suggestedFilename());
  await p.click('#snapShown [data-act="nw-show-all"]'); await p.waitForTimeout(150);
  ok("Show everything puts it back: every filing, every chip gone", (await t.txt('#snTiles [data-k="n"] b'))===n0 && !(await p.$("#snapShown")) && (await t.txt("#nw_snap_allst"))==="All states" && (await t.txt("#nw_snap_alltoi"))==="All types of insurance");
  // a search narrowed to FL and TX, then a wider choice
  await t.states("FL","TX"); await t.run();
  await t.states("GA");
  ok("a state that wasn't searched: offers a new search, and says what is below", (await t.txt("#snapWider")).startsWith("You've chosen more than this snapshot searched: GA. What is below covers only what was searched.") && !(await p.$("#snapShown")), await t.txt("#snapWider"));
  await p.click('#snapWider [data-act="nw-research"]'); await p.waitForTimeout(450);
  ok("Search again asks S&P for the wider choice", same(t.searches().at(-1).states,["FL","GA","TX"]) && !(await p.$("#snapWider")));
  await p.click('#nw_snap [data-act="nw-st-all"] >> nth=0'); await p.waitForTimeout(100);
  ok("every state, after a narrowed search, is wider too", (await t.txt("#snapWider")).includes("every state"));
  // reopening a kept snapshot puts its scope back
  await p.click('[data-act="snap-recent"] >> nth=1'); await p.waitForTimeout(450);
  ok("reopening a kept snapshot chooses its states again", same(await p.$$eval("#nw_snap .nwcol:first-child .cchip b",e=>e.map(x=>x.textContent)),["Florida","Texas"]) && same(t.searches().at(-1).states,["FL","TX"]));
  await ctx_close(t);

  // ----- S&P's lists not loaded; hostile names -----
  t=await open({refs:()=>{ const r=copy(REFS); delete r.lists.typeOfInsurance; return r; }}); p=t.p;
  ok("without S&P's list of types: says the filter is left out, and the button can't open it", (await t.txt("#nw_snap_toioff"))==="S&P's lists aren't loaded yet, so this filter is left out of the search." && await p.$eval("#nw_snap_toib",e=>e.disabled));
  await p.evaluate(()=>{ S.snap.nw.tois=["101"]; render(); });
  await t.group(); await t.run();
  ok("…and a type chosen earlier isn't sent", !("typeOfInsuranceIds" in t.searches().at(-1)));
  await ctx_close(t);
  t=await open({refs:()=>{ const r=copy(REFS); r.lists.typeOfInsurance.options.push({id:199, name:'<img src=x onerror="window.__xss=1">Boat'}); return r; }}); p=t.p;
  await t.types("199");
  ok("a hostile type name shows as text, in the list and the chip", !(await p.$("#nw_snap img")) && (await t.txt("#nw_snap .cchip b")).startsWith("<img") && await p.evaluate(()=>window.__xss===undefined));
  // keyboard: the controls are buttons and checkboxes reached by Tab and used with Enter or Space
  await p.focus("#nw_snap_stb"); await p.keyboard.press("Enter"); await p.waitForTimeout(100);
  await p.focus('#nw_snap_states [data-s="SC"]'); await p.keyboard.press("Space"); await p.waitForTimeout(100);
  ok("keyboard: Enter opens the states, Space chooses one, and focus stays on it", (await p.getAttribute('#nw_snap_states [data-s="SC"]',"aria-pressed"))==="true" && await p.evaluate(()=>document.activeElement.id==="nw_snap_st_SC"));
  ok("screen readers: the map is hidden from them, the list is a labelled group of toggle buttons", (await p.getAttribute("#nw_snap_map","aria-hidden"))==="true" && (await p.getAttribute("#nw_snap_states","aria-label"))==="States");
  await ctx_close(t);

  // ----- 1440px and 390px -----
  for(const width of [1440, 390]){
    t=await open({width}); p=t.p;
    await t.group();
    await t.states("FL","TX","GA","SC","CA","NY"); await t.types("101","102","109");
    await p.click("#nw_snap_stb"); await p.waitForTimeout(150);
    ok(`${width}px: no sideways scroll with every chip and the map open`, await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
    await p.screenshot({path:OUTDIR+`/viewfilters-snapshot-${width}.png`, fullPage:width<500});
    await p.click("#nw_snap_stb"); await t.run();
    ok(`${width}px: no sideways scroll with a narrowed result`, await t.noScroll());
    await ctx_close(t);
  }

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
  async function ctx_close(x){ await x.ctx.close(); }
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
