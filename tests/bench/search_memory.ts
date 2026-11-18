// How much one function call holds when a search is wide. Made-up rows in the fixture's shape (30 columns, a
// 200-character description); nothing real, and no network: S&P is a stand-in that answers at once, so the time
// measured is CPU time. Not part of the test run (tests/run.mjs reads only tests/functions, tests/web, ...).
//
//   deno run -A --node-modules-dir=none tests/bench/search_memory.ts whole 60      the whole search held at once
//   deno run -A --node-modules-dir=none tests/bench/search_memory.ts parts 60      the same search in parts, each part
//                                                                                  a separate process, as separate
//                                                                                  function calls are
// The number is S&P pages of 500 rows (60 is the most one search may ask for). "whole" is how every search ran before
// searches ran in parts; "parts" prints one line per function call and a summary.
import { mapRows, type SearchParams, searchFilings, searchStep, STEP_ROWS } from "../../supabase/functions/_shared/filings.ts";
import type { Db, StoreRow } from "../../supabase/functions/_shared/db.ts";

const fx = JSON.parse(Deno.readTextFileSync(new URL("../fixtures/spgmi_search.json", import.meta.url)));
const headers: string[] = fx.headers, sample = (fx.rows[0].row ?? fx.rows[0]) as unknown[];
const col = (n: string) => headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
const [mode, pagesArg, dirArg] = Deno.args;
const PAGES = Number(pagesArg ?? 60), PER = 500, COS = 60;
const companyIds = Array.from({ length: COS }, (_, i) => 4000000 + i);
const units = Math.ceil(COS / 10);
const P: SearchParams = { states: ["FL", "TX", "CA", "NY", "GA"], from: "2021-01-01", to: "2021-12-31", companyIds, institutionIds: [], filingStatusIds: [1], filingTypeIds: [], typeOfInsuranceIds: [], spStatEntityIds: [], trackingNumbers: [] };

/** S&P's answer to one page: 500 rows, each filing different, the same rows for the same request in any process. */
const api = { json: (_m: string, path: string, o: { body: { properties: Record<string, any> } }) => {
  if (path !== "/api/v1/search") return Promise.resolve({ headers: [], rows: [] });   // the reference lists
  const q = o.body.properties, unit = Math.floor((q.companyId[0] - 4000000) / 10), page = q.pageNumber;
  const rows: unknown[] = [];
  for (let i = 0; i < PER; i++) {
    const n = (unit * 1000 + page) * PER + i, r = sample.slice();
    const set = (name: string, v: unknown) => { const c = col(name); if (c >= 0) r[c] = v; };
    set("sfcNumber", "ABC" + String(1000000 + n)); set("filingVersionId", 9000000 + n); set("serffFilingEntityEventId", 7000000 + n); set("trackingNumber", null);
    set("companyId", 4000000 + unit * 10 + (n % 10)); set("companyName", "Calloway Insurance Co " + (n % COS));
    set("serffFilingStateId", ["FL", "TX", "CA", "NY", "GA"][n % 5]); set("publishDate", "2021-0" + (1 + n % 9) + "-1" + (n % 9)); set("filingDescription", "x".repeat(200));
    rows.push({ row: r });
  }
  // parsed from text, as the real client does
  return Promise.resolve(JSON.parse(JSON.stringify({ headers, rows, totalPages: Math.ceil(PAGES / units) })));
} };

const mb = (n: number) => +(n / 1e6).toFixed(1);

if (mode === "whole") {
  const t0 = performance.now();
  const res = await searchFilings(api as never, P, { maxRequests: PAGES, maxRows: Infinity });
  const doc = JSON.stringify({ params: P, ...res, source: "x" });   // what was saved
  const reply = JSON.stringify({ params: P, ...res, source: "x", fetchedAt: "x" });   // and what was sent
  const ms = performance.now() - t0, m = Deno.memoryUsage();
  console.log(JSON.stringify({ mode, pages: res.requests, rowsHeld: res.rows.length, docMB: mb(doc.length), replyMB: mb(reply.length), rssMB: mb(m.rss), heapMB: mb(m.heapUsed), cpuMs: Math.round(ms) }));
} else if (mode === "part") {
  // One function call. The database is files in a folder, so nothing saved stays in this process's memory.
  const dir = dirArg!;
  const file = (id: string) => `${dir}/${id.replace(/[^A-Za-z0-9]/g, "_")}.json`;
  let biggest = 0;
  const db = {
    async getStore(id: string): Promise<StoreRow | null> { try { return JSON.parse(Deno.readTextFileSync(file(id))); } catch { return null; } },
    async putStore(row: { id: string; kind: string; label?: string; doc: Record<string, unknown> }) {
      const text = JSON.stringify({ ...row, label: row.label ?? "", fetched_at: "2026-11-18T00:00:00Z" });
      biggest = Math.max(biggest, text.length); Deno.writeTextFileSync(file(row.id), text); return true;
    },
    async putEntities() {},
  } as unknown as Db;
  let cursor: unknown;
  try { cursor = JSON.parse(Deno.readTextFileSync(`${dir}/cursor.json`)); } catch { cursor = undefined; }
  const t0 = performance.now();
  const a = await searchStep(api as never, db, P, { now: Date.parse("2026-11-18T00:00:00Z"), maxRequests: 60, cursor });
  const reply = JSON.stringify(a);
  const ms = performance.now() - t0, m = Deno.memoryUsage();
  Deno.writeTextFileSync(`${dir}/cursor.json`, JSON.stringify(a.cursor));
  console.log(JSON.stringify({ part: a.part, more: a.more, rowsHeld: a.rows.length, totalSoFar: a.total, requests: a.requests, replyMB: mb(reply.length), biggestSavedMB: mb(biggest), rssMB: mb(m.rss), heapMB: mb(m.heapUsed), cpuMs: Math.round(ms) }));
} else if (mode === "parts") {
  const dir = Deno.makeTempDirSync({ prefix: "search-parts-" });
  const lines: Record<string, number | boolean>[] = [];
  for (let k = 0; k < 100; k++) {
    const out = new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--node-modules-dir=none", new URL(import.meta.url).pathname, "part", String(PAGES), dir] }).outputSync();
    const line = JSON.parse(new TextDecoder().decode(out.stdout).trim().split("\n").pop()!);
    console.log(JSON.stringify(line));
    lines.push(line);
    if (!line.more) break;
  }
  const max = (k: string) => Math.max(...lines.map((l) => Number(l[k])));
  console.log(JSON.stringify({ mode, pages: PAGES, calls: lines.length, filings: lines[lines.length - 1].totalSoFar, maxRowsHeld: max("rowsHeld"), bound: STEP_ROWS, maxReplyMB: max("replyMB"), maxSavedMB: max("biggestSavedMB"), maxRssMB: max("rssMB"), maxHeapMB: max("heapMB"), maxCpuMs: max("cpuMs") }));
  Deno.removeSync(dir, { recursive: true });
} else {
  console.log("Use: whole <pages> | parts <pages>");
}
