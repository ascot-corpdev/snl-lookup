// A stand-in for Snowflake's SQL API (POST /api/v2/statements and friends), shaped as Snowflake's documents
// describe it. It checks the sign-in the way Snowflake does (a key-pair JWT is verified against the public key;
// a programmatic access token is compared), and it runs the few statement shapes the app sends against made-up
// views held in memory, using the BOUND values. So a result only comes out right when the app's SQL and its
// bindings line up. Anything else is answered 422, the way Snowflake answers SQL it can't compile.
// Every view, column, company and figure here is made up.

import { type Clock, J } from "./fakes.ts";

export type SfCall = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: any; at: number };
type Value = string | number | null;
export type SfRows = Record<string, Value>[];
export type SfReply = { columns: string[]; rows: Value[][] } | { error: { status: number; code?: string; message: string; sqlState?: string } };
export type SfAuth = { pat?: string; publicKey?: CryptoKey; account?: string; user?: string };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

/** A fresh RSA key pair, made at run time (never pasted into a file). The fingerprint is worked out here from
    the PUBLIC key only: base64 of the SHA-256 of its DER (SubjectPublicKeyInfo), as Snowflake does. */
export async function makeKeyPair(bits = 2048) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const lines = b64(pkcs8).match(/.{1,64}/g)!.join("\n");
  const pem = ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\n" + lines + "\n" + ["-----END", "PRIVATE KEY-----"].join(" ") + "\n";
  const fingerprint = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
  return { pem, publicKey: pair.publicKey, fingerprint };
}

/** Splits a JWT and checks its RS256 signature against a public key. */
export async function readJwt(token: string, publicKey: CryptoKey) {
  const [h, c, s] = token.split(".");
  const header = JSON.parse(new TextDecoder().decode(unb64url(h ?? ""))), claims = JSON.parse(new TextDecoder().decode(unb64url(c ?? "")));
  const signatureOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, unb64url(s ?? ""), new TextEncoder().encode(`${h}.${c}`));
  return { header, claims, signatureOk, parts: token.split(".").length };
}

// ---------- the tiny SQL reader ----------

const NAME = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")`;
/** How Snowflake stores a name: upper case unless it was written in double quotes. */
export const stored = (name: string) => (name.startsWith('"') ? name.slice(1, -1) : name.toUpperCase());
const sqlError = (message: string, code = "001003", sqlState = "42000") => ({ error: { status: 422, code, message, sqlState } });
/** Snowflake's ILIKE: % is any run of characters, _ is any one character, case is ignored. */
export function ilike(text: string, pattern: string): boolean {
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${re}$`, "is").test(text);
}

export type SfOpts = {
  host?: string; database?: string; schema?: string; auth?: SfAuth;
  /** Made-up views: name as Snowflake stores it -> rows keyed by column name as stored. */
  tables?: Record<string, SfRows>;
  /** LOADTRACKER: view name -> last load time. */
  loaded?: Record<string, string>;
  /** Extra entries for INFORMATION_SCHEMA.TABLES (views with no rows here). */
  views?: { name: string; type?: string; comment?: string | null }[];
  /** Split results into partitions of this many rows. */
  partitionSize?: number;
  /** Answer a statement yourself; return undefined to let the built-in reader handle it. */
  on?: (statement: string, bindings: { type: string; value: string }[]) => SfReply | undefined;
};

export function fakeSnowflake(clock: Clock, opts: SfOpts = {}) {
  const host = opts.host ?? "ab12345.snowflakecomputing.com";
  const DB = (opts.database ?? "MI_XPRESSCLOUD").toUpperCase(), SCHEMA = (opts.schema ?? "XPRESSFEED").toUpperCase();
  const tables = opts.tables ?? {};
  const results = new Map<string, { columns: string[]; types: string[]; parts: (string | null)[][][]; pollsLeft: number; error?: SfReply }>();
  const state = {
    log: [] as SfCall[],
    /** Every statement received, with its bindings in order. */
    statements: [] as { statement: string; bindings: { type: string; value: string }[]; body: any }[],
    /** Answer the next calls with this status (and body) before anything else. */
    failNext: [] as { status: number; body?: unknown }[],
    /** The next statement answers 202 this many times before its result is ready. */
    slowNext: 0,
    cancelled: [] as string[],
    lastClaims: null as Record<string, unknown> | null,
    authFailures: [] as string[],
    calls: (path: string) => state.log.filter((c) => c.path === path),
  };

  async function authProblem(headers: Headers): Promise<string | null> {
    const a = opts.auth;
    if (!a) return null;
    const bearer = headers.get("authorization") ?? "", kind = headers.get("x-snowflake-authorization-token-type");
    if (!bearer.startsWith("Bearer ")) return "no bearer token";
    const token = bearer.slice(7);
    if (kind === "PROGRAMMATIC_ACCESS_TOKEN") return a.pat && token === a.pat ? null : "programmatic access token not recognised";
    if (kind !== "KEYPAIR_JWT") return "unknown token type";
    if (!a.publicKey) return "no public key is registered for this user";
    let jwt: Awaited<ReturnType<typeof readJwt>>;
    try { jwt = await readJwt(token, a.publicKey); } catch { return "the token is not a JWT"; }
    state.lastClaims = jwt.claims;
    if (jwt.parts !== 3 || jwt.header.alg !== "RS256") return "the JWT must be RS256";
    if (!jwt.signatureOk) return "the JWT signature does not match the registered public key";
    const fp = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", a.publicKey))));
    const who = `${(a.account ?? "AB12345").toUpperCase()}.${(a.user ?? "SVC_SNL").toUpperCase()}`;
    const nowS = Math.floor(clock.now / 1000);
    if (jwt.claims.sub !== who) return `sub must be ${who}`;
    if (jwt.claims.iss !== `${who}.SHA256:${fp}`) return "iss must be ACCOUNT.USER.SHA256:<public key fingerprint>";
    if (!Number.isInteger(jwt.claims.iat) || !Number.isInteger(jwt.claims.exp)) return "iat and exp must be whole seconds";
    if (jwt.claims.exp <= nowS) return "the JWT has expired";
    if (jwt.claims.exp - jwt.claims.iat > 3600) return "the JWT may last at most an hour";
    if (jwt.claims.iat > nowS + 60) return "the JWT is issued in the future";
    return null;
  }

  function run(statement: string, bindings: { type: string; value: string }[]): SfReply {
    const mine = opts.on?.(statement, bindings);
    if (mine) return mine;
    if (statement.includes(";")) return sqlError("Actual statement count 2 did not match the desired statement count 1.", "000008", "0A000");
    if (!/^\s*SELECT\s/i.test(statement)) return sqlError("SQL compilation error: this reader account can only run SELECT.", "003001", "42501");
    const holes = (statement.match(/\?/g) ?? []).length;
    if (holes !== bindings.length) return sqlError(`SQL compilation error: Bind variable ? not set (${holes} in the statement, ${bindings.length} bound).`, "002049", "42601");

    // INFORMATION_SCHEMA.TABLES
    let m = statement.match(new RegExp(String.raw`^SELECT TABLE_NAME, TABLE_TYPE, COMMENT FROM (${NAME})\.INFORMATION_SCHEMA\.TABLES WHERE TABLE_SCHEMA = \?( AND TABLE_NAME ILIKE \?)? ORDER BY TABLE_NAME LIMIT (\d+)$`, "i"));
    if (m) {
      if (stored(m[1]) !== DB) return sqlError(`SQL compilation error: Database '${stored(m[1])}' does not exist or not authorized.`, "002003", "02000");
      const all = [...Object.keys(tables).map((name) => ({ name, type: "VIEW", comment: null as string | null })), ...(opts.views ?? []).map((v) => ({ name: v.name, type: v.type ?? "VIEW", comment: v.comment ?? null }))];
      const hit = bindings[0].value === SCHEMA ? all.filter((v) => !m![2] || ilike(v.name, bindings[1].value)) : [];
      return { columns: ["TABLE_NAME", "TABLE_TYPE", "COMMENT"], rows: hit.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, Number(m[3])).map((v) => [v.name, v.type, v.comment]) };
    }
    // INFORMATION_SCHEMA.COLUMNS
    m = statement.match(new RegExp(String.raw`^SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION, COMMENT FROM (${NAME})\.INFORMATION_SCHEMA\.COLUMNS WHERE TABLE_SCHEMA = \? AND TABLE_NAME = \? ORDER BY ORDINAL_POSITION$`, "i"));
    if (m) {
      if (stored(m[1]) !== DB) return sqlError(`SQL compilation error: Database '${stored(m[1])}' does not exist or not authorized.`, "002003", "02000");
      const t = bindings[0].value === SCHEMA ? tables[bindings[1].value] : undefined;   // exact match: names are stored as written
      const cols = t?.length ? Object.keys(t[0]) : [];
      return { columns: ["COLUMN_NAME", "DATA_TYPE", "ORDINAL_POSITION", "COMMENT"], rows: cols.map((c, i) => [c, typeof t![0][c] === "number" ? "NUMBER" : "TEXT", i + 1, null]) };
    }
    // LOADTRACKER
    m = statement.match(new RegExp(String.raw`^SELECT TABLENAME, MAX\(LASTTABLEUPDATETIME\) AS AT FROM (${NAME})\.(${NAME})\.LOADTRACKER WHERE UPPER\(TABLENAME\) IN \(([?, ]+)\) GROUP BY TABLENAME ORDER BY 1$`, "i"));
    if (m) {
      if (stored(m[1]) !== DB || stored(m[2]) !== SCHEMA) return sqlError("SQL compilation error: Object does not exist or not authorized.", "002003", "42S02");
      if (!opts.loaded) return sqlError("SQL compilation error: Object 'LOADTRACKER' does not exist or not authorized.", "002003", "42S02");
      const want = bindings.map((b) => b.value);
      return { columns: ["TABLENAME", "AT"], rows: Object.entries(opts.loaded).filter(([name]) => want.includes(name.toUpperCase())).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, at]) => [name, at]) };
    }
    // One mapped field: SELECT <6 expressions> FROM db.schema.view WHERE <col> IN (?, ...) AND <year> BETWEEN ? AND ? [AND <col> = ?]... ORDER BY 1, 3 LIMIT n
    m = statement.match(new RegExp(String.raw`^SELECT (.+) FROM (${NAME})\.(${NAME})\.(${NAME}) WHERE (${NAME}) IN \(([?, ]+)\) AND (YEAR\(${NAME}\)|${NAME}) BETWEEN \? AND \?((?: AND ${NAME} = \?)*) ORDER BY 1, 3 LIMIT (\d+)$`, "i"));
    if (!m) return sqlError("SQL compilation error: syntax error, unexpected statement.");
    const [, list, db, schema, view, entityCol, marks, yearExpr, extras, limit] = m;
    if (stored(db) !== DB || stored(schema) !== SCHEMA || !tables[stored(view)]) return sqlError(`SQL compilation error: Object '${stored(db)}.${stored(schema)}.${stored(view)}' does not exist or not authorized.`, "002003", "42S02");
    const rows = tables[stored(view)], known = new Set(rows.flatMap((r) => Object.keys(r)));
    const exprs = list.split(/,\s*/).map((e) => e.match(new RegExp(String.raw`^(NULL|YEAR\(${NAME}\)|${NAME}) AS ([A-Z]+)$`, "i")));
    if (exprs.some((e) => !e)) return sqlError("SQL compilation error: syntax error in the select list.");
    const colOf = (expr: string) => stored(expr.replace(/^YEAR\((.+)\)$/i, "$1"));
    const extraCols = [...extras.matchAll(new RegExp(String.raw` AND (${NAME}) = \?`, "gi"))].map((x) => x[1]);
    for (const c of [entityCol, yearExpr, ...extraCols, ...exprs.map((e) => e![1]).filter((e) => !/^NULL$/i.test(e))]) if (!known.has(colOf(c))) return sqlError(`SQL compilation error: invalid identifier '${colOf(c)}'`, "000904", "42000");
    const value = (r: Record<string, Value>, expr: string): Value => {
      if (/^NULL$/i.test(expr)) return null;
      const v = r[colOf(expr)] ?? null;
      return /^YEAR\(/i.test(expr) && v !== null ? Number(String(v).slice(0, 4)) : v;
    };
    const nCodes = (marks.match(/\?/g) ?? []).length;
    const codes = bindings.slice(0, nCodes).map((b) => b.value.trim()), lo = Number(bindings[nCodes].value), hi = Number(bindings[nCodes + 1].value);
    const eq = bindings.slice(nCodes + 2).map((b) => b.value);
    const hit = rows.filter((r) => codes.includes(String(value(r, entityCol)).trim()) && Number(value(r, yearExpr)) >= lo && Number(value(r, yearExpr)) <= hi
      && extraCols.every((c, i) => String(value(r, c)) === eq[i]));
    const out = hit.map((r) => exprs.map((e) => value(r, e![1])));
    out.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0) || Number(a[2]) - Number(b[2]));
    return { columns: exprs.map((e) => e![2].toUpperCase()), rows: out.slice(0, Number(limit)) };
  }

  const doc = (handle: string, r: NonNullable<ReturnType<typeof results.get>>, part = 0) => ({
    resultSetMetaData: {
      numRows: r.parts.reduce((n, p) => n + p.length, 0), format: "jsonv2",
      rowType: r.columns.map((name, i) => ({ name, type: r.types[i], nullable: true, database: DB, schema: SCHEMA, table: "" })),
      partitionInfo: r.parts.map((p) => ({ rowCount: p.length, uncompressedSize: JSON.stringify(p).length })),
    },
    data: r.parts[part] ?? [], code: "090001", sqlState: "00000", message: "Statement executed successfully.",
    statementHandle: handle, statementStatusUrl: `/api/v2/statements/${handle}`, createdOn: clock.now,
  });
  const waiting = (handle: string) => J({ code: "333334", message: "Asynchronous execution in progress. Use provided query id to perform query monitoring and management.", statementHandle: handle, statementStatusUrl: `/api/v2/statements/${handle}` }, 202);

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init.method ?? "GET", headers = new Headers(init.headers);
    const raw = typeof init.body === "string" ? init.body : "";
    let body: any;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    state.log.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(headers), body, at: clock.now });
    if (url.host !== host) return J({ code: "390404", message: `No account at ${url.host}.` }, 404);
    const forced = state.failNext.shift();
    if (forced) return new Response(forced.body === undefined ? "" : typeof forced.body === "string" ? forced.body : JSON.stringify(forced.body), { status: forced.status, headers: { "content-type": "application/json" } });
    const problem = await authProblem(headers);
    if (problem) { state.authFailures.push(problem); return J({ code: "390144", message: `JWT token is invalid. ${problem}` }, 401); }
    if (headers.get("accept") !== "application/json" || !headers.get("user-agent")) return J({ code: "391902", message: "Unsupported Accept header or missing User-Agent." }, 400);

    if (url.pathname === "/api/v2/statements" && method === "POST") {
      if (headers.get("content-type") !== "application/json" || !body || typeof body.statement !== "string") return J({ code: "390142", message: "Incoming request does not contain a valid payload." }, 400);
      const b = body.bindings ?? {};
      const keys = Object.keys(b);
      if (keys.some((k, i) => k !== String(i + 1) || typeof b[k]?.value !== "string" || typeof b[k]?.type !== "string")) return J({ code: "390142", message: "Bindings must be {\"1\": {type, value}, ...} with text values." }, 400);
      const bindings = keys.map((k) => b[k]);
      state.statements.push({ statement: body.statement, bindings, body });
      const handle = `01b0c0de-0000-4000-8000-${String(state.statements.length).padStart(12, "0")}`;
      const reply = run(body.statement, bindings);
      const polls = state.slowNext;
      state.slowNext = 0;
      if ("error" in reply) {
        if (!polls) return J({ code: reply.error.code ?? "000000", message: reply.error.message, sqlState: reply.error.sqlState ?? "42000", statementHandle: handle }, reply.error.status);
        results.set(handle, { columns: [], types: [], parts: [], pollsLeft: polls - 1, error: reply });
        return waiting(handle);
      }
      const size = opts.partitionSize ?? Infinity, text = reply.rows.map((r) => r.map((v) => (v === null ? null : String(v))));
      const parts: (string | null)[][][] = [];
      for (let i = 0; i < Math.max(1, text.length); i += size) parts.push(text.slice(i, i + size));
      const types = reply.columns.map((_, i) => (reply.rows.some((r) => typeof r[i] === "number") ? "fixed" : "text"));
      results.set(handle, { columns: reply.columns, types, parts, pollsLeft: Math.max(0, polls - 1) });
      return polls ? waiting(handle) : J(doc(handle, results.get(handle)!));
    }
    const m = url.pathname.match(/^\/api\/v2\/statements\/([0-9a-f-]+)(\/cancel)?$/);
    if (m && m[2] && method === "POST") { state.cancelled.push(m[1]); return J({ code: "000604", message: "Statement cancelled successfully.", statementHandle: m[1] }); }
    if (m && !m[2] && method === "GET") {
      const r = results.get(m[1]);
      if (!r) return J({ code: "390142", message: "Statement not found." }, 404);
      if (r.pollsLeft > 0) { r.pollsLeft--; return waiting(m[1]); }
      if (r.error && "error" in r.error) return J({ code: r.error.error.code ?? "000000", message: r.error.error.message, sqlState: r.error.error.sqlState ?? "42000", statementHandle: m[1] }, r.error.error.status);
      const part = Number(url.searchParams.get("partition") ?? 0);
      if (part >= r.parts.length) return J({ code: "391903", message: "Partition out of range." }, 400);
      return J(part === 0 ? doc(m[1], r) : { data: r.parts[part] });
    }
    return J({ code: "390404", message: "Not found." }, 404);
  }) as typeof globalThis.fetch;
  return Object.assign(state, { fetch, host });
}
export type FakeSnowflake = ReturnType<typeof fakeSnowflake>;

/** Sends each request to the fake that owns its host, so one `fetch` can stand in for S&P and Snowflake at once. */
export function route(byHost: Record<string, typeof fetch>, otherwise: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input instanceof Request ? input.url : input)).host;
    const hit = Object.keys(byHost).find((h) => host === h || host.endsWith("." + h));
    return (hit ? byHost[hit] : otherwise)(input, init);
  }) as typeof fetch;
}
