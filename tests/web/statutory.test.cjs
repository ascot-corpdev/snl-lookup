// The Statutory view: the "not set up yet" and "not mapped yet" states, the one-off set-up panel (Corp Dev only),
// the search form, the blocks of figures with peers, formatting, saved results and Refresh, exports and errors.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), STAT=FIX("web_statutory.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const FAKE_XLSX='window.XLSX={utils:{aoa_to_sheet:a=>({aoa:a}),book_new:()=>({sheets:[]}),book_append_sheet:(wb,ws,name)=>{wb.sheets.push({name,aoa:ws.aoa});}},write:(wb,o)=>new TextEncoder().encode(JSON.stringify({opts:o,sheets:wb.sheets}))};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], delay:0, statStatus:()=>({status:200, body:copy(STAT.statusMapped)}),
      query:()=>({status:200, body:copy(STAT.query)}),
      discover:body=>({status:200, body:copy(body.view?STAT.columns:STAT.views)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body, auth:req.headers()["authorization"], apikey:req.headers()["apikey"]});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev", statutory:{configured:t.statStatus().body.configured===true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory"){ const a = body.action==="status" ? t.statStatus() : body.action==="query" ? t.query(body) : body.action==="discover" ? t.discover(body) : {status:400, body:{error:"bad",message:"Unknown action."}};
          if(t.delay && body.action==="query") await new Promise(res=>setTimeout(res,t.delay)); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/xlsx/.test(u)) return r.fulfill({contentType:"application/javascript",body:FAKE_XLSX});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+"#statutory"); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=(fn,a)=>t.calls.filter(c=>c.fn===fn && c.body.action===a);
    t.table=async id=>p.$eval(`.statblk[data-field="${id}"] table`,e=>({head:[...e.querySelectorAll("th")].map(x=>x.textContent), rows:[...e.querySelectorAll("tbody tr")].map(r=>[...r.children].map(c=>c.innerText.replace(/\s+/g," ").trim()))}));
    t.run=async codes=>{ await p.fill("#st_codes",codes); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(400); };
    t.download=async click=>{ const [d]=await Promise.all([p.waitForEvent("download"), click()]); return {name:d.suggestedFilename(), text:fs.readFileSync(await d.path(),"utf8")}; };
    return t;
  }
  const OFF=()=>({status:200, body:copy(STAT.statusOff)}), UNMAPPED=()=>({status:200, body:copy(STAT.statusUnmapped)}), MAPPED=()=>({status:200, body:copy(STAT.statusMapped)});

  // ----- not set up yet -----
  let t=await open({}, {statStatus:OFF}); let p=t.p;
  ok("not set up: the function's message, calmly", (await t.txt("#statOff"))===STAT.statusOff.message && (await p.getAttribute("#statOff","role"))==="status" && !(await p.$("#view [role=alert]")), await t.txt("#statOff"));
  ok("not set up: says what will appear", same(await t.all("#statComing li"),["Direct and net premiums written, by line of business and by state","Policyholder surplus","Loss, expense and combined ratios for the last five years","The same figures for peers, side by side, by NAIC company or group code"]));
  ok("not set up: nothing to click, even for Corp Dev", !(await p.$("#statForm")) && !(await p.$("#setup")) && (await p.$$("#view button, #view input, #view select, #view textarea")).length===0);
  ok("status asked once, with the login's token and the publishable key", same(t.of("snl-statutory","status").map(c=>c.body),[{action:"status"}]) && t.of("snl-statutory","status")[0].auth==="Bearer t" && t.of("snl-statutory","status")[0].apikey==="sb_publishable_k");
  ok("the strip agrees", (await t.txt("#s_stat"))==="Statutory data: not set up yet");
  await p.screenshot({path:OUTDIR+"/statutory-off-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on the not set up state", await t.noScroll());
  await p.screenshot({path:OUTDIR+"/statutory-off-390.png",fullPage:true});
  await t.ctx.close();
  t=await open({}, {statStatus:()=>({status:200, body:{configured:false, mapped:false, message:null, fields:[]}})}); p=t.p;
  ok("not set up and no message: the page's own words", (await t.txt("#statOff"))==="Statutory data isn't set up yet. It needs a Snowflake reader account from S&P.");
  await t.ctx.close();

  // ----- connected, not mapped: a reader -----
  t=await open({role:"reader"}, {statStatus:UNMAPPED}); p=t.p;
  ok("not mapped, reader: told to ask Corp Dev, no set-up", (await t.txt("#statUnmapped"))===STAT.statusUnmapped.message+" Ask Corp Dev to finish the set-up." && !(await p.$('button[data-act="su-toggle"]')) && !(await p.$("#setup")) && !(await p.$("#statForm")), await t.txt("#statUnmapped"));
  await t.ctx.close();

  // ----- connected, not mapped: Corp Dev does the one-off set-up -----
  t=await open({seed:[["snl_settings","statutory_mapping",{doc:STAT.mapping}]]}, {statStatus:UNMAPPED}); p=t.p;
  ok("not mapped, Corp Dev: the function's message and the set-up on offer", (await t.txt("#statUnmapped"))===STAT.statusUnmapped.message+"Start the set-up" && (await t.txt('button[data-act="su-toggle"]'))==="Start the set-up" && !(await p.$("#statForm")) && (await p.getAttribute("#statUnmapped","role"))==="status");
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(250);
  ok("the panel is labelled as one-off set-up for Corp Dev", (await t.txt("#setup h3"))==="One-off set-up: tell the app where each figure lives in Snowflake" && (await t.txt("#setup")).includes("Do this once") && (await t.txt("#setup")).includes("Only Corp Dev logins see this panel."));
  ok("it lists the figures and whether each is mapped", same(await t.all("#suFields span"),["dpw_by_line Direct premiums written by line (not mapped)","surplus Policyholder surplus (not mapped)","combined_ratio Combined ratio (not mapped)"]));
  ok("the saved mapping is read from snl_settings and shown as JSON", same(JSON.parse(await p.inputValue("#su_map")),STAT.mapping) && (await p.inputValue("#su_map")).includes('\n  "fields": {'));
  await p.fill("#su_like","STAT"); await p.press("#su_like","Enter"); await p.waitForTimeout(300);
  ok("List views asks the function, with the filter", same(t.of("snl-statutory","discover").map(c=>c.body),[{action:"discover",like:"STAT"}]) && t.of("snl-statutory","discover")[0].auth==="Bearer t");
  const views=await p.$$eval("#suViews tbody tr",r=>r.map(x=>[...x.children].map(c=>c.textContent)));
  ok("views listed with type and comment, n/d where there is none", views.length===3 && same(views[0],["STAT_PREMIUMS_BY_LINE","VIEW","Premiums written by line of business"]) && same(views[1],["STAT_FINANCIALS","VIEW","n/d"]), views);
  ok("hostile view names and comments show as text", views[2][0]==='STAT_<img src=x onerror="window.__xss=1">' && views[2][2]==="<script>window.__xss=1</script>" && !(await p.$("#setup img,#setup script")) && await p.evaluate(()=>window.__xss===undefined));
  await p.click('button[data-act="su-views"][data-refresh]'); await p.waitForTimeout(300);
  ok("Ask Snowflake again sends refresh", same(t.of("snl-statutory","discover").pop().body,{action:"discover",like:"STAT",refresh:true}));
  await p.fill("#su_like",""); await p.click('button[data-act="su-views"] >> nth=0'); await p.waitForTimeout(300);
  ok("no filter: just discover", same(t.of("snl-statutory","discover").pop().body,{action:"discover"}));
  await p.fill("#su_map",'{"half": "typed"');
  await p.click('#suViews button[data-name="STAT_PREMIUMS_BY_LINE"]'); await p.waitForTimeout(300);
  ok("a view lists its columns, in S&P's order", same(t.of("snl-statutory","discover").pop().body,{action:"discover",view:"STAT_PREMIUMS_BY_LINE"}) && same(await t.all("#suCols tbody tr td:first-child"),["NAIC_COMPANY_CODE","FISCAL_YEAR","LINE_OF_BUSINESS","DIRECT_PREMIUMS_WRITTEN"]) && (await t.txt("#setup")).includes("2. Columns in STAT_PREMIUMS_BY_LINE"));
  ok("column comments: n/d where there is none, hostile ones as text", same(await t.all("#suCols tbody tr td:last-child"),["NAIC company code","n/d","<script>window.__xss=1</script>","US dollars"]) && await p.evaluate(()=>window.__xss===undefined));
  ok("half-typed mapping survives the panel redrawing", (await p.inputValue("#su_map"))==='{"half": "typed"');
  await p.screenshot({path:OUTDIR+"/statutory-setup-1440.png",fullPage:true});
  const save=async text=>{ await p.fill("#su_map",text); await p.click('button[data-act="su-save"]'); await p.waitForTimeout(250); return t.txt("#suErr"); };
  ok("mapping check: must be JSON", (await save('{"half": "typed"')).startsWith("This isn't valid JSON yet: "));
  ok("mapping check: must be an object", (await save("[]"))==='The mapping must be an object, like {"fields": {...}}.');
  ok("mapping check: needs fields", (await save('{"field": {}}'))==='The mapping needs a "fields" object, with one entry for each figure.');
  ok("mapping check: fields must be an object, not a list", (await save('{"fields": []}'))==='The mapping needs a "fields" object, with one entry for each figure.');
  ok("mapping check: each entry must be an object", (await save('{"fields": {"surplus": "STAT_FINANCIALS"}}'))==='The entry for "surplus" must be an object with view, entity, year and value.');
  ok("nothing saved while the mapping is wrong", (await p.evaluate(()=>__mock.log.filter(l=>l.op==="upsert").length))===0 && same(await p.evaluate(()=>__mock.row("snl_settings","statutory_mapping").doc),STAT.mapping));
  await p.evaluate(()=>{ __mock.denySettings=true; });
  const NEW={fields:{...STAT.mapping.fields, combined_ratio:{view:"STAT_FINANCIALS", entity:{company:"NAIC_COMPANY_CODE"}, year:"FISCAL_YEAR", value:"COMBINED_RATIO", where:[{column:"BASIS", equals:"NET"}], scale:100}}};
  ok("the database refuses: says only Corp Dev can save", (await save(JSON.stringify(NEW)))==="Only Corp Dev logins can save the mapping.");
  await p.evaluate(()=>{ __mock.denySettings=false; });
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the set-up panel open", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/statutory-setup-390.png",fullPage:true});
  // a view name with no break points, longer than the phone is wide
  const LONGVIEW="STAT_INSURANCE_REGULATORY_PREMIUMS_BY_LINE_OF_BUSINESS_AND_STATE_DETAIL";
  const keepDiscover=t.discover;
  t.discover=body=>({status:200, body: body.view ? {view:LONGVIEW, columns:[{name:"NAIC_COMPANY_CODE",type:"TEXT",position:1,comment:null}], fetchedAt:"2026-11-13T12:00:00Z", fromStore:false} : {views:[{name:LONGVIEW,type:"VIEW",comment:null}], fetchedAt:"2026-11-13T12:00:00Z", fromStore:false}});
  await p.fill("#su_like","LONG"); await p.click('button[data-act="su-views"] >> nth=0'); await p.waitForTimeout(300);
  await p.click('button[data-act="su-view"]'); await p.waitForTimeout(300);
  ok("phone: a very long view name wraps instead of pushing the page sideways", (await t.txt("#setup")).includes("Columns in "+LONGVIEW) && await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/statutory-longview-390.png",fullPage:true});
  t.discover=keepDiscover; await p.fill("#su_like","");
  await p.setViewportSize({width:1440,height:900});
  t.statStatus=MAPPED; const nStatus=t.of("snl-statutory","status").length;
  await p.click('button[data-act="su-save"]'); await p.waitForTimeout(450);
  ok("a good mapping is written to snl_settings as the document", same(await p.evaluate(()=>__mock.row("snl_settings","statutory_mapping")).then(r=>({id:r.id,doc:r.doc})),{id:"statutory_mapping",doc:NEW}) && (await t.txt("#toastRoot"))==="Mapping saved");
  ok("then the view checks again and opens the search", t.of("snl-statutory","status").length===nStatus+1 && await p.isVisible("#statForm") && !(await p.$("#statUnmapped")));
  ok("the panel stays open for more edits, and can be hidden", await p.isVisible("#setup") && (await t.txt('button[data-act="su-toggle"]'))==="Hide field set-up");
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(100);
  ok("hidden", !(await p.$("#setup")) && (await t.txt('button[data-act="su-toggle"]'))==="Field set-up");
  await t.ctx.close();

  // set-up with nothing saved yet, and a refused discover
  t=await open({}, {statStatus:()=>({status:200, body:{...copy(STAT.statusUnmapped), message:null}}), discover:()=>({status:403, body:{error:"forbidden",message:"Only Corp Dev logins can look at Snowflake's views."}})}); p=t.p;
  ok("not mapped and no message: the page's own words", (await t.txt("#statUnmapped"))==="Snowflake is connected, but the statutory fields aren't mapped yet.Start the set-up");
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(250);
  ok("no mapping saved yet: an empty one to start from", (await p.inputValue("#su_map"))==='{\n  "fields": {}\n}');
  await p.click('button[data-act="su-views"]'); await p.waitForTimeout(300);
  ok("discover refused: the function's message", (await t.txt("#setup .banner"))==="Couldn't list the views. Only Corp Dev logins can look at Snowflake's views." && !(await p.$("#suViews")));
  t.discover=()=>({status:200, body:{views:[], fetchedAt:"2026-11-13T12:00:00Z", fromStore:false}});
  await p.click('button[data-act="su-views"]'); await p.waitForTimeout(300);
  ok("no views: says what that may mean", (await t.txt("#setup")).includes("No views match. That may mean the Snowflake login can't see them yet."));
  await t.ctx.close();

  // ----- mapped: the search form -----
  t=await open(); p=t.p;
  ok("mapped: the form, with the last five full years", await p.isVisible("#statForm") && (await p.inputValue("#st_from"))==="2021" && (await p.inputValue("#st_to"))==="2025" && (await p.getAttribute('button[data-k="company"]',"aria-pressed"))==="true" && (await t.txt("#statEmpty")).startsWith("Type the NAIC code of the company you want"));
  await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(100);
  ok("no code: refused", (await t.txt("#statErr"))==="Type at least one NAIC company code." && t.of("snl-statutory","query").length===0);
  await p.fill("#st_codes","1 2 3 4 5 6 7 8 9"); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(100);
  ok("more than eight codes: refused", (await t.txt("#statErr"))==="Compare at most 8 codes at a time: one subject and 7 peers.");
  await p.fill("#st_codes","90001, 90-107!"); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(100);
  ok("an odd code: refused", (await t.txt("#statErr"))==="NAIC codes are numbers of up to 6 digits, like 90001. Separate them with commas.");
  await p.fill("#st_codes","90001"); await p.fill("#st_from","2005"); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(100);
  ok("more than 15 years: refused", (await t.txt("#statErr"))==="Choose at most 15 years at a time.");
  await p.fill("#st_codes","90001"); await p.fill("#st_from","2026"); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(100);
  ok("years the wrong way round: refused", (await t.txt("#statErr"))==="The first year is after the last year.");
  await p.fill("#st_from","1800"); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(100);
  ok("a year out of range: refused", (await t.txt("#statErr"))==="Choose years between 1990 and 2026." && t.of("snl-statutory","query").length===0);
  await p.fill("#st_from","2021");
  await p.click('button[data-k="group"]'); await p.waitForTimeout(100); await p.fill("#st_codes",""); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(100);
  ok("group codes: the wording follows", (await t.txt("#statErr"))==="Type at least one NAIC group code." && (await t.txt("#statForm")).includes("NAIC group codes"));
  await t.run("9001");
  ok("group search sends kind group", same(t.of("snl-statutory","query")[0].body,{action:"query",kind:"group",codes:["9001"],fromYear:2021,toYear:2025}));
  await p.click('button[data-k="company"]'); await p.waitForTimeout(100);

  // ----- results -----
  t.delay=400; await p.fill("#st_codes","90001, 90107 90001"); await p.press("#st_codes","Enter"); await p.waitForTimeout(150);
  ok("while fetching: says so, and the button waits", (await t.txt("#statResults .banner")).startsWith("Fetching statutory data from Snowflake…") && await p.isDisabled('button[data-act="stat-search"]'));
  await p.waitForTimeout(600); t.delay=0;
  const q=t.of("snl-statutory","query").pop();
  ok("what the page sends: the subject first, then peers, as text; years as numbers", same(q.body,{action:"query",kind:"company",codes:["90001","90107"],fromYear:2021,toYear:2025}) && q.auth==="Bearer t" && q.apikey==="sb_publishable_k", q.body);
  ok("one block for each figure, in the function's order", same(await p.$$eval(".statblk",e=>e.map(x=>x.dataset.field)),["dpw_by_line","dpw_by_state","npw_by_line","surplus","loss_ratio","expense_ratio","combined_ratio"]));
  const sur=await t.table("surplus");
  ok("by year: years across, the subject first and peers beside it", same(sur.head,["Company","2021","2022","2023","2024","2025"]) && sur.rows[0][0]==="Calloway Insurance Co (NAIC 90001) Subject" && sur.rows[1][0]==="Tarrow Mutual Insurance Co (NAIC 90107) Peer", sur);
  ok("dollars in $M: commas, one decimal under 10, negatives in parentheses, n/d when missing", same(sur.rows[0].slice(1),["$412M","$455M","$8.4M","n/d","($3.2M)"]) && same(sur.rows[1].slice(1),["$1,235M","n/d","n/d","n/d","$0M"]), sur.rows);
  const cr=await t.table("combined_ratio");
  ok("percentages to one decimal, negatives in parentheses", same(cr.rows[0].slice(1),["95.3%","101.2%","n/d","n/d","98.0%"]) && same(cr.rows[1].slice(1),["(1.5%)","n/d","n/d","n/d","104.8%"]), cr.rows);
  ok("each block says its unit; a hostile label shows as text", (await t.txt('.statblk[data-field="surplus"] h3'))==="Policyholder surplus $M" && (await t.txt('.statblk[data-field="combined_ratio"] h3'))==="Combined <b>ratio</b> %");
  const ln=await t.table("dpw_by_line");
  ok("by line: one row a line for the subject, largest in the latest year first", same(ln.head,["Line of business","2021","2022","2023","2024","2025"]) && same(ln.rows,[["Private passenger auto","n/d","n/d","n/d","$512M","$499M"],["Homeowners","n/d","n/d","n/d","$310M","$342M"],["Inland marine","n/d","n/d","n/d","n/d","$7.3M"]]), ln.rows);
  ok("by line: a company selector, on the subject", same(await p.$$eval('select[data-ent="dpw_by_line"] option',o=>o.map(x=>x.textContent+(x.selected?"*":""))),["Calloway Insurance Co (NAIC 90001)*","Tarrow Mutual Insurance Co (NAIC 90107)"]));
  await p.selectOption('select[data-ent="dpw_by_line"]',"90107"); await p.waitForTimeout(150);
  ok("choosing a peer shows its lines; other blocks stay on the subject", same((await t.table("dpw_by_line")).rows,[["Homeowners","n/d","n/d","n/d","n/d","$88M"],["Dwelling fire","n/d","n/d","n/d","n/d","$13M"]]) && same((await t.table("dpw_by_state")).rows,[["TX","n/d","n/d","n/d","n/d","$1,235M"],["FL","n/d","n/d","n/d","n/d","$421M"]]), (await t.table("dpw_by_state")).rows);
  ok("a figure with no rows reads n/d, and isn't taken for zero", (await t.txt('.statblk[data-field="npw_by_line"] p'))==="S&P returned nothing for this figure, so it shows as n/d. That doesn't prove the figure is zero." && !(await p.$('.statblk[data-field="npw_by_line"] table')));
  ok("a figure that failed shows the function's reason", (await t.txt('.statblk[data-field="loss_ratio"] .err'))==="Snowflake couldn't find the column LOSS_RATIO in STAT_FINANCIALS. Check the mapping.");
  ok("a figure that isn't mapped says so", (await t.txt('.statblk[data-field="expense_ratio"] p'))==="This figure isn't mapped to a Snowflake column yet. Add it in the field set-up below.");
  ok("when S&P last loaded each view, and the source", (await t.txt("#statSource"))==="S&P last loaded STAT_PREMIUMS_BY_LINE on 28 Oct. S&P last loaded STAT_FINANCIALS on 30 Dec 2025. Source: S&P Global Market Intelligence statutory data, through Snowflake, fetched 12 Nov. US dollars are shown in $M.", await t.txt("#statSource"));
  ok("no em dashes in the view", !(await p.evaluate(()=>document.body.innerText)).includes("—"));
  await p.screenshot({path:OUTDIR+"/statutory-results-1440.png",fullPage:true});

  const F=await p.evaluate(()=>[usdM(1234567890),usdM(9940000),usdM(9960000),usdM(-12000000),usdM(0),usdM(null),usdM(""),usdM("x"),pct(0),pct(12.345),pct(-0.04),pct(undefined),count(12000),count(null)]);
  ok("number formats at the edges", same(F,["$1,235M","$9.9M","$10M","($12M)","$0M","n/d","n/d","n/d","0.0%","12.3%","0.0%","n/d","12,000","n/d"]), F);

  // ----- exports -----
  const csv=await t.download(()=>p.click('.statblk[data-field="surplus"] button[data-fmt="csv"]')); const L=csv.text.split("\r\n");
  ok("block CSV: raw figures with the unit named", csv.name==="snl-statutory-surplus-2026-11-13.csv" && L.length===3 && L[0].slice(1)==='"NAIC code","Name","Unit","2021","2022","2023","2024","2025"' && L[1]==='"90001","Calloway Insurance Co","US dollars","412300000","455100000","8400000","","-3200000"', L);
  const csv2=await t.download(()=>p.click('.statblk[data-field="dpw_by_line"] button[data-fmt="csv"]')); const L2=csv2.text.split("\r\n");
  ok("by-line CSV: every company, not just the one on screen", L2.length===6 && L2[0].slice(1).startsWith('"NAIC code","Name","Line of business","Unit","2021"') && L2[5]==='"90107","Tarrow Mutual Insurance Co","Dwelling fire","US dollars","","","","","12900000"', L2);
  const xl=await t.download(()=>p.click('.statblk[data-field="combined_ratio"] button[data-fmt="xlsx"]')); const wb=JSON.parse(xl.text);
  ok("block XLSX: numbers as numbers, gaps empty, a safe sheet name", xl.name==="snl-statutory-combined_ratio-2026-11-13.xlsx" && wb.sheets[0].name==="Combined <b>ratio< b>" && same(wb.sheets[0].aoa[1],["90001","Calloway Insurance Co","%",95.3,101.2,"","",98]), wb.sheets[0]);

  // ----- saved results and Refresh -----
  ok("saved figures say when they were fetched and offer Refresh", (await t.txt("#statFromStore"))==="From the last fetch on 12 Nov.Refresh");
  t.query=body=>({status:200, body:{...copy(STAT.query), fromStore:!body.refresh, fetchedAt:"2026-11-13T12:00:00Z", truncated:true}});
  await p.fill("#st_codes","99999");
  await p.click('button[data-act="stat-refresh"]'); await p.waitForTimeout(400);
  ok("Refresh sends the same question again with refresh, not the edited form", same(t.of("snl-statutory","query").pop().body,{action:"query",kind:"company",codes:["90001","90107"],fromYear:2021,toYear:2025,refresh:true}) && !(await p.$("#statFromStore")));
  ok("figures that were cut short say so", (await t.txt("#statTruncated")).startsWith("These figures are incomplete.") && (await p.getAttribute("#statTruncated","role"))==="alert");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on the figures; tables scroll inside their own box", await t.noScroll() && await p.$eval('.statblk[data-field="surplus"] .tbl-wrap',e=>e.scrollWidth>e.clientWidth), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/statutory-results-390.png",fullPage:true});
  await p.evaluate(()=>window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(80);
  ok("phone: the Ask Claude button is there, and the last figures scroll clear of it", (await t.txt("#askFab"))==="Ask Claude" && await p.evaluate(()=>{ const a=document.getElementById("askFab").getBoundingClientRect(), last=document.getElementById("statSource").getBoundingClientRect(); return last.bottom<=a.top && a.right<=innerWidth; }));
  await p.evaluate(()=>window.scrollTo(0,0));
  t.query=()=>({status:200, body:{...copy(STAT.query), loaded:[{view:"STAT_INSURANCE_REGULATORY_PREMIUMS_BY_LINE_OF_BUSINESS_AND_STATE_DETAIL", at:"2026-11-01T04:00:00"}]}});
  await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(400);
  ok("phone: a very long view name in the source line wraps too", (await t.txt("#statSource")).includes("STAT_INSURANCE_REGULATORY_PREMIUMS_BY_LINE_OF_BUSINESS_AND_STATE_DETAIL") && await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(250);
  ok("phone: no sideways scroll with the figures and the set-up panel", await p.isVisible("#setup") && await t.noScroll());
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(100);
  await p.setViewportSize({width:1440,height:900});

  // ----- problems -----
  const DOWN={status:502, body:{error:"snowflake_error",message:"Snowflake didn't answer in time. Try again in a minute."}};
  t.query=body=>body.refresh ? DOWN : {status:200, body:copy(STAT.query)};
  await t.run("90001, 90107"); await p.click('button[data-act="stat-refresh"]'); await p.waitForTimeout(400);
  ok("a failed refresh keeps the saved figures and says why", (await t.txt("#statResults .banner >> nth=0"))==="Couldn't refresh the statutory data. Snowflake didn't answer in time. Try again in a minute.Try again" && (await p.$$(".statblk")).length===7);
  t.query=()=>DOWN; await t.run("90001");
  ok("a failed search: the function's message and Try again", (await t.txt("#statResults .banner[role=alert]"))==="Couldn't fetch the statutory data. Snowflake didn't answer in time. Try again in a minute.Try again" && !(await p.$(".statblk")));
  t.query=()=>({status:200, body:{...copy(STAT.query), codes:["90001"], entities:[{code:"90001",name:"<script>window.__xss=1</script>"}], fromStore:false}});
  await p.click('button[data-act="stat-retry"]'); await p.waitForTimeout(400);
  const one=await t.table("surplus");
  ok("Try again works; a hostile name is text; a company S&P didn't name still shows, by its code", one.rows.length===2 && one.rows[0][0]==="<script>window.__xss=1</script> (NAIC 90001) Subject" && one.rows[1][0]==="NAIC 90107 Peer" && await p.evaluate(()=>window.__xss===undefined), one.rows);
  t.query=()=>({status:200, body:{...copy(STAT.query), codes:["90001"], entities:[{code:"90001",name:"Calloway Insurance Co"}], fields:[{...copy(STAT.query.fields[3]), rows:STAT.query.fields[3].rows.filter(r=>r.code==="90001")}], fromStore:false}});
  await t.run("90001");
  ok("one company alone: no subject or peer tag, and no company selector", same((await t.table("surplus")).rows.map(r=>r[0]),["Calloway Insurance Co (NAIC 90001)"]) && !(await p.$("select[data-ent]")));
  t.query=()=>({status:200, body:{...copy(STAT.query), fields:[], fromStore:false}});
  await t.run("90001");
  ok("no figures at all: says so without claiming there are none", (await t.txt("#statResults .empty"))==="No figures came back for these codes and years. That doesn't prove there are none.");
  t.query=()=>({status:503, body:{error:"not_configured",message:STAT.statusOff.message}}); t.statStatus=OFF;
  await t.run("90001");
  ok("turns out not to be set up: back to the calm state", (await t.txt("#statOff"))===STAT.statusOff.message && !(await p.$("#statForm")) && !(await p.$("#view [role=alert]")));
  await t.ctx.close();

  t=await open({role:"reader"}); p=t.p;
  ok("a reader gets the search but no set-up", await p.isVisible("#statForm") && !(await p.$('button[data-act="su-toggle"]')));
  t.query=()=>({status:200, body:copy(STAT.query)}); await t.run("90001, 90107");
  ok("a reader is told to ask Corp Dev about an unmapped figure", (await t.txt('.statblk[data-field="expense_ratio"] p'))==="This figure isn't mapped to a Snowflake column yet. Ask Corp Dev.");
  t.query=()=>({status:409, body:{error:"not_mapped",message:"Snowflake is connected, but the statutory fields aren't mapped to S&P's views yet. A Corp Dev login can do this once on the Statutory view."}}); t.statStatus=UNMAPPED;
  await t.run("90001");
  ok("the mapping has gone: the view says so", (await t.txt("#statUnmapped")).startsWith("Snowflake is connected, but the statutory fields aren't mapped") && !(await p.$("#statForm")));
  await t.ctx.close();

  // the status check itself fails
  t=await open({}, {statStatus:()=>({status:500, body:{error:"server",message:"The statutory function failed: made-up fault"}})}); p=t.p;
  ok("can't check: the reason and Try again", (await t.txt("#view .banner[role=alert]"))==="Couldn't check the statutory data. The statutory function failed: made-up fault Try again".replace(" Try again","Try again"), await t.txt("#view .banner"));
  t.statStatus=MAPPED; await p.click('button[data-act="stat-status-retry"]'); await p.waitForTimeout(350);
  ok("Try again opens the view", await p.isVisible("#statForm"));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
