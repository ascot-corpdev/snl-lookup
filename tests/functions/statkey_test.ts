// The S&P statutory entity key as an id that decides whether two company rows are the same company, in the functions
// (db.ts) and in the company-list script alike: a shared key merges, a differing key keeps rows apart, and a key that
// matches while a NAIC code or institution id differs is never merged. Runs the real database adapter (supabaseDb)
// against a small in-memory stand-in for the Supabase client. Every company, id, key and code here is made up.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { collapseEntities, type Entity, entityIdsOf, planEntityWrites, sameCompany, supabaseDb, withSameCompanies } from "../../supabase/functions/_shared/db.ts";
import { entitiesFrom, resolveEntity } from "../../supabase/functions/_shared/filings.ts";
import * as companiesLib from "../../scripts/companies-lib.mjs";
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
// deno-lint-ignore no-explicit-any
const lib: any = companiesLib;   // plain JavaScript, read without types
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const G = "Calloway Group (SNL P&C Group)";
const E = (over: Partial<Entity>): Entity => ({ companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...over });

/** snl_store in memory, behind the query chain supabaseDb uses for the directory. */
function storeSb() {
  const rows = new Map<string, { id: string; kind: string; label: string; doc: Record<string, unknown> }>();
  const reads: string[] = [];
  const client = {
    from: (_table: string) => {
      // deno-lint-ignore no-explicit-any
      const q: { filters: ((r: any) => boolean)[]; limit: number; order: boolean; upsert?: any[]; del?: boolean } = { filters: [], limit: 1000, order: false };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        // deno-lint-ignore no-explicit-any
        eq: (col: string, v: string) => { q.filters.push((r: any) => r[col] === v); return chain; },
        or: (expr: string) => {
          const parts = expr.split(",").map((p) => p.match(/^doc->>(\w+)\.eq\.(.*)$/)!);
          // deno-lint-ignore no-explicit-any
          q.filters.push((r: any) => parts.some((m) => String(r.doc?.[m[1]] ?? "") === m[2]));
          return chain;
        },
        // deno-lint-ignore no-explicit-any
        in: (col: string, vs: string[]) => { reads.push(col); const f = col.startsWith("doc->>") ? (r: any) => vs.includes(String(r.doc?.[col.slice(6)] ?? "")) : (r: any) => vs.includes(r[col]); q.filters.push(f); return chain; },
        delete: () => { q.del = true; return chain; },
        // deno-lint-ignore no-explicit-any
        ilike: (col: string, pat: string) => { const t = pat.replace(/^%|%$/g, "").toLowerCase(); q.filters.push((r: any) => String(r[col]).toLowerCase().includes(t)); return chain; },
        order: () => { q.order = true; return chain; },
        limit: (n: number) => { q.limit = n; return chain; },
        // deno-lint-ignore no-explicit-any
        upsert: (list: any[]) => { q.upsert = list; return chain; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => {
          if (q.upsert) { for (const r of q.upsert) rows.set(r.id, structuredClone(r)); return { data: null, error: null }; }
          if (q.del) { for (const r of [...rows.values()]) if (q.filters.every((f) => f(r))) rows.delete(r.id); return { data: null, error: null }; }
          let out = [...rows.values()].filter((r) => q.filters.every((f) => f(r)));
          if (q.order) out = out.sort((a, b) => a.label.localeCompare(b.label));
          return { data: out.slice(0, q.limit).map((r) => ({ id: r.id, doc: structuredClone(r.doc) })), error: null };
        }).then(res, rej),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  const put = (id: string, doc: Entity) => rows.set(id, { id, kind: "entity", label: [doc.companyName, doc.naicCompanyCode ? `NAIC ${doc.naicCompanyCode}` : "", doc.naicGroupName ?? ""].filter(Boolean).join(" | "), doc: doc as unknown as Record<string, unknown> });
  return { rows, reads, client, put };
}

// ---------- the rules, and the script in step ----------
{
  const pairs: [Entity, Entity, boolean, string][] = [
    [E({ institutionId: "5000001", spStatEntityId: "C1001" }), E({ naicCompanyCode: "90001", spStatEntityId: "C1001" }), true, "a shared key"],
    [E({ institutionId: "5000001", spStatEntityId: "c1001" }), E({ naicCompanyCode: "90001", spStatEntityId: "C1001" }), true, "a shared key in another letter case"],
    [E({ companyId: "4000001", spStatEntityId: "C1001" }), E({ companyId: "4000001", spStatEntityId: "C1002" }), false, "a shared company id but two keys"],
    [E({ spStatEntityId: "C1004", naicCompanyCode: "90099" }), E({ spStatEntityId: "C1004", naicCompanyCode: "90004" }), false, "a shared key but two NAIC codes"],
    [E({ spStatEntityId: "C1004", institutionId: "5000004" }), E({ spStatEntityId: "C1004", institutionId: "5000009" }), false, "a shared key but two institution ids"],
    [E({ spStatEntityId: "C1001" }), E({ naicCompanyCode: "90001" }), false, "nothing shared"],
  ];
  for (const [a, b, want, what] of pairs) ok(`${what}: ${want ? "the same company" : "two companies"}, in the functions and the script`, sameCompany(a, b) === want && lib.sameCompany(a, b) === want);
  ok("the ids to look rows up by include the key, in each letter case, letters and digits only", same(entityIdsOf([E({ spStatEntityId: "C1001" }), E({ spStatEntityId: "x'); drop" })]).spStatEntityId, ["C1001", "c1001"]) && same(lib.entityIdsOf([E({ spStatEntityId: "C1001" })]), entityIdsOf([E({ spStatEntityId: "C1001" })])));

  const saved = [{ id: "entity:i.5000001", doc: E({ institutionId: "5000001", spStatEntityId: "C1001", naicGroupName: G }) }, { id: "entity:4000002", doc: E({ companyName: "Calloway Home Co", companyId: "4000002", spStatEntityId: "C1002" }) }];
  const list = [E({ spStatEntityId: "C1001", naicCompanyCode: "90001", naicGroupCode: "9001", naicGroupName: G }), E({ companyName: "Calloway Home Co", spStatEntityId: "C1002", naicCompanyCode: "90002", naicGroupCode: "9001", naicGroupName: G })];
  const plan = planEntityWrites(saved, list, { fromList: true }), jsPlan = lib.planEntityWrites(saved, list);
  ok("a key-and-NAIC list lands on the rows with S&P ids, which keep their ids", same(plan.rows.map((r) => [r.id, r.doc.naicCompanyCode, r.doc.naicGroupCode]), [["entity:i.5000001", "90001", "9001"], ["entity:4000002", "90002", "9001"]]) && plan.drop.length === 0, plan);
  ok("the script makes the same plan as the functions", same(jsPlan.rows, plan.rows) && same(jsPlan.drop, plan.drop));
  const left = [{ id: "entity:i.5000005", doc: E({ institutionId: "5000005", spStatEntityId: "C1005", naicGroupName: G }) }, { id: "entity:n.90005", doc: E({ spStatEntityId: "C1005", naicCompanyCode: "90005", naicGroupCode: "9001" }) }, { id: "entity:n.90004", doc: E({ spStatEntityId: "C1004", naicCompanyCode: "90004" }) }, { id: "entity:i.5000004", doc: E({ spStatEntityId: "C1004", institutionId: "5000004", naicCompanyCode: "90099" }) }];
  ok("reading: a pair an earlier load left reads as one company; a clash stays two", same(collapseEntities(left.map((r) => r.doc)).map((e) => [e.institutionId, e.naicCompanyCode]), [["5000005", "90005"], [null, "90004"], ["5000004", "90099"]]));
  const t = lib.tidyPlan(left);
  ok("tidy merges the pair into the row with the S&P id and leaves the clash alone", same(t.drop, ["entity:n.90005"]) && t.rows.length === 1 && t.rows[0].id === "entity:i.5000005" && t.rows[0].doc.naicCompanyCode === "90005", t);
}

// ---------- the functions' own saving and finding ----------
{
  const sb = storeSb(), db = supabaseDb(sb.client, () => Date.parse("2026-11-22T12:00:00Z"));
  // a list loaded before this change: one NAIC-only row beside the row with S&P ids, sharing the key
  sb.put("entity:i.5000001", E({ institutionId: "5000001", spStatEntityId: "C1001", naicGroupName: G }));
  sb.put("entity:n.90001", E({ spStatEntityId: "C1001", naicCompanyCode: "90001", naicGroupCode: "9001", naicGroupName: G }));
  const found = await db.findEntities("Calloway", 50);
  ok("Find by name shows the pair once, with the NAIC code, so the Statutory view can add it", found.length === 1 && found[0].naicCompanyCode === "90001" && found[0].institutionId === "5000001" && found[0].naicGroupCode === "9001", found);
  const r = await resolveEntity(db, "5000001");
  ok("found by institution id too, still one company with its code", r.matches.length === 1 && r.matches[0].naicCompanyCode === "90001", r);
  // a filing search later names it with its company id and the same key
  await db.putEntities(entitiesFrom([{ companyId: 4000001, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: null, spStatEntityId: "C1001" } as never]));
  ok("saving search results reads saved rows by key as well", sb.reads.includes("doc->>spStatEntityId"), sb.reads);
  ok("the search result is folded into the list's row: one row with every id, the second row removed", same([...sb.rows.keys()], ["entity:i.5000001"]) && same(sb.rows.get("entity:i.5000001")!.doc, E({ companyId: "4000001", naicCompanyCode: "90001", institutionId: "5000001", spStatEntityId: "C1001", naicGroupCode: "9001", naicGroupName: G })), [...sb.rows.values()]);
  // a result with the same company id as a saved row but another key would be saved under that row's own id: it is
  // merged into it as before (what the saved row knows is kept), never written over it
  sb.put("entity:4000009", E({ companyName: "Tarrow Mutual Insurance Co", companyId: "4000009", spStatEntityId: "C1009", naicCompanyCode: "90009", naicGroupName: "Tarrow Group (SNL P&C Group)" }));
  await db.putEntities([E({ companyName: "Tarrow Mutual Insurance Co", companyId: "4000009", spStatEntityId: "C9999" })]);
  const t9 = sb.rows.get("entity:4000009")!.doc as unknown as Entity;
  ok("a row saved under the same id is merged into, not overwritten: its NAIC code and group stay", t9.naicCompanyCode === "90009" && t9.naicGroupName === "Tarrow Group (SNL P&C Group)" && t9.spStatEntityId === "C9999", t9);
  ok("the script does the same", same(lib.planEntityWrites([{ id: "entity:4000009", doc: E({ companyId: "4000009", spStatEntityId: "C1009", naicCompanyCode: "90009" }) }], [E({ companyId: "4000009", spStatEntityId: "C9999" })]).rows, planEntityWrites([{ id: "entity:4000009", doc: E({ companyId: "4000009", spStatEntityId: "C1009", naicCompanyCode: "90009" }) }], [E({ companyId: "4000009", spStatEntityId: "C9999" })], { fromList: true }).rows));
  ok("withSameCompanies keeps two rows with different keys apart", withSameCompanies([E({ companyId: "1", spStatEntityId: "C1" })], [E({ companyId: "1", spStatEntityId: "C2" })]).length === 1);
}

done();
