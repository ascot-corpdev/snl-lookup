// In-memory stand-in for supabase-js, for the page tests: one made-up login, the three tables the page reads
// (profiles, snl_jobs, snl_settings) and test hooks on window.__mock. Nothing here touches a real database.
// A test sets options before the page loads with page.addInitScript(o => { window.__opts = o; }, {...}):
//   role: "corpdev" (default) or "reader"    signedOut: true to start at the sign-in form
//   noProfile: true for a login with no role   seed: [[table, id, row], ...] rows to start with
(function(){
  const clone = o => JSON.parse(JSON.stringify(o));
  const O = window.__opts || {};
  const ME = "u1";
  const store = { profiles:{ [ME]:{id:ME, username:"corpdev1", display_name:"Corp Dev 1", role:O.role||"corpdev"} }, snl_jobs:{}, snl_settings:{} };
  if(O.noProfile) delete store.profiles[ME];
  (O.seed||[]).forEach(([t,id,row]) => { store[t][id] = {id, ...clone(row)}; });
  const authCbs = [];
  const session = () => ({user:{id:ME}, access_token:"t"});
  const M = window.__mock = {
    store, log:[], created:null, signedOut:!!O.signedOut,
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
    // An auth event from elsewhere, for example the session ending in another tab: fire("SIGNED_OUT")
    fire(event){ authCbs.forEach(cb => cb(event, event==="SIGNED_OUT" ? null : session())); }
  };

  function query(table){
    const st = {op:"select", eqs:[], ins:[], ord:null, lim:null, single:false, vals:null};
    const b = {
      select(){ return b; },
      eq(c, v){ st.eqs.push([c, v]); return b; },
      in(c, v){ st.ins.push([c, v]); return b; },
      order(c, o){ st.ord=[c, !(o&&o.ascending===false)]; return b; },
      limit(n){ st.lim=n; return b; },
      maybeSingle(){ st.single=true; return b; },
      upsert(row){ st.op="upsert"; st.vals=row; return b; },
      then(res, rej){ return Promise.resolve().then(run).then(res, rej); }
    };
    const match = r => st.eqs.every(([c,v]) => String(r[c]) === String(v)) && st.ins.every(([c,v]) => v.map(String).includes(String(r[c])));
    function run(){
      const T = store[table];
      if(!T) return {data:null, error:{code:"PGRST205", message:`Could not find the table 'public.${table}' in the schema cache`}};
      if(st.op === "upsert"){
        M.log.push({op:"upsert", table, id:st.vals.id});
        if(table !== "snl_settings" || M.denySettings) return {data:null, error:{code:"42501", message:`new row violates row-level security policy for table "${table}"`}};
        T[st.vals.id] = {...clone(st.vals), updated_at:new Date().toISOString(), updated_by:ME};
        return {data:null, error:null};
      }
      if(table === "snl_jobs"){ M.jobReads++; if(M.failJobs) return {data:null, error:{message:"TypeError: Failed to fetch"}}; }
      let rows = Object.values(T).filter(match).map(clone);
      if(st.ord){ const [c,asc]=st.ord; rows.sort((x,y)=>(String(x[c])<String(y[c])?-1:String(x[c])>String(y[c])?1:0)*(asc?1:-1)); }
      if(st.lim) rows = rows.slice(0, st.lim);
      return st.single ? {data:rows[0]||null, error:null} : {data:rows, error:null};
    }
    return b;
  }

  const client = {
    from: query,
    auth: {
      async getSession(){ return {data:{session: M.signedOut ? null : session()}}; },
      async signInWithPassword(c){
        M.log.push({op:"signIn", email:c&&c.email});
        if(M.failLogin==="invalid") return {data:{session:null}, error:{code:"invalid_credentials", message:"Invalid login credentials"}};
        if(M.failLogin==="rate") return {data:{session:null}, error:{code:"over_request_rate_limit", message:"Request rate limit reached"}};
        M.signedOut = false; return {data:{session:session()}, error:null};
      },
      async signOut(){ M.signedOut = true; M.log.push({op:"signOut"}); M.fire("SIGNED_OUT"); return {error:null}; },
      onAuthStateChange(cb){ authCbs.push(cb); return {data:{subscription:{unsubscribe(){}}}}; },
      async updateUser(v){ M.log.push({op:"updateUser", password:v&&v.password}); return {error: M.failUpdateUser ? {message:M.failUpdateUser} : null}; }
    }
  };
  window.supabase = { createClient(url, key){ M.created = {url, key}; return client; } };
})();
