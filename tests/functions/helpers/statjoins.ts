// A small reader for the statements the statutory mapping makes when a figure is spread over several joined views in
// several schemas, plugged into the fake Snowflake (helpers/snowflake.ts) through its `on` hook. It runs the SQL
// against made-up views held in memory, keyed "SCHEMA.VIEW", using the BOUND values, so a result only comes out
// right when the joins, conditions and bindings all line up. Anything it can't read is answered 422, as Snowflake
// answers SQL it can't compile. It also answers Discover across schemas and the run-date view of each schema.
// Every schema, view, column, company and figure here is made up.

import { ilike, type SfReply, stored } from "./snowflake.ts";

type Value = string | number | null;
type Row = Record<string, Value>;
export type SchemaTables = Record<string, Row[]>;   // "SCHEMA.VIEW" (as stored) -> rows

const NAME = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")`;
const REF = String.raw`(?:"[A-Z0-9_]+"\.)?${NAME}`;
const EXPR = String.raw`(?:(?:YEAR|MONTH)\(${REF}\)|${REF})`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Splits a select list on the commas between expressions, not those inside brackets. */
function splitList(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0 && s[i + 1] === " ") { out.push(cur); cur = ""; i++; continue; }
    cur += ch;
  }
  return [...out, cur];
}
const err = (message: string, code = "001003") => ({ error: { status: 422, code, message, sqlState: "42000" } });

export type JoinOpts = {
  database?: string;
  tables: SchemaTables;
  /** Extra views for Discover (no rows), keyed "SCHEMA.VIEW". */
  views?: string[];
  /** Schemas whose run-date view can't be read (the statement fails). */
  failLoaded?: string[];
};

export function joinReader(o: JoinOpts) {
  const DB = (o.database ?? "MI_XPRESSCLOUD").toUpperCase();
  const schemas = () => [...new Set([...Object.keys(o.tables), ...(o.views ?? [])].map((k) => k.split(".")[0]))].sort();

  return (statement: string, bindings: { type: string; value: string }[]): SfReply | undefined => {
    let m = statement.match(new RegExp(String.raw`^SELECT SCHEMA_NAME, COMMENT FROM (${NAME})\.INFORMATION_SCHEMA\.SCHEMATA WHERE SCHEMA_NAME <> \? ORDER BY SCHEMA_NAME LIMIT (\d+)$`));
    if (m) {
      if (stored(m[1]) !== DB) return err(`Database '${stored(m[1])}' does not exist or not authorized.`, "002003");
      return { columns: ["SCHEMA_NAME", "COMMENT"], rows: ["INFORMATION_SCHEMA", ...schemas()].filter((s) => s !== bindings[0].value).map((s) => [s, s === "ENTITY" ? "Made-up: companies and groups" : null]) };
    }
    m = statement.match(new RegExp(String.raw`^SELECT TABLE_NAME, TABLE_TYPE, COMMENT FROM (${NAME})\.INFORMATION_SCHEMA\.TABLES WHERE TABLE_SCHEMA = \?( AND TABLE_NAME ILIKE \?)? ORDER BY TABLE_NAME LIMIT (\d+)$`));
    if (m) {
      const names = [...new Set([...Object.keys(o.tables), ...(o.views ?? [])])].filter((k) => k.split(".")[0] === bindings[0].value).map((k) => k.split(".")[1]);
      return { columns: ["TABLE_NAME", "TABLE_TYPE", "COMMENT"], rows: names.filter((n) => !m![2] || ilike(n, bindings[1].value)).sort().map((n) => [n, "VIEW", null]) };
    }
    m = statement.match(new RegExp(String.raw`^SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION, COMMENT FROM (${NAME})\.INFORMATION_SCHEMA\.COLUMNS WHERE TABLE_SCHEMA = \? AND TABLE_NAME = \? ORDER BY ORDINAL_POSITION$`));
    if (m) {
      const t = o.tables[`${bindings[0].value}.${bindings[1].value}`];
      const cols = t?.length ? Object.keys(t[0]) : [];
      return { columns: ["COLUMN_NAME", "DATA_TYPE", "ORDINAL_POSITION", "COMMENT"], rows: cols.map((c, i) => [c, typeof t![0][c] === "number" ? "NUMBER" : "TEXT", i + 1, null]) };
    }
    m = statement.match(new RegExp(String.raw`^SELECT MAX\((${NAME})\) AS AT FROM (${NAME})\.(${NAME})\.(${NAME})$`));
    if (m) {
      const key = `${stored(m[3])}.${stored(m[4])}`, t = o.tables[key];
      if (stored(m[2]) !== DB || !t || (o.failLoaded ?? []).includes(stored(m[3]))) return err(`Object '${stored(m[2])}.${key}' does not exist or not authorized.`, "002003");
      if (t.length && !(stored(m[1]) in t[0])) return err(`invalid identifier '${stored(m[1])}'`, "000904");
      const vals = t.map((r) => r[stored(m![1])]).filter((v) => v !== null).map(String).sort();
      return { columns: ["AT"], rows: [[vals.length ? vals[vals.length - 1] : null]] };
    }
    if (/^SELECT .* AS CODE, /.test(statement)) return field(statement, bindings);
    return undefined;
  };

  // ---------- one mapped field ----------
  function field(statement: string, bindings: { type: string; value: string }[]): SfReply {
    const tail = statement.match(/ ORDER BY 1, 3 LIMIT (\d+)$/);
    const iFrom = statement.indexOf(" FROM "), iWhere = statement.indexOf(" WHERE ");
    if (!tail || iFrom < 0 || iWhere < 0) return err("SQL compilation error: syntax error, unexpected statement.");
    const list = statement.slice(7, iFrom), source = statement.slice(iFrom + 6, iWhere);
    let rest = statement.slice(iWhere + 7, statement.length - tail[0].length);
    let qualify = "", group = "";
    const iQ = rest.indexOf(" QUALIFY "); if (iQ >= 0) { qualify = rest.slice(iQ + 9); rest = rest.slice(0, iQ); }
    const iG = rest.indexOf(" GROUP BY "); if (iG >= 0) { group = rest.slice(iG + 10); rest = rest.slice(0, iG); }

    // FROM db.schema.view [AS "A"] [ [LEFT] JOIN db.schema.view AS "B" ON a = b [AND c = d]] ...
    const head = source.match(new RegExp(String.raw`^(${NAME})\.(${NAME})\.(${NAME})(?: AS "([A-Z0-9_]+)")?`));
    if (!head) return err("SQL compilation error: syntax error in FROM.");
    const views: { alias: string; key: string; kind: "inner" | "left"; on: [string, string][] }[] = [];
    const add = (db: string, sc: string, v: string, alias: string | undefined, kind: "inner" | "left", on: [string, string][]): SfReply | null => {
      const key = `${stored(sc)}.${stored(v)}`;
      if (stored(db) !== DB || !o.tables[key]) return err(`SQL compilation error: Object '${stored(db)}.${key}' does not exist or not authorized.`, "002003");
      views.push({ alias: alias ?? "", key, kind, on });
      return null;
    };
    let bad = add(head[1], head[2], head[3], head[4], "inner", []);
    if (bad) return bad;
    let joins = source.slice(head[0].length);
    const J = new RegExp(String.raw`^ (LEFT JOIN|JOIN) (${NAME})\.(${NAME})\.(${NAME}) AS "([A-Z0-9_]+)" ON (${REF} = ${REF}(?: AND ${REF} = ${REF})*)(?= (?:LEFT JOIN|JOIN) |$)`);
    while (joins.length) {
      const j = joins.match(J);
      if (!j) return err("SQL compilation error: syntax error in JOIN.");
      const on = j[6].split(" AND ").map((p) => p.split(" = ") as [string, string]);
      bad = add(j[2], j[3], j[4], j[5], j[1] === "LEFT JOIN" ? "left" : "inner", on);
      if (bad) return bad;
      joins = joins.slice(j[0].length);
    }
    const known = (key: string) => new Set(o.tables[key].flatMap((r) => Object.keys(r)));

    // A column reference: "A".COL, or COL alone when there is exactly one view.
    type Ctx = Record<string, Row | null>;
    const resolve = (ref: string): { alias: string; col: string } | string => {
      const q = ref.match(/^"([A-Z0-9_]+)"\.(.+)$/);
      const alias = q ? q[1] : views.length === 1 ? views[0].alias : null, col = stored(q ? q[2] : ref);
      const v = views.find((x) => x.alias === alias);
      if (alias === null || !v) return `invalid identifier '${ref}'`;
      return known(v.key).has(col) ? { alias, col } : `invalid identifier '${col}'`;
    };
    const problems: string[] = [];
    const ev = (expr: string, ctx: Ctx): Value => {
      if (expr === "NULL") return null;
      // value plus other columns: CASE WHEN a IS NULL AND b IS NULL THEN NULL ELSE COALESCE(a, 0) + COALESCE(b, 0) END
      const sumOf = expr.match(/^CASE WHEN (.+) THEN NULL ELSE (.+) END$/);
      if (sumOf) {
        const whens = sumOf[1].split(" AND ").map((x) => x.match(/^(.+) IS NULL$/)), terms = sumOf[2].split(" + ").map((x) => x.match(/^COALESCE\((.+), 0\)$/));
        if (whens.some((x) => !x) || terms.some((x) => !x) || !same(whens.map((x) => x![1]), terms.map((x) => x![1]))) { problems.push("syntax error in CASE"); return null; }
        const vals = terms.map((x) => ev(x![1], ctx));
        return vals.every((v) => v === null) ? null : vals.reduce((a: number, v) => a + (v === null ? 0 : Number(v)), 0);
      }
      const fn = expr.match(/^(YEAR|MONTH|SUM)\((.+)\)$/);
      if (fn) {
        const v = ev(fn[2], ctx);
        if (v === null || fn[1] === "SUM") return v;
        return fn[1] === "YEAR" ? Number(String(v).slice(0, 4)) : Number(String(v).slice(5, 7));
      }
      const r = resolve(expr);
      if (typeof r === "string") { problems.push(r); return null; }
      const row = ctx[r.alias];
      return row ? row[r.col] ?? null : null;
    };

    // the joined rows
    let ctxs: Ctx[] = o.tables[views[0].key].map((r) => ({ [views[0].alias]: r }));
    for (const v of views.slice(1)) {
      const next: Ctx[] = [];
      for (const c of ctxs) {
        const hits = o.tables[v.key].filter((r) => v.on.every(([a, b]) => { const x = ev(a, { ...c, [v.alias]: r }), y = ev(b, { ...c, [v.alias]: r }); return x !== null && y !== null && String(x) === String(y); }));
        if (hits.length) for (const r of hits) next.push({ ...c, [v.alias]: r });
        else if (v.kind === "left") next.push({ ...c, [v.alias]: null });
      }
      ctxs = next;
    }

    // WHERE, read one condition at a time, taking the bindings in order
    let b = 0;
    const conds: ((c: Ctx) => boolean)[] = [];
    while (rest.length) {
      let c: RegExpMatchArray | null;
      if ((c = rest.match(new RegExp(String.raw`^(${EXPR}) IN \(([?, ]+)\)`)))) { const e = c[1], vals = bindings.slice(b, b += (c[2].match(/\?/g) ?? []).length).map((x) => x.value); conds.push((x) => { const v = ev(e, x); return v !== null && vals.includes(String(v).trim()); }); }
      else if ((c = rest.match(new RegExp(String.raw`^(${EXPR}) BETWEEN \? AND \?`)))) { const e = c[1], lo = Number(bindings[b++].value), hi = Number(bindings[b++].value); conds.push((x) => { const v = ev(e, x); return v !== null && Number(v) >= lo && Number(v) <= hi; }); }
      else if ((c = rest.match(new RegExp(String.raw`^(${EXPR}) (=|<>) \?`)))) { const e = c[1], op = c[2], want = bindings[b++].value; conds.push((x) => { const v = ev(e, x); return v !== null && (op === "=" ? String(v) === want : String(v) !== want); }); }
      else if ((c = rest.match(new RegExp(String.raw`^STARTSWITH\((${REF}), \?\)`)))) { const e = c[1], pre = bindings[b++].value; conds.push((x) => { const v = ev(e, x); return v !== null && String(v).startsWith(pre); }); }
      else if ((c = rest.match(new RegExp(String.raw`^(${EXPR}) IS (NOT )?NULL`)))) { const e = c[1], not = !!c[2]; conds.push((x) => (ev(e, x) === null) !== not); }
      else return err(`SQL compilation error: syntax error near '${rest.slice(0, 30)}'.`);
      rest = rest.slice(c[0].length);
      if (rest.startsWith(" AND ")) rest = rest.slice(5);
      else if (rest.length) return err("SQL compilation error: syntax error in WHERE.");
    }
    if (b !== bindings.length) return err(`Bind variable count mismatch (${b} used, ${bindings.length} bound).`, "002049");

    const exprs = splitList(list).map((e) => e.match(/^(.+) AS ([A-Z]+)$/));
    if (exprs.some((e) => !e)) return err("SQL compilation error: syntax error in the select list.");
    // check every name once, against the first row's shape, so a wrong column is a 422 even with no rows
    const probe: Ctx = Object.fromEntries(views.map((v) => [v.alias, o.tables[v.key][0] ?? {}]));
    for (const e of exprs) ev(e![1], probe);
    let kept = ctxs.filter((x) => conds.every((f) => f(x)));
    if (problems.length) return err(`SQL compilation error: ${problems[0]}`, "000904");

    // GROUP BY 1, 2, 3, 4, 5[, 7][, "A".SEQ]: VAL summed, nulls skipped
    type Out = { vals: Value[]; ctx: Ctx };
    let out: Out[] = kept.map((ctx) => ({ vals: exprs.map((e) => ev(e![1], ctx)), ctx }));
    const valAt = exprs.findIndex((e) => e![2] === "VAL");
    if (group) {
      const parts = group.split(", ");
      const by = (x: Out) => JSON.stringify(parts.map((p) => /^\d+$/.test(p) ? x.vals[Number(p) - 1] : ev(p, x.ctx)));
      if (parts.some((p) => /^\d+$/.test(p) && Number(p) - 1 === valAt)) return err("SQL compilation error: aggregate in GROUP BY.");
      const groups = new Map<string, Out>();
      for (const x of out) {
        const k = by(x), g = groups.get(k), v = x.vals[valAt];
        if (!g) groups.set(k, { vals: [...x.vals], ctx: x.ctx });
        else if (v !== null) g.vals[valAt] = (g.vals[valAt] === null ? 0 : Number(g.vals[valAt])) + Number(v);
      }
      out = [...groups.values()];
    }
    // QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY x DESC) = 1
    if (qualify) {
      const q = qualify.match(/^ROW_NUMBER\(\) OVER \(PARTITION BY (.+) ORDER BY (.+) DESC\) = 1$/);
      if (!q) return err("SQL compilation error: syntax error in QUALIFY.");
      const best = new Map<string, Out>();
      for (const x of out) {
        const k = JSON.stringify(q[1].split(", ").map((p) => ev(p, x.ctx))), cur = best.get(k);
        if (!cur || Number(ev(q[2], x.ctx)) > Number(ev(q[2], cur.ctx))) best.set(k, x);
      }
      out = [...best.values()];
    }
    const rows = out.map((x) => x.vals);
    rows.sort((a, z) => (String(a[0]) < String(z[0]) ? -1 : String(a[0]) > String(z[0]) ? 1 : 0) || Number(a[2]) - Number(z[2]));
    return { columns: exprs.map((e) => e![2]), rows: rows.slice(0, Number(tail[1])) };
  }
}
