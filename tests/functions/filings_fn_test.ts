// The snl-filings function end to end, through handle(): status, reference lists, company look-up, search,
// document download, what each S&P failure looks like to the page, and how it behaves before S&P is set up.
(globalThis as any).__SNL_TEST__ = true;
const filings = await import(new URL("../../supabase/functions/snl-filings/index.ts", import.meta.url).href);
const { forgetTokens, NOT_CONFIGURED, SpgmiError } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
import { checks, corpdev, env, fakeClock, fakeSpgmi, J, memoryDb, PDF, reader, req } from "./helpers/fakes.ts";
import { filing, spError, spPage, spStub, watchStore } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" };
const IDS = [9100001, 9100002, 9100003, 9200001];
const SEARCH = { action: "search", companyIds: IDS, states: ["FL"], from: "2024-01-01", to: "2026-11-13" };

function world(secrets: Record<string, string> = SECRETS, documents: Parameters<typeof fakeSpgmi>[1] = {}) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock, documents);
  const deps = { env: env(secrets), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown, over: Record<string, unknown> = {}) => { const res: Response = await filings.handle(req("snl-filings", body), { ...deps, ...over }); return { res, status: res.status, body: await res.json() }; };
  return { clock, db, sp, deps, call };
}

// ---------- status ----------
{
  const w = world({});
  const s = await w.call({ action: "status" });
  ok("status works before anything is set up", s.status === 200 && s.body.filings.configured === false && s.body.statutory.configured === false && s.body.claude.configured === false, s.body);
  ok("status says plainly that S&P isn't set up", s.body.filings.message === NOT_CONFIGURED);
  ok("status shows requests used, the limits and the account type", same(s.body.filings.used, { hour: 0, day: 0 }) && same(s.body.filings.limits, { hour: 500, day: 12000 }) && s.body.filings.account === "trial", s.body.filings);
  ok("status shows nothing has been fetched yet", same(s.body.refreshed, { reference: null, search: null, statutory: null }), s.body.refreshed);
  ok("status gives the caller's role", s.body.role === "corpdev" && (await w.call({ action: "status" }, { whoIs: reader })).body.role === "reader");
  ok("status never calls S&P", w.sp.log.length === 0);
  ok("status doesn't leak the secrets it checks", !JSON.stringify(s.body).includes("api-pass"));

  const one = world({ SPGMI_API_USERNAME: "api-user" });
  ok("a username without a password is not set up", (await one.call({ action: "status" })).body.filings.configured === false);
  const all = world({ ...SECRETS, SPGMI_ACCOUNT: "production", ANTHROPIC_API_KEY: "test-key", SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat" });
  const s2 = await all.call({ action: "status" });
  ok("status reports each service that is set up", s2.body.filings.configured === true && s2.body.filings.message === null && s2.body.statutory.configured === true && s2.body.claude.configured === true, s2.body);
  ok("a production account shows the production limits", same(s2.body.filings.limits, { hour: 2000, day: 48000 }) && s2.body.filings.account === "production", s2.body.filings);
  ok("status doesn't sign in to S&P even when set up", all.sp.log.length === 0);
  await all.call(SEARCH);
  all.clock.now += 60_000;
  const s3 = await all.call({ action: "status" });
  ok("after a search, status shows the requests used and when data was last fetched", s3.body.filings.used.hour === all.sp.log.length && s3.body.filings.used.day === all.sp.log.length && typeof s3.body.refreshed.search === "string" && typeof s3.body.refreshed.reference === "string" && s3.body.refreshed.statutory === null, s3.body);
}

// ---------- reference ----------
{
  const w = world();
  const saved = watchStore(w.db);
  const r = await w.call({ action: "reference" });
  ok("reference returns S&P's four id lists", r.status === 200 && same(Object.keys(r.body.lists), ["typeOfInsurance", "filingStatus", "serffFilingState", "serffFilingType"]) && same(r.body.missing, []) && r.body.message === null, r.body);
  ok("each list was one GET to S&P's reference endpoint with docType", same(w.sp.calls("/api/v1/reference").map((c) => [c.method, c.query.referenceField, c.query.docType]), ["typeOfInsurance", "filingStatus", "serffFilingState", "serffFilingType"].map((f) => ["GET", f, "INSPRODFILINGS_DOCUMENTS_API"])), w.sp.calls("/api/v1/reference"));
  ok("the lists carry ids and names", same(r.body.lists.serffFilingType.options, [{ id: 0, name: "Form" }, { id: 1, name: "Rate" }, { id: 2, name: "Rule" }, { id: 3, name: "Rate/Rule" }]) && same(r.body.lists.serffFilingState.options[0], { id: "FL", name: "Florida" }));
  ok("the answer counts the S&P requests it used (one sign-in and four lists)", r.body.used.hour === 5 && r.body.limits.hour === 500 && r.body.account === "trial", r.body.used);
  ok("the lists are saved, in rows the database will accept", saved.length === 4 && saved.every((x) => x.problem === null && x.kind === "reference"), saved);
  const again = await w.call({ action: "reference" });
  ok("the lists open from the saved copy without asking S&P", again.body.lists.filingStatus.fromStore === true && w.sp.log.length === 5 && again.body.used.hour === 5, w.sp.log.length);
  const one = await w.call({ action: "reference", field: "filingStatus", refresh: true });
  ok("one list can be refreshed on request", same(Object.keys(one.body.lists), ["filingStatus"]) && one.body.lists.filingStatus.fromStore === false && w.sp.calls("/api/v1/reference").length === 5, Object.keys(one.body.lists));
  await w.call({ action: "reference", field: "filingStatus", refresh: "yes" });
  ok("refresh must be true, not just truthy", w.sp.calls("/api/v1/reference").length === 5);
  for (const field of ["companies", "", null, 7, "__proto__", ["filingStatus"]]) {
    const bad = await w.call({ action: "reference", field });
    ok(`reference with field ${JSON.stringify(field)} is refused, naming the four lists`, bad.status === 400 && bad.body.error === "bad" && bad.body.message.includes("typeOfInsurance, filingStatus, serffFilingState, serffFilingType"), bad.body);
  }
  w.clock.now += 31 * 86_400_000;
  const stale = await w.call({ action: "reference", field: "serffFilingType" });
  ok("a list older than 30 days is fetched again", stale.body.lists.serffFilingType.fromStore === false && w.sp.calls("/api/v1/reference").length === 6);

  // not set up
  const off = world({});
  const none = await off.call({ action: "reference" });
  ok("before S&P is set up, reference answers with the not-set-up message and names what is missing", none.status === 200 && none.body.message === NOT_CONFIGURED && same(none.body.missing, ["typeOfInsurance", "filingStatus", "serffFilingState", "serffFilingType"]) && Object.values(none.body.lists).every((v) => v === null), none.body);
  for (const [id, row] of w.db.store) off.db.store.set(id, row);
  const kept = await off.call({ action: "reference", refresh: true });
  ok("before S&P is set up, saved reference lists still open", kept.status === 200 && kept.body.message === null && same(kept.body.missing, []) && kept.body.lists.typeOfInsurance.fromStore === true && kept.body.lists.typeOfInsurance.options.length === 2 && off.sp.log.length === 0, kept.body);
  off.db.store.delete("ref:filingStatus");
  const part = await off.call({ action: "reference" });
  ok("a list that was never saved is named as missing beside the ones that open", same(part.body.missing, ["filingStatus"]) && part.body.lists.filingStatus === null && part.body.lists.serffFilingType !== null && part.body.message === NOT_CONFIGURED, part.body.missing);

  const refused = world();
  refused.sp.failNext.push({ status: 403 });
  const e = await refused.call({ action: "reference" });
  ok("an account with no entitlement gets the plain entitlement message and S&P's reference", e.status === 502 && e.body.error === "spgmi_entitlement" && e.body.message.includes("isn't entitled to SNL Insurance Product Filings") && e.body.requestId === "req-forced" && e.body.message.includes("req-forced"), e.body);
}

// ---------- resolve ----------
{
  const w = world();
  await w.call(SEARCH);
  const calls = w.sp.log.length;
  const byName = await w.call({ action: "resolve", q: "Calloway" });
  ok("resolve finds companies seen in earlier results by part of a name", byName.status === 200 && byName.body.matches.length === 3 && byName.body.note === null, byName.body);
  ok("each match carries the ids a search needs", same(Object.keys(byName.body.matches[0]).sort(), ["companyId", "companyName", "institutionId", "naicCompanyCode", "naicGroupCode", "naicGroupName", "spStatEntityId"]));
  ok("resolve finds a company by NAIC code", (await w.call({ action: "resolve", q: "91003" })).body.matches[0]?.companyName === "Calloway Coastal Co");
  ok("resolve finds a company by S&P company id", (await w.call({ action: "resolve", q: "9200001" })).body.matches[0]?.companyName === "Tarrow Mutual Insurance Co");
  ok("resolve finds a company by S&P institution id", (await w.call({ action: "resolve", q: " 820001 " })).body.matches[0]?.companyName === "Tarrow Mutual Insurance Co");
  const miss = await w.call({ action: "resolve", q: "Nonesuch Mutual" });
  ok("no match explains that only companies seen before are known and what to do", miss.status === 200 && miss.body.matches.length === 0 && miss.body.note.includes('No saved company matches "Nonesuch Mutual"') && miss.body.note.includes("S&P's filings API has no company search") && miss.body.note.includes("company id or institution id"), miss.body.note);
  ok("resolve never calls S&P", w.sp.log.length === calls, w.sp.log.length - calls);
  for (const q of [undefined, "", "   ", 91001, ["Calloway"], null]) {
    const bad = await w.call({ action: "resolve", q });
    ok(`resolve with q = ${JSON.stringify(q)} asks for something to look up`, bad.status === 400 && bad.body.message === "Type a company name, a NAIC code or an S&P id.", bad.body);
  }
  const hostile = await w.call({ action: "resolve", q: "x%' or 1=1 --,doc->>companyId.eq.9100001)" });
  ok("an odd query is just a query that matches nothing", hostile.status === 200 && hostile.body.matches.length === 0);

  const off = world({});
  for (const [id, row] of w.db.store) off.db.store.set(id, row);
  const r = await off.call({ action: "resolve", q: "tarrow" });
  ok("resolve still works before S&P is set up", r.status === 200 && r.body.matches[0]?.companyId === "9200001" && off.sp.log.length === 0, r.body);
  ok("as a reader too", (await off.call({ action: "resolve", q: "tarrow" }, { whoIs: reader })).status === 200);
}

// ---------- search ----------
{
  const w = world();
  const saved = watchStore(w.db);
  const a = await w.call({ ...SEARCH, states: ["FL", "TX", "NY"], filingTypeIds: [1] });
  ok("a search answers with rows, counts, notes and usage", a.status === 200 && a.body.total === 3 && a.body.rows.length === 3 && a.body.requests === 3 && a.body.capped === false && a.body.saved === true && a.body.fromStore === false && typeof a.body.fetchedAt === "string" && a.body.used.hour === w.sp.log.length, { total: a.body.total, requests: a.body.requests });
  ok("the rate filings carry S&P's rate impact columns", a.body.rows.some((r: any) => r.overallRateImpact === 6.5 && r.dispOverallRateImpact === "6.500%") && a.body.rows.some((r: any) => r.overallRateImpact === -2));
  ok("a filing with no document still comes back, with a null document id", a.body.rows.some((r: any) => r.trackingNumber === "TARR-135000002" && r.documentId === null && r.pages === null));
  ok("with no status chosen the search covers all statuses and says so", a.body.params.allStatuses === true && a.body.rows.some((r: any) => r.filingStatus === "Pending"));
  ok("a state outside S&P's list gets its own note; nothing is said about states with rows", a.body.notes.some((n: string) => n.startsWith("NY isn't in S&P's list")) && !a.body.notes.some((n: string) => /for FL|for TX/.test(n)), a.body.notes);
  ok("companies with no rate filings are named without a claim that none exist", a.body.notes.filter((n: string) => n.startsWith("S&P returned nothing for company id")).length === 2 && a.body.notes.every((n: string) => !/no filings exist\.$/.test(n) || n.includes("doesn't prove")), a.body.notes);
  ok("what was saved passes the database's checks", saved.filter((x) => x.kind === "search").length === 1 && saved.every((x) => x.problem === null), saved);
  ok("every S&P call in the search was at least a second after the one before", w.sp.log.every((c, i) => i === 0 || c.at - w.sp.log[i - 1].at >= 1000));

  const n = w.sp.log.length;
  const b = await w.call({ ...SEARCH, states: ["NY", "TX", "FL"], filingTypeIds: ["1"], companyIds: [...IDS].reverse() });
  ok("the same search opens from the store, with no S&P request and no change in usage", b.body.fromStore === true && b.body.total === 3 && w.sp.log.length === n && b.body.used.hour === n);
  const c = await w.call({ ...SEARCH, states: ["FL", "TX", "NY"], filingTypeIds: [1], refresh: true });
  ok("refresh asks S&P again", c.body.fromStore === false && w.sp.calls("/api/v1/search").length === 6, w.sp.calls("/api/v1/search").length);
  ok("search bodies sent to S&P are {properties: {...}} with at most 10 ids and 365 days", w.sp.calls("/api/v1/search").every((s) => !Array.isArray(s.body.properties) && (s.body.properties.companyId ?? []).length <= 10 && (Date.parse(s.body.properties.maxPublishDate) - Date.parse(s.body.properties.minPublishDate)) / 86_400_000 <= 365 && s.body.properties.pageSize === 500 && s.body.properties.pageNumber === 1));

  for (const [name, body, says] of [
    ["no company", { companyIds: [] }, /Choose at least one company/], ["no state", { states: [] }, /at least one state/], ["a start after the end", { from: "2026-12-01" }, /start date is after/],
    ["a bad date", { to: "13 Nov 2026" }, /Dates must look like/], ["more than ten years", { from: "2010-01-01" }, /at most 10 years/], ["an id that isn't a number", { companyIds: ["Calloway"] }, /whole numbers/],
  ] as const) {
    const calls = w.sp.log.length;
    const bad = await w.call({ ...SEARCH, ...body });
    ok(`a search with ${name} is refused with a plain reason and S&P isn't asked`, bad.status === 400 && bad.body.error === "bad" && says.test(bad.body.message) && w.sp.log.length === calls, bad.body);
  }
  const noFrom = await w.call({ action: "search", companyIds: IDS, states: ["FL"], to: "sometime" });
  ok("a bad end date with no start date is refused like any bad date, not a server error", noFrom.status === 400 && /Dates must look like/.test(noFrom.body.message ?? ""), { status: noFrom.status, body: noFrom.body });

  // a search that can't finish inside its request limit is refused before any request is spent
  const cap = world();
  const wide = { action: "search", companyIds: Array.from({ length: 41 }, (_, i) => 9100001 + i), institutionIds: [820001, 820002, 820003], states: ["FL"], from: "2016-11-14", to: "2026-11-13", filingStatusIds: [1] };
  const refused = await cap.call(wide);
  ok("a search that needs more S&P requests than one search may use is refused in plain words before any is spent", refused.status === 400 && /needs at least 66 S&P requests/.test(refused.body.message) && /more than the 60 one search may use/.test(refused.body.message) && /fewer companies or a shorter date range/.test(refused.body.message) && cap.sp.calls("/api/v1/search").length === 0, refused.body);

  // the request cap, reached by paging
  const STATES = { headers: ["serffFilingStateId", "serffFilingState"], rows: [{ row: ["FL", "Florida"] }] };
  const endless = spStub(cap.clock, (call, n) => (call.path === "/api/v1/reference" ? J(STATES) : J(spPage([filing(n)], { totalPages: 999 }))));
  const narrow = { action: "search", companyIds: [9100001], states: ["FL"], from: "2026-01-01", to: "2026-11-13", filingStatusIds: [1] };
  const capped = await cap.call(narrow, { fetch: endless.fetch });
  ok("a search with more pages than one call may fetch stops at 60 S&P requests and says so", capped.status === 200 && capped.body.capped === true && capped.body.requests === 60 && endless.calls("/api/v1/search").length === 60 && capped.body.notes[0].startsWith("The search stopped after 60 S&P requests"), { requests: capped.body.requests, notes: capped.body.notes });
  ok("a capped result is not saved", capped.body.saved === false && ![...cap.db.store.values()].some((r) => r.kind === "search"));
  ok("a capped result makes no claim about what is empty", !capped.body.notes.some((x: string) => /returned no filings|returned nothing/.test(x)), capped.body.notes);
  const before = endless.calls("/api/v1/search").length;
  const retry = await cap.call(narrow, { fetch: endless.fetch });
  ok("the same search again asks S&P again rather than opening a part result", retry.body.fromStore === false && endless.calls("/api/v1/search").length === before + 60);
  ok("companies found before the cap are still remembered", (await cap.call({ action: "resolve", q: "91001" })).body.matches.length === 1);

  // S&P answering slowly: the search stops while there is still time to answer
  const slowWorld = world();
  const slow = spStub(slowWorld.clock, (call, n) => { slowWorld.clock.now += 6000; return call.path === "/api/v1/reference" ? J(STATES) : J(spPage([filing(n)], { totalPages: 999 })); });
  const cut = await slowWorld.call(narrow, { fetch: slow.fetch });
  ok("when S&P is slow the search stops inside the time limit, says so, and isn't saved", cut.status === 200 && cut.body.capped === true && cut.body.saved === false && cut.body.requests < 25 && cut.body.notes[0].startsWith("S&P was answering slowly, so the search stopped after") && slowWorld.clock.now - Date.parse("2026-11-13T12:00:00Z") < 140_000, { requests: cut.body.requests, notes: cut.body.notes, ms: slowWorld.clock.now - Date.parse("2026-11-13T12:00:00Z") });
}

// ---------- before S&P is set up ----------
{
  const on = world();
  await on.call(SEARCH);
  const off = world({});
  for (const [id, row] of on.db.store) off.db.store.set(id, row);
  const opened = await off.call(SEARCH);
  ok("before S&P is set up, a saved search still opens", opened.status === 200 && opened.body.fromStore === true && opened.body.total === 6 && off.sp.log.length === 0, opened.body.total);
  const fresh = await off.call({ ...SEARCH, states: ["TX"] });
  ok("before S&P is set up, a new search answers 503 not_configured with the plain message", fresh.status === 503 && fresh.body.error === "not_configured" && fresh.body.message === NOT_CONFIGURED && off.sp.log.length === 0, fresh.body);
  const forced = await off.call({ ...SEARCH, refresh: true });
  ok("before S&P is set up, refresh answers 503 not_configured", forced.status === 503 && forced.body.error === "not_configured");
  const doc = await off.call({ action: "document", documentId: 70000001 });
  ok("before S&P is set up, a document answers 503 not_configured", doc.status === 503 && doc.body.error === "not_configured" && doc.body.message === NOT_CONFIGURED);
  ok("the 503 carries CORS headers so the page can read it", fresh.res.headers.get("Access-Control-Allow-Origin") === "*");
  const half = world({ SPGMI_API_PASSWORD: "api-pass" });
  ok("a password without a username is still not set up", (await half.call({ ...SEARCH, states: ["TX"] })).status === 503 && half.sp.log.length === 0);
}

// ---------- what each S&P failure looks like to the page ----------
{
  const cases: [number, number, string, RegExp][] = [
    [400, 400, "spgmi_bad_request", /S&P rejected the request \(400\)/], [403, 502, "spgmi_entitlement", /entitlement needed/], [404, 404, "spgmi_not_found", /couldn't find that \(404\)/],
    [405, 502, "spgmi_method", /fault in the app/], [500, 502, "spgmi_server", /S&P's service failed \(500\)/], [503, 502, "spgmi_server", /S&P's service failed \(503\)/],
  ];
  for (const [spStatus, status, error, says] of cases) {
    const w = world();
    await w.call({ action: "reference" });
    w.sp.failNext.push({ status: spStatus, body: { status: spStatus, timestamp: "t", requestId: `req-${spStatus}`, error: "E", message: "Detail from S&P" } });
    const r = await w.call(SEARCH);
    ok(`an S&P ${spStatus} reaches the page as ${status} ${error} with a plain message and S&P's reference`, r.status === status && r.body.error === error && says.test(r.body.message) && r.body.requestId === `req-${spStatus}` && r.body.message.includes(`S&P reference: req-${spStatus}.`), r.body);
    ok(`after an S&P ${spStatus} nothing is saved as a result`, ![...w.db.store.values()].some((x) => x.kind === "search"));
  }
  let w = world();
  await w.call({ action: "reference" });
  w.sp.failNext.push({ status: 429, headers: { "retry-after": "4" } });
  let r = await w.call(SEARCH);
  ok("one 429 from S&P is absorbed: the app waits and the search succeeds", r.status === 200 && r.body.total === 6 && w.clock.slept.includes(4000), { status: r.status, slept: w.clock.slept });
  w = world();
  await w.call({ action: "reference" });
  w.sp.failNext.push({ status: 429 }, { status: 429 });
  r = await w.call(SEARCH);
  ok("two 429s in a row reach the page as 429 with a plain message", r.status === 429 && r.body.error === "spgmi_rate_limited" && /too many requests were sent \(429\)/.test(r.body.message) && r.body.requestId === "req-forced", r.body);

  w = world({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "wrong" });
  r = await w.call(SEARCH);
  ok("a wrong password reaches the page as a sign-in problem that names the secrets, not the password", r.status === 502 && r.body.error === "spgmi_signin" && r.body.message.includes("SPGMI_API_USERNAME") && !r.body.message.includes("wrong"), r.body);
  ok("after a refused sign-in only the sign-in was tried", w.sp.log.length === 1);

  w = world();
  r = await w.call(SEARCH, { fetch: (() => Promise.reject(new TypeError("tcp reset"))) as unknown as typeof fetch });
  ok("S&P unreachable reaches the page as a plain network message", r.status === 502 && r.body.error === "spgmi_network" && r.body.message.startsWith("Couldn't reach S&P") && r.body.requestId === null, r.body);

  // the hourly limit
  w = world();
  for (let i = 0; i < 500; i++) await w.db.takeSlot({ hour: 500, day: 12_000 });
  r = await w.call(SEARCH);
  ok("with the hour's requests used up, the app answers 429 before calling S&P and says when the limit resets", r.status === 429 && r.body.error === "spgmi_limit" && r.body.message === "The app stopped before asking S&P: this hour's limit of 500 S&P requests is used up. It resets at the top of the hour." && w.sp.log.length === 0, r.body);
  ok("status then shows the hour as used up", (await w.call({ action: "status" })).body.filings.used.hour === 500);
  ok("saved results and look-ups still work at the limit", (await w.call({ action: "resolve", q: "calloway" })).status === 200);
  r = await w.call(SEARCH, { env: env({ ...SECRETS, SPGMI_ACCOUNT: "production" }) });
  ok("the same hour is open on a production account", r.status === 200 && r.body.limits.hour === 2000);
  ok("spgmiAnswer leaves other errors alone", filings.spgmiAnswer(new Error("x")) === null && filings.spgmiAnswer(new SpgmiError("limit", "m")).status === 429);
}

// ---------- documents ----------
{
  const bytes = PDF("Homeowner Program. Policy form CHO 30 01 (06 25).");
  const w = world(SECRETS, { documents: { "70000001": { bytes, name: "CALL-134000001.pdf" }, "0A0A0A0A-0000-4000-8000-000000000006": { bytes: new TextEncoder().encode("PK made-up spreadsheet"), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "TARR-135000002.xlsx" } } });
  const res: Response = await filings.handle(req("snl-filings", { action: "document", documentId: 70000001 }, "POST", { Origin: "https://desk.example" }), { ...w.deps, env: env({ ...SECRETS, ALLOWED_ORIGIN: "https://desk.example" }) });
  const got = new Uint8Array(await res.arrayBuffer());
  ok("a document comes back byte for byte", res.status === 200 && got.length === bytes.length && got.every((b, i) => b === bytes[i]), res.status);
  ok("with S&P's content type, file name and length", res.headers.get("content-type") === "application/pdf" && res.headers.get("content-disposition") === 'attachment; filename="CALL-134000001.pdf"' && res.headers.get("content-length") === String(bytes.length), Object.fromEntries(res.headers));
  ok("and CORS headers that let the page read the file name", res.headers.get("Access-Control-Allow-Origin") === "https://desk.example" && (res.headers.get("Access-Control-Expose-Headers") ?? "").includes("content-disposition") && (res.headers.get("Access-Control-Expose-Headers") ?? "").includes("content-length"));
  ok("a document is never cached by the browser or a proxy", res.headers.get("Cache-Control") === "private, no-store");
  const d = w.sp.calls("/api/v1/download")[0];
  ok("S&P was sent POST /api/v1/download {properties: {documentId}} with docType", d.method === "POST" && same(d.body, { properties: { documentId: 70000001 } }) && d.query.docType === "INSPRODFILINGS_DOCUMENTS_API", d);
  ok("nothing about the document is stored", w.db.store.size === 0 && w.db.jobs.size === 0);
  ok("the download is counted as S&P requests (a sign-in and the document)", (await w.db.usage()).hour === 2);

  const byVersion: Response = await filings.handle(req("snl-filings", { action: "document", filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" }), w.deps);
  ok("a document can be asked for by filing version id, and other file types pass through as they are", byVersion.status === 200 && byVersion.headers.get("content-type")!.includes("spreadsheetml") && byVersion.headers.get("content-disposition")!.includes("TARR-135000002.xlsx") && new TextDecoder().decode(await byVersion.arrayBuffer()) === "PK made-up spreadsheet");
  ok("S&P was sent {properties: {filingVersionId}}", same(w.sp.calls("/api/v1/download")[1].body, { properties: { filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" } }));
  const asText: Response = await filings.handle(req("snl-filings", { action: "document", documentId: "70000001" }), w.deps);
  ok("a document id typed as text works too", asText.status === 200 && (await asText.arrayBuffer()).byteLength === bytes.length);

  const missing = await w.call({ action: "document", documentId: 79999999 });
  ok("a document S&P doesn't have answers 404 with a plain message and S&P's reference", missing.status === 404 && missing.body.error === "spgmi_not_found" && missing.body.message.includes("S&P couldn't find that (404).") && typeof missing.body.requestId === "string" && missing.body.message.includes(missing.body.requestId), missing.body);
  for (const [name, body] of [["no id", {}], ["a zero id", { documentId: 0 }], ["a word for an id", { documentId: "latest" }], ["a version id that is too short", { filingVersionId: "abc" }], ["a version id with a path in it", { filingVersionId: "../../../../etc/passwd" }]] as const) {
    const calls = w.sp.log.length;
    const bad = await w.call({ action: "document", ...body });
    ok(`document with ${name} is refused and S&P isn't asked`, bad.status === 400 && bad.body.message === "Send a documentId (a number) or a filingVersionId." && w.sp.log.length === calls, bad.body);
  }
  w.sp.failNext.push({ status: 403 });
  const noRight = await w.call({ action: "document", documentId: 70000001 });
  ok("a document refused for entitlement answers with the entitlement message", noRight.status === 502 && noRight.body.error === "spgmi_entitlement", noRight.body);
}
{
  // Streamed straight through: the function answers while S&P is still sending.
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const sp = spStub(clock, () => new Response(new ReadableStream<Uint8Array>({ start(c) { feed = c; } }), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="big.pdf"' } }));
  const res: Response = await filings.handle(req("snl-filings", { action: "document", documentId: 70000009 }), { env: env(SECRETS), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep });
  ok("the function answers before S&P has finished sending the document", res.status === 200 && res.headers.get("content-disposition") === 'attachment; filename="big.pdf"');
  ok("when S&P gives no length, none is invented", res.headers.get("content-length") === null);
  const rd = res.body!.getReader();
  feed.enqueue(new TextEncoder().encode("%PDF-part-one "));
  const first = await rd.read();
  feed.enqueue(new TextEncoder().encode("part-two"));
  feed.close();
  const second = await rd.read(), end = await rd.read();
  ok("the bytes arrive as S&P sends them", new TextDecoder().decode(first.value) === "%PDF-part-one " && new TextDecoder().decode(second.value) === "part-two" && end.done === true);

  const plain = spStub(clock, () => new Response("raw bytes", { status: 200, headers: {} }));
  forgetTokens();
  const res2: Response = await filings.handle(req("snl-filings", { action: "document", documentId: 70000009 }), { env: env(SECRETS), fetch: plain.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep });
  ok("a document with no content type from S&P is sent as a plain download", ["application/octet-stream", "text/plain;charset=UTF-8"].includes(res2.headers.get("content-type") ?? "") && res2.headers.get("content-disposition") === null, res2.headers.get("content-type"));
  await res2.arrayBuffer();
}

{
  // S&P (or a gateway in front of it) compresses the document in transit. Deno's fetch hands the function the
  // unpacked bytes but leaves S&P's Content-Length (the packed size) and Content-Encoding on the response; this
  // stand-in answers exactly that way. A wrong length on the way out breaks the download in the browser.
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), unpacked = PDF("made-up ".repeat(500));
  const sp = spStub(clock, () => new Response(unpacked as unknown as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-encoding": "gzip", "content-length": "86", "content-disposition": 'attachment; filename="packed.pdf"' } }));
  const res: Response = await filings.handle(req("snl-filings", { action: "document", documentId: 70000009 }), { env: env(SECRETS), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep });
  const got = new Uint8Array(await res.arrayBuffer());
  ok("a document S&P sent compressed arrives whole", res.status === 200 && got.length === unpacked.length);
  ok("and the length passed on is the size of the bytes actually sent, or none at all, never the compressed size", res.headers.get("content-length") === null || res.headers.get("content-length") === String(unpacked.length), { contentLength: res.headers.get("content-length"), bytes: got.length });
}

// ---------- shuffled and renamed columns all the way through the function ----------
{
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  const order = ["extraColumn", "PAGES", "filingversionid", "DocumentId", "companyName", "COMPANYID", "trackingNumber", "serffFilingStateId", "publishDate", "naicCompanyCode", "institutionId", "filingStatusId", "FilingStatus"];
  const rows = [filing(1, { extraColumn: "kept" }), filing(2, { companyId: 9200001, companyName: "Tarrow Mutual Insurance Co", naicCompanyCode: "92001", institutionId: 820001 })];
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") return J({ headers: ["name", "filingStatusId"], rows: [{ row: ["Closed - Approved", 1] }] });
    const lower = Object.fromEntries(order.map((h) => [h.toLowerCase(), h]));
    return J({ headers: order, rows: rows.map((r) => ({ row: Object.keys(lower).map((k) => Object.entries(r).find(([name]) => name.toLowerCase() === k)?.[1] ?? null) })), totalPages: 1 });
  });
  const res: Response = await filings.handle(req("snl-filings", { action: "search", companyIds: [9100001, 9200001], states: ["FL"], from: "2026-01-01", to: "2026-11-13" }), { env: env(SECRETS), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep });
  const body = await res.json();
  ok("S&P sending fewer columns, in another order and case, still gives rows under S&P's documented names", res.status === 200 && body.total === 2 && body.rows[0].trackingNumber === "TEST-000001" && body.rows[0].documentId === 71000001 && body.rows[0].pages === 10 && body.rows[0].filingVersionId.startsWith("0B0B") && body.rows[0].extraColumn === "kept", body.rows?.[0]);
  ok("counts by company and state work from the named columns", same(body.byCompany.map((c: any) => [c.id, c.name, c.rows]), [[9100001, "Calloway Insurance Co", 1], [9200001, "Tarrow Mutual Insurance Co", 1]]) && same(body.byState, [{ state: "FL", rows: 2 }]), body.byCompany);
  ok("the status list is read by column name too", same(sp.calls("/api/v1/search")[0].body.properties.filingStatusId, [1]));
  ok("companies are remembered from the named columns", (await db.findEntities("92001", 5))[0]?.institutionId === "820001");
}

done();
