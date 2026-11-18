// Saved carrier sets on the page: the "Carrier sets" panel for a reader and for Corp Dev (create, rename, add and
// remove companies and groups, delete, save the companies chosen in the Filings form), saves that start from what is
// saved now so two people editing don't undo each other, a setting that is missing, malformed or unreadable, the
// "Use a saved set" control on the Filings form, the Snapshot and the watchlist, a target the page has never heard
// of, the limits, hostile names, and the layout at 1440px and 390px. Every company, group and id here is made up.
const OUTDIR=require("path").join(__dirname,"../out"); require("fs").mkdirSync(OUTDIR,{recursive:true});
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), RESOLVE=FIX("web_resolve.json");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const copy=o=>JSON.parse(JSON.stringify(o));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

// ----- made-up groups, in the shape the snl-filings function answers {action: "resolve"} with -----
const member=(name, kind, id)=>({companyName:name, companyId:kind==="c"?String(id):null, institutionId:kind==="i"?String(id):null});
const group=(name, members, extra)=>({name, code:null, companies:members.length, searchable:members.length, tooBig:false, requestsPerYear:0, members, ...extra});
const CALLOWAY_G="Calloway Group (SNL P&C Group)", OLD_G="Calloway Old Group (SNL P&C Group)", BIG_G="Nonesuch Big Group (SNL P&C Group)", TARROW_G="Tarrow Group (SNL P&C Group)";
const CALLOWAY=group(CALLOWAY_G, [...Array.from({length:5},(_,i)=>member(`Calloway Unit ${i} Co`,"c",4100000+i)), ...Array.from({length:7},(_,i)=>member(`Calloway Branch ${i} Co`,"i",5100000+i))], {companies:13, searchable:12});
const BIG=group(BIG_G, Array.from({length:69},(_,i)=>member(`Nonesuch Big Member ${i} Co`,"i",5200000+i)));
const TARROW=group(TARROW_G, [member("Tarrow Mutual Insurance Co","i",5300001), member("Tarrow Specialty Co","i",5300002), member("Tarrow Home Co","i",5300003)]);
const TARROW_MATCHES=[{companyId:null, companyName:"Tarrow Mutual Insurance Co", naicCompanyCode:null, institutionId:"5300001", naicGroupName:TARROW_G}, {companyId:null, companyName:"Tarrow Nameonly Co", naicCompanyCode:"90777", institutionId:null, naicGroupName:TARROW_G}];

// ----- saved sets, in the shape of the "carrier_sets" setting -----
const SET=(o)=>({id:"s-x", name:"x", note:"", companies:[], groups:[], updatedAt:"2026-11-10T09:00:00Z", ...o});
const co=(companyName, institutionId, companyId=null)=>({companyName, companyId, institutionId});
const PEERS=SET({id:"s-peer01", name:"Florida homeowners peers", note:"Florida homeowners, the usual peers", companies:[co("Tarrow Mutual Insurance Co","5300001"), co("Calloway Unlisted Co",null)], groups:[CALLOWAY_G, OLD_G]});
const BIGSET=SET({id:"s-big001", name:"Nonesuch and Calloway", companies:Array.from({length:30},(_,i)=>co(`Nonesuch Single ${i} Co`, String(6000000+i))), groups:[BIG_G, CALLOWAY_G]});
const DOC={sets:[PEERS, BIGSET]};
const seed=doc=>({seed:[["snl_settings","carrier_sets",{doc}]]});
const WSTATUS={configured:true, emailConfigured:true, enabled:false, watchlist:null, problems:[], cost:2, budget:30, maxCompanies:280, tooBig:null, windowDays:14, keepDays:90, running:false, lastRun:null, lastCheck:null, found:[], role:"corpdev"};

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts={}, over={}, hash="#filings"){
    const ctx=await b.newContext({viewport:{width:1440,height:900}, timezoneId:"UTC"}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-13T12:00:00Z"));
    const t={p, ctx, calls:[],
      resolve:q=>/old/i.test(q) ? {query:q, matches:[], note:"No saved company matches.", groups:[], groupNote:null}
        : /big/i.test(q) ? {query:q, matches:[], note:null, groups:[copy(BIG)], groupNote:null}
        : /tarrow/i.test(q) ? {query:q, matches:copy(TARROW_MATCHES), note:null, groups:[copy(TARROW)], groupNote:null}
        : /calloway/i.test(q) ? {...copy(RESOLVE), query:q, groups:[copy(CALLOWAY)], groupNote:null}
        : {query:q, matches:[], note:"No saved company matches.", groups:[], groupNote:null}, ...over};
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); t.calls.push({fn, body});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-watch") return J(200, {...copy(WSTATUS), role:opts.role||"corpdev"});
        if(body.action==="status") return J(200,{...copy(STATUS), role:opts.role||"corpdev"});
        if(body.action==="reference") return J(200,copy(REFS));
        if(body.action==="resolve") return J(200,t.resolve(body.q));
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+hash); await p.waitForTimeout(450);
    t.txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    t.all=async sel=>p.$$eval(sel,e=>e.map(x=>x.textContent.replace(/\s+/g," ").trim()));
    t.noScroll=async()=>p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
    t.saved=async()=>p.evaluate(()=>{ const r=__mock.row("snl_settings","carrier_sets"); return r&&r.doc; });
    t.upserts=async()=>p.evaluate(()=>__mock.log.filter(l=>l.op==="upsert" && l.id==="carrier_sets").length);
    t.resolves=()=>t.calls.filter(c=>c.body.action==="resolve");
    t.openSets=async(sel='[data-act="sets-open"] >> nth=0')=>{ await p.click(sel); await p.waitForTimeout(400); };
    t.item=n=>`#setList li.setitem >> nth=${n}`;
    return t;
  }

  // ----- a reader -----
  let t=await open({role:"reader", ...seed(DOC)}); let p=t.p;
  ok("the Filings company picker offers the saved sets and the Carrier sets button", same(await t.all("#setsel_filings option"),["Florida homeowners peers","Nonesuch and Calloway"]) && (await t.txt("#setpick_filings label"))==="Use a saved set" && (await t.txt("#setsOpen_filings"))==="Carrier sets (2)", await t.all("#setsel_filings option"));
  ok("a reader isn't offered to save the chosen companies as a set", !(await p.$('[data-act="sets-from-filings"]')));
  ok("loading the sets asks no function and costs no S&P request", t.resolves().length===0);
  await t.openSets();
  ok("the panel opens as a dialog with its title, and the visibility note", (await t.txt("#setsTitle"))==="Carrier sets" && (await p.getAttribute("#setsDrawer","role"))==="dialog"
    && (await t.txt("#setsVisible"))==="Every login on the site can see and use these sets, so a set's name, note and companies show which companies the team follows. Keep a name and note to the market a set covers, and leave off any company the team would not want named.", await t.txt("#setsVisible"));
  ok("a reader is told plainly to ask Corp Dev, and gets no editing controls", (await t.txt("#setsReader"))==="Only Corp Dev logins can create or change sets. To add a set or change one, ask Corp Dev. You can use any set beside the company pickers." && !(await p.$("#setsNew")) && !(await p.$('[data-act="sets-edit"]')) && !(await p.$('[data-act="sets-del"]')));
  ok("each set shows its name and note", same(await t.all("#setList .setname"),["Florida homeowners peers","Nonesuch and Calloway"]) && (await t.txt(t.item(0)+" >> .setnote"))==="Florida homeowners, the usual peers");
  ok("each set says how many companies it expands to today and how many have an S&P id", (await t.txt(t.item(0)+" >> .setcount"))==="2 companies and 2 groups saved. 15 companies today, 13 with an S&P id. Changed 10 Nov."
    && (await t.txt(t.item(1)+" >> .setcount"))==="30 companies and 2 groups saved. 112 companies today, 111 with an S&P id. Changed 10 Nov.", [await t.txt(t.item(0)+" >> .setcount"), await t.txt(t.item(1)+" >> .setcount")]);
  ok("a group in a set that no longer matches the company list is named plainly", (await t.txt(t.item(0)+" >> .setmissing"))===`"${OLD_G}" no longer matches the company list, so it gives no companies.`, await t.txt(t.item(0)+" >> .setmissing"));
  ok("each group is looked up once, by the plain part of its name", same(t.resolves().map(c=>c.body.q).sort(),["Calloway Group","Calloway Old Group","Nonesuch Big Group"]), t.resolves().map(c=>c.body.q));
  ok("a reader's attempt to change a set is refused before anything is saved", await (async()=>{ await p.evaluate(()=>changeSets(l=>{ l.pop(); return l; })); await p.waitForTimeout(150); return (await t.txt("#setsErr"))==="Only Corp Dev logins can change carrier sets. Ask Corp Dev." && (await t.upserts())===0; })());
  await p.keyboard.press("Escape"); await p.waitForTimeout(150);
  ok("Esc closes the panel and puts the cursor back on its button", !(await p.$("#setsDrawer")) && await p.evaluate(()=>document.activeElement&&document.activeElement.id==="setsOpen_filings"));
  // using a set on the Filings form
  await p.click('[data-act="set-use"][data-target="filings"]'); await p.waitForTimeout(300);
  ok("using a set fills the chosen companies, each once, only those with an S&P id", (await p.$$("#chips .cchip")).length===13 && (await t.txt("#chips .cchip >> nth=0 >> b"))==="Tarrow Mutual Insurance Co", (await p.$$("#chips .cchip")).length);
  ok("and says what was added and what was left out, and why", (await t.txt("#setsaid_filings"))===`Added 13 companies from "Florida homeowners peers". 2 companies in the set have no S&P id, so their filings can't be searched. "${OLD_G}" no longer matches the company list, so it was left out. Corp Dev can remove it from the set.`, await t.txt("#setsaid_filings"));
  ok("the groups already looked up aren't asked again", t.resolves().length===3);
  await p.click('[data-act="set-use"][data-target="filings"]'); await p.waitForTimeout(250);
  ok("using it again adds nothing and says so", (await p.$$("#chips .cchip")).length===13 && (await t.txt("#setsaid_filings")).startsWith(`Every company in "Florida homeowners peers" with an S&P id is already chosen.`));
  await p.selectOption("#setsel_filings","s-big001"); await p.click('[data-act="set-use"][data-target="filings"]'); await p.waitForTimeout(300);
  ok("a set larger than one search fills it to 100 companies and says how many were left out", (await p.$$("#chips .cchip")).length===100 && (await t.txt("#setsaid_filings"))===`Added 87 companies from "Nonesuch and Calloway". A search takes at most 100 companies, so 12 companies were left out: remove some to make room, or search the rest separately. 1 company in the set has no S&P id, so its filings can't be searched.`, await t.txt("#setsaid_filings"));
  ok("the chosen set stays chosen after the page redraws", (await p.inputValue("#setsel_filings"))==="s-big001");
  await p.screenshot({path:OUTDIR+"/sets-reader-1440.png",fullPage:false});
  await t.ctx.close();

  // ----- Corp Dev: create, find and add, rename, remove, delete -----
  t=await open(seed({sets:[PEERS]})); p=t.p;
  await t.openSets();
  ok("Corp Dev sees the new set form and the editing buttons", !!(await p.$("#setsNew")) && (await t.txt("#setsNew h3"))==="New set" && (await p.$$('[data-act="sets-edit"]')).length===1 && (await p.$$('[data-act="sets-del"]')).length===1);
  await p.click('[data-act="sets-create"]'); await p.waitForTimeout(150);
  ok("a set needs a name", (await t.txt("#setsErr"))==="Give the set a name." && (await t.upserts())===0);
  await p.fill("#sets_name","florida HOMEOWNERS peers"); await p.click('[data-act="sets-create"]'); await p.waitForTimeout(300);
  ok("two sets can't share a name, in any letter case", (await t.txt("#setsErr"))==='There is already a set named "florida HOMEOWNERS peers". Choose another name.' && (await t.upserts())===0, await t.txt("#setsErr"));
  await p.fill("#sets_name","  Texas   commercial "); await p.fill("#sets_note","Commercial auto, Texas"); await p.press("#sets_name","Enter"); await p.waitForTimeout(350);
  let doc=await t.saved();
  ok("Enter creates the set: name tidied, note kept, empty lists, a date and an id", doc.sets.length===2 && doc.sets[1].name==="Texas commercial" && doc.sets[1].note==="Commercial auto, Texas" && same(doc.sets[1].companies,[]) && same(doc.sets[1].groups,[]) && /^s-[a-z0-9]+$/.test(doc.sets[1].id) && doc.sets[1].updatedAt==="2026-11-13T12:00:00.000Z" && same(doc.sets[0], PEERS), doc.sets[1]);
  ok("says so, and opens the new set for adding companies", (await t.txt(".toast"))==='Created "Texas commercial". Add companies and groups to it below.' && !!(await p.$("#setEdit")) && (await p.inputValue("#sets_name"))==="");
  await p.fill("#sets_q","Tarrow"); await p.press("#sets_q","Enter"); await p.waitForTimeout(300);
  ok("the finder offers whole groups and companies; a company with no S&P id can't be added", same(await t.all("#setsGroups .t1"),[TARROW_G]) && same(await t.all("#setsMatches .t1"),["Tarrow Mutual Insurance Co","Tarrow Nameonly Co"]) && (await p.$$('#setsMatches [data-act="sets-add-co"]')).length===1 && (await t.txt("#setsMatches li >> nth=1 >> .noadd"))==="Can't be added: the company list has no S&P id for it.");
  await p.click('#setsGroups [data-act="sets-add-group"]'); await p.waitForTimeout(300);
  await p.click('#setsMatches [data-act="sets-add-co"]'); await p.waitForTimeout(300);
  doc=await t.saved();
  ok("a whole group is kept by its name; a company by its ids", same(doc.sets[1].groups,[TARROW_G]) && same(doc.sets[1].companies,[{companyName:"Tarrow Mutual Insurance Co", companyId:null, institutionId:"5300001"}]), doc.sets[1]);
  ok("the finder then shows both as in the set", (await t.txt("#setsGroups li >> nth=0 >> .inline"))==="In the set" && (await t.txt("#setsMatches li >> nth=0 >> .inline"))==="In the set");
  ok("the count follows: the group's 3 companies and the single one, once", (await t.txt(t.item(1)+" >> .setcount"))==="1 company and 1 group saved. 3 companies today, 3 with an S&P id. Changed 13 Nov.", await t.txt(t.item(1)+" >> .setcount"));
  await p.evaluate(()=>{ S.sets.find.matches=S.sets.find.matches.slice(0,1); render(); });
  await p.evaluate(()=>setsAddCompany(0)); await p.waitForTimeout(250);
  ok("the same company can't be added twice", (await t.txt("#setsErr"))==="Tarrow Mutual Insurance Co is already in the set." && (await t.saved()).sets[1].companies.length===1);
  await p.click(`${t.item(1)} >> [data-act="sets-rename"]`); await p.waitForTimeout(150);
  ok("Rename opens with the name and note filled in", (await p.inputValue("#sets_rn_name"))==="Texas commercial" && (await p.inputValue("#sets_rn_note"))==="Commercial auto, Texas");
  await p.fill("#sets_rn_name","Texas commercial auto"); await p.fill("#sets_rn_note",""); await p.click('[data-act="sets-rename-save"]'); await p.waitForTimeout(300);
  doc=await t.saved();
  ok("renaming saves the name and an empty note", doc.sets[1].name==="Texas commercial auto" && doc.sets[1].note==="" && (await t.txt(".toast"))==="Saved the name and note." && !(await p.$("#setRename")));
  await p.click(`#setEdit [data-act="sets-gr-remove"]`); await p.waitForTimeout(300);
  await p.click(`#setEdit [data-act="sets-co-remove"]`); await p.waitForTimeout(300);
  doc=await t.saved();
  ok("removing a group and a company", same(doc.sets[1].groups,[]) && same(doc.sets[1].companies,[]) && (await t.txt(".toast"))==="Removed from the set.");
  await p.click(`${t.item(1)} >> [data-act="sets-del"]`); await p.waitForTimeout(150);
  ok("deleting asks first, saying it goes for every login", (await t.txt("#setDel > span >> nth=0"))==='Delete "Texas commercial auto"? It goes for every login. Searches already run are kept.' && (await t.saved()).sets.length===2);
  await p.click('[data-act="sets-del-no"]'); await p.waitForTimeout(100);
  ok("Keep it keeps it", !(await p.$("#setDel")) && (await t.saved()).sets.length===2);
  await p.click(`${t.item(1)} >> [data-act="sets-del"]`); await p.click('[data-act="sets-del-yes"]'); await p.waitForTimeout(300);
  ok("delete removes it", same((await t.saved()).sets.map(s=>s.name),["Florida homeowners peers"]) && (await t.txt(".toast"))==='Deleted "Texas commercial auto".' && (await p.$$("#setList li.setitem")).length===1);
  // two people at once: someone else saves while this panel is open
  await p.evaluate(()=>{ __mock.store.snl_settings.carrier_sets.doc.sets.push({id:"s-other1", name:"Someone else's set", note:"", companies:[], groups:[], updatedAt:"2026-11-13T11:00:00Z"}); });
  await p.click(`${t.item(0)} >> [data-act="sets-rename"]`); await p.fill("#sets_rn_note","Changed here"); await p.click('[data-act="sets-rename-save"]'); await p.waitForTimeout(300);
  doc=await t.saved();
  ok("a change starts from what is saved now, so someone else's new set is kept", same(doc.sets.map(s=>s.name),["Florida homeowners peers","Someone else's set"]) && doc.sets[0].note==="Changed here" && same(await t.all("#setList .setname"),["Florida homeowners peers","Someone else's set"]), doc.sets.map(s=>s.name));
  await p.click(`${t.item(1)} >> [data-act="sets-edit"]`); await p.waitForTimeout(150);
  await p.evaluate(()=>{ const d=__mock.store.snl_settings.carrier_sets.doc; d.sets=d.sets.filter(s=>s.id!=="s-other1"); });
  await p.fill("#sets_q","Tarrow"); await p.press("#sets_q","Enter"); await p.waitForTimeout(300);
  await p.click('#setsGroups [data-act="sets-add-group"]'); await p.waitForTimeout(300);
  ok("a change to a set someone else deleted meanwhile is refused, plainly, and the list follows", (await t.txt("#setsErr"))==="That set has been deleted, here or by someone else. Nothing was changed." && (await t.saved()).sets.length===1 && (await p.$$("#setList li.setitem")).length===1, await t.txt("#setsErr"));
  // the database refusing the write
  await p.evaluate(()=>{ __mock.denySettings=true; });
  await p.click(`${t.item(0)} >> [data-act="sets-rename"]`); await p.fill("#sets_rn_note","Refused"); await p.click('[data-act="sets-rename-save"]'); await p.waitForTimeout(300);
  ok("a write the database refuses says only Corp Dev can change sets, and nothing changes", (await t.txt("#setsErr"))==="Only Corp Dev logins can change carrier sets. Ask Corp Dev." && (await t.saved()).sets[0].note==="Changed here");
  await p.evaluate(()=>{ __mock.denySettings=false; });
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: no sideways scroll with the panel open and a set being renamed", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/sets-panel-390.png",fullPage:false});
  await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(150);
  await p.screenshot({path:OUTDIR+"/sets-panel-1440.png",fullPage:false});
  await t.ctx.close();

  // ----- Corp Dev: save the companies chosen in the Filings form as a set -----
  t=await open({seed:[]}); p=t.p;
  ok("with no saved sets the control is left out, but the Carrier sets button is there", !(await p.$("#setpick_filings")) && (await t.txt("#setsOpen_filings"))==="Carrier sets" && await p.evaluate(()=>setPickHTML("filings")===""));
  ok("Save these companies as a set appears only once companies are chosen", !(await p.$('[data-act="sets-from-filings"]')));
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  await p.click('#matches li >> nth=0 >> button[data-kind="companyId"]');
  await p.fill("#f_q","Calloway"); await p.press("#f_q","Enter"); await p.waitForTimeout(250);
  await p.click('#matches li >> nth=1 >> button[data-kind="companyId"]');
  await p.click('[data-act="sets-from-filings"]'); await p.waitForTimeout(400);
  ok("it opens the panel ready to save the chosen companies", (await t.txt("#setsNew h3"))==="Save the companies chosen in the Filings form as a set" && (await t.txt('[data-act="sets-create-filings"]'))==="Save the 2 companies chosen in the Filings form" && !!(await p.$("#setsEmpty")));
  await p.fill("#sets_name","Calloway pair"); await p.press("#sets_name","Enter"); await p.waitForTimeout(350);
  let d2=await t.saved();
  ok("the set holds exactly the chosen companies", d2 && d2.sets.length===1 && same(d2.sets[0].companies,[{companyName:"Calloway Insurance Co",companyId:"4000001",institutionId:null},{companyName:"Calloway Home Co",companyId:"4000002",institutionId:null}]) && (await t.txt(".toast"))==='Saved 2 companies as "Calloway pair".', d2);
  await p.click('[data-act="sets-close"] >> nth=1'); await p.waitForTimeout(150);
  ok("the control now offers it on the Filings form", same(await t.all("#setsel_filings option"),["Calloway pair"]));
  await t.ctx.close();

  // ----- the Snapshot -----
  t=await open(seed(DOC), {}, "#snapshot"); p=t.p;
  ok("the Snapshot chooser offers the saved sets too", same(await t.all("#setsel_snapshot option"),["Florida homeowners peers","Nonesuch and Calloway"]) && !!(await p.$("#setsOpen_snapshot")));
  await p.click('[data-act="set-use"][data-target="snapshot"]'); await p.waitForTimeout(350);
  ok("a set is chosen like a group: all its companies, with what has no S&P id", (await t.txt("#sn_chosen"))==="Chosen: Florida homeowners peers (saved set) group of 13 companies with S&P ids in the company list; 2 companies have no S&P id and are left out Clear", await t.txt("#sn_chosen"));
  ok("with the Snapshot's own cost line", (await t.txt("#sn_cost")).startsWith("About 6 S&P requests"), await t.txt("#sn_cost"));
  ok("and the group that no longer matches is named", (await t.txt("#setsaid_snapshot"))===`Chosen: "Florida homeowners peers", 13 companies with S&P ids. "${OLD_G}" no longer matches the company list, so it was left out. Corp Dev can remove it from the set.`, await t.txt("#setsaid_snapshot"));
  await p.selectOption("#setsel_snapshot","s-big001"); await p.click('[data-act="set-use"][data-target="snapshot"]'); await p.waitForTimeout(350);
  ok("a set too big for one snapshot gets the Snapshot's too-big message, and runs nothing", (await t.txt("#sn_tooBig")).startsWith("Nonesuch and Calloway (saved set) has 111 companies with S&P ids in the company list, and one snapshot covers at most 100.") && !t.calls.some(c=>c.body.action==="search"), await t.txt("#sn_tooBig"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: no sideways scroll on the Snapshot with a set chosen", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/sets-snapshot-390.png",fullPage:false});
  await t.ctx.close();

  // ----- the watchlist -----
  t=await open(seed(DOC)); p=t.p;
  await p.click('[data-act="w-manage"]'); await p.waitForTimeout(150);
  ok("the watchlist's Manage section offers Add a saved set", (await t.txt("#setpick_watch label"))==="Add a saved set" && (await t.txt('[data-act="set-use"][data-target="watch"]'))==="Add");
  await p.click('[data-act="set-use"][data-target="watch"]'); await p.waitForTimeout(400);
  const wl=await p.evaluate(()=>{ const r=__mock.row("snl_settings","watchlist"); return r&&r.doc; });
  ok("adding a set adds its companies to the watchlist", wl && wl.companies.length===13 && same(wl.companies[0],{kind:"institutionId",id:"5300001",name:"Tarrow Mutual Insurance Co"}) && (await t.txt("#setsaid_watch")).startsWith(`Added 13 companies from "Florida homeowners peers" to the watchlist.`), [wl, await t.txt("#setsaid_watch")]);
  await t.ctx.close();

  // ----- a target the page has never heard of, and the contract -----
  t=await open({role:"reader", ...seed(DOC)}); p=t.p;
  const r0=await p.evaluate(async()=>{ document.getElementById("view").insertAdjacentHTML("beforeend", setPickHTML("market")); const has=!!document.querySelector('#setpick_market [data-act="set-use"]');
    document.querySelector('#setpick_market [data-act="set-use"]').click(); await new Promise(r=>setTimeout(r,150)); return {has, said:S.sets.said.market}; });
  ok("setPickHTML works for any target, and one not registered says so plainly", r0.has && r0.said==="Saved sets can't be used here yet.", r0);
  const r1=await p.evaluate(async()=>{
    if(typeof SET_TARGETS!=="undefined") SET_TARGETS.market=(companies, set)=>{ window.__got={companies, set}; return `Checked ${companies.length}.`; };
    document.getElementById("view").insertAdjacentHTML("beforeend", setPickHTML("market")); document.querySelector('#setpick_market [data-act="set-use"]').click();
    await new Promise(r=>setTimeout(r,400)); return {got:window.__got, said:S.sets.said.market}; });
  ok("a target another view registers gets each company once, only those with an S&P id", r1.got && r1.got.companies.length===13 && r1.got.companies.every(c=>["companyId","institutionId"].includes(c.kind) && /^\d+$/.test(c.id) && typeof c.name==="string") && new Set(r1.got.companies.map(c=>c.kind+c.id)).size===13, r1.got&&r1.got.companies.length);
  ok("each company says which of the set's groups it came from, or null for a single company", r1.got && r1.got.companies[0].group===null && r1.got.companies[0].name==="Tarrow Mutual Insurance Co" && r1.got.companies.slice(1).every(c=>c.group===CALLOWAY_G), r1.got&&r1.got.companies.slice(0,2));
  ok("the set's own group names come along", r1.got && same(r1.got.set.groups,[CALLOWAY_G, OLD_G]), r1.got&&r1.got.set.groups);
  ok("SET_TARGETS is on window, so a block anywhere in the page can register a target", await p.evaluate(()=>window.SET_TARGETS===SET_TARGETS && typeof SET_TARGETS.filings==="function" && typeof SET_TARGETS.snapshot==="function" && typeof SET_TARGETS.watch==="function"));
  ok("and what was chosen and left out", r1.got && r1.got.set.id==="s-peer01" && r1.got.set.name==="Florida homeowners peers" && r1.got.set.leftOut===2 && r1.got.set.noId===2 && r1.got.set.total===15 && same(r1.got.set.missingGroups,[OLD_G]) && r1.got.set.notes.length===2 && r1.said==="Checked 13.", r1.got&&r1.got.set);
  ok("an id that isn't a plain word is no target", await p.evaluate(()=>setPickHTML('x" onclick="alert(1)')==="" && setPickHTML("")===""));
  await t.ctx.close();

  // ----- missing, malformed and unreadable settings; limits; hostile names -----
  t=await open(seed({sets:"oops"})); p=t.p;
  ok("a malformed setting shows no sets and breaks nothing", !(await p.$("#setpick_filings")) && !!(await p.$("#searchForm")) && !!(await p.$("#watch")));
  await t.openSets();
  ok("the panel says part of the saved sets can't be used, and that the next change saves what shows", (await t.txt("#setsProblems"))==="Part of the saved carrier sets can't be used1 entry was unreadable, repeated or over the limits, and is left out. The next change saves the sets as they show here." && !!(await p.$("#setsEmpty")), await t.txt("#setsProblems"));
  await t.ctx.close();
  const junk={sets:[PEERS, null, {name:""}, {name:"FLORIDA homeowners peers"}, SET({id:"bad id", name:"Kept", companies:[co("",null), co("Dup Co","1"), co("Dup Co","1"), {companyName:"Odd id", institutionId:"12a"}], groups:[7, "", "Tarrow Group (SNL P&C Group)"]})]};
  t=await open(seed(junk)); p=t.p;
  ok("good sets in a messy setting are kept and usable", same(await t.all("#setsel_filings option"),["Florida homeowners peers","Kept"]));
  await t.openSets();
  ok("and what was left out is counted", (await t.txt("#setsProblems")).includes("5 entries were unreadable, repeated or over the limits"), await t.txt("#setsProblems"));
  await p.evaluate(()=>{ const real=S.sb.from.bind(S.sb); S.sb.from=tb=>tb==="snl_settings"?{select:()=>({eq:()=>({maybeSingle:async()=>({data:null, error:{message:"Failed to fetch"}})})})}:real(tb); });
  await p.click('[data-act="sets-retry"]').catch(()=>{}); await p.evaluate(()=>{ S.sets.loaded=false; loadSets(); }); await p.waitForTimeout(250);
  ok("a setting that can't be read says so, offers to try again, and hides the control", (await t.txt("#setsReadErr"))==="Couldn't read the carrier sets: Failed to fetch.Try again" && await p.evaluate(()=>setPickHTML("filings")===""), await t.txt("#setsReadErr"));
  await p.evaluate(()=>changeSets(l=>l)); await p.waitForTimeout(200);
  ok("and a change can't be saved over it", (await t.txt("#setsErr"))==="Couldn't read the carrier sets: Failed to fetch. Nothing was changed." && (await t.upserts())===0);
  ok("the rest of the page still works", !!(await p.$("#searchForm")) && !!(await p.$("#f_q")));
  await t.ctx.close();

  const full={sets:Array.from({length:40},(_,i)=>SET({id:`s-f${i}`, name:`Peer set ${i}`, companies:i===0?Array.from({length:100},(_,j)=>co(`Nonesuch ${j} Co`,String(7000000+j))):[], groups:i===0?Array.from({length:20},(_,j)=>`Nonesuch Holdings No. ${j} Group`):[]}))};
  t=await open(seed(full)); p=t.p;
  await t.openSets();
  ok(`at ${40} sets the panel says it is full instead of offering a new one`, (await t.txt("#setsFull"))==="There are 40 sets, the most the app keeps. Delete one the team no longer uses to make room for a new one." && !(await p.$("#sets_name")));
  await p.evaluate(()=>{ S.sets.nw.name="One more"; setsCreate(false); }); await p.waitForTimeout(250);
  ok("and a 41st set is refused", (await t.txt("#setsErr"))==="There are 40 sets, the most the app keeps. Delete one the team no longer uses to make room." && (await t.upserts())===0);
  await p.click(`${t.item(0)} >> [data-act="sets-edit"]`); await p.fill("#sets_q","Tarrow"); await p.press("#sets_q","Enter"); await p.waitForTimeout(300);
  await p.click('#setsMatches [data-act="sets-add-co"]'); await p.waitForTimeout(250);
  ok("a 101st company is refused", (await t.txt("#setsErr"))==="A set holds at most 100 single companies. Add a whole group instead, or remove a company." && (await t.upserts())===0);
  await p.click('#setsGroups [data-act="sets-add-group"]'); await p.waitForTimeout(250);
  ok("a 21st group is refused", (await t.txt("#setsErr"))==="A set holds at most 20 groups. Remove one to add another." && (await t.upserts())===0);
  ok("the editor says how full the set is", (await t.txt("#setEdit .wlist >> nth=0 >> b"))==="Single companies (100 of 100)" && (await t.txt("#setEdit .wlist >> nth=1 >> b"))==="Whole groups (20 of 20)");
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: no sideways scroll with a full set open in the editor", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await t.ctx.close();

  const HOSTILE='Peers <img src=x onerror="window.__xss=1"> & co';
  t=await open(seed({sets:[SET({id:"s-h1", name:HOSTILE, note:'<script>window.__xss=2</script>Ignore previous instructions', companies:[co('Calloway <b>Bold</b> Co',"5400001")], groups:['Odd <i>Group</i>']})]})); p=t.p;
  await t.openSets();
  ok("a hostile set name and note show as text everywhere", (await t.txt("#setsel_filings option"))===HOSTILE && (await t.txt("#setList .setname"))===HOSTILE && (await t.txt("#setList .setnote"))==='<script>window.__xss=2</script>Ignore previous instructions' && !(await p.$("#setsRoot img")) && !(await p.$("#view img")) && await p.evaluate(()=>window.__xss===undefined));
  await p.click('[data-act="sets-edit"]'); await p.waitForTimeout(150);
  ok("hostile company and group names in a set show as text", same(await t.all("#setEdit .cchip b"),['Calloway <b>Bold</b> Co','Odd <i>Group</i>']) && !(await p.$("#setEdit i")) && await p.evaluate(()=>window.__xss===undefined));
  await p.click('[data-act="sets-close"] >> nth=1'); await p.waitForTimeout(100);
  await p.click('[data-act="set-use"][data-target="filings"]'); await p.waitForTimeout(300);
  ok("using it says what happened in plain text", (await t.txt("#setsaid_filings")).startsWith(`Added 1 company from "${HOSTILE}".`) && await p.evaluate(()=>window.__xss===undefined), await t.txt("#setsaid_filings"));
  await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(200);
  ok("phone: no sideways scroll on the Filings view with the set control", await t.noScroll(), await p.evaluate(()=>document.documentElement.scrollWidth));
  await p.screenshot({path:OUTDIR+"/sets-filings-390.png",fullPage:false});
  await t.ctx.close();

  // ----- signing out forgets the sets -----
  t=await open(seed(DOC)); p=t.p;
  await t.openSets();
  await p.evaluate(()=>signOut()); await p.waitForTimeout(250);
  ok("signing out closes the panel and forgets the sets", !(await p.$("#setsDrawer")) && await p.evaluate(()=>!S.sets.loaded && S.sets.sets.length===0));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{ console.error(e); console.log(`${pass} passed, ${fail+1} failed`); process.exit(1); });
