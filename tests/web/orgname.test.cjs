// The company's name is a setting (window.SNL_CONFIG.orgName), not part of the public code: the browser tab title,
// the footer and the Ask Claude panel's note, with and without a name, a hostile name kept as text, and 390px.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG=org=>`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co/",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"${org===undefined?"":",orgName:"+JSON.stringify(org)}};`;
const SEES="Claude sees only your question, a short description of what is on this screen, and what S&P returns for it: nothing else from this site";
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(org, viewport={width:1440,height:900}){
    const ctx=await b.newContext({viewport, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}");
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...STATUS, role:"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory" && body.action==="status") return J(200,STAT.statusOff);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG(org)});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },{});
    await p.goto(BASE); await p.waitForTimeout(350);
    const txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    await p.click("#askFab"); await p.waitForTimeout(150);
    return {p, ctx, txt, foot:()=>txt("footer.foot span:first-child"), noScroll:()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)};
  }

  // ----- no name (the repository's own config.js has none) -----
  ok("the committed config has a blank company name", /orgName:\s*""/.test(fs.readFileSync(WEB+"/config.js","utf8")));
  for(const [label, org] of [["no orgName setting", undefined], ["a blank name", "  "]]){
    const t=await open(org);
    ok(`${label}: the tab title is just "SNL lookup"`, (await t.p.title())==="SNL lookup", await t.p.title());
    ok(`${label}: the footer shows the year alone`, (await t.foot())==="2026", await t.foot());
    ok(`${label}: the panel note ends at "this site"`, (await t.txt("#askSees"))===SEES+". Check figures against the source before you use them.", await t.txt("#askSees"));
    await t.ctx.close();
  }

  // ----- a name -----
  let t=await open("Calloway Group");
  ok("with a name: the tab title names it", (await t.p.title())==="Calloway Group SNL lookup", await t.p.title());
  ok("with a name: the footer shows the year and the name", (await t.foot())==="2026 Calloway Group", await t.foot());
  ok("with a name: the panel note names it", (await t.txt("#askSees"))===SEES+" or from Calloway Group. Check figures against the source before you use them.", await t.txt("#askSees"));
  await t.ctx.close();

  // ----- a hostile name stays text -----
  const BAD=`<img src=x onerror="window.__pwned=1">Nonesuch & Co`;
  t=await open(BAD);
  ok("a hostile name is shown as text in the footer and the panel, never run", (await t.foot())==="2026 "+BAD && (await t.txt("#askSees")).includes("or from "+BAD+".") && !(await t.p.$("footer img, #askSees img")) && !(await t.p.evaluate(()=>window.__pwned)));
  ok("a hostile name is plain text in the tab title", (await t.p.title())===BAD+" SNL lookup");
  await t.ctx.close();

  // ----- phone width -----
  t=await open("Tarrow Mutual Insurance Co Strategy and Corporate Development", {width:390,height:844});
  ok("390px with a long name and the panel open: no sideways scroll", await t.noScroll());
  await t.p.screenshot({path:OUTDIR+"/orgname-390.png",fullPage:true});
  await t.p.click("#askClose"); await t.p.waitForTimeout(100);
  await t.p.evaluate(()=>window.scrollTo(0, document.documentElement.scrollHeight)); await t.p.waitForTimeout(80);
  ok("390px with a long name, panel closed: no sideways scroll", await t.noScroll());
  await t.p.screenshot({path:OUTDIR+"/orgname-390-foot.png"});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
