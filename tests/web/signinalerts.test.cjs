// Recent sign-ins on the page (Cloudflare sign-on, Corp Dev only): opened from the account menu, it lists the last 30
// days of sign-ins from snl_signins, newest first, 20 at a time with Show more, and says in one line whether email
// notices are on and what is missing. Readers never see it and can't read the table. Every person here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), STAT=FIX("web_statutory.json");
const SB="https://a.supabase.co", FNS=SB+"/functions/v1/";
const CF='window.SNL_CONFIG={"supabaseUrl":"https://a.supabase.co","supabaseAnonKey":"sb_publishable_k","orgName":"","signOn":"cloudflare"};';
const PW='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co/",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const NOW=Date.parse("2026-11-13T12:00:00Z"), MIN=60000, DAY=86400000;
const ON={recorded:true, notices:{on:true, why:null, recipients:2, fromSet:true}, keepDays:90};
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

/* Sign-in rows: n sessions, each 40 minutes before the last; one Corp Dev among them. */
function rows(n){
  const out=[];
  for(let i=0;i<n;i++){ const first=new Date(NOW-i*40*MIN-20*MIN).toISOString(), last=new Date(NOW-i*40*MIN).toISOString();
    out.push(["snl_signins", "k"+String(i).padStart(3,"0"), {session_key:"k"+i, email:i===3?"owner@example.com":`colleague${i}@example.com`, role:i===3?"corpdev":"reader", first_seen_at:first, last_seen_at:last, notice:i===3?"not_needed":"sent"}]); }
  return out;
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open({config=CF, viewport={width:1440,height:900}, role="corpdev", signins=true, seed=[], status={status:200, body:ON}}={}){
    const ctx=await b.newContext({viewport, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date(NOW));
    const t={p, calls:[], role, status};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      const J=(s,o)=>r.fulfill({status:s,contentType:"application/json",headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*"},body:JSON.stringify(o)});
      if(req.method()==="OPTIONS") return r.fulfill({status:200,headers:{"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"}});
      if(u===BASE+"auth/session") return J(200,{accessToken:"tok-1", expiresAt:0, expiresIn:3600, profile:{id:"u1", email:role==="corpdev"?"owner@example.com":"sam.reader@example.com", username:"x", displayName:role==="corpdev"?"Owner":"Sam Reader", role}});
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"]});
        if(fn==="snl-signin" && body.action==="status") return J(t.status.status, t.status.body);
        if(fn==="snl-filings" && body.action==="status") return J(200,{...STATUS, role});
        if(fn==="snl-filings" && body.action==="reference") return J(200,FIX("web_reference.json"));
        if(fn==="snl-statutory" && body.action==="status") return J(200,STAT.statusOff);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u.startsWith(SB+"/rest/v1/")||u.startsWith(SB+"/storage/v1/")) return J(200,[]);
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:config});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },{role, signins, seed});
    await p.goto(BASE); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.openCard=async()=>{ await p.click("#whoDot"); await p.waitForTimeout(100); await p.click("#siMenu"); await p.waitForTimeout(300); };
    t.rowTexts=async()=>p.$$eval("#siTable tbody tr", trs=>trs.map(tr=>[...tr.children].map(td=>td.textContent.trim())));
    return t;
  }

  // ----- Corp Dev: rows, newest first, 20 at a time -----
  let t=await open({seed:[...rows(25), ["snl_signins","old",{session_key:"old", email:"long.ago@example.com", role:"reader", first_seen_at:new Date(NOW-40*DAY).toISOString(), last_seen_at:new Date(NOW-40*DAY).toISOString(), notice:"sent"}],
    ["snl_signins","odd",{session_key:"odd", email:"<img src=x onerror=window.__x=1>@example.com", role:"reader", first_seen_at:new Date(NOW-30*DAY+60*MIN).toISOString(), last_seen_at:new Date(NOW-30*DAY+60*MIN).toISOString(), notice:"sent"}]]});
  let p=t.p;
  ok("Corp Dev: nothing is shown until asked", !(await p.$("#siPanel")));
  await p.click("#whoDot"); await p.waitForTimeout(100);
  ok("Corp Dev: the account menu offers Recent sign-ins", await p.isVisible("#siMenu") && (await t.txt("#siMenu"))==="Recent sign-ins");
  await p.click("#siMenu"); await p.waitForTimeout(300);
  ok("the card opens under the strip, titled Recent sign-ins", await p.isVisible("#signinsRoot #siPanel") && (await t.txt("#siPanel h3"))==="Recent sign-ins");
  let tr=await t.rowTexts();
  ok("20 at a time", tr.length===20, tr.length);
  ok("newest first, with person, role, first seen and last seen written the house way", JSON.stringify(tr[0])===JSON.stringify(["colleague0@example.com","Reader","13 Nov, 11:40","13 Nov, 12:00"]) && JSON.stringify(tr[1])===JSON.stringify(["colleague1@example.com","Reader","13 Nov, 11:00","13 Nov, 11:20"]), tr.slice(0,2));
  ok("a Corp Dev sign-in says Corp Dev", JSON.stringify(tr[3])===JSON.stringify(["owner@example.com","Corp Dev","13 Nov, 09:40","13 Nov, 10:00"]), tr[3]);
  const reads=await p.evaluate(()=>__mock.signinReads);
  ok("it reads only the four columns, the last 30 days, newest first, 21 rows to know if there are more", reads.length===1 && reads[0].cols==="email,role,first_seen_at,last_seen_at" && JSON.stringify(reads[0].gtes)===JSON.stringify([["first_seen_at",new Date(NOW-30*DAY).toISOString()]]) && JSON.stringify(reads[0].ord)===JSON.stringify(["first_seen_at",false]) && JSON.stringify(reads[0].range)===JSON.stringify([0,20]), reads);
  ok("the notices line says they are on, and to how many addresses", (await t.txt("#siNotices"))==="Email notices are on: each new sign-in by someone not on the admin list is emailed to 2 addresses.", await t.txt("#siNotices"));
  const sc=t.calls.filter(c=>c.fn==="snl-signin");
  ok("the status comes from snl-signin's status action, with the login's token", sc.length===1 && sc[0].body.action==="status" && sc[0].auth==="Bearer tok-1", sc);
  ok("Show more is offered", await p.isVisible("#siMore") && (await t.txt("#siMore"))==="Show more");
  await p.screenshot({path:OUTDIR+"/signinalerts-1440.png"});
  ok("1440 wide: no sideways scroll", await t.noScroll());
  await p.click("#siMore"); await p.waitForTimeout(300);
  tr=await t.rowTexts();
  ok("Show more adds the next ones, and stops when there are no more", tr.length===26 && !(await p.$("#siMore")), tr.length);
  ok("a sign-in older than 30 days isn't listed", !tr.some(r=>r[0]==="long.ago@example.com"));
  ok("an address is shown as text, never as markup", tr[25][0]==="<img src=x onerror=window.__x=1>@example.com" && !(await p.$("#siTable img")) && !(await p.evaluate(()=>window.__x)));
  ok("the second read starts where the first ended", JSON.stringify((await p.evaluate(()=>__mock.signinReads))[1].range)===JSON.stringify([20,40]));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("390 wide: no sideways scroll", await t.noScroll());
  ok("390 wide: each sign-in reads as a small block with its labels", await p.evaluate(()=>getComputedStyle(document.querySelector("#siTable tbody td")).display==="block" && getComputedStyle(document.querySelector("#siTable thead")).display==="none"));
  await p.evaluate(()=>document.getElementById("siPanel").scrollIntoView());
  await p.screenshot({path:OUTDIR+"/signinalerts-390.png"});
  await p.click('[data-act="si-close"]'); await p.waitForTimeout(150);
  ok("Close takes the card away", !(await p.$("#siPanel")));
  await p.context().close();

  // ----- empty, missing table, notices off -----
  t=await open({seed:[]}); p=t.p; await t.openCard();
  ok("no rows: says no sign-ins recorded yet", (await t.txt("#siEmpty"))==="No sign-ins recorded yet." && !(await p.$("#siTable")));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("390 wide, empty: no sideways scroll", await t.noScroll());
  await p.context().close();

  t=await open({signins:false, status:{status:200, body:{...ON, recorded:false}}}); p=t.p; await t.openCard();
  ok("table missing: says to run migration 0011", (await t.txt("#siEmpty")).startsWith("Run migration 0011 to start recording sign-ins.") && !(await p.$("#siTable")), await t.txt("#siEmpty"));
  ok("table missing: the notices line says they start once the migration is run", (await t.txt("#siNotices"))==="Email notices start once migration 0011 has been run.");
  await p.screenshot({path:OUTDIR+"/signinalerts-missing-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("390 wide, missing: no sideways scroll", await t.noScroll());
  await p.context().close();

  t=await open({signins:false, status:{status:200, body:ON}}); p=t.p; await t.openCard();
  ok("a read that finds no table shows the missing state even when the status is late or says otherwise", (await t.txt("#siEmpty")).startsWith("Run migration 0011"));
  await p.context().close();

  const lines=[
    [{...ON, notices:{on:false, why:"off", recipients:2, fromSet:true}}, "Email notices are off: SNL_SIGNIN_NOTICES is set to off on Supabase. Sign-ins are still recorded."],
    [{...ON, notices:{on:false, why:"no_key", recipients:2, fromSet:true}}, "Email notices are off: RESEND_API_KEY isn't set on Supabase (README, Sign-in notices)."],
    [{...ON, notices:{on:false, why:"no_recipients", recipients:0, fromSet:true}}, "Email notices are off: there is no one to send them to. Set SNL_NOTIFY_EMAILS or SNL_ADMIN_EMAILS on Supabase."],
    [{...ON, notices:{on:true, why:null, recipients:1, fromSet:false}}, "Email notices are on: each new sign-in by someone not on the admin list is emailed to 1 address. WATCH_FROM isn't set on Supabase, so Resend delivers only to its own account's address."],
  ];
  for(const [body, want] of lines){
    t=await open({status:{status:200, body}}); p=t.p; await t.openCard();
    ok(`notices line: ${body.notices.why||"on"}${body.notices.fromSet?"":" without WATCH_FROM"}`, (await t.txt("#siNotices"))===want, await t.txt("#siNotices"));
    await p.context().close();
  }
  t=await open({status:{status:400, body:{error:"bad", message:"Unknown action. Use session."}}}); p=t.p; await t.openCard();
  ok("an older snl-signin (no status action): says to deploy it again", (await t.txt("#siNotices")).includes("Deploy it again: supabase functions deploy snl-signin --no-verify-jwt."), await t.txt("#siNotices"));
  ok("the list still shows", (await t.txt("#siEmpty"))==="No sign-ins recorded yet.");
  await p.context().close();

  t=await open({seed:rows(3)}); p=t.p;
  await p.evaluate(()=>{ __mock.failSignins=true; }); await t.openCard();
  ok("a failed read says so plainly, with Try again", (await t.txt("#siErr")).startsWith("Couldn't load recent sign-ins. Check your connection and try again.") && await p.isVisible('[data-act="si-retry"]'));
  await p.evaluate(()=>{ __mock.failSignins=false; }); await p.click('[data-act="si-retry"]'); await p.waitForTimeout(300);
  ok("Try again loads the list", (await t.rowTexts()).length===3);
  await p.context().close();

  // ----- readers -----
  t=await open({role:"reader", seed:rows(3)}); p=t.p;
  await p.click("#whoDot"); await p.waitForTimeout(100);
  ok("reader: the account menu has no Recent sign-ins", !(await p.isVisible("#siMenu")) && await p.isVisible('#whoMenu [data-act="signout"]'));
  await p.evaluate(()=>siOpen()); await p.waitForTimeout(300);
  ok("reader: even asked directly, the page shows no card and asks for no status", !(await p.$("#siPanel")) && !t.calls.some(c=>c.fn==="snl-signin"));
  const seen=await p.evaluate(async()=>{ const {data}=await S.sb.from("snl_signins").select("email"); return data; });
  ok("reader: the table gives a reader no rows, as its policy says", Array.isArray(seen) && seen.length===0);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("reader, 390 wide: no sideways scroll", await t.noScroll());
  await p.context().close();

  // ----- the password site is unchanged -----
  t=await open({config:PW, seed:rows(3)}); p=t.p;
  await p.click("#whoDot"); await p.waitForTimeout(100);
  ok("password sign-in (GitHub Pages): no Recent sign-ins, even for Corp Dev", !(await p.isVisible("#siMenu")) && await p.isVisible('#whoMenu [data-act="change-pw"]'));
  await p.context().close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
