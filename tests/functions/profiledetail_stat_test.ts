// The detailed company profile, the statutory side (supabase/functions/_shared/statutory.ts): the figures added for it
// (app-level names only, the first 18 kept in their order, the Statutory view's default set unchanged), every new
// figure "not mapped" until the owner maps it, and the one addition to the mapping language: an optional tag column
// on a figure by counterparty, selected as TAG, kept on each row, grouped on with sum and checked like any column.
// Mappings without a tag make exactly the SQL they made before. Every view, column, company and figure is made up.
(globalThis as any).__SNL_TEST__ = true;
import { Snowflake, snowflakeCreds } from "../../supabase/functions/_shared/snowflake.ts";
import { buildSql, DEFAULT_STAT_FIELDS, type FieldMap, fieldStatus, mapProblem, type Mapping, runStatutory, STAT_FIELDS, STAT_POOL, type StatQuery } from "../../supabase/functions/_shared/statutory.ts";
import { checks, env, fakeClock } from "./helpers/fakes.ts";
import { fakeSnowflake } from "./helpers/snowflake.ts";
import { joinReader, type SchemaTables } from "./helpers/statjoins.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PAT = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
const DB = "MI_XPRESSCLOUD", SCH = "XPRESSFEED";
const Q: StatQuery = { kind: "company", codes: ["12345"], fromYear: 2023, toYear: 2024 };

// ---------- the figures ----------
const FIRST = ["dpw_by_line", "npw_by_line", "dpw_by_state", "surplus", "loss_ratio", "loss_lae_ratio", "expense_ratio", "combined_ratio", "gpw", "npe", "net_income", "paid_in_capital", "total_assets", "rbc_ratio", "net_reserves", "pyd", "reins_recoverable", "ceded_by_reinsurer"];
const NEW: [string, string, string, string][] = [
  ["assumed_pw", "Assumed premiums written", "usd", "year"], ["ceded_pw", "Ceded premiums written", "usd", "year"], ["losses_incurred", "Net losses and LAE incurred", "usd", "year"],
  ["uw_gain", "Net underwriting gain", "usd", "year"], ["net_inv_income", "Net investment income earned", "usd", "year"], ["realized_gains", "Net realized capital gains", "usd", "year"],
  ["dividends_paid", "Dividends to stockholders", "usd", "year"], ["capital_contributed", "Capital and surplus paid in during the year", "usd", "year"], ["surplus_notes", "Surplus notes", "usd", "year"],
  ["unassigned_funds", "Unassigned funds", "usd", "year"], ["cash_from_ops", "Net cash from operations", "usd", "year"], ["cash_invested", "Cash and invested assets", "usd", "year"],
  ["bonds", "Bonds", "usd", "year"], ["stocks", "Common stocks", "usd", "year"], ["cash_short_term", "Cash and short-term investments", "usd", "year"],
  ["premiums_receivable", "Premiums receivable", "usd", "year"], ["total_liabilities", "Total liabilities", "usd", "year"], ["unearned_premiums", "Unearned premiums", "usd", "year"],
  ["rbc_acl", "Authorized control level risk-based capital", "usd", "year"], ["rbc_tac", "Total adjusted capital", "usd", "year"], ["pyd_two_year", "Two-year reserve development (positive is adverse)", "usd", "year"],
  ["commission_ratio", "Commission ratio", "pct", "year"], ["investment_yield", "Net yield on invested assets", "pct", "year"], ["roae", "Return on average equity", "pct", "year"],
  ["npe_by_line", "Net premiums earned by line", "usd", "line"], ["loss_lae_ratio_by_line", "Loss and LAE ratio by line", "pct", "line"],
  ["dpe_by_state", "Direct premiums earned by state", "usd", "state"], ["loss_ratio_by_state", "Direct loss ratio by state", "pct", "state"],
  ["recoverable_by_reinsurer", "Reinsurance recoverables by reinsurer", "usd", "item"], ["ay_loss_ratio", "Net loss and DCC ratio by accident year", "pct", "item"], ["ay_npe", "Net premiums earned by accident year", "usd", "item"],
];
{
  const ids = STAT_FIELDS.map((f) => f.id);
  ok("the first 18 figures are kept, in their order", same(ids.slice(0, 18), FIRST), ids.slice(0, 18));
  ok("the 31 new figures follow, each with its label, unit and kind", same(STAT_FIELDS.slice(18).map((f) => [f.id, f.label, f.unit, f.by]), NEW), STAT_FIELDS.slice(18));
  ok("49 figures in all, no id twice", ids.length === 49 && new Set(ids).size === 49);
  ok("ids are plain app-level names: lower case letters, digits and _", ids.every((id) => /^[a-z][a-z0-9_]*$/.test(id)));
  ok("the Statutory view's default set is unchanged", same(DEFAULT_STAT_FIELDS, ["dpw_by_line", "npw_by_line", "dpw_by_state", "surplus", "loss_ratio", "loss_lae_ratio", "expense_ratio", "combined_ratio"]));
  const st = fieldStatus({ fields: {} });
  ok("every new figure is not mapped until the owner maps it, and that is never an error", st.slice(18).every((f) => f.mapped === false && f.problem === "not mapped"));
  ok("eight statements run at once", STAT_POOL === 8);
}

// ---------- the tag column: what a mapping may say ----------
const REC: FieldMap = { view: "IR_RECOV", entity: { company: "NAIC_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "RECOV_000", item: "REINSURER", tag: "AUTH_FLAG", scale: 1000 };
{
  ok("a by-item figure may name a tag column", mapProblem("recoverable_by_reinsurer", REC) === null && mapProblem("ceded_by_reinsurer", { ...REC }) === null);
  ok("a tag on a figure by year, line or state is refused plainly", mapProblem("surplus", { ...REC, item: undefined }) === "tag is only for a figure by counterparty (one with an item column)"
    && mapProblem("npe_by_line", { ...REC, item: undefined, line: "LOB" }) === "tag is only for a figure by counterparty (one with an item column)");
  ok("a tag that isn't a column name is refused like any column", mapProblem("recoverable_by_reinsurer", { ...REC, tag: "AUTH; DROP TABLE X" }) === "tag must be a column name" && mapProblem("recoverable_by_reinsurer", { ...REC, tag: 7 as unknown as string }) === "tag must be a column name");
  const joined: FieldMap = { view: "REINS.RECOV", as: "R", joins: [{ view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "R.ENTITY_ID", right: "E.ENTITY_ID" }] }], entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME" }, year: "R.YR", value: "R.AMT", item: "R.REINSURER", tag: "R.AUTH" };
  ok("with joins a tag must say which view, and the view must be declared", mapProblem("recoverable_by_reinsurer", { ...joined, tag: "AUTH" }) === "tag must be ALIAS.COLUMN when there are joins" && mapProblem("recoverable_by_reinsurer", { ...joined, tag: "X.AUTH" }) === "tag names alias X, which isn't declared" && mapProblem("recoverable_by_reinsurer", joined) === null);
}

// ---------- the tag column: the SQL ----------
{
  const s = buildSql(DB, SCH, REC, Q)!;
  ok("a single view with a tag: TAG straight after ITEM, nothing else changed", s.statement === "SELECT NAIC_CD AS CODE, CO_NAME AS NAME, STMT_YEAR AS YR, NULL AS LINE, NULL AS STATE, RECOV_000 AS VAL, REINSURER AS ITEM, AUTH_FLAG AS TAG FROM MI_XPRESSCLOUD.XPRESSFEED.IR_RECOV WHERE NAIC_CD IN (?) AND STMT_YEAR BETWEEN ? AND ? ORDER BY 1, 3 LIMIT 20000", s.statement);
  const noTag = { ...REC }; delete noTag.tag;
  ok("the same mapping without a tag makes exactly the SQL a by-item figure made before", buildSql(DB, SCH, noTag, Q)!.statement === "SELECT NAIC_CD AS CODE, CO_NAME AS NAME, STMT_YEAR AS YR, NULL AS LINE, NULL AS STATE, RECOV_000 AS VAL, REINSURER AS ITEM FROM MI_XPRESSCLOUD.XPRESSFEED.IR_RECOV WHERE NAIC_CD IN (?) AND STMT_YEAR BETWEEN ? AND ? ORDER BY 1, 3 LIMIT 20000");
  const summed = buildSql(DB, SCH, { ...REC, sum: true, latest: "SEQ" }, Q)!;
  ok("with sum, the tag is grouped on (position 8), before the latest columns", summed.statement === "SELECT NAIC_CD AS CODE, CO_NAME AS NAME, STMT_YEAR AS YR, NULL AS LINE, NULL AS STATE, SUM(RECOV_000) AS VAL, REINSURER AS ITEM, AUTH_FLAG AS TAG FROM MI_XPRESSCLOUD.XPRESSFEED.IR_RECOV WHERE NAIC_CD IN (?) AND STMT_YEAR BETWEEN ? AND ? GROUP BY 1, 2, 3, 4, 5, 7, 8, SEQ QUALIFY ROW_NUMBER() OVER (PARTITION BY NAIC_CD, CO_NAME, STMT_YEAR, REINSURER ORDER BY SEQ DESC) = 1 ORDER BY 1, 3 LIMIT 20000", summed.statement);
  const bound = buildSql(DB, SCH, { ...REC, where: [{ column: "AUTH_FLAG", equals: "x' OR 1=1" }] }, Q)!;
  ok("values stay bound, never written in", !bound.statement.includes("OR 1=1") && bound.bindings.at(-1)!.value === "x' OR 1=1");
  ok("a tag on a mapping that buildSql is given without an item is ignored (the figure isn't by counterparty)", !buildSql(DB, SCH, { ...REC, item: undefined }, Q)!.statement.includes("TAG"));
}

// ---------- the tag column: the rows ----------
{
  const clock = fakeClock();
  const tables = { IR_RECOV: [
    { NAIC_CD: "12345", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, REINSURER: "Nonesuch Re", AUTH_FLAG: "Authorized", RECOV_000: 120 },
    { NAIC_CD: "12345", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, REINSURER: "Tarrow Re", AUTH_FLAG: null, RECOV_000: 30 },
  ], IR_CEDED: [{ NAIC_CD: "12345", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2024, REINSURER: "Nonesuch Re", CEDED_000: 50 }] };
  const sf = fakeSnowflake(clock, { tables });
  const api = new Snowflake(snowflakeCreds(env(PAT)), { fetch: sf.fetch, now: clock.fn, sleep: clock.sleep });
  const mapping: Mapping = { fields: { recoverable_by_reinsurer: REC, ceded_by_reinsurer: { view: "IR_CEDED", entity: { company: "NAIC_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "CEDED_000", item: "REINSURER", scale: 1000 }, surplus: { view: "IR_CEDED", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "CEDED_000" } } };
  const r = await runStatutory(api, DB, SCH, mapping, Q, ["recoverable_by_reinsurer", "ceded_by_reinsurer", "surplus", "uw_gain"]);
  const f = (id: string) => r.fields.find((x) => x.id === id)!;
  ok("each row keeps its tag, null when the column is empty", same(f("recoverable_by_reinsurer").rows, [{ code: "12345", year: 2024, line: null, state: null, value: 120_000, item: "Nonesuch Re", tag: "Authorized" }, { code: "12345", year: 2024, line: null, state: null, value: 30_000, item: "Tarrow Re", tag: null }]), f("recoverable_by_reinsurer").rows);
  ok("rows of a figure with no tag mapped have no tag key at all, as before", same(Object.keys(f("ceded_by_reinsurer").rows[0]), ["code", "year", "line", "state", "value", "item"]) && same(Object.keys(f("surplus").rows[0]), ["code", "year", "line", "state", "value"]));
  ok("a new figure that isn't mapped comes back not mapped, with no error and no statement", f("uw_gain").mapped === false && f("uw_gain").error === null && f("uw_gain").rows.length === 0 && sf.statements.filter((s) => !s.statement.includes("LOADTRACKER")).length === 3, sf.statements.map((s) => s.statement.slice(0, 60)));

  // joined views with sum: rows for each reinsurer and tag added up
  const T: SchemaTables = {
    "ENTITY.ENTITY_LIST": [{ ENTITY_ID: 1, NAIC_CD: "12345", ENTITY_NAME: "Calloway Insurance Co" }],
    "REINS.RECOV": [{ ENTITY_ID: 1, YR: 2024, REINSURER: "Nonesuch Re", AUTH: "A", AMT: 10 }, { ENTITY_ID: 1, YR: 2024, REINSURER: "Nonesuch Re", AUTH: "A", AMT: 5 }, { ENTITY_ID: 1, YR: 2024, REINSURER: "Tarrow Re", AUTH: "U", AMT: 7 }],
  };
  const c2 = fakeClock(), sf2 = fakeSnowflake(c2, { on: joinReader({ tables: T }) });
  const api2 = new Snowflake(snowflakeCreds(env(PAT)), { fetch: sf2.fetch, now: c2.fn, sleep: c2.sleep });
  const J: FieldMap = { view: "REINS.RECOV", as: "R", joins: [{ view: "ENTITY.ENTITY_LIST", as: "E", on: [{ left: "R.ENTITY_ID", right: "E.ENTITY_ID" }] }], entity: { company: "E.NAIC_CD", name: "E.ENTITY_NAME" }, year: "R.YR", value: "R.AMT", item: "R.REINSURER", tag: "R.AUTH", sum: true };
  const j = await runStatutory(api2, DB, SCH, { fields: { recoverable_by_reinsurer: J } }, Q, ["recoverable_by_reinsurer"]);
  const rows = [...j.fields[0].rows].sort((a, b) => String(a.item).localeCompare(String(b.item)));
  ok("through joined views with sum, each reinsurer and tag is one row, added up", same(rows.map((x) => [x.item, x.tag, x.value]), [["Nonesuch Re", "A", 15], ["Tarrow Re", "U", 7]]), rows);
}

done();
