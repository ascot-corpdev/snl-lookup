// Stand-ins for the market index suites: a made-up company list of a few hundred companies of both id kinds, a
// scripted S&P that answers searches from made-up filings the way S&P filters and pages them, and a caller for the
// snl-index function. Every company, id and filing here is made up.
(globalThis as any).__SNL_TEST__ = true;
import { entityLabel, type Entity } from "../../../supabase/functions/_shared/db.ts";
import { forgetTokens } from "../../../supabase/functions/_shared/spgmi.ts";
import { type IndexCtx, STEP_MS_PAGE } from "../../../supabase/functions/_shared/marketindex.ts";
import { Spgmi, makeGate, planLimits, type Gate } from "../../../supabase/functions/_shared/spgmi.ts";
import { corpdev, env, fakeClock, J, memoryDb, type MemoryDb } from "./fakes.ts";
import { filing, spPage, spStub } from "./more.ts";

export const SECRET = "made-up-index-secret-0123456789abcdef";
export const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", INDEX_SECRET: SECRET };
export const FV = (i: number) => `0E0E0E0E-0000-4000-8000-${String(i).padStart(12, "0")}`;
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A company as the owner's list has it. */
export function listRow(db: MemoryDb, e: Partial<Entity> & { companyName: string }) {
  const full: Entity = { companyId: null, naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...e };
  const key = full.companyId ? String(full.companyId) : full.institutionId ? `i.${full.institutionId}` : `n.${full.naicCompanyCode}`;
  db.store.set(`entity:${key}`, { id: `entity:${key}`, kind: "entity", label: entityLabel(full), doc: full as unknown as Record<string, unknown>, fetched_at: "2026-11-01T00:00:00.000Z" });
}

/** A made-up list: `byCompany` companies with an S&P company id (9300000 + k), `byInstitution` with only an
    institution id (930000 + k), and three with only a NAIC code (not searchable). Added in a shuffled order. */
export function madeUpList(db: MemoryDb, byCompany = 130, byInstitution = 270) {
  const rows: (Partial<Entity> & { companyName: string })[] = [];
  for (let k = 0; k < byCompany; k++) rows.push({ companyName: `Nonesuch Mutual No. ${k} Co`, companyId: String(9300000 + k) });
  for (let k = 0; k < byInstitution; k++) rows.push({ companyName: `Nonesuch Carrier No. ${k} Co`, institutionId: String(930000 + k), naicGroupName: `Nonesuch Holdings No. ${Math.floor(k / 9)} Group` });
  for (let k = 0; k < 3; k++) rows.push({ companyName: `Nonesuch Statutory Only ${k} Co`, naicCompanyCode: String(99000 + k) });
  let seed = 11;
  for (let k = rows.length - 1; k > 0; k--) { seed = (seed * 48271) % 2147483647; const j = seed % (k + 1); [rows[k], rows[j]] = [rows[j], rows[k]]; }
  for (const r of rows) listRow(db, r);
}

/** A made-up filing in the state, for one company of the list (by company id or institution id). */
export function F(i: number, who: { companyId?: number; institutionId?: number; name: string }, over: Record<string, unknown> = {}) {
  return filing(i, {
    filingVersionId: FV(i), companyId: who.companyId ?? null, institutionId: who.institutionId ?? null, companyName: who.name, naicCompanyCode: null, naicGroupCode: null, naicGroupName: null,
    trackingNumber: null, sfcNumber: `ZZZ${String(1000000 + i)}`, filingDescription: null, serffFilingStateId: "FL", serffFilingState: "Florida",
    publishDate: "2026-06-01", serffFilingType: "Rate", serffFilingTypeId: 1, overallRateImpact: 4.5, ...over,
  });
}

/** The made-up world: clock, in-memory database with the list, a scripted S&P answering from `rows`, and a caller.
    fail: the next n search requests answer 500; failUnit: searches whose first id is this fail every time;
    slowMs: each search request moves the clock this far. */
export function world(opts: { byCompany?: number; byInstitution?: number; rows?: Record<string, unknown>[]; secrets?: Record<string, string> } = {}) {
  forgetTokens();
  const clock = fakeClock("2026-11-18T09:00:00Z"), db = memoryDb(clock);
  madeUpList(db, opts.byCompany ?? 130, opts.byInstitution ?? 270);
  const state = { rows: opts.rows ?? [] as Record<string, unknown>[], fail: 0, failIds: new Set<number>(), slowMs: 0, pageSize: 0, status: [[1, "Approved"], [2, "Pending"], [3, "Withdrawn"]] as unknown[][] };
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") return J({ headers: ["filingStatusId", "filingStatus"], rows: state.status.map((row) => ({ row })) });
    if (state.slowMs) clock.now += state.slowMs;
    const p = call.body.properties, ids: number[] = [...(p.companyId ?? []), ...(p.institutionId ?? [])];
    if (state.fail) { state.fail--; return J({ status: 500, timestamp: "2026-11-18T09:00:00Z", requestId: "req-index-1", error: "Error", message: "Unknown Error" }, 500); }
    if (ids.some((x) => state.failIds.has(x))) return J({ status: 500, timestamp: "2026-11-18T09:00:00Z", requestId: "req-index-2", error: "Error", message: "Unknown Error" }, 500);
    const hit = state.rows.filter((r) => ((p.companyId ?? []).includes(r.companyId) || (p.institutionId ?? []).includes(r.institutionId))
      && p.serffFilingStateId.includes(r.serffFilingStateId) && p.filingStatusId.includes(r.filingStatusId)
      && String(r.publishDate) >= p.minPublishDate && String(r.publishDate) <= p.maxPublishDate);
    const size = state.pageSize || p.pageSize, page = p.pageNumber, slice = hit.slice((page - 1) * size, page * size);
    return J(spPage(slice, { totalPages: Math.max(1, Math.ceil(hit.length / size)), currentPage: page }));
  });
  const searches = () => sp.calls("/api/v1/search").map((c) => c.body.properties);
  const deps = { env: env(opts.secrets ?? SECRETS), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const send = async (r: Request, over: Record<string, unknown> = {}) => {
    const fn = await import(new URL("../../../supabase/functions/snl-index/index.ts", import.meta.url).href);
    const res: Response = await fn.handle(r, { ...deps, ...over });
    return { status: res.status, body: await res.json() };
  };
  const call = (body: unknown, over: Record<string, unknown> = {}) =>
    send(new Request("https://x.supabase.co/functions/v1/snl-index", { method: "POST", headers: { Authorization: "Bearer u", apikey: "k" }, body: JSON.stringify(body) }), over);
  const cron = (secret: string | null, body: unknown = { action: "scheduled" }, over: Record<string, unknown> = {}) =>
    send(new Request("https://x.supabase.co/functions/v1/snl-index", { method: "POST", headers: { "Content-Type": "application/json", ...(secret === null ? {} : { "x-index-secret": secret }) }, body: JSON.stringify(body) }), over);
  /** A context for calling the shared code directly, the way the function builds it. */
  const ctx = (over: Partial<IndexCtx> = {}): IndexCtx & { usedNow: () => number } => {
    const limits = planLimits(deps.env), inner: Gate = makeGate(db, limits, clock.sleep);
    let used = 0;
    const gate: Gate = async () => { await inner(); used++; };
    const api = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: sp.fetch, gate, sleep: clock.sleep, now: clock.fn });
    return { db, api, env: deps.env, now: clock.fn, limits, trigger: "manual", stepMs: STEP_MS_PAGE, used: () => used, usedNow: () => used, ...over };
  };
  return { clock, db, sp, state, searches, deps, call, cron, ctx };
}
export type World = ReturnType<typeof world>;

/** Adds other people's S&P requests to the hour's and the day's counts, as the shared counter would hold them: usage()
    reports them, and the throttle refuses a slot once the limit is reached. Returns a function that sets them again. */
export function othersUsed(db: MemoryDb, extra: { hour: number; day: number }) {
  const cur = { ...extra };
  const usage = db.usage.bind(db), take = db.takeSlot.bind(db);
  db.usage = async () => { const u = await usage(); return { hour: u.hour + cur.hour, day: u.day + cur.day }; };
  db.takeSlot = async (l) => {
    const u = await usage();
    if (u.hour + cur.hour >= l.hour || u.day + cur.day >= l.day) return { allowed: false, waitMs: 0, hour: u.hour + cur.hour, day: u.day + cur.day };
    const s = await take(l);
    return { ...s, hour: s.hour + cur.hour, day: s.day + cur.day };
  };
  return (next: { hour: number; day: number }) => Object.assign(cur, next);
}
