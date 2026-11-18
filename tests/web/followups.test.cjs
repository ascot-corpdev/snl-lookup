// Follow-ups to the first Live check, on the page: a filing with no tracking number is shown and quoted by S&P's own
// number, marked "S&P no.", everywhere the page names a filing (the Filings results and their filter, the exports,
// the Snapshot's latest filings and its exports, the watchlist's found filings, Claude's sources and the Word
// export of an answer); hostile numbers stay text; the watchlist says when S&P sent no descriptions; and the 1440px
// and 390px layouts. Every company, number and filing here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SEARCH=FIX("web_search.json"), RESOLVE=FIX("web_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

const SP="ABC1234567", SP2="XYZ7654321", HOSTILE='<img src=x onerror="window.__xss=1">';
// the fixture's six rows, with their numbers set: tracking only, S&P only, both, neither, hostile, S&P only
const NUMBERS=[["CALL-134000001",null],[null,SP],["CALL-134000003",SP2],[null,null],[null,HOSTILE],[null,"QRS0000006"]];
const ROWS=()=>copy(SEARCH.rows).map((r,i)=>({...r, trackingNumber:NUMBERS[i][0], sfcNumber:NUMBERS[i][1]}));
const RESULT=()=>({...copy(SEARCH), rows:ROWS()});
const LIST={enabled:true, companies:[{kind:"companyId",id:"4000001",name:"Calloway Insurance Co"}], states:["FL"], recipients:["corpdev1@example.com"]};
const FOUND=(i,over={})=>({filing_version_id:`0D0D0D0D-0000-4000-8000-${String(i).padStart(12,"0")}`, run_id:"run-2", first_seen_at:"2026-11-13T06:24:00Z", baseline:false, companies:["Calloway Insurance Co"], state:"FL", state_name:"Florida",
  filing_type:"Rate", type_of_insurance:"Homeowners", sub_type_of_insurance:null, filing_status:"Pending", date_submitted:"2026-10-28", publish_date:"2026-11-10", effective_new:"2027-01-01", effective_renewal:null,
  rate_impact:"-11", description:null, tracking_number:`S&P no. ABC000000${i}`, document_id:72000000+i, flags:[], ...over});
const RUN={id:"run-2", status:"ok", trigger:"schedule", started_at:"2026-11-13T06:23:00Z", finished_at:"2026-11-13T06:24:00Z", requests:2, found:3, new_count:3, baseline:false, complete:true, emailed:0, message:"Found 3 new filings.", scope:null};
const WSTATUS=found=>({configured:true, emailConfigured:true, enabled:true, watchlist:LIST, problems:[], cost:3, budget:30, maxCompanies:280, tooBig:null, windowDays:14, keepDays:90, running:false,
  lastRun:RUN, lastCheck:RUN, found, scheduleReady:true, lastScheduled:"2026-11-13T06:23:00Z", scheduleQuiet:false, role:"corpdev"});
const RATE={kind:"large_rate", label:"Large rate change", reason:"the overall rate impact is -11.0%"};

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(width=1440, over={}){
    const ctx=await b.newContext({viewport:{width,height:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], search:()=>RESULT(), watch:()=>WSTATUS([FOUND(1,{flags:[RATE]}), FOUND(2,{rate_impact:"-0.8"}), FOUND(3,{tracking_number:"CALL-FL-3", rate_impact:null})]), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-watch") return body.action==="status" ? J(200,t.watch()) : J(400,{error:"bad",message:"Unknown action."});
        if(body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve") return J(200,{...copy(RESOLVE), query:body.q});
        if(body.action==="search") return J(200,t.search(body));
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },{seed:[["snl_settings","watchlist",{doc:LIST}]]});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return fs.readFileSync(await d.path(),"utf8"); };
    t.quick=async()=>{ await p.fill("#f_q","4000001"); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click('#byId button >> nth=0'); await p.click('#states [data-s="FL"]'); await p.click('button[data-act="search"]'); await p.waitForTimeout(450); };
    return t;
  }

  // ----- the Filings results -----
  let t=await open(); let p=t.p;
  await t.quick();
  const cells=await t.all('#resTable tbody td[data-label="Tracking number"]');
  // results are newest first, so read each row's number by its filing version
  const byFv=await p.$$eval("#resTable tbody tr",rs=>Object.fromEntries(rs.map(r=>[r.dataset.key, r.querySelector(".c-tn").textContent.replace(/\s+/g," ").trim()])));
  ok("the column keeps its heading", (await t.all("#resTable thead th")).includes("Tracking number"));
  ok("a tracking number shows as before", byFv["vfv-00000001"]==="CALL-134000001", byFv);
  ok("no tracking number: S&P's number, marked S&P no.", byFv["vfv-00000002"]===`S&P no. ${SP}`, byFv);
  ok("both: the tracking number", byFv["vfv-00000003"]==="CALL-134000003", byFv);
  ok("neither: n/d", Object.values(byFv).includes("n/d") && cells.length===6, byFv);
  ok("a hostile number shows as text, and runs nothing", Object.values(byFv).includes(`S&P no. ${HOSTILE}`) && !(await p.$("#resTable .c-tn img")) && await p.evaluate(()=>window.__xss===undefined), byFv);
  ok("the mark is muted and says what it is on hover", await p.evaluate(()=>{ const m=document.querySelector("#resTable .c-tn .spno"); return !!m && m.classList.contains("t2") && m.textContent==="S&P no." && m.title==="S&P's own number for this filing, which has no tracking number"; }));
  ok("a tracking number has no mark", await p.evaluate(()=>[...document.querySelectorAll("#resTable .c-tn")].filter(td=>/^CALL-/.test(td.textContent.trim())).every(td=>!td.querySelector(".spno"))));
  await p.fill("#f_filter", SP); await p.waitForTimeout(150);
  ok("the filter finds a filing by S&P's number", (await t.all('#resTable tbody td[data-label="Tracking number"]')).join()===`S&P no. ${SP}`, await t.all('#resTable tbody td[data-label="Tracking number"]'));
  await p.fill("#f_filter", "s&p no."); await p.waitForTimeout(150);
  ok("…and by the mark, in any letter case", (await t.all('#resTable tbody td[data-label="Tracking number"]')).length===3);
  await p.fill("#f_filter", SP2); await p.waitForTimeout(150);
  ok("a filing with both numbers is found by its tracking number only", (await p.$$("#resTable tbody tr")).length===0);
  await p.fill("#f_filter", ""); await p.waitForTimeout(150);
  await p.setViewportSize({width:1440, height:900}); await p.screenshot({path:path.join(OUTDIR,"followups-filings-1440.png"), fullPage:false, clip:{x:0,y:0,width:1440,height:900}}).catch(()=>{});
  await p.evaluate(()=>document.querySelector("#resTable").scrollIntoView());
  await p.screenshot({path:path.join(OUTDIR,"followups-filings-1440.png")});
  const csv=await t.download(()=>p.click('button[data-what="filings"][data-fmt="csv"]'));
  const lines=csv.replace(/^\uFEFF/,"").split(/\r?\n/), head=lines[0].split(","), at=head.indexOf('"Tracking number"');
  ok("the export keeps its Tracking number column, which now gives S&P's number where there is no tracking number", at>=0 && head[at+1]==='"SFC number"' && csv.includes(`,"S&P no. ${SP}","${SP}",`) && csv.includes(`,"CALL-134000003","${SP2}",`) && csv.includes(',"CALL-134000001","",'), lines.slice(0,3));
  // Claude's sources and the Word export of an answer
  const src=await p.evaluate(sp=>{ const result={answer:[{text:"A fact.", cites:[1,2]}], sources:[{n:1, documentId:880002, filingVersionId:null, title:`S&P no. ${sp}, Calloway Insurance Co, FL, Form`, company:"Calloway Insurance Co", state:"FL", trackingNumber:null, sfcNumber:sp, pages:"2", startPage:2, quote:null},
    {n:2, documentId:880001, filingVersionId:null, title:"CALL-134000001", company:"Calloway Insurance Co", state:"FL", trackingNumber:"CALL-134000001", pages:"3", startPage:3, quote:null}], table:null, lookups:[], caps:[]};
    const html=answerHTML({question:"q", result, status:"done"}, 0), d=document.createElement("div"); d.innerHTML=html;
    return {shown:[...d.querySelectorAll(".srcs li .t2")].map(e=>e.textContent), doc:answerDoc({question:"q", asked:"", result}).sources.map(s=>s.meta)}; }, SP);
  ok("Claude's sources name a filing by S&P's number when it has no tracking number", src.shown.length===2 && src.shown[0].startsWith(`Calloway Insurance Co · FL · S&P no. ${SP} · `) && src.shown[1].startsWith("Calloway Insurance Co · FL · CALL-134000001 · "), src.shown);
  ok("…and so does the Word export of the answer", src.doc[0].includes(`FL · S&P no. ${SP}`) && src.doc[1].includes("FL · CALL-134000001"), src.doc);

  // ----- the Snapshot: its latest filings and its exports -----
  const snap=await p.evaluate(rows=>{ S.snap={...S.snap, res:{rows, params:{states:["FL"], from:"2025-11-14", to:"2026-11-13"}}, ran:{pick:{name:"Calloway Group"}}};
    const c=snapCompute(S.snap.res, S.snap.ran), d=document.createElement("div"); d.innerHTML=snapLatestBlockHTML(c);
    const f=snapExport("filings"), fr=snapExport("forms");
    return {cells:[...d.querySelectorAll(".c-tn")].map(e=>e.textContent.replace(/\s+/g," ").trim()), filings:f.rows.map(r=>r[f.cols.indexOf("Tracking number")]), forms:fr.rows.map(r=>r[fr.cols.indexOf("Tracking number")])}; }, ROWS());
  ok("the Snapshot's latest filings show S&P's number where there is no tracking number", snap.cells.includes(`S&P no. ${SP}`) && snap.cells.includes("CALL-134000001"), snap.cells);
  ok("the Snapshot's exports too", snap.filings.includes(`S&P no. ${SP}`) && snap.filings.includes("CALL-134000003") && snap.filings.includes("") && snap.forms.length>0 && snap.forms.every(x=>typeof x==="string"), snap);

  // ----- the watchlist's found filings -----
  const wTns=await t.all('#watchTable tbody td[data-label="Tracking number"]');
  ok("found filings show S&P's number, kept marked, and a tracking number plainly", same(wTns, ["S&P no. ABC0000001","S&P no. ABC0000002","CALL-FL-3"]), wTns);
  ok("the saved mark reads back as S&P's number: muted, with its hover", await p.evaluate(()=>{ const m=document.querySelector("#watchTable .c-tn .spno"); return !!m && m.textContent==="S&P no." && document.querySelectorAll("#watchTable .c-tn .spno").length===2; }));
  ok("with no descriptions, the note says which marks can still show", (await t.txt("#wNoDesc"))==="S&P sent no description with these filings, so only the filing type, type of insurance, status and rate impact could mark them: a new form, or a company new to a state, can't be spotted.", await t.txt("#wNoDesc"));
  ok("a bare rate impact from a live row shows as a percentage, like the Filings view", same(await t.all('#watchTable tbody td[data-label="Rate impact"]'), ["(11.0%)","(0.8%)","n/d"]), await t.all('#watchTable tbody td[data-label="Rate impact"]'));
  ok("the rest of the note is as before", (await t.txt("#wMarkNote")).startsWith("A mark is a hint from the filing type, status, rate impact and description, not a fact"));
  await p.evaluate(()=>document.querySelector("#watchWrap").scrollIntoView());
  await p.screenshot({path:path.join(OUTDIR,"followups-watch-1440.png")});
  await ctx_close(t);

  // a watchlist with descriptions: no such note
  t=await open(1440,{watch:()=>WSTATUS([FOUND(1,{flags:[RATE], description:"Made-up rate revision."}), FOUND(2,{rate_impact:"-0.8"})])}); p=t.p;
  ok("when some filing has a description, no note about missing descriptions", !(await p.$("#wNoDesc")) && !!(await p.$("#wMarkNote")));
  await ctx_close(t);

  // ----- 390px -----
  t=await open(390); p=t.p;
  await t.quick();
  ok("390px: no sideways scroll with S&P's numbers in the cards", await t.noScroll());
  const card=await p.evaluate(()=>{ const td=[...document.querySelectorAll("#resTable .c-tn")].find(x=>x.querySelector(".spno")); const r=td.getBoundingClientRect(), m=td.querySelector(".spno").getBoundingClientRect(); return {w:r.width, right:r.right, vw:innerWidth, sameLine:Math.abs(m.top-r.top)<30}; });
  ok("390px: the number sits inside its card", card.right<=card.vw && card.sameLine, card);
  await p.evaluate(()=>[...document.querySelectorAll("#resTable .c-tn")].find(x=>x.querySelector(".spno")).scrollIntoView({block:"center"}));
  await p.screenshot({path:path.join(OUTDIR,"followups-filings-390.png")});
  await p.evaluate(()=>document.querySelector("#watchWrap").scrollIntoView());
  ok("390px: the watchlist with its note, no sideways scroll", await t.noScroll() && !!(await p.$("#wNoDesc")));
  await p.screenshot({path:path.join(OUTDIR,"followups-watch-390.png")});
  await ctx_close(t);

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
  async function ctx_close(x){ await x.ctx.close(); }
})().catch(e=>{ console.log("FAIL crashed", e && e.stack || e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
