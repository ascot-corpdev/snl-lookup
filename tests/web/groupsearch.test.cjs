// Whole groups on the Filings view: the company finder offers a matching group as one choice ahead of its companies,
// with how many companies it adds and what a year of dates costs; a 69-company group added and searched in one go;
// the estimate when a search is too wide; a group too big for one search; hostile group names; the tick that keeps
// a search out of Recent searches (sent, remembered for the session, cleared on sign-out, and the list leaving such
// searches out); and the phone layout.
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

// ----- made-up groups, in the shape the snl-filings function answers {action: "resolve"} with -----
const member=(name, kind, id)=>({companyName:name, companyId:kind==="c"?String(id):null, institutionId:kind==="i"?String(id):null});
const group=(name, code, members, extra)=>({name, code, companies:members.length, searchable:members.length, tooBig:false, requestsPerYear:0, members, ...extra});
const CALLOWAY=group("Calloway Group", "9001", [...Array.from({length:5},(_,i)=>member(`Calloway Unit ${i} Co`,"c",4100000+i)), ...Array.from({length:7},(_,i)=>member(`Calloway Branch ${i} Co`,"i",5100000+i))]);
const BIG_IDS=Array.from({length:69},(_,i)=>5200000+i);
const BIG=group("Nonesuch Big Group (SNL P&C Group)", null, BIG_IDS.map((id,i)=>member(`Nonesuch Big Member ${i} Co`,"i",id)));
const GIANT=group("Nonesuch Giant Group", null, Array.from({length:100},(_,i)=>member(`Nonesuch Giant Member ${i} Co`,"i",7000000+i)), {companies:130, searchable:130, tooBig:true});
const NAMEONLY=group("Tarrow Group (SNL P&C Group)", null, [member("Tarrow Mutual Insurance Co","i",5300001), member("Tarrow Specialty Co","i",5300002), member("Tarrow Home Co","i",5300003)], {companies:4, searchable:3});
const HOSTILE=group('Calloway <img src=x onerror="window.__xss=1"> Group', null, [member('Calloway <b>Bold</b> Co',"i",5400001), member("Calloway Plain Co","i",5400002)]);
const NO_MATCH=q=>`No saved company matches "${q}". S&P's filings API has no company search, so the app only knows companies loaded from a company list or seen in earlier results. Search by the company's S&P company id or institution id instead; the app remembers the name after that.`;

// ----- saved searches for the Recent searches list: one listed, one kept out of it -----
const P=o=>({companyIds:[4000001], institutionIds:[], states:["FL"], filingStatusIds:[1,2,3,4], typeOfInsuranceIds:[], filingTypeIds:[], spStatEntityIds:[], trackingNumbers:[], from:"2025-11-14", to:"2026-11-13", allStatuses:true, ...o});
const saved=(id, at, params, more)=>["snl_store", id, {kind:"search", label:"x", fetched_at:at, doc:{params, rows:[], total:3, requests:1, capped:false, byState:[], byCompany:[{kind:"companyId", id:params.companyIds[0], name:"Calloway Listed Co", rows:3}], notes:[], source:"S&P", ...more}}];
const SEED=[
  saved("search:listed", "2026-11-12T09:00:00.000Z", P({}), {}),
  saved("search:private", "2026-11-12T10:00:00.000Z", P({companyIds:[4000999]}), {unlisted:true, byCompany:[{kind:"companyId", id:4000999, name:"Calloway Secret Co", rows:1}]}),
];

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[],
      resolve:q=>/big/i.test(q) ? {query:q, matches:[], note:NO_MATCH(q), groups:[copy(BIG)], groupNote:null}
        : /giant/i.test(q) ? {query:q, matches:[], note:NO_MATCH(q), groups:[copy(GIANT)], groupNote:null}
        : /tarrow/i.test(q) ? {query:q, matches:[], note:NO_MATCH(q), groups:[copy(NAMEONLY)], groupNote:"2 more groups match \"Tarrow\". Type more of the group's name to see them."}
        : /odd/i.test(q) ? {query:q, matches:[], note:NO_MATCH(q), groups:[copy(HOSTILE)], groupNote:null}
        : /calloway/i.test(q) ? {...copy(RESOLVE), query:q, groups:[copy(CALLOWAY)], groupNote:null}
        : {query:q, matches:[], note:NO_MATCH(q), groups:[], groupNote:null},
      search:()=>({status:200, body:copy(SEARCH)}), ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const body=JSON.parse(req.postData()||"{}"); t.calls.push({body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(body.action==="status") return J(200,{...copy(STATUS), role:"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        if(body.action==="search"){ const a=await t.search(body); return J(a.status,a.body); }
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+"#filings"); await p.waitForTimeout(400);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.of=a=>t.calls.filter(c=>c.body.action===a);
    t.find=async q=>{ await p.fill("#f_q",q); await p.press("#f_q","Enter"); await p.waitForTimeout(200); };
    t.chips=async()=>p.evaluate(()=>S.f.chips.map(c=>c.kind+":"+c.id));
    t.toast=async()=>t.txt("#toastRoot");
    return t;
  }

  let t=await open(); let p=t.p;
  // ----- typing a group's name offers the group itself, ahead of its companies -----
  ok("the company box says it takes a group's name, up to 100 companies", (await t.txt('label[for="f_q"]'))==="Companies name, group name, NAIC code or S&P id; up to 100");
  await t.find("Calloway");
  ok("the group is offered as one choice", (await p.$$("#groupChoices li")).length===1 && (await t.txt("#groupChoices li .t1"))==="Calloway Group, 12 companies: add all", await t.txt("#groupChoices"));
  ok("it says how many it adds, its NAIC group code, and what a year of dates costs", (await t.txt("#groupChoices li .t2"))==="NAIC group 9001 · about 2 S&P requests for each year of dates" && (await t.txt('#groupChoices button[data-act="co-add-group"]'))==="Add all 12", await t.txt("#groupChoices li .t2"));
  ok("ahead of the individual companies, which are still listed", await p.evaluate(()=>!!(document.getElementById("groupChoices").compareDocumentPosition(document.getElementById("matches")) & Node.DOCUMENT_POSITION_FOLLOWING)) && (await p.$$("#matches li")).length===3);
  ok("Add all for the listed companies no longer claims to be the whole group", (await t.txt("#addAll"))==="Add all 3 to add every company listed.", await t.txt("#addAll"));
  await p.screenshot({path:OUTDIR+"/groupsearch-choice-1440.png",fullPage:false});
  await p.click('#groupChoices button[data-act="co-add-group"]'); await p.waitForTimeout(150);
  ok("one click adds the whole group, each company by the id it has", same(await t.chips(), [...Array.from({length:5},(_,i)=>"companyId:"+(4100000+i)), ...Array.from({length:7},(_,i)=>"institutionId:"+(5100000+i))]) && (await t.toast())==="Added 12 companies from Calloway Group." && !(await p.$("#groupChoices")) && (await p.inputValue("#f_q"))==="", await t.chips());
  ok("the estimate counts the group: two S&P requests for the last 12 months", (await t.txt("#f_est"))==="About 2 S&P requests, more if there are many results. A search someone has already run costs none.", await t.txt("#f_est"));
  await t.find("Calloway"); await p.click('#groupChoices button[data-act="co-add-group"]'); await p.waitForTimeout(150);
  ok("adding the same group again adds nothing and says so", (await t.chips()).length===12 && (await t.toast())==="Every company in Calloway Group is already chosen.", await t.toast());
  await p.evaluate(()=>{ S.f.chips=[]; render(); });

  // ----- a list with group names only: a member with no S&P id, and a note about more groups -----
  await t.find("Tarrow");
  ok("a group from a name-only list: no NAIC group code, and members with no S&P id are counted", (await t.txt("#groupChoices li .t1"))==="Tarrow Group (SNL P&C Group), 3 companies: add all" && (await t.txt("#groupChoices li .t2"))==="about 1 S&P request for each year of dates · 1 company has no S&P id and can't be searched", await t.txt("#groupChoices li"));
  ok("the function's note about more matching groups is shown, and the 'no company' note gives way to the group", (await t.txt("#groupNote"))==="2 more groups match \"Tarrow\". Type more of the group's name to see them." && !(await p.$("#resolveNote")));
  await t.find("Nonesuch Mutual");
  ok("when no group matches, the 'no company' note shows as before", (await t.txt("#resolveNote")).startsWith('No saved company matches "Nonesuch Mutual".') && !(await p.$("#groupChoices")));

  // ----- a 69-company group, added and searched in one go -----
  await t.find("Nonesuch Big");
  ok("a 69-company group: one choice, seven S&P requests a year", (await t.txt("#groupChoices li .t1"))==="Nonesuch Big Group (SNL P&C Group), 69 companies: add all" && (await t.txt("#groupChoices li .t2"))==="about 7 S&P requests for each year of dates", await t.txt("#groupChoices li"));
  await p.click('#groupChoices button[data-act="co-add-group"]'); await p.waitForTimeout(150);
  ok("all 69 are chosen", (await t.chips()).length===69 && (await t.toast())==="Added 69 companies from Nonesuch Big Group (SNL P&C Group).");
  ok("12 months: about 7 S&P requests", (await t.txt("#f_est")).startsWith("About 7 S&P requests, more if there are many results."), await t.txt("#f_est"));
  await p.click('button[data-act="range"][data-y="3"]'); await p.waitForTimeout(80);
  ok("3 years: about 28", (await t.txt("#f_est")).startsWith("About 28 S&P requests,"), await t.txt("#f_est"));
  await p.click('button[data-act="range"][data-y="5"]'); await p.waitForTimeout(80);
  ok("5 years: about 42", (await t.txt("#f_est")).startsWith("About 42 S&P requests,"), await t.txt("#f_est"));
  await p.click('button[data-act="range"][data-y="10"]'); await p.waitForTimeout(80);
  ok("10 years: the estimate says it is too wide and what would fit, in plain words", (await t.txt("#f_est"))==="About 77 S&P requests: more than the 60 one search may use, so S&P won't be asked. Choose fewer years or fewer companies: with these 69 companies, a search can cover up to 2,920 days of dates (a little under 8 years); over these dates, a search can take up to 50 companies.", await t.txt("#f_est"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(120);
  ok("phone: no sideways scroll with 69 companies and the too-wide estimate", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/groupsearch-toowide-390.png",fullPage:true});
  await p.setViewportSize({width:1440,height:900});
  t.search=()=>({status:400, body:{error:"spgmi_bad_request", message:"This search needs at least 77 S&P requests (one for each batch of 10 companies and each year of dates), more than the 60 one search may use. Choose fewer companies or a shorter date range. With these 69 companies, one search can cover up to 2,920 days of dates, a little under 8 years; over these dates, one search can take up to 50 companies."}});
  await p.click('#states [data-s="FL"]'); await p.click('button[data-act="search"]'); await p.waitForTimeout(400);
  ok("the page still sends it, and the function's refusal shows with what to change", (await t.txt("#results .banner")).startsWith("Couldn't run the search. This search needs at least 77 S&P requests") && (await t.txt("#results .banner")).includes("one search can cover up to 2,920 days of dates"), await t.txt("#results .banner"));
  t.search=()=>({status:200, body:copy(SEARCH)});
  await p.click('button[data-act="range"][data-y="1"]'); await p.click('button[data-act="search"]'); await p.waitForTimeout(400);
  const sent=t.of("search").pop().body;
  ok("12 months of the whole group goes as one search of all 69 institution ids", same(sent.institutionIds, BIG_IDS) && same(sent.companyIds, []) && !("unlisted" in sent), sent);

  // ----- a group too big for one search -----
  await p.evaluate(()=>{ S.f.chips=[]; render(); });
  await t.find("Nonesuch Giant");
  ok("a group over 100 companies says plainly it is too big and what to do", (await t.txt("#groupChoices li .t1"))==="Nonesuch Giant Group, 130 companies" && (await t.txt("#groupChoices [data-big]"))==="Too big for one search: a search takes at most 100 companies. Add the first 100 and search, then remove them, find the others by name and search again." && (await t.txt('#groupChoices button[data-act="co-add-group"]'))==="Add the first 100", await t.txt("#groupChoices li"));
  ok("its cost line is for the first 100", (await t.txt("#groupChoices li .t2"))==="about 10 S&P requests for each year of dates for the first 100", await t.txt("#groupChoices li .t2"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(120);
  ok("phone: no sideways scroll with the too-big group showing", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await (await p.$("#searchForm")).screenshot({path:OUTDIR+"/groupsearch-toobig-390.png"});
  await p.setViewportSize({width:1440,height:900});
  await p.click('#groupChoices button[data-act="co-add-group"]'); await p.waitForTimeout(150);
  ok("Add the first 100 fills the search", (await t.chips()).length===100 && (await t.toast())==="Added 100 companies from Nonesuch Giant Group.", await t.toast());
  await t.find("Calloway"); await p.click('#groupChoices button[data-act="co-add-group"]'); await p.waitForTimeout(150);
  ok("a group with no room left adds nothing and says what to do", (await t.chips()).length===100 && (await t.toast())==="A search takes at most 100 companies and 100 are chosen, so none of Calloway Group was added. Remove some companies to make room.", await t.toast());
  await p.evaluate(()=>{ S.f.chips=S.f.chips.slice(0,95); render(); });
  await t.find("Calloway"); await p.click('#groupChoices button[data-act="co-add-group"]'); await p.waitForTimeout(150);
  ok("a group that only partly fits adds what fits and says how many were left out", (await t.chips()).length===100 && (await t.toast())==="Added 5 companies from Calloway Group. A search takes at most 100 companies, so 7 were left out. Remove some companies to make room.", await t.toast());
  await p.evaluate(()=>{ S.f.chips=[]; render(); });

  // ----- hostile group names -----
  await t.find("Calloway Odd");
  ok("a hostile group name shows as text, and nothing in it runs", (await t.txt("#groupChoices li .t1"))==='Calloway <img src=x onerror="window.__xss=1"> Group, 2 companies: add all' && !(await p.$("#groupChoices img")) && await p.evaluate(()=>window.__xss===undefined));
  await p.click('#groupChoices button[data-act="co-add-group"]'); await p.waitForTimeout(150);
  ok("and in the toast and the chips", (await t.toast())==='Added 2 companies from Calloway <img src=x onerror="window.__xss=1"> Group.' && same(await t.all("#chips .cchip b"),["Calloway <b>Bold</b> Co","Calloway Plain Co"]) && !(await p.$("#toastRoot img")) && !(await p.$("#chips b b")) && await p.evaluate(()=>window.__xss===undefined));
  ok("no errors on the page", errs.length===0, errs);
  await ctxClose(t);

  // ----- keeping a search out of Recent searches -----
  t=await open({seed:SEED}); p=t.p;
  ok("the tick is on the form, off at first, and says what it does", !(await p.isChecked("#f_unlisted")) && (await t.txt('label[for="f_unlisted"]'))==="Keep this search out of Recent searches The result is still saved, so running the same search again costs no S&P requests, but it isn't listed for anyone. Remembered until you sign out.");
  await p.click("#recentToggle"); await p.waitForTimeout(250);
  const reads=await p.evaluate(()=>__mock.storeReads);
  ok("the Recent searches list asks only for searches that aren't kept out", same(reads.at(-1).iss, [["doc->>unlisted", null]]) && same(reads.at(-1).eqs, [["kind","search"]]), reads.at(-1));
  ok("a search kept out is never listed; the others are", same(await t.all("#recentList .recent-i .t1"), ["Calloway Listed Co"]), await t.all("#recentList .recent-i .t1"));
  // Searches as the function would save them: listed or not, as the request asks; from the saved result when there is one.
  const store=async(id, doc)=>p.evaluate(([id, doc])=>{ __mock.store.snl_store[id]={id, kind:"search", label:"x", fetched_at:new Date().toISOString(), doc}; }, [id, doc]);
  const have={};
  t.search=async body=>{
    const key=JSON.stringify(body.institutionIds||[])+JSON.stringify(body.companyIds||[]);
    if(have[key] && !body.refresh) return {status:200, body:{...copy(SEARCH), ...have[key], fromStore:true}};
    have[key]={...(body.unlisted?{unlisted:true}:{}), params:{...copy(SEARCH).params, companyIds:body.companyIds}, byCompany:[{kind:"companyId", id:body.companyIds[0], name:"Calloway Hidden Co", rows:1}]};
    await store("search:"+Object.keys(have).length+(body.refresh?"r":""), {...copy(SEARCH), ...have[key]});
    return {status:200, body:{...copy(SEARCH), ...have[key], fromStore:false}};
  };
  await p.check("#f_unlisted"); await p.waitForTimeout(80);
  ok("ticking it is remembered for the session", await p.evaluate(()=>sessionStorage.getItem("snl.f.unlisted"))==="1");
  await p.fill("#f_q","4000555"); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click("#byId button >> nth=0");
  await p.click('#states [data-s="FL"]'); await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  const first=t.of("search").pop().body;
  ok("a search with the tick says so to the function", first.unlisted===true && same(first.companyIds,[4000555]), first);
  ok("and the results say it was kept out but saved", (await t.txt("#unlistedNote"))==="Kept out of Recent searches. The result is saved, so the same search costs no S&P requests next time.");
  ok("the list reloads and still leaves it out", same(await t.all("#recentList .recent-i .t1"), ["Calloway Listed Co"]), await t.all("#recentList .recent-i .t1"));
  await p.uncheck("#f_unlisted"); await p.waitForTimeout(80);
  ok("unticking it forgets it", await p.evaluate(()=>sessionStorage.getItem("snl.f.unlisted"))===null);
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  const second=t.of("search").at(-1).body;
  ok("the same search without the tick: sent without it, opens the saved result, and stays out of the list (nothing is said about it)", !("unlisted" in second) && !(await p.$("#unlistedNote")) && (await t.txt("#fromStore")).startsWith("From the last fetch") && same(await t.all("#recentList .recent-i .t1"), ["Calloway Listed Co"]), await t.all("#recentList .recent-i .t1"));

  // The other order: a listed search first, then the same with the tick.
  await p.evaluate(()=>{ S.f.chips=[]; render(); });
  await p.fill("#f_q","4000666"); await p.press("#f_q","Enter"); await p.waitForTimeout(150); await p.click("#byId button >> nth=0");
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("a search without the tick is listed", (await t.all("#recentList .recent-i .t1")).includes("Calloway Hidden Co"), await t.all("#recentList .recent-i .t1"));
  await p.check("#f_unlisted"); await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("the same search with the tick opens the saved result and says it was already in the list", t.of("search").at(-1).body.unlisted===true && (await t.txt("#unlistedNote"))==="This search had been run before and is already in Recent searches. Opening it again doesn't add anything to the list.");
  await p.click('button[data-act="search-refresh"]'); await p.waitForTimeout(450);
  const refreshed=t.of("search").at(-1).body;
  ok("Refresh with the tick asks for it to be kept out", refreshed.refresh===true && refreshed.unlisted===true, refreshed);
  t.search=()=>({status:200, body:{...copy(SEARCH), fromStore:false}});
  await p.click('button[data-act="search"]'); await p.waitForTimeout(450);
  ok("a function that hasn't been updated (it saved the search listed) is caught and said plainly", (await t.txt("#unlistedNote"))==="This search may show in Recent searches: the filings function hasn't been updated to keep searches out of the list yet. Tell Corp Dev.");

  // Remembered for the session: a reload keeps it; signing out forgets it.
  await p.reload(); await p.waitForTimeout(450);
  ok("after a reload the tick is still on", await p.isChecked("#f_unlisted"));
  await p.click("#recentToggle"); await p.waitForTimeout(250);
  await p.click('#recentList .recent-i >> nth=0'); await p.waitForTimeout(450);
  ok("reopening a recent search with the tick on keeps the reopened search out too", t.of("search").at(-1).body.unlisted===true, t.of("search").at(-1).body);
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(150);
  ok("phone: no sideways scroll with the tick and its note", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await (await p.$("#searchForm")).screenshot({path:OUTDIR+"/groupsearch-unlisted-390.png"});
  await p.setViewportSize({width:1440,height:900});
  await p.evaluate(()=>signOut()); await p.waitForTimeout(250);
  ok("signing out forgets the tick", await p.evaluate(()=>sessionStorage.getItem("snl.f.unlisted"))===null);
  ok("no errors on the page", errs.length===0, errs);
  await ctxClose(t);

  async function ctxClose(x){ await x.ctx.close(); }
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
