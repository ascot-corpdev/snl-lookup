// The profile builder, with the real pieces joined: the page (index.html), the real zip library, the real deck.js
// and profile-slides.js, a real (made-up) PowerPoint template in the storage mock, and the sample answer exactly
// as the snl-profile function gives it (tests/fixtures/profile_sample_answer.json; profile_core_test.ts checks the
// function still produces that file). The file the browser saves is opened and checked. Nothing touches the network.
const { chromium } = require("playwright"); const fs=require("fs"); const path=require("path"); const JSZip=require("jszip");
const WEB=path.join(__dirname,"../../web"); const MOCK=fs.readFileSync(__dirname+"/mock-supabase.js","utf8"); const BASE="http://localhost:8123/";
const FIX=n=>JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures",n),"utf8"));
const STATUS=FIX("web_status.json"), REFS=FIX("web_reference.json"), SAMPLE=FIX("profile_sample_answer.json");
const TEMPLATE=fs.readFileSync(path.join(__dirname,"../fixtures/standin-template.pptx"));
const ZIPLIB=fs.readFileSync(path.join(__dirname,"../../node_modules/jszip/dist/jszip.min.js"),"utf8");
const FNS="https://a.supabase.co/functions/v1/";
const CONFIG='window.SNL_CONFIG={supabaseUrl:"https://a.supabase.co",supabaseAnonKey:"sb_publishable_k",usernameDomain:"snl-lookup.test"};';
const JSZIP_URL="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
let pass=0, fail=0; const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log("FAIL "+n+"  "+JSON.stringify(x)); } };

(async()=>{
  const b=await chromium.launch(); const errs=[];
  async function open(opts){
    const ctx=await b.newContext({viewport:{width:1440, height:900}, timezoneId:"UTC", acceptDownloads:true}); const p=await ctx.newPage(); p.on("pageerror",e=>errs.push(String(e)));
    await p.clock.setFixedTime(new Date("2026-11-14T12:00:00Z"));
    const calls=[];
    await p.route("**/*",async r=>{ const req=r.request(), u=req.url();
      if(u.startsWith(FNS)){ const fn=u.slice(FNS.length), body=JSON.parse(req.postData()||"{}"); calls.push({fn, action:body.action});
        const J=(status,o)=>r.fulfill({status,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify(o)}).catch(()=>{});
        if(fn==="snl-profile" && body.action==="status") return J(200,{statutory:{configured:false, mapped:false, fields:[]}, claude:{configured:false}, filings:{configured:false}});
        if(fn==="snl-profile" && body.action==="sample") return J(200,SAMPLE);
        if(fn==="snl-chat" && body.action==="status") return J(200,{configured:false});
        if(fn==="snl-filings" && body.action==="status") return J(200,{...STATUS, role:"corpdev"});
        if(fn==="snl-filings" && body.action==="reference") return J(200,REFS);
        return J(400,{error:"bad",message:"Unknown action."}); }
      if(u===JSZIP_URL) return r.fulfill({contentType:"application/javascript",body:ZIPLIB});
      if(u===BASE+"deck.js" || u===BASE+"profile-slides.js") return r.fulfill({contentType:"application/javascript",body:fs.readFileSync(path.join(WEB,u.slice(BASE.length)),"utf8")});
      if(/supabase\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:MOCK});
      if(/config\.js/.test(u)) return r.fulfill({contentType:"application/javascript",body:CONFIG});
      if(u.startsWith(BASE)) return r.fulfill({contentType:"text/html",body:fs.readFileSync(WEB+"/index.html","utf8")}); return r.fulfill({status:404,body:""});});
    await p.addInitScript(o=>{ window.__opts=o; },opts);
    await p.goto(BASE+"#profile"); await p.waitForTimeout(500);
    const txt=async sel=>((await p.textContent(sel).catch(()=>""))||"").replace(/\s+/g," ").trim();
    return {p, ctx, calls, txt};
  }
  const setTemplate=p=>p.evaluate(b64=>{ __mock.storage.buckets["snl-template"]["template.pptx"].bytes=Array.from(Uint8Array.from(atob(b64), c=>c.charCodeAt(0))); }, TEMPLATE.toString("base64"));

  // ----- the sample profile, before statutory data or Claude are set up, on a template already in storage -----
  let t=await open({template:{text:"PK", updated_at:"2026-11-05T09:30:00Z"}}); let p=t.p;
  await setTemplate(p);
  const [d]=await Promise.all([p.waitForEvent("download",{timeout:20000}), p.click('[data-act="pf-sample"]')]);
  await p.waitForTimeout(300);
  ok("the sample downloads under the name the slides script gives it", d.suggestedFilename()==="Calloway-Insurance-Co-profile-sample-2026-11-14.pptx", d.suggestedFilename());
  ok("the page says the profile is ready, and lists nine slides, all included", !!(await p.$("#pfBuilt")) && (await p.$$("#pfPlan li")).length===9 && !(await t.txt("#pfPlan")).includes("Left out"), await t.txt("#pfPlan"));
  ok("only the sample was asked of the function: no figures, no draft", same(t.calls.filter(c=>c.fn==="snl-profile").map(c=>c.action),["status","sample"]));
  const zip=await JSZip.loadAsync(fs.readFileSync(await d.path()));
  const names=Object.keys(zip.files);
  const read=n=>zip.file(n).async("string");
  const pres=await read("ppt/presentation.xml"), ct=await read("[Content_Types].xml");
  const slides=names.filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n));
  ok("a real PowerPoint file with nine slides", names.includes("ppt/presentation.xml") && slides.length===9 && (pres.match(/<p:sldId /g)||[]).length===9, slides);
  const all=(await Promise.all(slides.map(read))).join("\n");
  ok("the template's example slides are gone", !all.includes("Example slide"));
  ok("the cover names the company and says it is a sample", all.includes("Calloway Insurance Co: company profile (sample)") && all.includes("Corporate development | November 2026"));
  ok("every slide's source line says the figures are made up", (all.match(/Sample: made-up figures/g)||[]).length===8);
  ok("the function's figures reach the slides", all.includes("$122.5M") && all.includes("91.5%") && all.includes("CALL-FL-1"));
  const charts=names.filter(n=>/^ppt\/charts\/chart\d+\.xml$/.test(n)), books=names.filter(n=>/^ppt\/embeddings\/.+\.xlsx$/.test(n));
  ok("four editable charts, each with its own workbook", charts.length===4 && books.length===4, {charts, books});
  ok("the reinsurer chart carries the reinsurers' names", (await Promise.all(charts.map(read))).some(x=>x.includes("Nonesuch Re")));
  ok("every slide and chart is declared, and nothing that is declared is missing", slides.concat(charts).every(n=>ct.includes('PartName="/'+n+'"')) && [...ct.matchAll(/PartName="\/([^"]+)"/g)].every(m=>names.includes(m[1])));
  const layoutOf=async n=>{ const rels=await read(n.replace("slides/","slides/_rels/")+".rels"); const m=rels.match(/Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/); return m ? (await read("ppt/slideLayouts/"+m[1])).match(/<p:cSld name="([^"]*)"/)[1] : null; };
  const byNum=slides.slice().sort((a,b)=>+a.match(/\d+/)[0]-+b.match(/\d+/)[0]);
  const order=[...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map(m=>m[1]); const prels=await read("ppt/_rels/presentation.xml.rels");
  const first="ppt/"+prels.match(new RegExp('Id="'+order[0]+'"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="'+order[0]+'"')).slice(1).find(Boolean);
  ok("the cover is on the cover layout and the rest on the content layout", (await layoutOf(first))==="Title White" && (await Promise.all(byNum.filter(n=>n!==first).map(layoutOf))).every(x=>x==="Spectrum Title Only White"));
  await t.ctx.close();

  // ----- Corp Dev uploads a real template: the real check accepts it, and refuses a file that is not one -----
  t=await open({}); p=t.p;
  await p.setInputFiles("#pf_tplFile",{name:"team-template.pptx", mimeType:"application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer:TEMPLATE}); await p.waitForTimeout(1200);
  ok("a usable template is uploaded", (await p.evaluate(()=>__mock.storage.uploads.map(u=>[u.bucket,u.path,u.size]))).length===1 && (await t.txt("#pfTplState")).startsWith("The template is uploaded."), await t.txt("#pfTplState"));
  await p.setInputFiles("#pf_tplFile",{name:"notes.pptx", mimeType:"application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer:Buffer.from("not a PowerPoint file")}); await p.waitForTimeout(800);
  ok("a file that isn't a PowerPoint file is refused before any upload, in plain words", (await p.evaluate(()=>__mock.storage.uploads.length))===1 && (await p.textContent("body")).includes("This file isn't a PowerPoint file."));
  await t.ctx.close();

  ok("no page errors", errs.length===0, errs);
  await b.close();
  console.log(`${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
