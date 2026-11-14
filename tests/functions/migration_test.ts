// Migration 0001 (supabase/migrations/0001_snl.sql), read as text: who can read and write each table, who can run
// each function, and the checks on saved rows. Then the request counter's rules (snl_take_slot) checked through
// the in-memory stand-in the other suites use, so the two can't drift apart unnoticed.
import { PLAN_LIMITS } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, fakeClock, memoryDb } from "./helpers/fakes.ts";
import { storeRules } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dir = new URL("../../supabase/migrations/", import.meta.url);
const raw = Deno.readTextFileSync(new URL("0001_snl.sql", dir));

/** SQL statements with comments removed, lower-cased and single-spaced. Function bodies ($$ ... $$) stay whole. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "", inBody = false;
  for (const line of sql.split("\n")) {
    const code = inBody ? line : line.replace(/--.*$/, "");
    for (const part of code.split(/(\$\$|;)/)) {
      if (part === "$$") { inBody = !inBody; cur += "$$"; }
      else if (part === ";" && !inBody) { if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " ").toLowerCase()); cur = ""; }
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
const WRITE_LOCKED = ["snl_store", "snl_usage", "snl_throttle", "snl_jobs", "snl_job_state"];

// ---------- tables and row level security ----------
{
  ok("the migration creates the seven tables the app uses", same([...tables].sort(), ["profiles", "snl_job_state", "snl_jobs", "snl_settings", "snl_store", "snl_throttle", "snl_usage"]), tables);
  for (const t of tables) ok(`${t} has row level security switched on`, st.includes(`alter table public.${t} enable row level security`));
  ok("row level security is never switched off or bypassed", !st.some((s) => /disable row level security|no force row level security|bypassrls/.test(s)));
  ok("every table is created in the public schema by name", st.filter((s) => s.startsWith("create table")).every((s) => /^create table if not exists public\.\w+ \(/.test(s)));
}

// ---------- grants ----------
type Grant = { privs: string[]; tables: string[]; roles: string[] };
const tableGrants: Grant[] = st.map((s) => s.match(/^grant (.+?) on (?!function)(.+?) to (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const tableRevokes: Grant[] = st.map((s) => s.match(/^revoke (.+?) on (?!function)(.+?) from (.+)$/)).filter(Boolean).map((m) => ({ privs: list(m![1]), tables: list(m![2]).map(bare), roles: list(m![3]) }));
const privsOf = (role: string, table: string) => [...new Set(tableGrants.filter((g) => g.roles.includes(role) && g.tables.includes(table)).flatMap((g) => g.privs))].sort();
{
  for (const role of ["anon", "authenticated"]) ok(`every table has all rights revoked from ${role} before anything is granted`, tables.every((t) => tableRevokes.some((r) => r.privs.includes("all") && r.roles.includes(role) && r.tables.includes(t))), tableRevokes);
  const lastRevoke = Math.max(...st.map((s, i) => (/^revoke .+ on (?!function)/.test(s) ? i : -1))), firstGrant = st.findIndex((s) => /^grant .+ on (?!function)/.test(s));
  ok("the revoke comes before the grants, so it can't undo them and they can't be undone by it", lastRevoke >= 0 && firstGrant > lastRevoke, { lastRevoke, firstGrant });
  ok("anon is granted nothing, anywhere in the migration", !st.some((s) => /^grant\b/.test(s) && /\banon\b/.test(s)) && !st.some((s) => /^grant\b/.test(s) && /\bto\b.*\bpublic\b\s*(,|$)/.test(s.replace(/public\.\w+/g, ""))), st.filter((s) => /^grant\b/.test(s) && /\banon\b/.test(s)));
  ok("nothing is granted with grant option or to every role", !st.some((s) => /with grant option|to public\b(?!\.)/.test(s)));
  for (const t of WRITE_LOCKED) ok(`a login can't insert, update or delete in ${t}`, privsOf("authenticated", t).every((p) => p === "select"), privsOf("authenticated", t));
  ok("a login has no rights at all on the throttle row or on an answer's saved place", same(privsOf("authenticated", "snl_throttle"), []) && same(privsOf("authenticated", "snl_job_state"), []));
  ok("a login may read profiles, saved results, the request counter and answers", ["profiles", "snl_store", "snl_usage", "snl_jobs"].every((t) => same(privsOf("authenticated", t), ["select"])));
  ok("a login may read, add and change shared settings, but never delete them", same(privsOf("authenticated", "snl_settings"), ["insert", "select", "update"]));
  ok("no login is granted delete, truncate, references, trigger or all on any table", tableGrants.filter((g) => g.roles.includes("authenticated")).every((g) => g.privs.every((p) => ["select", "insert", "update"].includes(p))));
  ok("the service role, which the functions use, can read and write every table", tables.every((t) => same(privsOf("service_role", t), ["delete", "insert", "select", "update"])), tables.map((t) => [t, privsOf("service_role", t)]));
  ok("only anon, authenticated and service_role are named in grants", tableGrants.every((g) => g.roles.every((r) => ["authenticated", "service_role"].includes(r))) && tableRevokes.every((g) => g.roles.every((r) => ["anon", "authenticated"].includes(r))));
}

// ---------- policies ----------
type Policy = { name: string; table: string; cmd: string; roles: string[]; using: string | null; check: string | null; text: string };
const policies: Policy[] = st.filter((s) => s.startsWith("create policy")).map((s) => {
  const m = s.match(/^create policy "([^"]+)" on public\.(\w+)(?: as \w+)?(?: for (\w+))?(?: to ([\w, ]+?))?(?= using| with check|$)(?: using \((.*?)\))?(?: with check \((.*)\))?$/);
  return m ? { name: m[1], table: m[2], cmd: m[3] ?? "all", roles: m[4] ? list(m[4]) : ["public"], using: m[5] ?? null, check: m[6] ?? null, text: s } : { name: "?", table: "?", cmd: "?", roles: ["?"], using: null, check: null, text: s };
});
const on = (t: string) => policies.filter((p) => p.table === t);
{
  ok("every policy could be read by this test", policies.length > 0 && policies.every((p) => p.name !== "?"), policies.filter((p) => p.name === "?").map((p) => p.text));
  ok("every policy names the authenticated role: none applies to anon or to everyone", policies.every((p) => same(p.roles, ["authenticated"])), policies.map((p) => [p.name, p.roles]));
  ok("no policy covers every command at once", policies.every((p) => ["select", "insert", "update"].includes(p.cmd)), policies.map((p) => [p.table, p.cmd]));
  ok("no table has a delete policy for logins", !policies.some((p) => p.cmd === "delete"));
  for (const t of WRITE_LOCKED) ok(`${t} has no insert, update or delete policy for logins`, on(t).every((p) => p.cmd === "select"), on(t).map((p) => p.cmd));
  ok("the throttle row and an answer's saved place have no policies at all, so only the service role reaches them", on("snl_throttle").length === 0 && on("snl_job_state").length === 0);
  ok("saved results and the request counter are readable only by a login with a profile", [...on("snl_store"), ...on("snl_usage")].length === 2 && [...on("snl_store"), ...on("snl_usage")].every((p) => p.using === "public.app_role() is not null"), [...on("snl_store"), ...on("snl_usage")].map((p) => p.using));
  ok("an answer is readable only by the login that asked it", on("snl_jobs").length === 1 && on("snl_jobs")[0].cmd === "select" && /^owner = auth\.uid\(\)/.test(on("snl_jobs")[0].using ?? "") && /public\.app_role\(\) is not null/.test(on("snl_jobs")[0].using ?? "") && !/\bor\b/.test(on("snl_jobs")[0].using ?? ""), on("snl_jobs"));
  ok("profiles can be read by logins and changed by none of them", same(on("profiles").map((p) => p.cmd), ["select"]));
  const settings = on("snl_settings");
  ok("shared settings: any login reads; only Corp Dev adds or changes, and a changed row must still pass the Corp Dev check", same(settings.map((p) => p.cmd).sort(), ["insert", "select", "update"]) && settings.find((p) => p.cmd === "select")!.using === "public.app_role() is not null"
    && settings.find((p) => p.cmd === "insert")!.check === "public.app_role() = 'corpdev'" && settings.find((p) => p.cmd === "update")!.using === "public.app_role() = 'corpdev'" && settings.find((p) => p.cmd === "update")!.check === "public.app_role() = 'corpdev'", settings);
  ok("every policy is dropped before it is created, so the migration can be run again", policies.every((p) => { const i = st.indexOf(p.text); return st.slice(0, i).includes(`drop policy if exists "${p.name}" on public.${p.table}`); }));
  ok("a login can only be given the role corpdev or reader", /check \(role in \('corpdev', 'reader'\)\)/.test(st.find((s) => s.startsWith("create table if not exists public.profiles"))!));
}

// ---------- functions ----------
{
  const fn = (name: string) => st.find((s) => s.startsWith(`create or replace function public.${name}(`))!;
  const fnRevokes = (name: string) => st.filter((s) => s.startsWith(`revoke `) && s.includes(`on function public.${name}(`)).flatMap((s) => list(s.split(" from ")[1]));
  const fnGrants = (name: string) => st.filter((s) => s.startsWith(`grant `) && s.includes(`on function public.${name}(`)).flatMap((s) => list(s.split(" to ")[1]));
  ok("snl_take_slot can't be run by anon, by logins, or through the default public grant", ["public", "anon", "authenticated"].every((r) => fnRevokes("snl_take_slot").includes(r)), fnRevokes("snl_take_slot"));
  ok("only the service role can run snl_take_slot", same(fnGrants("snl_take_slot"), ["service_role"]), fnGrants("snl_take_slot"));
  ok("app_role can't be run by anon or through the default public grant", ["public", "anon"].every((r) => fnRevokes("app_role").includes(r)), fnRevokes("app_role"));
  ok("app_role can be run by logins and the service role only", same(fnGrants("app_role").sort(), ["authenticated", "service_role"]), fnGrants("app_role"));
  ok("the functions' revokes and grants name the functions' real argument lists", st.some((s) => s.startsWith("revoke all on function public.snl_take_slot(integer, integer, integer) from")) && st.some((s) => s === "grant execute on function public.snl_take_slot(integer, integer, integer) to service_role") && fn("snl_take_slot").startsWith("create or replace function public.snl_take_slot(p_hour_limit integer, p_day_limit integer, p_gap_ms integer default 1000)"));
  const definers = st.filter((s) => s.startsWith("create or replace function") && /security definer/.test(s));
  ok("every function that runs with its owner's rights pins its search_path", definers.length === 2 && definers.every((s) => /set search_path = public\b/.test(s.split("$$")[0])), definers.map((s) => s.split("$$")[0]));
  ok("the trigger function is not callable by anon, logins or the public", ["public", "anon", "authenticated"].every((r) => fnRevokes("stamp_update").includes(r)) && fnGrants("stamp_update").length === 0, fnRevokes("stamp_update"));
  ok("app_role returns only the caller's own role", /select role from public\.profiles where id = auth\.uid\(\)/.test(fn("app_role")));
  ok("every function in the migration has its execute rights set explicitly", st.filter((s) => s.startsWith("create or replace function")).every((s) => { const n = s.match(/function public\.(\w+)\(/)![1]; return fnRevokes(n).includes("public"); }));

  const slot = fn("snl_take_slot");
  ok("snl_take_slot takes a row lock first, so two calls at once can't share a slot", /perform 1 from public\.snl_throttle where id for update/.test(slot) && slot.indexOf("for update") < slot.indexOf("select coalesce"));
  ok("hours and days are counted in UTC", /date_trunc\('hour', v_now, 'utc'\)/.test(slot) && /date_trunc\('day', v_now, 'utc'\)/.test(slot));
  ok("at a limit it returns allowed = false with no wait, before it moves the slot or counts anything", /if v_h >= p_hour_limit or v_d >= p_day_limit then return query select false, 0, v_h, v_d; return; end if;/.test(slot) && slot.indexOf("return query select false") < slot.indexOf("update public.snl_throttle") && slot.indexOf("return query select false") < slot.indexOf("insert into public.snl_usage"), slot);
  ok("the slot is the later of now and the next free time, and the next free time moves on by the gap", /select greatest\(t\.next_at, v_now\) into v_slot/.test(slot) && /update public\.snl_throttle set next_at = v_slot \+ make_interval\(secs => greatest\(p_gap_ms, 0\) \/ 1000\.0\)/.test(slot));
  ok("both the hour and the day counters go up by one", (slot.match(/on conflict \(bucket, starts_at\) do update set requests = public\.snl_usage\.requests \+ 1/g) ?? []).length === 2 && /values \('hour', v_hour, 1\)/.test(slot) && /values \('day', v_day, 1\)/.test(slot));
  ok("it returns the wait in whole milliseconds, never negative, and the new counts", /return query select true, greatest\(0, ceil\(extract\(epoch from \(v_slot - v_now\)\) \* 1000\)\)::integer, v_h \+ 1, v_d \+ 1/.test(slot));
  ok("the throttle table can only ever hold its one row, which the migration creates", /id boolean primary key default true check \(id\)/.test(st.find((s) => s.startsWith("create table if not exists public.snl_throttle"))!) && st.includes("insert into public.snl_throttle (id) values (true) on conflict (id) do nothing"));
}

// ---------- checks on saved rows ----------
{
  const rules = storeRules();
  ok("saved rows must be one of the five kinds the functions write", same(rules.kinds, ["reference", "search", "entity", "discover", "statutory"]), rules.kinds);
  const good = ["ref:typeOfInsurance", "ref:filingStatus", "ref:serffFilingState", "ref:serffFilingType", "search:0123456789abcdef0123456789abcdef", "entity:9100001", "discover:views", "discover:views.surplus", "discover:cols.IR_PREM_LINE", "statutory:0123456789abcdef0123456789abcdef"];
  ok("the ids the functions use are all allowed", good.every((id) => rules.problem({ id, kind: "search", doc: {} }) === null), good.filter((id) => rules.problem({ id, kind: "search", doc: {} })));
  ok("ids of other shapes are refused", ["search:", "other:abc", "search:has space", "ref:a/b", "search:" + "a".repeat(81), "SEARCH:abc", "entity:1;drop"].every((id) => rules.problem({ id, kind: "search", doc: {} }) !== null));
  ok("a label is at most 400 characters and a document must be a JSON object under 4 MB", rules.maxLabel === 400 && /doc\s+jsonb not null check \(jsonb_typeof\(doc\) = 'object' and pg_column_size\(doc\) < 4194304\)/.test(raw));
  const jobs = st.find((s) => s.startsWith("create table if not exists public.snl_jobs"))!;
  ok("an answer's status is one of the five the functions use", /check \(status in \('queued', 'running', 'paused', 'done', 'error'\)\)/.test(jobs));
  ok("a question is 1 to 4,000 characters, the same limit the function applies", /check \(length\(question\) between 1 and 4000\)/.test(jobs));
  ok("an answer belongs to a login and goes when the login is deleted", /owner uuid not null references auth\.users \(id\) on delete cascade/.test(jobs) && /job_id uuid primary key references public\.snl_jobs \(id\) on delete cascade/.test(st.find((s) => s.startsWith("create table if not exists public.snl_job_state"))!));
  ok("the request counter can't go negative and holds only hour and day buckets", /bucket text not null check \(bucket in \('hour', 'day'\)\)/.test(st.find((s) => s.startsWith("create table if not exists public.snl_usage"))!) && /requests integer not null default 0 check \(requests >= 0\)/.test(st.find((s) => s.startsWith("create table if not exists public.snl_usage"))!));
  ok("the migration can be run again: tables, indexes, functions, policies and triggers are all created idempotently", st.every((s) => !/^create (table|index) (?!if not exists)/.test(s) && !/^create function/.test(s) && (!s.startsWith("create trigger") || st.some((d) => d.startsWith("drop trigger if exists")))));
  ok("the migration holds no secret, key or real login", !/sk-ant-|eyJ[A-Za-z0-9_-]{10,}|password\s*=|BEGIN [A-Z ]*PRIVATE KEY/.test(raw));
}

// ---------- other migrations ----------
{
  const others = [...Deno.readDirSync(dir)].map((f) => f.name).filter((n) => n.endsWith(".sql") && n !== "0001_snl.sql").sort();
  const anonGrants: string[] = [];
  for (const name of others) for (const s of statements(Deno.readTextFileSync(new URL(name, dir)))) {
    if (/^grant\b/.test(s) && /\banon\b/.test(s)) anonGrants.push(`${name}: ${s}`);
    ok(`${name}: no table is granted to anon or switched out of row level security`, !/^grant .+ on (?!function).+\banon\b/.test(s) && !/disable row level security/.test(s), s);
  }
  const keep = others.includes("0002_keepalive.sql") ? statements(Deno.readTextFileSync(new URL("0002_keepalive.sql", dir))) : null;
  ok("the only thing anon may run in any migration is keepalive()", anonGrants.every((g) => /grant execute on function public\.keepalive\(\) to anon, authenticated$/.test(g)), anonGrants);
  if (keep) ok("keepalive() reads no table: it returns the time, runs with the caller's rights and an empty search_path", keep.some((s) => /^create or replace function public\.keepalive\(\) returns timestamptz language sql stable security invoker set search_path = '' as \$\$ select now\(\) \$\$$/.test(s)), keep);
}

// ---------- the same rules, through the in-memory stand-in ----------
{
  const clock = fakeClock("2026-11-13T12:00:00Z"), db = memoryDb(clock), T0 = clock.now;
  const a = await db.takeSlot(PLAN_LIMITS.trial), b = await db.takeSlot(PLAN_LIMITS.trial), c = await db.takeSlot(PLAN_LIMITS.trial);
  ok("the first request goes at once; the next two wait one and two seconds", same([a, b, c], [{ allowed: true, waitMs: 0, hour: 1, day: 1 }, { allowed: true, waitMs: 1000, hour: 2, day: 2 }, { allowed: true, waitMs: 2000, hour: 3, day: 3 }]), [a, b, c]);
  clock.now = T0 + 2500;
  ok("a caller arriving part-way through waits only until the next free second", (await db.takeSlot(PLAN_LIMITS.trial)).waitMs === 500);
  clock.now = T0 + 60_000;
  ok("after a quiet minute there is no wait", (await db.takeSlot(PLAN_LIMITS.trial)).waitMs === 0);
  ok("slots are never closer than a second apart", db.slots.every((s, i) => i === 0 || s - db.slots[i - 1] >= 1000), db.slots.map((s) => s - T0));
  ok("requests are counted for the hour and the day", same(await db.usage(), { hour: 5, day: 5 }));

  clock.now = Date.parse("2026-11-13T13:00:00Z");
  const next = await db.takeSlot(PLAN_LIMITS.trial);
  ok("a new hour starts its own count while the day carries on", next.hour === 1 && next.day === 6 && same(await db.usage(), { hour: 1, day: 6 }), next);
  clock.now = Date.parse("2026-11-14T00:00:00Z");
  const tomorrow = await db.takeSlot(PLAN_LIMITS.trial);
  ok("a new UTC day starts both counts again", tomorrow.hour === 1 && tomorrow.day === 1, tomorrow);

  const lim = memoryDb(fakeClock("2026-11-13T12:00:00Z"));
  await lim.takeSlot({ hour: 2, day: 10 });
  await lim.takeSlot({ hour: 2, day: 10 });
  const slots = lim.slots.length, refused = await lim.takeSlot({ hour: 2, day: 10 });
  ok("at the hourly limit a request is refused: not allowed, no wait, the counts as they stand", same(refused, { allowed: false, waitMs: 0, hour: 2, day: 2 }), refused);
  ok("a refused request takes no slot and is not counted", lim.slots.length === slots && same(await lim.usage(), { hour: 2, day: 2 }));
  ok("a higher limit on the same counts lets the next request through", (await lim.takeSlot({ hour: 3, day: 10 })).allowed === true);
  const day = memoryDb(fakeClock("2026-11-13T12:00:00Z"));
  await day.takeSlot({ hour: 10, day: 1 });
  ok("at the daily limit a request is refused the same way", same(await day.takeSlot({ hour: 10, day: 1 }), { allowed: false, waitMs: 0, hour: 1, day: 1 }));
  ok("a limit of zero refuses everything", (await memoryDb(fakeClock()).takeSlot({ hour: 0, day: 0 })).allowed === false);
  ok("the app's limits are S&P's: 500 and 12,000 on trial, 2,000 and 48,000 in production", same(PLAN_LIMITS, { trial: { hour: 500, day: 12_000 }, production: { hour: 2_000, day: 48_000 } }));
}

done();
