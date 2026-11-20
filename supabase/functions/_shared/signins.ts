// Sign-in notices: a record of who signed in through Cloudflare sign-on, and an email to the owner when someone
// else does. Used by snl-signin after the session is minted; nothing here can make a sign-in fail or wait long.
//
// One sign-in is one Cloudflare Access session. Access issues the application token when the person signs in and
// reuses it until it expires, and the page calls snl-signin on every load and every hour with it, so the token's
// own issue time (iat) and the email address together name the session. Only a SHA-256 of the two is kept, never
// the token. The first call of a session adds a row (an insert that does nothing when the row is already there, so
// two page loads at once make one row and one email); later calls only move "last seen", at most every
// SIGNIN_TOUCH_MS. The table is public.snl_signins (migration 0011). Rows not seen for SIGNIN_KEEP_DAYS are removed
// whenever a new sign-in is recorded, the way the watchlist clears its own old rows on every check.
//
// Settings (supabase secrets set ...):
//   SNL_NOTIFY_EMAILS   who gets the emails, comma-separated. Without it, the addresses in SNL_ADMIN_EMAILS.
//   SNL_SIGNIN_NOTICES  "off" stops the emails. Sign-ins are still recorded.
//   RESEND_API_KEY, WATCH_FROM  as for the watchlist (mail.ts). Without RESEND_API_KEY no email is sent.
// Sign-ins by addresses in SNL_ADMIN_EMAILS (Corp Dev) are recorded but never emailed.

import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { adminEmails, cleanEmail, type Role } from "./access.ts";
import { type Env, serviceKey } from "./http.ts";
import { type Mail, sendEmail } from "./mail.ts";

export const SIGNIN_KEEP_DAYS = 90;           // rows are kept this long after the session was last seen
export const SIGNIN_TOUCH_MS = 5 * 60_000;    // "last seen" moves at most this often
export const SIGNIN_MAIL_MS = 3000;           // the email call gives up after this
export const SIGNIN_WAIT_MS = 3000;           // without background work, a sign-in waits at most this long for the record
export const MAX_NOTIFY = 10;                 // recipients of one notice
const DAY = 86_400_000;

/** What happened about the email for a session: pending (being sent), sent, failed (Resend refused or didn't
    answer), not_needed (an admin's own sign-in), off (SNL_SIGNIN_NOTICES=off), not_set_up (no key or no one to send to). */
export type Notice = "pending" | "sent" | "failed" | "not_needed" | "off" | "not_set_up";
export const NOTICES: Notice[] = ["pending", "sent", "failed", "not_needed", "off", "not_set_up"];

/** One row of public.snl_signins. */
export type SigninRow = { session_key: string; email: string; role: Role; first_seen_at: string; last_seen_at: string; notice: Notice };

/** The record of sign-ins, behind one small interface so tests can use a stand-in. */
export interface SigninLog {
  /** Adds the row unless one with its session_key is there already. true only when this call added it. */
  add(row: SigninRow): Promise<boolean>;
  /** Moves last_seen_at to `at` for this session, only if it is older than `before`. */
  touch(sessionKey: string, at: string, before: string): Promise<void>;
  setNotice(sessionKey: string, notice: Notice): Promise<void>;
  /** Removes sessions last seen before `before`. */
  dropOld(before: string): Promise<void>;
  /** true when the table is there; false before migration 0011 has been run. Throws for any other failure. */
  present(): Promise<boolean>;
}

/** The session key: SHA-256 (hex) of the email address and the token's issue time (its expiry when it has no iat). */
export async function sessionKey(email: string, iat: number | null, exp: number): Promise<string> {
  const text = `snl-signin\n${email.trim().toLowerCase()}\n${iat !== null ? `iat:${iat}` : `exp:${exp}`}`;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Who gets the notices: SNL_NOTIFY_EMAILS when it holds an address, otherwise SNL_ADMIN_EMAILS. Cleaned, no repeats. */
export function noticeRecipients(env: Env): string[] {
  const read = (v: string | undefined) => [...new Set(String(v ?? "").split(",").map((s) => cleanEmail(s)).filter((s): s is string => !!s))];
  const notify = read(env("SNL_NOTIFY_EMAILS"));
  return (notify.length ? notify : [...adminEmails(env("SNL_ADMIN_EMAILS"))].map((s) => cleanEmail(s)).filter((s): s is string => !!s)).slice(0, MAX_NOTIFY);
}

export type NoticeSetting = { on: boolean; why: "off" | "no_key" | "no_recipients" | null; recipients: string[]; fromSet: boolean };

/** Whether notices go out, and if not, the first thing missing. */
export function noticeSetting(env: Env): NoticeSetting {
  const recipients = noticeRecipients(env), fromSet = !!(env("WATCH_FROM") ?? "").trim();
  const why = String(env("SNL_SIGNIN_NOTICES") ?? "").trim().toLowerCase() === "off" ? "off" : !(env("RESEND_API_KEY") ?? "").trim() ? "no_key" : !recipients.length ? "no_recipients" : null;
  return { on: why === null, why, recipients, fromSet };
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

/** "13 Nov at 12:00 UTC" (the year added when it isn't this year). */
export function whenUtc(ms: number, nowMs = ms): string {
  const d = new Date(ms), sameYear = d.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC", ...(sameYear ? {} : { year: "numeric" }) });
  return `${day} at ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** The notice: who, when (UTC) and that it was through Cloudflare sign-on. Nothing about what they did, no token,
    no IP address. Plain text and simple HTML with every value escaped. */
export function noticeEmail(who: { email: string; role: Role }, atMs: number): Mail {
  const email = oneLine(who.email), when = whenUtc(atMs), role = who.role === "corpdev" ? "Corp Dev" : "a reader";
  const lines = [
    `${email} signed in to SNL lookup through Cloudflare sign-on on ${when}, as ${role}.`,
    "If you expected this, there is nothing to do. If not, take their address off the Cloudflare Access policy and revoke their sign-in in Zero Trust (README, Cloudflare sign-on, Removing a person).",
    "You get one email for each new sign-in by someone not on the site's admin list. Corp Dev can see recent sign-ins on the site, in the account menu. To stop these emails, set SNL_SIGNIN_NOTICES=off on Supabase.",
  ];
  const html = `<p><b>${escHtml(email)}</b> signed in to SNL lookup through Cloudflare sign-on on ${escHtml(when)}, as ${escHtml(role)}.</p>`
    + lines.slice(1).map((l) => `<p>${escHtml(l)}</p>`).join("");
  return { subject: `SNL lookup: ${email} signed in`, text: lines.join("\n\n"), html };
}

/** A missing snl_signins table (migration 0011 not run yet). */
export const missingSignins = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return /snl_signins/.test(m) && /does not exist|could not find|schema cache|42P01|PGRST205/i.test(m);
};
/** A short reason for the log: never the address, the token or the error's own text. */
const reason = (e: unknown) => (missingSignins(e) ? "migration 0011 not run" : String((e as Error)?.name || "error").replace(/[^\w -]/g, "").slice(0, 40));
const say = (what: string, e: unknown) => console.error(`snl-signin: ${what} (${reason(e)})`);

export type RecordCtx = { log: SigninLog | null; env: Env; fetch: typeof fetch; now: () => number; seen: Map<string, number> };
export type Recorded = "none" | "recent" | "touched" | "new" | "failed";

/** Records one sign-in call and, for a new session of someone who isn't an admin, sends the notice. Never throws.
    seen: session keys this running function handled lately, so a busy page doesn't reach the database every call. */
export async function recordSignin(ctx: RecordCtx, who: { email: string; role: Role; iat: number | null; exp: number }): Promise<Recorded> {
  try {
    if (!ctx.log) return "none";
    const now = ctx.now(), at = new Date(now).toISOString();
    const key = await sessionKey(who.email, who.iat, who.exp);
    const last = ctx.seen.get(key);
    if (last !== undefined && now - last < SIGNIN_TOUCH_MS) return "recent";
    if (ctx.seen.size >= 1000) ctx.seen.clear();
    ctx.seen.set(key, now);

    const setting = noticeSetting(ctx.env);
    const notice: Notice = who.role === "corpdev" ? "not_needed" : setting.on ? "pending" : setting.why === "off" ? "off" : "not_set_up";
    let added: boolean;
    try {
      added = await ctx.log.add({ session_key: key, email: who.email.trim().toLowerCase(), role: who.role, first_seen_at: at, last_seen_at: at, notice });
    } catch (e) { say("sign-in not recorded", e); return "failed"; }
    if (!added) {
      try { await ctx.log.touch(key, at, new Date(now - SIGNIN_TOUCH_MS).toISOString()); } catch (e) { say("last seen not updated", e); }
      return "touched";
    }
    try { await ctx.log.dropOld(new Date(now - SIGNIN_KEEP_DAYS * DAY).toISOString()); } catch (e) { say("old sign-ins not cleared", e); }
    if (notice !== "pending") return "new";
    const sent = await sendEmail(ctx.fetch, ctx.env, setting.recipients, noticeEmail(who, now), { timeoutMs: SIGNIN_MAIL_MS });
    if ("error" in sent) console.error("snl-signin: the sign-in notice wasn't sent (Resend refused it or didn't answer)");
    try { await ctx.log.setNotice(key, "sent" in sent ? "sent" : "failed"); } catch (e) { say("notice not marked", e); }
    return "new";
  } catch (e) { say("sign-in not recorded", e); return "failed"; }
}

/** Waits for work, but no longer than ms. Never throws. */
export async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms); })]); }
  finally { clearTimeout(timer); }
}

export type SigninStatus = {
  recorded: boolean | null;   // null: couldn't tell
  notices: { on: boolean; why: NoticeSetting["why"]; recipients: number; fromSet: boolean };
  keepDays: number;
};

/** For Corp Dev: whether sign-ins are being recorded and whether notices go out. Counts only: never an address or key. */
export async function signinStatus(log: SigninLog | null, env: Env): Promise<SigninStatus> {
  let recorded: boolean | null = false;
  if (log) { try { recorded = await log.present(); } catch { recorded = null; } }
  const s = noticeSetting(env);
  return { recorded, notices: { on: s.on, why: s.why, recipients: s.recipients.length, fromSet: s.fromSet }, keepDays: SIGNIN_KEEP_DAYS };
}

// ---------- the real record, on Supabase with the service key ----------

/** The record on a real project. null outside Supabase. */
export function supabaseSigninLog(env: Env, fetchFn?: typeof fetch): SigninLog | null {
  const url = env("SUPABASE_URL"), key = serviceKey(env);
  if (!url || !key) return null;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, ...(fetchFn ? { global: { fetch: fetchFn } } : {}) });
  const table = () => admin.from("snl_signins");
  const fail = (what: string, err: { message?: string; code?: string } | null): never => { const e = new Error(`${err?.code ?? ""} ${err?.message ?? "no answer"}`.trim()); e.name = what; throw e; };
  return {
    async add(row) {
      const { data, error } = await table().upsert(row, { onConflict: "session_key", ignoreDuplicates: true }).select("session_key");
      if (error) fail("add", error);
      return Array.isArray(data) && data.length > 0;
    },
    async touch(k, at, before) {
      const { error } = await table().update({ last_seen_at: at }).eq("session_key", k).lt("last_seen_at", before);
      if (error) fail("touch", error);
    },
    async setNotice(k, notice) {
      const { error } = await table().update({ notice }).eq("session_key", k);
      if (error) fail("notice", error);
    },
    async dropOld(before) {
      const { error } = await table().delete().lt("last_seen_at", before);
      if (error) fail("trim", error);
    },
    async present() {
      const { error } = await table().select("session_key").limit(1);
      if (!error) return true;
      if (error.code === "PGRST205" || error.code === "42P01" || missingSignins(error.message ?? "")) return false;
      return fail("present", error);
    },
  };
}
