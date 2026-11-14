// The repository is public and must not name the company that owns the app: its name is a setting (ORG_NAME).
// This walks every file in the repository (not node_modules, .git or tests/out) and fails if the name is back.
// The name is built from pieces so this file does not contain it.
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };

const word = ["a", "s", "c", "o", "t"].join("");
const pattern = new RegExp(word, "i");
const skip = new Set(["node_modules", ".git", join("tests", "out")]);
const hits = [];
let files = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name), rel = relative(root, full);
    if (skip.has(name) || skip.has(rel)) continue;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { walk(full); continue; }
    files++;
    if (pattern.test(rel)) hits.push(rel);
    const text = readFileSync(full, "latin1");
    text.split("\n").forEach((line, i) => { if (pattern.test(line)) hits.push(`${rel}:${i + 1}`); });
  }
})(root);

ok("the walk found the repository's files", files > 30, files);
ok("the company's name appears nowhere in the repository, in any case", hits.length === 0, hits);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
