// Statutory financials for SNL lookup: SNL Insurance Regulatory Data on Snowflake, by NAIC company or group code.
// Built ready to switch on: until the Snowflake secrets are set, every action answers "not set up yet".
// Any signed-in login may read; only Corp Dev logins may run Discover (it lists the account's views and columns).
// Results are saved to public.snl_store, so the view opens from the last fetch and asks Snowflake only on Refresh.
//
// Secrets (supabase secrets set ...): SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_WAREHOUSE and either
// SNOWFLAKE_PRIVATE_KEY (unencrypted PKCS#8 PEM) or SNOWFLAKE_PAT. Optional: SNOWFLAKE_ROLE, SNOWFLAKE_DATABASE,
// SNOWFLAKE_SCHEMA, SNOWFLAKE_HOST, ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-statutory --no-verify-jwt
//
// POST /functions/v1/snl-statutory  {"action": ...}
//   status                                     -> {configured, mapped, message, fields}
//   query    {kind, codes, fromYear?, toYear?, fields?, refresh?}
//                                              -> {entities, fields: [{id, label, unit, by, rows}], loaded, ...}
//   discover {like?, refresh?} or {view, refresh?}   (Corp Dev only)
//                                              -> the views, or one view's columns, this account can see
//            {schemas: true}, {schema, like?} or {schema, view}   (Corp Dev only; the same in another schema)
//                                              -> the database's schemas, or a schema's views, or a view's columns

import { adminClient, type Env, type Json, readBody, shortHash, sleep, type WhoIs, whoIs, withCors } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import { credsReady, Snowflake, SNOWFLAKE_NOT_CONFIGURED, snowflakeCreds, SnowflakeError } from "../_shared/snowflake.ts";
import { discoverColumns, discoverSchemas, discoverViews, fieldStatus, getMapping, isViewName, loadedProblem, NOT_MAPPED, parseStatQuery, savedOrFreshStatutory, storedName } from "../_shared/statutory.ts";

export type Deps = { env: Env; fetch: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; sleep?: (ms: number) => Promise<void> };

export { NOT_MAPPED };
const QUERY_TIME_MS = 110_000;   // a query must answer inside Supabase's 150 seconds

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The statutory function", (json) => serve(req, deps, json));
}

export function snowflakeAnswer(e: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(e instanceof SnowflakeError)) return null;
  const plain = e.code === "not_configured" || e.code === "not_mapped";
  return { status: e.code === "not_configured" ? 503 : e.code === "not_mapped" ? 409 : e.code === "busy" ? 429 : 502, body: { error: plain ? e.code : `snowflake_${e.code}`, message: e.message } };
}

async function serve(req: Request, deps: Deps, json: Json): Promise<Response> {
  const who = await (deps.whoIs ?? whoIs(deps.env))(req);
  if (!who) return json(401, { error: "signin", message: "Sign in again." });
  const body = await readBody(req);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });

  const nowFn = deps.now ?? Date.now, now = nowFn();
  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, nowFn) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const creds = snowflakeCreds(deps.env), configured = credsReady(creds);
  const mapping = await getMapping(db);
  const fields = fieldStatus(mapping), mapped = fields.some((f) => f.mapped);
  const sf = configured ? new Snowflake(creds, { fetch: deps.fetch, now: nowFn, sleep: deps.sleep ?? sleep }) : null;

  try {
    switch (body.action) {
      case "status":
        return json(200, { configured, mapped, message: !configured ? SNOWFLAKE_NOT_CONFIGURED : !mapped ? NOT_MAPPED : null, fields, loadedProblem: loadedProblem(mapping.loaded) });

      case "query": {
        const parsed = parseStatQuery(body, new Date(now).getUTCFullYear());
        if (!parsed.ok) return json(400, { error: "bad", message: parsed.message });
        return json(200, await savedOrFreshStatutory(sf, db, creds.database, creds.schema, mapping, parsed.q, parsed.fields,
          { now, refresh: body.refresh === true, deadline: now + QUERY_TIME_MS, clock: nowFn }));
      }

      case "discover": {
        if (who.role !== "corpdev") return json(403, { error: "forbidden", message: "Only Corp Dev logins can run Discover." });
        // Another schema than the default: its own saved entries, keyed by the schema as well.
        if (body.schemas === true || body.schema !== undefined && body.schema !== null) return await discoverElsewhere(body, { db, sf, json, now, database: creds.database });
        const view = body.view === undefined || body.view === null ? null : String(body.view).trim();
        if (view !== null && !isViewName(view)) return json(400, { error: "bad", message: "view must be a view name." });
        const like = typeof body.like === "string" ? body.like.trim().replace(/[^A-Za-z0-9_$]/g, "").slice(0, 60) : "";
        // The exact name or filter is hashed into the id, so two different names never share a saved entry.
        const id = view ? `discover:cols.${await shortHash(storedName(view))}` : like ? `discover:views.${await shortHash(like)}` : "discover:views";
        const saved = body.refresh === true ? null : await db.getStore(id);
        if (saved) return json(200, { ...saved.doc, fetchedAt: saved.fetched_at, fromStore: true });
        if (!sf) return json(503, { error: "not_configured", message: SNOWFLAKE_NOT_CONFIGURED });
        const doc = view ? await discoverColumns(sf, creds.database, creds.schema, view) : await discoverViews(sf, creds.database, creds.schema, like || undefined);
        await db.putStore({ id, kind: "discover", label: view ?? "views", doc });
        return json(200, { ...doc, fetchedAt: new Date(now).toISOString(), fromStore: false });
      }

      default:
        return json(400, { error: "bad", message: "Unknown action. Use status, query or discover." });
    }
  } catch (e) {
    const answer = snowflakeAnswer(e);
    if (answer) return json(answer.status, answer.body);
    throw e;
  }
}

/** Discover beyond the default schema (Corp Dev only, checked by the caller):
      {schemas: true}                      -> the schemas in the database
      {schema, like?} / {schema, view}     -> the views in that schema, or one view's columns there
    Each answer is saved under an id that hashes the schema with the view or filter, so the same view name in two
    schemas never shares a saved entry, and none of these share one with the default schema's entries. */
async function discoverElsewhere(body: Record<string, unknown>, c: { db: Db; sf: Snowflake | null; json: Json; now: number; database: string }): Promise<Response> {
  const { db, sf, json } = c;
  let id: string, label: string, run: (sf: Snowflake) => Promise<Record<string, unknown>>;
  if (body.schemas === true) { id = "discover:schemas"; label = "schemas"; run = (s) => discoverSchemas(s, c.database); }
  else {
    const schema = typeof body.schema === "string" ? body.schema.trim() : "";
    if (!isViewName(schema)) return json(400, { error: "bad", message: "schema must be a schema name." });
    const view = body.view === undefined || body.view === null ? null : String(body.view).trim();
    if (view !== null && !isViewName(view)) return json(400, { error: "bad", message: "view must be a view name." });
    const like = typeof body.like === "string" ? body.like.trim().replace(/[^A-Za-z0-9_$]/g, "").slice(0, 60) : "";
    id = `discover:in.${await shortHash(JSON.stringify([storedName(schema), view ? "cols" : "views", view ? storedName(view) : like]))}`;
    label = `${storedName(schema)}.${view ? storedName(view) : "views"}`;
    run = async (s) => ({ schema: storedName(schema), ...(view ? await discoverColumns(s, c.database, schema, view) : await discoverViews(s, c.database, schema, like || undefined)) });
  }
  const saved = body.refresh === true ? null : await db.getStore(id);
  if (saved) return json(200, { ...saved.doc, fetchedAt: saved.fetched_at, fromStore: true });
  if (!sf) return json(503, { error: "not_configured", message: SNOWFLAKE_NOT_CONFIGURED });
  const doc = await run(sf);
  await db.putStore({ id, kind: "discover", label, doc });
  return json(200, { ...doc, fetchedAt: new Date(c.now).toISOString(), fromStore: false });
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
