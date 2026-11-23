// The Combination view's change on our company (Corp Dev only): how the pro forma differs from our company standalone,
// in percent for dollars, percentage points for percent ratios and x for multiples, with an up or down arrow, in the
// by-year tables, the scale tiles, the mix tables and the state map's table, hover panel, pinned state and export, and
// a "Show change" tick box that hides it everywhere. Covers: every kind of change against hand-worked numbers (up,
// down, zero, rounding to zero, ours zero, ours negative, either side n/d, never-combined rows, "New"); arrows with
// their accessible labels; colour only on the lower-is-better figures and in the right sense, with enough contrast;
// the tiles (with and without a company name setting); the mix tables; the map's table, hover panel, pinned detail and
// sorting by change (New and n/d placed sensibly and stably); the line filter and year flowing through; the exports;
// the tick box off and on; nothing new sent or stored; hostile names; 1440 and 390 wide.
// Every company, code and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), F=FIX("combination_figures.json"), SL=FIX("combomap_state_lines.json"), MORE=FIX("combochange_figures.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG=org=>`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"${org===undefined?"":",orgName:"+JSON.stringify(org)}};`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const M=1e6, ID="dpw_by_state_line";
const PCT=new Set(["loss_ratio","loss_lae_ratio","expense_ratio","combined_ratio","rbc_ratio","roae","investment_yield","commission_ratio"]);
const GROUP_BASE={kind:"group", codes:["9001"], label:"Calloway Group"};
// The Combination figures with a few more (combochange_figures.json) for the cases those don't reach.
const FIG=copy(F); for(const [code, figs] of Object.entries(MORE.codes)) Object.assign(FIG.codes[code], figs);
// Our side also reports a negative $5M in Wyoming, so one state's change is n/d (ours negative) for sorting.
const FIG_WY=copy(FIG); FIG_WY.codes["9001"].dpw_by_state["2025"].WY=-5;
const statusWith=mapped=>({...copy(STAT.statusMapped), companies:{mapped:false, problem:null}, fields:[...copy(STAT.statusMapped.fields), {id:ID, label:"Direct premiums written by state and line", unit:"usd", by:"state_line", mapped}]});
const MAGENTA="rgb(235, 0, 140)", TEAL="rgb(0, 133, 124)", INK="rgb(38, 33, 102)";
const lum=rgb=>{ const c=rgb.match(/\d+/g).slice(0,3).map(v=>+v/255).map(v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)); return .2126*c[0]+.7152*c[1]+.0722*c[2]; };
const contrast=(a,b)=>{ const x=lum(a), y=lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };

/* The statutory function's answer to one query: figures from o.fig (FIG by default), premiums by state and line from SL. */
function answer(body, o={}){
  const fig=o.fig||FIG, dim=id=>/_by_line$/.test(id)?"line":/_by_state$/.test(id)?"state":/_by_reinsurer$/.test(id)?"item":null;
  const fields=(body.fields||[]).map(id=>{
    if(id===ID){
      const f={id, label:"Direct premiums written by state and line", unit:"usd", by:"state_line", mapped:true, error:null, rows:[]};
      for(const code of body.codes) for(let y=body.fromYear;y<=body.toYear;y++) for(const [state,line,v] of ((SL.codes[code]||{})[y]||[])) f.rows.push({code, year:y, line, state, value:v*M});
      return f;
    }
    const f={id, label:id, unit:PCT.has(id)?"pct":"usd", by:dim(id)||"year", mapped:!(o.unmapped||[]).includes(id), error:null, rows:[]};
    if(!f.mapped) return f;
    for(const code of body.codes){
      const err=o.errors&&o.errors[code]&&o.errors[code][id]; if(err){ f.error=err; f.rows=[]; break; }
      const d=(fig.codes[code]||{})[id]; if(!d) continue;
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
  return {kind:body.kind, codes:body.codes, fromYear:body.fromYear, toYear:body.toYear, entities:body.codes.map(c=>({code:c, name:fig.names[c]||null})), fields,
    loaded:[{view:"STAT_FINANCIALS", at:"2026-10-28"}], truncated:false, source:"S&P Global Market Intelligence statutory data, through Snowflake", fetchedAt:"2026-11-13T11:59:00Z", fromStore:false, saved:true, pending:0};
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], role:"corpdev", stat:()=>statusWith(!!opts.mapped),
      o:{fig:opts.fig, unmapped:["pyd"], errors:{"9001":{unearned_premiums:"Snowflake couldn't find the column UNEARNED in STAT_FINANCIALS. Check the mapping."}}}};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:t.role, statutory:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2, resetsAt:"2026-11-14T00:00:00Z"});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(fn==="snl-statutory"){ if(body.action==="status") return J(200, t.stat()); if(body.action==="query") return J(200, answer(body, t.o)); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG(opts.org)});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; }, {role:t.role, seed:[["snl_settings","combination_base",{doc:opts.base||GROUP_BASE}]]});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    await p.evaluate(()=>{ location.hash="#combination"; }); await p.waitForTimeout(350);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.until=async (cond, ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await cond()) return true; await p.waitForTimeout(40); } return false; };
    // a by-year change cell: its text, why it is n/d, the arrow's label and colour
    t.chg=async (row, y)=>p.evaluate(([row,y])=>{ const td=document.querySelector(`#cbResults tr[data-row="${row}"] td[data-s="c"][data-y="${y}"]`); if(!td) return null;
      const why=td.querySelector(".cbwhy"), img=td.querySelector('[role="img"]'), arr=td.querySelector(".cbarr");
      return {v:[...td.childNodes].filter(n=>!(n.classList&&n.classList.contains("cbwhy"))).map(n=>n.textContent).join("").trim(), why:why?why.textContent.trim():"", label:img?img.getAttribute("aria-label"):"", color:arr?getComputedStyle(arr).color:"", tone:td.querySelector(".adv")?"adv":td.querySelector(".fav")?"fav":""}; }, [row, String(y)]);
    t.mapTable=()=>p.$$eval("#cbTab_map tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    t.go=async ()=>{ await p.fill("#cb_target_codes", "90107"); await p.click("#cbGo"); await t.until(async()=>!(await p.$("#cbResults .banner[role=status] .pb")) && !!(await p.$("#cbMap"))); await p.waitForTimeout(100); };
    t.pt=async code=>{ await p.$eval("#cbm_s_"+code, e=>e.scrollIntoView({block:"center"})); return p.evaluate(c=>{ const e=document.getElementById("cbm_s_"+c), svg=e.ownerSVGElement, q=svg.createSVGPoint(), m=US_MAP[c];
      if(m.length>2){ q.x=m[2]; q.y=m[3]; } else { const bb=e.getBBox(); q.x=bb.x+bb.width/2; q.y=bb.y+bb.height/2; } const r=q.matrixTransform(svg.getScreenCTM()); return {x:r.x, y:r.y}; }, code); };
    t.hover=async code=>{ const q=await t.pt(code); await p.mouse.move(q.x, q.y); await p.waitForTimeout(80); };
    t.click=async code=>{ const q=await t.pt(code); await p.mouse.click(q.x, q.y); await p.waitForTimeout(80); };
    t.sort=async k=>{ await p.click(`#cbTab_map [data-act="cbm-sort"][data-k="${k}"]`); await p.waitForTimeout(60); };
    t.line=async name=>{ if(!(await p.$("#cbmLineBox"))){ await p.click("#cbmPick"); await p.waitForTimeout(60); } const h=await p.evaluateHandle(n=>[...document.querySelectorAll("#cbmLineList input")].find(i=>i.dataset.name===n), name); await h.asElement().click(); await p.waitForTimeout(80); };
    t.year=async y=>{ await p.selectOption("#cbm_year", String(y)); await p.waitForTimeout(80); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8").replace(/^﻿/,"")}; };
    t.toggle=async ()=>{ await p.click("#cb_chg"); await p.waitForTimeout(120); };
    await t.go();
    return t;
  }

  // ===== the by-year tables: every kind of change, against hand-worked numbers =====
  let t=await open({}); let p=t.p;
  ok("the tick box is above the by-year tables, on by default", await p.isChecked("#cb_chg") && await p.evaluate(()=>!!(document.getElementById("cbChgBar").compareDocumentPosition(document.getElementById("cbTab_prem")) & Node.DOCUMENT_POSITION_FOLLOWING)));
  ok("one line says what Change is", (await t.txt("#cbChgWhat"))==="Change is the pro forma against Our company standalone: in percent for dollars, in percentage points (pts) for percent ratios and in x for multiples. It is n/d when either figure is, and a percent change is n/d when ours is zero or negative.", await t.txt("#cbChgWhat"));
  ok("four columns a year: ours, target, pro forma, then Change with our company's name in its note", same(await p.$$eval("#cbTab_prem thead tr:nth-child(2) th",e=>e.slice(0,4).map(x=>x.textContent)),["Our company","Target","Pro forma","Changeon Our company"]) && same(await p.$$eval("#cbTab_prem thead th.cbyr",e=>e.map(x=>x.getAttribute("colspan"))),["4","4","4","4","4"]));
  // dollars: percent change
  let c=await t.chg("dpw",2025);
  ok("dollars up: direct premiums 1,000 to 1,250 is up 25.0%", c.v==="▲ +25.0%" && c.label==="up 25.0%" && c.why==="", c);
  ok("dollars, rounded to one decimal: net premiums written 820 to 1,000 is up 22.0% (21.95)", (await t.chg("npw",2025)).v==="▲ +22.0%", await t.chg("npw",2025));
  ok("surplus 1,000 to 1,300: up 30.0%", (await t.chg("surplus",2025)).v==="▲ +30.0%");
  c=await t.chg("realized_gains",2025);
  ok("dollars down: realized gains 40 to 28 is down 30.0%", c.v==="▼ -30.0%" && c.label==="down 30.0%", c);
  c=await t.chg("surplus",2023);
  ok("down past zero: surplus 300 to (100) is down 133.3%", c.v==="▼ -133.3%" && c.label==="down 133.3%", c);
  c=await t.chg("cash_short_term",2025);
  ok("a change that rounds to zero: 2,000 to 2,000.5 shows 0.0% with no arrow", c.v==="0.0%" && c.label==="" && !c.color, c);
  c=await t.chg("cash_invested",2025);
  ok("ours zero: n/d, saying a percent change from zero means nothing", c.v==="n/d" && c.why==="ours is zero: no percent change", c);
  c=await t.chg("net_income",2023);
  ok("ours negative: n/d, saying why (net income (20) to (50))", c.v==="n/d" && c.why==="ours is negative: no percent change", c);
  c=await t.chg("net_income",2025);
  ok("the target n/d: no change, saying which side", c.v==="n/d" && c.why==="target: none returned", c);
  c=await t.chg("unearned_premiums",2025);
  ok("ours n/d: no change, saying which side", c.v==="n/d" && c.why==="base: couldn't be read", c);
  ok("a missing year on the target: n/d", (await t.chg("surplus",2021)).why==="target: none returned");
  // percent ratios: points
  c=await t.chg("loss_ratio",2025);
  ok("percent ratios in points, never a percent of a percent: loss ratio 60.0 to 62.0 is up 2.0 pts", c.v==="▲ +2.0 pts" && c.label==="up 2.0 points", c);
  ok("expense ratio 25.0 to 25.9: up 0.9 pts", (await t.chg("expense_ratio",2025)).v==="▲ +0.9 pts");
  ok("combined ratio 95.0 (as reported) to 97.9: up 2.9 pts", (await t.chg("combined_ratio",2025)).v==="▲ +2.9 pts", await t.chg("combined_ratio",2025));
  c=await t.chg("combined_ratio",2023);
  ok("combined ratio 2023, 112.0 to 110.9 ((85 x 700 + 78 x 180) / 880 + (27 x 730 + 29 x 160) / 890): down 1.1 pts", c.v==="▼ -1.1 pts" && c.label==="down 1.1 points", c);
  ok("cession share 25.5 to 26.5 ((1,100 - 820) / 1,100 to (1,360 - 1,000) / 1,360): up 1.0 pts", (await t.chg("cession_pct",2025)).v==="▲ +1.0 pts", await t.chg("cession_pct",2025));
  ok("a ratio n/d in the pro forma: the change is n/d with the same reason", same(await t.chg("loss_ratio",2024),{v:"n/d", why:"target net premiums earned zero or negative", label:"", color:"", tone:""}), await t.chg("loss_ratio",2024));
  // multiples: x
  c=await t.chg("npw_to_surplus",2025);
  ok("multiples in x: net premiums written to surplus 0.82 to 0.77 is down 0.1x", c.v==="▼ -0.1x" && c.label==="down 0.1 times", c);
  ok("a multiple that rounds to zero: reserves to surplus 0.60 to 0.58 shows 0.0x, no arrow", (await t.chg("reserves_to_surplus",2025)).v==="0.0x" && !(await t.chg("reserves_to_surplus",2025)).color);
  ok("a multiple n/d when the surplus is negative", (await t.chg("npw_to_surplus",2023)).v==="n/d" && (await t.chg("npw_to_surplus",2023)).why==="surplus zero or negative");
  // never combined
  ok("never-combined rows have no change: their table keeps three columns a year", !(await p.$('#cbTab_never td[data-s="c"]')) && !(await p.$("#cbTab_never th.cbchgh")) && same(await p.$$eval("#cbTab_never thead th.cbyr",e=>e.map(x=>x.getAttribute("colspan"))),["3","3","3","3","3"]));
  // colour
  const tone=async (row,y)=>(await t.chg(row,y));
  ok("lower is better and it went up: the arrow is in the page's adverse magenta", (await tone("loss_ratio",2025)).color===MAGENTA && (await tone("loss_ratio",2025)).tone==="adv" && (await tone("combined_ratio",2025)).color===MAGENTA && (await tone("expense_ratio",2025)).color===MAGENTA && (await tone("loss_lae_ratio",2025)).color===MAGENTA);
  ok("lower is better and it went down: favourable teal (combined ratio 2023, a ratio to surplus)", (await tone("combined_ratio",2023)).color===TEAL && (await tone("npw_to_surplus",2025)).color===TEAL && (await tone("npw_to_surplus",2025)).tone==="fav");
  ok("dollars and the cession share stay in the ordinary text colour, up or down", [await tone("dpw",2025), await tone("realized_gains",2025), await tone("surplus",2023), await tone("cession_pct",2025)].every(x=>x.color===INK && x.tone===""), [await tone("dpw",2025), await tone("cession_pct",2025)]);
  ok("the number beside a coloured arrow stays in the text colour", await p.$eval('#cbResults tr[data-row="loss_ratio"] td[data-s="c"][data-y="2025"] [role="img"]',e=>getComputedStyle(e).color)===INK);
  ok("the colours are explained in one line under the tables", (await t.txt("#cbChgKey"))==="▲ Magenta: worse, and ▼ teal: better, for the loss, loss and LAE, expense and combined ratios and the ratios to surplus, where lower is better. Every other change stays in the ordinary colour: bigger is not better or worse in itself.", await t.txt("#cbChgKey"));
  const bgs=await p.$$eval('#cbTab_ratio tbody tr',rs=>rs.slice(0,2).map(r=>getComputedStyle(r.querySelector("td")).backgroundColor));
  const shades=[...new Set(["rgb(255, 255, 255)", ...bgs.filter(x=>!/rgba\(0, 0, 0, 0\)/.test(x))])];
  ok("contrast: each arrow at least 3:1 on every row shade, the number at least 4.5:1", shades.length>=2 && shades.every(s=>contrast(MAGENTA,s)>=3 && contrast(TEAL,s)>=3 && contrast(INK,s)>=4.5), shades.map(s=>[s, contrast(MAGENTA,s).toFixed(2), contrast(TEAL,s).toFixed(2), contrast(INK,s).toFixed(2)]));
  ok("in grey the direction still reads: every arrow sits beside a signed number and has a label", await p.$$eval('#cbResults [role="img"]',e=>e.length>0 && e.every(x=>/^[▲▼] [+-][\d,]+\.\d( pts|x|%)$/.test(x.textContent) && /^(up|down) [\d,]+\.\d(%| points| times)$/.test(x.getAttribute("aria-label")) && (x.textContent[0]==="▲")===(x.textContent[2]==="+") && (x.textContent[0]==="▲")===x.getAttribute("aria-label").startsWith("up"))));
  ok("the arrows are text characters, not images or an icon font", !(await p.$("#cbResults [role=img] img, #cbResults [role=img] svg")) && await p.$$eval("#cbResults .cbarr",e=>e.every(x=>/^[▲▼]$/.test(x.textContent))));
  // tiles
  ok("the pro forma tiles carry the change on our company; the share tiles don't", same(await p.$$eval("#cbScale .sntile",e=>e.map(x=>{ const s=x.querySelector(".cbtchg"); return s?s.textContent.replace(/\s+/g," ").trim():null; })),["▲ +25.0% on our company","▲ +22.0% on our company","▲ +30.0% on our company",null,null]), await p.$$eval("#cbScale .sntile",e=>e.map(x=>x.textContent)));
  ok("a tile's arrow has its label too", await p.getAttribute('#cbScale [data-k="dpw"] [role="img"]',"aria-label")==="up 25.0%");
  // mix tables
  const mix=id=>p.$$eval(`#cbTab_${id} tbody tr`,rs=>rs.map(r=>[r.children[0].textContent, r.children[6].textContent, r.lastElementChild.textContent.replace(/\s+/g," ").trim()]));
  ok("by line: a change column against ours; New where only the target writes; 0.0% where only we do", same(await p.$$eval("#cbTab_lines thead th",e=>e.map(x=>x.textContent)).then(h=>h.slice(-1)),["Changeon Our company"]) && same(await mix("lines"),[["Homeowners","$750M","▲ +25.0%"],["Commercial auto","$250M","0.0%"],["Inland marine","$150M","0.0%"],["Farmowners","$100M","New"]]), await mix("lines"));
  ok("by state, with Other: FL 200 to 350 up 75.0%, GA new, the rest only ours", same(await mix("states"),[["TX","$400M","0.0%"],["FL","$350M","▲ +75.0%"],["GA","$100M","New"],["LA","$100M","0.0%"],["OK","$80M","0.0%"],["AR","$70M","0.0%"],["MS","$60M","0.0%"],["Other","$90M","0.0%"]]), await mix("states"));
  ok("mix changes are never coloured", !(await p.$("#cbTab_lines .adv, #cbTab_lines .fav, #cbTab_states .adv, #cbTab_states .fav")));
  ok("the note under a mix table says what Change and New are", (await t.txt("#cb_lines")).includes('Change is the pro forma against Our company in that line; "New" means only the target writes it.'));
  // the map's table, hover panel and pinned state
  ok("the map's table has a change column, sortable", (await p.$$eval("#cbTab_map thead th",e=>e.map(x=>x.textContent.trim()))).pop()==="Change on Our company" && !!(await p.$('#cbTab_map [data-act="cbm-sort"][data-k="c"]')));
  ok("the map's table: FL up 75.0%, GA new, TX only ours 0.0%", same((await t.mapTable()).map(r=>[r[0], r[9]]).filter(r=>/FL|GA|TX/.test(r[0])),[["Texas (TX)","0.0%"],["Florida (FL)","▲ +75.0%"],["Georgia (GA)","New"]]), await t.mapTable());
  await t.sort("c");
  ok("sorted by change, largest first: New, then the rises, then no change by name", same((await t.mapTable()).map(r=>r[0].slice(-3,-1)),["GA","FL","AL","AR","LA","MS","NM","OK","TX"]) && await p.getAttribute('#cbTab_map th:last-child',"aria-sort")==="descending", (await t.mapTable()).map(r=>r[0]));
  await t.sort("c");
  ok("and turned round: no change by name, then the rises, New last", same((await t.mapTable()).map(r=>r[0].slice(-3,-1)),["AL","AR","LA","MS","NM","OK","TX","FL","GA"]) && await p.getAttribute('#cbTab_map th:last-child',"aria-sort")==="ascending", (await t.mapTable()).map(r=>r[0]));
  await t.hover("FL");
  ok("the hover panel shows the change on our company", (await t.txt("#cbmTip")).includes("Target$150M60.0%Pro forma$350M28.0%Change on Our company▲ +75.0%Target's share here42.9%"), await t.txt("#cbmTip"));
  await t.hover("TX");
  ok("and 0.0% where only we write", (await t.txt("#cbmTip")).includes("Change on Our company0.0%"), await t.txt("#cbmTip"));
  await t.hover("GA");
  ok("and New where only the target writes", (await t.txt("#cbmTip")).includes("Change on Our companyNew"), await t.txt("#cbmTip"));
  await t.click("FL");
  ok("the pinned state's detail shows the same change", (await t.txt("#cbmPinChg"))==="Change on Our company (the pro forma against Our company alone): ▲ +75.0%." && await p.getAttribute('#cbmPinChg [role="img"]',"aria-label")==="up 75.0%", await t.txt("#cbmPinChg"));
  await p.click("#cbmUnpin"); await p.waitForTimeout(60);
  // exports
  let d=await t.download(()=>p.click('#cbResults [data-act="export"][data-tbl="years"][data-fmt="csv"]'));
  let L=d.text.split("\r\n");
  ok("export by year: the change beside each pro forma column, its unit in its own column", L[0].startsWith('"Figure","How","Unit","Change in","2025 Our company","2025 target","2025 pro forma","2025 change (see Change in)","2024 Our company"'), L[0]);
  ok("export by year: percent change as a number, unit Change %, how it is worked out", L.some(l=>l.startsWith('"Direct premiums written","Added. Change: (pro forma less Our company) over Our company, in percent; n/d when Our company\'s figure is zero or negative","US dollars","Change %","1000000000","250000000","1250000000","25",')), L.find(l=>l.startsWith('"Direct premiums written"')));
  ok("export by year: points for percent ratios, x for multiples", L.some(l=>l.startsWith('"Combined ratio","Derived: weighted loss and LAE ratio plus weighted expense ratio. Change: pro forma less Our company, in percentage points","%","Change pts","95","110","97.9","2.9",')) && L.some(l=>l.startsWith('"Net premiums written to surplus","Derived: from the added dollars. Change: pro forma less Our company, in x","times","Change x","0.82","0.6","0.7692","-0.1",')), L.filter(l=>/^"(Combined ratio|Net premiums written to surplus)"/.test(l)));
  ok("export by year: n/d with the reason as text, 0 for a change that rounds to zero", L.some(l=>l.startsWith('"Cash and invested assets",') && l.includes('"0","50000000","50000000","n/d (ours is zero: no percent change)"')) && L.some(l=>l.startsWith('"Cash and short-term investments",') && l.includes('"2000000000","500000","2000500000","0"')) && L.some(l=>l.startsWith('"Net income",') && l.includes('"n/d (ours is negative: no percent change)"')), L.filter(l=>/^"(Cash|Net income)/.test(l)));
  ok("export by year: never-combined rows have no change", L.some(l=>/^"Risk-based capital ratio","Not combined: [^"]*","%","","450","300","Not combined","",/.test(l)), L.find(l=>l.startsWith('"Risk-based capital ratio"')));
  ok("export by year: no arrows", !/[▲▼]/.test(d.text));
  d=await t.download(()=>p.click('#cb_lines [data-act="export"][data-fmt="csv"]'));
  L=d.text.split("\r\n");
  ok("export by line: Change % after the pro forma; New as text; how it is worked out", L[0].endsWith('"Pro forma US dollars","Pro forma share %","Change %"') && L.includes('"Homeowners","Both","600000000","60","150000000","60","750000000","60","25"') && L.includes('"Farmowners","Target only","","","100000000","40","100000000","8","New"') && L.includes('"Commercial auto","Our company only","250000000","25","","","250000000","20","0"') && L.some(l=>l.startsWith('"Change","The pro forma against Our company standalone: (pro forma less Our company) over Our company, in percent. New: only the target writes it."')) && !/[▲▼]/.test(d.text), L);
  d=await t.download(()=>p.click('#cb_states [data-act="export"][data-fmt="csv"]'));
  ok("export by state: the same", d.text.includes('"FL","Both","200000000","20","150000000","60","350000000","28","75"') && d.text.includes('"GA","Target only","","","100000000","40","100000000","8","New"'), d.text.slice(0,600));
  d=await t.download(()=>p.click('#cbMap [data-act="export"][data-fmt="csv"]'));
  L=d.text.split("\r\n");
  ok("export of the map's table: Change % last, in the table's order (by change, smallest first), how it is worked out", L[0].endsWith('"Target\'s share of the state %","Change %"') && L[1].startsWith('"Alabama","AL",') && L[9].startsWith('"Georgia","GA",') && L[9].endsWith(',"New"') && L.includes('"Florida","FL","Both","200000000","20","150000000","60","350000000","28","42.9","75"') && L.some(l=>l.startsWith('"Change","The pro forma against Our company standalone')) && !/[▲▼]/.test(d.text), L.slice(0,4));
  // the line filter and the year flow through (premiums by state and line mapped)
  await t.ctx.close();
  t=await open({mapped:true}); p=t.p;
  await t.line("Homeowners");
  await t.until(async()=>!(await p.$("#cbmSl_target")) && !(await p.$("#cbmSl_base")) && (await t.mapTable()).length===7);
  ok("one line: homeowners in each state, FL 150 to 240 up 60.0%, GA and RI new", same((await t.mapTable()).map(r=>[r[0].slice(-3,-1), r[9]]),[["TX","0.0%"],["FL","▲ +60.0%"],["LA","0.0%"],["AR","0.0%"],["GA","New"],["MS","0.0%"],["RI","New"]]), await t.mapTable());
  await t.sort("c");
  ok("sorted by change under the filter: New by name, then FL, then no change by name", same((await t.mapTable()).map(r=>r[0].slice(-3,-1)),["GA","RI","FL","AR","LA","MS","TX"]), (await t.mapTable()).map(r=>r[0]));
  await t.hover("FL");
  ok("the hover panel follows the filter", (await t.txt("#cbmTip")).includes("Change on Our company▲ +60.0%"), await t.txt("#cbmTip"));
  await t.year(2024);
  await t.until(async()=>!(await p.$("#cbmSl_target")) && !(await p.$("#cbmSl_base")) && (await t.mapTable()).length===2);
  ok("2024: TX only ours 0.0%, FL only the target New, still sorted by change", same((await t.mapTable()).map(r=>[r[0].slice(-3,-1), r[9]]),[["FL","New"],["TX","0.0%"]]), await t.mapTable());
  await t.ctx.close();

  // ===== n/d in the map's table sorts last either way; ours negative in one state =====
  t=await open({fig:FIG_WY}); p=t.p;
  ok("a state where ours is negative: n/d, saying why", same((await t.mapTable()).find(r=>r[0].includes("(WY)")).slice(-1),["n/dours is negative: no percent change"]), (await t.mapTable()).find(r=>r[0].includes("(WY)")));
  await t.sort("c");
  ok("sorted by change, n/d last", (await t.mapTable()).map(r=>r[0].slice(-3,-1)).pop()==="WY" && (await t.mapTable())[0][0]==="Georgia (GA)");
  await t.sort("c");
  ok("turned round, n/d still last", (await t.mapTable()).map(r=>r[0].slice(-3,-1)).pop()==="WY" && (await t.mapTable())[0][0]==="Alabama (AL)");
  const order1=(await t.mapTable()).map(r=>r[0]); await t.sort("c"); await t.sort("c");
  ok("and the order is the same each time (stable)", same((await t.mapTable()).map(r=>r[0]), order1));
  await t.ctx.close();

  // ===== the tick box: off hides it everywhere, on brings it back; nothing sent or kept =====
  t=await open({}); p=t.p;
  await t.sort("c");
  const callsBefore=t.calls.length, upsertsBefore=(await p.evaluate(()=>window.__mock.log)).filter(l=>l.op!=="select").length;
  await t.toggle();
  ok("Show change off: unticked, and the line says it is hidden", !(await p.isChecked("#cb_chg")) && (await t.txt("#cbChgWhat"))==="Change is hidden. Tick Show change to see the pro forma against Our company in every table on this view.");
  ok("off: no change column in any by-year table, three columns a year again", !(await p.$('#cbResults td[data-s="c"]')) && !(await p.$("#cbResults th.cbchgh")) && same(await p.$$eval("#cbTab_prem thead th.cbyr",e=>e.map(x=>x.getAttribute("colspan"))),["3","3","3","3","3"]));
  ok("off: no change on the tiles, the mix tables or the map's table, no colour key", !(await p.$("#cbScale .cbtchg")) && (await p.$$eval("#cbTab_lines thead th",e=>e.length))===8 && (await p.$$eval("#cbTab_map thead th",e=>e.length))===9 && !(await p.$("#cbChgKey")) && !(await p.$('#cbResults [role="img"]')));
  ok("off: the map's table, sorted by change before, falls back to the pro forma", (await t.mapTable())[0][0]==="Texas (TX)", (await t.mapTable()).map(r=>r[0]));
  await t.hover("FL");
  ok("off: the hover panel has no change", !(await t.txt("#cbmTip")).includes("Change on"));
  await t.click("FL");
  ok("off: the pinned state has no change", !(await p.$("#cbmPinChg")) && await p.isVisible("#cbmPin"));
  d=await t.download(()=>p.click('#cbResults [data-act="export"][data-tbl="years"][data-fmt="csv"]'));
  ok("off: the export is the tables as on screen, without the change", d.text.split("\r\n")[0].startsWith('"Figure","How","Unit","2025 Our company","2025 target","2025 pro forma","2024 Our company"') && !/Change/.test(d.text.split("\r\n")[0]));
  d=await t.download(()=>p.click('#cbMap [data-act="export"][data-fmt="csv"]'));
  ok("off: the map's export too", d.text.split("\r\n")[0].endsWith('"Target\'s share of the state %"'));
  await t.toggle();
  ok("on again: everything is back", await p.isChecked("#cb_chg") && (await t.chg("dpw",2025)).v==="▲ +25.0%" && !!(await p.$("#cbScale .cbtchg")) && (await p.$$eval("#cbTab_lines thead th",e=>e.length))===9 && !!(await p.$("#cbmPinChg")));
  ok("the tick box keeps focus after it is used", await p.evaluate(()=>document.activeElement&&document.activeElement.id)==="cb_chg");
  ok("switching asks for nothing: no new request of any kind", t.calls.length===callsBefore, t.calls.slice(callsBefore).map(c=>c.fn+":"+c.body.action));
  ok("and writes nothing", (await p.evaluate(()=>window.__mock.log)).filter(l=>l.op!=="select").length===upsertsBefore);
  ok("nothing about the change or the tick box is kept in browser storage", await p.evaluate(()=>!/chg|change|9001|90107|Tarrow/i.test(JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))), await p.evaluate(()=>JSON.stringify({...localStorage})));
  ok("the whole view asked for the two statutory look-ups and nothing else about the pair", t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query").length===2 && !t.calls.some(c=>/"9001"/.test(JSON.stringify(c.body)) && /"90107"/.test(JSON.stringify(c.body))));
  ok("Claude is still told nothing about this view", await p.evaluate(()=>askScreen()===null));
  // width
  ok("1440: no sideways scroll", await t.noScroll());
  ok("the year groups stay distinct: a darker rule before each year's first column", await p.$eval('#cbTab_prem tr[data-row="dpw"] td.cbfirst',e=>getComputedStyle(e).borderLeftColor)==="rgb(169, 173, 189)" && await p.$eval('#cbTab_prem tr[data-row="dpw"] td.cbfirst',e=>getComputedStyle(e).borderLeftWidth)==="2px");
  ok("the first column stays in view as the years scroll", await p.$eval('#cbTab_prem tr[data-row="dpw"] td:first-child',e=>getComputedStyle(e).position)==="sticky" && await p.$eval('#cbTab_prem thead tr:first-child th:first-child',e=>getComputedStyle(e).position)==="sticky");
  await p.screenshot({path:OUTDIR+"/combochange-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("390: no sideways scroll; the wide tables scroll in their own box", await t.noScroll() && await p.$eval("#cbWrap_prem",e=>e.scrollWidth>e.clientWidth));
  const w390=await p.evaluate(()=>{ const wrap=document.getElementById("cbWrap_ratio").getBoundingClientRect(), first=document.querySelector('#cbTab_ratio tr[data-row="combined_ratio"] td:first-child').getBoundingClientRect(), chg=document.querySelector('#cbTab_ratio tr[data-row="combined_ratio"] td[data-s="c"]').getBoundingClientRect(); return {first:first.width, chgRight:chg.right, wrapRight:wrap.right}; });
  ok("390: the first column is narrower but readable, and the latest year's change is in view beside it", w390.first>=110 && w390.first<=134 && w390.chgRight<=w390.wrapRight+1, w390);
  await p.$eval("#cbWrap_prem",e=>{ e.scrollLeft=400; }); await p.waitForTimeout(60);
  ok("390: scrolled sideways, the row names are still there", await p.evaluate(()=>{ const wrap=document.getElementById("cbWrap_prem").getBoundingClientRect(), td=document.querySelector('#cbTab_prem tr[data-row="dpw"] td:first-child').getBoundingClientRect(); return Math.abs(td.left-wrap.left)<3; }));
  await p.$eval("#cbWrap_prem",e=>{ e.scrollLeft=0; }); await p.waitForTimeout(60);
  ok("390: the tick box and its line fit", await p.$eval("#cbChgBar",e=>e.scrollWidth<=e.clientWidth+1));
  await p.screenshot({path:OUTDIR+"/combochange-390.png",fullPage:true});
  await p.$eval("#cbScale",e=>e.scrollIntoView()); await p.screenshot({path:OUTDIR+"/combochange-390-top.png"});
  await t.ctx.close();

  // ===== a company name setting, and hostile names kept as text =====
  const EVIL='<img src=x onerror="window.__pwn=7">Calloway & "Co"';
  t=await open({org:EVIL, base:{kind:"group", codes:["9001"], label:'<b onmouseover="window.__pwn=8">Calloway Group</b>'}}); p=t.p;
  ok("with a company name setting, the tiles say on that name", (await t.txt('#cbScale [data-k="dpw"] .cbtchg'))===`▲ +25.0% on ${EVIL}`, await t.txt('#cbScale [data-k="dpw"] .cbtchg'));
  ok("and the Change headers name it as text", (await p.$$eval("#cbTab_prem th.cbchgh .cbhn",e=>e.map(x=>x.textContent)))[0]===`on ${EVIL}` && (await p.$$eval("#cbTab_map thead th",e=>e.map(x=>x.textContent.trim()))).pop()===`Change on ${EVIL}`);
  ok("the line about Change names it as text", (await t.txt("#cbChgWhat")).startsWith(`Change is the pro forma against ${EVIL} standalone`));
  await t.hover("FL");
  ok("the hover panel names it as text", (await t.txt("#cbmTip")).includes(`Change on ${EVIL}▲ +75.0%`), await t.txt("#cbmTip"));
  d=await t.download(()=>p.click('#cbResults [data-act="export"][data-tbl="years"][data-fmt="csv"]'));
  ok("the export names it as text", d.text.includes('Change: (pro forma less <img src=x onerror=""window.__pwn=7"">Calloway & ""Co"") over'), d.text.slice(0,400));
  ok("nothing hostile ran or became markup", await p.evaluate(()=>window.__pwn===undefined) && !(await p.$("#view img")) && !(await p.$("#view b[onmouseover]")));
  await t.ctx.close();

  // ===== 390 wide from the start =====
  t=await open({}, {width:390}); p=t.p;
  ok("390 from the start: no sideways scroll, change shown", await t.noScroll() && (await t.chg("dpw",2025)).v==="▲ +25.0%");
  await t.toggle();
  ok("390, change off: still no sideways scroll", await t.noScroll());
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
