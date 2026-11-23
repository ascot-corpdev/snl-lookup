// The Combination view (Corp Dev only): the organisation's own statutory figures (a base company or group saved once as
// the setting "combination_base"), a target's, and a pro forma that adds the dollars and works the ratios out, in this
// browser. Covers: the base not set, set and changed; a company, a several-company and a group target; every sum and
// derived ratio against hand-worked numbers, with each refusal (one side missing, zero or negative denominator); ratios
// never combined; the mix by line and state with overlap, one-sided lines and "Other"; reinsurers both use; figures
// still arriving, not mapped and failed on one side; the export; an ordinary login (no tab, the deep link shows
// nothing); nothing about the pair saved or sent anywhere but the two statutory look-ups; hostile names kept as text;
// 1440 and 390 wide. Every company, code and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), F=FIX("combination_figures.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG=org=>`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"${org===undefined?"":",orgName:"+JSON.stringify(org)}};`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const NOT_RUN="Not run: the query ran out of time. Run it again, or ask for fewer fields.";
const M=1e6;
const PCT=new Set(["loss_ratio","loss_lae_ratio","expense_ratio","combined_ratio","rbc_ratio","roae","investment_yield","commission_ratio"]);
const STATUS_MAPPED={...copy(STAT.statusMapped), companies:{mapped:false, problem:null}};
const GROUP_BASE={kind:"group", codes:["9001"], label:"Calloway Group"};
const RESOLVE={
  tarrow:[{companyId:"4000107", companyName:"Tarrow Mutual Insurance Co", naicCompanyCode:"90107", institutionId:"5000107", naicGroupCode:"5521", naicGroupName:"Tarrow Group"},
          {companyId:"4000108", companyName:"Nonesuch Casualty Co", naicCompanyCode:"90108", institutionId:null, naicGroupCode:"5520", naicGroupName:"Nonesuch Group"}],
  calloway:[{companyId:"4000001", companyName:"Calloway Insurance Co", naicCompanyCode:"90001", institutionId:"5000001", naicGroupCode:"9001", naicGroupName:"Calloway Group"},
            {companyId:"4000002", companyName:"Calloway Home Co", naicCompanyCode:"90002", institutionId:null, naicGroupCode:"9001", naicGroupName:"Calloway Group"}],
  nonesuch:[{companyId:"4000108", companyName:"Nonesuch Casualty Co", naicCompanyCode:"90108", institutionId:null, naicGroupCode:"5520", naicGroupName:"Nonesuch Group"}],
  evil:[{companyId:"4000666", companyName:'<img src=x onerror="window.__pwn=1">Tarrow & "Co"', naicCompanyCode:"90107", institutionId:null, naicGroupCode:null, naicGroupName:'<b onmouseover="window.__pwn=2">bold</b>'}]
};

/* The statutory function's answer to one query, from the made-up figures: o.unmapped (field ids), o.errors
   ({code: {field: message}}), o.pending (the last n fields not run yet). */
function answer(body, o={}){
  const dim=id=>/_by_line$/.test(id)?"line":/_by_state$/.test(id)?"state":/_by_reinsurer$/.test(id)?"item":null;
  const fields=(body.fields||[]).map(id=>{
    const f={id, label:id, unit:PCT.has(id)?"pct":"usd", by:dim(id)?(dim(id)==="item"?"item":dim(id)):"year", mapped:!(o.unmapped||[]).includes(id), error:null, rows:[]};
    if(!f.mapped) return f;
    for(const code of body.codes){
      const err=o.errors&&o.errors[code]&&o.errors[code][id]; if(err){ f.error=err; f.rows=[]; break; }
      const d=(F.codes[code]||{})[id]; if(!d) continue;
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
  const mapped=fields.filter(f=>f.mapped), pending=Math.min(o.pending||0, mapped.length);
  for(const f of mapped.slice(mapped.length-pending)){ f.error=NOT_RUN; f.rows=[]; }
  return {kind:body.kind, codes:body.codes, fromYear:body.fromYear, toYear:body.toYear, entities:body.codes.map(c=>({code:c, name:F.names[c]||null})), fields,
    loaded:[{view:"STAT_FINANCIALS", at:"2026-10-28"}], truncated:false, source:"S&P Global Market Intelligence statutory data, through Snowflake", fetchedAt:"2026-11-13T11:59:00Z", fromStore:false, saved:pending===0, pending};
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], role:opts.role||"corpdev", delay:()=>0, stat:()=>copy(STATUS_MAPPED),
      query:body=>({status:200, body:answer(body, {unmapped:["pyd"], errors:{"9001":{unearned_premiums:"Snowflake couldn't find the column UNEARNED in STAT_FINANCIALS. Check the mapping."}}})}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:t.role, statutory:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-filings" && body.action==="resolve"){ const l=String(body.q).toLowerCase(); return J(200,{query:body.q, matches:copy(RESOLVE[Object.keys(RESOLVE).find(k=>l.startsWith(k))]||[]), note:null}); }
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2, resetsAt:"2026-11-14T00:00:00Z"});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(fn==="snl-statutory"){ if(body.action==="status") return J(200, t.stat());
          if(body.action==="query"){ const n=t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query"&&same(c.body.codes,body.codes)).length; const d=t.delay(body, n); if(d) await new Promise(res=>setTimeout(res,d)); const a=t.query(body, n); return J(a.status, a.body); } }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG(opts.org)});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; }, {role:t.role, seed:opts.base?[["snl_settings","combination_base",{doc:opts.base}]]:[]});
    await p.goto(BASE+(over.hash||"#filings")); await p.waitForTimeout(400);
    // every read of a table, so a test can see the page never read the base for a login that may not see the view
    await p.evaluate(()=>{ window.__reads=[]; const from=S.sb.from.bind(S.sb); S.sb.from=tb=>{ window.__reads.push(tb); const q=from(tb), eq=q.eq; q.eq=(c,v)=>{ window.__reads.push(tb+":"+v); return eq.call(q,c,v); }; return q; }; });
    if(over.go!==false){ await p.evaluate(()=>{ location.hash="#combination"; }); await p.waitForTimeout(350); }
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.queries=()=>t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="query").map(c=>c.body);
    // a cell of the by-year tables: its figure and, under it, why it is n/d
    t.cell=async (row, y, s)=>p.evaluate(([row,y,s])=>{ const td=document.querySelector(`#cbResults tr[data-row="${row}"] td[data-s="${s}"][data-y="${y}"]`); if(!td) return null;
      const why=td.querySelector(".cbwhy"); return {v:[...td.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join("").trim(), why:why?why.textContent.trim():""}; }, [row, String(y), s]);
    t.row=async (row, y)=>{ const out={}; for(const s of ["b","t","p"]){ const c=await t.cell(row,y,s); out[s]=c?(c.why?`${c.v} [${c.why}]`:c.v):null; } return out; };
    t.until=async (cond, ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await cond()) return true; await p.waitForTimeout(40); } return false; };
    t.find=async (w, q)=>{ await p.fill(`#cb_${w}_find`, q); await p.press(`#cb_${w}_find`, "Enter"); await p.waitForTimeout(150); };
    t.go=async ()=>{ await p.click("#cbGo"); await t.until(async()=>!(await p.$("#cbResults .banner[role=status] .pb")) && !!(await p.$("#cbScale"))); await p.waitForTimeout(100); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    return t;
  }

  // ===== the base not set: the tab says what to do; Corp Dev sets it by name, as a group =====
  let t=await open({}); let p=t.p;
  ok("Corp Dev sees the Combination tab, after Statutory", await p.isVisible('nav.tabs a[data-view="combination"]') && same(await p.$$eval("nav.tabs a:not([hidden])",as=>as.map(a=>a.dataset.view)),["filings","snapshot","compare","market","earnings","statutory","combination","profile"]));
  ok("the title is neutral without a company name setting", (await t.txt("#view .action-title"))==="Combination: Our company with a target, as a pro forma", await t.txt("#view .action-title"));
  ok("what it is, always above everything else", (await t.txt("#cbWhat")).startsWith("What this is: a simple sum of two sets of statutory figures, as each company filed them. It has no purchase accounting, no price, no synergies and no financing.") && (await t.txt("#cbWhat")).includes("Surplus in particular is not what a combined company would report."), await t.txt("#cbWhat"));
  ok("until the base is set, the tab says what to do and offers nothing else", (await t.txt("#cbBaseNone")).startsWith("Set the base company first. Choose your company's NAIC group code, or up to 8 NAIC company codes, and give it a name.") && !(await p.$("#cbForm")), await t.txt("#cbBaseNone"));
  ok("the base was read from the shared settings, once", (await p.evaluate(()=>window.__reads.filter(x=>x==="snl_settings:combination_base").length))===1);
  await p.click("#cbSet"); await p.waitForTimeout(100);
  ok("Set opens the base form with Find by name", await p.isVisible("#cbBaseEdit") && await p.isVisible("#cb_base_find"));
  await p.click('#cbBaseEdit [data-act="cb-kind"][data-k="group"]'); await p.waitForTimeout(80);
  await t.find("base","Calloway");
  ok("by group, the matches gather into their group", (await t.txt("#cb_base_matches")).startsWith("Calloway GroupNAIC group 9001 · 2 matching companies"), await t.txt("#cb_base_matches"));
  await p.click('#cb_base_matches [data-act="cb-add"]'); await p.waitForTimeout(80);
  ok("choosing the group fills in its code and its name", (await p.inputValue("#cb_base_codes"))==="9001" && (await p.inputValue("#cb_base_label"))==="Calloway Group");
  await p.fill("#cb_base_label",""); await p.click("#cbSave"); await p.waitForTimeout(100);
  ok("a base needs a name", (await t.txt("#cbSaveErr"))==="Give the base a name, as it should show on this page.");
  await p.fill("#cb_base_label","Calloway Group"); await p.fill("#cb_base_codes","9001, 9002"); await p.click("#cbSave"); await p.waitForTimeout(100);
  ok("a group look-up takes one group code", (await t.txt("#cbSaveErr"))==="A group look-up takes one NAIC group code.");
  await p.fill("#cb_base_codes","9001"); await p.click("#cbSave"); await p.waitForTimeout(200);
  let row=await p.evaluate(()=>window.__mock.row("snl_settings","combination_base"));
  ok("Save keeps exactly the base: kind, codes and name, and nothing else", row && same(row.doc, GROUP_BASE), row);
  ok("the only thing written is that one setting", same((await p.evaluate(()=>window.__mock.log)).filter(l=>l.op==="upsert"), [{op:"upsert", table:"snl_settings", id:"combination_base"}]));
  ok("the saved base shows, with Change", (await t.txt("#cbBase")).startsWith("Our company, the baseCalloway GroupNAIC group 9001. Saved for the team.") && await p.isVisible("#cbChange") && (await t.txt("#cbMsg"))==="Saved. The base is now Calloway Group. Choose a target to see the pro forma.", await t.txt("#cbBase"));
  ok("and the target form now shows, with what it costs", await p.isVisible("#cbForm") && (await t.txt("#cbCost"))==="Cost: two statutory look-ups, one for each side, each saved for that company or group as on the Statutory view, so looking again reads the saved figures. No S&P filing requests and no Claude. The two are added up in this browser: nothing that pairs them is saved or sent anywhere.", await t.txt("#cbCost"));
  ok("nothing was fetched yet", t.queries().length===0);
  await t.ctx.close();

  // ===== a company target, found by name: every sum and ratio against hand-worked numbers =====
  t=await open({base:GROUP_BASE}); p=t.p;
  ok("a saved base opens straight to the target form", (await t.txt("#cbBaseLabel"))==="Calloway Group" && await p.isVisible("#cbForm"));
  await t.find("target","Tarrow");
  ok("Find by name lists companies with their codes", (await t.txt("#cb_target_matches")).startsWith("Tarrow Mutual Insurance CoNAIC 90107 · group Tarrow GroupAdd"), await t.txt("#cb_target_matches"));
  await p.click('#cb_target_matches [data-act="cb-add"] >> nth=0'); await p.waitForTimeout(80);
  ok("Add puts the code in and names it", (await p.inputValue("#cb_target_codes"))==="90107" && (await t.txt("#cb_target_named")).startsWith("Tarrow Mutual Insurance Co NAIC 90107"));
  await t.go();
  const Q=t.queries();
  ok("two statutory look-ups, one a side, never one for both", Q.length===2 && same(Q.map(q=>[q.kind, q.codes]).sort(), [["company",["90107"]],["group",["9001"]]].sort()), Q.map(q=>[q.kind,q.codes]));
  ok("each asks for the five latest years and one before, up to last year", Q.every(q=>q.fromYear===2020 && q.toYear===2025 && q.action==="query" && !("refresh" in q)), Q);
  ok("the group side asks for no by-reinsurer figures; the company side does", !Q.find(q=>q.kind==="group").fields.includes("ceded_by_reinsurer") && Q.find(q=>q.kind==="company").fields.includes("ceded_by_reinsurer") && Q.find(q=>q.kind==="company").fields.includes("recoverable_by_reinsurer"));
  ok("the dollar figures, premiums by line and state and the ratios are asked for", ["surplus","npe","gpw","net_reserves","total_liabilities","net_income","uw_gain","net_inv_income","cash_invested","unearned_premiums","pyd","dpw_by_line","npw_by_line","dpw_by_state","loss_ratio","loss_lae_ratio","expense_ratio","combined_ratio","rbc_ratio","roae","investment_yield","commission_ratio"].every(f=>Q[0].fields.includes(f)));
  ok("who is on each side", (await t.txt("#cbWho"))==="Our company: Calloway Group (NAIC group 9001). Target: Tarrow Mutual Insurance Co (NAIC 90107).", await t.txt("#cbWho"));
  ok("five years, latest first, three columns each", same(await p.$$eval("#cbTab_prem thead tr:first-child th.cbyr",e=>e.map(x=>x.textContent)),["2025","2024","2023","2022","2021"]) && same(await p.$$eval("#cbTab_prem thead tr:nth-child(2) th",e=>e.slice(0,3).map(x=>x.textContent)),["Our company","Target","Pro forma"]));
  // dollars added
  ok("direct premiums: by-line totals added (1,000 + 250)", same(await t.row("dpw",2025),{b:"$1,000M", t:"$250M", p:"$1,250M"}), await t.row("dpw",2025));
  ok("net premiums written added (820 + 180)", same(await t.row("npw",2025),{b:"$820M", t:"$180M", p:"$1,000M"}), await t.row("npw",2025));
  ok("net premiums earned added", same(await t.row("npe",2025),{b:"$800M", t:"$200M", p:"$1,000M"}));
  ok("a group's rows for one year are added up (600 + 400), then the target's", same(await t.row("surplus",2025),{b:"$1,000M", t:"$300M", p:"$1,300M"}), await t.row("surplus",2025));
  ok("liabilities and reserves added", same(await t.row("total_liabilities",2025),{b:"$1,500M", t:"$400M", p:"$1,900M"}) && same(await t.row("net_reserves",2025),{b:"$600M", t:"$150M", p:"$750M"}));
  ok("a negative side is added as it is, shown in brackets", same(await t.row("surplus",2023),{b:"$300M", t:"($400M)", p:"($100M)"}), await t.row("surplus",2023));
  // refusals: one side missing, never zero
  ok("one side missing a year: the pro forma is n/d and says which side", same(await t.row("surplus",2021),{b:"$700M", t:"n/d [none returned]", p:"n/d [target: none returned]"}), await t.row("surplus",2021));
  ok("one side missing a figure: never counted as zero", same(await t.row("net_income",2025),{b:"$90M", t:"n/d [none returned]", p:"n/d [target: none returned]"}), await t.row("net_income",2025));
  ok("a figure not mapped: n/d on every side, with the reason", !(await t.cell("pyd",2025,"b")) && (await t.txt("#cb_none_res")).includes("One-year development (positive is adverse) (not mapped)"), await t.txt("#cb_none_res"));
  ok("a figure neither side has in any year is listed under its table with why, not left out", (await t.txt("#cb_none_bal")).startsWith("n/d on both sides in every year shown: Total assets (none returned), Cash and invested assets (none returned)"), await t.txt("#cb_none_bal"));
  ok("a figure that failed on one side only: that side says so", same(await t.row("unearned_premiums",2025),{b:"n/d [couldn't be read]", t:"$70M", p:"n/d [base: couldn't be read]"}), await t.row("unearned_premiums",2025));
  // ratios worked out
  ok("loss ratio weighted by net premiums earned: (60 x 800 + 70 x 200) / 1,000 = 62.0", same(await t.row("loss_ratio",2025),{b:"60.0%", t:"70.0%", p:"62.0%"}), await t.row("loss_ratio",2025));
  ok("loss and LAE ratio weighted the same way: 72.0", same(await t.row("loss_lae_ratio",2025),{b:"70.0%", t:"80.0%", p:"72.0%"}));
  ok("expense ratio weighted by net premiums written: (25 x 820 + 30 x 180) / 1,000 = 25.9", same(await t.row("expense_ratio",2025),{b:"25.0%", t:"30.0%", p:"25.9%"}), await t.row("expense_ratio",2025));
  ok("combined ratio: weighted loss and LAE plus weighted expense, 72.0 + 25.9 = 97.9; each side as reported", same(await t.row("combined_ratio",2025),{b:"95.0%", t:"110.0%", p:"97.9%"}), await t.row("combined_ratio",2025));
  ok("net premiums written to surplus from the added dollars: 1,000 / 1,300 (each side its own)", same(await t.row("npw_to_surplus",2025),{b:"0.8x", t:"0.6x", p:"0.8x"}), await t.row("npw_to_surplus",2025));
  ok("reserves to surplus: 750 / 1,300", same(await t.row("reserves_to_surplus",2025),{b:"0.6x", t:"0.5x", p:"0.6x"}), await t.row("reserves_to_surplus",2025));
  ok("liabilities to surplus: 1,900 / 1,300", same(await t.row("liabilities_to_surplus",2025),{b:"1.5x", t:"1.3x", p:"1.5x"}), await t.row("liabilities_to_surplus",2025));
  ok("cession share, gross less net over gross: (1,360 - 1,000) / 1,360 = 26.5%", same(await t.row("cession_pct",2025),{b:"25.5%", t:"30.8%", p:"26.5%"}), await t.row("cession_pct",2025));
  ok("a zero weight refuses the weighted ratio", same(await t.row("loss_ratio",2024),{b:"61.0%", t:"72.0%", p:"n/d [target net premiums earned zero or negative]"}), await t.row("loss_ratio",2024));
  ok("and the combined ratio with it", (await t.cell("combined_ratio",2024,"p")).why==="target net premiums earned zero or negative" && (await t.cell("expense_ratio",2024,"p")).v==="26.9%", [await t.cell("combined_ratio",2024,"p"), await t.cell("expense_ratio",2024,"p")]);
  ok("a negative denominator refuses a ratio to surplus, on the side and in the pro forma", same(await t.row("npw_to_surplus",2023),{b:"2.4x", t:"n/d [surplus zero or negative]", p:"n/d [surplus zero or negative]"}), await t.row("npw_to_surplus",2023));
  ok("a missing denominator refuses it too, saying which side", same(await t.row("liabilities_to_surplus",2021),{b:"2.0x", t:"n/d [surplus: none returned]", p:"n/d [surplus: target: none returned]"}), await t.row("liabilities_to_surplus",2021));
  ok("every worked-out ratio is marked derived", (await p.$$eval("#cbTab_ratio tbody tr td:first-child",e=>e.map(x=>x.textContent))).every(s=>s.includes("(derived)")) && (await p.$$("#cbTab_ratio tbody tr")).length===8);
  ok("the formulas are written out under the ratios", (await t.txt("#cbFormulas")).includes("Loss ratio and loss and LAE ratio: each side's ratio weighted by its net premiums earned.") && (await t.txt("#cbFormulas")).includes("Combined ratio: the weighted loss and LAE ratio plus the weighted expense ratio.") && (await t.txt("#cbFormulas")).includes("Cession share: gross less net premiums written, over gross premiums written"));
  // never combined
  for(const [id, b, tg] of [["rbc_ratio","450.0%","300.0%"],["roae","9.5%","4.0%"],["investment_yield","3.1%","2.5%"],["commission_ratio","12.0%","15.0%"]])
    ok(`${id}: each side's own figure, never a pro forma`, same(await t.row(id,2025),{b, t:tg, p:"Not combined"}), await t.row(id,2025));
  ok("each says why it can't be added up", (await t.txt('#cbTab_never tr[data-row="rbc_ratio"] td:first-child')).includes("can't be added up") && (await p.$$eval("#cbTab_never tbody tr td:first-child .cbwhy",e=>e.length))===4);
  // scale
  ok("scale at the top: pro forma premiums and surplus, and the target's share", same(await p.$$eval("#cbScale .sntile b",e=>e.map(x=>x.textContent)),["$1,250M","$1,000M","$1,300M","20.0%","23.1%"]), await p.$$eval("#cbScale .sntile b",e=>e.map(x=>x.textContent)));
  // mix by line: overlap and one-sided lines
  ok("lines: added by name, largest pro forma first, each side's share", same(await p.$$eval("#cbTab_lines tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent))),[
    ["Homeowners","Both","$600M","60.0%","$150M","60.0%","$750M","60.0%"],["Commercial auto","Our company only","$250M","25.0%","None","","$250M","20.0%"],
    ["Inland marine","Our company only","$150M","15.0%","None","","$150M","12.0%"],["Farmowners","Target only","None","","$100M","40.0%","$100M","8.0%"]]), await p.$$eval("#cbTab_lines tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent))));
  ok("lines: largest, top five, one-sided and overlap, before and after", same(await p.$$eval("#cb_lines_facts li",e=>e.map(x=>x.textContent)),[
    "Largest line: before, Homeowners at 60.0% of Our company; after, Homeowners at 60.0% of the pro forma.",
    "Top five lines: 100.0% of Our company before, 100.0% of the pro forma after.",
    "Only the target writes 1 line: $100M, 8.0% of the pro forma (Farmowners).",
    "Only Our company writes 2 lines: $400M, 32.0% of the pro forma (Commercial auto, Inland marine).",
    "Overlap, the lines both write: 1 line, $750M of pro forma premium, 60.0%."]), await p.$$eval("#cb_lines_facts li",e=>e.map(x=>x.textContent)));
  // mix by state: more than eight, so "Other"
  ok("states: top seven then Other", same(await p.$$eval("#cbTab_states tbody tr",rs=>rs.map(r=>[r.children[0].textContent, r.children[1].textContent, r.children[6].textContent, r.children[7].textContent])),[
    ["TX","Our company only","$400M","32.0%"],["FL","Both","$350M","28.0%"],["GA","Target only","$100M","8.0%"],["LA","Our company only","$100M","8.0%"],["OK","Our company only","$80M","6.4%"],["AR","Our company only","$70M","5.6%"],["MS","Our company only","$60M","4.8%"],["Other","2 more","$90M","7.2%"]]),
    await p.$$eval("#cbTab_states tbody tr",rs=>rs.map(r=>[r.children[0].textContent, r.children[1].textContent, r.children[6].textContent, r.children[7].textContent])));
  ok("states: largest and top five before and after, overlap", same(await p.$$eval("#cb_states_facts li",e=>e.map(x=>x.textContent)),[
    "Largest state: before, TX at 40.0% of Our company; after, TX at 32.0% of the pro forma.",
    "Top five states: 85.0% of Our company before, 82.4% of the pro forma after.",
    "Only the target writes 1 state: $100M, 8.0% of the pro forma (GA).",
    "Only Our company writes 7 states: $800M, 64.0% of the pro forma (TX, LA, OK, AR, MS, AL and more).",
    "Overlap, the states both write: 1 state, $350M of pro forma premium, 28.0%."]), await p.$$eval("#cb_states_facts li",e=>e.map(x=>x.textContent)));
  ok("reinsurers: a group side gets the plain reason", (await t.txt("#cb_reins_none"))==="The reinsurer panel is shown for company look-ups only: figures by reinsurer are looked up for companies, not groups. Look up both sides by NAIC company code to see it.");
  ok("the source line says it was added up here", (await t.txt("#cbSource")).endsWith("Source: S&P Global Market Intelligence statutory data, as filed. US dollars are shown in $M. Added up in this browser."));
  // export
  let d=await t.download(()=>p.click('#cbResults [data-act="export"][data-tbl="years"][data-fmt="csv"]'));
  ok("export by year: named for the view and the day, not the companies", d.name==="snl-combination-years-2026-11-13.csv", d.name);
  const lines=d.text.replace(/^﻿/,"").split("\r\n");
  ok("export by year: three columns a year, latest first", lines[0]==='"Figure","How","Unit","2025 Our company","2025 target","2025 pro forma","2024 Our company","2024 target","2024 pro forma","2023 Our company","2023 target","2023 pro forma","2022 Our company","2022 target","2022 pro forma","2021 Our company","2021 target","2021 pro forma"', lines[0]);
  ok("export by year: dollars as numbers, refusals with the reason", lines.includes('"Policyholder surplus","Added","US dollars","1000000000","300000000","1300000000","900000000","280000000","1180000000","300000000","-400000000","-100000000","760000000","260000000","1020000000","700000000","n/d (none returned)","n/d (target: none returned)"'), lines.find(l=>l.startsWith('"Policyholder surplus"')));
  ok("export by year: ratios say how they were worked out", lines.some(l=>l.startsWith('"Loss ratio","Derived: weighted by net premiums earned","%","60","70","62"')) && lines.some(l=>l.startsWith('"Risk-based capital ratio","Not combined: A combined company')), lines.find(l=>l.startsWith('"Loss ratio"')));
  ok("export by year: what it is, and who is on each side", d.text.includes('"Note","What this is: a simple sum of two sets of statutory figures') && d.text.includes('"Target","Tarrow Mutual Insurance Co (NAIC 90107)"'));
  d=await t.download(()=>p.click('#cb_lines [data-act="export"][data-fmt="csv"]'));
  ok("export by line: each side and the pro forma with shares", d.name==="snl-combination-lines-2026-11-13.csv" && d.text.includes('"Farmowners","Target only","","","100000000","40","100000000","8"') && d.text.includes('"Note","What this is'), d.text.slice(0,400));
  // nothing about the pair is saved or sent
  const sent=t.calls.map(c=>({fn:c.fn, body:JSON.stringify(c.body)}));
  ok("the only calls that carry a code are the two statutory look-ups and the name look-up", sent.filter(c=>/9001|90107/.test(c.body)).every(c=>c.fn==="snl-statutory" && /"action":"query"/.test(c.body)), sent.filter(c=>/9001|90107/.test(c.body)));
  ok("no call carries both sides", !sent.some(c=>/"9001"/.test(c.body) && /"90107"/.test(c.body)));
  ok("the name look-up sends only what was typed", same(t.calls.filter(c=>c.body.action==="resolve").map(c=>c.body),[{action:"resolve", q:"Tarrow"}]));
  ok("nothing is written to the database", (await p.evaluate(()=>window.__mock.log)).filter(l=>l.op==="upsert").length===0 && same(Object.keys(await p.evaluate(()=>window.__mock.store.snl_settings)),["combination_base"]) && same((await p.evaluate(()=>window.__mock.row("snl_settings","combination_base"))).doc, GROUP_BASE));
  ok("nothing about the pair is kept in browser storage", await p.evaluate(()=>!/9001|90107|Tarrow/.test(JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))));
  ok("Claude is told nothing about this view", await p.evaluate(()=>askScreen()===null));
  await p.click("#askFab"); await p.waitForTimeout(150); await p.fill("#ask_input","What is a combined ratio?"); await p.click('[data-act="ask-send"]'); await p.waitForTimeout(300);
  const asked=t.calls.filter(c=>c.fn==="snl-chat" && c.body.action==="ask");
  ok("a question asked from this view carries no screen and neither side", asked.length===1 && !("screen" in asked[0].body) && !/9001|90107|Calloway|Tarrow/.test(JSON.stringify(asked[0].body)), asked.map(a=>a.body));
  await p.click("#askClose").catch(()=>{}); await p.waitForTimeout(100);
  ok("no sideways scroll at 1440", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/combination-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("no sideways scroll at 390: the wide tables scroll in their own box", await t.noScroll() && await p.$eval("#cbWrap_prem",e=>e.scrollWidth>e.clientWidth));
  await p.screenshot({path:OUTDIR+"/combination-390.png",fullPage:true});
  await p.screenshot({path:OUTDIR+"/combination-390-top.png"});
  await t.ctx.close();

  // ===== several companies as the target, added up; with a company name setting =====
  t=await open({base:GROUP_BASE, org:"Calloway"}); p=t.p;
  ok("with a company name setting, the view uses it", (await t.txt("#view .action-title"))==="Combination: Calloway with a target, as a pro forma" && (await t.txt("#cbBase")).startsWith("Calloway, the baseCalloway Group"));
  await t.find("target","Tarrow");
  await p.click('#cb_target_matches [data-act="cb-add"] >> nth=0'); await p.click('#cb_target_matches [data-act="cb-add"] >> nth=0'); await p.waitForTimeout(80);
  ok("two companies chosen", (await p.inputValue("#cb_target_codes"))==="90107, 90108");
  await t.go();
  ok("one look-up for the target's two companies together", same(t.queries().filter(q=>q.kind==="company").map(q=>q.codes),[["90107","90108"]]));
  ok("headers use the name", same(await p.$$eval("#cbTab_prem thead tr:nth-child(2) th",e=>e.slice(0,3).map(x=>x.textContent)),["Calloway","Target","Pro forma"]));
  ok("the target's companies' dollars are added up (250 + 60)", same(await t.row("dpw",2025),{b:"$1,000M", t:"$310M", p:"$1,310M"}), await t.row("dpw",2025));
  ok("the target's loss ratio is worked out across its companies: (70 x 200 + 90 x 50) / 250 = 74.0", same(await t.row("loss_ratio",2025),{b:"60.0%", t:"74.0%", p:"63.3%"}), await t.row("loss_ratio",2025));
  ok("its expense ratio by net premiums written: (30 x 180 + 35 x 40) / 220 = 30.9", (await t.cell("expense_ratio",2025,"t")).v==="30.9%");
  ok("one company without a figure: the target's total is n/d, naming it", same(await t.row("surplus",2025),{b:"$1,000M", t:"n/d [none for NAIC 90108]", p:"n/d [target: none for NAIC 90108]"}), await t.row("surplus",2025));
  ok("a ratio never combined isn't added across the target's companies either", same(await t.row("rbc_ratio",2025),{b:"450.0%", t:"n/d [several companies: can't be added up]", p:"Not combined"}));
  ok("the note says how a side of several companies is treated", (await t.txt("#cbResults")).includes("A side of several companies has its dollars added up, and its loss, expense and combined ratios worked out across them as the pro forma's are."));
  await t.ctx.close();

  // ===== a group target; the same group as the base is refused =====
  t=await open({base:GROUP_BASE}); p=t.p;
  await p.click('#cbForm [data-act="cb-kind"][data-k="group"]'); await p.waitForTimeout(60);
  await p.fill("#cb_target_codes","9001"); await p.click("#cbGo"); await p.waitForTimeout(100);
  ok("the base itself as the target is refused: it would count twice", (await t.txt("#cbErr"))==="NAIC 9001 is part of the base already, so adding it would count it twice. Choose a different target." && t.queries().length===0, await t.txt("#cbErr"));
  await t.find("target","Nonesuch");
  await p.click('#cb_target_matches [data-act="cb-add"]'); await p.waitForTimeout(60);
  ok("by name, a group replaces the code (one group)", (await p.inputValue("#cb_target_codes"))==="5520");
  await t.go();
  ok("a group target is a group look-up", same(t.queries().map(q=>[q.kind,q.codes]).sort(),[["group",["5520"]],["group",["9001"]]]));
  ok("its figures go in", same(await t.row("npe",2025),{b:"$800M", t:"$100M", p:"$900M"}) && (await t.txt("#cbWho")).endsWith("Target: Nonesuch Group (NAIC group 5520)."), await t.txt("#cbWho"));
  ok("mix: one side without states says so, never that none exist", (await t.txt("#cb_states_none"))==="The state mix can't be added up: target: none returned. That doesn't mean there are none.", await t.txt("#cb_states_none"));
  await t.ctx.close();

  // ===== the base changed to two companies; reinsurers both use =====
  t=await open({base:GROUP_BASE}); p=t.p;
  await p.fill("#cb_target_codes","90107"); await t.go();
  ok("a pro forma is on screen", !!(await p.$("#cbScale")));
  await p.click("#cbChange"); await p.waitForTimeout(80);
  ok("Change opens the form with the saved base in it", (await p.inputValue("#cb_base_codes"))==="9001" && (await p.inputValue("#cb_base_label"))==="Calloway Group" && await p.getAttribute('#cbBaseEdit [data-act="cb-kind"][data-k="group"]',"aria-pressed")==="true");
  await p.click('#cbBaseEdit [data-act="cb-kind"][data-k="company"]'); await p.waitForTimeout(60);
  await p.fill("#cb_base_codes","90001, 90002"); await p.fill("#cb_base_label","Calloway Insurance Co and Calloway Home Co"); await p.click("#cbSave"); await p.waitForTimeout(200);
  row=await p.evaluate(()=>window.__mock.row("snl_settings","combination_base"));
  ok("the saved base is replaced, still holding the base alone", same(row.doc,{kind:"company", codes:["90001","90002"], label:"Calloway Insurance Co and Calloway Home Co"}), row.doc);
  ok("the old pro forma goes with the old base", !(await p.$("#cbScale")) && (await t.txt("#cbBaseLabel"))==="Calloway Insurance Co and Calloway Home Co");
  await t.go();
  ok("the base's companies are looked up together, the target alone", same(t.queries().slice(-2).map(q=>q.codes).sort(),[["90001","90002"],["90107"]]));
  ok("reinsurers both use: ceded premiums and recoverables added (70 + 40, 125 + 60)", same(await p.$$eval("#cbTab_reins tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent))),[["Nonesuch Re","$70M","$40M","$110M","$125M","$60M","$185M"]]), await p.$$eval("#cbTab_reins tbody tr",rs=>rs.map(r=>[...r.children].map(c=>c.textContent))));
  ok("and the reinsurers only one side uses are counted", (await t.txt("#cb_reins_note")).startsWith("1 reinsurer both use; 1 reinsurer only Our company uses and 1 reinsurer only the target uses, in 2025."), await t.txt("#cb_reins_note"));
  await t.ctx.close();

  // ===== figures still arriving on one side, then all there =====
  t=await open({base:GROUP_BASE}, {delay:(body,n)=>body.kind==="company"?300:0, query:(body,n)=>({status:200, body:answer(body, {pending:body.kind==="company"&&n===1?30:0})})}); p=t.p;
  await p.fill("#cb_target_codes","90107"); await p.click("#cbGo");
  ok("while the target is fetched, the base's figures are already in", await t.until(async()=>(await t.cell("npe",2025,"b"))?.v==="$800M" && !!(await p.$("#cbTargetBusy"))), await t.txt("#cbResults"));
  ok("the target's cells say still to come; the pro forma waits", same(await t.row("npe",2025),{b:"$800M", t:"n/d [still to come]", p:"n/d [target: still to come]"}), await t.row("npe",2025));
  ok("its banner says the figures are on their way, with Stop", (await t.txt("#cbTargetBusy")).startsWith("Fetching the target's figures (NAIC 90107)… This can take a minute.") && await p.isVisible('#cbTargetBusy [data-act="cb-stop"]'));
  ok("then the first part arrives and the rest is asked for at once", await t.until(async()=>!!(await p.$("#cbTargetCarry"))) && /^Getting the rest of the target's figures… \d+ of \d+ figures so far\./.test(await t.txt("#cbTargetCarry")), await t.txt("#cbTargetCarry"));
  ok("and it finishes on its own; the pro forma fills in", await t.until(async()=>!(await p.$("#cbTargetCarry")) && (await t.cell("npe",2025,"p"))?.v==="$1,000M"), await t.row("npe",2025));
  ok("the carry-on asked the same question again", same(t.queries().filter(q=>q.kind==="company").map(q=>q.codes),[["90107"],["90107"]]));
  await t.ctx.close();

  // ===== failed on one side =====
  t=await open({base:GROUP_BASE}, {query:(body,n)=>body.kind==="company"&&n===1 ? {status:502, body:{error:"snowflake_failed", message:"Snowflake didn't answer. Try again in a minute."}} : {status:200, body:answer(body)}}); p=t.p;
  await p.fill("#cb_target_codes","90107"); await p.click("#cbGo"); await p.waitForTimeout(500);
  ok("a side that failed says so, with Try again", (await t.txt("#cbTargetErr")).startsWith("Couldn't fetch the target's figures (NAIC 90107). They show as n/d below. Snowflake didn't answer. Try again in a minute.") && await p.isVisible('#cbTargetErr [data-act="cb-retry-target"]'), await t.txt("#cbTargetErr"));
  ok("the other side's figures still show; the pro forma is n/d and says why", same(await t.row("surplus",2025),{b:"$1,000M", t:"n/d [couldn't be fetched]", p:"n/d [target: couldn't be fetched]"}), await t.row("surplus",2025));
  await p.click('#cbTargetErr [data-act="cb-retry-target"]'); await p.waitForTimeout(400);
  ok("Try again fetches that side alone, and the pro forma fills in", !(await p.$("#cbTargetErr")) && (await t.cell("surplus",2025,"p")).v==="$1,300M" && t.queries().filter(q=>q.kind==="group").length===1);
  await t.ctx.close();

  // ===== the last year can be changed =====
  t=await open({base:GROUP_BASE}); p=t.p;
  await p.fill("#cb_target_codes","90107"); await p.fill("#cb_to","2024"); await t.go();
  ok("a different last year: the years asked for and shown follow it", t.queries().every(q=>q.fromYear===2019 && q.toYear===2024) && same(await p.$$eval("#cbTab_prem thead tr:first-child th.cbyr",e=>e.map(x=>x.textContent)),["2024","2023","2022","2021"]));
  await p.fill("#cb_to","2027"); await p.click("#cbGo"); await p.waitForTimeout(100);
  ok("a year in the future is refused", (await t.txt("#cbErr"))==="Choose a last year between 1996 and 2026.");
  await t.ctx.close();

  // ===== hostile names kept as text =====
  t=await open({base:{kind:"company", codes:["90001"], label:'<img src=x onerror="window.__pwn=3">Calloway'}}); p=t.p;
  await t.find("target","evil");
  await p.click('#cb_target_matches [data-act="cb-add"]'); await p.waitForTimeout(80);
  await t.go();
  ok("a hostile company name is shown as text everywhere", (await t.txt("#cbWho")).includes('Target: <img src=x onerror="window.__pwn=1">Tarrow & "Co" (NAIC 90107)') && (await t.txt("#cbBaseLabel"))==='<img src=x onerror="window.__pwn=3">Calloway' && !(await p.$("#view img")) && !(await p.$("#view b[onmouseover]")), await t.txt("#cbWho"));
  ok("and nothing in it ran", await p.evaluate(()=>window.__pwn===undefined));
  await t.ctx.close();

  // ===== statutory data not set up =====
  t=await open({base:GROUP_BASE}, {stat:()=>copy(STAT.statusOff)}); p=t.p;
  ok("before statutory data is set up, the view says so and asks for nothing", (await t.txt("#cbOff")).startsWith("Statutory data isn't set up yet, so there is nothing to add up.") && !(await p.$("#cbForm")) && t.queries().length===0);
  await t.ctx.close();

  // ===== an ordinary login: no tab, and the deep link shows nothing it shouldn't =====
  t=await open({base:GROUP_BASE, role:"reader"}, {role:"reader"}); p=t.p;
  ok("a reader has no Combination tab", !(await p.isVisible('nav.tabs a[data-view="combination"]')) && await p.isVisible('nav.tabs a[data-view="statutory"]'));
  ok("the deep link #combination says it is for Corp Dev, and nothing else", (await t.txt("#view"))==="This view is for Corp Dev logins." && !(await p.$("#cbWhat")) && !(await p.$("#cbBase")), await t.txt("#view"));
  ok("and the page didn't read the base or ask for any figures", (await p.evaluate(()=>window.__reads.filter(x=>/^snl_settings/.test(x)).length))===0 && t.calls.filter(c=>c.fn==="snl-statutory").length===0, {reads:await p.evaluate(()=>window.__reads), calls:t.calls.map(c=>c.fn+":"+c.body.action)});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("reader at 390: no sideways scroll", await t.noScroll());
  await t.ctx.close();

  // ===== 390 wide from the start: the base form and the target form =====
  t=await open({}, {width:390}); p=t.p;
  await p.click("#cbSet"); await p.waitForTimeout(80);
  ok("390: the base form fits", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/combination-base-390.png",fullPage:true});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
