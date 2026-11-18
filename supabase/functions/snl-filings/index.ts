// Filing search for SNL lookup: S&P's SNL Insurance Product Filings, through S&P's Physical Documents API.
// Any signed-in login may call it. The S&P credentials stay here as Supabase secrets. Search results and
// reference lists are saved to public.snl_store (migration 0001), so the page opens from the last fetch and asks
// S&P again only on Refresh. Filing documents are passed straight through and never kept.
//
// Secrets (supabase secrets set ...): SPGMI_API_USERNAME, SPGMI_API_PASSWORD.
// Optional: SPGMI_ACCOUNT ("trial", the default, or "production": which S&P limits apply), ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-filings --no-verify-jwt
//
// POST /functions/v1/snl-filings  {"action": ...}
//   status                                        -> what is set up, S&P requests used, when data was last fetched
//   reference {field?, refresh?}                  -> S&P's id lists (types of insurance, statuses, states, filing types)
//   resolve   {q}                                 -> companies in the app's company list, by name, NAIC code or S&P id,
//                                                    and whole groups whose name or group code matches {groups, groupNote}
//   search    {companyIds, institutionIds, states, from, to, filingStatusIds?, typeOfInsuranceIds?, filingTypeIds?,
//              spStatEntityIds?, trackingNumbers?, refresh?, unlisted?, steps?, cursor?}
//                                                 -> {rows, total, notes, byState, byCompany, requests, capped, fetchedAt, ...}
//                                                    At most STEP_ROWS filings a call. With steps: true, a wider search
//                                                    comes in parts: {..., part, parts, partsAbout, more, cursor}; send the
//                                                    same search with that cursor for the next part (_shared/filings.ts).
//   document  {documentId} or {filingVersionId}   -> the document itself, as S&P sends it (usually a PDF)
//   check                                         -> the S&P connection check: sign-in, entitlement, the four lists
//                                                    (at most five S&P requests), as a plain-English report
//   diagnose                                      -> the Live check (Corp Dev only): shapes and counts of real S&P answers,
//                                                    never S&P's data (at most six S&P requests), _shared/diagnose.ts

import { adminClient, type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { downloadDocument, getReference, MAX_SEARCH_REQUESTS, parseDocRef, parseSearch, type Reference, REFERENCE_FIELDS, type ReferenceField, resolveEntity, savedOrFreshSearch } from "../_shared/filings.ts";
import { groupChoices } from "../_shared/filings.ts";
import { searchStep, StepError } from "../_shared/filings.ts";
import { clearOld } from "../_shared/chat.ts";
import { type Gate, makeGate, NOT_CONFIGURED, planLimits, Spgmi, SpgmiError } from "../_shared/spgmi.ts";
import { snowflakeConfigured } from "../_shared/snowflake.ts";
import { checkConnection } from "../_shared/connection.ts";
import { diagnose } from "../_shared/diagnose.ts";

export type Deps = { env: Env; fetch: typeof fetch; anthropicFetch?: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; gate?: Gate; sleep?: (ms: number) => Promise<void> };

const SEARCH_TIME_MS = 100_000;   // a search must answer inside Supabase's 150 seconds

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The filings function", (json, cors) => serve(req, deps, json, cors));
}

/** What S&P's error means for the page: the HTTP status to answer with and the body. */
export function spgmiAnswer(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(e instanceof SpgmiError)) return null;
  const status = e.code === "not_configured" ? 503 : e.code === "limit" || e.code === "rate_limited" ? 429 : e.code === "bad_request" ? 400 : e.code === "not_found" ? 404 : 502;
  return { status, body: { error: e.code === "not_configured" ? "not_configured" : `spgmi_${e.code}`, message: e.message, requestId: e.requestId } };
}

async function serve(req: Request, deps: Deps, json: Json, cors: Record<string, string>): Promise<Response> {
  const who = await (deps.whoIs ?? whoIs(deps.env))(req);
  if (!who) return json(401, { error: "signin", message: "Sign in again." });
  const body = await readBody(req);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });

  const now = (deps.now ?? Date.now)();
  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, deps.now ?? Date.now) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const limits = planLimits(deps.env);
  const creds = Spgmi.creds(deps.env);
  const configured = Spgmi.configured(creds);
  const wait = deps.sleep ?? sleep;
  const api = configured ? new Spgmi(creds, { fetch: deps.fetch, gate: deps.gate ?? makeGate(db, limits, wait), sleep: wait, now: deps.now }) : null;
  const usage = async () => ({ used: await db.usage(), limits: { hour: limits.hour, day: limits.day }, account: limits.plan });

  try {
    switch (body.action) {
      case "status": {
        // Opening the app is also when leftovers are cleared: documents from answers that were abandoned are
        // deleted from Anthropic, and finished answers over 30 days old are removed.
        if (deps.env("ANTHROPIC_API_KEY")) await clearOld(db, { env: deps.env, anthropicFetch: deps.anthropicFetch, now: deps.now ?? Date.now });
        const last = await db.lastFetched();
        return json(200, {
          filings: { configured, message: configured ? null : NOT_CONFIGURED, ...(await usage()) },
          statutory: { configured: snowflakeConfigured(deps.env) },
          claude: { configured: !!deps.env("ANTHROPIC_API_KEY") },
          refreshed: { reference: last.reference ?? null, search: last.search ?? null, statutory: last.statutory ?? null },
          role: who.role,
        });
      }

      case "reference": {
        const fields = body.field === undefined ? [...REFERENCE_FIELDS] : REFERENCE_FIELDS.includes(body.field as ReferenceField) ? [body.field as ReferenceField] : null;
        if (!fields) return json(400, { error: "bad", message: `field must be one of: ${REFERENCE_FIELDS.join(", ")}.` });
        const lists: Record<string, Reference | null> = {};
        for (const f of fields) lists[f] = await getReference(api, db, f, { refresh: body.refresh === true, now });
        const missing = fields.filter((f) => !lists[f]);
        return json(200, { lists, missing, message: missing.length && !configured ? NOT_CONFIGURED : null, ...(await usage()) });
      }

      case "resolve": {
        if (typeof body.q !== "string" || !body.q.trim()) return json(400, { error: "bad", message: "Type a company name, a NAIC code or an S&P id." });
        // The companies that match, and whole groups whose name or NAIC group code matches, to add in one click.
        return json(200, { ...(await resolveEntity(db, body.q)), ...(await groupChoices(db, body.q)) });
      }

      case "search": {
        const parsed = parseSearch(body, new Date(now).toISOString().slice(0, 10));
        if (!parsed.ok) return json(400, { error: "bad", message: parsed.message });
        // unlisted: kept out of the shared Recent searches list (still saved, so the same search costs nothing again).
        const o = { now, refresh: body.refresh === true, maxRequests: MAX_SEARCH_REQUESTS, deadline: now + SEARCH_TIME_MS, clock: deps.now ?? Date.now, unlisted: body.unlisted === true };
        // steps: the page fetches a wide search in parts, one call each; without it a search stops at one part's worth
        const answer = body.steps === true ? await searchStep(api, db, parsed.params, { ...o, cursor: body.cursor }) : await savedOrFreshSearch(api, db, parsed.params, o);
        return json(200, { ...answer, ...(await usage()) });
      }

      case "document": {
        const ref = parseDocRef(body);
        if (!ref) return json(400, { error: "bad", message: "Send a documentId (a number) or a filingVersionId." });
        if (!api) return json(503, { error: "not_configured", message: NOT_CONFIGURED });
        const res = await downloadDocument(api, ref);
        const headers: Record<string, string> = { ...cors, "Content-Type": res.headers.get("content-type") || "application/octet-stream", "Cache-Control": "private, no-store" };
        // S&P's length is passed on only when the body isn't compressed: fetch unpacks a compressed body but
        // leaves the compressed length on the response, which would no longer match what the browser gets.
        const disposition = res.headers.get("content-disposition"), length = res.headers.get("content-encoding") ? null : res.headers.get("content-length");
        if (disposition) headers["Content-Disposition"] = disposition;
        if (length) headers["Content-Length"] = length;
        // Passed straight through to the browser: the function keeps no copy.
        return new Response(res.body, { status: 200, headers });
      }

      case "check":
        return json(200, await checkConnection({ creds, db, gate: deps.gate ?? makeGate(db, limits, wait), fetch: deps.fetch, sleep: wait, now: deps.now ?? Date.now, plan: limits.plan, limits }));

      case "diagnose":
        if (who.role !== "corpdev") return json(403, { error: "forbidden", message: "Only Corp Dev logins can run the Live check." });
        return json(200, await diagnose({ creds, db, gate: deps.gate ?? makeGate(db, limits, wait), fetch: deps.fetch, sleep: wait, now: deps.now ?? Date.now, plan: limits.plan, limits }));

      default:
        return json(400, { error: "bad", message: "Unknown action. Use status, reference, resolve, search, document or check." });
    }
  } catch (e) {
    if (e instanceof StepError) return json(409, { error: e.code === "moved" ? "search_moved" : "search_lost", message: e.message });
    const answer = spgmiAnswer(e);
    if (answer) return json(answer.status, answer.body);
    throw e;
  }
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
