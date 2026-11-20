// Sending one email through Resend, shared by the watchlist (watch.ts) and sign-in notices (signins.ts).
// Settings (supabase secrets set ...): RESEND_API_KEY, and WATCH_FROM for the sender ("SNL lookup <watch@yourco.com>").
// Without WATCH_FROM, Resend's test sender is used, which delivers only to the Resend account's own address.

import type { Env } from "./http.ts";

export const RESEND_URL = "https://api.resend.com/emails";

export type Mail = { subject: string; text: string; html?: string };

/** Sends the email through Resend. Returns how many it went to, or the reason it wasn't sent. Never throws.
    timeoutMs: give up waiting for Resend after this long (the watchlist sets none). */
export async function sendEmail(fetchFn: typeof fetch, env: Env, to: string[], mail: Mail, opts: { timeoutMs?: number } = {}): Promise<{ sent: number } | { error: string }> {
  const from = (env("WATCH_FROM") || "").trim() || "SNL lookup <onboarding@resend.dev>";
  const body = mail.html === undefined ? { from, to, subject: mail.subject, text: mail.text } : { from, to, subject: mail.subject, text: mail.text, html: mail.html };
  const init: RequestInit = { method: "POST", headers: { "Authorization": `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(RESEND_URL, init);
  } catch { return { error: "The email couldn't be sent: Resend didn't answer." }; }
  try { await res.body?.cancel(); } catch { /* already read or closed */ }
  return res.ok ? { sent: to.length } : { error: `The email couldn't be sent: Resend answered ${res.status}. Check RESEND_API_KEY and WATCH_FROM on Supabase.` };
}
