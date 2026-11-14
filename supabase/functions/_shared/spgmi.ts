// S&P Global Market Intelligence's Physical Documents API: sign-in, the 1-a-second throttle, and plain-English
// errors. Used only for SNL Insurance Product Filings (docType INSPRODFILINGS_DOCUMENTS_API).
//
// Confirmed by S&P's public OpenAPI specification (the api-docs document under the base URL below):
// the base URL, the docType parameter, the error body {status, timestamp, requestId, error, message}, the error
// codes, and the limits (1 request a second; trial 500 an hour and 12,000 a day; production 2,000 and 48,000).
// From an S&P sample notebook, not the spec: the token URL and its form body (see signIn).
// Not documented anywhere: how long a token lasts. So the token is kept in memory and replaced once after a 401.

import type { Db, Usage } from "./db.ts";
import type { Env } from "./http.ts";

export const SPGMI_HOST = "https://api-ciq.marketintelligence.spglobal.com";
export const DOCS_BASE = `${SPGMI_HOST}/gds/documents`;
export const TOKEN_URL = `${SPGMI_HOST}/gdsapi/rest/authenticate/api/v1/token`;
export const DOC_TYPE = "INSPRODFILINGS_DOCUMENTS_API";

export const PLAN_LIMITS = { trial: { hour: 500, day: 12_000 }, production: { hour: 2_000, day: 48_000 } } as const;
export type Plan = keyof typeof PLAN_LIMITS;

/** SPGMI_ACCOUNT says which S&P limits apply: "trial" (the default, and the lower limits) or "production". */
export function planLimits(env: Env): { plan: Plan } & Usage {
  const plan: Plan = (env("SPGMI_ACCOUNT") || "").trim().toLowerCase() === "production" ? "production" : "trial";
  return { plan, ...PLAN_LIMITS[plan] };
}

export type SpgmiCode = "not_configured" | "signin" | "entitlement" | "bad_request" | "not_found" | "method" | "rate_limited" | "limit" | "server" | "network";

export class SpgmiError extends Error {
  constructor(public code: SpgmiCode, message: string, public status = 0, public requestId: string | null = null) { super(message); }
}

export const NOT_CONFIGURED = "S&P API access isn't set up yet. It needs API credentials from S&P. When they arrive, the owner sets SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase (README, step 5). Saved results still open.";

/** S&P refused the sign-in. The status shown is the one S&P sent. */
const signInRefused = (status: number, requestId: string | null) =>
  new SpgmiError("signin", `S&P didn't accept the API sign-in (${status}). Check SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase. A Capital IQ Pro website login doesn't work here.${requestId ? ` S&P reference: ${requestId}.` : ""}`, status, requestId);

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
export type SpgmiIo = { fetch: typeof fetch; gate: Gate; sleep: (ms: number) => Promise<void>; backoffMs?: number };

// Kept while the function instance stays warm. Keyed by username, so a changed secret gets a new token.
const tokens = new Map<string, string>();
/** Tests start from a clean slate. */
export function forgetTokens(): void { tokens.clear(); }

export class Spgmi {
  constructor(private creds: SpgmiCreds, private io: SpgmiIo) {}

  static configured(c: SpgmiCreds): boolean { return !!(c.username && c.password); }
  static creds(env: Env): SpgmiCreds { return { username: env("SPGMI_API_USERNAME"), password: env("SPGMI_API_PASSWORD") }; }

  /** POST the username and password as a form; the answer's access_token is the bearer token. */
  private async signIn(): Promise<string> {
    if (!Spgmi.configured(this.creds)) throw new SpgmiError("not_configured", NOT_CONFIGURED);
    let res: Response;
    for (let backedOff = false; ; backedOff = true) {
      await this.io.gate();
      try {
        res = await this.io.fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
          body: new URLSearchParams({ username: this.creds.username!, password: this.creds.password! }).toString(),
        });
      } catch { throw new SpgmiError("network", "Couldn't reach S&P to sign in. Try again in a few minutes."); }
      // Too many requests: back off and try once more, like any other S&P call.
      if (res.status !== 429 || backedOff) break;
      await this.backOff(res);
    }
    if (!res.ok) {
      const e = await errorFrom(res);
      // UNCONFIRMED: how S&P answers a wrong username or password. A 400 or a 401 from the sign-in address is
      // read as "sign-in refused"; anything else keeps its own message.
      throw res.status === 400 || res.status === 401 ? signInRefused(res.status, e.requestId) : e;
    }
    let token: unknown;
    try { token = (await res.json())?.access_token; } catch { token = null; }
    if (typeof token !== "string" || !token) throw new SpgmiError("signin", "S&P's sign-in answered without a token. Try again; if it repeats, ask S&P whether the API account is active.");
    tokens.set(this.creds.username!, token);
    return token;
  }

  /** Waits after a 429: as long as S&P asks (Retry-After, up to a minute), otherwise five seconds. */
  private async backOff(res: Response): Promise<void> {
    const after = Number(res.headers.get("retry-after"));
    await res.body?.cancel();
    await this.io.sleep(after > 0 && after <= 60 ? after * 1000 : (this.io.backoffMs ?? 5000));
  }

  /** One call to the documents API. Signs in when needed, takes a throttle slot for every attempt, gets a new
      token once after a 401, and backs off and retries once after a 429. Returns S&P's successful response. */
  async call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
    if (!Spgmi.configured(this.creds)) throw new SpgmiError("not_configured", NOT_CONFIGURED);
    const url = `${DOCS_BASE}${path}?${new URLSearchParams({ docType: DOC_TYPE, ...(opts.query ?? {}) })}`;
    let reauthed = false, backedOff = false;
    for (;;) {
      const token = tokens.get(this.creds.username!) ?? await this.signIn();
      await this.io.gate();
      let res: Response;
      try {
        res = await this.io.fetch(url, {
          method,
          headers: { "Authorization": `Bearer ${token}`, "Accept": "*/*", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
      } catch { throw new SpgmiError("network", "Couldn't reach S&P. Try again in a few minutes."); }
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        tokens.delete(this.creds.username!);
        await res.body?.cancel();
        continue;
      }
      if (res.status === 429 && !backedOff) {
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
