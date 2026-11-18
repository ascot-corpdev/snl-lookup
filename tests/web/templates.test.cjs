// The Profile view's three template levels: a login's own (users/<login id>/template.pptx), the team's (template.pptx,
// Corp Dev uploads it) and the standard one beside the page (web/standard-template.pptx). Which one a build uses with
// no choice made (own, then team, then standard), choosing another, the choice remembered in this browser for each
// login, falling back when the chosen one has gone (when the page looks, and at build time), uploading, replacing and
// removing one's own, storage refusing it (migration 0008 not run), browser storage that can't be used, the layout
// note from the checker, hostile text, and the 390px layout. deck.js and profile-slides.js are small stand-ins.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), ANSWER=FIX("profilepage_answer.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const PPTX="application/vnd.openxmlformats-officedocument.presentationml.presentation";
const FAKE_DECK=`window.__deck={inspect:[],build:[]};
window.SNLDeck={
  inspect:async b=>{ const head=new TextDecoder().decode(new Uint8Array(b).slice(0,40)); window.__deck.inspect.push(head);
    if(window.__inspectAnswer) return window.__inspectAnswer;
    return head.startsWith("PK") ? {ok:true, slides:3, widthIn:13.333, heightIn:7.5, layouts:{cover:{name:"Title White",named:true},content:{name:"Spectrum Title Only White",named:true}}, note:""} : {ok:false, message:"That file isn't a PowerPoint file."}; },
  build:async (b,spec)=>{ window.__deck.build.push(new TextDecoder().decode(new Uint8Array(b))); return new TextEncoder().encode("PPTX"); } };`;
const FAKE_SLIDES=`window.SNLProfile={ plan:()=>[{id:"cover",label:"Cover",included:true,reason:""}], spec:f=>({fileName:"sample-profile.pptx", slides:[{kind:"cover"}]}) };`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const SAMPLE=()=>({facts:{...copy(ANSWER.facts), sample:true, entity:{kind:"company", code:"99999", name:"Nonesuch Sample Insurance Co", groupName:null, naicGroupCode:null}}, text:copy(ANSWER.text)});
const TEAM={text:"PK team template", updated_at:"2026-11-05T09:30:00Z"}, MINE={text:"PK my own template", updated_at:"2026-11-10T14:00:00Z"};

(async()=>{
  const b=await chromium.launch(); const errs=[];
  // opts go to the Supabase stand-in; over: {width, choice (a stored choice for login u1), noStorage (browser storage throws), ctx (reuse a context)}
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=over.ctx||await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true});
    const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, loads:[]};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}");
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-profile" && body.action==="status") return J(200,{statutory:{configured:true, mapped:true, fields:[]}, claude:{configured:false}, filings:{configured:true}});
        if(fn==="snl-profile" && body.action==="sample") return J(200,SAMPLE());
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:false});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===JSZIP_URL) return r.fulfill({contentType:"application/javascript",body:'window.JSZip=function(){};'});
      if(u===BASE+"deck.js") return r.fulfill({contentType:"application/javascript",body:FAKE_DECK});
      if(u===BASE+"profile-slides.js") return r.fulfill({contentType:"application/javascript",body:FAKE_SLIDES});
      if(u===BASE+"standard-template.pptx"){ t.loads.push("standard"); return r.fulfill({contentType:PPTX,body:"PK standard template"}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(([o, choice, noStorage])=>{ window.__opts=o;
      if(noStorage){ const no=()=>{ throw new DOMException("The operation is insecure.","SecurityError"); }; Object.defineProperty(window,"localStorage",{configurable:true,get:no}); }
      else if(choice && !sessionStorage.getItem("seeded")){ sessionStorage.setItem("seeded","1"); localStorage.setItem("snl.pfTemplate.u1", choice); } },[opts, over.choice||"", !!over.noStorage]);
    await p.goto(BASE+"#profile"); await p.waitForTimeout(500);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.choices=async()=>p.$$eval('[data-act="pf-tpl-use"]',e=>e.map(x=>x.textContent+(x.getAttribute("aria-pressed")==="true"?"*":"")));
    t.build=async()=>{ const [d]=await Promise.all([p.waitForEvent("download",{timeout:5000}), p.click('[data-act="pf-sample"]')]); await p.waitForTimeout(150);
      return p.evaluate(()=>window.__deck.build[window.__deck.build.length-1]); };
    t.stored=async()=>p.evaluate(()=>localStorage.getItem("snl.pfTemplate.u1"));
    t.ops=async()=>p.evaluate(()=>__mock.storage.calls.map(c=>c.op+":"+(Array.isArray(c.path)?c.path.join(","):c.path)));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    return t;
  }

  // ----- the order with no choice made: own, then team, then standard -----
  let t=await open({role:"reader"}); let p=t.p;
  ok("nothing uploaded: Standard, the only choice", same(await t.choices(),["Standard*"]) && (await t.txt("#pfTplState")).startsWith("The standard template."));
  ok("its own folder is looked in, and no one else's", same(await t.ops(),["list:","list:users/u1"]));
  ok("nothing uploaded: built on the standard template", (await t.build())==="PK standard template" && t.loads.length===1);
  await t.ctx.close();
  t=await open({role:"reader", template:TEAM}); p=t.p;
  ok("a team template: Team is used, Standard can be chosen", same(await t.choices(),["Standard","Team*"]) && (await t.build())==="PK team template" && !t.loads.length);
  await t.ctx.close();
  t=await open({role:"reader", template:TEAM, mine:MINE}); p=t.p;
  ok("its own and a team template: its own is used, all three can be chosen", same(await t.choices(),["Standard","Team","Mine*"]) && (await t.txt("#pfTplState"))==="Your own template. Used only for your profiles; nobody else can see it. It was last changed 10 Nov at 14:00, under 0.1 MB.", await t.txt("#pfTplState"));
  ok("built on its own template, downloaded from its own folder", (await t.build())==="PK my own template" && (await t.ops()).includes("download:users/u1/template.pptx"));
  ok("a reader can remove or replace its own, not the team's", (await t.txt('[data-act="pf-tpl-pick-mine"]'))==="Replace my template" && !!(await p.$('[data-act="pf-tpl-remove"]')) && !(await p.$('[data-act="pf-tpl-pick"]')));
  ok("no choice is stored until one is made", (await t.stored())===null);

  // ----- choosing, and the choice remembered for this login in this browser -----
  await p.click('[data-act="pf-tpl-use"][data-k="standard"]'); await p.waitForTimeout(100);
  ok("choosing Standard: pressed, stored for this login, and the build button says so", same(await t.choices(),["Standard*","Team","Mine"]) && (await t.stored())==="standard" && (await t.txt("#pfTplState")).startsWith("The standard template.") && (await t.txt("#pfTplState")).endsWith("Choose another above to use it instead."));
  ok("built on the standard template", (await t.build())==="PK standard template");
  await p.click('[data-act="pf-tpl-use"][data-k="team"]'); await p.waitForTimeout(100);
  ok("choosing Team: built on the team's", (await t.stored())==="team" && (await t.build())==="PK team template");
  await p.click('[data-act="pf-tpl-use"][data-k="mine"]'); await p.waitForTimeout(100);
  ok("back to its own: kept in memory, not downloaded again", (await t.build())==="PK my own template" && (await t.ops()).filter(o=>o==="download:users/u1/template.pptx").length===1);
  await p.click('[data-act="pf-tpl-use"][data-k="team"]'); await p.waitForTimeout(100);
  await p.reload(); await p.waitForTimeout(500);
  ok("the choice outlasts a reload", same(await t.choices(),["Standard","Team*","Mine"]) && (await t.txt("#pfTplState")).startsWith("Your team's template."));
  ok("the choice is kept for each login", same(await p.evaluate(()=>{ const u=S.session.uid; S.session.uid="u9"; const r=[tplKey(), tplChoice()]; S.session.uid=u; return r; }),["snl.pfTemplate.u9",""]));
  await t.ctx.close();

  // ----- the chosen one has gone -----
  t=await open({role:"reader", template:TEAM}, {choice:"mine"}); p=t.p;
  ok("chose its own, which isn't there: the team's is used, and said so", same(await t.choices(),["Standard","Team*"]) && (await t.txt("#pfTplNote"))==="You chose your own template, but it isn't in storage any more, so the team template is used." && (await t.build())==="PK team template", await t.txt("#pfTplNote"));
  await t.ctx.close();
  t=await open({role:"reader", mine:MINE}, {choice:"team"}); p=t.p;
  ok("chose the team's, which isn't there: down the order to Standard, not up to its own", same(await t.choices(),["Standard*","Mine"]) && (await t.txt("#pfTplNote"))==="You chose the team template, but it isn't in storage any more, so the standard template is used." && (await t.build())==="PK standard template");
  await p.click('[data-act="pf-tpl-use"][data-k="mine"]'); await p.waitForTimeout(100);
  ok("choosing again clears the note", !(await p.$("#pfTplNote")) && same(await t.choices(),["Standard","Mine*"]));
  await t.ctx.close();
  t=await open({role:"reader", template:TEAM, mine:MINE}); p=t.p;
  await p.evaluate(()=>{ delete __mock.storage.buckets["snl-template"]["users/u1/template.pptx"]; });
  ok("its own removed elsewhere before building: built on the team's, and said so", (await t.build())==="PK team template" && (await t.txt("#pfTplNote"))==="Your template isn't in storage any more. This profile is built on the team template instead." && same(await t.choices(),["Standard","Team*"]) && !(await p.$("#pfBuildErr")), await t.txt("#pfTplNote"));
  await t.ctx.close();

  // ----- uploading, replacing and removing its own -----
  t=await open({role:"reader", template:TEAM}); p=t.p;
  await p.evaluate(()=>{ window.__inspectAnswer={ok:true, slides:12, widthIn:13.333, heightIn:7.5, layouts:{cover:{name:"Title Slide",named:false},content:{name:"Title Only",named:false}},
    note:'It has no layout named "Title White", so the cover uses "Title Slide". It has no layout named "Spectrum Title Only White", so the other slides use "Title Only".'}; });
  await p.setInputFiles("#pf_tplFileMine",{name:"Corporate.pptx", mimeType:PPTX, buffer:Buffer.from("PK corporate template")}); await p.waitForTimeout(400);
  const ups=await p.evaluate(()=>__mock.storage.uploads);
  ok("uploaded to its own folder, replacing any earlier one", same(ups.map(u=>[u.path,u.text,u.opts]),[["users/u1/template.pptx","PK corporate template",{upsert:true,contentType:PPTX,cacheControl:"60"}]]), ups);
  ok("says it worked, which layouts were picked, and that nobody else sees it", (await t.txt("#pfTplDone"))==='Your template uploaded: 12 slides, 13.33 x 7.5 in. It has no layout named "Title White", so the cover uses "Title Slide". It has no layout named "Spectrum Title Only White", so the other slides use "Title Only". Your profiles are built on it now. Nobody else can see it.', await t.txt("#pfTplDone"));
  ok("now chosen, and offered with Standard and Team", (await t.stored())==="mine" && same(await t.choices(),["Standard","Team","Mine*"]) && (await t.txt('[data-act="pf-tpl-pick-mine"]'))==="Replace my template");
  ok("built on it from memory, no download", (await t.build())==="PK corporate template" && !(await t.ops()).some(o=>o.startsWith("download")));
  await p.evaluate(()=>{ window.__inspectAnswer=null; });
  await p.setInputFiles("#pf_tplFileMine",{name:"v2.pptx", mimeType:PPTX, buffer:Buffer.from("PK second")}); await p.waitForTimeout(400);
  ok("replacing says so", (await t.txt("#pfTplDone"))==="Your template replaced: 3 slides, 13.33 x 7.5 in. Your profiles are built on it now. Nobody else can see it." && (await t.build())==="PK second");
  await p.click('[data-act="pf-tpl-use"][data-k="standard"]'); await p.waitForTimeout(100);
  await p.click('[data-act="pf-tpl-remove"]'); await p.waitForTimeout(100);
  ok("remove asks first, saying what is used instead", (await t.txt("#pfTplRemove"))==="Remove your template? Your profiles will be built on the team template instead. You can upload it again at any time. Yes, remove itKeep it" && !(await p.$('[data-act="pf-tpl-remove"]')), await t.txt("#pfTplRemove"));
  await p.click('[data-act="pf-tpl-remove-no"]'); await p.waitForTimeout(100);
  ok("Keep it: nothing removed", !(await p.$("#pfTplRemove")) && (await p.evaluate(()=>__mock.storage.removed.length))===0);
  await p.setViewportSize({width:390,height:844}); await p.click('[data-act="pf-tpl-remove"]'); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with three choices and the remove question", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/templates-remove-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.click('[data-act="pf-tpl-remove-yes"]'); await p.waitForTimeout(300);
  ok("removed from its own folder only", same(await p.evaluate(()=>__mock.storage.removed),["users/u1/template.pptx"]) && (await p.evaluate(()=>Object.keys(__mock.storage.buckets["snl-template"])))+""==="template.pptx");
  ok("says so, Mine is gone, and a choice of Standard stays", (await t.txt("#pfTplDone"))==="Your template is removed. Your profiles are built on the standard template now." && same(await t.choices(),["Standard*","Team"]) && (await t.stored())==="standard" && !(await p.$('[data-act="pf-tpl-remove"]')), await t.txt("#pfTplDone"));
  await p.screenshot({path:OUTDIR+"/templates-removed-1440.png",fullPage:true});
  await t.ctx.close();
  t=await open({role:"reader", template:TEAM, mine:MINE}, {choice:"mine"}); p=t.p;
  await p.click('[data-act="pf-tpl-remove"]'); await p.click('[data-act="pf-tpl-remove-yes"]'); await p.waitForTimeout(300);
  ok("removing the chosen one: the choice is cleared and the order applies", (await t.stored())===null && same(await t.choices(),["Standard","Team*"]) && (await t.txt("#pfTplDone")).endsWith("built on the team template now."));
  await t.ctx.close();

  // ----- storage refuses it: migration 0008 not run -----
  t=await open({role:"reader"}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.refuseMine=true; });
  await p.setInputFiles("#pf_tplFileMine",{name:"mine.pptx", mimeType:PPTX, buffer:Buffer.from("PK mine")}); await p.waitForTimeout(400);
  ok("reader, upload refused: ask Corp Dev about migration 0008", (await t.txt("#pfTplErr"))==="Storage refused your template. Ask Corp Dev to check that migration 0008_personal_templates.sql has been run." && same(await t.choices(),["Standard*"]) && (await t.stored())===null);
  await t.ctx.close();
  t=await open({mine:MINE}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.refuseMine=true; });
  await p.setInputFiles("#pf_tplFileMine",{name:"mine.pptx", mimeType:PPTX, buffer:Buffer.from("PK mine")}); await p.waitForTimeout(400);
  ok("Corp Dev, upload refused: run migration 0008", (await t.txt("#pfTplErr"))==="Storage refused your template. Check that migration 0008_personal_templates.sql has been run in Supabase (see the README).");
  await p.click('[data-act="pf-tpl-remove"]'); await p.click('[data-act="pf-tpl-remove-yes"]'); await p.waitForTimeout(400);
  ok("a remove storage quietly ignores is caught: still there, said plainly", (await t.txt("#pfTplErr"))==="Storage refused your template. Check that migration 0008_personal_templates.sql has been run in Supabase (see the README)." && same(await t.choices(),["Standard","Mine*"]));
  await p.evaluate(()=>{ __mock.storage.refuseMine=false; __mock.storage.netFail=true; });
  await p.click('[data-act="pf-tpl-remove"]'); await p.click('[data-act="pf-tpl-remove-yes"]'); await p.waitForTimeout(300);
  ok("remove with no connection: said plainly", (await t.txt("#pfTplErr"))==="Couldn't reach storage to remove your template. Check your connection and try again." && same(await t.choices(),["Standard","Mine*"]));
  await t.ctx.close();

  // ----- someone else's template is never listed or used -----
  t=await open({role:"reader", users:{reader2:{id:"u2", display_name:"Reader 2", role:"reader"}}}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.buckets["snl-template"]["users/u2/template.pptx"]={bytes:Array.from(new TextEncoder().encode("PK someone else")), updated_at:"2026-11-01T00:00:00Z"}; S.pf.tpl.checked=false; checkTemplate(); });
  await p.waitForTimeout(200);
  ok("another login's template: not offered, not used", same(await t.choices(),["Standard*"]) && (await t.build())==="PK standard template");
  await t.ctx.close();

  // ----- browser storage that can't be used -----
  t=await open({role:"reader", template:TEAM}, {noStorage:true}); p=t.p;
  ok("browser storage blocked: the page works and the order applies", same(await t.choices(),["Standard","Team*"]));
  await p.click('[data-act="pf-tpl-use"][data-k="standard"]'); await p.waitForTimeout(100);
  ok("browser storage blocked: a choice still holds for this page", same(await t.choices(),["Standard*","Team"]) && (await t.build())==="PK standard template");
  await t.ctx.close();

  // ----- hostile text from the checker -----
  const X='<img src=x onerror="window.__xss=1">';
  t=await open({role:"reader"}); p=t.p;
  await p.evaluate(x=>{ window.__inspectAnswer={ok:true, slides:1, widthIn:13.333, heightIn:7.5, note:"It has no layout named \"Title White\", so the cover uses \""+x+"\"."}; }, X);
  await p.setInputFiles("#pf_tplFileMine",{name:"x.pptx", mimeType:PPTX, buffer:Buffer.from("PK x")}); await p.waitForTimeout(400);
  ok("a hostile layout name stays text", (await t.txt("#pfTplDone")).includes(X) && !(await p.evaluate(()=>window.__xss)));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
