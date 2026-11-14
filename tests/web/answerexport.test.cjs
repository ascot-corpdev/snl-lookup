// Taking a whole answer away from the Ask Claude panel: "Export answer" (one Word document, made by the docx library
// loaded on the first click) and "Copy answer" (rich text with a plain-text alternative). Checks the buttons appear
// only on a finished answer, the library loads once, what the page hands the library, what goes on the clipboard,
// that hostile text stays text, the answer with no table or no sources, a refused clipboard, the file name, and
// the panel at 480px and the phone sheet at 390px. The docx library is a small stand-in: no network.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), JOB=FIX("web_ask_result.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const DOCX_URL="https://cdn.jsdelivr.net/npm/docx@9.5.1/dist/index.iife.min.js";
// The stand-in records what each constructor is given; Packer.toBlob hands back the whole tree as JSON.
const FAKE_DOCX='(function(){ const mk=type=>function(o){ return Object.assign({type},o); }; window.docx={Document:mk("Document"),Paragraph:mk("Paragraph"),TextRun:mk("TextRun"),Table:mk("Table"),TableRow:mk("TableRow"),TableCell:mk("TableCell"),'
  +'HeadingLevel:{HEADING_2:"Heading2"},WidthType:{PERCENTAGE:"pct"},ShadingType:{CLEAR:"clear"},Packer:{toBlob:d=>Promise.resolve(new Blob([JSON.stringify(d)],{type:"application/json"}))}}; })();';
const NOW=Date.parse("2026-11-13T12:00:00Z");
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(width=1440){
    const ctx=await b.newContext({viewport:{width,height:width<500?844:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date(NOW));
    const t={p, ctx, jobs:0, docxLoads:0, docxFail:false};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}");
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev", claude:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-chat" && body.action==="ask") return J(202,{jobId:"job-"+(++t.jobs)});
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===DOCX_URL){ t.docxLoads++; return t.docxFail ? r.fulfill({status:404,body:""}) : r.fulfill({contentType:"application/javascript",body:FAKE_DOCX}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    // a clipboard that keeps what it is given, or refuses like a browser without permission
    await p.addInitScript(()=>{ window.__clip=null; window.__clipRefuse=false;
      Object.defineProperty(navigator,"clipboard",{configurable:true,value:{write:async items=>{ if(window.__clipRefuse) throw new DOMException("Write permission denied.","NotAllowedError");
        const it=items[0]; window.__clip={types:[...it.types], html:await (await it.getType("text/html")).text(), text:await (await it.getType("text/plain")).text()}; }}}); });
    await p.goto(BASE+"#filings"); await p.waitForTimeout(450);
    await p.evaluate(()=>{ TIMING.poll=100; });
    await p.click("#askFab"); await p.waitForTimeout(120);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.job=async(id,patch)=>{ await p.evaluate(([i,pa])=>{ __mock.setJob(i,pa); },[id,patch]); await p.waitForTimeout(300); };
    t.say=async q=>{ await p.fill("#ask_input",q); await p.click('button[data-act="ask-send"]'); await p.waitForTimeout(250); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    t.noScroll=async()=>p.evaluate(()=>{ const b=document.getElementById("askBody"); return document.documentElement.scrollWidth<=window.innerWidth && (!b || b.scrollWidth<=b.clientWidth); });
    return t;
  }
  // The document tree as lines: "H <heading>", a paragraph's text ("• " in front of a bullet), or {table:[[cells]]}.
  const kids=doc=>doc.sections[0].children;
  const runText=p=>p.text!==undefined ? p.text : p.children.map(x=>x.text).join("");
  const flat=doc=>kids(doc).map(c=>c.type==="Table" ? {table:c.rows.map(r=>r.children.map(cell=>cell.children.map(runText).join("")))} : c.heading ? "H "+c.text : (c.bullet?"• ":"")+runText(c));
  const bolds=c=>c.children.filter(x=>x.bold).map(x=>x.text);

  const Q1="Which Calloway companies filed homeowners forms in Florida since 2021?";
  // the fixture answer, with limit notes, a citation to a source that isn't listed, and hostile text in every part
  const RESULT=copy(JOB.result);
  RESULT.answer.push({text:"One more point <script>window.__xss=1</script> with no source listed.", cites:[9]});
  RESULT.sources.push({n:4, documentId:880009, filingVersionId:null, title:"<script>window.__xss=1</script>", company:"Calloway <b>Home</b> Co", state:"FL", trackingNumber:"CALL-134000009", pages:"2, 5", startPage:2, quote:'<img src=x onerror="window.__xss=1">'});
  RESULT.table.rows.push(["<script>window.__xss=1</script>", "", null, "Private client", "=1+2", "CALL-134000009"]);
  RESULT.caps=["Claude stopped at the limit of 12 lookups for one question, so the answer may be incomplete.", "<b>Second notice</b>"];
  const ASKED="Asked 13 Nov 2026 at 12:00", FOOT="Data from S&P Global Market Intelligence. Check figures against the source before you use them.";
  const ANSWER_LINES=[
    "**Yes.** Calloway uses separate homeowners forms for its two customer groups in Florida. [1][2]",
    "- **Middle market:** form CAL-HO3-MM (06 25), filed by Calloway Insurance Co, effective 1 Jan 2026. [1]",
    "- **Private client:** form CAL-HO5-PC (03 25), filed by Calloway Home Co, effective 1 Oct 2025. [2]",
    "Tarrow Mutual Insurance Co files one homeowners form for all customers. [3]",
    "One more point <script>window.__xss=1</script> with no source listed. [9]"];
  const unbold=s=>s.replace(/\*\*/g,"");
  const ROWS=[RESULT.table.columns].concat([...JOB.result.table.rows, ["<script>window.__xss=1</script>", "n/d", "n/d", "Private client", "=1+2", "CALL-134000009"]]);
  const SOURCES=[
    "[1] Homeowners HO-3 middle market policy form", "Calloway Insurance Co · FL · CALL-134000001 · pages 3-4", "“This form applies to dwellings insured under the Calloway middle market program.”",
    "[2] Homeowners HO-5 private client policy form", "Calloway Home Co · FL · CALL-134000002 · page 7", "“Private client: for dwellings with a replacement cost of $1,500,000 or more.”",
    "[3] Homeowners policy form", "Tarrow Mutual Insurance Co · FL · TARR-134000777",
    "[4] <script>window.__xss=1</script>", "Calloway <b>Home</b> Co · FL · CALL-134000009 · pages 2, 5", '“<img src=x onerror="window.__xss=1">”'];

  // ----- the buttons: only on a finished answer -----
  let t=await open(); let p=t.p;
  await t.say(Q1); await t.job("job-1",{status:"running", progress:[{at:"2026-11-13T12:00:05Z", text:"Searching S&P filings"}]});
  ok("a running answer has no export or copy", !!(await p.$(".ccmsg.run")) && !(await p.$('[data-act="answer-export"],[data-act="answer-copy"]')));
  await t.job("job-1",{status:"done", partial:null, result:RESULT});
  const acts=await p.$$eval("#turn-0 .ansacts button",l=>l.map(x=>x.textContent));
  ok("a finished answer has Export answer and Copy answer", same(acts,["Export answer","Copy answer"]), acts);
  ok("the controls sit after the sources", await p.evaluate(()=>{ const s=document.querySelector("#turn-0 .srcs"), a=document.querySelector("#turn-0 .ansacts"); return !!(s.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); }));
  ok("a freshly asked answer is not labelled as a saved answer", !(await p.$(".turn .asked")));
  ok("the Word library isn't fetched before it is needed", t.docxLoads===0 && await p.evaluate(()=>window.docx===undefined));
  ok("the table's own CSV and XLSX buttons are still there", same(await p.$$eval(".anstable .blk-h button",l=>l.map(x=>x.textContent)),["Export CSV","Export XLSX"]));
  ok("panel at 480px: the buttons fit without sideways scroll", await t.noScroll() && await p.evaluate(()=>{ const pr=document.getElementById("askPanel").getBoundingClientRect(); return [...document.querySelectorAll(".ansacts button,.anstable .blk-h button")].every(x=>{ const r=x.getBoundingClientRect(); return r.left>=pr.left && r.right<=pr.right; }); }));

  // ----- Export answer: one Word document -----
  let dl=await t.download(()=>p.click('#turn-0 [data-act="answer-export"]')); let doc=JSON.parse(dl.text);
  ok("the file name is plain and dated", dl.name==="snl-answer-2026-11-13.docx", dl.name);
  ok("the library was loaded once, on the first click", t.docxLoads===1);
  const want=["H Question", Q1, ASKED, "H Answer", ...ANSWER_LINES.map(l=>unbold(l).replace(/^- /,"• ")),
    "H Homeowners form filings in Florida", {table:ROWS}, RESULT.table.notes[0],
    "H Limits reached", ...RESULT.caps, "H Sources", ...SOURCES, FOOT];
  ok("the document, in order: question, date asked, answer, table, notes, limits, sources, a closing line", same(flat(doc),want), flat(doc));
  const ks=kids(doc);
  ok("headings are Word headings", ks.filter(c=>c.heading).every(c=>c.heading==="Heading2") && ks.filter(c=>c.heading).length===5);
  ok("bold is kept where Claude marked it, and nowhere else in the answer", same(bolds(ks[4]),["Yes."]) && same(bolds(ks[5]),["Middle market:"]) && same(bolds(ks[6]),["Private client:"]) && same(bolds(ks[7]),[]) && same(bolds(ks[8]),[]));
  ok("bullets are Word bullets; other lines are not", same(ks.slice(4,9).map(c=>!!c.bullet),[false,true,true,false,false]) && same(ks[5].bullet,{level:0}));
  ok("citation markers end their line", ks[4].children.slice(-1)[0].text===" [1][2]" && ks[8].children.slice(-1)[0].text===" [9]");
  const tbl=ks.find(c=>c.type==="Table");
  ok("the table is a real table, full width, with a repeating bold header row", tbl.width.type==="pct" && tbl.width.size===100 && tbl.rows[0].tableHeader===true && tbl.rows[0].children.every(c=>c.children[0].children[0].bold===true) && tbl.rows.length===5 && tbl.columnWidths.length===6);
  ok("a cell starting with = is passed as plain text", tbl.rows[4].children[4].children[0].children[0].text==="=1+2");
  ok("the date asked comes from when the question was asked", ks[2].children[0].text===ASKED);
  ok("hostile text goes to the library as text", ks[8].children[0].text.includes("<script>window.__xss=1</script>") && JSON.stringify(doc).includes("Calloway <b>Home</b> Co") && await p.evaluate(()=>window.__xss===undefined));
  ok("the page is letter size with one inch margins", same(doc.sections[0].properties.page,{size:{width:12240,height:15840},margin:{top:1440,right:1440,bottom:1440,left:1440}}));
  dl=await t.download(()=>p.click('#turn-0 [data-act="answer-export"]'));
  ok("a second export doesn't load the library again", t.docxLoads===1 && dl.name==="snl-answer-2026-11-13.docx");

  // ----- Copy answer: rich text with a plain-text alternative -----
  await p.click('#turn-0 [data-act="answer-copy"]'); await p.waitForTimeout(200);
  const clip=await p.evaluate(()=>window.__clip);
  ok("copy says it worked", (await t.txt("#toastRoot"))==="Answer copied. Paste it into an email or a document.");
  ok("the clipboard gets HTML and plain text", same(clip.types,["text/html","text/plain"]), clip.types);
  const parsed=await p.evaluate(h=>{ const d=new DOMParser().parseFromString(h,"text/html");
    return {heads:[...d.querySelectorAll("h3")].map(x=>x.textContent), ps:[...d.querySelectorAll("p")].map(x=>x.textContent), lis:[...d.querySelectorAll("li")].map(x=>x.textContent), uls:d.querySelectorAll("ul").length,
      b:[...d.querySelectorAll("p b, li b")].map(x=>x.textContent), rows:[...d.querySelectorAll("table tr")].map(r=>[...r.children].map(c=>c.textContent)), th:d.querySelectorAll("thead th").length,
      bad:d.querySelectorAll("script,img,style,iframe,[onerror]").length}; }, clip.html);
  ok("copied HTML: the same headings", same(parsed.heads,["Question","Answer","Homeowners form filings in Florida","Limits reached","Sources"]), parsed.heads);
  ok("copied HTML: answer paragraphs, one bullet list, bold kept", same(parsed.lis,ANSWER_LINES.slice(1,3).map(l=>unbold(l).slice(2))) && parsed.uls===1 && parsed.ps.includes(unbold(ANSWER_LINES[0])) && parsed.b.slice(0,3).join("|")==="Yes.|Middle market:|Private client:", parsed);
  ok("copied HTML: the table is a table", same(parsed.rows,ROWS) && parsed.th===6, parsed.rows);
  ok("copied HTML: question, date, notes, limits, sources and the closing line", parsed.ps[0]===Q1 && parsed.ps[1]===ASKED && parsed.ps.includes(RESULT.table.notes[0]) && parsed.ps.includes("<b>Second notice</b>") && parsed.ps.includes(SOURCES.slice(0,3).join("")) && parsed.ps.slice(-1)[0]===FOOT, parsed.ps);
  ok("copied HTML: hostile text stays text", parsed.bad===0 && clip.html.includes("&lt;script&gt;window.__xss=1&lt;/script&gt;") && clip.html.includes("Calloway &lt;b&gt;Home&lt;/b&gt; Co") && !clip.html.includes("<script") && !clip.html.includes("<img"));
  const text=["Question", Q1, ASKED, "", "Answer", ...ANSWER_LINES.map(unbold), "", "Homeowners form filings in Florida", ...ROWS.map(r=>r.join("\t")), RESULT.table.notes[0],
    "", "Limits reached", ...RESULT.caps, "", "Sources", ...SOURCES.map(s=>s.startsWith("[")?s:"    "+s), "", FOOT].join("\n");
  ok("copied plain text: the same parts, the table as tab-separated rows", clip.text===text, clip.text);
  await p.evaluate(()=>{ window.__clipRefuse=true; }); await p.click('#turn-0 [data-act="answer-copy"]'); await p.waitForTimeout(200);
  ok("a refused clipboard says so and suggests the export", (await t.txt("#toastRoot"))==="Your browser didn't allow copying. Use Export answer to download it as a Word document instead.");
  await p.evaluate(()=>{ window.__clipRefuse=false; });

  // ----- an answer with no table and no sources -----
  await t.say("And Tarrow?"); await t.job("job-2",{status:"done", partial:null, result:{answer:[{text:"Tarrow files one form.\n- **No** separate segments", cites:[]}], sources:[], table:null, lookups:[], caps:[]}});
  ok("a follow-up answer has its own controls", (await p.$$('[data-act="answer-export"]')).length===2 && !!(await p.$('#turn-1 [data-act="answer-export"]')));
  dl=await t.download(()=>p.click('#turn-1 [data-act="answer-export"]')); doc=JSON.parse(dl.text);
  ok("no table and no sources: the document leaves those parts out", same(flat(doc),["H Question","And Tarrow?",ASKED,"H Answer","Tarrow files one form.","• No separate segments",FOOT]), flat(doc));
  await p.click('#turn-1 [data-act="answer-copy"]'); await p.waitForTimeout(200);
  const clip2=await p.evaluate(()=>window.__clip);
  ok("no table and no sources: the copy leaves them out too", !clip2.html.includes("<table") && !clip2.html.includes("Sources") && !clip2.html.includes("Limits") && clip2.text==="Question\nAnd Tarrow?\n"+ASKED+"\n\nAnswer\nTarrow files one form.\n- No separate segments\n\n"+FOOT, clip2.text);
  ok("only a table, no sources: the table stays", await p.evaluate(()=>{ const m=answerDoc({question:"q", asked:"", result:{answer:[{text:"a"}], table:{title:"T", columns:["A"], rows:[["1"]]}, sources:[]}}); return !!m.table && m.sources.length===0 && !answerClipHTML(m).includes("Sources") && answerClipHTML(m).includes("<table"); }));

  // ----- a failed answer -----
  await t.say("One that fails"); await t.job("job-3",{status:"error", error:"Claude couldn't finish this answer. Ask again."});
  ok("a failed answer has no export or copy", !!(await p.$("#turn-2 .ccmsg.err")) && !(await p.$('#turn-2 [data-act="answer-export"],#turn-2 [data-act="answer-copy"]')));
  ok("no em dashes in the view", !(await p.evaluate(()=>document.body.innerText)).includes("—"));
  await p.$eval("#turn-0 .ansacts",e=>e.scrollIntoView({block:"center"}));
  await p.screenshot({path:OUTDIR+"/answerexport-1440.png"});
  await t.ctx.close();

  // ----- the library doesn't load -----
  t=await open(); p=t.p; t.docxFail=true;
  await t.say(Q1); await t.job("job-1",{status:"done", partial:null, result:RESULT});
  await p.click('#turn-0 [data-act="answer-export"]'); await p.waitForTimeout(300);
  ok("no library: says what happened and what to do", (await t.txt("#toastRoot"))==="Couldn't make the Word document. Check your connection and try again, or use Copy answer." && t.docxLoads===1);
  t.docxFail=false; dl=await t.download(()=>p.click('#turn-0 [data-act="answer-export"]'));
  ok("and it tries again on the next click", t.docxLoads===2 && dl.name==="snl-answer-2026-11-13.docx");
  await t.ctx.close();

  // ----- phone: 390px -----
  t=await open(390); p=t.p;
  await t.say(Q1); await t.job("job-1",{status:"done", partial:null, result:RESULT});
  await p.$eval("#turn-0 .ansacts",e=>e.scrollIntoView({block:"center"}));
  ok("phone: the controls show inside the sheet, with no sideways scroll", await t.noScroll() && await p.evaluate(()=>[...document.querySelectorAll(".ansacts button,.anstable .blk-h button")].every(x=>{ const r=x.getBoundingClientRect(); return r.width>0 && r.left>=0 && r.right<=innerWidth; })));
  ok("phone: the two controls share one row", await p.evaluate(()=>{ const [a,c]=document.querySelectorAll("#turn-0 .ansacts button"); return Math.round(a.getBoundingClientRect().top)===Math.round(c.getBoundingClientRect().top); }));
  await p.screenshot({path:OUTDIR+"/answerexport-390.png"});
  dl=await t.download(()=>p.click('#turn-0 [data-act="answer-export"]'));
  ok("phone: the export works there too", dl.name==="snl-answer-2026-11-13.docx" && flat(JSON.parse(dl.text))[1]===Q1);
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
