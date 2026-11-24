// The Screener (the statutory function's screen and screen-lines actions): every bad request refused in plain words,
// the one statement it makes for each choice of premium (none, states, lines, both) with filters, focus, growth,
// group, sort and limit, bindings never written into the SQL, distinct before sum, scale, company-only parts of a
// mapping, mappings that can't be reduced to one figure a company refused, an unmapped figure refused by name, the
// Corp Dev check, the wait and the timeout, nothing saved or logged, the count and the cut flag.
// The statements are run for real against made-up views in an in-memory SQLite database (node:sqlite) behind the
// fake Snowflake, so a sum, a join or a filter only comes out right when the SQL does. Every view, column, company and
// figure here is made up.
(globalThis as any).__SNL_TEST__ = true;
import { DatabaseSync } from "node:sqlite";
const statutory = await import(new URL("../../supabase/functions/snl-statutory/index.ts", import.meta.url).href);
import { buildScreenSql, type Mapping, type ScreenRequest } from "../../supabase/functions/_shared/statutory.ts";
import { parseScreen, SCREEN_ODD_FLOOR, SCREEN_ODD_SHARE, SCREEN_FIRST_WAIT_MS, SCREEN_TIMEOUT, SCREEN_TIMEOUT_S } from "../../supabase/functions/_shared/screen.ts";
import { checks, corpdev, env, fakeClock, memoryDb, reader, req } from "./helpers/fakes.ts";
import { fakeSnowflake, type SfReply } from "./helpers/snowflake.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PAT = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
type Row = Record<string, string | number | null>;

// ---------- made-up views (dollars in thousands) ----------
const stl = (code: string, y: number, st: string, lob: string, v: number) => ({ NAIC_CD: code, STMT_YEAR: y, ST: st, LOB: lob, DPW_000: v });
const TABLES: Record<string, Row[]> = {
  IR_PREM_LINE: [
    { NAIC_CD: "91001", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 150000 },
    { NAIC_CD: "91001", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2025, LOB: "Commercial auto", DPW_000: 50000 },
    { NAIC_CD: "91001", CO_NAME: "Calloway Insurance Co", STMT_YEAR: 2022, LOB: "Homeowners", DPW_000: 100000 },
    { NAIC_CD: "91002", CO_NAME: "Calloway Home Co", STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 60000 },
    { NAIC_CD: "91002", CO_NAME: "Calloway Home Co", STMT_YEAR: 2022, LOB: "Homeowners", DPW_000: 70000 },
    { NAIC_CD: "92001", CO_NAME: "Tarrow Mutual Insurance Co", STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 400000 },
    { NAIC_CD: "92001", CO_NAME: "Tarrow Mutual Insurance Co", STMT_YEAR: 2025, LOB: "Workers comp", DPW_000: 600000 },
    { NAIC_CD: "93001", CO_NAME: "Nonesuch Casualty Co", STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 80000 },
    { NAIC_CD: "93001", CO_NAME: "Nonesuch Casualty Co", STMT_YEAR: 2022, LOB: "Homeowners", DPW_000: 40000 },
    { NAIC_CD: "94001", CO_NAME: "Nonesuch Specialty Co", STMT_YEAR: 2025, LOB: "Commercial auto", DPW_000: 5000 },
  ],
  IR_PREM_STATE: [
    { NAIC_CD: "91001", STMT_YEAR: 2025, ST: "Reported:FL", DPW_000: 160000 }, { NAIC_CD: "91001", STMT_YEAR: 2025, ST: "Reported:GA", DPW_000: 40000 },
    { NAIC_CD: "91002", STMT_YEAR: 2025, ST: "Reported:FL", DPW_000: 60000 },
    { NAIC_CD: "92001", STMT_YEAR: 2025, ST: "Reported:FL", DPW_000: 300000 }, { NAIC_CD: "92001", STMT_YEAR: 2025, ST: "Reported:TX", DPW_000: 700000 },
    { NAIC_CD: "93001", STMT_YEAR: 2025, ST: "Reported:FL", DPW_000: 80000 },
    { NAIC_CD: "94001", STMT_YEAR: 2025, ST: "Reported:GA", DPW_000: 5000 },
  ],
  IR_PREM_STLINE: [
    stl("91001", 2025, "FL", "Homeowners", 120000), stl("91001", 2025, "FL", "Commercial auto", 40000), stl("91001", 2025, "GA", "Homeowners", 30000), stl("91001", 2025, "GA", "Commercial auto", 10000),
    stl("91001", 2022, "FL", "Homeowners", 80000),
    stl("91002", 2025, "FL", "Homeowners", 60000), stl("91002", 2022, "FL", "Homeowners", 70000),
    stl("92001", 2025, "FL", "Homeowners", 250000), stl("92001", 2025, "FL", "Workers comp", 50000), stl("92001", 2025, "TX", "Homeowners", 150000), stl("92001", 2025, "TX", "Workers comp", 550000),
    stl("93001", 2025, "FL", "Homeowners", 80000), stl("93001", 2022, "FL", "Homeowners", 40000),
    stl("94001", 2025, "GA", "Commercial auto", 5000),
  ],
  // a membership view that lists 91001 twice: joining it repeats 91001's rows, which distinct takes out again
  IR_MEMBERS: [{ NAIC_CD: "91001", PERIOD: "A" }, { NAIC_CD: "91001", PERIOD: "B" }, { NAIC_CD: "91002", PERIOD: "A" }, { NAIC_CD: "92001", PERIOD: "A" }, { NAIC_CD: "93001", PERIOD: "A" }, { NAIC_CD: "94001", PERIOD: "A" }],
  IR_TOTALS: [
    { NAIC_CD: "91001", STMT_YEAR: 2025, STMT_DATE: "2025-12-31", GPW_000: 210000, PHS_000: 140000 },
    { NAIC_CD: "91002", STMT_YEAR: 2025, STMT_DATE: "2025-12-31", GPW_000: 65000, PHS_000: 30000 },
    { NAIC_CD: "92001", STMT_YEAR: 2025, STMT_DATE: "2025-12-31", GPW_000: 1100000, PHS_000: 900000 },
    { NAIC_CD: "93001", STMT_YEAR: 2025, STMT_DATE: "2025-12-31", GPW_000: 90000, PHS_000: 50000 },
    { NAIC_CD: "91001", STMT_YEAR: 2024, STMT_DATE: "2024-12-31", GPW_000: 1, PHS_000: 1 },
  ],
  // ratios as fractions, company rows and group rows in one view; 93001 has no combined ratio at all (null)
  IR_RATIOS: [
    { NAIC_CD: "91001", GRP_CD: null, KIND: "C", STMT_YEAR: 2025, CR: 0.95 },
    { NAIC_CD: "91002", GRP_CD: null, KIND: "C", STMT_YEAR: 2025, CR: 1.05 },
    { NAIC_CD: "92001", GRP_CD: null, KIND: "C", STMT_YEAR: 2025, CR: 0.98 },
    { NAIC_CD: "93001", GRP_CD: null, KIND: "C", STMT_YEAR: 2025, CR: null },
    { NAIC_CD: "94001", GRP_CD: null, KIND: "C", STMT_YEAR: 2025, CR: 0.8 },
    { NAIC_CD: null, GRP_CD: "9100", KIND: "G", STMT_YEAR: 2025, CR: 0.99 },
  ],
  // two different gross premiums for 91001 in 2025: a mapping read this way can't give one figure
  IR_TOTALS_TWICE: [{ NAIC_CD: "91001", STMT_YEAR: 2025, GPW_000: 210000 }, { NAIC_CD: "91001", STMT_YEAR: 2025, GPW_000: 999 }, { NAIC_CD: "92001", STMT_YEAR: 2025, GPW_000: 5000 }],
  IR_COMPANIES: [
    { INST_ID: 5001, NAIC_CD: "91001", CO_NAME: "Calloway Insurance Co", GRP_CD: "9100", GRP_NAME: "Calloway Group" },
    { INST_ID: 5002, NAIC_CD: "91002", CO_NAME: "Calloway Home Co", GRP_CD: "9100", GRP_NAME: "Calloway Group" },
    { INST_ID: 5003, NAIC_CD: "92001", CO_NAME: "Tarrow Mutual Insurance Co", GRP_CD: null, GRP_NAME: null },
    { INST_ID: 5004, NAIC_CD: "93001", CO_NAME: "Nonesuch Casualty Co", GRP_CD: null, GRP_NAME: null },
  ],
};
const MAPPING: Mapping = { fields: {
  dpw_by_line: { view: "IR_PREM_LINE", entity: { company: "NAIC_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "DPW_000", line: "LOB", scale: 1000 },
  dpw_by_state: { view: "IR_PREM_STATE", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "DPW_000", state: "ST", stateStrip: "Reported:", where: [{ column: "ST", startsWith: "Reported:" }], scale: 1000 },
  dpw_by_state_line: { view: "IR_PREM_STLINE", as: "P", joins: [{ view: "IR_MEMBERS", as: "M", on: [{ left: "P.NAIC_CD", right: "M.NAIC_CD" }] }], distinct: true,
    entity: { company: "P.NAIC_CD" }, year: "P.STMT_YEAR", value: "P.DPW_000", state: "P.ST", line: "P.LOB", scale: 1000 },
  gpw: { view: "IR_TOTALS", entity: { company: "NAIC_CD" }, year: "STMT_DATE", yearIsDate: true, value: "GPW_000", scale: 1000 },
  surplus: { view: "IR_TOTALS", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "PHS_000", scale: 1000 },
  combined_ratio: { view: "IR_RATIOS", entity: { company: "NAIC_CD", group: "GRP_CD" }, year: "STMT_YEAR", value: "CR", scale: 100,
    where: [{ column: "KIND", equals: "C", when: "company" }, { column: "KIND", equals: "G", when: "group" }] },
}, companies: { view: "IR_COMPANIES", institution: "INST_ID", company: "NAIC_CD", name: "CO_NAME", groupCode: "GRP_CD", groupName: "GRP_NAME" } };

// ---------- the SQL run for real: SQLite stands in for Snowflake's engine ----------
function sqlite(tables: Record<string, Row[]>) {
  const d = new DatabaseSync(":memory:");
  d.exec("ATTACH ':memory:' AS XPRESSFEED");
  for (const [name, rows] of Object.entries(tables)) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    d.exec(`CREATE TABLE XPRESSFEED.${name} (${cols.map((c) => `${c} ${rows.some((r) => typeof r[c] === "number") ? "REAL" : "TEXT"}`).join(", ")})`);
    const ins = d.prepare(`INSERT INTO XPRESSFEED.${name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of rows) ins.run(...cols.map((c) => r[c] ?? null));
  }
  d.function("YEAR", (v: unknown) => (v === null ? null : Number(String(v).slice(0, 4))));
  d.function("MONTH", (v: unknown) => (v === null ? null : Number(String(v).slice(5, 7))));
  d.function("STARTSWITH", (a: unknown, b: unknown) => (a === null || b === null ? null : String(a).startsWith(String(b)) ? 1 : 0));
  return (statement: string, bindings: { type: string; value: string }[]): SfReply => {
    const holes = (statement.match(/\?/g) ?? []).length;
    if (holes !== bindings.length) return { error: { status: 422, message: `Bind variable ? not set (${holes} in the statement, ${bindings.length} bound).` } };
    if (statement.includes(";")) return { error: { status: 422, message: "Actual statement count 2 did not match the desired statement count 1." } };
    try {
      const st = d.prepare(statement.replace(/MI_XPRESSCLOUD\./g, ""));
      const rows = st.all(...bindings.map((b) => (b.type === "TEXT" ? b.value : Number(b.value)))) as Row[];
      const columns = (st as any).columns ? (st as any).columns().map((c: any) => c.name) : Object.keys(rows[0] ?? {});
      return { columns, rows: rows.map((r) => columns.map((c: string) => r[c] ?? null)) };
    } catch (e) { return { error: { status: 422, message: `SQL compilation error: ${(e as Error).message}` } }; }
  };
}

function world(o: { mapping?: Mapping | null; secrets?: Record<string, string>; tables?: Record<string, Row[]> } = {}) {
  const clock = fakeClock("2026-11-13T12:00:00Z"), db = memoryDb(clock), run = sqlite(o.tables ?? TABLES);
  const sf = fakeSnowflake(clock, { on: (s, b) => run(s, b) });
  if (o.mapping !== null) db.settings.set("statutory_mapping", structuredClone(o.mapping ?? MAPPING) as unknown as Record<string, unknown>);
  const logs: string[] = [];
  const deps = { env: env(o.secrets ?? PAT), fetch: sf.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown, over: Record<string, unknown> = {}) => {
    const keep = console.log, keepErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" ")); console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try { const res: Response = await statutory.handle(req("snl-statutory", body), { ...deps, ...over }); return { status: res.status, body: await res.json() }; }
    finally { console.log = keep; console.error = keepErr; }
  };
  return { clock, db, sf, call, logs };
}
const screen = (o: Record<string, unknown> = {}) => ({ action: "screen", year: 2025, ...o });
const codes = (b: any) => (b.rows ?? []).map((r: any) => r.code);

// ---------- request checking: every bad input refused in plain words ----------
{
  const w = world();
  const BAD: [string, Record<string, unknown>, RegExp][] = [
    ["an unknown key", { colour: "red" }, /doesn't take "colour"/],
    ["a year before 1990", { year: 1980 }, /whole year from 1990 to 2026/],
    ["a year in the future", { year: 2027 }, /whole year from 1990 to 2026/],
    ["a year as text", { year: "2025" }, /whole year/],
    ["eleven states", { states: "AL AK AZ AR CA CO CT DE FL GA HI".split(" ") }, /at most 10 states/],
    ["a state that isn't two letters", { states: ["Florida"] }, /two-letter codes/],
    ["states as text", { states: "FL" }, /at most 10 states/],
    ["eleven lines", { lines: Array.from({ length: 11 }, (_, i) => `Line ${i}`) }, /at most 10 lines/],
    ["an empty line", { lines: [" "] }, /line names as S&P gives them/],
    ["a line with a line break", { lines: ["Home\nowners"] }, /line names/],
    ["nine filters", { filters: Array.from({ length: 9 }, () => ({ field: "premium", min: 1 })) }, /at most 8 filters/],
    ["a filter on an unknown figure", { filters: [{ field: "deal_value", min: 1 }] }, /must be one of: premium, focus, gpw/],
    ["a filter with no bound", { filters: [{ field: "surplus" }] }, /Policyholder surplus: give a min, a max or both/],
    ["a filter with text bounds", { filters: [{ field: "surplus", min: "50" }] }, /min and max must be numbers/],
    ["a filter whose min is above its max", { filters: [{ field: "premium", min: 300, max: 50 }] }, /Premium in view: the min is above the max/],
    ["the same figure filtered twice", { filters: [{ field: "premium", min: 1 }, { field: "premium", max: 9 }] }, /filtered twice/],
    ["a filter with an extra key", { filters: [{ field: "premium", min: 1, op: ">" }] }, /Each filter is \{field, min, max\}/],
    ["growth over 2 years", { growth: { years: 2, min: 1 } }, /1, 3 or 5 years/],
    ["growth with no bound", { growth: { years: 3 } }, /give a min, a max or both/],
    ["growth reaching back before 1990", { year: 1991, growth: { years: 3, min: 1 } }, /before 1990/],
    ["an unknown group choice", { group: "yes" }, /group must be "any", "in"/],
    ["sorting by an unknown column", { sort: { by: "price" } }, /sort.by must be one of/],
    ["sorting by growth with no growth filter", { sort: { by: "growth" } }, /only sort by growth when it has a growth filter/],
    ["sorting in an unknown direction", { sort: { by: "premium", dir: "up" } }, /"asc" or "desc"/],
    ["a limit of 501", { limit: 501 }, /from 1 to 500/],
    ["a limit of 0", { limit: 0 }, /from 1 to 500/],
  ];
  for (const [name, o, re] of BAD) {
    const r = await w.call(screen(o));
    ok(`refused: ${name}`, r.status === 400 && r.body.error === "bad" && re.test(r.body.message) && !/\u2014/.test(r.body.message), r.body);
  }
  ok("nothing bad reached Snowflake", w.sf.statements.length === 0);
  const p = parseScreen({ action: "screen" }, 2026);
  ok("an empty screen is the last full year, all premium, no filters, any group, premium in view largest first, 100 rows",
    p.ok && same(p.r, { year: 2025, states: [], lines: [], filters: [], growth: null, group: "any", sort: { by: "premium", dir: "desc" }, limit: 100 }), p);
  const q = parseScreen({ states: ["fl", "FL", " ga "], lines: [" Homeowners ", "Homeowners"] }, 2026);
  ok("states are upper-cased and each kept once; lines trimmed and each kept once", q.ok && same(q.r.states, ["FL", "GA"]) && same(q.r.lines, ["Homeowners"]), q);
}

// ---------- who can use it ----------
{
  const w = world();
  const r = await w.call(screen(), { whoIs: reader });
  ok("an ordinary login gets the same plain refusal other Corp Dev actions give", r.status === 403 && r.body.error === "forbidden" && r.body.message === "Only Corp Dev logins can run the Screener." && same(Object.keys(r.body).sort(), ["error", "message"]), r.body);
  const l = await w.call({ action: "screen-lines", year: 2025 }, { whoIs: reader });
  ok("the line names are Corp Dev only too", l.status === 403 && l.body.error === "forbidden");
  ok("and nothing was sent to Snowflake for them", w.sf.statements.length === 0);
  const n = world({ secrets: {} });
  const r2 = await n.call(screen());
  ok("before Snowflake is set up a screen says so (503 not_configured)", r2.status === 503 && r2.body.error === "not_configured", r2.body);
}

// ---------- no state or line: all direct premiums written, from premiums by line ----------
{
  const w = world();
  const r = await w.call(screen({ filters: [{ field: "premium", min: 50, max: 300 }] }));
  ok("a screen answers 200", r.status === 200, r.body);
  ok("premium in view is the total of premiums by line, summed per company, in dollars", same(r.body.rows.map((x: any) => [x.code, x.premium]), [["91001", 200e6], ["93001", 80e6], ["91002", 60e6]]), r.body.rows);
  ok("companies outside the premium range are left out (92001 at $1,000M, 94001 at $5M)", !codes(r.body).includes("92001") && !codes(r.body).includes("94001"));
  ok("with no state or line chosen, focus is 100%", r.body.rows.every((x: any) => x.focus === 100), r.body.rows);
  ok("names come with the rows", r.body.rows[0].name === "Calloway Insurance Co");
  ok("surplus, combined ratio and gross premiums written are always shown when mapped", r.body.rows[0].surplus === 140e6 && r.body.rows[0].combined_ratio === 95 && r.body.rows[0].gpw === 210e6, r.body.rows[0]);
  ok("a company with no combined ratio at all (null) shows null, not zero, and is still listed when not filtered on", r.body.rows.find((x: any) => x.code === "93001").combined_ratio === null);
  ok("the answer names the premium figure and says where focus comes from", r.body.premium.figure === "dpw_by_line" && r.body.notes.some((n: string) => n === "Premium in view is all direct premiums written: the total of premiums by line.") && r.body.notes.includes("Focus is 100% for every company: with no state or line chosen, premium in view is all the company's direct premiums written."), r.body.notes);
  ok("with nothing narrowed, premium in view is the total: premiums by line are read once, and no separate total", (w.sf.statements[0].statement.match(/IR_PREM_LINE/g) ?? []).length === 1 && !/T_ROWS/.test(w.sf.statements[0].statement));
  ok("the count and the cut flag", r.body.total === 3 && r.body.cut === false && r.body.limit === 100);
  ok("the columns say what each figure is and its unit", same(r.body.columns.map((c: any) => [c.id, c.unit]), [["premium", "usd"], ["focus", "pct"], ["surplus", "usd"], ["combined_ratio", "pct"], ["gpw", "usd"]]), r.body.columns);
  ok("group codes and names come with the rows when the look-up is mapped", r.body.groupMapped === true && r.body.rows[0].groupCode === "9100" && r.body.rows[0].groupName === "Calloway Group" && r.body.rows.find((x: any) => x.code === "93001").groupCode === null);
  const s = w.sf.statements[0];
  ok("one statement, nothing after it", w.sf.statements.length === 1 && !s.statement.includes(";") && /^WITH /.test(s.statement));
  ok("the premium bounds are bound in the figure's own units ($50M and $300M over a scale of 1000)", s.bindings.some((b: any) => b.type === "REAL" && b.value === "50000") && s.bindings.some((b: any) => b.type === "REAL" && b.value === "300000"), s.bindings);
  ok("it is submitted on Snowflake's asynchronous route, with Snowflake's own timeout at five minutes", s.body.timeout === 300 && SCREEN_TIMEOUT_S === 300 && w.sf.log.some((c) => c.method === "POST" && c.path === "/api/v2/statements" && c.query.async === "true") && SCREEN_FIRST_WAIT_MS === 20_000);
}

// ---------- states only: premiums by state over those states ----------
{
  const w = world();
  const r = await w.call(screen({ states: ["FL"], filters: [{ field: "premium", min: 50 }] }));
  ok("states only: premiums by state summed over the chosen states, with the state prefix taken off", same(r.body.rows.map((x: any) => [x.code, x.premium]), [["92001", 300e6], ["91001", 160e6], ["93001", 80e6], ["91002", 60e6]]), r.body.rows);
  ok("focus is the chosen states over all the company's states", r.body.rows.find((x: any) => x.code === "92001").focus === 30 && r.body.rows.find((x: any) => x.code === "91001").focus === 80, r.body.rows);
  ok("the state is bound with its prefix, never written into the SQL", w.sf.statements[0].bindings.some((b: any) => b.value === "Reported:FL") && !w.sf.statements[0].statement.includes("FL"));
  const two = await w.call(screen({ states: ["FL", "GA"] }));
  ok("two states add up", two.body.rows.find((x: any) => x.code === "91001").premium === 200e6 && two.body.rows.find((x: any) => x.code === "94001").premium === 5e6);
  ok("the answer's premium is by state", r.body.premium.figure === "dpw_by_state" && same(r.body.premium.states, ["FL"]));
}

// ---------- lines only, and both ----------
{
  const w = world();
  const r = await w.call(screen({ lines: ["Homeowners"] }));
  ok("lines only: premiums by line summed over the chosen lines only", same(r.body.rows.map((x: any) => [x.code, x.premium]), [["92001", 400e6], ["91001", 150e6], ["93001", 80e6], ["91002", 60e6]]), r.body.rows);
  ok("a company that doesn't write the line isn't listed", !codes(r.body).includes("94001"));
  ok("focus for lines: Homeowners over all lines", r.body.rows.find((x: any) => x.code === "92001").focus === 40 && r.body.rows.find((x: any) => x.code === "91001").focus === 75);
  const b = await w.call(screen({ states: ["FL"], lines: ["Homeowners"], filters: [{ field: "premium", min: 50, max: 300 }, { field: "combined_ratio", max: 100 }] }));
  ok("both: premiums by state and line over the chosen states and lines", b.body.premium.figure === "dpw_by_state_line");
  ok("the owner's example: Florida homeowners $50M to $300M, combined ratio at most 100", same(b.body.rows.map((x: any) => [x.code, x.premium, x.combined_ratio]), [["92001", 250e6, 98], ["91001", 120e6, 95]]), b.body.rows);
  ok("a company with no combined ratio (null) is left out by a filter on it; one above 100 too", !codes(b.body).includes("93001") && !codes(b.body).includes("91002"));
  ok("focus with a state and a line takes its total from premiums by line, and the note says so", b.body.notes.includes("Focus is premium in view as a share of the company's total direct premiums written in 2025, from premiums by line over every line."), b.body.notes);
  const sel = w.sf.statements[1].statement, pRead = sel.slice(sel.indexOf("P_ROWS AS ("), sel.indexOf("P_K AS ("));
  ok("the premium read itself has the state, the line and the year in its WHERE, all bound", /WHERE "P".NAIC_CD IS NOT NULL AND "P".STMT_YEAR IN \(\?\) AND "P".ST IN \(\?\) AND "P".LOB IN \(\?\)/.test(pRead) && !/BETWEEN/.test(pRead), pRead);
  ok("the total for focus is its own small read of premiums by line for the year", /T_ROWS AS \(SELECT NAIC_CD AS CODE, NULL AS NAME, STMT_YEAR AS YR, LOB AS LINE, NULL AS STATE, DPW_000 AS VAL FROM MI_XPRESSCLOUD.XPRESSFEED.IR_PREM_LINE WHERE NAIC_CD IS NOT NULL AND STMT_YEAR IN \(\?\) AND NAIC_CD IN \(SELECT CODE FROM P_IN\)\)/.test(sel), sel.slice(sel.indexOf("T_ROWS"), sel.indexOf("T_KEYS")));
  ok("no window function anywhere: the name comes from the premium read alone", !/ OVER \(/.test(sel) && /P_ROWS AS \(SELECT DISTINCT "P".NAIC_CD AS CODE, NULL AS NAME/.test(sel) && /F0_ROWS AS \(SELECT NAIC_CD AS CODE, NULL AS NAME/.test(sel));
  ok("P_IN holds the bounds that depend on premium alone, and every other read is limited to its companies", /P_IN AS \(SELECT CODE, NAME, V FROM P WHERE V IS NOT NULL AND N <= 1 AND V >= \? AND V <= \?\)/.test(sel)
    && ["T_ROWS", "F0_ROWS", "F1_ROWS", "F2_ROWS", "G_ROWS"].every((c) => { const at = sel.indexOf(`${c} AS (`); return at > sel.indexOf("P_IN AS (") && sel.slice(at).split(/\), [A-Z0-9_]+ AS \(/)[0].includes(" IN (SELECT CODE FROM P_IN)"); })
    && /ALL_ROWS AS \(SELECT .* FROM P_IN AS P /.test(sel) && !/HITS AS \(SELECT \* FROM ALL_ROWS WHERE PREMIUM/.test(sel), sel);
  ok("the distinct mapping is de-duplicated before it is summed: 91001's rows, repeated by the join, count once", b.body.rows.find((x: any) => x.code === "91001").premium === 120e6);
  ok("focus for both: Florida homeowners over everything by state and line", b.body.rows.find((x: any) => x.code === "91001").focus === 60 && b.body.rows.find((x: any) => x.code === "92001").focus === 25, b.body.rows);
  const s = w.sf.statements[1];
  ok("the line and the bounds are bindings, never text in the statement", !s.statement.includes("Homeowners") && !s.statement.includes("50") && s.bindings.some((x: any) => x.value === "Homeowners") && s.bindings.some((x: any) => x.value === "300000" && x.type === "REAL"), s.statement);
  ok("the ratio bound is divided by the ratio's scale (100% is 1 as stored)", s.bindings.some((x: any) => x.type === "REAL" && x.value === "1"), s.bindings);
  ok("DISTINCT sits inside the premium rows, then on (code, year, line, state, value) without the name, before the SUM", /P_ROWS AS \(SELECT DISTINCT /.test(s.statement) && /P_K AS \(SELECT CODE, YR, LINE, STATE, MAX\(NAME\) AS NAME, MAX\(VAL\) AS VAL, COUNT\(DISTINCT VAL\) AS N FROM P_ROWS GROUP BY CODE, YR, LINE, STATE\)/.test(s.statement) && s.statement.indexOf("P_K AS") < s.statement.indexOf("SUM(CASE"));
  ok("the group-only where of the combined ratio is left out; the company one is used", s.bindings.filter((x: any) => x.value === "C").length === 1 && !s.bindings.some((x: any) => x.value === "G"));
  const f = await w.call(screen({ states: ["FL"], lines: ["Homeowners"], filters: [{ field: "focus", min: 50 }] }));
  ok("a focus filter keeps companies whose chosen premium is at least that share of all they write", same(codes(f.body), ["91001", "93001", "91002"]), f.body.rows);
  const hostile = await w.call(screen({ lines: ["Home'); DROP TABLE x --"] }));
  ok("a hostile line name is only ever a binding, and matches nothing", hostile.status === 200 && hostile.body.total === 0 && !w.sf.statements[3].statement.includes("DROP"), hostile.body);
}

// ---------- filters, scale, growth, group, sort, limit ----------
{
  const w = world();
  const s1 = await w.call(screen({ filters: [{ field: "surplus", max: 150 }] }));
  ok("surplus at most $150M: compared in thousands as stored (150,000)", same(codes(s1.body), ["91001", "93001", "91002"]) && w.sf.statements[0].bindings.some((b: any) => b.value === "150000"), s1.body.rows);
  ok("a company with no surplus row is left out by a filter on surplus", !codes(s1.body).includes("94001"));
  const g = await w.call(screen({ states: ["FL"], lines: ["Homeowners"], growth: { years: 3, min: 0 } }));
  ok("growth over 3 years: change in premium in view from 2022 to 2025, in percent", same(g.body.rows.map((x: any) => [x.code, x.growth]), [["91001", 50], ["93001", 100]]), g.body.rows);
  ok("a company with nothing in 2022 has no growth figure and doesn't pass the growth filter", !codes(g.body).includes("92001"));
  ok("a fall is negative growth", (await w.call(screen({ states: ["FL"], lines: ["Homeowners"], growth: { years: 3, max: 0 } }))).body.rows.map((x: any) => [x.code, Math.round(x.growth * 10) / 10]).join() === "91002,-14.3");
  ok("growth has its column and its note", g.body.columns.some((c: any) => c.id === "growth" && c.unit === "pct") && g.body.notes.some((n: string) => n === "Growth compares premium in view in 2025 with 2022. A company with nothing in 2022 has no growth figure and doesn't pass the growth filter."));
  const gi = await w.call(screen({ group: "in" }));
  ok("in a NAIC group: only companies the look-up puts in a group", same(codes(gi.body).sort(), ["91001", "91002"]), gi.body.rows);
  const gn = await w.call(screen({ group: "none" }));
  ok("not in a group: companies the look-up lists with no group; one it doesn't list is left out", same(codes(gn.body).sort(), ["92001", "93001"]) && gn.body.notes.includes("A company the company look-up doesn't list is left out by the group choice."), gn.body.rows);
  const byName = await w.call(screen({ sort: { by: "name", dir: "asc" } }));
  ok("sort by name, A to Z", same(byName.body.rows.map((x: any) => x.name), ["Calloway Home Co", "Calloway Insurance Co", "Nonesuch Casualty Co", "Nonesuch Specialty Co", "Tarrow Mutual Insurance Co"]), byName.body.rows.map((x: any) => x.name));
  const byCr = await w.call(screen({ sort: { by: "combined_ratio", dir: "asc" } }));
  ok("sort by combined ratio, lowest first, a missing one last", same(codes(byCr.body), ["94001", "91001", "92001", "91002", "93001"]), codes(byCr.body));
  const lim = await w.call(screen({ limit: 2 }));
  ok("the limit cuts the list: the largest 2 of 5 by premium in view, and says so", same(codes(lim.body), ["92001", "91001"]) && lim.body.total === 5 && lim.body.cut === true, lim.body);
  const st = w.sf.statements[w.sf.statements.length - 1];
  ok("the statement asks for at most the limit and the total count", /LIMIT \?\) AS R ON 1 = 1/.test(st.statement) && st.bindings[st.bindings.length - 1].value === "2" && /COUNT\(\*\) FROM HITS\) AS TOTAL/.test(st.statement));
  const none = await w.call(screen({ states: ["AK"] }));
  ok("nothing matched: an empty list with a total of 0, not an error", none.status === 200 && none.body.total === 0 && none.body.rows.length === 0 && none.body.cut === false, none.body);
  const unsorted = await w.call(screen({ sort: { by: "rbc_ratio" } }));
  ok("sorting by a figure the screen doesn't show is refused in plain words", unsorted.status === 409 && /can't be sorted by risk-based capital ratio/.test(unsorted.body.message), unsorted.body);
}

// ---------- figures that can't be used ----------
{
  const w = world();
  const r = await w.call(screen({ filters: [{ field: "rbc_ratio", min: 300 }] }));
  ok("a filter on an unmapped figure is refused, naming the figure, never dropped", r.status === 409 && r.body.error === "not_mapped" && r.body.figure === "rbc_ratio" && r.body.message.startsWith("Risk-based capital ratio isn't mapped to S&P's data yet, so a screen can't use it."), r.body);
  ok("and nothing was run", w.sf.statements.length === 0);
  const noSl = world({ mapping: { ...MAPPING, fields: { ...MAPPING.fields, dpw_by_state_line: undefined } } });
  const r2 = await noSl.call(screen({ states: ["FL"], lines: ["Homeowners"] }));
  ok("both a state and a line need premiums by state and line mapped, and say so", r2.status === 409 && r2.body.figure === "dpw_by_state_line" && /Direct premiums written by state and line isn't mapped/.test(r2.body.message), r2.body);
  const fan = world({ mapping: { ...MAPPING, fields: { ...MAPPING.fields, surplus: { ...MAPPING.fields.surplus!, line: "PHS_000" } } } });
  const r3 = await fan.call(screen({ filters: [{ field: "surplus", min: 1 }] }));
  ok("a one-a-year figure whose mapping names a line column fans out: refused before Snowflake", r3.status === 409 && r3.body.error === "fans_out" && /Policyholder surplus can't be screened: its mapping names a line column/.test(r3.body.message) && fan.sf.statements.length === 0, r3.body);
  const twice = world({ mapping: { ...MAPPING, fields: { ...MAPPING.fields, gpw: { view: "IR_TOTALS_TWICE", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "GPW_000", scale: 1000 } } } });
  const r4 = await twice.call(screen({ filters: [{ field: "gpw", min: 1 }] }));
  ok("a company whose yearly figure has two different values gets n/d for it, so a filter on it leaves the company out", r4.status === 200 && !codes(r4.body).includes("91001") && same(codes(r4.body), ["92001"]) && r4.body.odd.figures.gpw === 1, r4.body);
  ok("and a note says so in plain words", r4.body.notes.includes("Gross premiums written is n/d for 1 company: S&P's rows give it two figures for 2025."), r4.body.notes);
  const r4b = await twice.call(screen());
  ok("unfiltered, that company is still listed, its figure n/d, and the total counts it", r4b.body.rows.find((x: any) => x.code === "91001").gpw === null && r4b.body.total === 5);
  const nodist = world({ mapping: { ...MAPPING, fields: { ...MAPPING.fields, dpw_by_state_line: { ...MAPPING.fields.dpw_by_state_line!, distinct: undefined } } } });
  const r5 = await nodist.call(screen({ states: ["FL"], lines: ["Homeowners"] }));
  ok("without distinct, rows a join repeats exactly still count once (distinct code, year, state, line and value before the sum)", r5.status === 200 && r5.body.rows.find((x: any) => x.code === "91001").premium === 120e6 && r5.body.odd.premium === 0, r5.body);
  const groupOnly = world({ mapping: { ...MAPPING, fields: { ...MAPPING.fields, combined_ratio: { ...MAPPING.fields.combined_ratio!, entity: { group: "GRP_CD" } } } } });
  const r6 = await groupOnly.call(screen({ filters: [{ field: "combined_ratio", max: 100 }] }));
  ok("a figure mapped for groups only is refused for a screen of companies", r6.status === 409 && /mapped for group look-ups only/.test(r6.body.message), r6.body);
  const noLookup = world({ mapping: { fields: MAPPING.fields } });
  const r7 = await noLookup.call(screen({ group: "in" }));
  ok("the group choice needs the look-up with a group code column", r7.status === 409 && r7.body.error === "group" && /company look-up with a NAIC group code column isn't mapped/.test(r7.body.message), r7.body);
  const r8 = await noLookup.call(screen());
  ok("without the look-up a screen still runs, with no group columns", r8.status === 200 && r8.body.groupMapped === false && !("groupCode" in r8.body.rows[0]));
  const nothing = world({ mapping: { fields: {} } });
  const r9 = await nothing.call(screen());
  ok("with nothing mapped, the screen says premiums by line aren't mapped", r9.status === 409 && r9.body.figure === "dpw_by_line", r9.body);
  const byState = world({ mapping: { fields: { dpw_by_state: MAPPING.fields.dpw_by_state } } });
  const r10 = await byState.call(screen());
  ok("with no state or line chosen and premiums by line not mapped, the total of premiums by state is used, and the note says so", r10.status === 200 && r10.body.premium.figure === "dpw_by_state" && r10.body.rows[0].premium === 1000e6 && r10.body.notes.includes("Premium in view is all direct premiums written: the total of premiums by state (premiums by line aren't mapped)."), r10.body);
}

// ---------- rows with no code, two spellings of a name, companies whose rows disagree ----------
{
  const extra = structuredClone(TABLES);
  // no company code: never grouped into a row of their own, never added to anything
  extra.IR_PREM_LINE.push({ NAIC_CD: null, CO_NAME: "Nonesuch Pool (no code)", STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 900000 }, { NAIC_CD: null, CO_NAME: "Nonesuch Other (no code)", STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 700000 });
  extra.IR_PREM_STLINE.push(stl(null as unknown as string, 2025, "FL", "Homeowners", 500000));
  extra.IR_TOTALS.push({ NAIC_CD: null, STMT_YEAR: 2025, STMT_DATE: "2025-12-31", GPW_000: 5, PHS_000: 5 });
  extra.IR_COMPANIES.push({ INST_ID: 5999, NAIC_CD: null, CO_NAME: "No code", GRP_CD: "9100", GRP_NAME: "Calloway Group" });
  // 91002's name spelled two ways on otherwise identical rows: summed once
  extra.IR_PREM_LINE.push({ NAIC_CD: "91002", CO_NAME: "Calloway Home Company", STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 60000 });
  extra.IR_PREM_STLINE.push(stl("91002", 2025, "FL", "Homeowners", 60000));
  // 95001: two different Florida homeowners figures for 2025 (a restated row with no latest column mapped)
  extra.IR_PREM_STLINE.push(stl("95001", 2025, "FL", "Homeowners", 70000), stl("95001", 2025, "FL", "Homeowners", 75000));
  extra.IR_MEMBERS.push({ NAIC_CD: "95001", PERIOD: "A" });
  const w = world({ tables: extra });
  const all = await w.call(screen());
  ok("rows with no company code never reach a sum or the result", all.status === 200 && all.body.rows.every((x: any) => x.code) && all.body.total === 5 && all.body.rows[0].code === "92001" && all.body.rows[0].premium === 1000e6, all.body.rows);
  ok("a company whose name is spelled two ways is summed once, under one name", all.body.rows.find((x: any) => x.code === "91002").premium === 60e6 && all.body.rows.filter((x: any) => x.code === "91002").length === 1, all.body.rows);
  ok("every figure's read leaves out rows with no code, the group look-up's too", (w.sf.statements[0].statement.match(/IS NOT NULL AND/g) ?? []).length >= 4 && /G_ROWS AS \(SELECT DISTINCT .* WHERE NAIC_CD IS NOT NULL AND NAIC_CD IN \(SELECT CODE FROM P_IN\)\)/.test(w.sf.statements[0].statement));
  const fl = await w.call(screen({ states: ["FL"], lines: ["Homeowners"] }));
  ok("a company whose premium rows disagree is left out, and the others are not held up", fl.status === 200 && !codes(fl.body).includes("95001") && same(codes(fl.body), ["92001", "91001", "93001", "91002"]), fl.body.rows);
  ok("the code-less Florida row is not added to anyone, and 91002's second spelling counts once", fl.body.rows.find((x: any) => x.code === "91002").premium === 60e6 && fl.body.rows.find((x: any) => x.code === "92001").premium === 250e6);
  ok("the total counts only companies returnable, never the one left out", fl.body.total === 4 && fl.body.cut === false && fl.body.odd.premium === 1);
  ok("a note says how many were left out and why, in plain words", fl.body.notes.includes("1 company was left out: S&P's rows give it two premium figures for the same state and line in 2025."), fl.body.notes);
  ok("the limits for a widespread fault are named: 5% of companies with premium in view, at least 10", SCREEN_ODD_SHARE === 0.05 && SCREEN_ODD_FLOOR === 10);
  // widespread: 12 companies, each with two different figures, point to a mapping fault
  const many = structuredClone(TABLES);
  for (let i = 0; i < 12; i++) { const c = String(96000 + i); many.IR_PREM_LINE.push({ NAIC_CD: c, CO_NAME: `Nonesuch ${i} Co`, STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 1000 + i }, { NAIC_CD: c, CO_NAME: `Nonesuch ${i} Co`, STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 2000 + i }); }
  const wide = await world({ tables: many }).call(screen());
  ok("when it is widespread (12 of 17, above both limits) the whole screen is refused as a mapping fault", wide.status === 409 && wide.body.error === "fans_out" && wide.body.figure === "dpw_by_line" && /S&P's rows give 12 companies of the 17 with premium in view more than one premium figure for the same line in 2025\. So many points to a fault in its mapping/.test(wide.body.message), wide.body);
  const ten = structuredClone(TABLES);
  for (let i = 0; i < 10; i++) { const c = String(96000 + i); ten.IR_PREM_LINE.push({ NAIC_CD: c, CO_NAME: `Nonesuch ${i} Co`, STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 1000 + i }, { NAIC_CD: c, CO_NAME: `Nonesuch ${i} Co`, STMT_YEAR: 2025, LOB: "Homeowners", DPW_000: 2000 + i }); }
  const atFloor = await world({ tables: ten }).call(screen());
  ok("at the floor of 10 it still runs, leaving those 10 out", atFloor.status === 200 && atFloor.body.total === 5 && atFloor.body.odd.premium === 10 && atFloor.body.notes.includes("10 companies were left out: S&P's rows give them two premium figures for the same line in 2025."), atFloor.body);
}

// ---------- the statement's shape, straight from buildScreenSql ----------
{
  const R: ScreenRequest = { year: 2025, states: ["FL"], lines: [], filters: [], growth: null, group: "any", sort: { by: "premium", dir: "desc" }, limit: 100 };
  const latest: Mapping = { fields: { ...MAPPING.fields, dpw_by_state: { ...MAPPING.fields.dpw_by_state!, latest: "SEQ_NO" } } };
  const s = buildScreenSql("MI_XPRESSCLOUD", "XPRESSFEED", latest, R);
  ok("a latest column keeps only the latest row per company, year and state, inside the premium rows", !("problem" in s) && /P_ROWS AS \(SELECT .* QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY NAIC_CD, YEAR|P_ROWS AS \(SELECT .* QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY NAIC_CD, STMT_YEAR, ST ORDER BY SEQ_NO DESC\) = 1\)/.test((s as any).statement), (s as any).statement);
  ok("no company code is written into the statement: it reads every company", !("problem" in s) && !/NAIC_CD IN \(\?/.test((s as any).statement));
  const bad = buildScreenSql("MI-X", "XPRESSFEED", MAPPING, R);
  ok("a bad database name is refused", "problem" in bad && bad.code === "sql");
  const yd = await world().call(screen({ filters: [{ field: "gpw", min: 100 }] }));
  ok("a figure whose year is a date (yearIsDate) reads the right year", same(codes(yd.body), ["92001", "91001"]) && yd.body.rows[1].gpw === 210e6, yd.body.rows);
}

// ---------- submit, then read by handle: a screen can run longer than one function call ----------
{
  const w = world();
  const storeBefore = JSON.stringify([...w.db.store.entries()]), settingsBefore = JSON.stringify([...w.db.settings.entries()]);
  const Q = screen({ states: ["FL"], lines: ["Homeowners"], filters: [{ field: "premium", min: 50, max: 300 }, { field: "combined_ratio", max: 100 }] });
  const first = await w.call(Q);
  ok("a screen that finishes within the first call answers at once", first.status === 200 && same(codes(first.body), ["92001", "91001"]) && !("running" in first.body), first.body);
  w.sf.slowNext = 11;   // finishes just after the first call's 20 seconds
  const t0 = w.clock.now;
  const a1 = await w.call(Q);
  ok("still running after about 20 seconds: the call says so, with the handle, and leaves the statement running", a1.status === 200 && a1.body.running === true && /^[0-9a-f-]{36}$/.test(a1.body.handle) && a1.body.waitedMs >= 18_000 && a1.body.waitedMs <= 20_000 && w.sf.cancelled.length === 0 && !("rows" in a1.body), a1.body);
  ok("the first call waited about 20 seconds, no more", w.clock.now - t0 <= 20_000);
  const posts = () => w.sf.log.filter((c) => c.method === "POST" && c.path === "/api/v2/statements").length, before = posts();
  const a2 = await w.call({ ...Q, handle: a1.body.handle });
  ok("asked again with the handle, the finished screen answers as usual", a2.status === 200 && same(codes(a2.body), ["92001", "91001"]) && a2.body.total === 2, a2.body);
  ok("asking again never resubmits the statement", posts() === before);
  w.sf.slowNext = 12;
  const b1 = await w.call(Q), b2 = await w.call({ ...Q, handle: b1.body.handle }), b3 = await w.call({ ...Q, handle: b1.body.handle });
  ok("one that takes longer: running on the first and second calls, finished on the third", b1.body.running === true && b2.status === 200 && b2.body.running === true && b2.body.handle === b1.body.handle && b3.status === 200 && same(codes(b3.body), ["92001", "91001"]), [b1.body, b2.body]);
  const bad = await w.call({ ...Q, handle: "01b0c0de; DROP TABLE x" });
  ok("a handle that isn't the shape Snowflake gives is refused before it is used", bad.status === 400 && bad.body.error === "bad_handle" && /reference isn't one Snowflake gives/.test(bad.body.message));
  const n = w.sf.log.length, bad2 = await w.call({ ...Q, handle: 42 });
  ok("a handle that isn't text is refused too, and nothing is asked of Snowflake", bad2.status === 400 && bad2.body.error === "bad_handle" && w.sf.log.length === n);
  const lines = await w.call({ action: "screen-lines", year: 2025 });
  const linesHandle = w.sf.statements.length.toString().padStart(12, "0");
  const other = await w.call({ ...Q, handle: `01b0c0de-0000-4000-8000-${linesHandle}` });
  ok("a handle whose result has other columns (another statement's) is refused, and nothing of it is shown", lines.status === 200 && other.status === 400 && other.body.error === "handle" && other.body.message === "That screen can't be read: the result under its reference isn't this screen's. Run the screen again." && !("rows" in other.body), other.body);
  const grown = await w.call({ ...Q, growth: { years: 3, min: 0 }, handle: a1.body.handle });
  ok("so is this screen's handle read for a different screen (its columns differ)", grown.status === 400 && grown.body.error === "handle", grown.body);
  const gone = await w.call({ ...Q, handle: "01b0c0de-0000-4000-8000-0000000009ff" });
  ok("a handle Snowflake doesn't know: the screen is no longer running", gone.status === 410 && gone.body.error === "gone" && gone.body.message === "The screen is no longer running. Run it again.", gone.body);
  w.sf.slowNext = 100;
  const c1 = await w.call(Q);
  const cx = await w.call({ action: "screen-cancel", handle: c1.body.handle });
  ok("screen-cancel stops a running screen on Snowflake", cx.status === 200 && cx.body.cancelled === true && w.sf.cancelled.includes(c1.body.handle), cx.body);
  ok("screen-cancel takes only a handle", (await w.call({ action: "screen-cancel", handle: c1.body.handle, year: 2025 })).status === 400 && (await w.call({ action: "screen-cancel" })).status === 400);
  ok("screen-cancel refuses a bad handle", (await w.call({ action: "screen-cancel", handle: "x" })).body.error === "bad_handle");
  w.sf.failNext.push({ status: 408, body: { message: "Statement reached its statement or warehouse timeout of 300 second(s) and was canceled." } });
  const late = await w.call({ ...Q, handle: c1.body.handle });
  ok("a screen that reaches Snowflake's five-minute timeout says so plainly, and gives no list", late.status === 504 && late.body.error === "timeout" && late.body.message === SCREEN_TIMEOUT && !("rows" in late.body), late.body);
  const calls = w.sf.log.length;
  const roles = [await w.call({ ...Q, handle: c1.body.handle }, { whoIs: reader }), await w.call({ action: "screen-cancel", handle: c1.body.handle }, { whoIs: reader }), await w.call({ ...Q, handle: "x" }, { whoIs: reader })];
  ok("every screen call is Corp Dev only: asking again, cancelling, even with a bad handle", roles.every((x) => x.status === 403 && x.body.message === "Only Corp Dev logins can run the Screener.") && w.sf.log.length === calls, roles.map((x) => x.status));
  ok("nothing is saved across any of these calls: the store and the settings are as they were", JSON.stringify([...w.db.store.entries()]) === storeBefore && JSON.stringify([...w.db.settings.entries()]) === settingsBefore);
  ok("the log says only that a screen ran, how many filters, how long and how many rows", w.logs.length === 3 && w.logs.every((l) => /^snl-statutory: a screen ran \(2 filters, \d+ ms, 2 rows\)$/.test(l)), w.logs);
  ok("no criteria or company in any log line", !w.logs.some((l) => /FL|Homeowners|Calloway|Tarrow|300|combined/i.test(l)));
}

// ---------- the line names, and status ----------
{
  const w = world();
  const l = await w.call({ action: "screen-lines", year: 2025 });
  ok("the line names for the year, S&P's own, each once, in order", l.status === 200 && same(l.body.lines, ["Commercial auto", "Homeowners", "Workers comp"]) && l.body.cut === false, l.body);
  ok("one statement, with the year bound", w.sf.statements.length === 1 && /^SELECT DISTINCT LINE FROM \(/.test(w.sf.statements[0].statement) && w.sf.statements[0].bindings.every((b: any) => b.value === "2025"));
  const old = await w.call({ action: "screen-lines", year: 2022 });
  ok("another year has its own lines", same(old.body.lines, ["Homeowners"]));
  ok("a bad year is refused", (await w.call({ action: "screen-lines", year: 1900 })).status === 400);
  const n = world({ mapping: { fields: {} } });
  const nl = await n.call({ action: "screen-lines" });
  ok("with premiums by line not mapped the line names say so", nl.status === 409 && nl.body.figure === "dpw_by_line", nl.body);
  const s = await w.call({ action: "status" }, { whoIs: reader });
  ok("status says which screen figures can be used and why not", s.body.screen.premium.dpw_by_line === null && s.body.screen.figures.surplus === null && /isn't mapped/.test(s.body.screen.figures.rbc_ratio) && s.body.screen.group === true, s.body.screen);
  ok("the screen part of status leaves the rest as it was", same(s.body.companies, { mapped: true, problem: null }));
}

done();
