// Templates anyone can override: which template a profile deck is built on (a file just this once, your own, the
// standard one Corp Dev uploads, or the built-in plain template that ships with the site), in the template block of
// the Profile view. Covers the built-in file itself (usable by the real SNLDeck.inspect, clean properties, nothing in
// it but the two layouts), every level and what each login sees, uploads checked first and refused plainly,
// removing your own and the standard one (asked once), migration 0008 not run, the built-in file failing to load,
// storage refusing or out of reach, two logins never seeing each other's template, the session ending mid-way,
// hostile file names, the "ready" message naming the template, both kinds of profile, and 1440px and 390px.
// The zip library, deck.js and profile-slides.js are small stand-ins except where the real deck.js is named.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path"); const JSZip=require("jszip");
const ROOT=path.join(__dirname,"../.."), WEB=path.join(ROOT,"web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), ANSWER=FIX("profilepage_answer.json");
const BUILTIN=fs.readFileSync(path.join(WEB,"template-builtin.pptx"));
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const PPTX="application/vnd.openxmlformats-officedocument.presentationml.presentation";
const FAKE_JSZIP='window.JSZip=function(){}; window.JSZip.version="3.10.1";';
// deck.js stand-in: inspect says ok for anything starting "PK"; build records the first bytes of the template it got
const FAKE_DECK=`window.__deck={inspect:[],build:[]};
window.SNLDeck={
  inspect:async b=>{ const head=new TextDecoder().decode(new Uint8Array(b).slice(0,40)); window.__deck.inspect.push(head);
    return head.startsWith("PK") ? {ok:true, slides:3, widthIn:13.333, heightIn:7.5} : {ok:false, message:"This file isn't a PowerPoint file. Choose your template saved as a .pptx file."}; },
  build:async (b,spec)=>{ window.__deck.build.push({tpl:new TextDecoder().decode(new Uint8Array(b).slice(0,40)), file:spec.fileName}); return new TextEncoder().encode("PPTX for "+spec.fileName); } };`;
const FAKE_SLIDES=`window.SNLProfile={
  plan:f=>[{id:"cover",label:"Cover",included:true,reason:""}], spec:(f,t)=>({fileName:(f.sample?"sample":"Calloway")+"-profile.pptx", slides:[]}),
  filingsPlan:f=>[{id:"cover",label:"Cover",included:true,reason:""}], filingsSpec:(f,t)=>({fileName:"filings-sample.pptx", slides:[]}) };`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const PSTATUS=(over={})=>({statutory:{configured:true, mapped:true, fields:[]}, claude:{configured:false}, filings:{configured:true}, ...over});
const SAMPLE=()=>({facts:{...copy(ANSWER.facts), sample:true, entity:{kind:"company", code:"99999", name:"Nonesuch Sample Insurance Co", groupName:null, naicGroupCode:null}}, text:copy(ANSWER.text)});
const FSAMPLE=()=>({facts:{sample:true, entity:{kind:"group", name:"Nonesuch Sample Group", companies:3, noId:0}, totals:{filings:5, rate:2, states:2}, period:{from:"2021-11-14", to:"2026-11-13", years:5}, search:{}}, text:{by:"plain"}});
const STD={text:"PK standard template", updated_at:"2026-11-05T09:30:00Z"};
const X='<img src=x onerror="window.__xss=1">';

(async()=>{
  // ----- the built-in template itself -----
  const z=await JSZip.loadAsync(BUILTIN), names=Object.keys(z.files).sort(), rd=n=>z.file(n).async("string");
  ok("the built-in template is small", BUILTIN.length<20000, BUILTIN.length);
  ok("it holds only the parts a template needs: no slides, pictures, printer settings, thumbnail or embedded files", same(names,["[Content_Types].xml","_rels/.rels","docProps/app.xml","docProps/core.xml","ppt/_rels/presentation.xml.rels","ppt/presProps.xml","ppt/presentation.xml","ppt/slideLayouts/_rels/slideLayout1.xml.rels","ppt/slideLayouts/_rels/slideLayout6.xml.rels","ppt/slideLayouts/slideLayout1.xml","ppt/slideLayouts/slideLayout6.xml","ppt/slideMasters/_rels/slideMaster1.xml.rels","ppt/slideMasters/slideMaster1.xml","ppt/tableStyles.xml","ppt/theme/theme1.xml","ppt/viewProps.xml"]), names);
  const core=await rd("docProps/core.xml"), app=await rd("docProps/app.xml");
  ok("its properties name no author, editor or tool: only the title Plain template", /<dc:title>Plain template<\/dc:title>/.test(core) && /<dc:creator><\/dc:creator>/.test(core) && /<cp:lastModifiedBy><\/cp:lastModifiedBy>/.test(core) && /<dc:description><\/dc:description>/.test(core) && !/<cp:lastPrinted>/.test(core), core);
  ok("its application properties name no company, manager or slide titles", !/<Company>|<Manager>|<HyperlinkBase>/.test(app) && /<vt:lpstr>Arial<\/vt:lpstr><vt:lpstr>Plain<\/vt:lpstr><\/vt:vector><\/TitlesOfParts>/.test(app), app);
  const every=(await Promise.all(names.filter(n=>!z.files[n].dir).map(rd))).join("\n");
  ok("nothing in it names a person, a tool, a computer path or a made-up company", !/python-pptx|steve|canny|\/home\/|\/root\/|\/workspace|\/tmp\/|[a-z]:\\\\|users[\\/]|calloway|nonesuch|tarrow|example|lorem/i.test(every));
  const texts=[...every.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m=>m[1]);
  ok("its only text is the placeholder prompts and the slide number", texts.every(t=>["Kicker","Title","Subtitle","Click to edit Master title style","Click to edit Master text styles","Second level","Third level","Fourth level","Fifth level","‹#›"].includes(t)), texts);
  const cols=[...new Set([...every.matchAll(/srgbClr val="([0-9A-F]{6})"/g)].map(m=>m[1]))].sort();
  ok("its colours are the site's own palette", cols.every(c=>["262166","EB008C","666666","D9DCE6","EEEEF5","00539E","0081C3","00857C","944599","C46A1B","FFFFFF","000000"].includes(c)), cols);
  ok("every file in it carries the same fixed date, so a rebuild gives the same file", Object.values(z.files).every(f=>f.date.getFullYear()===2026));
  ok("the script that makes it is in the repository", fs.readFileSync(path.join(ROOT,"scripts/make-builtin-template.py"),"utf8").includes("web/template-builtin.pptx"));

  const b=await chromium.launch(); const errs=[];
  {
    const pg=await b.newPage(); pg.on("pageerror",e=>errs.push(String(e)));
    await pg.setContent("<html><body></body></html>");
    await pg.addScriptTag({content:fs.readFileSync(path.join(ROOT,"node_modules/jszip/dist/jszip.min.js"),"utf8")});
    await pg.addScriptTag({content:fs.readFileSync(path.join(WEB,"deck.js"),"utf8")});
    const r=await pg.evaluate(async b64=>SNLDeck.inspect(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)).buffer), BUILTIN.toString("base64"));
    ok("the real template check accepts the built-in template: widescreen, both layouts, no example slides", same(r,{ok:true, slides:0, widthIn:13.33, heightIn:7.5}), r);
    await pg.close();
  }

  async function open(opts={}, over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], builtinLoads:0, builtinFail:false, pstatus:()=>PSTATUS(), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-profile") return J(200, body.action==="status" ? t.pstatus() : body.action==="sample" ? SAMPLE() : body.action==="filings_sample" ? FSAMPLE() : body.action==="facts" ? {facts:copy(ANSWER.facts), text:copy(ANSWER.text)} : {});
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:false});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===JSZIP_URL) return r.fulfill({contentType:"application/javascript",body:FAKE_JSZIP});
      if(u===BASE+"deck.js") return r.fulfill({contentType:"application/javascript",body:FAKE_DECK});
      if(u===BASE+"profile-slides.js") return r.fulfill({contentType:"application/javascript",body:FAKE_SLIDES});
      if(u===BASE+"template-builtin.pptx"){ t.builtinLoads++; return t.builtinFail ? r.abort("failed") : r.fulfill({contentType:PPTX, body:BUILTIN}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; window.__blobs=[]; },opts);
    await p.goto(BASE+(over.hash||"#profile")); await p.waitForTimeout(500);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.has=async sel=>!!(await p.$(sel));
    t.st=async()=>p.evaluate(()=>__mock.storage.calls.map(c=>c.op+(c.path?":"+c.path:"")));
    t.ups=async()=>p.evaluate(()=>__mock.storage.uploads.map(u=>u.path+"="+u.text));
    t.deck=async()=>p.evaluate(()=>window.__deck||{inspect:[],build:[]});
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.file=async(sel, name, text)=>{ await p.setInputFiles(sel,{name, mimeType:PPTX, buffer:Buffer.from(text)}); await p.waitForTimeout(350); };
    t.build=async(sel="#pf_buildBtn")=>{ const [d]=await Promise.all([p.waitForEvent("download",{timeout:5000}), p.click(sel)]); await p.waitForTimeout(150); return d.suggestedFilename(); };
    t.figures=async()=>{ await p.fill("#pf_code","90001"); await p.click("#pf_get"); await p.waitForTimeout(400); };
    t.shot=async name=>{ const el=await p.$("#pfTpl"); if(el) await el.screenshot({path:OUTDIR+"/"+name+".png"}); };
    return t;
  }
  const BUILTIN_LINE="The built-in plain template: nobody has uploaded one yet.";

  // ----- a reader, nothing uploaded anywhere: the built-in template, and their own can be uploaded -----
  let t=await open({role:"reader"}); let p=t.p;
  ok("reader, nothing uploaded: the next deck uses the built-in plain template", (await t.txt("#pfTplState"))===BUILTIN_LINE, await t.txt("#pfTplState"));
  ok("…fetched from beside the page, once, at the start", t.builtinLoads===1);
  ok("the block says how the template is chosen", (await t.txt("#pfTpl h3+p"))==="Your next deck is built on your own template if you have one, otherwise on the standard template Corp Dev uploads for everyone, otherwise on the built-in plain template.");
  ok("reader: upload your own, and use a file just this once; nothing about the standard template", (await t.txt('[data-act="pf-own-pick"]'))==="Upload your own" && !(await t.has('[data-act="pf-own-remove"]')) && (await t.txt('[data-act="pf-once-pick"]'))==="Use a different file just this once" && !(await t.has("#pfTplStd")) && !(await t.has("#pf_tplFile")));
  ok("says a template of your own is private, Corp Dev included, and its size limit", (await t.txt("#pfTplOwn p"))==="A template of your own is private to you: nobody else can see it or build on it, Corp Dev included. A .pptx file of up to 20 MB.");
  ok("storage is asked: can templates of your own be kept, the standard one, and this login's own folder only", same(await t.st(),["getBucket","list","list:u1"]), await t.st());
  await t.shot("tpl-builtin-reader-1440");
  await t.figures();
  let name=await t.build();
  ok("a deck builds at once, on the built-in template, and says so", name==="Calloway-profile.pptx" && (await t.deck()).build[0].tpl.startsWith("PK") && (await t.txt("#pfBuilt")).endsWith("Built on the built-in plain template.Download again"), await t.txt("#pfBuilt"));
  ok("…from the bytes already fetched: no second fetch, nothing taken from storage", t.builtinLoads===1 && !(await t.st()).some(s=>s.startsWith("download")));
  // unusable files, each refused before anything is stored
  await t.file("#pf_ownFile","notes.potx","PK potx");
  ok("own upload: a file that isn't .pptx is refused", (await t.txt("#pfTplOwnErr"))==="Choose a PowerPoint file whose name ends in .pptx." && !(await t.ups()).length);
  await p.evaluate(()=>uploadOwnTemplate({name:"big.pptx", size:TPL_OWN_MAX+1, arrayBuffer:async()=>new ArrayBuffer(4)})); await p.waitForTimeout(150);
  ok("own upload: a file over 20 MB is refused plainly", (await t.txt("#pfTplOwnErr"))==="That file is 20.0 MB. Your own template can be at most 20 MB." && !(await t.ups()).length, await t.txt("#pfTplOwnErr"));
  await t.file("#pf_ownFile","notes.pptx","NOT A ZIP");
  ok("own upload: checked first, refused with the checker's own words", (await t.txt("#pfTplOwnErr"))==="This file isn't a PowerPoint file. Choose your template saved as a .pptx file." && (await t.deck()).inspect.includes("NOT A ZIP") && !(await t.ups()).length);
  await p.evaluate(()=>{ __mock.storage.delay=300; });
  await p.setInputFiles("#pf_ownFile",{name:"Mine.pptx", mimeType:PPTX, buffer:Buffer.from("PK my own template")}); await p.waitForTimeout(150);
  ok("uploading your own: says so, and the other buttons wait", (await t.txt('[data-act="pf-own-pick"]'))==="Uploading…" && await p.isDisabled('[data-act="pf-once-pick"]'));
  await p.waitForTimeout(450); await p.evaluate(()=>{ __mock.storage.delay=0; });
  ok("your own is stored under your own user id only, replacing any earlier one", same(await t.ups(),["u1/template.pptx=PK my own template"]) && same(await p.evaluate(()=>__mock.storage.uploads[0].opts),{upsert:true,contentType:PPTX,cacheControl:"60"}));
  ok("then the next deck uses it, and the way back is said", (await t.txt("#pfTplState"))==="Your own template, uploaded 13 Nov. Remove it to go back to the built-in plain template." && (await t.txt("#pfTplOwnDone"))==="Your own template is uploaded: 3 slides, 13.33 x 7.5 in. Your decks are built on it from now on, and nobody else can see it.", await t.txt("#pfTplState"));
  ok("replace and remove your own are offered", (await t.txt('[data-act="pf-own-pick"]'))==="Replace your own" && (await t.txt('[data-act="pf-own-remove"]'))==="Remove your own");
  await t.shot("tpl-own-reader-1440");
  name=await t.build();
  ok("built on your own template, from memory, and the message says so", (await t.deck()).build[1].tpl==="PK my own template" && !(await t.st()).some(s=>s.startsWith("download")) && (await t.txt("#pfBuilt")).endsWith("Built on your own template.Download again"));
  await p.click('[data-act="pf-own-remove"]'); await p.waitForTimeout(350);
  ok("remove your own: removed from storage, the page checks again, and says what comes next", same(await p.evaluate(()=>__mock.storage.removes),["u1/template.pptx"]) && (await t.txt("#pfTplState"))===BUILTIN_LINE && (await t.txt("#pfTplOwnDone"))==="Your own template is removed. Your next deck uses the built-in plain template." && (await t.txt('[data-act="pf-own-pick"]'))==="Upload your own");
  name=await t.build();
  ok("just removed: the next deck is on the built-in template again (the kept bytes were let go)", (await t.deck()).build[2].tpl.startsWith("PK\u0003\u0004") && t.builtinLoads===2 && (await t.txt("#pfBuilt")).endsWith("Built on the built-in plain template.Download again"), [t.builtinLoads, (await t.deck()).build[2]]);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll, reader", await t.noScroll());
  await t.shot("tpl-builtin-reader-390");
  await t.ctx.close();

  // ----- your own, the standard one behind it; another login's template is never seen -----
  t=await open({role:"reader", template:STD, ownTemplates:{u1:{text:"PK u1 own", updated_at:"2026-11-12T10:00:00Z"}, u2:{text:"PK u2 own"}}}); p=t.p;
  ok("own template present: used first, with the standard one as the way back", (await t.txt("#pfTplState"))==="Your own template, uploaded 12 Nov. Remove it to go back to the standard template.", await t.txt("#pfTplState"));
  await t.figures(); await t.build();
  ok("built on your own: downloaded from your own folder once", (await t.deck()).build[0].tpl==="PK u1 own" && same((await t.st()).filter(s=>s.startsWith("download")),["download:u1/template.pptx"]));
  ok("the page never asks storage about any other login's folder", (await t.st()).every(s=>["getBucket","list","list:u1","download:u1/template.pptx"].includes(s)), await t.st());
  { const body=await p.textContent("body"), tpl=await p.evaluate(()=>JSON.stringify({...S.pf.tpl, bytes:null}));
    ok("nothing on the page mentions the other login's template", !/\bu2\b|u2 own/.test(body) && !/\bu2\b|u2 own/.test(tpl), [body.match(/.{20}\bu2\b.{20}/), tpl.match(/.{20}u2.{20}/)]); }
  ok("even asked directly, storage shows this login nothing of another's (the mock follows the policies)", same(await p.evaluate(async()=>{ const B=S.sb.storage.from("snl-template"); const a=await B.list("u2"); const d=await B.download("u2/template.pptx"); const r=await B.list(""); return [a.data.length, !!d.error, r.data.map(x=>x.name).sort()]; }),[0,true,["template.pptx","u1"]]));
  await p.click('[data-act="pf-own-remove"]'); await p.waitForTimeout(350);
  ok("removed: back to the standard template", (await t.txt("#pfTplState"))==="The standard template, uploaded by Corp Dev on 5 Nov." && (await t.txt("#pfTplOwnDone"))==="Your own template is removed. Your next deck uses the standard template.");
  await t.build();
  ok("…and the next deck downloads the standard template", (await t.deck()).build[1].tpl==="PK standard template" && (await t.txt("#pfBuilt")).endsWith("Built on the standard template.Download again"));
  await t.ctx.close();

  // ----- two logins on one browser: the second never sees the first one's template -----
  t=await open({role:"reader", ownTemplates:{u1:{text:"PK u1 own"}}, users:{reader2:{id:"u2", display_name:"Reader 2", role:"reader"}}}); p=t.p;
  ok("first login: its own template", (await t.txt("#pfTplState")).startsWith("Your own template"));
  await p.evaluate(()=>signOut()); await p.waitForTimeout(250);
  ok("signing out drops the template state", await p.evaluate(()=>S.pf.tpl.own===null && S.pf.tpl.bytes===null && S.pf.tpl.once===null));
  await p.fill("#li_user","reader2"); await p.fill("#li_pw","made-up-password"); await p.click(".login button.primary"); await p.waitForTimeout(700);
  if(!(await t.has("#pfTpl"))){ await p.click('nav.tabs a[data-view="profile"]').catch(()=>{}); await p.waitForTimeout(400); }
  ok("second login: the built-in template, not the first login's", (await t.txt("#pfTplState"))===BUILTIN_LINE && (await t.st()).includes("list:u2") && !(await t.st()).some(s=>s.includes("u1/")), await t.st());
  await t.ctx.close();

  // ----- migration 0008 not run: the standard template still works; uploading your own says what Corp Dev must run -----
  t=await open({role:"reader", template:STD, noOwnTemplates:true, ownTemplates:{u1:{text:"PK left over"}}}); p=t.p;
  ok("0008 not run: the standard template is used (an object in your folder is ignored)", (await t.txt("#pfTplState"))==="The standard template, uploaded by Corp Dev on 5 Nov.");
  await p.click('[data-act="pf-own-pick"]'); await p.waitForTimeout(150);
  ok("0008 not run, reader: told to ask Corp Dev to run it; nothing uploaded", (await t.txt("#pfTplOwnErr"))==="Templates of your own aren't switched on yet. Ask Corp Dev to run migration 0008_own_templates.sql in Supabase (see the README)." && !(await t.ups()).length);
  await t.shot("tpl-nomigration-reader-1440");
  await t.figures(); await t.build();
  ok("0008 not run: decks still build on the standard template", (await t.deck()).build[0].tpl==="PK standard template");
  await p.evaluate(()=>uploadOwnTemplate({name:"x.pptx", size:10, arrayBuffer:async()=>new TextEncoder().encode("PK x").buffer})); await p.waitForTimeout(200);
  ok("…even called directly, nothing is uploaded", !(await t.ups()).length);
  await t.ctx.close();
  t=await open({template:STD, noOwnTemplates:true}); p=t.p;
  await p.click('[data-act="pf-own-pick"]'); await p.waitForTimeout(150);
  ok("0008 not run, Corp Dev: told to run it (and never uploads to a folder others could read)", (await t.txt("#pfTplOwnErr"))==="Templates of your own aren't switched on yet. Run migration 0008_own_templates.sql in the Supabase SQL editor (see the README), then reload this page." && !(await t.ups()).length);
  await t.ctx.close();

  // ----- just this once: a file from this computer, never stored, for the next deck only; and cancelled -----
  t=await open({role:"reader", template:STD}); p=t.p;
  await t.file("#pf_onceFile","notes.pptx","NOT A ZIP");
  ok("just this once: an unusable file is refused in the checker's words", (await t.txt("#pfTplOnceErr"))==="This file isn't a PowerPoint file. Choose your template saved as a .pptx file." && (await t.txt("#pfTplState")).startsWith("The standard template"));
  await t.file("#pf_onceFile","Board version.pptx","PK board version");
  ok("chosen: named, with what the check found, that it isn't stored, and a way to cancel", (await t.txt("#pfTplState"))==="Board version.pptx, a file from your computer, just this once (3 slides, 13.33 x 7.5 in). It isn't stored anywhere; the deck after it goes back to the standard template.Cancel, don't use it" && !(await t.ups()).length && (await t.txt('[data-act="pf-once-pick"]'))==="Choose a different file", await t.txt("#pfTplState"));
  await t.shot("tpl-once-1440");
  await p.click('[data-act="pf-once-cancel"]'); await p.waitForTimeout(150);
  ok("cancelled: back to the standard template, nothing kept", (await t.txt("#pfTplState"))==="The standard template, uploaded by Corp Dev on 5 Nov." && await p.evaluate(()=>S.pf.tpl.once===null));
  await t.file("#pf_onceFile","Board version.pptx","PK board version");
  await t.figures(); await t.build();
  ok("built on the one-off file, without touching storage, and the message names it", (await t.deck()).build[0].tpl==="PK board version" && !(await t.st()).some(s=>s.startsWith("download")||s.startsWith("upload")) && (await t.txt("#pfBuilt")).endsWith("Built on Board version.pptx, a file used just this once.Download again"), await t.txt("#pfBuilt"));
  ok("…and then it is let go: the next deck goes back to the standard template", (await t.txt("#pfTplState"))==="The standard template, uploaded by Corp Dev on 5 Nov." && await p.evaluate(()=>S.pf.tpl.once===null));
  await t.build();
  ok("the next deck: the standard template, and the earlier message is unchanged", (await t.deck()).build[1].tpl==="PK standard template" && (await t.txt("#pfBuilt")).endsWith("Built on the standard template.Download again"));
  // the sample filings profile uses the same choice
  await t.file("#pf_onceFile","Filings look.pptx","PK filings look");
  await p.click('[data-act="pf-mode"][data-m="filings"]'); await p.waitForTimeout(150);
  ok("the filings profile shows the same template block and choice", (await t.txt("#pfTplState")).startsWith("Filings look.pptx, a file from your computer"));
  await Promise.all([p.waitForEvent("download",{timeout:5000}), p.click('[data-act="fp-sample"]')]); await p.waitForTimeout(200);
  ok("a sample deck uses the same choice of template", (await t.deck()).build[2].tpl==="PK filings look" && (await t.txt("#fpBuilt")).endsWith("Built on Filings look.pptx, a file used just this once.Download again"), await t.txt("#fpBuilt"));
  // a hostile file name stays text, without control or direction characters
  await t.file("#pf_onceFile", X+"‮\u0007.pptx","PK hostile");
  ok("a hostile file name is shown as text, nothing runs", (await t.txt("#pfTplState")).startsWith(X+".pptx, a file from your computer") && !(await p.evaluate(()=>window.__xss)) && !(await p.evaluate(()=>document.querySelector("#pfTplState img"))), await t.txt("#pfTplState"));
  await p.evaluate(n=>chooseOnceTemplate({name:n, size:4, arrayBuffer:async()=>new TextEncoder().encode("PK long").buffer}), "a".repeat(300)+".pptx"); await p.waitForTimeout(250);
  ok("a very long file name is cut to 80 characters", (await p.evaluate(()=>S.pf.tpl.once.name.length))===80);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with a long file name chosen", await t.noScroll());
  await t.shot("tpl-once-390");
  await t.ctx.close();

  // ----- Corp Dev: the standard template, replace, remove (asked once); their own still wins for them -----
  t=await open({template:STD}); p=t.p;
  ok("Corp Dev: standard controls beside your own", (await t.txt('[data-act="pf-tpl-pick"]'))==="Replace the standard template" && (await t.txt('[data-act="pf-std-remove"]'))==="Remove the standard template" && (await t.txt("#pfTplStd b"))==="The standard template, for everyone" && (await t.txt('[data-act="pf-own-pick"]'))==="Upload your own");
  await p.click('[data-act="pf-std-remove"]'); await p.waitForTimeout(100);
  ok("remove the standard template: asked once, saying what it means and that the page can't count who it affects", (await t.txt("#pfTplConfirm p"))==="Remove the standard template? Everyone without a template of their own will build on the built-in plain template until a new standard template is uploaded. Templates of your own are private, so the page can't tell how many people that is." && await p.isDisabled('[data-act="pf-tpl-pick"]'));
  await t.shot("tpl-corpdev-confirm-1440");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll, Corp Dev asked to confirm", await t.noScroll());
  await t.shot("tpl-corpdev-confirm-390");
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);
  await p.click('[data-act="pf-std-remove-no"]'); await p.waitForTimeout(100);
  ok("Keep it: nothing removed", !(await t.has("#pfTplConfirm")) && !(await p.evaluate(()=>__mock.storage.removes||[])).length);
  await p.click('[data-act="pf-std-remove"]'); await p.click('[data-act="pf-std-remove-yes"]'); await p.waitForTimeout(350);
  ok("Yes: the standard template is removed and everyone without their own is on the built-in one", same(await p.evaluate(()=>__mock.storage.removes),["template.pptx"]) && (await t.txt("#pfTplState"))===BUILTIN_LINE && (await t.txt("#pfTplDone"))==="The standard template is removed. Everyone without a template of their own now builds on the built-in plain template, until a new standard template is uploaded." && (await t.txt('[data-act="pf-tpl-pick"]'))==="Upload the standard template" && !(await t.has('[data-act="pf-std-remove"]')));
  await t.file("#pf_ownFile","cd own.pptx","PK corp dev own");
  await t.file("#pf_tplFile","std2.pptx","PK standard two");
  ok("Corp Dev with their own: uploading the standard one says theirs still wins for them", (await t.txt("#pfTplDone"))==="Standard template uploaded: 3 slides, 13.33 x 7.5 in. Everyone without a template of their own builds on it from now on. Your own decks still use your own template." && (await t.txt("#pfTplState")).startsWith("Your own template") && same(await t.ups(),["u1/template.pptx=PK corp dev own","template.pptx=PK standard two"]));
  await t.figures(); await t.build();
  ok("Corp Dev builds on their own template", (await t.deck()).build[0].tpl==="PK corp dev own");
  await t.shot("tpl-corpdev-own-1440");
  await t.ctx.close();
  t=await open({template:STD, ownTemplates:{u2:{text:"PK reader's own"}}}); p=t.p;
  ok("Corp Dev cannot see a reader's own template", (await t.txt("#pfTplState")).startsWith("The standard template") && same(await p.evaluate(async()=>{ const d=await S.sb.storage.from("snl-template").download("u2/template.pptx"); const r=await S.sb.storage.from("snl-template").remove(["u2/template.pptx"]); return [!!d.error, r.data.length]; }),[true,0]));
  await t.ctx.close();

  // ----- the built-in file fails to load: said, with a retry; uploads still offered -----
  t=await open({role:"reader"}, {builtinFail:true}); p=t.p;
  ok("built-in fails: said plainly, with Try again, and your own can still be uploaded", (await t.txt("#pfTplBuiltinErr"))==="The built-in plain template couldn't be loaded. Check your connection and try again, or upload a template to build on.Try again" && (await p.getAttribute("#pfTplBuiltinErr","role"))==="alert" && !(await p.isDisabled('[data-act="pf-own-pick"]')) && !(await p.isDisabled('[data-act="pf-once-pick"]')));
  await t.shot("tpl-builtin-failed-1440");
  await t.figures(); await p.click("#pf_buildBtn"); await p.waitForTimeout(300);
  ok("building meanwhile: the same plain message, with Try again, nothing built", (await t.txt("#pfBuildErr"))==="The built-in plain template couldn't be loaded. Check your connection and try again, or upload a template to build on.Try again" && !(await t.deck()).build.length);
  t.builtinFail=false; await p.click('[data-act="pf-builtin-retry"]'); await p.waitForTimeout(300);
  ok("Try again loads it: the message goes", !(await t.has("#pfTplBuiltinErr")) && (await t.txt("#pfTplState"))===BUILTIN_LINE);
  await t.build('#pfBuildErr [data-act="pf-build"]');
  ok("…and the deck builds on it", (await t.deck()).build.length===1 && (await t.txt("#pfBuilt")).endsWith("Built on the built-in plain template.Download again"));
  await t.ctx.close();
  t=await open({role:"reader"}, {builtinFail:true}); p=t.p;
  await t.file("#pf_ownFile","Mine.pptx","PK mine");
  ok("built-in fails, then an own template is uploaded: the message goes and it is used", !(await t.has("#pfTplBuiltinErr")) && (await t.txt("#pfTplState")).startsWith("Your own template"));
  await t.ctx.close();

  // ----- storage refusing, missing or out of reach -----
  t=await open({role:"reader"}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.refuse=true; });
  await t.file("#pf_ownFile","Mine.pptx","PK mine");
  ok("own upload refused by the storage rules: says what Corp Dev must run", (await t.txt("#pfTplOwnErr"))==="Templates of your own aren't switched on yet. Ask Corp Dev to run migration 0008_own_templates.sql in Supabase (see the README).");
  await p.evaluate(()=>{ __mock.storage.refuse=false; __mock.storage.netFail=true; });
  await t.file("#pf_ownFile","Mine.pptx","PK mine");
  ok("own upload with no connection: said plainly", (await t.txt("#pfTplOwnErr"))==="Couldn't reach storage to upload your template. Check your connection and try again.");
  await p.evaluate(()=>{ __mock.storage.netFail=false; }); await t.file("#pf_ownFile","Mine.pptx","PK mine");
  await p.evaluate(()=>{ __mock.storage.netFail=true; }); await p.click('[data-act="pf-own-remove"]'); await p.waitForTimeout(250);
  ok("remove with no connection: said plainly, and it is still there", (await t.txt("#pfTplOwnErr"))==="Couldn't reach storage to remove your template. Check your connection and try again." && (await t.txt("#pfTplState")).startsWith("Your own template"));
  await p.evaluate(()=>{ __mock.storage.netFail=false; const may=__mock.storage.may; __mock.storage.may=(op,k)=>op==="remove"?false:may(op,k); }); await p.click('[data-act="pf-own-remove"]'); await p.waitForTimeout(350);
  ok("remove silently refused by storage: the page checks again and says it wasn't removed", (await t.txt("#pfTplOwnErr"))==="Your own template couldn't be removed. Try again, or ask Corp Dev to check that migration 0008_own_templates.sql has been run." && (await t.txt("#pfTplState")).startsWith("Your own template"), await t.txt("#pfTplOwnErr"));
  await t.ctx.close();
  t=await open({role:"reader", ownTemplates:{u1:{text:"PK u1 own"}}}); p=t.p;
  await t.figures();
  await p.evaluate(()=>{ delete __mock.storage.buckets["snl-template"]["u1/template.pptx"]; }); await p.click("#pf_buildBtn"); await p.waitForTimeout(300);
  ok("own template removed elsewhere by the time of building: says so, Try again uses the next one", (await t.txt("#pfBuildErr"))==="Your own template has been removed since this page checked. Choose Try again to build on the built-in plain template.Try again" && (await t.txt("#pfTplState"))===BUILTIN_LINE, await t.txt("#pfBuildErr"));
  await t.build('#pfBuildErr [data-act="pf-build"]');
  ok("…and Try again builds on the built-in one", (await t.txt("#pfBuilt")).endsWith("Built on the built-in plain template.Download again"));
  await t.ctx.close();
  t=await open({role:"reader", noBucket:true}); p=t.p;
  ok("bucket missing (0004 not run): the built-in template still builds; the set-up is pointed to", (await t.txt("#pfTplState"))===BUILTIN_LINE && (await t.txt("#pfTplSetup span"))==="The place the template is kept isn't set up yet. Ask Corp Dev to finish the set-up." && !(await t.has("#pfTplOwn")) && await t.has("#pfTplOnce"));
  await t.figures(); await t.build();
  ok("…a deck is built on it", (await t.deck()).build.length===1);
  await t.ctx.close();
  t=await open({role:"reader", template:STD}, {hash:"#filings"}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.netFail=true; }); await p.click('nav.tabs a[data-view="profile"]'); await p.waitForTimeout(300);
  ok("storage out of reach: a problem with Try again, no upload controls, nothing guessed", (await t.txt("#pfTplState span"))==="Couldn't reach storage to get the template. Check your connection and try again." && !(await t.has("#pfTplOwn")) && t.builtinLoads===0);
  await t.figures(); await p.click("#pf_buildBtn"); await p.waitForTimeout(300);
  ok("building with storage out of reach: never falls back silently to another template", (await t.txt("#pfBuildErr"))==="Couldn't reach storage to get the template. Check your connection and try again.Try again" && !(await t.deck()).build.length);
  await p.evaluate(()=>{ __mock.storage.netFail=false; });
  await t.build('#pfBuildErr [data-act="pf-build"]');
  ok("…Try again checks again and builds on the standard template", (await t.deck()).build[0].tpl==="PK standard template");
  await t.ctx.close();

  // ----- the session ends mid-way -----
  t=await open({role:"reader"}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.delay=400; });
  await p.setInputFiles("#pf_ownFile",{name:"Mine.pptx", mimeType:PPTX, buffer:Buffer.from("PK mine")}); await p.waitForTimeout(150);
  await p.evaluate(()=>signOut()); await p.waitForTimeout(600);
  ok("session ended while uploading: nothing of it is kept on the page", await p.evaluate(()=>S.pf.tpl.own===null && S.pf.tpl.ownNote==="" && S.pf.tpl.bytes===null) && !!(await p.$(".login")));
  await t.ctx.close();
  t=await open({role:"reader"}); p=t.p;
  await p.evaluate(()=>{ __mock.storage.delay=400; });
  await p.evaluate(()=>{ S.pf.tpl.checked=false; checkTemplate(); }); await p.waitForTimeout(100);
  await p.evaluate(()=>signOut()); await p.waitForTimeout(600);
  ok("session ended while checking: no error and no template left", await p.evaluate(()=>S.pf.tpl.own===null && S.pf.tpl.info===null));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
