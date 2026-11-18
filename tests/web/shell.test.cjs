// The frame around the two views: blank settings, sign-in and sign-out, change password, the nav and the remembered
// view, the status strip and the Ask Claude button on every view, and what happens when a function says the login is
// no longer good. The Ask Claude panel itself is covered in ask.test.cjs.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co/",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  // One page per scenario. opts: what the stand-in for Supabase starts with; hooks: per-test answers from the functions.
  async function open(opts={}, {config=CONFIG, viewport={width:1440,height:900}, init=null, hash=""}={}){
    const ctx=await b.newContext({viewport, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], status:{...JSON.parse(JSON.stringify(STATUS)), role:opts.role||"corpdev"}, statusCode:200, filings401:false, scripts:[]};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"], apikey:req.headers()["apikey"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)});
        if(t.filings401) return J(401,{error:"signin",message:"Sign in again."});
        if(fn==="snl-filings" && body.action==="status") return t.statusCode===200 ? J(200,t.status) : J(t.statusCode,{error:"server",message:"The filings function failed: made-up fault"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory" && body.action==="status") return J(200,STAT.statusOff);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/^https?:\/\/(?!localhost)/.test(u)) t.scripts.push(u);
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:config});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    if(init) await p.addInitScript(init);
    await p.goto(BASE+hash); await p.waitForTimeout(350);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    return t;
  }

  // ----- the page's own source: pinned libraries, nothing else from outside -----
  const SRC=fs.readFileSync(WEB+"/index.html","utf8");
  const scripts=[...SRC.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m=>m[1]);
  ok("only supabase-js 2.119.0 and config.js load with the page", JSON.stringify(scripts)===JSON.stringify(["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js","config.js"]), scripts);
  ok("SheetJS is pinned and only named for lazy loading", SRC.includes('"https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js"') && !/<script[^>]*xlsx/.test(SRC));
  ok("no stylesheet, font or image from outside", !/<link\b/.test(SRC) && !/@import|url\(/.test(SRC) && !/<img\b/.test(SRC));
  ok("no em dashes in the page", !SRC.includes("—"));
  ok("the committed config is blank", /supabaseUrl:\s*""/.test(fs.readFileSync(WEB+"/config.js","utf8")) && /supabaseAnonKey:\s*""/.test(fs.readFileSync(WEB+"/config.js","utf8")));

  // ----- blank settings: says how to set it up -----
  let t=await open({}, {config:fs.readFileSync(WEB+"/config.js","utf8")}); let p=t.p;
  ok("blank config: says it isn't connected and how to fix it", (await t.txt(".login h2"))==="Not connected yet" && (await t.txt(".login")).includes("SUPABASE_URL") && (await t.txt(".login")).includes("SUPABASE_PUBLISHABLE_KEY") && (await t.txt(".login")).includes("web/config.js"), await t.txt(".login"));
  ok("blank config: no sign-in form, nav, status strip or Ask Claude button, and no call to any function", !(await p.$("#loginForm")) && !(await p.isVisible("#tabs")) && !(await p.isVisible("#strip")) && !(await p.$("#askFab")) && t.calls.length===0);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("blank config, phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/shell-noconfig-390.png",fullPage:true});
  await t.ctx.close();

  // ----- sign-in -----
  t=await open({signedOut:true}); p=t.p;
  ok("signed out: the sign-in form, nothing else", (await t.txt(".login h2"))==="Sign in to SNL lookup" && !(await p.isVisible("#tabs")) && !(await p.isVisible("#strip")) && !(await p.isVisible("#signoutBtn")) && !(await p.$("#askFab")) && t.calls.length===0);
  ok("no self sign-up on offer", !/sign up|create an account|register/i.test((await t.txt(".login")).replace("there is no sign-up","")) && (await t.txt(".login")).includes("there is no sign-up"));
  const pwStyle=await p.evaluate(()=>{ const a=getComputedStyle(document.getElementById("li_user")), b=getComputedStyle(document.getElementById("li_pw")); return [a.borderTopColor,b.borderTopColor,a.borderTopWidth,b.borderTopWidth,a.paddingLeft,b.paddingLeft,b.borderRadius]; });
  ok("the password box is styled like the username box", pwStyle[0]===pwStyle[1] && pwStyle[2]===pwStyle[3] && pwStyle[4]===pwStyle[5] && pwStyle[6]==="0px", pwStyle);
  await p.click("#loginForm button"); await p.waitForTimeout(100);
  ok("empty sign-in refused", (await t.txt(".login .err"))==="Enter your username and password.");
  await p.evaluate(()=>{ __mock.failLogin="invalid"; });
  await p.fill("#li_user","CorpDev1"); await p.fill("#li_pw","wrong-password"); await p.press("#li_pw","Enter"); await p.waitForTimeout(200);
  ok("wrong password: plain message, password cleared, username kept", (await t.txt(".login .err")).startsWith("That username and password don't match.") && (await p.inputValue("#li_pw"))==="" && (await p.inputValue("#li_user"))==="CorpDev1");
  ok("the username becomes username@usernameDomain", (await p.evaluate(()=>__mock.log.filter(l=>l.op==="signIn").map(l=>l.email))).join()==="corpdev1@snl-lookup.test");
  await p.evaluate(()=>{ __mock.failLogin="rate"; });
  await p.fill("#li_pw","x"); await p.press("#li_pw","Enter"); await p.waitForTimeout(200);
  ok("too many attempts: says to wait", (await t.txt(".login .err"))==="Too many attempts. Wait a few minutes and try again.");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(100);
  ok("sign-in, phone: no sideways scroll", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/shell-signin-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.evaluate(()=>{ __mock.failLogin=""; });
  await p.fill("#li_pw","correct horse battery"); await p.click("#loginForm button"); await p.waitForTimeout(400);
  ok("signed in: lands on Filings with the nav and the name", await p.isVisible("#tabs") && (await t.txt("#whoName"))==="Corp Dev 1" && (await t.txt(".action-title"))==="Search rate, rule and form filings" && (await p.getAttribute('nav.tabs a[data-view="filings"]',"aria-current"))==="page");
  ok("the client is made from the config, with the URL tidied", JSON.stringify(await p.evaluate(()=>__mock.created))===JSON.stringify({url:"https://a.supabase.co",key:"sb_publishable_k"}));
  await t.ctx.close();

  // ----- a login with no role -----
  t=await open({noProfile:true}); p=t.p;
  ok("login with no role: signed out again with the reason", (await t.txt(".login .err"))==="This login has no role on this site yet. Ask the site owner to set it up." && await p.evaluate(()=>__mock.signedOut) && t.calls.length===0);
  await t.ctx.close();

  // ----- signed in: nav, strip, remembered view -----
  t=await open(); p=t.p;
  ok("six views in the nav, and Ask Claude as a button beside them", (await p.$$eval("nav.tabs a",a=>a.map(x=>x.textContent.trim()))).join("|")==="Filings|Snapshot|Compare|Market|Statutory|Profile" && (await t.txt("#askFab"))==="Ask Claude" && await p.isVisible("#askFab"));
  const st0=t.calls.find(c=>c.body.action==="status");
  ok("status asked once after sign-in, with the login's token and the publishable key", t.calls.filter(c=>c.fn==="snl-filings"&&c.body.action==="status").length===1 && st0.auth==="Bearer t" && st0.apikey==="sb_publishable_k", t.calls.map(c=>c.fn+":"+c.body.action));
  const strip=async()=>(await p.$$eval("#stripIn .s-i",e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim())));
  ok("strip: requests used against the limits, and when each source was refreshed", JSON.stringify(await strip())===JSON.stringify(["S&P requests: 12 of 500 this hour, 40 of 12,000 today (trial account)","Reference lists refreshed 5 Nov","Last search 13 Nov","Statutory data: not set up yet"]), await strip());
  await p.screenshot({path:OUTDIR+"/shell-filings-1440.png",fullPage:true});
  await p.click('nav.tabs a[data-view="statutory"]'); await p.waitForTimeout(250);
  ok("Statutory opens from the nav; the strip and the Ask Claude button stay", (await t.txt(".action-title"))==="Statutory financials by NAIC company or group" && (await p.getAttribute('nav.tabs a[data-view="statutory"]',"aria-current"))==="page" && (await strip()).length===4 && p.url().endsWith("#statutory") && await p.isVisible("#askFab"));
  await p.click("#askFab"); await p.waitForTimeout(150);
  ok("headings and buttons are in sentence case, in the view and in the Ask Claude panel", (await p.$$("#askPanel h2, #askPanel button")).length>=4 && (await p.$$eval("h1,h2,h3,button,nav a",e=>e.map(x=>x.textContent.trim()).filter(s=>s && /\s[A-Z][a-z]+/.test(s.replace(/\b(S&P|NAIC|Ask|Claude|Corp Dev|Snowflake|SNL|Filings|Statutory|CSV|XLSX)\b/g,"x"))))).length===0);
  await p.click("#pwBtn"); await p.waitForTimeout(150);
  ok("change password opens over the Ask Claude panel", await p.evaluate(()=>{ const d=document.querySelector(".drawer").getBoundingClientRect(), el=document.elementFromPoint(d.left+d.width/2, d.top+d.height/2); return !!el.closest(".drawer"); }));
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  ok("Esc closes the drawer first, and leaves the panel", !(await p.$(".drawer")) && await p.isVisible("#askPanel"));
  await p.goto(BASE); await p.waitForTimeout(350);
  ok("the last view is remembered when the address names none", (await t.txt(".action-title"))==="Statutory financials by NAIC company or group");
  await p.goto(BASE+"#nonsense"); await p.waitForTimeout(350);
  ok("an unknown view in the address falls back to the remembered one", (await t.txt(".action-title"))==="Statutory financials by NAIC company or group");
  await p.goto(BASE+"#filings"); await p.waitForTimeout(350);
  ok("a view in the address wins", (await t.txt(".action-title"))==="Search rate, rule and form filings");

  // ----- change password -----
  await p.click("#pwBtn"); await p.waitForTimeout(150);
  ok("change password opens for this login", (await t.txt("#drTitle"))==="Change password" && (await t.txt("#pwForm")).includes("corpdev1"));
  await p.fill("#p_new","short"); await p.fill("#p_again","short"); await p.click('button[data-act="save-pw"]'); await p.waitForTimeout(100);
  ok("short password refused", (await t.txt("#pwErr"))==="Use at least 12 characters.");
  await p.fill("#p_new","long enough password"); await p.fill("#p_again","long enough passw0rd"); await p.press("#p_again","Enter"); await p.waitForTimeout(100);
  ok("mismatch refused", (await t.txt("#pwErr"))==="The two passwords don't match." && !(await p.evaluate(()=>__mock.log.some(l=>l.op==="updateUser"))));
  await p.evaluate(()=>{ __mock.failUpdateUser="New password should be different from the old password."; });
  await p.fill("#p_again","long enough password"); await p.click('button[data-act="save-pw"]'); await p.waitForTimeout(150);
  ok("Supabase's reason shown when it refuses", (await t.txt("#pwErr"))==="New password should be different from the old password." && await p.isVisible(".drawer"));
  await p.evaluate(()=>{ __mock.failUpdateUser=""; });
  await p.click('button[data-act="save-pw"]'); await p.waitForTimeout(150);
  ok("password changed through supabase-js", (await p.evaluate(()=>__mock.log.filter(l=>l.op==="updateUser").pop().password))==="long enough password" && (await t.txt("#toastRoot"))==="Password changed" && !(await p.$(".drawer")));
  await p.click("#pwBtn"); await p.waitForTimeout(100); await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  ok("Escape closes the drawer", !(await p.$(".drawer")));

  await p.click("#whoDot"); await p.waitForTimeout(100);
  const menuOpen=await p.isVisible("#whoMenu") && (await p.getAttribute("#whoDot","aria-expanded"))==="true";
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  ok("the account menu opens from the initials and Escape closes it", menuOpen && !(await p.isVisible("#whoMenu")) && (await p.getAttribute("#whoDot","aria-expanded"))==="false");
  await p.click("#whoDot"); await p.waitForTimeout(100); await p.click(".action-title"); await p.waitForTimeout(100);
  ok("a click elsewhere closes it too", !(await p.isVisible("#whoMenu")));

  // ----- phone header: account actions behind the initials -----
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: name and buttons give way to the initials", !(await p.isVisible("#whoName")) && !(await p.isVisible("#signoutBtn")) && (await t.txt("#whoDot"))==="CD");
  await p.click("#whoDot"); await p.waitForTimeout(100);
  ok("phone: the initials open a menu with change password and sign out", await p.isVisible("#whoMenu") && (await p.$$eval("#whoMenu button",e=>e.map(x=>x.textContent))).join("|")==="Change password|Sign out" && (await t.txt("#whoMenuName")).includes("corpdev1 · Corp Dev"));
  ok("phone: no sideways scroll with the menu open", await t.noScroll());
  await p.click('#whoMenu button[data-act="change-pw"]'); await p.waitForTimeout(150);
  ok("phone: the drawer fits", await p.isVisible(".drawer") && await t.noScroll());
  await p.screenshot({path:OUTDIR+"/shell-password-390.png"});
  await p.click('.drawer-f button[data-act="close"]'); await p.waitForTimeout(100);
  for(const v of VIEWS_()){ await p.goto(BASE+"#"+v); await p.waitForTimeout(350); ok(`phone: no sideways scroll on ${v}`, await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth)); await p.screenshot({path:OUTDIR+`/shell-${v}-390.png`,fullPage:true}); }
  await p.setViewportSize({width:1440,height:900});

  // ----- sign out -----
  await p.click("#signoutBtn"); await p.waitForTimeout(300);
  ok("sign out: back to the form with no scolding, state cleared", (await t.txt(".login h2"))==="Sign in to SNL lookup" && !(await p.$(".login .err")) && !(await p.isVisible("#strip")) && !(await p.$("#askFab")) && await p.evaluate(()=>!S.session && !S.status && !S.refs && __mock.signedOut));
  await p.fill("#li_user","corpdev1"); await p.fill("#li_pw","correct horse battery"); await p.press("#li_pw","Enter"); await p.waitForTimeout(400);
  ok("can sign in again", await p.isVisible("#tabs"));
  await p.evaluate(()=>__mock.fire("SIGNED_OUT")); await p.waitForTimeout(150);
  ok("signed out from elsewhere: says so", (await t.txt(".login .err"))==="You were signed out. Sign in again.");
  await t.ctx.close();

  // ----- status variants -----
  t=await open({role:"reader"}, {init:()=>{}}); p=t.p;
  ok("a reader login shows its role", (await p.getAttribute("#whoName","title"))==="corpdev1 · Reader");
  t.status={filings:{configured:false,message:"S&P API access isn't set up yet.",used:{hour:500,day:700},limits:{hour:500,day:12000},account:"production"},statutory:{configured:true},claude:{configured:false},refreshed:{reference:null,search:"2025-11-05T10:00:00Z",statutory:"2026-11-12T10:00:00Z"},role:"reader"};
  await p.evaluate(()=>loadStatus()); await p.waitForTimeout(250);
  const s2=await p.$$eval("#stripIn .s-i",e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
  ok("strip: not set up, limit reached, nothing loaded yet, a date from another year", JSON.stringify(s2)===JSON.stringify(["S&P filings: not set up yet","S&P requests: 500 of 500 this hour, 700 of 12,000 today (production account). This hour's limit is reached; wait for the next hour.","Reference lists: not loaded yet","Last search 5 Nov 2025","Statutory data refreshed 12 Nov","Questions: not set up yet"]), s2);
  ok("strip: the reached limit stands out", await p.$eval("#s_usage",e=>e.classList.contains("warn")));
  t.status={filings:{configured:true,message:null,used:{hour:null,day:3},limits:{hour:500,day:12000},account:"trial"},statutory:{configured:true},claude:{configured:true},refreshed:{reference:null,search:null,statutory:null},role:"reader"};
  await p.evaluate(()=>loadStatus()); await p.waitForTimeout(250);
  ok("strip: a missing number shows as n/d; no searches yet; statutory connected", (await t.txt("#s_usage"))==="S&P requests: n/d of 500 this hour, 3 of 12,000 today (trial account)" && (await t.txt("#s_search"))==="No searches yet" && (await t.txt("#s_stat"))==="Statutory data: connected, nothing fetched yet");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: a long strip wraps instead of scrolling", await t.noScroll());
  await t.ctx.close();

  // status fails, then works
  t=await open(); p=t.p; t.statusCode=500;
  await p.evaluate(()=>{ S.status=null; return loadStatus(); }); await p.waitForTimeout(250);
  ok("status failed: the function's message and a way to retry", (await t.txt("#stripIn")).startsWith("Couldn't check S&P usage. The filings function failed: made-up fault") && await p.isVisible('button[data-act="status-retry"]'), await t.txt("#stripIn"));
  ok("status failed: the view still works", await p.isVisible("#searchForm"));
  t.statusCode=200; await p.click('button[data-act="status-retry"]'); await p.waitForTimeout(300);
  ok("retry brings the strip back", (await t.txt("#s_usage")).startsWith("S&P requests: 12 of 500"));

  // a function says the login is no longer good
  t.filings401=true;
  await p.evaluate(()=>loadStatus()); await p.waitForTimeout(300);
  ok("401 from a function: back to sign-in with its message", (await t.txt(".login .err"))==="Sign in again." && !(await p.isVisible("#tabs")) && await p.evaluate(()=>__mock.signedOut));
  await t.ctx.close();

  // the browser session ended without the page knowing
  t=await open(); p=t.p;
  const before=t.calls.length;
  await p.evaluate(()=>{ __mock.signedOut=true; return loadStatus(); }); await p.waitForTimeout(250);
  ok("session gone: sign-in form, and nothing sent without a token", (await t.txt(".login .err"))==="Your session ended. Sign in again." && t.calls.length===before);
  await t.ctx.close();

  // storage blocked: the page still works
  t=await open({}, {init:()=>{ Object.defineProperty(window,"localStorage",{get(){ throw new Error("blocked"); }}); }, hash:"#statutory"}); p=t.p;
  ok("storage blocked: the page still opens the view", (await t.txt(".action-title"))==="Statutory financials by NAIC company or group");
  await p.goto(BASE); await p.waitForTimeout(350);
  ok("storage blocked: falls back to Filings", (await t.txt(".action-title"))==="Search rate, rule and form filings");
  ok("nothing fetched from outside except supabase-js", t.scripts.every(u=>/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.119\.0\//.test(u)), t.scripts);
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
function VIEWS_(){ return ["filings","statutory"]; }
