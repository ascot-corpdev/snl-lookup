// The rules every SNL lookup function shares (supabase/functions/_shared/http.ts), checked on all three:
// CORS on every answer, POST only, sign-in, unknown actions, a readable last-resort error, and ALLOWED_ORIGIN.
(globalThis as any).__SNL_TEST__ = true;
const fns: Record<string, { handle: (req: Request, deps: any) => Promise<Response> }> = {
  "snl-filings": await import(new URL("../../supabase/functions/snl-filings/index.ts", import.meta.url).href),
  "snl-statutory": await import(new URL("../../supabase/functions/snl-statutory/index.ts", import.meta.url).href),
  "snl-chat": await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href),
};
import { adminClient, allowOrigin, corsHeaders, readBody, serviceKey, shortHash, whoIs } from "../../supabase/functions/_shared/http.ts";
import { checks, corpdev, env, fakeClock, memoryDb, nobody, reader, req } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const silently = async <T>(work: () => Promise<T>): Promise<T> => { const keep = console.error; console.error = () => {}; try { return await work(); } finally { console.error = keep; } };
const noFetch = (() => { throw new Error("no network call was expected"); }) as unknown as typeof fetch;
const SECRETS = { ANTHROPIC_API_KEY: "test-anthropic-key" };
const CORS = ["Access-Control-Allow-Origin", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods", "Vary"];
const hasCors = (res: Response) => CORS.every((h) => res.headers.get(h));
const WHAT: Record<string, string> = { "snl-filings": "The filings function", "snl-statutory": "The statutory function", "snl-chat": "The chat function" };
const ACTIONS: Record<string, string> = { "snl-filings": "status, reference, resolve, search or document", "snl-statutory": "status, query or discover", "snl-chat": "ask or continue" };

for (const [name, fn] of Object.entries(fns)) {
  const clock = fakeClock(), db = memoryDb(clock);
  const deps = (over: Record<string, unknown> = {}) => ({ env: env(SECRETS), fetch: noFetch, anthropicFetch: noFetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep, background: () => {}, ...over });
  const call = async (r: Request, over: Record<string, unknown> = {}) => { const res = await fn.handle(r, deps(over)); const text = await res.text(); let body: any = null; try { body = JSON.parse(text); } catch { /* not JSON */ } return { res, status: res.status, body, text }; };

  // OPTIONS
  const pre = await call(req(name, null, "OPTIONS", { Origin: "https://desk.example", "Access-Control-Request-Method": "POST" }), { whoIs: nobody });
  ok(`${name}: OPTIONS answers 200 with the CORS headers, with no sign-in needed`, pre.status === 200 && hasCors(pre.res) && pre.res.headers.get("Access-Control-Allow-Methods") === "POST, OPTIONS", Object.fromEntries(pre.res.headers));
  ok(`${name}: the pre-flight allows the headers the page sends`, ["authorization", "apikey", "content-type", "x-client-info"].every((h) => pre.res.headers.get("Access-Control-Allow-Headers")!.toLowerCase().includes(h)));
  ok(`${name}: the answer varies by Origin, so a cache can't hand one site's answer to another`, pre.res.headers.get("Vary") === "Origin");

  // not POST
  for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
    const r = await call(new Request(`https://x.supabase.co/functions/v1/${name}`, { method, headers: { Authorization: "Bearer u", apikey: "k" } }));
    ok(`${name}: ${method} answers 405 with CORS headers${method === "HEAD" ? "" : " and a JSON reason"}`, r.status === 405 && hasCors(r.res) && (method === "HEAD" || (r.body?.error === "method" && r.body?.message === "Use POST.")), { status: r.status, body: r.body });
  }

  // not signed in
  for (const body of [{ action: "status" }, { action: "ask", question: "Q" }, { action: "nonsense" }, "not json"]) {
    const r = await call(req(name, body), { whoIs: nobody });
    ok(`${name}: not signed in answers 401 signin for ${JSON.stringify(body)}, with CORS headers`, r.status === 401 && r.body?.error === "signin" && r.body?.message === "Sign in again." && hasCors(r.res) && r.res.headers.get("Content-Type") === "application/json", { status: r.status, body: r.body });
  }
  ok(`${name}: nothing is read or written for a caller who isn't signed in`, db.jobs.size === 0 && db.store.size === 0 && db.slots.length === 0);

  // bad bodies
  for (const [what, raw] of [["no body", ""], ["text that isn't JSON", "action=status"], ["a JSON list", "[1,2]"], ["a JSON string", '"status"'], ["JSON null", "null"], ["a JSON number", "7"]] as const) {
    const r = await call(new Request(`https://x.supabase.co/functions/v1/${name}`, { method: "POST", headers: { Authorization: "Bearer u", apikey: "k" }, body: raw }));
    ok(`${name}: ${what} answers 400 with a plain reason`, r.status === 400 && r.body?.error === "bad" && r.body?.message === "Send a JSON body with an action." && hasCors(r.res), { status: r.status, body: r.body });
  }

  // unknown action
  for (const action of ["nonsense", "", undefined, null, 5, "STATUS", "__proto__", "constructor", ["status"]]) {
    const r = await call(req(name, { action }));
    ok(`${name}: the action ${JSON.stringify(action)} answers 400 and names the actions that exist`, r.status === 400 && r.body?.error === "bad" && r.body?.message === `Unknown action. Use ${ACTIONS[name]}.` && hasCors(r.res), { status: r.status, body: r.body });
  }
  ok(`${name}: a reader is let in like any signed-in login`, (await call(req(name, { action: "nonsense" }), { whoIs: reader })).status === 400);

  // an unexpected exception
  const boom = new Proxy(db, { get: (t, k) => (typeof (t as any)[k] === "function" ? () => { throw new Error("connection to the database was lost"); } : (t as any)[k]) });
  const body = name === "snl-chat" ? { action: "ask", question: "Q" } : { action: "status" };
  const e = await silently(() => call(req(name, body, "POST", { Origin: "https://desk.example" }), { db: boom, env: env({ ...SECRETS, ALLOWED_ORIGIN: "https://desk.example" }) }));
  ok(`${name}: an unexpected failure answers 500 with CORS headers and a message that says what failed`, e.status === 500 && e.body?.error === "server" && e.body?.message === `${WHAT[name]} failed: connection to the database was lost. Try again. If it keeps happening, tell Corp Dev.` && hasCors(e.res) && e.res.headers.get("Access-Control-Allow-Origin") === "https://desk.example", { status: e.status, body: e.body, origin: e.res.headers.get("Access-Control-Allow-Origin") });
  const who = await silently(() => call(req(name, body), { whoIs: async () => { throw new Error("auth service timed out"); } }));
  ok(`${name}: a failure while checking the login is a 500 with CORS headers too, not a bare network error`, who.status === 500 && hasCors(who.res) && who.body?.message === `${WHAT[name]} failed: auth service timed out. Try again. If it keeps happening, tell Corp Dev.`, who.body);
  const odd = await silently(() => call(req(name, body), { whoIs: async () => { throw "a string, not an Error"; } }));
  ok(`${name}: even a failure with no message gives a readable 500`, odd.status === 500 && odd.body?.message === `${WHAT[name]} failed: unknown error. Try again. If it keeps happening, tell Corp Dev.`, odd.body);

  // outside Supabase: no database
  const bare = await call(req(name, body), { db: undefined });
  ok(`${name}: with no database to reach, the function says it must run inside Supabase`, bare.status === 500 && bare.body?.error === "server" && bare.body?.message === "The function can't reach its database. It must run inside Supabase." && hasCors(bare.res), bare.body);

  // ALLOWED_ORIGIN on a normal answer and on an error
  for (const [setting, origin, want] of [[undefined, "https://anything.example", "*"], ["*", "https://anything.example", "*"], ["https://desk.example", "https://desk.example", "https://desk.example"], ["https://desk.example", "https://evil.example", "https://desk.example"],
    ["https://desk.example/snl-lookup/", "https://desk.example", "https://desk.example"], ["https://desk.example, https://second.example/app", "https://second.example", "https://second.example"], ["https://desk.example, https://second.example/app", "https://evil.example", "https://desk.example"]] as const) {
    const r = await call(req(name, { action: "nonsense" }, "POST", { Origin: origin }), { env: env({ ...SECRETS, ...(setting === undefined ? {} : { ALLOWED_ORIGIN: setting }) }) });
    ok(`${name}: ALLOWED_ORIGIN=${JSON.stringify(setting)} answers a call from ${origin} with ${want}`, r.res.headers.get("Access-Control-Allow-Origin") === want, r.res.headers.get("Access-Control-Allow-Origin"));
  }
}

// ---------- allowOrigin ----------
{
  const cases: [string | undefined, string | null, string][] = [
    [undefined, "https://a.example", "*"], ["", "https://a.example", "*"], ["   ", "https://a.example", "*"], ["*", "https://a.example", "*"], [" * ", null, "*"],
    ["https://a.example", "https://a.example", "https://a.example"], ["https://a.example", "https://b.example", "https://a.example"], ["https://a.example", null, "https://a.example"],
    ["https://a.example/", "https://a.example", "https://a.example"], ["https://a.example/app/index.html?x=1#y", "https://a.example", "https://a.example"], ["https://A.Example", "https://a.example", "https://a.example"],
    ["https://a.example:8443/app", "https://a.example:8443", "https://a.example:8443"], ["https://a.example:8443", "https://a.example", "https://a.example:8443"], ["https://a.example:443", "https://a.example", "https://a.example"],
    ["http://localhost:8080", "http://localhost:8080", "http://localhost:8080"], ["https://a.example", "http://a.example", "https://a.example"],
    ["https://a.example,https://b.example", "https://b.example", "https://b.example"], [" https://a.example , https://b.example/x/ ", "https://b.example", "https://b.example"], ["https://a.example,https://b.example", "https://c.example", "https://a.example"],
    ["https://a.example,,https://b.example,", "https://b.example", "https://b.example"], ["https://a.example", "https://a.example.evil.test", "https://a.example"], ["https://a.example", "https://evil.test/https://a.example", "https://a.example"],
    ["https://a.example", "null", "https://a.example"], ["https://a.example, *", "https://c.example", "https://a.example"],
  ];
  for (const [setting, origin, want] of cases) ok(`allowOrigin(${JSON.stringify(setting)}, ${JSON.stringify(origin)}) is ${want}`, allowOrigin(setting, origin) === want, allowOrigin(setting, origin));
  ok("a setting that isn't an address is compared as written, minus trailing slashes", allowOrigin("desk.example//", "https://desk.example") === "desk.example");
  ok("a setting that is only commas still gives a header value, never the word undefined", [",", " , ,", ",,,"].every((junk) => typeof allowOrigin(junk, "https://a.example") === "string" && allowOrigin(junk, "https://a.example").length > 0), [",", " , ,", ",,,"].map((junk) => String(allowOrigin(junk, "https://a.example"))));
  const h = corsHeaders(env({ ALLOWED_ORIGIN: "https://a.example" }), new Request("https://x.supabase.co/functions/v1/snl-filings", { headers: { Origin: "https://a.example" } }));
  ok("the page may read a downloaded document's file name and length", /content-disposition/.test(h["Access-Control-Expose-Headers"]) && /content-length/.test(h["Access-Control-Expose-Headers"]), h);
  ok("credentials are never allowed across origins", !("Access-Control-Allow-Credentials" in h));
}

// ---------- the small helpers ----------
{
  ok("the service key is SUPABASE_SERVICE_ROLE_KEY when it is set", serviceKey(env({ SUPABASE_SERVICE_ROLE_KEY: "legacy-test-key", SUPABASE_SECRET_KEYS: '{"default":"new-test-key"}' })) === "legacy-test-key");
  ok("otherwise it is the default key in SUPABASE_SECRET_KEYS, or the first one", serviceKey(env({ SUPABASE_SECRET_KEYS: '{"other":"second-test-key","default":"new-test-key"}' })) === "new-test-key" && serviceKey(env({ SUPABASE_SECRET_KEYS: '{"other":"second-test-key"}' })) === "second-test-key");
  for (const v of [undefined, "", "{}", "not json", '{"default":""}', '{"default":5}', "[]", "null"]) ok(`SUPABASE_SECRET_KEYS=${JSON.stringify(v)} gives no key rather than failing`, serviceKey(env(v === undefined ? {} : { SUPABASE_SECRET_KEYS: v })) === undefined);
  ok("with no project address or key there is no database client", adminClient(env({})) === null && adminClient(env({ SUPABASE_URL: "https://x.supabase.co" })) === null && adminClient(env({ SUPABASE_SERVICE_ROLE_KEY: "legacy-test-key" })) === null);

  const body = (raw: string | undefined) => readBody(new Request("https://x.supabase.co/f", { method: "POST", body: raw }));
  ok("a JSON object body is read", same(await body('{"action":"status","n":1}'), { action: "status", n: 1 }));
  ok("anything else reads as no body", (await body("[]")) === null && (await body("")) === null && (await body("{")) === null && (await body("null")) === null && (await body('"x"')) === null && (await body(undefined)) === null);

  const a = await shortHash("the same text"), b = await shortHash("the same text"), c = await shortHash("the same text.");
  ok("a short hash is 32 hex characters, the same for the same text and different for different text", /^[0-9a-f]{32}$/.test(a) && a === b && a !== c, [a, c]);
  ok("it is the start of the text's SHA-256", a === Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("the same text")))).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32));

  const check = whoIs(env({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon-test-key" }));
  ok("a request with no Authorization header is not signed in, and Supabase isn't asked", (await check(new Request("https://x.supabase.co/f", { method: "POST", headers: { apikey: "k" } }))) === null);
  ok("a request with no key at all is not signed in", (await whoIs(env({ SUPABASE_URL: "https://x.supabase.co" }))(new Request("https://x.supabase.co/f", { method: "POST", headers: { Authorization: "Bearer u" } }))) === null);
}

done();
