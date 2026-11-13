// What every SNL lookup function shares: CORS, JSON answers, and checking the caller's login.
// The gateway's JWT check is off, so each function asks Supabase who the caller is, using the caller's own
// token so row-level security applies.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

export type Env = (k: string) => string | undefined;
/** The signed-in caller: their user id and role ("corpdev" or "reader"). null when not signed in or no profile. */
export type Who = { id: string; role: string } | null;
export type WhoIs = (req: Request) => Promise<Who>;
export type Json = (status: number, body: unknown) => Response;

/** ALLOWED_ORIGIN may be a site address with a path or trailing slash, or several separated by commas:
    compare origins only, and echo the caller's origin when it is one of them. */
export function allowOrigin(setting: string | undefined, origin: string | null): string {
  if (!setting || !setting.trim() || setting.trim() === "*") return "*";
  const allowed = setting.split(",").map((s) => { try { return new URL(s.trim()).origin; } catch { return s.trim().replace(/\/+$/, ""); } }).filter(Boolean);
  if (!allowed.length) return "*";
  return origin && allowed.includes(origin) ? origin : allowed[0];
}

export function corsHeaders(env: Env, req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowOrigin(env("ALLOWED_ORIGIN"), req.headers.get("Origin")),
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // So the page can read a downloaded document's file name.
    "Access-Control-Expose-Headers": "content-disposition, content-length",
  };
}

export function jsonWith(cors: Record<string, string>): Json {
  return (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

/** Wraps a function's work with CORS, the POST check and a last-resort error answer, so the page can always
    show a reason instead of the browser's bare "Failed to fetch". */
export async function withCors(req: Request, env: Env, what: string, work: (json: Json, cors: Record<string, string>) => Promise<Response>): Promise<Response> {
  const cors = corsHeaders(env, req);
  const json = jsonWith(cors);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method", message: "Use POST." });
  try { return await work(json, cors); }
  catch (e) { console.error(e); return json(500, { error: "server", message: `${what} failed: ${String((e as Error)?.message || "unknown error").replace(/[.\s]+$/, "")}. Try again. If it keeps happening, tell Corp Dev.` }); }
}

/** The project's service key, which Supabase gives every Edge Function (SUPABASE_SERVICE_ROLE_KEY, or the first
    key in SUPABASE_SECRET_KEYS on projects using the new API keys). */
export function serviceKey(env: Env): string | undefined {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    const first = keys.default ?? Object.values(keys)[0];
    return typeof first === "string" && first ? first : undefined;
  } catch { return undefined; }
}

/** A Supabase client that writes with the service role. null when the function isn't running inside Supabase. */
export function adminClient(env: Env): SupabaseClient | null {
  const url = env("SUPABASE_URL"), key = serviceKey(env);
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The caller's id and role, using their own token. Any login with a profile may use the app. */
export function whoIs(env: Env): WhoIs {
  return async (req) => {
    const auth = req.headers.get("Authorization") ?? "", key = req.headers.get("apikey") || env("SUPABASE_ANON_KEY") || "";
    if (!auth || !key) return null;
    const sb = createClient(env("SUPABASE_URL")!, key, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user } } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (!user) return null;
    const { data: profile } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
    return profile?.role ? { id: user.id, role: profile.role } : null;
  };
}

export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A short, stable id for a saved search: the first 32 hex characters of the SHA-256 of its text. */
export async function shortHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
