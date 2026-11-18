// Stand-ins the function tests share: an in-memory database, a fake S&P API, a fake Snowflake and a fake
// Anthropic API. Nothing here touches a real service, and every company, filing and figure is made up.

import type { Db, Entity, Job, JobPatch, JobStatus, StoreKind, StoreRow } from "../../../supabase/functions/_shared/db.ts";
import type { FoundFiling, WatchRun, WatchRunPatch } from "../../../supabase/functions/_shared/db.ts";
import type { DigestQuery, DigestRow } from "../../../supabase/functions/_shared/db.ts";
import { entityLabel, groupNamePattern, oneEach, planEntityWrites, withSameCompanies } from "../../../supabase/functions/_shared/db.ts";
import { LIBRARY_MISSING, type LibraryRow } from "../../../supabase/functions/_shared/db.ts";

export const read = (name: string) => JSON.parse(Deno.readTextFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));
export const J = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });

/** A clock tests control. sleep() moves it forward instead of waiting. */
export function fakeClock(start = "2026-11-13T12:00:00Z") {
  const c = { now: Date.parse(start), slept: [] as number[], fn: () => c.now, sleep: async (ms: number) => { c.slept.push(ms); c.now += ms; } };
  return c;
}
export type Clock = ReturnType<typeof fakeClock>;

/** The same rules as migration 0001 (snl_take_slot, the tables and who can change a job), held in memory. */
export function memoryDb(clock: Clock) {
  const store = new Map<string, StoreRow>(), settings = new Map<string, Record<string, unknown>>();
  const jobs = new Map<string, Job>(), states = new Map<string, { state: Record<string, unknown>; updated_at: string }>();
  const usage = new Map<string, number>();
  let nextAt = 0, jobSeq = 0;
  const iso = () => new Date(clock.now).toISOString();
  const entityDocs = () => [...store.values()].filter((r) => r.kind === "entity").map((r) => r.doc as unknown as Entity);
  const hour = () => "hour:" + iso().slice(0, 13), day = () => "day:" + iso().slice(0, 10);
  const db: Db & { store: typeof store; settings: typeof settings; jobs: typeof jobs; states: typeof states; slots: number[]; stateWrites: number } = {
    store, settings, jobs, states, slots: [], stateWrites: 0,
    async takeSlot(limits) {
      const h = usage.get(hour()) ?? 0, d = usage.get(day()) ?? 0;
      if (h >= limits.hour || d >= limits.day) return { allowed: false, waitMs: 0, hour: h, day: d };
      const slot = Math.max(nextAt, clock.now);
      nextAt = slot + 1000;
      usage.set(hour(), h + 1); usage.set(day(), d + 1);
      db.slots.push(slot);
      return { allowed: true, waitMs: slot - clock.now, hour: h + 1, day: d + 1 };
    },
    async usage() { return { hour: usage.get(hour()) ?? 0, day: usage.get(day()) ?? 0 }; },
    async getStore(id) { const r = store.get(id); return r ? structuredClone(r) : null; },
    async putStore(row) { store.set(row.id, { id: row.id, kind: row.kind, label: row.label ?? "", doc: structuredClone(row.doc), fetched_at: iso() }); return true; },
    async lastFetched() {
      const out: Partial<Record<StoreKind, string>> = {};
      for (const r of store.values()) if (!out[r.kind] || out[r.kind]! < r.fetched_at) out[r.kind] = r.fetched_at;
      return out;
    },
    async findEntities(q, limit) {
      const t = q.trim().toLowerCase();
      const found = [...store.values()].filter((r) => r.kind === "entity").map((r) => r.doc as unknown as Entity)
        .filter((e) => /^\d+$/.test(t) ? [e.naicCompanyCode, e.companyId, e.institutionId].includes(t) : t.length >= 2 && e.companyName.toLowerCase().includes(t))
        .slice(0, limit);
      // as the real one reads: a company saved twice is listed once, with what both rows know
      return withSameCompanies(found, entityDocs()).slice(0, limit);
    },
    async putEntities(entities) {
      // the same merge the real one makes: into the row already saved for the company, any second row folded in
      const plan = planEntityWrites([...store.values()].filter((r) => r.kind === "entity").map((r) => ({ id: r.id, doc: r.doc as unknown as Entity })), entities);
      for (const r of plan.rows) store.set(r.id, { id: r.id, kind: "entity", label: entityLabel(r.doc), doc: r.doc as unknown as Record<string, unknown>, fetched_at: iso() });
      for (const id of plan.drop) store.delete(id);
    },
    async entitiesInGroup(groupCode, limit) { return withSameCompanies(entityDocs().filter((e) => e.naicGroupCode === groupCode).slice(0, limit), entityDocs()).slice(0, limit); },
    async entitiesInGroupName(groupName, limit) {
      // The same filter the real one sends (ilike '%text%'): the text anywhere in the group name, any letter case.
      const pattern = groupNamePattern(groupName);
      if (!pattern) return [];
      const re = new RegExp("^" + pattern.split("%").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "is");
      const rows = [...store.values()].filter((r) => r.kind === "entity" && re.test(String((r.doc as Record<string, unknown>).naicGroupName ?? ""))).sort((a, b) => a.label.localeCompare(b.label));
      return withSameCompanies(oneEach(rows.map((r) => r.doc as unknown as Entity)).slice(0, limit), entityDocs()).slice(0, limit);
    },
    async getSetting(id) { return settings.get(id) ?? null; },
    // the Live check's two reads: the latest saved results of a kind, and the company list without names
    async recentStore(kind, limit) { return [...store.values()].filter((r) => r.kind === kind).sort((a, b) => b.fetched_at.localeCompare(a.fetched_at)).slice(0, limit).map((r) => structuredClone(r)); },
    async entityFields(limit) {
      return [...store.values()].filter((r) => r.kind === "entity").slice(0, limit).map((r) => {
        const e = r.doc as Record<string, unknown>, s = (v: unknown) => (v === null || v === undefined ? null : String(v));
        return { companyId: s(e.companyId), institutionId: s(e.institutionId), spStatEntityId: s(e.spStatEntityId), naicCompanyCode: s(e.naicCompanyCode), naicGroupCode: s(e.naicGroupCode), naicGroupName: s(e.naicGroupName) };
      });
    },
    ...watchTables(clock),
    ...libraryTables(clock),
    async createJob(owner, question) {
      const id = `00000000-0000-4000-8000-${String(++jobSeq).padStart(12, "0")}`;
      jobs.set(id, { id, owner, status: "queued", question, progress: [], partial: "", result: null, error: null, segments: 0, created_at: iso(), updated_at: iso(), heartbeat_at: iso() });
      return id;
    },
    async getJob(id) { const j = jobs.get(id); return j ? structuredClone(j) : null; },
    async updateJob(id, patch: JobPatch) { const j = jobs.get(id); if (j) Object.assign(j, structuredClone(patch), { updated_at: iso(), heartbeat_at: iso() }); },
    async claimJob(id, from: JobStatus[], staleMs) {
      const j = jobs.get(id);
      if (!j || !from.includes(j.status)) return false;
      if (staleMs !== undefined && !(Date.parse(j.heartbeat_at) < clock.now - staleMs)) return false;
      Object.assign(j, { status: "running", updated_at: iso(), heartbeat_at: iso() });
      return true;
    },
    async getJobState(id) { const s = states.get(id); return s ? JSON.parse(JSON.stringify(s.state)) : null; },
    async putJobState(id, state) { db.stateWrites++; states.set(id, { state: JSON.parse(JSON.stringify(state)), updated_at: iso() }); },
    async dropJobState(id) { states.delete(id); },
    async activeJob(owner, since) { return [...jobs.values()].find((j) => j.owner === owner && ["queued", "running", "paused"].includes(j.status) && j.heartbeat_at >= since)?.id ?? null; },
    async dropOldJobs(before) { for (const [id, j] of jobs) if (["done", "error"].includes(j.status) && j.created_at < before) jobs.delete(id); },
    async oldJobStates(before, limit) { return [...states.entries()].filter(([, s]) => s.updated_at < before).slice(0, limit).map(([jobId, s]) => ({ jobId, state: structuredClone(s.state) })); },
    async countJobsSince(owner, since) { return [...jobs.values()].filter((j) => j.owner === owner && j.created_at >= since).length; },
    async usageSince(owner, since) {
      return [...jobs.values()].filter((j) => j.owner === owner && j.status === "done" && j.created_at >= since)
        .map((j) => (j.result as { usage?: unknown } | null)?.usage).filter((u): u is Record<string, unknown> => !!u && typeof u === "object" && !Array.isArray(u)).map((u) => structuredClone(u));
    },
  };
  return db;
}
export type MemoryDb = ReturnType<typeof memoryDb>;

/** The watchlist's two tables (migration 0003) in memory, with the same one-running-check rule. runs and found are
    the rows, for tests to look at. */
export function watchTables(clock: Clock) {
  const runs: WatchRun[] = [], found = new Map<string, FoundFiling>();
  let seq = 0;
  const iso = () => new Date(clock.now).toISOString();
  const t: Pick<Db, "startWatchRun" | "finishWatchRun" | "addWatchRun" | "watchRuns" | "lastWatchScope" | "seenFilings" | "addFoundFilings" | "foundFilings" | "dropOldWatch"> & { runs: WatchRun[]; found: Map<string, FoundFiling> } = {
    runs, found,
    async startWatchRun(trigger, staleMs, staleMessage) {
      for (const r of runs) if (r.status === "running" && Date.parse(r.started_at) < clock.now - staleMs) Object.assign(r, { status: "failed", finished_at: iso(), message: staleMessage });
      if (runs.some((r) => r.status === "running")) return null;
      const id = `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;
      runs.push({ id, status: "running", trigger, started_at: iso(), finished_at: null, requests: 0, found: 0, new_count: 0, baseline: false, complete: true, emailed: 0, message: null, scope: null });
      return id;
    },
    async finishWatchRun(id, patch: WatchRunPatch) { const r = runs.find((x) => x.id === id); if (r) Object.assign(r, structuredClone(patch), { finished_at: iso() }); },
    async addWatchRun(run) { runs.push({ ...structuredClone(run), id: `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}` }); },
    async watchRuns(limit) { return structuredClone([...runs].sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id)).slice(0, limit)); },
    async lastWatchScope() { return structuredClone([...runs].filter((r) => r.status === "ok" && r.complete && r.scope).sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))[0]?.scope ?? null); },
    async seenFilings(ids) { return ids.filter((id) => found.has(id)); },
    async addFoundFilings(rows) { for (const r of rows) if (!found.has(r.filing_version_id)) found.set(r.filing_version_id, structuredClone(r)); },
    async foundFilings(limit) {
      return structuredClone([...found.values()].filter((r) => !r.baseline).sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at) || String(b.publish_date ?? "").localeCompare(String(a.publish_date ?? ""))).slice(0, limit));
    },
    async dropOldWatch(before) {
      for (const [k, r] of found) if (r.first_seen_at < before) found.delete(k);
      for (let i = runs.length - 1; i >= 0; i--) if (runs[i].status !== "running" && runs[i].started_at < before) runs.splice(i, 1);
    },
  };
  return t;
}

/** The team library (migration 0007) in memory, with the same one-entry-per-answer rule, plus the logins' display
    names. library and profiles are the rows, for tests to look at; libraryFlags.missing = true acts as if the
    migration hadn't been run (every library call fails as the real one does). */
export function libraryTables(clock: Clock) {
  const library = new Map<string, LibraryRow>(), profiles = new Map<string, string>();
  let seq = 0;
  const iso = () => new Date(clock.now).toISOString();
  const libraryFlags = { missing: false };
  const gate = () => { if (libraryFlags.missing) throw new Error(LIBRARY_MISSING); };
  const t: Required<Pick<Db, "profileName" | "libraryCount" | "libraryGet" | "libraryByJob" | "libraryAdd" | "libraryUpdate" | "libraryRemove">> & { library: typeof library; profiles: typeof profiles; libraryFlags: typeof libraryFlags } = {
    library, profiles, libraryFlags,
    async profileName(uid) { return profiles.get(uid) ?? null; },
    async libraryCount() { gate(); return library.size; },
    async libraryGet(id) { gate(); const r = library.get(id); return r ? structuredClone(r) : null; },
    async libraryByJob(jobId) { gate(); const r = [...library.values()].find((x) => x.job_id === jobId); return r ? structuredClone(r) : null; },
    async libraryAdd(row) {
      gate();
      if ([...library.values()].some((x) => x.job_id === row.job_id)) return null;
      const id = `00000000-0000-4000-a000-${String(++seq).padStart(12, "0")}`;
      library.set(id, { ...structuredClone(row), id, saved_at: iso(), updated_at: iso() });
      return structuredClone(library.get(id)!);
    },
    async libraryUpdate(id, patch) { gate(); const r = library.get(id); if (!r) return null; Object.assign(r, structuredClone(patch), { updated_at: iso() }); return structuredClone(r); },
    async libraryRemove(id) { gate(); return library.delete(id); },
  };
  return t;
}

// ---------- fake S&P ----------

const SPGMI = "https://api-ciq.marketintelligence.spglobal.com";
export const PDF = (pagesText: string) => new TextEncoder().encode(`%PDF-1.4\n% made-up test document\n${pagesText}\n%%EOF\n`);

export type SpCall = { path: string; method: string; query: Record<string, string>; body: any; auth: string | null; at: number };

/** S&P's token endpoint and Physical Documents API, shaped as S&P's documents describe them. */
export function fakeSpgmi(clock: Clock, opts: { username?: string; password?: string; documents?: Record<string, { bytes: Uint8Array; type?: string; name?: string }>; auth?: FakeAuthOpts } = {}) {
  const search = read("spgmi_search.json"), refs = read("spgmi_reference.json");
  const col = (name: string) => search.headers.indexOf(name);
  const state = {
    log: [] as SpCall[], tokens: 0, valid: new Set<string>(),
    /** Answer the next n data calls with this status (and body), before normal handling. */
    failNext: [] as { status: number; body?: unknown; headers?: Record<string, string> }[],
    /** Leave totalPages and the paging fields out of search responses. */
    noTotalPages: false,
    expireTokens() { state.valid.clear(); },
    calls: (path: string) => state.log.filter((c) => c.path === path),
  };
  const err = (status: number, error: string, message: string) => J({ status, timestamp: new Date(clock.now).toISOString(), requestId: "req-" + (state.log.length + 100), error, message }, status);
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init.method ?? "GET", headers = new Headers(init.headers);
    const auth = headers.get("authorization");
    const raw = typeof init.body === "string" ? init.body : "";
    const path = url.href.startsWith(SPGMI) ? url.pathname : url.href;
    if (opts.auth && (path === "/gdsapi/rest/authenticate/api/v1/token" || path === "/gdsapi/rest/authenticate/api/v1/tokenRefresh")) {
      const answer = authAnswer(opts.auth, path, raw, headers, clock, opts, state);
      if (answer) return answer;
    }
    if (path === "/gdsapi/rest/authenticate/api/v1/token") {
      state.log.push({ path, method, query: {}, body: Object.fromEntries(new URLSearchParams(raw)), auth, at: clock.now });
      const form = new URLSearchParams(raw);
      if (headers.get("content-type") !== "application/x-www-form-urlencoded" || form.get("username") !== (opts.username ?? "api-user") || form.get("password") !== (opts.password ?? "api-pass"))
        return err(401, "Unauthorized", "Invalid credentials.");
      const token = `tok-${++state.tokens}`;
      state.valid.add(token);
      return J({ access_token: token, token_type: "Bearer" });
    }
    const body = raw ? JSON.parse(raw) : undefined;
    const call: SpCall = { path: path.replace("/gds/documents", ""), method, query: Object.fromEntries(url.searchParams), body, auth, at: clock.now };
    state.log.push(call);
    if (!path.startsWith("/gds/documents/")) return err(404, "Not Found", "Invalid endpoint");
    if (!auth || !state.valid.has(auth.replace(/^Bearer /, ""))) return err(401, "Unauthorized", "Token is invalid or has expired.");
    if (opts.auth && (opts.auth.expires.get(auth.replace(/^Bearer /, "")) ?? Infinity) <= clock.now) return err(401, "Unauthorized", "Token is invalid or has expired.");
    if (url.searchParams.get("docType") !== "INSPRODFILINGS_DOCUMENTS_API") return err(400, "Bad Request", "Missing parameters: docType");
    const forced = state.failNext.shift();
    if (forced) return forced.body !== undefined ? J(forced.body, forced.status, forced.headers) : new Response(JSON.stringify({ status: forced.status, timestamp: new Date(clock.now).toISOString(), requestId: "req-forced", error: "Error", message: forced.status === 403 ? "Entitlement needed" : forced.status === 429 ? "Too many requests" : "Unknown Error" }), { status: forced.status, headers: { "content-type": "application/json", ...(forced.headers ?? {}) } });

    if (call.path === "/api/v1/reference" && method === "GET") {
      const list = refs[url.searchParams.get("referenceField") ?? ""];
      if (!list) return err(400, "Bad Request", "Invalid value: referenceField");
      return J({ numCols: list.headers.length, numRows: list.rows.length, headers: list.headers, rows: list.rows.map((row: unknown[]) => ({ row })) });
    }
    if (call.path === "/api/v1/search" && method === "POST") {
      const p = body?.properties;
      if (!p || Array.isArray(p)) return err(400, "Bad Request", "Invalid data type: properties");
      const ids = [...(p.companyId ?? []), ...(p.institutionId ?? [])];
      if (!ids.length || (p.companyId ?? []).length > 10 || (p.institutionId ?? []).length > 10) return err(400, "Bad Request", "Invalid range: companyId/institutionId (limit 10)");
      if (!p.minPublishDate || !p.maxPublishDate || !Array.isArray(p.serffFilingStateId) || !Array.isArray(p.filingStatusId)) return err(400, "Bad Request", "Missing parameters");
      if ((Date.parse(p.maxPublishDate) - Date.parse(p.minPublishDate)) / 86_400_000 > 365) return err(400, "Bad Request", "Invalid range: limitation 365 days per request");
      const hit = search.rows.filter((r: any[]) =>
        ((p.companyId ?? []).includes(r[col("companyId")]) || (p.institutionId ?? []).includes(r[col("institutionId")]))
        && p.serffFilingStateId.includes(r[col("serffFilingStateId")]) && p.filingStatusId.includes(r[col("filingStatusId")])
        && r[col("publishDate")] >= p.minPublishDate && r[col("publishDate")] <= p.maxPublishDate
        && (!p.typeOfInsuranceId || p.typeOfInsuranceId.includes(r[col("typeOfInsuranceId")]))
        && (!p.serffFilingTypeId || p.serffFilingTypeId.includes(r[col("serffFilingTypeId")]))
        && (!p.trackingNumber || p.trackingNumber.includes(r[col("trackingNumber")])));
      const size = p.pageSize ?? 500, page = p.pageNumber ?? 1, slice = hit.slice((page - 1) * size, page * size);
      return J({ numCols: search.headers.length, numRows: slice.length, ...(state.noTotalPages ? {} : { currentPageSize: slice.length, currentPage: page, totalPages: Math.max(1, Math.ceil(hit.length / size)) }),
        headers: search.headers, rows: slice.map((row: unknown[]) => ({ row })) });
    }
    if (call.path === "/api/v1/download" && method === "POST") {
      const p = body?.properties ?? {};
      const doc = opts.documents?.[String(p.documentId ?? p.filingVersionId)];
      if (!doc) return err(404, "Not Found", "Resource not found");
      return new Response(doc.bytes as unknown as BodyInit, { status: 200, headers: { "content-type": doc.type ?? "application/pdf", "content-disposition": `attachment; filename="${doc.name ?? "filing.pdf"}"`, "content-length": String(doc.bytes.length) } });
    }
    return err(405, "Method Not Allowed", "Method Not Allowed");
  }) as typeof globalThis.fetch;
  return Object.assign(state, { fetch });
}

// ---------- fake S&P sign-in, as S&P's Authenticate specification describes it ----------

/** Turns on fakeSpgmi's fuller sign-in: token lifetimes, refresh tokens and scripted failures. Make one with fakeAuth(). */
export type FakeAuthOpts = {
  /** expires_in_seconds sent with each token (a string, as in the specification); null leaves it out. */
  lifeSeconds: string | number | null;
  /** Send a refresh_token with each sign-in. */
  refresh: boolean;
  /** A refresh answer carries a new refresh token as well. */
  rotate: boolean;
  /** Answer the next sign-ins (or refreshes) with these, before normal handling. */
  signInFail: { status: number; message?: string; requestId?: string }[];
  refreshFail: { status: number; message?: string; requestId?: string }[];
  /** Access token -> when it stops working; refresh tokens S&P would take. */
  expires: Map<string, number>;
  refreshValid: Set<string>;
  signIns: number; refreshes: number;
};
export function fakeAuth(o: { lifeSeconds?: string | number | null; refresh?: boolean; rotate?: boolean } = {}): FakeAuthOpts {
  return { lifeSeconds: o.lifeSeconds === undefined ? "3600" : o.lifeSeconds, refresh: o.refresh ?? true, rotate: o.rotate ?? false, signInFail: [], refreshFail: [], expires: new Map(), refreshValid: new Set(), signIns: 0, refreshes: 0 };
}

function authAnswer(a: FakeAuthOpts, path: string, raw: string, headers: Headers, clock: Clock, opts: { username?: string; password?: string }, state: { log: SpCall[]; tokens: number; valid: Set<string> }): Response {
  const form = new URLSearchParams(raw);
  state.log.push({ path, method: "POST", query: {}, body: Object.fromEntries(form), auth: headers.get("authorization"), at: clock.now });
  // The error body in the Authenticate specification is {error, message}; a reference is added only when a test asks.
  const fail = (f: { status: number; message?: string; requestId?: string }) => J({ error: String(f.status), message: f.message ?? "Error", ...(f.requestId ? { requestId: f.requestId } : {}) }, f.status);
  if (headers.get("content-type") !== "application/x-www-form-urlencoded") return fail({ status: 400, message: "Expected a form" });
  const issue = (withRefresh: boolean) => {
    const token = `tok-${++state.tokens}`;
    state.valid.add(token);
    const life = a.lifeSeconds === null ? null : Number(a.lifeSeconds);
    if (life !== null && life > 0) a.expires.set(token, clock.now + life * 1000);   // an unreadable lifetime: the token doesn't expire
    let rt: string | undefined;
    if (withRefresh) { rt = `rt-${state.tokens}`; a.refreshValid.add(rt); }
    return J({ scope: "test", token_type: "bearer", access_token: token, ...(a.lifeSeconds === null ? {} : { expires_in_seconds: a.lifeSeconds }), ...(rt ? { refresh_token: rt } : {}) });
  };
  if (path.endsWith("/tokenRefresh")) {
    a.refreshes++;
    const forced = a.refreshFail.shift();
    if (forced) return fail(forced);
    const rt = form.get("refreshToken");
    if (!rt || !a.refreshValid.has(rt)) return fail({ status: 401, message: "User unauthorized" });
    if (a.rotate) a.refreshValid.delete(rt);
    return issue(a.rotate);
  }
  a.signIns++;
  const forced = a.signInFail.shift();
  if (forced) return fail(forced);
  if (form.get("username") !== (opts.username ?? "api-user") || form.get("password") !== (opts.password ?? "api-pass")) return fail({ status: 401, message: "User unauthorized" });
  return issue(a.refresh);
}

// ---------- fake Anthropic ----------

type Block = Record<string, any>;
export type Reply = { content: Block[]; stop_reason?: string; model?: string; usage?: Record<string, number> } | { error: { status: number; type: string; message: string } };
export type ClaudeCall = { body: any; betas: string | null; stream: boolean };

/** Turns a finished message into the server-sent events the Messages API streams. */
export function sse(message: Record<string, any>): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", { message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...message.usage, output_tokens: 0 } } });
  message.content.forEach((b: Block, index: number) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "", citations: b.citations ? [] : null } });
      for (const c of b.citations ?? []) out += ev("content_block_delta", { index, delta: { type: "citations_delta", citation: c } });
      const mid = Math.ceil(b.text.length / 2);
      for (const part of [b.text.slice(0, mid), b.text.slice(mid)]) if (part) out += ev("content_block_delta", { index, delta: { type: "text_delta", text: part } });
    } else if (b.type === "tool_use") {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    } else if (b.type === "thinking") {
      out += ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      out += ev("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature ?? "sig" } });
    } else out += ev("content_block_start", { index, content_block: b });
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  return out + ev("message_stop", {});
}

/** The Messages API and Files API. Each call to /v1/messages takes the next reply from the script; a reply can
    be a function of the request body, so a test can check what Claude was sent before answering. */
export function fakeAnthropic(script: (Reply | ((body: any, n: number) => Reply))[]) {
  const state = { calls: [] as ClaudeCall[], uploads: [] as { id: string; size: number; type: string; bytes?: Uint8Array; name?: string }[], deleted: [] as string[], left: [...script] };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init.method ?? "GET", headers = new Headers(init.headers);
    if (url.pathname === "/v1/files" && method === "POST") {
      const form = init.body as FormData;
      const file = form.get("file") as File;
      const id = `file_test${state.uploads.length + 1}`;
      state.uploads.push({ id, size: file.size, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
      return J({ id, type: "file", filename: file.name, mime_type: file.type, size_bytes: file.size, created_at: "2026-11-13T12:00:00Z", downloadable: false });
    }
    if (url.pathname.startsWith("/v1/files/") && method === "DELETE") {
      const id = url.pathname.split("/").pop()!;
      state.deleted.push(id);
      return J({ id, type: "file_deleted" });
    }
    if (url.pathname === "/v1/messages" && method === "POST") {
      const body = JSON.parse(String(init.body));
      state.calls.push({ body, betas: headers.get("anthropic-beta"), stream: body.stream === true });
      const next = state.left.shift();
      if (!next) return J({ type: "error", error: { type: "invalid_request_error", message: "the test script has no more replies" } }, 400);
      const reply = typeof next === "function" ? next(body, state.calls.length) : next;
      if ("error" in reply) return J({ type: "error", error: { type: reply.error.type, message: reply.error.message } }, reply.error.status, { "x-should-retry": "false" });
      const message = { id: `msg_test${state.calls.length}`, type: "message", role: "assistant", model: reply.model ?? body.model, content: reply.content,
        stop_reason: reply.stop_reason ?? (reply.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"), stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...(reply.usage ?? {}) } };
      if (!body.stream) return J(message);
      return new Response(sse(message), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return J({ type: "error", error: { type: "not_found_error", message: `no fake for ${method} ${url.pathname}` } }, 404);
  }) as typeof globalThis.fetch;
  return Object.assign(state, { fetch });
}

export const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
export const thinking = (): Block => ({ type: "thinking", thinking: "", signature: "sig-test" });
export const say = (text: string, citations?: Block[]): Block => ({ type: "text", text, ...(citations ? { citations } : {}) });
export const pageCite = (document_index: number, start: number, endExclusive: number, cited_text: string, document_title = "doc"): Block =>
  ({ type: "page_location", cited_text, document_index, document_title, start_page_number: start, end_page_number: endExclusive, file_id: null });

/** The tool results Claude was sent in a request, by tool_use id, parsed back from JSON. */
export function toolResults(body: any): Record<string, { value: any; isError: boolean }> {
  const out: Record<string, { value: any; isError: boolean }> = {};
  for (const m of body.messages) if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content)
    if (b.type === "tool_result") out[b.tool_use_id] = { value: JSON.parse(typeof b.content === "string" ? b.content : JSON.stringify(b.content)), isError: b.is_error === true };
  return out;
}
export const documentsIn = (body: any): Block[] => body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((b: Block) => b.type === "document") : []));

export const env = (o: Record<string, string>) => (k: string) => o[k];
export const req = (fn: string, body: unknown, method = "POST", headers: Record<string, string> = {}) =>
  new Request(`https://x.supabase.co/functions/v1/${fn}`, { method, headers: { Authorization: "Bearer u", apikey: "k", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });
export const corpdev = async () => ({ id: "user-1", role: "corpdev" }), reader = async () => ({ id: "user-2", role: "reader" }), nobody = async () => null;

export function checks() {
  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };
  const done = () => { console.log(`${pass} passed, ${fail} failed`); if (fail) Deno.exit(1); };
  return { ok, done };
}

// ---------- a stand-in for Anthropic's prompt cache ----------

/** Works out the usage Anthropic would report for a request, as its prompt cache is documented to behave: the
    request is read as tools, then system blocks, then the tool_choice, thinking and effort settings, then each
    message block. A breakpoint is a block with cache_control, plus the last block when the request has a top-level
    cache_control. The longest prefix that an earlier request wrote at one of its breakpoints is read from the
    cache; what follows, up to this request's last breakpoint, is written; the rest is uncached. A document counts
    pageTokens for each page of the uploaded file (pages counted from its page objects), or docTokens when it has
    none; any other block counts a token for every four characters. Each call takes one request body. */
export function promptCache(claude: { uploads: { id: string; bytes?: Uint8Array }[] }, pageTokens = 3000, docTokens = 2000) {
  const written = new Set<string>();
  const pagesOf = (fileId: string) => {
    const bytes = claude.uploads.find((u) => u.id === fileId)?.bytes;
    return bytes ? (new TextDecoder("latin1").decode(bytes).match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length : 0;
  };
  const strip = (b: unknown) => (b && typeof b === "object" && !Array.isArray(b) ? Object.fromEntries(Object.entries(b as Record<string, unknown>).filter(([k]) => k !== "cache_control")) : b);
  return (body: any) => {
    const units: { key: string; tokens: number; bp: boolean }[] = [];
    const add = (b: any) => {
      const key = JSON.stringify(strip(b));
      const pages = b?.type === "document" && b.source?.type === "file" ? pagesOf(b.source.file_id) : 0;
      units.push({ key, tokens: b?.type === "document" ? (pages ? pages * pageTokens : docTokens) : Math.ceil(key.length / 4), bp: !!b?.cache_control });
    };
    for (const t of body.tools ?? []) add(t);
    for (const b of typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system ?? []) add(b);
    units.push({ key: JSON.stringify({ tool_choice: body.tool_choice ?? null, thinking: body.thinking ?? null, effort: body.output_config?.effort ?? null }), tokens: 0, bp: false });
    for (const m of body.messages ?? []) {
      units.push({ key: "role:" + m.role, tokens: 0, bp: false });
      for (const b of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) add(b);
    }
    if (body.cache_control && units.length) units[units.length - 1].bp = true;
    const prefixes: string[] = [];
    let acc = "";
    for (const u of units) { acc += u.key + "\u0000"; prefixes.push(acc); }
    let hit = -1;
    for (let i = units.length - 1; i >= 0; i--) if (written.has(prefixes[i])) { hit = i; break; }
    const lastBp = units.map((u) => u.bp).lastIndexOf(true);
    const sum = (from: number, to: number) => units.slice(from, to + 1).reduce((n, u) => n + u.tokens, 0);
    units.forEach((u, i) => { if (u.bp) written.add(prefixes[i]); });
    const read = sum(0, hit), write = lastBp > hit ? sum(hit + 1, lastBp) : 0, rest = sum(Math.max(hit, lastBp) + 1, units.length - 1);
    return { input_tokens: rest, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: 200 };
  };
}

// ---------- saved filing summaries (migration 0005) ----------

/** The summaries table in memory, with the same rules as migration 0005's checks on a row. Not part of memoryDb: a test
    that wants summaries adds it, Object.assign(memoryDb(clock), digestTables(clock)), so the other suites run as before.
    rows: the saved rows; fail: a message, and every call fails with it (as a missing table would: "relation
    public.snl_digests does not exist"); gets, searches: what was asked. The search filters as the real one does: a
    form number anywhere in form_keys, or any of the words in search_body (word endings "s" and "es" ignored, as
    Postgres's English word search would). */
export function digestTables(_clock: Clock) {
  const rows = new Map<string, DigestRow>();
  const t = {
    rows, fail: "", gets: [] as { documentIds: number[]; versionIds: string[] }[], searches: [] as DigestQuery[], puts: 0,
    async getDigests(ids: { documentIds: number[]; versionIds: string[] }): Promise<DigestRow[]> {
      t.gets.push(structuredClone(ids));
      if (t.fail) throw new Error(t.fail);
      return [...rows.values()].filter((r) => (r.document_id !== null && ids.documentIds.includes(r.document_id)) || (r.filing_version_id !== null && ids.versionIds.includes(r.filing_version_id))).map((r) => structuredClone(r));
    },
    async putDigest(row: DigestRow): Promise<void> {
      if (t.fail) throw new Error(t.fail);
      const bad = !/^(v:[A-Za-z0-9._-]{8,64}|d:[0-9]{1,15})$/.test(row.id) || (row.state !== null && !/^[A-Z]{2}$/.test(row.state)) || (row.company !== null && row.company.length > 200)
        || row.form_keys.length > 4000 || row.search_body.length > 20000 || (row.filing_version_id === null && row.document_id === null) || JSON.stringify(row.doc).length >= 262144;
      if (bad) throw new Error("new row for relation \"snl_digests\" violates check constraint");
      t.puts++;
      rows.set(row.id, structuredClone(row));
    },
    async searchDigests(q: DigestQuery): Promise<DigestRow[]> {
      t.searches.push(structuredClone(q));
      if (t.fail) throw new Error(t.fail);
      const stem = (w: string) => w.toLowerCase().replace(/(es|s)$/, "");
      return [...rows.values()].filter((r) => !q.state || r.state === q.state)
        .filter((r) => (q.formKey && r.form_keys.includes(q.formKey)) || (q.words.length && q.words.some((w) => r.search_body.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((x) => stem(x) === stem(w)))))
        .sort((a, b) => b.made_at.localeCompare(a.made_at)).slice(0, q.limit).map((r) => structuredClone(r));
    },
    async countDigests(): Promise<number> { if (t.fail) throw new Error(t.fail); return rows.size; },
  };
  return t;
}
