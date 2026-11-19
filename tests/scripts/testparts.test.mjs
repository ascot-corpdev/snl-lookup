// The tests run as parts on separate machines at the same time (tests/shards.mjs, tests/run.mjs --shard, and
// .github/workflows/tests.yml). The danger in splitting is a suite that lands in no part and silently stops being
// run, so this suite proves every suite is in exactly one part, for the real files and for made-up ones, and that the
// workflow runs every part and reports one check that is green only when all of them passed.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BYTES_PER_SECOND, expectedSeconds, KIND_WEIGHT, parseShard, planShards } from "../shards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail === undefined ? "" : detail).slice(0, 600)); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- the argument ----------
{
  ok("--shard=2/4 is part 2 of 4", same(parseShard("--shard=2/4"), { index: 2, total: 4 }) && same(parseShard("--shard=1/1"), { index: 1, total: 1 }) && same(parseShard("--shard=16/16"), { index: 16, total: 16 }));
  ok("an argument that isn't a shard is left for something else", parseShard("--timings") === null && parseShard("filings") === null && parseShard("--shards=1/2") === null);
  const refused = ["--shard", "--shard=", "--shard=2", "--shard=0/4", "--shard=5/4", "--shard=1/0", "--shard=1/17", "--shard=a/b", "--shard=1/4/2", "--shard=-1/4", "--shard=1.5/4", "--shard= 1/4"];
  const said = refused.map((a) => { try { parseShard(a); return null; } catch (e) { return e.message; } });
  ok("a shard that can't be used is refused in plain words that show how to write it", said.every((m) => typeof m === "string" && /Write it as --shard=2\/4/.test(m) && !m.includes("—")), said);
}

// ---------- sharing suites out ----------
const made = (n, kind = "web") => Array.from({ length: n }, (_, i) => ({ name: `${kind}/s${String(i).padStart(3, "0")}.test.cjs`, kind, size: 1000 + ((i * 7919) % 50) * 1000 }));
{
  const suites = [...made(40), ...made(30, "functions"), ...made(3, "scripts")];
  for (const total of [1, 2, 3, 4, 5, 8, 16]) {
    const parts = planShards(suites, total);
    const flat = parts.flat();
    ok(`${total} part${total === 1 ? "" : "s"}: every suite is in exactly one part`, parts.length === total && flat.length === suites.length && new Set(flat).size === suites.length && suites.every((s) => flat.includes(s.name)), { total, flat: flat.length });
  }
  ok("the same files always give the same parts, whatever order they are listed in", same(planShards(suites, 4), planShards([...suites].reverse(), 4)) && same(planShards(suites, 4), planShards(suites, 4)));
  ok("more parts than suites: nothing is lost and the spare parts are empty", (() => { const p = planShards(made(2), 4); return p.flat().length === 2 && p.filter((x) => x.length === 0).length === 2; })());
  ok("no suites: every part is empty", same(planShards([], 3), [[], [], []]));

  // by time, when timings exist
  const timed = Object.fromEntries(suites.map((s, i) => [s.name, 5 + (i * 37) % 60]));
  const load = (names) => names.reduce((a, n) => a + timed[n], 0);
  const p4 = planShards(suites, 4, timed), loads = p4.map(load), longest = Math.max(...Object.values(timed));
  ok("with timings, the parts take about as long as each other: no two differ by more than the longest suite", Math.max(...loads) - Math.min(...loads) <= longest, loads);
  const lop = { "web/s000.test.cjs": 1000 };
  const pl = planShards(suites, 4, lop);
  ok("a suite that takes far longer than the rest gets a part mostly to itself", pl.find((x) => x.includes("web/s000.test.cjs")).length < pl.filter((x) => !x.includes("web/s000.test.cjs"))[0].length);

  ok("a suite never timed is given a time from its size, and a browser suite counts for more", expectedSeconds({ name: "web/a", kind: "web", size: 2 * BYTES_PER_SECOND }) === 2 * KIND_WEIGHT.web && expectedSeconds({ name: "functions/a", kind: "functions", size: 2 * BYTES_PER_SECOND }) === 2 && expectedSeconds({ name: "x/a", kind: "new-kind", size: 0 }) === 1);
  ok("a timing that isn't a positive number is ignored", [0, -3, "x", null, NaN, Infinity].every((v) => expectedSeconds({ name: "web/a", kind: "web", size: BYTES_PER_SECOND }, { "web/a": v }) === KIND_WEIGHT.web) && expectedSeconds({ name: "web/a", kind: "web", size: 1 }, { "web/a": 12 }) === 12);
  ok("a timing for a suite that no longer exists changes nothing", same(planShards(suites, 4, { ...timed, "web/gone.test.cjs": 999 }), p4));
}

// ---------- the runner, on the real suites ----------
const run = (...args) => spawnSync(process.execPath, [join(root, "tests/run.mjs"), ...args], { encoding: "utf8", cwd: root });
const listOf = (...args) => { const r = run("--list", ...args); return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : null; };
const onDisk = [
  ...readdirSync(join(root, "tests/functions")).filter((f) => f.endsWith(".ts")).map((f) => "functions/" + f),
  ...readdirSync(join(root, "tests/web")).filter((f) => f.endsWith(".test.cjs")).map((f) => "web/" + f),
  ...readdirSync(join(root, "tests/scripts")).filter((f) => f.endsWith(".test.mjs")).map((f) => "scripts/" + f),
  ...readdirSync(join(root, "tests/worker")).filter((f) => f.endsWith(".test.mjs")).map((f) => "worker/" + f),
].sort();
{
  const all = listOf();
  ok("with no shard, every suite file on disk is run", all !== null && same([...all].sort(), onDisk) && all.length > 100, { listed: all && all.length, onDisk: onDisk.length });
  for (const total of [2, 4, 6]) {
    const parts = Array.from({ length: total }, (_, i) => listOf(`--shard=${i + 1}/${total}`));
    const flat = parts.flat();
    ok(`the real suites in ${total} parts: every one is in exactly one part, and no part is empty`, parts.every((p) => Array.isArray(p) && p.length > 0) && flat.length === onDisk.length && same([...flat].sort(), onDisk), { total, flat: flat.length });
  }
  const filtered = [listOf("--shard=1/2", ".test.cjs"), listOf("--shard=2/2", ".test.cjs")];
  ok("a name filter and a shard together: the filtered suites, each in exactly one part", same(filtered.flat().sort(), onDisk.filter((n) => n.includes(".test.cjs"))));
  const bad = run("--shard=9/4"), unknown = run("--nope");
  ok("a shard that can't be used stops the run before any suite, with the reason", bad.status === 2 && /Can't use --shard=9\/4/.test(bad.stderr) && unknown.status === 2 && /Unknown option --nope/.test(unknown.stderr));
}

// ---------- the timings file ----------
{
  const d = JSON.parse(readFileSync(join(root, "tests/durations.json"), "utf8"));
  const names = Object.keys(d);
  ok("the timings are whole seconds, by suite, in name order", names.length > 0 && names.every((n) => /^(functions|web|scripts|worker)\/[\w.-]+$/.test(n) && Number.isInteger(d[n]) && d[n] >= 1 && d[n] < 3600) && same(names, [...names].sort()));
  const loads = (total) => planShards(onDisk.map((name) => ({ name, kind: name.split("/")[0], size: 20_000 })), total, d).map((p) => p.reduce((a, n) => a + (d[n] ?? 0), 0));
  const four = loads(4), longest = Math.max(...Object.values(d));
  ok("with today's timings the four parts take about as long as each other", Math.max(...four) - Math.min(...four) <= longest, four);
}

// ---------- the workflow ----------
{
  const yml = readFileSync(join(root, ".github/workflows/tests.yml"), "utf8");
  const matrix = /\n\s+matrix:\s*\n\s+part: \[([^\]]+)\]/.exec(yml);
  const partsList = matrix ? matrix[1].split(",").map((x) => Number(x.trim())) : [];
  ok("the workflow lists its parts as 1 to N with none missing", partsList.length >= 2 && same(partsList, partsList.map((_, i) => i + 1)), partsList);
  ok("each machine runs its own part of that many, taken from the list itself so the two can't drift apart", yml.includes("run: npm test -- --shard=${{ matrix.part }}/${{ strategy.job-total }}"));
  ok("a failing part doesn't stop the others, so every failure is seen in one run", /fail-fast: false/.test(yml));
  ok("each part keeps its own screenshots when it fails", yml.includes("name: test-output-part-${{ matrix.part }}"));
  const summary = yml.slice(yml.indexOf("\n  test:"));
  ok("one check named test waits for every part, runs even when a part failed, and is green only when all passed", /\n  test:\n\s+name: test\n\s+needs: suites\n\s+if: always\(\)/.test(yml) && summary.includes("RESULT: ${{ needs.suites.result }}") && /if \[ "\$RESULT" != "success" \]; then[\s\S]*exit 1/.test(summary));

  // the summary step's shell, run here with each result GitHub can give
  const lines = summary.split("\n"), at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l)), indent = lines[at].match(/^\s*/)[0].length + 2;
  const script = []; for (const l of lines.slice(at + 1)) { if (l.trim() && l.match(/^\s*/)[0].length < indent) break; script.push(l.slice(indent)); }
  const sh = (result) => spawnSync("bash", ["-e", "-c", script.join("\n")], { encoding: "utf8", env: { PATH: process.env.PATH, RESULT: result } });
  ok("all parts passed: the check passes", sh("success").status === 0 && /Every part of the tests passed/.test(sh("success").stdout));
  ok("a part failed, was cancelled or was skipped: the check fails and says to open the failing part", ["failure", "cancelled", "skipped", ""].every((r) => { const o = sh(r); return o.status === 1 && /Open the failing part above/.test(o.stdout); }));
  ok("the workflow still runs on every pull request and on pushes to main", /on:\n\s+pull_request:\n\s+push:\n\s+branches: \[main\]/.test(yml) && /cancel-in-progress: true/.test(yml));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
