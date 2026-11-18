// The team library in the Ask Claude panel: saving one's own finished answer (the form, its exact notice, where to
// find it), an answer already saved, the Team library list beside Past answers (newest first, search, Show more),
// opening an entry (who saved it and when, how old the facts are, sources, table, exports, documents), following it
// up as a private conversation of one's own, editing and removing as the saver and as Corp Dev, a reader's view,
// every "not ready" state (migration not run, function not redeployed, saving fails, the list fails, the cap, an
// entry removed while open, the session ending), hostile text, and the layouts at 1440px and 390px.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), JOB=FIX("web_ask_result.json"), STAT=FIX("web_statutory.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const NOW=Date.parse("2026-11-13T12:00:00Z");
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ago=ms=>new Date(NOW-ms).toISOString();
const MIN=60000, DAYMS=86400000;
const NOTICE="Everyone with a login on this site will be able to read this question and its answer, including which companies it is about. It stays until you or Corp Dev remove it.";
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const RESULT=copy(JOB.result);
const answerText=r=>r.answer.map(s=>s.text).join("\n");
// a snl_jobs row as the snl-chat function writes it
const row=(id, o={})=>["snl_jobs", id, {owner:"u1", status:"done", question:"Question "+id, progress:[], partial:"", result:RESULT, error:null, segments:0,
  created_at:ago(2*DAYMS), updated_at:ago(2*DAYMS-3*MIN), heartbeat_at:ago(2*DAYMS-3*MIN), ...o}];
// a snl_library row as the function saves it
const libRow=(id, o={})=>["snl_library", id, {job_id:"job-x-"+id, title:"Entry "+id, question:"Which carriers file private client forms in Florida?",
  answer:{answer:RESULT.answer, sources:RESULT.sources, table:RESULT.table, caps:RESULT.caps||[], lookups:RESULT.lookups||[]}, model:RESULT.model,
  asked_at:"2026-11-04T09:00:00Z", answered_at:"2026-11-04T09:04:00Z", saved_by:"u2", saved_by_name:"Robin Reader", saved_at:"2026-11-05T10:00:00Z", updated_at:"2026-11-05T10:00:00Z",
  tags:["Florida","forms"], companies:["Calloway Insurance Co","Calloway Home Co","Tarrow Mutual Insurance Co"], search_text:"", ...o}];
const USERS={reader2:{id:"u2", display_name:"Robin Reader", role:"reader"}, corp3:{id:"u3", display_name:"Casey Corp", role:"corpdev"}};

(async()=>{
  const b=await chromium.launch(); const errs=[];
  // One browser context per scenario. opts: the made-up database; at.panel: open the panel once loaded.
  async function open(opts={}, at={}){
    const {hash="#filings", panel=false, width=1440}=at;
    const ctx=await b.newContext({viewport:{width,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date(NOW));
    const t={p, ctx, calls:[], jobs:0, claude:true, libFn:null,
      ask:()=>({status:202, body:{jobId:"job-new-"+(++t.jobs)}})};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev", claude:{configured:t.claude}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory" && body.action==="status") return J(200,copy(STAT.statusMapped));
        if(fn==="snl-filings" && body.action==="document") return r.fulfill({status:200,contentType:"application/pdf",headers:{"access-control-allow-origin":"*"},body:"%PDF-1.4 made-up "+(body.documentId||body.filingVersionId)});
        if(fn==="snl-chat" && body.action==="ask"){ const a=t.ask(body); return J(a.status,a.body); }
        if(fn==="snl-chat" && body.action==="continue") return J(202,{jobId:body.jobId, resumed:false});
        if(fn==="snl-chat" && /^library_/.test(body.action||"")){ const a=t.libFn ? await t.libFn(body) : await fakeLibrary(p, body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action. Use ask or continue."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    // the latest answer counts as seen, so the panel opens on the lists rather than on that answer
    const latest=(opts.seed||[]).filter(s=>s[0]==="snl_jobs").sort((x,y)=>String(y[2].created_at).localeCompare(String(x[2].created_at)))[0];
    await p.addInitScript(([o,seen])=>{ window.__opts=o; window.__opened=[];
      try{ localStorage.setItem("snl.seenAnswer", seen); }catch{}
      window.open=url=>{ const w={closed:false, opener:window, location:{href:url||""}, document:{title:"", body:{textContent:""}}, close(){ this.closed=true; }}; window.__opened.push(w); return w; }; }, [opts, latest?latest[1]:"none"]);
    await p.goto(BASE+hash); await p.waitForTimeout(450);
    await p.evaluate(()=>{ TIMING.poll=100; });   // check ten times a second
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>{ const b=document.getElementById("askBody"); return document.documentElement.scrollWidth<=window.innerWidth && (!b || b.scrollWidth<=b.clientWidth); });
    t.openPanel=async()=>{ await p.click("#askFab"); await p.waitForTimeout(200); };
    t.of=a=>t.calls.filter(c=>c.body.action===a);
    t.lib=async()=>p.evaluate(()=>__mock.store.snl_library ? JSON.parse(JSON.stringify(__mock.store.snl_library)) : null);
    t.libReads=async()=>p.evaluate(()=>__mock.libReads);
    t.mock=async f=>p.evaluate(f);
    t.say=async q=>{ await p.fill("#ask_input",q); await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(250); };
    t.tab=async()=>{ await p.click("#tabLib"); await p.waitForTimeout(250); };
    t.openPast=async id=>{ await p.click(`#pastList button[data-id="${id}"]`); await p.waitForTimeout(300); };
    t.openEntry=async id=>{ await p.click(`#libList button[data-id="${id}"]`); await p.waitForTimeout(300); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), size:fs.statSync(await d.path()).size}; };
    t.shot=async name=>{ await p.screenshot({path:OUTDIR+"/"+name}); };
    if(panel) await t.openPanel();
    return t;
  }
  // The snl-chat function's library actions, played against the made-up database in the page, with the same rules.
  async function fakeLibrary(p, body){
    return p.evaluate(body=>{
      const S2=__mock.store, L=S2.snl_library, uid=__mock.uid, role=(S2.profiles[uid]||{}).role, now=new Date().toISOString();
      const out=e=>{ const o={...e}; delete o.answer; delete o.search_text; return o; };
      if(!L) return {status:503, body:{error:"library_missing", message:"The team library isn't set up yet."}};
      if(body.action==="library_save"){
        const j=S2.snl_jobs[body.jobId];
        if(!j || (j.owner||"u1")!==uid) return {status:404, body:{error:"not_found", message:"That answer wasn't found."}};
        if(j.status!=="done") return {status:409, body:{error:"not_finished", message:"This answer hasn't finished yet."}};
        const ex=Object.values(L).find(e=>e.job_id===j.id); if(ex) return {status:200, body:{entry:out(ex), existing:true}};
        const id="lib-new-"+(Object.keys(L).length+1), r=j.result||{};
        const companies=[...new Set((r.sources||[]).map(s=>s.company).filter(Boolean))];
        L[id]={id, job_id:j.id, title:body.title, question:j.question, answer:{answer:r.answer||[], sources:r.sources||[], table:r.table||null, caps:r.caps||[], lookups:r.lookups||[]}, model:r.model||null,
          asked_at:j.created_at, answered_at:j.updated_at, saved_by:uid, saved_by_name:S2.profiles[uid].display_name, saved_at:now, updated_at:now, tags:body.tags||[], companies,
          search_text:[body.title, j.question, (body.tags||[]).join(" "), companies.join(" ")].join(" ").toLowerCase()};
        return {status:200, body:{entry:out(L[id]), existing:false}};
      }
      const e=L[body.id];
      if(!e) return {status:404, body:{error:"not_found", message:"That entry is no longer in the team library. Someone may have removed it."}};
      if(e.saved_by!==uid && role!=="corpdev") return {status:403, body:{error:"forbidden", message:"Only the person who saved this entry, or a Corp Dev login, can change or remove it."}};
      if(body.action==="library_remove"){ delete L[body.id]; return {status:200, body:{removed:true}}; }
      if(body.action==="library_update"){ e.title=body.title; e.tags=body.tags; e.updated_at=now; return {status:200, body:{entry:out(e)}}; }
      return {status:400, body:{error:"bad", message:"Unknown action. Use ask or continue."}};
    }, body);
  }

  // ----- saving a past answer of one's own -----
  let t=await open({seed:[row("job-a",{question:"Which Calloway companies file separate homeowners forms in Florida for private clients?"})], users:USERS}, {panel:true}); let p=t.p;
  ok("the start of an empty conversation has two tabs: Past answers (chosen) and Team library", same(await t.all(".libtabs [role=tab]"),["Past answers","Team library"]) && (await p.getAttribute("#tabPast","aria-selected"))==="true" && await p.isVisible("#pastList"));
  await t.openPast("job-a");
  ok("one's own finished answer offers Save to team library", (await t.txt('button[data-act="lib-open-form"]'))==="Save to team library" && await p.isEnabled('button[data-act="lib-open-form"]'));
  const chk=(await t.libReads()).find(q=>q.eqs.some(e=>e[0]==="job_id"));
  ok("the page asked once whether it is already in the library, by its answer id, without the copied answer", !!chk && same(chk.eqs,[["job_id","job-a"]]) && !chk.cols.split(",").includes("answer") && chk.single, chk);
  await p.click('button[data-act="lib-open-form"]'); await p.waitForTimeout(150);
  ok("the form: a title suggested from the question, empty tags, the notice word for word above Save", (await p.inputValue("#lib_title"))==="Which Calloway companies file separate homeowners forms in Florida for private clients?" && (await p.inputValue("#lib_tags"))==="" && (await t.txt("#libNotice"))===NOTICE
    && await p.evaluate(()=>{ const n=document.getElementById("libNotice"), s=document.querySelector('[data-act="lib-save"]'); return !!(n.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); }), await t.txt("#libForm"));
  ok("the title box has the focus and holds at most 120 characters", await p.evaluate(()=>document.activeElement.id==="lib_title") && (await p.getAttribute("#lib_title","maxlength"))==="120");
  ok("nothing is saved by opening the form", t.of("library_save").length===0);
  await p.fill("#lib_title","   "); await p.click('button[data-act="lib-save"]'); await p.waitForTimeout(100);
  ok("no title: says so, nothing sent", (await t.txt("#libFormErr"))==="Give the entry a title." && t.of("library_save").length===0);
  await p.fill("#lib_title","Calloway private client forms, Florida"); await p.fill("#lib_tags","a, b, c, d, e, f"); await p.click('button[data-act="lib-save"]'); await p.waitForTimeout(100);
  ok("six tags: says so, nothing sent", (await t.txt("#libFormErr"))==="Use up to 5 tags." && t.of("library_save").length===0);
  await p.fill("#lib_tags","x".repeat(31)); await p.press("#lib_tags","Enter"); await p.waitForTimeout(100);
  ok("a tag over 30 characters: says so", (await t.txt("#libFormErr"))==="Keep each tag to 30 characters.");
  await p.click('button[data-act="lib-cancel"]'); await p.waitForTimeout(100);
  ok("Cancel closes the form and saves nothing", !(await p.$("#libForm")) && t.of("library_save").length===0 && await p.isVisible('button[data-act="lib-open-form"]'));
  await p.click('button[data-act="lib-open-form"]'); await p.waitForTimeout(100);
  await p.fill("#lib_title","Calloway private client forms, Florida"); await p.fill("#lib_tags"," Florida, private client,florida ,, forms ");
  await t.shot("library-form-1440.png");
  await p.click('button[data-act="lib-save"]'); await p.waitForTimeout(300);
  ok("Save sends this answer's id, the title and the tags (repeats and blanks dropped)", same(t.of("library_save").map(c=>c.body),[{action:"library_save", jobId:"job-a", title:"Calloway private client forms, Florida", tags:["Florida","private client","forms"]}]), t.of("library_save").map(c=>c.body));
  ok("saved: says so, and where to find it", (await t.txt("#libSaved p")).startsWith("Saved to the team library. Colleagues find it under Team library at the start of a new conversation in this panel. Title: “Calloway private client forms, Florida”. Saved by Corp Dev 1 on 13 Nov.") && (await t.txt('#libSaved button[data-act="lib-goto"]'))==="Go to the team library", await t.txt("#libSaved"));
  ok("the saver may remove it from there", (await t.txt('#libSaved button[data-act="lib-remove"]'))==="Remove from library");
  ok("no Save button any more", !(await p.$('button[data-act="lib-open-form"]')));
  await p.click('button[data-act="lib-goto"]'); await p.waitForTimeout(350);
  ok("Go to the team library: an empty conversation on the Team library tab, with the new entry", !(await p.$("#askLog")) && (await p.getAttribute("#tabLib","aria-selected"))==="true" && (await t.all("#libList .pq"))[0]==="Calloway private client forms, Florida");
  ok("the list item: who saved it and when, when it was answered, its tags", (await t.txt("#libList li .t2"))==="Saved by Corp Dev 1 on 13 Nov · Answered 11 Nov" && same(await t.all("#libList li .libtag"),["Florida","private client","forms"]), await t.txt("#libList li"));
  await t.ctx.close();

  // ----- an answer already in the library; removing it as its saver -----
  t=await open({seed:[row("job-b"), libRow("e1",{job_id:"job-b", title:"Mine already", saved_by:"u1", saved_by_name:"Corp Dev 1", saved_at:"2026-11-12T08:00:00Z"})], users:USERS, role:"reader"}, {panel:true}); p=t.p;
  await t.openPast("job-b");
  ok("an answer already saved says so instead of offering Save", (await t.txt("#libSaved p"))==="This answer is in the team library. Title: “Mine already”. Saved by Corp Dev 1 on 12 Nov." && !(await p.$('button[data-act="lib-open-form"]')), await t.txt("#libSaved"));
  await p.click('#libSaved button[data-act="lib-remove"]'); await p.waitForTimeout(100);
  ok("Remove asks first, saying it is gone for everyone", (await t.txt("#libConfirm p"))==="Remove this from the team library? It is gone for everyone, straight away." && t.of("library_remove").length===0);
  await p.click('button[data-act="lib-remove-no"]'); await p.waitForTimeout(100);
  ok("Keep it: nothing removed", !(await p.$("#libConfirm")) && t.of("library_remove").length===0 && Object.keys(await t.lib()).length===1);
  await p.click('#libSaved button[data-act="lib-remove"]'); await p.waitForTimeout(100);
  await p.click('button[data-act="lib-remove-yes"]'); await p.waitForTimeout(300);
  ok("removed by its saver (a reader): gone from the table, Save offered again", same(t.of("library_remove").map(c=>c.body),[{action:"library_remove", id:"e1"}]) && same(await t.lib(),{}) && (await t.txt("#libRemoved"))==="Removed from the team library. It is gone for everyone." && await p.isVisible('button[data-act="lib-open-form"]'));
  await t.ctx.close();

  // ----- the list: newest first, search, Show more -----
  const many=Array.from({length:12},(_,i)=>libRow("m"+String(i).padStart(2,"0"),{title:"Library entry "+(i+1), saved_at:new Date(Date.parse("2026-11-12T10:00:00Z")-i*DAYMS).toISOString(),
    tags:i===2?["Georgia"]:["Florida"], search_text:("library entry "+(i+1)+" which carriers file "+(i===2?"georgia tarrow mutual insurance co":"florida calloway home co")).toLowerCase()}));
  t=await open({seed:many, users:USERS}, {panel:true}); p=t.p;
  await t.tab();
  let items=await t.all("#libList .pq");
  ok("Team library: ten, newest first", items.length===10 && items[0]==="Library entry 1" && items[9]==="Library entry 10", items);
  const lq=(await t.libReads()).filter(q=>!q.single).pop();
  ok("the list reads small columns only (never the copied answer), newest first, a page at a time", lq.cols==="id,job_id,title,tags,companies,saved_by,saved_by_name,saved_at,answered_at" && same(lq.ord,["saved_at",false]) && same(lq.range,[0,10]) && !lq.ilikes.length, lq);
  ok("an intro says what it is", (await t.txt("#askLib .intro"))==="Answers colleagues chose to share with everyone who has a login on this site, newest first.");
  await p.click("#libMore"); await p.waitForTimeout(250);
  ok("Show more adds the rest, and goes", (await p.$$("#libList li")).length===12 && !(await p.$("#libMore")) && same((await t.libReads()).pop().range,[10,20]));
  await p.fill("#lib_q","  Tarrow   mutual "); await p.press("#lib_q","Enter"); await p.waitForTimeout(250);
  const sq=(await t.libReads()).pop();
  ok("search: each word must appear in the title, question, tags or companies", same(sq.ilikes,[["search_text","%tarrow%"],["search_text","%mutual%"]]) && same(sq.range,[0,10]) && same(await t.all("#libList .pq"),["Library entry 3"]), sq);
  ok("Clear search is offered", (await t.txt('button[data-act="lib-clear"]'))==="Clear search");
  await p.fill("#lib_q","georgia"); await p.click('button[data-act="lib-search"]'); await p.waitForTimeout(250);
  ok("a tag finds it too", same(await t.all("#libList .pq"),["Library entry 3"]));
  await p.fill("#lib_q","%_ , (x) nothing"); await p.click('button[data-act="lib-search"]'); await p.waitForTimeout(250);
  ok("wildcards and punctuation are taken out of the search", same((await t.libReads()).pop().ilikes,[["search_text","%x%"],["search_text","%nothing%"]]));
  ok("no match: says so plainly", (await t.txt("#libEmpty"))==="Nothing in the team library matches “%_ , (x) nothing”. Try fewer or different words.", await t.txt("#libEmpty"));
  await p.click('button[data-act="lib-clear"]'); await p.waitForTimeout(250);
  ok("Clear search: the whole list again", (await p.$$("#libList li")).length===10 && (await p.inputValue("#lib_q"))==="");
  await p.click("#tabPast"); await p.waitForTimeout(150);
  ok("back to Past answers, and the library tab remembers its list", await p.isVisible("#askPast") && !(await p.$("#askLib")));
  await t.tab();
  await t.shot("library-list-1440.png");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: the list doesn't scroll sideways", await t.noScroll(), await p.evaluate(()=>[document.documentElement.scrollWidth, document.getElementById("askBody").scrollWidth]));
  await t.shot("library-list-390.png");
  await p.setViewportSize({width:480,height:900}); await p.waitForTimeout(150);
  const at480=await p.evaluate(()=>{ const top=sel=>[...document.querySelectorAll(sel)].map(e=>Math.round(e.getBoundingClientRect().top)); const b=document.getElementById("askBody");
    return {page:document.documentElement.scrollWidth<=window.innerWidth, body:!b || b.scrollWidth<=b.clientWidth, sw:[document.documentElement.scrollWidth, b&&b.scrollWidth, b&&b.clientWidth], tabs:top(".libtabs .btn"), search:top(".libsearch > input, .libsearch > .btn:not(.ghost)")}; });
  ok("at the panel's own width (480px) the tabs and search sit on one line each without scrolling", at480.page && at480.body && new Set(at480.tabs).size===1 && Math.max(...at480.search)-Math.min(...at480.search)<6, at480);
  await t.shot("library-list-480.png");
  await t.ctx.close();

  // ----- opening an entry, as a reader who didn't save it -----
  t=await open({seed:[libRow("e2",{title:"Calloway homeowners forms by segment", saved_by:"u2", saved_by_name:"Robin Reader"})], users:USERS, role:"reader"}, {panel:true}); p=t.p;
  await t.tab(); await t.openEntry("e2");
  const oq=(await t.libReads()).pop();
  ok("opening reads that one entry, whole", same(oq.eqs,[["id","e2"]]) && oq.cols==="*" && oq.single, oq);
  ok("headed with the title, its tags, who saved it and when, and when it was answered", (await t.txt("#libHead .lt"))==="Calloway homeowners forms by segment" && (await t.txt("#libSavedBy"))==="Saved to the team library by Robin Reader on 5 Nov. Answered 4 Nov." && same(await t.all("#libHead .libtag"),["Florida","forms"]));
  ok("with a reminder to check figures against the source, and that a follow-up stays private", (await t.txt("#libHead")).includes("The figures are as S&P had them when it was answered: check them against the source before you use them. A follow-up question starts a conversation of your own, which only you can see unless you save it."));
  ok("the question, then the answer exactly as a past answer shows it", (await t.txt("#turn-0 .ccmsg.u"))==="Which carriers file private client forms in Florida?" && (await t.txt(".ans p >> nth=0")).startsWith("Yes. Calloway uses separate homeowners forms") && same(await t.all(".ans .cite"),["[1]","[2]","[1]","[2]","[3]"]));
  const src=await p.$$eval(".srcs li",l=>l.map(x=>({t2:(x.querySelector(".t2")||{}).textContent, btn:(x.querySelector("button")||{}).textContent})));
  ok("its sources with the cited pages", same(src.map(s=>s.btn),["Open at page 3","Open at page 7","Open document"]) && src[0].t2==="Calloway Insurance Co · FL · CALL-134000001 · pages 3-4", src);
  ok("its table, export and copy buttons, and the model", (await p.$$(".anstable tbody tr")).length===RESULT.table.rows.length && same(await t.all(".ansacts button"),["Export answer","Copy answer"]) && (await t.txt(".ccmsg.done .look")).includes(`Model: ${RESULT.model}.`));
  ok("no cost line: the library keeps no cost", !(await t.txt(".ccmsg.done .look")).includes("cost"));
  ok("a reader who didn't save it gets no Edit or Remove, and no Save (it is already shared)", !(await p.$('[data-act="lib-edit"]')) && !(await p.$('[data-act="lib-remove"]')) && !(await p.$('[data-act="lib-open-form"]')));
  await p.click("#src-0-1 button"); await p.waitForTimeout(300);
  ok("a source opens its document through the usual document action", same(t.of("document").map(c=>c.body),[{action:"document",documentId:880001}]) && await p.evaluate(()=>/^blob:.+#page=3$/.test(__opened[0].location.href)));
  const csv=await t.download(()=>p.click('.anstable button[data-fmt="csv"]'));
  ok("the table exports", csv.name==="snl-answer-table-2026-11-13.csv" && csv.size>0);
  await p.$eval("#askBody",e=>{ e.scrollTop=0; });
  await t.shot("library-opened-1440.png");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: an opened entry doesn't scroll sideways", await t.noScroll());
  await p.$eval("#askBody",e=>{ e.scrollTop=0; });
  await t.shot("library-opened-390.png");
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(100);

  // ----- following it up: a private conversation of the reader's own -----
  await t.say("And which of them changed rates since?");
  const ab=t.of("ask")[0].body;
  ok("the follow-up carries the entry as one labelled turn of history, bounded as any other", same(ab.history,[{question:"(A colleague's question, saved in the team library) Which carriers file private client forms in Florida?", answer:answerText(RESULT)}]) && ab.question==="And which of them changed rates since?", ab);
  ok("nothing is saved to the library by following up", t.of("library_save").length===0 && Object.keys(await t.lib()).length===1);
  ok("the way back to the list goes once the conversation grows", !(await p.$('[data-act="lib-back"]')));
  await t.mock(()=>{ __mock.setJob("job-new-1",{owner:"u1", status:"done", question:"And which of them changed rates since?", result:{answer:[{text:"Two of them did.",cites:[]}], sources:[], table:null}}); });
  await p.waitForTimeout(500);
  ok("the follow-up's answer is the reader's own: it offers Save to team library", (await t.txt("#turn-1 .ans"))==="Two of them did." && await p.isVisible('#turn-1 button[data-act="lib-open-form"]'), await t.txt("#turn-1"));
  await t.ctx.close();

  // ----- editing and removing: the saver, Corp Dev, an entry removed while open -----
  t=await open({seed:[libRow("e3",{title:"Saved by me", saved_by:"u1", saved_by_name:"Corp Dev 1"}), libRow("e4",{title:"Saved by Robin", saved_at:"2026-11-04T10:00:00Z"})], users:USERS, role:"reader"}, {panel:true}); p=t.p;
  await t.tab(); await t.openEntry("e3");
  ok("the saver (a reader) may edit and remove their entry", same(await t.all("#libHead .inline button"),["Edit title and tags","Remove from library"]));
  await p.click('[data-act="lib-edit"]'); await p.waitForTimeout(100);
  ok("Edit: the form with the current title and tags, no sharing notice (it is already shared)", (await t.txt("#libFormH"))==="Edit title and tags" && (await p.inputValue("#lib_title"))==="Saved by me" && (await p.inputValue("#lib_tags"))==="Florida, forms" && !(await p.$("#libNotice")) && (await t.txt('[data-act="lib-save"]'))==="Save changes");
  await p.fill("#lib_title","Renamed by me"); await p.fill("#lib_tags","Florida"); await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("saved: library_update with the new title and tags, and the heading follows", same(t.of("library_update").map(c=>c.body),[{action:"library_update", id:"e3", title:"Renamed by me", tags:["Florida"]}]) && (await t.txt("#libHead .lt"))==="Renamed by me" && same(await t.all("#libHead .libtag"),["Florida"]) && (await t.lib()).e3.title==="Renamed by me");
  await p.click('[data-act="lib-back"]'); await p.waitForTimeout(300);
  ok("Back to team library: the list, with the new title", (await t.all("#libList .pq"))[0]==="Renamed by me");
  await t.openEntry("e4");
  ok("a reader can't edit or remove someone else's entry", !(await p.$('[data-act="lib-edit"]')) && !(await p.$('[data-act="lib-remove"]')));
  await t.ctx.close();

  t=await open({seed:[libRow("e5",{title:"Robin's entry"}), libRow("e6",{title:"Another of Robin's", saved_at:"2026-11-04T10:00:00Z"})], users:USERS}, {panel:true}); p=t.p;
  await t.tab(); await t.openEntry("e5");
  ok("Corp Dev may edit and remove anyone's entry", same(await t.all("#libHead .inline button"),["Edit title and tags","Remove from library"]));
  await p.click('[data-act="lib-remove"]'); await p.waitForTimeout(100);
  await p.click('[data-act="lib-remove-yes"]'); await p.waitForTimeout(300);
  ok("removed by Corp Dev: gone for everyone; the copy on screen stays readable", same(Object.keys(await t.lib()),["e6"]) && (await t.txt("#libRemoved"))==="Removed from the team library. It is gone for everyone." && !(await p.$('[data-act="lib-edit"]')) && (await p.$$(".srcs li")).length===3);
  await p.click('[data-act="lib-back"]'); await p.waitForTimeout(300);
  ok("and the list no longer holds it", same(await t.all("#libList .pq"),["Another of Robin's"]));
  await t.openEntry("e6");
  await t.mock(()=>{ delete __mock.store.snl_library.e6; });   // someone else removes it meanwhile
  await p.click('[data-act="lib-edit"]'); await p.waitForTimeout(100); await p.fill("#lib_title","Too late"); await p.click('[data-act="lib-save"]'); await p.waitForTimeout(300);
  ok("removed while open, then edited: says it is gone, and it can still be read and followed up", (await t.txt("#libRemoved"))==="This entry is no longer in the team library: someone removed it. You can still read it here and follow it up." && !(await p.$("#libForm")) && await p.isEnabled('button[data-act="ask-send"]'));
  await t.ctx.close();
  t=await open({seed:[libRow("e7",{title:"Removed meanwhile"})], users:USERS}, {panel:true}); p=t.p;
  await t.tab(); await t.openEntry("e7");
  await t.mock(()=>{ delete __mock.store.snl_library.e7; });
  await p.click('[data-act="lib-remove"]'); await p.waitForTimeout(100); await p.click('[data-act="lib-remove-yes"]'); await p.waitForTimeout(300);
  ok("removed while open, then removed again: says it was already gone", (await t.txt("#libRemoved"))==="This entry is no longer in the team library: someone removed it. You can still read it here and follow it up.", await t.txt("#libHead"));
  await t.ctx.close();
  t=await open({seed:[libRow("e8",{title:"Gone before opening"})], users:USERS}, {panel:true}); p=t.p;
  await t.tab();
  await t.mock(()=>{ delete __mock.store.snl_library.e8; });
  await t.openEntry("e8");
  ok("a list item removed before it is opened: says so, and drops it from the list", (await t.txt("#libOpenErr"))==="That entry is no longer in the team library. Someone may have removed it." && !(await p.$("#askLog")) && (await t.txt("#libEmpty")).startsWith("Nothing in the team library yet."));
  await t.ctx.close();

  // ----- not ready: the migration not run -----
  for(const role of ["corpdev","reader"]){
    t=await open({seed:[row("job-c")], noLibrary:true, role}, {panel:true}); p=t.p;
    await t.tab();
    const want = role==="corpdev" ? "The team library isn't set up yet, so answers can't be shared. To set it up, run supabase/migrations/0007_answer_library.sql in the Supabase SQL editor (see the README). Everything else here works as before."
      : "The team library isn't set up yet, so answers can't be shared. Ask Corp Dev to set it up. Everything else here works as before.";
    ok(`migration not run (${role}): the library tab says so and what to do`, (await t.txt("#libMissing"))===want && !(await p.$("#lib_q")), await t.txt("#askLib"));
    await p.click("#tabPast"); await p.waitForTimeout(150); await t.openPast("job-c");
    ok(`migration not run (${role}): no Save button under an answer, the same note instead, and the answer works`, (await t.txt("#libMissingNote"))===want && !(await p.$('[data-act="lib-open-form"]')) && (await p.$$(".srcs li")).length===3);
    await t.say("Follow-up still works?");
    ok(`migration not run (${role}): asking still works`, t.of("ask").length===1);
    await t.ctx.close();
  }

  // ----- not ready: the function not redeployed; saving fails; the cap; the session ends -----
  t=await open({seed:[row("job-d")]}, {panel:true}); p=t.p;
  t.libFn=async()=>({status:400, body:{error:"bad", message:"Unknown action. Use ask or continue."}});
  await t.openPast("job-d"); await p.click('[data-act="lib-open-form"]'); await p.waitForTimeout(100); await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("function not redeployed (Corp Dev): the form says exactly what to run", (await t.txt("#libFormErr"))==="Saving to the team library needs the latest questions function. Run: supabase functions deploy snl-chat --no-verify-jwt (see the README), then try again." && await p.isEnabled('[data-act="lib-save"]'));
  t.libFn=async()=>({status:500, body:{error:"server", message:"The chat function failed: database unavailable. Try again. If it keeps happening, tell Corp Dev."}});
  await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("saving fails: the reason, the form kept to try again", (await t.txt("#libFormErr"))==="The chat function failed: database unavailable. Try again. If it keeps happening, tell Corp Dev." && await p.isVisible("#libForm") && (await p.inputValue("#lib_title")).length>0);
  t.libFn=async()=>({status:409, body:{error:"library_full", message:"The team library is full: it holds 500 answers. Corp Dev can remove old entries to make room, then save this one again."}});
  await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("the library is full: says so and what to do", (await t.txt("#libFormErr"))==="The team library is full: it holds 500 answers. Corp Dev can remove old entries to make room, then save this one again.");
  t.libFn=async()=>({status:413, body:{error:"too_large", message:"This answer is too long for the team library (210 KB; the most is 150 KB). Use Export answer to share it as a Word document instead."}});
  await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("too long for the library: says so", (await t.txt("#libFormErr")).startsWith("This answer is too long for the team library"));
  t.libFn=async()=>({status:404, body:{}});
  await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("the function not deployed at all: the usual deploy message", (await t.txt("#libFormErr"))==="The questions function isn't deployed yet. Run: supabase functions deploy snl-chat --no-verify-jwt (see the README).", await t.txt("#libFormErr"));
  t.libFn=async()=>({status:503, body:{error:"library_missing", message:"The team library isn't set up yet."}});
  await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("the migration not run, found on saving: the note replaces the form", (await t.txt("#libMissingNote")).startsWith("The team library isn't set up yet") && !(await p.$("#libForm")));
  await t.ctx.close();

  t=await open({seed:[row("job-r")], role:"reader"}, {panel:true}); p=t.p;
  t.libFn=async()=>({status:400, body:{error:"bad", message:"Unknown action. Use ask or continue."}});
  await t.openPast("job-r"); await p.click('[data-act="lib-open-form"]'); await p.waitForTimeout(100); await p.click('[data-act="lib-save"]'); await p.waitForTimeout(250);
  ok("function not redeployed (reader): ask Corp Dev", (await t.txt("#libFormErr"))==="Saving to the team library isn't switched on yet. Ask Corp Dev to update the site.");
  await t.ctx.close();

  t=await open({seed:[row("job-s")]}, {panel:true}); p=t.p;
  await t.openPast("job-s"); await p.click('[data-act="lib-open-form"]'); await p.waitForTimeout(100);
  await t.mock(()=>{ __mock.signedOut=true; });
  await p.click('[data-act="lib-save"]'); await p.waitForTimeout(300);
  ok("the session ended before Save: back to sign-in, nothing sent, nothing saved", await p.isVisible("#loginForm") && t.of("library_save").length===0 && same(await t.lib(),{}) && (await t.txt(".login .err"))==="Your session ended. Sign in again.");
  await t.ctx.close();
  t=await open({seed:[row("job-s2")]}, {panel:true}); p=t.p;
  t.libFn=async()=>({status:401, body:{error:"signin", message:"Sign in again."}});
  await t.openPast("job-s2"); await p.click('[data-act="lib-open-form"]'); await p.waitForTimeout(100); await p.click('[data-act="lib-save"]'); await p.waitForTimeout(300);
  ok("the session ends while saving: back to sign-in with the reason", await p.isVisible("#loginForm") && (await t.txt(".login .err"))==="Sign in again." && !(await p.$("#askPanel")));
  await t.ctx.close();
  t=await open({seed:[libRow("e9")]}, {panel:true}); p=t.p;
  await t.tab(); await t.mock(()=>{ __mock.signedOut=true; });
  await t.openEntry("e9");   // reading needs no function call; the page signs out only when a function says so
  await p.click('[data-act="lib-remove"]').catch(()=>{}); await p.waitForTimeout(100); await p.click('[data-act="lib-remove-yes"]').catch(()=>{}); await p.waitForTimeout(300);
  ok("the session ended before Remove: back to sign-in, nothing removed", await p.isVisible("#loginForm") && t.of("library_remove").length===0);
  await t.ctx.close();

  // ----- the list fails to load -----
  t=await open({seed:[libRow("f1"), row("job-f")]}, {panel:true}); p=t.p;
  await t.mock(()=>{ __mock.failLibrary=true; });
  await t.tab();
  ok("can't load: says so with Try again, and Past answers still work", (await t.txt("#libErr span"))==="Couldn't load the team library. Check your connection and try again." && (await p.getAttribute("#libErr","role"))==="alert" && await p.isVisible("#lib_q"));
  await p.click("#tabPast"); await p.waitForTimeout(100);
  ok("the Past answers tab is unaffected", (await p.$$("#pastList li")).length===1);
  await t.openPast("job-f");
  ok("an answer opens, and its Save button still offers itself when the check failed", await p.isEnabled('[data-act="lib-open-form"]'));
  await p.click('button[data-act="ask-new"]'); await p.waitForTimeout(150);
  await t.tab();
  ok("still failing when the tab is shown again: the problem again", await p.isVisible("#libErr"));
  await t.mock(()=>{ __mock.failLibrary=false; });
  await p.click('[data-act="lib-retry"]'); await p.waitForTimeout(250);
  ok("Try again loads it", !(await p.$("#libErr")) && (await p.$$("#libList li")).length===1);
  await p.setViewportSize({width:390,height:844}); await t.mock(()=>{ __mock.failLibrary=true; });
  await p.click('[data-act="lib-search"]'); await p.waitForTimeout(250);
  ok("phone: the problem doesn't scroll sideways", await p.isVisible("#libErr") && await t.noScroll());
  await t.ctx.close();

  // ----- an empty library -----
  t=await open({}, {panel:true}); p=t.p;
  await t.tab();
  ok("an empty library says how to add to it", (await t.txt("#libEmpty"))==="Nothing in the team library yet. To share a good answer, open it and choose Save to team library.");
  await t.ctx.close();

  // ----- hostile text from other people -----
  const EVIL='<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  const evilAnswer={answer:[{text:EVIL+" **bold** answer", cites:[1]}], sources:[{n:1, documentId:880001, filingVersionId:null, title:EVIL, company:EVIL, state:"FL", trackingNumber:EVIL, pages:"2", startPage:2, quote:EVIL}],
    table:{title:EVIL, columns:[EVIL,"B"], rows:[[EVIL,"x"]], notes:[EVIL]}, caps:[EVIL], lookups:[{tool:"search_filings", detail:EVIL}]};
  t=await open({seed:[libRow("h1",{title:EVIL+" title", question:EVIL+" question", tags:[EVIL,"ok"], saved_by_name:EVIL, answer:evilAnswer, model:EVIL})], users:USERS}, {panel:true}); p=t.p;
  await t.tab();
  ok("hostile title, tags and name in the list stay text", (await t.txt("#libList .pq"))===EVIL+" title" && (await t.all("#libList .libtag"))[0]===EVIL && (await t.txt("#libList .t2")).startsWith("Saved by "+EVIL) && (await p.$$("#askLib img,#askLib script")).length===0);
  await t.openEntry("h1");
  ok("an opened hostile entry: every part stays text, nothing runs", (await p.$$("#askBody img,#askBody script")).length===0 && await p.evaluate(()=>window.__xss===undefined) && (await t.txt("#libHead .lt"))===EVIL+" title" && (await t.txt("#turn-0 .ccmsg.u"))===EVIL+" question" && (await t.txt("#libSavedBy")).includes("by "+EVIL+" on") && (await t.txt(".srcs li .t1"))===EVIL && (await t.txt(".anstable h3"))===EVIL);
  await p.click('[data-act="lib-edit"]'); await p.waitForTimeout(100);
  ok("in the edit form too, as values", (await p.inputValue("#lib_title"))===EVIL+" title" && (await p.$$("#libForm img,#libForm script")).length===0);
  await p.click('[data-act="lib-cancel"]'); await p.waitForTimeout(100);
  await t.say("Follow up");
  const hb=t.of("ask")[0].body.history;
  ok("sent back to Claude as text, labelled as a colleague's question, within the usual bounds", hb.length===1 && hb[0].question==="(A colleague's question, saved in the team library) "+EVIL+" question" && hb[0].answer===EVIL+" **bold** answer");
  ok("no page errors", errs.length===0, errs);
  await t.ctx.close();
  // a very long entry goes back as history cut to what the function accepts
  const longQ="q".repeat(4000), longA={...copy(libRow("x")[2].answer), answer:[{text:"y".repeat(30000), cites:[]}]};
  t=await open({seed:[libRow("l1",{question:longQ, answer:longA})]}, {panel:true}); p=t.p;
  await t.tab(); await t.openEntry("l1"); await t.say("Shorter?");
  const lh=t.of("ask")[0].body.history[0];
  ok("a very long entry goes as history no longer than a question and 20,000 characters of answer", lh.question.length===4000 && lh.question.startsWith("(A colleague's question") && lh.answer.length===20000);
  await t.ctx.close();

  // ----- the save form at 390px -----
  t=await open({seed:[row("job-p",{question:"Which Calloway companies file separate homeowners forms in Florida for private clients, and since when?"})]}, {panel:true, width:390}); p=t.p;
  await t.openPast("job-p"); await p.click('[data-act="lib-open-form"]'); await p.waitForTimeout(150);
  await p.fill("#lib_tags","Florida, homeowners, private client");
  ok("phone: the save form doesn't scroll sideways, and its boxes fit", await t.noScroll() && await p.evaluate(()=>{ const f=document.getElementById("libForm").getBoundingClientRect(); return [...document.querySelectorAll("#libForm input,#libForm button")].every(e=>{ const r=e.getBoundingClientRect(); return r.left>=f.left-1 && r.right<=f.right+1; }); }));
  await p.$eval("#libForm",e=>e.scrollIntoView({block:"center"}));
  await t.shot("library-form-390.png");
  await t.ctx.close();

  ok("no page errors anywhere", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
