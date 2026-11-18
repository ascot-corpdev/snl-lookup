#!/usr/bin/env node
// Load a list of insurance companies into SNL lookup's company directory, so people can find a company or a
// whole group by name or NAIC code instead of typing S&P ids. Runs on your own machine with the Supabase secret
// key. The list itself never goes into the repository: it may be S&P's data.
//
//   node scripts/companies.mjs check <file.csv>     show what would be loaded; changes nothing
//   node scripts/companies.mjs load <file.csv>      load it (companies already there are updated, none removed)
//   node scripts/companies.mjs count                how many companies the directory holds
//   node scripts/companies.mjs tidy [--apply]       find companies saved twice and, with --apply, merge each into one row
//
// The file is a CSV (in Excel: File > Save As > CSV UTF-8). It needs a company name column and an S&P company
// id, institution id or NAIC company code column; group names and codes are used when present. A company with
// an S&P id can be searched for filings; one with a NAIC code can be found by name on the Statutory view. Headings are matched
// automatically. To name a column yourself:
//   --name "..."  --company-id "..."  --institution-id "..."  --naic "..."  --group-code "..."  --group-name "..."  --stat-id "..."
//
// Needs for load and count: SUPABASE_URL and SUPABASE_SECRET_KEY (the sb_secret_... key), as for logins.mjs.

import { readFileSync } from "node:fs";
import { batches, describe, entityIdsOf, FLAGS, planEntityWrites, planRows, readCompanies, tidyPlan } from "./companies-lib.mjs";

const USAGE = 'Usage: node scripts/companies.mjs check <file.csv> | load <file.csv> | count | tidy [--apply]   (optional: --name "Heading" --company-id "Heading" --institution-id "Heading" --naic "Heading" --group-code "Heading" --group-name "Heading" --stat-id "Heading")';

const args = process.argv.slice(2);
const cmd = args.shift();
const named = {};
const rest = [];
let apply = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] in FLAGS) { named[FLAGS[args[i]]] = args[++i] ?? ""; }
  else if (args[i] === "--apply" && cmd === "tidy") apply = true;
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

/** Saved company rows whose company id, institution id or NAIC company code is one of these. */
async function savedRows(sb, ids) {
  const out = new Map();
  for (const k of ["companyId", "institutionId", "naicCompanyCode"]) {
    for (const part of batches(ids[k], 100)) {
      const { data, error } = await sb.from("snl_store").select("id,doc").eq("kind", "entity").in(`doc->>${k}`, part).limit(1000);
      if (error) throw new Error(`Couldn't read the companies already saved: ${error.message}. Nothing was loaded from this batch.`);
      for (const r of data ?? []) out.set(r.id, r);
    }
  }
  return [...out.values()];
}

/** Every saved company row (ids and fields, without labels), a thousand at a time. */
async function allRows(sb) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("snl_store").select("id,doc").eq("kind", "entity").order("id").range(from, from + 999);
    if (error) throw new Error(`Couldn't read the directory: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
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
    // A company the app has already seen in search results has a row of its own: the list's row is merged into it
    // (or it into the list's row), so each company stays one row with everything known about it.
    const at = new Date().toISOString();
    let done = 0, merged = 0, folded = 0;
    for (const batch of batches(r.companies)) {
      const plan = planEntityWrites(await savedRows(sb, entityIdsOf(batch)), batch);
      const { error } = await sb.from("snl_store").upsert(planRows(plan, at), { onConflict: "id" });
      if (error) throw new Error(`The database refused the list after ${done.toLocaleString("en-US")} companies: ${error.message}`);
      if (plan.drop.length) {
        const { error: dropError } = await sb.from("snl_store").delete().eq("kind", "entity").in("id", plan.drop);
        if (dropError) throw new Error(`The list was saved, but a second row of ${plan.drop.length.toLocaleString("en-US")} companies couldn't be removed: ${dropError.message}. Run node scripts/companies.mjs tidy --apply to finish.`);
      }
      done += batch.length; merged += plan.merged; folded += plan.drop.length;
    }
    console.log(`\nLoaded ${done.toLocaleString("en-US")} companies. They can be found by name or NAIC code on the Filings and Statutory views straight away.`);
    if (merged) console.log(`${merged === 1 ? "One of them was" : `${merged.toLocaleString("en-US")} of them were`} already in the directory (loaded before, or seen in search results) and ${merged === 1 ? "was" : "were"} updated in place${folded ? `; ${folded.toLocaleString("en-US")} second ${folded === 1 ? "row" : "rows"} for the same companies merged in and removed` : ""}.`);
  } else if (cmd === "count") {
    const sb = await database();
    const rows = await allRows(sb);
    const t = tidyPlan(rows);
    console.log(`The directory holds ${t.companies.toLocaleString("en-US")} companies${t.duplicates ? ` in ${rows.length.toLocaleString("en-US")} rows: ${t.duplicates.toLocaleString("en-US")} ${t.duplicates === 1 ? "company has" : "companies have"} a second row from before rows were merged. The app reads each as one company; node scripts/companies.mjs tidy --apply merges them` : ""}.`);
  } else if (cmd === "tidy") {
    const sb = await database();
    const rows = await allRows(sb);
    const t = tidyPlan(rows);
    if (!t.duplicates) { console.log(`The directory holds ${t.companies.toLocaleString("en-US")} companies, one row each. Nothing to tidy.`); process.exit(0); }
    console.log(`${t.duplicates.toLocaleString("en-US")} ${t.duplicates === 1 ? "company has" : "companies have"} more than one row. Each would become one row with every id and the group name either row had:`);
    for (const r of t.rows.slice(0, 5)) console.log(`  ${r.doc.companyName || "(no name)"}  [kept: ${r.id}]`);
    if (t.rows.length > 5) console.log(`  and ${(t.rows.length - 5).toLocaleString("en-US")} more`);
    if (!apply) { console.log("\nNothing was changed. To merge them, run the same command with --apply."); process.exit(0); }
    const at = new Date().toISOString();
    for (const batch of batches(planRows(t, at))) {
      const { error } = await sb.from("snl_store").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`The database refused the merged rows: ${error.message}. Nothing was removed.`);
    }
    for (const ids of batches(t.drop, 200)) {
      const { error } = await sb.from("snl_store").delete().eq("kind", "entity").in("id", ids);
      if (error) throw new Error(`The merged rows were saved, but the second rows couldn't be removed: ${error.message}. Run the command again.`);
    }
    console.log(`\nMerged. The directory now holds ${t.companies.toLocaleString("en-US")} companies, one row each.`);
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
