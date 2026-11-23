// Statutory queries that finish: the figures' statements run several at once (never more than STAT_POOL), a figure
// that runs out of time is that figure's "Not run" and never fails the others, nothing is started with too little
// time left, and a sign-in failure part-way is reported once with nothing left hanging. Each figure that comes back
// is kept, so the same question asked again runs only what is missing and is then saved whole; refresh runs it all
// again. The snl-statutory and snl-profile functions and Claude's tool say how many figures are still pending.
// Every company, code, view, column and figure here is made up.
(globalThis as any).__SNL_TEST__ = true;
const statutory = await import(new URL("../../supabase/functions/snl-statutory/index.ts", import.meta.url).href);
const profile = await import(new URL("../../supabase/functions/snl-profile/index.ts", import.meta.url).href);
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
import { Snowflake, SnowflakeError, snowflakeCreds } from "../../supabase/functions/_shared/snowflake.ts";
import { figureStoreId, MAP_ONLY_FIELDS, type Mapping, NOT_RUN, runStatutory, savedOrFreshStatutory, STAT_FIELDS, STAT_MIN_MS, STAT_POOL, type StatFieldId, type StatQuery } from "../../supabase/functions/_shared/statutory.ts";
import { NOTES } from "../../supabase/functions/_shared/profile.ts";
import { forgetTokens } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, type Clock, corpdev, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, req, say, toolResults, toolUse } from "./helpers/fakes.ts";
import { fakeSnowflake, route } from "./helpers/snowflake.ts";
import { watchStore } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const caught = async (p: Promise<unknown>): Promise<any> => { try { await p; return null; } catch (e) { return e; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let unhandled = 0;
globalThis.addEventListener("unhandledrejection", (e) => { unhandled++; e.preventDefault(); });

const PAT = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
// Every figure a profile asks for (the Combination map's figure by state and line is asked for only by that map).
const ALL = STAT_FIELDS.map((f) => f.id).filter((id) => !MAP_ONLY_FIELDS.includes(id)) as StatFieldId[];
const viewOf = (id: string) => `V_${id.toUpperCase()}`;
// Every figure in its own made-up view, so a statement says which figure it is for.
const MAPPING: Mapping = { fields: Object.fromEntries(STAT_FIELDS.map((f) => [f.id, {
  view: viewOf(f.id), entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value: "VAL",
  ...(f.by === "line" ? { line: "LOB" } : f.by === "state" ? { state: "ST" } : f.by === "item" ? { item: "PARTY" } : {}),
}])) };
const COS = [["91001", "9100", "Calloway Insurance Co"], ["92001", "9200", "Tarrow Mutual Insurance Co"]];
const TABLES = Object.fromEntries(STAT_FIELDS.map((f, i) => [viewOf(f.id), COS.flatMap(([code, grp, name], c) => [2023, 2024].map((y) =>
  ({ NAIC_CD: code, GRP_CD: grp, CO_NAME: name, STMT_YEAR: y, LOB: "Homeowners", ST: "FL", PARTY: "Nonesuch Re", VAL: (i + 1) * 100 + c * 10 + (y - 2023) })))]));
const Q: StatQuery = { kind: "company", codes: ["91001", "92001"], fromYear: 2023, toYear: 2024 };
const figureStatements = (list: { statement: string }[]) => list.filter((s) => / FROM MI_XPRESSCLOUD\.XPRESSFEED\.V_/.test(s.statement));
const viewsIn = (list: { statement: string }[]) => figureStatements(list).map((s) => s.statement.match(/XPRESSFEED\.(V_[A-Z_]+)/)![1]);

/** The fake Snowflake behind the real client, with a gate in front of it: it can hold each statement for a while
    (so statements overlap), answer chosen figures 408 (Snowflake's "ran out of time"), and count what is in flight. */
function world(o: { delay?: (statement: string) => number; timeout?: (statement: string, n: number) => boolean } = {}) {
  const clock = fakeClock(), db = memoryDb(clock), fake = fakeSnowflake(clock, { tables: TABLES, loaded: Object.fromEntries(STAT_FIELDS.map((f) => [viewOf(f.id), "2026-11-01T04:00:00"])) });
  const gate = { inFlight: 0, max: 0, sent: [] as { statement: string }[], timedOut: [] as string[] };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.endsWith("/api/v2/statements") || init.method !== "POST") return fake.fetch(input, init);
    const statement = JSON.parse(String(init.body)).statement as string;
    gate.sent.push({ statement }); gate.inFlight++; gate.max = Math.max(gate.max, gate.inFlight);
    try {
      await wait(o.delay?.(statement) ?? 3);
      if (o.timeout?.(statement, gate.sent.length)) { gate.timedOut.push(statement); return new Response(JSON.stringify({ message: "Statement reached its statement or warehouse timeout." }), { status: 408, headers: { "content-type": "application/json" } }); }
      return await fake.fetch(input, init);
    } finally { gate.inFlight--; }
  }) as typeof globalThis.fetch;
  const creds = snowflakeCreds(env(PAT));
  const sf = new Snowflake(creds, { fetch, now: clock.fn, sleep: clock.sleep });
  const ask = (q: StatQuery = Q, fields: StatFieldId[] = ALL, opts: { refresh?: boolean; deadline?: number; mapping?: Mapping } = {}) =>
    savedOrFreshStatutory(sf, db, creds.database, creds.schema, opts.mapping ?? MAPPING, q, fields, { now: clock.now, refresh: opts.refresh, deadline: opts.deadline, clock: clock.fn });
  return { clock, db, fake, gate, sf, creds, fetch, ask };
}

/** A stand-in Snowflake client whose statements each take ms of the (fake) clock and some real milliseconds, so the
    deadline can pass part-way through a run. */
function standIn(clock: Clock, o: { ms?: number; delay?: (s: string) => number; fail?: (s: string) => Error | null } = {}) {
  const st = { started: [] as { s: string; at: number; wait: number }[], inFlight: 0, max: 0 };
  const query = async (s: string, _b: unknown, waitMs: number) => {
    if (s.includes("LOADTRACKER")) return { columns: [], rows: [], truncated: false, statementHandle: null };
    const at = clock.now;
    st.started.push({ s, at, wait: waitMs }); st.inFlight++; st.max = Math.max(st.max, st.inFlight);
    try {
      await wait(o.delay?.(s) ?? 2);
      if (o.ms) clock.now = Math.max(clock.now, at + o.ms);
      const e = o.fail?.(s); if (e) throw e;
      return { columns: [], rows: [{ CODE: "91001", NAME: "Calloway Insurance Co", YR: "2024", LINE: null, STATE: null, VAL: "1" }], truncated: false, statementHandle: null };
    } finally { st.inFlight--; }
  };
  return Object.assign(st, { query });
}

// ---------- several statements at once ----------
{
  ok("eight statements run at once, and a statement needs at least eight seconds", STAT_POOL === 8 && STAT_MIN_MS === 8_000);
  const w = world();
  const r = await runStatutory(w.sf, w.creds.database, w.creds.schema, MAPPING, Q, ALL);
  ok("every figure's statements overlap: more than one in flight", w.gate.max > 1, w.gate.max);
  ok(`but never more than ${STAT_POOL} at a time`, w.gate.max <= STAT_POOL, w.gate.max);
  ok("every figure came back, with its rows", r.fields.length === ALL.length && r.fields.every((f) => f.error === null && f.rows.length === 4), r.fields.map((f) => [f.id, f.error, f.rows.length]));
  ok("names and run dates are collected as before", same(r.entities, [{ code: "91001", name: "Calloway Insurance Co" }, { code: "92001", name: "Tarrow Mutual Insurance Co" }]) && r.loaded.length === ALL.length && r.truncated === false, { e: r.entities, l: r.loaded.length });
  ok("one statement for each figure, and one for LOADTRACKER", figureStatements(w.gate.sent).length === ALL.length && w.gate.sent.length === ALL.length + 1);

  // output order is the order asked, whichever statement finishes first
  const order: StatFieldId[] = ["surplus", "dpw_by_state", "ceded_by_reinsurer", "loss_ratio", "gpw", "dpw_by_line", "npe", "combined_ratio"];
  const slowFirst = world({ delay: (s) => { const i = order.findIndex((id) => s.includes(`.${viewOf(id)} `)); return i < 0 ? 1 : (order.length - i) * 4; } });
  const o = await runStatutory(slowFirst.sf, slowFirst.creds.database, slowFirst.creds.schema, MAPPING, Q, order);
  ok("the answer keeps the order asked, though the later figures finished first", same(o.fields.map((f) => f.id), order) && o.fields.every((f) => f.rows.length === 4 && f.rows[0].value === (ALL.indexOf(f.id) + 1) * 100), o.fields.map((f) => [f.id, f.rows[0]?.value]));
  ok("and the statements were sent in the order asked", same(viewsIn(slowFirst.gate.sent), order.map(viewOf)), viewsIn(slowFirst.gate.sent));
}

// ---------- a figure that runs out of time never fails the others ----------
{
  const w = world({ timeout: (s) => s.includes(".V_SURPLUS ") || s.includes(".V_NPE ") });
  const r = await runStatutory(w.sf, w.creds.database, w.creds.schema, MAPPING, Q, ALL);
  const f = (id: string) => r.fields.find((x) => x.id === id)!;
  ok("a 408 on one figure marks that figure Not run, with the usual words", f("surplus").error === NOT_RUN && f("npe").error === NOT_RUN && f("surplus").mapped === true && f("surplus").rows.length === 0, [f("surplus").error, f("npe").error]);
  ok("and the other figures are all there", r.fields.filter((x) => x.error === null && x.rows.length === 4).length === ALL.length - 2);
  ok("the run dates leave out only what didn't come back", r.loaded.length === ALL.length - 2 && !r.loaded.some((l) => l.view === "V_SURPLUS"), r.loaded.length);

  // a statement Snowflake keeps running past its time is given up on and cancelled: also Not run
  const slow = world();
  slow.fake.slowNext = 10_000;
  const s = await runStatutory(slow.sf, slow.creds.database, slow.creds.schema, MAPPING, Q, ["surplus", "gpw"]);
  ok("a statement that never finishes is cancelled and its figure is Not run; the other is intact", s.fields[0].error === NOT_RUN && s.fields[1].error === null && s.fields[1].rows.length === 4 && slow.fake.cancelled.length === 1, s.fields.map((x) => x.error));

  // the deadline passes part-way: each statement takes 30 seconds; 65 seconds in all
  const clock = fakeClock(), si = standIn(clock, { ms: 30_000 }), t0 = clock.now;
  const d = await runStatutory(si as unknown as Snowflake, "DB", "SCH", MAPPING, Q, ALL, { deadline: t0 + 65_000, now: clock.fn });
  ok(`with the deadline passing part-way, the first two rounds of ${STAT_POOL} run`, si.started.length === 2 * STAT_POOL && d.fields.slice(0, 2 * STAT_POOL).every((x) => x.error === null && x.rows.length === 1), si.started.map((x) => x.at - t0));
  ok("and the rest are Not run, never started with only five seconds left", d.fields.slice(2 * STAT_POOL).every((x) => x.error === NOT_RUN && x.rows.length === 0) && si.started.every((x) => x.at - t0 <= 30_000), d.fields.map((x) => x.error));
  ok("each statement is given only the time left when it starts", si.started.every((x) => x.wait === Math.min(100_000, t0 + 65_000 - x.at)) && si.max <= STAT_POOL && si.max > 1, si.started.map((x) => x.wait));

  // nothing is started with too little time left
  for (const [left, starts] of [[STAT_MIN_MS - 1, 0], [STAT_MIN_MS, STAT_POOL]] as const) {
    const c = fakeClock(), x = standIn(c, { ms: 30_000 });
    const out = await runStatutory(x as unknown as Snowflake, "DB", "SCH", MAPPING, Q, ALL, { deadline: c.now + left, now: c.fn });
    ok(`with ${left / 1000} seconds left, ${starts} statements start and the rest are Not run`, x.started.length === starts && out.fields.filter((f) => f.error === NOT_RUN).length === ALL.length - starts, { started: x.started.length });
  }
}

// ---------- a sign-in failure part-way stops the query, once ----------
{
  const clock = fakeClock();
  const si = standIn(clock, {
    delay: (s) => (s.includes(".V_SURPLUS ") ? 5 : s.includes(".V_LOSS_RATIO ") ? 15 : 30),
    fail: (s) => (s.includes(".V_SURPLUS ") ? new SnowflakeError("signin", "first failure") : s.includes(".V_LOSS_RATIO ") ? new SnowflakeError("signin", "second failure") : null),
  });
  const before = unhandled;
  const e = await caught(runStatutory(si as unknown as Snowflake, "DB", "SCH", MAPPING, Q, ALL));
  ok("a sign-in failure stops the whole query, reported as the first failure", e instanceof SnowflakeError && e.code === "signin" && e.message === "first failure", e?.message);
  ok("no new statement starts after it, and the ones in flight are finished with before it is reported", si.started.length === STAT_POOL && si.inFlight === 0, { started: si.started.length, inFlight: si.inFlight });
  await wait(60);
  ok("nothing is left as an unhandled rejection", unhandled === before, unhandled - before);

  const w = world();
  w.fake.failNext.push({ status: 401, body: { message: "JWT token is invalid." } });
  const db = memoryDb(w.clock);
  const f = await caught(savedOrFreshStatutory(w.sf, db, w.creds.database, w.creds.schema, MAPPING, Q, ALL, { now: w.clock.now }));
  ok("through the saved-or-fresh path a 401 is still the whole query's plain sign-in failure, and nothing whole is saved", f instanceof SnowflakeError && f.code === "signin" && ![...db.store.keys()].some((k) => /^statutory:[0-9a-f]{32}$/.test(k)), f?.message);
  await wait(30);
  ok("and nothing is left as an unhandled rejection there either", unhandled === before);
}

// ---------- figures kept as they arrive, so the next call carries on ----------
{
  let firstCall = true;
  const w = world({ timeout: (s) => firstCall && /\.V_(SURPLUS|NPE|PYD|RBC_RATIO) /.test(s) });
  const saved = watchStore(w.db);
  const t0 = w.clock.now;
  const a = await w.ask();
  ok("the first call answers with what arrived and says four figures are pending", a.pending === 4 && a.saved === false && a.fromStore === false && a.fields.length === ALL.length && a.fields.filter((f) => f.error === NOT_RUN).length === 4, { pending: a.pending, saved: a.saved });
  ok("each figure that came back is saved on its own, under kind statutory, and passes the database's checks", saved.length === ALL.length - 4 && saved.every((s) => s.kind === "statutory" && s.problem === null && /^statutory:f\.[0-9a-f]{32}$/.test(s.id)), saved);
  ok("the whole answer isn't saved while figures are pending", ![...w.db.store.keys()].some((k) => /^statutory:[0-9a-f]{32}$/.test(k)));
  firstCall = false;
  w.clock.now += 60_000;
  const n = w.gate.sent.length;
  const b = await w.ask();
  ok("the second call runs only the four missing statements", same(viewsIn(w.gate.sent.slice(n)), ["V_SURPLUS", "V_NPE", "V_RBC_RATIO", "V_PYD"]), viewsIn(w.gate.sent.slice(n)));
  ok("and answers in full, in the order asked, nothing pending", b.pending === 0 && same(b.fields.map((f) => f.id), ALL) && b.fields.every((f) => f.error === null && f.rows.length === 4), b.fields.map((f) => f.error));
  ok("the figures match a run done in one go", same(b.fields, (await world().ask()).fields));
  ok("names come from saved and fresh figures alike", same(b.entities, [{ code: "91001", name: "Calloway Insurance Co" }, { code: "92001", name: "Tarrow Mutual Insurance Co" }]));
  ok("the run dates cover every view, saved and fresh, looked up once", b.loaded.length === ALL.length && w.gate.sent.slice(n).filter((s) => s.statement.includes("LOADTRACKER")).length === 1, b.loaded.length);
  ok("a mixed answer is as old as its oldest figure", b.fetchedAt === new Date(t0).toISOString() && b.fromStore === false, b.fetchedAt);
  ok("once complete, the whole answer is saved", b.saved === true && [...w.db.store.keys()].filter((k) => /^statutory:[0-9a-f]{32}$/.test(k)).length === 1);
  const m = w.gate.sent.length;
  const c = await w.ask();
  ok("the third call opens the whole saved answer without asking Snowflake", c.fromStore === true && c.saved === true && c.pending === 0 && w.gate.sent.length === m && same(c.fields, b.fields) && c.fetchedAt === b.fetchedAt);
  const r = await w.ask(Q, ALL, { refresh: true });
  ok("refresh runs every statement again", figureStatements(w.gate.sent.slice(m)).length === ALL.length && r.fromStore === false && r.pending === 0 && r.fetchedAt === new Date(w.clock.now).toISOString());

  // a changed mapping for one figure re-runs only that figure
  const changed: Mapping = { fields: { ...MAPPING.fields, surplus: { ...MAPPING.fields.surplus!, scale: 1000 } } };
  const k = w.gate.sent.length;
  const ch = await w.ask(Q, ALL, { mapping: changed });
  ok("a changed mapping for one figure re-runs only that figure", same(viewsIn(w.gate.sent.slice(k)), ["V_SURPLUS"]) && ch.fields.find((f) => f.id === "surplus")!.rows[0].value === 400_000 && ch.pending === 0, viewsIn(w.gate.sent.slice(k)));

  // a different set of figures is answered from those already saved, asking only for run dates
  const j = w.gate.sent.length;
  const sub = await w.ask(Q, ["gpw", "surplus"]);
  ok("a different set of figures already saved is answered from them: only the run dates are asked", figureStatements(w.gate.sent.slice(j)).length === 0 && sub.fromStore === true && sub.pending === 0 && same(sub.fields.map((f) => f.id), ["gpw", "surplus"]), viewsIn(w.gate.sent.slice(j)));
}
{
  // two different companies, years or kinds never share a saved figure
  const ids = await Promise.all([Q, { ...Q, codes: ["92001", "91001"] }, { ...Q, codes: ["91001"] }, { ...Q, fromYear: 2022 }, { ...Q, toYear: 2025 }, { ...Q, kind: "group" as const }].map((q) => figureStoreId(MAPPING, q, "surplus")));
  ok("a figure's id hashes the kind, the sorted codes and the years", ids[0] === ids[1] && new Set(ids).size === 5, ids);
  ok("and the figure and its mapping", (await figureStoreId(MAPPING, Q, "gpw")) !== ids[0] && (await figureStoreId({ fields: { ...MAPPING.fields, surplus: { ...MAPPING.fields.surplus!, value: "OTHER" } } }, Q, "surplus")) !== ids[0]
    && (await figureStoreId({ ...MAPPING, loaded: { view: "RUNS", at: "RUN_AT" } }, Q, "surplus")) !== ids[0]);
  const w = world();
  await w.ask({ ...Q, codes: ["91001"] });
  for (const [name, q] of [["another company", { ...Q, codes: ["92001"] }], ["other years", { ...Q, codes: ["91001"], fromYear: 2024 }], ["a group", { kind: "group", codes: ["9100"], fromYear: 2023, toYear: 2024 }]] as [string, StatQuery][]) {
    const n = w.gate.sent.length;
    const a = await w.ask(q);
    ok(`${name} runs every statement afresh`, figureStatements(w.gate.sent.slice(n)).length === ALL.length && a.fromStore === false, figureStatements(w.gate.sent.slice(n)).length);
  }
}
{
  // old whole saved answers still open: a row as the app saved it before (no fetchedAt or pending in it)
  const w = world();
  await w.ask();
  const old = world();
  const [id, row] = [...w.db.store].find(([k]) => /^statutory:[0-9a-f]{32}$/.test(k))!;
  const doc = { ...row.doc } as Record<string, unknown>;
  delete doc.fetchedAt;
  old.db.store.set(id, { ...row, doc, fetched_at: "2026-10-01T09:00:00.000Z" });
  const a = await savedOrFreshStatutory(null, old.db, old.creds.database, old.creds.schema, MAPPING, Q, ALL, { now: old.clock.now });
  ok("an old whole saved answer still opens, without Snowflake, with its saved time and nothing pending", a.fromStore === true && a.saved === true && a.pending === 0 && a.fetchedAt === "2026-10-01T09:00:00.000Z" && a.fields.length === ALL.length && old.gate.sent.length === 0, { fromStore: a.fromStore, at: a.fetchedAt });
}
{
  // a refresh that doesn't get to everything: carrying on runs those afresh, never the old copies
  let timeouts = false;
  const w = world({ timeout: (s) => timeouts && /\.V_(GPW|NPE) /.test(s) });
  await w.ask();
  timeouts = true;
  w.clock.now += 3_600_000;
  const r = await w.ask(Q, ALL, { refresh: true });
  ok("a refresh that runs out of time for two figures says two are pending", r.pending === 2 && r.saved === false && r.fromStore === false);
  timeouts = false;
  const n = w.gate.sent.length;
  const c = await w.ask();
  ok("carrying on after it runs just those two, not the older whole answer", same(viewsIn(w.gate.sent.slice(n)), ["V_GPW", "V_NPE"]) && c.pending === 0 && c.fromStore === false && c.saved === true, viewsIn(w.gate.sent.slice(n)));
  ok("and the answer is as old as the refresh", c.fetchedAt === r.fetchedAt, [c.fetchedAt, r.fetchedAt]);
}

// ---------- through the functions ----------
{
  // snl-statutory: the answer carries pending, and the same query carries on
  let first = true;
  const w = world({ timeout: (s) => first && s.includes(".V_SURPLUS ") });
  w.db.settings.set("statutory_mapping", MAPPING as unknown as Record<string, unknown>);
  const deps = { env: env(PAT), fetch: w.fetch, now: w.clock.fn, whoIs: corpdev, db: w.db, sleep: w.clock.sleep };
  const call = async (body: unknown) => { const res: Response = await statutory.handle(req("snl-statutory", body), deps); return { status: res.status, body: await res.json() }; };
  const body = { action: "query", codes: ["91001", "92001"], fromYear: 2023, toYear: 2024 };
  const a = await call(body);
  ok("snl-statutory answers 200 with pending 1 when a figure ran out of time", a.status === 200 && a.body.pending === 1 && a.body.saved === false && a.body.fields.find((f: any) => f.id === "surplus").error === NOT_RUN, a.body.pending);
  first = false;
  const n = w.gate.sent.length;
  const b = await call(body);
  ok("the same query again runs only that figure and answers pending 0", b.status === 200 && b.body.pending === 0 && b.body.saved === true && same(viewsIn(w.gate.sent.slice(n)), ["V_SURPLUS"]), viewsIn(w.gate.sent.slice(n)));
}
{
  // snl-profile: facts say pending and figures done of of; a draft with figures pending isn't sent to Claude
  let first = true;
  const w = world({ timeout: (s) => first && /\.V_(SURPLUS|NET_INCOME) /.test(s) });
  w.db.settings.set("statutory_mapping", MAPPING as unknown as Record<string, unknown>);
  const ai = fakeAnthropic([]);
  const deps = { env: env({ ...PAT, ANTHROPIC_API_KEY: "test-key-not-a-secret" }), fetch: w.fetch, anthropicFetch: ai.fetch, now: w.clock.fn, whoIs: corpdev, db: w.db, sleep: w.clock.sleep };
  const call = async (body: unknown) => { const res: Response = await profile.handle(req("snl-profile", body), deps); return { status: res.status, body: await res.json() }; };
  const a = await call({ action: "facts", kind: "company", code: "91001", toYear: 2024 });
  ok("profile facts say two figures are pending, and how many came back", a.status === 200 && a.body.pending === 2 && same(a.body.figures, { done: ALL.length - 2, of: ALL.length }) && a.body.facts && a.body.text, { pending: a.body.pending, figures: a.body.figures });
  ok("the figures still to come are listed as missing, saying they weren't run", a.body.facts.missing.some((m: any) => m.field === "surplus" && /^Not run/.test(m.reason)), a.body.facts.missing);
  const d = await call({ action: "draft", kind: "company", code: "91001", toYear: 2024 });
  ok("a draft while figures are pending gives the plain text with a note, isn't sent to Claude and isn't counted", d.status === 200 && d.body.pending === 2 && d.body.text.by === "plain" && d.body.text.note === NOTES.pending && ai.calls.length === 0 && w.db.jobs.size === 0 && !d.body.jobId, d.body.text?.note);
  first = false;
  const n = w.gate.sent.length;
  const b = await call({ action: "facts", kind: "company", code: "91001", toYear: 2024 });
  ok("asking again carries on: only the two missing statements run, and nothing is pending", b.status === 200 && b.body.pending === undefined && b.body.figures === undefined && same(viewsIn(w.gate.sent.slice(n)), ["V_SURPLUS", "V_NET_INCOME"]) && !b.body.facts.missing.some((m: any) => /^Not run/.test(m.reason)), viewsIn(w.gate.sent.slice(n)));
  ok("a complete answer has the same keys as before", same(Object.keys(b.body).sort(), ["facts", "text"]));
}
{
  // Ask Claude: the tool result says when figures are pending, so Claude asks again; the second call carries on
  forgetTokens();
  let first = true;
  const w = world({ timeout: (s) => first && s.includes(".V_LOSS_RATIO ") });
  w.db.settings.set("statutory_mapping", MAPPING as unknown as Record<string, unknown>);
  const sp = fakeSpgmi(w.clock, {});
  const seen: Record<string, any> = {};
  const input = { kind: "company", naic_codes: ["91001"], from_year: 2023, to_year: 2024, fields: ["surplus", "loss_ratio"] };
  const claude = fakeAnthropic([
    { content: [toolUse("q1", "query_statutory", input)] },
    (body) => { seen.r1 = toolResults(body).q1; first = false; return { content: [toolUse("q2", "query_statutory", input)] }; },
    (body) => { seen.r2 = toolResults(body).q2; return { content: [say("Done.")] }; },
    { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] },
  ]);
  const pending: Promise<unknown>[] = [];
  const deps = { env: env({ ...PAT, SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "test-anthropic-key" }), fetch: route({ "snowflakecomputing.com": w.fetch }, sp.fetch), anthropicFetch: claude.fetch,
    now: w.clock.fn, whoIs: async () => ({ id: "login-5d2e", role: "corpdev" }), db: w.db, sleep: w.clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const res: Response = await chat.handle(req("snl-chat", { action: "ask", question: "What is Calloway Insurance Co's loss ratio?" }), deps);
  const { jobId } = await res.json();
  while (pending.length) await pending.shift();
  ok("Claude is told a figure is pending and to call the tool again with the same inputs", !seen.r1.isError && seen.r1.value.pending === 1 && /didn't come back in time/.test(seen.r1.value.note) && /call query_statutory again with the same inputs/.test(seen.r1.value.note), seen.r1?.value?.note);
  ok("the second call carries on: complete, with no note", !seen.r2.isError && seen.r2.value.pending === 0 && seen.r2.value.note === undefined && seen.r2.value.fields[1].rows.length === 2, seen.r2?.value?.pending);
  ok("the answer finishes", w.db.jobs.get(jobId)?.status === "done", w.db.jobs.get(jobId)?.status);
}

done();
