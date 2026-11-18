// Sign-in behind Cloudflare Access: when config.js (written by cloudflare/worker.js) sets accessLogin, the page shows
// no password form. It asks the Worker for a Supabase token, hands it to supabase-js, renews it before it runs out,
// picks it up again if supabase-js drops it, and signs out through Access. Without accessLogin (GitHub Pages) the
// password form is unchanged. Every name, email and token here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json");
const FNS="https://a.supabase.co/functions/v1/";
const ACCESS_CFG=`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.local",orgName:"",accessLogin:true,accessSessionUrl:"/access/session",logoutUrl:"/cdn-cgi/access/logout"};`;
const PAGES_CFG=`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};`;
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const T0=new Date("2026-11-13T12:00:00Z");

(async()=>{
  const b=await chromium.launch(); const errs=[];
  // bridge: (n) => {status, body} for the n-th call to /access/session (1-based)
  async function open({cfg=ACCESS_CFG, bridge, opts={}, viewport={width:1440,height:900}, fakeTimers=false}={}){
    const ctx=await b.newContext({viewport, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    const seen={session:0, logout:0, fns:[]};
    if(fakeTimers) await p.clock.install({time:T0}); else await p.clock.setFixedTime(T0);
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); seen.fns.push({fn, auth:req.headers()["authorization"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...STATUS, role:"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory" && body.action==="status") return J(200,STAT.statusOff);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:cfg});
      if(u===BASE+"access/session"){ seen.session++; const a=bridge?bridge(seen.session):{status:200, body:{access_token:"minted-"+seen.session, token_type:"bearer", expires_in:900, expires_at:0, user:{id:"u1", email:"owner@example.com"}, role:"corpdev", username:"owner"}};
        if(a==="abort") return r.abort("connectionfailed");
        return r.fulfill({status:a.status, contentType:"application/json", headers:{"cache-control":"no-store"}, body:JSON.stringify(a.body)}); }
      if(u===BASE+"cdn-cgi/access/logout"){ seen.logout++; return r.fulfill({contentType:"text/html",body:"<p>Signed out of Cloudflare Access</p>"}); }
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE);
    if(fakeTimers) await p.clock.runFor(2000); await p.waitForTimeout(350);
    const txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    const log=()=>p.evaluate(()=>window.__mock.log);
    return {p, ctx, seen, txt, log, noScroll:()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)};
  }

  // ----- signed in through Access -----
  {
    const t=await open();
    const log=await t.log();
    ok("asks the Worker for a token once", t.seen.session===1, t.seen);
    ok("hands the token to supabase-js with the placeholder refresh token", log.some(x=>x.op==="setSession" && x.access_token==="minted-1" && x.refresh_token==="cloudflare-access"), log);
    ok("never uses the password sign-in", !log.some(x=>x.op==="signIn"));
    ok("supabase-js made with its own refresh switched off", JSON.stringify(await t.p.evaluate(()=>__mock.created))===JSON.stringify({url:"https://a.supabase.co",key:"sb_publishable_k",opts:{auth:{autoRefreshToken:false}}}));
    ok("signed in: the tabs show, the form doesn't", await t.p.isVisible("#tabs") && !(await t.p.$("#li_user")) && !(await t.p.$("#li_pw")));
    ok("the header shows the login's name", (await t.txt("#whoName"))==="Corp Dev 1", await t.txt("#whoName"));
    ok("no Change password button", !(await t.p.isVisible("#pwBtn")));
    await t.p.click("#whoDot").catch(()=>{}); await t.p.waitForTimeout(100);
    ok("no Change password in the account menu", await t.p.$eval('#whoMenu [data-act="change-pw"]', e=>e.hidden && getComputedStyle(e).display==="none"));
    ok("the account menu still offers Sign out", await t.p.$eval('#whoMenu [data-act="signout"]', e=>getComputedStyle(e).display!=="none"));
    await t.p.keyboard.press("Escape");
    ok("functions are called with the Worker's token", t.seen.fns.length>0 && t.seen.fns.every(f=>f.auth==="Bearer t"), t.seen.fns);
    // supabase-js drops the token (it tried to refresh it and Supabase said no): the page asks the Worker again
    await t.p.evaluate(()=>__mock.fire("SIGNED_OUT")); await t.p.waitForTimeout(300);
    ok("a dropped token is fetched again and the login stays", t.seen.session===2 && await t.p.isVisible("#tabs"), t.seen);
    // Sign out goes through Access
    await t.p.evaluate(()=>{ const so=__mock.log; window.addEventListener("pagehide", ()=>{ try{ sessionStorage.setItem("signOutLog", JSON.stringify(so.filter(x=>x.op==="signOut"))); }catch{} }); });
    await t.p.click("#signoutBtn"); await t.p.waitForURL(BASE+"cdn-cgi/access/logout").catch(()=>{});
    ok("Sign out goes to Access's sign-out address", t.seen.logout===1 && t.p.url()===BASE+"cdn-cgi/access/logout", {seen:t.seen, url:t.p.url()});
    const so=JSON.parse(await t.p.evaluate(()=>sessionStorage.getItem("signOutLog")).catch(()=>"null")||"null");
    ok("and drops the Supabase token on this browser only", Array.isArray(so) && so.length===1 && so[0].scope==="local", so);
    await t.ctx.close();
  }

  // ----- the token is renewed 5 minutes before it runs out -----
  {
    const t=await open({fakeTimers:true});
    ok("one token at the start", t.seen.session===1, t.seen);
    await t.p.clock.runFor(590*1000); await t.p.waitForTimeout(150);
    ok("not renewed before 10 minutes", t.seen.session===1, t.seen);
    await t.p.clock.runFor(15*1000); await t.p.waitForTimeout(300);
    ok("renewed at 10 minutes, still signed in", t.seen.session===2 && await t.p.isVisible("#tabs"), t.seen);
    const log=await t.log();
    ok("the new token goes to supabase-js", log.some(x=>x.op==="setSession" && x.access_token==="minted-2"));
    await t.ctx.close();
  }

  // ----- renewal fails: back to the sign-in page with the reason -----
  {
    const okBody={access_token:"minted-1", token_type:"bearer", expires_in:900, user:{id:"u1"}, role:"corpdev"};
    const t=await open({fakeTimers:true, bridge:n=>n===1?{status:200, body:okBody}:{status:401, body:{error:"access_expired", message:"Your Cloudflare Access sign-in has expired. Sign in again."}}});
    await t.p.clock.runFor(605*1000); await t.p.waitForTimeout(300);
    ok("a failed renewal signs the page out with the Worker's reason", !(await t.p.isVisible("#tabs")) && (await t.txt(".login .err"))==="Your Cloudflare Access sign-in has expired. Sign in again.", await t.txt(".login"));
    ok("and offers Sign in again, with no password form", await t.p.isVisible("#accessAgain") && !(await t.p.$("#li_pw")));
    await t.ctx.close();
  }

  // ----- the Worker refuses at the start -----
  {
    const t=await open({bridge:()=>({status:403, body:{error:"access_aud", message:"The Cloudflare Access token is for another application. Check POLICY_AUD."}})});
    ok("the Worker's reason is shown", (await t.txt(".login .err"))==="The Cloudflare Access token is for another application. Check POLICY_AUD.", await t.txt(".login"));
    ok("no password form, a Sign in again link to this page", !(await t.p.$("#li_user")) && (await t.p.getAttribute("#accessAgain","href"))==="./");
    ok("nothing is asked of the functions", t.seen.fns.length===0, t.seen.fns);
    ok("no sideways scroll at desktop width", await t.noScroll());
    await t.ctx.close();
  }
  {
    const t=await open({bridge:()=>"abort", viewport:{width:390,height:844}});
    ok("no answer at all (an ended Access sign-in redirects away): says so", /Your sign-in has ended or the connection dropped/.test(await t.txt(".login .err")), await t.txt(".login"));
    ok("no sideways scroll at 390px", await t.noScroll());
    await t.p.screenshot({path:path.join(OUTDIR,"accesslogin-390.png")});
    await t.ctx.close();
  }
  {
    const t=await open({bridge:()=>({status:502, body:"not json"})});
    ok("an answer without a token: the status is given", /answered 502/.test(await t.txt(".login .err")), await t.txt(".login"));
    await t.ctx.close();
  }
  // ----- Supabase refuses the token -----
  {
    const ctx=await b.newContext({viewport:{width:1440,height:900}}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.route("**/*",async r=>{ const u=r.request().url();
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK.replace("failUpdateUser:\"\",","failUpdateUser:\"\", failSetSession:\"invalid JWT: unable to parse or verify signature\",")});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:ACCESS_CFG});
      if(u===BASE+"access/session") return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({access_token:"minted-bad",expires_in:900})});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""}); });
    await p.goto(BASE); await p.waitForTimeout(350);
    const msg=((await p.textContent(".login .err").catch(()=>""))||"").trim();
    ok("Supabase refusing the token says so, with Supabase's reason", msg==="Supabase didn't accept the sign-in (invalid JWT: unable to parse or verify signature). Tell the site owner.", msg);
    await ctx.close();
  }

  // ----- GitHub Pages (no accessLogin): the password form as before -----
  {
    const t=await open({cfg:PAGES_CFG, opts:{signedOut:true}});
    ok("the password form shows", !!(await t.p.$("#li_user")) && !!(await t.p.$("#li_pw")));
    ok("the Worker is never asked", t.seen.session===0);
    ok("supabase-js made as before", JSON.stringify(await t.p.evaluate(()=>__mock.created))===JSON.stringify({url:"https://a.supabase.co",key:"sb_publishable_k"}));
    await t.p.fill("#li_user","corpdev1"); await t.p.fill("#li_pw","made-up-password"); await t.p.click("#loginForm button"); await t.p.waitForTimeout(300);
    ok("signing in with a password still works", await t.p.isVisible("#tabs"));
    ok("and Change password is offered", await t.p.isVisible("#pwBtn"));
    await t.ctx.close();
  }

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
