// Snowflake's SQL API client (supabase/functions/_shared/snowflake.ts) and the statutory query builder
// (_shared/statutory.ts): the key-pair JWT, the request Snowflake is sent, waiting on a slow statement,
// partitions, the plain message for each failure, and that everything a user types is bound, never pasted
// into SQL. Every call goes to a stand-in that runs the SQL against made-up views using the bound values.
import { credsReady, jwtAccount, keyPairJwt, Snowflake, SNOWFLAKE_NOT_CONFIGURED, snowflakeConfigured, snowflakeCreds, SnowflakeError } from "../../supabase/functions/_shared/snowflake.ts";
import { buildSql, discoverColumns, discoverViews, type FieldMap, fieldStatus, isViewName, loadedAt, mapProblem, type Mapping, parseStatQuery, readMapping, runStatutory, STAT_FIELDS, type StatQuery } from "../../supabase/functions/_shared/statutory.ts";
import { checks, env, fakeClock, J } from "./helpers/fakes.ts";
import { fakeSnowflake, ilike, makeKeyPair, readJwt, type SfOpts } from "./helpers/snowflake.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const caught = async (p: Promise<unknown>): Promise<any> => { try { await p; return null; } catch (e) { return e; } };
const key = await makeKeyPair(), otherKey = await makeKeyPair();
const BASE = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST" };
const PAT = { ...BASE, SNOWFLAKE_PAT: "test-pat-not-a-secret" };

function world(secrets: Record<string, string> = PAT, opts: SfOpts = {}) {
  const clock = fakeClock(), sf = fakeSnowflake(clock, opts);
  const creds = snowflakeCreds(env(secrets));
  return { clock, sf, creds, api: new Snowflake(creds, { fetch: sf.fetch, now: clock.fn, sleep: clock.sleep }) };
}
const answer = (reply: { columns: string[]; rows: (string | number | null)[][] }) => ({ on: () => reply });

// ---------- secrets ----------
{
  const c = snowflakeCreds(env({ SNOWFLAKE_ACCOUNT: " ab12345 ", SNOWFLAKE_USER: " svc_snl ", SNOWFLAKE_WAREHOUSE: " WH_TEST ", SNOWFLAKE_PAT: " tok " }));
  ok("the Snowflake secrets are read and trimmed", c.account === "ab12345" && c.user === "svc_snl" && c.warehouse === "WH_TEST" && c.pat === "tok", c);
  ok("role, database and schema default to S&P's documented names", c.role === "XF_SNOWFLAKE_READER_ROLE" && c.database === "MI_XPRESSCLOUD" && c.schema === "XPRESSFEED");
  const o = snowflakeCreds(env({ ...PAT, SNOWFLAKE_ROLE: "R1", SNOWFLAKE_DATABASE: "DB1", SNOWFLAKE_SCHEMA: "S1", SNOWFLAKE_HOST: "acme-test.snowflakecomputing.com" }));
  ok("role, database, schema and host can be overridden", o.role === "R1" && o.database === "DB1" && o.schema === "S1" && o.host === "acme-test.snowflakecomputing.com");
  ok("nothing set is not configured", !snowflakeConfigured(env({})));
  ok("an account, a warehouse and a token is configured", snowflakeConfigured(env(PAT)));
  ok("an account, a warehouse, a user and a private key is configured", snowflakeConfigured(env({ ...BASE, SNOWFLAKE_PRIVATE_KEY: key.pem })));
  for (const [name, e] of [["no account", { SNOWFLAKE_WAREHOUSE: "W", SNOWFLAKE_PAT: "t" }], ["no warehouse", { SNOWFLAKE_ACCOUNT: "a", SNOWFLAKE_PAT: "t" }], ["a private key but no user", { SNOWFLAKE_ACCOUNT: "a", SNOWFLAKE_WAREHOUSE: "W", SNOWFLAKE_PRIVATE_KEY: key.pem }],
    ["a user but no key or token", { SNOWFLAKE_ACCOUNT: "a", SNOWFLAKE_WAREHOUSE: "W", SNOWFLAKE_USER: "u" }], ["a username and password only", { SNOWFLAKE_ACCOUNT: "a", SNOWFLAKE_WAREHOUSE: "W", SNOWFLAKE_USER: "u", SNOWFLAKE_PASSWORD: "p" }], ["blank values", { SNOWFLAKE_ACCOUNT: " ", SNOWFLAKE_WAREHOUSE: " ", SNOWFLAKE_PAT: " " }]] as const)
    ok(`${name} is not configured`, !snowflakeConfigured(env(e as Record<string, string>)));
  const w = world({});
  const e = await caught(w.api.query("SELECT 1"));
  ok("a query before Snowflake is set up fails with the not-set-up message and sends nothing", e instanceof SnowflakeError && e.code === "not_configured" && e.message === SNOWFLAKE_NOT_CONFIGURED && w.sf.log.length === 0, e?.message);
  ok("the not-set-up message says what is missing and that nothing is wrong on the user's side", SNOWFLAKE_NOT_CONFIGURED.includes("isn't set up yet") && SNOWFLAKE_NOT_CONFIGURED.includes("SNOWFLAKE secrets"));
}

// ---------- the key-pair JWT ----------
{
  const NOW = Date.parse("2026-11-13T12:00:00Z");
  const creds = snowflakeCreds(env({ ...BASE, SNOWFLAKE_ACCOUNT: "ab12345.us-east-1", SNOWFLAKE_PRIVATE_KEY: key.pem }));
  const token = await keyPairJwt(creds, NOW + 999);
  const jwt = await readJwt(token, key.publicKey);
  ok("the JWT has three parts and says RS256", jwt.parts === 3 && same(jwt.header, { alg: "RS256", typ: "JWT" }), jwt.header);
  ok("the JWT's signature verifies against the public key", jwt.signatureOk === true);
  ok("the same JWT does not verify against another key", (await readJwt(token, otherKey.publicKey)).signatureOk === false);
  ok("sub is ACCOUNT.USER in upper case, with the account locator's region left off", jwt.claims.sub === "AB12345.SVC_SNL", jwt.claims.sub);
  ok("iss is ACCOUNT.USER.SHA256:<base64 SHA-256 of the DER public key>", jwt.claims.iss === `AB12345.SVC_SNL.SHA256:${key.fingerprint}`, { iss: jwt.claims.iss, fingerprint: key.fingerprint });
  ok("the fingerprint is plain base64 of 32 bytes, not base64url", /^[A-Za-z0-9+/]{43}=$/.test(String(jwt.claims.iss).split("SHA256:")[1]));
  ok("iat is now in whole seconds", jwt.claims.iat === Math.floor((NOW + 999) / 1000), jwt.claims.iat);
  ok("exp is after iat and at most an hour after it", jwt.claims.exp > jwt.claims.iat && jwt.claims.exp - jwt.claims.iat <= 3600, jwt.claims.exp - jwt.claims.iat);
  ok("the JWT carries nothing but iss, sub, iat and exp", same(Object.keys(jwt.claims).sort(), ["exp", "iat", "iss", "sub"]));
  ok("the JWT is base64url with no padding", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
  const tampered = token.split(".").map((p, i) => (i === 1 ? btoa(JSON.stringify({ ...jwt.claims, sub: "AB12345.ADMIN" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") : p)).join(".");
  ok("changing a claim breaks the signature", (await readJwt(tampered, key.publicKey)).signatureOk === false);
  const two = await readJwt(await keyPairJwt(snowflakeCreds(env({ ...BASE, SNOWFLAKE_PRIVATE_KEY: otherKey.pem })), NOW), otherKey.publicKey);
  ok("a different key gives a different fingerprint", two.signatureOk && two.claims.iss === `AB12345.SVC_SNL.SHA256:${otherKey.fingerprint}` && otherKey.fingerprint !== key.fingerprint);
  const oneLine = snowflakeCreds(env({ ...BASE, SNOWFLAKE_PRIVATE_KEY: key.pem.trim().replace(/\n/g, "\\n") }));
  ok("a key pasted on one line with \\n in it is read the same", (await readJwt(await keyPairJwt(oneLine, NOW), key.publicKey)).signatureOk === true);
  const mixed = await readJwt(await keyPairJwt({ ...creds, account: "MyOrg-Acct_1", user: "Svc.Snl@example.test" }, NOW), key.publicKey);
  ok("account and user are upper-cased whatever case the secrets use", mixed.claims.sub === "MYORG-ACCT_1.SVC.SNL@EXAMPLE.TEST", mixed.claims.sub);
  ok("jwtAccount keeps an organisation-account name whole and drops only a locator's region", jwtAccount("myorg-acct1") === "MYORG-ACCT1" && jwtAccount("xy12345.eu-west-1.aws") === "XY12345" && jwtAccount("XY12345") === "XY12345");

  const enc = ["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" ") + "\nAAAA\n" + ["-----END", "ENCRYPTED PRIVATE KEY-----"].join(" ");
  let e = await caught(keyPairJwt({ ...creds, privateKey: enc }, NOW));
  ok("an encrypted key is refused with a message that says which key to use", e instanceof SnowflakeError && e.code === "signin" && e.message.includes("encrypted key") && e.message.includes("BEGIN PRIVATE KEY"), e?.message);
  e = await caught(keyPairJwt({ ...creds, privateKey: "not a key at all !!!" }, NOW));
  ok("a key that isn't PEM is refused in plain words", e instanceof SnowflakeError && e.code === "signin" && /SNOWFLAKE_PRIVATE_KEY/.test(e.message), e?.message);
  e = await caught(keyPairJwt({ ...creds, privateKey: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\nQUJDRA==\n" + ["-----END", "PRIVATE KEY-----"].join(" ") }, NOW));
  ok("a PEM that isn't an RSA PKCS#8 key is refused in plain words", e instanceof SnowflakeError && e.code === "signin" && e.message.includes("unencrypted RSA key in PKCS#8 PEM form"), e?.message);
  ok("no key error repeats the key", !String(e?.message).includes("QUJDRA"));
}

// ---------- the request ----------
{
  const w = world({ ...BASE, SNOWFLAKE_PRIVATE_KEY: key.pem }, { auth: { publicKey: key.publicKey, account: "ab12345", user: "svc_snl" }, ...answer({ columns: ["N"], rows: [[1]] }) });
  const r = await w.api.query("SELECT ? AS N", [{ type: "FIXED", value: "1" }, { type: "TEXT", value: "x" }]);
  const c = w.sf.log[0];
  ok("a statement is POSTed to https://<account>.snowflakecomputing.com/api/v2/statements", w.api.base === "https://ab12345.snowflakecomputing.com" && c.method === "POST" && c.path === "/api/v2/statements" && w.sf.log.length === 1, c.path);
  ok("Snowflake accepted the key-pair JWT (signature, iss, sub and lifetime checked the way Snowflake does)", w.sf.authFailures.length === 0 && same(r.rows, [{ N: "1" }]), w.sf.authFailures);
  ok("the headers are the ones the SQL API needs for a key-pair JWT", /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(c.headers.authorization) && c.headers.accept === "application/json" && c.headers["content-type"] === "application/json" && c.headers["x-snowflake-authorization-token-type"] === "KEYPAIR_JWT" && !!c.headers["user-agent"], c.headers);
  ok("the body carries the statement, a timeout, and the database, schema, warehouse and role", c.body.statement === "SELECT ? AS N" && typeof c.body.timeout === "number" && c.body.timeout > 0 && c.body.database === "MI_XPRESSCLOUD" && c.body.schema === "XPRESSFEED" && c.body.warehouse === "WH_TEST" && c.body.role === "XF_SNOWFLAKE_READER_ROLE", c.body);
  ok("bindings are numbered from 1, each with a type and a text value", same(c.body.bindings, { "1": { type: "FIXED", value: "1" }, "2": { type: "TEXT", value: "x" } }), c.body.bindings);
  ok("dates and timestamps are asked for as readable text", c.body.parameters?.date_output_format === "YYYY-MM-DD" && String(c.body.parameters?.timestamp_output_format).startsWith("YYYY-MM-DD"), c.body.parameters);
  ok("the body has only fields the SQL API documents", Object.keys(c.body).every((k) => ["statement", "timeout", "database", "schema", "warehouse", "role", "bindings", "parameters"].includes(k)), Object.keys(c.body));
  w.clock.now += 5 * 60_000;
  await w.api.query("SELECT 1 AS N");
  ok("a statement with no bindings sends none", !("bindings" in w.sf.log[1].body));
  ok("each request carries a newly made JWT", w.sf.log[1].headers.authorization !== c.headers.authorization && w.sf.lastClaims!.iat === Math.floor(w.clock.now / 1000));

  const wrong = world({ ...BASE, SNOWFLAKE_PRIVATE_KEY: otherKey.pem }, { auth: { publicKey: key.publicKey, account: "ab12345", user: "svc_snl" } });
  const e = await caught(wrong.api.query("SELECT 1"));
  ok("a JWT signed with a key Snowflake doesn't know is a plain sign-in failure", e instanceof SnowflakeError && e.code === "signin" && e.status === 401 && e.message.startsWith("Snowflake didn't accept the sign-in (401). Check SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER and the key or token on Supabase."), e?.message);
  const wrongUser = world({ ...BASE, SNOWFLAKE_USER: "someone_else", SNOWFLAKE_PRIVATE_KEY: key.pem }, { auth: { publicKey: key.publicKey, account: "ab12345", user: "svc_snl" } });
  ok("a JWT for another user is refused by Snowflake's check", (await caught(wrongUser.api.query("SELECT 1")))?.code === "signin" && wrongUser.sf.authFailures[0].startsWith("sub must be"));

  const pat = world(PAT, { auth: { pat: "test-pat-not-a-secret" }, ...answer({ columns: ["N"], rows: [[1]] }) });
  await pat.api.query("SELECT 1 AS N");
  ok("a programmatic access token is sent as the bearer token, marked as such", pat.sf.log[0].headers.authorization === "Bearer test-pat-not-a-secret" && pat.sf.log[0].headers["x-snowflake-authorization-token-type"] === "PROGRAMMATIC_ACCESS_TOKEN" && pat.sf.authFailures.length === 0, pat.sf.log[0].headers);
  const both = world({ ...PAT, SNOWFLAKE_PRIVATE_KEY: key.pem }, { auth: { pat: "test-pat-not-a-secret" }, ...answer({ columns: ["N"], rows: [[1]] }) });
  await both.api.query("SELECT 1 AS N");
  ok("when both a token and a key are set the token is used", both.sf.log[0].headers["x-snowflake-authorization-token-type"] === "PROGRAMMATIC_ACCESS_TOKEN");
  const badPat = world({ ...PAT, SNOWFLAKE_PAT: "revoked" }, { auth: { pat: "test-pat-not-a-secret" } });
  ok("a token Snowflake doesn't accept is a plain sign-in failure", (await caught(badPat.api.query("SELECT 1")))?.code === "signin");

  ok("an underscore in the account name becomes a hyphen in the address", new Snowflake(snowflakeCreds(env({ ...PAT, SNOWFLAKE_ACCOUNT: "MyOrg-Acct_1" })), { fetch, now: Date.now, sleep: async () => {} }).base === "https://myorg-acct-1.snowflakecomputing.com");
  ok("an account locator keeps its region in the address", new Snowflake(snowflakeCreds(env({ ...PAT, SNOWFLAKE_ACCOUNT: "xy12345.us-east-1" })), { fetch, now: Date.now, sleep: async () => {} }).base === "https://xy12345.us-east-1.snowflakecomputing.com");
  for (const host of ["acme.privatelink.snowflakecomputing.com", "https://acme.privatelink.snowflakecomputing.com/", "http://acme.privatelink.snowflakecomputing.com"])
    ok(`SNOWFLAKE_HOST "${host}" is used as the address, always over https`, new Snowflake(snowflakeCreds(env({ ...PAT, SNOWFLAKE_HOST: host })), { fetch, now: Date.now, sleep: async () => {} }).base === "https://acme.privatelink.snowflakecomputing.com");
}

// ---------- results ----------
{
  let w = world(PAT, answer({ columns: ["CODE", "VAL", "D"], rows: [["91001", 12.5, "2026-01-31"], ["92001", null, null]] }));
  let r = await w.api.query("SELECT 1");
  ok("rows come back as objects keyed by column name, values as text", same(r.rows, [{ CODE: "91001", VAL: "12.5", D: "2026-01-31" }, { CODE: "92001", VAL: null, D: null }]), r.rows);
  ok("nulls stay null", r.rows[1].VAL === null);
  ok("columns carry their names and lower-cased types, and the statement handle is kept", same(r.columns, [{ name: "CODE", type: "text" }, { name: "VAL", type: "fixed" }, { name: "D", type: "text" }]) && typeof r.statementHandle === "string" && r.truncated === false, r.columns);
  w = world(PAT, { on: () => undefined });
  w.sf.failNext.push({ status: 200, body: { resultSetMetaData: { rowType: [{ name: "A", type: "TEXT" }, { name: "B", type: "TEXT" }] }, data: [["only-a"], []] } });
  r = await w.api.query("SELECT 1");
  ok("a short row gives null for the missing column", same(r.rows, [{ A: "only-a", B: null }, { A: null, B: null }]), r.rows);
  w.sf.failNext.push({ status: 200, body: {} });
  r = await w.api.query("SELECT 1");
  ok("an answer with no data is no rows, not a failure", r.rows.length === 0 && r.columns.length === 0 && r.statementHandle === null);

  // slow statement
  w = world(PAT, answer({ columns: ["N"], rows: [[7]] }));
  w.sf.slowNext = 3;
  r = await w.api.query("SELECT 7 AS N");
  const polls = w.sf.log.filter((c) => c.method === "GET");
  ok("a statement that is still running (202) is polled at GET /api/v2/statements/<handle> until it finishes", same(r.rows, [{ N: "7" }]) && polls.length === 3 && polls.every((c) => /^\/api\/v2\/statements\/[0-9a-f-]+$/.test(c.path)) && w.sf.log.filter((c) => c.method === "POST").length === 1, w.sf.log.map((c) => `${c.method} ${c.path}`));
  ok("polls are two seconds apart", same(w.clock.slept, [2000, 2000, 2000]), w.clock.slept);
  ok("polls carry the sign-in headers too", polls.every((c) => c.headers.authorization === "Bearer test-pat-not-a-secret" && c.headers["x-snowflake-authorization-token-type"] === "PROGRAMMATIC_ACCESS_TOKEN"));
  w = world(PAT, answer({ columns: ["N"], rows: [[7]] }));
  w.sf.slowNext = 10_000;
  let e = await caught(w.api.query("SELECT 7 AS N"));
  ok("a statement that never finishes is given up on after about 100 seconds, in plain words", e instanceof SnowflakeError && e.code === "timeout" && e.message.includes("took too long and was cancelled") && w.clock.now - Date.parse("2026-11-13T12:00:00Z") <= 110_000, { m: e?.message, waited: w.clock.now - Date.parse("2026-11-13T12:00:00Z") });
  ok("and the statement is cancelled on Snowflake", w.sf.cancelled.length === 1 && w.sf.log.at(-1)!.method === "POST" && w.sf.log.at(-1)!.path.endsWith("/cancel"), w.sf.log.at(-1));
  w = world(PAT);
  w.sf.failNext.push({ status: 202, body: { code: "333334", message: "Asynchronous execution in progress." } });
  e = await caught(w.api.query("SELECT 1"));
  ok("a 202 with no statement handle fails plainly instead of polling nothing", e instanceof SnowflakeError && e.code === "server" && w.sf.log.length === 1, e?.message);
  w = world(PAT, { on: () => ({ error: { status: 422, code: "000904", message: "SQL compilation error: invalid identifier 'NOPE'", sqlState: "42000" } }) });
  w.sf.slowNext = 2;
  e = await caught(w.api.query("SELECT NOPE"));
  ok("a statement that fails after running for a while is still reported as an SQL failure", e instanceof SnowflakeError && e.code === "sql" && e.message.includes("invalid identifier 'NOPE'"), e?.message);

  // partitions
  const rows = Array.from({ length: 2500 }, (_, i) => [String(i), i]);
  w = world(PAT, { partitionSize: 1000, ...answer({ columns: ["ID", "N"], rows }) });
  r = await w.api.query("SELECT 1");
  ok("more partitions are fetched with ?partition=N and joined in order", r.rows.length === 2500 && r.rows[0].ID === "0" && r.rows[999].ID === "999" && r.rows[1000].ID === "1000" && r.rows[2499].ID === "2499" && same(w.sf.log.filter((c) => c.method === "GET").map((c) => c.query.partition), ["1", "2"]) && r.truncated === false, w.sf.log.map((c) => `${c.method} ${c.path} ${c.query.partition ?? ""}`));
  w = world(PAT, { partitionSize: 9000, ...answer({ columns: ["ID"], rows: Array.from({ length: 30_000 }, (_, i) => [String(i)]) }) });
  r = await w.api.query("SELECT 1");
  ok("a result over 20,000 rows is cut at 20,000 and marked as cut", r.rows.length === 20_000 && r.truncated === true && r.rows[19_999].ID === "19999", { rows: r.rows.length, truncated: r.truncated });
  ok("no partition is fetched once 20,000 rows are in hand", w.sf.log.filter((c) => c.method === "GET").length === 2, w.sf.log.filter((c) => c.method === "GET").map((c) => c.query.partition));
}

// ---------- failures ----------
{
  const cases: [number, unknown, string, RegExp][] = [
    [401, { code: "390144", message: "JWT token is invalid." }, "signin", /^Snowflake didn't accept the sign-in \(401\)\. Check SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER and the key or token on Supabase\. Snowflake said: JWT token is invalid\.$/],
    [422, { code: "002003", message: "SQL compilation error:\nObject 'X' does not exist or not authorized.", sqlState: "42S02" }, "sql", /^Snowflake couldn't run the query \(422\)\. Snowflake said: SQL compilation error: Object 'X' does not exist or not authorized\.$/],
    [408, { message: "Statement timed out" }, "timeout", /^The Snowflake query ran out of time\. Narrow it and try again\.$/],
    [500, { message: "Internal error" }, "server", /^Snowflake answered 500\. Snowflake said: Internal error Try again in a few minutes\.$|^Snowflake answered 500\. Snowflake said: Internal error\. Try again in a few minutes\.$/],
    [503, "<html>unavailable</html>", "server", /^Snowflake answered 503\. Try again in a few minutes\.$/],
    [403, { message: "Role not granted" }, "server", /^Snowflake answered 403\./],
  ];
  for (const [status, body, code, shape] of cases) {
    const w = world();
    w.sf.failNext.push({ status, body });
    const e = await caught(w.api.query("SELECT 1"));
    ok(`a ${status} from Snowflake is a plain "${code}" failure`, e instanceof SnowflakeError && e.code === code && e.status === status && shape.test(e.message), e?.message);
    ok(`a ${status} is not retried`, w.sf.log.length === 1);
  }
  let w = world(PAT, answer({ columns: ["N"], rows: [[1]] }));
  w.sf.failNext.push({ status: 429, body: { message: "Too many requests" } });
  const r = await w.api.query("SELECT 1 AS N");
  ok("a 429 waits three seconds and tries once more", same(r.rows, [{ N: "1" }]) && same(w.clock.slept, [3000]) && w.sf.log.length === 2, w.clock.slept);
  w = world();
  w.sf.failNext.push({ status: 429 }, { status: 429 });
  let e = await caught(w.api.query("SELECT 1"));
  ok("a second 429 fails with a plain 'busy' message", e instanceof SnowflakeError && e.code === "busy" && e.message === "Snowflake is busy (429). Wait a minute and try again." && w.sf.log.length === 2, e?.message);
  const down = new Snowflake(snowflakeCreds(env(PAT)), { fetch: (() => Promise.reject(new TypeError("getaddrinfo ENOTFOUND ab12345"))) as unknown as typeof fetch, now: Date.now, sleep: async () => {} });
  e = await caught(down.query("SELECT 1"));
  ok("Snowflake unreachable is a plain network failure that doesn't repeat the address", e instanceof SnowflakeError && e.code === "network" && e.message === "Couldn't reach Snowflake. Try again in a few minutes.", e?.message);
  w = world();
  w.sf.failNext.push({ status: 422, body: { message: "x".repeat(2000) } });
  e = await caught(w.api.query("SELECT 1"));
  ok("a very long Snowflake message is cut short", e.message.length < 400, e?.message.length);
  w = world({ ...PAT, SNOWFLAKE_ACCOUNT: "zz99999" });
  e = await caught(w.api.query("SELECT 1"));
  ok("a wrong account name (404 from Snowflake) is a plain failure, not a crash", e instanceof SnowflakeError && e.code === "server" && e.status === 404, e?.message);
}

// ---------- the mapping: only checked names reach SQL ----------
const GOOD: FieldMap = { view: "IR_PREM_LINE", entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "DPW_000", line: "LOB", scale: 1000, where: [{ column: "BASIS", equals: "Direct" }] };
const HOSTILE = ["X; DROP TABLE Y", 'a"b', "A--", "A/*", "A B", "A.B", "A)", "(SELECT 1)", "1A", "", " ", '"a""b"', '"A" OR "1"="1"', "A\n", "A\nB", "A'", "A,B", "A=B", "Ａ", "A;", "NAIC_CD IN (SELECT 1)", "x".repeat(129), '""', "A\u0000", "$A", "A\\", "`A`", "[A]"];
{
  ok("a complete mapping has nothing wrong with it", mapProblem("dpw_by_line", GOOD) === null);
  ok("a name in double quotes, for exact case, is allowed", mapProblem("dpw_by_line", { ...GOOD, view: '"Ir Prem Line"', value: '"Dpw 000"' }) === null && isViewName('"Ir Prem Line"'));
  ok("names with $ and _ are allowed", isViewName("IR$PREM_2") && isViewName("_X") && isViewName("x".repeat(128)));
  let leaks: string[] = [];
  for (const bad of HOSTILE) {
    const tries: [string, unknown][] = [
      ["view", { ...GOOD, view: bad }], ["entity.company", { ...GOOD, entity: { ...GOOD.entity, company: bad } }], ["entity.group", { ...GOOD, entity: { ...GOOD.entity, group: bad } }], ["entity.name", { ...GOOD, entity: { ...GOOD.entity, name: bad } }],
      ["year", { ...GOOD, year: bad }], ["value", { ...GOOD, value: bad }], ["line", { ...GOOD, line: bad }], ["state", { ...GOOD, state: bad }], ["where.column", { ...GOOD, where: [{ column: bad, equals: "x" }] }],
    ];
    for (const [where, m] of tries) if (mapProblem("dpw_by_line", m) === null) leaks.push(`${where}=${JSON.stringify(bad)}`);
    if (isViewName(bad)) leaks.push(`isViewName(${JSON.stringify(bad)})`);
  }
  ok(`${HOSTILE.length} hostile or malformed names are refused in every place a name can go`, leaks.length === 0, leaks);
  ok("the reason names the part that is wrong", mapProblem("dpw_by_line", { ...GOOD, view: "X; DROP TABLE Y" }) === "view must be a view name" && mapProblem("dpw_by_line", { ...GOOD, year: 'a"b' }) === "year must be a column name" && mapProblem("dpw_by_line", { ...GOOD, value: "A--" }) === "value must be a column name"
    && mapProblem("dpw_by_line", { ...GOOD, entity: { company: "NAIC_CD", name: "A--" } }) === "entity.name must be a column name");
  for (const [name, m] of [["nothing", undefined], ["null", null], ["a string", "IR_PREM_LINE"], ["a list", []], ["no entity", { ...GOOD, entity: undefined }], ["an entity with neither company nor group", { ...GOOD, entity: { name: "CO_NAME" } }], ["no year", { ...GOOD, year: undefined }], ["no value", { ...GOOD, value: undefined }],
    ["a by-line field with no line column", { ...GOOD, line: undefined }], ["a view that is a number", { ...GOOD, view: 42 }], ["a view that is a list", { ...GOOD, view: ["A"] }], ["where that isn't a list", { ...GOOD, where: { column: "A", equals: "b" } }], ["nine where filters", { ...GOOD, where: Array.from({ length: 9 }, () => ({ column: "A", equals: "b" })) }],
    ["a where value that isn't text", { ...GOOD, where: [{ column: "A", equals: 5 }] }], ["a where value of 201 characters", { ...GOOD, where: [{ column: "A", equals: "x".repeat(201) }] }], ["a null where entry", { ...GOOD, where: [null] }],
    ["a scale of zero", { ...GOOD, scale: 0 }], ["a scale that is text", { ...GOOD, scale: "1000" }], ["a scale that isn't finite", { ...GOOD, scale: Infinity }], ["a scale that is SQL", { ...GOOD, scale: "1; DROP" }]] as const)
    ok(`a mapping with ${name} is not usable`, mapProblem("dpw_by_line", m) !== null, mapProblem("dpw_by_line", m));
  ok("a by-state field needs a state column", mapProblem("dpw_by_state", GOOD) === "state must be a column name" && mapProblem("dpw_by_state", { ...GOOD, state: "ST" }) === null);
  ok("a by-year field needs neither line nor state", mapProblem("surplus", { view: "IR_SURPLUS", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "PHS" }) === null);
  ok("a where value may hold any text, because it is bound", mapProblem("dpw_by_line", { ...GOOD, where: [{ column: "BASIS", equals: "'; DROP TABLE X; --" }] }) === null);
  const status = fieldStatus({ fields: { dpw_by_line: GOOD, surplus: { ...GOOD, view: "X; DROP TABLE Y" } } });
  ok("status lists every field (the seven the view shows and ten for company profiles) and which are mapped", status.length === 17 && same(status.filter((f) => f.mapped).map((f) => f.id), ["dpw_by_line"]) && same(status.map((f) => f.id), STAT_FIELDS.map((f) => f.id)), status.map((f) => [f.id, f.mapped]));
  ok("a settings row with no fields reads as nothing mapped", same(readMapping(null), { fields: {} }) && same(readMapping({}), { fields: {} }) && same(readMapping({ fields: "x" }), { fields: {} }) && same(readMapping({ fields: null }), { fields: {} }));
}

// ---------- buildSql ----------
const Q: StatQuery = { kind: "company", codes: ["91001", "92001"], fromYear: 2021, toYear: 2025 };
{
  const sql = buildSql("MI_XPRESSCLOUD", "XPRESSFEED", GOOD, Q)!;
  ok("one field becomes one SELECT over the mapped view", sql.statement === "SELECT NAIC_CD AS CODE, CO_NAME AS NAME, STMT_YEAR AS YR, LOB AS LINE, NULL AS STATE, DPW_000 AS VAL FROM MI_XPRESSCLOUD.XPRESSFEED.IR_PREM_LINE WHERE NAIC_CD IN (?, ?) AND STMT_YEAR BETWEEN ? AND ? AND BASIS = ? ORDER BY 1, 3 LIMIT 20000", sql.statement);
  ok("codes are bound as text, years as numbers, and filter values as text, in the order of the question marks", same(sql.bindings, [{ type: "TEXT", value: "91001" }, { type: "TEXT", value: "92001" }, { type: "FIXED", value: "2021" }, { type: "FIXED", value: "2025" }, { type: "TEXT", value: "Direct" }]), sql.bindings);
  const readOnly = (s: string) => /^SELECT /.test(s) && !s.includes(";") && !/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|CALL|COPY|PUT|EXECUTE|USE)\b/i.test(s) && !/--|\/\*/.test(s) && (s.match(/\bSELECT\b/gi) ?? []).length === 1;
  ok("the statement is a single read-only SELECT with a row limit", readOnly(sql.statement) && / LIMIT 20000$/.test(sql.statement));
  ok("there is one question mark for each binding", (sql.statement.match(/\?/g) ?? []).length === sql.bindings.length);
  const evil = buildSql("MI_XPRESSCLOUD", "XPRESSFEED", { ...GOOD, where: [{ column: "BASIS", equals: "x' OR '1'='1" }, { column: "SRC", equals: "'; DROP TABLE Y; --" }] }, { ...Q, codes: ["1", "2", "3"] })!;
  ok("values never appear in the SQL text, whatever they contain", readOnly(evil.statement) && !evil.statement.includes("OR '1'") && !evil.statement.includes("DROP") && !/\d{4}/.test(evil.statement.replace("LIMIT 20000", "")) && !evil.statement.includes("'") && same(evil.bindings.slice(-2).map((b) => b.value), ["x' OR '1'='1", "'; DROP TABLE Y; --"]), evil.statement);
  const grp = buildSql("MI_XPRESSCLOUD", "XPRESSFEED", GOOD, { ...Q, kind: "group", codes: ["9100"] })!;
  ok("a group query filters on the group column", grp.statement.includes("SELECT GRP_CD AS CODE") && grp.statement.includes("WHERE GRP_CD IN (?)") && grp.bindings[0].value === "9100", grp.statement);
  ok("a field with no group column can't be asked for by group", buildSql("MI_XPRESSCLOUD", "XPRESSFEED", { ...GOOD, entity: { company: "NAIC_CD" } }, { ...Q, kind: "group" }) === null);
  const dated = buildSql("MI_XPRESSCLOUD", "XPRESSFEED", { ...GOOD, year: "PERIOD_END", yearIsDate: true, entity: { company: "NAIC_CD" }, line: undefined, state: '"State Code"', where: undefined }, Q)!;
  ok("a date column is turned into a year, and unmapped name, line or state columns become NULL", dated.statement === 'SELECT NAIC_CD AS CODE, NULL AS NAME, YEAR(PERIOD_END) AS YR, NULL AS LINE, "State Code" AS STATE, DPW_000 AS VAL FROM MI_XPRESSCLOUD.XPRESSFEED.IR_PREM_LINE WHERE NAIC_CD IN (?, ?) AND YEAR(PERIOD_END) BETWEEN ? AND ? ORDER BY 1, 3 LIMIT 20000', dated.statement);
  for (const bad of ["X; DROP TABLE Y", 'a"b', "A--", "DB.OTHER", ""]) {
    ok(`a database called ${JSON.stringify(bad)} produces no SQL`, buildSql(bad, "XPRESSFEED", GOOD, Q) === null);
    ok(`a schema called ${JSON.stringify(bad)} produces no SQL`, buildSql("MI_XPRESSCLOUD", bad, GOOD, Q) === null);
  }
}

// ---------- parseStatQuery ----------
{
  const p = parseStatQuery({ codes: ["91001", 92001, " 91001 "] }, 2026);
  ok("a query needs only codes: company, last five full years, the seven fields the view shows", p.ok && same(p.q, { kind: "company", codes: ["91001", "92001"], fromYear: 2021, toYear: 2025 }) && same(p.fields, STAT_FIELDS.slice(0, 7).map((f) => f.id)), p);
  const g = parseStatQuery({ kind: "group", codes: ["9100"], fromYear: 2015, toYear: 2026, fields: ["surplus", "surplus", "loss_ratio"] }, 2026);
  ok("kind, years and fields can be chosen; repeats are dropped", g.ok && g.q.kind === "group" && g.q.fromYear === 2015 && g.q.toYear === 2026 && same(g.fields, ["surplus", "loss_ratio"]), g);
  ok("15 years at a time is allowed, 16 is not", parseStatQuery({ codes: ["1"], fromYear: 2011, toYear: 2025 }, 2026).ok && !parseStatQuery({ codes: ["1"], fromYear: 2010, toYear: 2025 }, 2026).ok);
  const refused = (name: string, body: Record<string, unknown>, says: RegExp) => { const r = parseStatQuery({ codes: ["91001"], ...body }, 2026) as any; ok(`${name} is refused with a plain reason`, r.ok === false && says.test(r.message), r); };
  for (const code of ["1 OR 1=1", "91001'", "91001;--", "1234567", "", " ", "-1", "1e3", "１２３", "91 001", "0x1F", "NAIC", "91001\n2", "null"]) refused(`the code ${JSON.stringify(code)}`, { codes: [code] }, /1 to 8 NAIC codes/);
  refused("no codes", { codes: [] }, /1 to 8 NAIC codes/);
  refused("codes that aren't a list", { codes: "91001" }, /1 to 8 NAIC codes/);
  refused("nine codes", { codes: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }, /1 to 8 NAIC codes/);
  refused("a code that is an object", { codes: [{ $ne: null }] }, /1 to 8 NAIC codes/);
  refused("a kind that isn't company or group", { kind: "state" }, /kind must be/);
  refused("a kind that is a number", { kind: 1 }, /kind must be/);
  for (const [name, years] of [["a year that is SQL", { toYear: "2024; DROP TABLE X" }], ["a year with a fraction", { fromYear: 2020.5 }], ["a year before 1990", { fromYear: 1989, toYear: 1995 }], ["a year in the future", { toYear: 2027 }], ["a start year after the end year", { fromYear: 2024, toYear: 2020 }],
    ["a null year", { toYear: null }], ["an empty year", { fromYear: "" }], ["a year that is true", { toYear: true }], ["a year in words", { toYear: "last year" }]] as const) refused(name, years, /Years must be whole years/);
  refused("a field the app doesn't have", { fields: ["surplus", "ebitda"] }, /fields must be from: dpw_by_line/);
  refused("an empty field list", { fields: [] }, /fields must be from/);
  refused("fields that aren't a list", { fields: "surplus" }, /fields must be from/);
  ok("a year typed as text is read as the year", (() => { const r = parseStatQuery({ codes: ["1"], fromYear: "2020", toYear: "2024" }, 2026); return r.ok && r.q.fromYear === 2020 && r.q.toYear === 2024; })());
}

// ---------- runStatutory against made-up views ----------
const TABLES = {
  IR_PREM_LINE: [
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2023, LOB: "Homeowners", ST: "FL", BASIS: "Direct", DPW_000: 1200.5, NPW_000: 900 },
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "FL", BASIS: "Direct", DPW_000: 1300, NPW_000: null },
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "FL", BASIS: "Assumed", DPW_000: 55, NPW_000: 55 },
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2019, LOB: "Homeowners", ST: "FL", BASIS: "Direct", DPW_000: 999, NPW_000: 999 },
    { NAIC_CD: "91002", GRP_CD: "9100", CO_NAME: "Calloway Home Co", STMT_YEAR: 2024, LOB: "Personal Auto", ST: "TX", BASIS: "Direct", DPW_000: 400, NPW_000: 380 },
    { NAIC_CD: "92001", GRP_CD: null, CO_NAME: "Tarrow Mutual Insurance Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "FL", BASIS: "Direct", DPW_000: "", NPW_000: 0 },
    { NAIC_CD: "93001", GRP_CD: "9300", CO_NAME: "Not Asked For Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "FL", BASIS: "Direct", DPW_000: 777, NPW_000: 777 },
  ],
  IR_RATIOS: [
    { NAIC_CD: "91001", PERIOD_END: "2023-12-31", LOSS_RATIO: 0.625, COMBINED: 0.985 },
    { NAIC_CD: "91001", PERIOD_END: "2024-12-31", LOSS_RATIO: 0.5, COMBINED: null },
    { NAIC_CD: "92001", PERIOD_END: "2024-12-31", LOSS_RATIO: 1.25, COMBINED: 1.5 },
    { NAIC_CD: "92001", PERIOD_END: "2020-12-31", LOSS_RATIO: 9, COMBINED: 9 },
  ],
  ir_surplus_mixed: [{ naic: "91001", yr: 2024, phs: 5000 }],
};
const MAPPING: Mapping = { fields: {
  dpw_by_line: { view: "IR_PREM_LINE", entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "DPW_000", line: "LOB", scale: 1000, where: [{ column: "BASIS", equals: "Direct" }] },
  npw_by_line: { view: "ir_prem_line", entity: { company: "naic_cd", name: "co_name" }, year: "stmt_year", value: "npw_000", line: "lob", scale: 1000, where: [{ column: "BASIS", equals: "Direct" }] },
  dpw_by_state: { view: "IR_PREM_LINE", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "DPW_000", state: "ST", where: [{ column: "BASIS", equals: "Direct" }] },
  loss_ratio: { view: "IR_RATIOS", entity: { company: "NAIC_CD" }, year: "PERIOD_END", yearIsDate: true, value: "LOSS_RATIO", scale: 100 },
  combined_ratio: { view: "IR_RATIOS", entity: { company: "NAIC_CD" }, year: "PERIOD_END", yearIsDate: true, value: "COMBINED", scale: 100 },
  expense_ratio: { view: "IR_RATIOS", entity: { company: "NAIC_CD" }, year: "PERIOD_END", yearIsDate: true, value: "EXPENSE_RATIO_MISSING", scale: 100 },
  surplus: { view: '"ir_surplus_mixed"', entity: { company: '"naic"' }, year: '"yr"', value: '"phs"' },
} };
const LOADED = { IR_PREM_LINE: "2026-11-01T04:00:00", IR_RATIOS: "2026-10-15T04:00:00", ir_surplus_mixed: "2026-09-01T00:00:00", SOMETHING_ELSE: "2026-01-01T00:00:00" };
{
  const w = world(PAT, { tables: TABLES, loaded: LOADED });
  const all = STAT_FIELDS.map((f) => f.id);
  const r = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, Q, all);
  const f = (id: string) => r.fields.find((x) => x.id === id)!;
  ok("every field asked for comes back, in order, with its label, unit and shape", same(r.fields.map((x) => [x.id, x.unit, x.by]), STAT_FIELDS.map((x) => [x.id, x.unit, x.by])) && f("dpw_by_line").label === "Direct premiums written by line");
  ok("only the companies and years asked for come back, filtered by the mapping's where values", same(f("dpw_by_line").rows, [
    { code: "91001", year: 2023, line: "Homeowners", state: null, value: 1_200_500 }, { code: "91001", year: 2024, line: "Homeowners", state: null, value: 1_300_000 }, { code: "92001", year: 2024, line: "Homeowners", state: null, value: null }]), f("dpw_by_line").rows);
  ok("scale multiplies the stored value (thousands to dollars)", f("dpw_by_line").rows[0].value === 1_200_500 && f("dpw_by_state").rows[0].value === 1200.5);
  ok("a null stays null, and so does an empty value: neither becomes zero", f("npw_by_line").rows.find((x) => x.code === "91001" && x.year === 2024)!.value === null && f("dpw_by_line").rows.find((x) => x.code === "92001")!.value === null);
  ok("a real zero stays zero", f("npw_by_line").rows.find((x) => x.code === "92001")!.value === 0);
  ok("names in the mapping work in any case, as Snowflake reads unquoted names", f("npw_by_line").mapped && f("npw_by_line").error === null && f("npw_by_line").rows.length === 3, f("npw_by_line"));
  ok("names in double quotes keep their exact case", f("surplus").error === null && same(f("surplus").rows, [{ code: "91001", year: 2024, line: null, state: null, value: 5000 }]), f("surplus"));
  ok("a by-state field carries the state and no line", same(f("dpw_by_state").rows.map((x) => [x.state, x.line]), [["FL", null], ["FL", null], ["FL", null]]));
  ok("a date column is read as its year", same(f("loss_ratio").rows.map((x) => [x.code, x.year]), [["91001", 2023], ["91001", 2024], ["92001", 2024]]), f("loss_ratio").rows);
  ok("a ratio held as a fraction is scaled to a percentage", same(f("loss_ratio").rows.map((x) => x.value), [62.5, 50, 125]) && same(f("combined_ratio").rows.map((x) => x.value), [98.5, null, 150]), f("combined_ratio").rows);
  ok("a field whose SQL fails is reported on that field, with Snowflake's words", f("expense_ratio").mapped === true && f("expense_ratio").rows.length === 0 && /^Snowflake couldn't run the query \(422\)\. Snowflake said: SQL compilation error: invalid identifier 'EXPENSE_RATIO_MISSING' Check this field's mapping\.$|invalid identifier 'EXPENSE_RATIO_MISSING'\. Check this field's mapping\.$/.test(f("expense_ratio").error ?? ""), f("expense_ratio").error);
  ok("the other fields are not failed by it", r.fields.filter((x) => x.error === null && x.rows.length > 0).length === 6);
  ok("company names come from the data, for the codes asked", same(r.entities, [{ code: "91001", name: "Calloway Insurance Co" }, { code: "92001", name: "Tarrow Mutual Insurance Co" }]), r.entities);
  ok("LOADTRACKER supplies when each view used was last loaded", same(r.loaded, [{ view: "IR_PREM_LINE", at: "2026-11-01T04:00:00" }, { view: "IR_RATIOS", at: "2026-10-15T04:00:00" }, { view: "ir_surplus_mixed", at: "2026-09-01T00:00:00" }]), r.loaded);
  ok("the result names its source and echoes the question", r.source === "S&P Global Market Intelligence, SNL Insurance Regulatory Data (Snowflake)" && r.kind === "company" && same(r.codes, Q.codes) && r.fromYear === 2021 && r.toYear === 2025 && r.truncated === false);

  const typed = [...Q.codes, String(Q.fromYear), String(Q.toYear), "Direct"];
  ok("eight statements were sent: one for each mapped field and one for LOADTRACKER", w.sf.statements.length === 8, w.sf.statements.length);
  ok("every statement is a single read-only SELECT", w.sf.statements.every((s) => /^SELECT /.test(s.statement) && !s.statement.includes(";") && (s.statement.match(/\bSELECT\b/g) ?? []).length === 1));
  ok("nothing the user typed, and no where value, appears in any SQL text", w.sf.statements.every((s) => typed.every((v) => !s.statement.includes(v))), w.sf.statements.map((s) => s.statement).filter((s) => typed.some((v) => s.includes(v))));
  ok("every typed value went as a binding, one for each question mark", w.sf.statements.every((s) => (s.statement.match(/\?/g) ?? []).length === s.bindings.length) && w.sf.statements.slice(0, 7).every((s) => same(s.bindings.slice(0, 4), [{ type: "TEXT", value: "91001" }, { type: "TEXT", value: "92001" }, { type: "FIXED", value: "2021" }, { type: "FIXED", value: "2025" }])));

  // group query
  const g = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, { kind: "group", codes: ["9100"], fromYear: 2024, toYear: 2024 }, ["dpw_by_line", "surplus"]);
  ok("a group query returns every company row in the group", same(g.fields[0].rows.map((x) => [x.code, x.line, x.value]), [["9100", "Homeowners", 1_300_000], ["9100", "Personal Auto", 400_000]]), g.fields[0].rows);
  ok("a field with no group column says it can't be looked up by group, and sends no SQL", g.fields[1].mapped === false && g.fields[1].error === "This field has no group column mapped, so it can't be looked up by group code." && g.fields[1].rows.length === 0, g.fields[1]);

  // unmapped and hostile
  const before = w.sf.statements.length;
  const partial = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { dpw_by_line: MAPPING.fields.dpw_by_line, surplus: { ...MAPPING.fields.surplus!, view: "X; DROP TABLE Y" }, loss_ratio: { ...MAPPING.fields.loss_ratio!, value: 'a"b' }, combined_ratio: { ...MAPPING.fields.combined_ratio!, year: "A--" } } }, Q, ["dpw_by_line", "surplus", "loss_ratio", "combined_ratio", "npw_by_line"]);
  ok("fields with no mapping, or a mapping with a bad name, are reported as not mapped", same(partial.fields.map((x) => [x.id, x.mapped, x.rows.length > 0]), [["dpw_by_line", true, true], ["surplus", false, false], ["loss_ratio", false, false], ["combined_ratio", false, false], ["npw_by_line", false, false]]), partial.fields.map((x) => [x.id, x.mapped]));
  ok("a hostile mapping sends nothing to Snowflake: only the good field and LOADTRACKER ran", w.sf.statements.length === before + 2 && w.sf.statements.slice(before).every((s) => !/DROP|--|a"b/.test(s.statement)), w.sf.statements.slice(before).map((s) => s.statement));

  // a where value that looks like SQL is only ever a value
  const evil = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { dpw_by_line: { ...MAPPING.fields.dpw_by_line!, where: [{ column: "BASIS", equals: "Direct' OR '1'='1" }] } } }, Q, ["dpw_by_line"]);
  const last = w.sf.statements.findLast((s) => s.statement.includes("IR_PREM_LINE WHERE"))!;
  ok("a where value that looks like SQL is bound as a value and matches nothing", evil.fields[0].error === null && evil.fields[0].rows.length === 0 && !last.statement.includes("OR '1'") && last.bindings.at(-1)!.value === "Direct' OR '1'='1", { rows: evil.fields[0].rows.length, statement: last.statement });
  ok("when nothing ran, LOADTRACKER isn't asked", await (async () => { const n = w.sf.statements.length; const none = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: {} }, Q, ["surplus"]); return w.sf.statements.length === n && same(none.loaded, []) && none.fields[0].mapped === false; })());

  // hostile database or schema names from the secrets
  for (const [db, schema] of [["MI; DROP DATABASE X", "XPRESSFEED"], ["MI_XPRESSCLOUD", 'XP"; --']]) {
    const n = w.sf.statements.length;
    const out = await runStatutory(w.api, db, schema, MAPPING, Q, ["dpw_by_line"]);
    ok(`a database/schema of ${JSON.stringify([db, schema])} sends no SQL`, w.sf.statements.length === n && out.fields[0].rows.length === 0, w.sf.statements.slice(n).map((s) => s.statement));
    ok(`and the reason given for ${JSON.stringify([db, schema])} is about the database or schema name, not about a missing company column`, !/no company column mapped/.test(out.fields[0].error ?? "") && /database|schema/i.test(out.fields[0].error ?? ""), out.fields[0].error);
  }
}
{
  // failures that stop the whole query
  for (const [status, code] of [[401, "signin"], [500, "server"], [408, "timeout"]] as const) {
    const w = world(PAT, { tables: TABLES, loaded: LOADED });
    w.sf.failNext.push({ status, body: { message: "nope" } });
    const e = await caught(runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, Q, ["dpw_by_line", "surplus"]));
    ok(`a ${status} from Snowflake fails the whole query with a plain "${code}" message, not field by field`, e instanceof SnowflakeError && e.code === code && w.sf.log.length === 1, e?.message);
  }
  let w = world(PAT, { tables: TABLES });   // no LOADTRACKER in this account
  let r = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, Q, ["dpw_by_line"]);
  ok("a LOADTRACKER that can't be read never fails the query", r.fields[0].rows.length === 3 && same(r.loaded, []), r.loaded);
  w = world(PAT, { tables: TABLES, loaded: LOADED });
  ok("loadedAt asks for view names in upper case and binds them", same(await loadedAt(w.api, "MI_XPRESSCLOUD", "XPRESSFEED", ["ir_prem_line"]), [{ view: "IR_PREM_LINE", at: "2026-11-01T04:00:00" }]) && same(w.sf.statements[0].bindings, [{ type: "TEXT", value: "IR_PREM_LINE" }]) && !w.sf.statements[0].statement.includes("IR_PREM_LINE"));
  ok("loadedAt with a bad database name asks nothing", same(await loadedAt(w.api, "X; DROP", "XPRESSFEED", ["A"]), []) && w.sf.statements.length === 1);
  w = world(PAT, { tables: { BIG: Array.from({ length: 20_500 }, (_, i) => ({ NAIC_CD: "91001", STMT_YEAR: 2024, V: i })) }, partitionSize: 7000 });
  r = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { surplus: { view: "BIG", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "V" } } }, Q, ["surplus"]);
  ok("the SQL's own LIMIT keeps a huge view to 20,000 rows", r.fields[0].rows.length === 20_000, r.fields[0].rows.length);
  w = world(PAT, { on: () => ({ columns: ["CODE", "NAME", "YR", "LINE", "STATE", "VAL"], rows: [["91001", "Calloway Insurance Co", "2024", null, null, "12.5"], [" 91001 ", null, "not-a-year", null, null, "1"], ["91001", null, "2023", null, null, "abc"]] }) });
  r = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, Q, ["surplus"]);
  ok("a row with no usable year is dropped, and a value that isn't a number is null", same(r.fields[0].rows, [{ code: "91001", year: 2024, line: null, state: null, value: 12.5 }, { code: "91001", year: 2023, line: null, state: null, value: null }]), r.fields[0].rows);
}

// ---------- discover ----------
{
  const views = [{ name: "LOADTRACKER" }, { name: "IR_STAT_PREM_STATE", comment: "Made-up comment" }, { name: "CIQ_COMPANY", type: "BASE TABLE" }];
  const w = world(PAT, { tables: TABLES, views });
  const all = await discoverViews(w.api, w.creds.database, w.creds.schema);
  ok("discover lists the views this account can see, by name", same(all.views.map((v) => v.name), ["CIQ_COMPANY", "IR_PREM_LINE", "IR_RATIOS", "IR_STAT_PREM_STATE", "LOADTRACKER", "ir_surplus_mixed"]) && all.truncated === false, all.views.map((v) => v.name));
  ok("each view carries its type and comment", same(all.views.find((v) => v.name === "IR_STAT_PREM_STATE"), { name: "IR_STAT_PREM_STATE", type: "VIEW", comment: "Made-up comment" }) && all.views.find((v) => v.name === "CIQ_COMPANY")!.type === "BASE TABLE");
  const s0 = w.sf.statements[0];
  ok("the list comes from INFORMATION_SCHEMA.TABLES, filtered by schema with a bound value", /^SELECT TABLE_NAME, TABLE_TYPE, COMMENT FROM MI_XPRESSCLOUD\.INFORMATION_SCHEMA\.TABLES WHERE TABLE_SCHEMA = \? ORDER BY TABLE_NAME LIMIT 5000$/.test(s0.statement) && same(s0.bindings, [{ type: "TEXT", value: "XPRESSFEED" }]), s0);
  const some = await discoverViews(w.api, w.creds.database, w.creds.schema, "ratio");
  ok("a name filter narrows the list, whatever its case", same(some.views.map((v) => v.name), ["IR_RATIOS"]) && w.sf.statements[1].statement.includes("AND TABLE_NAME ILIKE ?") && same(w.sf.statements[1].bindings[1], { type: "TEXT", value: "%ratio%" }), w.sf.statements[1]);
  const under = await discoverViews(w.api, w.creds.database, w.creds.schema, "STAT_PREM");
  ok("a name filter with an underscore finds the views whose names contain it", same(under.views.map((v) => v.name), ["IR_STAT_PREM_STATE"]), { found: under.views.map((v) => v.name), bound: w.sf.statements.at(-1)!.bindings[1] });
  const pct = await discoverViews(w.api, w.creds.database, w.creds.schema, "%");
  ok("a filter of % alone can't be used to mean everything by accident: it is bound, not pasted", w.sf.statements.at(-1)!.statement.includes("ILIKE ?") && !w.sf.statements.at(-1)!.statement.includes("%"), w.sf.statements.at(-1));
  ok("a filter that looks like SQL is only ever a bound value", await (async () => { await discoverViews(w.api, w.creds.database, w.creds.schema, "x' OR '1'='1"); const s = w.sf.statements.at(-1)!; return !s.statement.includes("OR '1'") && s.bindings[1].value.includes("x' OR '1'='1"); })());
  const other = await discoverViews(w.api, w.creds.database, "OTHER_SCHEMA");
  ok("another schema's views aren't listed", other.views.length === 0 && w.sf.statements.at(-1)!.bindings[0].value === "OTHER_SCHEMA", pct.views.length);
  const e = await caught(discoverViews(w.api, "X; DROP DATABASE Y", "XPRESSFEED"));
  const n = w.sf.statements.length;
  ok("a database name that isn't a name is refused before anything is sent", e instanceof SnowflakeError && e.message === "SNOWFLAKE_DATABASE isn't a valid name." && w.sf.statements.length === n, e?.message);

  const cols = await discoverColumns(w.api, w.creds.database, w.creds.schema, "IR_RATIOS");
  ok("discover lists one view's columns in order, with types", cols.view === "IR_RATIOS" && same(cols.columns.map((c) => [c.name, c.type, c.position]), [["NAIC_CD", "TEXT", 1], ["PERIOD_END", "TEXT", 2], ["LOSS_RATIO", "NUMBER", 3], ["COMBINED", "NUMBER", 4]]), cols.columns);
  const sc = w.sf.statements.at(-1)!;
  ok("the columns come from INFORMATION_SCHEMA.COLUMNS with the schema and view bound", /^SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION, COMMENT FROM MI_XPRESSCLOUD\.INFORMATION_SCHEMA\.COLUMNS WHERE TABLE_SCHEMA = \? AND TABLE_NAME = \? ORDER BY ORDINAL_POSITION$/.test(sc.statement) && same(sc.bindings, [{ type: "TEXT", value: "XPRESSFEED" }, { type: "TEXT", value: "IR_RATIOS" }]), sc);
  const quoted = await discoverColumns(w.api, w.creds.database, w.creds.schema, '"ir_surplus_mixed"');
  ok("a view named in double quotes is looked up in its exact case", quoted.view === "ir_surplus_mixed" && same(quoted.columns.map((c) => c.name), ["naic", "yr", "phs"]), quoted);
  const lower = await discoverColumns(w.api, w.creds.database, w.creds.schema, "ir_ratios");
  ok("a view typed in lower case without quotes is looked up the way Snowflake stores it, in upper case", lower.columns.length === 4, { bound: w.sf.statements.at(-1)!.bindings[1], columns: lower.columns.length });
  ok("the stand-in's ILIKE treats _ as one character and % as any run, as Snowflake does", ilike("IR_STAT_PREM", "%stat_prem%") && ilike("IRXSTATXPREM", "%STAT_PREM%") && !ilike("IR_STATPREM", "%STAT_PREM%") && ilike("abc", "%") && !ilike("abc", "b"));
}

done();
