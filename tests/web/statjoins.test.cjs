// The Field set-up panel for figures spread over several joined views in several schemas: list the schemas, pick
// one, list its views and a wide view's columns with the "columns containing" filter, paste a joined mapping,
// save it, and see the reasons the function gives for any figure it can't use. At 1440 and 390 wide with no
// sideways scroll, and the Statutory view still showing a result, with run dates by schema.
// Every schema, view, column, company and figure here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SJ=FIX("statjoins_web.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };
// A very wide made-up view: 950 columns, a few with long names or descriptions, one hostile.
const WIDE=Array.from({length:950},(_,i)=>({name:i===0?"PERIOD_ID":i===1?"NPE_000":i===2?"NPE_ADJUSTED_FOR_PORTFOLIO_TRANSFERS_AND_COMMUTATIONS_000":`COL_${String(i).padStart(4,"0")}`, type:i<2?"NUMBER":"TEXT", position:i+1,
  comment:i===1?"Made-up: net premiums earned, thousands":i===3?'<img src=x onerror="window.__xss=1">':i===4?"A made-up description long enough to need wrapping on a phone screen without pushing the page sideways at all":null}));
(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[], statStatus:()=>({status:200, body:copy(SJ.statusUnmapped)}), query:()=>({status:200, body:copy(SJ.query)}),
      discover:body=>body.schemas ? {status:200, body:copy(SJ.schemas)}
        : body.view ? {status:200, body:{...(body.schema?{schema:body.schema}:{}), view:body.view, columns:body.view==="FIN_FLOW_B"?copy(WIDE):[{name:"ENTITY_ID",type:"NUMBER",position:1,comment:null}], fetchedAt:"2026-11-13T12:00:00Z", fromStore:false}}
        : {status:200, body:{...(body.schema?{schema:body.schema}:{}), views:copy(body.schema?SJ.views[body.schema]||[]:[{name:"DEFAULT_ONLY_VIEW",type:"VIEW",comment:null}]), truncated:false, fetchedAt:"2026-11-13T12:00:00Z", fromStore:false}}, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev", statutory:{configured:true}});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        if(fn==="snl-statutory"){ const a = body.action==="status" ? t.statStatus() : body.action==="query" ? t.query(body) : body.action==="discover" ? t.discover(body) : {status:400, body:{error:"bad",message:"Unknown action."}}; return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+"#statutory"); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.disc=()=>t.calls.filter(c=>c.fn==="snl-statutory" && c.body.action==="discover").map(c=>c.body);
    return t;
  }

  // ----- Corp Dev: schemas, views, columns -----
  let t=await open(); let p=t.p;
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(250);
  ok("the panel says which schema it is looking in: the default one to start with", (await t.txt("#suSchemaNow"))==="Looking in the default schema (the SNOWFLAKE_SCHEMA secret).");
  ok("the help for joined mappings is there, folded away, with a made-up example that is valid JSON", await p.$("#suHelp:not([open])") && same(Object.keys(JSON.parse(await p.textContent("#suExample"))),["fields","loaded"]) && JSON.parse(await p.textContent("#suExample")).fields.npe.joins.length===3);
  await p.click('button[data-act="su-schemas"]'); await p.waitForTimeout(300);
  ok("List schemas asks the function for the schemas", same(t.disc(),[{action:"discover",schemas:true}]));
  ok("the schemas are offered as choices, the default first and chosen", same(await t.all("#suSchemas button"),["Default schema","CORE_FIN","ENTITY","REINS"]) && (await p.getAttribute('#suSchemas button[data-name=""]',"aria-pressed"))==="true");
  await p.click('#suSchemas button[data-name="CORE_FIN"]'); await p.waitForTimeout(300);
  ok("choosing a schema lists its views at once, with the schema sent", same(t.disc().pop(),{action:"discover",schema:"CORE_FIN"}) && same(await t.all("#suViews tbody tr td:first-child"),["FIN_FLOW_B","FLOW_PERIOD","STOCK_PERIOD"]) && (await t.txt("#suSchemaNow"))==="Looking in CORE_FIN." && (await p.getAttribute('#suSchemas button[data-name="CORE_FIN"]',"aria-pressed"))==="true");
  await p.fill("#su_like","FLOW"); await p.press("#su_like","Enter"); await p.waitForTimeout(300);
  ok("a view filter in a chosen schema sends both", same(t.disc().pop(),{action:"discover",schema:"CORE_FIN",like:"FLOW"}));
  await p.click('button[data-act="su-views"][data-refresh]'); await p.waitForTimeout(300);
  ok("Ask Snowflake again keeps the schema", same(t.disc().pop(),{action:"discover",schema:"CORE_FIN",like:"FLOW",refresh:true}));
  await p.click('#suViews button[data-name="FIN_FLOW_B"]'); await p.waitForTimeout(400);
  ok("a view's columns are asked for in that schema", same(t.disc().pop(),{action:"discover",schema:"CORE_FIN",view:"FIN_FLOW_B"}));
  ok("the heading names the view with its schema, as the mapping should write it", (await t.txt("#setup")).includes("2. Columns in CORE_FIN.FIN_FLOW_B write the view as CORE_FIN.FIN_FLOW_B in the mapping"));
  ok("all 950 columns are listed until a filter is typed", (await p.$$("#suCols tbody tr")).length===950 && !(await p.$("#suColsCount")));
  ok("a hostile column description shows as text", (await p.$$eval("#suCols tbody tr",r=>r[3].children[2].textContent))==='<img src=x onerror="window.__xss=1">' && !(await p.$("#suCols img")) && await p.evaluate(()=>window.__xss===undefined));
  await p.click("#su_colLike"); await p.keyboard.type("npe");
  await p.waitForTimeout(150);
  ok("typing in the column filter narrows the list as you type, by name or description, any case", same(await t.all("#suCols tbody tr td:first-child"),["NPE_000","NPE_ADJUSTED_FOR_PORTFOLIO_TRANSFERS_AND_COMMUTATIONS_000"]) && (await t.txt("#suColsCount"))==="Showing 2 of 950 columns.");
  ok("the filter box keeps the cursor while the list changes", await p.evaluate(()=>document.activeElement&&document.activeElement.id==="su_colLike") && (await p.inputValue("#su_colLike"))==="npe");
  await p.keyboard.type("zz"); await p.waitForTimeout(150);
  ok("a filter that matches nothing says so plainly", (await t.txt("#suColsNone"))==='No column name or description contains "npezz".' && !(await p.$("#suCols")));
  await p.fill("#su_colLike","thousands"); await p.waitForTimeout(150);
  ok("the filter also finds words in S&P's description", same(await t.all("#suCols tbody tr td:first-child"),["NPE_000"]));
  await p.fill("#su_colLike","COL_0"); await p.waitForTimeout(150);
  ok("the count reads with commas", (await t.txt("#suColsCount"))==="Showing 947 of 950 columns.");
  await p.fill("#su_map", '{"half": "typed"');
  await p.click('#suSchemas button[data-name="ENTITY"]'); await p.waitForTimeout(300);
  ok("another schema: its views, the columns and the filter cleared, a half-typed mapping kept", same(await t.all("#suViews tbody tr td:first-child"),["ENTITY_LIST"]) && !(await p.$("#suCols")) && !(await p.$("#su_colLike")) && (await p.inputValue("#su_map"))==='{"half": "typed"');
  await p.click('#suSchemas button[data-name="CORE_FIN"]'); await p.waitForTimeout(300);
  await p.click('#suViews button[data-name="FIN_FLOW_B"]'); await p.waitForTimeout(400);
  await p.fill("#su_colLike","npe"); await p.waitForTimeout(150);
  await p.screenshot({path:OUTDIR+"/statjoins-setup-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the schemas, a long column name and the filter", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.fill("#su_colLike",""); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with all 950 columns listed", (await p.$$("#suCols tbody tr")).length===950 && await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.click("#suHelp summary"); await p.waitForTimeout(150);
  ok("phone: the help and its example open without sideways scroll", await p.$("#suHelp[open]") && await p.isVisible("#suExample") && await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/statjoins-setup-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  await p.click('#suSchemas button[data-name=""]'); await p.waitForTimeout(300);
  ok("back to the default schema: views are listed without a schema, as before", same(t.disc().pop(),{action:"discover",like:"FLOW"}) && (await t.txt("#suSchemaNow")).startsWith("Looking in the default schema"));

  // ----- pasting and saving a joined mapping -----
  const save=async text=>{ await p.fill("#su_map",text); await p.click('button[data-act="su-save"]'); await p.waitForTimeout(300); return t.txt("#suErr"); };
  ok("the page's own check: joins must be a list", (await save('{"fields":{"npe":{"view":"CORE_FIN.FIN_FLOW_B","joins":{"view":"X"}}}}'))==='The entry for "npe" has "joins" that isn\'t a list. Write it as [{"view": ..., "as": ..., "on": [...]}].');
  ok("the page's own check: at most 6 joins", (await save(JSON.stringify({fields:{npe:{view:"V", joins:Array(7).fill({view:"V",as:"A",on:[]})}}})))==='The entry for "npe" has 7 joins. A figure can join at most 6 views.');
  ok("the page's own check: where must be a list", (await save('{"fields":{"npe":{"view":"V","where":{"column":"A","equals":"b"}}}}'))==='The entry for "npe" has "where" that isn\'t a list. Write it as [{"column": ..., "equals": ...}].');
  ok("the page's own check: loaded must be an object", (await save('{"fields":{},"loaded":"BATCH_RUN"}'))==='The "loaded" entry must be an object, like {"view": "...", "at": "..."}.');
  ok("nothing was saved while the mapping was wrong", (await p.evaluate(()=>__mock.log.filter(l=>l.op==="upsert").length))===0);
  t.statStatus=()=>({status:200, body:copy(SJ.statusSaved)});
  const nStatus=t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="status").length;
  await p.fill("#su_map",JSON.stringify(SJ.mapping)); await p.click('button[data-act="su-save"]');
  await p.waitForTimeout(450);
  ok("a joined mapping with loaded is written to snl_settings exactly as pasted", same(await p.evaluate(()=>__mock.row("snl_settings","statutory_mapping").doc),SJ.mapping) && (await t.txt("#toastRoot"))==="Mapping saved" && t.calls.filter(c=>c.fn==="snl-statutory"&&c.body.action==="status").length===nStatus+1);
  ok("after saving, the panel shows why each figure that can't be used is refused, and the loaded problem", same(await t.all("#suProblems li"),["surplus Policyholder surplus: joins[1].on[0].left names alias X, which isn't declared. Fix this entry and save again.","loaded: loaded.at must be a column name. Until it is fixed, the dates S&P last loaded each view are shown instead."]) && (await t.txt("#suProblems b"))==="Part of the saved mapping can't be used yet");
  ok("a figure that is simply not in the mapping isn't listed as a problem, and the mapped list still says which are mapped", !(await t.txt("#suProblems")).includes("ceded_by_reinsurer") && same(await t.all("#suFields span"),["npe Net premiums earned (mapped)","surplus Policyholder surplus (not mapped)","ceded_by_reinsurer Ceded premiums by reinsurer (not mapped)"]));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the problems shown", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/statjoins-saved-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  t.statStatus=()=>({status:200, body:{...copy(SJ.statusSaved), loadedProblem:null, fields:SJ.statusSaved.fields.map(f=>({...f, mapped:f.id!=="ceded_by_reinsurer", problem:f.id==="ceded_by_reinsurer"?"not mapped":null}))}});
  await save(JSON.stringify({...SJ.mapping, loaded:{view:"BATCH_RUN", at:"RUN_DATE"}})); await p.waitForTimeout(250);
  ok("once corrected, the problems go away", !(await p.$("#suProblems")));

  // ----- the Statutory view still shows a result, with run dates by schema -----
  await p.fill("#st_codes","12345, 23456"); await p.click('button[data-act="stat-search"]'); await p.waitForTimeout(450);
  ok("the Statutory view shows a result from the joined mapping", same(await p.$$eval(".statblk",e=>e.map(x=>x.dataset.field)),["surplus"]) && same(await p.$$eval('.statblk[data-field="surplus"] tbody tr',r=>r.map(x=>x.children[4].textContent)),["$5.6M","$3.0M"]));
  ok("run dates by schema are worded as when S&P last updated that part of its database", (await t.txt("#statSource")).startsWith("S&P last updated the CORE_FIN part of its database on 16 Nov. S&P last updated the ENTITY part of its database on 15 Nov. Source: "), await t.txt("#statSource"));
  ok("no em dashes on the page", !(await p.evaluate(()=>document.body.innerText)).includes("—"));
  await p.screenshot({path:OUTDIR+"/statjoins-results-1440.png",fullPage:true});
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll on the result with the set-up panel open", await p.isVisible("#setup") && await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/statjoins-results-390.png",fullPage:true});
  await t.ctx.close();

  // ----- schemas can't be listed -----
  t=await open({}, {discover:body=>body.schemas?{status:502, body:{error:"snowflake_sql", message:"Snowflake couldn't run the query (422). Snowflake said: made-up fault."}}:{status:200, body:{views:[], fetchedAt:"2026-11-13T12:00:00Z", fromStore:false}}}); p=t.p;
  await p.click('button[data-act="su-toggle"]'); await p.waitForTimeout(250);
  await p.click('button[data-act="su-schemas"]'); await p.waitForTimeout(300);
  ok("a failed schema list says so, with the function's words, and the default schema still works", (await t.txt("#suSchema .banner")).startsWith("Couldn't list the schemas. Snowflake couldn't run the query (422).") && !(await p.$("#suSchemas")) && (await t.txt("#suSchemaNow")).startsWith("Looking in the default schema"));
  t.discover=body=>body.schemas?{status:200, body:{schemas:[], truncated:false}}:{status:200, body:{views:[]}};
  await p.click('button[data-act="su-schemas"]'); await p.waitForTimeout(300);
  ok("no schemas: says what that may mean", (await t.txt("#suSchema")).includes("No schemas came back. That may mean the Snowflake login can't see them yet."));
  await t.ctx.close();

  // ----- a reader sees none of it -----
  t=await open({role:"reader"}, {statStatus:()=>({status:200, body:{...copy(SJ.statusSaved), loadedProblem:null}})}); p=t.p;
  ok("a reader gets no set-up panel, schemas or problems", await p.isVisible("#statForm") && !(await p.$("#setup")) && !(await p.$("#suSchema")) && !(await p.$("#suProblems")));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  console.log(`${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
