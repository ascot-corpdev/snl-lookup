// The state picker in the Filings form: a map of the United States on the left and the list of states on the
// right. A click on a state does what its button in the list does, and each shows what the other chose. Covers
// states S&P's list doesn't have, the built-in list when S&P's hasn't loaded, what a search sends, state names
// from S&P as text, the phone layout, and that the map is left to the list for keyboards and screen readers.
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
    t.onMap=async()=>p.$$eval("#stateMap path.on",e=>e.map(x=>x.dataset.s).sort());
    t.pressed=async()=>p.$$eval('#states [aria-pressed="true"]',e=>e.map(x=>x.dataset.s).sort());
    // a real click on the state's own ground: where its label sits on the drawing
    t.clickState=async c=>{ const pt=await p.evaluate(c=>{ const svg=document.getElementById("stateMap"); svg.scrollIntoView({block:"center"}); const r=svg.getBoundingClientRect(), m=US_MAP[c]; return {x:r.left+m[2]/975*r.width, y:r.top+m[3]/610*r.height}; },c); await p.mouse.click(pt.x, pt.y); await p.waitForTimeout(80); };
    t.box=async sel=>p.$eval(sel,e=>{ const r=e.getBoundingClientRect(); return {l:r.left, t:r.top, r:r.right, b:r.bottom, w:r.width}; });
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    return t;
  }

  // ----- S&P's list of states is loaded (six states in the made-up list) -----
  let t=await open(); let p=t.p;
  ok("a map of every state and DC", (await p.$$("#stateMap path")).length===51 && (await p.getAttribute("#stateMap","viewBox"))==="0 0 975 610");
  ok("only the states in S&P's list can be chosen on the map", same(await p.$$eval("#stateMap path[data-act]",e=>e.map(x=>x.dataset.s).sort()),["CA","FL","GA","NY","SC","TX"]) && (await p.$$("#stateMap path.off")).length===45);
  const mb=await t.box(".stmapbox"), lb=await t.box(".stlist");
  ok("the map is on the left and the list on its right, starting level", mb.r<=lb.l && Math.abs(mb.t-lb.t)<2 && mb.w>400, {mb, lb});
  ok("nothing chosen to begin with", same(await t.onMap(),[]) && same(await t.pressed(),[]) && !(await p.$("#statesChosen")));
  ok("says how to use it", (await t.txt("#stateMapNote"))==="Click a state on the map, or choose it from the list.");
  await t.clickState("FL");
  ok("a click on the map chooses the state in the list too", same(await t.onMap(),["FL"]) && same(await t.pressed(),["FL"]) && (await t.txt("#searchForm")).includes("States 1 chosen"));
  ok("the chosen states are named under the list", (await t.txt("#statesChosen"))==="Chosen: Florida.", await t.txt("#statesChosen"));
  await p.click('#states [data-s="GA"]'); await p.waitForTimeout(80);
  ok("a click in the list shows on the map", same(await t.onMap(),["FL","GA"]) && (await p.getAttribute('#stateMap text.on >> nth=0',"class")).includes("on"));
  await t.clickState("FL");
  ok("a second click on the map takes the state off again", same(await t.onMap(),["GA"]) && same(await t.pressed(),["GA"]));
  await t.clickState("WY");
  ok("a state S&P's list doesn't have can't be chosen", same(await t.onMap(),["GA"]) && same(await t.pressed(),["GA"]) && !(await p.getAttribute('#stateMap path >> nth=0',"tabindex")));
  ok("the pointer names each state, and says when it can't be chosen", (await p.$eval('#stateMap path[data-s="FL"] title',e=>e.textContent))==="Florida (FL)"
    && (await p.$$eval("#stateMap path.off title",e=>e.map(x=>x.textContent))).includes("Wyoming (WY) isn't in S&P's list of states"));
  await p.click('button[data-act="state-all"]'); await p.waitForTimeout(80);
  ok("Choose all fills the map", same(await t.onMap(),["CA","FL","GA","NY","SC","TX"]));
  await p.click('button[data-act="state-none"]'); await p.waitForTimeout(80);
  ok("Clear empties it", same(await t.onMap(),[]) && !(await p.$("#statesChosen")));
  ok("the map is left to the list for keyboards and screen readers", (await p.getAttribute("#stateMap","aria-hidden"))==="true" && (await p.$$("#stateMap [tabindex]")).length===0 && (await p.$$("#states button")).length===6);
  // what a search sends
  await p.fill("#f_q","4000001"); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click('#byId button >> nth=0');
  await t.clickState("TX"); await t.clickState("FL");
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("a search sends the states chosen on the map", same(t.calls.filter(c=>c.body.action==="search").map(c=>c.body.states),[["FL","TX"]]));
  await p.screenshot({path:path.join(OUTDIR,"statemap-1440.png")});
  await t.ctx.close();

  // ----- S&P's list hasn't loaded: the built-in list, with every state on the map -----
  t=await open({refsStatus:500}); p=t.p;
  ok("built-in list: every state on the map can be chosen", (await p.$$("#stateMap path[data-act]")).length===51 && (await p.$$("#stateMap path.off")).length===0 && (await p.$$("#states button")).length===51);
  ok("built-in list: the buttons carry the state's name", (await p.getAttribute('#states [data-s="FL"]',"title"))==="Florida" && (await p.getAttribute('#states [data-s="DC"]',"title"))==="District of Columbia");
  await t.clickState("TX"); await t.clickState("CA");
  ok("built-in list: map and list agree, and the names show", same(await t.onMap(),["CA","TX"]) && same(await t.pressed(),["CA","TX"]) && (await t.txt("#statesChosen"))==="Chosen: California, Texas.");
  await p.click('button[data-act="state-all"]'); await p.waitForTimeout(80);
  ok("many chosen: the first twelve are named and the rest counted", (await t.txt("#statesChosen")).endsWith("and 39 more.") && (await t.onMap()).length===51, await t.txt("#statesChosen"));
  await t.ctx.close();

  // ----- a state name from S&P is shown as text -----
  const HOSTILE='<img src=x onerror="window.__xss=1"> & "Florida"';
  const refs=copy(REFS); refs.lists.serffFilingState.options=refs.lists.serffFilingState.options.map(o=>String(o.id).toUpperCase()==="FL" ? {...o, name:HOSTILE} : o);
  t=await open({refs}); p=t.p;
  await t.clickState("FL");
  ok("a name from S&P stays text on the map, in the list and under it", (await p.$eval('#stateMap path[data-s="FL"] title',e=>e.textContent))===HOSTILE+" (FL)" && (await p.getAttribute('#states [data-s="FL"]',"title"))===HOSTILE
    && (await t.txt("#statesChosen"))==="Chosen: "+HOSTILE+"." && !(await p.$("#searchForm img")) && !(await p.evaluate(()=>window.__xss)));
  await t.ctx.close();

  // ----- a phone -----
  t=await open({width:390}); p=t.p;
  const m3=await t.box(".stmapbox"), l3=await t.box(".stlist");
  ok("390px: the list sits under the map, and nothing scrolls sideways", l3.t>=m3.b && m3.r<=390 && l3.r<=390 && await t.noScroll(), {m3, l3});
  ok("390px: the labels are left off the small map", await p.$eval("#stateMap text",e=>getComputedStyle(e).display)==="none");
  await p.$eval("#stateMap",e=>e.scrollIntoView({block:"center"})); await p.waitForTimeout(80);
  const y0=await p.evaluate(()=>window.scrollY);
  await t.clickState("TX");
  ok("390px: a tap on the map chooses the state without moving the page to the list", same(await t.onMap(),["TX"]) && same(await t.pressed(),["TX"]) && Math.abs((await p.evaluate(()=>window.scrollY))-y0)<2, {y0, y1:await p.evaluate(()=>window.scrollY)});
  await p.$eval("#stateMap",e=>e.scrollIntoView({block:"start"})); await p.screenshot({path:path.join(OUTDIR,"statemap-390.png")});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
