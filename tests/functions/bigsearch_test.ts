// Searches too big for one function call (big-searches): no call holds or answers more than STEP_ROWS filings,
// whoever asks. The Filings view's search runs in parts that put together equal the same search in one piece; parts
// are saved and open again without S&P; a result saved whole before parts still opens; Recent searches lists a search
// once; Refresh, a lost answer, a lost place, an empty part, the request total across parts and the too-wide refusal.
// Then each of the functions' own searches at and over the bound: Claude's search_filings, the filings profile, the
// watchlist and the market index. Every company, id and filing here is made up.
(globalThis as any).__SNL_TEST__ = true;
const filingsFn = await import(new URL("../../supabase/functions/snl-filings/index.ts", import.meta.url).href);
const chatFn = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const profileFn = await import(new URL("../../supabase/functions/snl-profile/index.ts", import.meta.url).href);
const watchFn = await import(new URL("../../supabase/functions/snl-watch/index.ts", import.meta.url).href);
import {
  boundNote, emptyStateNote, partNote, savedOrFreshSearch, LOST_PLACE, MAX_SEARCH_REQUESTS, MOVED, RUN_SUFFIX, savedBoundNote, type SearchParams, searchFilings, searchKey, STEP_PAGES, STEP_ROWS,
} from "../../supabase/functions/_shared/filings.ts";
import { forgetTokens, makeGate, PLAN_LIMITS, Spgmi } from "../../supabase/functions/_shared/spgmi.ts";
import { runStep, startSweep } from "../../supabase/functions/_shared/marketindex.ts";
import { checks, corpdev, env, fakeAnthropic, fakeClock, J, memoryDb, read, req, say, toolResults, toolUse } from "./helpers/fakes.ts";
import { filing, spPage, spStub, storeRules } from "./helpers/more.ts";
import { F as indexFiling, world as indexWorld } from "./helpers/marketindex.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" };
const refs = read("spgmi_reference.json");
const KNOWN = refs.serffFilingState.rows.map((r: unknown[]) => String(r[0]));
const rules = storeRules();
const FV = (i: number) => `0F0F0F0F-0000-4000-8000-${String(i).padStart(12, "0")}`;

type Answer = (call: any) => Response;
/** S&P made up: reference lists from the fixture; searches answered by `search`. */
function world(search: Answer) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  let rowsSent = 0;
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") { const l = refs[call.query.referenceField]; return J({ headers: l.headers, rows: l.rows.map((row: unknown[]) => ({ row })) }); }
    const res = search(call);
    return res;
  });
  // counts the rows S&P sends, so each function call's share can be checked
  const counting = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await sp.fetch(input, init);
    if (String(input).includes("/api/v1/search")) { const b = await res.clone().json(); rowsSent += Array.isArray(b.rows) ? b.rows.length : 0; }
    return res;
  }) as typeof fetch;
  const deps = { env: env(SECRETS), fetch: counting, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown) => {
    const before = rowsSent;
    const res: Response = await filingsFn.handle(req("snl-filings", body), deps);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), bytes: text.length, fromSp: rowsSent - before };
  };
  /** The page's way: the first part, then each next part with the cursor, until there is none. */
  const parts = async (body: Record<string, unknown>) => {
    const out = [await call({ ...body })];
    while (out.at(-1)!.status === 200 && out.at(-1)!.body.more) out.push(await call({ ...body, cursor: out.at(-1)!.body.cursor }));
    return out;
  };
  const searches = () => sp.calls("/api/v1/search").length;
  /** The functions' own way (Claude, profiles): savedOrFreshSearch, one call, stopped at the bound. */
  const own = async (b: Record<string, any>) => {
    const before = rowsSent;
    const api = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: counting, gate: makeGate(db, PLAN_LIMITS.trial, clock.sleep), sleep: clock.sleep });
    const p: SearchParams = { companyIds: b.companyIds ?? [], institutionIds: b.institutionIds ?? [], states: b.states, filingStatusIds: b.filingStatusIds ?? [], typeOfInsuranceIds: [], filingTypeIds: [], spStatEntityIds: [], trackingNumbers: [], from: b.from, to: b.to };
    const body = await savedOrFreshSearch(api, db, p, { now: clock.now, refresh: b.refresh === true });
    return { status: 200, body: JSON.parse(JSON.stringify(body)), fromSp: rowsSent - before };
  };
  const listed = () => [...db.store.values()].filter((r) => r.kind === "search" && (r.doc as any).unlisted === undefined);
  return { clock, db, sp, deps, call, parts, own, searches, listed };
}

/** Pages of made-up filings generated per request: `pages` full pages of `per` rows for every batch and window. */
function generated(pages: number, per = 500, over: (n: number) => Record<string, unknown> = () => ({})): Answer {
  return (call) => {
    const p = call.body.properties, first = (p.companyId ?? p.institutionId)[0], page = p.pageNumber;
    const rows = Array.from({ length: page <= pages ? per : 0 }, (_, i) => {
      const n = ((first % 1000) * 100 + Number(p.minPublishDate.slice(2, 4))) * 100000 + page * 1000 + i;
      return filing(n, { filingVersionId: FV(n), companyId: (p.companyId ?? [null])[i % (p.companyId ?? [1]).length], institutionId: null, companyName: `Calloway Test Co ${first}`, sfcNumber: `ABC${n}`, trackingNumber: null, publishDate: p.maxPublishDate, filingDescription: "x".repeat(200), ...over(n) });
    });
    return J(spPage(rows, { totalPages: pages, currentPage: page }));
  };
}
/** S&P's search over a list of rows, `per` rows a page (whatever page size is asked), filtered as S&P does. */
function over(rows: Record<string, unknown>[], per: number): Answer {
  return (call) => {
    const p = call.body.properties;
    const hit = rows.filter((r) => ((p.companyId ?? []).includes(r.companyId) || (p.institutionId ?? []).includes(r.institutionId)) && p.serffFilingStateId.includes(r.serffFilingStateId)
      && p.filingStatusId.includes(r.filingStatusId) && String(r.publishDate) >= p.minPublishDate && String(r.publishDate) <= p.maxPublishDate);
    const page = p.pageNumber, slice = hit.slice((page - 1) * per, page * per);
    return J(spPage(slice, { totalPages: Math.max(1, Math.ceil(hit.length / per)), currentPage: page }));
  };
}
/** The page's way of putting parts together (web/index.html, bsMerge): each filing version once, companies from later
    parts added, then newest first (a stable sort, so filings published the same day keep the order S&P sent them). */
function together(answers: any[]) {
  const by = new Map<string, any>(), rows: any[] = [];
  for (const a of answers) for (const r of a.rows) {
    const k = r.filingVersionId !== null && r.filingVersionId !== undefined ? "v:" + r.filingVersionId : r.serffFilingEntityEventId !== null && r.serffFilingEntityEventId !== undefined ? "e:" + r.serffFilingEntityEventId : "j:" + JSON.stringify(r);
    const kept = by.get(k);
    if (!kept) { const c = { ...r, companies: [...r.companies] }; by.set(k, c); rows.push(c); continue; }
    for (const c of r.companies) if (!kept.companies.some((x: any) => String(x.companyId) === String(c.companyId) && x.companyName === c.companyName)) kept.companies.push(c);
  }
  return rows.sort((a, b) => String(b.publishDate ?? "").localeCompare(String(a.publishDate ?? "")));
}

const SIXTY = Array.from({ length: 60 }, (_, i) => 9100000 + i);
const WIDE = { action: "search", companyIds: SIXTY, states: ["FL", "TX"], from: "2026-01-01", to: "2026-11-13", filingStatusIds: [1] };

// ---------- the bound: a search of 30,000 made-up filings ----------
{
  const w = world(generated(10));   // 6 batches of 10 companies, 10 pages of 500 each: 60 pages, the most one search may ask for
  const ps = await w.parts(WIDE);
  const last = ps.at(-1)!.body;
  ok("a 30,000-filing search runs in parts of at most STEP_ROWS filings", ps.length === 60 / STEP_PAGES && ps.every((p) => p.status === 200 && p.body.rows.length <= STEP_ROWS) && last.total === 30000 && !last.more && last.parts === ps.length, ps.map((p) => [p.status, p.body.rows?.length, p.body.message]));
  ok("no call took more than STEP_ROWS rows from S&P", ps.every((p) => p.fromSp <= STEP_ROWS), ps.map((p) => p.fromSp));
  ok("no answer to the page is over 3 MB", ps.every((p) => p.bytes < 3e6), ps.map((p) => p.bytes));
  ok("the 60 S&P requests are spread over the parts, 4 a part, and counted for the whole search", w.searches() === 60 && last.requests === 60 && ps.every((p, i) => p.body.requests === (i + 1) * STEP_PAGES), ps.map((p) => p.body.requests));
  ok("each part says which it is and roughly how many there are", ps.every((p, i) => p.body.part === i + 1) && ps[0].body.partsAbout === ps.length && ps[0].body.parts === null && last.parts === ps.length, ps.map((p) => [p.body.part, p.body.partsAbout]));
  ok("a part before the last is marked incomplete with a note for pages from before parts; the last isn't", ps.slice(0, -1).every((p) => p.body.capped === true && same(p.body.notes, [partNote(p.body.part)])) && last.capped === false && !last.notes.some((n: string) => n.includes("comes in parts")), ps[0].body.notes);
  ok("each part counts the whole search so far", ps.every((p, i) => p.body.total === (i + 1) * STEP_ROWS));
  const saved = [...w.db.store.values()].filter((r) => r.kind === "search");
  ok("every saved document holds at most STEP_ROWS filings and is under the database's 4 MB", saved.every((r) => (!Array.isArray((r.doc as any).rows) || (r.doc as any).rows.length <= STEP_ROWS) && JSON.stringify(r.doc).length < 4_000_000 && rules.problem(r) === null), saved.map((r) => [r.id, JSON.stringify(r.doc).length]));
  ok("the search is saved once with its counts and how many parts it has, and each part on its own", saved.filter((r) => typeof (r.doc as any).parts === "number" && !(r.doc as any).progress).length === 1 && saved.filter((r) => (r.doc as any).partOf).length === ps.length);
  ok("Recent searches would list it once: only the search itself is listed", w.listed().length === 1 && (w.listed()[0].doc as any).total === 30000 && same((w.listed()[0].doc as any).params.companyIds, SIXTY), w.listed().map((r) => r.id));
  ok("its place between parts is cleared down to the run once it finishes", (() => { const run = [...w.db.store.values()].find((r) => r.id.endsWith(RUN_SUFFIX))!; return (run.doc as any).done === true && !(run.doc as any).tally && JSON.stringify(run.doc).length < 300; })());

  // opened again: every part from the store, nothing asked of S&P
  const again = await w.parts(WIDE);
  ok("opened again, it comes back in the same parts without asking S&P", w.searches() === 60 && again.length === ps.length && again.every((p) => p.body.fromStore === true && p.fromSp === 0) && again.at(-1)!.body.total === 30000, again.map((p) => p.body.fromStore));
  ok("the parts opened again are the parts first fetched", same(together(again.map((p) => p.body)).map((r) => r.filingVersionId), together(ps.map((p) => p.body)).map((r) => r.filingVersionId)));
  ok("opened again, each part still says the whole search's counts", again.every((p) => p.body.total === 30000 && p.body.parts === ps.length));

  // the same search from a caller that doesn't ask for parts stops at the bound and says so
  const one = await w.own({ ...WIDE, refresh: true });
  ok("the functions' own search (one call) stops at STEP_ROWS filings and says the result is incomplete, and why", one.status === 200 && one.body.capped === true && one.body.atBound === true && one.body.rows.length === STEP_ROWS && one.body.notes[0] === boundNote(STEP_PAGES) && one.fromSp <= STEP_ROWS, one.body.notes);
  ok("…it isn't saved, so the parts saved before stay as they were", one.body.saved === false && w.listed().length === 1 && typeof (w.listed()[0].doc as any).parts === "number");
  const held = await w.own(WIDE);
  ok("a saved search in parts, opened by the functions' own search, gives its first part and says it holds more", held.body.fromStore === true && held.body.capped === true && held.body.rows.length === STEP_ROWS && held.body.notes[0] === savedBoundNote(30000, STEP_ROWS) && !("parts" in held.body), held.body.notes);
}

// ---------- parts put together equal the same search in one piece ----------
{
  // 25 companies (three batches of ids) over two years (two windows), 190 filings a company, so the search has several parts.
  // A filing version named by companies in the first and the third batch (two names for one company), filings on the
  // same day, a state with nothing (GA), a company with nothing (9100024), a filing with no version id.
  const ids = Array.from({ length: 25 }, (_, i) => 9100000 + i);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 24; i++) for (let k = 0; k < 190; k++) rows.push(filing(i * 1000 + k, { filingVersionId: FV(i * 1000 + k), companyId: ids[i], companyName: `Calloway Test Co ${i}`, serffFilingStateId: k % 2 ? "TX" : "FL", publishDate: k % 3 ? "2025-06-0" + (1 + (k % 3)) : "2026-0" + (1 + (k + i) % 9) + "-15" }));
  rows.push(filing(900, { filingVersionId: FV(900), companyId: ids[3], companyName: "Calloway Home Co", publishDate: "2026-08-01" }), filing(901, { filingVersionId: FV(900), companyId: ids[22], companyName: "Calloway Coastal Co", publishDate: "2026-08-01" }));
  rows.push(filing(902, { filingVersionId: FV(902), companyId: ids[21], companyName: "Calloway Coastal Co", publishDate: "2026-08-01" }), filing(903, { filingVersionId: FV(902), companyId: ids[2], companyName: "Calloway Insurance Co", publishDate: "2026-08-01" }));
  rows.push(filing(904, { filingVersionId: FV(904), companyId: ids[5], companyName: "Calloway Test Co 5", publishDate: "2026-08-01" }), filing(905, { filingVersionId: FV(904), companyId: ids[5], companyName: "Calloway Renamed Co", publishDate: "2026-08-01" }));
  rows.push(filing(907, { filingVersionId: FV(907), companyId: ids[1], companyName: "Calloway Insurance Co", publishDate: "2026-11-01" }), filing(908, { filingVersionId: FV(907), companyId: ids[23], companyName: "Calloway Alias Co", publishDate: "2026-11-01" }));
  rows.push(filing(906, { filingVersionId: null, serffFilingEntityEventId: 8800001, companyId: ids[7], publishDate: "2025-12-01" }));
  const body = { action: "search", companyIds: ids, states: ["FL", "TX", "GA"], from: "2024-11-14", to: "2026-11-13", filingStatusIds: [1] };
  const w = world(over(rows, 500));
  const ps = await w.parts(body);
  const p: SearchParams = { companyIds: ids, institutionIds: [], states: ["FL", "TX", "GA"], filingStatusIds: [1], typeOfInsuranceIds: [], filingTypeIds: [], spStatEntityIds: [], trackingNumbers: [], from: "2024-11-14", to: "2026-11-13" };
  const o = world(over(rows, 500));
  const api = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: o.deps.fetch, gate: makeGate(o.db, PLAN_LIMITS.trial, o.clock.sleep), sleep: o.clock.sleep });
  const whole = await searchFilings(api, p, { maxRows: Infinity, knownStates: KNOWN });
  const last = ps.at(-1)!.body, joined = together(ps.map((x) => x.body));
  ok("the small search runs in several parts", ps.length >= 3 && ps.every((x) => x.status === 200), ps.map((x) => [x.status, x.body.rows?.length]));
  ok("put together, the parts have the same filings in the same order as one piece", same(joined, JSON.parse(JSON.stringify(whole.rows))), { parts: joined.length, whole: whole.rows.length });
  ok("…including the filing named in two batches, with both companies", joined.find((r) => r.filingVersionId === FV(900)).companies.map((c: any) => c.companyName).join("|") === "Calloway Home Co|Calloway Coastal Co");
  ok("the counts by state and by company and the total are the same", last.total === whole.total && same(last.byState, whole.byState) && same(last.byCompany, whole.byCompany), { parts: [last.byState, last.byCompany.slice(0, 3)], whole: [whole.byState, whole.byCompany.slice(0, 3)] });
  ok("a company's name is the one its newest filing gives, as in one piece", [3, 5, 21, 22, 23].every((k) => last.byCompany.find((c: any) => c.id === ids[k]).name === whole.byCompany.find((c) => c.id === ids[k])!.name) && whole.byCompany.find((c) => c.id === ids[5])!.name === "Calloway Test Co 5" && whole.byCompany.find((c) => c.id === ids[23])!.name === "Calloway Alias Co");
  ok("the notes are the same, the empty state and the empty company included", same(last.notes, whole.notes) && last.notes.includes(emptyStateNote("GA")) && last.notes.some((n: string) => n.includes("company id 9100024")), { parts: last.notes, whole: whole.notes });
  ok("the requests are the same as one piece", last.requests === whole.requests, [last.requests, whole.requests]);
  ok("the search's own notes come only with the last part", ps.slice(0, -1).every((x) => same(x.body.notes, [partNote(x.body.part)])));
  const twice = await world(over(rows, 500)).parts(body);
  ok("the same search run twice gives the same rows in the same order", same(together(twice.map((x) => x.body)), joined));
  // a search that fits in one part is answered and saved as searches always were
  const few = rows.filter((r) => { const n = Number(r.serffFilingEntityEventId) - 600000; return n % 1000 < 5 || (n >= 900 && n < 1000); });
  ok("(the small case is small)", few.length < 200, few.length);
  const small = world(over(few, 500)), alone = world(over(few, 500));
  const s = await small.parts(body);
  const whole1 = await searchFilings(new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: alone.deps.fetch, gate: makeGate(alone.db, PLAN_LIMITS.trial, alone.clock.sleep), sleep: alone.clock.sleep }), p, { knownStates: KNOWN });
  ok("a search that fits in one part comes in one answer, sorted, saved whole", s.length === 1 && s[0].body.part === 1 && s[0].body.parts === 1 && s[0].body.more === false && s[0].body.cursor === null && s[0].body.saved === true && same(s[0].body.rows, JSON.parse(JSON.stringify(whole1.rows))), s.map((x) => x.body.rows.length));
  const doc = small.db.store.get(await searchKey(p))!.doc as any;
  ok("…saved as one document with every row, as before", Array.isArray(doc.rows) && doc.rows.length === whole1.total && doc.parts === undefined && same(Object.keys(doc), ["params", "rows", "total", "requests", "capped", "byState", "byCompany", "notes", "source"]), Object.keys(doc));
}

// ---------- an empty part, the too-wide refusal, the request total across parts ----------
{
  // the first batch's year has filings; the next ones have none, so whole parts come back empty
  const w = world((call) => { const p = call.body.properties; return generated(p.companyId[0] === 9100000 ? 4 : 1, p.companyId[0] === 9100000 ? 500 : 0)(call); });
  const ps = await w.parts(WIDE);
  ok("a part that comes back with no filings is not an error: the search carries on and finishes", ps.every((p) => p.status === 200) && ps.some((p) => p.body.rows.length === 0) && ps.at(-1)!.body.more === false && ps.at(-1)!.body.total === 2000, ps.map((p) => [p.status, p.body.rows?.length]));
  ok("…and the result is saved", ps.at(-1)!.body.saved === true && w.listed().length === 1);

  const wide = world(generated(1));
  const r = await wide.call({ ...WIDE, companyIds: Array.from({ length: 70 }, (_, i) => 9100000 + i), from: "2016-11-15", to: "2026-11-13" });
  ok("a search too wide for its 60 requests is refused before any request is spent, in parts as before", r.status === 400 && r.body.error === "spgmi_bad_request" && /needs at least 77 S&P requests/.test(r.body.message) && wide.searches() === 0, r.body);

  const endless = world((call) => J(spPage(Array.from({ length: 500 }, (_, i) => filing(call.body.properties.pageNumber * 1000 + i, { filingVersionId: FV(call.body.properties.pageNumber * 1000 + i), companyId: 9100001 })), { totalPages: 9999 })));
  const e = await endless.parts({ ...WIDE, companyIds: [9100001] });
  const end = e.at(-1)!.body;
  ok(`the ${MAX_SEARCH_REQUESTS}-request limit is for the whole search, across its parts`, endless.searches() === MAX_SEARCH_REQUESTS && end.requests === MAX_SEARCH_REQUESTS && e.length === MAX_SEARCH_REQUESTS / STEP_PAGES, { n: endless.searches(), parts: e.length });
  ok("…then it stops, says the result is incomplete, makes no claim about empty states, and isn't saved", end.capped === true && end.more === false && end.notes[0].startsWith(`The search stopped after ${MAX_SEARCH_REQUESTS} S&P requests`) && !end.notes.some((n: string) => /returned no filings/.test(n)) && end.saved === false && endless.listed().length === 0, end.notes);
}

// ---------- a lost answer, a lost place, a saved search refreshed while it opens ----------
{
  const w = world(generated(3));   // 6 batches x 3 pages: 18 pages, 5 parts
  const one = await w.call({ ...WIDE });
  const two = await w.call({ ...WIDE, cursor: one.body.cursor });
  const n = w.searches();
  const again = await w.call({ ...WIDE, cursor: one.body.cursor });
  ok("asking for a part again (its answer was lost on the way) sends the same part, without asking S&P", again.status === 200 && w.searches() === n && same(again.body.rows, two.body.rows) && again.body.part === 2 && same(again.body.cursor, two.body.cursor), { s: again.status, n: w.searches() - n });
  // Another run's id: the real one with its first character changed. (Swapping it for a fixed "0" left the id unchanged
  // whenever the real one already began with 0, one run in sixteen, and the check then failed by chance.)
  const otherRun = (one.body.cursor.run[0] === "0" ? "1" : "0") + one.body.cursor.run.slice(1);
  const bad = await w.call({ ...WIDE, cursor: { run: otherRun, part: 3 } });
  ok("a cursor from another run of the search can't carry on: 409 with what to do", bad.status === 409 && bad.body.error === "search_lost" && bad.body.message === LOST_PLACE, bad.body);
  const skip = await w.call({ ...WIDE, cursor: { ...two.body.cursor, part: 5 } });
  ok("nor can a cursor that skips a part", skip.status === 409 && skip.body.error === "search_lost");
  const junk = await w.call({ ...WIDE, cursor: { run: "<script>", part: 2 } });
  ok("a cursor that isn't one is refused the same way", junk.status === 409 && junk.body.message === LOST_PLACE);
  let c = two.body.cursor, last = two;
  while (last.body.more) { last = await w.call({ ...WIDE, cursor: c }); c = last.body.cursor; }
  ok("after those, the search still finishes and is saved", last.status === 200 && last.body.saved === true && last.body.total === 18 * 500, last.body);
  const lostLast = await w.call({ ...WIDE, cursor: { run: one.body.cursor.run, part: last.body.part } });
  ok("asking again for the last part, once the search is saved, sends it from the saved search", lostLast.status === 200 && lostLast.body.fromStore === true && same(lostLast.body.rows, last.body.rows));

  // opening it, then someone refreshes it before the next part is asked for
  const open1 = await w.call({ ...WIDE });
  ok("a saved search opens from the store, part 1 of its parts", open1.body.fromStore === true && open1.body.part === 1 && open1.body.parts === last.body.part && open1.body.cursor.run.startsWith("s"), open1.body);
  const re = await w.parts({ ...WIDE, refresh: true });
  ok("Refresh asks S&P for all of it again", re.length === last.body.part && re.every((p) => p.body.fromStore === false) && w.searches() === 2 * 18 && re.at(-1)!.body.saved === true, w.searches());
  ok("…and Recent searches still lists it once", w.listed().length === 1);
  const stale = await w.call({ ...WIDE, cursor: open1.body.cursor });
  ok("carrying on from before the refresh says plainly the saved search changed", stale.status === 409 && stale.body.error === "search_moved" && stale.body.message === MOVED, stale.body);
  const fresh = await w.parts(WIDE);
  ok("opening it again gives the refreshed result", fresh.every((p) => p.body.fromStore) && fresh.at(-1)!.body.total === 18 * 500);

  // kept out of Recent searches
  const u = world(generated(3));
  const up = await u.parts({ ...WIDE, unlisted: true });
  ok("a search kept out of Recent searches is saved in parts and listed nowhere", up.at(-1)!.body.saved === true && up.at(-1)!.body.unlisted === true && u.listed().length === 0 && [...u.db.store.values()].filter((r) => r.kind === "search").length > 1);
  const upAgain = await u.parts(WIDE);
  ok("…and opens again from the store", upAgain.every((p) => p.body.fromStore) && upAgain.at(-1)!.body.total === 18 * 500);
}

// ---------- results saved before parts ----------
{
  const w = world(generated(1));
  const p: SearchParams = { companyIds: [9100001], institutionIds: [], states: ["FL"], filingStatusIds: [1], typeOfInsuranceIds: [], filingTypeIds: [], spStatEntityIds: [], trackingNumbers: [], from: "2026-01-01", to: "2026-11-13" };
  const rows = Array.from({ length: 4500 }, (_, i) => ({ ...filing(i, { filingVersionId: FV(i), publishDate: `2026-${String(10 - Math.floor(i / 500)).padStart(2, "0")}-01` }), companies: [{ companyId: 9100001, companyName: "Calloway Insurance Co", naicCompanyCode: "91001", institutionId: 810001, spStatEntityId: "C9101" }] }));
  const id = await searchKey(p);
  w.db.store.set(id, { id, kind: "search", label: "FL", doc: { params: { ...p, allStatuses: false }, rows, total: 4500, requests: 9, capped: false, byState: [{ state: "FL", rows: 4500 }], byCompany: [{ kind: "companyId", id: 9100001, name: "Calloway Insurance Co", rows: 4500 }], notes: [], source: "S&P Global Market Intelligence, SNL Insurance Product Filings" }, fetched_at: "2026-11-01T10:00:00.000Z" });
  const body = { action: "search", companyIds: [9100001], states: ["FL"], from: "2026-01-01", to: "2026-11-13", filingStatusIds: [1] };
  const ps = await w.parts(body);
  ok("a large result saved whole before parts opens in parts, with no S&P request", ps.length === 3 && ps.map((x) => x.body.rows.length).join() === "2000,2000,500" && w.searches() === 0 && ps.every((x) => x.body.fromStore && x.body.total === 4500 && x.body.fetchedAt === "2026-11-01T10:00:00.000Z"), ps.map((x) => [x.status, x.body.rows?.length]));
  ok("…and put together it is the saved result", same(together(ps.map((x) => x.body)), rows));
  const held = await w.own(body);
  ok("opened by the functions' own search, it gives its newest STEP_ROWS filings and says the rest are left out", held.body.rows.length === STEP_ROWS && held.body.capped === true && held.body.notes[0] === savedBoundNote(4500, STEP_ROWS) && held.body.rows[0].publishDate === "2026-10-01", held.body.notes);
  const smallId = await searchKey({ ...p, states: ["TX"] });
  const doc = { params: { ...p, states: ["TX"], allStatuses: false }, rows: rows.slice(0, 3), total: 3, requests: 1, capped: false, byState: [{ state: "TX", rows: 3 }], byCompany: [], notes: ["A note saved with it."], source: "S&P Global Market Intelligence, SNL Insurance Product Filings" };
  w.db.store.set(smallId, { id: smallId, kind: "search", label: "TX", doc, fetched_at: "2026-11-01T10:00:00.000Z" });
  const a = await w.call({ ...body, states: ["TX"] }), b = await w.own({ ...body, states: ["TX"] });
  ok("a small result saved before parts opens exactly as it was saved, either way", same(a.body.rows, doc.rows) && same(a.body.notes, doc.notes) && a.body.more === false && a.body.parts === 1 && same(b.body.rows, doc.rows) && b.body.capped === false && same(b.body.notes, doc.notes), { a: a.body.notes, b: b.body.capped });
}

// ---------- Claude's search_filings at and over the bound ----------
async function claudeSearch(pages: number) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), seen: Record<string, any> = {};
  const claude = fakeAnthropic([
    { content: [toolUse("s1", "search_filings", { company_ids: [9100001], institution_ids: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] })] },
    (b) => { seen.s1 = toolResults(b).s1; return { content: [say("Done.")] }; },
    { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] },
  ]);
  const sp = spStub(clock, (call) => (call.path === "/api/v1/reference" ? J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }] }) : generated(pages)(call)));
  const pending: Promise<unknown>[] = [];
  const deps = { env: env({ ...SECRETS, ANTHROPIC_API_KEY: "test-anthropic-key" }), fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: async () => ({ id: "login-1", role: "corpdev" }), db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const r: Response = await chatFn.handle(req("snl-chat", { action: "ask", question: "What did Calloway file in Florida this year?" }), deps);
  const jobId = (await r.json()).jobId;
  while (pending.length) await pending.shift();
  return { seen: seen.s1, result: db.jobs.get(jobId)!.result as any, searches: sp.calls("/api/v1/search").length };
}
{
  const at = await claudeSearch(STEP_PAGES);
  ok("Claude's search of exactly STEP_ROWS filings is complete, with no limit hit", at.seen && !at.seen.isError && at.seen.value.total === STEP_ROWS && !at.seen.value.notes.some((n: string) => /incomplete/.test(n)) && !at.result.caps.some((c: string) => /hold at once/.test(c)), at.seen?.value?.notes);
  const past = await claudeSearch(STEP_PAGES + 3);
  ok("over the bound, Claude's search stops at STEP_ROWS filings and Claude is told why it is incomplete", past.searches === STEP_PAGES && past.seen.value.total === STEP_ROWS && past.seen.value.notes[0] === boundNote(STEP_PAGES), past.seen.value.notes);
  ok("…and the answer says so in its list of limits hit, in plain words", past.result.caps.includes(`One search found more filings than the site can hold at once (${STEP_ROWS.toLocaleString("en-US")}), so its results are incomplete. Narrow the dates, states or companies.`), past.result.caps);
}

// ---------- the filings profile at and over the bound ----------
async function profileFacts(pages: number) {
  forgetTokens();
  const clock = fakeClock("2026-11-18T12:00:00Z"), db = memoryDb(clock);
  db.putEntities([{ companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: "6000001", spStatEntityId: null, naicGroupCode: null, naicGroupName: "Calloway Group (SNL P&C Group)" }]);
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") { const l = refs[call.query.referenceField]; return J({ headers: l.headers, rows: l.rows.map((row: unknown[]) => ({ row })) }); }
    const p = call.body.properties;
    return J(spPage(Array.from({ length: 500 }, (_, i) => filing(p.pageNumber * 1000 + i, { institutionId: 6000001, companyId: null, filingDescription: null, publishDate: p.maxPublishDate, filingVersionId: `V-${p.minPublishDate}-${p.pageNumber}-${i}` })), { totalPages: pages, currentPage: p.pageNumber }));
  });
  const deps = { env: env(SECRETS), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const res: Response = await profileFn.handle(req("snl-profile", { action: "filings_facts", kind: "company", institutionId: "6000001", years: 1 }), deps);
  return { status: res.status, body: await res.json(), searches: sp.calls("/api/v1/search").length };
}
{
  const at = await profileFacts(STEP_PAGES);
  ok("a filings profile whose search is exactly STEP_ROWS filings is complete", at.status === 200 && at.body.facts.search.capped === false && at.body.facts.totals.filings === STEP_ROWS, at.body.facts?.search);
  const past = await profileFacts(STEP_PAGES * 2);
  ok("over the bound, the profile's search stops at STEP_ROWS filings and the profile says it stopped early", past.status === 200 && past.searches === STEP_PAGES && past.body.facts.search.capped === true && past.body.facts.totals.filings === STEP_ROWS && /stopped early/.test(past.body.text.summary.points[0].text), { s: past.searches, t: past.body.text?.summary?.points?.[0] });
}

// ---------- the watchlist at and over the bound ----------
async function watchCheck(pages: number) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  db.settings.set("watchlist", { enabled: true, companies: [{ kind: "companyId", id: "9100001", name: "Calloway Insurance Co" }], states: ["FL"], recipients: [] });
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") return J({ headers: ["filingStatusId", "filingStatus"], rows: [{ row: [1, "Closed - Approved"] }] });
    const p = call.body.properties;
    return J(spPage(Array.from({ length: 500 }, (_, i) => filing(p.pageNumber * 1000 + i, { filingVersionId: FV(p.pageNumber * 1000 + i), publishDate: p.maxPublishDate })), { totalPages: pages, currentPage: p.pageNumber }));
  });
  const deps = { env: env({ ...SECRETS, WATCH_SECRET: "made-up-watch-secret-0123456789abcdef" }), fetch: sp.fetch, mailFetch: (async () => J({})) as unknown as typeof fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const res: Response = await watchFn.handle(new Request("https://x.supabase.co/functions/v1/snl-watch", { method: "POST", headers: { Authorization: "Bearer u", apikey: "k" }, body: JSON.stringify({ action: "run" }) }), deps);
  return { status: res.status, body: await res.json(), searches: sp.calls("/api/v1/search").length };
}
{
  const at = await watchCheck(STEP_PAGES);
  ok("a watchlist check that finds exactly STEP_ROWS filings is complete", at.status === 200 && at.body.run.complete === true && at.body.run.found === STEP_ROWS, at.body);
  const past = await watchCheck(STEP_PAGES + 2);
  ok("over the bound, the check stops at STEP_ROWS filings and says it may have missed some, and why", past.body.run.complete === false && past.body.run.found === STEP_ROWS && past.searches === STEP_PAGES && past.body.run.message.includes(`The check found more filings than it can hold at once (${STEP_ROWS.toLocaleString("en-US")}), so it stopped before S&P had returned everything and may have missed some filings.`), past.body.run);
}

// ---------- the market index: a batch with more filings than one call holds is read in pieces ----------
{
  const who = { companyId: 9300000, name: "Nonesuch Mutual No. 0 Co" };
  const rows = Array.from({ length: 4600 }, (_, i) => indexFiling(i + 1, who, { publishDate: "2026-0" + (1 + (i % 9)) + "-02" }));
  rows.push(indexFiling(1, { companyId: 9300001, name: "Nonesuch Mutual No. 1 Co" }, { publishDate: "2026-01-02" }));   // the first filing again, for a second company in the batch
  const w = indexWorld({ rows, byCompany: 2, byInstitution: 0 });
  const t = w.db as unknown as { putIndexRows: (r: any[]) => Promise<void>; filingRows: Map<string, any> };
  const sizes: number[] = [], put = t.putIndexRows.bind(t);
  t.putIndexRows = async (r) => { sizes.push(r.length); return put(r); };
  await startSweep(w.ctx(), { state: "FL", period: "last_12_months", kind: "sweep" });
  const s = await runStep(w.ctx());
  const sw = (w.db as any).sweepRows[0];
  ok("a batch of 4,600 filings (10 pages) is read in pieces of at most STEP_ROWS and every filing is kept", s.reason === "done" && w.searches().length === 10 && t.filingRows.size === 4600 && sizes.every((n) => n <= STEP_ROWS) && sizes.length === 3 && sw.missed.length === 0, { reason: s.reason, n: w.searches().length, kept: t.filingRows.size, sizes });
  ok("…each filing counted once, and a filing named on two pages keeps both companies", sw.rows_found === 4600 && t.filingRows.get("FL|v:" + rows[0].filingVersionId).companies.length === 2, sw.rows_found);
}

done();
