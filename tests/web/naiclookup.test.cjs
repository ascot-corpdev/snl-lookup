// Find by name when the company list has a company's S&P institution id but no NAIC company code: with the statutory
// mapping's company look-up, the Statutory and Profile finders show the matches at once, say they are looking the
// codes up, fill them in (one call), and say truthfully what S&P's statutory data had when a code is still missing
// (none, or more than one). A failed or timed-out look-up leaves the matches as they were, with the plain reason.
// Without the look-up nothing changes. Field set-up says whether it is mapped. 1440 and 390 wide. Every company, id
// and code is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), NL=FIX("naiclookup_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const MDASH="\u2014";
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const MAPPED=()=>({...copy(STAT.statusMapped), companies:{mapped:true, problem:null}});
const codesAnswer=ids=>({status:200, body:{results:ids.map(id=>({institutionId:id, ...(NL.codes[id]||{status:"unknown", naicCompanyCode:null, naicGroupCode:null, naicGroupName:null})})), asked:ids.length, saved:3}});
const PSTATUS=(codes)=>({statutory:{configured:true, mapped:true, fields:[], ...(codes?{codes:true}:{})}, claude:{configured:true}, filings:{configured:true}});
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width,height:width<500?844:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-22T12:00:00Z"));
    const t={p, ctx, calls:[], codesDelay:0, statStatus:()=>({status:200, body:MAPPED()}), pstatus:()=>PSTATUS(true),
      resolve:q=>/calloway/i.test(q) ? copy(NL.calloway) : /tarrow/i.test(q) ? copy(NL.tarrow) : {query:q, matches:[], note:"No saved company matches."},
      codes:body=>codesAnswer(body.institutionIds), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev", statutory:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-filings" && body.action==="resolve") return J(200,t.resolve(body.q));
        if(fn==="snl-statutory" && body.action==="codes"){ if(t.codesDelay) await new Promise(res=>setTimeout(res,t.codesDelay)); const a=t.codes(body); return J(a.status,a.body); }
        if(fn==="snl-statutory"){ const a = body.action==="status" ? t.statStatus() : {status:400, body:{error:"bad",message:"Unknown action."}}; return J(a.status,a.body); }
        if(fn==="snl-profile" && body.action==="status") return J(200,t.pstatus());
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:0, dailyLimit:20, costToday:0, resetsAt:"2026-11-23T00:00:00Z"});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+(over.hash||"#statutory")); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.innerText.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=(fn,a)=>t.calls.filter(c=>c.fn===fn && c.body.action===a);
    t.find=async q=>{ await p.fill("#st_find",q); await p.click('button[data-act="st-find"]'); await p.waitForTimeout(250); };
    t.noDash=async()=>!(await p.evaluate(()=>document.body.innerText)).includes(MDASH);
    return t;
  }
  const ROW_NONE="Calloway Specialty Co group Calloway Group (SNL P&C Group) Can't be added: S&P's statutory data has no NAIC company code for this company either. If you know the code, type it in the box above.";
  const ROW_SEVERAL="Calloway Twin Co group Calloway Group (SNL P&C Group) Can't be added: S&P's statutory data has more than one NAIC company code for this company (90041, 90042), so the app didn't choose. Type the right one in the box above.";
  const ROW_OLD=n=>`${n} Can't be added: the company list has no NAIC company code for it.`;

  // ----- without the company look-up: exactly as before -----
  let t=await open({}, {statStatus:()=>({status:200, body:copy(STAT.statusMapped)})}); let p=t.p;
  await t.find("Calloway");
  let rows=await t.all("#st_matches li");
  ok("not mapped: no look-up is asked for", t.of("snl-statutory","codes").length===0 && !(await p.$("#st_codesBusy")), t.calls.map(c=>c.fn+":"+c.body.action));
  ok("not mapped: the rows say what they said before", rows[0]===ROW_OLD("Calloway Insurance Co group Calloway Group (SNL P&C Group)") && rows[4]==="Calloway Coastal Co NAIC 90005 · group Calloway Group (SNL P&C Group) Add", rows);
  await t.ctx.close();

  // ----- with it: looking up, then filled in -----
  t=await open(); p=t.p; t.codesDelay=700;
  await p.fill("#st_find","Calloway"); await p.click('button[data-act="st-find"]'); await p.waitForTimeout(250);
  rows=await t.all("#st_matches li");
  ok("the matches show at once, while the codes are looked up", rows.length===7 && (await t.txt("#st_codesBusy"))==="Looking up 5 missing NAIC codes on S&P's statutory data. The first time takes about ten seconds." && rows[0].endsWith("Looking up its NAIC code…") && rows[4].endsWith("Add"), rows);
  ok("one look-up, for the institution ids that have no code, each once; not for a company with no institution id", same(t.of("snl-statutory","codes").map(c=>c.body),[{action:"codes", institutionIds:["5000001","5000002","5000003","5000004","5000006"]}]));
  ok("a company with no institution id still says what it said before", rows[6]===ROW_OLD("Calloway Lone Co"), rows[6]);
  await p.screenshot({path:OUTDIR+"/naiclookup-busy-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(120);
  ok("phone: no sideways scroll while looking up", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/naiclookup-busy-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.waitForTimeout(800);
  rows=await t.all("#st_matches li");
  ok("codes found are filled in, with an Add button", rows[0]==="Calloway Insurance Co NAIC 90001 · group Calloway Group (SNL P&C Group) Add" && rows[1]==="Calloway Home Co NAIC 90002 · group Calloway Group (SNL P&C Group) Add" && !(await p.$("#st_codesBusy")), rows);
  ok("none: says S&P's statutory data has no code either, and what to do", rows[2]===ROW_NONE, rows[2]);
  ok("two codes: says so, lists them, and doesn't choose", rows[3]===ROW_SEVERAL, rows[3]);
  ok("hostile names stay text, before and after the look-up", rows[5].startsWith('Calloway <img src=x onerror="window.__xss=1"> Co NAIC 90006') && rows[5].includes("Nonesuch <b>Group</b>") && !(await p.$("#st_matches img, #st_matches li b")) && await p.evaluate(()=>window.__xss===undefined), rows[5]);
  ok("Add all now counts the codes found", (await t.txt("#st_addAll")).startsWith("Add all 4 "), await t.txt("#st_addAll"));
  await p.click('#st_matches li >> nth=0 >> button[data-act="st-add"]'); await p.waitForTimeout(120);
  ok("Add puts the code that was looked up in the list, with its name", (await p.inputValue("#st_codes"))==="90001" && same(await t.all("#st_named .cchip"),["Calloway Insurance Co NAIC 90001 ×"]), await t.all("#st_named .cchip"));
  ok("no em dashes on the page", await t.noDash());
  await p.screenshot({path:OUTDIR+"/naiclookup-done-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(120);
  ok("phone: no sideways scroll with the codes filled in", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/naiclookup-done-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});

  // the group toggle uses the NAIC group code that came back
  await p.fill("#st_codes",""); await p.click('button[data-k="group"]'); await p.waitForTimeout(120);
  const gl=await t.all("#st_matches li");
  ok("group mode: the looked-up NAIC group code can be added, and companies with only the group's name are counted in it, listed once", gl[0]==="Calloway Group (SNL P&C Group) NAIC group 9001 · 5 matching companies Add" && gl.length===2, gl);
  await p.click('#st_matches li >> nth=0 >> button[data-act="st-add"]'); await p.waitForTimeout(100);
  ok("Add puts the NAIC group code in the list", (await p.inputValue("#st_codes"))==="9001");
  await p.click('button[data-k="company"]'); await p.waitForTimeout(100);

  // a new search starts afresh; one with no institution ids asks nothing
  await t.find("Tarrow"); await p.waitForTimeout(150);
  ok("a new search looks its own codes up", same(t.of("snl-statutory","codes").pop().body.institutionIds,["5000003"]) && (await t.all("#st_matches li"))[0].includes("S&P's statutory data has no NAIC company code for this company either"));
  await t.ctx.close();

  // ----- the look-up fails or runs out of time -----
  t=await open({}, {codes:()=>({status:502, body:{error:"snowflake_timeout", message:"The Snowflake query ran out of time. Try again in a minute."}})}); p=t.p;
  await t.find("Calloway"); await p.waitForTimeout(200);
  rows=await t.all("#st_matches li");
  ok("a time-out: the matches stay as the company list has them, with the plain reason", rows.length===7 && rows[0]===ROW_OLD("Calloway Insurance Co group Calloway Group (SNL P&C Group)") && (await t.txt("#st_codesErr"))==="Couldn't look up the missing NAIC codes on S&P's statutory data. The Snowflake query ran out of time. Try again in a minute. The matches are shown as the company list has them; if you know a code, type it in the box above.", {rows, err:await t.txt("#st_codesErr")});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(120);
  ok("phone: no sideways scroll with the failure note", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/naiclookup-failed-390.png",fullPage:true});
  await t.ctx.close();
  t=await open({}, {codes:()=>({status:409, body:{error:"not_mapped", message:"The company look-up isn't mapped."}})}); p=t.p;
  await t.find("Calloway"); await p.waitForTimeout(200);
  ok("a look-up that turns out not to be mapped: no note, the rows as before", !(await p.$("#st_codesErr")) && (await t.all("#st_matches li"))[0]===ROW_OLD("Calloway Insurance Co group Calloway Group (SNL P&C Group)"));
  await t.ctx.close();
  t=await open({}, {codes:()=>({status:500, body:{}})}); p=t.p;
  await t.find("Calloway"); await p.waitForTimeout(200);
  ok("any other failure is said too", (await t.txt("#st_codesErr")).startsWith("Couldn't look up the missing NAIC codes on S&P's statutory data. The statutory function answered 500."), await t.txt("#st_codesErr"));
  await t.ctx.close();

  // ----- Field set-up says whether the look-up is mapped, and what is wrong with it -----
  t=await open({}, {statStatus:()=>({status:200, body:{...MAPPED(), companies:{mapped:false, problem:"companies.view must be a view name"}}})}); p=t.p;
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(150);
  ok("set-up: not mapped, and the problem listed", (await t.txt("#suCompanies")).endsWith("not mapped (optional).") && (await t.txt("#suProblems")).includes("companies: companies.view must be a view name. Until it is fixed, Find by name can't look up missing NAIC codes."), [await t.txt("#suCompanies"), await t.txt("#suProblems")]);
  await t.find("Calloway");
  ok("a look-up with a problem isn't used", t.of("snl-statutory","codes").length===0);
  await t.ctx.close();
  t=await open(); p=t.p;
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(150);
  ok("set-up: mapped", (await t.txt("#suCompanies"))==="companies Company look-up, which finds the NAIC code of a company found by name without one: mapped." && !(await p.$("#suProblems")), await t.txt("#suCompanies"));
  await t.ctx.close();

  // ----- the Profile view's finder -----
  t=await open({}, {hash:"#profile"}); p=t.p; t.codesDelay=500;
  await p.fill("#pf_find","Calloway"); await p.press("#pf_find","Enter"); await p.waitForTimeout(250);
  ok("profile: shows the matches it has, and that it is looking the rest up", (await t.all("#pf_matches li .t1")).length===1 && (await t.txt("#pf_codesBusy")).startsWith("Looking up 5 missing NAIC codes"), await t.all("#pf_matches li .t1"));
  await p.waitForTimeout(600);
  const pm=await t.all("#pf_matches li .t1");
  ok("profile: the companies with codes found can now be chosen", same(pm,["Calloway Insurance Co","Calloway Home Co","Calloway Coastal Co",'Calloway <img src=x onerror="window.__xss=1"> Co']) && await p.evaluate(()=>window.__xss===undefined), pm);
  await p.click('#pf_matches li >> nth=0 >> [data-act="pf-choose"]'); await p.waitForTimeout(120);
  ok("profile: choosing fills the looked-up code", (await p.inputValue("#pf_code"))==="90001");
  await p.fill("#pf_find","Tarrow"); await p.press("#pf_find","Enter"); await p.waitForTimeout(800);
  ok("profile: none found anywhere says so truthfully", (await t.txt("#pf_noMatch"))==='The companies that match "Tarrow" have no NAIC company code in the company list or in S&P\'s statutory data. If you know the code, type it above.', await t.txt("#pf_noMatch"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(120);
  ok("profile phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/naiclookup-profile-390.png",fullPage:true});
  await t.ctx.close();
  t=await open({}, {hash:"#profile", pstatus:()=>PSTATUS(false)}); p=t.p;
  await p.fill("#pf_find","Calloway"); await p.press("#pf_find","Enter"); await p.waitForTimeout(300);
  ok("profile without the look-up: as before, nothing asked", t.of("snl-statutory","codes").length===0 && same(await t.all("#pf_matches li .t1"),["Calloway Coastal Co"]));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
