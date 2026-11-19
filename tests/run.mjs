// Runs every test suite and prints one summary. Exit code 1 if anything fails.
//   npm test              all suites
//   npm test -- filings chat  only suites whose file name contains "filings" or "chat"
//   npm test -- --shard=2/4   the second of four parts (tests/shards.mjs); GitHub runs the parts at the same time
//   npm test -- --timings     also record how long each suite took in tests/durations.json, which evens out the parts
//   npm test -- --list        print the suites that would run, one a line, and run nothing
// Web suites (tests/web/*.test.cjs) drive web/index.html in Chromium against an in-memory Supabase stand-in
// (tests/web/mock-supabase.js); nothing touches the live database. Function suites (tests/functions/*.ts) run the
// Supabase Edge Functions under Deno against fake S&P, Snowflake and Claude APIs; they are skipped if Deno isn't installed.
// Screenshots land in tests/out/ (not committed).
import { spawnSync } from "node:child_process";
import { readdirSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShard, planShards } from "./shards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "out"), { recursive: true });
let shard = null, timings = false, list = false;
const only = [];
for (const a of process.argv.slice(2)) {
  if (!a.startsWith("--")) { only.push(a); continue; }
  if (a === "--timings") { timings = true; continue; }
  if (a === "--list") { list = true; continue; }
  try { const s = parseShard(a); if (!s) throw new Error(`Unknown option ${a}. The options are --shard=2/4, --timings and --list.`); shard = s; }
  catch (e) { console.error(e.message); process.exit(2); }
}
const DURATIONS = join(here, "durations.json");
const readDurations = () => { try { const d = JSON.parse(readFileSync(DURATIONS, "utf8")); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; } catch { return {}; } };
const pick = (f) => !only.length || only.some((o) => f.includes(o));
const deno = process.env.DENO_BIN || "deno";
const hasDeno = spawnSync(deno, ["--version"], { stdio: "ignore" }).status === 0;

const ls = (d) => (existsSync(join(here, d)) ? readdirSync(join(here, d)) : []);
const all = [
  ...ls("functions").filter((f) => f.endsWith(".ts")).filter(pick).map((f) => ({ name: "functions/" + f, cmd: deno, args: ["run", "-A", "--node-modules-dir=none", join(here, "functions", f)], deno: true })),
  ...ls("web").filter((f) => f.endsWith(".test.cjs")).filter(pick).map((f) => ({ name: "web/" + f, cmd: process.execPath, args: [join(here, "web", f)] })),
  ...ls("scripts").filter((f) => f.endsWith(".test.mjs")).filter(pick).map((f) => ({ name: "scripts/" + f, cmd: process.execPath, args: [join(here, "scripts", f)] })),
  // The Cloudflare Worker (worker/index.js), run under Node with stand-ins for its static files and outside calls.
  ...ls("worker").filter((f) => f.endsWith(".test.mjs")).filter(pick).map((f) => ({ name: "worker/" + f, cmd: process.execPath, args: [join(here, "worker", f)] })),
];

// One part of the suites when asked for; every suite is in exactly one part.
const kindOf = (name) => name.split("/")[0];
const sizeOf = (name) => { try { return statSync(join(here, name)).size; } catch { return 0; } };
const mine = shard ? new Set(planShards(all.map((s) => ({ name: s.name, kind: kindOf(s.name), size: sizeOf(s.name) })), shard.total, readDurations())[shard.index - 1]) : null;
const suites = mine ? all.filter((s) => mine.has(s.name)) : all;
if (list) { console.log(suites.map((s) => s.name).join("\n")); process.exit(0); }
if (shard) console.log(`Part ${shard.index} of ${shard.total}: ${suites.length} of ${all.length} suites.`);

let failed = 0, passed = 0;
const rows = [], took = {};
for (const s of suites) {
  if (s.deno && !hasDeno) { rows.push([s.name, "skipped (Deno not installed)"]); continue; }
  // Browser suites wait on timers, so a slow machine can trip one; run a failing suite a second time before reporting it.
  let r, tries = 0, began = 0;
  do { began = Date.now(); r = spawnSync(s.cmd, s.args, { encoding: "utf8", cwd: join(here, ".."), timeout: 10 * 60_000 }); tries++; }
  while (r.status !== 0 && tries < 2 && !s.deno);
  if (r.status === 0) took[s.name] = Math.max(1, Math.round((Date.now() - began) / 1000));
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/(\d+) passed, (\d+) failed/g);
  const last = m ? m[m.length - 1].match(/(\d+) passed, (\d+) failed/) : null;
  passed += last ? +last[1] : 0;
  if (r.status !== 0) {
    failed++;
    rows.push([s.name, `FAILED${last ? ` (${last[1]} passed, ${last[2]} failed)` : ""}`]);
    console.log(`\n--- ${s.name} ---\n` + out.split("\n").filter((l) => /FAIL|Error|error|at /.test(l)).slice(0, 40).join("\n"));
  } else rows.push([s.name, `ok, ${last ? last[1] : "?"} checks${tries > 1 ? " (passed on retry)" : ""}`]);
}
const w = Math.max(...rows.map((r) => r[0].length));
console.log("\n" + rows.map(([n, v]) => n.padEnd(w + 2) + v).join("\n"));
console.log(`\n${passed} checks passed; ${failed} suite${failed === 1 ? "" : "s"} failed.`);
if (timings) {
  // Kept for suites that still exist; a suite not run this time keeps its last timing.
  const exists = (n) => { const [d, f] = n.split("/"); return ls(d).includes(f); };
  const names = { has: exists }, merged = { ...readDurations(), ...took };
  const out = Object.fromEntries(Object.keys(merged).filter((n) => names.has(n)).sort().map((n) => [n, merged[n]]));
  writeFileSync(DURATIONS, JSON.stringify(out, null, 1) + "\n");
  console.log(`Recorded how long ${Object.keys(took).length} suite${Object.keys(took).length === 1 ? "" : "s"} took in tests/durations.json.`);
}
process.exit(failed ? 1 : 0);
