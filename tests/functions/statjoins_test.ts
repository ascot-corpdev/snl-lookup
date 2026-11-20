// The statutory mapping for figures spread over several joined views in several schemas: what a mapping may say
// (and every reason one is refused), the exact SQL and bindings it becomes, hostile names and values, results
// through runStatutory against made-up joined views, run dates for each schema, Discover across schemas, and the
// saved-result id. Every schema, view, column, company and figure here is made up.
(globalThis as any).__SNL_TEST__ = true;
const statutory = await import(new URL("../../supabase/functions/snl-statutory/index.ts", import.meta.url).href);
import { Snowflake, snowflakeCreds } from "../../supabase/functions/_shared/snowflake.ts";
import { buildSql, type FieldMap, fieldStatus, loadedBySchema, loadedProblem, mapProblem, type Mapping, readMapping, runStatutory, savedOrFreshStatutory, type StatQuery } from "../../supabase/functions/_shared/statutory.ts";
import { shortHash } from "../../supabase/functions/_shared/http.ts";
import { checks, corpdev, env, fakeClock, memoryDb, reader, req } from "./helpers/fakes.ts";
import { fakeSnowflake } from "./helpers/snowflake.ts";
import { joinReader, type SchemaTables } from "./helpers/statjoins.ts";
import { watchStore } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PAT = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
const DB = "MI_XPRESSCLOUD", SCH = "XPRESSFEED";
const Q: StatQuery = { kind: "company", codes: ["12345", "23456"], fromYear: 2023, toYear: 2024 };
const T = (v: string) => ({ type: "TEXT", value: v }), N = (v: number) => ({ type: "FIXED", value: String(v) });
const sortRows = (rows: any[]) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

// ---------- made-up views in three schemas ----------
const TABLES: SchemaTables = {
  "ENTITY.ENTITY_LIST": [
    { ENTITY_ID: 1, NAIC_CD: "12345", ENTITY_NAME: "Calloway Insurance Co", GROUP_ID: 10, GROUP_ENT_ID: 900, INST_ID: 5001 },
    { ENTITY_ID: 2, NAIC_CD: "12346", ENTITY_NAME: "Calloway Home Co", GROUP_ID: 10, GROUP_ENT_ID: 900, INST_ID: 5002 },
    { ENTITY_ID: 3, NAIC_CD: "23456", ENTITY_NAME: "Tarrow Mutual Insurance Co", GROUP_ID: null, GROUP_ENT_ID: null, INST_ID: 5003 },
    // the group's own entity, whose periods carry the group's combined figures
    { ENTITY_ID: 900, NAIC_CD: null, ENTITY_NAME: "Calloway Group (combined)", GROUP_ID: null, GROUP_ENT_ID: null, INST_ID: 5900 },
  ],
  // group membership: one row for each member and membership period
  "ENTITY.GROUP_MEMBERS": [
    { GROUP_CD: "9100", GROUP_NAME: "Calloway Group", MEMBER_PERIOD: "2024-12-31", INST_ID: 5001 },
    { GROUP_CD: "9100", GROUP_NAME: "Calloway Group", MEMBER_PERIOD: "2024-12-31", INST_ID: 5002 },
    { GROUP_CD: "9100", GROUP_NAME: "Calloway Group", MEMBER_PERIOD: "2023-12-31", INST_ID: 5001 },
  ],
  "ENTITY.GROUP_LIST": [{ GROUP_ID: 10, GROUP_CD: "9100", GROUP_NAME: "Calloway Group" }],
  "CORE_FIN.STOCK_PERIOD": [
    { PERIOD_ID: 101, ENTITY_ID: 1, PERIOD_END: "2023-12-31", LOB_NAME: "Total", SEQ: 1 },
    { PERIOD_ID: 102, ENTITY_ID: 1, PERIOD_END: "2024-12-31", LOB_NAME: "Total", SEQ: 1 },
    { PERIOD_ID: 103, ENTITY_ID: 1, PERIOD_END: "2024-12-31", LOB_NAME: "Total", SEQ: 2 },   // 2024 restated: the latest
    { PERIOD_ID: 104, ENTITY_ID: 1, PERIOD_END: "2024-06-30", LOB_NAME: "Total", SEQ: 1 },   // half year: not a year end
    { PERIOD_ID: 105, ENTITY_ID: 1, PERIOD_END: "2024-12-31", LOB_NAME: "Homeowners", SEQ: 2, LOB_ID: 140 },
    { PERIOD_ID: 106, ENTITY_ID: 1, PERIOD_END: "2024-12-31", LOB_NAME: "Commercial auto", SEQ: 2, LOB_ID: 150 },
    { PERIOD_ID: 107, ENTITY_ID: 2, PERIOD_END: "2024-12-31", LOB_NAME: "Total", SEQ: 1 },
    { PERIOD_ID: 108, ENTITY_ID: 3, PERIOD_END: "2024-12-31", LOB_NAME: "Total", SEQ: 1 },
    { PERIOD_ID: 109, ENTITY_ID: 3, PERIOD_END: "2024-12-31", LOB_NAME: null, SEQ: 1 },
    { PERIOD_ID: 120, ENTITY_ID: 900, PERIOD_END: "2024-12-31", LOB_NAME: "Total", SEQ: 1 },
    { PERIOD_ID: 121, ENTITY_ID: 900, PERIOD_END: "2023-12-31", LOB_NAME: "Total", SEQ: 1 },
  ],
  "CORE_FIN.FLOW_PERIOD": [
    { FLOW_ID: 201, STOCK_PERIOD_ID: 101, ANNUALISED: "Y", ANN_FACTOR: 1 }, { FLOW_ID: 202, STOCK_PERIOD_ID: 102, ANNUALISED: "Y", ANN_FACTOR: 1 },
    { FLOW_ID: 203, STOCK_PERIOD_ID: 103, ANNUALISED: "Y", ANN_FACTOR: 1 }, { FLOW_ID: 204, STOCK_PERIOD_ID: 104, ANNUALISED: "Y" },
    { FLOW_ID: 205, STOCK_PERIOD_ID: 105, ANNUALISED: "Y", ANN_FACTOR: 1 }, { FLOW_ID: 206, STOCK_PERIOD_ID: 106, ANNUALISED: "Y", ANN_FACTOR: 1 },
    { FLOW_ID: 207, STOCK_PERIOD_ID: 107, ANNUALISED: "Y" }, { FLOW_ID: 208, STOCK_PERIOD_ID: 108, ANNUALISED: "Y", ANN_FACTOR: 1 },
    { FLOW_ID: 209, STOCK_PERIOD_ID: 103, ANNUALISED: "N", ANN_FACTOR: 0.25 },   // a quarter inside the restated year
    { FLOW_ID: 210, STOCK_PERIOD_ID: 109, ANNUALISED: "Y" },
    { FLOW_ID: 220, STOCK_PERIOD_ID: 120, ANNUALISED: "Y", ANN_FACTOR: 1 }, { FLOW_ID: 221, STOCK_PERIOD_ID: 121, ANNUALISED: "Y", ANN_FACTOR: 1 },
  ],
  "CORE_FIN.FIN_FLOW_B": [
    { FLOW_ID: 201, NPE_000: 1000, DPW_000: 1200, LOSS_RATIO: 0.6 }, { FLOW_ID: 202, NPE_000: 1100, DPW_000: 1250, LOSS_RATIO: 0.62 },
    { FLOW_ID: 203, NPE_000: 1150, DPW_000: 1300, LOSS_RATIO: 0.61 }, { FLOW_ID: 204, NPE_000: 500, DPW_000: 600, LOSS_RATIO: 0.5 },
    { FLOW_ID: 205, NPE_000: 400, DPW_000: 420, LOSS_RATIO: null }, { FLOW_ID: 206, NPE_000: 300, DPW_000: 310, LOSS_RATIO: null },
    { FLOW_ID: 207, NPE_000: 250, DPW_000: 260, LOSS_RATIO: 0.7 }, { FLOW_ID: 208, NPE_000: 900, DPW_000: 950, LOSS_RATIO: 99999999999999 },   // S&P-style "meaningless" sentinel
    { FLOW_ID: 209, NPE_000: 280, DPW_000: 290, LOSS_RATIO: 0.4 }, { FLOW_ID: 210, NPE_000: 1, DPW_000: 1, LOSS_RATIO: 0.01 },
    { FLOW_ID: 220, NPE_000: 1400, DPW_000: 1500, LOSS_RATIO: 0.58 }, { FLOW_ID: 221, NPE_000: 1300, DPW_000: 1350, LOSS_RATIO: 0.6 },
  ],
  "CORE_FIN.FIN_STOCK_A": [{ PERIOD_ID: 101, PHS_000: 5000, CAP_STOCK_000: 10, PAID_IN_000: 90 }, { PERIOD_ID: 102, PHS_000: 5500, CAP_STOCK_000: 5, PAID_IN_000: null }, { PERIOD_ID: 103, PHS_000: 5600, CAP_STOCK_000: null, PAID_IN_000: 200 },
    { PERIOD_ID: 104, PHS_000: 5200, CAP_STOCK_000: 1, PAID_IN_000: 1 }, { PERIOD_ID: 107, PHS_000: 800, CAP_STOCK_000: 2, PAID_IN_000: 3 }, { PERIOD_ID: 108, PHS_000: 3000, CAP_STOCK_000: null, PAID_IN_000: null },
    { PERIOD_ID: 120, PHS_000: 9000, CAP_STOCK_000: 50, PAID_IN_000: 450 }, { PERIOD_ID: 121, PHS_000: 8000, CAP_STOCK_000: 50, PAID_IN_000: 400 }],
  "CORE_FIN.GEO_REGION": [
    { FLOW_ID: 203, REGION: "Reported:FL", DPW_000: 700 }, { FLOW_ID: 203, REGION: "Reported:TX", DPW_000: 450 }, { FLOW_ID: 203, REGION: "Region:Southeast", DPW_000: 1150 },
    { FLOW_ID: 203, REGION: "Zone:3", DPW_000: 5 }, { FLOW_ID: 208, REGION: "Reported:FL", DPW_000: 900 },
  ],
  "CORE_FIN.GEO_FLOW": [
    { FLOW_ID: 203, STATE_CD: "FL", DPW_000: 700 }, { FLOW_ID: 203, STATE_CD: "TX", DPW_000: 450 }, { FLOW_ID: 208, STATE_CD: "FL", DPW_000: 900 },
    { FLOW_ID: 209, STATE_CD: "FL", DPW_000: 10 },   // not annualised
  ],
  "REINS.CEDED_DETAIL": [
    { STOCK_PERIOD_ID: 101, REINSURER_NAME: "Nonesuch Re", CEDED_000: 80 },
    { STOCK_PERIOD_ID: 102, REINSURER_NAME: "Nonesuch Re", CEDED_000: 999 },   // superseded by the restatement
    { STOCK_PERIOD_ID: 103, REINSURER_NAME: "Nonesuch Re", CEDED_000: 100 }, { STOCK_PERIOD_ID: 103, REINSURER_NAME: "Nonesuch Re", CEDED_000: 50 },
    { STOCK_PERIOD_ID: 103, REINSURER_NAME: "Nonesuch Mutual Re", CEDED_000: 30 }, { STOCK_PERIOD_ID: 103, REINSURER_NAME: "Nonesuch Mutual Re", CEDED_000: null },
    { STOCK_PERIOD_ID: 108, REINSURER_NAME: "Nonesuch Re", CEDED_000: 12 },
  ],
  "CORE_FIN.BATCH_RUN": [{ RUN_DATE: "2026-11-02" }, { RUN_DATE: "2026-11-16" }],
  "ENTITY.BATCH_RUN": [{ RUN_DATE: "2026-11-15" }],
  "REINS.BATCH_RUN": [{ RUN_DATE: "2026-10-31" }],
};

// ---------- the made-up mapping, one of each kind ----------
const CHAIN = [
  { view: "CORE_FIN.FLOW_PERIOD", as: "FP", on: [{ left: "F.FLOW_ID", right: "FP.FLOW_ID" }] },
  { view: "CORE_FIN.STOCK_PERIOD", as: "SP", on: [{ left: "FP.STOCK_PERIOD_ID", right: "SP.PERIOD_ID" }] },
  { view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "SP.ENTITY_ID", right: "E.ENTITY_ID" }] },
  { view: "ENTITY.GROUP_LIST", as: "G", on: [{ left: "E.GROUP_ID", right: "G.GROUP_ID" }], kind: "left" as const },
];
const ENT = { company: "E.NAIC_CD", group: "G.GROUP_CD", name: "E.ENTITY_NAME" };
const YEAR_END = [{ column: "SP.LOB_NAME", equals: "Total" }, { column: "FP.ANNUALISED", equals: "Y" }, { column: "SP.PERIOD_END", month: 12 }];
const NPE: FieldMap = { view: "CORE_FIN.FIN_FLOW_B", as: "F", joins: CHAIN, entity: ENT, year: "SP.PERIOD_END", yearIsDate: true, value: "F.NPE_000", where: YEAR_END, latest: "SP.SEQ", scale: 1000 };
const SURPLUS: FieldMap = { view: "CORE_FIN.FIN_STOCK_A", as: "S", joins: [
  { view: "CORE_FIN.STOCK_PERIOD", as: "SP", on: [{ left: "S.PERIOD_ID", right: "SP.PERIOD_ID" }] },
  { view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "SP.ENTITY_ID", right: "E.ENTITY_ID" }] },
], entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME" }, year: "SP.PERIOD_END", yearIsDate: true, value: "S.PHS_000", where: [{ column: "SP.LOB_NAME", equals: "Total" }, { column: "SP.PERIOD_END", month: 12 }], latest: "SP.SEQ", scale: 1000 };
const BY_LINE: FieldMap = { ...NPE, value: "F.DPW_000", line: "SP.LOB_NAME", where: [{ column: "SP.LOB_NAME", notEquals: "Total" }, { column: "FP.ANNUALISED", equals: "Y" }, { column: "SP.PERIOD_END", month: 12 }] };
const BY_STATE: FieldMap = { view: "CORE_FIN.GEO_FLOW", as: "GEO", joins: [
  { view: "CORE_FIN.FLOW_PERIOD", as: "FP", on: [{ left: "GEO.FLOW_ID", right: "FP.FLOW_ID" }] }, CHAIN[1], CHAIN[2],
], entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME" }, year: "SP.PERIOD_END", yearIsDate: true, value: "GEO.DPW_000", state: "GEO.STATE_CD", where: [{ column: "FP.ANNUALISED", in: ["Y", "y"] }, { column: "SP.LOB_NAME", isNull: false }], latest: "SP.SEQ", scale: 1000 };
const CEDED: FieldMap = { view: "REINS.CEDED_DETAIL", as: "C", joins: [
  { view: "CORE_FIN.STOCK_PERIOD", as: "SP", on: [{ left: "C.STOCK_PERIOD_ID", right: "SP.PERIOD_ID" }] }, CHAIN[2],
], entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME" }, year: "SP.PERIOD_END", yearIsDate: true, value: "C.CEDED_000", item: "C.REINSURER_NAME", where: [{ column: "SP.PERIOD_END", month: 12 }], sum: true, latest: "SP.SEQ", scale: 1000 };
const LOSS: FieldMap = { ...NPE, value: "F.LOSS_RATIO", scale: 100 };
const MAPPING: Mapping = { fields: { npe: NPE, surplus: SURPLUS, dpw_by_line: BY_LINE, dpw_by_state: BY_STATE, ceded_by_reinsurer: CEDED, loss_ratio: LOSS }, loaded: { view: "BATCH_RUN", at: "RUN_DATE" } };

function world(opts: { failLoaded?: string[]; views?: string[]; secrets?: Record<string, string> } = {}) {
  const clock = fakeClock(), sf = fakeSnowflake(clock, { on: joinReader({ tables: TABLES, failLoaded: opts.failLoaded, views: opts.views }) });
  const creds = snowflakeCreds(env(opts.secrets ?? PAT));
  return { clock, sf, creds, api: new Snowflake(creds, { fetch: sf.fetch, now: clock.fn, sleep: clock.sleep }) };
}

// ---------- a single-view mapping is unchanged ----------
const OLD: FieldMap = { view: "IR_PREM_LINE", entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "DPW_000", line: "LOB", scale: 1000, where: [{ column: "BASIS", equals: "Direct" }] };
{
  const s = buildSql(DB, SCH, OLD, Q)!;
  ok("a single-view mapping makes exactly the SQL it made before joins existed", s.statement === "SELECT NAIC_CD AS CODE, CO_NAME AS NAME, STMT_YEAR AS YR, LOB AS LINE, NULL AS STATE, DPW_000 AS VAL FROM MI_XPRESSCLOUD.XPRESSFEED.IR_PREM_LINE WHERE NAIC_CD IN (?, ?) AND STMT_YEAR BETWEEN ? AND ? AND BASIS = ? ORDER BY 1, 3 LIMIT 20000", s.statement);
  ok("and the same bindings", same(s.bindings, [T("12345"), T("23456"), N(2023), N(2024), T("Direct")]), s.bindings);
  const d = buildSql(DB, SCH, { view: "IR_RATIOS", entity: { company: "NAIC_CD" }, year: "PERIOD_END", yearIsDate: true, value: "LR", state: '"State Code"' }, Q)!;
  ok("a single view with a date year and a quoted name is unchanged too", d.statement === 'SELECT NAIC_CD AS CODE, NULL AS NAME, YEAR(PERIOD_END) AS YR, NULL AS LINE, "State Code" AS STATE, LR AS VAL FROM MI_XPRESSCLOUD.XPRESSFEED.IR_RATIOS WHERE NAIC_CD IN (?, ?) AND YEAR(PERIOD_END) BETWEEN ? AND ? ORDER BY 1, 3 LIMIT 20000', d.statement);
  const other = buildSql(DB, SCH, { ...OLD, view: "CORE_FIN.IR_PREM_LINE" }, Q)!;
  ok("a single view in another schema is read from that schema", other.statement.includes(" FROM MI_XPRESSCLOUD.CORE_FIN.IR_PREM_LINE WHERE "), other.statement);
  const aliased = buildSql(DB, SCH, { ...OLD, as: "p", entity: { company: "P.NAIC_CD" }, year: "p.STMT_YEAR", where: undefined, line: "LOB" }, Q)!;
  ok("a single view may have an alias, and columns with or without it", aliased.statement === 'SELECT "P".NAIC_CD AS CODE, NULL AS NAME, "P".STMT_YEAR AS YR, LOB AS LINE, NULL AS STATE, DPW_000 AS VAL FROM MI_XPRESSCLOUD.XPRESSFEED.IR_PREM_LINE AS "P" WHERE "P".NAIC_CD IN (?, ?) AND "P".STMT_YEAR BETWEEN ? AND ? ORDER BY 1, 3 LIMIT 20000', aliased.statement);
  ok("every mapping in the made-up set has nothing wrong with it", (["npe", "surplus", "dpw_by_line", "dpw_by_state", "ceded_by_reinsurer", "loss_ratio"] as const).every((id) => mapProblem(id, MAPPING.fields[id]) === null), (["npe", "surplus", "dpw_by_line", "dpw_by_state", "ceded_by_reinsurer", "loss_ratio"] as const).map((id) => mapProblem(id, MAPPING.fields[id])));
}

// ---------- the exact SQL for joined mappings ----------
{
  const s = buildSql(DB, SCH, NPE, Q)!;
  ok("a flow figure through four joins: the exact SQL", s.statement === 'SELECT "E".NAIC_CD AS CODE, "E".ENTITY_NAME AS NAME, YEAR("SP".PERIOD_END) AS YR, NULL AS LINE, NULL AS STATE, "F".NPE_000 AS VAL FROM MI_XPRESSCLOUD.CORE_FIN.FIN_FLOW_B AS "F" JOIN MI_XPRESSCLOUD.CORE_FIN.FLOW_PERIOD AS "FP" ON "F".FLOW_ID = "FP".FLOW_ID JOIN MI_XPRESSCLOUD.CORE_FIN.STOCK_PERIOD AS "SP" ON "FP".STOCK_PERIOD_ID = "SP".PERIOD_ID JOIN MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "E" ON "SP".ENTITY_ID = "E".ENTITY_ID LEFT JOIN MI_XPRESSCLOUD.ENTITY.GROUP_LIST AS "G" ON "E".GROUP_ID = "G".GROUP_ID WHERE "E".NAIC_CD IN (?, ?) AND YEAR("SP".PERIOD_END) BETWEEN ? AND ? AND "SP".LOB_NAME = ? AND "FP".ANNUALISED = ? AND MONTH("SP".PERIOD_END) = ? QUALIFY ROW_NUMBER() OVER (PARTITION BY "E".NAIC_CD, "E".ENTITY_NAME, YEAR("SP".PERIOD_END) ORDER BY "SP".SEQ DESC) = 1 ORDER BY 1, 3 LIMIT 20000', s.statement);
  ok("and its bindings: codes, years, then each condition's value in order, the month as a number", same(s.bindings, [T("12345"), T("23456"), N(2023), N(2024), T("Total"), T("Y"), N(12)]), s.bindings);
  const g = buildSql(DB, SCH, NPE, { ...Q, kind: "group", codes: ["9100"] })!;
  ok("a group lookup filters on the group column of the joined group view, and keeps each company apart", g.statement.startsWith('SELECT "G".GROUP_CD AS CODE, ') && g.statement.includes('WHERE "G".GROUP_CD IN (?) AND ') && g.statement.includes('PARTITION BY "G".GROUP_CD, "E".NAIC_CD, "E".ENTITY_NAME, YEAR("SP".PERIOD_END) ORDER BY'), g.statement);
  ok("a joined field with no group column can't be asked for by group", buildSql(DB, SCH, SURPLUS, { ...Q, kind: "group" }) === null);
  const st = buildSql(DB, SCH, BY_STATE, Q)!;
  ok("a by-state field: the exact SQL, with in and isNull", st.statement === 'SELECT "E".NAIC_CD AS CODE, "E".ENTITY_NAME AS NAME, YEAR("SP".PERIOD_END) AS YR, NULL AS LINE, "GEO".STATE_CD AS STATE, "GEO".DPW_000 AS VAL FROM MI_XPRESSCLOUD.CORE_FIN.GEO_FLOW AS "GEO" JOIN MI_XPRESSCLOUD.CORE_FIN.FLOW_PERIOD AS "FP" ON "GEO".FLOW_ID = "FP".FLOW_ID JOIN MI_XPRESSCLOUD.CORE_FIN.STOCK_PERIOD AS "SP" ON "FP".STOCK_PERIOD_ID = "SP".PERIOD_ID JOIN MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "E" ON "SP".ENTITY_ID = "E".ENTITY_ID WHERE "E".NAIC_CD IN (?, ?) AND YEAR("SP".PERIOD_END) BETWEEN ? AND ? AND "FP".ANNUALISED IN (?, ?) AND "SP".LOB_NAME IS NOT NULL QUALIFY ROW_NUMBER() OVER (PARTITION BY "E".NAIC_CD, "E".ENTITY_NAME, YEAR("SP".PERIOD_END), "GEO".STATE_CD ORDER BY "SP".SEQ DESC) = 1 ORDER BY 1, 3 LIMIT 20000', st.statement);
  ok("its bindings", same(st.bindings, [T("12345"), T("23456"), N(2023), N(2024), T("Y"), T("y")]), st.bindings);
  const c = buildSql(DB, SCH, CEDED, Q)!;
  ok("a summed by-item field: the exact SQL, grouped by position and by the latest column", c.statement === 'SELECT "E".NAIC_CD AS CODE, "E".ENTITY_NAME AS NAME, YEAR("SP".PERIOD_END) AS YR, NULL AS LINE, NULL AS STATE, SUM("C".CEDED_000) AS VAL, "C".REINSURER_NAME AS ITEM FROM MI_XPRESSCLOUD.REINS.CEDED_DETAIL AS "C" JOIN MI_XPRESSCLOUD.CORE_FIN.STOCK_PERIOD AS "SP" ON "C".STOCK_PERIOD_ID = "SP".PERIOD_ID JOIN MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "E" ON "SP".ENTITY_ID = "E".ENTITY_ID WHERE "E".NAIC_CD IN (?, ?) AND YEAR("SP".PERIOD_END) BETWEEN ? AND ? AND MONTH("SP".PERIOD_END) = ? GROUP BY 1, 2, 3, 4, 5, 7, "SP".SEQ QUALIFY ROW_NUMBER() OVER (PARTITION BY "E".NAIC_CD, "E".ENTITY_NAME, YEAR("SP".PERIOD_END), "C".REINSURER_NAME ORDER BY "SP".SEQ DESC) = 1 ORDER BY 1, 3 LIMIT 20000', c.statement);
  const sumOnly = buildSql(DB, SCH, { ...CEDED, latest: undefined }, Q)!;
  ok("sum without latest groups by the selected columns alone", / GROUP BY 1, 2, 3, 4, 5, 7 ORDER BY 1, 3 LIMIT 20000$/.test(sumOnly.statement) && !sumOnly.statement.includes("QUALIFY"), sumOnly.statement);
  const sumYear = buildSql(DB, SCH, { ...SURPLUS, sum: true, latest: undefined }, Q)!;
  ok("sum on a by-year field leaves the item out of the grouping", / GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 3 LIMIT 20000$/.test(sumYear.statement), sumYear.statement);
  // each where operator, one at a time
  const one = (w: unknown) => buildSql(DB, SCH, { ...SURPLUS, latest: undefined, where: [w as any] }, Q)!;
  const ops: [string, unknown, string, unknown[]][] = [
    ["equals", { column: "SP.LOB_NAME", equals: "Total" }, ' AND "SP".LOB_NAME = ?', [T("Total")]],
    ["notEquals", { column: "SP.LOB_NAME", notEquals: "Total" }, ' AND "SP".LOB_NAME <> ?', [T("Total")]],
    ["in", { column: "SP.LOB_NAME", in: ["Homeowners", "Commercial auto", "Total"] }, ' AND "SP".LOB_NAME IN (?, ?, ?)', [T("Homeowners"), T("Commercial auto"), T("Total")]],
    ["isNull true", { column: "SP.LOB_NAME", isNull: true }, ' AND "SP".LOB_NAME IS NULL', []],
    ["isNull false", { column: "SP.LOB_NAME", isNull: false }, ' AND "SP".LOB_NAME IS NOT NULL', []],
    ["month", { column: "SP.PERIOD_END", month: 6 }, ' AND MONTH("SP".PERIOD_END) = ?', [N(6)]],
  ];
  for (const [name, w, sql, binds] of ops) {
    const s1 = one(w);
    ok(`the ${name} condition becomes "${sql.trim()}", with its value bound`, s1.statement.endsWith(`BETWEEN ? AND ?${sql} ORDER BY 1, 3 LIMIT 20000`) && same(s1.bindings.slice(4), binds) && (s1.statement.match(/\?/g) ?? []).length === s1.bindings.length, s1);
  }
  const dated = buildSql(DB, SCH, SURPLUS, Q)!;
  ok("a year taken from a date, with a month condition to keep year-end rows", dated.statement.includes('YEAR("SP".PERIOD_END) AS YR') && dated.statement.includes('YEAR("SP".PERIOD_END) BETWEEN ? AND ? AND "SP".LOB_NAME = ? AND MONTH("SP".PERIOD_END) = ?') && same(dated.bindings.slice(4), [T("Total"), N(12)]), dated.statement);
  ok("the database comes from the secret, and the default schema only where a view names none", buildSql("OTHER_DB", "DEFAULT_S", { ...SURPLUS, joins: [{ ...SURPLUS.joins![0], view: "STOCK_PERIOD" }, SURPLUS.joins![1]] }, Q)!.statement.includes("FROM OTHER_DB.CORE_FIN.FIN_STOCK_A AS \"S\" JOIN OTHER_DB.DEFAULT_S.STOCK_PERIOD AS \"SP\""));
  const readOnly = (x: string) => /^SELECT /.test(x) && !x.includes(";") && !/--|\/\*|'/.test(x) && (x.match(/\bSELECT\b/g) ?? []).length === 1 && !/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|CALL|COPY|PUT|EXECUTE|USE|UNION)\b/i.test(x);
  ok("every joined statement is one read-only SELECT, with one question mark per binding", [s, g, st, c, sumOnly, dated].every((x) => readOnly(x.statement) && (x.statement.match(/\?/g) ?? []).length === x.bindings.length));
}

// ---------- every reason a mapping is refused ----------
{
  const J0 = { view: "CORE_FIN.STOCK_PERIOD", as: "SP", on: [{ left: "S.PERIOD_ID", right: "SP.PERIOD_ID" }] };
  const BASE: any = { view: "CORE_FIN.FIN_STOCK_A", as: "S", joins: [J0], entity: { company: "SP.ENTITY_ID" }, year: "SP.PERIOD_END", yearIsDate: true, value: "S.PHS_000" };
  ok("the small base mapping used below is fine", mapProblem("surplus", BASE) === null, mapProblem("surplus", BASE));
  const cases: [string, any, string, string?][] = [
    ["a view with three parts", { ...BASE, view: "DB.CORE_FIN.FIN_STOCK_A" }, "view must be a view name"],
    ["a view with an empty schema", { ...BASE, view: ".FIN_STOCK_A" }, "view must be a view name"],
    ["an alias that is SQL", { ...BASE, as: 'S" ; DROP' }, "as must be a short name: letters, digits and _, starting with a letter"],
    ["an alias in quotes", { ...BASE, as: '"S"' }, "as must be a short name: letters, digits and _, starting with a letter"],
    ["an alias that is too long", { ...BASE, as: "A".repeat(31) }, "as must be a short name: letters, digits and _, starting with a letter"],
    ["an alias with a dollar sign", { ...BASE, as: "S$" }, "as must be a short name: letters, digits and _, starting with a letter"],
    ["joins that aren't a list", { ...BASE, joins: J0 }, "joins must be a list of up to 8 joins"],
    ["nine joins", { ...BASE, joins: Array.from({ length: 9 }, (_, i) => ({ view: "V", as: `J${i}`, on: [{ left: "S.A", right: `J${i}.A` }] })) }, "joins must be a list of up to 8 joins"],
    ["joins with no alias on the main view", { ...BASE, as: undefined }, "as is needed on the main view when there are joins, so each column can say which view it is in"],
    ["a join that isn't an object", { ...BASE, joins: ["CORE_FIN.STOCK_PERIOD"] }, "joins[0] must be an object with view, as and on"],
    ["a join with a hostile view", { ...BASE, joins: [{ ...J0, view: "CORE_FIN.X; DROP TABLE Y" }] }, "joins[0].view must be a view name or SCHEMA.VIEW"],
    ["a join with no alias", { ...BASE, joins: [{ ...J0, as: undefined }] }, "joins[0].as must be a short name: letters, digits and _, starting with a letter"],
    ["a join of another kind", { ...BASE, joins: [{ ...J0, kind: "cross" }] }, 'joins[0].kind must be "inner" or "left"'],
    ["an alias declared twice", { ...BASE, joins: [{ ...J0, as: "s", on: [{ left: "S.PERIOD_ID", right: "s.PERIOD_ID" }] }] }, "alias S is declared more than once"],
    ["a join with no on", { ...BASE, joins: [{ ...J0, on: [] }] }, "joins[0].on must be a list of 1 to 4 {left, right} pairs"],
    ["a join with five on pairs", { ...BASE, joins: [{ ...J0, on: Array(5).fill(J0.on[0]) }] }, "joins[0].on must be a list of 1 to 4 {left, right} pairs"],
    ["an on pair that isn't an object", { ...BASE, joins: [{ ...J0, on: ["S.PERIOD_ID = SP.PERIOD_ID"] }] }, "joins[0].on[0] must be {left, right}"],
    ["an on side without an alias", { ...BASE, joins: [{ ...J0, on: [{ left: "PERIOD_ID", right: "SP.PERIOD_ID" }] }] }, "joins[0].on[0].left must be ALIAS.COLUMN"],
    ["an on side that is SQL", { ...BASE, joins: [{ ...J0, on: [{ left: "S.PERIOD_ID", right: "SP.PERIOD_ID OR 1=1" }] }] }, "joins[0].on[0].right must be ALIAS.COLUMN"],
    ["an on side naming an alias nobody declared", { ...BASE, joins: [{ ...J0, on: [{ left: "X.PERIOD_ID", right: "SP.PERIOD_ID" }] }] }, "joins[0].on[0].left names alias X, which isn't declared"],
    ["an on side naming a later alias", { ...BASE, joins: [{ ...J0, on: [{ left: "E.ENTITY_ID", right: "SP.ENTITY_ID" }] }, { view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "SP.ENTITY_ID", right: "E.ENTITY_ID" }] }] }, "joins[0].on[0].left names alias E, which isn't declared"],
    ["a join on two earlier views only", { ...BASE, joins: [J0, { view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "S.PERIOD_ID", right: "SP.PERIOD_ID" }] }] }, "joins[1].on[0] must link E to a view named before it"],
    ["a join on itself only", { ...BASE, joins: [{ ...J0, on: [{ left: "SP.PERIOD_ID", right: "SP.PERIOD_ID" }] }] }, "joins[0].on[0] must link SP to a view named before it"],
    ["a column without an alias when there are joins", { ...BASE, value: "PHS_000" }, "value must be ALIAS.COLUMN when there are joins"],
    ["entity.company without an alias", { ...BASE, entity: { company: "NAIC_CD" } }, "entity.company must be ALIAS.COLUMN when there are joins"],
    ["entity.group naming an undeclared alias", { ...BASE, entity: { company: "SP.ENTITY_ID", group: "G.GROUP_CD" } }, "entity.group names alias G, which isn't declared"],
    ["entity with neither company nor group", { ...BASE, entity: { name: "SP.NAME" } }, "entity needs a company or group column"],
    ["a year that is SQL", { ...BASE, year: "SP.PERIOD_END)" }, "year must be a column name"],
    ["a year with an alias and three parts", { ...BASE, year: "SP.X.PERIOD_END" }, "year must be a column name"],
    ["a line naming an undeclared alias", { ...BASE, line: "Z.LOB" }, "line names alias Z, which isn't declared"],
    ["a latest column that is SQL", { ...BASE, latest: "SP.SEQ DESC, 1" }, "latest must be a column name"],
    ["a where that isn't a list", { ...BASE, where: { column: "SP.A", equals: "x" } }, "where must be a list of up to 12 conditions"],
    ["thirteen where conditions", { ...BASE, where: Array(13).fill({ column: "SP.A", equals: "x" }) }, "where must be a list of up to 12 conditions"],
    ["a null where entry", { ...BASE, where: [null] }, "where[0] must be an object with column and one of equals, notEquals, in, isNull, month or startsWith"],
    ["a where column without an alias", { ...BASE, where: [{ column: "LOB_NAME", equals: "Total" }] }, "where[0].column must be ALIAS.COLUMN when there are joins"],
    ["a where column naming an undeclared alias", { ...BASE, where: [{ column: "FP.ANNUALISED", equals: "Y" }] }, "where[0].column names alias FP, which isn't declared"],
    ["a where with no operator", { ...BASE, where: [{ column: "SP.A" }] }, "where[0] needs exactly one of equals, notEquals, in, isNull, month or startsWith"],
    ["a where with two operators", { ...BASE, where: [{ column: "SP.A", equals: "x", notEquals: "y" }] }, "where[0] needs exactly one of equals, notEquals, in, isNull, month or startsWith"],
    ["an equals that isn't text", { ...BASE, where: [{ column: "SP.A", equals: 5 }] }, "where[0].equals must be text of up to 200 characters"],
    ["a notEquals of 201 characters", { ...BASE, where: [{ column: "SP.A", notEquals: "x".repeat(201) }] }, "where[0].notEquals must be text of up to 200 characters"],
    ["an empty in list", { ...BASE, where: [{ column: "SP.A", in: [] }] }, "where[0].in must be a list of 1 to 80 texts of up to 200 characters"],
    ["an in list of 81", { ...BASE, where: [{ column: "SP.A", in: Array(81).fill("x") }] }, "where[0].in must be a list of 1 to 80 texts of up to 200 characters"],
    ["an in list with a number", { ...BASE, where: [{ column: "SP.A", in: ["x", 1] }] }, "where[0].in must be a list of 1 to 80 texts of up to 200 characters"],
    ["an in that is text", { ...BASE, where: [{ column: "SP.A", in: "x" }] }, "where[0].in must be a list of 1 to 80 texts of up to 200 characters"],
    ["an isNull that is text", { ...BASE, where: [{ column: "SP.A", isNull: "true" }] }, "where[0].isNull must be true or false"],
    ["a month of 13", { ...BASE, where: [{ column: "SP.A", month: 13 }] }, "where[0].month must be a whole number from 1 to 12"],
    ["a month of 0", { ...BASE, where: [{ column: "SP.A", month: 0 }] }, "where[0].month must be a whole number from 1 to 12"],
    ["a month with a fraction", { ...BASE, where: [{ column: "SP.A", month: 6.5 }] }, "where[0].month must be a whole number from 1 to 12"],
    ["a month that is text", { ...BASE, where: [{ column: "SP.A", month: "12" }] }, "where[0].month must be a whole number from 1 to 12"],
    ["an empty startsWith", { ...BASE, where: [{ column: "SP.A", startsWith: "" }] }, "where[0].startsWith must be text of 1 to 200 characters"],
    ["a startsWith that is a number", { ...BASE, where: [{ column: "SP.A", startsWith: 5 }] }, "where[0].startsWith must be text of 1 to 200 characters"],
    ["a startsWith of 201 characters", { ...BASE, where: [{ column: "SP.A", startsWith: "x".repeat(201) }] }, "where[0].startsWith must be text of 1 to 200 characters"],
    ["plus that isn't a list", { ...BASE, plus: "S.B" }, "plus must be a list of 1 to 4 columns"],
    ["an empty plus", { ...BASE, plus: [] }, "plus must be a list of 1 to 4 columns"],
    ["plus of five columns", { ...BASE, plus: Array(5).fill("S.B") }, "plus must be a list of 1 to 4 columns"],
    ["a plus column without an alias", { ...BASE, plus: ["PAID_IN"] }, "plus[0] must be ALIAS.COLUMN when there are joins"],
    ["a plus column naming an undeclared alias", { ...BASE, plus: ["S.A", "Z.B"] }, "plus[1] names alias Z, which isn't declared"],
    ["a plus column that is SQL", { ...BASE, plus: ["S.A) + (1"] }, "plus[0] must be a column name"],
    ["an empty stateStrip", { ...BASE, stateStrip: "" }, "stateStrip must be text of 1 to 200 characters"],
    ["a stateStrip that is a list", { ...BASE, stateStrip: ["Reported:"] }, "stateStrip must be text of 1 to 200 characters"],
    ["a sum that is text", { ...BASE, sum: "yes" }, "sum must be true or false"],
    ["a yearIsDate that is text", { ...BASE, yearIsDate: "true" }, "yearIsDate must be true or false"],
    ["a scale of zero", { ...BASE, scale: 0 }, "scale must be a number"],
    ["a by-line field with no line", BASE, "line must be a column name", "dpw_by_line"],
    ["a by-state field with no state", BASE, "state must be a column name", "dpw_by_state"],
    ["a by-item field with no item", BASE, "item must be a column name", "ceded_by_reinsurer"],
    ["nothing at all", undefined, "not mapped"],
    ["a single view with ALIAS.COLUMN but no alias declared", { view: "V", entity: { company: "A.NAIC" }, year: "Y", value: "V1" }, "entity.company names alias A, which isn't declared"],
  ];
  for (const [name, m, says, id] of cases) {
    const got = mapProblem((id ?? "surplus") as any, m);
    ok(`refused: ${name}, saying "${says}"`, got === says, got);
    if (m && got !== null) ok(`and no SQL is made for it: ${name}`, buildSql(DB, SCH, m, Q) === null || id !== undefined);
  }
}

// ---------- injection ----------
{
  const HOSTILE = ["X; DROP TABLE Y", 'a"b', "A--", "A/*", "A B", "A)", "(SELECT 1)", "1A", "", " ", '"a""b"', '"A" OR "1"="1"', "A\n", "A'", "A,B", "A=B", "Ａ", "A;", "x".repeat(129), '""', "$A", "A\\", "`A`", "[A]", "S.A.B", "S..A", ".A", "A.", 'S."a.b"', "S.A--", "S.A B", "S.(SELECT 1)", "S.A,B"];
  const leaks: string[] = [];
  for (const bad of HOSTILE) {
    const tries: [string, any][] = [
      ["view", { ...NPE, view: bad }], ["joins[0].view", { ...NPE, joins: [{ ...CHAIN[0], view: bad }, ...CHAIN.slice(1)] }], ["joins[1].as", { ...NPE, joins: [CHAIN[0], { ...CHAIN[1], as: bad }, ...CHAIN.slice(2)] }],
      ["as", { ...NPE, as: bad }], ["on.left", { ...NPE, joins: [{ ...CHAIN[0], on: [{ left: bad, right: "FP.FLOW_ID" }] }, ...CHAIN.slice(1)] }], ["on.right", { ...NPE, joins: [{ ...CHAIN[0], on: [{ left: "F.FLOW_ID", right: bad }] }, ...CHAIN.slice(1)] }],
      ["entity.company", { ...NPE, entity: { ...ENT, company: bad } }], ["entity.group", { ...NPE, entity: { ...ENT, group: bad } }], ["entity.name", { ...NPE, entity: { ...ENT, name: bad } }],
      ["year", { ...NPE, year: bad }], ["value", { ...NPE, value: bad }], ["line", { ...NPE, line: bad }], ["state", { ...NPE, state: bad }], ["item", { ...NPE, item: bad }], ["latest", { ...NPE, latest: bad }],
      ["where.column", { ...NPE, where: [{ column: bad, equals: "x" }] }],
    ];
    for (const [where, m] of tries) if (mapProblem("npe", m) === null || buildSql(DB, SCH, m, Q) !== null) leaks.push(`${where}=${JSON.stringify(bad)}`);
  }
  ok(`${HOSTILE.length} hostile names are refused in every place a name can go in a joined mapping, and make no SQL`, leaks.length === 0, leaks);
  ok("an alias in quotes is refused in a column, though a quoted schema is fine in a view", mapProblem("npe", { ...NPE, value: '"F".NPE_000' }) === "value must be a column name" && mapProblem("npe", { ...NPE, view: '"CORE_FIN".FIN_FLOW_B' }) === null);
  const values = ["' OR '1'='1", "Total'; DROP TABLE X; --", "?", "\\", "%", "x".repeat(200)];
  const evil = buildSql(DB, SCH, { ...SURPLUS, where: [{ column: "SP.LOB_NAME", equals: values[0] }, { column: "SP.LOB_NAME", notEquals: values[1] }, { column: "SP.LOB_NAME", in: values.slice(2) }] }, Q)!;
  ok("values of every kind are bound, never written into the SQL", !evil.statement.includes("'") && !evil.statement.includes("DROP") && !evil.statement.includes("%") && same(evil.bindings.slice(4).map((b) => b.value), values) && (evil.statement.match(/\?/g) ?? []).length === evil.bindings.length, evil);
  ok("an alias always goes into the SQL in double quotes and upper case", (buildSql(DB, SCH, { ...SURPLUS, as: "select", joins: SURPLUS.joins!.map((j) => ({ ...j, on: j.on.map((o) => ({ left: o.left.replace(/^S\./, "select."), right: o.right })) })), value: "select.PHS_000" }, Q)?.statement ?? "").includes('FROM MI_XPRESSCLOUD.CORE_FIN.FIN_STOCK_A AS "SELECT" JOIN'));
  const most = buildSql(DB, SCH, { ...SURPLUS, where: Array.from({ length: 12 }, () => ({ column: "SP.LOB_NAME", in: Array(80).fill("x") })) }, { ...Q, codes: ["1", "2", "3", "4", "5", "6", "7", "8"] })!;
  ok("the most bindings a mapping can ask for is bounded (8 codes, 2 years, 12 lists of 80)", most.bindings.length === 970 && (most.statement.match(/\?/g) ?? []).length === 970 && most.statement.length < 12000, most.bindings.length);
  ok("hostile plus columns are refused and make no SQL", HOSTILE.every((bad) => mapProblem("npe", { ...NPE, plus: [bad] }) !== null && buildSql(DB, SCH, { ...NPE, plus: [bad] } as any, Q) === null));
  const sw = buildSql(DB, SCH, { ...BY_STATE, where: [{ column: "GEO.STATE_CD", startsWith: "Reported:'; DROP TABLE X; --%_" }] }, Q)!;
  ok("a startsWith value is bound too, with no LIKE wildcards to escape", sw.statement.includes(' AND STARTSWITH("GEO".STATE_CD, ?)') && !sw.statement.includes("DROP") && !sw.statement.includes("LIKE") && sw.bindings.at(-1)!.value === "Reported:'; DROP TABLE X; --%_", sw);
  for (const [db, sc] of [["MI; DROP", SCH], [DB, 'X"; --'], [DB, "A.B"]]) ok(`a database or default schema of ${JSON.stringify([db, sc])} makes no SQL`, buildSql(db, sc, NPE, Q) === null);
  ok("a quoted schema or view with spaces is fine, and kept exactly", buildSql(DB, SCH, { ...OLD, view: '"Core Fin"."Prem Line"' }, Q)!.statement.includes(' FROM MI_XPRESSCLOUD."Core Fin"."Prem Line" WHERE '));
  ok("a mapping with a hostile part never reaches SQL even if mapProblem is skipped", buildSql(DB, SCH, { ...NPE, joins: [{ ...CHAIN[0], on: [{ left: "F.FLOW_ID) OR (1=1", right: "FP.FLOW_ID" }] }] } as any, Q) === null);
}

// ---------- results through runStatutory ----------
{
  const w = world();
  const r = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, { ...Q, fromYear: 2023, toYear: 2024 }, ["npe", "surplus", "dpw_by_line", "dpw_by_state", "ceded_by_reinsurer", "loss_ratio", "gpw"]);
  const f = (id: string) => r.fields.find((x) => x.id === id)!;
  ok("a flow figure through four joins: year-end, annualised, total rows only, the latest restatement, scaled", same(f("npe").rows, [{ code: "12345", year: 2023, line: null, state: null, value: 1_000_000 }, { code: "12345", year: 2024, line: null, state: null, value: 1_150_000 }, { code: "23456", year: 2024, line: null, state: null, value: 900_000 }]), f("npe"));
  ok("a stock figure through two joins", same(f("surplus").rows.map((x) => [x.code, x.year, x.value]), [["12345", 2023, 5_000_000], ["12345", 2024, 5_600_000], ["23456", 2024, 3_000_000]]), f("surplus"));
  ok("a by-line figure: every line but the total, with the line named", same(sortRows(f("dpw_by_line").rows), sortRows([{ code: "12345", year: 2024, line: "Commercial auto", state: null, value: 310_000 }, { code: "12345", year: 2024, line: "Homeowners", state: null, value: 420_000 }])), f("dpw_by_line"));
  ok("a by-state figure from the geography view: annualised only, with the state named", same(sortRows(f("dpw_by_state").rows), sortRows([{ code: "12345", year: 2024, line: null, state: "FL", value: 700_000 }, { code: "12345", year: 2024, line: null, state: "TX", value: 450_000 }, { code: "23456", year: 2024, line: null, state: "FL", value: 900_000 }])), f("dpw_by_state"));
  ok("a summed by-item figure: rows for each reinsurer added up, the superseded version left out, an empty value not counted as zero", same(sortRows(f("ceded_by_reinsurer").rows), sortRows([
    { code: "12345", year: 2023, line: null, state: null, value: 80_000, item: "Nonesuch Re" }, { code: "12345", year: 2024, line: null, state: null, value: 150_000, item: "Nonesuch Re" },
    { code: "12345", year: 2024, line: null, state: null, value: 30_000, item: "Nonesuch Mutual Re" }, { code: "23456", year: 2024, line: null, state: null, value: 12_000, item: "Nonesuch Re" }])), f("ceded_by_reinsurer").rows);
  ok("a ratio held as a fraction comes back as a percentage (the sentinel too, until it is excluded)", same(f("loss_ratio").rows.map((x) => x.value), [60, 61, 9999999999999900]), f("loss_ratio").rows);
  ok("a figure with no mapping is reported as not mapped", f("gpw").mapped === false && f("gpw").error === null && f("gpw").rows.length === 0);
  ok("every mapped figure ran without error", r.fields.filter((x) => x.mapped).every((x) => x.error === null), r.fields.map((x) => [x.id, x.error]));
  ok("company names come from the joined entity view", same(r.entities, [{ code: "12345", name: "Calloway Insurance Co" }, { code: "23456", name: "Tarrow Mutual Insurance Co" }]), r.entities);
  ok("with a loaded entry, the run date of each schema a figure came from, in name order", same(r.loaded, [{ view: "CORE_FIN", at: "2026-11-16" }, { view: "ENTITY", at: "2026-11-15" }, { view: "REINS", at: "2026-10-31" }]) && r.loadedBy === "schema", r.loaded);
  const loadStmts = w.sf.statements.filter((s) => s.statement.startsWith("SELECT MAX("));
  ok("one small statement for each schema, and LOADTRACKER isn't asked", loadStmts.length === 3 && same(loadStmts.map((s) => s.statement), ["SELECT MAX(RUN_DATE) AS AT FROM MI_XPRESSCLOUD.CORE_FIN.BATCH_RUN", "SELECT MAX(RUN_DATE) AS AT FROM MI_XPRESSCLOUD.ENTITY.BATCH_RUN", "SELECT MAX(RUN_DATE) AS AT FROM MI_XPRESSCLOUD.REINS.BATCH_RUN"]) && !w.sf.statements.some((s) => s.statement.includes("LOADTRACKER")), loadStmts.map((s) => s.statement));
  ok("nothing typed appears in any SQL text", w.sf.statements.every((s) => !/12345|23456|2023|2024|Total/.test(s.statement)));

  const g = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, { kind: "group", codes: ["9100"], fromYear: 2024, toYear: 2024 }, ["npe", "surplus"]);
  ok("a group lookup through the joined group view returns each company in the group", same(sortRows(g.fields[0].rows.map((x) => [x.code, x.value])), sortRows([["9100", 1_150_000], ["9100", 250_000]])), g.fields[0].rows);
  ok("a joined field with no group column says so in the existing plain words, and sends nothing", g.fields[1].mapped === false && g.fields[1].error === "This field has no group column mapped, so it can't be looked up by group code.", g.fields[1]);

  const typo = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { surplus: { ...SURPLUS, value: "S.PHS_TYPO" } } }, Q, ["surplus"]);
  ok("a joined field with a wrong column fails on its own with Snowflake's words", /invalid identifier 'PHS_TYPO'/.test(typo.fields[0].error ?? "") && /Check this field's mapping\.$/.test(typo.fields[0].error ?? ""), typo.fields[0].error);
  const plain = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { surplus: SURPLUS } }, Q, ["surplus"]);
  ok("without a loaded entry, run dates come from LOADTRACKER as before (none here), and no run-date view is asked", same(plain.loaded, []) && plain.loadedBy === undefined && typo.loadedBy === undefined && w.sf.statements.at(-1)!.statement.includes("LOADTRACKER") && same(w.sf.statements.at(-1)!.bindings, [T("FIN_STOCK_A")]), w.sf.statements.at(-1));
  const wrongView = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { surplus: { ...SURPLUS, joins: [{ ...SURPLUS.joins![0], view: "ENTITY.STOCK_PERIOD" }, SURPLUS.joins![1]] } } }, Q, ["surplus"]);
  ok("a join to a view that isn't in that schema fails on that field", /does not exist or not authorized/.test(wrongView.fields[0].error ?? ""), wrongView.fields[0].error);

  // run dates: one schema can't be read, a bad loaded entry, and loadedBySchema itself
  const w2 = world({ failLoaded: ["ENTITY"] });
  const r2 = await runStatutory(w2.api, w2.creds.database, w2.creds.schema, MAPPING, Q, ["surplus"]);
  ok("a schema whose run-date view can't be read is left out, and the figures still come back", same(r2.loaded, [{ view: "CORE_FIN", at: "2026-11-16" }]) && r2.fields[0].rows.length === 3, r2.loaded);
  const w3 = world();
  const r3 = await runStatutory(w3.api, w3.creds.database, w3.creds.schema, { ...MAPPING, loaded: { view: "BATCH_RUN; DROP", at: "RUN_DATE" } }, Q, ["surplus"]);
  ok("a loaded entry that isn't valid is ignored: dates from LOADTRACKER as before, nothing hostile sent", r3.loadedBy === undefined && w3.sf.statements.every((s) => !s.statement.includes("DROP")) && w3.sf.statements.at(-1)!.statement.includes("LOADTRACKER"));
  ok("loadedBySchema asks nothing for a bad database or a bad entry, and skips bad schema names", same(await loadedBySchema(w3.api, "X; DROP", { view: "BATCH_RUN", at: "RUN_DATE" }, ["CORE_FIN"]), []) && same(await loadedBySchema(w3.api, DB, { view: "A--", at: "RUN_DATE" }, ["CORE_FIN"]), []) && same(await loadedBySchema(w3.api, DB, { view: "BATCH_RUN", at: "RUN_DATE" }, ["X; DROP", "core_fin", "CORE_FIN"]), [{ view: "CORE_FIN", at: "2026-11-16" }]));
  const none = await runStatutory(w3.api, w3.creds.database, w3.creds.schema, MAPPING, Q, ["gpw"]);
  ok("when nothing ran, no run dates are asked for", same(none.loaded, []) && none.loadedBy === "schema");
  for (const [l, says] of [[undefined, null], [{ view: "BATCH_RUN", at: "RUN_DATE" }, null], ["BATCH_RUN", "loaded must be {view, at}"], [{ view: "CORE_FIN.BATCH_RUN", at: "RUN_DATE" }, "loaded.view must be a view name (the same view in each schema, so no schema in front)"], [{ view: "BATCH_RUN", at: "MAX(RUN_DATE)" }, "loaded.at must be a column name"], [{ view: "BATCH_RUN" }, "loaded.at must be a column name"]] as const)
    ok(`loaded ${JSON.stringify(l)}: ${says ?? "fine"}`, loadedProblem(l) === says, loadedProblem(l));
  ok("readMapping keeps the loaded entry, and leaves it out when there is none", same(readMapping({ fields: {}, loaded: { view: "B", at: "D" } }), { fields: {}, loaded: { view: "B", at: "D" } }) && same(readMapping({ fields: {} }), { fields: {} }));
  ok("fieldStatus gives each figure's problem, null when it is mapped", (() => { const s = fieldStatus({ fields: { surplus: SURPLUS, npe: { ...NPE, value: "PHS" } } }); return s.find((x) => x.id === "surplus")!.problem === null && s.find((x) => x.id === "npe")!.problem === "value must be ALIAS.COLUMN when there are joins" && s.find((x) => x.id === "gpw")!.problem === "not mapped"; })());
}

// ---------- startsWith with stateStrip, plus, an in list of 80, numeric columns against bound text ----------
const BY_REGION: FieldMap = { ...BY_STATE, view: "CORE_FIN.GEO_REGION", state: "GEO.REGION", where: [...BY_STATE.where!, { column: "GEO.REGION", startsWith: "Reported:" }], stateStrip: "Reported:" };
const PAID_IN: FieldMap = { ...SURPLUS, value: "S.CAP_STOCK_000", plus: ["S.PAID_IN_000"], latest: "SP.SEQ", scale: 1000 };
{
  const s = buildSql(DB, SCH, BY_REGION, Q)!;
  ok("startsWith becomes STARTSWITH(column, ?) with the prefix bound", s.statement.includes(' AND "SP".LOB_NAME IS NOT NULL AND STARTSWITH("GEO".REGION, ?) QUALIFY ') && same(s.bindings.slice(-1), [T("Reported:")]) && !s.statement.includes("Reported"), s.statement);
  ok("stateStrip never reaches the SQL", !buildSql(DB, SCH, { ...BY_REGION, stateStrip: "'; DROP" }, Q)!.statement.includes("DROP"));
  const pl = buildSql(DB, SCH, PAID_IN, Q)!;
  ok("plus: the exact value expression, a null counted as zero but all nulls null", pl.statement.includes('CASE WHEN "S".CAP_STOCK_000 IS NULL AND "S".PAID_IN_000 IS NULL THEN NULL ELSE COALESCE("S".CAP_STOCK_000, 0) + COALESCE("S".PAID_IN_000, 0) END AS VAL'), pl.statement);
  const pls = buildSql(DB, SCH, { ...PAID_IN, sum: true, latest: undefined, plus: ["S.PAID_IN_000", "S.PHS_000"] }, Q)!;
  ok("plus with sum: the whole expression is summed, with up to four extra columns", pls.statement.includes('SUM(CASE WHEN "S".CAP_STOCK_000 IS NULL AND "S".PAID_IN_000 IS NULL AND "S".PHS_000 IS NULL THEN NULL ELSE COALESCE("S".CAP_STOCK_000, 0) + COALESCE("S".PAID_IN_000, 0) + COALESCE("S".PHS_000, 0) END) AS VAL') && / GROUP BY 1, 2, 3, 4, 5 ORDER BY/.test(pls.statement), pls.statement);
  ok("plus on a single view without aliases works too", buildSql(DB, SCH, { ...OLD, plus: ["NPW_000"] }, Q)!.statement.includes("CASE WHEN DPW_000 IS NULL AND NPW_000 IS NULL THEN NULL ELSE COALESCE(DPW_000, 0) + COALESCE(NPW_000, 0) END AS VAL"));
  const ids = [...Array.from({ length: 79 }, (_, i) => String(1000 + i)), "140"];
  const byIds: FieldMap = { ...BY_LINE, where: [{ column: "SP.LOB_ID", in: ids }, { column: "FP.ANN_FACTOR", equals: "1" }, { column: "SP.PERIOD_END", month: 12 }] };
  ok("an in list of 80 is allowed, and every value is bound as text", mapProblem("dpw_by_line", byIds) === null && (() => { const b = buildSql(DB, SCH, byIds, Q)!; return b.bindings.filter((x) => x.type === "TEXT").length === 2 + 80 + 1 && b.statement.includes(`"SP".LOB_ID IN (${Array(80).fill("?").join(", ")})`) && !b.statement.includes("140"); })());

  const w = world();
  const r = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { dpw_by_state: BY_REGION, paid_in_capital: PAID_IN, dpw_by_line: byIds,
    npe: { ...NPE, where: [{ column: "SP.LOB_NAME", equals: "Total" }, { column: "FP.ANN_FACTOR", equals: "1" }, { column: "SP.PERIOD_END", month: 12 }] },
    loss_ratio: { ...LOSS, where: [...LOSS.where!, { column: "F.LOSS_RATIO", notEquals: "99999999999999" }] },
    surplus: { ...PAID_IN, sum: true, latest: undefined } } }, Q, ["dpw_by_state", "paid_in_capital", "dpw_by_line", "npe", "loss_ratio", "surplus"]);
  const f = (id: string) => r.fields.find((x) => x.id === id)!;
  ok("startsWith keeps only the state rows, and stateStrip takes the prefix off", same(sortRows(f("dpw_by_state").rows), sortRows([{ code: "12345", year: 2024, line: null, state: "FL", value: 700_000 }, { code: "12345", year: 2024, line: null, state: "TX", value: 450_000 }, { code: "23456", year: 2024, line: null, state: "FL", value: 900_000 }])), f("dpw_by_state").rows);
  ok("plus adds the two columns of one row, a null counting as zero, null when both are null, then scale", same(f("paid_in_capital").rows.map((x) => [x.code, x.year, x.value]), [["12345", 2023, 100_000], ["12345", 2024, 200_000], ["23456", 2024, null]]), f("paid_in_capital").rows);
  ok("plus with sum adds the rows up too (both 2024 versions here), still null when nothing is there", same(f("surplus").rows.map((x) => [x.code, x.year, x.value]), [["12345", 2023, 100_000], ["12345", 2024, 205_000], ["23456", 2024, null]]), f("surplus").rows);
  ok("in on a number column with bound text values picks the lines by id", same(f("dpw_by_line").rows.map((x) => [x.line, x.value]), [["Homeowners", 420_000]]), f("dpw_by_line").rows);
  ok("equals on a number column (an annualisation factor of 1) with a bound text value", same(f("npe").rows.map((x) => x.value), [1_000_000, 1_150_000, 900_000]), f("npe").rows);
  ok("notEquals on the value column leaves out the sentinel", same(f("loss_ratio").rows.map((x) => [x.code, x.value]), [["12345", 60], ["12345", 61]]), f("loss_ratio").rows);
  const loose = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { dpw_by_state: { ...BY_REGION, where: BY_STATE.where } } }, Q, ["dpw_by_state"]);
  ok("without the startsWith condition, a state that doesn't start with the prefix is left as it is", same(sortRows(loose.fields[0].rows.map((x) => x.state)), sortRows(["FL", "TX", "Region:Southeast", "Zone:3", "FL"])), loose.fields[0].rows);
}

// ---------- group lookups through a membership view, from the same mapping as company lookups ----------
const GROUPED: FieldMap = {
  view: "CORE_FIN.FIN_FLOW_B", as: "F", joins: [
    CHAIN[0], CHAIN[1],
    { view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "SP.ENTITY_ID", right: "E.ENTITY_ID" }], when: "company" },
    { view: "ENTITY.ENTITY_LIST", as: "GE", on: [{ left: "SP.ENTITY_ID", right: "GE.ENTITY_ID" }], when: "group" },
    { view: "ENTITY.ENTITY_LIST", as: "M", on: [{ left: "GE.ENTITY_ID", right: "M.GROUP_ENT_ID" }], when: "group" },
    { view: "ENTITY.GROUP_MEMBERS", as: "MS", on: [{ left: "M.INST_ID", right: "MS.INST_ID" }], when: "group" },
  ],
  entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME", group: "MS.GROUP_CD", groupName: "MS.GROUP_NAME" },
  year: "SP.PERIOD_END", yearIsDate: true, value: "F.NPE_000",
  where: [{ column: "SP.LOB_NAME", equals: "Total" }, { column: "FP.ANNUALISED", equals: "Y" }, { column: "SP.PERIOD_END", month: 12 }],
  latest: ["SP.SEQ", { column: "MS.MEMBER_PERIOD", when: "group" }], distinct: true, scale: 1000,
};
{
  ok("a mapping with company-only and group-only joins has nothing wrong with it", mapProblem("npe", GROUPED) === null, mapProblem("npe", GROUPED));
  const co = buildSql(DB, SCH, GROUPED, Q)!;
  ok("a company lookup: the exact SQL, with none of the group-only joins", co.statement === 'SELECT DISTINCT "E".NAIC_CD AS CODE, "E".ENTITY_NAME AS NAME, YEAR("SP".PERIOD_END) AS YR, NULL AS LINE, NULL AS STATE, "F".NPE_000 AS VAL FROM MI_XPRESSCLOUD.CORE_FIN.FIN_FLOW_B AS "F" JOIN MI_XPRESSCLOUD.CORE_FIN.FLOW_PERIOD AS "FP" ON "F".FLOW_ID = "FP".FLOW_ID JOIN MI_XPRESSCLOUD.CORE_FIN.STOCK_PERIOD AS "SP" ON "FP".STOCK_PERIOD_ID = "SP".PERIOD_ID JOIN MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "E" ON "SP".ENTITY_ID = "E".ENTITY_ID WHERE "E".NAIC_CD IN (?, ?) AND YEAR("SP".PERIOD_END) BETWEEN ? AND ? AND "SP".LOB_NAME = ? AND "FP".ANNUALISED = ? AND MONTH("SP".PERIOD_END) = ? QUALIFY ROW_NUMBER() OVER (PARTITION BY "E".NAIC_CD, "E".ENTITY_NAME, YEAR("SP".PERIOD_END) ORDER BY "SP".SEQ DESC) = 1 ORDER BY 1, 3 LIMIT 20000', co.statement);
  ok("and nothing of the group's chain appears in it", !/"GE"|"M"|"MS"|GROUP_MEMBERS|MEMBER_PERIOD/.test(co.statement));
  const gr = buildSql(DB, SCH, GROUPED, { ...Q, kind: "group", codes: ["9100"] })!;
  ok("a group lookup from the same mapping: the exact SQL, through the group entity, its members and the membership view", gr.statement === 'SELECT DISTINCT "MS".GROUP_CD AS CODE, "MS".GROUP_NAME AS NAME, YEAR("SP".PERIOD_END) AS YR, NULL AS LINE, NULL AS STATE, "F".NPE_000 AS VAL FROM MI_XPRESSCLOUD.CORE_FIN.FIN_FLOW_B AS "F" JOIN MI_XPRESSCLOUD.CORE_FIN.FLOW_PERIOD AS "FP" ON "F".FLOW_ID = "FP".FLOW_ID JOIN MI_XPRESSCLOUD.CORE_FIN.STOCK_PERIOD AS "SP" ON "FP".STOCK_PERIOD_ID = "SP".PERIOD_ID JOIN MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "GE" ON "SP".ENTITY_ID = "GE".ENTITY_ID JOIN MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "M" ON "GE".ENTITY_ID = "M".GROUP_ENT_ID JOIN MI_XPRESSCLOUD.ENTITY.GROUP_MEMBERS AS "MS" ON "M".INST_ID = "MS".INST_ID WHERE "MS".GROUP_CD IN (?) AND YEAR("SP".PERIOD_END) BETWEEN ? AND ? AND "SP".LOB_NAME = ? AND "FP".ANNUALISED = ? AND MONTH("SP".PERIOD_END) = ? QUALIFY ROW_NUMBER() OVER (PARTITION BY "MS".GROUP_CD, "MS".GROUP_NAME, YEAR("SP".PERIOD_END) ORDER BY "SP".SEQ DESC, "MS".MEMBER_PERIOD DESC) = 1 ORDER BY 1, 3 LIMIT 20000', gr.statement);
  ok("its bindings", same(gr.bindings, [T("9100"), N(2023), N(2024), T("Total"), T("Y"), N(12)]), gr.bindings);
  const whereWhen = buildSql(DB, SCH, { ...GROUPED, where: [...GROUPED.where!, { column: "MS.MEMBER_PERIOD", isNull: false, when: "group" }, { column: "E.NAIC_CD", notEquals: "00000", when: "company" }] }, Q)!;
  ok("a where entry marked for groups is left out of a company lookup, and one marked for companies is kept", !whereWhen.statement.includes("MEMBER_PERIOD") && whereWhen.statement.includes('AND "E".NAIC_CD <> ?') && whereWhen.bindings.at(-1)!.value === "00000");
  const whereG = buildSql(DB, SCH, { ...GROUPED, where: [...GROUPED.where!, { column: "MS.MEMBER_PERIOD", isNull: false, when: "group" }, { column: "E.NAIC_CD", notEquals: "00000", when: "company" }] }, { ...Q, kind: "group", codes: ["9100"] })!;
  ok("and the other way round for a group lookup", whereG.statement.includes('AND "MS".MEMBER_PERIOD IS NOT NULL') && !whereG.statement.includes('"E".') && whereG.bindings.length === 6);
  const noGn = buildSql(DB, SCH, { ...GROUPED, entity: { company: "E.NAIC_CD", group: "MS.GROUP_CD" } }, { ...Q, kind: "group", codes: ["9100"] })!;
  ok("without a name column, NULL is selected as the name", noGn.statement.includes('"MS".GROUP_CD AS CODE, NULL AS NAME'));
  ok("without distinct there is no DISTINCT", !buildSql(DB, SCH, { ...GROUPED, distinct: undefined }, Q)!.statement.includes("DISTINCT"));

  const w = world();
  const r = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { npe: GROUPED } }, Q, ["npe"]);
  ok("the company lookup gives each company's own figures", same(r.fields[0].rows.map((x) => [x.code, x.year, x.value]), [["12345", 2023, 1_000_000], ["12345", 2024, 1_150_000], ["23456", 2024, 900_000]]), r.fields[0].rows);
  const g = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { npe: GROUPED } }, { kind: "group", codes: ["9100"], fromYear: 2023, toYear: 2024 }, ["npe"]);
  ok("the group lookup gives the group's combined figures once a year, named from the membership view", same(g.fields[0].rows.map((x) => [x.code, x.year, x.value]), [["9100", 2023, 1_300_000], ["9100", 2024, 1_400_000]]) && same(g.entities, [{ code: "9100", name: "Calloway Group" }]), { rows: g.fields[0].rows, entities: g.entities });
  const stock: FieldMap = { ...GROUPED, view: "CORE_FIN.FIN_STOCK_A", as: "S", joins: [{ view: "CORE_FIN.STOCK_PERIOD", as: "SP", on: [{ left: "S.PERIOD_ID", right: "SP.PERIOD_ID" }] }, ...GROUPED.joins!.slice(2)], value: "S.PHS_000", where: [{ column: "SP.LOB_NAME", equals: "Total" }, { column: "SP.PERIOD_END", month: 12 }], latest: undefined };
  const fan = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { surplus: { ...stock, distinct: undefined } } }, { kind: "group", codes: ["9100"], fromYear: 2024, toYear: 2024 }, ["surplus"]);
  ok("without distinct or latest, the member list fans one figure out to one row per member and membership period", fan.fields[0].rows.length === 3 && fan.fields[0].rows.every((x) => x.value === 9_000_000), fan.fields[0].rows);
  const dist = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { surplus: stock } }, { kind: "group", codes: ["9100"], fromYear: 2023, toYear: 2024 }, ["surplus"]);
  ok("distinct collapses the fan-out to one row a year", same(dist.fields[0].rows.map((x) => [x.year, x.value]), [[2023, 8_000_000], [2024, 9_000_000]]), dist.fields[0].rows);
  const tarrow = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { surplus: stock } }, { kind: "company", codes: ["23456"], fromYear: 2024, toYear: 2024 }, ["surplus"]);
  ok("a company in no group still comes back on a company lookup, because the group's joins aren't used", same(tarrow.fields[0].rows.map((x) => [x.code, x.value]), [["23456", 3_000_000]]), tarrow.fields[0].rows);
  const eight = { ...GROUPED, joins: [...GROUPED.joins!, { view: "ENTITY.GROUP_LIST", as: "GL", on: [{ left: "E.GROUP_ID", right: "GL.GROUP_ID" }], kind: "left" as const, when: "company" as const }, { view: "ENTITY.GROUP_LIST", as: "GL2", on: [{ left: "M.GROUP_ID", right: "GL2.GROUP_ID" }], kind: "left" as const, when: "group" as const }] };
  ok("eight joins are allowed", eight.joins.length === 8 && mapProblem("npe", eight) === null, mapProblem("npe", eight));

  const G: any = GROUPED;
  for (const [name, m, says] of [
    ["entity.company on a group-only alias", { ...G, entity: { ...G.entity, company: "MS.NAIC_CD" } }, "entity.company names alias MS, which is only joined for group lookups"],
    ["entity.group on a company-only alias", { ...G, entity: { ...G.entity, group: "E.GROUP_CD" } }, "entity.group names alias E, which is only joined for company lookups"],
    ["entity.groupName on a company-only alias", { ...G, entity: { ...G.entity, groupName: "E.ENTITY_NAME" } }, "entity.groupName names alias E, which is only joined for company lookups"],
    ["entity.name on a company-only alias with no groupName", { ...G, entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME", group: "MS.GROUP_CD" } }, "entity.name names alias E, which is only joined for company lookups"],
    ["the value on a group-only alias", { ...G, value: "GE.NPE_000" }, "value names alias GE, which is only joined for group lookups"],
    ["a where entry for every lookup on a group-only alias", { ...G, where: [{ column: "MS.MEMBER_PERIOD", isNull: false }] }, "where[0].column names alias MS, which is only joined for group lookups"],
    ["a latest column for every lookup on a group-only alias", { ...G, latest: ["SP.SEQ", "MS.MEMBER_PERIOD"] }, "latest[1] names alias MS, which is only joined for group lookups"],
    ["a join for every lookup linked to a group-only alias", { ...G, joins: [...G.joins, { view: "ENTITY.GROUP_LIST", as: "GL", on: [{ left: "M.GROUP_ID", right: "GL.GROUP_ID" }] }] }, "joins[6].on[0].left names alias M, which is only joined for group lookups"],
    ["a group-only join linked to a company-only alias", { ...G, joins: [...G.joins.slice(0, 5), { ...G.joins[5], on: [{ left: "E.INST_ID", right: "MS.INST_ID" }] }] }, "joins[5].on[0].left names alias E, which is only joined for company lookups"],
    ["a join for another kind of lookup", { ...G, joins: [...G.joins.slice(0, 2), { ...G.joins[2], when: "holding" }] }, 'joins[2].when must be "company" or "group"'],
    ["a where entry for another kind of lookup", { ...G, where: [{ column: "SP.LOB_NAME", equals: "Total", when: "both" }] }, 'where[0].when must be "company" or "group"'],
    ["a latest column for another kind of lookup", { ...G, latest: ["SP.SEQ", { column: "MS.MEMBER_PERIOD", when: 1 }] }, 'latest[1].when must be "company" or "group"'],
    ["four latest columns", { ...G, latest: ["SP.SEQ", "SP.SEQ", "SP.SEQ", "SP.SEQ"] }, "latest must be a column, or a list of 1 to 3 columns"],
    ["an empty latest list", { ...G, latest: [] }, "latest must be a column, or a list of 1 to 3 columns"],
    ["a latest column that is SQL", { ...G, latest: ["SP.SEQ DESC; --"] }, "latest[0] must be a column name"],
    ["a latest object column that is SQL", { ...G, latest: [{ column: "SP.SEQ)" }] }, "latest[0].column must be a column name"],
    ["distinct that is text", { ...G, distinct: "yes" }, "distinct must be true or false"],
    ["distinct with sum", { ...G, sum: true }, "sum and distinct can't be used together: removing repeated rows before adding up would also drop real rows that happen to have the same figures"],
  ] as const) {
    const got = mapProblem("npe", m);
    ok(`refused: ${name}, saying "${says}"`, got === says && buildSql(DB, SCH, m as any, Q) === null && buildSql(DB, SCH, m as any, { ...Q, kind: "group", codes: ["9100"] }) === null, got);
  }
  ok("a group-only join may use an alias only group lookups have, when the mapping has no group column it is simply never used", mapProblem("npe", { ...G, entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME" }, latest: "SP.SEQ" }) === null);
  ok("a group lookup on a mapping with no group column still gives the plain existing message", buildSql(DB, SCH, { ...G, entity: { company: "E.NAIC_CD" }, latest: "SP.SEQ" }, { ...Q, kind: "group" }) === null);
}

// ---------- the loss and LAE ratio, a new figure ----------
{
  const P = await import(new URL("../../supabase/functions/_shared/profile.ts", import.meta.url).href);
  const { STAT_FIELDS, DEFAULT_STAT_FIELDS } = await import(new URL("../../supabase/functions/_shared/statutory.ts", import.meta.url).href);
  const ids = STAT_FIELDS.map((f: any) => f.id);
  ok("the loss and LAE ratio is the 18th figure, straight after the loss ratio, a percentage by year", ids.length === 18 && ids.indexOf("loss_lae_ratio") === ids.indexOf("loss_ratio") + 1 && same(STAT_FIELDS.find((f: any) => f.id === "loss_lae_ratio"), { id: "loss_lae_ratio", label: "Loss and LAE ratio", unit: "pct", by: "year" }) && STAT_FIELDS.find((f: any) => f.id === "loss_ratio").label === "Loss ratio");
  ok("it is one of the figures a query gets by default, straight after the loss ratio", same(DEFAULT_STAT_FIELDS, ["dpw_by_line", "npw_by_line", "dpw_by_state", "surplus", "loss_ratio", "loss_lae_ratio", "expense_ratio", "combined_ratio"]));
  const w = world();
  const r = await runStatutory(w.api, w.creds.database, w.creds.schema, MAPPING, Q, DEFAULT_STAT_FIELDS);
  const ll = r.fields.find((f) => f.id === "loss_lae_ratio")!;
  ok("unmapped, as in a mapping saved before it existed, it shows as not mapped and is never an error", ll.mapped === false && ll.error === null && ll.rows.length === 0 && r.fields.find((f) => f.id === "loss_ratio")!.rows.length === 3);
  const mapped = await runStatutory(w.api, w.creds.database, w.creds.schema, { fields: { loss_lae_ratio: { ...LOSS, value: "F.LOSS_RATIO" } } }, Q, ["loss_lae_ratio"]);
  ok("mapped, it comes back like any other ratio", mapped.fields[0].mapped === true && mapped.fields[0].rows.length === 3 && mapped.fields[0].unit === "pct");
  ok("company profiles carry it as a series beside the loss ratio", P.SERIES.indexOf("loss_lae_ratio") === P.SERIES.indexOf("loss_ratio") + 1);
  const s = P.sampleFacts("2026-11-14");
  ok("in the sample, loss and LAE ratio plus expense ratio is the combined ratio, and the loss ratio is the smaller", s.series.loss_lae_ratio.every((v: number, i: number) => Math.abs(v + s.series.expense_ratio[i] - s.series.combined_ratio[i]) < 1e-9 && s.series.loss_ratio[i] < v));
  const text = JSON.stringify(P.plainText(s));
  ok("the profile's underwriting text gives the loss and LAE ratio too", text.includes("loss ratio 50.2%, loss and LAE ratio 60.7%, expense ratio 30.8%, combined ratio 91.5%"), text.match(/In 2025: [^"]*/)?.[0]);
  const noLl = { ...s, series: { ...s.series, loss_lae_ratio: undefined } };
  ok("without it, the text reads as before", JSON.stringify(P.plainText(noLl)).includes("loss ratio 50.2%, expense ratio 30.8%, combined ratio 91.5%"));
}

// ---------- the saved-result id ----------
{
  const clock = fakeClock(), db = memoryDb(clock), sf = fakeSnowflake(clock, { on: joinReader({ tables: TABLES }) });
  const api = new Snowflake(snowflakeCreds(env(PAT)), { fetch: sf.fetch, now: clock.fn, sleep: clock.sleep });
  const saved = watchStore(db);
  const run = (m: Mapping) => savedOrFreshStatutory(api, db, DB, SCH, m, Q, ["surplus"], { now: clock.now });
  const a = await run(MAPPING);
  ok("a joined result is saved and passes the database's checks", a.saved === true && saved.filter((s) => /^statutory:[0-9a-f]{32}$/.test(s.id)).length === 1 && saved.every((s) => s.problem === null), saved);
  ok("the same mapping opens from the store", (await run(MAPPING)).fromStore === true);
  const changedJoin = await run({ ...MAPPING, fields: { ...MAPPING.fields, surplus: { ...SURPLUS, joins: [{ ...SURPLUS.joins![0], kind: "left" }, SURPLUS.joins![1]] } } });
  ok("changing a join is a new saved result, so a corrected mapping is used straight away", changedJoin.fromStore === false);
  const changedWhere = await run({ ...MAPPING, fields: { ...MAPPING.fields, surplus: { ...SURPLUS, where: [{ column: "SP.PERIOD_END", month: 12 }] } } });
  ok("changing a condition is a new saved result", changedWhere.fromStore === false);
  const changedLoaded = await run({ ...MAPPING, loaded: { view: "BATCH_RUN", at: "OTHER_DATE" } });
  ok("changing the loaded entry is a new saved result", changedLoaded.fromStore === false);
  const noLoaded = await run({ fields: MAPPING.fields });
  ok("removing it is a new saved result too", noLoaded.fromStore === false);
  // a mapping with no loaded entry keeps the id it had before this change, so results saved then still open
  const old = { fields: { surplus: OLD } } as Mapping;
  const oldId = "statutory:" + await shortHash(JSON.stringify([Q.kind, [...Q.codes].sort(), Q.fromYear, Q.toYear, ["surplus"], [OLD]]));
  db.store.set(oldId, { id: oldId, kind: "statutory", label: "x", doc: { ...a, fields: [] }, fetched_at: "2026-11-01T00:00:00Z" } as any);
  ok("a result saved under the earlier id formula still opens", (await savedOrFreshStatutory(null, db, DB, SCH, old, Q, ["surplus"], { now: clock.now })).fromStore === true);
}

// ---------- through the function: status and Discover across schemas ----------
function fnWorld(mapping: unknown = MAPPING) {
  const clock = fakeClock(), db = memoryDb(clock), sf = fakeSnowflake(clock, { on: joinReader({ tables: TABLES, views: ["CORE_FIN.FIN_FLOW_A", "ENTITY.FIN_FLOW_B"] }) });
  if (mapping !== null) db.settings.set("statutory_mapping", mapping as Record<string, unknown>);
  const deps = { env: env(PAT), fetch: sf.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown, over: Record<string, unknown> = {}) => { const res: Response = await statutory.handle(req("snl-statutory", body), { ...deps, ...over }); return { status: res.status, body: await res.json() }; };
  return { clock, db, sf, call };
}
{
  const w = fnWorld({ ...MAPPING, fields: { ...MAPPING.fields, npe: { ...NPE, joins: [{ ...CHAIN[0], on: [{ left: "X.FLOW_ID", right: "FP.FLOW_ID" }] }, ...CHAIN.slice(1)] } } });
  const s = await w.call({ action: "status" });
  const npe = s.body.fields.find((x: any) => x.id === "npe");
  ok("status gives the reason a figure isn't mapped, in plain words", npe.mapped === false && npe.problem === "joins[0].on[0].left names alias X, which isn't declared" && s.body.fields.find((x: any) => x.id === "surplus").problem === null, npe);
  ok("status says the loaded entry is fine", s.body.loadedProblem === null && s.body.mapped === true);
  const bad = await fnWorld({ ...MAPPING, loaded: { view: "BATCH_RUN", at: "A--" } }).call({ action: "status" });
  ok("status says what is wrong with a loaded entry", bad.body.loadedProblem === "loaded.at must be a column name");

  const q = await w.call({ action: "query", codes: ["12345"], fromYear: 2023, toYear: 2024, fields: ["surplus", "ceded_by_reinsurer"] });
  ok("a query through the function answers with the joined figures and the run dates by schema", q.status === 200 && q.body.fields[0].rows.length === 2 && q.body.fields[1].rows.length === 3 && q.body.loadedBy === "schema" && same(q.body.loaded.map((l: any) => l.view), ["CORE_FIN", "ENTITY", "REINS"]), q.body);
}
{
  const w = fnWorld();
  const saved = watchStore(w.db);
  const sc = await w.call({ action: "discover", schemas: true });
  ok("Discover lists the database's schemas, without INFORMATION_SCHEMA", sc.status === 200 && same(sc.body.schemas.map((x: any) => x.name), ["CORE_FIN", "ENTITY", "REINS"]) && sc.body.schemas[1].comment === "Made-up: companies and groups" && sc.body.fromStore === false && sc.body.truncated === false, sc.body);
  ok("it asks INFORMATION_SCHEMA.SCHEMATA with the name to leave out bound", w.sf.statements[0].statement === "SELECT SCHEMA_NAME, COMMENT FROM MI_XPRESSCLOUD.INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME <> ? ORDER BY SCHEMA_NAME LIMIT 1000" && same(w.sf.statements[0].bindings, [T("INFORMATION_SCHEMA")]));
  const again = await w.call({ action: "discover", schemas: true }), sent1: number = w.sf.statements.length;
  const fresh = await w.call({ action: "discover", schemas: true, refresh: true }), sent2: number = w.sf.statements.length;
  ok("the schema list opens from the store the second time, and refresh asks again", again.body.fromStore === true && sent1 === 1 && fresh.body.fromStore === false && sent2 === 2, { sent1, sent2 });
  const v = await w.call({ action: "discover", schema: "core_fin" });
  ok("Discover lists the views in a chosen schema, naming the schema", v.status === 200 && v.body.schema === "CORE_FIN" && same(v.body.views.map((x: any) => x.name), ["BATCH_RUN", "FIN_FLOW_A", "FIN_FLOW_B", "FIN_STOCK_A", "FLOW_PERIOD", "GEO_FLOW", "GEO_REGION", "STOCK_PERIOD"]) && same(w.sf.statements.at(-1)!.bindings, [T("CORE_FIN")]), v.body);
  const vl = await w.call({ action: "discover", schema: "CORE_FIN", like: "flow_" });
  ok("a name filter works in a chosen schema", same(vl.body.views.map((x: any) => x.name), ["FIN_FLOW_A", "FIN_FLOW_B", "FLOW_PERIOD"]) && same(w.sf.statements.at(-1)!.bindings, [T("CORE_FIN"), T("%flow_%")]), vl.body);
  const e = await w.call({ action: "discover", schema: "ENTITY" });
  ok("another schema lists its own views", same(e.body.views.map((x: any) => x.name), ["BATCH_RUN", "ENTITY_LIST", "FIN_FLOW_B", "GROUP_LIST", "GROUP_MEMBERS"]), e.body);
  const c1 = await w.call({ action: "discover", schema: "CORE_FIN", view: "FIN_FLOW_B" });
  ok("Discover lists a view's columns in a chosen schema", c1.status === 200 && c1.body.schema === "CORE_FIN" && c1.body.view === "FIN_FLOW_B" && same(c1.body.columns.map((x: any) => x.name), ["FLOW_ID", "NPE_000", "DPW_000", "LOSS_RATIO"]) && same(w.sf.statements.at(-1)!.bindings, [T("CORE_FIN"), T("FIN_FLOW_B")]), c1.body);
  const c2 = await w.call({ action: "discover", schema: "ENTITY", view: "FIN_FLOW_B" });
  ok("the same view name in another schema is a separate saved entry, not the first one's columns", c2.body.fromStore === false && c2.body.schema === "ENTITY" && c2.body.columns.length === 0, c2.body);
  ok("and each opens from its own saved entry afterwards", (await w.call({ action: "discover", schema: "CORE_FIN", view: "FIN_FLOW_B" })).body.columns.length === 4 && (await w.call({ action: "discover", schema: "ENTITY", view: "FIN_FLOW_B" })).body.columns.length === 0);
  const ids = [...new Set(saved.map((x) => x.id))];
  ok("saved entries for other schemas have their own ids, apart from the default schema's", ids.includes("discover:schemas") && ids.filter((i) => i.startsWith("discover:in.")).length === 5 &&!ids.some((i) => i === "discover:views" || i.startsWith("discover:cols.")) && saved.every((x) => x.problem === null), ids);
  const def = await w.call({ action: "discover" });
  ok("with no schema, Discover still lists the default schema's views under the old id", def.status === 200 && same(w.sf.statements.at(-1)!.bindings, [T("XPRESSFEED")]) && def.body.schema === undefined && w.db.store.has("discover:views"));
  const n = w.sf.log.length;
  for (const schema of ["X; DROP TABLE Y", 'a"b', "A--", "A.B", "", "  ", 42.5, ["A"], { name: "A" }]) {
    const r = await w.call({ action: "discover", schema });
    ok(`Discover with schema ${JSON.stringify(schema)} is refused and nothing is sent`, r.status === 400 && r.body.message === "schema must be a schema name.", r.body);
  }
  const badView = await w.call({ action: "discover", schema: "CORE_FIN", view: "A--" });
  ok("a bad view name in a chosen schema is refused too", badView.status === 400 && badView.body.message === "view must be a view name." && w.sf.log.length === n);
  const hostile = await w.call({ action: "discover", schema: "CORE_FIN", like: "x'; DROP TABLE y; --%" });
  ok("a filter that carries SQL is cleaned and bound in a chosen schema too", hostile.status === 200 && !/DROP|--|'/.test(w.sf.statements.at(-1)!.statement), w.sf.statements.at(-1));
  for (const body of [{ action: "discover", schemas: true }, { action: "discover", schema: "CORE_FIN" }, { action: "discover", schema: "CORE_FIN", view: "FIN_FLOW_B" }, { action: "discover", schema: "A--" }]) {
    const r = await w.call(body, { whoIs: reader });
    ok(`a reader asking Discover for ${JSON.stringify(body)} gets 403 and learns nothing`, r.status === 403 && r.body.error === "forbidden" && same(Object.keys(r.body).sort(), ["error", "message"]));
  }
  const off = fnWorld();
  const offCall = (b: unknown) => off.call(b, { env: env({}) });
  for (const [id, row] of w.db.store) off.db.store.set(id, row);
  ok("saved schema lists and columns still open when Snowflake isn't set up", (await offCall({ action: "discover", schemas: true })).body.fromStore === true && (await offCall({ action: "discover", schema: "CORE_FIN", view: "FIN_FLOW_B" })).body.columns.length === 4);
  const notYet = await offCall({ action: "discover", schema: "REINS" });
  ok("an unsaved schema answers not set up yet", notYet.status === 503 && notYet.body.error === "not_configured", notYet.body);
  const badDb = fnWorld();
  const bd = await badDb.call({ action: "discover", schemas: true }, { env: env({ ...PAT, SNOWFLAKE_DATABASE: "MI; DROP" }) });
  ok("listing schemas with a database that isn't a name is refused in plain words", bd.status === 502 && bd.body.message === "SNOWFLAKE_DATABASE isn't a valid name." && badDb.sf.log.length === 0, bd.body);
}

done();
