// The Profile view with the detailed profile: thirteen slides listed, each one the reader can take out (remembered in
// this browser, and left out of the built deck); the figures section by section as tables and small charts, folded
// away until opened, with "(derived)" on worked-out figures; the same sections filling in while figures are still
// coming in, with the "Some figures didn't arrive" banner as before; figures saved before this change, and none of the
// new figures mapped; hostile names kept as text; and the 1440px and 390px layouts with no sideways scroll.
// The real profile-slides.js plans and lays out the slides; the zip library and deck.js are small stand-ins that record
// what they were given. Every company, reinsurer and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SAMPLE=FIX("profile_sample_answer.json"), OLD=FIX("profilepage_answer.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const FAKE_JSZIP='window.JSZip=function(){}; window.JSZip.version="3.10.1";';
const FAKE_DECK=`window.__deck={build:[]};
window.SNLDeck={ inspect:async b=>({ok:true, slides:3, widthIn:13.333, heightIn:7.5}),
  build:async (b,spec)=>{ window.__deck.build.push({file:spec.fileName, ids:spec.slides.map(s=>s.id||s.kind)}); return new TextEncoder().encode("PPTX for "+spec.fileName); } };`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x===undefined?"":x).slice(0,600)); } };
const X='<img src=x onerror="window.__xss=1">';

/** The made-up sample as a real company's figures. */
const REAL=()=>{ const a=copy(SAMPLE); a.facts.sample=false; return a; };
/** Only some sections' figures in: what a first call of a long first load gives. */
function partial(){
  const a=REAL(), F=a.facts;
  for(const k of Object.keys(F.series)) if(!["dpw","npw","gpw","npe","surplus","combined_ratio","loss_ratio","expense_ratio"].includes(k)) delete F.series[k];
  F.derived={cession_pct:F.derived.cession_pct}; F.detail={derived:{}}; delete F.reinsurers;
  return {...a, pending:17, figures:{done:32, of:49}};
}
/** The sample with none of the new figures mapped. */
function noneNew(){
  const a=REAL(), F=a.facts;
  for(const k of ["assumed_pw","ceded_pw","losses_incurred","uw_gain","net_inv_income","realized_gains","dividends_paid","capital_contributed","surplus_notes","unassigned_funds","cash_from_ops","cash_invested","bonds","stocks","cash_short_term","premiums_receivable","total_liabilities","unearned_premiums","rbc_acl","rbc_tac","pyd_two_year","commission_ratio","investment_yield","roae"]) delete F.series[k];
  for(const k of ["gross_pw","pyd_to_npe","rbc_ratio_calc","rbc_acl_implied","invested_to_liabilities","liabilities_to_surplus","receivable_to_dpw","bonds_share","stocks_share","cash_share","net_capital_flow","dpw_yoy","npw_yoy","surplus_yoy"]) delete F.derived[k];
  F.detail={derived:{}};
  F.missing=[["uw_gain","Net underwriting gain"],["net_inv_income","Net investment income earned"],["realized_gains","Net realized capital gains"],["cash_from_ops","Net cash from operations"],["investment_yield","Net yield on invested assets"],["cash_invested","Cash and invested assets"],["premiums_receivable","Premiums receivable"],["total_liabilities","Total liabilities"],["npe_by_line","Net premiums earned by line"],["loss_lae_ratio_by_line","Loss and LAE ratio by line"],["dpe_by_state","Direct premiums earned by state"],["loss_ratio_by_state","Direct loss ratio by state"],["ay_loss_ratio","Net loss and LAE ratio by accident year"]].map(([field,label])=>({field,label,reason:"not mapped"}));
  return a;
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-14T12:00:00Z"));
    const t={p, ctx, calls:[], n:0, facts:()=>({status:200, body:REAL()}), delay:()=>0, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-profile"){
          if(body.action==="status") return J(200,{statutory:{configured:true, mapped:true, fields:[]}, claude:{configured:false}, filings:{configured:true}});
          if(body.action==="facts"){ const n=++t.n; const d=t.delay(n); if(d) await new Promise(res=>setTimeout(res,d)); const a=t.facts(body,n); return J(a.status,a.body); }
          return J(400,{error:"bad",message:"Unknown action."}); }
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:false, askedToday:0, dailyLimit:20, costToday:0, resetsAt:"2026-11-15T00:00:00Z"});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===JSZIP_URL) return r.fulfill({contentType:"application/javascript",body:FAKE_JSZIP});
      if(u===BASE+"deck.js") return r.fulfill({contentType:"application/javascript",body:FAKE_DECK});
      if(u===BASE+"profile-slides.js") return r.fulfill({contentType:"application/javascript",body:fs.readFileSync(WEB+"/profile-slides.js","utf8")});
      if(u===BASE+"template-builtin.pptx") return r.fulfill({contentType:"application/vnd.openxmlformats-officedocument.presentationml.presentation",body:fs.readFileSync(WEB+"/template-builtin.pptx")});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.goto(BASE+"#profile"); await p.waitForTimeout(500);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.figures=async code=>{ await p.fill("#pf_code",code); await p.click("#pf_get"); await p.waitForTimeout(600); };
    t.until=async(fn,ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await fn()) return true; await p.waitForTimeout(60); } return false; };
    t.cells=async sel=>p.$$eval(sel+" tr",rows=>rows.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    return t;
  }

  // ----- every figure in: thirteen slides, each with a tick box, and the figures section by section -----
  let t=await open(); let p=t.p;
  await t.figures("90001");
  ok("nineteen slides (the filings in detail in place of the one filings slide), all included, the new ones among them", same(await t.list("#pfPlan li"),["CoverIncluded","Executive summaryIncluded","PremiumIncluded","Lines and statesIncluded","UnderwritingIncluded","EarningsIncluded","Balance sheetIncluded","CapitalIncluded","ReservesIncluded","Accident yearsIncluded","ReinsuranceIncluded","Filings at a glance, last 12 monthsIncluded","Rate changes, last 12 monthsIncluded","Latest rate change by state (map), last 12 monthsIncluded","New products and market moves, last 12 monthsIncluded","Latest form and rule filings, last 12 monthsIncluded","Every state, last 12 monthsIncluded","Time with the regulator, last 12 monthsIncluded","Key diligence questionsIncluded"]), await t.list("#pfPlan li"));
  ok("every slide but the cover has a tick box, ticked, named for the slide", (await p.$$("#pfPlan .pfinc")).length===18 && (await p.$$eval("#pfPlan .pfinc",e=>e.every(x=>x.checked))) && (await p.getAttribute('#pfPlan .pfinc[data-id="earnings"]',"aria-label"))==="Include the earnings slide" && !(await p.$('#pfPlan .pfinc[data-id="cover"]')));
  ok("the sections are there, folded away, in slide order", same(await p.$$eval("#pfDetail-contents details.pfsec",e=>e.map(x=>[x.dataset.sec, x.open])),[["premium",false],["lines",false],["underwriting",false],["earnings",false],["balance",false],["capital",false],["reserves",false],["accident",false],["reinsurance",false],["filings",false]]));
  await p.click("#pfSec-contents-premium summary"); await p.waitForTimeout(150);
  const prem=await t.cells("#pfTabPremium");
  ok("premium: direct, assumed, gross, ceded, net and earned premiums in $M, then shares and growth marked (derived)", same(prem.map(r=>r[0]),["$M unless shown","Direct premiums written","Assumed premiums written","Gross premiums written","Ceded premiums written","Net premiums written","Net premiums earned","Ceded share (%) (derived)","Direct premium growth (%) (derived)","Net premium growth (%) (derived)"]) && same(prem[1],["Direct premiums written","74.2","83.6","96.1","108.9","122.5"]), prem.map(r=>r[0]));
  ok("premium: a small chart of direct and net premiums, as the page draws its charts", (await p.$$("#pfSec-contents-premium svg.pfchart rect")).length===10 && same(await t.list("#pfSec-contents-premium .pfkeys span"),["Direct premiums written","Net premiums written"]), [(await p.$$("#pfSec-contents-premium svg.pfchart rect")).length, await t.list("#pfSec-contents-premium .pfkeys span")]);
  await p.click("#pf_get"); await p.waitForTimeout(700);
  ok("an open section stays open when the page redraws", await p.$eval("#pfSec-contents-premium",e=>e.open));
  await p.click('[data-act="pf-sec-all"]'); await p.waitForTimeout(200);
  ok("Open all opens every section, and the button then closes them", (await p.$$eval("#pfDetail-contents details.pfsec",e=>e.every(x=>x.open))) && (await t.txt('[data-act="pf-sec-all"]'))==="Close all");
  const lines=await t.cells("#pfTabLines"), states=await t.cells("#pfTabStates");
  ok("lines and states: the largest five with premiums, share (derived) and loss ratio", same(lines[0],["Line","DPW $M","NPW $M","NPE $M","Share %","Loss and LAE ratio %"]) && same(lines[1],["Homeowners","81.0","52.6","50.1","66.1","60.0"]) && lines.length===7 && same(states[1],["FL","70.0","67.2","57.1","56.1"]) && (await t.txt("#pfSec-contents-lines")).includes("(share of direct premiums written, derived)"), [lines, states[1]]);
  const ay=await t.cells("#pfTabAy");
  ok("accident years: one row each, blank where a statement came before the year, the change in points (derived)", same(ay[0],["Accident year","2021","2022","2023","2024","2025","Change (points)","NPE $M"]) && same(ay[4],["2022","","70.1","72.4","74.7","77.0","+6.9","54.1"]) && (await p.$eval("#pfTabAy tr:nth-child(4) td:nth-child(7)",e=>e.className)).includes("bad") && (await t.txt("#pfSec-contents-accident")).includes("in percentage points (derived)"), ay);
  const rec=await t.cells("#pfTabRecov");
  ok("reinsurance: recoverables by reinsurer with their status, and the share owed by reinsurers not authorized (derived)", same(rec[0],["Reinsurer","$M","Share %","To surplus %","Status"]) && same(rec[3],["Tarrow Re","5.0","15.0","8.9","Unauthorized"]) && (await t.txt("#pfSec-contents-reinsurance")).includes("18.0% of recoverables were owed by reinsurers marked as not authorized, and 0.5% by reinsurers with no status given (derived)."), rec.slice(0,4));
  const cap=await t.cells("#pfTabCap"), earn=await t.cells("#pfTabEarn"), bal=await t.cells("#pfTabBal");
  ok("capital, earnings and balance sheet: reported figures as they are, worked-out ones marked (derived)", cap.some(r=>r[0]==="Paid in less dividends (derived)") && cap.some(r=>r[0]==="RBC ratio (%)") && earn.some(r=>r[0]==="Return on average equity (%)") && !earn.some(r=>r[0]==="Return on average equity (%) (derived)") && bal.some(r=>same(r,["Invested assets to liabilities (derived)","1.1x","1.0x","1.0x","1.0x","1.0x"])), [cap.map(r=>r[0]), bal.map(r=>r[0])]);
  ok("losses and adverse figures are magenta, in the house style", (await p.$$eval("#pfTabEarn td.bad",e=>e.map(x=>x.textContent))).includes("(2.4)") && (await p.$$eval("#pfTabUw td.bad",e=>e.map(x=>x.textContent))).includes("104.4"));
  ok("headings and buttons are in sentence case, and no em dashes", (await p.$$eval("#view h2,#view h3,#view summary,#view button",e=>e.map(x=>x.textContent.trim()).filter(s=>s && /\s[A-Z][a-z]+/.test(s.replace(/\b(S&P|NAIC|Claude|Corp Dev|PowerPoint|Calloway Insurance Co)\b/g,"x"))))).length===0 && !(await p.textContent("#view")).includes("\u2014"));
  await p.screenshot({path:OUTDIR+"/profiledetail-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: every section open, no sideways scroll", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/profiledetail-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(150);

  // ----- the reader takes slides out -----
  await p.click('#pfPlan .pfinc[data-id="earnings"]'); await p.waitForTimeout(150);
  await p.click('#pfPlan .pfinc[data-id="accident"]'); await p.waitForTimeout(150);
  ok("a slide taken out says so, and the count says how many you left out", (await t.list("#pfPlan li")).includes("EarningsYou left it out") && (await t.txt("#pfPlan")).includes("Accident yearsYou left it out") && (await t.txt(".f:has(#pfPlan) em")).includes("19 slides of 19 can be filled from these figures; you left out 2"), [await t.list("#pfPlan li"), await t.txt(".f:has(#pfPlan) em")]);
  ok("it is remembered in this browser only", same(await p.evaluate(()=>JSON.parse(localStorage.getItem("snl.pfSkip"))),["earnings","accident"]));
  await p.click("#pf_buildBtn"); await p.waitForTimeout(1200);
  let built=await p.evaluate(()=>window.__deck&&window.__deck.build);
  ok("the deck is built without them: eighteen slides (every state runs on to a second)", built && built.length===1 && built[0].ids.length===18 && !built[0].ids.includes("earnings") && !built[0].ids.includes("accident") && built[0].ids.includes("balance"), built);
  await p.click('#pfPlan .pfinc[data-id="earnings"]'); await p.waitForTimeout(150);
  ok("ticking it again puts it back", same(await p.evaluate(()=>JSON.parse(localStorage.getItem("snl.pfSkip"))),["accident"]) && (await t.list("#pfPlan li")).includes("EarningsIncluded"));
  await t.ctx.close();
  t=await open(); p=t.p;
  await p.evaluate(()=>localStorage.setItem("snl.pfSkip", JSON.stringify(["accident"]))); await p.reload(); await p.waitForTimeout(500);
  await t.figures("90001");
  ok("after a reload the choice is still there", (await t.list("#pfPlan li")).includes("Accident yearsYou left it out") && !(await p.isChecked('#pfPlan .pfinc[data-id="accident"]')));
  await p.evaluate(()=>localStorage.setItem("snl.pfSkip", "not json")); await p.reload(); await p.waitForTimeout(500);
  await t.figures("90001");
  ok("a broken saved choice is ignored: every slide is on", (await p.$$eval("#pfPlan .pfinc",e=>e.every(x=>x.checked))));
  await t.ctx.close();

  // ----- a long first load: the sections fill in as figures arrive; the banner is as before -----
  t=await open({facts:(body,n)=>({status:200, body:n===1?partial():REAL()}), delay:n=>n===1?50:1500}); p=t.p;
  await p.fill("#pf_code","90001"); await p.click("#pf_get");
  ok("while the rest come in, the figures so far are shown, section by section", await t.until(async()=>!!(await p.$("#pfSoFar"))) && (await t.txt("#pfBusy")).startsWith("Getting the rest of the figures for NAIC company 90001… 32 of 49 figures so far.") && !(await p.$("#pfContents")), await t.txt("#pfBusy"));
  ok("only the sections whose figures have arrived", same(await p.$$eval("#pfSoFar details.pfsec",e=>e.map(x=>x.dataset.sec)),["premium","lines","underwriting","capital","reinsurance","filings"]), await p.$$eval("#pfSoFar details.pfsec",e=>e.map(x=>x.dataset.sec)));
  await p.click("#pfSec-sofar-premium summary"); await p.waitForTimeout(100);
  ok("a section can be opened and read while the rest come in", await p.$eval("#pfSec-sofar-premium",e=>e.open) && (await t.cells("#pfTabPremium")).length>3 && await p.isVisible("#pfStop"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll while it carries on", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/profiledetail-carry-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  ok("once everything is in, the profile replaces the figures so far, and the open section stays open", await t.until(async()=>!!(await p.$("#pfContents")) && !(await p.$("#pfSoFar"))) && await p.$eval("#pfSec-contents-premium",e=>e.open) && t.n===2, t.n);
  await t.ctx.close();

  t=await open({facts:()=>({status:200, body:partial()})}); p=t.p;
  await p.fill("#pf_code","90001"); await p.click("#pf_get");
  ok("figures that don't come: the banner is as before, above what the profile holds", await t.until(async()=>!!(await p.$("#pfPending"))) && (await t.txt("#pfPending")).startsWith("Some figures didn't arrive. 17 of 49 figures didn't come back in time, so the profile below doesn't have them yet and the slides that need them are left out.") && !!(await p.$("#pfPending + #pfContents")) && !(await p.$("#pfSoFar")), await t.txt("#pfPending"));
  ok("and the sections the figures that did arrive fill are shown, and the filings", (await p.$$("#pfDetail-contents details.pfsec")).length===6);
  await t.ctx.close();

  // ----- none of the new figures mapped, and figures saved before this change -----
  t=await open({facts:()=>({status:200, body:noneNew()})}); p=t.p;
  await t.figures("90001");
  const pl=await t.list("#pfPlan li");
  ok("none of the new figures: the new slides are left out, saying which figures aren't mapped; never an error", pl.includes("EarningsLeft out: Net underwriting gain, net investment income earned, net realized capital gains, net cash from operations and net yield on invested assets aren't mapped to Snowflake yet.") && pl.includes("Accident yearsLeft out: Net loss and LAE ratio by accident year isn't mapped to Snowflake yet.") && !(await p.$("#pfErr")), pl);
  ok("the sections show what the other figures fill (net income and total assets still fill earnings and the balance sheet)", same(await p.$$eval("#pfDetail-contents details.pfsec",e=>e.map(x=>x.dataset.sec)),["premium","lines","underwriting","earnings","balance","capital","reserves","reinsurance","filings"]) && (await p.$$("#pfTabEarn tr")).length===3 && (await t.txt("#pfMissing")).includes("Net underwriting gain (not mapped)"), [await p.$$eval("#pfDetail-contents details.pfsec",e=>e.map(x=>x.dataset.sec)), await t.txt("#pfMissing")]);
  await t.ctx.close();
  t=await open({facts:()=>({status:200, body:copy(OLD)})}); p=t.p;
  await t.figures("90001");
  ok("facts saved before this change: the nine slides they had, and the sections their figures fill", (await p.$$("#pfPlan li")).length===9 && same(await p.$$eval("#pfDetail-contents details.pfsec",e=>e.map(x=>x.dataset.sec)),["premium","underwriting","capital"]), await p.$$eval("#pfDetail-contents details.pfsec",e=>e.map(x=>x.dataset.sec)));
  await t.ctx.close();

  // ----- hostile names -----
  const evil=REAL(); evil.facts.detail.lines.items[0].name=X; evil.facts.detail.recoverables.items[0].name=X; evil.facts.detail.recoverables.items[1].tag=X; evil.facts.reinsurers.items[0].name=X;
  t=await open({facts:()=>({status:200, body:evil})}); p=t.p;
  await t.figures("90001"); await p.click('[data-act="pf-sec-all"]'); await p.waitForTimeout(300);
  ok("hostile names in lines and reinsurers stay text", (await t.txt("#pfTabLines")).includes(X) && (await t.txt("#pfTabRecov")).includes(X) && !(await p.evaluate(()=>window.__xss)));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.log("FAIL harness "+(e&&e.stack||e)); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
