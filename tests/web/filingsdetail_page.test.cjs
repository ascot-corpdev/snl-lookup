// The Profile view with the filings in detail (filings-detail): the slide list with the detailed filing slides in
// place of the one filings slide, each with its tick box; "The figures, section by section" with a filings section
// holding the same detail (the counts, rate changes by state and line, the filings marked as maybe new with the words
// that marked them, the latest form and rule filings, and every state in a box that scrolls inside itself, with "none
// returned" and "not searched", never zero filings); the section while figures are still arriving; an empty search;
// facts saved before this change, which show what they showed before; hostile text kept as text; and the 1440px and
// 390px layouts with no sideways scroll. The real profile-slides.js plans the slides; the zip library and deck.js are
// small stand-ins that record what they were given. Every company, filing number and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SAMPLE=FIX("profile_sample_answer.json"), OLD=FIX("profilepage_answer.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const FAKE_JSZIP='window.JSZip=function(){}; window.JSZip.version="3.10.1";';
const FAKE_DECK=`window.__deck={build:[]};
window.SNLDeck={ inspect:async b=>({ok:true, slides:3, widthIn:13.333, heightIn:7.5}),
  build:async (b,spec)=>{ window.__deck.build.push({file:spec.fileName, ids:spec.slides.map(s=>s.id||s.kind), titles:spec.slides.map(s=>s.title)}); return new TextEncoder().encode("PPTX for "+spec.fileName); } };`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x===undefined?"":x).slice(0,600)); } };
const X='<img src=x onerror="window.__xss=1">';
const FD_LABELS=["Filings at a glance, last 12 monthsIncluded","Rate changes, last 12 monthsIncluded","Latest rate change by state (map), last 12 monthsIncluded","New products and market moves, last 12 monthsIncluded","Latest form and rule filings, last 12 monthsIncluded","Every state, last 12 monthsIncluded","Time with the regulator, last 12 monthsIncluded"];

/** The made-up sample as a real company's figures. */
const REAL=()=>{ const a=copy(SAMPLE); a.facts.sample=false; a.facts.filingsDetail.sample=false; return a; };
/** An empty search: S&P returned nothing in any of the states searched. */
function empty(){
  const a=REAL(), D=a.facts.filingsDetail;
  a.facts.filings={...a.facts.filings, total:0, rows:[], byType:[], byState:[]};
  D.totals={filings:0, rate:0, rule:0, form:0, other:0, states:0, latest:null, undated:0};
  D.rates={...D.rates, filings:0, withImpact:0, notApproved:0, lo:null, hi:null, points:[], pointsTotal:0, rows:[], rowsTotal:0}; D.states={rows:[], noState:0};
  D.latest={rows:[], total:0}; D.regulator={rows:[], all:null, left:0}; D.largest=null;
  D.marks={counts:{new_program:0,new_state:0,new_form:0,withdrawal:0,large_rate:0}, filings:0, rows:[], largeRate:0, threshold:10};
  D.everyState=D.everyState.map(s=>({...s, n:0, rate:0, rule:0, form:0, latest:null, newProgram:0, marked:0}));
  return a;
}

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-14T12:00:00Z"));
    const t={p, ctx, calls:[], n:0, facts:()=>({status:200, body:REAL()}), delay:()=>0, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-profile"){
          if(body.action==="status") return J(200,{statutory:{configured:true, mapped:true, fields:[]}, claude:{configured:false}, filings:{configured:true}});
          if(body.action==="facts"){ const n=++t.n; const d=t.delay(n); if(d) await new Promise(res=>setTimeout(res,d)); const a=t.facts(body,n); return J(a.status,a.body); }
          return J(400,{error:"bad",message:"Unknown action."}); }
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:false, askedToday:0, dailyLimit:20, costToday:0, resetsAt:"2026-11-15T00:00:00Z"});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===JSZIP_URL) return r.fulfill({contentType:"application/javascript",body:FAKE_JSZIP});
      if(u===BASE+"deck.js") return r.fulfill({contentType:"application/javascript",body:FAKE_DECK});
      if(u===BASE+"profile-slides.js") return r.fulfill({contentType:"application/javascript",body:fs.readFileSync(WEB+"/profile-slides.js","utf8")});
      if(u===BASE+"template-builtin.pptx") return r.fulfill({contentType:"application/vnd.openxmlformats-officedocument.presentationml.presentation",body:fs.readFileSync(WEB+"/template-builtin.pptx")});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.goto(BASE+"#profile"); await p.waitForTimeout(500);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.list=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.figures=async code=>{ await p.fill("#pf_code",code); await p.click("#pf_get"); await p.waitForTimeout(600); };
    t.until=async(fn,ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await fn()) return true; await p.waitForTimeout(60); } return false; };
    t.cells=async sel=>p.$$eval(sel+" tr",rows=>rows.map(r=>[...r.children].map(c=>c.textContent.replace(/\s+/g," ").trim())));
    return t;
  }

  // ----- the slides: the detailed filing slides in place of the one filings slide, each with a tick box -----
  let t=await open(); let p=t.p;
  await t.figures("90001");
  const plan=await t.list("#pfPlan li");
  ok("the slide list: the six detailed filing slides follow the filings at a glance, all included", same(plan.slice(11,18), FD_LABELS) && plan.length===19 && plan[18]==="Key diligence questionsIncluded", plan);
  ok("each detailed filing slide has its tick box, ticked, named for the slide", same(await p.$$eval('#pfPlan .pfinc',e=>e.filter(x=>/^(filings|fd)/.test(x.dataset.id)).map(x=>[x.dataset.id,x.checked])), ["filings","fdRates","fdRateMap","fdMarks","fdForms","fdStates","fdRegulator"].map(id=>[id,true])) && (await p.getAttribute('#pfPlan .pfinc[data-id="fdMarks"]',"aria-label"))==="Include the new products and market moves, last 12 months slide");

  // ----- the filings section, section by section -----
  ok("a filings section, folded away, after the others", same(await p.$$eval("#pfDetail-contents details.pfsec",e=>e.map(x=>[x.dataset.sec,x.open]).slice(-1)),[["filings",false]]) && (await t.txt("#pfSec-contents-filings summary"))==="Recent rate and form filings, last 12 months");
  await p.click("#pfSec-contents-filings summary"); await p.waitForTimeout(150);
  ok("the counts: filings, of which rate, rule and form, states of those searched, and the marks as maybe (inferred)", same(await t.list("#fdTiles span"),["23 filings published 14 Nov 2025 to 13 Nov","10 rate, 7 rule, 7 form","6 states with filings of 51 searched","5 may be new products or market moves (inferred)"]), await t.list("#fdTiles span"));
  const rates=await t.cells("#fdTabRates");
  ok("rate changes by state and type of insurance, with the latest, its date and status; not approved starred", same(rates[0],["State","Type of insurance","Filings","Range %","Latest %","Published","Status"]) && rates.some(r=>same(r,["FL","Homeowners","4","4.5 to 7.9","4.5*","10 Oct","Pending"])) && rates.some(r=>same(r,["SC","Homeowners","1","(1.5)","(1.5)","18 Apr","Closed - Approved"])), rates);
  ok("the largest change and the not-weighted note", (await t.txt("#fdLargest")).startsWith("Largest overall rate change: 7.9% in FL (Homeowners), published 27 Feb") && (await t.txt("#pfSec-contents-filings")).includes("not weighted by premium"), await t.txt("#fdLargest"));
  const marks=await t.cells("#fdTabMarks");
  ok("the marked filings, newest first, with what each may be and the words that marked it", same(marks[0],["State","Type of insurance","Filing type","Status","Published","Effective","Filing number","May be","Why: the words that marked it"]) && same(marks[1],["GA","Inland marine","Form","Closed - Approved","23 May","21 Aug","CALL-GA-6","New form","the description says \"new endorsement\""]) && marks.length===6 && marks.some(r=>r[7]==="Withdrawal" && r[8]==="the description says \"withdraw\""), marks);
  ok("the marks read as an inference, never as fact", (await t.txt("#pfSec-contents-filings")).includes("May be new products or market moves (inferred from each filing's wording, not reported by S&P)"));
  const forms=await t.cells("#fdTabForms");
  ok("the latest form and rule filings", same(forms[0],["State","Type of insurance","Filing type","Status","Published","Filing number"]) && forms.length===13 && same(forms[1],["FL","Homeowners","Form","Closed - Approved","23 Sept","CALL-FL-2"].map((x,i)=>i===4?forms[1][4]:x)), forms.slice(0,2));
  const states=await t.cells("#fdTabStates");
  ok("every state: 51 rows in a box that scrolls inside itself", states.length===52 && await p.$eval("#fdStatesBox",e=>getComputedStyle(e).overflowY==="auto" && e.scrollHeight>e.clientHeight), states.length);
  ok("every state: FL with its filings, kinds, latest rate, date, line and new programs (magenta)", same(states.find(r=>r[0]==="FL"),["FL","10","4","3","3","4.5*","10 Oct","Homeowners","2"]) && (await p.$eval('#fdTabStates tr[data-st="FL"] td:last-child',e=>e.className)).includes("bad"));
  ok("every state: a state searched with nothing returned says so, never zero filings", same(states.find(r=>r[0]==="AK"),["AK","None returned"]) && (await t.txt("#pfSec-contents-filings")).includes("45 none returned") && (await t.txt("#pfSec-contents-filings")).includes("which doesn't prove nothing was filed"));
  ok("the time with the regulator, approximate", (await t.txt("#fdRegulator"))==="About 54 days from submitted to published, the median over 23 filings (approximate).", await t.txt("#fdRegulator"));
  ok("no em dashes, sentence case in the section's headings", !(await p.textContent("#pfSec-contents-filings")).includes("\u2014") && !(await p.$$eval("#pfSec-contents-filings .pfcap,#pfSec-contents-filings th",e=>e.map(x=>x.childNodes[0].textContent.trim()))).some(s=>/\s(?!S&P)[A-Z][a-z]+/.test(s)));
  await p.screenshot({path:OUTDIR+"/filingsdetail-1440.png",fullPage:true});
  await (await p.$("#pfSec-contents-filings")).screenshot({path:OUTDIR+"/filingsdetail-section-1440.png"});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: the filings section open, no sideways scroll", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.$eval("#pfSec-contents-filings",e=>e.scrollIntoView());
  await p.screenshot({path:OUTDIR+"/filingsdetail-390.png",fullPage:true});
  await (await p.$("#pfSec-contents-filings")).screenshot({path:OUTDIR+"/filingsdetail-section-390.png"});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(150);

  // ----- taking a detailed slide out, and the deck -----
  await p.click('#pfPlan .pfinc[data-id="fdStates"]'); await p.waitForTimeout(150);
  ok("a detailed slide taken out says so", (await t.list("#pfPlan li")).includes("Every state, last 12 monthsYou left it out"));
  await p.click("#pf_buildBtn"); await p.waitForTimeout(1200);
  const built=await p.evaluate(()=>window.__deck&&window.__deck.build);
  ok("the deck: the at-a-glance slide, then the detailed slides it kept, in order, titled last 12 months", built && built.length===1 && same(built[0].ids.slice(11,17),["filings","fdRates","fdRateMap","fdMarks","fdForms","fdRegulator"]) && !built[0].ids.includes("fdStates") && built[0].titles.slice(11,17).every(x=>/last 12 months/.test(x)), built && built[0]);
  await p.click('#pfPlan .pfinc[data-id="fdStates"]'); await p.waitForTimeout(150);
  await p.click("#pf_buildBtn"); await p.waitForTimeout(1200);
  const b2=await p.evaluate(()=>window.__deck.build[1]);
  ok("ticked again, every state is back and runs on to a second slide", b2 && b2.ids.filter(x=>x==="fdStates").length===2, b2 && b2.ids);
  await t.ctx.close();

  // ----- while figures are still arriving: the section shows what has come, as the others do -----
  const part=()=>{ const a=REAL(); for(const k of Object.keys(a.facts.series)) if(!["dpw","surplus"].includes(k)) delete a.facts.series[k]; a.facts.detail={derived:{}}; return {...a, pending:17, figures:{done:32, of:49}}; };
  t=await open({facts:(body,n)=>({status:200, body:n===1?part():REAL()}), delay:n=>n===1?50:1500}); p=t.p;
  await p.fill("#pf_code","90001"); await p.click("#pf_get");
  ok("while the rest come in, the filings section is among the figures so far, and opens", await t.until(async()=>!!(await p.$("#pfSec-sofar-filings"))) && await (async()=>{ await p.click("#pfSec-sofar-filings summary"); await p.waitForTimeout(100); return (await t.cells("#fdTabStates")).length===52; })());
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll while it carries on", await t.noScroll());
  await p.setViewportSize({width:1440,height:900});
  ok("once everything is in, the open filings section stays open", await t.until(async()=>!!(await p.$("#pfContents"))) && await p.$eval("#pfSec-contents-filings",e=>e.open));
  await t.ctx.close();

  // ----- an empty search -----
  t=await open({facts:()=>({status:200, body:empty()})}); p=t.p;
  await t.figures("90001");
  const ep=await t.list("#pfPlan li");
  ok("empty search: the at-a-glance slide stays; the detailed ones are left out, saying S&P returned nothing, never that nothing was filed", ep.includes("Filings at a glance, last 12 monthsIncluded") && ep.filter(x=>/last 12 monthsLeft out: S&P returned nothing for this search, so there are no filings to show\. That doesn't prove nothing was filed\./.test(x)).length===6, ep.slice(11,18));
  await p.click("#pfSec-contents-filings summary"); await p.waitForTimeout(150);
  ok("empty search: the section says S&P returned nothing in the 51 states searched, which doesn't prove nothing was filed", (await t.txt("#fdNone"))==="S&P returned nothing for this search (published 14 Nov 2025 to 13 Nov, 51 states searched). That doesn't prove nothing was filed.", await t.txt("#fdNone"));
  await t.ctx.close();

  // ----- not searched; facts saved before this change; the search unavailable -----
  const ns=REAL(); ns.facts.filingsDetail.everyState.forEach(s=>{ if(["AK","HI"].includes(s.state)) s.searched=false; });
  t=await open({facts:()=>({status:200, body:ns})}); p=t.p;
  await t.figures("90001"); await p.click("#pfSec-contents-filings summary"); await p.waitForTimeout(150);
  ok("a state not searched says not searched", same((await t.cells("#fdTabStates")).find(r=>r[0]==="HI"),["HI","Not searched"]) && (await t.txt("#pfSec-contents-filings")).includes("2 not searched"));
  await t.ctx.close();
  t=await open({facts:()=>({status:200, body:copy(OLD)})}); p=t.p;
  await t.figures("90001");
  ok("facts saved before this change: the slides they had (one filings slide), and no filings section", (await t.list("#pfPlan li")).includes("Recent rate and form filingsIncluded") && !(await t.list("#pfPlan li")).some(x=>/last 12 months/.test(x)) && !(await p.$("#pfSec-contents-filings")));
  await t.ctx.close();
  const un=REAL(); un.facts.filings={unavailable:"S&P filings aren't set up yet, so recent filings can't be searched."}; delete un.facts.filingsDetail;
  t=await open({facts:()=>({status:200, body:un})}); p=t.p;
  await t.figures("90001");
  ok("the search couldn't run: the filings slide is left out with the reason, no detailed slides, no filings section", (await t.list("#pfPlan li")).includes("Recent rate and form filingsLeft out: S&P filings aren't set up yet, so recent filings can't be searched.") && !(await t.list("#pfPlan li")).some(x=>/last 12 months/.test(x)) && !(await p.$("#pfSec-contents-filings")));
  await t.ctx.close();

  // ----- hostile text -----
  const evil=REAL(), E=evil.facts.filingsDetail; E.marks.rows[0].marks[0].reason=X; E.marks.rows[0].toi=X; E.everyState[0].latest={rate:1, date:"2026-01-01", toi:X, approved:true, state:"AK", status:"x"}; E.everyState[0].n=1;
  t=await open({facts:()=>({status:200, body:evil})}); p=t.p;
  await t.figures("90001"); await p.click("#pfSec-contents-filings summary"); await p.waitForTimeout(200);
  ok("hostile text in the marks and every state stays text", (await t.txt("#fdTabMarks")).includes(X) && (await t.txt("#fdTabStates")).includes(X) && !(await p.evaluate(()=>window.__xss)));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.log("FAIL harness "+(e&&e.stack||e)); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
