// The Combination view's state map, the function side: the one figure added for it, direct premiums written by state
// and line together (dpw_by_state_line, an app-level name the owner maps). Covers: the figure and its kind; that it is
// never asked for by default, by a profile or by Claude; the mapping checks (a good mapping, and each kind of bad one);
// the SQL it makes (both columns selected, one year, everything typed bound); rows that carry both a state and a line;
// a result cut at the 20,000-row limit marked as cut; and the snl-statutory function answering it alone, for one year,
// saved for that company as any figure is. Every view, column, company and figure here is made up.
(globalThis as any).__SNL_TEST__ = true;
const statutory = await import(new URL("../../supabase/functions/snl-statutory/index.ts", import.meta.url).href);
const profile = await import(new URL("../../supabase/functions/snl-profile/index.ts", import.meta.url).href);
import { Snowflake, snowflakeCreds } from "../../supabase/functions/_shared/snowflake.ts";
import { buildSql, DEFAULT_STAT_FIELDS, type FieldMap, fieldStatus, MAP_ONLY_FIELDS, mapProblem, type Mapping, parseStatQuery, runStatutory, STAT_FIELDS, type StatQuery } from "../../supabase/functions/_shared/statutory.ts";
import * as P from "../../supabase/functions/_shared/profile.ts";
import { CLAUDE_STAT_IDS, statFieldsFrom, TOOLS } from "../../supabase/functions/_shared/chat.ts";
import { checks, corpdev, env, fakeClock, memoryDb, req } from "./helpers/fakes.ts";
import { fakeSnowflake, type SfOpts } from "./helpers/snowflake.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PAT = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
const ID = "dpw_by_state_line";

// ---------- the figure ----------
{
  const f = STAT_FIELDS.find((x) => x.id === ID);
  ok("the figure is there: direct premiums written by state and line, in dollars, by state and line", same(f, { id: ID, label: "Direct premiums written by state and line", unit: "usd", by: "state_line" }), f);
  ok("it comes last, so the figures before it keep their order", STAT_FIELDS[STAT_FIELDS.length - 1].id === ID);
  ok("it is asked for only by the map", same(MAP_ONLY_FIELDS, [ID]));
  ok("a query that names no fields doesn't get it", !DEFAULT_STAT_FIELDS.includes(ID as never));
  ok("a profile doesn't ask for it, and asks for every other figure", !P.PROFILE_FIELDS.includes(ID as never) && P.PROFILE_FIELDS.length === STAT_FIELDS.length - 1 && STAT_FIELDS.every((x) => x.id === ID || P.PROFILE_FIELDS.includes(x.id)));
  ok("Claude isn't offered it: not in the tool's list of ids, and refused when written", !CLAUDE_STAT_IDS.includes(ID) && CLAUDE_STAT_IDS.length === STAT_FIELDS.length - 1 && same(statFieldsFrom([ID, "surplus"]), { fields: ["surplus"], bad: [ID] }));
  const tool = JSON.stringify(TOOLS.find((t: any) => t.name === "query_statutory") ?? TOOLS);
  ok("the statutory tool's description doesn't name it", !tool.includes(ID) && tool.includes("dpw_by_state"), tool.slice(0, 200));
  const st = fieldStatus({ fields: {} }).find((x) => x.id === ID)!;
  ok("until the owner maps it, it is not mapped, and that is never an error", st.mapped === false && st.problem === "not mapped");
  const p = parseStatQuery({ kind: "company", codes: ["91001"], fromYear: 2024, toYear: 2024, fields: [ID] }, 2026);
  ok("a query may ask for it by name, alone, for one year", p.ok && same(p.fields, [ID]) && p.q.fromYear === 2024 && p.q.toYear === 2024, p);
  // even a statutory answer that has the figure (not mapped) beside every other one
  const stat = { kind: "company" as const, codes: ["90001"], fromYear: 2020, toYear: 2025, entities: [{ code: "90001", name: "Calloway Insurance Co" }], loaded: [], truncated: false, source: "x",
    fields: STAT_FIELDS.map((x) => ({ id: x.id, label: x.label, unit: x.unit, by: x.by, mapped: false, error: null, rows: [] })) };
  const none = P.factsFrom(stat as any, { name: "Calloway Insurance Co", groupName: null, groupCode: null, companyIds: [], institutionIds: [], members: 0 } as any, { unavailable: P.FILINGS_NOT_SET_UP } as any,
    { kind: "company", code: "90001", asOf: "2026-11-14", fromYear: 2020, toYear: 2025 });
  ok("a profile never lists it as missing", Array.isArray(none.missing) && !none.missing.some((m: any) => m.field === ID) && none.missing.length === P.PROFILE_FIELDS.length, none.missing?.length);
  const s = P.sampleFacts ? JSON.stringify(P.sampleFacts("2026-11-14")) : "";
  ok("the sample profile doesn't carry it either", !s.includes(ID));
}

// ---------- the mapping checks ----------
const GOOD: FieldMap = { view: "IR_PREM_STATE_LINE", entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "DPW_000", state: "ST", line: "LOB", scale: 1000 };
{
  ok("a mapping with both a state and a line column is good", mapProblem(ID, GOOD) === null);
  ok("not there at all: not mapped", mapProblem(ID, undefined) === "not mapped" && mapProblem(ID, "IR_PREM") === "not mapped" && mapProblem(ID, [GOOD]) === "not mapped");
  const { state: _s, ...noState } = GOOD, { line: _l, ...noLine } = GOOD;
  ok("no state column: refused, saying both are needed", mapProblem(ID, noState) === "state must be a column name (a figure by state and line needs both a state and a line column)", mapProblem(ID, noState));
  ok("no line column: refused, saying both are needed", mapProblem(ID, noLine) === "line must be a column name (a figure by state and line needs both a state and a line column)", mapProblem(ID, noLine));
  ok("neither: refused", mapProblem(ID, { ...noState, line: undefined }) !== null);
  ok("the same mapping without a line is still good for premiums by state alone", mapProblem("dpw_by_state", noLine) === null);
  ok("a state or line that isn't a column name is refused", mapProblem(ID, { ...GOOD, state: "ST; DROP" }) === "state must be a column name" && mapProblem(ID, { ...GOOD, line: "LOB--" }) === "line must be a column name");
  ok("a tag is only for a figure by counterparty", mapProblem(ID, { ...GOOD, tag: "KIND" }) === "tag is only for a figure by counterparty (one with an item column)");
  ok("no year or value column: refused as for any figure", mapProblem(ID, { ...GOOD, year: undefined } as never) !== null && mapProblem(ID, { ...GOOD, value: "1x" }) === "value must be a column name");
  ok("with joins, every column must say which view it is in", mapProblem(ID, { ...GOOD, as: "P", joins: [{ view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "P.ENT_ID", right: "E.ENT_ID" }] }] }) === "entity.company must be ALIAS.COLUMN when there are joins");
  const joined: FieldMap = { view: "FIN.PREM_STATE_LINE", as: "P", joins: [{ view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "P.ENT_ID", right: "E.ENT_ID" }] }],
    entity: { company: "E.NAIC_CD", name: "E.CO_NAME" }, year: "P.STMT_YEAR", value: "P.DPW_000", state: "P.ST", line: "P.LOB", where: [{ column: "P.BASIS", equals: "Direct" }], sum: true, stateStrip: "Reported:" };
  ok("a joined mapping that adds up rows is good", mapProblem(ID, joined) === null, mapProblem(ID, joined));
  const status = fieldStatus({ fields: { [ID]: GOOD } } as Mapping).find((x) => x.id === ID)!;
  ok("once mapped, status says so", status.mapped === true && status.problem === null && status.by === "state_line");

  // ---------- the SQL ----------
  const Q1: StatQuery = { kind: "company", codes: ["91001", "91002"], fromYear: 2024, toYear: 2024 };
  const sql = buildSql("MI_XPRESSCLOUD", "XPRESSFEED", GOOD, Q1)!;
  ok("one SELECT with both the state and the line columns, by position as every figure is", sql.statement === "SELECT NAIC_CD AS CODE, CO_NAME AS NAME, STMT_YEAR AS YR, LOB AS LINE, ST AS STATE, DPW_000 AS VAL FROM MI_XPRESSCLOUD.XPRESSFEED.IR_PREM_STATE_LINE WHERE NAIC_CD IN (?, ?) AND STMT_YEAR BETWEEN ? AND ? ORDER BY 1, 3 LIMIT 20000", sql.statement);
  ok("the codes and the one year are bound, never written in", same(sql.bindings, [{ type: "TEXT", value: "91001" }, { type: "TEXT", value: "91002" }, { type: "FIXED", value: "2024" }, { type: "FIXED", value: "2024" }]) && !/91001|2024/.test(sql.statement));
  const j = buildSql("MI_XPRESSCLOUD", "XPRESSFEED", joined, { kind: "company", codes: ["91001"], fromYear: 2025, toYear: 2025 })!;
  ok("joined and added up: grouped by code, name, year, line and state", j.statement === 'SELECT "E".NAIC_CD AS CODE, "E".CO_NAME AS NAME, "P".STMT_YEAR AS YR, "P".LOB AS LINE, "P".ST AS STATE, SUM("P".DPW_000) AS VAL FROM MI_XPRESSCLOUD.FIN.PREM_STATE_LINE AS "P" JOIN MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "E" ON "P".ENT_ID = "E".ENT_ID WHERE "E".NAIC_CD IN (?) AND "P".STMT_YEAR BETWEEN ? AND ? AND "P".BASIS = ? GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 3 LIMIT 20000', j.statement);
  ok("and the where value is bound too", same(j.bindings.map((b) => b.value), ["91001", "2025", "2025", "Direct"]));
  ok("a group look-up needs the group column", buildSql("MI_XPRESSCLOUD", "XPRESSFEED", joined, { kind: "group", codes: ["9100"], fromYear: 2025, toYear: 2025 }) === null);
}

// ---------- rows that carry both ----------
const TABLES = {
  IR_PREM_STATE_LINE: [
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "Reported:FL", DPW_000: 400 },
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, LOB: "Homeowners", ST: "Reported:TX", DPW_000: 250.5 },
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, LOB: "Commercial auto", ST: "Reported:TX", DPW_000: 120 },
    { NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2023, LOB: "Homeowners", ST: "Reported:FL", DPW_000: 380 },
    { NAIC_CD: "92001", GRP_CD: null, CO_NAME: "Tarrow Mutual Insurance Co", STMT_YEAR: 2024, LOB: "Farmowners", ST: "Reported:GA", DPW_000: null },
  ],
};
const MAPPED: Mapping = { fields: { [ID]: { ...GOOD, stateStrip: "Reported:" } } };
function world(opts: SfOpts = { tables: TABLES, loaded: { IR_PREM_STATE_LINE: "2026-11-01T04:00:00" } }) {
  const clock = fakeClock(), sf = fakeSnowflake(clock, opts), creds = snowflakeCreds(env(PAT));
  return { clock, sf, creds, api: new Snowflake(creds, { fetch: sf.fetch, now: clock.fn, sleep: clock.sleep }) };
}
{
  const w = world();
  const r = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPED, { kind: "company", codes: ["91001", "92001"], fromYear: 2024, toYear: 2024 }, [ID]);
  const f = r.fields[0];
  ok("one statement for the figure, one for when it was loaded", w.sf.statements.length === 2 && f.id === ID && f.by === "state_line" && f.error === null);
  ok("each row carries both its state (prefix taken off) and its line, in dollars, the year asked only", same(f.rows, [
    { code: "91001", year: 2024, line: "Homeowners", state: "FL", value: 400_000 }, { code: "91001", year: 2024, line: "Homeowners", state: "TX", value: 250_500 },
    { code: "91001", year: 2024, line: "Commercial auto", state: "TX", value: 120_000 }, { code: "92001", year: 2024, line: "Farmowners", state: "GA", value: null }]), f.rows);
  ok("an empty value stays null, never zero", f.rows[3].value === null);
  ok("the answer isn't marked as cut", r.truncated === false);
}
{
  // a result over the 20,000-row limit: cut, and marked as cut, so the page never shows a part as the whole
  const rows = Array.from({ length: 20_001 }, (_, i) => ["91001", "Calloway Insurance Co", 2024, `Line ${i % 40}`, `S${i}`, 1]);
  const w = world({ partitionSize: 9000, on: (s) => (s.includes("IR_PREM_STATE_LINE") ? { columns: ["CODE", "NAME", "YR", "LINE", "STATE", "VAL"], rows } : undefined) });
  const r = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPED, { kind: "company", codes: ["91001"], fromYear: 2024, toYear: 2024 }, [ID]);
  ok("over 20,000 rows: cut at 20,000 and the answer marked as cut", r.truncated === true && r.fields[0].rows.length === 20_000, { truncated: r.truncated, rows: r.fields[0].rows.length });
}

// ---------- through the statutory function ----------
{
  const clock = fakeClock(), db = memoryDb(clock), sf = fakeSnowflake(clock, { tables: TABLES, loaded: { IR_PREM_STATE_LINE: "2026-11-01T04:00:00" } });
  db.settings.set("statutory_mapping", MAPPED as unknown as Record<string, unknown>);
  const deps = { env: env(PAT), fetch: sf.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown) => { const res: Response = await statutory.handle(req("snl-statutory", body), deps); return { status: res.status, body: await res.json() }; };
  const s = await call({ action: "status" });
  const fs = s.body.fields.find((x: any) => x.id === ID);
  ok("status lists it for Field set-up, mapped, by state and line", s.status === 200 && fs && fs.mapped === true && fs.by === "state_line" && fs.label === "Direct premiums written by state and line", fs);
  const before = sf.statements.length;
  const a = await call({ action: "query", kind: "company", codes: ["91001"], fromYear: 2024, toYear: 2024, fields: [ID] });
  ok("a query for it alone, one year: one figure back, each row with its state and line", a.status === 200 && a.body.fields.length === 1 && a.body.fields[0].id === ID && same(a.body.fields[0].rows.map((x: any) => [x.state, x.line, x.value]), [["FL", "Homeowners", 400_000], ["TX", "Homeowners", 250_500], ["TX", "Commercial auto", 120_000]]) && a.body.pending === 0 && a.body.truncated === false, a.body);
  ok("only that figure's statement ran", sf.statements.slice(before).filter((x) => x.statement.includes("IR_PREM_STATE_LINE")).length === 1);
  const n = sf.statements.length;
  const b = await call({ action: "query", kind: "company", codes: ["91001"], fromYear: 2024, toYear: 2024, fields: [ID] });
  ok("asked again: read from what was saved for that company and year, nothing sent to Snowflake", b.status === 200 && b.body.fromStore === true && sf.statements.length === n);
  const saved = [...db.store.values()].filter((x) => x.kind === "statutory").map((x) => JSON.stringify(x));
  ok("what is saved is that company's own look-up, naming no other", saved.length >= 1 && saved.every((x: string) => x.includes("91001") && !x.includes("92001")), saved.length);
  const c = await call({ action: "query", kind: "company", codes: ["91001"], fromYear: 2023, toYear: 2023, fields: [ID] });
  ok("another year is its own look-up", c.status === 200 && c.body.fromStore === false && same(c.body.fields[0].rows.map((x: any) => [x.year, x.state, x.value]), [[2023, "FL", 380_000]]));
}
{
  // the profile function's status lists only what a profile asks for
  const clock = fakeClock(), db = memoryDb(clock);
  const res: Response = await profile.handle(req("snl-profile", { action: "status" }), { env: env({}), fetch: (() => { throw new Error("no network"); }) as never, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep });
  const body = await res.json();
  ok("the profile's status leaves it out", res.status === 200 && body.statutory.fields.length === P.PROFILE_FIELDS.length && !body.statutory.fields.some((f: any) => f.id === ID), body.statutory?.fields?.length);
}

done();
