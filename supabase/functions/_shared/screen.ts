// The Screener: finds the companies that fit a description across every statutory filer, from a plain form, in one
// Snowflake statement (buildScreenSql in statutory.ts). Corp Dev only, checked by the statutory function.
//
// Nothing about a screen is kept: not the request, not the result, not in the database, the statutory store, the
// settings or a log line. The log says only that a screen ran, how many filters it had, how long it took and how many
// rows came back. The criteria say what the organisation is looking for.
//
// The request is small plain JSON, so a later Ask Claude tool can fill it in (see parseScreen):
//   {year?, states?: ["FL"], lines?: ["Homeowners"], filters?: [{field, min?, max?}], growth?: {years: 1|3|5, min?, max?},
//    group?: "any"|"in"|"none", sort?: {by, dir?: "asc"|"desc"}, limit?}
// Dollar bounds are in $M; ratio bounds, focus and growth are in percent.

import { type Binding, type Snowflake, SnowflakeError } from "./snowflake.ts";
import { buildLinesSql, buildScreenSql, companiesMapped, type Mapping, premiumFigure, SCREEN_FIGURES, SCREEN_MAX_LIMIT, type ScreenField, type ScreenRequest, screenFigureProblem, STAT_FIELDS, type StatFieldId } from "./statutory.ts";

export const SCREEN_MAX_STATES = 10, SCREEN_MAX_LINES = 10, SCREEN_MAX_FILTERS = 8, SCREEN_DEFAULT_LIMIT = 100;
/** The longest a screen waits for Snowflake: the statutory function must answer inside Supabase's 150 seconds, and the
    SQL API's own statement timeout is capped at 90 seconds (snowflake.ts), so 100 seconds of waiting leaves room for
    signing in and answering. A live screen of one state and one line took about 25 seconds. */
export const SCREEN_WAIT_MS = 100_000;
export const SCREEN_TIMEOUT = "The screen didn't finish in time. Narrow it (add a state or a line) and run it again.";
/** A figure whose rows disagree for more than this share of the companies with premium in view (and more than
    SCREEN_ODD_FLOOR companies) points to a mapping fault, and the screen is refused; below it, those companies are
    left out (premium) or shown n/d (a yearly figure), and a note says how many. */
export const SCREEN_ODD_SHARE = 0.05, SCREEN_ODD_FLOOR = 10;
export const SCREEN_ONLY_CORPDEV = "Only Corp Dev logins can run the Screener.";
const SORTS = ["premium", "focus", "growth", "name", "code", ...SCREEN_FIGURES];
const FIELDS: ScreenField[] = ["premium", "focus", ...SCREEN_FIGURES];
const label = (id: string) => id === "premium" ? "Premium in view" : id === "focus" ? "Focus" : id === "growth" ? "Growth" : STAT_FIELDS.find((f) => f.id === id)?.label ?? id;

/** A plain message for anything a screen can't use. */
export class ScreenError extends Error {
  constructor(public code: "fans_out" | "not_mapped" | "group" | "sql", message: string, public figure?: string) { super(message); }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const extraKey = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).find((k) => !keys.includes(k));
const bound = (v: unknown): number | null | undefined => (v === undefined || v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Checks a screen. Every bad input is refused with a plain message; nothing is silently dropped. */
export function parseScreen(b: Record<string, unknown>, thisYear: number): { ok: true; r: ScreenRequest } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  const extra = extraKey(b, ["action", "year", "states", "lines", "filters", "growth", "group", "sort", "limit"]);
  if (extra) return bad(`A screen doesn't take "${extra.slice(0, 40)}". It takes year, states, lines, filters, growth, group, sort and limit.`);
  const year = b.year === undefined ? thisYear - 1 : b.year;
  if (!Number.isInteger(year) || (year as number) < 1990 || (year as number) > thisYear) return bad(`The year must be a whole year from 1990 to ${thisYear}.`);
  const y = year as number;

  const list = (v: unknown, what: string, max: number) => v === undefined ? [] : Array.isArray(v) && v.length <= max ? v : null;
  const rawStates = list(b.states, "states", SCREEN_MAX_STATES);
  if (!rawStates) return bad(`Choose at most ${SCREEN_MAX_STATES} states, as a list of two-letter codes like FL.`);
  const states = rawStates.map((s) => (typeof s === "string" ? s.trim().toUpperCase() : ""));
  if (states.some((s) => !/^[A-Z]{2}$/.test(s))) return bad("States are two-letter codes, like FL.");
  const rawLines = list(b.lines, "lines", SCREEN_MAX_LINES);
  if (!rawLines) return bad(`Choose at most ${SCREEN_MAX_LINES} lines, as a list of line names.`);
  const lines = rawLines.map((l) => (typeof l === "string" ? l.trim() : ""));
  if (lines.some((l) => !l || l.length > 120 || /[\u0000-\u001f\u007f]/.test(l))) return bad("Lines are line names as S&P gives them, each up to 120 characters.");

  if (b.filters !== undefined && !(Array.isArray(b.filters) && b.filters.length <= SCREEN_MAX_FILTERS)) return bad(`Give at most ${SCREEN_MAX_FILTERS} filters, as a list.`);
  const filters: ScreenRequest["filters"] = [];
  for (const f of (b.filters ?? []) as unknown[]) {
    if (!isObj(f) || extraKey(f, ["field", "min", "max"])) return bad("Each filter is {field, min, max}.");
    const field = f.field as ScreenField;
    if (!FIELDS.includes(field)) return bad(`A filter's figure must be one of: ${FIELDS.join(", ")}.`);
    if (filters.some((x) => x.field === field)) return bad(`${label(field)} is filtered twice. Give it one filter, with a min, a max or both.`);
    const min = bound(f.min), max = bound(f.max);
    if (min === undefined || max === undefined) return bad(`${label(field)}: min and max must be numbers.`);
    if (min === null && max === null) return bad(`${label(field)}: give a min, a max or both.`);
    if (min !== null && max !== null && min > max) return bad(`${label(field)}: the min is above the max.`);
    filters.push({ field, min, max });
  }

  let growth: ScreenRequest["growth"] = null;
  if (b.growth !== undefined && b.growth !== null) {
    const g = b.growth;
    if (!isObj(g) || extraKey(g, ["years", "min", "max"])) return bad("Growth is {years, min, max}.");
    if (g.years !== 1 && g.years !== 3 && g.years !== 5) return bad("Growth is over 1, 3 or 5 years.");
    const min = bound(g.min), max = bound(g.max);
    if (min === undefined || max === undefined) return bad("Growth: min and max must be numbers (percent).");
    if (min === null && max === null) return bad("Growth: give a min, a max or both (percent).");
    if (min !== null && max !== null && min > max) return bad("Growth: the min is above the max.");
    if (y - g.years < 1990) return bad("Growth would reach back before 1990. Choose a later year or fewer years.");
    growth = { years: g.years, min, max };
  }

  const group = b.group === undefined ? "any" : b.group;
  if (group !== "any" && group !== "in" && group !== "none") return bad('group must be "any", "in" (in a NAIC group) or "none" (not in a group).');

  let sort: ScreenRequest["sort"] = { by: "premium", dir: "desc" };
  if (b.sort !== undefined) {
    const s = b.sort;
    if (!isObj(s) || extraKey(s, ["by", "dir"])) return bad("sort is {by, dir}.");
    if (typeof s.by !== "string" || !SORTS.includes(s.by)) return bad(`sort.by must be one of: ${SORTS.join(", ")}.`);
    if (s.by === "growth" && !growth) return bad("The screen can only sort by growth when it has a growth filter.");
    if (s.dir !== undefined && s.dir !== "asc" && s.dir !== "desc") return bad('sort.dir must be "asc" or "desc".');
    sort = { by: s.by, dir: (s.dir as "asc" | "desc" | undefined) ?? "desc" };
  }
  const limit = b.limit === undefined ? SCREEN_DEFAULT_LIMIT : b.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > SCREEN_MAX_LIMIT) return bad(`limit must be a whole number from 1 to ${SCREEN_MAX_LIMIT}.`);
  return { ok: true, r: { year: y, states: [...new Set(states)], lines: [...new Set(lines)], filters, growth, group, sort, limit: limit as number } };
}

/** What the page needs to know before a screen: which premium figures and which figures can be used, and whether
    the group choice can be offered. Part of the status answer. */
export function screenStatus(mapping: Mapping) {
  const can = (id: StatFieldId) => screenFigureProblem(id, mapping.fields[id])?.problem ?? null;
  return {
    premium: { dpw_by_line: can("dpw_by_line"), dpw_by_state: can("dpw_by_state"), dpw_by_state_line: can("dpw_by_state_line") },
    figures: Object.fromEntries(SCREEN_FIGURES.map((id) => [id, can(id)])),
    group: companiesMapped(mapping) && mapping.companies!.groupCode !== undefined,
  };
}

export type ScreenRow = { code: string; name: string | null; groupCode?: string | null; groupName?: string | null; [k: string]: string | number | null | undefined };
const num = (v: unknown) => { const n = v === null || v === undefined || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
const txt = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);

/** Runs a checked screen: ONE statement, waiting up to SCREEN_WAIT_MS. A screen that doesn't finish is a
    SnowflakeError "timeout" (never a partial list); one whose figures don't reduce to one a company is a ScreenError. */
export async function runScreen(sf: Snowflake, database: string, schema: string, mapping: Mapping, r: ScreenRequest, opts: { now: () => number; waitMs?: number; log?: (s: string) => void }) {
  const built = buildScreenSql(database, schema, mapping, r);
  if ("problem" in built) throw new ScreenError(built.code, built.problem, built.figure);
  const started = opts.now();
  const res = await sf.query(built.statement, built.bindings as Binding[], opts.waitMs ?? SCREEN_WAIT_MS);
  const head = res.rows[0] ?? {};
  const inView = num(head.IN_VIEW) ?? 0, limitOdd = Math.max(SCREEN_ODD_FLOOR, SCREEN_ODD_SHARE * inView);
  const key = built.premium === "dpw_by_line" ? "line" : built.premium === "dpw_by_state" ? "state" : "state and line";
  const odd: { premium: number; figures: Record<string, number> } = { premium: 0, figures: {} };
  const oddNotes: string[] = [];
  const many = (n: number) => `${n} ${n === 1 ? "company" : "companies"}`, them = (n: number) => (n === 1 ? "it" : "them");
  for (const c of built.checks) {
    const n = num(head[c.col]) ?? 0;
    if (!n) continue;
    const prem = c.col === "ODD_P";
    if (n > limitOdd) {
      throw new ScreenError("fans_out", `${label(c.id)} can't be screened as it is mapped: S&P's rows give ${many(n)} of the ${inView} with premium in view more than one ${prem ? `premium figure for the same ${key}` : "figure"} in ${r.year}. So many points to a fault in its mapping. Check it in Field set-up: it needs one figure for each company a year${prem ? `, ${key}` : ""}.`, c.id);
    }
    if (prem) { odd.premium = n; oddNotes.push(`${many(n)} ${n === 1 ? "was" : "were"} left out: S&P's rows give ${them(n)} two premium figures for the same ${key} in ${r.year}.`); }
    else { odd.figures[c.id] = n; oddNotes.push(`${label(c.id)} is n/d for ${many(n)}: S&P's rows give ${them(n)} two figures for ${r.year}.`); }
  }
  const rows: ScreenRow[] = res.rows.filter((x) => txt(x.CODE) !== null).map((x) => {
    const row: ScreenRow = { code: txt(x.CODE)!.replace(/\.0+$/, ""), name: txt(x.NAME) };
    for (const c of built.columns) { const v = num(x[c.col]); row[c.id] = v === null ? null : Math.round(v * c.scale * 1e6) / 1e6; }
    if (built.group) { row.groupCode = txt(x.GROUP_CODE)?.replace(/\.0+$/, "") ?? null; row.groupName = txt(x.GROUP_NAME); }
    return row;
  });
  const total = num(head.TOTAL) ?? rows.length;
  (opts.log ?? console.log)(`snl-statutory: a screen ran (${r.filters.length} filter${r.filters.length === 1 ? "" : "s"}, ${opts.now() - started} ms, ${rows.length} row${rows.length === 1 ? "" : "s"})`);
  const notes = [
    built.premium === "dpw_by_line" && !r.lines.length ? "Premium in view is all direct premiums written: the total of premiums by line." : "",
    built.premium === "dpw_by_state" && !r.states.length ? "Premium in view is all direct premiums written: the total of premiums by state (premiums by line aren't mapped)." : "",
    built.totalFrom === null ? "Focus is 100% for every company: with no state or line chosen, premium in view is all the company's direct premiums written."
      : `Focus is premium in view as a share of the company's total direct premiums written in ${r.year}, from ${built.totalFrom === "dpw_by_line" ? "premiums by line over every line" : built.totalFrom === "dpw_by_state" ? "premiums by state over every state" : "premiums by state and line over every state and line"}.`,
    r.growth ? `Growth compares premium in view in ${r.year} with ${r.year - r.growth.years}. A company with nothing in ${r.year - r.growth.years} has no growth figure and doesn't pass the growth filter.` : "",
    r.group !== "any" ? "A company the company look-up doesn't list is left out by the group choice." : "",
    ...oddNotes,
    ...built.left.map((l) => `${label(l.id)} isn't shown: ${l.why}`),
  ].filter(Boolean);
  return {
    year: r.year, premium: { figure: built.premium, states: r.states, lines: r.lines }, growth: r.growth, group: r.group, groupMapped: built.group,
    columns: built.columns.map(({ id, label, unit }) => ({ id, label, unit })), rows, total, limit: r.limit, cut: total > rows.length, sort: r.sort, notes, odd,
    source: "S&P Global Market Intelligence, SNL Insurance Regulatory Data (Snowflake)", fetchedAt: new Date(opts.now()).toISOString(),
  };
}

/** The line names of premiums by line for one year, for the line picker. One statement; not saved. */
export async function screenLines(sf: Snowflake, database: string, schema: string, mapping: Mapping, year: number) {
  const p = screenFigureProblem("dpw_by_line", mapping.fields.dpw_by_line);
  if (p) throw new ScreenError(p.code, p.problem, "dpw_by_line");
  const sql = buildLinesSql(database, schema, mapping, year);
  if (!sql) throw new ScreenError("sql", "SNOWFLAKE_DATABASE or SNOWFLAKE_SCHEMA isn't a valid name. Check those two secrets on Supabase.");
  const res = await sf.query(sql.statement, sql.bindings, 45_000);
  const lines = res.rows.map((x) => txt(x.LINE)).filter((x): x is string => !!x);
  return { year, lines, cut: lines.length >= 1000 };
}

export { premiumFigure };
