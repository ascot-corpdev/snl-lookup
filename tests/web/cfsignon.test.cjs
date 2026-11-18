// Cloudflare sign-on on the page: with signOn "cloudflare" in config.js (written by the Worker) there is no
// username and password; the page asks the Worker's /auth/session, is signed in, sends the short Supabase token on
// function calls, table reads and storage, renews it before it ends and once on a 401, says plainly what went
// wrong, and signs out through Access. Password mode (the GitHub Pages copy) is unchanged. Every name is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const REAL_SB=fs.readFileSync(path.join(__dirname,"../../node_modules/@supabase/supabase-js/dist/umd/supabase.js"),"utf8");
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), STAT=FIX("web_statutory.json");
const SB="https://a.supabase.co", FNS=SB+"/functions/v1/";
const CF='window.SNL_CONFIG={"supabaseUrl":"https://a.supabase.co","supabaseAnonKey":"sb_publishable_k","orgName":"","signOn":"cloudflare"};';
const PW='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co/",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const PROFILE={id:"u1", email:"jane.doe@calloway.example", username:"jane.doe", displayName:"Jane Doe", role:"reader"};
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const wait=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  const b=await chromium.launch(); const errs=[];
  /* One page per scenario. t.session(n) decides the nth answer of /auth/session (from 1): an object
     {status, body} | "abort" | "redirect"; by default a fresh token "tok-n" for an hour. t.fnAuth401: tokens the
     functions refuse with 401. real: load the real supabase-js 2.119.0 instead of the stand-in. */
  async function open({config=CF, viewport={width:1440,height:900}, real=false, opts={}, session=null, install=false}={}){
    const ctx=await b.newContext({viewport, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    if(install) await p.clock.install({time:new Date("2026-11-13T12:00:00Z")}); else await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], sessions:[], rest:[], storage:[], logouts:[], signouts:0, fnAuth401:new Set(), restAuth401:new Set(), role:"reader"};
    t.session=session || (n=>({status:200, body:{accessToken:"tok-"+n, expiresAt:0, expiresIn:3600, profile:{...PROFILE, role:t.role}}}));
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*"},body:JSON.stringify(o)});
      if(req.method()==="OPTIONS") return r.fulfill({status:200,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"}});
      if(u===BASE+"auth/session"){ const n=t.sessions.length+1; t.sessions.push({method:req.method(), body:req.postData()}); const a=t.session(n);
        if(a==="abort") return r.abort("failed");
        if(a==="redirect") return r.fulfill({status:302,headers:{location:"https://team.example.cloudflareaccess.com/cdn-cgi/access/login/snl-lookup.calloway.workers.dev"}});
        return J(a.status,a.body); }
      if(u===BASE+"auth/signout"){ t.signouts++; return r.fulfill({contentType:"text/html",body:"<!doctype html><title>Signed out</title><p>Signed out of Cloudflare</p>"}); }
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"), auth=req.headers()["authorization"]; t.calls.push({fn, body, auth, apikey:req.headers()["apikey"]});
        if(t.fnAuth401.has(auth)) return J(401,{error:"signin",message:"Sign in again."});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...STATUS, role:t.role});
        if(fn==="snl-filings" && body.action==="reference") return J(200,FIX("web_reference.json"));
        if(fn==="snl-statutory" && body.action==="status") return J(200,STAT.statusOff);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u.startsWith(SB+"/auth/v1/logout")){ t.logouts.push({auth:req.headers()["authorization"], url:u}); return r.fulfill({status:204,headers:{"access-control-allow-origin":"*"}}); }
      if(u.startsWith(SB+"/rest/v1/")){ const auth=req.headers()["authorization"]; t.rest.push({path:u.slice(SB.length), auth, apikey:req.headers()["apikey"]});
        if(t.restAuth401.has(auth)) return J(401,{code:"PGRST301",message:"JWT expired"});
        return J(200,[]); }
      if(u.startsWith(SB+"/storage/v1/")){ t.storage.push({path:u.slice(SB.length), auth:req.headers()["authorization"]}); return J(200,[]); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:real?REAL_SB:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:config});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.noPassword=async()=>p.evaluate(()=>!document.querySelector("input[type=password]") && !document.getElementById("loginForm") && document.getElementById("pwBtn").hidden && [...document.querySelectorAll('#whoMenu [data-act="change-pw"]')].every(x=>x.hidden));
    return t;
  }

  // ----- signed in with no form -----
  let t=await open(); let p=t.p;
  ok("Cloudflare mode: signed in on load, with no username or password form", await p.isVisible("#tabs") && !(await p.$("#loginForm")) && (await t.txt(".action-title"))==="Search rate, rule and form filings", await t.txt("main"));
  ok("it asked /auth/session once, by POST, with nothing but the action", t.sessions.length===1 && t.sessions[0].method==="POST" && t.sessions[0].body==='{"action":"session"}', t.sessions);
  ok("the header shows who is signed in: the name, and the email address with the role", (await t.txt("#whoName"))==="Jane Doe" && (await p.getAttribute("#whoName","title"))==="jane.doe@calloway.example · Reader" && (await p.textContent("#whoMenuName")).includes("jane.doe@calloway.example"));
  ok("no password control anywhere: no change-password button or menu item, no password box", await t.noPassword());
  ok("the client is made with the token callback and the 401-retrying fetch", JSON.stringify(await p.evaluate(()=>__mock.createdWithToken))===JSON.stringify({url:SB,key:"sb_publishable_k",fetch:true}) && !(await p.evaluate(()=>__mock.created)));
  const st=t.calls.find(c=>c.fn==="snl-filings" && c.body.action==="status");
  ok("function calls carry the minted token and the publishable key", st && st.auth==="Bearer tok-1" && st.apikey==="sb_publishable_k", t.calls);
  ok("table reads ask for the token (the past answers list)", (await p.evaluate(()=>__mock.tokens)).some(x=>x.what==="table:snl_jobs" && x.token==="tok-1"), await p.evaluate(()=>__mock.tokens));
  await p.evaluate(async()=>{ await S.sb.storage.from("snl-template").list("", {limit:1}); await S.sb.storage.from("snl-template").download("template.pptx"); });
  ok("storage calls ask for the token too", (await p.evaluate(()=>__mock.tokens)).filter(x=>x.what.startsWith("storage:") && x.token==="tok-1").length===2);
  ok("the page never touches the client's auth (which throws with a supplied token)", !errs.some(e=>/accessToken option/.test(e)), errs);
  await p.screenshot({path:OUTDIR+"/cfsignon-signedin-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: signed in, no sideways scroll", await t.noScroll());
  await p.click("#whoDot"); await p.waitForTimeout(100);
  ok("phone: the account menu offers sign out, and no password change", await p.isVisible('#whoMenu [data-act="signout"]') && !(await p.isVisible('#whoMenu [data-act="change-pw"]')) && (await t.txt("#whoMenuName")).includes("jane.doe@calloway.example · Reader"));
  await p.screenshot({path:OUTDIR+"/cfsignon-menu-390.png"});
  // ----- sign out -----
  await p.click('#whoMenu [data-act="signout"]'); await p.waitForTimeout(500);
  ok("sign out ends the Supabase session (best effort) with the current token", t.logouts.length===1 && t.logouts[0].auth==="Bearer tok-1" && /scope=local/.test(t.logouts[0].url), t.logouts);
  ok("then goes to the Worker's sign-out, which hands over to Access's logout", t.signouts===1 && p.url()===BASE+"auth/signout", p.url());
  await t.ctx.close();

  // ----- renews before it ends, without losing what the user is doing -----
  t=await open({install:true}); p=t.p;
  await p.fill("#f_q","Calloway").catch(()=>{});
  const typed=await p.inputValue("#f_q").catch(()=>null);
  await p.clock.fastForward("54:00"); await wait(200);
  ok("no renewal well before the end", t.sessions.length===1);
  await p.clock.fastForward("02:00"); await wait(400);
  ok("renewed quietly about five minutes before the end", t.sessions.length===2, t.sessions.length);
  await p.evaluate(()=>loadStatus()); await wait(300);
  const later=t.calls.filter(c=>c.fn==="snl-filings" && c.body.action==="status").pop();
  ok("calls after the renewal use the new token", later && later.auth==="Bearer tok-2", later);
  ok("still signed in, on the same view, with what was typed kept", await p.isVisible("#tabs") && (typed===null || (await p.inputValue("#f_q"))===typed) && (await t.txt(".action-title"))==="Search rate, rule and form filings");
  await t.ctx.close();

  // ----- a token about to end is renewed before it is used -----
  t=await open({session:n=>({status:200, body:{accessToken:"tok-"+n, expiresAt:0, expiresIn:n===1?30:3600, profile:PROFILE}})}); p=t.p;
  await p.evaluate(()=>loadStatus()); await wait(300);
  ok("a token with under a minute left is renewed first, and the call uses the new one", t.sessions.length>=2 && t.calls.filter(c=>c.fn==="snl-filings" && c.body.action==="status").pop().auth==="Bearer tok-2", {s:t.sessions.length, c:t.calls.map(c=>c.auth)});
  await t.ctx.close();

  // ----- renews once on a 401 -----
  t=await open(); p=t.p;
  t.fnAuth401.add("Bearer tok-1");
  await p.evaluate(()=>loadStatus()); await wait(400);
  const sts=t.calls.filter(c=>c.fn==="snl-filings" && c.body.action==="status").slice(-2);
  ok("a 401 from a function renews the token once and sends the same call again", t.sessions.length===2 && sts[0].auth==="Bearer tok-1" && sts[1].auth==="Bearer tok-2" && JSON.stringify(sts[0].body)===JSON.stringify(sts[1].body), {s:t.sessions.length, sts});
  ok("and the user is still signed in", await p.isVisible("#tabs") && !(await p.$(".login")));
  // a 401 that persists: the sign-in has ended
  t.fnAuth401.add("Bearer tok-2"); t.fnAuth401.add("Bearer tok-3");
  await p.evaluate(()=>loadStatus()); await wait(500);
  ok("a 401 that stays after one renewal: 'your sign-in has ended', with a Reload button", (await t.txt(".login h2"))==="Your sign-in has ended" && await p.isVisible('.login [data-act="cf-reload"]') && !(await p.isVisible("#tabs")) && t.sessions.length===3, {h:await t.txt(".login"), s:t.sessions.length});
  ok("the ended state has no password box either", await t.noPassword());
  await p.screenshot({path:OUTDIR+"/cfsignon-ended-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("ended, phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/cfsignon-ended-390.png"});
  t.fnAuth401.clear();
  await p.click('[data-act="cf-reload"]'); await p.waitForTimeout(600);
  ok("Reload goes back through Cloudflare and signs in again", await p.isVisible("#tabs") && (await t.txt("#whoName"))==="Jane Doe");
  await t.ctx.close();

  // ----- renewal outcomes -----
  t=await open(); p=t.p;
  t.session=n=>n===1?null:"abort";
  await p.evaluate(()=>cfRenew()); await wait(300);
  ok("renewal can't reach the service while the token is still good: still signed in, tries again later", await p.isVisible("#tabs") && !(await p.$(".login")));
  t.session=n=>({status:200, body:{accessToken:"tok-"+n, expiresAt:0, expiresIn:3600, profile:{...PROFILE, role:"corpdev", displayName:"Jane Doe"}}});
  await p.evaluate(()=>cfRenew()); await wait(300);
  ok("a renewal that brings a new role updates the header", (await p.getAttribute("#whoName","title"))==="jane.doe@calloway.example · Corp Dev");
  t.session=()=>"redirect";
  await p.evaluate(()=>cfRenew()); await wait(300);
  ok("a renewal Access redirects (its own session ended): 'your sign-in has ended'", (await t.txt(".login h2"))==="Your sign-in has ended");
  await t.ctx.close();

  // ----- the plain messages -----
  t=await open({session:()=>({status:503, body:{error:"not_configured", message:"Cloudflare let you in, but sign-in isn't set up on Supabase yet. Ask the site owner to finish the set-up (README, Cloudflare sign-on)."}})}); p=t.p;
  ok("Cloudflare let you in but Supabase isn't set up: says so, with no form", (await t.txt(".login h2"))==="Not set up yet" && (await t.txt(".login")).includes("Cloudflare let you in, but sign-in isn't set up on Supabase yet.") && await t.noPassword() && !(await p.isVisible("#tabs")) && t.calls.length===0);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("not set up, phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/cfsignon-notset-390.png"});
  await t.ctx.close();

  t=await open({config:'window.SNL_CONFIG={"supabaseUrl":"","supabaseAnonKey":"","orgName":"","signOn":"cloudflare"};'}); p=t.p;
  ok("the Worker has no Supabase settings: 'not set up yet', and /auth/session isn't asked", (await t.txt(".login h2"))==="Not set up yet" && (await t.txt(".login")).includes("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on the Worker") && t.sessions.length===0);
  await t.ctx.close();
  t=await open({config:'window.SNL_CONFIG={"supabaseUrl":"https://a.supabase.co","supabaseAnonKey":"","orgName":"","signOn":"cloudflare","configProblem":"secret_key"};'}); p=t.p;
  ok("a secret key set on the Worker by mistake: says so plainly", (await t.txt(".login")).includes("holds a secret key, which is never sent to browsers"));
  await t.ctx.close();

  let first=true;
  t=await open({session:n=>first?"abort":({status:200, body:{accessToken:"tok-"+n, expiresAt:0, expiresIn:3600, profile:PROFILE}})}); p=t.p;
  ok("the sign-in service can't be reached: says so, with Try again", (await t.txt(".login h2"))==="Can't reach the sign-in service" && (await t.txt(".login")).includes("The sign-in service can't be reached.") && await p.isVisible('[data-act="cf-retry"]') && await t.noPassword());
  await p.screenshot({path:OUTDIR+"/cfsignon-unreachable-1440.png"});
  first=false; await p.click('[data-act="cf-retry"]'); await p.waitForTimeout(500);
  ok("Try again signs in once the service answers", await p.isVisible("#tabs") && (await t.txt("#whoName"))==="Jane Doe");
  await t.ctx.close();

  t=await open({session:()=>({status:500, body:{error:"server", message:"Your session couldn't be started. Try again in a minute. If it keeps happening, tell the site owner."}})}); p=t.p;
  ok("a Supabase failure shows the function's plain message with Try again", (await t.txt(".login")).includes("Your session couldn't be started.") && await p.isVisible('[data-act="cf-retry"]'));
  await t.ctx.close();
  for(const [label, a] of [["401", {status:401, body:{error:"signin", message:"Your Cloudflare sign-in couldn't be confirmed. Reload the page to sign in again."}}], ["a redirect to Access", "redirect"], ["403 from the Worker", {status:403, body:{error:"signin", message:"You need to sign in through Cloudflare to use this site."}}]]){
    t=await open({session:()=>a}); p=t.p;
    ok(`on load, ${label}: 'your sign-in has ended', with Reload`, (await t.txt(".login h2"))==="Your sign-in has ended" && await p.isVisible('[data-act="cf-reload"]') && !(await p.isVisible("#tabs")), await t.txt(".login"));
    await t.ctx.close();
  }

  // ----- with the real supabase-js 2.119.0: the token on table reads, storage and functions, and the 401 retry -----
  t=await open({real:true}); p=t.p;
  ok("real supabase-js: signed in", await p.isVisible("#tabs"), await t.txt("main"));
  ok("real supabase-js: table reads send the minted token and the publishable key", t.rest.length>0 && t.rest.every(r=>r.auth==="Bearer tok-1" && r.apikey==="sb_publishable_k"), t.rest);
  await p.evaluate(async()=>{ await S.sb.storage.from("snl-template").list("", {limit:1, search:"template.pptx"}); });
  ok("real supabase-js: storage sends the minted token", t.storage.length===1 && t.storage[0].auth==="Bearer tok-1" && t.storage[0].path.startsWith("/storage/v1/object/list/snl-template"), t.storage);
  ok("real supabase-js: function calls send the minted token", t.calls.length>0 && t.calls.every(c=>c.auth==="Bearer tok-1"));
  ok("real supabase-js: the client was made with a supplied token (its own sign-in is off)", await p.evaluate(()=>{ try{ S.sb.auth.getSession(); return false; }catch(e){ return /accessToken option/.test(e.message); } }));
  t.restAuth401.add("Bearer tok-1"); const n0=t.rest.length;
  const read=await p.evaluate(async()=>{ const {data, error}=await S.sb.from("snl_jobs").select("id").limit(1); return {data, error:error&&error.message}; });
  const tried=t.rest.slice(n0);
  ok("real supabase-js: a 401 on a table read renews the token once and reads again", read.error===null && tried.length===2 && tried[0].auth==="Bearer tok-1" && tried[1].auth==="Bearer tok-2" && t.sessions.length===2, {read, tried});
  await t.ctx.close();

  // ----- password mode is unchanged -----
  t=await open({config:PW, opts:{signedOut:true}}); p=t.p;
  ok("password mode: the username and password form, and no call to /auth/session", await p.isVisible("#loginForm") && (await t.txt(".login h2"))==="Sign in to SNL lookup" && t.sessions.length===0);
  await p.fill("#li_user","corpdev1"); await p.fill("#li_pw","correct horse battery"); await p.click("#loginForm button"); await p.waitForTimeout(400);
  ok("password mode: signs in as before, with change password on offer", await p.isVisible("#tabs") && !(await p.evaluate(()=>document.getElementById("pwBtn").hidden)) && JSON.stringify(await p.evaluate(()=>__mock.created))===JSON.stringify({url:SB,key:"sb_publishable_k"}) && t.sessions.length===0);
  await p.click("#signoutBtn"); await p.waitForTimeout(300);
  ok("password mode: sign out returns to the form, not to Cloudflare", await p.isVisible("#loginForm") && t.signouts===0);
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
