// Extra stand-ins for the function suites, beside fakes.ts: a scriptable S&P (for paging, shuffled columns and
// odd answers that the fixture-backed fakeSpgmi can't give), made-up filing rows, and the rules migration 0001
// puts on saved rows, read from the migration's own text. Every company, id and filing here is made up.

import { type Clock, J, type MemoryDb, type SpCall } from "./fakes.ts";

const SPGMI = "https://api-ciq.marketintelligence.spglobal.com";
export const HEADERS: string[] = JSON.parse(Deno.readTextFileSync(new URL("../../fixtures/spgmi_search.json", import.meta.url))).headers;

/** S&P's error body. */
export const spError = (status: number, message: string, requestId: string | null = "req-test-1", error = "Error") =>
  J({ status, timestamp: "2026-11-13T12:00:00Z", ...(requestId === null ? {} : { requestId }), error, message }, status);

/** A bare S&P: signs in like S&P does, then hands every documents call to the test's own handler. */
export function spStub(clock: Clock, answer: (call: SpCall, n: number) => Response | Promise<Response>, opts: { token?: (n: number) => Response } = {}) {
  const state = { log: [] as (SpCall & { contentType: string | null; accept: string | null; raw: string })[], tokens: 0, data: 0, calls: (path: string) => state.log.filter((c) => c.path === path) };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init.headers), raw = typeof init.body === "string" ? init.body : "";
    const base = { method: init.method ?? "GET", query: Object.fromEntries(url.searchParams), auth: headers.get("authorization"), at: clock.now, contentType: headers.get("content-type"), accept: headers.get("accept"), raw };
    if (url.href === `${SPGMI}/gdsapi/rest/authenticate/api/v1/token`) {
      state.log.push({ ...base, path: "token", body: Object.fromEntries(new URLSearchParams(raw)) });
      state.tokens++;
      return opts.token ? opts.token(state.tokens) : J({ access_token: `stub-${state.tokens}`, token_type: "Bearer" });
    }
    const call = { ...base, path: url.href.startsWith(`${SPGMI}/gds/documents`) ? url.pathname.replace("/gds/documents", "") : url.href, body: raw ? JSON.parse(raw) : undefined };
    state.log.push(call);
    return await answer(call, ++state.data);
  }) as typeof globalThis.fetch;
  return Object.assign(state, { fetch });
}

/** One made-up filing as an object keyed by S&P's column names. */
export function filing(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const n = String(i).padStart(6, "0");
  return {
    serffFilingEntityEventId: 600000 + i, serffFilingEventId: 700000 + i, trackingNumber: `TEST-${n}`, sfcNumber: null, institutionId: 810001, spStatEntityId: "C9101",
    naicCompanyCode: "91001", companyId: 9100001, companyName: "Calloway Insurance Co", naicGroupCode: "9100", naicGroupName: "Calloway Financial Grp",
    serffFilingStateId: "FL", serffFilingState: "Florida", typeOfInsuranceId: 4, typeOfInsurance: "Homeowners", subTypeOfInsurance: "Owner occupied homeowners",
    dateSubmitted: "2026-01-10", publishDate: "2026-02-01", renewBusReqEffDate: "2026-06-01", newBusReqEffDate: "2026-05-01", filingStatusId: 1, filingStatus: "Closed - Approved",
    serffFilingTypeId: 0, serffFilingType: "Form", overallRateImpact: null, dispOverallRateImpact: null, filingDescription: `Made-up filing ${i}.`,
    documentId: 71000000 + i, filingVersionId: `0B0B0B0B-0000-4000-8000-${String(i).padStart(12, "0")}`, pages: 10, ...over,
  };
}

/** S&P's search answer for a list of row objects. `headers` chooses the column order (and may add or drop columns). */
export function spPage(rows: Record<string, unknown>[], extra: Record<string, unknown> = {}, headers: string[] = HEADERS) {
  return { numCols: headers.length, numRows: rows.length, ...extra, headers, rows: rows.map((r) => ({ row: headers.map((h) => (h in r ? r[h] : null)) })) };
}

/** A promise that never settles: a function call that Supabase killed mid-step. */
export const never = <T = never>() => new Promise<T>(() => {});

/** The checks migration 0001 puts on public.snl_store rows, read from the migration text. */
export function storeRules() {
  const sql = Deno.readTextFileSync(new URL("../../../supabase/migrations/0001_snl.sql", import.meta.url));
  const idRe = sql.match(/create table if not exists public\.snl_store[\s\S]*?id\s+text primary key check \(id ~ '([^']+)'\)/)?.[1];
  const kinds = sql.match(/kind\s+text not null check \(kind in \(([^)]+)\)\)/)?.[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  const maxLabel = Number(sql.match(/check \(length\(label\) <= (\d+)\)/)?.[1]);
  if (!idRe || !kinds || !maxLabel) throw new Error("couldn't read snl_store's checks from the migration");
  const re = new RegExp(idRe);
  return {
    idPattern: idRe, kinds, maxLabel,
    /** What Postgres would refuse about this row, or null when it would be saved. */
    problem(row: { id: string; kind: string; label?: string; doc: unknown }): string | null {
      if (!re.test(row.id)) return `id "${row.id}" doesn't match ${idRe}`;
      if (!kinds.includes(row.kind)) return `kind "${row.kind}" isn't allowed`;
      if ((row.label ?? "").length > maxLabel) return `label is ${row.label!.length} characters, over ${maxLabel}`;
      if (!row.doc || typeof row.doc !== "object" || Array.isArray(row.doc)) return "doc must be a JSON object";
      return null;
    },
  };
}

/** Records every row a function saves and what the migration's checks would say about it. */
export function watchStore(db: MemoryDb) {
  const rules = storeRules(), saved: { id: string; kind: string; problem: string | null }[] = [];
  const put = db.putStore.bind(db);
  db.putStore = async (row) => { saved.push({ id: row.id, kind: row.kind, problem: rules.problem(row) }); return put(row); };
  return saved;
}

/** Ends a suite whose test left a function call hanging on purpose (its heartbeat timer would keep Deno alive). */
export function finish(done: () => void): never {
  done();
  Deno.exit(0);
}
