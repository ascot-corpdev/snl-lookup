// Ask Claude about a Snapshot in one click: the "Ask Claude about this" button and the "Ask about this" link beside
// each main block put a question in the box, written from what is on screen (the carrier, the period, the states and
// lines that really appear, the largest change that is really there), and send nothing until the reader presses Ask.
// The panel's starting suggestions over a Snapshot, the line under the box, and what goes to the function as
// `screen`. Snapshots of different shapes: a group, only decreases, no rate impacts, no change, a withdrawn filing,
// partial, nothing returned, hostile names. Then 390px. Made-up companies throughout; nothing touches the network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("snapshot_search.json"), RES=FIX("snapshot_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

// made-up filings for one company, Calloway Insurance Co (institution 5000001), in the shape a search answers with
let seq=0;
const row=o=>{ seq++; return {serffFilingEntityEventId:72000000+seq, serffFilingEventId:62000000+seq, trackingNumber:null, sfcNumber:null, institutionId:5000001, spStatEntityId:null, naicCompanyCode:null, companyId:null,
  companyName:o.co||"Calloway Insurance Co", naicGroupCode:null, naicGroupName:null, serffFilingStateId:o.st, serffFilingState:null, typeOfInsuranceId:101, typeOfInsurance:o.toi===undefined?"Homeowners":o.toi, subTypeOfInsurance:null,
  dateSubmitted:null, publishDate:o.pub, renewBusReqEffDate:null, newBusReqEffDate:null, filingStatusId:1, filingStatus:o.status===undefined?"Approved":o.status, serffFilingTypeId:1, serffFilingType:o.type,
  overallRateImpact:o.rate===undefined?null:o.rate, dispOverallRateImpact:null, filingDescription:null, documentId:8900000+seq, filingVersionId:`snapask-${seq}-made-up`, pages:600,
  companies:[{companyId:null, companyName:o.co||"Calloway Insurance Co", naicCompanyCode:null, institutionId:5000001, spStatEntityId:null}]}; };
const ONE={...SEARCH.params, institutionIds:[5000001]};
const result=(rows, extra={})=>({...copy(SEARCH), params:copy(ONE), rows, total:rows.length, byCompany:[{kind:"institutionId", id:5000001, name:"Calloway Insurance Co", rows:rows.length}], notes:[], ...extra});

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", deviceScaleFactor:width<500?2:1}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], resolve:q=>/group/i.test(q) ? copy(RES.byGroup) : copy(RES.byName), search:()=>({status:200, body:copy(SEARCH)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(body.action==="status") return J(200,copy(STATUS));
        if(body.action==="reference") return J(200,REFS);
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        if(body.action==="search"){ const a=t.search(body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.goto(BASE+"#snapshot"); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.asks=()=>t.calls.filter(c=>c.fn==="snl-chat" && c.body.action==="ask");
    t.find=async q=>{ await p.fill("#sn_find",q); await p.press("#sn_find","Enter"); await p.waitForTimeout(200); };
    t.group=async()=>{ await t.find("Calloway Group"); await p.click('[data-act="snap-group"] >> nth=0'); await p.waitForTimeout(250); };
    t.company=async(i=0)=>{ await t.find("Calloway"); await p.click(`#sn_matches [data-act="snap-co"] >> nth=${i}`); await p.waitForTimeout(150); };
    t.run=async()=>{ await p.click("#sn_run"); await p.waitForTimeout(450); };
    t.qs=async()=>p.evaluate(()=>snapAskQs());
    // a click that should fill the box: the question in it, the panel open, the box focused with the cursor at the end
    t.fill=async sel=>{ await p.click(sel); await p.waitForTimeout(150);
      return {open:await p.isVisible("#askPanel"), value:await p.inputValue("#ask_input"), focused:await p.evaluate(()=>{ const e=document.activeElement; return !!e && e.id==="ask_input" && e.selectionStart===e.value.length; })}; };
    t.close=async()=>{ if(await p.isVisible("#askClose")) { await p.click("#askClose"); await p.waitForTimeout(100); } };
    return t;
  }
  const done=async t=>{ await t.ctx.close(); };

  // ----- a group: the made-up fixture of 18 filings across three companies -----
  let t=await open(); let p=t.p;
  ok("no Ask button before a snapshot is on screen", !(await p.$("#sn_ask")) && !(await p.$('[data-act="snap-ask"]')));
  await t.group(); await t.run();
  const G="Calloway Group (SNL P&C Group)";
  const GQ={
    all:`Give me an overview of what ${G} has filed since Nov 2023: the largest rate changes in California and Florida, what the latest form and rule filings changed and where it files most.`,
    rates:`What explains the rate changes ${G} filed in California, Florida and Texas since Nov 2023? The largest on screen is a 12.5% increase for Commercial property in California. Read the filings behind the largest ones.`,
    states:`Which lines of business and filing types make up the filings ${G} made in Florida, Georgia and Texas, its busiest states, since Nov 2023?`,
    years:`How did the filings ${G} made change from 2023 to 2026, and what was behind 2026, the year with the most? Look at the rate, rule and form filings.`,
    forms:`Summarise what the latest form and rule filings ${G} made in Florida for Homeowners and Dwelling fire changed.`,
  };
  const qs=await t.qs();
  const sorted=o=>Object.fromEntries(Object.entries(o).sort());
  ok("group: the question for each block, written from the fixture", same(sorted(qs), sorted(GQ)), qs);
  ok("group: one button at the top and a link beside each of the four main blocks", await p.isVisible("#snHead #sn_ask") && (await t.txt("#sn_ask"))==="Ask Claude about this"
    && same(await p.$$eval('.snblk [data-act="snap-ask"]', e=>e.map(x=>[x.closest(".snblk").id, x.dataset.q, x.textContent])), [["snMap","states","Ask about this"],["snRates","rates","Ask about this"],["snYears","years","Ask about this"],["snLatest","forms","Ask about this"]]),
    await p.$$eval('.snblk [data-act="snap-ask"]', e=>e.map(x=>[x.closest(".snblk").id, x.dataset.q])));
  ok("group: no link on time with the regulator", !(await p.$('#snDays [data-act="snap-ask"]')));
  for(const [sel,k] of [["#sn_ask","all"],['#snRates [data-act="snap-ask"]',"rates"],['#snMap [data-act="snap-ask"]',"states"],['#snYears [data-act="snap-ask"]',"years"],['#snLatest [data-act="snap-ask"]',"forms"]]){
    const f=await t.fill(sel);
    ok(`group: ${k}: opens the panel with the question in the box, ready to send or edit`, f.open && f.value===GQ[k] && f.focused, f);
    await t.close();
  }
  ok("nothing is sent before Ask", t.asks().length===0, t.asks());
  // the panel's suggestions over this snapshot
  await p.click("#askFab"); await p.waitForTimeout(150);
  ok("suggestions over a snapshot: four built from it, in place of the Filings view's", same(await t.list("#askSuggest .chip"), [GQ.all, GQ.rates, GQ.forms, GQ.states]), await t.list("#askSuggest .chip"));
  ok("the lead says they start from what is on screen", (await t.txt("#askSuggest p")).endsWith("To start from what is on screen, pick a question or type your own:"));
  ok("the note under the box: Claude starts from this carrier and period", (await t.txt("#askTold"))===`Claude starts from this carrier and period: ${G} and its 3 companies, filings published 15 Nov 2023 to 13 Nov in 6 states, every filing type and status. 18 filings on screen.`, await t.txt("#askTold"));
  await p.click('#askSuggest .chip >> nth=1'); await p.waitForTimeout(100);
  ok("a suggestion fills the box and sends nothing", (await p.inputValue("#ask_input"))===GQ.rates && t.asks().length===0);
  // edited, then asked: the question as edited goes, with the snapshot described
  await p.fill("#ask_input", GQ.rates+" Keep it short."); await p.click('[data-act="ask-send"]'); await p.waitForTimeout(300);
  const ask=t.asks()[0];
  ok("Ask sends the question as the reader left it", t.asks().length===1 && ask.body.question===GQ.rates+" Keep it short.", ask&&ask.body);
  ok("and the screen: the snapshot's search, its companies, and that it is a snapshot", !!ask && same(ask.body.screen, {view:"filings", search:{companyIds:[], institutionIds:[5000001,5000002,5000003], states:["CA","FL","GA","NY","SC","TX"], from:"2023-11-15", to:"2026-11-13", typeOfInsuranceIds:[], filingTypeIds:[], filingStatusIds:[]},
    total:18, companies:[G,"Calloway Coastal Co","Calloway Home Co","Calloway Insurance Co"], snapshot:{name:G, kind:"group", years:3, capped:false}}), ask&&ask.body.screen);
  ok("the question shows that Claude started from this carrier and period", (await t.txt("#turn-0 .told"))===`Claude started from this carrier and period: ${G} and its 3 companies, filings published 15 Nov 2023 to 13 Nov in 6 states, every filing type and status. 18 filings on screen.`, await t.txt("#turn-0 .told"));
  // with a conversation going, a link still fills the box for a follow-up, and sends nothing
  await t.close();
  const f2=await t.fill('#snLatest [data-act="snap-ask"]');
  ok("with a conversation going, a link fills the box for a follow-up", f2.open && f2.value===GQ.forms && t.asks().length===1, f2);
  await t.close();
  await p.screenshot({path:OUTDIR+"/snapshotask-1440.png",fullPage:false});
  // 390px: the button and the links fit, and the panel with a long question doesn't scroll sideways
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(250);
  ok("390px: no sideways scroll with the snapshot on screen", await t.noScroll());
  ok("390px: the button and every link are visible", await p.isVisible("#sn_ask") && (await p.$$eval('.snblk [data-act="snap-ask"]', e=>e.every(x=>x.getBoundingClientRect().width>0 && x.getBoundingClientRect().right<=window.innerWidth))));
  await p.$eval("#snRates", e=>e.scrollIntoView()); await p.screenshot({path:OUTDIR+"/snapshotask-390-block.png"});
  await p.click('#snRates [data-act="snap-ask"]'); await p.waitForTimeout(200);
  ok("390px: the panel opens with the question, no sideways scroll", (await p.inputValue("#ask_input"))===GQ.rates && await t.noScroll());
  await p.screenshot({path:OUTDIR+"/snapshotask-390-panel.png"});
  ok("no page errors (group)", errs.length===0, errs);
  await done(t);

  // ----- one company, only decreases; a withdrawn form filing among the latest -----
  t=await open({search:()=>({status:200, body:result([
    row({st:"FL", type:"Rate", rate:-3.0, pub:"2026-05-11T00:00:00"}), row({st:"TX", type:"Rate", rate:-7.5, pub:"2025-02-01T00:00:00", toi:"Dwelling fire"}),
    row({st:"FL", type:"Form", pub:"2026-06-01T00:00:00", status:"Withdrawn"}), row({st:"FL", type:"Form", pub:"2026-03-01T00:00:00"}), row({st:"GA", type:"Rule", pub:"2025-09-01T00:00:00", toi:"Private passenger auto"})])})}); p=t.p;
  await t.company(0); await t.run();
  const C="Calloway Insurance Co";
  const DQ={
    rates:`What explains the rate changes ${C} filed in Texas and Florida since Nov 2023? The largest on screen is a 7.5% decrease for Dwelling fire in Texas. Read the filings behind the largest ones.`,
    states:`Which lines of business and filing types make up the filings ${C} made in Florida, Georgia and Texas, its busiest states, since Nov 2023?`,
    years:`How did the filings ${C} made change from 2023 to 2026, and what was behind 2026, the year with the most? Look at the rate, rule and form filings.`,
    forms:`Summarise what the latest form filings ${C} made in Florida for Homeowners changed. One of them was withdrawn: say what the filing gives as the reason, if it gives one.`,
    all:`Give me an overview of what ${C} has filed since Nov 2023: the largest rate changes in Texas and Florida, what the latest form and rule filings changed and where it files most.`,
  };
  const dq=await t.qs();
  ok("only decreases: says decrease, never increase, and names the largest that is there", same(sorted(dq), sorted(DQ)) && !/increase/.test(dq.rates), dq);
  ok("only decreases: the top button and the rate link fill those questions", (await t.fill("#sn_ask")).value===DQ.all && (await t.close(), (await t.fill('#snRates [data-act="snap-ask"]')).value===DQ.rates));
  await t.close();
  ok("one company: the note under the box has no group count", (await (async()=>{ await p.click("#askFab"); await p.waitForTimeout(100); return t.txt("#askTold"); })())===`Claude starts from this carrier and period: ${C}, filings published 15 Nov 2023 to 13 Nov in 6 states, every filing type and status. 5 filings on screen.`, await t.txt("#askTold"));
  await t.close();
  await done(t);

  // ----- rate filings but no rate impact anywhere; no withdrawn filing -----
  t=await open({search:()=>({status:200, body:result([
    row({st:"GA", type:"Rate", pub:"2026-04-01T00:00:00"}), row({st:"FL", type:"Rate", pub:"2025-04-01T00:00:00"}), row({st:"FL", type:"Rule", pub:"2025-05-01T00:00:00", status:"Pending"})])})}); p=t.p;
  await t.company(0); await t.run();
  const nq=await t.qs();
  ok("no rate impacts: the rate question says so and asks what they changed, naming no change that isn't there", nq.rates===`The rate filings ${C} made in Georgia and Florida since Nov 2023 carry no overall rate impact in S&P's data. Read the most recent ones and say what each changed.`, nq.rates);
  ok("no rate impacts: the overview doesn't mention rate changes", nq.all===`Give me an overview of what ${C} has filed since Nov 2023: what the latest rule filings changed and where it files most.`, nq.all);
  ok("no withdrawn filing: nothing about withdrawal", !/withdr/i.test(JSON.stringify(nq)) && nq.forms===`Summarise what the latest rule filings ${C} made in Florida for Homeowners changed.`, nq.forms);
  ok("no rate impacts: the rate link is still there, as rate filings are", await p.isVisible('#snRates [data-act="snap-ask"]'));
  await done(t);

  // ----- no rate filings, no form or rule filings: those links aren't offered -----
  t=await open({search:()=>({status:200, body:result([row({st:"SC", type:"Other", pub:"2026-01-10T00:00:00"})])})}); p=t.p;
  await t.company(0); await t.run();
  const oq=await t.qs();
  ok("no rate, form or rule filings: no question or link for those blocks", !oq.rates && !oq.forms && !(await p.$('#snRates [data-act="snap-ask"]')) && !(await p.$('#snLatest [data-act="snap-ask"]')), oq);
  ok("one state, one year: said plainly", oq.states===`Which lines of business and filing types make up the filings ${C} made in South Carolina, the only state with filings on screen, since Nov 2023?` && oq.years===`What did the other filings ${C} made in 2026 change?`, oq);
  await p.click("#askFab"); await p.waitForTimeout(100);
  ok("suggestions skip what isn't there", same(await t.list("#askSuggest .chip"), [oq.all, oq.states, oq.years]), await t.list("#askSuggest .chip"));
  await done(t);

  // ----- every rate impact is zero -----
  t=await open({search:()=>({status:200, body:result([row({st:"GA", type:"Rate", rate:0, pub:"2026-04-01T00:00:00", toi:"Private passenger auto"})])})}); p=t.p;
  await t.company(0); await t.run();
  const zq=await t.qs();
  ok("no change in rate: says no change, not an increase or decrease", zq.rates===`The rate filings ${C} made in Georgia since Nov 2023 show no change in overall rate on screen. What did they change? Read the filings behind them.` && !/the largest rate changes/.test(zq.all), zq);
  await done(t);

  // ----- partial -----
  t=await open({search:()=>({status:200, body:{...copy(SEARCH), capped:true, saved:false}})}); p=t.p;
  await t.group(); await t.run();
  const pq=await t.qs();
  ok("partial: the overview says the snapshot is partial", pq.all===GQ.all+" The snapshot on screen is partial, so its counts are lower than they should be.", pq.all);
  await p.click("#askFab"); await p.waitForTimeout(100);
  ok("partial: the note under the box says so", (await t.txt("#askTold"))===`Claude starts from this carrier and period: ${G} and its 3 companies, filings published 15 Nov 2023 to 13 Nov in 6 states, every filing type and status. 18 filings on screen, a partial result.`, await t.txt("#askTold"));
  await p.fill("#ask_input","What changed?"); await p.click('[data-act="ask-send"]'); await p.waitForTimeout(300);
  ok("partial: the screen says the result was cut", t.asks().length===1 && t.asks()[0].body.screen.snapshot.capped===true, t.asks()[0]&&t.asks()[0].body.screen);
  await done(t);

  // ----- nothing returned -----
  t=await open({search:()=>({status:200, body:result([])})}); p=t.p;
  await t.company(0); await t.run();
  const eq=await t.qs();
  ok("nothing returned: the button asks where else it might file, and no block links", (await t.fill("#sn_ask")).value===`S&P returned no filings for ${C} published since Nov 2023 in this snapshot. Check whether it files under other company names, and search those.` && !(await p.$('.snblk [data-act="snap-ask"]')), eq);
  ok("nothing returned: suggestions are those two", same(await t.list("#askSuggest .chip"), [eq.all, eq.names]), await t.list("#askSuggest .chip"));
  ok("nothing returned: still told as a snapshot with no filings", (await t.txt("#askTold")).endsWith("every filing type and status. 0 filings on screen."), await t.txt("#askTold"));
  await done(t);

  // ----- hostile names: in the box as text, never as markup -----
  t=await open({search:()=>({status:200, body:result([row({st:"FL", type:"Rate", rate:4.0, pub:"2026-04-01T00:00:00", toi:'<img src=x onerror="window.__xss=2">', status:"Pending </textarea><b>x</b>", co:"Calloway <script>window.__xss=1</script> Co"})])})}); p=t.p;
  await t.company(2); await t.run();
  const H="Calloway <script>window.__xss=1</script> Co";
  const hf=await t.fill('#snRates [data-act="snap-ask"]');
  ok("hostile names: the question carries them as text", hf.value===`What explains the rate changes ${H} filed in Florida since Nov 2023? The largest on screen is a 4.0% increase for <img src=x onerror="window.__xss=2"> in Florida, pending </textarea><b>x</b>. Read the filings behind the largest ones.`, hf.value);
  ok("hostile names: nothing in them runs or becomes markup", await p.evaluate(()=>window.__xss===undefined) && !(await p.$("#askPanel img")) && (await p.$$("#askPanel textarea")).length===1 &&!(await p.$("#askRoot script")));
  await p.click('[data-act="ask-send"]'); await p.waitForTimeout(300);
  ok("hostile names: the name goes as the snapshot's name, as text", t.asks().length===1 && t.asks()[0].body.screen.snapshot.name===H, t.asks()[0]&&t.asks()[0].body.screen.snapshot);
  await done(t);

  // ----- a very long name is cut short in the question and in the screen -----
  t=await open({resolve:()=>({query:"x", matches:[{companyId:null, companyName:"Calloway "+"Long ".repeat(60)+"Co", naicCompanyCode:null, institutionId:"5000001", spStatEntityId:null, naicGroupCode:null, naicGroupName:null}]}),
    search:()=>({status:200, body:result([row({st:"FL", type:"Form", pub:"2026-04-01T00:00:00"})])})}); p=t.p;
  await t.company(0); await t.run();
  const lq=await t.qs(), lname=await p.evaluate(()=>snapScreen().snapshot.name);
  ok("a long name: at most 120 characters in the question and the screen", lname.length===120 && lq.forms.includes(lname+" made") && !lq.forms.includes(lname+"Long"), lname.length);
  await done(t);

  // ----- over a Snapshot with nothing on screen: what a snapshot can answer -----
  t=await open(); p=t.p;
  await p.click("#askFab"); await p.waitForTimeout(150);
  ok("nothing on screen: suggestions say what a snapshot can answer, asking for the carrier", same(await t.list("#askSuggest .chip"), [
    "What rate changes has this carrier filed in each state over the last 3 years, and what explains the largest? Carrier:",
    "Summarise what the latest form and rule filings this carrier made changed. Carrier:",
    "In which states has this carrier filed most over the last 3 years, and for which lines of business? Carrier:"]) && (await t.txt("#askSuggest p")).endsWith("To see what a snapshot can answer, pick a question or type your own:"), await t.list("#askSuggest .chip"));
  ok("nothing on screen: the note says Claude starts from the question alone", (await t.txt("#askTold"))==="Nothing is on screen yet, so Claude starts from your question alone.");
  await t.close();
  await t.company(1); await p.click('[data-act="snap-years"][data-y="5"]'); await p.waitForTimeout(100);
  await p.click("#askFab"); await p.waitForTimeout(150);
  ok("a carrier chosen but not run: the suggestions name it and the period", (await t.list("#askSuggest .chip"))[0]==="What rate changes has Calloway Home Co filed in each state over the last 5 years, and what explains the largest?", await t.list("#askSuggest .chip"));
  await p.click('#askSuggest .chip >> nth=2'); await p.waitForTimeout(100);
  ok("and a suggestion fills the box without sending", (await p.inputValue("#ask_input"))==="In which states has Calloway Home Co filed most over the last 5 years, and for which lines of business?" && t.asks().length===0);
  await t.close();
  // the Filings view keeps its own suggestions
  await p.click('nav.tabs a[data-view="filings"]'); await p.waitForTimeout(200); await p.click("#askFab"); await p.waitForTimeout(150);
  ok("the Filings view keeps its own starting points", !(await p.$("#askSuggest")) || !(await t.list("#askSuggest .chip")).some(s=>/carrier/i.test(s)));
  ok("no page errors", errs.length===0, errs);
  await done(t);

  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
