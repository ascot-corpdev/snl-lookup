#!/usr/bin/env node
// Load a list of insurance companies into SNL lookup's company directory, so people can find a company or a
// whole group by name or NAIC code instead of typing S&P ids. Runs on your own machine with the Supabase secret
// key. The list itself never goes into the repository: it may be S&P's data.
//
//   node scripts/companies.mjs check <file.csv>     show what would be loaded; changes nothing
//   node scripts/companies.mjs load <file.csv>      load it (companies already there are updated, none removed)
//   node scripts/companies.mjs count                how many companies the directory holds
//
// The file is a CSV (in Excel: File > Save As > CSV UTF-8). It needs a company name column and an S&P company
// id or institution id column; NAIC codes and group names are used when present. Headings are matched
// automatically. To name a column yourself:
//   --name "..."  --company-id "..."  --institution-id "..."  --naic "..."  --group-code "..."  --group-name "..."  --stat-id "..."
//
// Needs for load and count: SUPABASE_URL and SUPABASE_SECRET_KEY (the sb_secret_... key), as for logins.mjs.

import { readFileSync } from "node:fs";
import { batches, describe, FLAGS, readCompanies, toStoreRows } from "./companies-lib.mjs";

const USAGE = 'Usage: node scripts/companies.mjs check <file.csv> | load <file.csv> | count   (optional: --name "Heading" --company-id "Heading" --institution-id "Heading" --naic "Heading" --group-code "Heading" --group-name "Heading" --stat-id "Heading")';

const args = process.argv.slice(2);
const cmd = args.shift();
const named = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] in FLAGS) { named[FLAGS[args[i]]] = args[++i] ?? ""; }
  else if (args[i].startsWith("--")) { console.error(`Unknown option ${args[i]}.\n${USAGE}`); process.exit(1); }
  else rest.push(args[i]);
}

function read(file) {
  if (!file) { console.error(`Give the list's file name.\n${USAGE}`); process.exit(1); }
  if (/\.xlsx?$/i.test(file)) { console.error("That is an Excel file. In Excel choose File > Save As > CSV UTF-8, then give this script the .csv file."); process.exit(1); }
  let text;
  try { text = readFileSync(file, "utf8"); } catch { console.error(`Couldn't open ${file}. Check the name and the folder you are in.`); process.exit(1); }
  const r = readCompanies(text, named);
  if (!r.ok) {
    console.error(r.message);
    if (r.headings?.length) console.error(`The first row reads: ${r.headings.map((h) => `"${h}"`).join(", ")}`);
    process.exit(1);
  }
  return r;
}

async function database() {
  // Accept the URL as copied from anywhere in the dashboard: keep only https://<ref>.supabase.co
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/(rest|auth)\/v1$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SECRET_KEY first (Supabase dashboard > Project settings > API Keys; the secret key starts with sb_secret_).");
    process.exit(1);
  }
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

try {
  if (cmd === "check") {
    const r = read(rest[0]);
    console.log(describe(r));
    console.log("\nNothing was changed. If this looks right, run the same command with load in place of check.");
  } else if (cmd === "load") {
    const r = read(rest[0]);
    console.log(describe(r));
    if (!r.companies.length) { console.error("\nNothing to load."); process.exit(1); }
    const sb = await database();
    const rows = toStoreRows(r.companies, new Date().toISOString());
    let done = 0;
    for (const batch of batches(rows)) {
      const { error } = await sb.from("snl_store").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`The database refused the list after ${done.toLocaleString("en-US")} companies: ${error.message}`);
      done += batch.length;
    }
    console.log(`\nLoaded ${done.toLocaleString("en-US")} companies. They can be found by name or NAIC code on the Filings view straight away.`);
  } else if (cmd === "count") {
    const sb = await database();
    const { count, error } = await sb.from("snl_store").select("id", { count: "exact", head: true }).eq("kind", "entity");
    if (error) throw error;
    console.log(`The directory holds ${(count ?? 0).toLocaleString("en-US")} companies.`);
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
