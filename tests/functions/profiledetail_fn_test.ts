// The detailed company profile through the snl-profile function: the status lists all 49 figures, a profile with
// some of the new figures mapped (a reinsurer tag among them) gives the detail, the new sections and the rest listed as
// not mapped, never an error; the sample carries every new part; and the time a first full profile takes: about 50
// statements of about ten seconds, eight at a time, in the 45 seconds a call gives the figures, so two calls.
// Every company, reinsurer, code, view, column and figure here is made up.
(globalThis as any).__SNL_TEST__ = true;
const profile = await import(new URL("../../supabase/functions/snl-profile/index.ts", import.meta.url).href);
import * as P from "../../supabase/functions/_shared/profile.ts";
import type { Snowflake } from "../../supabase/functions/_shared/snowflake.ts";
import { type Mapping, savedOrFreshStatutory, STAT_FIELDS, STAT_MIN_MS, STAT_POOL, type StatFieldId } from "../../supabase/functions/_shared/statutory.ts";
import { forgetTokens } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, corpdev, env, fakeClock, memoryDb, req } from "./helpers/fakes.ts";
import { fakeSnowflake, route } from "./helpers/snowflake.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SF = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
const yr = (y: number, o: Record<string, unknown>) => ({ NAIC_CD: "91001", GRP_CD: "9100", CO_NAME: "Calloway Insurance Co", STMT_YEAR: y, ...o });
const TABLES = {
  IR_YEARLY: [2023, 2024, 2025].map((y, i) => yr(y, { PHS_000: 40_000 + i * 5_000, UWG_000: [-1_200, 800, 2_400][i], NII_000: 1_500 + i * 100, CI_000: 90_000 + i * 6_000, TL_000: 60_000 + i * 2_000, YLD: 0.031 + i * 0.001 })),
  IR_LINES: [2025].flatMap((y) => [["Homeowners", 52_000, 0.612], ["Fire", 11_000, 0.455]].map(([l, e, r]) => yr(y, { LOB: l, NPE_000: e, LR: r }))),
  IR_RECOV: [yr(2025, { REINSURER: "Nonesuch Re", AUTH: "Authorized", REC_000: 9_000 }), yr(2025, { REINSURER: "Tarrow Re", AUTH: "Unauthorized", REC_000: 3_000 })],
  IR_AY: [2024, 2025].flatMap((y) => [2024, 2025].filter((a) => a <= y).map((a) => yr(y, { AY: String(a), AYLR: a === 2024 ? (y === 2024 ? 0.6 : 0.65) : 0.58 }))),
};
const base = (view: string, value: string, extra: Record<string, unknown> = {}) => ({ view, entity: { company: "NAIC_CD", group: "GRP_CD", name: "CO_NAME" }, year: "STMT_YEAR", value, scale: 1000, ...extra });
const MAPPING = { fields: {
  surplus: base("IR_YEARLY", "PHS_000"), uw_gain: base("IR_YEARLY", "UWG_000"), net_inv_income: base("IR_YEARLY", "NII_000"), cash_invested: base("IR_YEARLY", "CI_000"), total_liabilities: base("IR_YEARLY", "TL_000"),
  investment_yield: base("IR_YEARLY", "YLD", { scale: 100 }), npe_by_line: base("IR_LINES", "NPE_000", { line: "LOB" }), loss_lae_ratio_by_line: base("IR_LINES", "LR", { line: "LOB", scale: 100 }),
  recoverable_by_reinsurer: base("IR_RECOV", "REC_000", { item: "REINSURER", tag: "AUTH" }), ay_loss_ratio: base("IR_AY", "AYLR", { item: "AY", scale: 100 }),
} };

function world() {
  forgetTokens();
  const clock = fakeClock("2026-11-13T12:00:00Z"), db = memoryDb(clock), sf = fakeSnowflake(clock, { tables: TABLES });
  db.settings.set("statutory_mapping", MAPPING as Record<string, unknown>);
  const deps = { env: env(SF), fetch: route({ [sf.host]: sf.fetch }, (() => { throw new Error("no S&P here"); }) as unknown as typeof fetch), now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep };
  const call = async (body: unknown) => { const res: Response = await profile.handle(req("snl-profile", body), deps); return { status: res.status, body: await res.json() }; };
  return { clock, db, sf, call };
}

// ---------- status and facts ----------
{
  const w = world();
  const s = await w.call({ action: "status" });
  ok("status lists all 49 figures, the new ones with their labels, and which are mapped", s.status === 200 && s.body.statutory.fields.length === 49 && s.body.statutory.fields.filter((f: any) => f.mapped).length === 10
    && s.body.statutory.fields.find((f: any) => f.id === "recoverable_by_reinsurer").label === "Reinsurance recoverables by reinsurer", s.body.statutory.fields.filter((f: any) => f.mapped).map((f: any) => f.id));
  const r = await w.call({ action: "facts", kind: "company", code: "91001", toYear: 2025 });
  const f = r.body.facts;
  ok("facts with some new figures mapped answer 200, with no figures pending", r.status === 200 && r.body.pending === undefined && same(f.years, [2023, 2024, 2025]), { status: r.status, years: f?.years });
  ok("the new figures by year arrive as series, scaled", same(f.series.uw_gain, [-1_200_000, 800_000, 2_400_000]) && same(f.series.investment_yield, [3.1, 3.2, 3.3]), f.series.uw_gain);
  ok("worked out from them: liabilities to surplus and invested assets to liabilities", Math.abs(f.derived.liabilities_to_surplus[2] - 64 / 50) < 1e-4 && Math.abs(f.derived.invested_to_liabilities[2] - 102 / 64) < 1e-4, f.derived);
  ok("lines: ranked by net premiums earned (no direct premiums by line), with their loss and LAE ratios", f.detail.lines.by === "npe" && same(f.detail.lines.items.map((l: any) => [l.name, l.lossRatio]), [["Homeowners", 61.2], ["Fire", 45.5]]), f.detail.lines);
  ok("recoverables carry the tag; the share owed by reinsurers not authorized is worked out", f.detail.recoverables.tagged === true && f.detail.recoverables.unauthorizedShare === 25 && f.detail.recoverables.items[0].tag === "Authorized" && f.detail.recoverables.items[0].toSurplus === 18, f.detail.recoverables);
  ok("accident years as each statement reported them", same(f.detail.accidentYears.rows.map((x: any) => [x.ay, x.values, x.change]), [[2024, [null, 60, 65], 5], [2025, [null, null, 58], null]]), f.detail.accidentYears.rows);
  const unmapped = f.missing.filter((m: any) => STAT_FIELDS.findIndex((x) => x.id === m.field) >= 18);
  ok("every new figure not mapped is listed as not mapped, never as an error", unmapped.length === 31 - 9 && unmapped.every((m: any) => m.reason === "not mapped"), unmapped.map((m: any) => [m.field, m.reason]));
  ok("the text has the new sections", r.body.text.earnings.points[0].text === "Net underwriting gain of $2.4M in 2025." && /Total liabilities of \$64\.0M at the end of 2025; cash and invested assets were 1\.6x liabilities \(derived\)\./.test(r.body.text.balance.points[1].text), [r.body.text.earnings.points[0], r.body.text.balance.points[1]]);
  const rec = w.sf.statements.find((x) => x.statement.includes("IR_RECOV"))!;
  ok("the recoverables statement selects the tag beside the reinsurer", rec.statement.includes(", REC_000 AS VAL, REINSURER AS ITEM, AUTH AS TAG FROM "), rec.statement);
  const n = w.sf.statements.length;
  const again = await w.call({ action: "facts", kind: "company", code: "91001", toYear: 2025 });
  ok("the same profile again opens from the saved figures: no new statement", again.status === 200 && w.sf.statements.length === n && same(again.body.facts.detail, f.detail));

  const smp = await w.call({ action: "sample" });
  ok("the sample answers every new part, from made-up figures only", smp.status === 200 && smp.body.facts.missing.length === 0 && !!smp.body.facts.detail.accidentYears && smp.body.text.balance.points.length === 4 && same(smp.body.facts, P.sampleFacts("2026-11-13")));
}

// ---------- the time a first full profile takes ----------
{
  // a stand-in Snowflake where every statement takes ten seconds of the (fake) clock
  const clock = fakeClock(), db = memoryDb(clock);
  const started: number[] = [];
  const sf = { query: async (s: string, _b: unknown, _w: number) => {
    if (s.includes("LOADTRACKER")) return { columns: [], rows: [], truncated: false, statementHandle: null };
    const at = clock.now; started.push(at);
    await new Promise((r) => setTimeout(r, 1));
    clock.now = Math.max(clock.now, at + 10_000);
    return { columns: [], rows: [{ CODE: "91001", NAME: "Calloway Insurance Co", YR: "2025", LINE: "Homeowners", STATE: "FL", VAL: "1", ITEM: "2025" }], truncated: false, statementHandle: null };
  } } as unknown as Snowflake;
  const all = STAT_FIELDS.map((f) => f.id) as StatFieldId[];
  const mapping: Mapping = { fields: Object.fromEntries(all.map((id) => { const by = STAT_FIELDS.find((f) => f.id === id)!.by; return [id, { view: `V_${id.toUpperCase()}`, entity: { company: "NAIC_CD" }, year: "YR", value: "VAL", ...(by === "line" ? { line: "LOB" } : by === "state" ? { state: "ST" } : by === "item" ? { item: "PARTY" } : {}) }]; })) };
  const q = { kind: "company" as const, codes: ["91001"], fromYear: 2020, toYear: 2025 };
  const ask = () => { const t0 = clock.now; return savedOrFreshStatutory(sf, db, "DB", "SCH", mapping, q, P.PROFILE_FIELDS, { now: t0, deadline: t0 + P.PROFILE_STAT_MS, clock: clock.fn }); };
  const a = await ask();
  // 45 seconds: rounds start at 0, 10, 20 and 30 seconds; at 40 only 5 are left, under the 8 a statement needs
  const rounds = Math.floor((P.PROFILE_STAT_MS - STAT_MIN_MS) / 10_000) + 1;
  ok(`the first call runs ${rounds} rounds of ${STAT_POOL}: ${rounds * STAT_POOL} of the 49 figures, the rest pending`, started.length === rounds * STAT_POOL && rounds * STAT_POOL === 32 && a.pending === 49 - 32, { started: started.length, pending: a.pending });
  clock.now += 60_000;
  const b = await ask();
  ok("the second call runs the other 17 and nothing is pending: two calls in all, well inside the page's six", b.pending === 0 && started.length === 49, { pending: b.pending, started: started.length });
}

done();
