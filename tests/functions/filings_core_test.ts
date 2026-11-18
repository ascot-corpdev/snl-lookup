// The filing search's building blocks (supabase/functions/_shared/filings.ts): reading S&P's rows by column
// name, splitting a search into id batches and date windows, paging, removing duplicates, the notes that keep an
// empty result from reading as "no filings exist", saved results, reference lists, and company look-up.
import {
  batches, dateWindows, dedupe, downloadDocument, emptyStateNote, entitiesFrom, getReference, mapRows, MAX_IDS_PER_REQUEST, NO_MATCH, PAGE_SIZE,
  parseDocRef, parseSearch, planSearch, referenceOptions, resolveEntity, savedOrFreshSearch, searchFilings, searchKey, SEARCH_COLUMNS, SOURCE, type SearchParams,
} from "../../supabase/functions/_shared/filings.ts";
import { forgetTokens, makeGate, PLAN_LIMITS, Spgmi, SpgmiError } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, fakeClock, fakeSpgmi, J, memoryDb, read, type SpCall } from "./helpers/fakes.ts";
import { filing, HEADERS, spError, spPage, spStub, watchStore } from "./helpers/more.ts";

const { ok, done } = checks();
const caught = async (p: Promise<unknown>): Promise<any> => { try { await p; return null; } catch (e) { return e; } };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const TODAY = "2026-11-13";
const P = (over: Partial<SearchParams> = {}): SearchParams => ({ companyIds: [9100001], institutionIds: [], states: ["FL"], filingStatusIds: [1], typeOfInsuranceIds: [], filingTypeIds: [], spStatEntityIds: [], trackingNumbers: [], from: "2026-01-01", to: "2026-11-13", ...over });
const DAY = 86_400_000, ms = (d: string) => Date.parse(d + "T00:00:00Z"), ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** S&P's search over a list of made-up rows: filters as S&P does, then pages. */
function searchOver(rows: Record<string, unknown>[], opts: { totalPages?: boolean; headers?: string[] } = {}) {
  return (call: SpCall) => {
    if (call.path !== "/api/v1/search") return spError(404, "Invalid endpoint");
    const p = call.body.properties;
    const hit = rows.filter((r) => ((p.companyId ?? []).includes(r.companyId) || (p.institutionId ?? []).includes(r.institutionId)) && p.serffFilingStateId.includes(String(r.serffFilingStateId).toUpperCase())
      && p.filingStatusId.includes(r.filingStatusId) && String(r.publishDate) >= p.minPublishDate && String(r.publishDate) <= p.maxPublishDate
      && (!p.typeOfInsuranceId || p.typeOfInsuranceId.includes(r.typeOfInsuranceId)) && (!p.serffFilingTypeId || p.serffFilingTypeId.includes(r.serffFilingTypeId)));
    const size = p.pageSize ?? 500, page = p.pageNumber ?? 1, slice = hit.slice((page - 1) * size, page * size);
    return J(spPage(slice, opts.totalPages === false ? {} : { currentPageSize: slice.length, currentPage: page, totalPages: Math.max(1, Math.ceil(hit.length / size)) }, opts.headers));
  };
}
function client(answer: Parameters<typeof spStub>[1]) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = spStub(clock, answer);
  const api = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: sp.fetch, gate: makeGate(db, PLAN_LIMITS.trial, clock.sleep), sleep: clock.sleep });
  return { clock, db, sp, api, searches: () => sp.calls("/api/v1/search") };
}

// ---------- mapRows: by header name, never by position ----------
{
  const row = filing(1, { overallRateImpact: 6.5, sfcNumber: "" });
  const straight = mapRows(spPage([row]))[0];
  ok("a row is read into S&P's column names", SEARCH_COLUMNS.every((c) => c in straight) && straight.trackingNumber === "TEST-000001" && straight.companyId === 9100001 && straight.overallRateImpact === 6.5, straight);
  const shuffled = [...HEADERS].reverse();
  ok("columns in a different order give the same row", same(Object.entries(mapRows(spPage([row], {}, shuffled))[0]).sort(), Object.entries(straight).sort()));
  const rotated = [...HEADERS.slice(11), ...HEADERS.slice(0, 11)];
  ok("columns rotated give the same values under the same names", SEARCH_COLUMNS.every((c) => mapRows(spPage([row], {}, rotated))[0][c] === straight[c]));
  const extra = ["newColumnFromSp", ...HEADERS.slice(0, 5), "another_new_one", ...HEADERS.slice(5)];
  const withExtra = mapRows(spPage([{ ...row, newColumnFromSp: "x1", another_new_one: 42 }], {}, extra))[0];
  ok("columns the app doesn't know are kept under S&P's own names and shift nothing", withExtra.newColumnFromSp === "x1" && withExtra.another_new_one === 42 && SEARCH_COLUMNS.every((c) => withExtra[c] === straight[c]), withExtra);
  const cased = HEADERS.map((h, i) => (i % 3 === 0 ? h.toUpperCase() : i % 3 === 1 ? h.toLowerCase() : h[0].toUpperCase() + h.slice(1)));
  const fromCased = mapRows({ headers: cased, rows: [{ row: HEADERS.map((h) => row[h]) }] })[0];
  ok("column names in a different case are read as the same columns", same(fromCased, straight), Object.keys(fromCased));
  const short = mapRows({ headers: HEADERS, rows: [{ row: HEADERS.slice(0, 9).map((h) => row[h]) }] })[0];
  ok("a row with cells missing off the end gives null for those columns, not a shifted row", short.companyName === "Calloway Insurance Co" && short.naicGroupCode === null && short.documentId === null && Object.keys(short).length === HEADERS.length, short);
  ok("an empty cell reads as null", straight.sfcNumber === null && straight.dispOverallRateImpact === null);
  ok("zero and false are kept, not turned into null", (() => { const r = mapRows({ headers: ["serffFilingTypeId", "flag"], rows: [{ row: [0, false] }] })[0]; return r.serffFilingTypeId === 0 && r.flag === false; })());
  ok("a row longer than the headers ignores the spare cells", same(mapRows({ headers: ["companyId"], rows: [{ row: [1, 2, 3] }] }), [{ companyId: 1 }]));
  ok("rows sent as bare lists are read too", same(mapRows({ headers: ["companyId", "companyName"], rows: [[7, "Tarrow Mutual Insurance Co"]] }), [{ companyId: 7, companyName: "Tarrow Mutual Insurance Co" }]));
  ok("a cell holding a list or object is kept as text", mapRows({ headers: ["companyName"], rows: [{ row: [["a", "b"]] }] })[0].companyName === '["a","b"]');
  ok("a row that isn't a row gives nulls rather than failing", same(mapRows({ headers: ["companyId"], rows: [null, "x", { row: "nope" }, {}] }), [{ companyId: null }, { companyId: null }, { companyId: null }, { companyId: null }]));
  for (const [name, v] of [["no headers", { rows: [{ row: [1] }] }], ["no rows", { headers: ["a"] }], ["null", null], ["text", "oops"], ["an error body", { status: 500, message: "x" }]] as const)
    ok(`an answer with ${name} gives no usable rows and doesn't fail`, (() => { try { return mapRows(v).every((r) => Object.keys(r).length === 0); } catch { return false; } })());
  ok("the app's column list is the 30 columns S&P documents", SEARCH_COLUMNS.length === 30 && same([...SEARCH_COLUMNS], HEADERS));
}

// ---------- dateWindows ----------
{
  const span = (w: [string, string]) => (ms(w[1]) - ms(w[0])) / DAY;
  /** Every day from..to is in exactly one window; windows run newest first; none is longer than S&P allows. */
  const sound = (from: string, to: string) => {
    const w = dateWindows(from, to);
    if (!w.length || w[0][1] !== to || w.at(-1)![0] !== from) return false;
    for (let i = 0; i < w.length; i++) {
      if (w[i][0] > w[i][1] || span(w[i]) > 365) return false;
      if (i > 0 && ms(w[i][1]) !== ms(w[i - 1][0]) - DAY) return false;   // touches the next one with no gap and no shared day
    }
    return w.reduce((n, x) => n + span(x) + 1, 0) === (ms(to) - ms(from)) / DAY + 1;
  };
  ok("a single day is one window of that day", same(dateWindows("2026-03-01", "2026-03-01"), [["2026-03-01", "2026-03-01"]]));
  ok("a range inside a year is one window", same(dateWindows("2026-01-01", "2026-11-13"), [["2026-01-01", "2026-11-13"]]));
  ok("365 days counted inclusively is one window", same(dateWindows("2025-01-01", "2025-12-31"), [["2025-01-01", "2025-12-31"]]));
  ok("one day more makes a second window of that one day", same(dateWindows("2024-12-31", "2025-12-31"), [["2025-01-01", "2025-12-31"], ["2024-12-31", "2024-12-31"]]), dateWindows("2024-12-31", "2025-12-31"));
  ok("a leap year (366 days) needs two windows and misses no day", same(dateWindows("2024-01-01", "2024-12-31"), [["2024-01-02", "2024-12-31"], ["2024-01-01", "2024-01-01"]]) && sound("2024-01-01", "2024-12-31"), dateWindows("2024-01-01", "2024-12-31"));
  ok("29 February is covered once", dateWindows("2023-06-01", "2024-06-01").filter(([a, b]) => a <= "2024-02-29" && "2024-02-29" <= b).length === 1 && sound("2023-06-01", "2024-06-01"));
  ok("a single 29 February is one window", same(dateWindows("2024-02-29", "2024-02-29"), [["2024-02-29", "2024-02-29"]]));
  ok("windows run newest first", (() => { const w = dateWindows("2021-11-13", "2026-11-13"); return w.length === 6 && w.every((x, i) => i === 0 || x[1] < w[i - 1][0]); })(), dateWindows("2021-11-13", "2026-11-13"));
  ok("no window is more than 365 days end to end, so S&P's 365-day limit holds however S&P counts it", dateWindows("2016-11-13", "2026-11-13").every((w) => span(w) <= 364), dateWindows("2016-11-13", "2026-11-13").map(span));
  ok("a start after the end gives no windows", dateWindows("2026-02-01", "2026-01-01").length === 0);
  let allSound = true, bad = "";
  for (const [from, to] of [["2020-02-28", "2021-02-28"], ["2020-03-01", "2021-03-01"], ["2019-12-31", "2021-01-01"], ["2023-12-31", "2024-12-30"], ["2023-12-31", "2024-12-31"], ["2024-02-29", "2025-02-28"], ["2024-02-29", "2025-03-01"], ["2000-01-01", "2010-01-01"], ["1999-12-31", "2000-12-31"]])
    if (!sound(from, to)) { allSound = false; bad = `${from}..${to}`; }
  ok("year ends, leap days and exact boundaries are each covered exactly once", allSound, bad);
  // many ranges, with a fixed seed so a failure can be repeated
  let seed = 20261113, worst = "";
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 400 && !worst; i++) { const a = ms("2014-01-01") + rnd(4000) * DAY, b = a + rnd(3700) * DAY; if (!sound(ymd(a), ymd(b))) worst = `${ymd(a)}..${ymd(b)}`; }
  ok("400 ranges of up to ten years: every day is in exactly one window", worst === "", worst);
  ok("a custom window length is honoured", same(dateWindows("2026-01-01", "2026-01-10", 3), [["2026-01-07", "2026-01-10"], ["2026-01-03", "2026-01-06"], ["2026-01-01", "2026-01-02"]]), dateWindows("2026-01-01", "2026-01-10", 3));
}

// ---------- batches and planSearch ----------
{
  ok("S&P's limit of 10 ids a request is the batch size", MAX_IDS_PER_REQUEST === 10 && PAGE_SIZE === 500);
  ok("no ids, no batches", batches([]).length === 0);
  const sizes = (n: number) => batches(Array.from({ length: n }, (_, i) => i)).map((b) => b.length).join();
  ok("ids split into batches of at most 10, in order, none lost", sizes(1) === "1" && sizes(10) === "10" && sizes(11) === "10,1" && sizes(20) === "10,10" && sizes(25) === "10,10,5" && same(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));

  const companyIds = Array.from({ length: 23 }, (_, i) => 9100001 + i), institutionIds = Array.from({ length: 12 }, (_, i) => 810001 + i);
  const plan = planSearch(P({ companyIds, institutionIds, states: ["FL", "TX"], filingStatusIds: [1, 2], from: "2024-06-01", to: "2026-11-13" }));
  ok("23 companies and 12 institutions over three windows make 15 requests", plan.length === 15, plan.length);
  ok("no request carries more than 10 ids", plan.every((b: any) => (b.companyId ?? b.institutionId).length <= 10));
  ok("company ids and institution ids never share a request", plan.every((b: any) => (b.companyId === undefined) !== (b.institutionId === undefined)));
  const windows = [...new Set(plan.map((b: any) => `${b.minPublishDate}|${b.maxPublishDate}`))];
  ok("every window asks for every id exactly once", windows.length === 3 && windows.every((w) => {
    const inW = plan.filter((b: any) => `${b.minPublishDate}|${b.maxPublishDate}` === w);
    return same(inW.flatMap((b: any) => b.companyId ?? []).sort(), [...companyIds].sort()) && same(inW.flatMap((b: any) => b.institutionId ?? []).sort(), [...institutionIds].sort());
  }));
  ok("every request carries the dates, the states and the statuses S&P requires", plan.every((b: any) => /^\d{4}-\d{2}-\d{2}$/.test(b.minPublishDate) && /^\d{4}-\d{2}-\d{2}$/.test(b.maxPublishDate) && same(b.serffFilingStateId, ["FL", "TX"]) && same(b.filingStatusId, [1, 2])));
  ok("no request spans more than 365 days", plan.every((b: any) => (ms(b.maxPublishDate) - ms(b.minPublishDate)) / DAY <= 365));
  ok("filters that weren't chosen are left out of the request", plan.every((b: any) => !("typeOfInsuranceId" in b) && !("serffFilingTypeId" in b) && !("spStatEntityId" in b) && !("trackingNumber" in b)), Object.keys(plan[0]));
  const full = planSearch(P({ typeOfInsuranceIds: [4], filingTypeIds: [0, 1], spStatEntityIds: ["C9101"], trackingNumbers: ["CALL-134000001"] }))[0] as any;
  ok("chosen filters use S&P's property names", same(full.typeOfInsuranceId, [4]) && same(full.serffFilingTypeId, [0, 1]) && same(full.spStatEntityId, ["C9101"]) && same(full.trackingNumber, ["CALL-134000001"]) && same(full.companyId, [9100001]), full);
  ok("a search by institution only sends institutionId and no companyId", (() => { const b = planSearch(P({ companyIds: [], institutionIds: [810001] }))[0] as any; return same(b.institutionId, [810001]) && !("companyId" in b); })());
}

// ---------- parseSearch ----------
{
  const good = { companyIds: [9100001, "9100002", 9100001], institutionIds: ["810003"], states: ["fl", " Tx "], from: "2025-01-01", to: "2025-12-31" };
  const p = parseSearch(good, TODAY);
  ok("a good search is accepted", p.ok === true, p);
  if (p.ok) {
    ok("ids typed as text become numbers and repeats are dropped", same(p.params.companyIds, [9100001, 9100002]) && same(p.params.institutionIds, [810003]), p.params);
    ok("state codes are tidied to upper case", same(p.params.states, ["FL", "TX"]), p.params.states);
    ok("filters left out are empty lists", same([p.params.filingStatusIds, p.params.typeOfInsuranceIds, p.params.filingTypeIds, p.params.spStatEntityIds, p.params.trackingNumbers], [[], [], [], [], []]));
  }
  const d = parseSearch({ companyIds: [1], states: ["FL"] }, TODAY);
  ok("with no dates the search covers the 365 days up to today", d.ok && d.params.to === TODAY && d.params.from === "2025-11-14" && dateWindows(d.params.from, d.params.to).length === 1, d);
  const e = parseSearch({ companyIds: [1], states: ["FL"], from: "", to: null }, TODAY);
  ok("blank dates are treated as left out", e.ok && e.params.to === TODAY && e.params.from === "2025-11-14", e);
  const f = parseSearch({ companyIds: [1], states: ["FL"], to: "2024-03-01" }, TODAY);
  ok("with only an end date the search covers the 365 days up to it", f.ok && f.params.from === "2023-03-03" && f.params.to === "2024-03-01", f);
  const g = parseSearch({ institutionIds: [810001], states: ["FL"] }, TODAY);
  ok("an institution id alone is enough", g.ok && same(g.params.companyIds, []) && same(g.params.institutionIds, [810001]));

  const refused = (name: string, body: Record<string, unknown>, says: RegExp) => {
    let r: any;
    try { r = parseSearch({ companyIds: [9100001], states: ["FL"], from: "2025-01-01", to: "2025-12-31", ...body }, TODAY); } catch (err) { r = { threw: String(err) }; }
    ok(`${name} is refused with a plain reason`, r.ok === false && says.test(r.message), r);
  };
  refused("a search with no company", { companyIds: [] }, /Choose at least one company/);
  refused("a search with no company fields at all", { companyIds: undefined }, /Choose at least one company/);
  refused("a company id that isn't a whole number", { companyIds: [1.5] }, /whole numbers/);
  refused("a negative company id", { companyIds: [-1] }, /whole numbers/);
  refused("a company id with letters", { companyIds: ["91a"] }, /whole numbers/);
  refused("a company id that tries to carry SQL", { companyIds: ["1; drop table x"] }, /whole numbers/);
  refused("company ids that aren't a list", { companyIds: "9100001" }, /whole numbers/);
  refused("an institution id that is an object", { institutionIds: [{ id: 1 }] }, /whole numbers/);
  refused("more than 100 companies and institutions together", { companyIds: Array.from({ length: 60 }, (_, i) => i + 1), institutionIds: Array.from({ length: 41 }, (_, i) => i + 1000) }, /at most 100/);
  refused("more than 100 companies", { companyIds: Array.from({ length: 101 }, (_, i) => i + 1) }, /at most 100/);
  refused("a search with no state", { states: [] }, /at least one state/);
  refused("a state written out in full", { states: ["Florida"] }, /two-letter code/);
  refused("states that aren't a list", { states: "FL" }, /two-letter code/);
  refused("a state with a digit", { states: ["F1"] }, /two-letter code/);
  refused("a filing status that isn't an id", { filingStatusIds: ["approved"] }, /S&P's reference lists/);
  refused("a type of insurance that isn't an id", { typeOfInsuranceIds: [4.2] }, /S&P's reference lists/);
  refused("a filing type that isn't a list", { filingTypeIds: 0 }, /S&P's reference lists/);
  refused("a tracking number with odd characters", { trackingNumbers: ["CALL'; --"] }, /short text values/);
  refused("a statutory entity id with a space", { spStatEntityIds: ["C 9101"] }, /short text values/);
  refused("a tracking number that isn't text", { trackingNumbers: [134000001] }, /short text values/);
  refused("a date in the wrong shape", { from: "01/02/2025" }, /Dates must look like/);
  refused("a date that doesn't exist", { from: "2025-02-30" }, /Dates must look like/);
  refused("29 February in a year that has none", { to: "2025-02-29" }, /Dates must look like/);
  refused("a date sent as a number", { from: 20250101 }, /Dates must look like/);
  refused("a date with a time on it", { to: "2025-12-31T00:00:00Z" }, /Dates must look like/);
  refused("a start after the end", { from: "2025-12-31", to: "2025-01-01" }, /start date is after the end date/);
  refused("more than ten years", { from: "2014-01-01", to: "2025-12-31" }, /at most 10 years/);
  refused("an end date that isn't a date, with no start date", { from: undefined, to: "next week" }, /Dates must look like/);
  refused("an end date that doesn't exist, with no start date", { from: "", to: "2026-13-45" }, /Dates must look like/);
  ok("29 February in a leap year is accepted", parseSearch({ companyIds: [1], states: ["FL"], from: "2024-02-29", to: "2024-03-01" }, TODAY).ok);
  ok("exactly ten years is accepted", parseSearch({ companyIds: [1], states: ["FL"], from: "2016-11-13", to: "2026-11-13" }, TODAY).ok);
  ok("50 companies are accepted", parseSearch({ companyIds: Array.from({ length: 50 }, (_, i) => i + 1), states: ["FL"] }, TODAY).ok);
  const t = parseSearch({ companyIds: [1], states: ["FL"], trackingNumbers: [" CALL-134000001 ", "ST 12/3.4_b"], spStatEntityIds: ["C9101"], filingStatusIds: ["1", 2], typeOfInsuranceIds: [4], filingTypeIds: [0] }, TODAY);
  ok("tracking numbers, entity ids and reference ids are accepted and tidied", t.ok && same(t.params.trackingNumbers, ["CALL-134000001", "ST 12/3.4_b"]) && same(t.params.filingStatusIds, [1, 2]) && same(t.params.filingTypeIds, [0]), t);
}

// ---------- searchKey ----------
{
  const a = await searchKey(P({ companyIds: [3, 1, 2], institutionIds: [9, 8], states: ["TX", "FL"], filingStatusIds: [2, 1], typeOfInsuranceIds: [19, 4], trackingNumbers: ["b", "a"] }));
  const b = await searchKey(P({ companyIds: [1, 2, 3], institutionIds: [8, 9], states: ["FL", "TX"], filingStatusIds: [1, 2], typeOfInsuranceIds: [4, 19], trackingNumbers: ["a", "b"] }));
  ok("the same search in a different order has the same id", a === b, [a, b]);
  ok("the id fits the saved-results table", /^search:[0-9a-f]{32}$/.test(a), a);
  const base = await searchKey(P());
  const others = await Promise.all([P({ from: "2026-01-02" }), P({ to: "2026-11-12" }), P({ states: ["GA"] }), P({ companyIds: [9100002] }), P({ companyIds: [], institutionIds: [9100001] }), P({ filingStatusIds: [2] }),
    P({ typeOfInsuranceIds: [4] }), P({ filingTypeIds: [4] }), P({ spStatEntityIds: ["C9101"] }), P({ trackingNumbers: ["C9101"] }), P({ companyIds: [9100001, 2] })].map(searchKey));
  ok("any change to the search gives a different id", new Set([base, ...others]).size === others.length + 1, others);
  ok("ids sort as numbers, so 9 and 10 can't be confused with 10 and 9", await searchKey(P({ companyIds: [9, 10] })) === await searchKey(P({ companyIds: [10, 9] })));
}

// ---------- dedupe ----------
{
  const v = "0C0C0C0C-0000-4000-8000-000000000001";
  const rows = mapRows(spPage([
    filing(1, { filingVersionId: v, companyId: 9100001, companyName: "Calloway Insurance Co", naicCompanyCode: "91001" }),
    filing(2, { filingVersionId: v, companyId: 9100002, companyName: "Calloway Home Co", naicCompanyCode: "91002", institutionId: 810002 }),
    filing(3, { filingVersionId: v, companyId: 9100001, companyName: "Calloway Insurance Co", naicCompanyCode: "91001" }),
    filing(4),
    filing(5, { filingVersionId: null, serffFilingEntityEventId: 42 }),
    filing(6, { filingVersionId: null, serffFilingEntityEventId: 42, companyId: 9100003, companyName: "Calloway Coastal Co" }),
    filing(7, { filingVersionId: null, serffFilingEntityEventId: null, trackingNumbers: "x" }),
    filing(7, { filingVersionId: null, serffFilingEntityEventId: null, trackingNumbers: "x" }),
    filing(8, { filingVersionId: null, serffFilingEntityEventId: null }),
  ]));
  const out = dedupe(rows);
  ok("rows that share a filing version become one row", out.filter((r) => r.filingVersionId === v).length === 1 && out.length === 5, out.map((r) => r.trackingNumber));
  const shared = out.find((r) => r.filingVersionId === v)!;
  ok("the one row lists every company named on that version, once each", shared.companies!.length === 2 && shared.companies!.map((c) => c.companyName).join("|") === "Calloway Insurance Co|Calloway Home Co" && shared.companies![1].naicCompanyCode === "91002", shared.companies);
  ok("the first row's own columns are kept", shared.trackingNumber === "TEST-000001" && shared.companyId === 9100001);
  ok("a filing with one company lists that company", out.find((r) => r.trackingNumber === "TEST-000004")!.companies!.length === 1);
  ok("with no version id, rows are matched on S&P's event id instead", out.filter((r) => r.serffFilingEntityEventId === 42).length === 1 && out.find((r) => r.serffFilingEntityEventId === 42)!.companies!.length === 2);
  ok("with neither id, only rows identical in every column are merged", out.filter((r) => r.trackingNumber === "TEST-000007").length === 1 && out.filter((r) => r.trackingNumber === "TEST-000008").length === 1);
  ok("no rows in, no rows out", dedupe([]).length === 0);
  ok("the input rows are not changed", !("companies" in rows[0]));
  ok("version ids 1 and \"1\" from S&P are the same version", dedupe([{ filingVersionId: 1, companyId: 1, companyName: "A" }, { filingVersionId: "1", companyId: 2, companyName: "B" }]).length === 1);
}

// ---------- searchFilings: paging ----------
{
  const many = Array.from({ length: 1037 }, (_, i) => filing(i + 1, { publishDate: ymd(ms("2026-01-01") + (i % 300) * DAY) }));
  let c = client(searchOver(many));
  let r = await searchFilings(c.api, P());
  ok("three pages are read when S&P says there are three", r.requests === 3 && r.total === 1037 && !r.capped && same(c.searches().map((s) => s.body.properties.pageNumber), [1, 2, 3]), { requests: r.requests, total: r.total });
  ok("every page asks for 500 rows", c.searches().every((s) => s.body.properties.pageSize === 500));
  ok("the search body is {properties: {...}}, an object, with S&P's required fields", c.searches().every((s) => { const b = s.body; return Object.keys(b).join() === "properties" && !Array.isArray(b.properties) && same(b.properties.companyId, [9100001]) && b.properties.minPublishDate === "2026-01-01" && b.properties.maxPublishDate === "2026-11-13" && same(b.properties.serffFilingStateId, ["FL"]) && same(b.properties.filingStatusId, [1]); }), c.searches()[0]?.body);
  ok("every search call carries docType and the bearer token", c.searches().every((s) => s.query.docType === "INSPRODFILINGS_DOCUMENTS_API" && s.auth === "Bearer stub-1" && s.method === "POST"));
  ok("results come back newest publish date first", r.rows.every((x, i) => i === 0 || String(x.publishDate) <= String(r.rows[i - 1].publishDate)));
  ok("search requests are a second apart", c.sp.log.every((x, i) => i === 0 || x.at - c.sp.log[i - 1].at >= 1000), c.sp.log.map((x) => x.at - c.sp.log[0].at));

  c = client(searchOver(many, { totalPages: false }));
  r = await searchFilings(c.api, P());
  ok("when S&P leaves out totalPages, pages are read until one comes back short", r.requests === 3 && r.total === 1037 && same(c.searches().map((s) => s.body.properties.pageNumber), [1, 2, 3]), r.requests);
  c = client(searchOver(many.slice(0, 500), { totalPages: false }));
  r = await searchFilings(c.api, P());
  ok("without totalPages, exactly one full page means one more request to be sure", r.requests === 2 && r.total === 500, r.requests);
  c = client(searchOver(many.slice(0, 499), { totalPages: false }));
  r = await searchFilings(c.api, P());
  ok("without totalPages, a short first page is the only request", r.requests === 1 && r.total === 499, r.requests);
  c = client(searchOver(many.slice(0, 500)));
  r = await searchFilings(c.api, P());
  ok("with totalPages = 1, a full page needs no second request", r.requests === 1 && r.total === 500, r.requests);
  c = client(searchOver([], { totalPages: false }));
  r = await searchFilings(c.api, P());
  ok("no rows and no totalPages is one request", r.requests === 1 && r.total === 0);
  for (const odd of [0, null, "many", -1]) {
    c = client((call) => { const page = call.body.properties.pageNumber; return J(spPage(page === 1 ? many.slice(0, 500) : many.slice(500, 520), { totalPages: odd })); });
    r = await searchFilings(c.api, P());
    ok(`a totalPages of ${JSON.stringify(odd)} is ignored and the row count decides`, r.requests === 2 && r.total === 520, { requests: r.requests, total: r.total });
  }
  c = client((call) => J(spPage(many.slice(0, 3), { totalPages: "2", currentPage: call.body.properties.pageNumber })));
  r = await searchFilings(c.api, P());
  ok("a totalPages sent as text is still honoured", r.requests === 2, r.requests);
  c = client(searchOver(many.slice(0, 7)));
  r = await searchFilings(c.api, P(), { pageSize: 3 });
  ok("a smaller page size is passed to S&P and paged the same way", r.requests === 3 && r.total === 7 && c.searches().every((s) => s.body.properties.pageSize === 3));
  // S&P keeps saying "more pages": the cap ends it
  c = client((call) => J(spPage([filing(call.body.properties.pageNumber)], { totalPages: 9999 })));
  r = await searchFilings(c.api, P(), { maxRequests: 6 });
  ok("a search that never ends stops at the request cap", r.capped === true && r.requests === 6 && c.searches().length === 6, r.requests);
}

// ---------- searchFilings: batches, windows, the cap, duplicates ----------
{
  const ids = Array.from({ length: 25 }, (_, i) => 9100001 + i);
  const rows = ids.map((id, i) => filing(i + 1, { companyId: id, companyName: `Calloway Test Co ${i + 1}`, publishDate: i % 2 ? "2025-03-01" : "2026-03-01" }));
  let c = client(searchOver(rows));
  let r = await searchFilings(c.api, P({ companyIds: ids, from: "2025-01-01", to: "2026-11-13" }));
  ok("25 companies over two windows take six requests and find every filing", r.requests === 6 && r.total === 25 && !r.capped, { requests: r.requests, total: r.total });
  ok("each company is counted with its name", r.byCompany.length === 25 && r.byCompany.every((x, i) => x.kind === "companyId" && x.id === ids[i] && x.rows === 1 && x.name === `Calloway Test Co ${i + 1}`), r.byCompany.slice(0, 3));
  ok("a complete search with results in every state has no notes", r.notes.length === 0, r.notes);

  c = client(searchOver(rows));
  r = await searchFilings(c.api, P({ companyIds: ids, from: "2025-01-01", to: "2026-11-13" }), { maxRequests: 4 });
  ok("the search stops at its request cap", r.capped === true && r.requests === 4 && c.searches().length === 4, r.requests);
  ok("a capped search says so, in plain words, and tells the user what to do", r.notes[0] === "The search stopped after 4 S&P requests to stay inside the time limit, so these results are incomplete. Narrow the dates, states or companies and search again.", r.notes);
  ok("a capped search still returns what it found", r.total > 0 && r.total < 25, r.total);
  ok("a capped search makes no claim about empty states or companies", !r.notes.some((n) => /returned no filings|returned nothing/.test(n)), r.notes);
  c = client(searchOver(rows));
  r = await searchFilings(c.api, P({ companyIds: ids, from: "2025-01-01", to: "2026-11-13" }), { maxRequests: 6 });
  ok("a search that needs exactly the cap is complete, not capped", r.capped === false && r.requests === 6 && r.total === 25 && r.notes.length === 0, r);
  c = client(searchOver(rows));
  r = await searchFilings(c.api, P({ companyIds: ids, from: "2025-01-01", to: "2026-11-13" }), { maxRequests: 0 });
  ok("a cap of zero asks S&P nothing and says the result is incomplete", r.capped && r.requests === 0 && c.sp.log.length === 0 && r.notes.length === 1, r.notes);
  ok("the default cap is 60 requests", await (async () => { const x = client((call) => J(spPage([filing(call.body.properties.pageNumber)], { totalPages: 9999 }))); const y = await searchFilings(x.api, P()); return y.capped && y.requests === 60; })());

  // the same filing version returned for two companies in different batches, and again in a second window's page
  const v = "0D0D0D0D-0000-4000-8000-000000000001";
  const pub = { publishDate: "2026-03-01" };
  const dup = [filing(1, { ...pub, filingVersionId: v, companyId: ids[0], companyName: "Calloway Insurance Co" }), filing(2, { ...pub, filingVersionId: v, companyId: ids[12], companyName: "Calloway Home Co", institutionId: 810002 }),
    filing(3, { ...pub, filingVersionId: v, companyId: ids[24], companyName: "Calloway Coastal Co", institutionId: 810003 }), filing(4, { ...pub, companyId: ids[1] })];
  c = client(searchOver(dup));
  r = await searchFilings(c.api, P({ companyIds: ids }));
  ok("a filing version found in three batches is one row", r.total === 2 && r.requests === 3, { total: r.total, requests: r.requests });
  const one = r.rows.find((x) => x.filingVersionId === v)!;
  ok("that row names all three companies", one.companies!.length === 3 && same(one.companies!.map((x) => x.companyId), [ids[0], ids[12], ids[24]]), one.companies);
  ok("each of the three companies is counted as having that filing", [ids[0], ids[12], ids[24]].every((id) => r.byCompany.find((x) => x.id === id)!.rows === 1) && r.byCompany.find((x) => x.id === ids[12])!.name === "Calloway Home Co", r.byCompany.filter((x) => x.rows));
  ok("companies with nothing are each named in a note that doesn't claim no filings exist", r.notes.filter((n) => /^S&P returned nothing for company id \d+ in this search\. Check the id; an empty result doesn't prove no filings exist\.$/.test(n)).length === 21, r.notes.length);

  // a search by institution id where two institutions made the same filing
  c = client(searchOver(dup));
  r = await searchFilings(c.api, P({ companyIds: [], institutionIds: [810001, 810002, 810003] }));
  ok("an institution search finds the shared filing once", r.total === 2 && r.rows.find((x) => x.filingVersionId === v)!.companies!.length === 3, r.total);
  ok("an institution whose only filing is shared with another institution is still counted", same(r.byCompany.map((x) => [x.id, x.rows]), [[810001, 2], [810002, 1], [810003, 1]]), r.byCompany);
  ok("no note says S&P returned nothing for an institution that S&P returned a filing for", !r.notes.some((n) => n.includes("810002") || n.includes("810003")), r.notes);

  c = client((call, n) => (n === 2 ? spError(500, "Unknown Error", "req-mid") : searchOver(rows)(call)));
  const e = await caught(searchFilings(c.api, P({ companyIds: ids })));
  ok("an S&P failure part-way through fails the search rather than passing off part of it as the answer", e instanceof SpgmiError && e.code === "server" && e.requestId === "req-mid", e?.message);
}

// ---------- searchFilings: notes for empty results ----------
{
  const rows = [filing(1), filing(2, { serffFilingStateId: "tx", serffFilingState: "Texas" })];
  let c = client(searchOver(rows));
  let r = await searchFilings(c.api, P({ states: ["FL", "GA", "TX"], companyIds: [9100001, 9200001] }), { knownStates: ["FL", "GA", "TX"] });
  ok("rows are counted by state in the order asked, whatever case S&P uses for the code", same(r.byState, [{ state: "FL", rows: 1 }, { state: "GA", rows: 0 }, { state: "TX", rows: 1 }]), r.byState);
  ok("the empty state's note says S&P returned nothing and that this doesn't prove none were filed", r.notes.includes(emptyStateNote("GA")) && emptyStateNote("GA") === "S&P returned no filings for GA in this search. That means none are in S&P's data for these companies, dates and filters. It doesn't prove that none were filed.", r.notes);
  ok("states with filings get no note", !r.notes.some((n) => /for FL|for TX|^FL |^TX /.test(n)), r.notes);
  ok("the company S&P returned nothing for is named, without claiming it has no filings", r.notes.includes("S&P returned nothing for company id 9200001 in this search. Check the id; an empty result doesn't prove no filings exist."), r.notes);
  ok("a company with no rows has no name and a count of zero", same(r.byCompany[1], { kind: "companyId", id: 9200001, name: null, rows: 0 }), r.byCompany);

  c = client(searchOver(rows));
  r = await searchFilings(c.api, P({ states: ["FL", "NY", "GA"] }), { knownStates: ["FL", "GA", "TX"] });
  const ny = r.notes.find((n) => n.startsWith("NY"));
  ok("a state missing from S&P's list of filing states gets a different note", ny === "NY isn't in S&P's list of filing states, so S&P's data may not cover it. An empty result for NY says nothing about whether filings exist." && !r.notes.includes(emptyStateNote("NY")) && r.notes.includes(emptyStateNote("GA")), r.notes);
  c = client(searchOver(rows));
  r = await searchFilings(c.api, P({ states: ["FL"] }), { knownStates: ["GA", "TX"] });
  ok("a state that returned filings is never described as an empty result, even if it is missing from S&P's state list", r.byState[0].rows === 1 && !r.notes.some((n) => /empty result for FL|may not cover it/.test(n)), r.notes);
  c = client(searchOver(rows));
  r = await searchFilings(c.api, P({ states: ["NY"] }));
  ok("when the app doesn't have S&P's state list, an empty state gets the ordinary note", same(r.notes, [emptyStateNote("NY")]), r.notes);
  c = client(searchOver(rows));
  r = await searchFilings(c.api, P({ states: ["NY"] }), { knownStates: [] });
  ok("an empty state list is treated as not having the list", same(r.notes, [emptyStateNote("NY")]), r.notes);

  c = client(searchOver([]));
  r = await searchFilings(c.api, P({ states: ["FL", "GA"], companyIds: [9100001, 9200001] }), { knownStates: ["FL", "GA"] });
  ok("a search with nothing at all gives one note for each state and no rows", r.total === 0 && same(r.notes, [emptyStateNote("FL"), emptyStateNote("GA")]) && r.byCompany.every((x) => x.rows === 0), r.notes);
  const all = [...r.notes, emptyStateNote("ZZ"), NO_MATCH("x"), "S&P returned nothing for company id 1 in this search. Check the id; an empty result doesn't prove no filings exist."];
  ok("no note ever states flatly that no filings exist", all.every((n) => !/no filings exist|none (were|was) filed|has no filings|have no filings/i.test(n.replace(/doesn't prove (that )?(none were filed|no filings exist)/g, "").replace(/says nothing about whether filings exist/g, ""))), all);
  ok("every empty-result note carries its caveat", all.filter((n) => /returned no|returned nothing/.test(n)).every((n) => /doesn't prove/.test(n)));
}

// ---------- savedOrFreshSearch ----------
{
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock), saved = watchStore(db);
  const api = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: sp.fetch, gate: makeGate(db, PLAN_LIMITS.trial, clock.sleep), sleep: clock.sleep });
  const params = P({ companyIds: [9100001, 9100002, 9100003, 9200001], states: ["FL", "NY"], filingStatusIds: [], from: "2024-01-01", to: "2026-11-13" });
  const t0 = clock.now;
  const a = await savedOrFreshSearch(api, db, params, { now: t0 });
  const bodies = sp.calls("/api/v1/search").map((x) => x.body.properties);
  ok("with no status chosen, every status in S&P's list is sent", bodies.length === 3 && bodies.every((b) => same(b.filingStatusId, [1, 2, 3])), bodies.map((b) => b.filingStatusId));
  ok("the answer says all statuses were searched", a.params.allStatuses === true && same(a.params.filingStatusIds, [1, 2, 3]), a.params);
  ok("the status list and the state list were each fetched once from S&P", same(sp.calls("/api/v1/reference").map((x) => x.query.referenceField), ["filingStatus", "serffFilingState"]));
  ok("pending and approved filings both come back", a.total === 6 && a.rows.some((x) => x.filingStatus === "Pending") && a.rows.some((x) => x.filingStatus === "Closed - Approved"), a.total);
  ok("a state that isn't in S&P's list is flagged from the fetched list", a.notes.some((n) => n.startsWith("NY isn't in S&P's list of filing states")), a.notes);
  ok("the answer names its source, when it was fetched, and that it is fresh", a.source === SOURCE && SOURCE === "S&P Global Market Intelligence, SNL Insurance Product Filings" && a.fetchedAt === new Date(t0).toISOString() && a.fromStore === false && a.saved === true);
  ok("everything saved would pass the database's checks on saved rows", saved.length === 3 && saved.every((x) => x.problem === null), saved.filter((x) => x.problem));
  ok("the saved search is labelled with its states and dates", [...db.store.values()].find((x) => x.kind === "search")!.label === "FL,NY 2024-01-01 to 2026-11-13");

  const calls = sp.log.length;
  const b = await savedOrFreshSearch(api, db, { ...params, companyIds: [9200001, 9100003, 9100002, 9100001], states: ["NY", "FL"] }, { now: clock.now + 5000 });
  ok("the same search, in another order, opens from the saved result without asking S&P", b.fromStore === true && b.saved === true && b.total === 6 && sp.log.length === calls, { calls: sp.log.length - calls });
  const explicit = await savedOrFreshSearch(api, db, { ...params, filingStatusIds: [1, 2, 3] }, { now: clock.now });
  ok("choosing every status by hand is a separate search from choosing none", explicit.fromStore === false && explicit.params.allStatuses === false && explicit.total === 6);
  const calls2 = sp.log.length;
  const fresh = await savedOrFreshSearch(api, db, params, { now: clock.now, refresh: true });
  ok("refresh asks S&P again", fresh.fromStore === false && sp.calls("/api/v1/search").length > 0 && sp.log.length === calls2 + 3, sp.log.length - calls2);

  // not set up: saved results still open
  const offline = await savedOrFreshSearch(null, db, params, { now: clock.now });
  ok("with S&P not set up, a saved search still opens", offline.fromStore === true && offline.total === 6);
  const e = await caught(savedOrFreshSearch(null, db, P({ companyIds: [9100001], states: ["TX"] }), { now: clock.now }));
  ok("with S&P not set up, a search that isn't saved says S&P isn't set up", e instanceof SpgmiError && e.code === "not_configured", e?.message);
  const e2 = await caught(savedOrFreshSearch(null, db, params, { now: clock.now, refresh: true }));
  ok("with S&P not set up, refresh says S&P isn't set up rather than showing stale rows as fresh", e2 instanceof SpgmiError && e2.code === "not_configured", e2?.message);

  // capped
  const before = db.store.size;
  const wide = P({ companyIds: [9100001], states: ["FL"], filingStatusIds: [1], from: "2017-01-01", to: "2026-11-13" });
  const callsBeforeWide = sp.calls("/api/v1/search").length;
  const tooWideErr = await caught(savedOrFreshSearch(api, db, wide, { now: clock.now, maxRequests: 4 }));
  ok("a search that needs more requests than one search may use is refused before any is spent", tooWideErr instanceof SpgmiError && tooWideErr.code === "bad_request" && /needs at least 10 S&P requests/.test(tooWideErr.message) && /more than the 4 one search may use/.test(tooWideErr.message) && sp.calls("/api/v1/search").length === callsBeforeWide, tooWideErr?.message);
  // S&P answering slowly: each request takes a second of the fake clock, and the search must stop after about three
  const capped = await savedOrFreshSearch(api, db, wide, { now: clock.now, maxRequests: 40, deadline: clock.now + 3500, clock: clock.fn });
  ok("a search cut short for time is returned but not saved, and says S&P was slow", capped.capped === true && capped.saved === false && capped.fromStore === false && capped.requests >= 2 && capped.requests < 10 && capped.notes[0].startsWith("S&P was answering slowly, so the search stopped after") && capped.notes[0].includes("These results are incomplete") && [...db.store.values()].filter((x) => x.kind === "search").length === 2, { saved: capped.saved, requests: capped.requests, notes: capped.notes, store: db.store.size - before });
  const calls3 = sp.calls("/api/v1/search").length;
  const retry = await savedOrFreshSearch(api, db, wide, { now: clock.now, maxRequests: 40 });
  ok("the next try of a capped search asks S&P again and, when complete, is saved", retry.fromStore === false && retry.capped === false && retry.saved === true && sp.calls("/api/v1/search").length === calls3 + 10, sp.calls("/api/v1/search").length - calls3);

  // the store refuses the row (too big, say)
  const put = db.putStore.bind(db);
  db.putStore = async (row) => (row.kind === "search" ? false : put(row));
  const unsaved = await savedOrFreshSearch(api, db, P({ companyIds: [9200001], states: ["FL"], from: "2024-01-01", to: "2026-11-13" }), { now: clock.now });
  ok("a result the database won't take is still returned, marked as not saved", unsaved.saved === false && unsaved.fromStore === false && unsaved.total === 1, { saved: unsaved.saved, total: unsaved.total });
  db.putStore = put;
}
{
  // S&P's status list comes back empty
  const c = client((call) => (call.path === "/api/v1/reference" ? J({ headers: ["filingStatusId", "filingStatus"], rows: [] }) : J(spPage([filing(1)]))));
  const e = await caught(savedOrFreshSearch(c.api, c.db, P({ filingStatusIds: [] }), { now: c.clock.now }));
  ok("an empty status list from S&P stops the search with a plain reason, since S&P needs a status", e instanceof SpgmiError && e.message.includes("list of filing statuses came back empty") && c.searches().length === 0, e?.message);
  // S&P's state ids aren't two-letter codes
  const c2 = client((call) => (call.path === "/api/v1/reference" ? J({ headers: ["serffFilingStateId", "serffFilingState"], rows: [{ row: [12, "Florida"] }] }) : J(spPage([]))));
  const r = await savedOrFreshSearch(c2.api, c2.db, P({ states: ["FL"] }), { now: c2.clock.now });
  ok("if S&P's state list isn't two-letter codes, no state is wrongly flagged as missing from it", same(r.notes, [emptyStateNote("FL")]), r.notes);
}

// ---------- reference lists ----------
{
  const opt = (headers: string[], rows: unknown[][]) => referenceOptions(headers, mapRows({ headers, rows: rows.map((row) => ({ row })) }));
  ok("the id is the column ending in Id and the name is the other column", same(opt(["typeOfInsuranceId", "typeOfInsurance"], [[4, "Homeowners"], [19, "Personal auto"]]), [{ id: 4, name: "Homeowners" }, { id: 19, name: "Personal auto" }]));
  ok("column order doesn't matter", same(opt(["typeOfInsurance", "typeOfInsuranceId"], [["Homeowners", 4]]), [{ id: 4, name: "Homeowners" }]));
  ok("an id of 0 is a real id", same(opt(["serffFilingTypeId", "serffFilingType"], [[0, "Form"], [1, "Rate"]]), [{ id: 0, name: "Form" }, { id: 1, name: "Rate" }]));
  ok("text ids such as state codes are kept as text", same(opt(["serffFilingStateId", "serffFilingState"], [["FL", "Florida"]]), [{ id: "FL", name: "Florida" }]));
  ok("with no Id column, a Code column is the id", same(opt(["stateCode", "stateName"], [["FL", "Florida"]]), [{ id: "FL", name: "Florida" }]));
  ok("with neither, the first column is the id", same(opt(["key", "label"], [["a", "Alpha"]]), [{ id: "a", name: "Alpha" }]));
  ok("a name, description or value column is preferred for the name", same(opt(["filingStatusId", "sortOrder", "filingStatusName"], [[1, 10, "Pending"]]), [{ id: 1, name: "Pending" }]));
  ok("a one-column list uses the id as the name", same(opt(["filingStatusId"], [[1]]), [{ id: 1, name: "1" }]));
  ok("repeated ids and rows with no id are dropped", same(opt(["filingStatusId", "filingStatus"], [[1, "A"], [1, "B"], [null, "C"], ["", "D"], [2, "E"]]), [{ id: 1, name: "A" }, { id: 2, name: "E" }]));
  ok("a missing name falls back to the id", same(opt(["filingStatusId", "filingStatus"], [[3, null]]), [{ id: 3, name: "3" }]));
  ok("no headers, no options", referenceOptions([], [{ a: 1 }]).length === 0);

  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock);
  const api = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: sp.fetch, gate: makeGate(db, PLAN_LIMITS.trial, clock.sleep), sleep: clock.sleep });
  const refCalls = () => sp.calls("/api/v1/reference").length;
  ok("with nothing saved and S&P not set up there is no list", (await getReference(null, db, "filingStatus", { now: clock.now })) === null);
  const first = await getReference(api, db, "filingStatus", { now: clock.now });
  ok("a list is fetched with GET /api/v1/reference?referenceField=...", refCalls() === 1 && sp.calls("/api/v1/reference")[0].method === "GET" && sp.calls("/api/v1/reference")[0].query.referenceField === "filingStatus" && sp.calls("/api/v1/reference")[0].query.docType === "INSPRODFILINGS_DOCUMENTS_API");
  ok("the list comes back with its options, raw rows and headers", first!.fromStore === false && same(first!.options, [{ id: 1, name: "Closed - Approved" }, { id: 2, name: "Pending" }, { id: 3, name: "Withdrawn" }]) && same(first!.headers, ["filingStatusId", "filingStatus"]) && first!.rows.length === 3 && first!.field === "filingStatus", first);
  ok("the list is saved under ref:<field>", db.store.get("ref:filingStatus")?.kind === "reference");
  const second = await getReference(api, db, "filingStatus", { now: clock.now + 29 * 86_400_000 });
  ok("a saved list under 30 days old is used without asking S&P", second!.fromStore === true && refCalls() === 1 && same(second!.options, first!.options) && second!.fetchedAt === db.store.get("ref:filingStatus")!.fetched_at);
  const saved0 = Date.parse(db.store.get("ref:filingStatus")!.fetched_at);
  await getReference(api, db, "filingStatus", { now: saved0 + 30 * 86_400_000 - 1 });
  ok("one millisecond short of 30 days the saved list is still used", refCalls() === 1);
  const third = await getReference(api, db, "filingStatus", { now: saved0 + 30 * 86_400_000 });
  ok("at 30 days the list is fetched again", third!.fromStore === false && refCalls() === 2, refCalls());
  const forced = await getReference(api, db, "filingStatus", { now: clock.now, refresh: true });
  ok("refresh fetches the list again even when it is fresh", forced!.fromStore === false && refCalls() === 3);
  const old = await getReference(null, db, "filingStatus", { now: clock.now + 400 * 86_400_000, refresh: true });
  ok("with S&P not set up, even an old saved list still opens", old!.fromStore === true && old!.options.length === 3 && refCalls() === 3);
  sp.failNext.push({ status: 403 });
  const e = await caught(getReference(api, db, "typeOfInsurance", { now: clock.now }));
  ok("a list S&P refuses fails with S&P's plain message and saves nothing", e instanceof SpgmiError && e.code === "entitlement" && !db.store.has("ref:typeOfInsurance"), e?.message);
}

// ---------- companies remembered, and resolve ----------
{
  const fixture = read("spgmi_search.json");
  const rows = dedupe(mapRows({ headers: fixture.headers, rows: fixture.rows.map((row: unknown[]) => ({ row })) }));
  const ents = entitiesFrom(rows);
  ok("each company in the results is remembered once", ents.length === 4 && same(ents.map((x) => x.companyId).sort(), ["9100001", "9100002", "9100003", "9200001"]), ents.map((x) => x.companyName));
  const first = ents.find((x) => x.companyId === "9100001")!;
  ok("a company is remembered with its name, NAIC code, institution id, statutory id and group", same(first, { companyId: "9100001", companyName: "Calloway Insurance Co", naicCompanyCode: "91001", institutionId: "810001", spStatEntityId: "C9101", naicGroupCode: "9100", naicGroupName: "Calloway Financial Grp" }), first);
  ok("a company with no group is remembered with no group", ents.find((x) => x.companyId === "9200001")!.naicGroupName === null);
  const co = ents.find((x) => x.companyId === "9100002")!;
  ok("a company seen only as a co-filer on a shared filing keeps its own institution id", co.companyName === "Calloway Home Co" && co.naicCompanyCode === "91002" && co.institutionId === "810002", co);
  ok("a co-filer keeps its own statutory entity id as well", co.spStatEntityId === "C9102", co);
  ok("rows with no company id or name are skipped", entitiesFrom([{ companyId: null, companyName: "X" }, { companyId: 5, companyName: null }, { companyId: 6, companyName: "" }]).length === 0);
  ok("rows that were never de-duplicated still give their company", same(entitiesFrom([{ companyId: 7, companyName: "Tarrow Mutual Insurance Co", naicCompanyCode: "92001" }]).map((x) => x.companyId), ["7"]));

  const clock = fakeClock(), db = memoryDb(clock);
  await db.putEntities(ents);
  const none = await resolveEntity(db, "Nonesuch Mutual");
  ok("no match gives no companies and a note that explains why", none.matches.length === 0 && none.note === NO_MATCH("Nonesuch Mutual") && none.note!.includes("S&P's filings API has no company search") && none.note!.includes("only knows companies loaded from a company list or seen in earlier results") && none.note!.includes("S&P company id or institution id"), none.note);
  ok("the no-match note doesn't say the company doesn't exist or has no filings", !/doesn't exist|no filings/i.test(none.note!));
  const byName = await resolveEntity(db, "  calloway ");
  ok("part of a name finds every match, whatever its case", byName.matches.length === 3 && byName.note === null && byName.query === "calloway", byName.matches.map((x) => x.companyName));
  ok("a NAIC code finds its company", (await resolveEntity(db, "92001")).matches[0]?.companyName === "Tarrow Mutual Insurance Co");
  ok("an S&P company id finds its company", (await resolveEntity(db, "9100003")).matches[0]?.companyName === "Calloway Coastal Co");
  ok("an S&P institution id finds its company", (await resolveEntity(db, "810001")).matches[0]?.companyName === "Calloway Insurance Co");
  ok("the institution id of a company seen only as a co-filer finds it too", (await resolveEntity(db, "810002")).matches[0]?.companyName === "Calloway Home Co", (await resolveEntity(db, "810002")).matches);
  ok("a single letter is too little to search on", (await resolveEntity(db, "c")).matches.length === 0 && (await resolveEntity(db, "c")).note !== null);
  ok("an over-long query is cut to 100 characters", (await resolveEntity(db, "x".repeat(500))).query.length === 100);
  let asked = 0;
  const counting = { ...db, findEntities: async (q: string, n: number) => { asked++; return db.findEntities(q, n); } };
  await resolveEntity(counting, "calloway", 2);
  ok("resolve reads only the app's own saved companies", asked === 1);
  ok("the number of matches can be limited", (await resolveEntity(db, "calloway", 2)).matches.length === 2);
}

// ---------- documents ----------
{
  ok("a document id may be a number or digits as text", same(parseDocRef({ documentId: 70000001 }), { documentId: 70000001 }) && same(parseDocRef({ documentId: "70000001" }), { documentId: 70000001 }));
  ok("a filing version id is accepted when there is no document id", same(parseDocRef({ filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" }), { filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" }));
  ok("the document id wins when both are sent", same(parseDocRef({ documentId: 5, filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" }), { documentId: 5 }));
  ok("a null document id falls back to the version id", same(parseDocRef({ documentId: null, filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" }), { filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" }));
  for (const [name, b] of [["nothing", {}], ["zero", { documentId: 0 }], ["a negative id", { documentId: -4 }], ["a fraction", { documentId: 1.5 }], ["letters", { documentId: "70a" }], ["a path", { documentId: "../1" }], ["a list", { documentId: [1] }],
    ["a short version id", { filingVersionId: "abc" }], ["a version id with a slash", { filingVersionId: "0A0A0A0A/../../etc" }], ["a version id with a space", { filingVersionId: "0A0A0A0A 0000" }], ["a version id that is a number", { filingVersionId: 12345678 }], ["a version id of 65 characters", { filingVersionId: "a".repeat(65) }]] as const)
    ok(`${name} is not a document reference`, parseDocRef(b as Record<string, unknown>) === null, parseDocRef(b as Record<string, unknown>));

  const c = client((call) => (call.path === "/api/v1/download" ? new Response(new Uint8Array([37, 80, 68, 70, 45]), { status: 200, headers: { "content-type": "application/pdf" } }) : spError(404, "no")));
  const res = await downloadDocument(c.api, { documentId: 70000001 });
  const d1 = c.sp.calls("/api/v1/download")[0];
  ok("a download by document id is POST /api/v1/download with {properties: {documentId}}", d1.method === "POST" && same(d1.body, { properties: { documentId: 70000001 } }) && d1.query.docType === "INSPRODFILINGS_DOCUMENTS_API" && res.status === 200, d1);
  await (await downloadDocument(c.api, { filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" })).arrayBuffer();
  ok("a download by version id sends {properties: {filingVersionId}}", same(c.sp.calls("/api/v1/download")[1].body, { properties: { filingVersionId: "0A0A0A0A-0000-4000-8000-000000000006" } }));
  ok("each download is one S&P request", c.sp.calls("/api/v1/download").length === 2 && c.sp.data === 2);
}

done();
