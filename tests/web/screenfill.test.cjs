// The Screener's "Fill in the form" box (Corp Dev only): the reader describes the companies in plain English, Claude
// (snl-profile's screen-fill action, stood in for here) turns it into the form's filters, and the page puts them in the
// form without running the screen. Covers: the box and what it says is sent; the request sent (text, year, S&P's line
// names, the current screen when there is one); the form holding the answer and the read-back; Claude's notes shown as
// text (HTML in a note is not rendered); the screen not run until Run screen is pressed; refining; Start over; waiting,
// failed (with Try again), Claude not set up, nothing that could be expressed, refused by the checks, the form changed
// while waiting; no line names; a year change; a reader sees none of it; nothing kept in browser storage or told to Ask
// Claude; keyboard use; 1440 and 390 wide. Every company, line and figure is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json"), SC=FIX("screener_answers.json"), FILL=FIX("screenfill_answers.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG=`window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};`;
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
const STATUS_MAPPED={...copy(STAT.statusMapped), companies:{mapped:true, problem:null}, screen:copy(SC.screenStatus)};
const J200=o=>({status:200, body:o});
const LINES=["Commercial auto","Homeowners","Workers comp"];
const TEXT="Florida homeowners writers with $50M to $300M of direct premium, combined ratio under 100, not part of a big group";

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(over={}){
    const width=over.width||1440;
    const ctx=await b.newContext({viewport:{width, height:width<500?844:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-24T12:00:00Z"));
    const t={p, ctx, calls:[], role:over.role||"corpdev", delay:()=>0, stat:()=>copy(STATUS_MAPPED), status:()=>({...copy(STATUS), role:t.role, statutory:{configured:true}}),
      lines:b=>J200({year:b.year, lines:LINES, cut:false}), screen:()=>J200(copy(SC.answer)), fill:()=>J200(copy(FILL.filled)), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,t.status());
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:true, askedToday:1, dailyLimit:20, costToday:0.2, resetsAt:"2026-11-25T00:00:00Z"});
        if(fn==="snl-chat") return J(503,{error:"not_configured", message:"Questions aren't set up yet."});
        if(fn==="snl-profile" && body.action==="screen-fill"){ const d=t.delay(body); if(d) await new Promise(res=>setTimeout(res,d)); const a=t.fill(body); return J(a.status, a.body); }
        if(fn==="snl-profile") return J(200,{configured:true, statutory:{configured:true, mapped:true}, template:null});
        if(fn==="snl-statutory"){
          if(body.action==="status") return J(200, t.stat());
          if(body.action==="screen-lines"){ const a=t.lines(body); return J(a.status, a.body); }
          if(body.action==="screen"){ const a=t.screen(body); return J(a.status, a.body); }
        }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; }, {role:t.role});
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    await p.evaluate(()=>{ location.hash="#screener"; }); await p.waitForTimeout(350);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.fills=()=>t.calls.filter(c=>c.fn==="snl-profile"&&c.body.action==="screen-fill").map(c=>c.body);
    t.screens=()=>t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="screen").map(c=>c.body);
    t.until=async (cond, ms=6000)=>{ const end=Date.now()+ms; while(Date.now()<end){ if(await cond()) return true; await p.waitForTimeout(40); } return false; };
    t.linesUp=()=>t.until(async()=>(await p.$$('[data-sc-pick="lines"]')).length===3);
    t.fillIn=async (text, n)=>{ const before=t.fills().length; await p.fill("#scFillText", text); await p.click("#scFillGo"); await t.until(async()=>t.fills().length>before); await t.until(async()=>!(await p.$("#scFillBusy"))); await p.waitForTimeout(80); };
    t.form=()=>p.evaluate(()=>JSON.parse(JSON.stringify(S.sc.form)));
    return t;
  }

  // ===== the box, a fill, the form holding it, nothing run until Run screen =====
  let t=await open(); let p=t.p;
  await t.linesUp();
  ok("the box sits at the top of the Screener, above the form", await p.$eval("#scFill", el=>{ const f=document.getElementById("scForm"); return !!f && (el.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING)>0; }));
  ok("it asks for a description, with a made-up example and a count of characters", (await t.txt("#scFill label.f span"))==="Describe the company you are looking for up to 600 characters" && (await p.getAttribute("#scFillText","placeholder"))===TEXT && (await p.getAttribute("#scFillText","maxlength"))==="600" && (await t.txt("#scFillCount"))==="0 of 600 characters");
  ok("the button says what it does", (await t.txt("#scFillGo"))==="Fill in the form" && await p.isEnabled("#scFillGo"));
  ok("it says what is sent, when, that nothing is saved, the cost, and that it doesn't run the screen", (await t.txt("#scFillSent"))==="Claude only fills in the form; it doesn't run the screen. Your description goes to Claude (Anthropic) only when you press Fill in the form, with S&P's line names for the year and the filters now in the form. Nothing else is sent, and nothing is saved. A fill costs a few cents and counts as one of your questions to Claude for the day.", await t.txt("#scFillSent"));
  ok("nothing is sent to Claude on opening the view", t.fills().length===0);
  await p.fill("#scFillText", TEXT);
  ok("the count follows the typing", (await t.txt("#scFillCount"))===`${TEXT.length} of 600 characters`);
  await t.fillIn(TEXT);
  ok("pressing it sends the description, the year and S&P's line names, and no current screen for an empty form", same(t.fills()[0], {action:"screen-fill", text:TEXT, year:2025, lines:LINES}), t.fills()[0]);
  ok("the form holds the request: year, state, line, the two filters, not in a group, sort and limit", same(await t.form(), {year:"2025", states:["FL"], lines:["Homeowners"], filters:[{field:"premium",min:"50",max:"300"},{field:"combined_ratio",min:"",max:"100"}], growth:{years:"",min:"",max:""}, group:"none", sort:"premium", dir:"desc", limit:"100", lineQ:""}), await t.form());
  ok("and shows it: chips, ticked line, filter boxes, group", (await t.txt("#sc_states .chips"))==="Florida FL×" && await p.isChecked('[data-sc-pick="lines"][value="Homeowners"]') && (await p.inputValue("#sc_f0_min"))==="50" && (await p.inputValue("#sc_f0_max"))==="300" && (await p.inputValue("#sc_f1_field"))==="combined_ratio" && (await p.inputValue("#sc_f1_max"))==="100" && (await p.inputValue("#sc_group"))==="none");
  ok("the page says Claude filled it in, to check it, then run it", (await t.txt("#scFillDone"))==="Claude filled in the form. Check it, then run the screen.");
  ok("the read-back the form writes, for what was filled in", (await t.txt("#scFillReadBack"))==="Filled in: Direct premiums written in Florida, Homeowners, 2025, between $50M and $300M; combined ratio at most 100.0%; not in a NAIC group.", await t.txt("#scFillReadBack"));
  const notes=await p.$$eval("#scFillNotes li", e=>e.map(x=>x.textContent));
  ok("Claude's notes are listed under the box", notes.length===2 && notes[0]==='Read "not part of a big group" as not in a NAIC group: the size of a group can\'t be screened.', notes);
  ok("a note holding HTML is shown as text, never rendered", notes[1]==="<b>Bold</b> <img src=x onerror=\"window.__pwned=1\"> stays text." && !(await p.$("#scFillNotes b, #scFillNotes img")) && !(await p.evaluate(()=>window.__pwned)), notes[1]);
  ok("the notes are announced: they sit in a polite status region", (await p.getAttribute("#scFillSay","role"))==="status" && (await p.getAttribute("#scFillSay","aria-live"))==="polite" && !!(await p.$("#scFillSay #scFillNotes")));
  ok("the screen is NOT run by the fill", t.screens().length===0 && !(await p.$("#scTable")) && !(await p.$("#scBusy")));
  ok("no em dash anywhere on the view", !(await t.txt("#view")).includes(String.fromCharCode(0x2014)));
  await p.screenshot({path:path.join(OUTDIR,"screenfill-1440.png"), fullPage:true});
  ok("no sideways scroll at 1440", await t.noScroll());
  await p.click("#scGo"); await t.until(async()=>!!(await p.$("#scTable")));
  ok("Run screen runs exactly what was filled in", same(t.screens()[0], {action:"screen", year:2025, states:["FL"], lines:["Homeowners"], filters:[{field:"premium",min:50,max:300},{field:"combined_ratio",max:100}], group:"none", sort:{by:"premium",dir:"desc"}, limit:100}), t.screens()[0]);
  ok("nothing about the fill is kept in browser storage", await p.evaluate(()=>!/Florida|homeowners|Homeowners|big group|combined|Bold/.test(JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))));
  ok("Ask Claude is still told nothing about this view", await p.evaluate(()=>askScreen()===null));
  ok("the description went to the fill only: no other call carried it", t.calls.filter(c=>!(c.fn==="snl-profile"&&c.body.action==="screen-fill")).every(c=>!JSON.stringify(c.body).includes("big group")));
  ok("nothing written to the database by the page", (await p.evaluate(()=>window.__mock.log)).filter(l=>l.op==="upsert").length===0);

  // ===== refining: the current screen goes with the description =====
  t.fill=b=>{ const q=copy(b.current); q.states=["TX"]; return J200({request:{...q, filters:q.filters.map(f=>({min:null, max:null, ...f})), growth:q.growth||null}, notes:["Changed the state to Texas and kept the rest."]}); };
  await t.fillIn("make it Texas instead");
  ok("a second fill sends the screen now in the form as current", same(t.fills()[1].current, {year:2025, states:["FL"], lines:["Homeowners"], filters:[{field:"premium",min:50,max:300},{field:"combined_ratio",max:100}], group:"none", sort:{by:"premium",dir:"desc"}, limit:100}) && t.fills()[1].text==="make it Texas instead", t.fills()[1]);
  ok("and the answer changes the screen rather than starting again", same((await t.form()).states, ["TX"]) && (await t.form()).filters.length===2 && (await t.form()).group==="none" && (await t.txt("#scFillReadBack")).startsWith("Filled in: Direct premiums written in Texas, Homeowners, 2025"));
  ok("the last screen's result stays until Run screen is pressed again", t.screens().length===1 && !!(await p.$("#scTable")));
  // the form has a problem: nothing is sent, and the page says why
  await p.fill("#sc_f0_min", "400"); await p.fill("#scFillText", "and bigger"); await p.click("#scFillGo"); await p.waitForTimeout(100);
  ok("a form with a problem isn't sent: the page says Claude can't build on it", t.fills().length===2 && (await t.txt("#scFillErr"))==="The form has a problem, so Claude can't build on it: Premium in view: the minimum is above the maximum. Fix it, or choose Start over.", await t.txt("#scFillErr"));
  // Start over
  await p.click("#scFillReset"); await p.waitForTimeout(120);
  ok("Start over clears the box and the form", (await p.inputValue("#scFillText"))==="" && same((await t.form()).states, []) && (await t.form()).filters.length===0 && (await t.form()).group==="any" && !(await p.$("#scFillDone")) && !(await p.$("#scFillNotes")) && (await t.txt("#scFillCount"))==="0 of 600 characters");
  ok("and puts the focus back in the box", await p.evaluate(()=>document.activeElement&&document.activeElement.id==="scFillText"));
  await p.click("#scFillGo"); await p.waitForTimeout(80);
  ok("an empty box is caught before anything is sent", (await t.txt("#scFillErr"))==="Describe the company you are looking for first." && t.fills().length===2);
  ok("no page errors", errs.length===0, errs);
  await t.ctx.close();

  // ===== waiting, and the form stays usable =====
  t=await open({delay:()=>900}); p=t.p; await t.linesUp();
  await p.fill("#scFillText", TEXT); await p.click("#scFillGo"); await p.waitForTimeout(200);
  ok("while waiting: what is happening, the button busy and off", (await t.txt("#scFillBusy"))==="Claude is turning your description into filters. This takes a few seconds. Nothing runs until you press Run screen." && (await t.txt("#scFillGo"))==="Filling in…" && await p.isDisabled("#scFillGo"));
  ok("the form stays usable by hand while waiting", await p.isEnabled("#scGo") && await p.isEnabled("#scAddFilter"));
  await t.until(async()=>!!(await p.$("#scFillDone")));
  ok("then it fills in as usual", same((await t.form()).states, ["FL"]));
  // the form changed while waiting: Claude's filters are not put over the reader's own
  await p.fill("#scFillText", "only Texas"); await p.click("#scFillGo"); await p.waitForTimeout(150);
  await p.click('[data-act="sc-unpick"][data-v="FL"]'); await p.waitForTimeout(60);
  await t.until(async()=>!(await p.$("#scFillBusy")), 4000); await p.waitForTimeout(80);
  ok("a form changed while Claude worked is left as the reader made it, and the page says so", (await t.txt("#scFillChanged"))==="You changed the form while Claude was working, so its filters weren't put in. Press Fill in the form again to use them." && same((await t.form()).states, []));
  // Start over while waiting drops the late answer
  await p.fill("#scFillText", TEXT); await p.click("#scFillGo"); await p.waitForTimeout(150); await p.click("#scFillReset");
  await p.waitForTimeout(1200);
  ok("Start over while waiting drops the answer when it arrives", same((await t.form()).states, []) && !(await p.$("#scFillDone")) && (await p.inputValue("#scFillText"))==="");
  await t.ctx.close();

  // ===== failed, with Try again; refused by the checks; nothing that could be expressed; Claude not set up =====
  t=await open({fill:()=>({status:502, body:{error:"claude", message:"Claude is busy. Wait a minute and try again."}})}); p=t.p; await t.linesUp();
  await t.fillIn(TEXT);
  ok("failed: the plain reason, that the form still works by hand, and Try again", (await t.txt("#scFillFailed"))==="The form wasn't filled in. Claude is busy. Wait a minute and try again. The form below still works by hand.Try again" && same((await t.form()).states, []), await t.txt("#scFillFailed"));
  t.fill=()=>J200(copy(FILL.filled));
  await p.click('#scFillFailed [data-act="scf-go"]'); await t.until(async()=>!!(await p.$("#scFillDone")));
  ok("Try again sends it again and fills in", t.fills().length===2 && same(t.fills()[1], t.fills()[0]) && same((await t.form()).states, ["FL"]));
  await t.ctx.close();
  t=await open({fill:()=>({status:422, body:{error:"unusable", message:"Claude's screen couldn't be used: Premium in view: the min is above the max. Try again with other words, or fill in the form by hand."}})}); p=t.p; await t.linesUp();
  await t.fillIn(TEXT);
  ok("refused by the checks: the checks' own words, and the form untouched", (await t.txt("#scFillFailed")).startsWith("The form wasn't filled in. Claude's screen couldn't be used: Premium in view: the min is above the max.") && same((await t.form()).filters, []));
  await t.ctx.close();
  t=await open({fill:()=>J200(copy(FILL.empty))}); p=t.p; await t.linesUp();
  await t.fillIn("companies that are for sale with a strong management team");
  ok("nothing expressible: Claude couldn't turn that into a screen, with its note, and the form unchanged", (await t.txt("#scFillEmpty"))==="Claude couldn't turn that into a screen. The form wasn't changed. Try other words, or fill in the form by hand." && same(await p.$$eval("#scFillNotes li", e=>e.map(x=>x.textContent)), FILL.empty.notes) && same((await t.form()).states, []) && t.screens().length===0);
  await t.ctx.close();
  t=await open({fill:()=>({status:503, body:{error:"not_configured", message:"Claude isn't connected yet, so the form can't be filled in from a description. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6). The form still works by hand."}})}); p=t.p; await t.linesUp();
  await t.fillIn(TEXT);
  ok("not set up (from the function): says what the owner must do, calmly", (await t.txt("#scFillOff"))==="Claude isn't connected yet, so the form can't be filled in from a description. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6). The form still works by hand." && await p.isEnabled("#scGo"));
  await t.ctx.close();
  t=await open({status:()=>({...copy(STATUS), role:"corpdev", statutory:{configured:true}, claude:{configured:false}})}); p=t.p; await t.linesUp();
  ok("not set up (from the status): said before anything is sent, the button off and the form usable", (await t.txt("#scFillOff")).startsWith("Claude isn't connected yet, so the form can't be filled in from a description. The owner sets ANTHROPIC_API_KEY on Supabase (README, step 6).") && await p.isDisabled("#scFillGo") && await p.isEnabled("#scGo"));
  await t.ctx.close();

  // ===== no line names, and a year change =====
  t=await open({lines:()=>({status:502, body:{error:"snowflake_server", message:"Snowflake answered 500. Try again in a few minutes."}}), fill:()=>J200({request:{...copy(FILL.filled.request), lines:[]}, notes:["Lines couldn't be chosen: S&P's line names for the year weren't available."]})}); p=t.p;
  await t.until(async()=>!!(await p.$("#scLinesErr")));
  await t.fillIn(TEXT);
  ok("with no line names on the page, the fill sends an empty list", same(t.fills()[0].lines, []));
  ok("and shows the note saying lines couldn't be chosen", (await t.txt("#scFillNotes")).includes("Lines couldn't be chosen"));
  await t.ctx.close();
  t=await open({fill:()=>J200({request:{...copy(FILL.filled.request), year:2024, lines:[]}, notes:[]})}); p=t.p; await t.linesUp();
  await t.fillIn("the same but for 2024");
  ok("a fill that changes the year loads S&P's line names for that year", (await t.form()).year==="2024" && await t.until(async()=>t.calls.some(c=>c.body.action==="screen-lines" && c.body.year===2024)));
  await t.ctx.close();

  // ===== keyboard =====
  t=await open(); p=t.p; await t.linesUp();
  await p.focus("#scFillText"); await p.keyboard.type("Texas workers comp writers");
  await p.keyboard.press("Tab");
  ok("Tab from the box reaches Fill in the form, then Start over", await p.evaluate(()=>document.activeElement.id==="scFillGo") && await p.keyboard.press("Tab").then(()=>p.evaluate(()=>document.activeElement.id==="scFillReset")));
  await p.focus("#scFillText"); await p.keyboard.press("Enter");
  ok("Enter alone makes a new line in the box and sends nothing", t.fills().length===0 && (await p.inputValue("#scFillText")).endsWith("\n"));
  await p.keyboard.press("Control+Enter"); await t.until(async()=>!!(await p.$("#scFillDone")));
  ok("Ctrl+Enter in the box fills in the form", t.fills().length===1 && t.fills()[0].text==="Texas workers comp writers");
  await p.focus("#scFillGo"); await p.keyboard.press("Enter"); await t.until(async()=>t.fills().length===2);
  ok("the button works from the keyboard", t.fills().length===2);
  await t.ctx.close();

  // ===== a reader sees none of it =====
  t=await open({role:"reader"}); p=t.p;
  ok("a reader has no box and the view says it is for Corp Dev", !(await p.$("#scFill")) && (await t.txt("#scOnly"))==="This view is for Corp Dev logins.");
  ok("and nothing is sent to the fill", t.fills().length===0);
  await t.ctx.close();

  // ===== 390 wide =====
  t=await open({width:390}); p=t.p; await t.linesUp();
  ok("no sideways scroll at 390 with the empty box", await t.noScroll());
  await t.fillIn(TEXT);
  ok("no sideways scroll at 390 once filled in, with the notes", await t.noScroll() && await p.isVisible("#scFillNotes"));
  ok("the box is no wider than the screen", await p.$eval("#scFillText", el=>el.getBoundingClientRect().right<=window.innerWidth));
  await p.screenshot({path:path.join(OUTDIR,"screenfill-390.png"), fullPage:true});
  await p.reload(); await p.waitForTimeout(500);
  ok("after a reload the box is empty: the description was in memory only", (await p.inputValue("#scFillText").catch(()=>"gone"))==="" && !(await p.$("#scFillDone")));
  ok("no page errors", errs.length===0, errs);
  await t.ctx.close();

  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
