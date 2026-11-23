// The Earnings view at #earnings: the seventh tab; the quarter (the latest ended by default) and the companies; Find one
// company at a time with the shared progress bar, Stop and one more try for a company that failed; the table's every
// state in words; Refresh; a row opened to its documents (links to the source in a new tab, hostile titles escaped);
// what is new since the reader's last look; downloads one at a time and as one zip in the script's folders and names,
// with a file too big and a refused source; "not set up yet"; the watchlist for readers and for Corp Dev (pasting the
// script's list, checked entry by entry; add, change, remove; refused by row-level security); 1440px and 390px with no
// sideways scroll. Every company, ticker and address is made up; the function is a stand-in.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path"); const JSZip=require("jszip");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const ZIPJS=fs.readFileSync(path.join(__dirname,"../../node_modules/jszip/dist/jszip.min.js"),"utf8");
const SCRATCH="/tmp/claude-0/-workspace/53a3716b-de6d-55ad-8392-70c70b8d61ed/scratchpad";
const STATUS=JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures/web_status.json"),"utf8"));
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o)), same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

const HOSTILE='<img src=x onerror="window.__pwned=1">';
const CO=(id,name,o={})=>({id, name, ticker:null, otherTickers:[], cik:null, irUrls:[], sec:true, folder:null, fileUrls:{}, ...o});
const WATCH=[
  CO("e-cal","Calloway Insurance Co",{ticker:"CLWY", irUrls:["https://investors.calloway.example/events-and-presentations/default.aspx"], folder:"Calloway"}),
  CO("e-tar","Tarrow Mutual",{ticker:"TRWM", otherTickers:["TRWX"], irUrls:["https://ir.tarrow.example/"]}),
  CO("e-nsh","Nonesuch Holdings plc",{sec:false, irUrls:["https://www.nonesuch.example/investors/results"], fileUrls:{supplement:["https://www.nonesuch.example/ir/{yyyy}/supp-{q}q{yy}.pdf"]}}),
  CO("e-nre","Nonesuch Re Ltd",{ticker:"NSRE"}),
  CO("e-bad",HOSTILE,{ticker:"NOPE", irUrls:["https://js.nonesuch.example/ir"]}),
];
const DOC=(id,col,o={})=>({id, col, type:"10-Q", title:"QUARTERLY REPORT", filed:"2026-11-04", source:"sec", host:"www.sec.gov", url:`https://www.sec.gov/Archives/edgar/data/1999001/x/${id}.htm`, name:`Calloway 3Q26 ${id}`, ext:".htm", page:false, firstSeen:"2026-11-19T10:00:00Z", ...o});
const CELL=(state,docs=[],o={})=>({state, docs, ...o});
const RES=(co,q,o={})=>({v:1, company:{id:co.id, name:co.name, ticker:co.ticker, folder:co.folder||co.name}, quarter:q, q:+q[0], y:2000+ +q.slice(2), madeAt:"2026-11-19T10:00:00Z", cik:null, sec:co.sec!==false, london:co.sec===false,
  cells:{"10q":CELL("not_filed"), "8k":CELL("not_filed"), supplement:CELL("not_found"), deck:CELL("not_found")}, docs:[], pages:[], notes:[], secRequests:3, pagesRead:2, ...o});
function results(q){
  const [cal,tar,nsh,nre,bad]=WATCH;
  return {
    "e-cal":RES(cal,q,{cik:1999001, cells:{"10q":CELL("found",["d10q","dirq"]), "8k":CELL("found",["d8k","d991","d992"]), supplement:CELL("found",["dsupx","dsupp"]), deck:CELL("found",["ddeck"])}, docs:[
      DOC("d10q","10q",{name:"Calloway 3Q26 10-Q"}), DOC("dirq","10q",{source:"ir", host:"investors.calloway.example", type:"10-Q", title:"Form 10-Q", filed:null, url:"https://investors.calloway.example/files/10q.pdf", name:"Calloway 3Q26 10-Q", ext:".pdf"}),
      DOC("d8k","8k",{type:"8-K", title:"FORM 8-K", filed:"2026-10-28", name:"Calloway 3Q26 8-K"}), DOC("d991","8k",{type:"EX-99.1", title:"PRESS RELEASE", filed:"2026-10-28", name:"Calloway 3Q26 8-K Ex 99.1 - PRESS RELEASE"}),
      DOC("d992","8k",{type:"EX-99.2", title:"FINANCIAL SUPPLEMENT", filed:"2026-10-28", ext:".pdf", url:"https://www.sec.gov/Archives/edgar/data/1999001/x/ex992.pdf", name:"Calloway 3Q26 8-K Ex 99.2 - FINANCIAL SUPPLEMENT"}),
      DOC("dsupx","supplement",{source:"ir", host:"investors.calloway.example", type:"Supplement", title:"Financial Supplement (Excel) Q3-2026-Financial-Supplement", filed:null, url:"https://investors.calloway.example/files/supp.xlsx", name:"Calloway 3Q26 Supplement - Q3 2026 Financial Supplement", ext:".xlsx"}),
      DOC("dsupp","supplement",{source:"ir", host:"investors.calloway.example", type:"Supplement", title:"Q3 2026 Financial Supplement", filed:null, url:"https://investors.calloway.example/files/supp.pdf", name:"Calloway 3Q26 Supplement - Q3 2026 Financial Supplement", ext:".pdf"}),
      DOC("ddeck","deck",{source:"ir", host:"investors.calloway.example", type:"Presentation", title:"Third Quarter 2026 Investor Presentation", filed:null, url:"https://investors.calloway.example/files/deck.pdf", name:"Calloway 3Q26 Presentation - Third Quarter 2026 Investor Presentation", ext:".pdf"})]}),
    "e-tar":RES(tar,q,{cik:1999002, cells:{"10q":CELL("not_filed"), "8k":CELL("not_filed"), supplement:CELL("refused",[],{refused:["https://ir.tarrow.example/"]}), deck:CELL("refused",[],{refused:["https://ir.tarrow.example/"]})}}),
    "e-nsh":RES(nsh,q,{cells:{"10q":CELL("not_found",[],{kind:"Report"}), "8k":CELL("found",["dtu"],{kind:"Trading Update"}), supplement:CELL("found",["dns"]), deck:CELL("none_listed")}, docs:[
      DOC("dtu","8k",{source:"ir", host:"www.nonesuch.example", type:"Trading Update (web page)", title:"Q3 Trading Update", filed:null, url:"https://www.nonesuch.example/investors/2026/q3-trading-update", name:"Nonesuch Holdings plc 3Q26 Trading Update - Q3 Trading Update", ext:"", page:true}),
      DOC("dns","supplement",{source:"ir", host:"www.nonesuch.example", type:"Supplement", title:"supp-3q26", filed:null, url:"https://www.nonesuch.example/ir/2026/supp-3q26.pdf", name:"Nonesuch Holdings plc 3Q26 Supplement - supp-3q26", ext:".pdf"})]}),
    "e-nre":RES(nre,q,{cik:1999777, cells:{"10q":CELL("error",[],{note:"The SEC was busy and didn't answer after retries."}), "8k":CELL("not_found_sec"), supplement:CELL("in_8k",["dx"]), deck:CELL("none_listed")}, docs:[DOC("dx","supplement",{type:"EX-99.2", title:"Supplement", name:"Nonesuch Re Ltd 3Q26 6-K Ex 99.2", url:"https://www.sec.gov/x/dx.htm"})]}),
    "e-bad":RES(bad,q,{cells:{"10q":CELL("no_cik",[],{note:"Not found at the SEC by its ticker. Add its CIK to the watchlist."}), "8k":CELL("no_cik"), supplement:CELL("found",["dh"]), deck:CELL("not_found")}, notes:["A page read had almost no links: the site may fill its lists with JavaScript."], docs:[
      DOC("dh","supplement",{source:"ir", host:"js.nonesuch.example", type:"Supplement", title:HOSTILE+" supplement", filed:null, url:"javascript:alert(1)", name:"Bad 3Q26 Supplement", ext:".pdf"})]}),
  };
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=over.ctx || await b.newContext({viewport:{width:over.width||1440,height:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-19T12:00:00Z"));
    const t={p, ctx, calls:[], configured:true, watch:copy(WATCH), problems:[], saved:{}, delay:0, failOnce:{}, failAlways:{},
      findFn:body=>({status:200, body:{result:copy(results(body.quarter)[body.company]), fromStore:false}}),
      dl:body=>{ const r=results(body.quarter)[body.company], d=r&&r.docs.find(x=>x.id===body.doc);
        if(!d) return {status:404, json:{error:"unknown_doc", message:"That document isn't in what was found for this quarter. Find again, then download."}};
        if(d.id==="dsupp") return {status:413, json:{error:"too_big", message:"This file is larger than 60 MB, more than the site passes through. Open it from its link instead."}};
        if(d.id==="dsupx") return {status:502, json:{error:"refused", message:"The company's site refused to hand the file to the app (it answered 403). Open it from its link in your browser."}};
        const ext=d.ext||".htm", type=ext===".pdf"?"application/pdf":ext===".xlsx"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"text/html";
        return {status:200, type, disposition:`attachment; filename="x${ext}"; filename*=UTF-8''${encodeURIComponent(d.name+ext)}`, raw:(ext===".pdf"?"%PDF-1.7 ":"")+"made-up "+d.id}; },
      ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const cors={"access-control-allow-origin":"*","access-control-expose-headers":"content-disposition, content-length"};
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:cors,body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-earnings"){
          const a=body.action;
          if(a==="status") return J(200,{configured:t.configured, companies:t.watch.length, problems:t.problems.length, role:opts.role||"corpdev", quarter:"3Q26"});
          if(a==="list"){ const saved=await p.evaluate(()=>window.__mock.row("snl_settings","earnings_watchlist")).catch(()=>null); if(saved) t.watch=saved.doc.companies; return J(200,{companies:t.watch, problems:t.problems, configured:t.configured}); }
          if(a==="check"){ let raw=body.list; if(typeof raw==="string"){ try{ raw=JSON.parse(raw); }catch{ return J(400,{error:"bad", message:"That isn't JSON the app can read."}); } }
            const list=Array.isArray(raw)?raw:raw&&raw.companies||[], companies=[], problems=[];
            list.forEach((e,i)=>{ if(!e||!e.name){ problems.push({at:i+1, name:"", message:"It has no name.", dropped:true}); return; }
              const ir=(e.ir_urls||e.irUrls||[]).filter(x=>{ const good=/^https:\/\/[a-z0-9.-]+\.[a-z]+\//i.test(x)&&!/127\.0\.0\.1|localhost/.test(x); if(!good) problems.push({at:i+1, name:e.name, message:`The investor page "${x}" can't be used: only https addresses are fetched. It was left out.`, dropped:false}); return good; });
              companies.push(CO(e.id||"e-"+e.name.toLowerCase().replace(/[^a-z0-9]+/g,"").slice(0,20), e.name, {ticker:e.ticker?String(e.ticker).toUpperCase():null, irUrls:ir, sec:e.sec!==false, otherTickers:e.other_tickers||e.otherTickers||[], cik:e.cik||null, folder:e.folder||null})); });
            return J(200,{companies, problems}); }
          if(a==="saved") return J(200,{quarter:body.quarter, results:copy(t.saved[body.quarter]||[])});
          if(a==="find"){ if(t.delay) await new Promise(res=>setTimeout(res,t.delay));
            if(!t.configured) return J(503,{error:"not_configured", message:"Earnings isn't set up yet."});
            if(t.failAlways[body.company] || t.failOnce[body.company]){ t.failOnce[body.company]=false; return J(502,{error:"server", message:"The earnings function failed: the site timed out. Try again."}); }
            const a2=t.findFn(body); return J(a2.status,a2.body); }
          if(a==="download"){ const d=t.dl(body); if(d.json) return J(d.status,d.json); return r.fulfill({status:200, contentType:d.type, headers:{...cors,"content-disposition":d.disposition}, body:d.raw}); }
          return J(400,{error:"bad"}); }
        if(body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        return J(200,{}); }
      if(/jszip/.test(u)) return r.fulfill({contentType:"application/javascript",body:ZIPJS});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+(over.hash||"#earnings")); await p.waitForTimeout(500);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.fn==="snl-earnings" && c.body.action===a).map(c=>c.body);
    t.cell=async(co,col)=>t.txt(`#eaTable tr[data-co="${co}"] td[data-label="${col}"]`);
    t.find=async()=>{ await p.click("#ea_go"); for(let i=0;i<60;i++){ await p.waitForTimeout(100); if(await p.evaluate(()=>!S.ea.run||S.ea.run.done)) break; } await p.waitForTimeout(150); };
    return t;
  }

  // ----- the tab, the view, a reader -----
  let t=await open({role:"reader"}); let p=t.p;
  ok("eight tabs for a Corp Dev login, Earnings after Market, and it is the one open", same(await t.all("nav.tabs a"),["Filings","Snapshot","Compare","Market","Earnings","Statutory","Combination","Profile"]) && (await p.getAttribute('nav.tabs a[data-view="earnings"]',"aria-current"))==="page" && (await t.txt(".action-title"))==="Earnings documents for a quarter");
  ok("on opening: status and the watchlist, then what was found before for the latest ended quarter", t.of("status").length===1 && t.of("list").length===1 && same(t.of("saved"),[{action:"saved", quarter:"3Q26"}]) && t.of("find").length===0);
  ok("the quarter: the latest ended first, eight to choose from", (await p.inputValue("#ea_q"))==="3Q26" && same((await p.$$eval("#ea_q option",o=>o.map(x=>x.value))).slice(0,5),["3Q26","2Q26","1Q26","4Q25","3Q25"]) && (await p.$$("#ea_q option")).length===8);
  ok("what it can't do is said once, plainly", (await p.$$("#eaLimits")).length===1 && (await t.txt("#eaLimits")).includes("Investor sites that block automated tools show as refused") && (await t.txt("#eaLimits")).includes("The desktop script remains the way to get everything.") && (await t.txt("main")).split("desktop script remains").length===2);
  ok("no S&P and no Claude, said on the page", (await t.txt(".ea .sub")).includes("No S&P requests and no Claude."));
  ok("the watchlist: visible to every login, says so, nothing about why", (await t.txt("#eaWatchNote")).startsWith("Every login can see this list.") && (await t.txt("#eaWatchNote")).includes("nothing about why a company is on it") && (await p.$$("#eaWlTable tbody tr")).length===5);
  ok("a reader can't change it", !(await p.$('[data-act="ea-edit"]')) && !(await p.$('[data-act="ea-add"]')) && !(await p.$("#ea_paste")) && (await t.txt("#eaWatchNote")).includes("Corp Dev can change it."));
  ok("investor pages are links to a new tab, safe", await p.$$eval("#eaWlTable a",a=>a.length>0 && a.every(x=>x.target==="_blank" && x.rel==="noopener noreferrer" && x.href.startsWith("https://"))));
  ok("a hostile company name is text, not markup", await p.evaluate(()=>!window.__pwned && !document.querySelector('#view img[src="x"]')) && (await t.txt("#eaWlTable")).includes(HOSTILE));
  ok("before Find: every row says not looked at yet; Download this quarter is off", (await t.cell("e-cal","10-Q"))==="Not looked at yet" && await p.isDisabled("#ea_zip"));

  // ----- Find: one company at a time, progress, the states -----
  t.delay=250;
  await p.click("#ea_go"); await p.waitForTimeout(400);
  const mid=await t.txt("#eaProgress");
  ok("Find asks for one company at a time and the bar says how many of how many", /^\d of 5 companies; now /.test(mid) && t.of("find").length<=2 && await p.isDisabled("#ea_go"), mid);
  ok("the bar is the shared progress bar, with a fraction", !!(await p.$('#eaProgress .pb [role="progressbar"][aria-valuenow]')));
  for(let i=0;i<40;i++){ await p.waitForTimeout(100); if(await p.evaluate(()=>S.ea.run.done)) break; }
  await p.waitForTimeout(150);
  ok("each company once, in the watchlist's order, for the quarter chosen", same(t.of("find").map(b=>[b.company,b.quarter,!!b.refresh]), WATCH.map(c=>[c.id,"3Q26",false])));
  ok("finished: the bar goes, the table stays", !(await p.$("#eaProgress")) && (await p.$$("#eaTable tbody tr[data-co]")).length===5);
  ok("the table's columns: company, 10-Q, earnings 8-K, supplement, presentation", same(await t.all("#eaTable thead th"),["Company","10-Q","Earnings 8-K","Supplement","Presentation"]));
  ok("found, with how many documents", (await t.cell("e-cal","10-Q"))==="Found, 2 documents" && (await t.cell("e-cal","Earnings 8-K"))==="Found, 3 documents");
  ok("not posted yet; site refused", (await t.cell("e-tar","10-Q"))==="Not posted yet" && (await t.cell("e-tar","Supplement"))==="Site refused");
  ok("London: labelled report and trading update; not found on the pages read; no pages listed", (await t.cell("e-nsh","10-Q"))==="Report Not found on the pages read" && (await t.cell("e-nsh","Earnings 8-K"))==="Trading update Found, 1 document" && (await t.cell("e-nsh","Presentation"))==="No investor pages listed" && (await t.txt("#eaLondon")).includes("interim or annual report"), [await t.cell("e-nsh","10-Q"), await t.cell("e-nsh","Earnings 8-K"), await t.cell("e-nsh","Presentation"), await t.txt("#eaLondon")]);
  ok("error; not found at the SEC; in the 8-K; no CIK", (await t.cell("e-nre","10-Q"))==="Error" && (await t.cell("e-nre","Earnings 8-K"))==="Not found at the SEC" && (await t.cell("e-nre","Supplement"))==="In the 8-K, 1 document" && (await t.cell("e-bad","10-Q"))==="No CIK");
  ok("states are in words, with a mark by colour too", await p.$eval('#eaTable tr[data-co="e-tar"] .s-refused b',b=>getComputedStyle(b).color==="rgb(235, 0, 140)") && await p.$eval('#eaTable tr[data-co="e-cal"] .s-found b',b=>getComputedStyle(b).color!=="rgb(38, 33, 102)"));
  ok("first look at a quarter: nothing marked new, and it says why", (await t.txt("#eaFirstLook")).includes("first look at 3Q26 in this browser") && !(await p.$("#eaTable .ea-new")));

  // ----- a row opened: documents, links, hostile titles -----
  await p.click('#eaTable tr[data-co="e-cal"] [data-act="ea-open"]'); await p.waitForTimeout(150);
  const docs=await t.all("#ea_docs_e-cal li");
  ok("opening a row lists each document with its type, date filed and where it came from", docs.length===8 && docs.some(d=>d.startsWith("FORM 8-K 8-K; filed 28 Oct; from SEC EDGAR")) && docs.some(d=>d.startsWith("Form 10-Q 10-Q; date filed n/d; from investors.calloway.example")), docs);
  ok("each title links to its source in a new tab", await p.$$eval("#ea_docs_e-cal li a",a=>a.length===8 && a.every(x=>x.target==="_blank" && x.rel==="noopener noreferrer")));
  ok("SEC web pages say they are saved as .htm", (await t.txt('#ea_docs_e-cal li[data-doc="d10q"]')).includes("Saved as a web page (.htm)."));
  ok("the row says when it was looked at and what it cost", (await t.txt("#ea_docs_e-cal .source")).startsWith("Looked 19 Nov; SEC CIK 1999001; 3 SEC requests, 2 investor pages read"));
  await p.click('#eaTable tr[data-co="e-tar"] [data-act="ea-open"]'); await p.click('#eaTable tr[data-co="e-bad"] [data-act="ea-open"]'); await p.click('#eaTable tr[data-co="e-nsh"] [data-act="ea-open"]'); await p.waitForTimeout(150);
  ok("a refused site gives the page to open yourself", (await t.txt("#ea_docs_e-tar")).includes("The site refused the app's requests. Open these pages yourself: https://ir.tarrow.example/") && await p.$eval("#ea_docs_e-tar a",a=>a.target==="_blank"&&a.rel==="noopener noreferrer"));
  ok("a hostile title is text, and an address that isn't https is not a link", await p.evaluate(()=>!window.__pwned && !document.querySelector("#ea_docs_e-bad img") && !document.querySelector('#ea_docs_e-bad a[href^="javascript"]')) && (await t.txt("#ea_docs_e-bad")).includes(HOSTILE+" supplement"));
  ok("notes from the function are shown (a page filled by JavaScript)", (await t.txt("#ea_docs_e-bad")).includes("fill its lists with JavaScript"));
  ok("a web page on a company's site has no download, only its link", (await t.txt('#ea_docs_e-nsh li[data-doc="dtu"]')).includes("A web page: open it from its link.") && !(await p.$('#ea_docs_e-nsh li[data-doc="dtu"] [data-act="ea-dl"]')));

  // ----- downloads, one at a time -----
  let dl=p.waitForEvent("download"); await p.click('#ea_docs_e-cal li[data-doc="ddeck"] [data-act="ea-dl"]'); let file=await dl;
  ok("a document downloads through the function, by its id, named as the script names it", file.suggestedFilename()==="Calloway 3Q26 Presentation - Third Quarter 2026 Investor Presentation.pdf" && same(t.of("download").at(-1),{action:"download", company:"e-cal", quarter:"3Q26", doc:"ddeck"}) && fs.readFileSync(await file.path(),"utf8").startsWith("%PDF"));
  ok("the page never sends an address to the function", t.calls.every(c=>!JSON.stringify(c.body).includes("https://")));
  await p.click('#ea_docs_e-cal li[data-doc="dsupp"] [data-act="ea-dl"]'); await p.waitForTimeout(300);
  ok("a file too big says so plainly", (await t.txt('#ea_docs_e-cal li[data-doc="dsupp"] .err'))==="This file is larger than 60 MB, more than the site passes through. Open it from its link instead.");
  await p.click('#ea_docs_e-cal li[data-doc="dsupx"] [data-act="ea-dl"]'); await p.waitForTimeout(300);
  ok("a refused source says so, and what to do", (await t.txt('#ea_docs_e-cal li[data-doc="dsupx"] .err')).includes("refused to hand the file to the app") && (await t.txt('#ea_docs_e-cal li[data-doc="dsupx"] .err')).includes("Open it from its link in your browser."));
  await p.screenshot({path:OUTDIR+"/earnings-1440.png",fullPage:true});
  await p.screenshot({path:SCRATCH+"/earnings-view-1440.png",fullPage:true}).catch(()=>{});

  // ----- the whole quarter as one zip -----
  dl=p.waitForEvent("download"); await p.click("#ea_zip"); file=await dl; await p.waitForTimeout(200);
  const zip=await JSZip.loadAsync(fs.readFileSync(await file.path())), names=Object.keys(zip.files).filter(n=>!zip.files[n].dir).sort();
  ok("the zip is named for the quarter, laid out quarter then company folder, with the script's file names",
    file.suggestedFilename()==="3Q26 Financial Statements.zip" && names.includes("3Q26 Financial Statements/Calloway/Calloway 3Q26 10-Q.htm") && names.includes("3Q26 Financial Statements/Calloway/Calloway 3Q26 10-Q.pdf") && names.includes("3Q26 Financial Statements/Calloway/Calloway 3Q26 8-K Ex 99.2 - FINANCIAL SUPPLEMENT.pdf") && names.includes("3Q26 Financial Statements/Nonesuch Re Ltd/Nonesuch Re Ltd 3Q26 6-K Ex 99.2.htm"), names);
  ok("the company folder is the watchlist's folder, else the name", names.some(n=>n.startsWith("3Q26 Financial Statements/Calloway/")) && names.some(n=>n.startsWith("3Q26 Financial Statements/Nonesuch Holdings plc/")));
  ok("a hostile name can't make a folder outside the quarter", names.every(n=>n.startsWith("3Q26 Financial Statements/") && !n.includes("..")) && names.some(n=>n.includes("img src=x onerror=")), names);
  const about=await zip.file("3Q26 Financial Statements/About this download.txt").async("string");
  ok("a note in the zip: SEC filings are web pages; web pages to open; what couldn't be fetched and why", about.includes("SEC filings are saved as the SEC's own web pages (.htm), not PDFs") && about.includes("https://www.nonesuch.example/investors/2026/q3-trading-update") && about.includes("larger than 60 MB") && about.includes("refused to hand the file"), about);
  ok("web pages and refused files aren't in the zip", !names.some(n=>/Trading Update/.test(n)) && names.length===10, names);
  ok("the page lists what couldn't be fetched", (await t.txt("#eaZipProgress")).includes("couldn't be fetched") && (await p.$$("#eaZipLeft li")).length===2);

  // ----- Refresh and what is new -----
  t.findFn=body=>{ const r=copy(results(body.quarter)[body.company]); if(body.company==="e-cal"){ r.docs.push(DOC("dnew","deck",{source:"ir", type:"Presentation", title:"Q3 2026 investor day slides", filed:null, ext:".pdf", url:"https://investors.calloway.example/files/day.pdf", firstSeen:"2026-11-19T11:00:00Z"})); r.cells.deck.docs.push("dnew"); } return {status:200, body:{result:r, fromStore:false}}; };
  t.delay=0; await p.click("#ea_refresh");
  for(let i=0;i<40;i++){ await p.waitForTimeout(100); if(await p.evaluate(()=>S.ea.run.done)) break; } await p.waitForTimeout(150);
  ok("Refresh asks again for every company", t.of("find").slice(-5).every(b=>b.refresh===true));
  ok("a document that appeared since the last look is marked New, in its cell and its row", (await t.cell("e-cal","Presentation"))==="Found, 2 documents 1 new" && (await t.txt('#ea_docs_e-cal li[data-doc="dnew"]')).startsWith("New ") && (await t.txt("#eaNewNote"))==="1 new document since your last look at 3Q26 in this browser." && (await p.$$("#eaTable .ea-new")).length===2, [await t.cell("e-cal","Presentation"), await t.txt('#ea_docs_e-cal li[data-doc="dnew"]'), await t.txt("#eaNewNote"), (await p.$$("#eaTable .ea-new")).length]);
  await t.ctx.close();

  // ----- the record of the last look survives a new visit -----
  {
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC", acceptDownloads:true});
    const seed=await ctx.newPage(); await seed.route("**/*",r=>r.fulfill({contentType:"text/html",body:"<p>x</p>"})); await seed.goto(BASE); await seed.evaluate(()=>localStorage.setItem("snl.earn.seen.3Q26", JSON.stringify(["d10q","d8k"]))); await seed.close();
    t=await open({role:"reader"}, {ctx}); p=t.p;
    t.saved["3Q26"]=Object.values(results("3Q26")).slice(0,1);
    await p.selectOption("#ea_q","2Q26"); await p.waitForTimeout(200); await p.selectOption("#ea_q","3Q26"); await p.waitForTimeout(300);
    ok("a saved quarter opens with no Find: the documents not seen last time are new", t.of("find").length===0 && same(t.of("saved").map(b=>b.quarter),["3Q26","2Q26","3Q26"]) && (await t.cell("e-cal","10-Q"))==="Found, 2 documents 1 new" && (await t.cell("e-cal","Earnings 8-K"))==="Found, 3 documents 2 new", [t.of("saved"), await t.cell("e-cal","10-Q"), await t.cell("e-cal","Earnings 8-K")]);
    ok("choosing a quarter asks only for what was saved", (await p.$$("#eaTable tbody tr[data-co]")).length===5 && (await t.cell("e-tar","10-Q"))==="Not looked at yet");
    await p.selectOption("#ea_q","4Q25"); await p.waitForTimeout(200);
    ok("for a fourth quarter the first column is the 10-K", same(await t.all("#eaTable thead th"),["Company","10-K","Earnings 8-K","Supplement","Presentation"]));
    await ctx.close();
  }

  // ----- Stop, and one more try for a company that failed -----
  t=await open({}); p=t.p; t.delay=200;
  await p.click("#ea_go"); await p.waitForTimeout(300); await p.click('[data-act="ea-stop"]'); await p.waitForTimeout(800);
  ok("Stop: the company being asked finishes, no more are asked, and the bar stays, marked stopped", t.of("find").length<=2 && (await t.txt("#eaProgress")).startsWith("Stopped") && /of 5 companies, then stopped/.test(await t.txt("#eaProgress")) && !(await p.isDisabled("#ea_go")), await t.txt("#eaProgress"));
  await t.ctx.close();
  t=await open({}); p=t.p; t.failOnce={"e-tar":true}; t.failAlways={"e-nre":true};
  await t.find(); await p.waitForTimeout(4500);
  for(let i=0;i<40;i++){ await p.waitForTimeout(100); if(await p.evaluate(()=>S.ea.run.done)) break; }
  const tries=t.of("find").map(b=>b.company);
  ok("a company that failed is asked once more; one that fails again isn't asked a third time", tries.filter(c=>c==="e-tar").length===2 && tries.filter(c=>c==="e-nre").length===2 && tries.length===7, tries);
  ok("the one that came back on the retry has its row", (await t.cell("e-tar","10-Q"))==="Not posted yet" && !(await p.$('#eaTable tr[data-co="e-tar"] .err')));
  ok("the one that failed twice says so on its row and on the bar", (await t.txt('#eaTable tr[data-co="e-nre"] .err')).includes("the site timed out") && (await t.txt("#eaProgress")).includes("Didn't finish") && (await t.txt("#eaProgress")).includes("Nonesuch Re Ltd failed twice") && await p.$eval("#eaProgress .pb",e=>e.classList.contains("pb-failed")));
  // a few companies only
  await p.click("#eaCos summary"); await p.click('[data-act="ea-none"]'); await p.check('input[data-ea-co="e-nsh"]'); await p.waitForTimeout(100);
  ok("choosing companies: the summary says how many", (await t.txt("#eaCos summary"))==="Companies: 1 of 5");
  const before=t.of("find").length; t.failAlways={}; await t.find();
  ok("Find asks only for the companies chosen", same(t.of("find").slice(before).map(b=>b.company),["e-nsh"]));
  await t.ctx.close();

  // ----- not set up yet -----
  t=await open({}); p=t.p; await t.ctx.close();
  t=await open({}, {configured:false}); p=t.p;
  ok("without SEC_CONTACT: Find and Refresh are off and the page says what the owner sets; the watchlist still works", await p.isDisabled("#ea_go") && await p.isDisabled("#ea_refresh") && (await t.txt("#eaNotSet")).includes("SEC_CONTACT") && !!(await p.$('[data-act="ea-add"]')));
  await t.ctx.close();

  // ----- Corp Dev: the watchlist -----
  t=await open({}, {watch:[]}); p=t.p;
  ok("an empty watchlist: Corp Dev is told to paste the script's list or add one", (await t.txt("#eaWlEmpty")).includes("Paste the script's list below") && !(await p.$("#eaForm")));
  await p.click("#eaPaste summary");
  const pasted=JSON.stringify([{name:"Calloway Insurance Co", ticker:"clwy", ir_urls:["https://investors.calloway.example/events/default.aspx","http://plain.calloway.example/"]}, {ticker:"NONAME"}, {name:"Nonesuch Holdings plc", sec:false, ir_urls:["https://www.nonesuch.example/investors/results"]}]);
  await p.fill("#ea_paste", pasted); await p.click('[data-act="ea-check"]'); await p.waitForTimeout(300);
  ok("pasting the script's list: checked, with a plain message for each entry that can't be used", (await t.txt("#eaChecked p"))==="2 companies can be loaded. 2 notes:" && same(await t.all("#eaCheckMsgs li"),['Entry 1 (Calloway Insurance Co): The investor page "http://plain.calloway.example/" can\'t be used: only https addresses are fetched. It was left out.',"Entry 2: It has no name. Left out."]) && same(t.of("check").at(-1),{action:"check", list:pasted}));
  await p.click('[data-act="ea-load"]'); await p.waitForTimeout(500);
  const savedRow=await p.evaluate(()=>window.__mock.row("snl_settings","earnings_watchlist"));
  ok("Load saves the checked list as the shared setting", !!savedRow && same(savedRow.doc.companies.map(c=>c.name),["Calloway Insurance Co","Nonesuch Holdings plc"]) && (await t.txt("#eaWlMsg"))==="Loaded 2 companies." && (await p.$$("#eaWlTable tbody tr")).length===2);
  await p.click('[data-act="ea-add"]'); await p.fill("#ea_e_name","Tarrow Mutual"); await p.fill("#ea_e_ticker","TRWM"); await p.fill("#ea_e_ir","https://ir.tarrow.example/"); await p.fill("#ea_e_files","supplement: https://ir.tarrow.example/{yyyy}/s-{q}q{yy}.pdf");
  await p.click('[data-act="ea-save"]'); await p.waitForTimeout(500);
  const added=(await p.evaluate(()=>window.__mock.row("snl_settings","earnings_watchlist"))).doc.companies;
  ok("Add: checked by the function, then saved", added.length===3 && added[2].name==="Tarrow Mutual" && (await t.txt("#eaWlMsg"))==="Added Tarrow Mutual." && same(t.of("check").at(-1).list[2],{name:"Tarrow Mutual", ticker:"TRWM", other_tickers:[], cik:null, ir_urls:["https://ir.tarrow.example/"], sec:true, folder:null, file_urls:{supplement:["https://ir.tarrow.example/{yyyy}/s-{q}q{yy}.pdf"]}}), t.of("check").at(-1).list[2]);
  await p.click('[data-act="ea-add"]'); await p.fill("#ea_e_name","calloway insurance co"); await p.click('[data-act="ea-save"]'); await p.waitForTimeout(400);
  ok("a second company of the same name is refused", (await t.txt("#eaWlErr"))==="calloway insurance co is already on the watchlist.");
  await p.click('[data-act="ea-cancel"]');
  const nsId=added[1].id;
  await p.click(`[data-act="ea-edit"][data-co="${nsId}"]`); await p.fill("#ea_e_folder","Nonesuch"); await p.click('[data-act="ea-save"]'); await p.waitForTimeout(400);
  ok("Change: saved, keeping the company's id", (await p.evaluate(()=>window.__mock.row("snl_settings","earnings_watchlist"))).doc.companies.find(c=>c.id===nsId).folder==="Nonesuch" && (await t.txt("#eaWlMsg"))==="Saved the changes to Nonesuch Holdings plc.");
  await p.click(`[data-act="ea-del"][data-co="${nsId}"]`); await p.waitForTimeout(100); await p.click(`[data-act="ea-del-yes"][data-co="${nsId}"]`); await p.waitForTimeout(400);
  ok("Remove asks once, then removes", (await p.evaluate(()=>window.__mock.row("snl_settings","earnings_watchlist"))).doc.companies.length===2 && (await t.txt("#eaWlMsg"))==="Removed Nonesuch Holdings plc.");
  await p.evaluate(()=>{ window.__mock.denySettings=true; });
  await p.click(`[data-act="ea-del"][data-co="${added[0].id}"]`); await p.click(`[data-act="ea-del-yes"][data-co="${added[0].id}"]`); await p.waitForTimeout(400);
  ok("refused by row-level security: says only Corp Dev can, nothing changed", (await t.txt("#eaWlErr"))==="Only Corp Dev logins can change the earnings watchlist. Ask Corp Dev." && (await p.evaluate(()=>window.__mock.row("snl_settings","earnings_watchlist"))).doc.companies.length===2);
  await t.ctx.close();

  // ----- phone -----
  t=await open({}, {width:390}); p=t.p;
  ok("phone: every tab whole and in sight, no sideways scroll", await p.evaluate(()=>[...document.querySelectorAll("nav.tabs a")].every(a=>{ const r=a.getBoundingClientRect(); return r.left>=0 && r.right<=window.innerWidth; })) && await t.noScroll());
  await t.find();
  for(const co of ["e-cal","e-bad","e-nsh"]) await p.click(`#eaTable tr[data-co="${co}"] [data-act="ea-open"]`);
  await p.waitForTimeout(200);
  ok("phone: the table as cards with the columns named, no sideways scroll with rows open", await t.noScroll() && (await p.$eval('#eaTable tr[data-co="e-cal"] td[data-label="Supplement"]',td=>getComputedStyle(td,"::before").content)).includes("Supplement"), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.click("#eaWatch h3");
  ok("phone: the watchlist fits too", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/earnings-390.png",fullPage:true});
  await p.screenshot({path:SCRATCH+"/earnings-view-390.png",fullPage:true}).catch(()=>{});
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
