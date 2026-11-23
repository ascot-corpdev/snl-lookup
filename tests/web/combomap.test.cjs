// The Combination view's state map (Corp Dev only): the pro forma's direct premiums written on a map of the US states
// and DC, with what is shown (pro forma, either side, the target's share, who writes it), a line-of-business filter,
// the year, hover, focus and a pinned state, the small states beside the map, a sortable table and its export.
// Covers: the map with all lines from premiums by state, agreeing with the table of states, and the filter off until
// premiums by state and line are mapped; one line, several lines and Clear; every "what is shown" choice against
// hand-worked numbers; a state only one side writes; a side missing, not mapped, cut short at the row limit, still
// arriving, failed then retried, and late; a year change fetching once a side a year; hover, focus, pin and unpin by
// mouse, keyboard and touch; the small states; the table and exports following the filter; premiums by state and line
// that don't add up to premiums by state; nothing about the pair written or sent beyond each side's own statutory
// look-ups; an ordinary login; hostile line and state names kept as text; 1440 and 390 wide.
// Every company, code and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), F=FIX("combination_figures.json"), SL=FIX("combomap_state_lines.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG=()=>`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const NOT_RUN="Not run: the query ran out of time. Run it again, or ask for fewer fields.";
const M=1e6, ID="dpw_by_state_line";
const PCT=new Set(["loss_ratio","loss_lae_ratio","expense_ratio","combined_ratio","rbc_ratio","roae","investment_yield","commission_ratio"]);
const GROUP_BASE={kind:"group", codes:["9001"], label:"Calloway Group"};
// The Combination figures, with the target also writing $20M of homeowners in Rhode Island (a small state), and its
// homeowners and farmowners split as the state-by-line figures have them.
const FIG=copy(F); FIG.codes["90107"].dpw_by_state["2025"].RI=20; FIG.codes["90107"].dpw_by_line["2025"]={Homeowners:160, Farmowners:110};
const statusWith=mapped=>({...copy(STAT.statusMapped), companies:{mapped:false, problem:null}, fields:[...copy(STAT.statusMapped.fields), {id:ID, label:"Direct premiums written by state and line", unit:"usd", by:"state_line", mapped}]});
const rgb=h=>`rgb(${parseInt(h.slice(1,3),16)}, ${parseInt(h.slice(3,5),16)}, ${parseInt(h.slice(5,7),16)})`;
const BLUES=["#C6DBEF","#9ECAE1","#4292C6","#2171B5","#08306B"], ORANGES=["#FDD0A2","#FDAE6B","#F16913","#D94801","#7F2704"];

/* The statutory function's answer to one query. By-year, by-line and by-state figures from FIG (o.unmapped field ids);
   premiums by state and line from SL, for the one year asked (o.sl: {code: rows} to replace, o.slTruncated: codes cut
   short, o.slUnmapped, o.slPending). */
function answer(body, o={}){
  const dim=id=>/_by_line$/.test(id)?"line":/_by_state$/.test(id)?"state":/_by_reinsurer$/.test(id)?"item":null;
  let truncated=false;
  const fields=(body.fields||[]).map(id=>{
    if(id===ID){
      const f={id, label:"Direct premiums written by state and line", unit:"usd", by:"state_line", mapped:!o.slUnmapped, error:null, rows:[]};
      if(!f.mapped) return f;
      if(o.slPending){ f.error=NOT_RUN; return f; }
      for(const code of body.codes){
        if((o.slTruncated||[]).includes(code)) truncated=true;
        for(let y=body.fromYear;y<=body.toYear;y++){ const rows=(o.sl&&o.sl[code]&&o.sl[code][y]) || (SL.codes[code]||{})[y] || []; for(const [state,line,v] of rows) f.rows.push({code, year:y, line, state, value:v*M}); }
      }
      return f;
    }
    const f={id, label:id, unit:PCT.has(id)?"pct":"usd", by:dim(id)||"year", mapped:!(o.unmapped||[]).includes(id), error:null, rows:[]};
    if(!f.mapped) return f;
    for(const code of body.codes){
      const d=(FIG.codes[code]||{})[id]; if(!d) continue;
      for(const [y,v] of Object.entries(d)){
        const yr=+y; if(yr<body.fromYear || yr>body.toYear) continue;
        const row=(val, extra)=>({code, year:yr, line:null, state:null, value:PCT.has(id)?val:val*M, ...extra});
        const k=dim(id);
        if(k) for(const [name,val] of Object.entries(v)) f.rows.push(row(val, {[k]:name}));
        else for(const val of [].concat(v)) f.rows.push(row(val));
      }
    }
    return f;
  });
  const pending=fields.filter(f=>f.error===NOT_RUN).length;
  return {kind:body.kind, codes:body.codes, fromYear:body.fromYear, toYear:body.toYear, entities:body.codes.map(c=>({code:c, name:FIG.names[c]||null})), fields,
    loaded:[{view:"STAT_FINANCIALS", at:"2026-10-28"}], truncated, source:"S&P Global Market Intelligence statutory data, through Snowflake", fetchedAt:"2026-11-13T11:59:00Z", fromStore:false, saved:pending===0, pending};
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true, ...(over.touch?{hasTouch:true, isMobile:true}:{})}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], role:opts.role||"corpdev", delay:()=>0, stat:()=>statusWith(!!opts.mapped), o:{}, ...over};
    t.query = over.query || ((body)=>({status:200, body:answer(body, t.o)}));
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:t.role, statutory:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2, resetsAt:"2026-11-14T00:00:00Z"});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(fn==="snl-statutory"){ if(body.action==="status") return J(200, t.stat());
          if(body.action==="query"){ const n=t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query"&&same(c.body.codes,body.codes)&&same(c.body.fields,body.fields)).length; const d=t.delay(body, n); if(d) await new Promise(res=>setTimeout(res,d)); const a=t.query(body, n); return J(a.status, a.body); } }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG()});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; }, {role:t.role, seed:[["snl_settings","combination_base",{doc:opts.base||GROUP_BASE}]]});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    await p.evaluate(()=>{ location.hash="#combination"; }); await p.waitForTimeout(350);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.queries=()=>t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query").map(c=>c.body);
    t.slQueries=()=>t.queries().filter(q=>same(q.fields,[ID]));
    t.until=async (cond, ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await cond()) return true; await p.waitForTimeout(40); } return false; };
    t.go=async ()=>{ if(t.role!=="corpdev") return; await p.fill("#cb_target_codes", opts.target||"90107"); await p.click("#cbGo"); await t.until(async()=>!(await p.$("#cbResults .banner[role=status] .pb")) && !!(await p.$("#cbMap"))); await p.waitForTimeout(100); };
    t.fill=code=>p.evaluate(c=>{ const e=document.getElementById("cbm_s_"+c); return e ? (e.classList.contains("miss")?"miss":e.classList.contains("zero")?"zero":e.style.fill) : null; }, code);
    t.label=code=>p.getAttribute("#cbm_s_"+code, "aria-label");
    // a point inside a state, on screen: its label's place on the drawing (inside the state), as a person would point
    t.pt=async code=>{ await p.$eval("#cbm_s_"+code, e=>e.scrollIntoView({block:"center"})); return p.evaluate(c=>{ const e=document.getElementById("cbm_s_"+c), svg=e.ownerSVGElement, q=svg.createSVGPoint(), m=US_MAP[c];
      if(m.length>2){ q.x=m[2]; q.y=m[3]; } else { const bb=e.getBBox(); q.x=bb.x+bb.width/2; q.y=bb.y+bb.height/2; } const r=q.matrixTransform(svg.getScreenCTM()); return {x:r.x, y:r.y}; }, code); };
    t.click=async code=>{ const q=await t.pt(code); await p.mouse.click(q.x, q.y); await p.waitForTimeout(80); };
    t.hover=async code=>{ const q=await t.pt(code); await p.mouse.move(q.x, q.y); await p.waitForTimeout(80); };
    t.tap=async code=>{ const q=await t.pt(code); await p.touchscreen.tap(q.x, q.y); await p.waitForTimeout(100); };
    // the map's table: [state, written by, base, share, target, share, pro forma, share, target's share], by row
    t.table=()=>p.$$eval("#cbTab_map tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    t.facts=()=>p.$$eval("#cbm_facts li",e=>e.map(x=>x.textContent));
    t.key=()=>p.$$eval("#cbmKey li",e=>e.map(x=>x.textContent));
    t.show=async v=>{ await p.click(`#cbMap [data-act="cbm-show"][data-v="${v}"]`); await p.waitForTimeout(60); };
    t.openLines=async()=>{ if(!(await p.$("#cbmLineBox"))){ await p.click("#cbmPick"); await p.waitForTimeout(60); } };
    t.line=async name=>{ await t.openLines(); const h=await p.evaluateHandle(n=>[...document.querySelectorAll("#cbmLineList input")].find(i=>i.dataset.name===n), name); await h.asElement().click(); await p.waitForTimeout(80); };
    t.year=async y=>{ await p.selectOption("#cbm_year", String(y)); await p.waitForTimeout(80); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    await t.go();
    return t;
  }

  // ===== before premiums by state and line are mapped: the map with all lines, from premiums by state =====
  let t=await open({}); let p=t.p;
  ok("the map is in the results, above the mix tables", !!(await p.$("#cbMap")) && await p.evaluate(()=>!!(document.getElementById("cbMap").compareDocumentPosition(document.getElementById("cb_lines")) & Node.DOCUMENT_POSITION_FOLLOWING)));
  ok("the latest year both sides have, in the heading and chosen in Year", (await t.txt("#cbMapH"))==="Direct premiums by state, on a map, 2025" && (await p.inputValue("#cbm_year"))==="2025" && same(await p.$$eval("#cbm_year option",e=>e.map(x=>x.value)),["2025","2024","2023","2022","2021"]));
  ok("the US states and DC are drawn, each reachable", (await p.$$("#cbmSvg path[data-cbs]")).length===51 && (await p.$$eval("#cbmSvg path[data-cbs]",e=>e.filter(x=>x.getAttribute("role")==="button" && x.hasAttribute("tabindex")).length))===51);
  ok("one tab stop on the map: the first state", (await p.$$eval('#cbmSvg path[tabindex="0"]',e=>e.map(x=>x.dataset.cbs)))[0]==="AK" && (await p.$$('#cbmSvg path[tabindex="0"]')).length===1);
  ok("the lines in view are said in words", (await t.txt("#cbmInView"))==="Lines in view: all lines (4 lines either side writes), 2025. With all lines the map uses premiums by state, as in the table of states below.", await t.txt("#cbmInView"));
  ok("the line filter is shown but off, saying what is needed", (await t.txt("#cbmLinesOff"))==="Narrowing by line is off. It needs premiums by state and line together, a figure that isn't mapped yet. A Corp Dev login can map dpw_by_state_line in Field set-up on the Statutory view; until then the map shows all lines.", await t.txt("#cbmLinesOff"));
  await t.openLines();
  ok("its lines are listed, largest first by pro forma premiums by line, and can't be chosen", same(await p.$$eval("#cbmLineList label",e=>e.map(x=>[...x.querySelectorAll("span")].map(s=>s.textContent).join(" "))),["Homeowners $760M","Commercial auto $250M","Inland marine $150M","Farmowners $110M"]) && (await p.$$eval("#cbmLineList input",e=>e.every(x=>x.disabled))), await p.$$eval("#cbmLineList label",e=>e.map(x=>x.textContent)));
  ok("no look-up for premiums by state and line, ever, with all lines", t.slQueries().length===0 && t.queries().length===2 && t.queries().every(q=>!q.fields.includes(ID)));
  // pro forma, all lines
  ok("pro forma by state: the two sides' premiums by state added", same((await t.table()).map(r=>[r[0], r[1], r[2], r[4], r[6], r[8]]),[
    ["Texas (TX)","Our company only","$400M","None","$400M","0.0%"],["Florida (FL)","Both","$200M","$150M","$350M","42.9%"],["Georgia (GA)","Target only","None","$100M","$100M","100.0%"],["Louisiana (LA)","Our company only","$100M","None","$100M","0.0%"],
    ["Oklahoma (OK)","Our company only","$80M","None","$80M","0.0%"],["Arkansas (AR)","Our company only","$70M","None","$70M","0.0%"],["Mississippi (MS)","Our company only","$60M","None","$60M","0.0%"],["Alabama (AL)","Our company only","$50M","None","$50M","0.0%"],
    ["New Mexico (NM)","Our company only","$40M","None","$40M","0.0%"],["Rhode Island (RI)","Target only","None","$20M","$20M","100.0%"]]), await t.table());
  ok("each side's share of its own total, and the pro forma's: FL 200 of 1,000, 150 of 270, 350 of 1,270", same((await t.table())[1].slice(2,8),["$200M","20.0%","$150M","55.6%","$350M","27.6%"]), (await t.table())[1]);
  const stTab=await p.$$eval("#cbTab_states tbody tr",rs=>rs.filter(r=>r.children[0].textContent!=="Other").map(r=>[r.children[0].textContent, r.children[2].textContent, r.children[4].textContent, r.children[6].textContent]));
  const mapTab=(await t.table()).map(r=>[r[0].replace(/^.*\(([A-Z]{2})\)$/,"$1"), r[2], r[4], r[6]]);
  ok("with all lines, the map's totals agree with the table of states below", stTab.length===7 && stTab.every(s=>mapTab.some(m=>m[0]===s[0] && m[1]===s[1] && m[2]===s[2] && m[3]===s[3])), {stTab, mapTab});
  ok("dollar groups of about as many states each, darkest for the most", await t.fill("TX")===rgb(BLUES[4]) && await t.fill("FL")===rgb(BLUES[4]) && await t.fill("GA")===rgb(BLUES[3]) && await t.fill("OK")===rgb(BLUES[2]) && await t.fill("AL")===rgb(BLUES[1]) && await t.fill("RI")===rgb(BLUES[0]), [await t.fill("TX"), await t.fill("RI")]);
  ok("a state with no premium on either side is neutral, not a colour", await t.fill("CA")==="zero" && await t.fill("DC")==="zero");
  ok("the legend gives each group's range and the neutral", same(await t.key(),["$20M to $40M","$50M to $60M","$70M to $80M","$100M","$350M to $400M","No premium in either side's figures"]), await t.key());
  ok("the read-outs: both, only one side, largest and top five before and after, the total", same(await t.facts(),[
    "Written by both: 1 state, $350M of pro forma premium (27.6%), the overlap.",
    "Only Our company: 7 states, $800M (63.0%). Only the target: 2 states, $120M (9.4%).",
    "Largest state: before, TX at 40.0% of Our company; after, TX at 31.5% of the pro forma.",
    "Top five states: 85.0% of Our company before, 81.1% of the pro forma after.",
    "Total: Our company $1,000M, target $270M, pro forma $1,270M."]), await t.facts());
  ok("each state's accessible name carries its figures", (await t.label("FL"))==="Florida (FL): Our company $200M; target $150M; pro forma $350M; target's share 42.9%" && (await t.label("GA"))==="Georgia (GA): Our company none in its figures; target $100M; pro forma $100M; target's share 100.0%", await t.label("GA"));
  // every "what is shown"
  await t.show("b");
  ok("our company's: groups of its own states; a state only the target writes is neutral", await t.fill("TX")===rgb(BLUES[4]) && await t.fill("NM")===rgb(BLUES[0]) && await t.fill("GA")==="zero" && same(await t.key(),["$40M","$50M to $60M","$70M","$80M to $100M","$200M to $400M","No premium in Our company's figures"]), await t.key());
  await t.show("t");
  ok("the target's: FL 150 and GA 100 darkest, RI lightest; TX neutral", await t.fill("FL")===rgb(BLUES[4]) && await t.fill("GA")===rgb(BLUES[3]) && await t.fill("RI")===rgb(BLUES[2]) && await t.fill("TX")==="zero" && (await t.key()).pop()==="No premium in the target's figures", [await t.fill("FL"), await t.fill("GA"), await t.fill("RI"), await t.key()]);
  await t.show("share");
  ok("the target's share: FL 42.9% in 40 to 60, GA and RI 100%, TX 0%; neither neutral", await t.fill("FL")===rgb(ORANGES[2]) && await t.fill("GA")===rgb(ORANGES[4]) && await t.fill("RI")===rgb(ORANGES[4]) && await t.fill("TX")===rgb(ORANGES[0]) && await t.fill("CA")==="zero" && (await t.key())[0]==="Target's share: Under 20.0%", await t.key());
  await t.show("who");
  ok("who writes it: both, only us, only the target, neither", await t.fill("FL")===rgb("#08306B") && await t.fill("TX")===rgb("#9ECAE1") && await t.fill("GA")===rgb("#F16913") && await t.fill("CA")==="zero" && same(await t.key(),["Both write here","Only Our company","Only the target","No premium in either side's figures"]), await t.key());
  ok("the choice is pressed, one at a time", same(await p.$$eval('#cbMap [data-act="cbm-show"]',e=>e.map(x=>x.getAttribute("aria-pressed"))),["false","false","false","false","true"]));
  await t.show("pf");
  // hover
  await t.hover("TX");
  ok("hover shows a small panel for the state", await p.isVisible("#cbmTip") && (await t.txt("#cbmTip")).startsWith("Texas (TX), 2025Our company$400M40.0%TargetNone") && (await t.txt("#cbmTip")).includes("Pro forma$400M31.5%"), await t.txt("#cbmTip"));
  ok("its lines can't be shown until premiums by state and line are mapped", (await t.txt("#cbmTip")).includes("Lines here: n/d, premiums by state and line aren't mapped yet."), await t.txt("#cbmTip"));
  ok("the panel stays inside the page", await t.noScroll());
  await p.mouse.move(5,5); await p.waitForTimeout(60);
  ok("and goes when the pointer leaves", !(await p.isVisible("#cbmTip")));
  // click to pin, again to unpin
  await t.click("FL");
  ok("click pins a state: its detail shows below the map", (await t.txt("#cbmPinH"))==="Florida (FL), 2025" && same(await p.$$eval("#cbmPinTab tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent))),[["Our company","$200M","20.0%"],["Target","$150M","55.6%"],["Pro forma","$350M","27.6%"],["Target's share here","42.9%",""]]) && await p.getAttribute("#cbm_s_FL","aria-pressed")==="true" && await p.evaluate(()=>document.getElementById("cbm_s_FL").classList.contains("pin")));
  ok("the pinned state's lines say why they can't be shown", (await t.txt("#cbmPinLinesWhy"))==="The lines in Florida can't be shown: premiums by state and line aren't mapped yet." && !(await p.$("#cbmPinFetch")), await t.txt("#cbmPinLinesWhy"));
  await t.click("FL");
  ok("clicking it again unpins it", !(await p.$("#cbmPin")) && await p.getAttribute("#cbm_s_FL","aria-pressed")==="false");
  // keyboard
  await p.focus("#cbm_s_AL"); await p.waitForTimeout(60);
  ok("focus shows the panel too", await p.isVisible("#cbmTip") && (await t.txt("#cbmTip")).startsWith("Alabama (AL), 2025"));
  await p.keyboard.press("ArrowRight"); await p.waitForTimeout(40);
  ok("the arrow keys move between states", await p.evaluate(()=>document.activeElement.id)==="cbm_s_AR" && await p.getAttribute("#cbm_s_AR","tabindex")==="0" && await p.getAttribute("#cbm_s_AL","tabindex")==="-1" && (await t.txt("#cbmTip")).startsWith("Arkansas (AR)"));
  await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft"); await p.waitForTimeout(40);
  ok("and wrap round", await p.evaluate(()=>document.activeElement.id)==="cbm_s_WY");
  await p.keyboard.press("End"); await p.keyboard.press("Home"); for(let i=0;i<43;i++) await p.keyboard.press("ArrowRight"); await p.waitForTimeout(40);
  ok("every state can be reached: Home then 43 steps is Texas", await p.evaluate(()=>document.activeElement.id)==="cbm_s_TX");
  await p.keyboard.press("Enter"); await p.waitForTimeout(80);
  ok("Enter pins it, and focus stays on it", (await t.txt("#cbmPinH"))==="Texas (TX), 2025" && await p.evaluate(()=>document.activeElement.id)==="cbm_s_TX" && (await t.label("TX")).endsWith(". Pinned"));
  await p.keyboard.press("Escape"); await p.waitForTimeout(80);
  ok("Escape unpins it, focus still on the state", !(await p.$("#cbmPin")) && await p.evaluate(()=>document.activeElement.id)==="cbm_s_TX");
  await p.keyboard.press(" "); await p.waitForTimeout(80);
  ok("Space pins too", (await t.txt("#cbmPinH"))==="Texas (TX), 2025");
  await p.click("#cbmUnpin"); await p.waitForTimeout(80);
  ok("Unpin closes it and puts focus back on the state", !(await p.$("#cbmPin")) && await p.evaluate(()=>document.activeElement.id)==="cbm_s_TX");
  // the small states
  ok("the small north-eastern states and DC have labelled boxes beside the map", same(await p.$$eval("#cbmSmall button",e=>e.map(x=>x.textContent)),["VT","NH","MA","RI","CT","NJ","DE","MD","DC"]) && (await p.getAttribute("#cbm_b_DC","aria-label"))==="District of Columbia (DC): Our company none in its figures; target none in its figures; pro forma $0M; target's share no premium on either side", await p.getAttribute("#cbm_b_DC","aria-label"));
  ok("a small state's box has its colour", await p.$eval("#cbm_b_RI .sw",e=>e.style.background)===rgb(BLUES[0]));
  await p.focus("#cbm_b_RI"); await p.keyboard.press("Enter"); await p.waitForTimeout(80);
  ok("a box pins its state by keyboard, as the map does", (await t.txt("#cbmPinH"))==="Rhode Island (RI), 2025" && await p.getAttribute("#cbm_b_RI","aria-pressed")==="true" && await p.getAttribute("#cbm_s_RI","aria-pressed")==="true");
  await p.click("#cbm_b_DC"); await p.waitForTimeout(80);
  ok("and by click: DC pins, with nothing on either side", (await t.txt("#cbmPinH"))==="District of Columbia (DC), 2025" && same(await p.$$eval("#cbmPinTab tbody tr td:nth-child(2)",e=>e.map(x=>x.textContent)),["None","None","$0M","no premium on either side"]));
  await p.click("#cbmUnpin"); await p.waitForTimeout(60);
  // the table
  await p.click('#cbTab_map [data-act="cbm-sort"][data-k="t"]'); await p.waitForTimeout(60);
  ok("the table sorts by the target, largest first, states it doesn't write after", same((await t.table()).map(r=>r[0]).slice(0,4),["Florida (FL)","Georgia (GA)","Rhode Island (RI)","Alabama (AL)"]) && await p.getAttribute('#cbTab_map th:nth-child(5)',"aria-sort")==="descending", (await t.table()).map(r=>r[0]));
  await p.click('#cbTab_map [data-act="cbm-sort"][data-k="name"]'); await p.waitForTimeout(60);
  ok("and by name, A to Z", (await t.table())[0][0]==="Alabama (AL)" && (await t.table()).pop()[0]==="Texas (TX)" && await p.getAttribute('#cbTab_map th:nth-child(1)',"aria-sort")==="ascending");
  await p.click('#cbTab_map [data-act="cbm-sort"][data-k="name"]'); await p.waitForTimeout(60);
  ok("a second click turns the order round", (await t.table())[0][0]==="Texas (TX)");
  await p.click('#cbTab_map [data-act="cbm-sort"][data-k="p"]'); await p.waitForTimeout(60);
  await p.click('#cbTab_map [data-act="cbm-pin"][data-s="GA"]'); await p.waitForTimeout(60);
  ok("a state's name in the table pins it", (await t.txt("#cbmPinH"))==="Georgia (GA), 2025"); await p.click("#cbmUnpin"); await p.waitForTimeout(60);
  let d=await t.download(()=>p.click('#cbMap [data-act="export"][data-fmt="csv"]'));
  let L=d.text.replace(/^﻿/,"").split("\r\n");
  ok("export: named for the view and the day, never the companies", d.name==="snl-combination-map-2026-11-13.csv", d.name);
  // with Show change on (the default) the export ends with "Change %"; tests/web/combochange.test.cjs covers it
  ok("export: each state with both sides, the pro forma and the shares", L[0]==='"State","Code","Written by","Our company US dollars","Our company share %","Target US dollars","Target share %","Pro forma US dollars","Pro forma share %","Target\'s share of the state %","Change %"' && L.includes('"Florida","FL","Both","200000000","20","150000000","55.6","350000000","27.6","42.9","75"') && L.includes('"Georgia","GA","Target only","","","100000000","37","100000000","7.9","100","New"'), L.slice(0,4));
  ok("export: the year, the lines and what is shown are stated in the file", L.includes('"Year","2025","","","","","","","","",""') && L.includes('"Lines","All lines","","","","","","","","",""') && L.includes('"From","Premiums by state (dpw_by_state)","","","","","","","","",""') && L.includes('"Shown on the map","Pro forma direct premiums written","","","","","","","","",""') && d.text.includes('"Note","What this is: a simple sum'), L.slice(-8));
  ok("the cost is said: nothing more with all lines, one look-up a side for a line", (await t.txt("#cbmCost"))==="Cost: with all lines, nothing more, as the map uses the premiums by state already fetched. Choosing a line adds one statutory look-up a side for the year shown (about 0.02 Snowflake credit each the first time, nothing when reopened). No Claude, and nothing that pairs the two is saved or sent.");
  // a year with no premiums by state: n/d, hatched, never zero
  await t.year(2024);
  ok("a year with no premiums by state on either side: every state hatched and said to be missing", await t.fill("TX")==="miss" && await t.fill("CA")==="miss" && (await t.key()).pop()==="Hatched: n/d, Our company: none returned; target: none returned" && (await t.label("TX"))==="Texas (TX): Our company n/d (none returned); target n/d (none returned); pro forma n/d (base: none returned; target: none returned); target's share n/d", await t.label("TX"));
  ok("and the table and read-outs say so, never that nothing is written", (await t.txt("#cbmTabNone")).endsWith("That doesn't mean nothing is written there.") && (await t.txt("#cbm_facts_none"))==="The read-outs need both sides: Our company: none returned; target: none returned. That doesn't mean nothing is written there.", await t.txt("#cbmTabNone"));
  ok("still no look-up for premiums by state and line", t.slQueries().length===0);
  await t.year(2025);
  // nothing about the pair is written or sent
  const sent=t.calls.map(c=>({fn:c.fn, body:JSON.stringify(c.body)}));
  ok("no call carries both sides", !sent.some(c=>/"9001"/.test(c.body) && /"90107"/.test(c.body)));
  ok("nothing is written to the database", (await p.evaluate(()=>window.__mock.log)).filter(l=>l.op==="upsert").length===0);
  ok("nothing about the pair or the map is kept in browser storage", await p.evaluate(()=>!/9001|90107|Tarrow|Calloway|cbm|Homeowners/.test(JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))));
  await p.click("#askFab"); await p.waitForTimeout(150); await p.fill("#ask_input","What is direct premium?"); await p.click('[data-act="ask-send"]'); await p.waitForTimeout(300);
  const asked=t.calls.filter(c=>c.fn==="snl-chat" && c.body.action==="ask");
  ok("a question asked from this view carries no screen, no side, no state and no line", asked.length===1 && !("screen" in asked[0].body) && !/9001|90107|Calloway|Tarrow|Homeowners|Florida|dpw_by_state/.test(JSON.stringify(asked[0].body)), asked.map(a=>a.body));
  await p.click("#askClose").catch(()=>{}); await p.waitForTimeout(100);
  ok("no sideways scroll at 1440", await t.noScroll());
  await p.$eval("#cbMap",e=>e.scrollIntoView()); await p.waitForTimeout(80);
  await (await p.$("#cbMap")).screenshot({path:OUTDIR+"/combomap-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("no sideways scroll at 390: the map scales to its box", await t.noScroll() && await p.$eval("#cbmSvg",e=>e.getBoundingClientRect().width<=360));
  await (await p.$("#cbMap")).screenshot({path:OUTDIR+"/combomap-390.png"});
  await t.ctx.close();

  // ===== premiums by state and line mapped: one line, several, Clear, a year change =====
  t=await open({mapped:true}, {delay:b=>same(b.fields,[ID])&&b.kind==="company"?400:0}); p=t.p;
  ok("mapped: the filter is on, with nothing fetched yet", !(await p.$("#cbmLinesOff")) && t.slQueries().length===0);
  await t.line("Homeowners");
  ok("choosing a line asks once a side, for the year shown, that figure only, each side alone", same(t.slQueries().map(q=>[q.kind, q.codes, q.fromYear, q.toYear, q.fields]).sort(),[["company",["90107"],2025,2025,[ID]],["group",["9001"],2025,2025,[ID]]]));
  ok("while the target's are coming: progress, and that side n/d as still coming", await p.isVisible("#cbmSl_target .pb") && (await t.txt("#cbmSl_target")).startsWith("Fetching the target's premiums by state and line for 2025… The rest of the view stays as it is.") && (await t.label("FL")).includes("target n/d (still coming)"), await t.txt("#cbmSl_target"));
  await t.show("b");
  ok("the rest of the view stays usable meanwhile", await p.getAttribute('#cbMap [data-act="cbm-show"][data-v="b"]',"aria-pressed")==="true" && await t.fill("TX")===rgb(BLUES[4]));
  await t.show("pf");
  await t.until(async()=>!(await p.$("#cbmSl_target")));
  ok("one line: homeowners in each state, hand-worked", same((await t.table()).map(r=>[r[0].slice(-3,-1), r[2], r[4], r[6], r[8]]),[
    ["TX","$250M","None","$250M","0.0%"],["FL","$150M","$90M","$240M","37.5%"],["LA","$100M","None","$100M","0.0%"],["AR","$50M","None","$50M","0.0%"],["GA","None","$50M","$50M","100.0%"],["MS","$50M","None","$50M","0.0%"],["RI","None","$20M","$20M","100.0%"]]), await t.table());
  ok("the line in view is said", (await t.txt("#cbmInView"))==="Lines in view: Homeowners (1 of 4 lines), 2025.", await t.txt("#cbmInView"));
  ok("the read-outs follow the filter", same(await t.facts(),[
    "Written by both: 1 state, $240M of pro forma premium (31.6%), the overlap.",
    "Only Our company: 4 states, $450M (59.2%). Only the target: 2 states, $70M (9.2%).",
    "Largest state: before, TX at 41.7% of Our company; after, TX at 32.9% of the pro forma.",
    "Top five states: 100.0% of Our company before, 90.8% of the pro forma after.",
    "Total: Our company $600M, target $160M, pro forma $760M."]), await t.facts());
  ok("a state neither side writes homeowners in is neutral (OK writes only commercial auto)", await t.fill("OK")==="zero" && await t.fill("AL")==="zero" && await t.fill("TX")!=="zero");
  await t.show("share");
  ok("the target's share under the filter: FL 37.5% in 20 to 40", await t.fill("FL")===rgb(ORANGES[1]) && await t.fill("GA")===rgb(ORANGES[4]));
  await t.show("who");
  ok("who writes homeowners: FL both, TX only us, GA only the target", await t.fill("FL")===rgb("#08306B") && await t.fill("TX")===rgb("#9ECAE1") && await t.fill("GA")===rgb("#F16913"));
  await t.show("pf");
  await t.hover("TX");
  ok("hover: the state's top lines under the filter", (await t.txt("#cbmTip")).includes("Largest lines here: Homeowners $250M."), await t.txt("#cbmTip"));
  await t.line("Farmowners");
  ok("a second line: no new look-up for the same year", t.slQueries().length===2);
  ok("several lines: added up in each state", same((await t.table()).map(r=>[r[0].slice(-3,-1), r[6]]),[["FL","$300M"],["TX","$250M"],["GA","$100M"],["LA","$100M"],["AR","$50M"],["MS","$50M"],["RI","$20M"]]) && (await t.txt("#cbmInView"))==="Lines in view: Homeowners and Farmowners (2 of 4 lines), 2025.", [await t.table(), await t.txt("#cbmInView")]);
  await t.click("FL");
  ok("a pinned state lists its lines under the filter, each side and the pro forma", same(await p.$$eval("#cbmPinLines tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent))),[["Homeowners","$150M","$90M","$240M"],["Farmowners","None","$60M","$60M"]]), await p.$$eval("#cbmPinLines tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent))));
  d=await t.download(()=>p.click('#cbMap [data-act="export"][data-fmt="csv"]'));
  L=d.text.replace(/^﻿/,"").split("\r\n");
  ok("export follows the filter and says so", L.includes('"Florida","FL","Both","150000000","25","150000000","55.6","300000000","34.5","50","100"') && L.includes('"Lines","Homeowners; Farmowners","","","","","","","","",""') && L.includes('"From","Premiums by state and line (dpw_by_state_line)","","","","","","","","",""'), L.filter(l=>/Florida|Lines|From/.test(l)));
  await p.click("#cbmClear"); await p.waitForTimeout(80);
  ok("Clear goes back to all lines, from premiums by state", (await t.txt("#cbmInView")).startsWith("Lines in view: all lines") && (await t.table())[0].slice(0,7).join("|")==="Texas (TX)|Our company only|$400M|40.0%|None||$400M");
  ok("the pinned state keeps its lines, now all of them, in hand already", same(await p.$$eval("#cbmPinLines tbody tr td:first-child",e=>e.map(x=>x.textContent)),["Homeowners","Farmowners","Commercial auto"]));
  await p.click("#cbmUnpin"); await p.waitForTimeout(60);
  await t.hover("TX");
  ok("hover with all lines: the state's top lines, now in hand", (await t.txt("#cbmTip")).includes("Largest lines here: Homeowners $250M, Commercial auto $100M, Inland marine $50M."), await t.txt("#cbmTip"));
  ok("premiums by state and line add up to premiums by state here: no note", !(await p.$("#cbmGap_base")) && !(await p.$("#cbmGap_target")));
  // the year
  await t.line("Homeowners"); await t.year(2024);
  await t.until(async()=>t.slQueries().length===4 && !(await p.$("#cbmSl_target")) && !(await p.$("#cbmSl_base")));
  ok("a year change with a line chosen fetches that year once a side", same(t.slQueries().slice(2).map(q=>[q.codes, q.fromYear, q.toYear]).sort(),[[["9001"],2024,2024],[["90107"],2024,2024]]), t.slQueries().map(q=>[q.codes,q.fromYear]));
  ok("2024's homeowners", same((await t.table()).map(r=>[r[0].slice(-3,-1), r[2], r[4], r[6]]),[["TX","$300M","None","$300M"],["FL","None","$120M","$120M"]]) && (await t.txt("#cbMapH")).endsWith(", 2024"), await t.table());
  await t.year(2025); await t.year(2024); await t.year(2025); await p.waitForTimeout(100);
  ok("going back and forth asks for nothing more", t.slQueries().length===4);
  ok("no look-up ever paired the two sides", !t.calls.some(c=>/"9001"/.test(JSON.stringify(c.body)) && /"90107"/.test(JSON.stringify(c.body))));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  await t.openLines();
  ok("390 with lines chosen and the list open: no sideways scroll", await t.noScroll());
  await (await p.$("#cbMap")).screenshot({path:OUTDIR+"/combomap-lines-390.png"});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(150);
  await (await p.$("#cbMap")).screenshot({path:OUTDIR+"/combomap-lines-1440.png"});
  await t.ctx.close();

  // ===== the target's premiums by state and line cut short at the row limit =====
  t=await open({mapped:true}); p=t.p; t.o.slTruncated=["90107"];
  await t.line("Homeowners"); await t.until(async()=>t.slQueries().length===2 && !!(await p.$("#cbmSl_target")) && !(await p.$("#cbmSl_target .pb")));
  ok("cut short: the map says so, never a part shown as the whole", (await t.txt("#cbmSl_target"))==="The target's premiums by state and line for 2025 were cut short. Snowflake returned more rows than one request allows, so they show as n/d rather than as a part shown as the whole. Use fewer codes for that side.", await t.txt("#cbmSl_target"));
  ok("every state's pro forma is n/d and hatched, saying why", await t.fill("TX")==="miss" && await t.fill("FL")==="miss" && (await t.label("FL")).includes("target n/d (cut short at the row limit)") && (await t.key()).pop()==="Hatched: n/d, target: cut short at the row limit", await t.key());
  ok("our company's own figures still show when shown alone", (await t.show("b"), await t.fill("TX"))===rgb(BLUES[4]));
  ok("the table keeps our company's figures and says n/d, with why, for the rest (A to Z, as no pro forma can be sorted)", same((await t.table())[0],["Arkansas (AR)","n/d","$50M","8.3%","n/dcut short at the row limit","","n/dtarget: cut short at the row limit","","n/d","n/dtarget: cut short at the row limit"]), (await t.table())[0]);
  await t.ctx.close();

  // ===== the target's failed, then retried; our company's late; not mapped for a group =====
  t=await open({mapped:true}, {query:(body,n)=>same(body.fields,[ID])&&body.kind==="company"&&n===1 ? {status:502, body:{error:"snowflake_failed", message:"Snowflake didn't answer. Try again in a minute."}} : {status:200, body:answer(body, {})}}); p=t.p;
  await t.line("Homeowners"); await t.until(async()=>!!(await p.$("#cbmSl_target[role=alert]")));
  ok("a side that failed says so, with Try again", (await t.txt("#cbmSl_target")).startsWith("Couldn't fetch the target's premiums by state and line for 2025. Snowflake didn't answer. Try again in a minute. That side shows as n/d on the map.") && (await t.label("FL")).includes("target n/d (couldn't be fetched)"), await t.txt("#cbmSl_target"));
  await p.click('#cbmSl_target [data-act="cbm-retry"]'); await t.until(async()=>!(await p.$("#cbmSl_target")));
  ok("Try again fetches that side alone, and the map fills in", same(t.slQueries().map(q=>q.codes),[["9001"],["90107"],["90107"]]) && (await t.label("FL")).includes("pro forma $240M"), await t.label("FL"));
  await t.ctx.close();

  t=await open({mapped:true}); p=t.p; t.o.slPending=true;
  await t.line("Homeowners"); await t.until(async()=>!!(await p.$("#cbmSl_base[role=alert]")));
  ok("figures that didn't come back in time: n/d, with Try again", (await t.txt("#cbmSl_base")).startsWith("Our company's premiums by state and line for 2025 didn't come back in time.") && (await t.label("TX")).includes("Our company n/d (didn't come back in time)"), await t.txt("#cbmSl_base"));
  t.o.slPending=false; await p.click('#cbmSl_base [data-act="cbm-retry"]'); await p.click('#cbmSl_target [data-act="cbm-retry"]'); await t.until(async()=>!(await p.$("#cbmSl_base")) && !(await p.$("#cbmSl_target")));
  ok("and they fill in when each side is asked again, that side alone", (await t.label("TX")).includes("pro forma $250M") && t.slQueries().length===6 && same(t.slQueries().slice(4).map(q=>q.codes),[["9001"],["90107"]]), [await t.label("TX"), await t.txt("#cbMap .banner"), t.slQueries().length]);
  await t.ctx.close();

  t=await open({mapped:true}); p=t.p; t.o.slUnmapped=true;
  await t.line("Homeowners"); await t.until(async()=>t.slQueries().length===2 && !(await p.$("#cbmSl_base")) && !(await p.$("#cbmSl_target")));
  ok("not mapped for a side's look-up: n/d, said as not mapped", (await t.label("TX")).includes("Our company n/d (not mapped)") && (await t.key()).pop()==="Hatched: n/d, Our company: not mapped; target: not mapped", await t.key());
  await t.ctx.close();

  // ===== a side's premiums by state missing: all lines hatched, never zero =====
  t=await open({}); p=t.p; t.o.unmapped=["dpw_by_state"]; await t.go();
  ok("premiums by state not mapped: every state hatched, n/d with the reason", await t.fill("TX")==="miss" && (await t.key()).pop()==="Hatched: n/d, Our company: not mapped; target: not mapped" && (await t.label("TX")).startsWith("Texas (TX): Our company n/d (not mapped)"), await t.key());
  await t.ctx.close();

  // ===== premiums by state and line that don't add up to premiums by state =====
  t=await open({mapped:true}); p=t.p;
  t.o.sl={"9001":{2025:[...SL.codes["9001"]["2025"].filter(r=>!(r[0]==="TX"&&r[1]==="Inland marine")), ["TX","Inland marine",40]]}};
  await t.line("Homeowners"); await t.until(async()=>t.slQueries().length===2 && !(await p.$("#cbmSl_base")));
  ok("a state whose lines don't add up is named in a note, not hidden", (await t.txt("#cbmGap_base"))==="Our company's premiums by state and line for 2025 don't add up to its premiums by state in TX ($390M against $400M). The map with all lines uses premiums by state; with lines chosen, premiums by state and line." && !(await p.$("#cbmGap_target")), await t.txt("#cbmGap_base"));
  await t.ctx.close();

  // ===== hostile line and state names kept as text =====
  t=await open({mapped:true}); p=t.p;
  t.o.sl={"90107":{2025:[["FL",'<img src=x onerror="window.__pwn=1">Homeowners',90], ['<b onmouseover="window.__pwn=2">ZZ</b>',"Homeowners",5], ["GA","Homeowners",50]]}};
  await t.line("Homeowners"); await t.until(async()=>t.slQueries().length===2 && !(await p.$("#cbmSl_target")));
  await t.openLines();
  ok("a hostile line name is listed as text", (await p.$$eval("#cbmLineList label span:first-of-type",e=>e.map(x=>x.textContent))).includes('<img src=x onerror="window.__pwn=1">Homeowners') && !(await p.$("#cbMap img")));
  ok("a hostile state name is shown as text in the table only", (await t.table()).some(r=>r[0]==='<b onmouseover="window.__pwn=2">ZZ</b>') && !(await p.$("#cbMap b[onmouseover]")) && (await t.txt("#cbmOffMap")).includes('<b onmouseover="window.__pwn=2">ZZ</b>'), await t.table());
  await t.line('<img src=x onerror="window.__pwn=1">Homeowners');
  await t.click("FL");
  ok("and in a pinned state's lines", (await t.txt("#cbmPinLines")).includes('<img src=x onerror="window.__pwn=1">Homeowners'));
  ok("nothing in them ran", await p.evaluate(()=>window.__pwn===undefined));
  await t.ctx.close();

  // ===== by touch at 390: tap to pin, no hover needed =====
  t=await open({mapped:true}, {width:390, touch:true}); p=t.p;
  ok("390 by touch: no sideways scroll", await t.noScroll());
  await t.tap("TX");
  ok("a tap pins a state and shows its detail below the map", (await t.txt("#cbmPinH"))==="Texas (TX), 2025");
  ok("its lines can be fetched from there, as with a line chosen", (await t.txt("#cbmPinLinesWhy"))==="The lines in Texas can't be shown: Our company: not fetched yet; target: not fetched yet. They come with premiums by state and line, one look-up a side for the year." && await p.isVisible("#cbmPinFetch"), await t.txt("#cbmPinLinesWhy"));
  await p.tap("#cbmPinFetch"); await t.until(async()=>t.slQueries().length===2 && !(await p.$("#cbmSl_base")) && !(await p.$("#cbmSl_target")));
  ok("and then shows them", same(await p.$$eval("#cbmPinLines tbody tr td:first-child",e=>e.map(x=>x.textContent)),["Homeowners","Commercial auto","Inland marine"]));
  await p.tap("#cbm_b_RI"); await p.waitForTimeout(100);
  ok("by touch, no hover panel covers the map", !(await p.isVisible("#cbmTip")));
  ok("a small state's box is big enough to tap", (await t.txt("#cbmPinH"))==="Rhode Island (RI), 2025" && await p.$eval("#cbm_b_RI",e=>e.getBoundingClientRect().height>=24));
  ok("still no sideways scroll", await t.noScroll());
  await (await p.$("#cbMap")).screenshot({path:OUTDIR+"/combomap-touch-390.png"});
  await t.ctx.close();

  // ===== an ordinary login: no map, nothing asked =====
  t=await open({role:"reader"}, {role:"reader"}); p=t.p;
  ok("a reader's deep link shows no map and asks for no figures", !(await p.$("#cbMap")) && t.calls.filter(c=>c.fn==="snl-statutory" && c.body.action==="query").length===0);
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
