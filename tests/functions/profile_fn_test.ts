// The snl-profile function end to end, through handle(): every action, the login check and CORS, "not set up" and
// "not mapped", saved statutory results and saved filing searches reused, the cap on S&P requests, the daily question
// limit and "one answer at a time", Claude's text (good, timed out, unusable, refused, with a figure that isn't in the
// facts) always ending in a usable text, and the draft counted as one question with its cost.
// Every company, code, view, column and figure here is made up.
(globalThis as any).__SNL_TEST__ = true;
const profile = await import(new URL("../../supabase/functions/snl-profile/index.ts", import.meta.url).href);
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { supabaseDb } from "../../supabase/functions/_shared/db.ts";
import * as P from "../../supabase/functions/_shared/profile.ts";
import { forgetTokens, Spgmi, SpgmiError } from "../../supabase/functions/_shared/spgmi.ts";
import { SNOWFLAKE_NOT_CONFIGURED } from "../../supabase/functions/_shared/snowflake.ts";
import { NOT_MAPPED } from "../../supabase/functions/_shared/statutory.ts";
import { checks, corpdev, env, fakeAnthropic, fakeClock, J, memoryDb, nobody, read, reader, type Reply, req, say } from "./helpers/fakes.ts";
import { fakeSnowflake, route } from "./helpers/snowflake.ts";
import { filing, spPage, spStub } from "./helpers/more.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SF = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
const SP = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" };
const AI = { ANTHROPIC_API_KEY: "test-key-not-a-secret" };
const ALL = { ...SF, ...SP, ...AI };
const yr = (y: number, o: Record<string, unknown>) => ({ NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: y, ...o });
const TABLES = {
  IR_YEARLY: [2020, 2021, 2022, 2023, 2024, 2025].map((y, i) => yr(y, { PHS_000: 40_000 + i * 3_000, NI_000: i === 2 ? -1_500 : 2_000 + i * 500, CR: 0.95 + (i % 3) * 0.04, GPW_000: 90_000 + i * 9_000, NPE_000: 55_000 + i * 6_000 })),
  IR_LINES: [2024, 2025].flatMap((y) => [["Homeowners", 70_000, 50_000], ["Fire", 20_000, 12_000], ["Inland marine", 10_000, 8_000]].map(([l, d, n]) => yr(y, { LOB: l, DPW_000: d, NPW_000: n }))),
  IR_STATES: [yr(2025, { ST: "FL", DPW_000: 80_000 }), yr(2025, { ST: "GA", DPW_000: 20_000 })],
  IR_REINS: [yr(2025, { REINSURER: "Nonesuch Re", CEDED_000: 6_000 }), yr(2025, { REINSURER: "Tarrow Re", CEDED_000: 4_000 })],
};
const base = (view: string, value: string, extra: Record<string, unknown> = {}) => ({ view, entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value, scale: 1000, ...extra });
const MAPPING = { fields: {
  surplus: base("IR_YEARLY", "PHS_000"), net_income: base("IR_YEARLY", "NI_000"), combined_ratio: base("IR_YEARLY", "CR", { scale: 100 }), gpw: base("IR_YEARLY", "GPW_000"), npe: base("IR_YEARLY", "NPE_000"),
  dpw_by_line: base("IR_LINES", "DPW_000", { line: "LOB" }), npw_by_line: base("IR_LINES", "NPW_000", { line: "LOB" }), dpw_by_state: base("IR_STATES", "DPW_000", { state: "ST" }),
  ceded_by_reinsurer: base("IR_REINS", "CEDED_000", { item: "REINSURER" }),
} };
const ENT = { companyId: "9100001", companyName: "Calloway Insurance Co", naicCompanyCode: "91001", institutionId: "810001", spStatEntityId: null, naicGroupCode: "9100", naicGroupName: "Calloway Group" };
const BODY = { action: "facts", kind: "company", code: "91001" };

type Opts = { secrets?: Record<string, string>; mapping?: unknown; entity?: boolean; script?: (Reply | ((body: any, n: number) => Reply))[]; pages?: number; anthropicFetch?: typeof fetch };
function world(o: Opts = {}) {
  forgetTokens();
  const clock = fakeClock("2026-11-13T12:00:00Z"), db = memoryDb(clock), sf = fakeSnowflake(clock, { tables: TABLES });
  if (o.mapping !== null) db.settings.set("statutory_mapping", (o.mapping ?? MAPPING) as Record<string, unknown>);
  if (o.entity !== false) db.putEntities([ENT]);
  const refs = read("spgmi_reference.json");
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/reference") { const l = refs[call.query.referenceField]; return J({ headers: l.headers, rows: l.rows.map((row: unknown[]) => ({ row })) }); }
    const p = call.body.properties;
    if (o.pages) return J(spPage(Array.from({ length: 500 }, (_, i) => filing(p.pageNumber * 1000 + i, { publishDate: "2026-10-01", filingVersionId: `V-${p.pageNumber}-${i}` })), { totalPages: o.pages, currentPage: p.pageNumber }));
    const rows = [filing(1, { serffFilingType: "Rate", dispOverallRateImpact: "4.5%", publishDate: "2026-10-10" }), filing(2, { serffFilingStateId: "GA", publishDate: "2026-08-01" }), filing(3, { publishDate: "2024-01-01" })]
      .filter((r) => (p.companyId ?? []).includes(r.companyId) && p.serffFilingStateId.includes(r.serffFilingStateId) && String(r.publishDate) >= p.minPublishDate && String(r.publishDate) <= p.maxPublishDate);
    return J(spPage(rows, { totalPages: 1, currentPage: 1 }));
  });
  const ai = fakeAnthropic(o.script ?? []);
  const deps = { env: env(o.secrets ?? ALL), fetch: route({ [sf.host]: sf.fetch }, sp.fetch), anthropicFetch: o.anthropicFetch ?? ai.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown, over: Record<string, unknown> = {}) => { const res: Response = await profile.handle(req("snl-profile", body), { ...deps, ...over }); return { res, status: res.status, body: await res.json() }; };
  return { clock, db, sf, sp, ai, deps, call };
}

/** Claude's answer: the plain text of the facts it was sent, with action titles, as JSON. */
const factsSent = (body: any) => JSON.parse(String(body.messages[0].content).split("<facts>\n")[1].split("\n</facts>")[0]);
const claudeText = (edit: (t: any) => void = () => {}) => (body: any): Reply => {
  const t: any = P.plainText(factsSent(body));
  delete t.by; delete t.note;
  t.summary.title = `Combined ratio of ${P.fmt.pct(factsSent(body).series.combined_ratio.at(-1))} in 2025`;
  edit(t);
  return { content: [say(JSON.stringify(t))] };
};

// ---------- CORS, sign-in, bad bodies ----------
{
  const w = world();
  const pre: Response = await profile.handle(new Request("https://x.supabase.co/functions/v1/snl-profile", { method: "OPTIONS", headers: { Origin: "https://site.example" } }), w.deps);
  ok("a preflight is answered with CORS headers", pre.status === 200 && pre.headers.get("access-control-allow-origin") === "*" && /authorization/.test(pre.headers.get("access-control-allow-headers")!));
  const get: Response = await profile.handle(req("snl-profile", null, "GET"), w.deps);
  ok("anything but POST is refused, with CORS headers", get.status === 405 && get.headers.get("access-control-allow-origin") === "*");
  const pinned: Response = await profile.handle(req("snl-profile", { action: "status" }, "POST", { Origin: "https://site.example" }), { ...w.deps, env: env({ ...ALL, ALLOWED_ORIGIN: "https://site.example/app/" }) });
  ok("ALLOWED_ORIGIN is honoured as in the other functions", pinned.headers.get("access-control-allow-origin") === "https://site.example");
  for (const action of ["status", "sample", "facts", "draft"]) {
    const r = await w.call({ ...BODY, action }, { whoIs: nobody });
    ok(`${action} needs a signed-in login`, r.status === 401 && r.body.error === "signin" && r.res.headers.get("access-control-allow-origin") === "*", r.body);
  }
  ok("a body that isn't JSON is refused plainly", (await profile.handle(new Request("https://x.supabase.co/functions/v1/snl-profile", { method: "POST", headers: { Authorization: "Bearer u" }, body: "{oops" }), w.deps)).status === 400);
  const u = await w.call({ action: "build" });
  ok("an unknown action is refused, naming the actions", u.status === 400 && /status, sample, facts or draft/.test(u.body.message));
  for (const [name, body, says] of [["no kind", { code: "91001" }, /kind must be/], ["a code with SQL", { kind: "company", code: "91001' OR 1=1" }, /NAIC code/], ["a seven-digit code", { kind: "company", code: "1234567" }, /NAIC code/],
    ["a year in the future", { kind: "company", code: "91001", toYear: 2027 }, /last year/], ["a year that is text", { kind: "company", code: "91001", toYear: "last" }, /last year/], ["a year too early", { kind: "company", code: "91001", toYear: 1990 }, /last year/]] as const) {
    const r = await w.call({ action: "facts", ...body });
    ok(`facts with ${name} is refused with a plain reason, before Snowflake is asked`, r.status === 400 && r.body.error === "bad" && says.test(r.body.message) && w.sf.log.length === 0, r.body);
  }
  ok("parseProfile takes a numeric code and a year as text", same(profile.parseProfile({ kind: "group", code: 9100, toYear: "2024" }, 2026), { ok: true, kind: "group", code: "9100", toYear: 2024 }));
}

// ---------- status and sample ----------
{
  const off = world({ secrets: {}, mapping: null });
  const s = await off.call({ action: "status" });
  ok("status before anything is set up", s.status === 200 && same(s.body.claude, { configured: false }) && same(s.body.filings, { configured: false }) && s.body.statutory.configured === false && s.body.statutory.mapped === false, s.body);
  ok("status lists every statutory field with its label and whether it is mapped", s.body.statutory.fields.length === 49 && s.body.statutory.fields.every((f: any) => same(Object.keys(f), ["id", "label", "mapped"]) && f.mapped === false) && s.body.statutory.fields.some((f: any) => f.id === "ceded_by_reinsurer"));
  const on = await world().call({ action: "status" }, { whoIs: reader });
  ok("status once set up, for a reader too", on.body.statutory.configured === true && on.body.statutory.mapped === true && on.body.claude.configured && on.body.filings.configured && on.body.statutory.fields.filter((f: any) => f.mapped).length === 9, on.body);

  let calls = 0;
  const sample = await off.call({ action: "sample" }, { fetch: (() => { calls++; throw new Error("no"); }) as unknown as typeof fetch, anthropicFetch: (() => { calls++; throw new Error("no"); }) as unknown as typeof fetch, db: undefined });
  ok("sample answers made-up facts and the plain text, with no S&P, Snowflake, Claude or database call", sample.status === 200 && sample.body.facts.sample === true && sample.body.text.by === "plain" && calls === 0 && sample.body.facts.entity.name === "Calloway Insurance Co" && sample.body.facts.asOf === "2026-11-13", sample.body.facts?.entity);
  ok("the sample is the one sampleFacts makes for today", same(sample.body.facts, P.sampleFacts("2026-11-13")) && same(sample.body.text, P.plainText(P.sampleFacts("2026-11-13"))));
  ok("a reader may have the sample", (await off.call({ action: "sample" }, { whoIs: reader })).status === 200);
}

// ---------- facts: not set up, not mapped ----------
{
  const off = world({ secrets: {}, mapping: null });
  const r = await off.call(BODY);
  ok("facts before Snowflake is set up answers 503 not_configured, as snl-statutory does", r.status === 503 && r.body.error === "not_configured" && r.body.message === SNOWFLAKE_NOT_CONFIGURED, r.body);
  const unmapped = world({ mapping: null });
  const m = await unmapped.call(BODY);
  ok("facts with Snowflake connected and nothing mapped answers 409 not_mapped", m.status === 409 && m.body.error === "not_mapped" && m.body.message === NOT_MAPPED && unmapped.sf.log.length === 0, m.body);
  unmapped.sf.failNext.push({ status: 401 });
  const bad = await world().call(BODY, { fetch: route({ "ab12345.snowflakecomputing.com": (async () => J({ message: "nope" }, 401)) as unknown as typeof fetch }, (() => { throw new Error("no S&P"); }) as unknown as typeof fetch) });
  ok("a Snowflake sign-in failure reaches the page as snowflake_signin", bad.status === 502 && bad.body.error === "snowflake_signin", bad.body);
}

// ---------- facts ----------
{
  const w = world();
  const r = await w.call(BODY);
  const f = r.body.facts;
  ok("facts answers 200 with facts and the plain text", r.status === 200 && f.version === 1 && f.sample === false && r.body.text.by === "plain" && same(r.body.text, P.plainText(f)), r.body);
  ok("the latest five years up to last year", same(f.years, [2021, 2022, 2023, 2024, 2025]), f.years);
  ok("figures come from the mapped views, scaled to dollars", f.series.surplus[4] === 55_000_000 && f.series.gpw[0] === 99_000_000 && same(f.series.dpw, [null, null, null, 100_000_000, 100_000_000]) && f.series.npw[4] === 70_000_000, f.series);
  ok("ratios are percentage points", Math.abs(f.series.combined_ratio[0] - 99) < 1e-9, f.series.combined_ratio);
  ok("derived figures are worked out", Math.abs(f.derived.cession_pct[4] - ((135 - 70) / 135) * 100) < 1e-3 && f.derived.npw_to_surplus[4] === Math.round((70 / 55) * 1e4) / 1e4 && f.derived.roae[0] === null, f.derived);
  ok("the mix and the reinsurers", f.mix.year === 2025 && f.mix.lines[0].name === "Homeowners" && f.mix.lines[0].share === 70 && f.mix.topStateShare === 80 && same(f.reinsurers.items.map((x: any) => [x.name, x.share]), [["Nonesuch Re", 60], ["Tarrow Re", 40]]), [f.mix, f.reinsurers]);
  ok("the company is named, with its group from the company list", same(f.entity, { kind: "company", code: "91001", name: "Calloway Insurance Co", groupName: "Calloway Group", naicGroupCode: "9100" }), f.entity);
  ok("missing lists the fields that aren't mapped, in plain words", same(f.missing.map((m: any) => m.field).filter((id: any) => P.PROFILE_FIELDS.indexOf(id) < 18).sort(), ["expense_ratio", "loss_lae_ratio", "loss_ratio", "net_reserves", "paid_in_capital", "pyd", "rbc_ratio", "reins_recoverable", "total_assets"]) && f.missing.every((m: any) => m.reason === "not mapped" && m.label));
  const reins = w.sf.statements.find((s) => s.statement.includes("IR_REINS"))!, lines = w.sf.statements.find((s) => s.statement.includes("IR_LINES"))!;
  ok("the reinsurer field selects its item column; other fields' SQL is unchanged", reins.statement.includes(", CEDED_000 AS VAL, REINSURER AS ITEM FROM") && !lines.statement.includes("ITEM") && /^SELECT NAIC_CD AS CODE, CO_NAME AS NAME, STMT_YEAR AS YR, LOB AS LINE, NULL AS STATE, DPW_000 AS VAL FROM MI_XPRESSCLOUD\.XPRESSFEED\.IR_LINES WHERE/.test(lines.statement), reins.statement);
  ok("six years are asked of Snowflake, bound, never written into the SQL", same(reins.bindings.slice(0, 3).map((b) => b.value), ["91001", "2020", "2025"]) && w.sf.statements.every((s) => !s.statement.includes("91001")));

  // filings
  ok("filings: the S&P company id from the company list, every state in S&P's list, the last 12 months", same(w.sp.calls("/api/v1/search").map((c) => [c.body.properties.companyId, c.body.properties.serffFilingStateId, c.body.properties.minPublishDate, c.body.properties.maxPublishDate]), [[[9100001], ["FL", "TX", "GA"], "2025-11-13", "2026-11-12"]]), w.sp.calls("/api/v1/search").map((c) => c.body.properties));
  ok("the filings in the facts", f.filings.total === 2 && f.filings.from === "2025-11-13" && f.filings.to === "2026-11-12" && f.filings.rows[0].rateImpact === 4.5 && same(f.filings.byState, [{ state: "FL", count: 1 }, { state: "GA", count: 1 }]), f.filings);
  const used = w.sp.log.length;
  ok("S&P requests: sign-in, the two lists and one search, through the shared counter", used === 4 && w.db.slots.length === 4, w.sp.log.map((c) => c.path));

  // saved results reused
  const n = w.sf.log.length;
  w.clock.now += 3_600_000;
  const again = await w.call(BODY, { whoIs: reader });
  ok("the same profile again opens the saved statutory result and the saved search: no Snowflake and no S&P request", again.status === 200 && w.sf.log.length === n && w.sp.log.length === used && same(again.body.facts.series, f.series) && again.body.facts.filings.total === 2, { sf: w.sf.log.length - n, sp: w.sp.log.length - used });
  const off = world({ secrets: {} });
  for (const [id, row] of w.db.store) off.db.store.set(id, row);
  const opened = await off.call(BODY);
  ok("a saved statutory result opens even when Snowflake isn't set up; filings then say S&P isn't set up", opened.status === 200 && same(opened.body.facts.series, f.series) && opened.body.facts.filings.unavailable === P.FILINGS_NOT_SET_UP, opened.body.facts?.filings);
  const other = await w.call({ ...BODY, toYear: 2024 });
  ok("another last year is a new query", other.body.facts.years.at(-1) === 2024 && w.sf.log.length > n);

  const noId = world({ entity: false });
  const ni = await noId.call(BODY);
  ok("with no S&P id in the company list, filings say so and S&P isn't asked", ni.body.facts.filings.unavailable === P.NO_SP_ID.company && noId.sp.log.length === 0 && ni.body.facts.entity.name === "Calloway Insurance Co");
  const noSp = world({ secrets: { ...SF, ...AI } });
  ok("with S&P not set up, filings say so in plain words", (await noSp.call(BODY)).body.facts.filings.unavailable === "S&P filings aren't set up yet, so recent filings can't be searched." && noSp.sp.log.length === 0);

  const grp = world();
  grp.db.putEntities(Array.from({ length: 14 }, (_, i) => ({ ...ENT, companyId: String(9100010 + i), companyName: `Calloway Member ${i}`, naicCompanyCode: String(91010 + i) })));
  const g = await grp.call({ action: "facts", kind: "group", code: "9100" });
  const ids = grp.sp.calls("/api/v1/search").flatMap((c) => c.body.properties.companyId ?? []);
  ok("a group searches its member companies, at most ten ids, in one request", g.status === 200 && ids.length === 10 && grp.sp.calls("/api/v1/search").length === 1 && g.body.facts.entity.name === "Calloway Group" && g.body.facts.entity.kind === "group", { ids, entity: g.body.facts?.entity });
  ok("a group query uses the group column", grp.sf.statements.some((s) => s.statement.startsWith("SELECT GRP_CD AS CODE")));

  // the cap on S&P requests
  const big = world({ pages: 9 });
  const b = await big.call(BODY);
  ok(`a search with many pages stops inside the cap of ${P.PROFILE_MAX_SP_REQUESTS} S&P requests and says it is incomplete`, b.status === 200 && big.sp.log.length <= P.PROFILE_MAX_SP_REQUESTS && b.body.facts.filings.capped === true && big.sp.calls("/api/v1/search").length === P.PROFILE_SEARCH_PAGES, { log: big.sp.log.length, filings: b.body.facts.filings.total });
  ok("an incomplete search isn't saved", ![...big.db.store.values()].some((r) => r.kind === "search"));
  const capped = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: big.deps.fetch, sleep: big.clock.sleep, gate: async () => { throw new SpgmiError("limit", "The filing search stopped after the 6 S&P requests one profile may use."); } });
  const lim = await P.profileFilings(capped, big.db, { name: null, groupName: null, groupCode: null, companyIds: [9100001], institutionIds: [], members: 1 }, "company", "2026-11-13", { now: big.clock.fn, deadline: big.clock.now + 1000 });
  ok("hitting the cap gives a plain reason instead of filings", same(lim, { unavailable: P.FILINGS_LIMIT }) && /6 S&P requests for one profile/.test(P.FILINGS_LIMIT), lim);
  const fail = new Spgmi({ username: "api-user", password: "api-pass" }, { fetch: big.deps.fetch, sleep: big.clock.sleep, gate: async () => { throw new SpgmiError("limit", "The app stopped before asking S&P: this hour's limit of 500 S&P requests is used up. It resets at the top of the hour."); } });
  const hour = await P.profileFilings(fail, big.db, { name: null, groupName: null, groupCode: null, companyIds: [9100001], institutionIds: [], members: 1 }, "company", "2026-11-13", { now: big.clock.fn, deadline: big.clock.now + 1000 });
  ok("the hour's S&P limit gives S&P's plain reason, and the profile is still built", "unavailable" in hour && /this hour's limit/.test((hour as any).unavailable));
}

// ---------- draft ----------
{
  const off = world({ secrets: { ...SF, ...SP } });
  const r = await off.call({ ...BODY, action: "draft" });
  ok("draft without an Anthropic key answers 503 not_configured, and nothing is counted", r.status === 503 && r.body.error === "not_configured" && /ANTHROPIC_API_KEY/.test(r.body.message) && off.db.jobs.size === 0, r.body);

  const w = world({ script: [claudeText()] });
  const d = await w.call({ ...BODY, action: "draft" }, { whoIs: reader });
  ok("a draft answers facts, Claude's text and usage, for a reader too", d.status === 200 && d.body.text.by === "claude" && d.body.text.note === null && /^Combined ratio of .*% in 2025$/.test(d.body.text.summary.title) && d.body.facts.entity.code === "91001" && typeof d.body.jobId === "string", d.body.text?.note);
  const sent = w.ai.calls[0];
  ok("one streamed request, with no tools, the model setting and the same options as the comparison table", w.ai.calls.length === 1 && sent.stream && !sent.body.tools && sent.body.model === "claude-opus-5-5" && /server-side-fallback/.test(sent.betas ?? "") && sent.body.output_config.format.type === "json_schema" && sent.body.system === P.DRAFT_SYSTEM && sent.body.messages.length === 1, sent.body);
  ok("Claude is sent only the facts (fenced as data, the filings in detail bounded) and the writing rules", same(factsSent(sent.body), JSON.parse(JSON.stringify(P.factsForClaude(d.body.facts)))) && same(Object.keys(sent.body).sort(), ["fallbacks", "max_tokens", "messages", "model", "output_config", "stream", "system"]), Object.keys(sent.body));
  const job = w.db.jobs.get(d.body.jobId)!;
  ok("the draft is kept as a finished answer of the login that asked", job.owner === "user-2" && job.status === "done" && job.question === "Profile text for Calloway Insurance Co");
  ok("the saved answer reads as the drafted points, with headings and bold leads", Array.isArray(job.result!.answer) && (job.result!.answer as any[]).some((s) => s.text.startsWith("## Executive summary: Combined ratio")) && (job.result!.answer as any[]).some((s) => /^- \*\*Scale\.\*\* /.test(s.text)) && (job.result!.answer as any[]).every((s) => same(s.cites, [])) && same(job.result!.sources, []) && job.result!.table === null, job.result);
  ok("its usage and cost are recorded: 1,000 tokens read and 200 written at the listed price", same(d.body.usage, job.result!.usage) && d.body.usage.inputTokens === 1000 && d.body.usage.outputTokens === 200 && d.body.usage.costUsd === 0.01 && d.body.usage.spRequests === 4, d.body.usage);
  const day = await chat.handle(req("snl-chat", { action: "status" }), { ...w.deps, whoIs: reader });
  const dayBody = await day.json();
  ok("the Ask Claude line counts it: 1 question today, about $0.01", dayBody.askedToday === 1 && dayBody.costToday === 0.01, dayBody);
  w.clock.now += 31 * 86_400_000;
  w.ai.left.push(claudeText());
  await w.call({ ...BODY, action: "draft" }, { whoIs: reader });
  ok("drafts are cleared after 30 days like other answers", !w.db.jobs.has(d.body.jobId) && w.db.jobs.size === 1);

  const m = world({ secrets: { ...ALL, CLAUDE_MODEL: "claude-sonnet-5-5" }, script: [claudeText()] });
  await m.call({ ...BODY, action: "draft" });
  ok("CLAUDE_MODEL chooses the model", m.ai.calls[0].body.model === "claude-sonnet-5-5");

  // the daily limit and one answer at a time
  const lim = world({ secrets: { ...ALL, CHAT_DAILY_LIMIT: "1" }, script: [claudeText(), claudeText()] });
  ok("the first draft of the day is allowed", (await lim.call({ ...BODY, action: "draft" })).status === 200);
  const second = await lim.call({ ...BODY, action: "draft" });
  ok("at the daily limit a draft answers 429 limit, says the plain text still works, and isn't counted", second.status === 429 && second.body.error === "limit" && second.body.dailyLimit === 1 && second.body.askedToday === 1 && /plain text/.test(second.body.message) && lim.db.jobs.size === 1 && lim.ai.calls.length === 1, second.body);
  ok("facts and the plain text still work at the limit", (await lim.call(BODY)).status === 200);
  const busy = world({ script: [claudeText()] });
  const going = await busy.db.createJob("user-1", "An earlier question");
  const b = await busy.call({ ...BODY, action: "draft" });
  ok("with an answer in progress, a draft answers 409 busy and nothing is sent to Claude", b.status === 409 && b.body.error === "busy" && b.body.jobId === going && busy.ai.calls.length === 0 && busy.sf.log.length === 0, b.body);
  busy.clock.now += 11 * 60_000;
  ok("ten minutes later the stuck answer no longer blocks", (await busy.call({ ...BODY, action: "draft" })).status === 200);
  const nf = world({ secrets: { ...AI, ...SP } });
  ok("a draft whose figures can't be had (Snowflake not set up) answers 503 and isn't counted", (await nf.call({ ...BODY, action: "draft" })).status === 503 && nf.db.jobs.size === 0);

  // Claude failing in every way still gives a usable text
  const plainOf = (body: any) => P.plainText(body.facts);
  const cases: [string, Opts, string][] = [
    ["an answer that isn't JSON", { script: [{ content: [say("Here is your profile!")] }] }, P.NOTES.unusable],
    ["an answer cut off at the length limit", { script: [{ content: [say("{\"cover\":")], stop_reason: "max_tokens" }] }, P.NOTES.unusable],
    ["a refusal", { script: [{ content: [], stop_reason: "refusal" }] }, P.NOTES.refusal],
    ["Claude being busy (429)", { script: [{ error: { status: 429, type: "rate_limit_error", message: "slow down" } }] }, P.NOTES.busy],
    ["a bad API key (401)", { script: [{ error: { status: 401, type: "authentication_error", message: "bad key" } }] }, P.NOTES.key],
    ["Anthropic failing (500)", { script: [{ error: { status: 500, type: "api_error", message: "oops" } }] }, P.NOTES.overloaded],
    ["Anthropic unreachable", { anthropicFetch: (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch }, P.NOTES.unreachable],
  ];
  for (const [name, o, note] of cases) {
    const x = world(o);
    const r2 = await x.call({ ...BODY, action: "draft" }, { sleep: async () => {} });
    const j = x.db.jobs.get(r2.body.jobId);
    ok(`${name}: the plain text comes back with a note, and the draft is still recorded`, r2.status === 200 && r2.body.text.by === "plain" && r2.body.text.note === note && same({ ...r2.body.text, note: null }, plainOf(r2.body)) && j?.status === "done" && same(j!.result!.caps, [note]), { status: r2.status, note: r2.body.text?.note, job: j?.status });
  }
  // a reply that never finishes
  let aborted = false;
  const hang = ((_: unknown, init: RequestInit = {}) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => { aborted = true; rej(new DOMException("aborted", "AbortError")); }))) as unknown as typeof fetch;
  const slow = world({ anthropicFetch: hang });
  const t0 = Date.now();
  const r3 = await slow.call({ ...BODY, action: "draft" }, { draftMs: 50 });
  ok("Claude not finishing in time: the request is given up at the deadline and the plain text comes back with a note", r3.status === 200 && aborted && r3.body.text.by === "plain" && r3.body.text.note === P.NOTES.timeout && Date.now() - t0 < 5_000, r3.body.text?.note);
  ok("a draft that timed out still counts as a question", slow.db.jobs.get(r3.body.jobId)?.status === "done");
  ok("the deadline is a minute, inside one function call", P.DRAFT_TIME_MS === 60_000 && P.PROFILE_CALL_MS <= 140_000);

  // a figure Claude made up
  const madeUp = world({ script: [claudeText((t) => { t.capital.points[0].text = "Surplus rose 42.4% to $99.9M in 2025."; })] });
  const r4 = await madeUp.call({ ...BODY, action: "draft" });
  ok("a section with a figure that isn't in the facts is replaced by the plain one, and the note says so", r4.body.text.by === "claude" && same(r4.body.text.capital, plainOf(r4.body).capital) && r4.body.text.note === P.NOTES.figures && r4.body.text.summary.title !== plainOf(r4.body).summary.title, r4.body.text?.note);
  const dashes = world({ script: [claudeText((t) => { t.summary.points[0].text = "Scale — direct premiums of $100.0M in 2025."; })] });
  ok("em dashes in Claude's text are replaced", !(JSON.stringify((await dashes.call({ ...BODY, action: "draft" })).body.text)).includes("—"));
}

// ---------- the company list query ----------
{
  const ops: { table: string; calls: unknown[][] }[] = [];
  const chain = (op: { table: string; calls: unknown[][] }): any => new Proxy(() => {}, {
    get: (_t, k) => (k === "then" ? (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ doc: ENT }], error: null }).then(res) : (...args: unknown[]) => { op.calls.push([String(k), ...args]); return chain(op); }),
  });
  const sb = { from: (table: string) => { const op = { table, calls: [] as unknown[][] }; ops.push(op); return chain(op); } } as unknown as SupabaseClient;
  const found = await supabaseDb(sb).entitiesInGroup("9100", 200);
  ok("a group's companies are read from saved companies by their group code", same(found, [ENT]) && ops[0].table === "snl_store" && ops[0].calls.some((c) => same(c, ["eq", "kind", "entity"])) && ops[0].calls.some((c) => same(c, ["eq", "doc->>naicGroupCode", "9100"])) && ops[0].calls.some((c) => same(c, ["limit", 200])), ops[0].calls);
  const asked = ops.length;
  ok("a group code that isn't a code asks nothing", same(await supabaseDb(sb).entitiesInGroup("9100' or 1=1", 5), []) && ops.length === asked);
}

done();
