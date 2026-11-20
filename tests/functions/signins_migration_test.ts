// Migration 0011 (supabase/migrations/0011_signins.sql), read as text like library_migration_test.ts reads 0007:
// row level security on, only Corp Dev logins read, readers and anon get nothing, nobody writes but the function,
// safe to run twice, the columns and checks match what snl-signin writes, and rows go after 90 days.
import { NOTICES, SIGNIN_KEEP_DAYS, sessionKey, type SigninRow } from "../../supabase/functions/_shared/signins.ts";
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const raw = Deno.readTextFileSync(new URL("../../supabase/migrations/0011_signins.sql", import.meta.url));

/** SQL statements with comments removed, lower-cased and single-spaced. */
function statements(sql: string): string[] {
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  return code.split(";").map((s) => s.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}
const st = statements(raw);
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const bare = (t: string) => t.replace(/^public\./, "");
const tables = st.map((s) => s.match(/^create table (?:if not exists )?public\.(\w+)/)?.[1]).filter(Boolean) as string[];

// ---------- the table and row level security ----------
{
  ok("the migration creates one table, snl_signins", same(tables, ["snl_signins"]), tables);
  ok("row level security is switched on", st.includes("alter table public.snl_signins enable row level security"));
  ok("row level security is never switched off or bypassed", !st.some((s) => /disable row level security|no force row level security|bypassrls|security definer/.test(s)));
  ok("it changes no table from earlier migrations", !st.some((s) => /^(alter|drop|insert|update|delete|grant|revoke).*public\.(profiles|snl_store|snl_usage|snl_throttle|snl_jobs|snl_job_state|snl_settings|snl_watch_runs|snl_watch_found|snl_library)\b/.test(s)));
}

// ---------- safe to run twice ----------
{
  ok("the table is created only if it isn't there", st.filter((s) => s.startsWith("create table")).every((s) => s.startsWith("create table if not exists public.")));
  const idx = st.filter((s) => /^create (unique )?index/.test(s));
  ok("every index is created only if it isn't there", idx.length === 2 && idx.every((s) => /^create (unique )?index if not exists /.test(s)), idx);
  const pols = st.filter((s) => s.startsWith("create policy"));
  ok("every policy is dropped first if it exists", pols.length === 1 && pols.every((p) => {
    const m = p.match(/^create policy "([^"]+)" on (public\.\w+)/)!;
    const drop = st.indexOf(`drop policy if exists "${m[1]}" on ${m[2]}`);
    return drop >= 0 && drop < st.indexOf(p);
  }));
  ok("nothing is inserted, dropped or altered that a second run would trip on", !st.some((s) => /^(insert|drop table|drop index|alter table .* (add|drop) column|create function|create or replace function|create trigger)/.test(s)));
}

// ---------- grants and policies ----------
type Grant = { privs: string[]; tables: string[]; roles: string[] };
const grants: Grant[] = st.map((s) => s.match(/^grant (.+?) on (.+?) to (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const revokes: Grant[] = st.map((s) => s.match(/^revoke (.+?) on (.+?) from (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const privsOf = (role: string) => [...new Set(grants.filter((g) => g.roles.includes(role) && g.tables.includes("snl_signins")).flatMap((g) => g.privs))].sort();
const pols = st.filter((s) => s.startsWith("create policy"));
{
  for (const role of ["anon", "authenticated"]) ok(`all rights are revoked from ${role} first`, revokes.some((r) => r.privs.includes("all") && r.roles.includes(role) && r.tables.includes("snl_signins")));
  const lastRevoke = Math.max(...st.map((s, i) => (/^revoke /.test(s) ? i : -1))), firstGrant = st.findIndex((s) => /^grant /.test(s));
  ok("the revoke comes before the grants", lastRevoke >= 0 && firstGrant > lastRevoke);
  ok("anon is granted nothing", privsOf("anon").length === 0 && !st.some((s) => /^grant\b/.test(s) && /\banon\b/.test(s)) && !st.some((s) => /with grant option|to public\b(?!\.)/.test(s)));
  ok("a login may only read (and the policy decides which logins see rows)", same(privsOf("authenticated"), ["select"]), privsOf("authenticated"));
  ok("the service role, which the function uses, can read and write", same(privsOf("service_role"), ["delete", "insert", "select", "update"]));
  ok("one policy: read only, for logins whose role is Corp Dev", pols.length === 1 && / on public\.snl_signins for select to authenticated using \(public\.app_role\(\) = 'corpdev'\)$/.test(pols[0]), pols);
  ok("no insert, update or delete policy for logins", !pols.some((p) => / for (insert|update|delete|all) /.test(p)));
}
{
  // The policy's condition, worked out for each kind of caller: app_role() is the caller's profile role, or null
  // for a login with no profile. anon has no grant at all, so it never gets as far as the policy.
  const cond = pols[0].match(/using \((.+)\)$/)![1];
  const sees = (role: string | null) => {
    const m = cond.match(/^public\.app_role\(\) = '(\w+)'$/);
    if (!m) throw new Error("unexpected policy " + cond);
    return role !== null && role === m[1];
  };
  ok("Corp Dev can read the record of sign-ins", sees("corpdev") && privsOf("authenticated").includes("select"));
  ok("readers can't read it: the policy hides every row from them", !sees("reader"));
  ok("a login with no profile can't read it", !sees(null));
  ok("anonymous visitors can't read it: no grant", !privsOf("anon").includes("select"));
}

// ---------- the columns match what the function writes ----------
const cols = (() => {
  const s = st.find((x) => x.startsWith("create table if not exists public.snl_signins ("))!;
  const body = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of body) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out.map((c) => ({ name: c.split(" ")[0], def: c }));
})();
const def = (name: string) => cols.find((c) => c.name === name)?.def ?? "";
{
  const row: SigninRow = { session_key: await sessionKey("sam.reader@example.com", 1, 2), email: "sam.reader@example.com", role: "reader", first_seen_at: "", last_seen_at: "", notice: "pending" };
  ok("the table has exactly the columns the function writes", same(cols.map((c) => c.name).sort(), Object.keys(row).sort()), cols.map((c) => c.name));
  ok("one row per session: the session key is the primary key, so a second insert of it does nothing on conflict", def("session_key").includes("primary key"));
  ok("the session key is a SHA-256 in hex, as the function makes it", def("session_key").includes("check (session_key ~ '^[0-9a-f]{64}$')") && new RegExp("^[0-9a-f]{64}$").test(row.session_key));
  ok("the email is kept in lower case", def("email").includes("email = lower(email)") && def("email").includes("length(email) between 3 and 254"));
  ok("the role is Corp Dev or reader, as on profiles", def("role").includes("check (role in ('corpdev', 'reader'))"));
  ok("first and last seen are times, set by default", def("first_seen_at") === "first_seen_at timestamptz not null default now()" && def("last_seen_at") === "last_seen_at timestamptz not null default now()");
  ok("the notice is one of the function's values", def("notice").includes(`check (notice in (${NOTICES.map((n) => `'${n}'`).join(", ")}))`), def("notice"));
  ok("nothing sensitive has a column: no token, no IP address, no key, no page or search", !cols.some((c) => /token|jwt|ip|addr|key_|secret|password|country|agent|query|search|page/.test(c.name.replace("session_key", ""))));
  ok("newest first is quick: an index on first seen", st.includes("create index if not exists snl_signins_first_seen on public.snl_signins (first_seen_at desc)"));
}

// ---------- 90 days ----------
{
  ok("the function keeps rows 90 days", SIGNIN_KEEP_DAYS === 90);
  ok("the migration says rows go after 90 days, and that the function removes them", /Rows not seen for 90 days are removed by the function/.test(raw));
  ok("the clear-out by last seen is quick: an index on last seen", st.includes("create index if not exists snl_signins_last_seen on public.snl_signins (last_seen_at)"));
  ok("no schedule is added for it", !/cron\.|pg_cron|schedule/i.test(st.join(";")));
}

ok("the migration holds no secret, key or real address", !/sk-ant-|re_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}|password\s*=|@(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i.test(raw));
done();
