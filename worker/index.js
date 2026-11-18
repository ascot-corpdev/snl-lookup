// SNL lookup's Cloudflare Worker: serves the site (web/) at <name>.<account>.workers.dev behind Cloudflare Access,
// and is the only way in to a Supabase session. Plain JavaScript module: no build step, no dependencies.
//
// It runs before every request (wrangler.toml: run_worker_first) and fails closed: a request is answered only when
// it carries a valid Cloudflare Access sign-in for this site, the Cf-Access-Jwt-Assertion header Access adds,
// checked here against the team's public keys. With Access switched off, a token for another application, or the
// settings below missing, it answers 403 and serves nothing.
//
//   GET  /config.js     the page's settings, written from this Worker's settings (no config.js is uploaded)
//   POST /auth/session  passes the Access token on to the Supabase function snl-signin, which checks it again
//                       itself and returns a short Supabase session (the access token only)
//   GET  /auth/signout  sends the browser to Access's own logout address
//   anything else       the file from web/
//
// Settings on the Worker (none is a secret, but the repository is public, so none is committed; set them with
// `npx wrangler secret put NAME`, which a deploy never removes):
//   TEAM_DOMAIN               <team>.cloudflareaccess.com (with or without https://)
//   POLICY_AUD                the Access application's Audience (AUD) tag; several may be comma-separated
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  sb_publishable_... (never the secret key: a secret key is refused, not served)
//   ORG_NAME                  optional: the company name the site shows

const KEYS_FOR_MS = 3600e3, REFETCH_AFTER_MS = 10e3, SKEW_S = 30;

const b64url = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)); }
  catch { return null; }
};
const jsonPart = (s) => {
  const b = b64url(s);
  if (!b) return null;
  try { const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)); return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  catch { return null; }
};
export const teamHost = (v) => {
  const s = String(v ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s) ? s : null;
};
const auds = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The Supabase settings this Worker passes to the page: the address only when it is a plain https origin, and the
    key only when it isn't a secret key (a secret key is never served, even if set by mistake). */
export function pageSettings(env) {
  const url = String(env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "").replace(/\/(rest|auth)\/v1$/, "");
  const key = String(env.SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  let okUrl = "";
  try { const u = new URL(url); if (u.protocol === "https:" && !u.search && !u.hash && !u.username && u.pathname === "/") okUrl = u.origin; } catch { /* not an address */ }
  const secret = /^sb_secret_/.test(key) || /service_role/.test(key);
  return { supabaseUrl: okUrl, supabaseAnonKey: secret ? "" : key, orgName: String(env.ORG_NAME ?? "").trim().slice(0, 120), secret };
}

/** The page's settings as a script. JSON with <, >, &, and the two line separators escaped, so no value can end
    the script or start markup, whatever it holds. */
export function configScript(env) {
  const s = pageSettings(env);
  const cfg = { supabaseUrl: s.supabaseUrl, supabaseAnonKey: s.supabaseAnonKey, orgName: s.orgName, signOn: "cloudflare", ...(s.secret ? { configProblem: "secret_key" } : {}) };
  const json = JSON.stringify(cfg).replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return `window.SNL_CONFIG = ${json};\n`;
}

const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" };
const NO_STORE = "no-store";

function page(status, title, text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<style>body{font:16px/1.5 Arial,Helvetica,sans-serif;margin:0;padding:48px 16px;color:#1d2433;background:#fff}main{max-width:560px;margin:0 auto}h1{font-size:22px}</style></head>`
    + `<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_STORE, ...SECURITY } });
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": NO_STORE, ...SECURITY } });

export const TEXT = {
  notSetUp: "This site's Cloudflare sign-in isn't set up yet, so nothing is served. If you run the site, set TEAM_DOMAIN and POLICY_AUD on the Worker (README, Cloudflare sign-on).",
  signIn: "You need to sign in through Cloudflare to use this site. Open the site's address again to sign in. If this keeps happening, ask the site owner to check that your email address is on the list.",
  keys: "Cloudflare's sign-in check couldn't be reached. Wait a minute and reload the page.",
  unreachable: "The sign-in service can't be reached. Try again in a minute.",
};

/** A Worker with its own fetch and clock, so tests can run it under Node with stand-ins. */
export function createWorker({ fetch: fetchFn, now = () => Date.now() } = {}) {
  let keys = null, keysAt = 0, keysTeam = "";

  async function loadKeys(team) {
    try {
      const r = await fetchFn(`https://${team}/cdn-cgi/access/certs`);
      if (!r.ok) return false;
      const body = await r.json();
      if (!body || !Array.isArray(body.keys)) return false;
      keys = body.keys.filter((k) => k && k.kty === "RSA" && typeof k.kid === "string" && typeof k.n === "string" && typeof k.e === "string");
      keysAt = now(); keysTeam = team;
      return true;
    } catch { return false; }
  }

  /** "ok", or why not: "keys" when Cloudflare's keys can't be fetched, otherwise "refused". */
  async function check(token, team, want) {
    if (!token || token.length > 16384) return "refused";
    const part = token.split(".");
    if (part.length !== 3 || !part[2]) return "refused";
    const head = jsonPart(part[0]), claims = jsonPart(part[1]), sig = b64url(part[2]);
    if (!head || !claims || !sig || !sig.length) return "refused";
    if (head.alg !== "RS256" || typeof head.kid !== "string" || !head.kid) return "refused";
    if (claims.iss !== `https://${team}`) return "refused";
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === "string" && want.includes(a))) return "refused";
    const t = now() / 1000;
    if (typeof claims.exp !== "number" || !(claims.exp > t)) return "refused";
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > t + SKEW_S)) return "refused";
    if (keysTeam !== team) { keys = null; keysAt = 0; }
    if (!keys || now() - keysAt > KEYS_FOR_MS) { if (!(await loadKeys(team))) return "keys"; }
    let jwk = keys.find((k) => k.kid === head.kid);
    if (!jwk && now() - keysAt > REFETCH_AFTER_MS) {   // a key id not seen yet: Cloudflare may have rotated
      if (!(await loadKeys(team))) return "keys";
      jwk = keys.find((k) => k.kid === head.kid);
    }
    if (!jwk) return "refused";
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(part[0] + "." + part[1]))) ? "ok" : "refused";
    } catch { return "refused"; }
  }

  async function session(token, env) {
    const { supabaseUrl: url, supabaseAnonKey: key } = pageSettings(env);
    if (!url || !key) return json(503, { error: "not_configured", message: "Cloudflare let you in, but the site isn't set up yet: the Worker doesn't know which Supabase project to use. Ask the site owner (README, Cloudflare sign-on)." });
    let r;
    try {
      // Only the token goes on: no cookies, no other headers from the browser.
      r = await fetchFn(`${url}/functions/v1/snl-signin`, { method: "POST", headers: { "Content-Type": "application/json", apikey: key, "Cf-Access-Jwt-Assertion": token }, body: JSON.stringify({ action: "session" }) });
    } catch { return json(502, { error: "unreachable", message: TEXT.unreachable }); }
    let body = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    if (r.status === 404 && !(body && body.message)) return json(503, { error: "not_configured", message: "Cloudflare let you in, but the site isn't set up yet: the sign-in function isn't deployed on Supabase. Ask the site owner (README, Cloudflare sign-on)." });
    if (!body || typeof body !== "object") return json(502, { error: "unreachable", message: TEXT.unreachable });
    // Only the fields the page needs go back, whatever the function said.
    if (r.ok && typeof body.accessToken === "string" && body.profile && typeof body.profile === "object") {
      const p = body.profile;
      return json(200, { accessToken: body.accessToken, expiresAt: Number(body.expiresAt) || 0, expiresIn: Number(body.expiresIn) || 0,
        profile: { id: String(p.id ?? ""), email: String(p.email ?? ""), username: String(p.username ?? ""), displayName: String(p.displayName ?? ""), role: String(p.role ?? "") } });
    }
    const status = r.ok ? 502 : r.status;
    return json(status, { error: String(body.error ?? "server"), message: String(body.message ?? TEXT.unreachable) });
  }

  return {
    async fetch(req, env) {
      env = env || {};
      const team = teamHost(env.TEAM_DOMAIN), want = auds(env.POLICY_AUD);
      const url = new URL(req.url), path = url.pathname, isApi = path.startsWith("/auth/");
      if (!team || !want.length) return isApi ? json(403, { error: "not_configured", message: TEXT.notSetUp }) : page(403, "Not set up yet", TEXT.notSetUp);
      const token = req.headers.get("Cf-Access-Jwt-Assertion");
      const verdict = await check(token, team, want);
      if (verdict === "keys") return isApi ? json(503, { error: "unavailable", message: TEXT.keys }) : page(503, "Sign-in check unavailable", TEXT.keys);
      if (verdict !== "ok") return isApi ? json(403, { error: "signin", message: TEXT.signIn }) : page(403, "Sign in through Cloudflare", TEXT.signIn);

      if (path === "/config.js") {
        if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method", message: "Use GET." });
        return new Response(req.method === "HEAD" ? null : configScript(env), { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": NO_STORE, ...SECURITY } });
      }
      if (path === "/auth/session") {
        if (req.method !== "POST") return json(405, { error: "method", message: "Use POST." });
        return session(token, env);
      }
      if (path === "/auth/signout") return new Response(null, { status: 302, headers: { Location: "/cdn-cgi/access/logout", "Cache-Control": NO_STORE, ...SECURITY } });
      if (isApi) return json(404, { error: "not_found", message: "Not found." });

      if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method", message: "Use GET." });
      if (!env.ASSETS) return page(503, "Not set up yet", "The site's files aren't attached to this Worker. If you run the site, deploy it with wrangler (README, Cloudflare sign-on).");
      const res = await env.ASSETS.fetch(req);
      const out = new Response(res.body, res);
      // Behind a sign-in: no shared cache may keep a copy, and the browser checks for a newer one each time.
      out.headers.set("Cache-Control", "private, no-cache");
      for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
      return out;
    },
  };
}

export default createWorker({ fetch: (...a) => fetch(...a) });
