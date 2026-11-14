// The real database adapter (supabase/functions/_shared/db.ts, supabaseDb), against a stand-in Supabase client
// that records every query. The other suites use an in-memory database, so this is where the actual queries
// are pinned down: what is sent to Postgres, that typed text can't change a filter, and how failures are read.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { type Entity, entityLabel, supabaseDb } from "../../supabase/functions/_shared/db.ts";
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Op = { table: string; calls: unknown[][] };
type Answer = { data?: unknown; error?: { message: string } | null };

/** A Supabase client whose every query is recorded and answered by the test. */
function fakeSb(answer: (op: Op) => Answer | Promise<Answer> = () => ({ data: null, error: null })) {
  const ops: Op[] = [];
  const chain = (op: Op): any => new Proxy(() => {}, {
    get: (_t, k) => (k === "then" ? (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => answer(op)).then((a) => ({ data: null, error: null, ...a })).then(res, rej)
      : (...args: unknown[]) => { op.calls.push([String(k), ...args]); return chain(op); }),
  });
  const client = {
    from: (table: string) => { const op = { table, calls: [] as unknown[][] }; ops.push(op); return chain(op); },
    rpc: (name: string, args: unknown) => { const op = { table: `rpc:${name}`, calls: [["rpc", args]] as unknown[][] }; ops.push(op); return chain(op); },
  } as unknown as SupabaseClient;
  const has = (op: Op, method: string) => op.calls.find((c) => c[0] === method);
  return { ops, client, has };
}
const NOW = Date.parse("2026-11-13T12:34:56.789Z");
const ENT = (id: string, name: string, over: Partial<Entity> = {}): Entity => ({ companyId: id, companyName: name, naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...over });

// ---------- the request counter ----------
{
  let sb = fakeSb(() => ({ data: [{ allowed: true, wait_ms: 250, hour_count: 7, day_count: 90 }] }));
  let slot = await supabaseDb(sb.client, () => NOW).takeSlot({ hour: 500, day: 12_000 });
  ok("a slot is taken by calling snl_take_slot with the limits and a gap just over one second", sb.ops.length === 1 && sb.ops[0].table === "rpc:snl_take_slot" && same(sb.ops[0].calls[0][1], { p_hour_limit: 500, p_day_limit: 12_000, p_gap_ms: 1100 }), sb.ops[0]);
  ok("the function's row is read as allowed, wait and the two counts", same(slot, { allowed: true, waitMs: 250, hour: 7, day: 90 }), slot);
  sb = fakeSb(() => ({ data: { allowed: false, wait_ms: 0, hour_count: 500, day_count: 600 } }));
  slot = await supabaseDb(sb.client).takeSlot({ hour: 500, day: 12_000 });
  ok("a refusal is read as not allowed, whether Postgres sends a row or a list of one", same(slot, { allowed: false, waitMs: 0, hour: 500, day: 600 }), slot);
  sb = fakeSb(() => ({ data: [] }));
  ok("no row back is treated as not allowed, never as a free pass", (await supabaseDb(sb.client).takeSlot({ hour: 1, day: 1 })).allowed === false);
  sb = fakeSb(() => ({ data: null, error: { message: "permission denied for function snl_take_slot" } }));
  let threw: any = null;
  try { await supabaseDb(sb.client).takeSlot({ hour: 1, day: 1 }); } catch (e) { threw = e; }
  ok("if the counter can't be reached the call fails rather than going to S&P uncounted", threw instanceof Error && threw.message === "The S&P request counter didn't answer: permission denied for function snl_take_slot", threw?.message);

  sb = fakeSb(() => ({ data: [{ bucket: "hour", starts_at: "2026-11-13T12:00:00+00:00", requests: 12 }, { bucket: "day", starts_at: "2026-11-13T00:00:00+00:00", requests: 340 }, { bucket: "hour", starts_at: "2026-11-13T00:00:00+00:00", requests: 99 }] }));
  const usage = await supabaseDb(sb.client, () => NOW).usage();
  ok("usage reads this UTC hour's and this UTC day's counts", same(usage, { hour: 12, day: 340 }) && sb.ops[0].table === "snl_usage" && same(sb.has(sb.ops[0], "in"), ["in", "starts_at", ["2026-11-13T12:00:00.000Z", "2026-11-13T00:00:00.000Z"]]), { usage, op: sb.ops[0] });
  ok("with no rows yet, usage is zero", same(await supabaseDb(fakeSb(() => ({ data: [] })).client, () => NOW).usage(), { hour: 0, day: 0 }) && same(await supabaseDb(fakeSb(() => ({ data: null })).client, () => NOW).usage(), { hour: 0, day: 0 }));
}

// ---------- saved rows ----------
{
  let sb = fakeSb();
  let db = supabaseDb(sb.client, () => NOW);
  const saved = await db.putStore({ id: "ref:filingStatus", kind: "reference", label: "filingStatus", doc: { a: 1 } });
  ok("a row is saved with upsert on its id, stamped with the time", saved === true && sb.ops[0].table === "snl_store" && same(sb.has(sb.ops[0], "upsert"), ["upsert", { id: "ref:filingStatus", kind: "reference", label: "filingStatus", doc: { a: 1 }, fetched_at: "2026-11-13T12:34:56.789Z" }, { onConflict: "id" }]), sb.ops[0]);
  await db.putStore({ id: "search:abc", kind: "search", doc: {} });
  ok("a row saved with no label gets an empty one", (sb.has(sb.ops[1], "upsert")![1] as any).label === "");
  sb = fakeSb(() => ({ error: { message: 'new row for relation "snl_store" violates check constraint' } }));
  ok("a row Postgres refuses is reported as not saved", (await supabaseDb(sb.client).putStore({ id: "search:abc", kind: "search", doc: {} })) === false);
  sb = fakeSb(() => { throw new Error("fetch failed"); });
  ok("a save that fails outright is reported as not saved, not thrown", (await supabaseDb(sb.client).putStore({ id: "search:abc", kind: "search", doc: {} })) === false);

  sb = fakeSb(() => ({ data: { id: "ref:filingStatus", kind: "reference", label: "x", doc: { a: 1 }, fetched_at: "2026-11-01T00:00:00+00:00" } }));
  const row = await supabaseDb(sb.client).getStore("ref:filingStatus");
  ok("a saved row is read by its exact id", row?.kind === "reference" && same(sb.has(sb.ops[0], "eq"), ["eq", "id", "ref:filingStatus"]) && !!sb.has(sb.ops[0], "maybeSingle"));
  ok("a missing row reads as null", (await supabaseDb(fakeSb().client).getStore("ref:nope")) === null);

  sb = fakeSb((op) => ({ data: (op.calls.find((c) => c[0] === "eq")![2] === "search") ? [{ fetched_at: "2026-11-12T08:00:00+00:00" }] : [] }));
  const last = await supabaseDb(sb.client).lastFetched();
  ok("last-fetched times are read for reference lists, searches and statutory results, newest first", same(last, { search: "2026-11-12T08:00:00+00:00" }) && same(sb.ops.map((o) => o.calls.find((c) => c[0] === "eq")![2]), ["reference", "search", "statutory"]) && sb.ops.every((o) => same(sb.has(o, "order"), ["order", "fetched_at", { ascending: false }]) && same(sb.has(o, "limit"), ["limit", 1])), last);

  sb = fakeSb(() => ({ data: { doc: { fields: { surplus: {} } } } }));
  ok("a setting is read by its id from snl_settings", same(await supabaseDb(sb.client).getSetting("statutory_mapping"), { fields: { surplus: {} } }) && sb.ops[0].table === "snl_settings" && same(sb.has(sb.ops[0], "eq"), ["eq", "id", "statutory_mapping"]));
  ok("a missing setting reads as null", (await supabaseDb(fakeSb().client).getSetting("statutory_mapping")) === null);
}

// ---------- companies: typed text can't change the filter ----------
{
  const rows = [{ doc: ENT("9100001", "Calloway Insurance Co", { naicCompanyCode: "91001" }) }, { doc: ENT("9100002", "Calloway Home Co") }];
  let sb = fakeSb(() => ({ data: rows }));
  let found = await supabaseDb(sb.client).findEntities("  Calloway ", 20);
  ok("a name is looked for in the label, any case, with the limit applied", found.length === 2 && sb.ops.length === 1 && same(sb.has(sb.ops[0], "ilike"), ["ilike", "label", "%Calloway%"]) && same(sb.has(sb.ops[0], "eq"), ["eq", "kind", "entity"]) && same(sb.has(sb.ops[0], "limit"), ["limit", 20]), sb.ops[0]);
  ok("a name search never builds an or-filter", !sb.ops.some((o) => sb.has(o, "or")));

  sb = fakeSb(() => ({ data: rows }));
  found = await supabaseDb(sb.client).findEntities("91001", 20);
  const or = sb.ops.map((o) => sb.has(o, "or")).find(Boolean);
  ok("a number is matched exactly against the NAIC code, the company id and the institution id", same(or, ["or", "doc->>naicCompanyCode.eq.91001,doc->>companyId.eq.91001,doc->>institutionId.eq.91001"]), or);
  ok("the same company found both ways is listed once", found.length === 2 && sb.ops.length === 2, found.map((e) => e.companyId));

  const hostile = ["1,kind.eq.search", "91001)", "1 or 1=1", "doc->>companyId.eq.1", "9100001,doc->>companyName.neq.x", "1;drop table snl_store", "９１００１", "1e5", "-1", "1.5", "1234567890123", "0x1F", "91001\n,kind.neq.entity"];
  const leaked: string[] = [];
  for (const q of hostile) {
    sb = fakeSb(() => ({ data: [] }));
    await supabaseDb(sb.client).findEntities(q, 20);
    if (sb.ops.some((o) => sb.has(o, "or"))) leaked.push(q);
    const like = sb.ops.map((o) => sb.has(o, "ilike")).find(Boolean);
    if (like && /[%_,()*;:=<>"\\\n]/.test(String(like[2]).slice(1, -1))) leaked.push(`ilike:${q}`);
  }
  ok("text that isn't purely 1 to 12 digits never reaches the id filter, and filter punctuation never reaches the name pattern", leaked.length === 0, leaked);
  sb = fakeSb(() => ({ data: [] }));
  await supabaseDb(sb.client).findEntities("100%_sure, (Calloway) & Sons' Co.-op*", 20);
  ok("wildcards and brackets in a name are dropped; ordinary name punctuation is kept", same(sb.has(sb.ops[0], "ilike"), ["ilike", "label", "%100 sure Calloway & Sons' Co.-op%"]), sb.has(sb.ops[0], "ilike"));
  sb = fakeSb(() => ({ data: [] }));
  ok("nothing typed, or one character, asks the database nothing", (await supabaseDb(sb.client).findEntities("   ", 20)).length === 0 && (await supabaseDb(sb.client).findEntities("c", 20)).length === 0 && (await supabaseDb(sb.client).findEntities("%", 20)).length === 0 && sb.ops.length === 0, sb.ops);
  sb = fakeSb(() => ({ data: [{ doc: null }, { doc: {} }, { doc: ENT("7", "Tarrow Mutual Insurance Co") }, { doc: ENT("7", "Tarrow Mutual Insurance Co") }, { doc: ENT("8", "Tarrow Two") }] }));
  ok("rows with no company id are skipped, repeats dropped and the limit kept", same((await supabaseDb(sb.client).findEntities("tarrow", 1)).map((e) => e.companyId), ["7"]));

  sb = fakeSb();
  await supabaseDb(sb.client, () => NOW).putEntities([ENT("9100001", "Calloway Insurance Co", { naicCompanyCode: "91001", naicGroupName: "Calloway Financial Grp" }), ENT("9200001", "Tarrow Mutual Insurance Co")]);
  const up = sb.has(sb.ops[0], "upsert")!;
  ok("companies are saved one row each under entity:<companyId>, labelled with name, NAIC code and group", same((up[1] as any[]).map((r) => [r.id, r.kind, r.label]), [["entity:9100001", "entity", "Calloway Insurance Co | NAIC 91001 | Calloway Financial Grp"], ["entity:9200001", "entity", "Tarrow Mutual Insurance Co"]]) && same(up[2], { onConflict: "id" }), up[1]);
  ok("a label is never longer than the 400 characters the table allows", entityLabel(ENT("1", "N".repeat(500), { naicGroupName: "G".repeat(500) })).length === 400);
  sb = fakeSb();
  await supabaseDb(sb.client).putEntities([]);
  ok("no companies, no query", sb.ops.length === 0);
  sb = fakeSb(() => { throw new Error("fetch failed"); });
  let failed = false;
  try { await supabaseDb(sb.client).putEntities([ENT("1", "A Co")]); } catch { failed = true; }
  ok("a failed save of the company directory never fails the search", failed === false);
}

// ---------- answers ----------
{
  let sb = fakeSb(() => ({ data: { id: "00000000-0000-4000-8000-000000000001" } }));
  let db = supabaseDb(sb.client, () => NOW);
  ok("a new answer is inserted as queued for its owner and its id returned", (await db.createJob("user-1", "Q?")) === "00000000-0000-4000-8000-000000000001" && sb.ops[0].table === "snl_jobs" && same(sb.has(sb.ops[0], "insert"), ["insert", { owner: "user-1", question: "Q?", status: "queued" }]), sb.ops[0]);
  ok("if the insert fails there is no id", (await supabaseDb(fakeSb(() => ({ data: null, error: { message: "violates check" } })).client).createJob("user-1", "Q?")) === null);

  sb = fakeSb();
  db = supabaseDb(sb.client, () => NOW);
  await db.updateJob("job-1", { status: "paused", segments: 2 });
  ok("every update to an answer also moves its heartbeat", same(sb.has(sb.ops[0], "update"), ["update", { status: "paused", segments: 2, updated_at: "2026-11-13T12:34:56.789Z", heartbeat_at: "2026-11-13T12:34:56.789Z" }]) && same(sb.has(sb.ops[0], "eq"), ["eq", "id", "job-1"]), sb.ops[0]);
  await db.updateJob("job-1", {});
  ok("an empty update is a heartbeat", same(sb.has(sb.ops[1], "update"), ["update", { updated_at: "2026-11-13T12:34:56.789Z", heartbeat_at: "2026-11-13T12:34:56.789Z" }]));

  sb = fakeSb(() => ({ data: [{ id: "job-1" }] }));
  db = supabaseDb(sb.client, () => NOW);
  ok("a paused answer is claimed by one conditional update: only if it is still paused", (await db.claimJob("job-1", ["paused"])) === true && same(sb.has(sb.ops[0], "update"), ["update", { status: "running", updated_at: "2026-11-13T12:34:56.789Z", heartbeat_at: "2026-11-13T12:34:56.789Z" }]) && same(sb.has(sb.ops[0], "eq"), ["eq", "id", "job-1"]) && same(sb.has(sb.ops[0], "in"), ["in", "status", ["paused"]]) && !sb.has(sb.ops[0], "lt") && same(sb.has(sb.ops[0], "select"), ["select", "id"]), sb.ops[0]);
  await db.claimJob("job-1", ["running", "queued"], 45_000);
  ok("a running answer is claimed only if its heartbeat is older than the given time", same(sb.has(sb.ops[1], "in"), ["in", "status", ["running", "queued"]]) && same(sb.has(sb.ops[1], "lt"), ["lt", "heartbeat_at", "2026-11-13T12:34:11.789Z"]), sb.ops[1]);
  ok("no row changed means the claim was lost", (await supabaseDb(fakeSb(() => ({ data: [] })).client).claimJob("job-1", ["paused"])) === false && (await supabaseDb(fakeSb(() => ({ data: null, error: { message: "x" } })).client).claimJob("job-1", ["paused"])) === false);

  sb = fakeSb((op) => (op.table === "snl_job_state" ? { data: { state: { phase: "answer" } } } : { data: { id: "job-1", status: "paused" } }));
  db = supabaseDb(sb.client, () => NOW);
  ok("an answer and its saved place are read by id", (await db.getJob("job-1"))?.status === "paused" && same(await db.getJobState("job-1"), { phase: "answer" }) && same(sb.has(sb.ops[1], "eq"), ["eq", "job_id", "job-1"]));
  ok("a missing answer or saved place reads as null", (await supabaseDb(fakeSb().client).getJob("x")) === null && (await supabaseDb(fakeSb().client).getJobState("x")) === null);
  sb = fakeSb();
  db = supabaseDb(sb.client, () => NOW);
  await db.putJobState("job-1", { phase: "table" });
  await db.dropJobState("job-1");
  ok("a saved place is upserted by job id, as exact text so its key order survives, and deleted by job id", sb.ops[0].table === "snl_job_state" && same(sb.has(sb.ops[0], "upsert"), ["upsert", { job_id: "job-1", state: { json: '{"phase":"table"}' }, updated_at: "2026-11-13T12:34:56.789Z" }, { onConflict: "job_id" }]) && !!sb.has(sb.ops[1], "delete") && same(sb.has(sb.ops[1], "eq"), ["eq", "job_id", "job-1"]), sb.ops);
  sb = fakeSb(() => ({ data: [{ job_id: "job-9", state: { docs: [] } }] }));
  const old = await supabaseDb(sb.client).oldJobStates("2026-11-13T11:00:00.000Z", 5);
  ok("old saved places are those not updated since the given time, oldest first, up to the limit", same(old, [{ jobId: "job-9", state: { docs: [] } }]) && same(sb.has(sb.ops[0], "lt"), ["lt", "updated_at", "2026-11-13T11:00:00.000Z"]) && same(sb.has(sb.ops[0], "order"), ["order", "updated_at"]) && same(sb.has(sb.ops[0], "limit"), ["limit", 5]), sb.ops[0]);
}

{
  // The saved place is exact text. Postgres re-orders the keys of JSON it stores, and Claude must be sent back the
  // conversation byte for byte when an answer is picked up again.
  const place = { z: 1, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_filings", input: { to: "2026-11-13", from: "2021-11-13", states: ["FL"] } }] }], a: null };
  let sb = fakeSb();
  await supabaseDb(sb.client, () => NOW).putJobState("job-1", place);
  const sent = (sb.has(sb.ops[0], "upsert")![1] as { state: Record<string, unknown> }).state;
  ok("the saved place is stored as one text value", Object.keys(sent).join() === "json" && sent.json === JSON.stringify(place), sent);
  const reordered = { json: sent.json };   // what Postgres would hand back: the wrapper may be re-ordered, the text can't be
  const back = await supabaseDb(fakeSb(() => ({ data: { state: reordered } })).client).getJobState("job-1");
  ok("and reads back with every key in the order it was saved", JSON.stringify(back) === JSON.stringify(place), back);
  const olds = await supabaseDb(fakeSb(() => ({ data: [{ job_id: "job-2", state: reordered }] })).client).oldJobStates("2026-11-13T11:00:00.000Z", 5);
  ok("old saved places are unpacked the same way", JSON.stringify(olds[0].state) === JSON.stringify(place));

  // A write that fails must not pass silently: the answer would otherwise be cleared as if it had been saved.
  const failing = supabaseDb(fakeSb(() => ({ data: null, error: { message: "connection reset" } })).client, () => NOW);
  const thrown = async (work: Promise<unknown>) => { try { await work; return null; } catch (e) { return (e as Error).message; } };
  ok("a failed progress write raises", /Couldn't save the answer's progress: connection reset/.test(await thrown(failing.updateJob("job-1", { status: "done" })) ?? ""));
  ok("a failed write of the saved place raises", /Couldn't save the answer's place: connection reset/.test(await thrown(failing.putJobState("job-1", place)) ?? ""));

  sb = fakeSb(() => ({ data: [{ id: "job-7" }] }));
  const active = await supabaseDb(sb.client).activeJob("user-1", "2026-11-13T12:24:56.789Z");
  ok("a login's answer in progress is its newest queued, running or paused answer that has shown life since the given time", active === "job-7" && sb.ops[0].table === "snl_jobs"
    && same(sb.has(sb.ops[0], "eq"), ["eq", "owner", "user-1"]) && same(sb.has(sb.ops[0], "in"), ["in", "status", ["queued", "running", "paused"]]) && same(sb.has(sb.ops[0], "gte"), ["gte", "heartbeat_at", "2026-11-13T12:24:56.789Z"]), sb.ops[0]);
  ok("none in progress reads as null", (await supabaseDb(fakeSb(() => ({ data: [] })).client).activeJob("user-1", "x")) === null);
  sb = fakeSb();
  await supabaseDb(sb.client).dropOldJobs("2026-10-14T00:00:00.000Z");
  ok("old answers are removed only when finished and created before the given time", sb.ops[0].table === "snl_jobs" && !!sb.has(sb.ops[0], "delete") && same(sb.has(sb.ops[0], "in"), ["in", "status", ["done", "error"]]) && same(sb.has(sb.ops[0], "lt"), ["lt", "created_at", "2026-10-14T00:00:00.000Z"]), sb.ops[0]);
}

{
  // Companies loaded from a list may have an institution id and no company id
  const { entityKey } = await import("../../supabase/functions/_shared/db.ts");
  const INST = ENT("x", "Calloway Coastal Co", { companyId: null, institutionId: "5000003", naicCompanyCode: "90003", naicGroupName: "Calloway Group" });
  ok("a company is keyed by its company id, or by i.<institution id> when it has none", entityKey(ENT("9100001", "A", { institutionId: "810001" })) === "9100001" && entityKey(INST) === "i.5000003" && entityKey(ENT("x", "A", { companyId: null })) === null);
  let sb = fakeSb();
  await supabaseDb(sb.client, () => NOW).putEntities([INST, ENT("x", "No ids at all", { companyId: null })]);
  const up = sb.has(sb.ops[0], "upsert")!;
  ok("an institution-only company is saved under entity:i.<institution id>, and one with no id at all is not saved", same((up[1] as any[]).map((r) => [r.id, r.label]), [["entity:i.5000003", "Calloway Coastal Co | NAIC 90003 | Calloway Group"]]), up[1]);
  sb = fakeSb();
  await supabaseDb(sb.client, () => NOW).putEntities([ENT("x", "No ids at all", { companyId: null })]);
  ok("nothing to save means nothing is sent", sb.ops.length === 0);

  const both = ENT("9100003", "Calloway Coastal Co", { institutionId: "5000003" });
  sb = fakeSb(() => ({ data: [{ doc: INST }, { doc: both }, { doc: ENT("9100001", "Calloway Insurance Co") }] }));
  const found = await supabaseDb(sb.client).findEntities("Calloway", 50);
  ok("a company loaded by institution id alone and later seen with its company id is listed once, with the company id", same(found.map((e) => e.companyId), ["9100003", "9100001"]), found);
  sb = fakeSb(() => ({ data: [{ doc: INST }] }));
  ok("an institution-only company is found like any other", same((await supabaseDb(sb.client).findEntities("Coastal", 50)).map((e) => [e.companyId, e.institutionId]), [[null, "5000003"]]));
}

done();
