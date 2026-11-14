// Companies the company list gives a NAIC company code but no S&P id: saved in the directory, found by name or
// NAIC code (for the Statutory view), shown once when the same company later turns up with an S&P id, and never
// offered to a filing search. Runs the real database adapter (supabaseDb) against a small in-memory stand-in for
// the Supabase client that answers the few queries the directory makes. Every company and code is made up.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { canSearchFilings, type Entity, entityKey, supabaseDb } from "../../supabase/functions/_shared/db.ts";
import { entitiesFrom, parseSearch, resolveEntity } from "../../supabase/functions/_shared/filings.ts";
import * as companiesLib from "../../scripts/companies-lib.mjs";
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
// deno-lint-ignore no-explicit-any
const lib: any = companiesLib;   // plain JavaScript, read without types
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ROW_ID = /^(ref|search|entity|discover|statutory):[A-Za-z0-9_.:-]{1,80}$/;   // the check on snl_store.id, migration 0001
const ENT = (over: Partial<Entity>): Entity => ({ companyId: null, companyName: "Nonesuch Specialty Co", naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...over });

/** snl_store in memory, behind the query chain supabaseDb uses for the directory: upsert, and select with eq,
    or (exact matches on doc fields), ilike on the label, order and limit. */
function storeSb() {
  const rows = new Map<string, { id: string; kind: string; label: string; doc: Record<string, unknown> }>();
  const client = {
    from: (_table: string) => {
      const q: { filters: ((r: any) => boolean)[]; limit: number; order: boolean; upsert?: any[] } = { filters: [], limit: 1000, order: false };
      const chain: any = {
        select: () => chain,
        eq: (col: string, v: string) => { q.filters.push((r) => r[col] === v); return chain; },
        or: (expr: string) => {
          const parts = expr.split(",").map((p) => p.match(/^doc->>(\w+)\.eq\.(.*)$/)!);
          q.filters.push((r) => parts.some((m) => String(r.doc?.[m[1]] ?? "") === m[2]));
          return chain;
        },
        ilike: (col: string, pat: string) => { const t = pat.replace(/^%|%$/g, "").toLowerCase(); q.filters.push((r) => String(r[col]).toLowerCase().includes(t)); return chain; },
        order: () => { q.order = true; return chain; },
        limit: (n: number) => { q.limit = n; return chain; },
        upsert: (list: any[]) => { q.upsert = list; return chain; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => {
          if (q.upsert) { for (const r of q.upsert) { if (!ROW_ID.test(r.id)) return { data: null, error: { message: "violates check constraint" } }; rows.set(r.id, structuredClone(r)); } return { data: null, error: null }; }
          let out = [...rows.values()].filter((r) => q.filters.every((f) => f(r)));
          if (q.order) out = out.sort((a, b) => a.label.localeCompare(b.label));
          return { data: out.slice(0, q.limit).map((r) => ({ doc: structuredClone(r.doc) })), error: null };
        }).then(res, rej),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { rows, client };
}

// ---------- the key ----------
{
  const naicOnly = ENT({ naicCompanyCode: "90555" });
  ok("a company with only a NAIC company code is saved under n.<code>", entityKey(naicOnly) === "n.90555");
  ok("that key passes the database's check on saved rows", ROW_ID.test(`entity:${entityKey(naicOnly)}`));
  ok("an S&P company id or institution id still wins over the NAIC code", entityKey(ENT({ companyId: "4000555", naicCompanyCode: "90555" })) === "4000555" && entityKey(ENT({ institutionId: "5000555", naicCompanyCode: "90555" })) === "i.5000555");
  ok("no S&P id and no usable NAIC code means no key", [null, "", "90-55", "1234567", "9O555", "90555 OR 1=1"].every((c) => entityKey(ENT({ naicCompanyCode: c })) === null));
  ok("a NAIC-only company can't be used by a filing search; one with either S&P id can", canSearchFilings(naicOnly) === false && canSearchFilings(ENT({ companyId: "1" })) && canSearchFilings(ENT({ institutionId: "1" })));
  const cases = [naicOnly, ENT({ companyId: "4000001", naicCompanyCode: "90001" }), ENT({ institutionId: "5000003" }), ENT({ naicCompanyCode: "1234567" }), ENT({}), ENT({ naicCompanyCode: "90-55" })];
  ok("the company-list script keys every company exactly as the functions do", same(cases.map((e) => lib.entityKey(e)), cases.map((e) => entityKey(e))) && same(cases.map((e) => lib.canSearchFilings(e)), cases.map((e) => canSearchFilings(e))), cases.map((e) => [lib.entityKey(e), entityKey(e)]));
}

// ---------- saved, found and de-duplicated ----------
{
  const sb = storeSb(), db = supabaseDb(sb.client, () => Date.parse("2026-11-13T12:00:00Z"));
  await db.putEntities([ENT({ naicCompanyCode: "90555", naicGroupCode: "9055", naicGroupName: "Nonesuch Group" }), ENT({ companyName: "Nonesuch Lost Co" })]);
  ok("a NAIC-only company is saved as entity:n.<code>, labelled with its name, code and group", same([...sb.rows.values()].map((r) => [r.id, r.label]), [["entity:n.90555", "Nonesuch Specialty Co | NAIC 90555 | Nonesuch Group"]]), [...sb.rows.keys()]);
  ok("a company with no S&P id and no NAIC code is still not saved", ![...sb.rows.keys()].some((k) => k.includes("Lost")) && sb.rows.size === 1);

  const byName = await db.findEntities("nonesuch spec", 50), byCode = await db.findEntities("90555", 50);
  ok("it is found by part of its name", same(byName.map((e) => entityKey(e)), ["n.90555"]), byName);
  ok("it is found by its NAIC code", same(byCode.map((e) => entityKey(e)), ["n.90555"]), byCode);
  const r = await resolveEntity(db, "Nonesuch");
  ok("the resolve action returns it with no S&P ids, so nothing can send it to a filing search", r.matches.length === 1 && r.matches[0].companyId === null && r.matches[0].institutionId === null && r.matches[0].naicCompanyCode === "90555" && r.note === null, r);

  // Later a filing search names the same company with its S&P company id.
  await db.putEntities(entitiesFrom([{ companyId: 4000555, companyName: "Nonesuch Specialty Co", naicCompanyCode: "90555", institutionId: null, spStatEntityId: null } as any]));
  ok("both rows are kept in the directory (the import never deletes)", sb.rows.has("entity:n.90555") && sb.rows.has("entity:4000555"), [...sb.rows.keys()]);
  const again = await db.findEntities("90555", 50), againName = await db.findEntities("Nonesuch", 50);
  ok("by NAIC code the company is listed once, with its S&P id", same(again.map((e) => entityKey(e)), ["4000555"]), again);
  ok("by name the company is listed once, with its S&P id", same(againName.map((e) => entityKey(e)), ["4000555"]), againName);

  await db.putEntities([ENT({ companyName: "Nonesuch Mutual Co", naicCompanyCode: "90556" })]);
  ok("a different NAIC-only company with a similar name is not swallowed", same((await db.findEntities("Nonesuch", 50)).map((e) => entityKey(e)).sort(), ["4000555", "n.90556"]));
}

// ---------- never used for a filing search ----------
{
  ok("results from S&P never make a NAIC-only company", entitiesFrom([{ companyId: null, companyName: "Nonesuch Specialty Co", naicCompanyCode: "90555" } as any]).length === 0);
  const p = parseSearch({ companyIds: [], institutionIds: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13" }, "2026-11-13");
  ok("a filing search with no S&P id is refused, whatever NAIC codes the page holds", p.ok === false && /company id or an institution id/.test((p as { message: string }).message), p);
}

// ---------- the import ----------
{
  const LIST = [
    "Company Name,S&P Company ID,NAIC Company Code,NAIC Group Code,NAIC Group Name",
    "Calloway Insurance Co,4000001,90001,9001,Calloway Group",
    "Calloway Insurance Co,,90001,9001,Calloway Group",
    "Nonesuch Specialty Co,,90555,9055,Nonesuch Group",
    "Nonesuch Lost Co,,,,",
  ].join("\n");
  const r = lib.readCompanies(LIST);
  ok("the import keeps a NAIC-only company", r.ok && r.companies.some((c: Entity) => lib.entityKey(c) === "n.90555"), r);
  ok("a NAIC-only row for a company another row lists with an S&P id is dropped and counted as a repeat", r.companies.length === 2 && !r.companies.some((c: Entity) => lib.entityKey(c) === "n.90001") && r.duplicates === 1, r.companies);
  ok("a row with no S&P id and no NAIC code is left out and counted", r.skipped.noId === 1);
  ok("the counts split companies usable for filings from those for statutory figures only", r.counts.withCompanyId === 1 && r.counts.institutionOnly === 0 && r.counts.naicOnly === 1 && r.counts.withNaic === 2, r.counts);
  ok("NAIC-only rows are saved under entity:n.<code>, which the database accepts", same(lib.toStoreRows(r.companies, "2026-11-13T12:00:00.000Z").map((x: { id: string }) => x.id), ["entity:4000001", "entity:n.90555"]) && lib.toStoreRows(r.companies, "x").every((x: { id: string }) => ROW_ID.test(x.id)));
  const said = lib.describe(r);
  ok("the summary says how many can be used for filings and how many for statutory figures only", said.includes("1 can be used to search filings:") && said.includes("1 for statutory figures only: a NAIC company code but no S&P id") && said.includes("[NAIC code only: statutory figures, no filings]"), said);
  const naicOnlyList = lib.readCompanies("Company Name,NAIC Code\nNonesuch Specialty Co,90555\n");
  ok("a list with a name and NAIC codes but no S&P id column is accepted", naicOnlyList.ok && naicOnlyList.companies.length === 1 && naicOnlyList.counts.naicOnly === 1, naicOnlyList);
}

done();
