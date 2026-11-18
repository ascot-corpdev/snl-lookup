// scripts/companies.mjs after the first Live check: a list loaded after search results merges into the rows the app
// already has (one company, one row), loading again changes nothing, count reports companies (and any company saved
// twice before merging was done), and tidy shows, then with --apply merges, companies saved twice. Runs against a
// stand-in for Supabase on this machine only. Every company, id and code here is made up.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { entityIdsOf, mergeEntity, planEntityWrites, sameCompany, tidyPlan } from "../../scripts/companies-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../scripts/companies.mjs");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const E = (over) => ({ companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...over });

// ---------- the pieces ----------
ok("ids for the look-up are digits only, each once", same(entityIdsOf([E({ companyId: "4000001", institutionId: "5000001" }), E({ companyId: "4000001", naicCompanyCode: "90-01" }), E({ institutionId: "1 or 1=1" })]), { companyId: ["4000001"], institutionId: ["5000001"], naicCompanyCode: [] }));
ok("the same company by institution id; never two company ids", sameCompany(E({ institutionId: "5000001" }), E({ companyId: "4000001", institutionId: "5000001" })) && !sameCompany(E({ companyId: "1", institutionId: "5" }), E({ companyId: "2", institutionId: "5" })));
ok("a list's empty cell never wipes what results taught", same(mergeEntity(E({ companyId: "4000001", institutionId: "5000001", naicCompanyCode: "90001" }), E({ institutionId: "5000001", naicGroupName: "Calloway Group" })),
  E({ companyId: "4000001", institutionId: "5000001", naicCompanyCode: "90001", naicGroupName: "Calloway Group" })));
const plan = planEntityWrites([{ id: "entity:4000001", doc: E({ companyId: "4000001", institutionId: "5000001", naicCompanyCode: "90001", naicGroupName: "Calloway Grp" }) }], [E({ institutionId: "5000001", naicGroupName: "Calloway Group (SNL P&C Group)" }), E({ companyName: "Calloway Home Co", institutionId: "5000002" })]);
ok("a loaded company lands on the row results made, with the list's group name; a new one gets its own row", same(plan.rows.map((r) => [r.id, r.doc.companyId, r.doc.naicGroupName]), [["entity:4000001", "4000001", "Calloway Group (SNL P&C Group)"], ["entity:i.5000002", null, null]]) && plan.merged === 1 && plan.drop.length === 0, plan);
const tidy = tidyPlan([{ id: "entity:i.5000001", doc: E({ institutionId: "5000001", naicGroupName: "Calloway Group" }) }, { id: "entity:4000001", doc: E({ companyId: "4000001", institutionId: "5000001", naicCompanyCode: "90001" }) }, { id: "entity:i.5000002", doc: E({ institutionId: "5000002" }) }, { id: "entity:9", doc: null }]);
ok("tidy keeps the list's row with every field, and removes the other", same(tidy.rows, [{ id: "entity:i.5000001", doc: E({ companyId: "4000001", naicCompanyCode: "90001", institutionId: "5000001", naicGroupName: "Calloway Group" }) }]) && same(tidy.drop, ["entity:4000001"]) && tidy.companies === 2 && tidy.duplicates === 1, tidy);
ok("tidy with nothing saved twice changes nothing", same(tidyPlan([{ id: "entity:i.5000002", doc: E({ institutionId: "5000002" }) }]), { rows: [], drop: [], companies: 1, duplicates: 0 }));

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
const dir = mkdtempSync(join(tmpdir(), "snl-followups-"));
const file = join(dir, "list.csv");
writeFileSync(file, ["Company Name,SNL Institution Key,NAIC Group Name", "Calloway Insurance Co,5000001,Calloway Group (SNL P&C Group)", "Calloway Home Co,5000002,Calloway Group (SNL P&C Group)", "Tarrow Mutual Insurance Co,5000004,Tarrow Mutual Group"].join("\n"));
const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, SUPABASE_URL: base, SUPABASE_SECRET_KEY: "test-secret-key" } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});
const row = (id, doc) => saved.set(id, { id, kind: "entity", label: doc.companyName, doc, fetched_at: "2026-11-18T00:00:00Z" });

// search results came first: one company the app already knows by its company id
row("entity:4000001", E({ companyId: "4000001", institutionId: "5000001", naicCompanyCode: "90001", spStatEntityId: "C90001" }));
const load = await run(["load", file]);
ok("load merges the list into the row results made and says so", load.status === 0 && /Loaded 3 companies\./.test(load.out) && load.out.includes("One of them was already in the directory (loaded before, or seen in search results) and was updated in place.") && saved.size === 3, load.out);
ok("the merged row carries every id and the loaded group name", same(saved.get("entity:4000001").doc, E({ companyId: "4000001", institutionId: "5000001", naicCompanyCode: "90001", spStatEntityId: "C90001", naicGroupName: "Calloway Group (SNL P&C Group)" })) && saved.get("entity:4000001").label === "Calloway Insurance Co | NAIC 90001 | Calloway Group (SNL P&C Group)", saved.get("entity:4000001"));
ok("no second row for that company", !saved.has("entity:i.5000001"));
const again = await run(["load", file]);
ok("loading again adds nothing and keeps what results taught", again.status === 0 && saved.size === 3 && saved.get("entity:4000001").doc.companyId === "4000001" && again.out.includes("3 of them were already in the directory"), again.out);
let count = await run(["count"]);
ok("count: companies, one row each", count.status === 0 && count.out.trim() === "The directory holds 3 companies.", count.out);

// a pair saved before merging was done
row("entity:4000002", E({ companyName: "Calloway Home Co", companyId: "4000002", institutionId: "5000002", naicCompanyCode: "90002" }));
count = await run(["count"]);
ok("count: a company saved twice counts once, and the way to merge it is given", count.status === 0 && count.out.includes("The directory holds 3 companies in 4 rows: 1 company has a second row") && count.out.includes("node scripts/companies.mjs tidy --apply"), count.out);
const look = await run(["tidy"]);
ok("tidy on its own shows what it would merge and changes nothing", look.status === 0 && look.out.includes("1 company has more than one row.") && look.out.includes("Calloway Home Co  [kept: entity:i.5000002]") && look.out.includes("Nothing was changed.") && saved.size === 4 && !log.some((l) => l.method === "DELETE"), look.out);
const done = await run(["tidy", "--apply"]);
ok("tidy --apply merges it: one row, every field, the other removed", done.status === 0 && done.out.includes("Merged. The directory now holds 3 companies, one row each.") && saved.size === 3 && !saved.has("entity:4000002")
  && same(saved.get("entity:i.5000002").doc, E({ companyName: "Calloway Home Co", companyId: "4000002", naicCompanyCode: "90002", institutionId: "5000002", naicGroupName: "Calloway Group (SNL P&C Group)" })), { out: done.out, row: saved.get("entity:i.5000002") });
const posts = log.map((l, i) => [l.method, i]), firstDelete = posts.find(([m]) => m === "DELETE")?.[1], lastPost = posts.filter(([m]) => m === "POST").at(-1)[1];
ok("the merged row is saved before the second row is removed", firstDelete > lastPost, posts);
const nothing = await run(["tidy", "--apply"]);
ok("tidy again: nothing to do", nothing.status === 0 && nothing.out.trim() === "The directory holds 3 companies, one row each. Nothing to tidy.", nothing.out);
const bad = await run(["count", "--apply"]);
ok("--apply belongs to tidy only", bad.status === 1 && /Unknown option --apply/.test(bad.out), bad.out);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
