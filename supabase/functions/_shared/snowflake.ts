// Snowflake's SQL API, for SNL Insurance Regulatory Data that S&P shares on Snowflake.
//
// Checked against Snowflake's documentation (docs.snowflake.com, developer-guide/sql-api):
//   POST https://<account>.snowflakecomputing.com/api/v2/statements, body {statement, timeout, database, schema,
//   warehouse, role, bindings, parameters}; 200 = results, 202 = still running (poll statementStatusUrl),
//   422 = the SQL failed; results are arrays of strings described by resultSetMetaData.rowType; more rows come
//   from ?partition=N. Sign-in is a key-pair JWT (RS256; iss = ACCOUNT.USER.SHA256:<fingerprint>, sub =
//   ACCOUNT.USER, at most an hour) or a programmatic access token. A username and password don't work here.
//
// Secrets: SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_WAREHOUSE and either SNOWFLAKE_PRIVATE_KEY (unencrypted
// PKCS#8 PEM) or SNOWFLAKE_PAT. Optional: SNOWFLAKE_ROLE, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA (S&P's defaults
// below), SNOWFLAKE_HOST (only if the address isn't <account>.snowflakecomputing.com).

import type { Env } from "./http.ts";

export type SnowflakeCreds = {
  account?: string; user?: string; privateKey?: string; pat?: string; warehouse?: string;
  role: string; database: string; schema: string; host?: string;
};

export function snowflakeCreds(env: Env): SnowflakeCreds {
  return {
    account: env("SNOWFLAKE_ACCOUNT")?.trim(), user: env("SNOWFLAKE_USER")?.trim(),
    // Secrets set from the command line can carry literal "\n".
    privateKey: env("SNOWFLAKE_PRIVATE_KEY")?.replace(/\\n/g, "\n"), pat: env("SNOWFLAKE_PAT")?.trim(),
    warehouse: env("SNOWFLAKE_WAREHOUSE")?.trim(),
    role: env("SNOWFLAKE_ROLE")?.trim() || "XF_SNOWFLAKE_READER_ROLE",        // from S&P's Snowflake guide
    database: env("SNOWFLAKE_DATABASE")?.trim() || "MI_XPRESSCLOUD",           // from S&P's Snowflake guide
    schema: env("SNOWFLAKE_SCHEMA")?.trim() || "XPRESSFEED",                   // from S&P's Snowflake guide
    host: env("SNOWFLAKE_HOST")?.trim(),
  };
}

export function credsReady(c: SnowflakeCreds): boolean {
  return !!(c.account && c.warehouse && (c.pat || (c.user && c.privateKey)));
}
export const snowflakeConfigured = (env: Env) => credsReady(snowflakeCreds(env));

export const SNOWFLAKE_NOT_CONFIGURED = "Statutory data isn't set up yet. It needs a Snowflake reader account from S&P. When that exists, the owner sets the SNOWFLAKE secrets on Supabase (README, step 7) and this view goes live.";

export class SnowflakeError extends Error {
  /** gone: a statement handle Snowflake no longer knows, or a statement that was cancelled (submit, check). */
  constructor(public code: "not_configured" | "not_mapped" | "signin" | "sql" | "busy" | "timeout" | "server" | "network" | "gone", message: string, public status = 0) { super(message); }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  if (/ENCRYPTED/.test(pem)) throw new SnowflakeError("signin", "SNOWFLAKE_PRIVATE_KEY is an encrypted key. Use the unencrypted PKCS#8 key (the file that starts with BEGIN PRIVATE KEY).");
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  try { const raw = atob(body), out = new Uint8Array(new ArrayBuffer(raw.length)); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; }
  catch { throw new SnowflakeError("signin", "SNOWFLAKE_PRIVATE_KEY isn't a readable PEM key."); }
}

/** The account part of the JWT: upper case, and for an account locator with a region ("xy12345.us-east-1") only
    the locator. UNCONFIRMED: whether an underscore in an account name must be written "_" or "-" here. */
export function jwtAccount(account: string): string {
  return account.split(".")[0].toUpperCase();
}

/** A key-pair JWT for the SQL API. The fingerprint is the SHA-256 of the public key (DER, SubjectPublicKeyInfo),
    base64, worked out from the private key so there is only one secret to set. A new one is made for every
    request: Snowflake can reject a token that arrives more than a minute after it was issued. */
export async function keyPairJwt(c: SnowflakeCreds, nowMs: number): Promise<string> {
  let key: CryptoKey, spki: ArrayBuffer;
  try {
    const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const extractable = await crypto.subtle.importKey("pkcs8", pemToDer(c.privateKey!), alg, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", extractable);
    const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, alg, true, ["verify"]);
    spki = await crypto.subtle.exportKey("spki", pub);
    key = extractable;
  } catch (e) {
    if (e instanceof SnowflakeError) throw e;
    throw new SnowflakeError("signin", "SNOWFLAKE_PRIVATE_KEY couldn't be read. It must be an unencrypted RSA key in PKCS#8 PEM form.");
  }
  const fp = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", spki))));
  const who = `${jwtAccount(c.account!)}.${c.user!.toUpperCase()}`;
  const iat = Math.floor(nowMs / 1000);
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(JSON.stringify({ iss: `${who}.SHA256:${fp}`, sub: who, iat, exp: iat + 600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(new Uint8Array(sig))}`;
}

/** REAL: a number that may have a fraction (the Screener's bounds); Snowflake's SQL API lists it beside FIXED and TEXT. */
export type Binding = { type: "TEXT" | "FIXED" | "REAL"; value: string };
export type SqlResult = { columns: { name: string; type: string }[]; rows: Record<string, string | null>[]; truncated: boolean; statementHandle: string | null };
export type SnowflakeIo = { fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> };

const MAX_ROWS = 20_000, WAIT_MS = 100_000, POLL_MS = 2_000;
// Dates and times come back as readable text instead of numbers since 1970.
const OUTPUT = {
  date_output_format: "YYYY-MM-DD",
  timestamp_output_format: 'YYYY-MM-DD"T"HH24:MI:SS', timestamp_ntz_output_format: 'YYYY-MM-DD"T"HH24:MI:SS',
  timestamp_ltz_output_format: 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM', timestamp_tz_output_format: 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM',
};

export class Snowflake {
  constructor(private c: SnowflakeCreds, private io: SnowflakeIo) {}

  get base(): string {
    const host = this.c.host || `${this.c.account!.toLowerCase().replace(/_/g, "-")}.snowflakecomputing.com`;
    return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = this.c.pat || await keyPairJwt(this.c, this.io.now());
    return {
      "Authorization": `Bearer ${token}`, "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "snl-lookup/1.0",
      "X-Snowflake-Authorization-Token-Type": this.c.pat ? "PROGRAMMATIC_ACCESS_TOKEN" : "KEYPAIR_JWT",
    };
  }

  private async send(url: string, init: { method: string; body?: string }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try { res = await this.io.fetch(url, { ...init, headers: await this.headers() }); }
      catch (e) { if (e instanceof SnowflakeError) throw e; throw new SnowflakeError("network", "Couldn't reach Snowflake. Try again in a few minutes."); }
      // Snowflake asks for a retry with a pause when it is busy.
      if (res.status === 429 && attempt === 0) { await res.body?.cancel(); await this.io.sleep(3000); continue; }
      return res;
    }
  }

  /** Runs one read-only statement and returns its rows as objects keyed by column name. Values are text, or
      null. Waits up to about 100 seconds (or waitMs) for a slow statement, then cancels it. */
  async query(statement: string, bindings: Binding[] = [], waitMs = WAIT_MS): Promise<SqlResult> {
    if (!credsReady(this.c)) throw new SnowflakeError("not_configured", SNOWFLAKE_NOT_CONFIGURED);
    const body = JSON.stringify({
      statement, timeout: Math.max(5, Math.min(90, Math.ceil(waitMs / 1000))), database: this.c.database, schema: this.c.schema, warehouse: this.c.warehouse, role: this.c.role,
      parameters: OUTPUT,
      ...(bindings.length ? { bindings: Object.fromEntries(bindings.map((b, i) => [String(i + 1), b])) } : {}),
    });
    const started = this.io.now();
    let res = await this.send(`${this.base}/api/v2/statements`, { method: "POST", body });
    let doc = await this.read(res);
    while (res.status === 202) {
      const handle = String(doc.statementHandle ?? "");
      if (!handle) throw new SnowflakeError("server", "Snowflake said the query is still running but gave no way to check on it. Try again.");
      if (this.io.now() - started > waitMs) {
        try { await (await this.send(`${this.base}/api/v2/statements/${handle}/cancel`, { method: "POST" })).body?.cancel(); } catch { /* best effort */ }
        throw new SnowflakeError("timeout", "The Snowflake query took too long and was cancelled. Try again in a minute.");
      }
      await this.io.sleep(POLL_MS);
      res = await this.send(`${this.base}/api/v2/statements/${handle}`, { method: "GET" });
      doc = await this.read(res);
    }
    return this.collect(doc);
  }

  /** The rows of a finished statement's answer, with its further partitions fetched (up to MAX_ROWS). */
  private async collect(doc: Record<string, unknown>): Promise<SqlResult> {
    const meta = (doc.resultSetMetaData ?? {}) as { rowType?: { name?: string; type?: string }[]; partitionInfo?: unknown[] };
    const columns = (meta.rowType ?? []).map((c) => ({ name: String(c.name ?? ""), type: String(c.type ?? "").toLowerCase() }));
    const handle = typeof doc.statementHandle === "string" ? doc.statementHandle : null;
    const data: (string | null)[][] = Array.isArray(doc.data) ? doc.data as (string | null)[][] : [];
    const partitions = Array.isArray(meta.partitionInfo) ? meta.partitionInfo.length : 1;
    let truncated = false;
    for (let p = 1; p < partitions && handle; p++) {
      if (data.length >= MAX_ROWS) { truncated = true; break; }
      const more = await this.read(await this.send(`${this.base}/api/v2/statements/${handle}?partition=${p}`, { method: "GET" }));
      if (Array.isArray(more.data)) data.push(...more.data as (string | null)[][]);
    }
    if (data.length > MAX_ROWS) { data.length = MAX_ROWS; truncated = true; }
    const rows = data.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] === undefined ? null : r[i]])));
    return { columns, rows, truncated, statementHandle: handle };
  }

  /** Submits one read-only statement that may run longer than a function call: Snowflake's own timeout is
      timeoutS seconds (not query's 90), and this call waits at most waitMs. A statement still running then is left
      running (never cancelled here) and its handle comes back, to be read later with check, or stopped with cancel.
      It is sent with ?async=true, so Snowflake answers 202 with the handle at once and this call polls for the rest.
      UNCONFIRMED: that a statement keeps running after the call that submitted it returns. */
  async submit(statement: string, bindings: Binding[], opts: { timeoutS: number; waitMs: number }): Promise<{ running: true; handle: string } | { running: false; result: SqlResult }> {
    if (!credsReady(this.c)) throw new SnowflakeError("not_configured", SNOWFLAKE_NOT_CONFIGURED);
    const body = JSON.stringify({
      statement, timeout: Math.max(5, Math.ceil(opts.timeoutS)), database: this.c.database, schema: this.c.schema, warehouse: this.c.warehouse, role: this.c.role,
      parameters: OUTPUT,
      ...(bindings.length ? { bindings: Object.fromEntries(bindings.map((b, i) => [String(i + 1), b])) } : {}),
    });
    const started = this.io.now();
    let res = await this.send(`${this.base}/api/v2/statements?async=true`, { method: "POST", body });
    let doc = await this.read(res);
    while (res.status === 202) {
      const handle = String(doc.statementHandle ?? "");
      if (!handle) throw new SnowflakeError("server", "Snowflake said the query is still running but gave no way to check on it. Try again.");
      if (this.io.now() - started + POLL_MS > opts.waitMs) return { running: true, handle };
      await this.io.sleep(POLL_MS);
      res = await this.send(`${this.base}/api/v2/statements/${handle}`, { method: "GET" });
      doc = await this.readHandle(res);
    }
    return { running: false, result: await this.collect(doc) };
  }

  /** One look at a submitted statement: its result when it has finished, running while it hasn't. A handle
      Snowflake doesn't know (expired) or a cancelled statement is SnowflakeError "gone". UNCONFIRMED: that a
      result stays readable by its handle for the minutes a screen takes, and the answers for an unknown or
      cancelled handle (taken as 404, or 422 that says cancelled or not found). */
  async check(handle: string): Promise<{ running: true; handle: string } | { running: false; result: SqlResult }> {
    if (!credsReady(this.c)) throw new SnowflakeError("not_configured", SNOWFLAKE_NOT_CONFIGURED);
    const res = await this.send(`${this.base}/api/v2/statements/${encodeURIComponent(handle)}`, { method: "GET" });
    const doc = await this.readHandle(res);
    if (res.status === 202) return { running: true, handle };
    return { running: false, result: await this.collect(doc) };
  }

  /** Asks Snowflake to stop a submitted statement. A handle it no longer knows is not an error. */
  async cancel(handle: string): Promise<void> {
    if (!credsReady(this.c)) throw new SnowflakeError("not_configured", SNOWFLAKE_NOT_CONFIGURED);
    const res = await this.send(`${this.base}/api/v2/statements/${encodeURIComponent(handle)}/cancel`, { method: "POST" });
    await res.body?.cancel();
  }

  /** read, where an unknown or cancelled statement is "gone" rather than a failure of the SQL. */
  private async readHandle(res: Response): Promise<Record<string, unknown>> {
    if (res.status === 404) { await res.body?.cancel(); throw new SnowflakeError("gone", "Snowflake no longer knows this statement.", 404); }
    try { return await this.read(res); }
    catch (e) {
      if (e instanceof SnowflakeError && e.code === "sql" && /cancel|not found|does not exist/i.test(e.message)) throw new SnowflakeError("gone", "Snowflake no longer knows this statement.", 422);
      throw e;
    }
  }

  private async read(res: Response): Promise<Record<string, unknown>> {
    let doc: Record<string, unknown> = {};
    try { const b = await res.json(); if (b && typeof b === "object") doc = b; } catch { /* the status decides */ }
    if (res.status === 200 || res.status === 202) return doc;
    const words = typeof doc.message === "string" ? doc.message.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const said = words ? ` Snowflake said: ${words}${/[.!?]$/.test(words) ? "" : "."}` : "";
    if (res.status === 401) throw new SnowflakeError("signin", `Snowflake didn't accept the sign-in (401). Check SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER and the key or token on Supabase.${said}`, 401);
    if (res.status === 422) throw new SnowflakeError("sql", `Snowflake couldn't run the query (422).${said}`, 422);
    if (res.status === 408) throw new SnowflakeError("timeout", "The Snowflake query ran out of time. Try again in a minute.", 408);
    if (res.status === 429) throw new SnowflakeError("busy", "Snowflake is busy (429). Wait a minute and try again.", 429);
    throw new SnowflakeError("server", `Snowflake answered ${res.status}.${said} Try again in a few minutes.`, res.status);
  }
}
