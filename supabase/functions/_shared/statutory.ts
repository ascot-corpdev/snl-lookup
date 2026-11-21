// Statutory financials from SNL Insurance Regulatory Data on Snowflake, driven by a field mapping.
//
// Confirmed by S&P's Snowflake guide: database MI_XPRESSCLOUD, schema XPRESSFEED, tables appear as views, and
// the LOADTRACKER view (PACKAGENAME, TABLENAME, LASTTABLEUPDATETIME) says when each was last loaded.
// NOT confirmed: the name of any Insurance Regulatory view or column. So nothing here names one. The app's
// fields (below) are mapped to real views and columns in the snl_settings row "statutory_mapping", which Corp
// Dev fills in after running Discover. buildSql is the one place a mapping becomes SQL.
// A figure may be read through several joined views in several schemas of the database (FieldMap below); the
// default schema is the SNOWFLAKE_SCHEMA secret. Which schemas, views, joins and run-date views S&P has is
// UNCONFIRMED here: it lives only in the owner's saved mapping.

import type { Db } from "./db.ts";
import { shortHash } from "./http.ts";
import { type Binding, type Snowflake, SNOWFLAKE_NOT_CONFIGURED, SnowflakeError } from "./snowflake.ts";

export const STAT_FIELDS = [
  { id: "dpw_by_line", label: "Direct premiums written by line", unit: "usd", by: "line" },
  { id: "npw_by_line", label: "Net premiums written by line", unit: "usd", by: "line" },
  { id: "dpw_by_state", label: "Direct premiums written by state", unit: "usd", by: "state" },
  { id: "surplus", label: "Policyholder surplus", unit: "usd", by: "year" },
  { id: "loss_ratio", label: "Loss ratio", unit: "pct", by: "year" },
  // Losses plus loss adjustment expenses (LAE) to premiums. Loss and LAE ratio plus expense ratio is the combined ratio.
  { id: "loss_lae_ratio", label: "Loss and LAE ratio", unit: "pct", by: "year" },
  { id: "expense_ratio", label: "Expense ratio", unit: "pct", by: "year" },
  { id: "combined_ratio", label: "Combined ratio", unit: "pct", by: "year" },
  // Added for company profiles. App-level names only: the owner maps each to S&P's real view and column.
  { id: "gpw", label: "Gross premiums written", unit: "usd", by: "year" },
  { id: "npe", label: "Net premiums earned", unit: "usd", by: "year" },
  { id: "net_income", label: "Net income", unit: "usd", by: "year" },
  { id: "paid_in_capital", label: "Paid-in capital (common stock plus paid-in and contributed surplus)", unit: "usd", by: "year" },
  { id: "total_assets", label: "Total assets", unit: "usd", by: "year" },
  { id: "rbc_ratio", label: "Risk-based capital ratio", unit: "pct", by: "year" },
  { id: "net_reserves", label: "Net loss and LAE reserves", unit: "usd", by: "year" },
  { id: "pyd", label: "Prior-year reserve development (positive is adverse)", unit: "usd", by: "year" },
  { id: "reins_recoverable", label: "Reinsurance recoverables", unit: "usd", by: "year" },
  { id: "ceded_by_reinsurer", label: "Ceded premiums by reinsurer", unit: "usd", by: "item" },
  // Added for the detailed company profile. App-level names only, as above: each is "not mapped" until the owner maps it.
  { id: "assumed_pw", label: "Assumed premiums written", unit: "usd", by: "year" },
  { id: "ceded_pw", label: "Ceded premiums written", unit: "usd", by: "year" },
  { id: "losses_incurred", label: "Net losses and LAE incurred", unit: "usd", by: "year" },
  { id: "uw_gain", label: "Net underwriting gain", unit: "usd", by: "year" },
  { id: "net_inv_income", label: "Net investment income earned", unit: "usd", by: "year" },
  { id: "realized_gains", label: "Net realized capital gains", unit: "usd", by: "year" },
  { id: "dividends_paid", label: "Dividends to stockholders", unit: "usd", by: "year" },
  { id: "capital_contributed", label: "Capital and surplus paid in during the year", unit: "usd", by: "year" },
  { id: "surplus_notes", label: "Surplus notes", unit: "usd", by: "year" },
  { id: "unassigned_funds", label: "Unassigned funds", unit: "usd", by: "year" },
  { id: "cash_from_ops", label: "Net cash from operations", unit: "usd", by: "year" },
  { id: "cash_invested", label: "Cash and invested assets", unit: "usd", by: "year" },
  { id: "bonds", label: "Bonds", unit: "usd", by: "year" },
  { id: "stocks", label: "Common stocks", unit: "usd", by: "year" },
  { id: "cash_short_term", label: "Cash and short-term investments", unit: "usd", by: "year" },
  { id: "premiums_receivable", label: "Premiums receivable", unit: "usd", by: "year" },
  { id: "total_liabilities", label: "Total liabilities", unit: "usd", by: "year" },
  { id: "unearned_premiums", label: "Unearned premiums", unit: "usd", by: "year" },
  { id: "rbc_acl", label: "Authorized control level risk-based capital", unit: "usd", by: "year" },
  { id: "rbc_tac", label: "Total adjusted capital", unit: "usd", by: "year" },
  { id: "pyd_two_year", label: "Two-year reserve development (positive is adverse)", unit: "usd", by: "year" },
  { id: "commission_ratio", label: "Commission ratio", unit: "pct", by: "year" },
  { id: "investment_yield", label: "Net yield on invested assets", unit: "pct", by: "year" },
  { id: "roae", label: "Return on average equity", unit: "pct", by: "year" },
  { id: "npe_by_line", label: "Net premiums earned by line", unit: "usd", by: "line" },
  { id: "loss_lae_ratio_by_line", label: "Loss and LAE ratio by line", unit: "pct", by: "line" },
  { id: "dpe_by_state", label: "Direct premiums earned by state", unit: "usd", by: "state" },
  { id: "loss_ratio_by_state", label: "Direct loss ratio by state", unit: "pct", by: "state" },
  // By counterparty: item is the reinsurer; an optional tag column says, for example, whether it is authorized.
  { id: "recoverable_by_reinsurer", label: "Reinsurance recoverables by reinsurer", unit: "usd", by: "item" },
  // By accident year: item is the accident year, with one set of rows for each statement year.
  { id: "ay_loss_ratio", label: "Net loss and LAE ratio by accident year", unit: "pct", by: "item" },
  { id: "ay_npe", label: "Net premiums earned by accident year", unit: "usd", by: "item" },
] as const;
export type StatFieldId = typeof STAT_FIELDS[number]["id"];
export const MAPPING_ID = "statutory_mapping";
/** The fields a query gets when it names none: the original seven, which the Statutory view shows. The fields
    added for company profiles are there when asked for by name. */
export const DEFAULT_STAT_FIELDS: StatFieldId[] = ["dpw_by_line", "npw_by_line", "dpw_by_state", "surplus", "loss_ratio", "loss_lae_ratio", "expense_ratio", "combined_ratio"];

/** How one app field maps to Snowflake. Column names are whatever Discover shows for the account.
    scale multiplies the stored value: 1000 when the view holds thousands of dollars, 100 when a ratio is held
    as a fraction.
    A figure can sit in one view, or be read through a chain of joined views in several schemas:
    - view is "VIEW" (the default schema, the SNOWFLAKE_SCHEMA secret) or "SCHEMA.VIEW"; as names it ("F").
    - joins (up to 8) each add a view with its own as, joined on columns of views named before it.
    - every column is "COLUMN" or "ALIAS.COLUMN"; with joins it must be "ALIAS.COLUMN", so nothing is ambiguous.
    - where conditions: equals, notEquals, in (up to 80 texts), isNull (true or false), month (1 to 12, the month
      of a date column), startsWith (text at the start). Values are always bound, never written into the SQL, as
      text; Snowflake converts a text value to a number when the column is a number.
    - plus: more columns of the same row added to value. stateStrip: a prefix taken off each state afterwards.
    - sum: true adds up the value over rows that share everything else (many rows per counterparty).
    - latest: a column such as a sequence number; only the row with its highest value is kept for each company,
      year, line, state and item (a restated period keeps only its latest version). Up to 3 columns may be listed,
      the first deciding first.
    - joins[] and where[] entries (and latest columns) may say when: "company" or "group", to be used only for that
      kind of lookup; a group lookup can then go through a membership view that a company lookup never touches.
      entity.groupName names the group's name column. distinct: true removes the repeated rows such a join fans
      out to (not with sum, which would add up only one of two real rows that happen to be equal). */
/** when: "company" or "group" uses the entry only for that kind of lookup; without it, the entry is always used. */
export type WhereMap = { column: string; equals?: string; notEquals?: string; in?: string[]; isNull?: boolean; month?: number; startsWith?: string; when?: "company" | "group" };
export type JoinMap = { view: string; as: string; on: { left: string; right: string }[]; kind?: "inner" | "left"; when?: "company" | "group" };
export type FieldMap = {
  view: string; as?: string; joins?: JoinMap[];
  /** groupName: the name column for group lookups (falls back to name). */
  entity: { company?: string; group?: string; name?: string; groupName?: string };
  year: string; yearIsDate?: boolean;
  value: string;
  line?: string; state?: string;
  /** For a field by counterparty (by "item", such as ceded premiums by reinsurer): the column naming it. */
  item?: string;
  /** For a field by counterparty only: a column of the same row that describes the item (for example whether the
      reinsurer is authorized, or affiliated). Selected as TAG, kept on each row, and grouped on with sum. */
  tag?: string;
  where?: WhereMap[];
  sum?: boolean; latest?: string | (string | { column: string; when?: "company" | "group" })[];
  /** SELECT DISTINCT: collapses the repeated rows a join to a list of group members fans out to. Not with sum. */
  distinct?: boolean;
  /** Up to 4 more columns of the same row added to value (a null counts as zero; null only when all are null). */
  plus?: string[];
  /** Text taken off the front of each state before it reaches the page ("Reported:FL" becomes "FL"). */
  stateStrip?: string;
  scale?: number;
};
/** loaded: optional. When S&P's database has no LOADTRACKER, the view each schema has with S&P's run dates, and its
    date column. The app then reports, for each schema a figure came from, the latest date in that view. */
export type LoadedMap = { view: string; at: string };
export type Mapping = { fields: Partial<Record<StatFieldId, FieldMap>>; loaded?: LoadedMap };

// A plain name (letters, digits, _ and $), or the same in double quotes for a name that needs its exact case.
const IDENT = /^(?:[A-Za-z_][A-Za-z0-9_$]{0,127}|"[A-Za-z0-9_$ ]{1,127}")$/;
const ident = (s: unknown): s is string => typeof s === "string" && IDENT.test(s);
// An alias for a view in the mapping: short, plain, written into the SQL in double quotes and upper case.
const ALIAS = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;
const MAX_JOINS = 8, MAX_ON = 4, MAX_WHERE = 12, MAX_IN = 80, MAX_TEXT = 200, MAX_PLUS = 4;
const WHERE_OPS = ["equals", "notEquals", "in", "isNull", "month", "startsWith"] as const;
const OPS_WORDS = "equals, notEquals, in, isNull, month or startsWith";

/** "VIEW" or "SCHEMA.VIEW", each part a checked name (a quoted part can't hold a dot, so the split is safe). */
function viewRef(s: unknown): { schema: string | null; view: string } | null {
  if (typeof s !== "string") return null;
  const p = s.split(".");
  if (p.length === 1 && ident(p[0])) return { schema: null, view: p[0] };
  if (p.length === 2 && ident(p[0]) && ident(p[1])) return { schema: p[0], view: p[1] };
  return null;
}
/** "COLUMN" or "ALIAS.COLUMN". The alias comes back in upper case, as Snowflake reads an unquoted name. */
function colRef(s: unknown): { alias: string | null; col: string } | null {
  if (typeof s !== "string") return null;
  if (IDENT.test(s)) return { alias: null, col: s };
  const i = s.indexOf(".");
  if (i < 0) return null;
  const a = s.slice(0, i), c = s.slice(i + 1);
  return ALIAS.test(a) && ident(c) ? { alias: a.toUpperCase(), col: c } : null;
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type Kind = "company" | "group";
/** Whether a joins[] or where[] entry (or a latest column) is used for this kind of lookup: always without when. */
const usedFor = (x: unknown, k: Kind) => !isObj(x) || x.when === undefined || x.when === k;
const otherKind = (k: Kind): Kind => (k === "company" ? "group" : "company");
/** latest as a list of {column, when?}: a single column, or up to 3 (each "ALIAS.COLUMN" or {column, when}). */
function latestList(f: FieldMap): { column: unknown; when?: unknown }[] {
  const l = f.latest as unknown;
  if (l === undefined) return [];
  return (Array.isArray(l) ? l : [l]).map((x) => (isObj(x) ? { column: x.column, when: x.when } : { column: x }));
}

/** Everything about a field's mapping that doesn't depend on which figure it is. Returns what is wrong, or null.
    A joins[] or where[] entry with when: "company" or "group" is used only for that kind of lookup, so the alias
    checks run once for each kind the mapping can be looked up by (company when it has entity.company, group when
    it has entity.group). */
function shapeProblem(f: FieldMap): string | null {
  if (!viewRef(f.view)) return "view must be a view name";
  if (f.as !== undefined && !(typeof f.as === "string" && ALIAS.test(f.as))) return "as must be a short name: letters, digits and _, starting with a letter";
  const joins = f.joins;
  if (joins !== undefined && (!Array.isArray(joins) || joins.length > MAX_JOINS)) return `joins must be a list of up to ${MAX_JOINS} joins`;
  const joined = !!joins && joins.length > 0;
  if (joined && f.as === undefined) return "as is needed on the main view when there are joins, so each column can say which view it is in";
  const whenOk = (w: unknown) => w === undefined || w === "company" || w === "group";
  // Every alias, in the order declared (the main view's, then each join's), whatever kind of lookup it is for.
  const order: string[] = f.as === undefined ? [] : [f.as.toUpperCase()];
  const whenOf = new Map<string, unknown>();
  for (const [i, j] of (joins ?? []).entries()) {
    const at = `joins[${i}]`;
    if (!isObj(j)) return `${at} must be an object with view, as and on`;
    if (!viewRef(j.view)) return `${at}.view must be a view name or SCHEMA.VIEW`;
    if (!(typeof j.as === "string" && ALIAS.test(j.as))) return `${at}.as must be a short name: letters, digits and _, starting with a letter`;
    if (j.kind !== undefined && j.kind !== "inner" && j.kind !== "left") return `${at}.kind must be "inner" or "left"`;
    if (!whenOk(j.when)) return `${at}.when must be "company" or "group"`;
    const me = j.as.toUpperCase();
    if (order.includes(me)) return `alias ${me} is declared more than once`;
    if (!Array.isArray(j.on) || j.on.length < 1 || j.on.length > MAX_ON) return `${at}.on must be a list of 1 to ${MAX_ON} {left, right} pairs`;
    order.push(me);
    whenOf.set(me, j.when);
    for (const [k, o] of (j.on as unknown[]).entries()) {
      if (!isObj(o)) return `${at}.on[${k}] must be {left, right}`;
      for (const side of ["left", "right"] as const) {
        const r = colRef(o[side]);
        if (!r || !r.alias) return `${at}.on[${k}].${side} must be ALIAS.COLUMN`;
        if (!order.includes(r.alias)) return `${at}.on[${k}].${side} names alias ${r.alias}, which isn't declared`;
      }
    }
  }
  if (!isObj(f.entity) || (f.entity.company === undefined && f.entity.group === undefined)) return "entity needs a company or group column";
  const kinds: Kind[] = (["company", "group"] as const).filter((k) => f.entity[k] !== undefined);
  // The aliases each kind of lookup has, and each join's links checked within that kind's chain.
  const has = new Map<Kind, string[]>();
  for (const kind of kinds) {
    const mine: string[] = f.as === undefined ? [] : [f.as.toUpperCase()];
    for (const [i, j] of (joins ?? []).entries()) {
      if (!usedFor(j, kind)) continue;
      const me = j.as.toUpperCase(), before = [...mine];
      mine.push(me);
      for (const [k, o] of j.on.entries()) {
        const sides: string[] = [];
        for (const side of ["left", "right"] as const) {
          const a = colRef(o[side])!.alias!;
          if (!mine.includes(a)) return `joins[${i}].on[${k}].${side} names alias ${a}, which is only joined for ${otherKind(kind)} lookups`;
          sides.push(a);
        }
        if (!sides.includes(me) || !sides.some((a) => before.includes(a))) return `joins[${i}].on[${k}] must link ${me} to a view named before it`;
      }
    }
    has.set(kind, mine);
  }
  // Every column: a checked name, the alias form when there are joins, and only aliases the lookup has.
  const col = (where: string, v: unknown, forKinds: Kind[] = kinds): string | null => {
    const r = colRef(v);
    if (!r) return `${where} must be a column name`;
    if (joined && !r.alias) return `${where} must be ALIAS.COLUMN when there are joins`;
    if (r.alias && !order.includes(r.alias)) return `${where} names alias ${r.alias}, which isn't declared`;
    for (const k of forKinds) if (r.alias && !has.get(k)!.includes(r.alias)) return `${where} names alias ${r.alias}, which is only joined for ${otherKind(k)} lookups`;
    return null;
  };
  const inKinds = (ks: Kind[]) => kinds.filter((k) => ks.includes(k));
  const ent = f.entity as Record<string, unknown>;
  const entityKinds: Record<string, Kind[]> = { company: ["company"], group: ["group"], name: ent.groupName === undefined ? ["company", "group"] : ["company"], groupName: ["group"] };
  for (const k of ["company", "group", "name", "groupName"] as const) if (ent[k] !== undefined) { const p = col(`entity.${k}`, ent[k], inKinds(entityKinds[k])); if (p) return p; }
  for (const k of ["year", "value"] as const) { const p = col(k, f[k]); if (p) return p; }
  for (const k of ["line", "state", "item", "tag"] as const) if (f[k] !== undefined) { const p = col(k, f[k]); if (p) return p; }
  if (f.latest !== undefined) {
    const l = latestList(f), one = !Array.isArray(f.latest as unknown);
    if (!one && (l.length < 1 || l.length > 3)) return "latest must be a column, or a list of 1 to 3 columns";
    for (const [i, x] of l.entries()) {
      const at = one ? "latest" : `latest[${i}]`;
      if (!whenOk(x.when)) return `${at}.when must be "company" or "group"`;
      const p = col(one ? at : at + (isObj((f.latest as unknown[])[i]) ? ".column" : ""), x.column, kinds.filter((k) => usedFor(x, k))); if (p) return p;
    }
  }
  if (f.where !== undefined && (!Array.isArray(f.where) || f.where.length > MAX_WHERE)) return `where must be a list of up to ${MAX_WHERE} conditions`;
  for (const [i, w] of (f.where ?? []).entries()) {
    const at = `where[${i}]`;
    if (!isObj(w)) return `${at} must be an object with column and one of ${OPS_WORDS}`;
    if (!whenOk(w.when)) return `${at}.when must be "company" or "group"`;
    const p = col(`${at}.column`, w.column, kinds.filter((k) => usedFor(w, k))); if (p) return p;
    const ops = WHERE_OPS.filter((k) => w[k] !== undefined);
    if (ops.length !== 1) return `${at} needs exactly one of ${OPS_WORDS}`;
    const text = (v: unknown) => typeof v === "string" && v.length <= MAX_TEXT;
    const op = ops[0], v = w[op];
    if ((op === "equals" || op === "notEquals") && !text(v)) return `${at}.${op} must be text of up to ${MAX_TEXT} characters`;
    if (op === "startsWith" && !(text(v) && (v as string).length > 0)) return `${at}.startsWith must be text of 1 to ${MAX_TEXT} characters`;
    if (op === "in" && !(Array.isArray(v) && v.length >= 1 && v.length <= MAX_IN && v.every(text))) return `${at}.in must be a list of 1 to ${MAX_IN} texts of up to ${MAX_TEXT} characters`;
    if (op === "isNull" && typeof v !== "boolean") return `${at}.isNull must be true or false`;
    if (op === "month" && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12)) return `${at}.month must be a whole number from 1 to 12`;
  }
  if (f.plus !== undefined && (!Array.isArray(f.plus) || f.plus.length < 1 || f.plus.length > MAX_PLUS)) return `plus must be a list of 1 to ${MAX_PLUS} columns`;
  for (const [i, x] of (f.plus ?? []).entries()) { const p = col(`plus[${i}]`, x); if (p) return p; }
  if (f.stateStrip !== undefined && !(typeof f.stateStrip === "string" && f.stateStrip.length >= 1 && f.stateStrip.length <= MAX_TEXT)) return `stateStrip must be text of 1 to ${MAX_TEXT} characters`;
  if (f.sum !== undefined && typeof f.sum !== "boolean") return "sum must be true or false";
  if (f.distinct !== undefined && typeof f.distinct !== "boolean") return "distinct must be true or false";
  // Adding up after removing repeated rows would also drop real rows that happen to carry the same figures.
  if (f.sum && f.distinct) return "sum and distinct can't be used together: removing repeated rows before adding up would also drop real rows that happen to have the same figures";
  if (f.yearIsDate !== undefined && typeof f.yearIsDate !== "boolean") return "yearIsDate must be true or false";
  if (f.scale !== undefined && !(typeof f.scale === "number" && Number.isFinite(f.scale) && f.scale !== 0)) return "scale must be a number";
  return null;
}

/** Checks one field's mapping. Returns what is wrong, or null. Only checked names ever reach SQL. */
export function mapProblem(id: StatFieldId, m: unknown): string | null {
  const f = m as FieldMap, by = STAT_FIELDS.find((x) => x.id === id)!.by;
  if (!isObj(f)) return "not mapped";
  if (by === "line" && f.line === undefined) return "line must be a column name";
  if (by === "state" && f.state === undefined) return "state must be a column name";
  if (by === "item" && f.item === undefined) return "item must be a column name";
  if (by !== "item" && f.tag !== undefined) return "tag is only for a figure by counterparty (one with an item column)";
  return shapeProblem(f);
}

/** Checks the optional loaded entry. Returns what is wrong, or null (also when there is none). */
export function loadedProblem(l: unknown): string | null {
  if (l === undefined) return null;
  if (!isObj(l)) return "loaded must be {view, at}";
  if (!ident(l.view)) return "loaded.view must be a view name (the same view in each schema, so no schema in front)";
  if (!ident(l.at)) return "loaded.at must be a column name";
  return null;
}

export function readMapping(doc: Record<string, unknown> | null): Mapping {
  const fields = doc && typeof doc.fields === "object" && doc.fields ? doc.fields as Mapping["fields"] : {};
  return doc && doc.loaded !== undefined ? { fields, loaded: doc.loaded as LoadedMap } : { fields };
}

export function fieldStatus(mapping: Mapping) {
  return STAT_FIELDS.map((f) => { const problem = mapProblem(f.id, mapping.fields[f.id]); return { ...f, mapped: problem === null, problem }; });
}

export type StatQuery = { kind: "company" | "group"; codes: string[]; fromYear: number; toYear: number };

export function parseStatQuery(b: Record<string, unknown>, thisYear: number): { ok: true; q: StatQuery; fields: StatFieldId[]; } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  const kind = b.kind === "group" ? "group" : b.kind === "company" || b.kind === undefined ? "company" : null;
  if (!kind) return bad('kind must be "company" or "group".');
  const codes = Array.isArray(b.codes) ? [...new Set(b.codes.map((c) => String(c).trim()))] : [];
  if (!codes.length || codes.length > 8 || codes.some((c) => !/^[0-9]{1,6}$/.test(c))) return bad("Give 1 to 8 NAIC codes (numbers of up to 6 digits).");
  const toYear = b.toYear === undefined ? thisYear - 1 : Number(b.toYear), fromYear = b.fromYear === undefined ? toYear - 4 : Number(b.fromYear);
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear < 1990 || toYear > thisYear || fromYear > toYear || toYear - fromYear > 14) return bad("Years must be whole years, at most 15 at a time.");
  const all = STAT_FIELDS.map((f) => f.id) as StatFieldId[];
  const fields = b.fields === undefined ? [...DEFAULT_STAT_FIELDS] : Array.isArray(b.fields) && b.fields.every((f) => all.includes(f as StatFieldId)) ? [...new Set(b.fields as StatFieldId[])] : null;
  if (!fields || !fields.length) return bad(`fields must be from: ${all.join(", ")}.`);
  return { ok: true, q: { kind, codes, fromYear, toYear }, fields };
}

/** UNCONFIRMED until the mapping is filled in from Discover: turns one mapped field into a read-only SELECT.
    Every name comes from the checked mapping; every value the user typed is bound, never pasted into the SQL. */
export function buildSql(database: string, schema: string, m: FieldMap, q: StatQuery): { statement: string; bindings: Binding[] } | null {
  const entityRef = q.kind === "group" ? m.entity?.group : m.entity?.company;
  if (!entityRef || !ident(database) || !ident(schema) || shapeProblem(m)) return null;
  // Only names that passed the checks above are written in. An alias goes in double quotes, in upper case.
  const c = (ref: string) => { const r = colRef(ref)!; return r.alias ? `"${r.alias}".${r.col}` : r.col; };
  const from = (ref: string) => { const r = viewRef(ref)!; return `${database}.${r.schema ?? schema}.${r.view}`; };
  const entityCol = c(entityRef), year = m.yearIsDate ? `YEAR(${c(m.year)})` : c(m.year);
  // A group lookup uses only the joins and conditions for every lookup and those marked when: "group"; a company
  // lookup likewise. So a company lookup never goes through a group's membership view.
  const joins = (m.joins ?? []).filter((j) => usedFor(j, q.kind)), conds = (m.where ?? []).filter((w) => usedFor(w, q.kind));
  const nameRef = q.kind === "group" ? m.entity.groupName ?? m.entity.name : m.entity.name;
  const name = nameRef === undefined ? null : c(nameRef), line = m.line === undefined ? null : c(m.line), state = m.state === undefined ? null : c(m.state);
  const item = m.item === undefined ? null : c(m.item);
  // plus: value + each extra column of the same row, a null counted as zero; null when every one is null
  const adds = [m.value, ...(m.plus ?? [])].map(c);
  const value = adds.length === 1 ? adds[0] : `CASE WHEN ${adds.map((a) => `${a} IS NULL`).join(" AND ")} THEN NULL ELSE ${adds.map((a) => `COALESCE(${a}, 0)`).join(" + ")} END`;
  const cols = [`${m.distinct ? "DISTINCT " : ""}${entityCol} AS CODE`, `${name ?? "NULL"} AS NAME`, `${year} AS YR`, `${line ?? "NULL"} AS LINE`, `${state ?? "NULL"} AS STATE`, `${m.sum ? `SUM(${value})` : value} AS VAL`];
  if (item !== null) cols.push(`${item} AS ITEM`);   // only fields by counterparty map an item column
  const tag = item !== null && m.tag !== undefined ? c(m.tag) : null;
  if (tag !== null) cols.push(`${tag} AS TAG`);      // and only they may map a tag column beside it
  let source = from(m.view) + (m.as === undefined ? "" : ` AS "${m.as.toUpperCase()}"`);
  for (const j of joins) source += ` ${j.kind === "left" ? "LEFT JOIN" : "JOIN"} ${from(j.view)} AS "${j.as.toUpperCase()}" ON ${j.on.map((o) => `${c(o.left)} = ${c(o.right)}`).join(" AND ")}`;
  const bindings: Binding[] = q.codes.map((code) => ({ type: "TEXT", value: code }));
  let where = `${entityCol} IN (${q.codes.map(() => "?").join(", ")}) AND ${year} BETWEEN ? AND ?`;
  bindings.push({ type: "FIXED", value: String(q.fromYear) }, { type: "FIXED", value: String(q.toYear) });
  for (const w of conds) {
    const col = c(w.column);
    if (w.equals !== undefined) { where += ` AND ${col} = ?`; bindings.push({ type: "TEXT", value: w.equals }); }
    else if (w.notEquals !== undefined) { where += ` AND ${col} <> ?`; bindings.push({ type: "TEXT", value: w.notEquals }); }
    else if (w.in !== undefined) { where += ` AND ${col} IN (${w.in.map(() => "?").join(", ")})`; bindings.push(...w.in.map((v) => ({ type: "TEXT" as const, value: v }))); }
    else if (w.isNull !== undefined) where += ` AND ${col} ${w.isNull ? "IS NULL" : "IS NOT NULL"}`;
    else if (w.month !== undefined) { where += ` AND MONTH(${col}) = ?`; bindings.push({ type: "FIXED", value: String(w.month) }); }
    else if (w.startsWith !== undefined) { where += ` AND STARTSWITH(${col}, ?)`; bindings.push({ type: "TEXT", value: w.startsWith }); }
  }
  const latest = latestList(m).filter((x) => usedFor(x, q.kind)).map((x) => c(x.column as string));
  // sum: grouped by everything else selected (by position), and by the latest columns when there are any.
  const group = m.sum ? ` GROUP BY 1, 2, 3, 4, 5${item !== null ? ", 7" : ""}${tag !== null ? ", 8" : ""}${latest.map((l) => `, ${l}`).join("")}` : "";
  // Rows of each company stay apart in a group lookup, when this lookup's chain has the company column.
  const aliases = [m.as, ...joins.map((j) => j.as)].filter((a): a is string => a !== undefined).map((a) => a.toUpperCase());
  const companyRef = m.entity.company === undefined ? null : colRef(m.entity.company)!;
  const company = !m.sum && companyRef && m.entity.company !== entityRef && (!companyRef.alias || aliases.includes(companyRef.alias)) ? c(m.entity.company!) : null;
  const keep = latest.length ? ` QUALIFY ROW_NUMBER() OVER (PARTITION BY ${[entityCol, company, name, year, line, state, item].filter((x) => x !== null).join(", ")} ORDER BY ${latest.map((l) => `${l} DESC`).join(", ")}) = 1` : "";
  return { statement: `SELECT ${cols.join(", ")} FROM ${source} WHERE ${where}${group}${keep} ORDER BY 1, 3 LIMIT 20000`, bindings };
}

export type StatRow = { code: string; year: number; line: string | null; state: string | null; value: number | null; item?: string | null; tag?: string | null };
export type StatField = { id: StatFieldId; label: string; unit: "usd" | "pct"; by: "year" | "line" | "state" | "item"; mapped: boolean; error: string | null; rows: StatRow[] };
export type StatResult = {
  kind: "company" | "group"; codes: string[]; fromYear: number; toYear: number;
  entities: { code: string; name: string | null }[]; fields: StatField[]; loaded: { view: string; at: string }[]; truncated: boolean; source: string;
  /** "schema" when loaded lists schemas and their run dates (the mapping's loaded entry), not views from LOADTRACKER. */
  loadedBy?: "schema";
};

const bareName = (v: string) => v.replace(/^"|"$/g, "");
/** The name as Snowflake stores it: exactly as written when it is in double quotes, otherwise upper case. */
export const storedName = (v: string) => (/^".*"$/.test(v) ? bareName(v) : v.toUpperCase());

/** How many figures' statements run at once: each is a join across big shared views that takes several seconds, so
    one after another they don't fit in one function call. Eight: Snowflake's usual limit of statements running at
    once on one warehouse (more would only queue). A full profile asks for about 50 figures. */
export const STAT_POOL = 8;
/** A statement isn't started with less time than this left in the call: it would only be cancelled. */
export const STAT_MIN_MS = 8_000;
/** Every figure that didn't fit in the time starts with this; savedOrFreshStatutory counts them as still to come. */
export const NOT_RUN_PREFIX = "Not run:";
export const NOT_RUN = `${NOT_RUN_PREFIX} the query ran out of time. Run it again, or ask for fewer fields.`;
const notRun = (f: StatField) => !!f.error?.startsWith(NOT_RUN_PREFIX);

/** One figure as it came back: its field, the entity names its rows carried, whether it was cut at the row limit,
    and where it was read from (the main view for LOADTRACKER, every schema for the run-date view). */
export type FigurePart = { field: StatField; names: Record<string, string>; truncated: boolean; view: string | null; schemas: string[] };

/** Runs jobs at most n at a time; the answers keep the jobs' order. A job that throws stops new ones from starting;
    those already running are waited for (their own failures are dropped), then the first error is thrown. */
async function inPool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0, failed: { e: unknown } | null = null;
  const worker = async () => {
    while (!failed && next < jobs.length) {
      const i = next++;
      try { out[i] = await jobs[i](); } catch (e) { if (!failed) failed = { e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  if (failed) throw (failed as { e: unknown }).e;
  return out;
}

/** Each requested field as one Snowflake statement, STAT_POOL at a time, in the order asked. A figure that runs out
    of time (Snowflake's 408, or a statement given up on) is that figure's NOT_RUN, as is one that would start with
    less than STAT_MIN_MS left; sign-in, set-up, network and busy failures stop the whole query. */
async function runFigures(sf: Snowflake, database: string, schema: string, mapping: Mapping, q: StatQuery, fields: StatFieldId[], time?: { deadline: number; now: () => number }): Promise<FigurePart[]> {
  const parts: FigurePart[] = new Array(fields.length), jobs: (() => Promise<void>)[] = [];
  const part = (field: StatField): FigurePart => ({ field, names: {}, truncated: false, view: null, schemas: [] });
  for (const [i, id] of fields.entries()) {
    const meta = STAT_FIELDS.find((f) => f.id === id)!;
    const m = mapping.fields[id];
    const problem = mapProblem(id, m);
    const base = { id, label: meta.label, unit: meta.unit, by: meta.by };
    if (problem || !m) { parts[i] = part({ ...base, mapped: false, error: null, rows: [] }); continue; }
    const sql = buildSql(database, schema, meta.by === "item" ? m : { ...m, item: undefined, tag: undefined }, q);
    if (!sql) {
      const error = !ident(database) || !ident(schema) ? "SNOWFLAKE_DATABASE or SNOWFLAKE_SCHEMA isn't a valid name. Check those two secrets on Supabase."
        : `This field has no ${q.kind} column mapped, so it can't be looked up by ${q.kind} code.`;
      parts[i] = part({ ...base, mapped: false, error, rows: [] });
      continue;
    }
    jobs.push(async () => {
      // A function call may only run so long: fields that don't fit are reported, not left hanging.
      const left = time ? time.deadline - time.now() : Infinity;
      if (left < STAT_MIN_MS) { parts[i] = part({ ...base, mapped: true, error: NOT_RUN, rows: [] }); return; }
      try {
        const res = await sf.query(sql.statement, sql.bindings, Math.min(100_000, left));
        const names: Record<string, string> = {};
        const rows: StatRow[] = res.rows.map((r) => {
          const code = String(r.CODE ?? "").trim(), raw = r.VAL === null || r.VAL === "" ? NaN : Number(r.VAL);
          if (r.NAME && q.codes.includes(code) && !names[code]) names[code] = String(r.NAME);
          const row: StatRow = { code, year: Number(r.YR), line: r.LINE === null ? null : String(r.LINE), state: r.STATE === null ? null : String(r.STATE), value: Number.isFinite(raw) ? Math.round(raw * (m.scale ?? 1) * 1e6) / 1e6 : null };
          if (m.stateStrip && row.state !== null && row.state.startsWith(m.stateStrip)) row.state = row.state.slice(m.stateStrip.length);   // "Reported:FL" -> "FL"
          if (meta.by === "item") row.item =r.ITEM === null || r.ITEM === undefined ? null : String(r.ITEM);
          if (meta.by === "item" && m.tag !== undefined) row.tag = r.TAG === null || r.TAG === undefined ? null : String(r.TAG);
          return row;
        }).filter((r) => Number.isInteger(r.year));
        parts[i] = {
          field: { ...base, mapped: true, error: null, rows }, names, truncated: res.truncated,
          view: bareName(viewRef(m.view)?.view ?? m.view),   // LOADTRACKER names a view without its schema
          schemas: [m.view, ...(m.joins ?? []).map((j) => j.view)].map((v) => viewRef(v)?.schema ?? schema),
        };
      } catch (e) {
        // Sign-in and set-up failures stop the whole query; a field whose SQL fails, or that runs out of time, is
        // reported on its own.
        if (e instanceof SnowflakeError && e.code === "timeout") { parts[i] = part({ ...base, mapped: true, error: NOT_RUN, rows: [] }); return; }
        if (!(e instanceof SnowflakeError) || e.code !== "sql") throw e;
        parts[i] = part({ ...base, mapped: true, error: `${e.message.replace(/[.\s]*$/, ".")} Check this field's mapping.`, rows: [] });
      }
    });
  }
  await inPool(STAT_POOL, jobs);
  return parts;
}

/** The answer from its figures, in the order given: names, truncated and the run dates of every view or schema used. */
async function assemble(sf: Snowflake, database: string, schema: string, mapping: Mapping, q: StatQuery, parts: FigurePart[]): Promise<StatResult> {
  const names = new Map<string, string | null>(q.codes.map((c) => [c, null]));
  const views = new Set<string>(), schemasUsed = new Set<string>();
  let truncated = false;
  for (const p of parts) {
    truncated ||= p.truncated;
    for (const [code, name] of Object.entries(p.names)) if (names.has(code) && !names.get(code)) names.set(code, name);
    if (p.view !== null) views.add(p.view);
    for (const s of p.schemas) schemasUsed.add(s);
  }
  // With a loaded entry, the run date of each schema a figure came from; without one, LOADTRACKER as before.
  const bySchema = mapping.loaded !== undefined && loadedProblem(mapping.loaded) === null;
  return {
    ...q, entities: q.codes.map((code) => ({ code, name: names.get(code) ?? null })), fields: parts.map((p) => p.field),
    loaded: bySchema ? (schemasUsed.size ? await loadedBySchema(sf, database, mapping.loaded!, [...schemasUsed]) : []) : views.size ? await loadedAt(sf, database, schema, [...views]) : [],
    ...(bySchema ? { loadedBy: "schema" as const } : {}), truncated,
    source: "S&P Global Market Intelligence, SNL Insurance Regulatory Data (Snowflake)",
  };
}

/** Runs each requested field as one Snowflake statement (several at once) and shapes the rows for the page and for Claude. */
export async function runStatutory(sf: Snowflake, database: string, schema: string, mapping: Mapping, q: StatQuery, fields: StatFieldId[], time?: { deadline: number; now: () => number }): Promise<StatResult> {
  return assemble(sf, database, schema, mapping, q, await runFigures(sf, database, schema, mapping, q, fields, time));
}

/** UNCONFIRMED: S&P's run-date view and column are whatever the mapping's loaded entry names. For each schema, the
    latest date in that schema's view, one small statement per schema, in name order. Entries keep the {view, at}
    shape, with the schema's name as view. A failure here never fails the query: that schema is left out. */
export async function loadedBySchema(sf: Snowflake, database: string, loaded: LoadedMap, schemas: string[]): Promise<{ view: string; at: string }[]> {
  if (!ident(database) || loadedProblem(loaded) !== null) return [];
  const seen = new Map<string, string>();
  for (const s of schemas) if (ident(s) && !seen.has(storedName(s))) seen.set(storedName(s), s);
  // several at once (STAT_POOL), answered in name order
  const found = await inPool(STAT_POOL, [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, s]) => async () => {
    try {
      const res = await sf.query(`SELECT MAX(${loaded.at}) AS AT FROM ${database}.${s}.${loaded.view}`, [], 15_000);
      const at = res.rows[0]?.AT;
      return at ? { view: name, at: String(at) } : null;
    } catch { return null; /* this schema's date is left out */ }
  }));
  return found.filter((x): x is { view: string; at: string } => x !== null);
}

/** When S&P last loaded each view, from LOADTRACKER. A failure here never fails the query. */
export async function loadedAt(sf: Snowflake, database: string, schema: string, views: string[]): Promise<{ view: string; at: string }[]> {
  if (!ident(database) || !ident(schema) || !views.length) return [];
  try {
    const res = await sf.query(
      `SELECT TABLENAME, MAX(LASTTABLEUPDATETIME) AS AT FROM ${database}.${schema}.LOADTRACKER WHERE UPPER(TABLENAME) IN (${views.map(() => "?").join(", ")}) GROUP BY TABLENAME ORDER BY 1`,
      views.map((v) => ({ type: "TEXT" as const, value: v.toUpperCase() })));
    return res.rows.filter((r) => r.TABLENAME && r.AT).map((r) => ({ view: String(r.TABLENAME), at: String(r.AT) }));
  } catch { return []; }
}

// ---------- discovery ----------
// INFORMATION_SCHEMA lists only what the role can see. It needs a running warehouse, so each call costs at
// least a minute of warehouse time. Filters keep the answer small (Snowflake refuses unselective queries).

export async function discoverViews(sf: Snowflake, database: string, schema: string, like?: string) {
  if (!ident(database)) throw new SnowflakeError("sql", "SNOWFLAKE_DATABASE isn't a valid name.");
  const bindings: Binding[] = [{ type: "TEXT", value: storedName(schema) }];
  let where = "TABLE_SCHEMA = ?";
  if (like) { where += " AND TABLE_NAME ILIKE ?"; bindings.push({ type: "TEXT", value: `%${like.replace(/%/g, "")}%` }); }
  const res = await sf.query(`SELECT TABLE_NAME, TABLE_TYPE, COMMENT FROM ${database}.INFORMATION_SCHEMA.TABLES WHERE ${where} ORDER BY TABLE_NAME LIMIT 5000`, bindings);
  return { views: res.rows.map((r) => ({ name: String(r.TABLE_NAME), type: String(r.TABLE_TYPE ?? ""), comment: r.COMMENT ?? null })), truncated: res.truncated || res.rows.length >= 5000 };
}

export async function discoverColumns(sf: Snowflake, database: string, schema: string, view: string) {
  if (!ident(database)) throw new SnowflakeError("sql", "SNOWFLAKE_DATABASE isn't a valid name.");
  const res = await sf.query(
    `SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION, COMMENT FROM ${database}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [{ type: "TEXT", value: storedName(schema) }, { type: "TEXT", value: storedName(view) }]);
  return { view: storedName(view), columns: res.rows.map((r) => ({ name: String(r.COLUMN_NAME), type: String(r.DATA_TYPE ?? ""), position: Number(r.ORDINAL_POSITION), comment: r.COMMENT ?? null })) };
}

/** The schemas in the database this account can see (S&P keeps entities, financials and so on in separate ones). */
export async function discoverSchemas(sf: Snowflake, database: string) {
  if (!ident(database)) throw new SnowflakeError("sql", "SNOWFLAKE_DATABASE isn't a valid name.");
  const res = await sf.query(`SELECT SCHEMA_NAME, COMMENT FROM ${database}.INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME <> ? ORDER BY SCHEMA_NAME LIMIT 1000`, [{ type: "TEXT", value: "INFORMATION_SCHEMA" }]);
  return { schemas: res.rows.map((r) => ({ name: String(r.SCHEMA_NAME), comment: r.COMMENT ?? null })), truncated: res.truncated || res.rows.length >= 1000 };
}

export const NOT_MAPPED = "Snowflake is connected, but the statutory fields aren't mapped to S&P's views yet. A Corp Dev login can do this once on the Statutory view.";
/** pending: figures still "Not run" (the time ran out before they came back); asking again with the same question
    carries on from where it stopped, as each figure that came back is kept. */
export type StatAnswer = StatResult & { fetchedAt: string; fromStore: boolean; saved: boolean; pending: number };

/** The saved entry of one figure of a question: kind, sorted codes, years, the figure, that figure's whole mapping and
    the mapping's loaded entry when there is one. Two companies, years or kinds never share one. */
export async function figureStoreId(mapping: Mapping, q: StatQuery, f: StatFieldId): Promise<string> {
  return "statutory:f." + await shortHash(JSON.stringify(["figure", q.kind, [...q.codes].sort(), q.fromYear, q.toYear, f, mapping.fields[f] ?? null, ...(mapping.loaded !== undefined ? [{ loaded: mapping.loaded }] : [])]));
}
type SavedFigure = FigurePart & { fetchedAt: string };
/** A saved figure as it was put, or null for anything else (a figure later overwritten by a refresh that didn't reach it). */
function readFigure(doc: unknown, f: StatFieldId): SavedFigure | null {
  const d = doc as Partial<SavedFigure> | null;
  if (!d || typeof d !== "object" || !d.field || d.field.id !== f || !Array.isArray(d.field.rows) || d.field.error !== null || typeof d.fetchedAt !== "string") return null;
  return { field: d.field, names: d.names && typeof d.names === "object" ? d.names : {}, truncated: d.truncated === true, view: typeof d.view === "string" ? d.view : null, schemas: Array.isArray(d.schemas) ? d.schemas : [], fetchedAt: d.fetchedAt };
}
/** What replaces a saved entry that a refresh couldn't get to again, so the next call runs it afresh. */
const SUPERSEDED = { superseded: true };

/** A statutory query as the page and Claude both run it: the saved result when there is one (unless refresh),
    otherwise Snowflake. The mapping is part of the saved result's id, so a corrected mapping is used straight
    away. sf is null when Snowflake isn't set up.
    Each figure that comes back is also saved on its own (figureStoreId), and only figures not saved are run, so a
    question too big for one call is answered over several: each answer says how many figures are still pending. The
    whole answer is saved, as before, once nothing is pending. */
export async function savedOrFreshStatutory(sf: Snowflake | null, db: Db, database: string, schema: string, mapping: Mapping, q: StatQuery, fields: StatFieldId[],
  opts: { now: number; refresh?: boolean; deadline?: number; clock?: () => number }): Promise<StatAnswer> {
  const asked = [...fields].sort();
  // Each field's whole mapping (joins and where included) is hashed; the loaded entry too, when there is one, so
  // results saved before it existed keep their ids.
  const id = "statutory:" + await shortHash(JSON.stringify([q.kind, [...q.codes].sort(), q.fromYear, q.toYear, asked, asked.map((f) => mapping.fields[f] ?? null), ...(mapping.loaded !== undefined ? [{ loaded: mapping.loaded }] : [])]));
  const saved = opts.refresh ? null : await db.getStore(id);
  if (saved && (saved.doc as Record<string, unknown>).superseded !== true) {
    const doc = saved.doc as unknown as StatResult & { fetchedAt?: unknown };
    return { ...doc, fetchedAt: typeof doc.fetchedAt === "string" ? doc.fetchedAt : saved.fetched_at, fromStore: true, saved: true, pending: 0 };
  }
  if (!sf) throw new SnowflakeError("not_configured", SNOWFLAKE_NOT_CONFIGURED);
  if (!fieldStatus(mapping).some((f) => f.mapped)) throw new SnowflakeError("not_mapped", NOT_MAPPED);
  const now = new Date(opts.now).toISOString();
  // The figures saved earlier (unless refresh); only the rest are asked of Snowflake.
  const figIds = await Promise.all(fields.map((f) => figureStoreId(mapping, q, f)));
  const kept: (SavedFigure | null)[] = opts.refresh ? fields.map(() => null)
    : await Promise.all(fields.map(async (f, i) => (mapProblem(f, mapping.fields[f]) ? null : readFigure((await db.getStore(figIds[i]))?.doc ?? null, f))));
  const toRun = fields.filter((_, i) => !kept[i]);
  const fresh = toRun.length ? await runFigures(sf, database, schema, mapping, q, toRun, opts.deadline !== undefined ? { deadline: opts.deadline, now: opts.clock ?? Date.now } : undefined) : [];
  let k = 0;
  const parts: FigurePart[] = fields.map((_, i) => kept[i] ?? fresh[k++]);
  const label = `${q.kind} ${q.codes.join(",")} ${q.fromYear}-${q.toYear}`;
  // Each figure that came back without an error is kept, so the next call carries on from here.
  const pendingIds: string[] = [];
  await Promise.all(fields.map((f, i) => {
    if (kept[i]) return null;
    const p = parts[i];
    if (notRun(p.field)) { pendingIds.push(figIds[i]); return null; }
    if (!p.field.mapped || p.field.error !== null) return null;
    const doc: SavedFigure = { ...p, fetchedAt: now };
    return db.putStore({ id: figIds[i], kind: "statutory", label: `${label} ${f}`, doc: doc as unknown as Record<string, unknown> });
  }));
  const result = await assemble(sf, database, schema, mapping, q, parts);
  const pending = parts.filter((p) => notRun(p.field)).length;
  // A mixed answer is as old as its oldest figure.
  const fetchedAt = kept.reduce((a, s) => (s && s.fetchedAt < a ? s.fetchedAt : a), now);
  // From the store when every figure there is came from it: nothing was asked of Snowflake but the run dates.
  const fromStore = kept.some(Boolean) && fresh.every((p) => !p.field.mapped);
  let wasSaved = false;
  if (pending === 0) wasSaved = await db.putStore({ id, kind: "statutory", label, doc: { ...result, fetchedAt } as unknown as Record<string, unknown> });
  else if (opts.refresh) {
    // A refresh that didn't get to every figure: the older whole answer and the older copies of the figures it
    // didn't reach are set aside, so carrying on runs them afresh instead of mixing in the old ones.
    await Promise.all([id, ...pendingIds].map((x) => db.putStore({ id: x, kind: "statutory", label, doc: SUPERSEDED })));
  }
  return { ...result, fetchedAt, fromStore, saved: wasSaved, pending };
}

export async function getMapping(db: Db): Promise<Mapping> { return readMapping(await db.getSetting(MAPPING_ID)); }
export const isViewName = ident;
