// The snl-statutory function end to end, through handle(): what it says before Snowflake is set up and before
// the fields are mapped, a query against made-up views, saved results, Discover (Corp Dev only), hostile
// mappings and codes, and what each Snowflake failure looks like to the page.
(globalThis as any).__SNL_TEST__ = true;
const statutory = await import(new URL("../../supabase/functions/snl-statutory/index.ts", import.meta.url).href);
const { SNOWFLAKE_NOT_CONFIGURED, SnowflakeError } = await import(new URL("../../supabase/functions/_shared/snowflake.ts", import.meta.url).href);
import { checks, corpdev, env, fakeClock, memoryDb, reader, req } from "./helpers/fakes.ts";
import { fakeSnowflake, makeKeyPair, type SfOpts } from "./helpers/snowflake.ts";
import { watchStore } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PAT = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
const TABLES = {
  IR_PREM_LINE: [
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2023, LOB: "Homeowners", ST: "FL", DPW_000: 1200.5 },
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "FL", DPW_000: 1300 },
    { NAIC_CD: "92001", GRP_CD: null, CO_NAME: "Tarrow Mutual Insurance Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "FL", DPW_000: null },
    { NAIC_CD: "93001", GRP_CD: "9300", CO_NAME: "Not Asked For Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "FL", DPW_000: 777 },
  ],
  IR_SURPLUS: [{ NAIC_CD: "91001", STMT_YEAR: 2024, PHS_000: 5000 }, { NAIC_CD: "92001", STMT_YEAR: 2024, PHS_000: 250 }],
};
const MAPPING = { fields: {
  dpw_by_line: { view: "IR_PREM_LINE", entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "DPW_000", line: "LOB", scale: 1000 },
  surplus: { view: "IR_SURPLUS", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "PHS_000", scale: 1000 },
  loss_ratio: { view: "IR_RATIOS_NOT_THERE", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "LR" },
} };
const QUERY = { action: "query", codes: ["91001", "92001"], fromYear: 2023, toYear: 2024 };

function world(secrets: Record<string, string> = PAT, opts: SfOpts & { mapping?: unknown } = { tables: TABLES, loaded: { IR_PREM_LINE: "2026-11-01T04:00:00", IR_SURPLUS: "2026-10-20T04:00:00" } }) {
  const clock = fakeClock(), db = memoryDb(clock), sf = fakeSnowflake(clock, opts);
  if (opts.mapping !== null) db.settings.set("statutory_mapping", (opts.mapping ?? MAPPING) as Record<string, unknown>);
  const deps = { env: env(secrets), fetch: sf.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown, over: Record<string, unknown> = {}) => { const res: Response = await statutory.handle(req("snl-statutory", body), { ...deps, ...over }); return { res, status: res.status, body: await res.json() }; };
  return { clock, db, sf, deps, call };
}

// ---------- before Snowflake is set up ----------
{
  const w = world({}, { mapping: null });
  const s = await w.call({ action: "status" });
  ok("status says statutory data isn't set up yet, in plain words", s.status === 200 && s.body.configured === false && s.body.mapped === false && s.body.message === SNOWFLAKE_NOT_CONFIGURED, s.body);
  ok("status lists every field (the eight the view shows and ten for company profiles), none mapped", s.body.fields.length === 18 && s.body.fields.every((f: any) => f.mapped === false && f.label && f.unit && f.by), s.body.fields);
  const q = await w.call(QUERY);
  ok("a query answers 503 not_configured with the same message", q.status === 503 && q.body.error === "not_configured" && q.body.message === SNOWFLAKE_NOT_CONFIGURED, q.body);
  const d = await w.call({ action: "discover" });
  ok("Discover answers 503 not_configured for a Corp Dev login", d.status === 503 && d.body.error === "not_configured" && d.body.message === SNOWFLAKE_NOT_CONFIGURED, d.body);
  const r = await w.call({ action: "discover" }, { whoIs: reader });
  ok("Discover answers 403 forbidden for a reader", r.status === 403 && r.body.error === "forbidden" && r.body.message === "Only Corp Dev logins can run Discover.", r.body);
  ok("a reader's 403 says nothing about whether Snowflake is set up", same(Object.keys(r.body).sort(), ["error", "message"]) && !/set up|Snowflake/i.test(r.body.message));
  ok("a reader may still read status and run a query (and gets the same not-set-up answer)", (await w.call({ action: "status" }, { whoIs: reader })).status === 200 && (await w.call(QUERY, { whoIs: reader })).status === 503);
  ok("nothing was sent to Snowflake", w.sf.log.length === 0);
  const half = world({ SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl" });
  ok("an account and user with no key, token or warehouse is not set up", (await half.call({ action: "status" })).body.configured === false && (await half.call(QUERY)).status === 503);
  const withMap = world({});
  const s2 = await withMap.call({ action: "status" });
  ok("a mapping saved before Snowflake is set up shows as mapped, with the not-set-up message", s2.body.configured === false && s2.body.mapped === true && s2.body.message === SNOWFLAKE_NOT_CONFIGURED);
}

// ---------- set up but not mapped ----------
{
  const w = world(PAT, { tables: TABLES, mapping: null });
  const s = await w.call({ action: "status" });
  ok("with Snowflake connected and nothing mapped, status says so and who can fix it", s.body.configured === true && s.body.mapped === false && s.body.message === statutory.NOT_MAPPED && statutory.NOT_MAPPED.includes("Corp Dev login"), s.body.message);
  const q = await w.call(QUERY);
  ok("a query then answers 409 not_mapped", q.status === 409 && q.body.error === "not_mapped" && q.body.message === statutory.NOT_MAPPED && w.sf.log.length === 0, q.body);
  for (const [name, mapping] of [["an empty mapping", { fields: {} }], ["a mapping with no fields key", { note: "x" }], ["a mapping whose only field has a hostile view name", { fields: { surplus: { view: "X; DROP TABLE Y", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "PHS" } } }],
    ["a mapping whose only field has a quote in a column name", { fields: { surplus: { view: "IR_SURPLUS", entity: { company: 'a"b' }, year: "STMT_YEAR", value: "PHS" } } }], ["a mapping whose only field has a comment in a column name", { fields: { surplus: { view: "IR_SURPLUS", entity: { company: "NAIC_CD" }, year: "A--", value: "PHS" } } }],
    ["a mapping for a field the app doesn't have", { fields: { ebitda: { view: "IR_SURPLUS", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "PHS" } } }]] as const) {
    const h = world(PAT, { tables: TABLES, mapping });
    const r = await h.call(QUERY);
    ok(`${name} counts as not mapped, and nothing is sent to Snowflake`, r.status === 409 && r.body.error === "not_mapped" && h.sf.log.length === 0 && (await h.call({ action: "status" })).body.mapped === false, r.body);
  }
}

// ---------- a query ----------
{
  const w = world();
  const saved = watchStore(w.db);
  const t0 = w.clock.now;
  const r = await w.call(QUERY);
  const f = (id: string) => r.body.fields.find((x: any) => x.id === id);
  ok("a query answers 200 with one entry for each of the eight fields", r.status === 200 && r.body.fields.length === 8 && r.body.kind === "company" && same(r.body.codes, ["91001", "92001"]) && r.body.fromYear === 2023 && r.body.toYear === 2024, r.body);
  ok("mapped fields carry rows for the codes and years asked, scaled", same(f("dpw_by_line").rows, [{ code: "91001", year: 2023, line: "Homeowners", state: null, value: 1_200_500 }, { code: "91001", year: 2024, line: "Homeowners", state: null, value: 1_300_000 }, { code: "92001", year: 2024, line: "Homeowners", state: null, value: null }])
    && same(f("surplus").rows.map((x: any) => x.value), [5_000_000, 250_000]), f("dpw_by_line").rows);
  ok("a null value stays null", f("dpw_by_line").rows[2].value === null);
  ok("unmapped fields are reported as mapped:false with no rows and no error", ["npw_by_line", "dpw_by_state", "expense_ratio", "combined_ratio"].every((id) => f(id).mapped === false && f(id).rows.length === 0 && f(id).error === null));
  ok("a field whose view doesn't exist reports the failure on that field only", f("loss_ratio").mapped === true && /Snowflake couldn't run the query \(422\)/.test(f("loss_ratio").error) && /Check this field's mapping\.$/.test(f("loss_ratio").error) && f("surplus").error === null, f("loss_ratio"));
  ok("company names come back for the codes asked", same(r.body.entities, [{ code: "91001", name: "Calloway Insurance Co" }, { code: "92001", name: "Tarrow Mutual Insurance Co" }]));
  ok("LOADTRACKER supplies when each view was loaded", same(r.body.loaded, [{ view: "IR_PREM_LINE", at: "2026-11-01T04:00:00" }, { view: "IR_SURPLUS", at: "2026-10-20T04:00:00" }]), r.body.loaded);
  ok("the answer says where it came from and that it is fresh and saved", r.body.source.includes("SNL Insurance Regulatory Data") && r.body.fromStore === false && r.body.saved === true && r.body.fetchedAt === new Date(t0).toISOString());
  ok("the saved row passes the database's checks", saved.length === 1 && saved[0].kind === "statutory" && saved[0].problem === null && /^statutory:[0-9a-f]{32}$/.test(saved[0].id), saved);
  ok("the SQL was sent with the codes and years bound, not written in", w.sf.statements.length === 4 && w.sf.statements.every((s) => !/91001|92001|2023|2024/.test(s.statement)) && same(w.sf.statements[0].bindings, [{ type: "TEXT", value: "91001" }, { type: "TEXT", value: "92001" }, { type: "FIXED", value: "2023" }, { type: "FIXED", value: "2024" }]), w.sf.statements.map((s) => s.statement));
  ok("Snowflake was sent the SQL API's headers and the default database, schema and role", w.sf.log.every((c) => c.headers.authorization === "Bearer test-pat-not-a-secret" && c.headers["x-snowflake-authorization-token-type"] === "PROGRAMMATIC_ACCESS_TOKEN" && c.headers.accept === "application/json")
    && w.sf.statements.every((s) => s.body.database === "MI_XPRESSCLOUD" && s.body.schema === "XPRESSFEED" && s.body.role === "XF_SNOWFLAKE_READER_ROLE" && s.body.warehouse === "WH_TEST"));

  const n = w.sf.log.length;
  w.clock.now += 3600_000;
  const again = await w.call({ ...QUERY, codes: ["92001", "91001", "91001"] });
  ok("the same query opens from the store without asking Snowflake", again.status === 200 && again.body.fromStore === true && again.body.saved === true && w.sf.log.length === n && again.body.fetchedAt === new Date(t0).toISOString() && same(again.body.fields, r.body.fields), { calls: w.sf.log.length - n });
  const fresh = await w.call({ ...QUERY, refresh: true });
  ok("refresh asks Snowflake again", fresh.body.fromStore === false && w.sf.log.length === n + 4 && fresh.body.fetchedAt === new Date(w.clock.now).toISOString());
  const other = await w.call({ ...QUERY, fields: ["surplus"] });
  ok("a different set of fields is a different saved result", other.body.fromStore === false && other.body.fields.length === 1 && other.body.fields[0].id === "surplus");
  ok("a reader may run a query", (await w.call({ ...QUERY, toYear: 2025 }, { whoIs: reader })).status === 200);
  const grp = await w.call({ action: "query", kind: "group", codes: ["9100"], fromYear: 2024, toYear: 2024, fields: ["dpw_by_line", "surplus"] });
  ok("a group query uses the group column, and says which fields can't be looked up by group", same(grp.body.fields[0].rows.map((x: any) => [x.code, x.value]), [["9100", 1_300_000]]) && grp.body.fields[1].mapped === false && /no group column mapped/.test(grp.body.fields[1].error), grp.body.fields);

  // saved results still open when Snowflake is later not set up; a changed or removed mapping is a new query
  const off = world({});
  for (const [id, row] of w.db.store) off.db.store.set(id, row);
  const opened = await off.call(QUERY);
  ok("a saved result still opens when Snowflake isn't set up", opened.status === 200 && opened.body.fromStore === true && opened.body.fields.length === 8 && off.sf.log.length === 0);
  const unmapped = world({}, { mapping: null });
  for (const [id, row] of w.db.store) unmapped.db.store.set(id, row);
  ok("a result saved under a mapping that has since been removed is not reopened", (await unmapped.call(QUERY)).status === 503 && unmapped.sf.log.length === 0);
  ok("but refresh then answers 503 not_configured", (await off.call({ ...QUERY, refresh: true })).status === 503);

  for (const [name, body, says] of [["no codes", { codes: [] }, /1 to 8 NAIC codes/], ["a code that carries SQL", { codes: ["91001' OR '1'='1"] }, /1 to 8 NAIC codes/], ["a code with a semicolon", { codes: ["1;2"] }, /1 to 8 NAIC codes/], ["nine codes", { codes: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }, /1 to 8 NAIC codes/],
    ["a year that carries SQL", { toYear: "2024 OR 1=1" }, /Years must be whole years/], ["a year in the future", { toYear: 2027 }, /Years must be whole years/], ["sixteen years", { fromYear: 2009, toYear: 2024 }, /at most 15/], ["an unknown kind", { kind: "holding" }, /kind must be/], ["an unknown field", { fields: ["surplus; DROP"] }, /fields must be from/]] as const) {
    const calls = w.sf.log.length;
    const bad = await w.call({ ...QUERY, ...body });
    ok(`a query with ${name} is refused with a plain reason and Snowflake isn't asked`, bad.status === 400 && bad.body.error === "bad" && says.test(bad.body.message) && w.sf.log.length === calls, bad.body);
  }
  ok("a bad query is refused the same way before Snowflake is set up", (await off.call({ ...QUERY, codes: ["x"] })).status === 400);
}

// ---------- key-pair sign-in through the function ----------
{
  const key = await makeKeyPair(), other = await makeKeyPair();
  const secrets = { SNOWFLAKE_ACCOUNT: "ab12345.us-east-1", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PRIVATE_KEY: key.pem.replace(/\n/g, "\\n") };
  const w = world(secrets, { host: "ab12345.us-east-1.snowflakecomputing.com", tables: TABLES, auth: { publicKey: key.publicKey, account: "ab12345", user: "svc_snl" } });
  const r = await w.call(QUERY);
  ok("with a private key the function signs in with a JWT that Snowflake's check accepts", r.status === 200 && w.sf.authFailures.length === 0 && r.body.fields.find((f: any) => f.id === "surplus").rows.length === 2, { status: r.status, body: r.body.message, failures: w.sf.authFailures });
  ok("the JWT names ACCOUNT.USER in upper case without the region", w.sf.lastClaims?.sub === "AB12345.SVC_SNL" && w.sf.lastClaims?.iss === `AB12345.SVC_SNL.SHA256:${key.fingerprint}`, w.sf.lastClaims);
  const bad = world({ ...secrets, SNOWFLAKE_PRIVATE_KEY: other.pem }, { host: "ab12345.us-east-1.snowflakecomputing.com", tables: TABLES, auth: { publicKey: key.publicKey, account: "ab12345", user: "svc_snl" } });
  const e = await bad.call(QUERY);
  ok("a key Snowflake doesn't know fails the whole query as a sign-in problem, in plain words", e.status === 502 && e.body.error === "snowflake_signin" && e.body.message.startsWith("Snowflake didn't accept the sign-in (401). Check SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER and the key or token on Supabase."), e.body);
  ok("a failed sign-in is not saved as a result and is tried once", bad.db.store.size === 0 && bad.sf.log.length === 1);
  ok("the answer never repeats the key", !JSON.stringify(e.body).includes(other.pem.slice(40, 80)));
  const garbage = world({ ...secrets, SNOWFLAKE_PRIVATE_KEY: "not-a-key" }, { tables: TABLES });
  const g = await garbage.call(QUERY);
  ok("an unreadable private key is a plain sign-in problem too, and nothing is sent", g.status === 502 && g.body.error === "snowflake_signin" && /SNOWFLAKE_PRIVATE_KEY/.test(g.body.message) && garbage.sf.log.length === 0, g.body);
}

// ---------- what each Snowflake failure looks like to the page ----------
{
  for (const [sfStatus, status, error, says] of [[401, 502, "snowflake_signin", /didn't accept the sign-in/], [500, 502, "snowflake_server", /Snowflake answered 500/], [503, 502, "snowflake_server", /Snowflake answered 503/], [408, 502, "snowflake_timeout", /ran out of time/]] as const) {
    const w = world();
    w.sf.failNext.push({ status: sfStatus, body: { message: "detail" } });
    const r = await w.call(QUERY);
    ok(`a Snowflake ${sfStatus} reaches the page as ${status} ${error} with a plain message`, r.status === status && r.body.error === error && says.test(r.body.message), r.body);
    ok(`after a Snowflake ${sfStatus} nothing is saved`, w.db.store.size === 0);
  }
  let w = world();
  w.sf.failNext.push({ status: 429 });
  let r = await w.call(QUERY);
  ok("one 429 from Snowflake is absorbed: the function waits and the query succeeds", r.status === 200 && w.clock.slept.includes(3000), { status: r.status, slept: w.clock.slept });
  w = world();
  w.sf.failNext.push({ status: 429 }, { status: 429 });
  r = await w.call(QUERY);
  ok("two 429s reach the page as 429 snowflake_busy", r.status === 429 && r.body.error === "snowflake_busy" && r.body.message === "Snowflake is busy (429). Wait a minute and try again.", r.body);
  w = world();
  r = await w.call(QUERY, { fetch: (() => Promise.reject(new TypeError("socket hang up"))) as unknown as typeof fetch });
  ok("Snowflake unreachable reaches the page as a plain network message", r.status === 502 && r.body.error === "snowflake_network" && r.body.message === "Couldn't reach Snowflake. Try again in a few minutes.", r.body);
  w = world();
  w.sf.slowNext = 10_000;
  r = await w.call(QUERY);
  ok("a query that never finishes reaches the page as a timeout, and is cancelled", r.status === 502 && r.body.error === "snowflake_timeout" && w.sf.cancelled.length === 1, r.body);
  ok("snowflakeAnswer leaves other errors alone", statutory.snowflakeAnswer(new Error("x")) === null && statutory.snowflakeAnswer(new SnowflakeError("not_configured", "m")).status === 503);

  // Corp Dev sees "Check this field's mapping", corrects the mapping, and runs the same query again.
  w = world(PAT, { tables: TABLES, mapping: { fields: { surplus: { ...MAPPING.fields.surplus, value: "PHS_TYPO" } } } });
  r = await w.call({ ...QUERY, fields: ["surplus"] });
  ok("when a mapped field's SQL fails, the answer still comes back with the reason on that field", r.status === 200 && /422/.test(r.body.fields[0].error) && /invalid identifier 'PHS_TYPO'/.test(r.body.fields[0].error), r.body.fields?.[0]);
  w.db.settings.set("statutory_mapping", { fields: { surplus: MAPPING.fields.surplus } });
  const again = await w.call({ ...QUERY, fields: ["surplus"] });
  ok("after the mapping is corrected, the same query uses the new mapping instead of reopening the failed result", again.body.fields[0].error === null && again.body.fields[0].rows.length === 2, { fromStore: again.body.fromStore, field: again.body.fields[0] });
}

// ---------- hostile database and schema secrets ----------
{
  for (const [name, extra] of [["SNOWFLAKE_DATABASE", { SNOWFLAKE_DATABASE: "MI; DROP DATABASE X" }], ["SNOWFLAKE_SCHEMA", { SNOWFLAKE_SCHEMA: 'X" OR "1"="1' }]] as const) {
    const w = world({ ...PAT, ...extra });
    const r = await w.call(QUERY);
    ok(`a ${name} that isn't a name never reaches SQL`, w.sf.statements.every((s) => !/DROP|OR "1"/.test(s.statement)), w.sf.statements.map((s) => s.statement));
    ok(`and no rows are passed off as a result for it`, r.status !== 200 || r.body.fields.every((f: any) => f.rows.length === 0), r.body);
  }
  const w = world({ ...PAT, SNOWFLAKE_DATABASE: "MI; DROP DATABASE X" });
  const d = await w.call({ action: "discover" });
  ok("Discover with a database that isn't a name is refused in plain words, and nothing is sent", d.status === 502 && d.body.error === "snowflake_sql" && d.body.message === "SNOWFLAKE_DATABASE isn't a valid name." && w.sf.log.length === 0, d.body);
}

// ---------- Discover ----------
{
  const w = world(PAT, { tables: TABLES, views: [{ name: "LOADTRACKER" }, { name: "IR_STAT_PREM_STATE" }, { name: "IR$ODD" }] });
  const saved = watchStore(w.db);
  const all = await w.call({ action: "discover" });
  ok("Discover lists the views a Corp Dev login's account can see", all.status === 200 && same(all.body.views.map((v: any) => v.name), ["IR$ODD", "IR_PREM_LINE", "IR_STAT_PREM_STATE", "IR_SURPLUS", "LOADTRACKER"]) && all.body.fromStore === false && all.body.truncated === false, all.body);
  ok("it asks INFORMATION_SCHEMA.TABLES, filtered by the schema as a bound value", w.sf.statements[0].statement.includes("INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?") && same(w.sf.statements[0].bindings, [{ type: "TEXT", value: "XPRESSFEED" }]));
  const again = await w.call({ action: "discover" });
  ok("the list opens from the store the second time", again.body.fromStore === true && w.sf.statements.length === 1 && again.body.views.length === 5);
  const fresh = await w.call({ action: "discover", refresh: true });
  ok("refresh asks Snowflake again", fresh.body.fromStore === false && w.sf.statements.length === 2);
  const some = await w.call({ action: "discover", like: "surplus" });
  ok("a name filter narrows the list", same(some.body.views.map((v: any) => v.name), ["IR_SURPLUS"]) && same(w.sf.statements.at(-1)!.bindings, [{ type: "TEXT", value: "XPRESSFEED" }, { type: "TEXT", value: "%surplus%" }]), some.body.views);
  const under = await w.call({ action: "discover", like: "STAT_PREM" });
  ok("a name filter with an underscore, as in most view names, finds the view", same(under.body.views.map((v: any) => v.name), ["IR_STAT_PREM_STATE"]), { found: under.body.views, bound: w.sf.statements.at(-1)!.bindings });
  const hostile = await w.call({ action: "discover", like: "x'; DROP TABLE y; --%" });
  ok("a filter that carries SQL is cleaned and bound, never written into the SQL", hostile.status === 200 && !/DROP|--|'/.test(w.sf.statements.at(-1)!.statement) && !/[';% -]/.test(w.sf.statements.at(-1)!.bindings[1].value.slice(1, -1)), w.sf.statements.at(-1));
  await w.call({ action: "discover", like: "IR$" });

  const cols = await w.call({ action: "discover", view: "IR_PREM_LINE" });
  ok("Discover lists one view's columns", cols.status === 200 && cols.body.view === "IR_PREM_LINE" && same(cols.body.columns.map((c: any) => c.name), ["NAIC_CD", "GRP_CD", "CO_NAME", "STMT_YEAR", "LOB", "ST", "DPW_000"]) && cols.body.columns[0].position === 1 && cols.body.fromStore === false, cols.body);
  ok("it asks INFORMATION_SCHEMA.COLUMNS with the schema and view as bound values", w.sf.statements.at(-1)!.statement.includes("INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?") && same(w.sf.statements.at(-1)!.bindings.map((b) => b.value), ["XPRESSFEED", "IR_PREM_LINE"]) && !w.sf.statements.at(-1)!.statement.includes("IR_PREM_LINE"));
  const n = w.sf.statements.length;
  ok("a view's columns open from the store the second time", (await w.call({ action: "discover", view: " IR_PREM_LINE " })).body.fromStore === true && w.sf.statements.length === n);
  for (const view of ["X; DROP TABLE Y", 'a"b', "A--", "A.B", "", "  ", "A B", "(SELECT 1)", 42.5, ["A", "B"], { name: "A" }]) {
    const calls = w.sf.log.length;
    const bad = await w.call({ action: "discover", view });
    ok(`Discover with view ${JSON.stringify(view)} is refused and nothing is sent`, bad.status === 400 && bad.body.message === "view must be a view name." && w.sf.log.length === calls, bad.body);
  }
  ok("everything Discover saved passes the database's checks on saved rows", saved.length >= 5 && saved.every((x) => x.problem === null), saved.filter((x) => x.problem));
  ok("two different views never share one saved entry", await (async () => {
    const x = world(PAT, { tables: { "IR$A": [{ ONLY_IN_DOLLAR: 1 }], IR_A: [{ ONLY_IN_UNDERSCORE: 1 }] } });
    const a = await x.call({ action: "discover", view: "IR$A" }), b = await x.call({ action: "discover", view: "IR_A" });
    return a.body.columns[0]?.name === "ONLY_IN_DOLLAR" && b.body.columns[0]?.name === "ONLY_IN_UNDERSCORE";
  })(), "IR$A and IR_A are both saved as discover:cols.IR_A, so the second shows the first one's columns");

  // readers
  const calls = w.sf.log.length;
  for (const [name, body] of [["the view list", { action: "discover" }], ["a saved view list", { action: "discover", like: "surplus" }], ["a view's columns", { action: "discover", view: "IR_PREM_LINE" }], ["a refresh", { action: "discover", refresh: true }], ["a bad view name", { action: "discover", view: "A--" }]] as const) {
    const r = await w.call(body, { whoIs: reader });
    ok(`a reader asking Discover for ${name} gets 403 and learns nothing`, r.status === 403 && r.body.error === "forbidden" && same(Object.keys(r.body).sort(), ["error", "message"]) && w.sf.log.length === calls, r.body);
  }
  for (const role of ["", "admin", "CORPDEV", "corpdev "]) ok(`a login whose role is ${JSON.stringify(role)} can't run Discover`, (await w.call({ action: "discover" }, { whoIs: async () => ({ id: "user-3", role }) })).status === 403);

  // saved Discover results before Snowflake is set up
  const off = world({}, { mapping: null });
  for (const [id, row] of w.db.store) off.db.store.set(id, row);
  ok("a saved view list still opens for Corp Dev when Snowflake isn't set up", (await off.call({ action: "discover" })).body.fromStore === true && (await off.call({ action: "discover", view: "IR_PREM_LINE" })).body.columns.length === 7);
  ok("and still 403 for a reader", (await off.call({ action: "discover" }, { whoIs: reader })).status === 403);
}

done();
