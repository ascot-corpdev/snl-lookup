// Whole insurer groups in one search: a 69-company group searched end to end against the fake S&P (requests
// counted), the refusal at the request cap and what it tells the user to change, the company finder's whole-group
// choices, Claude's search_filings taking tracking numbers, and searches kept out of the Recent searches list.
// Made-up companies, ids and fake services throughout; nothing real is called.
(globalThis as any).__SNL_TEST__ = true;
const filings = await import(new URL("../../supabase/functions/snl-filings/index.ts", import.meta.url).href);
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { SYSTEM, TOOLS, LIMITS } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
const F = await import(new URL("../../supabase/functions/_shared/filings.ts", import.meta.url).href);
const { entityLabel } = await import(new URL("../../supabase/functions/_shared/db.ts", import.meta.url).href);
const { forgetTokens, SpgmiError } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
import type { Entity } from "../../supabase/functions/_shared/db.ts";
import { checks, corpdev, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, type MemoryDb, type Reply, req, say, toolResults, toolUse } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" };
const BIG = "Nonesuch Big Group (SNL P&C Group)";

/** A company as the owner's list has it: an institution id and a group name; a NAIC group code when given. */
function listRow(db: MemoryDb, name: string, ids: { institutionId?: number | null; companyId?: number | null; naic?: string | null }, group: string | null, groupCode: string | null = null) {
  const e: Entity = { companyId: ids.companyId ? String(ids.companyId) : null, companyName: name, naicCompanyCode: ids.naic ?? null, institutionId: ids.institutionId ? String(ids.institutionId) : null, spStatEntityId: null, naicGroupCode: groupCode, naicGroupName: group };
  const key = e.companyId ? String(e.companyId) : e.institutionId ? `i.${e.institutionId}` : `n.${e.naicCompanyCode}`;
  db.store.set(`entity:${key}`, { id: `entity:${key}`, kind: "entity", label: entityLabel(e), doc: e as unknown as Record<string, unknown>, fetched_at: "2026-11-01T00:00:00.000Z" });
}
/** 69 companies in one group: the three the fake S&P has filings for (institution ids 810001 to 810003), and 66 more. */
const BIG_IDS = [810001, 810002, 810003, ...Array.from({ length: 66 }, (_, i) => 700100 + i)];
function bigGroup(db: MemoryDb) {
  BIG_IDS.forEach((id, i) => listRow(db, `Nonesuch Big Member ${String(i).padStart(2, "0")} Co`, { institutionId: id }, BIG));
}
function world() {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock);
  const deps = { env: env(SECRETS), fetch: sp.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown) => { const res: Response = await filings.handle(req("snl-filings", body), deps); return { status: res.status, body: await res.json() }; };
  return { clock, db, sp, call };
}
const P = (over: Record<string, unknown> = {}) => ({ companyIds: [], institutionIds: BIG_IDS, states: ["FL"], filingStatusIds: [1], typeOfInsuranceIds: [], filingTypeIds: [], spStatEntityIds: [], trackingNumbers: [], from: "2025-11-14", to: "2026-11-13", ...over });

// ---------- the arithmetic: what a 69-company group costs ----------
{
  ok("one search takes a whole group: up to 100 companies, more than the largest group (69)", F.MAX_IDS === 100 && F.MAX_IDS >= BIG_IDS.length && F.MAX_SEARCH_REQUESTS === 60);
  const cost = (from: string) => F.planSearch(P({ from }) as any).length;
  ok("69 companies over 12 months: 7 S&P requests (7 batches of 10, one window of 365 days)", cost("2025-11-14") === 7, cost("2025-11-14"));
  ok("over the last 3 years (4 windows of 365 days): 28", cost("2023-11-13") === 28, cost("2023-11-13"));
  ok("over the last 5 years (6 windows): 42", cost("2021-11-13") === 42, cost("2021-11-13"));
  ok("over the last 10 years (11 windows): 77, more than the 60 one search may use", cost("2016-11-13") === 77, cost("2016-11-13"));
  ok("a search of 69 and of 100 companies is accepted; 101 is refused with what to do", F.parseSearch({ institutionIds: BIG_IDS, states: ["FL"] }, "2026-11-13").ok
    && F.parseSearch({ companyIds: Array.from({ length: 100 }, (_, i) => i + 1), states: ["FL"] }, "2026-11-13").ok
    && (F.parseSearch({ companyIds: Array.from({ length: 101 }, (_, i) => i + 1), states: ["FL"] }, "2026-11-13") as any).message === "Search at most 100 companies at a time. Remove some companies, or split them into two searches.");
  const advice = F.widthAdvice(P({ from: "2016-11-13" }) as any, 60);
  ok("the advice says how many years these companies can cover and how many companies these dates can take", advice === "With these 69 companies, one search can cover up to 2,920 days of dates, a little under 8 years; over these dates, one search can take up to 50 companies.", advice);
  ok("Claude's tighter limit of 40 a search: 5 years of a 69-company group is refused, 3 years fits", LIMITS.searchRequests === 40 && cost("2021-11-13") > LIMITS.searchRequests && cost("2023-11-13") <= LIMITS.searchRequests);
  const tight = F.widthAdvice(P({ from: "2016-11-13" }) as any, 4), single = F.widthAdvice(P({ institutionIds: [1], from: "2016-11-13" }) as any, 4);
  ok("when even one year is too much for these companies, it says to choose fewer", tight === "Choose fewer companies: these dates are too long for even 10 companies.", tight);
  ok("one company reads naturally", single === "With this company, one search can cover up to 1,460 days of dates, a little under 4 years; these dates are too long for even 10 companies.", single);
  ok("the old wording is kept, so existing messages still read the same", F.tooWide(77, 60) === "This search needs at least 77 S&P requests (one for each batch of 10 companies and each year of dates), more than the 60 one search may use. Choose fewer companies or a shorter date range.");
}

// ---------- a 69-company group end to end, through the snl-filings function ----------
{
  const w = world();
  bigGroup(w.db);
  listRow(w.db, "Calloway Insurance Co", { institutionId: 810901 }, "Calloway Group (SNL P&C Group)");
  const found = await w.call({ action: "resolve", q: "Nonesuch Big" });
  const g = found.body.groups?.[0];
  ok("typing the group's name offers the whole group, with every member", found.status === 200 && found.body.groups.length === 1 && g.name === BIG && g.code === null && g.companies === 69 && g.searchable === 69 && g.members.length === 69 && g.tooBig === false, found.body.groups);
  ok("and what one year of dates costs for it: 7 S&P requests", g.requestsPerYear === 7);
  ok("each member carries the id a search takes", g.members.every((m: any) => m.companyId === null && /^\d+$/.test(m.institutionId)) && same(g.members.map((m: any) => Number(m.institutionId)).sort(), [...BIG_IDS].sort()));
  ok("looking up a group never asks S&P", w.sp.log.length === 0);

  const before = () => w.sp.calls("/api/v1/search").length;
  let n = before();
  const one = await w.call({ action: "search", institutionIds: g.members.map((m: any) => Number(m.institutionId)), states: ["FL"], from: "2025-01-01", to: "2025-12-31", filingStatusIds: [1] });
  const year = w.sp.calls("/api/v1/search").slice(n);
  ok("the whole group searches in one go: 7 S&P requests for one year, each of at most 10 ids", one.status === 200 && year.length === 7 && one.body.requests === 7 && year.every((c) => c.body.properties.institutionId.length <= 10) && same(year.flatMap((c) => c.body.properties.institutionId).sort(), [...BIG_IDS].sort()), { status: one.status, n: year.length, msg: one.body.message });
  ok("the filings of the members that have them come back, and every member is counted", one.body.total > 0 && one.body.byCompany.length === 69 && one.body.capped === false && one.body.saved === true, one.body.total);
  n = before();
  const three = await w.call({ action: "search", institutionIds: BIG_IDS, states: ["FL"], from: "2023-11-13", to: "2026-11-13", filingStatusIds: [1] });
  ok("the last 3 years: 28 S&P requests", three.status === 200 && before() - n === 28 && three.body.requests === 28, before() - n);
  n = before();
  const five = await w.call({ action: "search", institutionIds: BIG_IDS, states: ["FL"], from: "2021-11-13", to: "2026-11-13", filingStatusIds: [1] });
  ok("the last 5 years: 42 S&P requests", five.status === 200 && before() - n === 42 && five.body.requests === 42, before() - n);
  n = before();
  const again = await w.call({ action: "search", institutionIds: [...BIG_IDS].reverse(), states: ["FL"], from: "2021-11-13", to: "2026-11-13", filingStatusIds: [1] });
  ok("the same group search again opens from the saved result and costs nothing", again.body.fromStore === true && before() === n);
  const calls = w.sp.log.length;
  const ten = await w.call({ action: "search", institutionIds: BIG_IDS, states: ["FL"], from: "2016-11-13", to: "2026-11-13", filingStatusIds: [1] });
  ok("the last 10 years is refused before any S&P request is spent", ten.status === 400 && w.sp.log.length === calls, ten.status);
  ok("the refusal says what it needs, the limit, and what to change in plain words", ten.body.message === "This search needs at least 77 S&P requests (one for each batch of 10 companies and each year of dates), more than the 60 one search may use. Choose fewer companies or a shorter date range. With these 69 companies, one search can cover up to 2,920 days of dates, a little under 8 years; over these dates, one search can take up to 50 companies.", ten.body.message);
  const eight = await w.call({ action: "search", institutionIds: BIG_IDS, states: ["FL"], from: "2018-11-23", to: "2026-11-13", filingStatusIds: [1] });
  ok("following the advice works: 2,920 days of dates for the 69 companies runs (56 S&P requests)", eight.status === 200 && eight.body.requests === 56, { status: eight.status, r: eight.body.requests, m: eight.body.message });
  const over = await w.call({ action: "search", companyIds: Array.from({ length: 101 }, (_, i) => 9300001 + i), states: ["FL"] });
  ok("101 companies is refused by the function with what to do", over.status === 400 && over.body.message === "Search at most 100 companies at a time. Remove some companies, or split them into two searches.", over.body);
}

// ---------- the company finder's whole groups ----------
{
  const clock = fakeClock(), db = memoryDb(clock);
  // A list with NAIC group codes and names, a name-only list, and a group too big for one search.
  listRow(db, "Calloway Insurance Co", { companyId: 4000001, naic: "90001" }, "Calloway Group", "9001");
  listRow(db, "Calloway Home Co", { institutionId: 5000002, naic: "90002" }, "Calloway Group", "9001");
  listRow(db, "Calloway Statutory Only Co", { naic: "90009" }, "Calloway Group", "9001");
  listRow(db, "Calloway Coastal Co", { institutionId: 5000003 }, "calloway coastal group");
  listRow(db, "Calloway Coastal Two Co", { institutionId: 5000004 }, "Calloway Coastal Group");
  for (let i = 0; i < 130; i++) listRow(db, `Nonesuch Giant Member ${String(i).padStart(3, "0")} Co`, { institutionId: 700000 + i }, "Nonesuch Giant Group");
  listRow(db, "Nonesuch Paper Co", { naic: "90777" }, "Nonesuch Paper Group");

  const r = await F.groupChoices(db, "Calloway");
  const coded = r.groups.find((g: any) => g.code === "9001"), named = r.groups.find((g: any) => g.code === null);
  ok("a list with NAIC group codes: the group is matched by its code, and named", !!coded && coded.name === "Calloway Group" && coded.companies === 3 && coded.searchable === 2, r.groups);
  ok("a member with only a NAIC code is counted but can't be added", coded.members.length === 2 && same(coded.members.map((m: any) => [m.companyId, m.institutionId]).sort(), [["4000001", null], [null, "5000002"]].sort()), coded.members);
  ok("company ids and institution ids are costed apart: one request each for a year", coded.requestsPerYear === 2);
  ok("a name-only list: the group is matched by name, whatever the letter case", !!named && named.companies === 2 && named.members.length === 2 && r.groups.length === 2, r.groups.map((g: any) => g.name));
  ok("the group's NAIC code finds it too", (await F.groupChoices(db, "9001")).groups[0]?.name === "Calloway Group");
  const giant = (await F.groupChoices(db, "Nonesuch Giant")).groups[0];
  ok("a group too big for one search is offered, marked too big, with the first 100 members", giant.companies === 130 && giant.searchable === 130 && giant.tooBig === true && giant.members.length === 100 && giant.members[0].companyName === "Nonesuch Giant Member 000 Co" && giant.requestsPerYear === 13, { c: giant.companies, m: giant.members.length, r: giant.requestsPerYear });
  ok("a group with no company that has an S&P id isn't offered", (await F.groupChoices(db, "Nonesuch Paper")).groups.length === 0);
  ok("two letters or less, or nothing, asks nothing", (await F.groupChoices(db, "Ca")).groups.length === 0 && (await F.groupChoices(db, "  ")).groups.length === 0);
  for (let i = 0; i < 7; i++) listRow(db, `Tarrow Unit ${i} Co`, { institutionId: 600000 + i }, `Tarrow Holdings ${i} Group`);
  const many = await F.groupChoices(db, "Tarrow Holdings");
  ok(`at most ${F.MAX_GROUP_CHOICES} groups are offered, and a note says how many more match`, many.groups.length === F.MAX_GROUP_CHOICES && many.groupNote === '2 more groups match "Tarrow Holdings". Type more of the group\'s name to see them.', many.groupNote);
  for (let i = 0; i < F.GROUP_SCAN; i++) listRow(db, `Nonesuch Filler ${i} Co`, { institutionId: 800000 + i }, `Nonesuch Filler Group ${i % 40}`);
  const loose = await F.groupChoices(db, "Nonesuch");
  ok("a name that matches too many companies offers no group and says to type more", loose.groups.length === 0 && loose.groupNote === `More than ${F.GROUP_SCAN} companies are in groups whose name matches "Nonesuch", so no whole group is offered. Type more of the group's name.`, loose.groupNote);

  // hostile group names and look-ups
  listRow(db, "Calloway Odd Co", { institutionId: 5000099 }, `Calloway "Odd" <script>window.__x=1</script> Group'; drop table x; --`);
  const odd = (await F.groupChoices(db, "Calloway")).groups.find((g: any) => /Odd/.test(g.name));
  ok("a group name with markup and SQL comes back as plain data, to be shown as text", odd?.name === `Calloway "Odd" <script>window.__x=1</script> Group'; drop table x; --` && odd.members.length === 1, odd);
  const sneaky = await F.groupChoices(db, "x%' or 1=1 --,doc->>companyId.eq.1)");
  ok("a look-up with SQL or filter text in it matches nothing", sneaky.groups.length === 0 && sneaky.groupNote === null, sneaky);
  const control = await F.groupChoices(db, "Calloway\u0000\u001f Group");
  ok("control characters are taken out of a look-up", control.groups.some((g: any) => g.name === "Calloway Group"), control.groups.map((g: any) => g.name));
}

// ---------- keeping a search out of Recent searches ----------
{
  const listed = (w: ReturnType<typeof world>) => [...w.db.store.values()].filter((r) => r.kind === "search" && !(r.doc as any).unlisted).map((r) => r.id);
  const searchRows = (w: ReturnType<typeof world>) => [...w.db.store.values()].filter((r) => r.kind === "search");
  const S = { action: "search", companyIds: [9100001], states: ["FL"], from: "2025-01-01", to: "2025-12-31", filingStatusIds: [1] };

  // An unlisted search first, the same search listed afterwards.
  const a = world();
  const p1 = await a.call({ ...S, unlisted: true });
  const id = await F.searchKey(P({ companyIds: [9100001], institutionIds: [], from: "2025-01-01", to: "2025-12-31" }) as any);
  ok("an unlisted search is saved, under the same id as the same search listed", p1.status === 200 && p1.body.unlisted === true && p1.body.saved === true && searchRows(a).length === 1 && searchRows(a)[0].id === id, searchRows(a).map((r) => r.id));
  ok("the saved result is marked, so the Recent searches list leaves it out", (searchRows(a)[0].doc as any).unlisted === true && listed(a).length === 0);
  const sp1 = a.sp.log.length;
  const p2 = await a.call(S);
  ok("then the same search without the tick opens the saved result at no cost, and it stays out of the list", p2.body.fromStore === true && a.sp.log.length === sp1 && p2.body.unlisted === true && listed(a).length === 0);
  const p3 = await a.call({ ...S, refresh: true });
  ok("a Refresh without the tick asks S&P again and saves it listed, under the new fetch", p3.body.fromStore === false && !("unlisted" in p3.body) && listed(a).length === 1 && searchRows(a).length === 1, p3.body.unlisted);

  // A listed search first, the same search unlisted afterwards.
  const b = world();
  await b.call(S);
  ok("a search without the tick is listed", listed(b).length === 1);
  const sp2 = b.sp.log.length;
  const q2 = await b.call({ ...S, unlisted: true });
  ok("the same search with the tick opens the saved result; it was already listed, and stays as it was", q2.body.fromStore === true && b.sp.log.length === sp2 && !q2.body.unlisted && listed(b).length === 1);
  const q3 = await b.call({ ...S, unlisted: true, refresh: true });
  ok("a Refresh with the tick saves the new result out of the list", q3.body.fromStore === false && q3.body.unlisted === true && listed(b).length === 0 && searchRows(b).length === 1);
  const q4 = await b.call({ ...S, unlisted: "yes", refresh: true });
  ok("only true keeps a search out; anything else is an ordinary search", !q4.body.unlisted && listed(b).length === 1);
}

// ---------- Claude: search_filings takes tracking numbers ----------
{
  const t = TOOLS.find((x: any) => x.name === "search_filings") as any;
  const tn = t.input_schema.properties.tracking_numbers;
  ok("search_filings offers tracking_numbers: a required list of text, strict", t.strict === true && t.input_schema.required.includes("tracking_numbers") && tn.type === "array" && tn.items.type === "string" && t.input_schema.additionalProperties === false);
  ok("described in plain words: finds a known filing again, still needs the company and state", /find again/.test(tn.description) && /company and state/.test(tn.description), tn.description);
  ok("one sentence in the instructions mentions it", SYSTEM.includes("To find a filing you already know again, put its tracking number in tracking_numbers, with its company and state."));

  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock);
  const seen: Record<string, any> = {};
  const NO_TABLE: Reply = { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] };
  const base = { company_ids: [9100001], institution_ids: [], states: ["FL"], from: "2025-01-01", to: "2025-12-31", type_of_insurance_ids: [], filing_type_ids: [], filing_status_ids: [] };
  const claude = fakeAnthropic([
    { content: [toolUse("s1", "search_filings", { ...base, tracking_numbers: ["CALL-134000003"] }), toolUse("s2", "search_filings", { ...base, tracking_numbers: ["CALL'; --"] })] },
    (body) => { seen.r = toolResults(body); return { content: [say("Filing CALL-134000003 is a Florida filing published 9 May 2025.")] }; },
    NO_TABLE,
  ]);
  const pending: Promise<unknown>[] = [];
  const deps = { env: env({ ...SECRETS, ANTHROPIC_API_KEY: "test-anthropic-key" }), fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: async () => ({ id: "login-1", role: "corpdev" }), db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const res: Response = await chat.handle(req("snl-chat", { action: "ask", question: "Find filing CALL-134000003 again" }), deps);
  const jobId = (await res.json()).jobId as string;
  while (pending.length) await pending.shift();
  const job = db.jobs.get(jobId)!;
  const searches = sp.calls("/api/v1/search");
  ok("the answer finishes", job.status === "done", job.error);
  ok("the tracking number goes to S&P with the company and state", searches.length === 1 && same(searches[0].body.properties.trackingNumber, ["CALL-134000003"]) && same(searches[0].body.properties.companyId, [9100001]) && same(searches[0].body.properties.serffFilingStateId, ["FL"]), searches.map((c) => c.body.properties));
  ok("and only that filing comes back to Claude", seen.r.s1.isError === false && seen.r.s1.value.total === 1 && seen.r.s1.value.filings[0].trackingNumber === "CALL-134000003", seen.r.s1.value);
  ok("a tracking number with odd characters is a plain tool error, and S&P isn't asked", seen.r.s2.isError === true && /tracking numbers must be short text values/.test(seen.r.s2.value.error) && searches.length === 1, seen.r.s2);
  const saved = [...db.store.values()].filter((r) => r.kind === "search");
  ok("a search Claude runs inside an answer is saved, but kept out of the shared Recent searches list", saved.length === 1 && (saved[0].doc as any).unlisted === true);
  ok("the search Claude ran is saved under the same id the Filings view would use for it", saved.length === 1 && saved[0].id === await F.searchKey(P({ companyIds: [9100001], institutionIds: [], filingStatusIds: [], trackingNumbers: ["CALL-134000003"], from: "2025-01-01", to: "2025-12-31" }) as any), saved.map((r) => r.id));
}

done();
