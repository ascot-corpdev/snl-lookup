// In-memory stand-in for supabase-js, for the page tests: one made-up login, the three tables the page reads
// (profiles, snl_jobs, snl_settings) and test hooks on window.__mock. Nothing here touches a real database.
// A test sets options before the page loads with page.addInitScript(o => { window.__opts = o; }, {...}):
//   role: "corpdev" (default) or "reader"    signedOut: true to start at the sign-in form
//   noProfile: true for a login with no role   seed: [[table, id, row], ...] rows to start with
//   users: {username:{id, display_name, role}} more logins that can sign in (snl_jobs rows carry owner; the default is "u1")
(function(){
  const clone = o => JSON.parse(JSON.stringify(o));
  const O = window.__opts || {};
  const ME = "u1";
  const store = { profiles:{ [ME]:{id:ME, username:"corpdev1", display_name:"Corp Dev 1", role:O.role||"corpdev"} }, snl_jobs:{}, snl_settings:{}, snl_store:{} };
  if(O.noProfile) delete store.profiles[ME];
  // The team library (migration 0007). noLibrary: true starts without the table, as before the migration is run.
  if(!O.noLibrary) store.snl_library = {};
  (O.seed||[]).forEach(([t,id,row]) => { store[t][id] = {id, ...clone(row)}; });
  // More logins, for tests that sign one out and another in: users: {corpdev2:{id:"u2", display_name:"Corp Dev 2", role:"reader"}}
  Object.values(O.users||{}).forEach(u => { store.profiles[u.id] = {username:"", ...clone(u)}; });
  Object.entries(O.users||{}).forEach(([name,u]) => { store.profiles[u.id].username = store.profiles[u.id].username || name; });
  const authCbs = [];
  const session = () => ({user:{id:M.uid}, access_token: M.uid===ME ? "t" : "t-"+M.uid});
  const M = window.__mock = {
    store, log:[], created:null, signedOut:!!O.signedOut,
    uid:ME,              // the login signed in now; snl_jobs rows are read only where owner is this login, as row-level security does
    jobQueries:[],       // every read of snl_jobs: {cols, eqs, ins, gtes, lts, ord, lim, range, uid}
    listReads:0,         // how many times the page has read snl_jobs other than by id (the past answers list, the latest answer)
    failList:!!O.failList,   // true: reading snl_jobs other than by id fails (option failList: true from the start)
    jobReads:0,          // how many times the page has read a job row
    failJobs:false,      // true: reading snl_jobs fails, as it would with no connection
    denySettings:false,  // true: saving a setting is refused, as row-level security refuses a reader
    failLogin:"",        // "invalid" or "rate": signInWithPassword fails that way
    failUpdateUser:"",   // a message: updateUser fails with it
    // Create or change an answer job, the way the snl-chat function would: setJob("job-1", {status:"running", progress:[...]})
    setJob(id, patch){
      const now = new Date().toISOString();
      store.snl_jobs[id] = {id, owner:ME, status:"queued", question:"", progress:[], partial:null, result:null, error:null, segments:null,
        created_at:now, heartbeat_at:now, ...(store.snl_jobs[id]||{}), ...clone(patch||{}), updated_at:now};
      return clone(store.snl_jobs[id]);
    },
    row(table, id){ return store[table][id] ? clone(store[table][id]) : null; },
    // snl_store (saved S&P results): every read is recorded in storeReads as {cols, eqs, ord, lim}, so a test can
    // see exactly what the page asked for. failStore: a message, and reading snl_store fails with it.
    // storeDelay: milliseconds a read of snl_store waits before answering.
    storeReads:[], failStore:"", storeDelay:0,
    // snl_library (the team library): every read is recorded in libReads as {cols, eqs, ilikes, ord, range, single};
    // failLibrary: true and reading it fails, as with no connection.
    libReads:[], failLibrary:false,
    // An auth event from elsewhere, for example the session ending in another tab: fire("SIGNED_OUT")
    fire(event){ authCbs.forEach(cb => cb(event, event==="SIGNED_OUT" ? null : session())); }
  };

  // Storage (the PowerPoint template): storage.from(bucket).list/download/upload against in-memory buckets, answering
  // with errors shaped like supabase-js's StorageApiError. Options: template: {text, updated_at} starts the
  // "snl-template" bucket with template.pptx; noBucket: true starts with no such bucket (the migration not run).
  // Switches on __mock.storage: noBucket, refuse (true: reads and writes refused, as a policy would), netFail (true:
  // every call fails as with no connection), delay (milliseconds before each answer). Records: calls [{op, bucket,
  // path, opts}], uploads [{bucket, path, size, type, opts, text}].
  const enc = s => Array.from(new TextEncoder().encode(String(s)));
  M.storage = {buckets:{"snl-template":{}}, noBucket:!!O.noBucket, refuse:false, netFail:false, delay:0, calls:[], uploads:[]};
  if(O.template) M.storage.buckets["snl-template"]["template.pptx"] = {bytes:enc(O.template.text||"PK made-up template"), updated_at:O.template.updated_at||"2026-11-05T09:30:00Z"};
  const sErr = (message, statusCode, status) => ({name:"StorageApiError", message, statusCode, status});
  // Templates of your own (migration 0008): "<user id>/template.pptx" in the same bucket. The rules follow the
  // policies: before 0008 (option noOwnTemplates: true, or __mock.storage.ownOff) any login with a role reads every
  // object and only Corp Dev writes; after it, everyone reads template.pptx, only Corp Dev writes it, and each login
  // reads and writes its own "<id>/template.pptx" and nothing else. Option ownTemplates: {u1:{text, updated_at}}
  // starts logins with one. storage.getBucket answers only after 0008 (before it the bucket is hidden from logins).
  M.storage.ownOff = !!O.noOwnTemplates;
  Object.entries(O.ownTemplates||{}).forEach(([uid,o]) => { M.storage.buckets["snl-template"][uid+"/template.pptx"] = {bytes:enc(o.text||"PK own template"), updated_at:o.updated_at||"2026-11-12T10:00:00Z"}; });
  M.storage.may = (op, path) => {   // what the policies allow the login signed in now
    const role = store.profiles[M.uid] && store.profiles[M.uid].role, read = op==="list"||op==="download";
    if(!role) return false;
    if(M.storage.ownOff) return read || role==="corpdev";
    if(path==="template.pptx") return read || role==="corpdev";
    return path===M.uid+"/template.pptx";
  };
  M.storage.getBucket = async id => {
    M.storage.calls.push({op:"getBucket", bucket:id, path:null, opts:null});
    if(M.storage.delay) await new Promise(r=>setTimeout(r, M.storage.delay));
    if(M.storage.netFail) return {data:null, error:{name:"StorageUnknownError", message:"Failed to fetch"}};
    if(M.storage.noBucket || M.storage.ownOff || !M.storage.buckets[id] || !(store.profiles[M.uid]&&store.profiles[M.uid].role)) return {data:null, error:sErr("Bucket not found", "404", 400)};
    return {data:{id, name:id, public:false, file_size_limit:52428800, allowed_mime_types:["application/vnd.openxmlformats-officedocument.presentationml.presentation"]}, error:null};
  };
  function bucket(name){
    const gate = async (op, path, opts) => {
      M.storage.calls.push({op, bucket:name, path, opts:opts?clone(opts):null});
      if(M.storage.delay) await new Promise(r=>setTimeout(r, M.storage.delay));
      if(M.storage.netFail) return {name:"StorageUnknownError", message:"Failed to fetch"};
      if(M.storage.noBucket || !M.storage.buckets[name]) return sErr("Bucket not found", "404", 400);
      if(M.storage.refuse) return op==="upload" ? sErr("new row violates row-level security policy", "403", 400) : op==="download" ? sErr("Object not found", "404", 400) : null;
      return null;
    };
    return {
      async list(prefix, opts){ const e=await gate("list", prefix, opts); if(e) return {data:null, error:e};
        if(M.storage.refuse) return {data:[], error:null};   // a policy hides what it doesn't allow
        const s=opts&&opts.search||""; const B=M.storage.buckets[name], pre=prefix?String(prefix).replace(/\/$/,"")+"/":"";
        const seen=Object.keys(B).filter(k=>k.startsWith(pre) && M.storage.may("list", k));   // what the policies let this login see
        const folders=[...new Set(seen.map(k=>k.slice(pre.length)).filter(r=>r.includes("/")).map(r=>r.split("/")[0]))].filter(f=>f.includes(s));
        return {data:folders.map(f=>({name:f, id:null, updated_at:null, created_at:null, last_accessed_at:null, metadata:null})).concat(seen.filter(k=>!k.slice(pre.length).includes("/")).map(k=>k.slice(pre.length)).filter(k=>k.includes(s)).map(r=>pre+r).map(k=>({name:k.slice(pre.length), id:"obj-"+k, updated_at:B[k].updated_at, created_at:B[k].updated_at, last_accessed_at:null, metadata:{size:B[k].bytes.length, mimetype:"application/vnd.openxmlformats-officedocument.presentationml.presentation"}}))), error:null}; },
      async download(path){ const e=await gate("download", path); if(e) return {data:null, error:e};
        const o=M.storage.buckets[name][path]; if(!o || !M.storage.may("download", path)) return {data:null, error:sErr("Object not found", "404", 400)};
        return {data:new Blob([new Uint8Array(o.bytes)]), error:null}; },
      async upload(path, body, opts){ const e=await gate("upload", path, opts); if(e) return {data:null, error:e};
        if(!M.storage.may("upload", path)) return {data:null, error:sErr("new row violates row-level security policy", "403", 400)};
        const B=M.storage.buckets[name]; if(B[path] && !(opts&&opts.upsert)) return {data:null, error:sErr("The resource already exists", "409", 400)};
        const bytes=Array.from(new Uint8Array(await body.arrayBuffer()));
        M.storage.uploads.push({bucket:name, path, size:bytes.length, type:body.type||"", opts:opts?clone(opts):null, text:new TextDecoder().decode(new Uint8Array(bytes.slice(0,64)))});
        B[path]={bytes, updated_at:new Date().toISOString()}; return {data:{path, id:"obj-"+path, fullPath:name+"/"+path}, error:null}; },
      // remove([paths]): as Supabase answers, what a policy hides is simply not removed (no error); records removes
      async remove(paths){ const e=await gate("remove", (paths||[]).join(",")); if(e) return {data:null, error:e};
        if(M.storage.refuse) return {data:[], error:null};
        const B=M.storage.buckets[name], gone=(paths||[]).filter(k=>B[k] && M.storage.may("remove", k));
        gone.forEach(k=>{ delete B[k]; }); (M.storage.removes=M.storage.removes||[]).push(...gone);
        return {data:gone.map(k=>({name:k, bucket_id:name})), error:null}; }
    };
  }

  function query(table){
    const st = {op:"select", eqs:[], ins:[], ord:null, lim:null, single:false, vals:null, cols:null, gtes:[], lts:[], range:null};
    const b = {
      select(c){ st.cols=c||null; return b; },
      gte(c, v){ st.gtes.push([c, v]); return b; },
      lt(c, v){ st.lts.push([c, v]); return b; },
      range(a, z){ st.range=[a, z]; return b; },
      eq(c, v){ st.eqs.push([c, v]); return b; },
      // is(c, null): "doc->>key" reads a key inside a jsonb column, as PostgREST does; a missing key is null
      is(c, v){ (st.iss=st.iss||[]).push([c, v]); return b; },
      in(c, v){ st.ins.push([c, v]); return b; },
      // ilike(c, "%word%"): the text anywhere in the column, any letter case (only % wildcards, as the page sends)
      ilike(c, v){ (st.ilikes=st.ilikes||[]).push([c, v]); return b; },
      order(c, o){ st.ord=[c, !(o&&o.ascending===false)]; return b; },
      limit(n){ st.lim=n; return b; },
      maybeSingle(){ st.single=true; return b; },
      upsert(row){ st.op="upsert"; st.vals=row; return b; },
      then(res, rej){ return Promise.resolve().then(run).then(res, rej); }
    };
    const match = r => st.eqs.every(([c,v]) => String(r[c]) === String(v)) && st.ins.every(([c,v]) => v.map(String).includes(String(r[c])))
      && st.gtes.every(([c,v]) => String(r[c]) >= String(v)) && st.lts.every(([c,v]) => String(r[c]) < String(v))
      && (table !== "snl_jobs" || (r.owner ?? ME) === M.uid)
      && (st.ilikes||[]).every(([c,v]) => new RegExp("^"+String(v).split("%").map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join(".*")+"$","is").test(String(r[c]??"")))
      && (st.iss||[]).every(([c,v]) => { const [col, ...ks]=c.split(/->>?/); let x=r[col]; for(const k of ks) x = x!==null && typeof x==="object" && k in x ? x[k] : null; return (x===undefined?null:x)===v || (x!==null && String(x)===String(v)); });
    function run(){
      const T = store[table];
      if(!T) return {data:null, error:{code:"PGRST205", message:`Could not find the table 'public.${table}' in the schema cache`}};
      if(st.op === "upsert"){
        M.log.push({op:"upsert", table, id:st.vals.id});
        if(table !== "snl_settings" || M.denySettings) return {data:null, error:{code:"42501", message:`new row violates row-level security policy for table "${table}"`}};
        T[st.vals.id] = {...clone(st.vals), updated_at:new Date().toISOString(), updated_by:ME};
        return {data:null, error:null};
      }
      if(table === "snl_store") return storeRun();
      const byId = st.eqs.some(([c]) => c === "id");
      if(table === "snl_jobs"){ M.jobQueries.push(clone({cols:st.cols, eqs:st.eqs, ins:st.ins, gtes:st.gtes, lts:st.lts, ord:st.ord, lim:st.lim, range:st.range, single:st.single, uid:M.uid}));
        if(!byId){ M.listReads++; if(M.failList || M.failJobs) return {data:null, error:{message:"TypeError: Failed to fetch"}}; } }
      if(table === "snl_jobs" && byId){ M.jobReads++; if(M.failJobs) return {data:null, error:{message:"TypeError: Failed to fetch"}}; }
      let rows = Object.values(T).filter(match).map(clone);
      if(st.ord){ const [c,asc]=st.ord; rows.sort((x,y)=>(String(x[c])<String(y[c])?-1:String(x[c])>String(y[c])?1:0)*(asc?1:-1)); }
      if(st.lim) rows = rows.slice(0, st.lim);
      if(st.range) rows = rows.slice(st.range[0], st.range[1]+1);
      // only the columns asked for, as PostgREST answers
      if(table === "snl_library"){ M.libReads.push(clone({cols:st.cols, eqs:st.eqs, ilikes:st.ilikes||[], ord:st.ord, range:st.range, single:st.single})); if(M.failLibrary) return {data:null, error:{message:"TypeError: Failed to fetch"}}; }
      if((table === "snl_jobs" || table === "snl_library") && st.cols && st.cols !== "*"){ const cs = st.cols.split(",").map(s=>s.trim()); rows = rows.map(r => Object.fromEntries(cs.filter(c=>c in r).map(c=>[c, r[c]]))); }
      return st.single ? {data:rows[0]||null, error:null} : {data:rows, error:null};
    }
    // snl_store answers the way PostgREST would: only the columns asked for, where "alias:doc->a->b" is a JSON
    // path into a jsonb column and a plain name is the whole column (so "doc" alone returns every saved row).
    async function storeRun(){
      M.storeReads.push({cols:st.cols==null?"*":String(st.cols), eqs:clone(st.eqs), ord:st.ord, lim:st.lim, iss:clone(st.iss||[])});
      if(M.storeDelay) await new Promise(r=>setTimeout(r, M.storeDelay));
      if(M.failStore) return {data:null, error:{message:M.failStore}};
      let rows = Object.values(store.snl_store).filter(match).map(clone);
      if(st.ord){ const [c,asc]=st.ord; rows.sort((x,y)=>(String(x[c])<String(y[c])?-1:String(x[c])>String(y[c])?1:0)*(asc?1:-1)); }
      if(st.lim) rows = rows.slice(0, st.lim);
      const cols = st.cols==null||st.cols==="*" ? null : String(st.cols).split(",").map(s=>s.trim()).filter(Boolean).map(s=>{
        const m=s.match(/^(?:([A-Za-z_]\w*):)?([A-Za-z_]\w*)((?:->>?\w+)*)$/); if(!m) throw new Error("bad select "+s);
        const path=[...m[3].matchAll(/->(>?)(\w+)/g)].map(x=>[x[2], !!x[1]]);
        return {as:m[1]||(path.length?path[path.length-1][0]:m[2]), col:m[2], path};
      });
      if(cols) rows = rows.map(r=>Object.fromEntries(cols.map(({as,col,path})=>{ let v=r[col];
        for(const [k,txt] of path){ v = v!==null && typeof v==="object" && k in v ? v[k] : null; if(txt && v!==null) v = typeof v==="object" ? JSON.stringify(v) : String(v); }
        return [as, v===undefined ? null : v]; })));
      return st.single ? {data:rows[0]||null, error:null} : {data:rows, error:null};
    }
    return b;
  }

  const client = {
    from: query,
    storage: { from: bucket, getBucket: id => M.storage.getBucket(id) },
    auth: {
      async getSession(){ return {data:{session: M.signedOut ? null : session()}}; },
      async signInWithPassword(c){
        M.log.push({op:"signIn", email:c&&c.email});
        if(M.failLogin==="invalid") return {data:{session:null}, error:{code:"invalid_credentials", message:"Invalid login credentials"}};
        if(M.failLogin==="rate") return {data:{session:null}, error:{code:"over_request_rate_limit", message:"Request rate limit reached"}};
        const name = String(c&&c.email||"").split("@")[0], other = Object.entries(O.users||{}).find(([n]) => n === name);
        M.uid = other ? other[1].id : ME;
        M.signedOut = false; return {data:{session:session()}, error:null};
      },
      async signOut(){ M.signedOut = true; M.log.push({op:"signOut"}); M.fire("SIGNED_OUT"); return {error:null}; },
      onAuthStateChange(cb){ authCbs.push(cb); return {data:{subscription:{unsubscribe(){}}}}; },
      async updateUser(v){ M.log.push({op:"updateUser", password:v&&v.password}); return {error: M.failUpdateUser ? {message:M.failUpdateUser} : null}; }
    }
  };
  window.supabase = { createClient(url, key){ M.created = {url, key}; return client; } };
})();
