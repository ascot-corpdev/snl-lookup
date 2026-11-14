// scripts/companies.mjs: reading a company list and loading it into the app's company directory, against a
// stand-in for Supabase on this machine only. Every company, id and code here is made up.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { batches, cleanId, describe, entityKey, entityLabel, findHeadingRow, matchColumns, parseDelimited, readCompanies, toStoreRows } from "../../scripts/companies-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../scripts/companies.mjs");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- reading delimited text ----------
ok("plain rows split on commas", same(parseDelimited("a,b,c\n1,2,3\n"), [["a", "b", "c"], ["1", "2", "3"]]));
ok("quoted cells keep their commas, quotes and line breaks", same(parseDelimited('name,note\n"Calloway Home, Inc.","said ""yes""\nthen left"\n'), [["name", "note"], ["Calloway Home, Inc.", 'said "yes"\nthen left']]));
ok("Windows line endings, a byte-order mark and blank lines are handled", same(parseDelimited("﻿a,b\r\n\r\n1,2\r\n,\r\n"), [["a", "b"], ["1", "2"]]));
ok("tab-separated and semicolon-separated lists are recognised", same(parseDelimited("a\tb\n1,5\t2\n"), [["a", "b"], ["1,5", "2"]]) && same(parseDelimited("a;b\n1;2\n"), [["a", "b"], ["1", "2"]]));
ok("a last row with no line break is kept", same(parseDelimited("a,b\n1,2"), [["a", "b"], ["1", "2"]]));

// ---------- ids ----------
ok("ids are whole numbers as text, whatever the export dressed them in", cleanId("IQ4000001") === "4000001" && cleanId("iq4000001") === "4000001" && cleanId("4,000,001") === "4000001" && cleanId("4000001.0") === "4000001" && cleanId(" 4000001 ") === "4000001" && cleanId(4000001) === "4000001");
ok("anything that isn't a whole number is no id", [cleanId(""), cleanId("n/a"), cleanId("4000001.5"), cleanId("-12"), cleanId("0"), cleanId("12 OR 1=1"), cleanId("1234567890123"), cleanId(null)].every((v) => v === null));

// ---------- finding the columns ----------
const cols = (h, named) => { const { cols } = matchColumns(h, named); return Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, h[i]])); };
ok("plain headings are matched", same(cols(["Company Name", "Company ID", "Institution ID", "NAIC Company Code", "NAIC Group Code", "NAIC Group Name"]),
  { naicGroupName: "NAIC Group Name", naicGroupCode: "NAIC Group Code", institutionId: "Institution ID", companyId: "Company ID", naicCompanyCode: "NAIC Company Code", companyName: "Company Name" }));
ok("headings in another style are matched too", same(cols(["Entity Name", "S&P Capital IQ ID (Company)", "SNL Institution Key", "NAIC Code", "Group Name"]),
  { naicGroupName: "Group Name", institutionId: "SNL Institution Key", companyId: "S&P Capital IQ ID (Company)", naicCompanyCode: "NAIC Code", companyName: "Entity Name" }));
ok("the group's name is never taken for the company's name", cols(["Group Name", "Name", "Company ID"]).companyName === "Name" && cols(["Group Name", "Name", "Company ID"]).naicGroupName === "Group Name");
ok("a column can be named outright, whatever its heading", same(cols(["Insurer", "Key", "Code"], { companyName: "Insurer", institutionId: "Key", naicCompanyCode: "Code" }), { companyName: "Insurer", institutionId: "Key", naicCompanyCode: "Code" }));
ok("naming a column that isn't there is reported", same(matchColumns(["Company Name", "Company ID"], { companyId: "S&P ID" }).problems, ['There is no column headed "S&P ID".']));
ok("the heading row is found under a title and a date", findHeadingRow([["Company screen"], ["Run 13 Nov 2026"], ["Company Name", "Company ID"], ["Calloway Insurance Co", "4000001"]]).at === 2);
ok("a sheet with a name but no id column has no heading row", findHeadingRow([["Company Name", "State"], ["Calloway Insurance Co", "FL"]]) === null);

// ---------- reading a whole list ----------
const LIST = [
  "Made-up insurer list",
  "",
  'Company Name,S&P Company ID,SNL Institution Key,NAIC Company Code,NAIC Group Code,NAIC Group Name,State',
  'Calloway Insurance Co,IQ4000001,5000001,90001,9001,Calloway Group,OH',
  '"Calloway Home, Inc.",4000002.0,,90002,9001,Calloway Group,OH',
  "Calloway Coastal Co,,5000003,90003,9001,Calloway Group,FL",
  "Tarrow Mutual Insurance Co,4000107,5000107,90107,n/a,,FL",
  "Nonesuch Specialty Co,,,90555,,,TX",
  ",4000999,,,,,",
  "Calloway Insurance Co,4000001,5000001,90001,9001,Calloway Group,OH",
].join("\n");
const r = readCompanies(LIST);
ok("a list is read from its heading row down", r.ok && r.headingRow === 3 && r.companies.length === 4, r);
ok("each company keeps its ids, codes and group", same(r.companies[0], { companyId: "4000001", companyName: "Calloway Insurance Co", naicCompanyCode: "90001", institutionId: "5000001", spStatEntityId: null, naicGroupCode: "9001", naicGroupName: "Calloway Group" }), r.companies[0]);
ok("a company with only an institution id is kept", same([r.companies[2].companyId, r.companies[2].institutionId, entityKey(r.companies[2])], [null, "5000003", "i.5000003"]));
ok("blank and n/a cells are empty, not text", r.companies[3].naicGroupCode === null && r.companies[3].naicGroupName === null && r.companies[1].institutionId === null);
ok("rows with no S&P id, or no name, are left out and counted", same(r.skipped, { noName: 1, noId: 1 }));
ok("a repeated company is loaded once and counted", r.duplicates === 1 && r.companies.filter((c) => c.companyId === "4000001").length === 1);
ok("the columns used and not used are reported", r.columns.companyId === "S&P Company ID" && r.columns.institutionId === "SNL Institution Key" && r.columns.spStatEntityId === null && same(r.unused, ["State"]));
ok("the counts say how many have each kind of id", same(r.counts, { withCompanyId: 3, institutionOnly: 1, withNaic: 4, withGroup: 3 }));
const noIds = readCompanies("Company Name,State\nCalloway Insurance Co,OH\n");
ok("a list with no S&P id column is refused, saying what it needs and what the first row reads", noIds.ok === false && /needs a company name column and an S&P company id or institution id column/.test(noIds.message) && same(noIds.headings, ["Company Name", "State"]), noIds);

// ---------- the rows saved ----------
const rows = toStoreRows(r.companies, "2026-11-13T12:00:00.000Z");
ok("a company is saved under entity:<company id>, labelled with name, NAIC code and group", same([rows[0].id, rows[0].kind, rows[0].label, rows[0].fetched_at], ["entity:4000001", "entity", "Calloway Insurance Co | NAIC 90001 | Calloway Group", "2026-11-13T12:00:00.000Z"]) && same(rows[0].doc, r.companies[0]));
ok("a company with only an institution id is saved under entity:i.<institution id>", rows[2].id === "entity:i.5000003" && entityLabel(r.companies[2]) === "Calloway Coastal Co | NAIC 90003 | Calloway Group");
ok("every saved id passes the database's check on saved rows", rows.every((x) => /^(ref|search|entity|discover|statutory):[A-Za-z0-9_.:-]{1,80}$/.test(x.id)));
ok("rows go to the database in batches of 500", same(batches(Array.from({ length: 1201 }, (_, i) => i)).map((b) => b.length), [500, 500, 201]));
const said = describe(r);
ok("the summary is in plain words and shows the first companies", said.includes('S&P company id           "S&P Company ID"') && said.includes("4 companies to load:") && said.includes("1 with an institution id only")
  && said.includes("1 rows left out: no S&P company id or institution id") && said.includes("Calloway Insurance Co | NAIC 90001 | Calloway Group  [company id 4000001]") && said.includes('Columns not used: "State"'), said);

// ---------- the command, against a stand-in for Supabase ----------
const saved = new Map(), log = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers.apikey, prefer: req.headers.prefer, rows: raw ? JSON.parse(raw).length : 0 });
    if (url.pathname === "/rest/v1/snl_store" && req.method === "POST") {
      for (const row of JSON.parse(raw)) saved.set(row.id, row);
      res.writeHead(201, { "content-type": "application/json" }); return res.end("[]");
    }
    if (url.pathname === "/rest/v1/snl_store" && req.method === "HEAD") { res.writeHead(200, { "content-range": `0-0/${saved.size}`, "content-type": "application/json" }); return res.end(); }
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "no stand-in for " + req.method + " " + url.pathname }));
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "snl-companies-"));
const file = join(dir, "list.csv");
writeFileSync(file, LIST);
const run = (args, env = { SUPABASE_URL: base + "/rest/v1/", SUPABASE_SECRET_KEY: "test-secret-key" }) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});

const usage = await run([]);
ok("with no command it prints how to use it", usage.status === 0 && /check <file\.csv> \| load <file\.csv> \| count/.test(usage.out), usage.out);
const check = await run(["check", file], {});
ok("check shows what would be loaded, needs no key and sends nothing", check.status === 0 && check.out.includes("4 companies to load:") && check.out.includes("Nothing was changed.") && log.length === 0, check.out);
const excel = await run(["check", join(dir, "list.xlsx")], {});
ok("an Excel file is turned away with how to save it as CSV", excel.status === 1 && /File > Save As > CSV UTF-8/.test(excel.out), excel.out);
const absent = await run(["check", join(dir, "nothing.csv")], {});
ok("a file that isn't there says so", absent.status === 1 && /Couldn't open/.test(absent.out), absent.out);
const badFlag = await run(["check", file, "--colour", "blue"], {});
ok("an unknown option is refused", badFlag.status === 1 && /Unknown option --colour/.test(badFlag.out), badFlag.out);
const noKey = await run(["load", file], {});
ok("load without the address and secret key stops and says what to set", noKey.status === 1 && /Set SUPABASE_URL and SUPABASE_SECRET_KEY first/.test(noKey.out) && log.length === 0, noKey.out);

const load = await run(["load", file]);
ok("load saves every company and says how many", load.status === 0 && /Loaded 4 companies\./.test(load.out) && saved.size === 4, load.out);
ok("it upserts by id with the secret key, so loading again updates and never duplicates", log.length === 1 && log[0].method === "POST" && log[0].query.on_conflict === "id" && /resolution=merge-duplicates/.test(log[0].prefer) && log[0].key === "test-secret-key" && log[0].rows === 4, log);
ok("what is saved is exactly the directory's row shape", same(saved.get("entity:4000001").doc, r.companies[0]) && saved.get("entity:4000001").kind === "entity" && saved.get("entity:i.5000003").label === "Calloway Coastal Co | NAIC 90003 | Calloway Group");
await run(["load", file]);
ok("loading the same list twice leaves the same companies", saved.size === 4);
const named = await run(["check", file, "--naic", "NAIC Group Code"], {});
ok("a column named with a flag is the one used", named.status === 0 && named.out.includes('NAIC company code        "NAIC Group Code"'), named.out);
const count = await run(["count"]);
ok("count reports how many companies the directory holds", count.status === 0 && /The directory holds 4 companies\./.test(count.out), count.out);

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
