// Reading a company list (a CSV exported from S&P Capital IQ Pro or similar) and turning it into the rows the
// app's company directory holds. Kept apart from companies.mjs so it can be tested without a Supabase project.
//
// The column names in an S&P export are not something this project can confirm, so nothing is assumed: the
// headings are matched against the likely names below, `check` shows what was matched, and any column can be
// named outright with a flag (for example --company-id "My heading").

/** Splits delimited text into rows of cells. Handles quoted cells, doubled quotes, commas and line breaks inside
    quotes, Windows line endings and a leading byte-order mark. The delimiter is a comma, tab or semicolon,
    whichever the first lines use most. */
export function parseDelimited(text) {
  return parseAll(text).filter((r) => r.some((c) => c !== ""));
}

/** The same, with blank lines kept, so a row's number matches the line in the file. */
function parseAll(text) {
  const src = text.replace(/^﻿/, "");
  const head = src.split(/\r?\n/).slice(0, 20).join("\n");
  const count = (ch) => head.split(ch).length - 1;
  const delimiter = count("\t") > count(",") && count("\t") >= count(";") ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

export const FIELDS = ["companyName", "companyId", "institutionId", "naicCompanyCode", "naicGroupCode", "naicGroupName", "spStatEntityId"];
export const FLAGS = { "--name": "companyName", "--company-id": "companyId", "--institution-id": "institutionId", "--naic": "naicCompanyCode", "--group-code": "naicGroupCode", "--group-name": "naicGroupName", "--stat-id": "spStatEntityId" };

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Likely headings for each field, most specific first. A heading matches when it equals one of these or, for
// the longer ones, contains it. Group columns are matched before the company's own, so "Group name" is never
// taken for the company name.
const LIKELY = {
  naicGroupName: ["naicgroupname", "groupname", "group"],
  naicGroupCode: ["naicgroupcode", "naicgroupnumber", "naicgroup", "groupcode", "groupnumber"],
  spStatEntityId: ["spstatentityid", "statentityid", "statutoryentityid", "spstatutoryentitykey", "statutoryentitykey", "snlstatentitykey", "statentitykey"],
  institutionId: ["snlinstitutionkey", "spinstitutionkey", "institutionkey", "spinstitutionid", "institutionid", "keyinstn", "mikey", "snlkey"],
  companyId: ["spcapitaliqid", "capitaliqcompanyid", "capitaliqid", "ciqcompanyid", "spcompanyid", "companyid", "ciqid", "iqid"],
  naicCompanyCode: ["naiccompanycode", "naiccompanynumber", "naiccocode", "naiccode", "naicnumber", "cocode", "naic"],
  companyName: ["companyname", "entityname", "institutionname", "legalname", "company", "entity", "name"],
};
const ORDER = ["naicGroupName", "naicGroupCode", "spStatEntityId", "institutionId", "companyId", "naicCompanyCode", "companyName"];

/** Which column holds each field, from the headings. `named` is {field: heading} from the flags and wins. */
export function matchColumns(headings, named = {}) {
  const keys = headings.map(norm), taken = new Set(), cols = {}, problems = [];
  for (const [field, heading] of Object.entries(named)) {
    const at = keys.indexOf(norm(heading));
    if (at < 0) problems.push(`There is no column headed "${heading}".`);
    else { cols[field] = at; taken.add(at); }
  }
  for (const field of ORDER) {
    if (field in cols) continue;
    let at = -1;
    for (const want of LIKELY[field]) { at = keys.findIndex((k, i) => !taken.has(i) && k === want); if (at >= 0) break; }
    if (at < 0) for (const want of LIKELY[field].filter((w) => w.length >= 8)) { at = keys.findIndex((k, i) => !taken.has(i) && k.includes(want)); if (at >= 0) break; }
    if (at >= 0) { cols[field] = at; taken.add(at); }
  }
  return { cols, problems };
}

/** The heading row: the first of the first 40 rows that has a company name column and an id or NAIC code column. Exports
    often start with a title and a date before the headings. */
export function findHeadingRow(rows, named = {}) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const { cols, problems } = matchColumns(rows[i], named);
    if (!problems.length && "companyName" in cols && ("companyId" in cols || "institutionId" in cols || "naicCompanyCode" in cols)) return { at: i, cols };
  }
  return null;
}

/** A whole-number id as text. Takes "IQ4973721", "4,973,721" and "4973721.0" as 4973721; anything else is null. */
export function cleanId(v) {
  const s = String(v ?? "").trim().replace(/^IQ/i, "").replace(/[,\s]/g, "").replace(/\.0+$/, "");
  return /^\d{1,12}$/.test(s) && Number(s) > 0 ? String(Number(s)) : null;
}
const cleanCode = (v) => { const s = String(v ?? "").trim().replace(/\.0+$/, ""); return /^\d{1,6}$/.test(s) ? s : null; };
const cleanText = (v, max) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s && !/^(n\/?a|na|null|none|-+)$/i.test(s) ? s.slice(0, max) : null; };

// The same key and label the functions use (supabase/functions/_shared/db.ts: entityKey, entityLabel). A company
// with neither S&P id but a NAIC company code is saved under "n." and the code: the Statutory view can use it,
// a filing search can't.
const isNaicCode = (v) => typeof v === "string" && /^[0-9]{1,6}$/.test(v);
export const canSearchFilings = (e) => !!(e.companyId || e.institutionId);
export const entityKey = (e) => (e.companyId ? String(e.companyId) : e.institutionId ? `i.${e.institutionId}` : isNaicCode(e.naicCompanyCode) ? `n.${e.naicCompanyCode}` : null);
export const entityLabel = (e) => [e.companyName, e.naicCompanyCode ? `NAIC ${e.naicCompanyCode}` : "", e.naicGroupName ?? ""].filter(Boolean).join(" | ").slice(0, 400);

/** Reads a list. Returns the companies to load and a plain account of what was found and what was left out. */
export function readCompanies(text, named = {}) {
  const rows = parseAll(text);
  const heading = findHeadingRow(rows, named);
  if (!heading) {
    const first = rows.find((r) => r.some((c) => c !== "")) ?? [];
    const { problems } = matchColumns(first, named);
    return { ok: false, headings: first, message: problems[0] ?? "Couldn't find the heading row. The list needs a company name column and an S&P company id, institution id or NAIC company code column. Name them with flags, for example: --name \"Company\" --company-id \"S&P ID\" --naic \"NAIC code\"." };
  }
  const headings = rows[heading.at], cols = heading.cols;
  const cell = (r, field) => (field in cols ? r[cols[field]] : undefined);
  const byKey = new Map();
  const skipped = { noName: 0, noId: 0 };
  let duplicates = 0;
  for (const r of rows.slice(heading.at + 1)) {
    if (!r.some((c) => c !== "")) continue;
    const companyName = cleanText(cell(r, "companyName"), 200);
    const e = {
      companyId: cleanId(cell(r, "companyId")), companyName, naicCompanyCode: cleanCode(cell(r, "naicCompanyCode")),
      institutionId: cleanId(cell(r, "institutionId")), spStatEntityId: cleanText(cell(r, "spStatEntityId"), 20),
      naicGroupCode: cleanCode(cell(r, "naicGroupCode")), naicGroupName: cleanText(cell(r, "naicGroupName"), 200),
    };
    if (!companyName) { skipped.noName++; continue; }
    const key = entityKey(e);
    if (!key) { skipped.noId++; continue; }
    if (byKey.has(key)) duplicates++;
    byKey.set(key, e);
  }
  // A row with only a NAIC code for a company another row lists with an S&P id is the same company: keep the one
  // with the id, which serves both filings and statutory figures.
  const naicWithId = new Set([...byKey.values()].filter((c) => canSearchFilings(c) && c.naicCompanyCode).map((c) => c.naicCompanyCode));
  for (const [key, c] of byKey) if (!canSearchFilings(c) && naicWithId.has(c.naicCompanyCode)) { byKey.delete(key); duplicates++; }
  const companies = [...byKey.values()];
  return {
    ok: true, companies, headingRow: heading.at + 1, skipped, duplicates,
    columns: Object.fromEntries(FIELDS.map((f) => [f, f in cols ? headings[cols[f]] : null])),
    unused: headings.filter((_, i) => !Object.values(cols).includes(i) && headings[i] !== ""),
    counts: {
      withCompanyId: companies.filter((c) => c.companyId).length, institutionOnly: companies.filter((c) => !c.companyId && c.institutionId).length,
      naicOnly: companies.filter((c) => !canSearchFilings(c)).length, withNaic:companies.filter((c) => c.naicCompanyCode).length, withGroup: companies.filter((c) => c.naicGroupName).length,
    },
  };
}

/** The rows as the snl_store table holds them (migration 0001), in batches the database takes comfortably. */
export function toStoreRows(companies, fetchedAt) {
  return companies.map((e) => ({ id: `entity:${entityKey(e)}`, kind: "entity", label: entityLabel(e), doc: e, fetched_at: fetchedAt }));
}
export function batches(items, size = 500) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What `check` and `load` print about a list that was read. */
export function describe(r) {
  const n = (x) => x.toLocaleString("en-US");
  const label = { companyName: "Company name", companyId: "S&P company id", institutionId: "S&P institution id", naicCompanyCode: "NAIC company code", naicGroupCode: "NAIC group code", naicGroupName: "Group name", spStatEntityId: "S&P statutory entity id" };
  const lines = [`Headings found on row ${r.headingRow}.`, "", "Columns used:"];
  for (const f of FIELDS) lines.push(`  ${label[f].padEnd(24)} ${r.columns[f] ? `"${r.columns[f]}"` : "not in this list"}`);
  if (r.unused.length) lines.push("", `Columns not used: ${r.unused.map((h) => `"${h}"`).join(", ")}`);
  lines.push("", `${n(r.companies.length)} companies to load:`,
    `  ${n(r.counts.withCompanyId + r.counts.institutionOnly)} can be used to search filings:`,
    `    ${n(r.counts.withCompanyId)} with an S&P company id`,
    `    ${n(r.counts.institutionOnly)} with an institution id only`,
    `  ${n(r.counts.naicOnly)} for statutory figures only: a NAIC company code but no S&P id, so their filings can't be searched`,
    `  ${n(r.counts.withNaic)} with a NAIC company code, so their statutory figures can be found by name`,
    `  ${n(r.counts.withGroup)} with a group name`);
  // A company with a statutory key lands on the row already saved with the same key (and its S&P ids) on load.
  const withStatKey = r.companies.filter((c) => c.spStatEntityId).length;
  if (withStatKey) lines.push(`  ${n(withStatKey)} with an S&P statutory entity key: loading merges each into a company already in the directory with the same key, which keeps its S&P ids`);
  if (r.skipped.noId) lines.push(`${n(r.skipped.noId)} rows left out: no S&P company id, institution id or NAIC company code, so the app couldn't use them.`);
  if (r.skipped.noName) lines.push(`${n(r.skipped.noName)} rows left out: no company name.`);
  if (r.duplicates) lines.push(`${n(r.duplicates)} rows repeated a company already in the list; the last one was kept.`);
  if (r.companies.length) {
    lines.push("", "First three, as they will be saved:");
    for (const c of r.companies.slice(0, 3)) lines.push(`  ${entityLabel(c)}  [${c.companyId ? `company id ${c.companyId}` : c.institutionId ? `institution id ${c.institutionId}` : "NAIC code only: statutory figures, no filings"}]`);
  }
  return lines.join("\n");
}

// ---------- one company, one row ----------
// The same merge the functions make when they save companies from search results (supabase/functions/_shared/db.ts:
// sameCompany, mergeEntity, planEntityWrites), so a list loaded after search results, or loaded again, lands on the
// row already there instead of making a second row for the same company. Kept in step by a test.

// The S&P statutory entity key decides too (compared without regard to letter case), as in db.ts.
const ID_FIELDS = ["companyId", "institutionId", "naicCompanyCode", "spStatEntityId"];
const FIELD_ORDER = ["companyId", "companyName", "naicCompanyCode", "institutionId", "spStatEntityId", "naicGroupCode", "naicGroupName"];
const filled = (v) => (v === null || v === undefined || typeof v === "object" || typeof v === "boolean" ? null : String(v).trim() || null);
const idOf = (e, k) => { const v = filled(e?.[k]); return v && k === "spStatEntityId" ? v.toUpperCase() : v; };
const clash = (a, b) => ID_FIELDS.some((k) => { const x = idOf(a, k), y = idOf(b, k); return !!x && !!y && x !== y; });

/** Whether two rows are the same company: they share a company id, an institution id, a NAIC company code or an S&P
    statutory entity key, and no id that both have differs. */
export function sameCompany(a, b) {
  if (!a || !b) return false;
  let shared = false;
  for (const k of ID_FIELDS) { const x = idOf(a, k), y = idOf(b, k); if (x && y) { if (x !== y) return false; shared = true; } }
  return shared;
}

/** One row from two rows of the same company: newer's filled-in values win, older's fill the gaps; keepGroup keeps
    older's group code and name. */
export function mergeEntity(older, newer, opts = {}) {
  const pick = (k, first, second) => (filled(first?.[k]) ? String(first[k]).trim() : filled(second?.[k]) ? String(second[k]).trim() : null);
  const out = {};
  for (const k of FIELD_ORDER) out[k] = pick(k, newer, older);
  if (opts.keepGroup) for (const k of ["naicGroupCode", "naicGroupName"]) out[k] = pick(k, older, newer);
  out.companyName = out.companyName ?? "";
  return out;
}

const fullness = (e) => FIELD_ORDER.filter((k) => filled(e[k])).length + (filled(e.companyId) ? 10 : 0);
const mergeGroup = (g) => { const [lead, ...rest] = [...g].sort((a, b) => fullness(b) - fullness(a)); return rest.reduce((acc, e) => mergeEntity(e, acc), mergeEntity(lead, lead)); };
const homeRank = (id) => (id.startsWith("entity:i.") ? 0 : /^entity:\d/.test(id) ? 1 : id.startsWith("entity:n.") ? 2 : 3);

/** Rows grouped by company, in the order each company first appears (rows: {id, doc}). */
function companyGroups(rows) {
  const groups = [], byId = new Map();
  const keys = (r) => ID_FIELDS.map((k) => (idOf(r.doc, k) ? `${k}:${idOf(r.doc, k)}` : null)).filter(Boolean);
  const fits = (a, b) => a.every((x) => b.every((y) => !clash(x.doc, y.doc)));
  for (const r of rows) {
    const linked = [...new Set(keys(r).map((k) => byId.get(k)).filter(Boolean))].filter((g) => fits(g.rows, [r])).sort((a, b) => a.at - b.at);
    let home = linked[0];
    if (home) home.rows.push(r); else groups.push(home = { at: groups.length, rows: [r] });
    for (const g of linked.slice(1)) if (fits(home.rows, g.rows)) { home.rows.push(...g.rows); g.rows = []; }
    for (const x of home.rows) for (const k of keys(x)) { const g = byId.get(k); if (!g || !g.rows.length) byId.set(k, home); }
  }
  return groups.filter((g) => g.rows.length).map((g) => g.rows);
}

/** The ids to look for saved rows of the same companies by: digits only, statutory entity keys letters and digits. */
export function entityIdsOf(list) {
  const pick = (k, re) => [...new Set(list.map((e) => filled(e?.[k])).filter((v) => v && re.test(v)))];
  return { companyId: pick("companyId", /^\d{1,12}$/), institutionId: pick("institutionId", /^\d{1,12}$/), naicCompanyCode: pick("naicCompanyCode", /^\d{1,6}$/), spStatEntityId: [...new Set(pick("spStatEntityId", /^[A-Za-z0-9]{1,20}$/).flatMap((v) => [v, v.toUpperCase(), v.toLowerCase()]))] };
}

/** What loading companies does to the rows already saved (existing: [{id, doc}] that may be the same companies):
    each company is merged into the row already there for it, or gets a new row; any other row of that company is
    merged in and removed. fromList (the default here): the list's group name wins over one already saved.
    merged: how many companies landed on a row that was already there. */
export function planEntityWrites(existing, incoming, opts = { fromList: true }) {
  let saved = existing.filter((r) => r && typeof r.id === "string" && r.doc && typeof r.doc === "object");
  const rows = new Map(), drop = new Set();
  let merged = 0;
  const own = companyGroups(incoming.filter((e) => e && entityKey(e)).map((doc, i) => ({ id: `#${i}`, doc }))).map((g) => (g.length === 1 ? g[0].doc : mergeGroup(g.map((r) => r.doc))));
  for (const e of own) {
    const same = [], order = [...saved].sort((a, b) => homeRank(a.id) - homeRank(b.id) || a.id.localeCompare(b.id));
    for (let grew = true, cur = e; grew;) {
      grew = false;
      for (const r of order) {
        if (same.includes(r) || !sameCompany(r.doc, cur) || clash(r.doc, e) || same.some((x) => clash(x.doc, r.doc))) continue;
        same.push(r); cur = mergeGroup([e, ...same.map((x) => x.doc)]); grew = true;
      }
    }
    // A saved row under the very id this company would get is merged into as before, never overwritten (db.ts too).
    const taken = saved.find((r) => r.id === `entity:${entityKey(e)}`);
    if (!same.length && taken) same.push(taken);
    const known = same.length ? mergeGroup(same.map((r) => r.doc)) : null;
    const doc = known ? mergeEntity(known, e, { keepGroup: !opts.fromList }) : mergeEntity(e, e);
    const ids = [...new Set(same.map((r) => r.id))].sort((a, b) => homeRank(a) - homeRank(b) || a.localeCompare(b));
    const home = ids[0] ?? `entity:${entityKey(doc)}`;
    if (ids.length) merged++;
    rows.set(home, doc);
    for (const id of ids.slice(1)) { drop.add(id); rows.delete(id); }
    drop.delete(home);
    saved = [...saved.filter((r) => !ids.includes(r.id)), { id: home, doc }];
  }
  return { rows: [...rows].map(([id, doc]) => ({ id, doc })), drop: [...drop], merged };
}

/** The company list as saved, checked for companies with more than one row (saved before saving merged them):
    each such company becomes one row, the loaded list's row where there is one, with every field either row had
    and the loaded list's group name; the other rows are removed. rows: every saved company row, [{id, doc}]. */
export function tidyPlan(rows) {
  const list = rows.filter((r) => r && typeof r.id === "string" && r.doc && typeof r.doc === "object");
  const keep = [], drop = [];
  for (const g of companyGroups(list)) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => homeRank(a.id) - homeRank(b.id) || a.id.localeCompare(b.id)), home = sorted[0];
    // every field either row had; the home row's group (the loaded list's, where there is one) wins
    const all = mergeGroup(g.map((r) => r.doc));
    const doc = mergeEntity(all, { ...all, naicGroupCode: home.doc.naicGroupCode ?? null, naicGroupName: home.doc.naicGroupName ?? null });
    keep.push({ id: home.id, doc });
    drop.push(...sorted.slice(1).map((r) => r.id));
  }
  return { rows: keep, drop, companies: list.length - drop.length, duplicates: keep.length };
}

/** The rows of a plan as the snl_store table holds them. */
export const planRows = (plan, fetchedAt) => plan.rows.map((r) => ({ id: r.id, kind: "entity", label: entityLabel(r.doc), doc: r.doc, fetched_at: fetchedAt }));
