// Statutory financials from SNL Insurance Regulatory Data on Snowflake, driven by a field mapping.
//
// Confirmed by S&P's Snowflake guide: database MI_XPRESSCLOUD, schema XPRESSFEED, tables appear as views, and
// the LOADTRACKER view (PACKAGENAME, TABLENAME, LASTTABLEUPDATETIME) says when each was last loaded.
// NOT confirmed: the name of any Insurance Regulatory view or column. So nothing here names one. The app's
// fields (below) are mapped to real views and columns in the snl_settings row "statutory_mapping", which Corp
// Dev fills in after running Discover. buildSql is the one place a mapping becomes SQL.

import type { Db } from "./db.ts";
import { shortHash } from "./http.ts";
import { type Binding, type Snowflake, SNOWFLAKE_NOT_CONFIGURED, SnowflakeError } from "./snowflake.ts";

export const STAT_FIELDS = [
  { id: "dpw_by_line", label: "Direct premiums written by line", unit: "usd", by: "line" },
  { id: "npw_by_line", label: "Net premiums written by line", unit: "usd", by: "line" },
  { id: "dpw_by_state", label: "Direct premiums written by state", unit: "usd", by: "state" },
  { id: "surplus", label: "Policyholder surplus", unit: "usd", by: "year" },
  { id: "loss_ratio", label: "Loss ratio", unit: "pct", by: "year" },
  { id: "expense_ratio", label: "Expense ratio", unit: "pct", by: "year" },
  { id: "combined_ratio", label: "Combined ratio", unit: "pct", by: "year" },
] as const;
export type StatFieldId = typeof STAT_FIELDS[number]["id"];
export const MAPPING_ID = "statutory_mapping";

/** How one app field maps to a Snowflake view. Column names are whatever Discover shows for the account.
    scale multiplies the stored value: 1000 when the view holds thousands of dollars, 100 when a ratio is held
    as a fraction. */
export type FieldMap = {
  view: string;
  entity: { company?: string; group?: string; name?: string };
  year: string; yearIsDate?: boolean;
  value: string;
  line?: string; state?: string;
  where?: { column: string; equals: string }[];
  scale?: number;
};
export type Mapping = { fields: Partial<Record<StatFieldId, FieldMap>> };

// A plain name (letters, digits, _ and $), or the same in double quotes for a name that needs its exact case.
const IDENT = /^(?:[A-Za-z_][A-Za-z0-9_$]{0,127}|"[A-Za-z0-9_$ ]{1,127}")$/;
const ident = (s: unknown): s is string => typeof s === "string" && IDENT.test(s);

/** Checks one field's mapping. Returns what is wrong, or null. Only checked names ever reach SQL. */
export function mapProblem(id: StatFieldId, m: unknown): string | null {
  const f = m as FieldMap, by = STAT_FIELDS.find((x) => x.id === id)!.by;
  if (!f || typeof f !== "object") return "not mapped";
  if (!ident(f.view)) return "view must be a view name";
  if (!f.entity || typeof f.entity !== "object" || (!ident(f.entity.company) && !ident(f.entity.group))) return "entity needs a company or group column";
  for (const k of ["company", "group", "name"] as const) if (f.entity[k] !== undefined && !ident(f.entity[k])) return `entity.${k} must be a column name`;
  if (!ident(f.year)) return "year must be a column name";
  if (!ident(f.value)) return "value must be a column name";
  if (by === "line" && !ident(f.line)) return "line must be a column name";
  if (by === "state" && !ident(f.state)) return "state must be a column name";
  if (f.line !== undefined && !ident(f.line)) return "line must be a column name";
  if (f.state !== undefined && !ident(f.state)) return "state must be a column name";
  if (f.where !== undefined && (!Array.isArray(f.where) || f.where.length > 8 || f.where.some((w) => !w || !ident(w.column) || typeof w.equals !== "string" || w.equals.length > 200))) return "where must be a list of {column, equals}";
  if (f.scale !== undefined && !(typeof f.scale === "number" && Number.isFinite(f.scale) && f.scale !== 0)) return "scale must be a number";
  return null;
}

export function readMapping(doc: Record<string, unknown> | null): Mapping {
  const fields = doc && typeof doc.fields === "object" && doc.fields ? doc.fields as Mapping["fields"] : {};
  return { fields };
}

export function fieldStatus(mapping: Mapping) {
  return STAT_FIELDS.map((f) => ({ ...f, mapped: mapProblem(f.id, mapping.fields[f.id]) === null }));
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
  const fields = b.fields === undefined ? all : Array.isArray(b.fields) && b.fields.every((f) => all.includes(f as StatFieldId)) ? [...new Set(b.fields as StatFieldId[])] : null;
  if (!fields || !fields.length) return bad(`fields must be from: ${all.join(", ")}.`);
  return { ok: true, q: { kind, codes, fromYear, toYear }, fields };
}

/** UNCONFIRMED until the mapping is filled in from Discover: turns one mapped field into a read-only SELECT.
    Every name comes from the checked mapping; every value the user typed is bound, never pasted into the SQL. */
export function buildSql(database: string, schema: string, m: FieldMap, q: StatQuery): { statement: string; bindings: Binding[] } | null {
  const entityCol = q.kind === "group" ? m.entity.group : m.entity.company;
  if (!entityCol || !ident(database) || !ident(schema)) return null;
  const year = m.yearIsDate ? `YEAR(${m.year})` : m.year;
  const cols = [`${entityCol} AS CODE`, `${m.entity.name ?? "NULL"} AS NAME`, `${year} AS YR`, `${m.line ?? "NULL"} AS LINE`, `${m.state ?? "NULL"} AS STATE`, `${m.value} AS VAL`];
  const bindings: Binding[] = q.codes.map((c) => ({ type: "TEXT", value: c }));
  let where = `${entityCol} IN (${q.codes.map(() => "?").join(", ")}) AND ${year} BETWEEN ? AND ?`;
  bindings.push({ type: "FIXED", value: String(q.fromYear) }, { type: "FIXED", value: String(q.toYear) });
  for (const w of m.where ?? []) { where += ` AND ${w.column} = ?`; bindings.push({ type: "TEXT", value: w.equals }); }
  return { statement: `SELECT ${cols.join(", ")} FROM ${database}.${schema}.${m.view} WHERE ${where} ORDER BY 1, 3 LIMIT 20000`, bindings };
}

export type StatRow = { code: string; year: number; line: string | null; state: string | null; value: number | null };
export type StatField = { id: StatFieldId; label: string; unit: "usd" | "pct"; by: "year" | "line" | "state"; mapped: boolean; error: string | null; rows: StatRow[] };
export type StatResult = {
  kind: "company" | "group"; codes: string[]; fromYear: number; toYear: number;
  entities: { code: string; name: string | null }[]; fields: StatField[]; loaded: { view: string; at: string }[]; truncated: boolean; source: string;
};

const bareName = (v: string) => v.replace(/^"|"$/g, "");
/** The name as Snowflake stores it: exactly as written when it is in double quotes, otherwise upper case. */
export const storedName = (v: string) => (/^".*"$/.test(v) ? bareName(v) : v.toUpperCase());

/** Runs each requested field as one Snowflake statement and shapes the rows for the page and for Claude. */
export async function runStatutory(sf: Snowflake, database: string, schema: string, mapping: Mapping, q: StatQuery, fields: StatFieldId[], time?: { deadline: number; now: () => number }): Promise<StatResult> {
  const names = new Map<string, string | null>(q.codes.map((c) => [c, null]));
  const out: StatField[] = [];
  const views = new Set<string>();
  let truncated = false;
  for (const id of fields) {
    const meta = STAT_FIELDS.find((f) => f.id === id)!;
    const m = mapping.fields[id];
    const problem = mapProblem(id, m);
    const base = { id, label: meta.label, unit: meta.unit, by: meta.by };
    if (problem || !m) { out.push({ ...base, mapped: false, error: null, rows: [] }); continue; }
    const sql = buildSql(database, schema, m, q);
    if (!sql) {
      const error = !ident(database) || !ident(schema) ? "SNOWFLAKE_DATABASE or SNOWFLAKE_SCHEMA isn't a valid name. Check those two secrets on Supabase."
        : `This field has no ${q.kind} column mapped, so it can't be looked up by ${q.kind} code.`;
      out.push({ ...base, mapped: false, error, rows: [] });
      continue;
    }
    // A function call may only run so long: fields that don't fit are reported, not left hanging.
    const left = time ? time.deadline - time.now() : Infinity;
    if (left <= 0) { out.push({ ...base, mapped: true, error: "Not run: the query ran out of time. Run it again, or ask for fewer fields.", rows: [] }); continue; }
    try {
      const res = await sf.query(sql.statement, sql.bindings, Math.max(5_000, Math.min(100_000, left)));
      truncated ||= res.truncated;
      views.add(bareName(m.view));
      const rows: StatRow[] = res.rows.map((r) => {
        const code = String(r.CODE ?? "").trim(), raw = r.VAL === null || r.VAL === "" ? NaN : Number(r.VAL);
        if (r.NAME && names.has(code) && !names.get(code)) names.set(code, String(r.NAME));
        return { code, year: Number(r.YR), line: r.LINE === null ? null : String(r.LINE), state: r.STATE === null ? null : String(r.STATE), value: Number.isFinite(raw) ? Math.round(raw * (m.scale ?? 1) * 1e6) / 1e6 : null };
      }).filter((r) => Number.isInteger(r.year));
      out.push({ ...base, mapped: true, error: null, rows });
    } catch (e) {
      // Sign-in and set-up failures stop the whole query; a field whose SQL fails is reported on its own.
      if (!(e instanceof SnowflakeError) || e.code !== "sql") throw e;
      out.push({ ...base, mapped: true, error: `${e.message.replace(/[.\s]*$/, ".")} Check this field's mapping.`, rows: [] });
    }
  }
  return {
    ...q, entities: q.codes.map((code) => ({ code, name: names.get(code) ?? null })), fields: out,
    loaded: views.size ? await loadedAt(sf, database, schema, [...views]) : [], truncated,
    source: "S&P Global Market Intelligence, SNL Insurance Regulatory Data (Snowflake)",
  };
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
  const bindings: Binding[] = [{ type: "TEXT", value: bareName(schema).toUpperCase() }];
  let where = "TABLE_SCHEMA = ?";
  if (like) { where += " AND TABLE_NAME ILIKE ?"; bindings.push({ type: "TEXT", value: `%${like.replace(/%/g, "")}%` }); }
  const res = await sf.query(`SELECT TABLE_NAME, TABLE_TYPE, COMMENT FROM ${database}.INFORMATION_SCHEMA.TABLES WHERE ${where} ORDER BY TABLE_NAME LIMIT 5000`, bindings);
  return { views: res.rows.map((r) => ({ name: String(r.TABLE_NAME), type: String(r.TABLE_TYPE ?? ""), comment: r.COMMENT ?? null })), truncated: res.truncated || res.rows.length >= 5000 };
}

export async function discoverColumns(sf: Snowflake, database: string, schema: string, view: string) {
  if (!ident(database)) throw new SnowflakeError("sql", "SNOWFLAKE_DATABASE isn't a valid name.");
  const res = await sf.query(
    `SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION, COMMENT FROM ${database}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [{ type: "TEXT", value: bareName(schema).toUpperCase() }, { type: "TEXT", value: storedName(view) }]);
  return { view: storedName(view), columns: res.rows.map((r) => ({ name: String(r.COLUMN_NAME), type: String(r.DATA_TYPE ?? ""), position: Number(r.ORDINAL_POSITION), comment: r.COMMENT ?? null })) };
}

export const NOT_MAPPED = "Snowflake is connected, but the statutory fields aren't mapped to S&P's views yet. A Corp Dev login can do this once on the Statutory view.";
export type StatAnswer = StatResult & { fetchedAt: string; fromStore: boolean; saved: boolean };

/** A statutory query as the page and Claude both run it: the saved result when there is one (unless refresh),
    otherwise Snowflake. The mapping is part of the saved result's id, so a corrected mapping is used straight
    away. sf is null when Snowflake isn't set up. */
export async function savedOrFreshStatutory(sf: Snowflake | null, db: Db, database: string, schema: string, mapping: Mapping, q: StatQuery, fields: StatFieldId[],
  opts: { now: number; refresh?: boolean; deadline?: number; clock?: () => number }): Promise<StatAnswer> {
  const asked = [...fields].sort();
  const id = "statutory:" + await shortHash(JSON.stringify([q.kind, [...q.codes].sort(), q.fromYear, q.toYear, asked, asked.map((f) => mapping.fields[f] ?? null)]));
  const saved = opts.refresh ? null : await db.getStore(id);
  if (saved) return { ...(saved.doc as unknown as StatResult), fetchedAt: saved.fetched_at, fromStore: true, saved: true };
  if (!sf) throw new SnowflakeError("not_configured", SNOWFLAKE_NOT_CONFIGURED);
  if (!fieldStatus(mapping).some((f) => f.mapped)) throw new SnowflakeError("not_mapped", NOT_MAPPED);
  const result = await runStatutory(sf, database, schema, mapping, q, fields, opts.deadline !== undefined ? { deadline: opts.deadline, now: opts.clock ?? Date.now } : undefined);
  // A result cut short by the time limit isn't saved, so the next try asks Snowflake again.
  const cut = result.fields.some((f) => f.error?.startsWith("Not run:"));
  const wasSaved = cut ? false : await db.putStore({ id, kind: "statutory", label: `${q.kind} ${q.codes.join(",")} ${q.fromYear}-${q.toYear}`, doc: result });
  return { ...result, fetchedAt: new Date(opts.now).toISOString(), fromStore: false, saved: wasSaved };
}

export async function getMapping(db: Db): Promise<Mapping> { return readMapping(await db.getSetting(MAPPING_ID)); }
export const isViewName = ident;
