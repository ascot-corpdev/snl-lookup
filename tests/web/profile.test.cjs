// The Profile view: choosing a company or group, what the profile will hold (name, years, slides in or out, headline
// figures, figures not mapped), Claude's draft (on by default, its cost line, a draft that fell back, limit, busy and
// not set up), building and downloading the PowerPoint file, the template in storage (uploaded or not, Corp Dev
// uploading, checks before upload, storage errors), the sample profile, every "not ready" state, the session ending
// mid-way, hostile text, what Ask Claude is told, and the 1440px and 390px layouts. The zip library, deck.js and
// profile-slides.js are small stand-ins that record what they were called with; nothing touches the network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), RESOLVE=FIX("web_resolve.json"), ANSWER=FIX("profilepage_answer.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const PPTX="application/vnd.openxmlformats-officedocument.presentationml.presentation";
const FAKE_JSZIP='window.JSZip=function(){}; window.JSZip.version="3.10.1";';
// deck.js stand-in: inspect says ok for anything starting "PK"; build records the template it was given and the spec
const FAKE_DECK=`window.__deck={inspect:[],build:[]};
window.SNLDeck={
  inspect:async b=>{ const u=new Uint8Array(b); const head=new TextDecoder().decode(u.slice(0,40)); window.__deck.inspect.push({ab:b instanceof ArrayBuffer, head});
    if(window.__inspectAnswer) return window.__inspectAnswer;
    return head.startsWith("PK") ? {ok:true, slides:14, widthIn:13.333, heightIn:7.5} : {ok:false, message:"That file isn't a PowerPoint file. Choose a .pptx file."}; },
  build:async (b,spec)=>{ const u=new Uint8Array(b); window.__deck.build.push({ab:b instanceof ArrayBuffer, tpl:new TextDecoder().decode(u), spec:JSON.parse(JSON.stringify(spec))});
    if(window.__buildFail) throw new Error(window.__buildFail); return new TextEncoder().encode("PPTX for "+spec.fileName); } };`;
// profile-slides.js stand-in: a fixed plan, and a spec that names the file after the company
const FAKE_SLIDES=`window.__slides={plan:[],spec:[]};
window.SNLProfile={
  plan:f=>{ window.__slides.plan.push(f.entity&&f.entity.code); if(window.__planAnswer) return window.__planAnswer;
    return [{id:"cover",label:"Cover",included:true,reason:""},{id:"summary",label:"Executive summary",included:true,reason:""},{id:"premium",label:"Premium",included:true,reason:""},
      {id:"reserves",label:"Reserves",included:false,reason:"Net loss and LAE reserves aren't mapped"},{id:"reinsurance",label:"Reinsurance",included:false,reason:"Ceded premiums by reinsurer aren't mapped"}]; },
  spec:(f,t)=>{ window.__slides.spec.push({code:f.entity.code, sample:f.sample, by:t.by, title:t.summary.title});
    return {fileName:String(f.entity.name||"profile").replace(/[^A-Za-z]+/g,"-")+"-profile-2026-11-13.pptx", slides:[{layout:"Title White"}]}; } };`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

const FACTS=ANSWER.facts, TEXT=ANSWER.text;
const PSTATUS=(over={})=>({statutory:{configured:true, mapped:true, fields:[]}, claude:{configured:true}, filings:{configured:true}, ...over});
const CLAUDE_TEXT={...copy(TEXT), by:"claude", summary:{title:"A growing Florida homeowners writer", points:copy(TEXT.summary.points)}};
const DRAFT=()=>({facts:copy(FACTS), text:copy(CLAUDE_TEXT), usage:{inputTokens:18400, outputTokens:2100, costUsd:0.12}});
const SAMPLE=()=>({facts:{...copy(FACTS), sample:true, entity:{kind:"company", code:"99999", name:"Nonesuch Sample Insurance Co", groupName:null, naicGroupCode:null}}, text:copy(TEXT)});
const TPL={text:"PK made-up template", updated_at:"2026-11-05T09:30:00Z"};

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], loads:[], libFail:{}, delay:{}, asked:3,
      pstatus:()=>PSTATUS(), facts:()=>({status:200, body:{facts:copy(FACTS), text:copy(TEXT)}}), draft:()=>({status:200, body:DRAFT()}), sample:()=>({status:200, body:SAMPLE()}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-profile"){
          if(t.delay[body.action]) await new Promise(res=>setTimeout(res,t.delay[body.action]));
          const a = t.all ? t.all(body) : body.action==="status" ? {status:200, body:t.pstatus()} : body.action==="facts" ? t.facts(body) : body.action==="draft" ? t.draft(body) : body.action==="sample" ? t.sample(body) : {status:400, body:{error:"bad", message:"Unknown action."}};
          if(body.action==="draft" && a.status===200) t.asked++;
          return a.empty ? r.fulfill({status:a.status, body:""}).catch(()=>{}) : J(a.status, a.body); }
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:t.asked, dailyLimit:20, costToday:0.2*t.asked, resetsAt:"2026-11-14T00:00:00Z"});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-filings" && body.action==="resolve") return J(200,{...copy(RESOLVE), query:body.q});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===JSZIP_URL){ t.loads.push("jszip"); return t.libFail.jszip ? r.fulfill({status:404,body:""}) : r.fulfill({contentType:"application/javascript",body:FAKE_JSZIP}); }
      if(u===BASE+"deck.js"){ t.loads.push("deck"); return t.libFail.deck ? r.fulfill({status:404,body:""}) : r.fulfill({contentType:"application/javascript",body:FAKE_DECK}); }
      if(u===BASE+"profile-slides.js"){ t.loads.push("slides"); return r.fulfill({contentType:"application/javascript",body:FAKE_SLIDES}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    // every file handed to the browser to save: its type and size
    await p.addInitScript(o=>{ window.__opts=o; window.__blobs=[]; const c=URL.createObjectURL; URL.createObjectURL=x=>{ if(x instanceof Blob) window.__blobs.push({type:x.type, size:x.size}); return c.call(URL,x); }; },opts);
    await p.goto(BASE+(over.hash||"#profile")); await p.waitForTimeout(500);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=t.all||null;
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.fn==="snl-profile" && c.body.action===a);
    t.st=async()=>p.evaluate(()=>__mock.storage.calls.map(c=>c.op));
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download",{timeout:5000}), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    t.figures=async code=>{ await p.fill("#pf_code",code); await p.click("#pf_get"); await p.waitForTimeout(400); };
    t.deck=async()=>p.evaluate(()=>window.__deck||null);
    t.specs=async()=>p.evaluate(()=>window.__slides?window.__slides.spec:[]);
    t.xss=async()=>p.evaluate(()=>window.__xss);
    return t;
  }

  // ----- Corp Dev, everything set up, a template uploaded: the whole way through -----
  let t=await open({template:TPL}); let p=t.p;
  ok("a third view in the nav, and it is the one open", same(await t.list("nav.tabs a"),["Filings","Statutory","Profile"]) && (await p.getAttribute('nav.tabs a[data-view="profile"]',"aria-current"))==="page" && (await t.txt(".action-title"))==="Company profile as a PowerPoint file");
  ok("the status strip and the Ask Claude button stay over it", await p.isVisible("#s_usage") && await p.isVisible("#askFab"));
  ok("the profile function is asked for its status once", same(t.of("status").map(c=>c.body),[{action:"status"}]));
  ok("the template is looked for once, by listing, not downloaded yet", same(await p.evaluate(()=>__mock.storage.calls),[{op:"list",bucket:"snl-template",path:"",opts:{limit:100,search:"template.pptx"}}]));
  ok("says the template is uploaded, and when", (await t.txt("#pfTplState"))==="The template is uploaded. Last changed 5 Nov at 09:30, under 0.1 MB.", await t.txt("#pfTplState"));
  ok("Corp Dev can replace it", (await t.txt('[data-act="pf-tpl-pick"]'))==="Replace template" && !!(await p.$("#pf_tplFile")));
  ok("the sample is offered, and says its figures are made up", (await t.txt('[data-act="pf-sample"]'))==="Build a sample profile" && (await t.txt("#pfSampleNote")).includes("made-up figures"));
  ok("nothing about the profile before figures are asked for", !(await p.$("#pfContents")) && !(await p.$("#pf_buildBtn")) && t.loads.length===0);
  await p.click("#pf_get"); await p.waitForTimeout(150);
  ok("no code: says what to do, asks nothing", (await t.txt("#pfFormErr"))==="Choose a company: find it by name, or type its NAIC company code." && t.of("facts").length===0);
  await p.fill("#pf_find","Calloway"); await p.press("#pf_find","Enter"); await p.waitForTimeout(300);
  ok("find by name uses the same company list as the Statutory view", same(t.calls.filter(c=>c.body.action==="resolve").map(c=>[c.fn,c.body]),[["snl-filings",{action:"resolve",q:"Calloway"}]]));
  ok("only matches with a NAIC company code can be chosen", same(await t.list("#pf_matches li .t1"),["Calloway Insurance Co","Calloway Home Co"]) && !(await t.xss()));
  await p.click('#pf_matches li >> nth=0 >> [data-act="pf-choose"]'); await p.waitForTimeout(150);
  ok("choosing fills the code and names the choice", (await p.inputValue("#pf_code"))==="90001" && (await t.txt("#pf_chosen"))==="Chosen: Calloway Insurance Co NAIC company 90001" && !(await p.$("#pf_matches")));
  t.delay.facts=400;
  await p.click("#pf_get"); await p.waitForTimeout(150);
  ok("figures loading: says so, by name", (await t.txt("#pfBusy"))==="Getting the figures for Calloway Insurance Co… This can take a minute when they haven't been fetched before." && await p.isDisabled("#pf_get"));
  await p.waitForTimeout(550); t.delay.facts=0;
  ok("asks for the figures of one company", same(t.of("facts").map(c=>c.body),[{action:"facts",kind:"company",code:"90001"}]));
  ok("the company's name and the years covered", (await t.txt("#pfName"))==="Calloway Insurance Co" && (await t.txt("#pfMeta"))==="NAIC company 90001 · part of Calloway Group · figures for 2021 to 2025", await t.txt("#pfMeta"));
  ok("headline figures, latest year, in house style", same(await p.$$eval("#pfHead .pftile",e=>e.map(x=>[x.querySelector("span").textContent, x.querySelector("b").textContent])),[["Direct premiums written 2025","$123M"],["Combined ratio 2025","93.7%"],["Policyholder surplus 2025","$59M"]]));
  ok("the slide builder is loaded once, in order: zip library, deck.js, profile-slides.js", same(t.loads,["jszip","deck","slides"]), t.loads);
  ok("the slides, each included or left out with its reason", same(await t.list("#pfPlan li"),["CoverIncluded","Executive summaryIncluded","PremiumIncluded","ReservesLeft out: Net loss and LAE reserves aren't mapped","ReinsuranceLeft out: Ceded premiums by reinsurer aren't mapped"]) && same(await p.evaluate(()=>__slides.plan),["90001"]), await t.list("#pfPlan li"));
  ok("figures not mapped, in plain words, with a pointer to the field set-up", (await t.txt("#pfMissing")).startsWith("Some figures aren't available, so the slides that need them are left out.Net loss and LAE reserves (not mapped)Ceded premiums by reinsurer (not mapped) Map them in the field set-up on the Statutory view") && (await p.getAttribute("#pfMissing a","href"))==="#statutory", await t.txt("#pfMissing"));
  ok("Claude's draft is on by default, with what it counts as and costs", await p.isChecked("#pf_draft") && (await t.txt("#pfDraftCost"))==="Counts as one of today's questions to Claude. You've asked 3 of 20 questions today, about $0.60 in all. Today's answers have cost about $0.20 each on average.", await t.txt("#pfDraftCost"));
  ok("the build button says Claude drafts first", (await t.txt("#pf_buildBtn"))==="Draft with Claude and build" && !(await p.isDisabled("#pf_buildBtn")));
  ok("headings and buttons are in sentence case", (await p.$$eval("#view h2,#view h3,#view button,nav a",e=>e.map(x=>x.textContent.trim()).filter(s=>s && /\s[A-Z][a-z]+/.test(s.replace(/\b(S&P|NAIC|Claude|Corp Dev|PowerPoint|Calloway Insurance Co)\b/g,"x"))))).length===0);
  await p.screenshot({path:OUTDIR+"/profile-contents-1440.png",fullPage:true});
  const chatBefore=t.calls.filter(c=>c.fn==="snl-chat"&&c.body.action==="status").length;
  t.delay.draft=500;
  let dl=await t.download(async()=>{ await p.click("#pf_buildBtn"); await p.waitForTimeout(200);
    ok("drafting: says it can take up to two minutes", (await t.txt("#pfDrafting"))==="Claude is drafting the slide text… This can take up to two minutes. Keep this tab open." && await p.isDisabled("#pf_buildBtn") && await p.isDisabled("#pf_draft")); });
  t.delay.draft=0; await p.waitForTimeout(250);
  ok("the draft is asked for by kind and code only: no figures go from the page", same(t.of("draft").map(c=>c.body),[{action:"draft",kind:"company",code:"90001"}]));
  ok("the file downloads with the name the slides script gives it", dl.name==="Calloway-Insurance-Co-profile-2026-11-13.pptx" && dl.text==="PPTX for Calloway-Insurance-Co-profile-2026-11-13.pptx", dl);
  ok("as a PowerPoint file", same(await p.evaluate(()=>__blobs.map(x=>x.type)),[PPTX]));
  let deck=await t.deck();
  ok("the template is downloaded once and handed to the builder as bytes", same(await t.st(),["list","download"]) && deck.build.length===1 && deck.build[0].tpl==="PK made-up template" && deck.build[0].ab, deck.build);
  ok("the builder gets the spec from SNLProfile.spec(facts, Claude's text)", same(await t.specs(),[{code:"90001",sample:false,by:"claude",title:"A growing Florida homeowners writer"}]) && same(deck.build[0].spec,{fileName:"Calloway-Insurance-Co-profile-2026-11-13.pptx",slides:[{layout:"Title White"}]}));
  ok("built: says so, and that the file went nowhere", (await t.txt("#pfBuilt"))==="Your profile is ready. Calloway-Insurance-Co-profile-2026-11-13.pptx was saved to your downloads. It was made in this browser and isn't stored or sent anywhere.Download again", await t.txt("#pfBuilt"));
  ok("the draft's cost is shown and today's count is asked again", (await t.txt("#pfDrafted"))==="Claude has drafted the text for these figures. It cost about $0.12 (18,400 tokens read, 2,100 written)." && t.calls.filter(c=>c.fn==="snl-chat"&&c.body.action==="status").length===chatBefore+1 && (await t.txt("#pfDraftCost")).includes("4 of 20"), await t.txt("#pfDrafted"));
  dl=await t.download(()=>p.click('[data-act="pf-again"]'));
  ok("Download again: the same file, not built again", dl.name==="Calloway-Insurance-Co-profile-2026-11-13.pptx" && (await t.deck()).build.length===1);
  dl=await t.download(()=>p.click("#pf_buildBtn")); await p.waitForTimeout(150);
  ok("Build again: no second draft, no second template download", (await t.deck()).build.length===2 && t.of("draft").length===1 && same(await t.st(),["list","download"]) && (await t.specs())[1].by==="claude");
  await p.click("#pf_draft"); await p.waitForTimeout(100);
  dl=await t.download(()=>p.click("#pf_buildBtn")); await p.waitForTimeout(150);
  ok("draft switched off: the plain text is used", (await t.specs())[2].by==="plain" && t.of("draft").length===1);
  ok("nothing about the profile is sent anywhere but the four profile calls", same(t.calls.filter(c=>c.fn==="snl-profile").map(c=>c.body.action),["status","facts","draft"]) && (await p.evaluate(()=>__mock.storage.uploads.length))===0);
  // Ask Claude is told about the figures on screen, as the Statutory view tells it
  await p.click("#askFab"); await p.waitForTimeout(200);
  ok("Ask Claude is told what is on screen", same(await p.evaluate(()=>askScreen()),{view:"statutory",query:{kind:"company",codes:["90001"],fromYear:2021,toYear:2025},companies:["Calloway Insurance Co"]}) && (await t.txt("#askTold"))==="Claude will be told what is on screen: statutory figures for NAIC 90001, 2021 to 2025.", await t.txt("#askTold"));
  ok("with starting questions about one company", (await t.list("#askSuggest .chip"))[0]==="What stands out in this company's results over these years?");
  await p.click('#askSuggest .chip >> nth=0'); await p.waitForTimeout(100);
  ok("a starting question fills the box", (await p.inputValue("#ask_input"))==="What stands out in this company's results over these years?");
  await p.click("#askClose"); await p.waitForTimeout(100);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: no sideways scroll with the profile built", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/profile-built-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(150);
  await p.screenshot({path:OUTDIR+"/profile-built-1440.png",fullPage:true});
  await p.evaluate(()=>signOut()); await p.waitForTimeout(250);
  ok("signing out drops the template and the built file", await p.evaluate(()=>S.pf.tpl.bytes===null && S.pf.built===null && S.pf.res===null));
  await t.ctx.close();

  // ----- a group, and codes typed by hand -----
  t=await open({template:TPL}, {facts:body=>({status:200, body:{facts:{...copy(FACTS), entity:{kind:body.kind, code:body.code, name:body.kind==="group"?"Calloway Group":null, groupName:null, naicGroupCode:null}}, text:copy(TEXT)}})}); p=t.p;
  await p.click('[data-act="pf-kind"][data-k="group"]'); await p.waitForTimeout(100);
  await p.fill("#pf_find","Calloway"); await p.click('[data-act="pf-find"]'); await p.waitForTimeout(300);
  ok("by group: the matches gathered into their groups", same(await t.list("#pf_matches li"),["Calloway GroupNAIC group 9001 · 2 matching companiesChoose"]), await t.list("#pf_matches li"));
  await p.click('#pf_matches [data-act="pf-choose"]'); await p.waitForTimeout(100);
  ok("choosing a group fills its code", (await p.inputValue("#pf_code"))==="9001" && (await t.txt("#pf_chosen"))==="Chosen: Calloway Group NAIC group 9001");
  await p.focus("#pf_code"); await p.press("#pf_code","End"); await p.keyboard.type("9"); await p.waitForTimeout(100);
  ok("changing the code by hand drops the name", (await t.txt("#pf_chosen"))==="Chosen: NAIC group 90019", await t.txt("#pf_chosen"));
  await p.fill("#pf_code","12a"); await p.click("#pf_get"); await p.waitForTimeout(150);
  ok("a code that isn't one: says so, asks nothing", (await t.txt("#pfFormErr"))==="NAIC codes are numbers of up to 6 digits, like 90001." && t.of("facts").length===0);
  await p.fill("#pf_code","9001"); await p.press("#pf_code","Enter"); await p.waitForTimeout(400);
  ok("one group per profile", same(t.of("facts").map(c=>c.body),[{action:"facts",kind:"group",code:"9001"}]) && (await t.txt("#pfName"))==="Calloway Group" && (await t.txt("#pfMeta")).startsWith("NAIC group 9001 ·"));
  await p.click('[data-act="pf-kind"][data-k="company"]'); await p.fill("#pf_code","90001"); await p.click("#pf_get"); await p.waitForTimeout(400);
  ok("no name from S&P or the finder: the code stands in", (await t.txt("#pfName"))==="NAIC company 90001");
  await t.ctx.close();

  // ----- Claude's draft fell back to plain text -----
  t=await open({template:TPL}, {draft:()=>({status:200, body:{facts:copy(FACTS), text:{...copy(TEXT), note:"Claude didn't finish in time, so the slides use plain text."}, usage:{inputTokens:9000, outputTokens:0, costUsd:0.03}}})}); p=t.p;
  await t.figures("90001");
  dl=await t.download(()=>p.click("#pf_buildBtn")); await p.waitForTimeout(150);
  ok("draft fell back: the note, and the build carries on with the plain text", (await t.txt("#pfNote"))==="The slides use plain text. Claude didn't finish in time, so the slides use plain text." && (await t.specs())[0].by==="plain" && dl.name.endsWith(".pptx") && !!(await p.$("#pfBuilt")) && !(await p.$("#pfDrafted")));
  await t.ctx.close();

  // ----- Claude's draft refused: limit, busy, not set up; each still builds with plain text -----
  for(const [code, status, msg, again] of [["limit",429,"You've reached today's limit of questions to Claude, so it can't draft the text now. Build with plain text instead, or try again tomorrow.",false],
    ["busy",503,"Claude is busy with other work just now. Build with plain text, or try the draft again in a few minutes.",true],
    ["not_configured",503,"Claude isn't set up, so it can't draft the text. Build with plain text instead.",false]]){
    t=await open({template:TPL}, {draft:()=>({status, body:{error:code, message:"Server words for "+code}})}); p=t.p;
    await t.figures("90001");
    await p.click("#pf_buildBtn"); await p.waitForTimeout(400);
    ok(`draft ${code}: a plain message, nothing built yet`, (await t.txt("#pfDraftErr span"))===msg && (await p.getAttribute("#pfDraftErr","role"))==="status" && !(await t.deck()).build.length, await t.txt("#pfDraftErr"));
    ok(`draft ${code}: ${again?"can try the draft again":"no point trying the draft again"}`, !!(await p.$('#pfDraftErr [data-act="pf-build"]'))===again);
    dl=await t.download(()=>p.click('[data-act="pf-build-plain"]')); await p.waitForTimeout(150);
    ok(`draft ${code}: Build with plain text works`, (await t.specs())[0].by==="plain" && t.of("draft").length===1 && !(await p.isChecked("#pf_draft").catch(()=>false)) && !!(await p.$("#pfBuilt")));
    await t.ctx.close();
  }

  // ----- a reader, no template yet -----
  t=await open({role:"reader"}); p=t.p;
  ok("reader, no template: ask Corp Dev", (await t.txt("#pfTplState"))==="No template yet. Ask Corp Dev to upload the template. Until then you can get the figures, but not build the file." && !(await p.$("#pf_tplFile")) && !(await p.$('[data-act="pf-tpl-pick"]')));
  await t.figures("90001");
  ok("reader, no template: the figures still come", (await t.txt("#pfName"))==="Calloway Insurance Co" && (await p.$$("#pfPlan li")).length===5);
  ok("reader, no template: building is off, and says why", await p.isDisabled("#pf_buildBtn") && (await t.txt("#pfNoTplNote"))==="The file can be built once Corp Dev uploads the template.");
  ok("reader: the missing figures point to Corp Dev", (await t.txt("#pfMissing")).endsWith("Ask Corp Dev to map them in the statutory field set-up.") && !(await p.$("#pfMissing a")));
  await p.evaluate(()=>pfBuild(false)); await p.waitForTimeout(150);
  ok("reader, no template: nothing is downloaded or built", same(await t.st(),["list"]) && !(await t.deck()).build.length);
  await p.screenshot({path:OUTDIR+"/profile-reader-notemplate-1440.png",fullPage:true});
  await t.ctx.close();

  // ----- Corp Dev uploads the template -----
  t=await open({}); p=t.p;
  ok("Corp Dev, no template: invited to upload one", (await t.txt("#pfTplState"))==="No template yet. Upload your team's PowerPoint template (.pptx, up to 50 MB). Profiles can be built once it is here." && (await t.txt('[data-act="pf-tpl-pick"]'))==="Upload template");
  await p.setInputFiles("#pf_tplFile",{name:"template.potx", mimeType:"application/octet-stream", buffer:Buffer.from("PK potx")}); await p.waitForTimeout(250);
  ok("a file that isn't .pptx is refused before anything loads", (await t.txt("#pfTplErr"))==="Choose a PowerPoint file whose name ends in .pptx." && t.loads.length===0 && (await p.evaluate(()=>__mock.storage.uploads.length))===0);
  await p.evaluate(()=>uploadTemplate({name:"big.pptx", size:TPL_MAX+1, arrayBuffer:async()=>new ArrayBuffer(4)})); await p.waitForTimeout(150);
  ok("a file over 50 MB is refused plainly", (await t.txt("#pfTplErr"))==="That file is 50.0 MB. The template can be at most 50 MB." && (await p.evaluate(()=>__mock.storage.uploads.length))===0, await t.txt("#pfTplErr"));
  await p.setInputFiles("#pf_tplFile",{name:"notes.pptx", mimeType:PPTX, buffer:Buffer.from("NOT A ZIP")}); await p.waitForTimeout(400);
  ok("checked in the browser first: refused with the checker's own message", (await t.txt("#pfTplErr"))==="That file isn't a PowerPoint file. Choose a .pptx file." && same((await t.deck()).inspect,[{ab:true, head:"NOT A ZIP"}]) && (await p.evaluate(()=>__mock.storage.uploads.length))===0);
  ok("the checker loaded the zip library and deck.js in order", same(t.loads.slice(0,2),["jszip","deck"]));
  await p.evaluate(()=>{ __mock.storage.delay=300; });
  await p.setInputFiles("#pf_tplFile",{name:"Team template.pptx", mimeType:PPTX, buffer:Buffer.from("PK new team template")}); await p.waitForTimeout(150);
  ok("uploading: says so", (await t.txt('[data-act="pf-tpl-pick"]'))==="Uploading…" && await p.isDisabled('[data-act="pf-tpl-pick"]'));
  await p.waitForTimeout(450); await p.evaluate(()=>{ __mock.storage.delay=0; });
  const ups=await p.evaluate(()=>__mock.storage.uploads);
  ok("uploaded to the private bucket, replacing any earlier one", same(ups.map(u=>({...u, size:undefined})),[{bucket:"snl-template",path:"template.pptx",type:PPTX,opts:{upsert:true,contentType:PPTX,cacheControl:"60"},text:"PK new team template"}]), ups);
  ok("says it worked, and what the checker found", (await t.txt("#pfTplDone"))==="Template uploaded: 14 slides, 13.33 x 7.5 in. Every profile from now on is built on it." && (await t.txt("#pfTplState")).startsWith("The template is uploaded. Last changed 13 Nov at 12:00") && (await t.txt('[data-act="pf-tpl-pick"]'))==="Replace template" && !(await p.$("#pfTplErr")), await t.txt("#pfTplDone"));
  await t.figures("90001"); await p.click("#pf_draft"); await p.waitForTimeout(100);
  ok("draft off: the button just builds", (await t.txt("#pf_buildBtn"))==="Build the PowerPoint file");
  dl=await t.download(()=>p.click("#pf_buildBtn")); await p.waitForTimeout(150);
  ok("the uploaded template is used from memory, not downloaded again", (await t.deck()).build[0].tpl==="PK new team template" && !(await t.st()).includes("download") && t.of("draft").length===0);
  await p.setInputFiles("#pf_tplFile",{name:"v2.pptx", mimeType:PPTX, buffer:Buffer.from("PK second")}); await p.waitForTimeout(400);
  ok("replacing says so", (await t.txt("#pfTplDone")).startsWith("Template replaced: 14 slides"));
  await p.evaluate(()=>{ __mock.storage.refuse=true; });
  await p.setInputFiles("#pf_tplFile",{name:"v3.pptx", mimeType:PPTX, buffer:Buffer.from("PK third")}); await p.waitForTimeout(400);
  ok("upload refused by the storage rules: said plainly", (await t.txt("#pfTplErr"))==="Only Corp Dev logins can upload the template. If this is a Corp Dev login, check that migration 0004_profile_template.sql has been run (see the README).");
  await p.evaluate(()=>{ __mock.storage.refuse=false; __mock.storage.netFail=true; });
  await p.setInputFiles("#pf_tplFile",{name:"v3.pptx", mimeType:PPTX, buffer:Buffer.from("PK third")}); await p.waitForTimeout(400);
  ok("upload with no connection: said plainly", (await t.txt("#pfTplErr"))==="Couldn't reach storage to upload the template. Check your connection and try again.");
  await p.evaluate(()=>{ __mock.storage.netFail=false; __mock.storage.noBucket=true; });
  await p.setInputFiles("#pf_tplFile",{name:"v3.pptx", mimeType:PPTX, buffer:Buffer.from("PK third")}); await p.waitForTimeout(400);
  ok("upload with no bucket: run the migration", (await t.txt("#pfTplErr"))==="The place the template is kept isn't set up yet. Run migration 0004_profile_template.sql in Supabase (see the README), then try again.");
  ok("only the two good files were ever stored", (await p.evaluate(()=>__mock.storage.uploads.map(u=>u.text)))+""===["PK new team template","PK second"]+"");
  await p.screenshot({path:OUTDIR+"/profile-upload-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with upload messages", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/profile-upload-390.png",fullPage:true});
  await t.ctx.close();

  // ----- storage not set up, or out of reach -----
  t=await open({noBucket:true}); p=t.p;
  ok("no bucket: Corp Dev is told to run the migration", (await t.txt("#pfTplState"))==="The place the template is kept isn't set up yet. Run migration 0004_profile_template.sql in Supabase (see the README), then try again.Check again" && (await p.getAttribute("#pfTplState","role"))==="status" && !(await p.$("#pf_tplFile")));
  await p.evaluate(()=>{ __mock.storage.noBucket=false; }); await p.click('#pfTplState [data-act="pf-tpl-retry"]'); await p.waitForTimeout(250);
  ok("Check again after the migration: the upload is offered", (await t.txt("#pfTplState")).startsWith("No template yet.") && !!(await p.$("#pf_tplFile")));
  await t.ctx.close();
  t=await open({role:"reader", noBucket:true}); p=t.p;
  ok("no bucket, reader: ask Corp Dev", (await t.txt("#pfTplState span"))==="The place the template is kept isn't set up yet. Ask Corp Dev to finish the set-up.");
  await t.ctx.close();
  t=await open({template:TPL}, {hash:"#filings"}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.netFail=true; }); await p.click('nav.tabs a[data-view="profile"]'); await p.waitForTimeout(300);
  ok("storage out of reach: a problem, with Try again", (await t.txt("#pfTplState span"))==="Couldn't reach storage to get the template. Check your connection and try again." && (await p.getAttribute("#pfTplState","role"))==="alert");
  await p.evaluate(()=>{ __mock.storage.netFail=false; }); await p.click('#pfTplState [data-act="pf-tpl-retry"]'); await p.waitForTimeout(250);
  ok("…and Try again finds it", (await t.txt("#pfTplState")).startsWith("The template is uploaded."));
  await t.figures("90001"); await p.click("#pf_draft");
  await p.evaluate(()=>{ __mock.storage.netFail=true; }); await p.click("#pf_buildBtn"); await p.waitForTimeout(300);
  ok("template download fails at build: said plainly, with Try again", (await t.txt("#pfBuildErr"))==="Couldn't reach storage to get the template. Check your connection and try again.Try again" && !(await t.deck()).build.length);
  await p.evaluate(()=>{ __mock.storage.netFail=false; });
  dl=await t.download(()=>p.click('#pfBuildErr [data-act="pf-build"]'));
  ok("…and Try again builds it", dl.name.endsWith(".pptx") && !(await p.$("#pfBuildErr")));
  await t.ctx.close();
  // the template was deleted since the page looked: building says there is none
  t=await open({template:TPL}); p=t.p;
  await t.figures("90001"); await p.click("#pf_draft");
  await p.evaluate(()=>{ delete __mock.storage.buckets["snl-template"]["template.pptx"]; }); await p.click("#pf_buildBtn"); await p.waitForTimeout(300);
  ok("template gone by the time of building: says so, and the block follows", (await t.txt("#pfBuildErr"))==="There is no template yet. Upload your PowerPoint template first." && (await t.txt("#pfTplState")).startsWith("No template yet.") && await p.isDisabled("#pf_buildBtn"));
  await t.ctx.close();

  // ----- the slide builder: fails to load, rejects the build -----
  t=await open({template:TPL}); p=t.p; t.libFail.jszip=true;
  await t.figures("90001");
  ok("the zip library doesn't load: the slide list says so, with Try again", (await t.txt("#pfLibsErr"))==="Couldn't load the slide builder. Check your connection and try again.Try again" && !(await p.$("#pfPlan")));
  t.libFail.jszip=false; await p.click('[data-act="pf-libs-retry"]'); await p.waitForTimeout(400);
  ok("…Try again loads it and shows the slides", (await p.$$("#pfPlan li")).length===5 && same(t.loads,["jszip","jszip","deck","slides"]), t.loads);
  await p.click("#pf_draft"); await p.evaluate(()=>{ window.__buildFail='The template has no layout named "Title White". Upload the team template.'; });
  await p.click("#pf_buildBtn"); await p.waitForTimeout(300);
  ok("a rejected build: the builder's own words, and a way to try again", (await t.txt("#pfBuildErr"))==='Couldn\'t build the PowerPoint file. The template has no layout named "Title White". Upload the team template.Try again' && !(await p.$("#pfBuilt")) && (await p.evaluate(()=>__blobs.length))===0);
  await p.evaluate(()=>{ window.__buildFail=""; });
  dl=await t.download(()=>p.click('#pfBuildErr [data-act="pf-build"]'));
  ok("…and builds on the second try", dl.name.endsWith(".pptx"));
  await t.ctx.close();
  t=await open({template:TPL}); p=t.p;
  await t.figures("90001"); await p.click("#pf_draft");
  await p.evaluate(()=>{ delete window.SNLDeck; delete window.SNLProfile; delete window.JSZip; }); t.libFail.deck=true;
  await p.click("#pf_buildBtn"); await p.waitForTimeout(400);
  ok("the scripts don't load at build time: said plainly", (await t.txt("#pfBuildErr"))==="Couldn't load the slide builder. Check your connection and try again.Try again");
  await t.ctx.close();

  // ----- statutory data not set up: only the sample -----
  t=await open({template:TPL}, {pstatus:()=>PSTATUS({statutory:{configured:false, mapped:false, fields:[]}})}); p=t.p;
  ok("statutory not set up: calm, and points to the sample", (await t.txt("#pfOff"))==="Statutory data isn't set up yet, so profiles of real companies can't be built. It needs a Snowflake reader account from S&P. Until then, build a sample profile below to check how your template comes out." && (await p.getAttribute("#pfOff","role"))==="status" && !(await p.$("#pfForm")));
  await p.screenshot({path:OUTDIR+"/profile-off-1440.png",fullPage:true});
  dl=await t.download(()=>p.click('[data-act="pf-sample"]')); await p.waitForTimeout(200);
  ok("the sample is asked for and built in one click", same(t.of("sample").map(c=>c.body),[{action:"sample"}]) && dl.name==="Nonesuch-Sample-Insurance-Co-profile-2026-11-13.pptx" && same(await t.specs(),[{code:"99999",sample:true,by:"plain",title:"Executive summary"}]));
  ok("the sample says its figures are made up", (await t.txt("#pfSample"))==="This is a sample profile. The company and every figure in it are made up, so you can check how your template comes out.");
  ok("the sample: no Claude draft, and nothing told to Claude", (await t.txt("#pfDraftNote"))==="The sample uses plain text written from its figures." && !(await p.$("#pf_draft")) && t.of("draft").length===0 && (await p.evaluate(()=>askScreen()))===null);
  ok("the sample is built and can be downloaded again", (await t.txt("#pfBuilt")).startsWith("Your profile is ready. Nonesuch-Sample-Insurance-Co-profile-2026-11-13.pptx"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the sample", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/profile-sample-390.png",fullPage:true});
  await t.ctx.close();
  // the sample with no template: shown, not built
  t=await open({}, {pstatus:()=>PSTATUS({statutory:{configured:false, mapped:false, fields:[]}})}); p=t.p;
  await p.click('[data-act="pf-sample"]'); await p.waitForTimeout(400);
  ok("the sample with no template: shows what it holds, can't build yet", (await t.txt("#pfName"))==="Nonesuch Sample Insurance Co" && await p.isDisabled("#pf_buildBtn") && (await t.txt("#pfNoTplNote"))==="Upload your PowerPoint template below to build the file." && (await p.evaluate(()=>__blobs.length))===0);
  await t.ctx.close();

  // ----- set up but not mapped -----
  t=await open({template:TPL}, {pstatus:()=>PSTATUS({statutory:{configured:true, mapped:false, fields:[]}})}); p=t.p;
  ok("not mapped, Corp Dev: points to the field set-up", (await t.txt("#pfOff"))==="Snowflake is connected, but the statutory fields aren't mapped yet, so profiles can't be built. Map them in the field set-up on the Statutory view. You can build a sample profile below meanwhile." && (await p.getAttribute("#pfOff a","href"))==="#statutory" && !(await p.$("#pfForm")));
  await t.ctx.close();
  t=await open({role:"reader", template:TPL}, {pstatus:()=>PSTATUS({statutory:{configured:true, mapped:false, fields:[]}})}); p=t.p;
  ok("not mapped, reader: ask Corp Dev", (await t.txt("#pfOff"))==="Snowflake is connected, but the statutory fields aren't mapped yet, so profiles can't be built. Ask Corp Dev to finish the set-up. You can build a sample profile below meanwhile." && !(await p.$("#pfOff a")));
  await t.ctx.close();

  // ----- the profile function isn't deployed -----
  t=await open({template:TPL}, {all:()=>({status:404, empty:true})}); p=t.p;
  ok("not deployed, Corp Dev: the deploy command", (await t.txt("#pfOff"))==="The profile function isn't deployed yet. Run: supabase functions deploy snl-profile --no-verify-jwt (see the README)." && (await p.getAttribute("#pfOff","role"))==="status");
  ok("not deployed: no sample to build, the template block still works", await p.isDisabled('[data-act="pf-sample"]') && (await t.txt("#pfTplState")).startsWith("The template is uploaded."));
  await t.ctx.close();
  t=await open({role:"reader"}, {all:()=>({status:404, empty:true})}); p=t.p;
  ok("not deployed, reader: ask Corp Dev", (await t.txt("#pfOff"))==="This part of the site isn't set up yet. Ask Corp Dev.");
  await t.ctx.close();
  t=await open({template:TPL}, {pstatus:()=>{ throw 0; }, all:b=>b.action==="status"?{status:500, body:{error:"internal", message:"The profile function failed. Try again in a minute."}}:{status:200,body:{}}}); p=t.p;
  ok("status fails: a problem with Try again", (await t.txt("#pfOff"))==="Couldn't check whether profiles are set up. The profile function failed. Try again in a minute.Try again");
  await t.ctx.close();

  // ----- the figures: failed, not mapped after all, nothing for that code -----
  let factsAns={status:502, body:{error:"upstream", message:"Snowflake didn't answer. Try again in a minute."}};
  t=await open({template:TPL}, {facts:()=>factsAns}); p=t.p;
  await t.figures("90001");
  ok("figures failed: a problem with Try again", (await t.txt("#pfErr"))==="Couldn't get the figures. Snowflake didn't answer. Try again in a minute.Try again" && (await p.getAttribute("#pfErr .banner","role"))==="alert");
  factsAns={status:200, body:{facts:copy(FACTS), text:copy(TEXT)}};
  await p.click('#pfErr [data-act="pf-facts"]'); await p.waitForTimeout(400);
  ok("…Try again gets them", (await t.txt("#pfName"))==="Calloway Insurance Co" && !(await p.$("#pfErr")));
  factsAns={status:409, body:{error:"not_mapped", message:"The statutory fields aren't mapped yet. A Corp Dev login can do this once on the Statutory view."}};
  const stBefore=t.of("status").length;
  await t.figures("90001");
  ok("not mapped after all: calm, and the status is asked again", (await t.txt("#pfErr"))==="The statutory fields aren't mapped yet. A Corp Dev login can do this once on the Statutory view." && (await p.getAttribute("#pfErr","role"))==="status" && t.of("status").length===stBefore+1);
  await t.ctx.close();
  t=await open({template:TPL}, {facts:body=>({status:200, body:{facts:{...copy(FACTS), entity:{kind:"company", code:body.code, name:null, groupName:null, naicGroupCode:null}, years:[], series:{}, derived:undefined, mix:undefined}, text:copy(TEXT)}})}); p=t.p;
  await t.figures("90107");
  ok("nothing for that code: S&P returned nothing, never 'doesn't exist'", (await t.txt("#pfNoData"))==="S&P returned nothing for this code. No statutory figures came back for NAIC company 90107 in the years asked for. Check the code, or try its NAIC group code." && !/exist/i.test(await t.txt("#pfOut")) && !(await p.$("#pf_buildBtn")) && t.loads.length===0, await t.txt("#pfNoData"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with nothing for that code", await t.noScroll());
  await t.ctx.close();

  // ----- the session ends mid-way -----
  t=await open({template:TPL}, {draft:()=>({status:401, body:{message:"Your session has ended. Sign in again."}})}); p=t.p;
  await t.figures("90001");
  await p.click("#pf_buildBtn"); await p.waitForTimeout(500);
  ok("session ended while drafting: back to sign-in with the message, nothing built", (await t.txt(".login .err"))==="Your session has ended. Sign in again." && !(await t.deck()).build.length && (await p.evaluate(()=>__blobs.length))===0 && await p.evaluate(()=>S.pf.res===null && S.pf.tpl.bytes===null));
  await t.ctx.close();
  t=await open({template:TPL}); p=t.p;
  await t.figures("90001"); await p.click("#pf_draft");
  await p.evaluate(()=>{ __mock.storage.delay=400; }); await p.click("#pf_buildBtn"); await p.waitForTimeout(100);
  ok("building: says so", (await t.txt("#pfBuilding"))==="Building the PowerPoint file… This takes a few seconds, a little longer the first time." && await p.isDisabled("#pf_buildBtn"));
  await p.evaluate(()=>{ __mock.fire("SIGNED_OUT"); }); await p.waitForTimeout(600);
  ok("signed out elsewhere while building: no file appears afterwards", (await t.txt(".login .err"))==="You were signed out. Sign in again." && (await p.evaluate(()=>__blobs.length))===0 && !(await t.deck()).build.length);
  await t.ctx.close();

  // ----- hostile text from the function, the slide builder and the user -----
  const X='<img src=x onerror="window.__xss=1">';
  t=await open({template:TPL}, {facts:()=>({status:200, body:{facts:{...copy(FACTS), entity:{...FACTS.entity, name:"Calloway "+X, groupName:X}, source:X, missing:[{field:"x", label:X, reason:X}]}, text:copy(TEXT)}}),
    draft:()=>({status:200, body:{facts:copy(FACTS), text:{...copy(TEXT), note:X}, usage:{}}})}); p=t.p;
  await p.evaluate(x=>{ window.__planAnswer=[{id:"cover",label:x,included:true,reason:""},{id:"r",label:"R",included:false,reason:x}]; }, X);
  await p.fill("#pf_find",X); await p.press("#pf_find","Enter"); await p.waitForTimeout(300);
  await t.figures("90001");
  ok("hostile name, group, source, missing label and slide reason stay text", (await t.txt("#pfName"))==="Calloway "+X && (await t.txt("#pfMissing")).includes(X) && (await t.txt("#pfPlan")).includes("Left out: "+X) && !(await t.xss()));
  dl=await t.download(()=>p.click("#pf_buildBtn")); await p.waitForTimeout(150);
  ok("a hostile draft note stays text", (await t.txt("#pfNote"))==="The slides use plain text. "+X && !(await t.xss()));
  await p.evaluate(x=>{ window.__inspectAnswer={ok:false, message:x}; }, X);
  await p.setInputFiles("#pf_tplFile",{name:"x.pptx", mimeType:PPTX, buffer:Buffer.from("PK")}); await p.waitForTimeout(300);
  ok("a hostile checker message stays text", (await t.txt("#pfTplErr"))===X && !(await t.xss()));
  ok("a hostile file name from the slide script can't reach a path", await p.evaluate(()=>pfFileName({fileName:"../a/b:c.pptx"}))==="..-a-b-c.pptx" && await p.evaluate(()=>pfFileName({}))==="profile-2026-11-13.pptx");
  await t.ctx.close();

  // ----- Claude not set up, and today's limit reached -----
  t=await open({template:TPL}, {pstatus:()=>PSTATUS({claude:{configured:false}})}); p=t.p;
  await t.figures("90001");
  ok("Claude not set up: no draft choice, plain text", (await t.txt("#pfDraftNote"))==="Claude isn't set up, so the slides use plain titles and points written from the figures." && !(await p.$("#pf_draft")) && (await t.txt("#pf_buildBtn"))==="Build the PowerPoint file");
  await t.ctx.close();
  t=await open({template:TPL}, {asked:20}); p=t.p;
  await t.figures("90001"); await p.waitForTimeout(200);
  ok("today's limit reached: says so, and builds with plain text", (await t.txt("#pfDraftNote"))==="You've reached today's limit of 20 questions, so the slides use plain titles and points written from the figures. Questions come back at midnight UTC." && (await t.txt("#pf_buildBtn"))==="Build the PowerPoint file", await t.txt("#pfDraftNote"));
  await p.screenshot({path:OUTDIR+"/profile-limit-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the figures shown", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/profile-contents-390.png",fullPage:true});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
