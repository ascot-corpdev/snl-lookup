// Cloudflare sign-on: turns a Cloudflare Access sign-in into a Supabase session (the snl-signin function).
//
// The site is served by a Cloudflare Worker behind Cloudflare Access. Access adds a signed token, the header
// Cf-Access-Jwt-Assertion, to every request it lets through; the Worker passes that token on to snl-signin.
// This file checks the token again, itself, against the Cloudflare team's public keys (it never trusts the
// Worker), finds or creates the Supabase user with that email address, keeps their profile and role up to date,
// and mints a short Supabase session for them. Only the access token goes back: never the refresh token, so a
// person removed in Cloudflare cannot keep renewing their Supabase session.
//
// Settings (supabase secrets set ...):
//   CF_ACCESS_TEAM_DOMAIN  the team domain, <team>.cloudflareaccess.com (with or without https://)
//   CF_ACCESS_AUD          the Access application's Audience (AUD) tag; several may be comma-separated
//   SNL_ADMIN_EMAILS       emails that get the Corp Dev role, comma-separated, any letter case. Everyone else is a
//                          reader. The role follows this list at every sign-in, up and down.
// Without the first two, nothing is minted and the answer says sign-in isn't set up yet.
//
// What Cloudflare documents (checked 18 Nov 2026): the token is RS256, signed with keys published at
// https://<team>.cloudflareaccess.com/cdn-cgi/access/certs (two keys, rotated every 6 weeks); iss is
// https://<team>.cloudflareaccess.com, aud a list holding the application's AUD tag, email the address the
// identity provider verified; a service token has no email.

import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { type Env, serviceKey } from "./http.ts";

export type AccessSettings = { team: string; auds: string[] };
export type Role = "corpdev" | "reader";

/** The team domain as a bare host name, or null when it isn't one. */
export function teamHost(v: string | undefined | null): string | null {
  // Forgiving about how it was pasted, the same way as the Worker: quotes round it, https://, a whole sign-in
  // address (the host is kept), or the team name alone (".cloudflareaccess.com" is added).
  let s = String(v ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim().toLowerCase();
  s = s.replace(/^https:\/\//, "").replace(/[\/?#].*$/, "");
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) s += ".cloudflareaccess.com";
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s) ? s : null;
}

/** The two Access settings, or null when either is missing: then nothing is minted. */
export function accessSettings(env: Env): AccessSettings | null {
  const team = teamHost(env("CF_ACCESS_TEAM_DOMAIN"));
  const auds = String(env("CF_ACCESS_AUD") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return team && auds.length ? { team, auds } : null;
}

/** The admin list, lower-cased, blanks dropped. An empty or missing setting means nobody is an admin. */
export function adminEmails(setting: string | undefined): Set<string> {
  return new Set(String(setting ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function roleFor(email: string, env: Env): Role {
  return adminEmails(env("SNL_ADMIN_EMAILS")).has(email.trim().toLowerCase()) ? "corpdev" : "reader";
}

const EMAIL = /^[^\s@",;<>]+@[^\s@",;<>]+\.[^\s@",;<>]+$/;
export const cleanEmail = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
};

/** "jane.doe+x@calloway.example" -> "Jane Doe": a readable name until the person has one of their own. */
export function displayNameFrom(email: string): string {
  const local = email.split("@")[0].replace(/\+.*$/, "");
  const words = local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  return (words.join(" ") || local || email).slice(0, 80);
}

/** A username that fits the profiles table (2 to 40 of a-z 0-9 . _ -): the part of the address before the @. */
export function usernameBase(email: string): string {
  let u = email.split("@")[0].replace(/\+.*$/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  u = u.slice(0, 36).replace(/[-.]+$/, "");
  return u.length >= 2 ? u : (u + "-user").replace(/^-/, "");
}

// ---------- the Access token ----------

export type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string };
type KeyAnswer = { key: Jwk } | { missing: true } | { unavailable: true };

/** Cloudflare's public keys, kept for an hour and fetched again when a token names a key not seen yet (rotation).
    One store serves every request of a running function. */
export class KeyStore {
  private keys: Jwk[] | null = null;
  private at = 0;
  private team = "";
  fetches = 0;
  constructor(private fetchFn: typeof fetch, private now: () => number = Date.now) {}

  private async load(team: string): Promise<boolean> {
    this.fetches++;
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(5000) : undefined;
      const r = await this.fetchFn(`https://${team}/cdn-cgi/access/certs`, { signal });
      if (!r.ok) return false;
      const body = await r.json();
      const keys = Array.isArray(body?.keys) ? body.keys.filter((k: Jwk) => k && typeof k === "object" && typeof k.kid === "string" && k.kty === "RSA" && typeof k.n === "string" && typeof k.e === "string") : null;
      if (!keys) return false;
      this.keys = keys; this.at = this.now(); this.team = team;
      return true;
    } catch { return false; }
  }

  async find(team: string, kid: string): Promise<KeyAnswer> {
    if (this.team !== team) { this.keys = null; this.at = 0; }
    if (!this.keys || this.now() - this.at > 3600_000) {
      if (!(await this.load(team))) return { unavailable: true };
    }
    let key = this.keys!.find((k) => k.kid === kid);
    // A key id not seen yet: Cloudflare may have rotated its keys. Ask again, at most every 10 seconds.
    if (!key && this.now() - this.at > 10_000) {
      if (!(await this.load(team))) return { unavailable: true };
      key = this.keys!.find((k) => k.kid === kid);
    }
    return key ? { key } : { missing: true };
  }
}

export type Refusal = "missing" | "malformed" | "algorithm" | "issuer" | "audience" | "expired" | "early" | "key" | "signature" | "no_email" | "keys_unavailable";
/** iat and exp are the token's own issue and expiry times (seconds): the same for every request of one Access
    session, so they tell one sign-in from the next (sign-in notices, signins.ts). iat is null when the token has none. */
export type Checked = { ok: true; email: string; sub: string; iat: number | null; exp: number } | { ok: false; why: Refusal };

function b64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)); }
  catch { return null; }
}
function jsonPart(s: string): Record<string, unknown> | null {
  const bytes = b64url(s);
  if (!bytes) return null;
  try { const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  catch { return null; }
}

/** Checks a Cloudflare Access application token: RS256 only, signed by one of the team's keys, issued by the
    team, for one of the expected audiences, inside its time window, and carrying a verified email. */
export async function checkAccessToken(token: string | null | undefined, settings: AccessSettings, keys: KeyStore, nowMs: number): Promise<Checked> {
  if (!token) return { ok: false, why: "missing" };
  if (token.length > 16_384) return { ok: false, why: "malformed" };
  const part = token.split(".");
  if (part.length !== 3 || !part[2]) return { ok: false, why: "malformed" };
  const head = jsonPart(part[0]), claims = jsonPart(part[1]), sig = b64url(part[2]);
  if (!head || !claims || !sig || !sig.length) return { ok: false, why: "malformed" };
  if (head.alg !== "RS256") return { ok: false, why: "algorithm" };
  if (typeof head.kid !== "string" || !head.kid) return { ok: false, why: "malformed" };
  if (claims.iss !== `https://${settings.team}`) return { ok: false, why: "issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && settings.auds.includes(a))) return { ok: false, why: "audience" };
  const now = nowMs / 1000;
  if (typeof claims.exp !== "number" || !(claims.exp > now)) return { ok: false, why: "expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 30)) return { ok: false, why: "early" };
  const found = await keys.find(settings.team, head.kid);
  if ("unavailable" in found) return { ok: false, why: "keys_unavailable" };
  if ("missing" in found) return { ok: false, why: "key" };
  let good = false;
  try {
    const { kty, n, e } = found.key;
    const key = await crypto.subtle.importKey("jwk", { kty, n, e, ext: true } as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(part[0] + "." + part[1]));
  } catch { good = false; }
  if (!good) return { ok: false, why: "signature" };
  const email = cleanEmail(claims.email);
  if (!email) return { ok: false, why: "no_email" };
  return { ok: true, email, sub: typeof claims.sub === "string" ? claims.sub : "", iat: typeof claims.iat === "number" && Number.isFinite(claims.iat) ? claims.iat : null, exp: claims.exp };
}

// ---------- the Supabase side ----------

export type Profile = { id: string; username: string; display_name: string; role: string };
/** What minting gives back. A refresh token is never part of it. */
export type Minted = { userId: string; accessToken: string; expiresAt: number };

/** Everything sign-on needs from Supabase, behind one small interface so tests can use a stand-in. */
export interface SigninStore {
  /** Creates a confirmed user with this email and a long random password nobody knows, unless one exists. */
  ensureUser(email: string): Promise<void>;
  /** A real Supabase session for the user with this email, made without sending any email. */
  mint(email: string): Promise<Minted>;
  profile(id: string): Promise<Profile | null>;
  /** The id of the profile that has this username, or null. */
  usernameOwner(username: string): Promise<string | null>;
  saveProfile(p: Profile): Promise<void>;
}

/** who: on success only, never sent back: the verified sign-in, for the record of sign-ins (signins.ts). */
export type SigninResult = { status: number; body: Record<string, unknown>; who?: { email: string; role: Role; iat: number | null; exp: number } };

export const MSG = {
  notSetUp: "Cloudflare let you in, but sign-in isn't set up on Supabase yet. Ask the site owner to finish the set-up (README, Cloudflare sign-on).",
  signin: "Your Cloudflare sign-in couldn't be confirmed. Reload the page to sign in again.",
  noEmail: "This Cloudflare sign-in has no email address, so it can't be used here. Sign in with your email address.",
  keys: "Cloudflare's sign-in check couldn't be reached. Try again in a minute.",
  server: "Your session couldn't be started. Try again in a minute. If it keeps happening, tell the site owner.",
};

async function pickUsername(store: SigninStore, email: string, id: string): Promise<string> {
  const base = usernameBase(email);
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    const owner = await store.usernameOwner(name);
    if (!owner || owner === id) return name;
  }
  return `${base.slice(0, 27)}-${id.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}`;
}

/** Keeps the profile in step with the sign-in: creates it the first time; afterwards changes only the role (the
    username and display name the person already has are kept). */
export async function upkeepProfile(store: SigninStore, id: string, email: string, role: Role): Promise<Profile> {
  const had = await store.profile(id);
  if (had) {
    const next = { ...had, role, display_name: had.display_name || displayNameFrom(email) };
    if (next.role !== had.role || next.display_name !== had.display_name) await store.saveProfile(next);
    return next;
  }
  const fresh: Profile = { id, username: await pickUsername(store, email, id), display_name: displayNameFrom(email), role };
  await store.saveProfile(fresh);
  return fresh;
}

/** The whole sign-in: check the token, find or create the user, keep the profile, mint the session. */
export async function signIn(token: string | null, deps: { env: Env; store: SigninStore | null; keys: KeyStore; now: number }): Promise<SigninResult> {
  const settings = accessSettings(deps.env);
  if (!settings || !deps.store) return { status: 503, body: { error: "not_configured", message: MSG.notSetUp } };
  const checked = await checkAccessToken(token, settings, deps.keys, deps.now);
  if (!checked.ok) {
    console.error(`snl-signin: refused (${checked.why})`);   // the reason only: never the token or the address
    if (checked.why === "keys_unavailable") return { status: 503, body: { error: "unavailable", message: MSG.keys } };
    if (checked.why === "no_email") return { status: 403, body: { error: "no_email", message: MSG.noEmail } };
    return { status: 401, body: { error: "signin", message: MSG.signin } };
  }
  const role = roleFor(checked.email, deps.env);
  try {
    await deps.store.ensureUser(checked.email);
    const minted = await deps.store.mint(checked.email);
    const profile = await upkeepProfile(deps.store, minted.userId, checked.email, role);
    return {
      status: 200,
      body: {
        // expiresIn as well as expiresAt, so a browser whose clock is wrong still renews in time
        accessToken: minted.accessToken, expiresAt: minted.expiresAt, expiresIn: Math.max(0, minted.expiresAt - Math.floor(deps.now / 1000)),
        profile: { id: profile.id, email: checked.email, username: profile.username, displayName: profile.display_name, role: profile.role },
      },
      who: { email: checked.email, role, iat: checked.iat, exp: checked.exp },
    };
  } catch (e) {
    console.error(`snl-signin: couldn't start a session (${String((e as Error)?.name || "error")})`);
    return { status: 500, body: { error: "server", message: MSG.server } };
  }
}

// ---------- the real store, on Supabase's admin API ----------

function randomPassword(): string {
  const b = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const exists = (err: { code?: string; status?: number; message?: string } | null) =>
  !!err && (err.code === "email_exists" || err.code === "user_already_exists" || /already (been )?registered|already exists/i.test(err.message ?? ""));

/** The store on a real project, with the service key Supabase gives every function. null outside Supabase. */
export function supabaseSigninStore(env: Env, fetchFn?: typeof fetch, now: () => number = Date.now): SigninStore | null {
  const url = env("SUPABASE_URL"), key = serviceKey(env);
  if (!url || !key) return null;
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, ...(fetchFn ? { global: { fetch: fetchFn } } : {}) };
  const admin = createClient(url, key, opts);
  const fail = (what: string, err: { message?: string } | null): never => { const e = new Error(`${what}: ${err?.message ?? "no answer"}`); e.name = what; throw e; };
  return {
    async ensureUser(email) {
      const { error } = await admin.auth.admin.createUser({ email, password: randomPassword(), email_confirm: true });
      if (error && !exists(error)) fail("create_user", error);
    },
    async mint(email) {
      // An admin "magic link" for the user, made without sending it; its hashed token is exchanged here for a
      // session. The exchange runs on a client of its own: verifyOtp keeps the session it gets, and on the admin
      // client that would make every later database call run as the user instead of with the service key.
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      const hash = data?.properties?.hashed_token;
      if (error || !hash) fail("generate_link", error);
      const once = createClient(url, key, opts);
      const { data: v, error: ve } = await once.auth.verifyOtp({ token_hash: hash!, type: "email" });
      const s = v?.session;
      if (ve || !s?.access_token || !s.user?.id) fail("verify", ve);
      const expiresAt = typeof s!.expires_at === "number" ? s!.expires_at : Math.floor(now() / 1000) + (Number(s!.expires_in) || 3600);
      return { userId: s!.user.id, accessToken: s!.access_token, expiresAt };   // the refresh token stays here
    },
    async profile(id) {
      const { data, error } = await admin.from("profiles").select("id,username,display_name,role").eq("id", id).maybeSingle();
      if (error) fail("profile", error);
      return (data as Profile | null) ?? null;
    },
    async usernameOwner(username) {
      const { data, error } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
      if (error) fail("profile", error);
      return (data as { id: string } | null)?.id ?? null;
    },
    async saveProfile(p) {
      const { error } = await admin.from("profiles").upsert({ id: p.id, username: p.username, display_name: p.display_name, role: p.role }, { onConflict: "id" });
      if (error) fail("save_profile", error);
    },
  };
}
