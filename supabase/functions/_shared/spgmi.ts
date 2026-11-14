// S&P Global Market Intelligence's Physical Documents API: sign-in, the 1-a-second throttle, and plain-English
// errors. Used only for SNL Insurance Product Filings (docType INSPRODFILINGS_DOCUMENTS_API).
//
// Confirmed by S&P's public OpenAPI specification (the api-docs document under the base URL below):
// the base URL, the docType parameter, the error body {status, timestamp, requestId, error, message}, the error
// codes, and the limits (1 request a second; trial 500 an hour and 12,000 a day; production 2,000 and 48,000).
// Confirmed by S&P's Authenticate specification (gdsapi/swagger/v3/authentication-api-docs.yaml, read 14 Nov 2026):
// POST {base}/api/v1/token with username and password as application/x-www-form-urlencoded; the answer carries
// access_token, refresh_token, token_type, scope and expires_in_seconds (a string: seconds until the token
// expires); POST {base}/api/v1/tokenRefresh with refreshToken (form encoded) gives a new token, and the refresh
// token "is valid for up to 7 days and expires following 24 hours of inactivity"; the sign-in answers 401 "User
// unauthorized", 405, 423 "Account Locked", 429 "Too many requests" and 500; the refresh answers 401, 405 and 500.
// The error body there is {error, message}.

import type { Db, Usage } from "./db.ts";
import type { Env } from "./http.ts";

export const SPGMI_HOST = "https://api-ciq.marketintelligence.spglobal.com";
export const DOCS_BASE = `${SPGMI_HOST}/gds/documents`;
export const TOKEN_URL = `${SPGMI_HOST}/gdsapi/rest/authenticate/api/v1/token`;
export const REFRESH_URL = `${SPGMI_HOST}/gdsapi/rest/authenticate/api/v1/tokenRefresh`;
export const DOC_TYPE = "INSPRODFILINGS_DOCUMENTS_API";

export const PLAN_LIMITS = { trial: { hour: 500, day: 12_000 }, production: { hour: 2_000, day: 48_000 } } as const;
export type Plan = keyof typeof PLAN_LIMITS;

/** SPGMI_ACCOUNT says which S&P limits apply: "trial" (the default, and the lower limits) or "production". */
export function planLimits(env: Env): { plan: Plan } & Usage {
  const plan: Plan = (env("SPGMI_ACCOUNT") || "").trim().toLowerCase() === "production" ? "production" : "trial";
  return { plan, ...PLAN_LIMITS[plan] };
}

export type SpgmiCode = "not_configured" | "signin" | "locked" | "entitlement" | "bad_request" | "not_found" | "method" | "rate_limited" | "limit" | "server" | "network";

export class SpgmiError extends Error {
  constructor(public code: SpgmiCode, message: string, public status = 0, public requestId: string | null = null) { super(message); }
}

export const NOT_CONFIGURED = "S&P API access isn't set up yet. It needs API credentials from S&P. When they arrive, the owner sets SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase (README, step 5). Saved results still open.";

/** S&P refused the sign-in. The status shown is the one S&P sent. */
const signInRefused = (status: number, requestId: string | null) =>
  new SpgmiError("signin", `S&P didn't accept the API sign-in (${status}). Check SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase. A Capital IQ Pro website login doesn't work here.${requestId ? ` S&P reference: ${requestId}.` : ""}`, status, requestId);

/** "14:30 UTC", for when the app will next try to sign in. */
const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

/** S&P locked the API account (423). `until` is when the app will next try, if it has stopped. */
export function accountLocked(requestId: string | null, until?: number): SpgmiError {
  const ref = requestId ? ` S&P reference: ${requestId}.` : "";
  const wait = until ? ` The app has stopped trying and won't sign in again before ${utcTime(until)}, so it can't make the lock worse.` : " The app has stopped trying.";
  return new SpgmiError("locked", `S&P has locked the API account (423 Account Locked). This usually happens after repeated failed sign-ins. Ask S&P to unlock it.${wait}${ref}`, 423, requestId);
}

/** The plain message for each S&P error code, with S&P's reference so Corp Dev can quote it to S&P. */
export function explain(status: number, detail: string, requestId: string | null): SpgmiError {
  const ref = requestId ? ` S&P reference: ${requestId}.` : "";
  const words = detail.replace(/\s+/g, " ").trim().slice(0, 300).replace(/\s+([.!?])$/, "$1");
  const said = words ? ` S&P said: ${words}${/[.!?]$/.test(words) ? "" : "."}` : "";
  switch (status) {
    case 400: return new SpgmiError("bad_request", `S&P rejected the request (400).${said}${ref}`, status, requestId);
    case 401: return signInRefused(401, requestId);
    case 403: return new SpgmiError("entitlement", `This S&P account isn't entitled to SNL Insurance Product Filings through the API (403, entitlement needed). Ask S&P to switch it on.${ref}`, status, requestId);
    case 404: return new SpgmiError("not_found", `S&P couldn't find that (404).${said}${ref}`, status, requestId);
    case 405: return new SpgmiError("method", `S&P refused the kind of request the app sent (405). This is a fault in the app, not in your search.${ref}`, status, requestId);
    case 423: return accountLocked(requestId);
    case 429: return new SpgmiError("rate_limited", `S&P says too many requests were sent (429). Wait a minute and try again.${ref}`, status, requestId);
    default: return new SpgmiError("server", `S&P's service failed (${status || "no answer"}). Try again in a few minutes.${ref}`, status, requestId);
  }
}

async function errorFrom(res: Response): Promise<SpgmiError> {
  let requestId: string | null = null, detail = "";
  try {
    const b = await res.json();
    if (b && typeof b === "object") { requestId = typeof b.requestId === "string" ? b.requestId : null; detail = typeof b.message === "string" ? b.message : ""; }
  } catch { /* not JSON: the status alone decides the message */ }
  return explain(res.status, detail, requestId);
}

/** Waits for the next free S&P slot. Throws when the hourly or daily limit is used up. */
export type Gate = () => Promise<void>;

/** The gate every S&P call passes through. The slot and the count live in Postgres (snl_take_slot), so the
    1-a-second spacing holds across function calls that run at the same time. */
export function makeGate(db: Db, limits: Usage, sleep: (ms: number) => Promise<void>): Gate {
  return async () => {
    const slot = await db.takeSlot(limits);
    if (!slot.allowed) {
      const which = slot.day >= limits.day
        ? `today's limit of ${limits.day.toLocaleString("en-US")} S&P requests is used up. It resets at midnight UTC`
        : `this hour's limit of ${limits.hour.toLocaleString("en-US")} S&P requests is used up. It resets at the top of the hour`;
      throw new SpgmiError("limit", `The app stopped before asking S&P: ${which}.`);
    }
    if (slot.waitMs > 0) await sleep(slot.waitMs);
  };
}

export type SpgmiCreds = { username?: string; password?: string };
/** now: the clock (Date.now by default). once: one attempt per request, with no new token after a 401 and no second
    try after a 429; the connection check uses it so it costs a known number of requests. */
export type SpgmiIo = { fetch: typeof fetch; gate: Gate; sleep: (ms: number) => Promise<void>; backoffMs?: number; now?: () => number; once?: boolean };

/** A token is replaced this long before S&P says it expires (or halfway through, for a very short-lived token). */
export const RENEW_BEFORE_MS = 60_000;
/** S&P: the refresh token "is valid for up to 7 days and expires following 24 hours of inactivity". The app stops
    using it an hour short of either, so it never sends one S&P is about to refuse. */
export const REFRESH_LIFE_MS = 7 * 24 * 3600_000, REFRESH_IDLE_MS = 24 * 3600_000, REFRESH_MARGIN_MS = 3600_000;
/** After S&P locks the account (423), no sign-in is sent for this long. */
export const LOCK_COOL_OFF_MS = 30 * 60_000;
/** After S&P refuses a username and password, the same pair isn't sent again for this long. */
export const REFUSED_COOL_OFF_MS = 5 * 60_000;

type Session = { access: string; renewAt: number | null; refresh: string | null; refreshFrom: number; refreshUsed: number };
// Kept while the function instance stays warm. Keyed by username, so a changed secret gets a new token.
const tokens = new Map<string, Session>();
// The account is locked: no sign-in before `until`, whatever the password.
const locks = new Map<string, { until: number; requestId: string | null }>();
// This username and password were refused: they aren't sent again before `until` (a changed password is tried at once).
const refusals = new Map<string, { password: string; until: number; status: number; requestId: string | null }>();
/** Tests start from a clean slate: tokens, refresh tokens, a remembered lock and a remembered refusal. */
export function forgetTokens(): void { tokens.clear(); locks.clear(); refusals.clear(); }

/** S&P's expires_in_seconds is a string in the specification; a number is read too. Null when it can't be read. */
function lifetimeMs(v: unknown): number | null {
  const s = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

export class Spgmi {
  constructor(private creds: SpgmiCreds, private io: SpgmiIo) {}

  static configured(c: SpgmiCreds): boolean { return !!(c.username && c.password); }
  static creds(env: Env): SpgmiCreds { return { username: env("SPGMI_API_USERNAME"), password: env("SPGMI_API_PASSWORD") }; }

  private now(): number { return (this.io.now ?? Date.now)(); }

  /** Refuses, without calling S&P, while the account is known to be locked or this password was just refused. */
  private guard(): void {
    const user = this.creds.username!, now = this.now();
    const lock = locks.get(user);
    if (lock && now < lock.until) throw accountLocked(lock.requestId, lock.until);
    if (lock) locks.delete(user);
    const no = refusals.get(user);
    if (no && no.password === this.creds.password && now < no.until) {
      throw new SpgmiError("signin", `S&P refused this API sign-in a moment ago (${no.status}), so the app hasn't sent the same username and password again. Check SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase. The app tries again after ${utcTime(no.until)}, or at once when the password is changed.${no.requestId ? ` S&P reference: ${no.requestId}.` : ""}`, no.status, no.requestId);
    }
    if (no) refusals.delete(user);
  }

  /** A bearer token: the one held while it is still good, otherwise from the refresh token, otherwise a sign-in. */
  private async token(): Promise<string> {
    const s = tokens.get(this.creds.username!), now = this.now();
    if (s?.access && (s.renewAt === null || now < s.renewAt)) return s.access;
    if (s?.refresh && now < s.refreshFrom + REFRESH_LIFE_MS - REFRESH_MARGIN_MS && now < s.refreshUsed + REFRESH_IDLE_MS - REFRESH_MARGIN_MS) {
      const t = await this.refresh(s);
      if (t) return t;
    }
    return await this.signIn();
  }

  /** Keeps a token S&P sent. A refresh answer without a new refresh token keeps the one already held. */
  private keep(body: Record<string, unknown>, sentAt: number, held?: Session): string | null {
    const access = body.access_token;
    if (typeof access !== "string" || !access) return null;
    const life = lifetimeMs(body.expires_in_seconds);
    const fresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null;
    tokens.set(this.creds.username!, {
      access, renewAt: life === null ? null : sentAt + life - Math.min(RENEW_BEFORE_MS, life / 2),
      refresh: fresh ?? held?.refresh ?? null, refreshFrom: fresh ? sentAt : held?.refreshFrom ?? sentAt, refreshUsed: sentAt,
    });
    return access;
  }

  /** POST the refresh token as a form. Null when S&P won't take it (the caller then signs in in full). */
  private async refresh(s: Session): Promise<string | null> {
    this.guard();
    await this.io.gate();
    const sentAt = this.now();
    let res: Response;
    try {
      res = await this.io.fetch(REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({ refreshToken: s.refresh! }).toString(),
      });
    } catch { throw new SpgmiError("network", "Couldn't reach S&P to sign in. Try again in a few minutes."); }
    if (!res.ok) s.refresh = null;   // refused: not sent again
    if (res.status === 423) {
      // Not listed for the refresh in S&P's specification, but read the same way as at sign-in if it comes.
      const e = await errorFrom(res);
      const until = this.now() + LOCK_COOL_OFF_MS;
      locks.set(this.creds.username!, { until, requestId: e.requestId });
      throw accountLocked(e.requestId, until);
    }
    if (!res.ok) { await res.body?.cancel(); return null; }
    let body: Record<string, unknown> | null = null;
    try { body = await res.json(); } catch { /* unreadable: sign in in full */ }
    const t = body && typeof body === "object" ? this.keep(body, sentAt, s) : null;
    if (!t) s.refresh = null;
    return t;
  }

  /** Signs in in full now, even while a token is held: the connection check uses it to test the credentials.
      A remembered lock or refusal still stops it before it reaches S&P. */
  async signInNow(): Promise<void> {
    if (!Spgmi.configured(this.creds)) throw new SpgmiError("not_configured", NOT_CONFIGURED);
    await this.signIn();
  }

  /** POST the username and password as a form; the answer's access_token is the bearer token. */
  private async signIn(): Promise<string> {
    if (!Spgmi.configured(this.creds)) throw new SpgmiError("not_configured", NOT_CONFIGURED);
    this.guard();
    let res: Response, sentAt = 0;
    for (let backedOff = false; ; backedOff = true) {
      await this.io.gate();
      try {
        res = await this.io.fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
          body: new URLSearchParams({ username: this.creds.username!, password: this.creds.password! }).toString(),
        });
      } catch { throw new SpgmiError("network", "Couldn't reach S&P to sign in. Try again in a few minutes."); }
      sentAt = this.now();
      // Too many requests: back off and try once more, like any other S&P call.
      if (res.status !== 429 || backedOff || this.io.once) break;
      await this.backOff(res);
    }
    if (!res.ok) {
      const e = await errorFrom(res);
      const user = this.creds.username!;
      // 423 Account Locked (S&P's specification): stop signing in for a while, so the app can't make it worse.
      if (res.status === 423) {
        const until = this.now() + LOCK_COOL_OFF_MS;
        locks.set(user, { until, requestId: e.requestId });
        throw accountLocked(e.requestId, until);
      }
      // 401 "User unauthorized" is S&P's documented answer to a wrong username or password. UNCONFIRMED: a 400
      // isn't in the specification for the sign-in; it is read the same way. Either way the same pair isn't
      // sent again for a while, so a wrong password can't be retried into a lock.
      if (res.status === 400 || res.status === 401) {
        refusals.set(user, { password: this.creds.password!, until: this.now() + REFUSED_COOL_OFF_MS, status: res.status, requestId: e.requestId });
        throw signInRefused(res.status, e.requestId);
      }
      throw e;
    }
    let body: unknown;
    try { body = await res.json(); } catch { body = null; }
    const token = body && typeof body === "object" ? this.keep(body as Record<string, unknown>, sentAt) : null;
    if (!token) throw new SpgmiError("signin", "S&P's sign-in answered without a token. Try again; if it repeats, ask S&P whether the API account is active.");
    return token;
  }

  /** Waits after a 429: as long as S&P asks (Retry-After, up to a minute), otherwise five seconds. */
  private async backOff(res: Response): Promise<void> {
    const after = Number(res.headers.get("retry-after"));
    await res.body?.cancel();
    await this.io.sleep(after > 0 && after <= 60 ? after * 1000 : (this.io.backoffMs ?? 5000));
  }

  /** One call to the documents API. Signs in (or refreshes the token) when needed, takes a throttle slot for every
      attempt, gets a new token once after a 401, and backs off and retries once after a 429. Returns S&P's
      successful response. */
  async call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
    if (!Spgmi.configured(this.creds)) throw new SpgmiError("not_configured", NOT_CONFIGURED);
    const url = `${DOCS_BASE}${path}?${new URLSearchParams({ docType: DOC_TYPE, ...(opts.query ?? {}) })}`;
    let reauthed = false, backedOff = false;
    for (;;) {
      const token = await this.token();
      await this.io.gate();
      let res: Response;
      try {
        res = await this.io.fetch(url, {
          method,
          headers: { "Authorization": `Bearer ${token}`, "Accept": "*/*", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
      } catch { throw new SpgmiError("network", "Couldn't reach S&P. Try again in a few minutes."); }
      if (res.status === 401 && !reauthed && !this.io.once) {
        // The safety net: S&P turned the token down before its stated expiry. Drop it (a refresh token, if held,
        // is tried next) and try once more.
        reauthed = true;
        const s = tokens.get(this.creds.username!);
        if (s && s.access === token) s.access = "";
        await res.body?.cancel();
        continue;
      }
      if (res.status === 429 && !backedOff && !this.io.once) {
        backedOff = true;
        await this.backOff(res);
        continue;
      }
      if (!res.ok) throw await errorFrom(res);
      return res;
    }
  }

  async json(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<Record<string, unknown>> {
    const res = await this.call(method, path, opts);
    try { const b = await res.json(); return b && typeof b === "object" ? b : {}; }
    catch { throw new SpgmiError("server", "S&P answered with something the app couldn't read. Try again in a few minutes."); }
  }
}
