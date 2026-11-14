// Finding statutory companies and groups by name: the "Find by name" box on the Statutory view (company and group
// modes, the limit of eight codes, names beside the codes and in the results, the empty, busy and failed states,
// and where the box is hidden), and on the Filings view a company with a NAIC code but no S&P id, which is shown
// but can't be added. Every company and code is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), FOUND=FIX("statnames_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const NOTE=q=>`No saved company matches "${q}". S&P's filings API has no company search.`;
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, statStatus:()=>({status:200, body:copy(STAT.statusMapped)}),
      query:()=>({status:200, body:copy(STAT.query)}),
      resolve:q=>/calloway/i.test(q) ? {status:200, body:{...copy(FOUND.calloway), query:q}} : /tarrow/i.test(q) ? {status:200, body:{...copy(FOUND.tarrow), query:q}} : {status:200, body:{query:q, matches:[], note:NOTE(q)}}, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"], apikey:req.headers()["apikey"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev", statutory:{configured:t.statStatus().body.configured===true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-filings" && body.action==="resolve"){ const a=t.resolve(body.q); if(t.delay) await new Promise(res=>setTimeout(res,t.delay)); return J(a.status,a.body); }
        if(fn==="snl-statutory"){ const a = body.action==="status" ? t.statStatus() : body.action==="query" ? t.query(body) : {status:400, body:{error:"bad",message:"Unknown action."}}; return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+(opts.hash||"#statutory")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.innerText.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=(fn,a)=>t.calls.filter(c=>c.fn===fn && c.body.action===a);
    t.find=async (q, how)=>{ await p.fill("#st_find",q); if(how==="enter") await p.press("#st_find","Enter"); else await p.click('button[data-act="st-find"]'); await p.waitForTimeout(250); };
    t.codes=()=>p.inputValue("#st_codes");
    t.toast=()=>t.txt("#toastRoot");
    return t;
  }

  // ----- hidden where the form is hidden -----
  let t=await open({}, {statStatus:()=>({status:200, body:copy(STAT.statusOff)})}); let p=t.p;
  ok("not set up yet: no finder, as there is no form", !(await p.$("#st_find")) && !(await p.$("#statForm")) && (await p.$("#statOff")));
  await t.ctx.close();
  t=await open({}, {statStatus:()=>({status:200, body:copy(STAT.statusUnmapped)})}); p=t.p;
  ok("not mapped yet: no finder either", !(await p.$("#st_find")) && !(await p.$("#statForm")));
  await t.ctx.close();

  // ----- company mode -----
  t=await open(); p=t.p;
  ok("the finder sits in the form, labelled in plain words", await p.isVisible("#st_find") && (await t.txt('label[for="st_find"]'))==="Find by name part of a company or group name, or a NAIC code; adds the company's NAIC code to the list" && (await t.txt('button[data-act="st-find"]'))==="Find");
  ok("the empty state points to the finder", (await t.txt("#statEmpty")).endsWith("Don't know a code? Find the company or group by name above."));
  await t.find("   ");
  ok("nothing typed: says what to type and asks nothing", (await t.txt("#st_findErr"))==="Type part of a company or group name, or a NAIC code." && t.of("snl-filings","resolve").length===0);

  t.delay=500; await p.fill("#st_find","Calloway"); await p.press("#st_find","Enter"); await p.waitForTimeout(150);
  ok("while looking: says so, and the button waits", (await t.txt("#st_finding"))==="Looking for matches…" && await p.isDisabled('button[data-act="st-find"]') && !(await p.$("#st_findErr")));
  await p.waitForTimeout(600); t.delay=0;
  ok("Enter looks the name up with the resolve action, and doesn't fetch figures", same(t.of("snl-filings","resolve").map(c=>c.body),[{action:"resolve",q:"Calloway"}]) && t.of("snl-filings","resolve")[0].auth==="Bearer t" && t.of("snl-filings","resolve")[0].apikey==="sb_publishable_k" && t.of("snl-statutory","query").length===0 && !(await p.$("#statErr")));
  const rows=await t.all("#st_matches li");
  ok("each match shows its name, NAIC code and group", rows.length===7 && rows[0]==="Calloway Insurance Co NAIC 90001 · group Calloway Group Add" && rows[2]==="Calloway Coastal Co NAIC 90003 · group Calloway Group Add" && rows[5]==="Calloway Lone Co NAIC 90006 Add", rows);
  ok("a company with no NAIC code is shown but can't be added, and says why", rows[3]==="Calloway Specialty Co group Calloway Group Can't be added: the company list has no NAIC company code for it." && !(await p.$('#st_matches li >> nth=3 >> button')), rows[3]);
  ok("hostile names show as text", rows[6].includes('Calloway <img src=x onerror="window.__xss=1"> Co') && rows[6].includes("Nonesuch <b>Group</b>") && !(await p.$("#st_matches img, #st_matches li b")) && await p.evaluate(()=>window.__xss===undefined), rows[6]);
  ok("Add all counts only the matches with a NAIC code", (await t.txt("#st_addAll"))==="Add all 6 to compare them all. The first code in the list is the subject; at most 8 codes.");

  await p.click('#st_matches li >> nth=0 >> button[data-act="st-add"]'); await p.waitForTimeout(120);
  ok("Add puts the NAIC code in the codes box and the name beside it", (await t.codes())==="90001" && same(await t.all("#st_named .cchip"),["Calloway Insurance Co NAIC 90001 ×"]), await t.all("#st_named .cchip"));
  ok("the added match says so and can't be added twice; the list stays open for more", (await t.txt("#st_matches li >> nth=0 >> button"))==="Added" && await p.isDisabled("#st_matches li >> nth=0 >> button") && (await p.$$("#st_matches li")).length===7);
  await p.click('#st_matches li >> nth=2 >> button[data-act="st-add"]'); await p.waitForTimeout(120);
  ok("the first code is the subject and the next a peer", (await t.codes())==="90001, 90003" && same(await t.all("#st_named .cchip"),["Calloway Insurance Co NAIC 90001 · subject ×","Calloway Coastal Co NAIC 90003 · peer ×"]), await t.all("#st_named .cchip"));

  // typed by hand, alongside
  await p.fill("#st_codes","90001, 90003, 90002"); await p.waitForTimeout(80);
  ok("a code typed by hand shows by its code, as you type", same(await t.all("#st_named .cchip"),["Calloway Insurance Co NAIC 90001 · subject ×","Calloway Coastal Co NAIC 90003 · peer ×","NAIC 90002 peer ×"]) && (await p.evaluate(()=>document.activeElement.id))==="st_codes");
  await p.click('#st_matches li >> nth=1 >> button[data-act="st-add"]'); await p.waitForTimeout(100);
  ok("adding a code that was typed by hand is refused as a repeat", (await t.toast())==="That code is already in the list." && (await t.codes())==="90001, 90003, 90002" && await p.isDisabled("#st_matches li >> nth=1 >> button"), [await t.toast(), await t.codes()]);
  await p.click('#st_named .cchip >> nth=2 >> button'); await p.waitForTimeout(80);
  ok("× takes a code out of the list", (await t.codes())==="90001, 90003" && (await p.$$("#st_named .cchip")).length===2);

  // results carry the names the function didn't give
  t.query=()=>({status:200, body:{...copy(STAT.query), codes:["90001","90003"], entities:[{code:"90001",name:"Calloway Insurance Co"}], fromStore:false}});
  await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(400);
  ok("the query sends the codes the finder added, the subject first", same(t.of("snl-statutory","query").pop().body,{action:"query",kind:"company",codes:["90001","90003"],fromYear:2021,toYear:2025}));
  const heads=await p.$$eval('.statblk[data-field="surplus"] tbody tr td:first-child',e=>e.map(x=>x.innerText.replace(/\s+/g," ").trim()));
  ok("a company the function didn't name is shown by the name it was found by", heads[0]==="Calloway Insurance Co (NAIC 90001) Subject" && heads[1]==="Calloway Coastal Co (NAIC 90003) Peer" && heads[2]==="NAIC 90107 Peer", heads);

  // the limit
  await p.fill("#st_codes","90001"); await p.waitForTimeout(50);
  await t.find("Tarrow");
  ok("one group's companies: Add all names the group", (await t.txt("#st_addAll")).startsWith("Add all 10 to compare the whole of Tarrow Group."));
  await p.click('button[data-act="st-add-all"]'); await p.waitForTimeout(150);
  ok("Add all fills the list up to eight and says how many were left out", (await t.codes())==="90001, 90101, 90102, 90103, 90104, 90105, 90106, 90107" && (await t.toast())==="Added 7. A comparison takes at most 8 codes, so 3 were left out.", [await t.codes(), await t.toast()]);
  const later=await p.$$eval('.statblk[data-field="surplus"] tbody tr td:first-child',e=>e.map(x=>x.innerText.replace(/\s+/g," ").trim()));
  ok("names found after the figures were fetched don't change the results already shown", later[2]==="NAIC 90107 Peer", later);
  await p.click('#st_matches li >> nth=9 >> button[data-act="st-add"]'); await p.waitForTimeout(120);
  ok("when the list is full, Add says so and changes nothing", (await t.toast())==="The list is full: one subject and 7 peers. Remove a code to add another." && (await t.codes()).split(", ").length===8);
  await p.click('button[data-act="st-add-all"]'); await p.waitForTimeout(120);
  ok("Add all again when full adds nothing and says so", (await t.toast())==="The list is full: one subject and 7 peers. Remove a code to add another." && (await t.codes()).split(", ").length===8);
  await p.screenshot({path:OUTDIR+"/statnames-company-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with matches and named codes", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/statnames-company-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});

  // ----- group mode -----
  await p.fill("#st_codes",""); await p.click('button[data-k="group"]'); await p.waitForTimeout(100);
  await t.find("Calloway");
  const gl=await t.all("#st_matches li");
  ok("in group mode the matches are gathered into their groups, with how many companies matched", same(gl,["Calloway Group NAIC group 9001 · 4 matching companies Add","Calloway Re Group NAIC group 9002 · 1 matching company Add","Nonesuch <b>Group</b> 1 matching company Can't be added: the company list has no NAIC group code for this group."]) && (await t.txt('#st_matches')).length>0 && (await p.getAttribute("#st_matches","aria-label"))==="Matching groups", gl);
  ok("companies with no group are counted, not lost", (await t.txt("#st_loose"))==="1 matching company has no group in the company list." && !(await p.$("#st_addAll")));
  ok("the label follows the mode", (await t.txt('label[for="st_find"]')).endsWith("adds the group's NAIC code to the list"));
  await p.click('#st_matches li >> nth=0 >> button[data-act="st-add"]'); await p.waitForTimeout(100);
  await p.click('#st_matches li >> nth=1 >> button[data-act="st-add"]'); await p.waitForTimeout(100);
  ok("Add puts the NAIC group code in the list, with the group's name", (await t.codes())==="9001, 9002" && same(await t.all("#st_named .cchip"),["Calloway Group NAIC 9001 · subject ×","Calloway Re Group NAIC 9002 · peer ×"]));
  t.query=()=>({status:200, body:{...copy(STAT.query), kind:"group", codes:["9001","9002"], entities:[], fields:[{id:"surplus", label:"Policyholder surplus", unit:"usd", by:"year", rows:[{code:"9001",year:2025,value:5e8},{code:"9002",year:2025,value:2e8}]}], fromStore:false}});
  await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(400);
  ok("the group query goes as before", same(t.of("snl-statutory","query").pop().body,{action:"query",kind:"group",codes:["9001","9002"],fromYear:2021,toYear:2025}));
  const gh=await p.$$eval('.statblk[data-field="surplus"] tbody tr td:first-child',e=>e.map(x=>x.innerText.replace(/\s+/g," ").trim()));
  ok("group names carry into the results", same(gh,["Calloway Group (NAIC 9001) Subject","Calloway Re Group (NAIC 9002) Peer"]), gh);
  await p.click('button[data-k="company"]'); await p.waitForTimeout(100);
  ok("names belong to their mode: the group codes don't take company names", same(await t.all("#st_named .cchip"),["NAIC 9001 subject ×","NAIC 9002 peer ×"]));
  await p.setViewportSize({width:390,height:844}); await p.click('button[data-k="group"]'); await p.waitForTimeout(150);
  ok("phone: no sideways scroll in group mode", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/statnames-group-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});

  // ----- nothing found, failure -----
  await t.find("Zennor");
  ok("nothing matches: a calm note that says what to do instead", (await t.txt("#st_findNote"))==='No company in the app\'s company list matches "Zennor". Try a shorter part of the name, or type the NAIC group code in the box above.' && (await p.getAttribute("#st_findNote","role"))==="status" && !(await p.$("#st_matches")));
  t.resolve=()=>({status:500, body:{error:"server", message:"The filings function answered 500. Try again in a minute."}});
  await t.find("Calloway");
  ok("a failed lookup says so, and the form still works", (await t.txt("#st_findErr"))==="Couldn't look that up. The filings function answered 500. Try again in a minute." && (await p.getAttribute("#st_findErr","role"))==="alert" && !(await p.$("#st_matches")) && !(await p.isDisabled('button[data-act="stat-search"]')));
  await t.ctx.close();

  // ----- the Filings view: a company with a NAIC code and no S&P id -----
  t=await open({hash:"#filings"}); p=t.p;
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  const coastal=(await t.all("#matches li"))[2];
  ok("Filings: a NAIC-only company is shown, can't be added, and says why in plain words", coastal==="Calloway Coastal Co NAIC 90003 · group Calloway Group Can't be added: the company list has no S&P id for it, so its filings can't be searched. Its NAIC code works on the Statutory view." && !(await p.$("#matches li >> nth=2 >> button")), coastal);
  ok("Filings: Add all counts only companies with an S&P id", (await t.txt('button[data-act="co-add-all"]'))==="Add all 5");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("Filings phone: no sideways scroll with the reason shown", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/statnames-filings-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.click('button[data-act="co-add-all"]'); await p.waitForTimeout(150);
  ok("Filings: Add all leaves the NAIC-only companies out", same(await t.all("#chips .cchip b"),["Calloway Insurance Co","Calloway Home Co","Calloway Specialty Co","Calloway Re Co",'Calloway <img src=x onerror="window.__xss=1"> Co']) && !(await p.evaluate(()=>S.f.chips.some(c=>c.name==="Calloway Coastal Co"||c.name==="Calloway Lone Co"))));
  await t.ctx.close();

  ok("no script errors on the page", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
