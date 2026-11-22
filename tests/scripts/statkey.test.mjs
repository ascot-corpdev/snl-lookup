// scripts/companies.mjs with a list that has only names, S&P statutory entity keys, NAIC codes and groups (no S&P
// company id or institution id): each company lands on the row already saved for it with the same statutory key,
// instead of a second, NAIC-only row. Loading again changes nothing, tidy merges pairs an earlier load left, and two
// rows that share a key but differ on another id are kept apart. Runs against a stand-in for Supabase on this
// machine only. Every company, id, key and code here is made up.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { entityIdsOf, planEntityWrites, readCompanies, sameCompany, tidyPlan } from "../../scripts/companies-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../scripts/companies.mjs");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const E = (over) => ({ companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...over });
const G = "Calloway Group (SNL P&C Group)";

// ---------- the pieces ----------
ok("a shared statutory key makes two rows the same company", sameCompany(E({ institutionId: "5000001", spStatEntityId: "C1001" }), E({ naicCompanyCode: "90001", spStatEntityId: "C1001" })));
ok("the key is compared without regard to letter case", sameCompany(E({ institutionId: "5000001", spStatEntityId: "c1001" }), E({ naicCompanyCode: "90001", spStatEntityId: "C1001" })));
ok("two different keys are two companies, whatever else they share", !sameCompany(E({ institutionId: "5000001", spStatEntityId: "C1001" }), E({ institutionId: "5000001", spStatEntityId: "C1002" })));
ok("a shared key with a different NAIC code is two companies", !sameCompany(E({ naicCompanyCode: "90099", spStatEntityId: "C1004" }), E({ naicCompanyCode: "90004", spStatEntityId: "C1004" })));
ok("a shared key with a different institution id is two companies", !sameCompany(E({ institutionId: "5000001", spStatEntityId: "C1004" }), E({ institutionId: "5000009", spStatEntityId: "C1004" })));
ok("keys for the look-up: letters and digits only, in each letter case", same(entityIdsOf([E({ spStatEntityId: "C1001" }), E({ spStatEntityId: "C1001" }), E({ spStatEntityId: "C1'; drop" })]).spStatEntityId, ["C1001", "c1001"]));

const listRow = E({ spStatEntityId: "C1001", naicCompanyCode: "90001", naicGroupCode: "9001", naicGroupName: G });
let plan = planEntityWrites([{ id: "entity:i.5000001", doc: E({ institutionId: "5000001", spStatEntityId: "C1001", naicGroupName: G }) }], [listRow]);
ok("a key-and-NAIC list row lands on the row with the S&P ids: one row, everything, same id", same(plan.rows, [{ id: "entity:i.5000001", doc: E({ naicCompanyCode: "90001", institutionId: "5000001", spStatEntityId: "C1001", naicGroupCode: "9001", naicGroupName: G }) }]) && plan.drop.length === 0 && plan.merged === 1, plan);
plan = planEntityWrites([{ id: "entity:i.5000004", doc: E({ companyName: "Nonesuch Clash Co", institutionId: "5000004", spStatEntityId: "C1004", naicCompanyCode: "90099" }) }], [E({ companyName: "Nonesuch Clash Co", spStatEntityId: "C1004", naicCompanyCode: "90004" })]);
ok("a shared key but a different NAIC code: not merged, the list row gets its own row and the saved row is left alone", same(plan.rows.map((r) => r.id), ["entity:n.90004"]) && plan.merged === 0 && plan.drop.length === 0, plan);

// The loader's own rules still hold: a NAIC-only row is dropped only for a row in the same list with an S&P id and the
// same NAIC code, and the label people search by now carries the NAIC code.
const read = readCompanies(["Company Name,S&P Statutory Entity Key,NAIC Company Code,NAIC Group Code,Group Name", `Calloway Insurance Co,C1001,90001,9001,${G}`, "Tarrow Mutual Insurance Co,C1003,90003,,Tarrow Group (SNL P&C Group)"].join("\n"));
ok("the list reads as NAIC-only companies with their statutory keys, none dropped", read.ok && read.companies.length === 2 && read.counts.naicOnly === 2 && read.duplicates === 0 && read.columns.spStatEntityId === "S&P Statutory Entity Key" && read.companies[0].spStatEntityId === "C1001", read);

// ---------- the script, against a stand-in database ----------
const saved = new Map(), log = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    log.push({ method: req.method, query: Object.fromEntries(url.searchParams) });
    const json = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname !== "/rest/v1/snl_store") return json(404, { message: "no stand-in for " + url.pathname });
    const ins = [...url.searchParams].filter(([, v]) => v.startsWith("in.(")).map(([k, v]) => [k, v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, ""))]);
    const match = (r) => ins.every(([k, vs]) => vs.includes(String(k.startsWith("doc->>") ? r.doc?.[k.slice(6)] ?? "" : r[k])));
    if (req.method === "POST") { for (const row of JSON.parse(raw)) saved.set(row.id, row); return json(201, []); }
    if (req.method === "DELETE") { for (const r of [...saved.values()]) if (r.kind === "entity" && match(r)) saved.delete(r.id); return json(200, []); }
    if (req.method === "GET") {
      const from = Number(url.searchParams.get("offset") ?? 0), n = Number(url.searchParams.get("limit") ?? 1000);
      return json(200, [...saved.values()].filter((r) => r.kind === "entity" && match(r)).sort((a, b) => a.id.localeCompare(b.id)).slice(from, from + n).map((r) => ({ id: r.id, doc: r.doc })));
    }
    json(405, { message: "no" });
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "snl-statkey-"));
const file = join(dir, "list.csv");
writeFileSync(file, ["Company Name,S&P Statutory Entity Key,NAIC Company Code,NAIC Group Code,Group Name",
  `Calloway Insurance Co,C1001,90001,9001,${G}`, `Calloway Home Co,C1002,90002,9001,${G}`,
  "Tarrow Mutual Insurance Co,C1003,90003,,Tarrow Group (SNL P&C Group)", "Nonesuch Clash Co,C1004,90004,9004,Nonesuch Group (SNL P&C Group)"].join("\n"));
const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, SUPABASE_URL: base, SUPABASE_SECRET_KEY: "test-secret-key" } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});
const row = (id, doc) => saved.set(id, { id, kind: "entity", label: doc.companyName, doc, fetched_at: "2026-11-18T00:00:00Z" });

// What the live list holds today: S&P ids, the statutory key and S&P's group name, no NAIC code.
row("entity:i.5000001", E({ institutionId: "5000001", spStatEntityId: "C1001", naicGroupName: G }));
row("entity:4000002", E({ companyName: "Calloway Home Co", companyId: "4000002", institutionId: "5000002", spStatEntityId: "c1002", naicGroupName: G }));
row("entity:i.5000003", E({ companyName: "Tarrow Mutual Insurance Co", institutionId: "5000003", naicGroupName: "Tarrow Group (SNL P&C Group)" }));   // no key: can't be matched
row("entity:i.5000004", E({ companyName: "Nonesuch Clash Co", institutionId: "5000004", spStatEntityId: "C1004", naicCompanyCode: "90099" }));          // same key, other NAIC code

const check = await run(["check", file]);
ok("check reads the list and changes nothing", check.status === 0 && check.out.includes("4 for statutory figures only") && check.out.includes('S&P statutory entity id  "S&P Statutory Entity Key"') && check.out.includes("4 with an S&P statutory entity key: loading merges each into a company already in the directory with the same key") && !log.length, check.out);
const load = await run(["load", file]);
ok("load: two companies land on their rows by statutory key; the one without a key and the clash get rows of their own", load.status === 0 && load.out.includes("Loaded 4 companies.") && load.out.includes("2 of them were already in the directory") && saved.size === 6, { out: load.out, ids: [...saved.keys()] });
ok("the row with the institution id keeps its id and gains the NAIC code and group code", same(saved.get("entity:i.5000001").doc, E({ naicCompanyCode: "90001", institutionId: "5000001", spStatEntityId: "C1001", naicGroupCode: "9001", naicGroupName: G })) && saved.get("entity:i.5000001").label === `Calloway Insurance Co | NAIC 90001 | ${G}`, saved.get("entity:i.5000001"));
ok("the row with the company id keeps its id and every id, found by a key in the other letter case", saved.get("entity:4000002").doc.companyId === "4000002" && saved.get("entity:4000002").doc.institutionId === "5000002" && saved.get("entity:4000002").doc.naicCompanyCode === "90002" && saved.get("entity:4000002").doc.naicGroupCode === "9001" && !saved.has("entity:n.90002") && !saved.has("entity:n.90001"), saved.get("entity:4000002"));
ok("a saved row with no statutory key can't be matched: the list's company gets a NAIC-only row beside it", saved.has("entity:n.90003") && saved.get("entity:i.5000003").doc.naicCompanyCode === null, [...saved.keys()]);
ok("a shared key with a different NAIC code is kept apart: the saved code is never overwritten", saved.get("entity:i.5000004").doc.naicCompanyCode === "90099" && saved.get("entity:n.90004").doc.naicCompanyCode === "90004", [saved.get("entity:i.5000004"), saved.get("entity:n.90004")]);
const before = JSON.stringify([...saved.entries()].map(([id, r]) => [id, r.doc]));
const again = await run(["load", file]);
ok("loading the same list again changes nothing", again.status === 0 && again.out.includes("4 of them were already in the directory") && JSON.stringify([...saved.entries()].map(([id, r]) => [id, r.doc])) === before, again.out);

// An earlier load, made before the key decided, left NAIC-only rows beside the rows with S&P ids.
row("entity:i.5000005", E({ companyName: "Calloway Coastal Co", institutionId: "5000005", spStatEntityId: "C1005", naicGroupName: G }));
row("entity:n.90005", E({ companyName: "Calloway Coastal Co", spStatEntityId: "C1005", naicCompanyCode: "90005", naicGroupCode: "9001", naicGroupName: G }));
const look = await run(["tidy"]);
ok("tidy shows the pair the earlier load left, keeps the row with the S&P id, and leaves the clash and the keyless pair alone", look.status === 0 && look.out.includes("1 company has more than one row.") && look.out.includes("Calloway Coastal Co  [kept: entity:i.5000005]") && look.out.includes("Nothing was changed.") && saved.size === 8, look.out);
const apply = await run(["tidy", "--apply"]);
ok("tidy --apply merges it into one row with everything, and removes the NAIC-only row", apply.status === 0 && !saved.has("entity:n.90005") && same(saved.get("entity:i.5000005").doc, E({ companyName: "Calloway Coastal Co", naicCompanyCode: "90005", institutionId: "5000005", spStatEntityId: "C1005", naicGroupCode: "9001", naicGroupName: G })) && saved.size === 7, { out: apply.out, row: saved.get("entity:i.5000005") });
ok("tidy's own plan agrees", tidyPlan([...saved.values()]).duplicates === 0);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
