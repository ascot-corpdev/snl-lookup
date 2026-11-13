// Everything the functions read from or write to Postgres, behind one small interface, so tests can swap in an
// in-memory stand-in. The real one below writes with the service role (migration 0001); logins can only read.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

export type StoreKind = "reference" | "search" | "entity" | "discover" | "statutory";
export type StoreRow = { id: string; kind: StoreKind; label: string; doc: Record<string, unknown>; fetched_at: string };

/** A company S&P has returned before. Field names are S&P's own search columns. */
export type Entity = {
  companyId: string; companyName: string; naicCompanyCode: string | null; institutionId: string | null;
  spStatEntityId: string | null; naicGroupCode: string | null; naicGroupName: string | null;
};

export type Slot = { allowed: boolean; waitMs: number; hour: number; day: number };
export type Usage = { hour: number; day: number };

export type JobStatus = "queued" | "running" | "paused" | "done" | "error";
export type Step = { at: string; text: string };
export type Job = {
  id: string; owner: string; status: JobStatus; question: string; progress: Step[]; partial: string;
  result: Record<string, unknown> | null; error: string | null; segments: number;
  created_at: string; updated_at: string; heartbeat_at: string;
};
export type JobPatch = Partial<Pick<Job, "status" | "progress" | "partial" | "result" | "error" | "segments">>;

export interface Db {
  /** Takes the next one-second S&P slot and counts the request (migration 0001, snl_take_slot). */
  takeSlot(limits: Usage): Promise<Slot>;
  /** S&P requests counted this hour and today (UTC). */
  usage(): Promise<Usage>;
  getStore(id: string): Promise<StoreRow | null>;
  putStore(row: { id: string; kind: StoreKind; label?: string; doc: Record<string, unknown> }): Promise<boolean>;
  /** When each kind of saved result was last fetched. */
  lastFetched(): Promise<Partial<Record<StoreKind, string>>>;
  /** Companies seen before whose name contains the text, or whose NAIC code or S&P id equals it. */
  findEntities(q: string, limit: number): Promise<Entity[]>;
  putEntities(entities: Entity[]): Promise<void>;
  getSetting(id: string): Promise<Record<string, unknown> | null>;
  createJob(owner: string, question: string): Promise<string | null>;
  getJob(id: string): Promise<Job | null>;
  /** Updates a job and its heartbeat. */
  updateJob(id: string, patch: JobPatch): Promise<void>;
  /** Moves a job to "running" only if it is in one of the given states and (when given) its heartbeat is older
      than staleMs. Returns whether this caller won it, so two calls can't run the same answer. */
  claimJob(id: string, from: JobStatus[], staleMs?: number): Promise<boolean>;
  getJobState(id: string): Promise<Record<string, unknown> | null>;
  putJobState(id: string, state: Record<string, unknown>): Promise<void>;
  dropJobState(id: string): Promise<void>;
  /** Saved places of answers that haven't moved since the given time, so their leftovers can be cleared. */
  oldJobStates(before: string, limit: number): Promise<{ jobId: string; state: Record<string, unknown> }[]>;
  /** The login's answer that is still going (queued, running or paused) and has shown life since the given time. */
  activeJob(owner: string, since: string): Promise<string | null>;
  /** Removes finished answers created before the given time. */
  dropOldJobs(before: string): Promise<void>;
}

// A saved place is kept as text inside its row. Postgres re-orders the keys of JSON it stores, and Claude must
// be sent back exactly the conversation it produced, byte for byte, when an answer is picked up again.
const pack = (state: Record<string, unknown>) => ({ json: JSON.stringify(state) });
const unpack = (v: unknown): Record<string, unknown> | null => {
  if (!v || typeof v !== "object") return null;
  const json = (v as { json?: unknown }).json;
  return typeof json === "string" ? JSON.parse(json) : v as Record<string, unknown>;
};

export function entityLabel(e: Entity): string {
  return [e.companyName, e.naicCompanyCode ? `NAIC ${e.naicCompanyCode}` : "", e.naicGroupName ?? ""].filter(Boolean).join(" | ").slice(0, 400);
}

// A little over S&P's one second, because the wait is measured in the database and slept in the function.
const GAP_MS = 1100;

const hourStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString();
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

export function supabaseDb(sb: SupabaseClient, now: () => number = Date.now): Db {
  const nowIso = () => new Date(now()).toISOString();
  return {
    async takeSlot(limits) {
      const { data, error } = await sb.rpc("snl_take_slot", { p_hour_limit: limits.hour, p_day_limit: limits.day, p_gap_ms: GAP_MS });
      if (error) throw new Error(`The S&P request counter didn't answer: ${error.message}`);
      const r = Array.isArray(data) ? data[0] : data;
      return { allowed: !!r?.allowed, waitMs: Number(r?.wait_ms ?? 0), hour: Number(r?.hour_count ?? 0), day: Number(r?.day_count ?? 0) };
    },
    async usage() {
      const d = new Date(now());
      const { data } = await sb.from("snl_usage").select("bucket,starts_at,requests").in("starts_at", [hourStart(d), dayStart(d)]);
      const find = (bucket: string, at: string) => Number((data ?? []).find((r) => r.bucket === bucket && new Date(r.starts_at).toISOString() === at)?.requests ?? 0);
      return { hour: find("hour", hourStart(d)), day: find("day", dayStart(d)) };
    },
    async getStore(id) {
      const { data } = await sb.from("snl_store").select("id,kind,label,doc,fetched_at").eq("id", id).maybeSingle();
      return (data as StoreRow | null) ?? null;
    },
    async putStore(row) {
      try {
        const { error } = await sb.from("snl_store").upsert({ id: row.id, kind: row.kind, label: row.label ?? "", doc: row.doc, fetched_at: nowIso() }, { onConflict: "id" });
        return !error;
      } catch { return false; }
    },
    async lastFetched() {
      const out: Partial<Record<StoreKind, string>> = {};
      for (const kind of ["reference", "search", "statutory"] as StoreKind[]) {
        const { data } = await sb.from("snl_store").select("fetched_at").eq("kind", kind).order("fetched_at", { ascending: false }).limit(1);
        if (data?.[0]?.fetched_at) out[kind] = data[0].fetched_at;
      }
      return out;
    },
    async findEntities(q, limit) {
      const text = q.trim();
      if (!text) return [];
      // Letters, digits, spaces and a few name characters only, so the text can't change the filter.
      const safe = text.replace(/[^\p{L}\p{N} .&'-]/gu, " ").replace(/\s+/g, " ").trim();
      const byId = /^[0-9]{1,12}$/.test(text)
        ? await sb.from("snl_store").select("doc").eq("kind", "entity").or(`doc->>naicCompanyCode.eq.${text},doc->>companyId.eq.${text},doc->>institutionId.eq.${text}`).limit(limit)
        : { data: [] as { doc: Entity }[] };
      const byName = safe.length >= 2
        ? await sb.from("snl_store").select("doc").eq("kind", "entity").ilike("label", `%${safe.replace(/[%_]/g, " ")}%`).order("label").limit(limit)
        : { data: [] as { doc: Entity }[] };
      const seen = new Set<string>(), out: Entity[] = [];
      for (const r of [...(byId.data ?? []), ...(byName.data ?? [])]) {
        const e = r.doc as Entity;
        if (e?.companyId && !seen.has(e.companyId)) { seen.add(e.companyId); out.push(e); }
      }
      return out.slice(0, limit);
    },
    async putEntities(entities) {
      if (!entities.length) return;
      const rows = entities.map((e) => ({ id: `entity:${e.companyId}`, kind: "entity", label: entityLabel(e), doc: e, fetched_at: nowIso() }));
      try { await sb.from("snl_store").upsert(rows, { onConflict: "id" }); } catch { /* the directory is a convenience; a failed save never fails a search */ }
    },
    async getSetting(id) {
      const { data } = await sb.from("snl_settings").select("doc").eq("id", id).maybeSingle();
      return (data?.doc as Record<string, unknown> | undefined) ?? null;
    },
    async createJob(owner, question) {
      const { data, error } = await sb.from("snl_jobs").insert({ owner, question, status: "queued" }).select("id").single();
      return error ? null : (data.id as string);
    },
    async getJob(id) {
      const { data } = await sb.from("snl_jobs").select("*").eq("id", id).maybeSingle();
      return (data as Job | null) ?? null;
    },
    async updateJob(id, patch) {
      const { error } = await sb.from("snl_jobs").update({ ...patch, updated_at: nowIso(), heartbeat_at: nowIso() }).eq("id", id);
      if (error) throw new Error(`Couldn't save the answer's progress: ${error.message}`);
    },
    async claimJob(id, from, staleMs) {
      let q = sb.from("snl_jobs").update({ status: "running", updated_at: nowIso(), heartbeat_at: nowIso() }).eq("id", id).in("status", from);
      if (staleMs !== undefined) q = q.lt("heartbeat_at", new Date(now() - staleMs).toISOString());
      const { data, error } = await q.select("id");
      return !error && (data?.length ?? 0) === 1;
    },
    async getJobState(id) {
      const { data } = await sb.from("snl_job_state").select("state").eq("job_id", id).maybeSingle();
      return unpack(data?.state);
    },
    async putJobState(id, state) {
      const { error } = await sb.from("snl_job_state").upsert({ job_id: id, state: pack(state), updated_at: nowIso() }, { onConflict: "job_id" });
      if (error) throw new Error(`Couldn't save the answer's place: ${error.message}`);
    },
    async dropJobState(id) {
      await sb.from("snl_job_state").delete().eq("job_id", id);
    },
    async oldJobStates(before, limit) {
      const { data } = await sb.from("snl_job_state").select("job_id,state").lt("updated_at", before).order("updated_at").limit(limit);
      return (data ?? []).map((r) => ({ jobId: r.job_id as string, state: unpack(r.state) ?? {} }));
    },
    async activeJob(owner, since) {
      const { data } = await sb.from("snl_jobs").select("id").eq("owner", owner).in("status", ["queued", "running", "paused"]).gte("heartbeat_at", since).order("created_at", { ascending: false }).limit(1);
      return (data?.[0]?.id as string | undefined) ?? null;
    },
    async dropOldJobs(before) {
      try { await sb.from("snl_jobs").delete().in("status", ["done", "error"]).lt("created_at", before); } catch { /* housekeeping: tried again next time */ }
    },
  };
}
