// The state picker in the Filings form: a large map of the United States on the left and a scrollable list of
// states on the right, one per row with its name and code. A click on a state does what its row in the list does,
// and each shows what the other chose. Covers the layout at 1440px, 1280px and 390px, the list scrolling inside its
// own box and keeping its place, the map bringing a row into view without moving the page, the keyboard, states
// S&P's list doesn't have, the built-in list when S&P's hasn't loaded, what a search sends, state names from S&P
// as text, and that the map is left to the list for keyboards and screen readers.
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

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], refs:copy(REFS), refsStatus:200, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(body.action==="reference") return t.refsStatus===200 ? J(200,t.refs) : J(t.refsStatus,{error:"server",message:"The filings function failed: made-up fault"});
        if(body.action==="resolve") return J(200,{query:body.q, matches:[], note:"No saved company matches."});
        if(body.action==="search") return J(200,copy(SEARCH));
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.onMap=async()=>p.$$eval("#stateMap path.on",e=>e.map(x=>x.dataset.s).sort());
    t.pressed=async()=>p.$$eval('#states [aria-pressed="true"]',e=>e.map(x=>x.dataset.s).sort());
    // a real click on the state's own ground: where its label sits on the drawing (stay=true: don't scroll the map into view first)
    t.clickState=async(c,stay)=>{ const pt=await p.evaluate(([c,stay])=>{ const svg=document.getElementById("stateMap"); if(!stay) svg.scrollIntoView({block:"center"}); const r=svg.getBoundingClientRect(), m=US_MAP[c]; return {x:r.left+m[2]/975*r.width, y:r.top+m[3]/610*r.height}; },[c,!!stay]); await p.mouse.click(pt.x, pt.y); await p.waitForTimeout(80); };
    t.box=async sel=>p.$eval(sel,e=>{ const r=e.getBoundingClientRect(); return {l:r.left, t:r.top, r:r.right, b:r.bottom, w:r.width, h:r.height}; });
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.list=async()=>p.$eval("#states",e=>({top:e.scrollTop, h:e.clientHeight, sh:e.scrollHeight, overflow:getComputedStyle(e).overflowY}));
    t.y=async()=>p.evaluate(()=>window.scrollY);
    t.focused=async()=>p.evaluate(()=>{ const a=document.activeElement; return a&&a.closest("#states") ? a.dataset.s : null; });
    // is the row wholly inside the list's visible box?
    t.rowShown=async s=>p.evaluate(s=>{ const box=document.getElementById("states").getBoundingClientRect(), r=document.querySelector(`#states [data-s="${s}"]`).getBoundingClientRect(); return r.top>=box.top-1 && r.bottom<=box.bottom+1; },s);
    return t;
  }

  // ----- S&P's list of states is loaded (six states in the made-up list) -----
  let t=await open(); let p=t.p;
  ok("a map of every state and DC", (await p.$$("#stateMap path")).length===51 && (await p.getAttribute("#stateMap","viewBox"))==="0 0 975 610");
  ok("only the states in S&P's list can be chosen on the map", same(await p.$$eval("#stateMap path[data-act]",e=>e.map(x=>x.dataset.s).sort()),["CA","FL","GA","NY","SC","TX"]) && (await p.$$("#stateMap path.off")).length===45);
  let mb=await t.box(".stmapbox"), lb=await t.box(".stlist"), fb=await t.box("#searchForm");
  ok("1440px: the map is on the left and the list on its right, starting level", mb.r<=lb.l && Math.abs(mb.t-lb.t)<2, {mb, lb});
  ok("1440px: the map is large, about two thirds of the form", mb.w>=760 && mb.w/fb.w>0.58 && mb.w/fb.w<0.72, {mw:mb.w, fw:fb.w});
  ok("1440px: the map isn't too tall", mb.h<=560, mb);
  ok("1440px: the map's labels are readable", await p.$eval('#stateMap text',e=>e.getBoundingClientRect().height>=11));
  ok("the list is one state per row with its name and code", same(await t.all("#states button"),["California CA","Florida FL","Georgia GA","New York NY","South Carolina SC","Texas TX"])
    && same(await p.$$eval("#states button",e=>[...new Set(e.map(x=>Math.round(x.getBoundingClientRect().left)))].length),1), await t.all("#states button"));
  ok("the rows are native toggle buttons in a named group", (await p.getAttribute("#states","role"))==="group" && (await p.getAttribute("#states","aria-label"))==="States"
    && (await p.$$eval("#states button",e=>e.every(x=>x.type==="button" && x.dataset.act==="state-toggle" && x.getAttribute("aria-pressed")==="false"))));
  ok("nothing chosen to begin with", same(await t.onMap(),[]) && same(await t.pressed(),[]) && (await t.txt("#statesCount"))==="0 of 6 chosen");
  ok("Choose all and Clear sit above the list", (await t.box('button[data-act="state-all"]')).b<=(await t.box("#states")).t && (await t.box('button[data-act="state-none"]')).b<=(await t.box("#states")).t);
  ok("the line naming the chosen states is gone: the list names them", !(await p.$("#statesChosen")));
  ok("says how to use it", (await t.txt("#stateMapNote"))==="Click a state on the map, or choose it from the list.");
  await t.clickState("FL");
  ok("a click on the map chooses the state in the list too", same(await t.onMap(),["FL"]) && same(await t.pressed(),["FL"]) && (await t.txt("#searchForm")).includes("States 1 chosen") && (await t.txt("#statesCount"))==="1 of 6 chosen");
  ok("a chosen row is marked", await p.$eval('#states [data-s="FL"]',e=>{ const a=getComputedStyle(e), m=getComputedStyle(e,"::before"); return a.fontWeight==="700" && m.backgroundColor!==getComputedStyle(document.body).backgroundColor && getComputedStyle(e,"::after").content==='""'; })
    && await p.$eval('#states [data-s="GA"]',e=>getComputedStyle(e).fontWeight==="400" && getComputedStyle(e,"::after").content==="none"));
  await p.click('#states [data-s="GA"]'); await p.waitForTimeout(80);
  ok("a click in the list shows on the map", same(await t.onMap(),["FL","GA"]) && (await p.getAttribute('#stateMap text.on >> nth=0',"class")).includes("on"));
  await t.clickState("FL");
  ok("a second click on the map takes the state off again", same(await t.onMap(),["GA"]) && same(await t.pressed(),["GA"]));
  await t.clickState("WY");
  ok("a state S&P's list doesn't have can't be chosen, and isn't in the list", same(await t.onMap(),["GA"]) && same(await t.pressed(),["GA"]) && !(await p.$('#states [data-s="WY"]')) && !(await p.getAttribute('#stateMap path >> nth=0',"tabindex")));
  ok("the pointer names each state, and says when it can't be chosen", (await p.$eval('#stateMap path[data-s="FL"] title',e=>e.textContent))==="Florida (FL)"
    && (await p.$$eval("#stateMap path.off title",e=>e.map(x=>x.textContent))).includes("Wyoming (WY) isn't in S&P's list of states"));
  await p.click('button[data-act="state-all"]'); await p.waitForTimeout(80);
  ok("Choose all fills the map and the list", same(await t.onMap(),["CA","FL","GA","NY","SC","TX"]) && (await t.pressed()).length===6 && (await t.txt("#statesCount"))==="6 of 6 chosen");
  await p.click('button[data-act="state-none"]'); await p.waitForTimeout(80);
  ok("Clear empties them", same(await t.onMap(),[]) && same(await t.pressed(),[]));
  ok("the map is left to the list for keyboards and screen readers", (await p.getAttribute("#stateMap","aria-hidden"))==="true" && (await p.$$("#stateMap [tabindex]")).length===0 && (await p.$$("#states button")).length===6);
  // the keyboard: Tab reaches the rows, Space and Enter toggle, and the focus stays on the row
  await p.focus('#states [data-s="CA"]'); await p.keyboard.press("Tab");
  ok("keyboard: Tab moves to the next row", (await t.focused())==="FL");
  await p.keyboard.press("Space"); await p.waitForTimeout(80);
  ok("keyboard: Space chooses the row and keeps the focus on it", same(await t.pressed(),["FL"]) && (await t.focused())==="FL" && same(await t.onMap(),["FL"]));
  await p.keyboard.press("Enter"); await p.waitForTimeout(80);
  ok("keyboard: Enter takes it off again, focus still on it", same(await t.pressed(),[]) && (await t.focused())==="FL");
  // what a search sends
  await p.fill("#f_q","4000001"); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click('#byId button >> nth=0');
  await t.clickState("TX"); await t.clickState("FL");
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("a search sends the states chosen on the map", same(t.calls.filter(c=>c.body.action==="search").map(c=>c.body.states),[["FL","TX"]]));
  await t.ctx.close();

  // ----- S&P's list hasn't loaded: the built-in 50 states and DC, which scroll inside the list's box -----
  t=await open({refsStatus:500}); p=t.p;
  ok("built-in list: every state on the map can be chosen", (await p.$$("#stateMap path[data-act]")).length===51 && (await p.$$("#stateMap path.off")).length===0 && (await p.$$("#states button")).length===51);
  ok("built-in list: the rows carry the state's name", (await t.txt('#states [data-s="FL"]'))==="Florida FL" && (await t.txt('#states [data-s="DC"]'))==="District of Columbia DC");
  let L=await t.list(); mb=await t.box(".stmapbox"); lb=await t.box(".stlist");
  ok("1440px: the list scrolls inside its own box", L.overflow==="auto" && L.sh>L.h*2, L);
  ok("1440px: the list column is as tall as the map beside it", Math.abs(lb.h-mb.h)<=2 && Math.abs(lb.b-mb.b)<=2, {mb, lb});
  ok("1440px: the page doesn't grow by 51 rows", (await t.box("#searchForm")).h<mb.h+700, await t.box("#searchForm"));
  for(const c of ["TX","CA","NY","GA","FL"]) await t.clickState(c);
  ok("built-in list: map and list agree", same(await t.onMap(),["CA","FL","GA","NY","TX"]) && same(await t.pressed(),["CA","FL","GA","NY","TX"]) && (await t.txt("#statesCount"))==="5 of 51 chosen");
  await p.$eval("#searchForm",e=>e.scrollIntoView({block:"start"}));
  await p.screenshot({path:path.join(OUTDIR,"statemap-1440.png")});
  // the list keeps its place when a row is toggled, and neither it nor the page moves
  await p.$eval("#states",e=>e.scrollTop=420); await p.waitForTimeout(50);
  let top0=(await t.list()).top, y0=await t.y();
  const mid=await p.evaluate(()=>{ const box=document.getElementById("states").getBoundingClientRect(); return [...document.querySelectorAll("#states button")].find(r=>{ const b=r.getBoundingClientRect(); return b.top>box.top+40 && b.bottom<box.bottom-40; }).dataset.s; });
  await p.click(`#states [data-s="${mid}"]`); await p.waitForTimeout(80);
  ok("a click in the list keeps the list's scroll and the page still", (await t.list()).top===top0 && top0>0 && Math.abs((await t.y())-y0)<1 && (await t.pressed()).includes(mid) && (await t.focused())===mid, {top0, now:(await t.list()).top, y0, y1:await t.y(), mid});
  await p.click(`#states [data-s="${mid}"]`); await p.waitForTimeout(80);
  ok("a second click takes it off, still in place", (await t.list()).top===top0 && !(await t.pressed()).includes(mid));
  // a click on the map brings the state's row into view in the list, without moving the page
  await p.$eval("#states",e=>e.scrollTop=0); await p.waitForTimeout(50);
  ok("Wyoming's row starts out of sight", !(await t.rowShown("WY")));
  await p.$eval("#stateMap",e=>e.scrollIntoView({block:"center"})); y0=await t.y();
  await t.clickState("WY", true);
  ok("choosing on the map brings the row into view in the list", same((await t.pressed()).filter(s=>s==="WY"),["WY"]) && await t.rowShown("WY") && (await t.list()).top>0, await t.list());
  ok("choosing on the map doesn't move the page", Math.abs((await t.y())-y0)<1, {y0, y1:await t.y()});
  await t.clickState("AL", true);
  ok("and back up the list for a state near the top", await t.rowShown("AL") && (await t.pressed()).includes("AL") && Math.abs((await t.y())-y0)<1);
  ok("no sideways scroll at 1440px", await t.noScroll());
  await t.ctx.close();

  // ----- 1280px -----
  t=await open({width:1280, refsStatus:500}); p=t.p;
  mb=await t.box(".stmapbox"); lb=await t.box(".stlist"); fb=await t.box("#searchForm");
  ok("1280px: map left, list right, the same height", mb.r<=lb.l && Math.abs(mb.t-lb.t)<2 && Math.abs(lb.h-mb.h)<=2 && mb.w>=700 && lb.w>=300, {mb, lb, fb});
  ok("1280px: the list scrolls and nothing scrolls sideways", (await t.list()).sh>(await t.list()).h && await t.noScroll());
  for(const c of ["TX","CA","NY","GA","FL"]) await t.clickState(c);
  await p.$eval("#searchForm",e=>e.scrollIntoView({block:"start"})); await p.screenshot({path:path.join(OUTDIR,"statemap-1280.png")});
  await t.ctx.close();

  // ----- names: from S&P, from the map when S&P gives only the code, the code alone when neither has one -----
  const HOSTILE='<img src=x onerror="window.__xss=1"> & "Florida"';
  let refs=copy(REFS); refs.lists.serffFilingState.options=refs.lists.serffFilingState.options.map(o=>o.id==="FL" ? {...o, name:HOSTILE} : o.id==="GA" ? {...o, name:"GA"} : o).concat({id:"PR", name:"PR"});
  t=await open({refs}); p=t.p;
  ok("a state S&P names only by its code takes the map's name; one the map doesn't have shows the code alone", (await t.txt('#states [data-s="GA"]'))==="Georgia GA" && (await t.txt('#states [data-s="PR"]'))==="PR" && !(await p.$('#states [data-s="PR"] .stn')));
  await t.clickState("FL");
  ok("a name from S&P stays text on the map and in the list", (await p.$eval('#stateMap path[data-s="FL"] title',e=>e.textContent))===HOSTILE+" (FL)" && (await p.textContent('#states [data-s="FL"] .stn'))===HOSTILE
    && same(await t.pressed(),["FL"]) && !(await p.$("#searchForm img")) && !(await p.evaluate(()=>window.__xss)));
  await t.ctx.close();

  // ----- a phone -----
  t=await open({width:390, refsStatus:500}); p=t.p;
  const m3=await t.box(".stmapbox"), l3=await t.box(".stlist"), s3=await t.box("#states");
  ok("390px: the list sits under the map, and nothing scrolls sideways", l3.t>=m3.b && m3.r<=390 && l3.r<=390 && await t.noScroll(), {m3, l3});
  ok("390px: the list scrolls inside a box of a fixed height", Math.abs(s3.h-300)<=2 && (await t.list()).sh>(await t.list()).h, s3);
  ok("390px: the labels are left off the small map", await p.$eval("#stateMap text",e=>getComputedStyle(e).display)==="none");
  await p.$eval("#stateMap",e=>e.scrollIntoView({block:"center"})); await p.waitForTimeout(80);
  const py0=await t.y();
  await t.clickState("TX", true);
  ok("390px: a tap on the map chooses the state without moving the page to the list", same(await t.onMap(),["TX"]) && same(await t.pressed(),["TX"]) && Math.abs((await t.y())-py0)<2, {py0, y1:await t.y()});
  for(const c of ["CA","NY","GA","FL"]) await t.clickState(c, true);
  ok("390px: no sideways scroll with states chosen", await t.noScroll());
  await p.$eval("#stateMap",e=>e.scrollIntoView({block:"start"})); await p.screenshot({path:path.join(OUTDIR,"statemap-390.png")});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
