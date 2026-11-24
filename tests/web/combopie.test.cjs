// The Combination view's line-of-business pies, in the state map (Corp Dev only): two pies of direct premiums written
// by line, our company standalone and the pro forma, for all states before a state is clicked (from premiums by line)
// and for a pinned state (from premiums by state and line, fetched one side and one year at a time when a state is
// pinned), with a legend of each line's $M, share and change in share, and an export.
// Covers: the all-states pies against hand-worked shares; a pinned state's pies against hand-worked shares; the same
// line the same colour in both pies; six slices then "Other" with its count; a state only the target writes, one only
// we write and one neither writes; zero and negative lines; a side n/d, not mapped, cut short, still arriving, failed
// then retried; the line filter and a year change; fetching once a side a year on pin; keyboard, hover, focus and
// touch; the legend's figures and change, and "Show change" off; the export; nothing new stored or sent beyond the
// per-side look-ups; hostile line names kept as text; 1440 and 390 wide.
// Every company, code and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), F=FIX("combination_figures.json"), SL=FIX("combomap_state_lines.json"), NV=FIX("combopie_state_lines.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG=()=>`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const NOT_RUN="Not run: the query ran out of time. Run it again, or ask for fewer fields.";
const M=1e6, ID="dpw_by_state_line", EM="\u2014";
const PCT=new Set(["loss_ratio","loss_lae_ratio","expense_ratio","combined_ratio","rbc_ratio","roae","investment_yield","commission_ratio"]);
const GROUP_BASE={kind:"group", codes:["9001"], label:"Calloway Group"};
const PAL=["#00539E","#C46A1B","#944599","#0081C3","#EB008C","#008A7E"], OTHER="#B8BCCB";
// As the map suite: the target also writes $20M of homeowners in Rhode Island, and its lines are as the state-by-line figures have them.
const FIG=copy(F); FIG.codes["90107"].dpw_by_state["2025"].RI=20; FIG.codes["90107"].dpw_by_line["2025"]={Homeowners:160, Farmowners:110};
const statusWith=mapped=>({...copy(STAT.statusMapped), companies:{mapped:false, problem:null}, fields:[...copy(STAT.statusMapped.fields), {id:ID, label:"Direct premiums written by state and line", unit:"usd", by:"state_line", mapped}]});
// Nevada (NV), added to both sides' 2025 premiums by state and line: eight target lines (six named, then "Other"),
// and our company with one line above zero, one at zero and one below.
const WITH_NV={"9001":{2025:[...SL.codes["9001"]["2025"], ...NV.codes["9001"]["2025"]]}, "90107":{2025:[...SL.codes["90107"]["2025"], ...NV.codes["90107"]["2025"]]}};

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
    const t={p, ctx, calls:[], role:"corpdev", delay:()=>0, stat:()=>statusWith(!!opts.mapped), o:copy(opts.o||{}), ...over};
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
    await p.addInitScript(o=>{ window.__opts=o; }, {role:t.role, seed:[["snl_settings","combination_base",{doc:GROUP_BASE}]]});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    await p.evaluate(()=>{ location.hash="#combination"; }); await p.waitForTimeout(350);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.queries=()=>t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query").map(c=>c.body);
    t.slQueries=()=>t.queries().filter(q=>same(q.fields,[ID]));
    t.until=async (cond, ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await cond()) return true; await p.waitForTimeout(40); } return false; };
    t.settled=()=>t.until(async()=>!(await p.$("#cbmSl_base .pb")) && !(await p.$("#cbmSl_target .pb")));
    t.go=async ()=>{ await p.fill("#cb_target_codes", "90107"); await p.click("#cbGo"); await t.until(async()=>!(await p.$("#cbResults .banner[role=status] .pb")) && !!(await p.$("#cbMap"))); await p.waitForTimeout(100); };
    t.pt=async code=>{ await p.$eval("#cbm_s_"+code, e=>e.scrollIntoView({block:"center"})); return p.evaluate(c=>{ const e=document.getElementById("cbm_s_"+c), svg=e.ownerSVGElement, q=svg.createSVGPoint(), m=US_MAP[c];
      if(m.length>2){ q.x=m[2]; q.y=m[3]; } else { const bb=e.getBBox(); q.x=bb.x+bb.width/2; q.y=bb.y+bb.height/2; } const r=q.matrixTransform(svg.getScreenCTM()); return {x:r.x, y:r.y}; }, code); };
    t.click=async code=>{ const q=await t.pt(code); await p.mouse.click(q.x, q.y); await p.waitForTimeout(80); };
    t.tap=async code=>{ const q=await t.pt(code); await p.touchscreen.tap(q.x, q.y); await p.waitForTimeout(100); };
    // a pie's slices: [name, $ (raw), fill, aria-label]
    t.slices=side=>p.$$eval(`#cbpSvg_${side} .cbpsl`,e=>e.map(x=>({k:x.dataset.k, v:+x.dataset.v, fill:x.getAttribute("fill"), label:x.getAttribute("aria-label")})));
    t.legend=()=>p.$$eval("#cbpLegend tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    t.swatches=()=>p.$$eval("#cbpLegend tbody .sw",e=>e.map(x=>x.style.backgroundColor));
    t.openLines=async()=>{ if(!(await p.$("#cbmLineBox"))){ await p.click("#cbmPick"); await p.waitForTimeout(60); } };
    t.line=async name=>{ await t.openLines(); const h=await p.evaluateHandle(n=>[...document.querySelectorAll("#cbmLineList input")].find(i=>i.dataset.name===n), name); await h.asElement().click(); await p.waitForTimeout(80); };
    t.year=async y=>{ await p.selectOption("#cbm_year", String(y)); await p.waitForTimeout(80); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download", {timeout:10000}).catch(()=>null), click()]); return d ? {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")} : {name:"", text:""}; };
    t.center=async (side, k)=>{ const h=await p.evaluateHandle(([s,k])=>[...document.querySelectorAll(`#cbpSvg_${s} .cbpsl`)].find(x=>x.dataset.k===k), [side,k]); const el=h.asElement(); await el.scrollIntoViewIfNeeded();
      return p.evaluate(e=>{ const svg=e.ownerSVGElement, tot=e.getTotalLength(), pts=[0.5,0.25,0.75].map(f=>e.getPointAtLength(tot*f)); const cx=150, cy=110; const q=svg.createSVGPoint();
        // a point inside the slice: two thirds of the way out from the centre towards the middle of its arc
        const a=pts[0]; q.x=cx+(a.x-cx)*0.66; q.y=cy+(a.y-cy)*0.66; const r=q.matrixTransform(svg.getScreenCTM()); return {x:r.x, y:r.y}; }, el); };
    await t.go();
    return t;
  }
  const rgb=h=>`rgb(${parseInt(h.slice(1,3),16)}, ${parseInt(h.slice(3,5),16)}, ${parseInt(h.slice(5,7),16)})`;

  // ===== not mapped: the all-states pies from premiums by line, before any state is clicked =====
  let t=await open({}); let p=t.p;
  ok("before a state is clicked: the pies show all states, said in the heading", (await t.txt("#cbPieH"))==="Premiums by line, all states, 2025" && (await t.txt("#cbpShowing"))==="Showing all states. Click a state on the map to see its lines." && !(await p.$("#cbmPin #cbPie")), await t.txt("#cbPieH"));
  ok("two pies, our company and the pro forma, titled", (await t.txt("#cbpH_base"))==="Our company, all states, 2025" && (await t.txt("#cbpH_pf"))==="Pro forma, all states, 2025" && (await p.$eval("#cbpT_base",e=>e.textContent))==="Our company, all states, 2025");
  let sb=await t.slices("base"), sp=await t.slices("pf");
  ok("our company: homeowners 60.0%, commercial auto 25.0%, inland marine 15.0%, largest first by the pro forma", same(sb.map(s=>s.label),["Homeowners: $600M, 60.0%","Commercial auto: $250M, 25.0%","Inland marine: $150M, 15.0%"]), sb.map(s=>s.label));
  ok("the pro forma: 760, 250, 150 and 110 of 1,270", same(sp.map(s=>s.label),["Homeowners: $760M, 59.8%","Commercial auto: $250M, 19.7%","Inland marine: $150M, 11.8%","Farmowners: $110M, 8.7%"]), sp.map(s=>s.label));
  ok("each pie's slices add up to its side's total", sb.reduce((a,s)=>a+s.v,0)===1000*M && sp.reduce((a,s)=>a+s.v,0)===1270*M);
  ok("colours from one ordered palette, by the pro forma's order", same(sp.map(s=>s.fill), PAL.slice(0,4)));
  ok("the same line has the same colour in both pies", sb.every(s=>sp.find(x=>x.k===s.k).fill===s.fill));
  ok("each pie has a description naming its slices and shares", (await p.$eval("#cbpD_pf",e=>e.textContent))==="Homeowners 59.8%, Commercial auto 19.7%, Inland marine 11.8%, Farmowners 8.7%. Total $1,270M.", await p.$eval("#cbpD_pf",e=>e.textContent));
  ok("share labels beside the slices", same(await p.$$eval("#cbpSvg_pf text",e=>e.map(x=>x.textContent)),["59.8%","19.7%","11.8%","8.7%"]));
  ok("the legend: each line's $M and share, each side, and the change in share in points", same(await t.legend(),[
    ["Homeowners","$600M","60.0%","$760M","59.8%","▼ -0.2 pts"],["Commercial auto","$250M","25.0%","$250M","19.7%","▼ -5.3 pts"],["Inland marine","$150M","15.0%","$150M","11.8%","▼ -3.2 pts"],["Farmowners","None","0.0%","$110M","8.7%","▲ +8.7 pts"]]), await t.legend());
  ok("the legend's swatches are the slices' colours", same(await t.swatches(), PAL.slice(0,4).map(rgb)));
  ok("every second colour carries a texture, in the pie and the legend, for grey print", (await p.$$eval("#cbpSvg_pf .cbptex",e=>e.length))===2 && same(await p.$$eval("#cbpLegend tbody .sw",e=>e.map(x=>x.classList.contains("tex"))),[false,true,false,true]) && (await p.$eval("#cbpSvg_pf .cbptex",e=>e.getAttribute("fill")))==="url(#cbpTex_pf)");
  ok("the cost is said", (await t.txt("#cbpCost"))==="Cost: with no state pinned, nothing more, as the pies use the premiums by line already fetched. Pinning a state adds one statutory look-up a side for the year shown, the first time, when premiums by state and line are mapped (about 0.02 Snowflake credit each; nothing when reopened). No Claude, and nothing that pairs the two is saved or sent.");
  ok("nothing asked for the all-states pies", t.queries().length===2 && t.slQueries().length===0);
  ok("no em dash in the pies' words", !(await t.txt("#cbPie")).includes(EM));
  // keyboard, focus and hover
  await p.focus("#cbpSvg_pf .cbpsl"); await p.waitForTimeout(60);
  ok("a slice can be reached by keyboard and shows a small panel on focus", await p.isVisible("#cbpTip") && (await t.txt("#cbpTip"))==="Homeowners Pro forma, all states, 2025 $760M, 59.8% of $1,270M", await t.txt("#cbpTip"));
  await p.keyboard.press("Tab"); await p.waitForTimeout(60);
  ok("Tab moves to the next slice", (await t.txt("#cbpTip")).startsWith("Commercial auto Pro forma") && await p.evaluate(()=>document.activeElement.dataset.k)==="commercial auto");
  await p.keyboard.press("Escape"); await p.waitForTimeout(40);
  ok("Escape hides the panel", !(await p.isVisible("#cbpTip")));
  await p.evaluate(()=>document.activeElement.blur());
  let q=await t.center("base","inland marine"); await p.mouse.move(q.x, q.y); await p.waitForTimeout(80);
  ok("hover shows the same panel", await p.isVisible("#cbpTip") && (await t.txt("#cbpTip"))==="Inland marine Our company, all states, 2025 $150M, 15.0% of $1,000M", await t.txt("#cbpTip"));
  ok("the panel stays inside the page", await t.noScroll());
  await p.mouse.move(5,5); await p.waitForTimeout(60);
  ok("and goes when the pointer leaves", !(await p.isVisible("#cbpTip")));
  // a state pinned, the figure not mapped
  await t.click("FL");
  ok("pinned, not mapped: the all-states pies are out of view, and it says what is needed and where to map it", !(await p.$("#cbpSvg_base")) && !(await p.$("#cbpSvg_pf")) && (await t.txt("#cbpOff"))==="A state's lines need premiums by state and line, a figure that isn't mapped yet. A Corp Dev login can map dpw_by_state_line in Field set-up on the Statutory view. Unpin Florida to see the pies for all states." && !!(await p.$("#cbmPin #cbpOff")), await t.txt("#cbpOff"));
  ok("the pinned detail keeps its own words as before", (await t.txt("#cbmPinLinesWhy"))==="The lines in Florida can't be shown: premiums by state and line aren't mapped yet.");
  ok("and asks for nothing", t.slQueries().length===0);
  await p.click("#cbmUnpin"); await p.waitForTimeout(80);
  ok("unpinning swaps back to all states", (await t.txt("#cbPieH"))==="Premiums by line, all states, 2025" && (await t.slices("pf")).length===4);
  // "Show change" off
  await p.uncheck("#cb_chg"); await p.waitForTimeout(80);
  ok("Show change off: the legend has no change", (await p.$$eval("#cbpLegend thead th",e=>e.length))===5 && same((await t.legend())[0],["Homeowners","$600M","60.0%","$760M","59.8%"]));
  let d=await t.download(()=>p.click('#cbPie [data-act="export"][data-fmt="csv"]'));
  let L=d.text.replace(/^\uFEFF/,"").split("\r\n");
  ok("export without change: no change column", L[0]==='"Line of business","In the pies as","Our company US dollars","Our company share %","Pro forma US dollars","Pro forma share %"', L[0]);
  await p.check("#cb_chg"); await p.waitForTimeout(80);
  // the export
  d=await t.download(()=>p.click('#cbPie [data-act="export"][data-fmt="csv"]'));
  L=d.text.replace(/^\uFEFF/,"").split("\r\n");
  ok("export: named for the lines, all states and the year, never the companies", d.name==="snl-combination-lines-all-states-2025-2026-11-13.csv" && !/calloway|tarrow|9001|90107/i.test(d.name), d.name);
  ok("export: each line, how it is shown, each side's dollars and share, and the change in share", L[0]==='"Line of business","In the pies as","Our company US dollars","Our company share %","Pro forma US dollars","Pro forma share %","Change in share pts"' && L[1]==='"Homeowners","Its own slice","600000000","60","760000000","59.8","-0.2"' && L[4]==='"Farmowners","Its own slice","","0","110000000","8.7","8.7"', L.slice(0,5));
  ok("export: the state, year and lines in view are written into the file", L.includes('"State","All states","","","","",""') && L.includes('"Year","2025","","","","",""') && L.includes('"Lines","All lines","","","","",""') && L.includes('"From","Premiums by line (dpw_by_line)","","","","",""') && L.includes('"Pro forma total US dollars","1270000000","","","","",""') && d.text.includes('"Note","What this is: a simple sum'), L.slice(5));
  ok("and as Excel, from the same table", await p.getAttribute('#cbPie [data-act="export"][data-fmt="xlsx"]',"data-tbl")==="pie" && await p.evaluate(()=>{ const x=cbExport("pie"); return x.sheet==="By line" && x.name==="snl-combination-lines-all-states-2025-2026-11-13"; }));
  // a year with only our company's lines
  await t.year(2024);
  ok("a year change: the pies follow it; the pro forma n/d with the reason, never drawn", (await t.txt("#cbPieH"))==="Premiums by line, all states, 2024" && same((await t.slices("base")).map(s=>s.label),["Homeowners: $550M, 59.1%","Commercial auto: $240M, 25.8%","Inland marine: $140M, 15.1%"]) && !(await p.$("#cbpSvg_pf")) && (await t.txt("#cbpNone_pf"))==="n/d: target: none returned.", [await t.txt("#cbpNone_pf"), (await t.slices("base")).map(s=>s.label)]);
  ok("ranked and coloured by ours when the pro forma is n/d", same((await t.slices("base")).map(s=>s.fill), PAL.slice(0,3)) && same((await t.legend())[0],["Homeowners","$550M","59.1%","n/d","","n/dtarget: none returned"]), (await t.legend())[0]);
  await t.year(2025);
  // nothing stored or sent
  ok("nothing is written to the database", (await p.evaluate(()=>window.__mock.log)).filter(l=>l.op==="upsert").length===0);
  ok("nothing about the pair, the pies or the lines is kept in browser storage", await p.evaluate(()=>!/9001|90107|Tarrow|Calloway|cbp|cbm|Homeowners|Farmowners/.test(JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))));
  await t.ctx.close();

  // ===== mapped: pinning a state fetches its lines once a side a year, and draws its pies =====
  t=await open({mapped:true}, {delay:b=>same(b.fields,[ID])&&b.kind==="company"?500:0}); p=t.p;
  ok("mapped, nothing pinned: the all-states pies, and no look-up", (await t.slices("pf")).length===4 && t.slQueries().length===0);
  await t.click("FL");
  ok("pinning asks for premiums by state and line once a side, for the year shown, each side alone", same(t.slQueries().map(q=>[q.kind, q.codes, q.fromYear, q.toYear, q.fields]).sort(),[["company",["90107"],2025,2025,[ID]],["group",["9001"],2025,2025,[ID]]]));
  ok("the pies move into the pinned state's detail, the heading says which state", !!(await p.$("#cbmPin #cbPie")) && (await t.txt("#cbPieH"))==="Premiums by line, Florida, 2025" && (await t.txt("#cbpShowing"))==="Showing Florida only. Unpin it to see all states.");
  await t.until(async()=>!!(await p.$("#cbpSvg_base")) && !(await p.$("#cbpSvg_pf")));
  ok("while the target's are coming: progress shown, the pro forma not drawn", (await t.txt("#cbpNone_pf"))==="n/d: target: still coming. The pie is drawn when the figures arrive." && await p.isVisible("#cbmSl_target .pb"), await t.txt("#cbpNone_pf"));
  ok("and the map stays usable meanwhile", (await p.click('#cbMap [data-act="cbm-show"][data-v="b"]'), await p.getAttribute('#cbMap [data-act="cbm-show"][data-v="b"]',"aria-pressed"))==="true");
  await p.click('#cbMap [data-act="cbm-show"][data-v="pf"]');
  await t.settled(); await p.waitForTimeout(60);
  sb=await t.slices("base"); sp=await t.slices("pf");
  ok("Florida, ours: homeowners 150 and commercial auto 50 of 200", same(sb.map(s=>s.label),["Homeowners: $150M, 75.0%","Commercial auto: $50M, 25.0%"]), sb.map(s=>s.label));
  ok("Florida, pro forma: homeowners 240, farmowners 60, commercial auto 50 of 350", same(sp.map(s=>s.label),["Homeowners: $240M, 68.6%","Farmowners: $60M, 17.1%","Commercial auto: $50M, 14.3%"]), sp.map(s=>s.label));
  ok("the slices add up to Florida's total on each side", sb.reduce((a,s)=>a+s.v,0)===200*M && sp.reduce((a,s)=>a+s.v,0)===350*M);
  ok("the same line, the same colour, in both pies", sb.find(s=>s.k==="commercial auto").fill===sp.find(s=>s.k==="commercial auto").fill && sb.find(s=>s.k==="homeowners").fill===PAL[0] && sp.find(s=>s.k==="farmowners").fill===PAL[1] && sp.find(s=>s.k==="commercial auto").fill===PAL[2]);
  ok("the legend for Florida, with the change in share", same(await t.legend(),[["Homeowners","$150M","75.0%","$240M","68.6%","▼ -6.4 pts"],["Farmowners","None","0.0%","$60M","17.1%","▲ +17.1 pts"],["Commercial auto","$50M","25.0%","$50M","14.3%","▼ -10.7 pts"]]), await t.legend());
  ok("the change says up or down to a screen reader", await p.getAttribute('#cbpLegend tbody tr:nth-child(2) [role="img"]',"aria-label")==="up 17.1 points");
  await p.click("#cbmUnpin"); await p.waitForTimeout(80);
  ok("unpin: back to all states", (await t.txt("#cbPieH"))==="Premiums by line, all states, 2025" && !(await p.$("#cbmPin")));
  await t.click("GA"); await p.waitForTimeout(80);
  ok("another state: nothing more asked, the year's lines are in hand", t.slQueries().length===2);
  ok("a state only the target writes: ours says so in place of its pie", !(await p.$("#cbpSvg_base")) && (await t.txt("#cbpNone_base"))==="Our company writes nothing here in 2025." && same((await t.slices("pf")).map(s=>s.label),["Farmowners: $50M, 50.0%","Homeowners: $50M, 50.0%"]), await t.txt("#cbpNone_base"));
  ok("and the change is New", same(await t.legend(),[["Farmowners","None","","$50M","50.0%","New"],["Homeowners","None","","$50M","50.0%","New"]]), await t.legend());
  await t.click("TX");
  ok("a state only we write: the two pies alike, no change", same((await t.slices("base")).map(s=>s.label),["Homeowners: $250M, 62.5%","Commercial auto: $100M, 25.0%","Inland marine: $50M, 12.5%"]) && same((await t.slices("pf")).map(s=>s.label),(await t.slices("base")).map(s=>s.label)) && (await t.legend()).every(r=>r[5]==="0.0 pts"), await t.legend());
  await t.click("CA");
  ok("a state neither writes: both say so, and no legend", (await t.txt("#cbpNone_base"))==="Our company writes nothing here in 2025." && (await t.txt("#cbpNone_pf"))==="Neither side writes anything here in 2025." && !(await p.$("#cbpLegend")));
  // the year with a state pinned
  await t.click("CA"); await t.click("FL"); await t.year(2024);
  await t.until(async()=>t.slQueries().length===4); await t.settled(); await p.waitForTimeout(60);
  ok("a year change with a state pinned fetches that year once a side", same(t.slQueries().slice(2).map(q=>[q.codes, q.fromYear]).sort(),[[["9001"],2024],[["90107"],2024]]));
  ok("2024 in Florida: only the target writes there", (await t.txt("#cbPieH"))==="Premiums by line, Florida, 2024" && (await t.txt("#cbpNone_base"))==="Our company writes nothing here in 2024." && same((await t.slices("pf")).map(s=>s.label),["Homeowners: $120M, 100.0%"]), await t.txt("#cbpNone_base"));
  ok("a single line is drawn as a whole circle", (await p.$$eval("#cbpSvg_pf .cbpsl",e=>e.map(x=>(x.getAttribute("d").match(/A/g)||[]).length)))[0]===2);
  await t.year(2025); await t.year(2024); await t.year(2025); await p.click("#cbmUnpin"); await t.click("FL"); await p.waitForTimeout(100);
  ok("back and forth, unpin and pin again: nothing more asked", t.slQueries().length===4);
  // the line filter
  await t.line("Homeowners"); await t.line("Farmowners"); await p.waitForTimeout(80);
  ok("the line filter: the pies show the lines chosen only, and the heading says so", (await t.txt("#cbPieH"))==="Premiums by line, Florida, 2025: Homeowners and Farmowners only" && same((await t.slices("base")).map(s=>s.label),["Homeowners: $150M, 100.0%"]) && same((await t.slices("pf")).map(s=>s.label),["Homeowners: $240M, 80.0%","Farmowners: $60M, 20.0%"]), [await t.txt("#cbPieH"), (await t.slices("pf")).map(s=>s.label)]);
  ok("the filter keeps each line's colour", (await t.slices("pf"))[0].fill===PAL[0] && (await t.slices("pf"))[1].fill===PAL[1]);
  ok("no look-up for the filter, the year's lines are in hand", t.slQueries().length===4);
  d=await t.download(()=>p.click('#cbPie [data-act="export"][data-fmt="csv"]'));
  L=d.text.replace(/^\uFEFF/,"").split("\r\n");
  ok("export for a pinned state: its name, the lines in view and where from", d.name==="snl-combination-lines-fl-2025-2026-11-13.csv" && L.includes('"State","Florida (FL)","","","","",""') && L.includes('"Lines","Homeowners; Farmowners","","","","",""') && L.includes('"From","Premiums by state and line (dpw_by_state_line)","","","","",""') && L[1]==='"Homeowners","Its own slice","150000000","100","240000000","80","-20"', L);
  await p.click("#cbmClear"); await p.click("#cbmUnpin"); await p.waitForTimeout(60);
  await t.line("Homeowners");
  ok("the filter with no state pinned: all states' homeowners", (await t.txt("#cbPieH"))==="Premiums by line, all states, 2025: Homeowners only" && same((await t.slices("pf")).map(s=>s.label),["Homeowners: $760M, 100.0%"]));
  // nothing sent beyond the per-side look-ups
  ok("every look-up is one side's own", !t.calls.some(c=>/"9001"/.test(JSON.stringify(c.body)) && /"90107"/.test(JSON.stringify(c.body))) && t.queries().every(q=>same(q.codes,["9001"]) || same(q.codes,["90107"])));
  ok("nothing is written to the database", (await p.evaluate(()=>window.__mock.log)).filter(l=>l.op==="upsert").length===0);
  ok("nothing kept in browser storage", await p.evaluate(()=>!/9001|90107|Tarrow|Calloway|cbp|cbm|Homeowners|Farmowners|Florida/.test(JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))));
  await t.click("FL");
  await p.click("#askFab"); await p.waitForTimeout(150); await p.fill("#ask_input","What is direct premium?"); await p.click('[data-act="ask-send"]'); await p.waitForTimeout(300);
  const asked=t.calls.filter(c=>c.fn==="snl-chat" && c.body.action==="ask");
  ok("a question asked with the pies on screen carries no screen, side, state or line", asked.length===1 && !("screen" in asked[0].body) && !/9001|90107|Calloway|Tarrow|Homeowners|Farmowners|Florida|dpw_by/.test(JSON.stringify(asked[0].body)), asked.map(a=>a.body));
  await p.click("#askClose").catch(()=>{}); await p.waitForTimeout(100);
  await t.ctx.close();

  // ===== six slices then "Other"; zero and negative lines; and the figures that don't add up to premiums by state =====
  t=await open({mapped:true, o:{sl:WITH_NV}}); p=t.p;
  await t.click("NV"); await t.settled(); await t.until(async()=>!!(await p.$("#cbpSvg_pf"))); await p.waitForTimeout(60);
  sp=await t.slices("pf"); sb=await t.slices("base");
  ok("six named slices, largest first by the pro forma, then Other with how many lines it holds", same(sp.map(s=>s.label),["Homeowners: $120M, 30.0%","Farmowners: $70M, 17.5%","Commercial auto: $60M, 15.0%","Inland marine: $50M, 12.5%","Allied lines: $40M, 10.0%","Fire: $30M, 7.5%","Other (2 lines): $30M, 7.5%"]), sp.map(s=>s.label));
  ok("the six take the palette in order; Other is the neutral", same(sp.map(s=>s.fill), [...PAL, OTHER]));
  ok("a line below zero or at zero is left out of the pie: the slices are the lines above zero", sp.reduce((a,s)=>a+s.v,0)===400*M && same(sb.map(s=>s.label),["Homeowners: $40M, 100.0%"]));
  ok("and listed under it with its figures, and the total with them", (await t.txt("#cbpLow_pf"))==="Left out of the pie, as a pie can't show zero or below: Ocean marine $0M, Boiler and machinery ($5.0M). Shares are of the lines above zero, $400M; with the rest the total is $395M." && (await t.txt("#cbpLow_base"))==="Left out of the pie, as a pie can't show zero or below: Ocean marine $0M, Boiler and machinery ($5.0M). Shares are of the lines above zero, $40M; with the rest the total is $35M.", await t.txt("#cbpLow_pf"));
  ok("the legend: the six, then Other with its count", same(await t.legend(),[["Homeowners","$40M","100.0%","$120M","30.0%","▼ -70.0 pts"],["Farmowners","None","0.0%","$70M","17.5%","▲ +17.5 pts"],["Commercial auto","None","0.0%","$60M","15.0%","▲ +15.0 pts"],["Inland marine","None","0.0%","$50M","12.5%","▲ +12.5 pts"],["Allied lines","None","0.0%","$40M","10.0%","▲ +10.0 pts"],["Fire","None","0.0%","$30M","7.5%","▲ +7.5 pts"],["Other (2 lines)","None","0.0%","$30M","7.5%","▲ +7.5 pts"]]), await t.legend());
  ok("Other's swatch is the neutral", (await t.swatches()).pop()===rgb(OTHER));
  ok("a small slice has no label crowding it, a big one does", same(await p.$$eval("#cbpSvg_pf text",e=>e.map(x=>x.textContent)),["30.0%","17.5%","15.0%","12.5%","10.0%","7.5%","7.5%"]));
  ok("lines that don't add up to premiums by state keep the note, named for the state", (await t.txt("#cbpGap_base"))==="Our company's lines in Nevada add up to $35M, against $0M in its premiums by state. The pies show the lines." && !!(await p.$("#cbmGap_base")), await t.txt("#cbpGap_base"));
  d=await t.download(()=>p.click('#cbPie [data-act="export"][data-fmt="csv"]'));
  L=d.text.replace(/^\uFEFF/,"").split("\r\n");
  ok("export: every line, Other's lines and those left out each on their own row", L.includes('"Surety","Other","","0","20000000","5","5"') && L.includes('"Boiler and machinery","Left out: zero or below","-5000000","","-5000000","","n/d (left out of a pie: zero or below)"') && L.includes('"Ocean marine","Left out: zero or below","0","","0","","n/d (left out of a pie: zero or below)"'), L.slice(0,12));
  await t.ctx.close();

  // ===== a side n/d: premiums by line not mapped, before a state is clicked =====
  t=await open({o:{unmapped:["dpw_by_line"]}}); p=t.p;
  ok("premiums by line not mapped: both pies n/d with the reason, never drawn, no export", (await t.txt("#cbpNone_base"))==="n/d: not mapped." && (await t.txt("#cbpNone_pf"))==="n/d: Our company: not mapped; target: not mapped." && !(await p.$("#cbPie svg")) && !(await p.$("#cbPie [data-act=export]")) && !(await p.$("#cbpLegend")), [await t.txt("#cbpNone_base"), await t.txt("#cbpNone_pf")]);
  await t.ctx.close();

  // ===== the target's lines cut short at the row limit =====
  t=await open({mapped:true, o:{slTruncated:["90107"]}}); p=t.p;
  await t.click("FL"); await t.settled(); await t.until(async()=>!!(await p.$("#cbpSvg_base")));
  ok("cut short: the pro forma is n/d, never a part drawn as the whole; ours is drawn", !(await p.$("#cbpSvg_pf")) && (await t.txt("#cbpNone_pf"))==="n/d: target: cut short at the row limit. A part is never drawn as the whole." && (await t.slices("base")).length===2, await t.txt("#cbpNone_pf"));
  ok("the legend says n/d for the pro forma, with why", same((await t.legend())[0],["Homeowners","$150M","75.0%","n/d","","n/dtarget: cut short at the row limit"]), (await t.legend())[0]);
  await t.ctx.close();

  // ===== our company's not mapped for its look-up =====
  t=await open({mapped:true, o:{slUnmapped:true}}); p=t.p;
  await t.click("FL"); await t.settled(); await t.until(async()=>!!(await p.$("#cbpNone_pf")));
  ok("not mapped for the look-up: both n/d, said as not mapped", (await t.txt("#cbpNone_base"))==="n/d: not mapped." && (await t.txt("#cbpNone_pf"))==="n/d: Our company: not mapped; target: not mapped.", [await t.txt("#cbpNone_base"), await t.txt("#cbpNone_pf")]);
  await t.ctx.close();

  // ===== the target's failed, then retried =====
  t=await open({mapped:true}, {query:(body,n)=>same(body.fields,[ID])&&body.kind==="company"&&n===1 ? {status:502, body:{error:"snowflake_failed", message:"Snowflake didn't answer. Try again in a minute."}} : {status:200, body:answer(body, {})}}); p=t.p;
  await t.click("FL"); await t.until(async()=>!!(await p.$("#cbmSl_target[role=alert]")));
  ok("failed: the pro forma n/d, with the map's Try again", (await t.txt("#cbpNone_pf"))==="n/d: target: couldn't be fetched." && !!(await p.$("#cbpSvg_base")), await t.txt("#cbpNone_pf"));
  await p.click('#cbmSl_target [data-act="cbm-retry"]'); await t.until(async()=>!!(await p.$("#cbpSvg_pf")));
  ok("Try again asks for that side alone, and the pie is drawn", same(t.slQueries().map(q=>q.codes),[["9001"],["90107"],["90107"]]) && (await t.slices("pf")).length===3);
  await t.ctx.close();

  // ===== figures that didn't come back in time =====
  t=await open({mapped:true, o:{slPending:true}}); p=t.p;
  await t.click("FL"); await t.until(async()=>!!(await p.$("#cbmSl_base[role=alert]")));
  ok("late: both pies n/d with the reason", (await t.txt("#cbpNone_base"))==="n/d: didn't come back in time." && !(await p.$("#cbPie svg")), await t.txt("#cbpNone_base"));
  await t.ctx.close();

  // ===== hostile line names kept as text =====
  t=await open({mapped:true, o:{sl:{"90107":{2025:[["FL",'<img src=x onerror="window.__pwn=1">Homeowners',90], ["FL",'"><svg onload="window.__pwn=2">',60]]}}}}); p=t.p;
  await t.click("FL"); await t.settled(); await t.until(async()=>!!(await p.$("#cbpSvg_pf")));
  ok("a hostile line name is a slice's label and a legend row, as text", (await t.slices("pf")).some(s=>s.label==='<img src=x onerror="window.__pwn=1">Homeowners: $90M, 25.7%') && (await t.legend()).some(r=>r[0]==='"><svg onload="window.__pwn=2">') && !(await p.$("#cbPie img")) && (await p.$$("#cbPie svg")).length===2, await t.legend());
  q=await t.center("pf", '<img src=x onerror="window.__pwn=1">homeowners'); await p.mouse.move(q.x, q.y); await p.waitForTimeout(80);
  ok("and in the panel", (await t.txt("#cbpTip")).startsWith('<img src=x onerror="window.__pwn=1">Homeowners'), await t.txt("#cbpTip"));
  d=await t.download(()=>p.click('#cbPie [data-act="export"][data-fmt="csv"]'));
  ok("and in the export", d.text.includes('"<img src=x onerror=""window.__pwn=1"">Homeowners"'));
  ok("nothing in them ran", await p.evaluate(()=>window.__pwn===undefined));
  await t.ctx.close();

  // ===== 1440 and 390 wide =====
  t=await open({mapped:true}); p=t.p;
  ok("1440, all states: the two pies side by side", await p.evaluate(()=>{ const a=document.getElementById("cbpPie_base").getBoundingClientRect(), c=document.getElementById("cbpPie_pf").getBoundingClientRect(); return Math.abs(a.top-c.top)<2 && c.left>a.right; }) && await t.noScroll());
  await (await p.$("#cbPie")).screenshot({path:OUTDIR+"/combopie-all-1440.png"});
  await t.click("FL"); await t.settled(); await t.until(async()=>!!(await p.$("#cbpSvg_pf"))); await p.waitForTimeout(80);
  ok("1440, a state pinned: side by side, no sideways scroll", await p.evaluate(()=>{ const a=document.getElementById("cbpPie_base").getBoundingClientRect(), c=document.getElementById("cbpPie_pf").getBoundingClientRect(); return Math.abs(a.top-c.top)<2; }) && await t.noScroll());
  await (await p.$("#cbmPin")).screenshot({path:OUTDIR+"/combopie-pin-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("390: the pies stack, nothing scrolls sideways", await p.evaluate(()=>{ const a=document.getElementById("cbpPie_base").getBoundingClientRect(), c=document.getElementById("cbpPie_pf").getBoundingClientRect(); return c.top>=a.bottom-1; }) && await t.noScroll() && await p.$eval("#cbpSvg_pf",e=>e.getBoundingClientRect().width<=358));
  await (await p.$("#cbmPin")).screenshot({path:OUTDIR+"/combopie-pin-390.png"});
  await t.ctx.close();

  // ===== by touch at 390: tap a state, then a slice =====
  t=await open({mapped:true, o:{sl:WITH_NV}}, {width:390, touch:true}); p=t.p;
  ok("390 by touch: the all-states pies, no sideways scroll", (await t.slices("pf")).length===4 && await t.noScroll());
  await t.tap("NV"); await t.settled(); await t.until(async()=>!!(await p.$("#cbpSvg_pf"))); await p.waitForTimeout(80);
  ok("a tap pins the state, fetches its lines once a side and draws its pies", t.slQueries().length===2 && (await t.txt("#cbPieH"))==="Premiums by line, Nevada, 2025" && (await t.slices("pf")).length===7);
  q=await t.center("pf","farmowners"); await p.touchscreen.tap(q.x, q.y); await p.waitForTimeout(120);
  ok("a tap on a slice shows its panel", await p.isVisible("#cbpTip") &&(await t.txt("#cbpTip"))==="Farmowners Pro forma, Nevada, 2025 $70M, 17.5% of $400M", await t.txt("#cbpTip"));
  ok("the panel stays inside the page", await t.noScroll());
  await p.touchscreen.tap(10, 10); await p.waitForTimeout(100);
  ok("a tap elsewhere hides it", !(await p.isVisible("#cbpTip")));
  ok("still no sideways scroll with the legend of seven lines", await t.noScroll());
  await (await p.$("#cbmPin")).screenshot({path:OUTDIR+"/combopie-touch-390.png"});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
