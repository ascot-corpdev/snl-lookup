// Migration 0005 (supabase/migrations/0005_filing_digests.sql), read as text like watch_migration_test.ts reads 0003: row
// level security on, logins read only, the service role writes, anon gets nothing, safe to run twice, the search index
// and the generated word column, no extension needed, and the columns and limits match what the functions write. Then
// the function's entry in config.toml.
import { buildDigest, checkDigest, digestId, digestRow, metaFrom } from "../../supabase/functions/_shared/digest.ts";
import { checks } from "./helpers/fakes.ts";
import { goodRaw } from "./helpers/digests.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const root = new URL("../../supabase/", import.meta.url);
const raw = Deno.readTextFileSync(new URL("migrations/0005_filing_digests.sql", root));

/** SQL statements with comments removed, lower-cased and single-spaced. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of sql.split("\n")) {
    for (const part of line.replace(/--.*$/, "").split(/(;)/)) {
      if (part === ";") { if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " ").toLowerCase()); cur = ""; }
      else cur += part;
    }
    cur += "\n";
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " ").toLowerCase());
  return out;
}
const st = statements(raw);
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const bare = (t: string) => t.replace(/^public\./, "");
const tables = st.map((s) => s.match(/^create table (?:if not exists )?public\.(\w+)/)?.[1]).filter(Boolean) as string[];

// ---------- the table and row level security ----------
{
  ok("the migration creates one table, snl_digests", same(tables, ["snl_digests"]), tables);
  ok("it has row level security switched on", st.includes("alter table public.snl_digests enable row level security"));
  ok("row level security is never switched off or bypassed", !st.some((s) => /disable row level security|no force row level security|bypassrls/.test(s)));
  ok("it touches no table from the earlier migrations", !st.some((s) => /public\.(profiles|snl_store|snl_usage|snl_throttle|snl_jobs|snl_job_state|snl_settings|snl_keepalive|snl_watch_runs|snl_watch_found)\b/.test(s)));
  ok("it needs no extension, so it runs on Supabase's free plan as it is", !st.some((s) => /create extension|gin_trgm_ops|pg_trgm/.test(s)));
}

// ---------- safe to run twice ----------
{
  ok("the table is created only if it isn't there", st.filter((s) => s.startsWith("create table")).every((s) => s.startsWith("create table if not exists public.")));
  const idx = st.filter((s) => /^create (unique )?index/.test(s));
  ok("every index is created only if it isn't there: five of them", idx.length === 5 && idx.every((s) => /^create (unique )?index if not exists /.test(s)), idx);
  const pols = st.filter((s) => s.startsWith("create policy"));
  ok("the policy is dropped first if it exists, so running again replaces it", pols.length === 1 && st.indexOf('drop policy if exists "read: any login" on public.snl_digests') >= 0 && st.indexOf('drop policy if exists "read: any login" on public.snl_digests') < st.indexOf(pols[0]));
  ok("nothing is inserted, dropped or altered that a second run would trip on", !st.some((s) => /^(insert|drop table|drop index|alter table .* (add|drop) column|create function|create trigger)/.test(s)));
}

// ---------- grants ----------
type Grant = { privs: string[]; tables: string[]; roles: string[] };
const grants: Grant[] = st.map((s) => s.match(/^grant (.+?) on (?!function)(.+?) to (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const revokes: Grant[] = st.map((s) => s.match(/^revoke (.+?) on (?!function)(.+?) from (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const privsOf = (role: string) => [...new Set(grants.filter((g) => g.roles.includes(role) && g.tables.includes("snl_digests")).flatMap((g) => g.privs))].sort();
{
  for (const role of ["anon", "authenticated"]) ok(`all rights are revoked from ${role}`, revokes.some((r) => r.privs.includes("all") && r.roles.includes(role) && r.tables.includes("snl_digests")));
  const lastRevoke = Math.max(...st.map((s, i) => (/^revoke /.test(s) ? i : -1))), firstGrant = st.findIndex((s) => /^grant /.test(s));
  ok("the revoke comes before the grants", lastRevoke >= 0 && firstGrant > lastRevoke);
  ok("anon is granted nothing", !st.some((s) => /^grant\b/.test(s) && /\banon\b/.test(s)) && !st.some((s) => /with grant option|to public\b(?!\.)/.test(s)));
  ok("a login may only read", same(privsOf("authenticated"), ["select"]), privsOf("authenticated"));
  ok("the service role, which the functions use, can read and write", same(privsOf("service_role"), ["delete", "insert", "select", "update"]));
  ok("only authenticated and service_role are named in grants", grants.every((g) => g.roles.every((r) => ["authenticated", "service_role"].includes(r))));
  const pol = st.find((s) => s.startsWith("create policy"))!;
  ok("one policy: read only, for logins with a profile", / for select to authenticated using \(public\.app_role\(\) is not null\)$/.test(pol), pol);
}

// ---------- columns, search and limits ----------
const s = st.find((x) => x.startsWith("create table if not exists public.snl_digests ("))!;
const body = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
const parts: string[] = [];
{ let depth = 0, cur = ""; for (const ch of body) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) parts.push(cur.trim()); }
const cols = parts.filter((p) => !p.startsWith("check ")).map((c) => ({ name: c.split(" ")[0], def: c }));
const col = (n: string) => cols.find((c) => c.name === n)!.def;
{
  const d = buildDigest(metaFrom({ documentId: 71000001, filingVersionId: "0B0B0B0B-0000-4000-8000-000000000001", companyName: "Calloway Home Co", serffFilingStateId: "FL" }), checkDigest(goodRaw(), [{ from: 1, to: 150 }]).fields!, [{ from: 1, to: 150 }], "2026-11-18T05:00:00.000Z");
  const row = digestRow(d, digestId(d)!);
  ok("the table has the columns a saved summary has, plus the generated word column", same(cols.map((c) => c.name).sort(), [...Object.keys(row), "search_text"].sort()), { table: cols.map((c) => c.name), row: Object.keys(row) });
  ok("one row per filing: the key is the filing's version id, or its document id", col("id").includes("primary key") && col("id").includes("check (id ~ '^(v:[a-za-z0-9._-]{8,64}|d:[0-9]{1,15})$')"));
  ok("the keys the functions write fit the key's rule", ["v:0B0B0B0B-0000-4000-8000-000000000001", "d:71000001"].every((k) => /^(v:[A-Za-z0-9._-]{8,64}|d:[0-9]{1,15})$/.test(k)) && digestId(d) === "v:0B0B0B0B-0000-4000-8000-000000000001" && digestId({ filingVersionId: null, documentId: 5 }) === "d:5");
  ok("a row needs one of the two ids", parts.includes("check (filing_version_id is not null or document_id is not null)"));
  ok("the word column is generated from the searchable text with Postgres's English word search, and stored", col("search_text") === "search_text tsvector generated always as (to_tsvector('english'::regconfig, search_body)) stored");
  ok("the word column has a GIN index, and state and date have the indexes search's order needs", st.includes("create index if not exists snl_digests_search on public.snl_digests using gin (search_text)") && st.includes("create index if not exists snl_digests_state_made on public.snl_digests (state, made_at desc)") && st.includes("create index if not exists snl_digests_made on public.snl_digests (made_at desc)"));
  ok("summaries are found by either id through an index", st.includes("create index if not exists snl_digests_version on public.snl_digests (filing_version_id)") && st.includes("create index if not exists snl_digests_document on public.snl_digests (document_id)"));
  ok("the summary itself is a JSON object of bounded size", col("doc") === "doc jsonb not null check (jsonb_typeof(doc) = 'object' and pg_column_size(doc) < 262144)");
  const limit = (n: string) => Number(col(n).match(/length\(\w+\) <= (\d+)/)?.[1]);
  ok("text columns have limits at least as large as what the functions write", limit("company") === 200 && limit("form_keys") === 4000 && limit("search_body") === 20000, [limit("company"), limit("form_keys"), limit("search_body")]);
  ok("state is two capital letters or null, as the functions write it", col("state") === "state text check (state is null or state ~ '^[a-z]{2}$')");
}

// ---------- config.toml ----------
{
  const toml = Deno.readTextFileSync(new URL("config.toml", root));
  ok("config.toml deploys snl-digest with the gateway's login check off, like the others", /\[functions\.snl-digest\]\nverify_jwt = false/.test(toml));
  ok("and still lists every other function", ["snl-filings", "snl-statutory", "snl-chat", "snl-watch", "snl-profile"].every((f) => toml.includes(`[functions.${f}]\nverify_jwt = false`)));
}

done();
