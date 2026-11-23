// The detailed company profile, the pure parts (supabase/functions/_shared/profile.ts): every figure the app works
// out, against hand-worked numbers, with the refusals (a missing, zero or negative denominator is n/d, never a
// number); the largest lines and states, recoverables by reinsurer with their authorization tags, accident years and
// the run of years above or below 100%; which figures the facts say are derived; the new sections' plain text with
// all figures, none and a ragged mix, always within the limits and every figure matching the facts; facts and text
// saved before this change; the made-up sample; and Claude's shape within Anthropic's limits.
// Every company, reinsurer, code and figure here is made up.
import * as P from "../../supabase/functions/_shared/profile.ts";
import { STAT_FIELDS, type StatFieldId, type StatResult, type StatRow } from "../../supabase/functions/_shared/statutory.ts";
import { SCHEMA_LIMITS } from "../../supabase/functions/_shared/digest.ts";
import { checks } from "./helpers/fakes.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: unknown, b: number, tol = 1e-3) => typeof a === "number" && Math.abs(a - b) <= tol;
const nearAll = (a: unknown, b: (number | null)[], tol = 1e-3) => Array.isArray(a) && a.length === b.length && a.every((v, i) => (b[i] === null ? v === null : near(v, b[i]!, tol)));
const M = 1e6;
const DIR: P.Directory = { name: "Calloway Insurance Co", groupName: "Calloway Group", groupCode: "9001", companyIds: [], institutionIds: [], members: 0 };
const NOFIL: P.FactsFilings = { unavailable: P.FILINGS_NOT_SET_UP };
const O = { kind: "company" as const, code: "90001", asOf: "2026-11-14", fromYear: 2020, toYear: 2025 };
type Rows = Partial<Record<StatFieldId, Partial<StatRow>[] | { error: string } | "unmapped">>;
function stat(rows: Rows, over: Partial<StatResult> = {}): StatResult {
  return {
    kind: "company", codes: ["90001"], fromYear: 2020, toYear: 2025, entities: [{ code: "90001", name: "Calloway Insurance Co" }], loaded: [], truncated: false, source: "x", ...over,
    fields: STAT_FIELDS.map((f) => {
      const r = rows[f.id], base = { id: f.id, label: f.label, unit: f.unit, by: f.by };
      if (r === undefined || r === "unmapped") return { ...base, mapped: false, error: null, rows: [] };
      if (!Array.isArray(r)) return { ...base, mapped: true, error: r.error, rows: [] };
      return { ...base, mapped: true, error: null, rows: r.map((x) => ({ code: "90001", year: 2025, line: null, state: null, value: null, ...x })) };
    }),
  };
}
const yearly = (vals: Record<number, number | null>) => Object.entries(vals).map(([y, v]) => ({ year: Number(y), value: v }));
const facts = (rows: Rows, over: Partial<typeof O> = {}, filings: P.FactsFilings = NOFIL) => P.factsFrom(stat(rows), DIR, filings, { ...O, ...over });

// ---------- figures worked out by year, against hand-worked numbers ----------
{
  const Y = [2022, 2023, 2024];
  const d = P.derive(Y, {
    dpw: [80, 100, 0], assumed_pw: [20, 10, 5], npw: [70, 60, 50], ceded_pw: [40, 50, null], surplus: [50, 100, -20], npe: [90, 0, 60], pyd: [9, 4, -3],
    rbc_tac: [60, 120, 40], rbc_acl: [20, 0, 10], cash_invested: [200, 300, 400], total_liabilities: [100, 0, 160], premiums_receivable: [8, 15, 2],
    bonds: [150, 240, 300], stocks: [30, 30, null], cash_short_term: [20, 30, 100], capital_contributed: [5, 0, 10], dividends_paid: [0, 3, null],
  });
  ok("gross premiums are direct plus assumed when gross isn't mapped", same(d.gross_pw, [100, 110, 5]), d.gross_pw);
  ok("cession share is the reported ceded premiums over gross: 40/100, 50/110", nearAll(d.cession_pct, [40, 45.4545, null]), d.cession_pct);
  ok("with ceded premiums missing, cession share is 1 - net / gross", nearAll(P.derive([2024], { gpw: [200], npw: [150] }).cession_pct, [25]) && nearAll(P.derive([2024], { dpw: [150], assumed_pw: [50], npw: [150] }).cession_pct, [25]));
  ok("a reported gross is used as it is, never replaced by direct plus assumed", !("gross_pw" in P.derive([2024], { gpw: [300], dpw: [100], assumed_pw: [5] })) && nearAll(P.derive([2024], { gpw: [300], dpw: [100], assumed_pw: [5], ceded_pw: [60] }).cession_pct, [20]));
  ok("net premiums to surplus: n/d for a negative surplus", nearAll(d.npw_to_surplus, [1.4, 0.6, null]), d.npw_to_surplus);
  ok("one-year development to prior surplus: first year n/d, then 4/50", nearAll(d.pyd_to_prior_surplus, [null, 8, -3]), d.pyd_to_prior_surplus);
  ok("one-year development to net premiums earned: 9/90; NPE of zero is n/d", nearAll(d.pyd_to_npe, [10, null, -5]), d.pyd_to_npe);
  ok("RBC ratio from total adjusted capital over authorized control level, when the ratio isn't reported; ACL of zero is n/d", nearAll(d.rbc_ratio_calc, [300, null, 400]), d.rbc_ratio_calc);
  ok("cash and invested assets to liabilities: liabilities of zero are n/d", nearAll(d.invested_to_liabilities, [2, null, 2.5]), d.invested_to_liabilities);
  ok("liabilities to surplus: 100/50, 0/100, negative surplus n/d", nearAll(d.liabilities_to_surplus, [2, 0, null]), d.liabilities_to_surplus);
  ok("premiums receivable to direct premiums: direct premiums of zero are n/d", nearAll(d.receivable_to_dpw, [10, 15, null]), d.receivable_to_dpw);
  ok("the mix of cash and invested assets", nearAll(d.bonds_share, [75, 80, 75]) && nearAll(d.stocks_share, [15, 10, null]) && nearAll(d.cash_share, [10, 10, 25]), [d.bonds_share, d.stocks_share, d.cash_share]);
  ok("growth on the previous year: n/d from a zero or negative base", nearAll(d.dpw_yoy, [null, 25, -100]) && nearAll(d.surplus_yoy, [null, 100, -120]) && nearAll(P.derive([2023, 2024], { surplus: [-10, 20] }).surplus_yoy ?? [null, null], [null, null]), [d.dpw_yoy, d.surplus_yoy]);
  ok("growth needs the previous calendar year: across a gap it is n/d", !("dpw_yoy" in P.derive([2021, 2023], { dpw: [10, 20] })));
  ok("capital paid in less dividends", same(d.net_capital_flow, [5, -3, null]), d.net_capital_flow);
  ok("return on equity and RBC worked out only from the figures there: none without their inputs", !("rbc_acl_implied" in d) && !("roae" in d));
  const r = P.derive([2024, 2025], { surplus: [40, 60], rbc_ratio: [400, 0] });
  ok("the implied control level is surplus divided by the ratio, when only the ratio is there; a ratio of zero is n/d", nearAll(r.rbc_acl_implied, [10, null]) && !("rbc_ratio_calc" in r), r);
  ok("…and isn't worked out when the control level is reported", !("rbc_acl_implied" in P.derive([2025], { surplus: [40], rbc_ratio: [400], rbc_acl: [9] })));
  ok("an RBC ratio that is reported isn't worked out again", !("rbc_ratio_calc" in P.derive([2025], { rbc_ratio: [350], rbc_tac: [60], rbc_acl: [20] })));
  const e = P.derive([2021, 2022, 2023, 2024, 2025], { net_income: [5, -8, 2, 6, 10], surplus: [100, 90, 95, 105, 120], combined_ratio: [96, 108, 103, 98, 94], npe: [100, 110, 120, 130, 140] });
  ok("return on average equity from net income and surplus: 2022 is -8 over (100+90)/2", nearAll(e.roae, [null, -8.4211, 2.1622, 6, 8.8889]), e.roae);
  ok("cumulative net income, and years above and at or below 100%", e.net_income_total === 15 && e.years_above_100 === 2 && e.years_below_100 === 3);
  ok("simple and premium-weighted averages of the combined ratio", near(e.combined_avg, 99.8) && near(e.combined_avg_weighted, (96 * 100 + 108 * 110 + 103 * 120 + 98 * 130 + 94 * 140) / 600), [e.combined_avg, e.combined_avg_weighted]);
  ok("a negative average surplus gives no return on equity", nearAll(P.derive([2024, 2025], { net_income: [1, 2], surplus: [-50, -40] }).roae ?? [null, null], [null, null]));
  const none = P.derive([2025], {});
  ok("with no figures there is nothing derived at all", same(none, {}));
  ok("a ratio with a zero divisor is never Infinity or NaN", Object.values(P.derive([2024, 2025], { dpw: [0, 0], premiums_receivable: [1, 1], cash_invested: [0, 0], bonds: [1, 1], total_liabilities: [0, 0], rbc_tac: [1, 1], rbc_acl: [0, 0] })).every((v) => !Array.isArray(v) || v.every((x) => x === null || Number.isFinite(x))));
}

// ---------- lines, states, recoverables, accident years and the run of years ----------
const LINES = ["Homeowners", "Commercial property", "Inland marine", "Other liability", "Allied lines", "Fire", "Earthquake", "Mobile homes"];
{
  const f = facts({
    surplus: yearly({ 2024: 40 * M, 2025: 50 * M }),
    dpw_by_line: LINES.map((n, i) => ({ year: 2025, line: n, value: (8 - i) * 10 * M })),
    npe_by_line: LINES.map((n, i) => ({ year: 2025, line: n, value: (8 - i) * 9 * M })),
    loss_lae_ratio_by_line: LINES.slice(0, 3).map((n, i) => ({ year: 2025, line: n, value: 60 + i })),
    dpw_by_state: [["FL", 50], ["TX", 30], ["LA", 20]].map(([s, v]) => ({ year: 2025, state: s as string, value: (v as number) * M })),
    loss_ratio_by_state: [{ year: 2025, state: "fl", value: 55.5 }],
    recoverable_by_reinsurer: [{ year: 2025, item: "Nonesuch Re", tag: "Authorized", value: 20 * M }, { year: 2025, item: "Tarrow Re", tag: "Unauthorized", value: 10 * M }, { year: 2025, item: "Nonesuch Specialty Re", tag: null, value: 5 * M }, { year: 2025, item: "Nonesuch Global Re", tag: "non-authorised", value: 5 * M }],
    ay_loss_ratio: [{ year: 2023, item: "2023", value: 60 }, { year: 2024, item: "2023", value: 64 }, { year: 2025, item: "2023", value: 66.5 }, { year: 2024, item: "2024", value: 70 }, { year: 2025, item: "2024", value: 68 }, { year: 2025, item: "2025", value: 59 }, { year: 2025, item: "2026", value: 1 }, { year: 2025, item: "AY total", value: 1 }],
    ay_npe: [{ year: 2025, item: "2023", value: 30 * M }, { year: 2025, item: "2024", value: 33 * M }],
  });
  const X = f.detail!;
  ok("eight lines: the five largest, then Other", same(X.lines!.items.map((l) => l.name), [...LINES.slice(0, 5), "Other"]) && X.lines!.by === "dpw" && X.lines!.year === 2025, X.lines);
  ok("each line's share of direct premiums: 80 of 360", near(X.lines!.items[0].share, 22.2222) && X.lines!.items[0].npe === 72 * M && X.lines!.items[0].lossRatio === 60 && X.lines!.items[3].lossRatio === null, X.lines!.items[0]);
  ok("Other adds up the rest and has no loss ratio (ratios aren't added up)", X.lines!.items[5].dpw === 60 * M && X.lines!.items[5].npe === 54 * M && X.lines!.items[5].lossRatio === null);
  ok("the five largest lines' share together: 300 of 360", near(X.lines!.top5Share, 83.3333), X.lines!.top5Share);
  ok("states keep their premiums, share and direct loss ratio; a lower-case state is upper-cased", same(X.states!.items.map((s) => [s.state, s.share, s.lossRatio]), [["FL", 50, 55.5], ["TX", 30, null], ["LA", 20, null]]) && X.states!.top5Share === 100, X.states);
  const R = X.recoverables!;
  ok("recoverables by reinsurer, largest first, each with its share and its share of surplus: 20 of 50", same(R.items.map((r) => r.name), ["Nonesuch Re", "Tarrow Re", "Nonesuch Specialty Re", "Nonesuch Global Re"]) && R.items[0].share === 50 && R.items[0].toSurplus === 40 && R.total === 40 * M, R.items);
  ok("the share owed by reinsurers marked as not authorized (unauthorized, non-authorised), and with no tag", R.tagged && R.unauthorizedShare === 37.5 && R.untaggedShare === 12.5, R);
  ok("unauthorizedTag reads the usual spellings and nothing else", P.unauthorizedTag("Unauthorized") && P.unauthorizedTag("NOT AUTHORIZED") && P.unauthorizedTag("non-authorised") && P.unauthorizedTag("Nonauthorized") && !P.unauthorizedTag("Authorized") && !P.unauthorizedTag("Certified") && !P.unauthorizedTag(null));
  const A = X.accidentYears!;
  ok("accident years, as each statement year reported them, lined up with the years shown", same(f.years, [2023, 2024, 2025]) && same(A.rows.map((r) => [r.ay, r.values]), [[2023, [60, 64, 66.5]], [2024, [null, 70, 68]], [2025, [null, null, 59]]]), A.rows);
  ok("an accident year later than its statement, or a row that isn't a year, is left out", !A.rows.some((r) => r.ay === 2026));
  ok("first reported, latest and the change in points: 2023 from 60 to 66.5 is +6.5; 2024 from 70 to 68 is -2", same(A.rows.map((r) => [r.first, r.firstYear, r.latest, r.latestYear, r.change]), [[60, 2023, 66.5, 2025, 6.5], [70, 2024, 68, 2025, -2], [59, 2025, 59, 2025, null]]), A.rows);
  ok("one statement only gives no change; the worst change and how many are worse", A.worst === 6.5 && A.worse === 1);
  ok("each accident year's net premiums earned, from the latest statement", same(A.rows.map((r) => r.npe), [30 * M, 33 * M, null]));
  ok("every new figure that gave something is not listed as missing", ["npe_by_line", "loss_lae_ratio_by_line", "loss_ratio_by_state", "recoverable_by_reinsurer", "ay_loss_ratio", "ay_npe"].every((id) => !f.missing.some((m) => m.field === id)), f.missing.map((m) => m.field));
  ok("the facts say which figures are worked out, in words", ["detail.lines.items.share", "detail.recoverables.unauthorizedShare", "detail.accidentYears.rows.change"].every((k) => typeof X.derived[k] === "string") && !("detail.combinedRun" in X.derived), Object.keys(X.derived));
  ok("only derived figures that are there are listed", Object.keys(X.derived).every((k) => k in P.DERIVED_WORDS) && !("derived.rbc_ratio_calc" in X.derived) && "derived.recoverable_to_surplus" in X.derived === false);

  const untagged = facts({ recoverable_by_reinsurer: [{ year: 2025, item: "Nonesuch Re", value: 5 }] }).detail!.recoverables!;
  ok("without tags, no authorization share is claimed: n/d", untagged.tagged === false && untagged.unauthorizedShare === null && untagged.untaggedShare === null && untagged.items[0].toSurplus === null);
  const negSurplus = facts({ surplus: yearly({ 2025: -1 * M }), recoverable_by_reinsurer: [{ year: 2025, item: "Nonesuch Re", value: 5 }] }).detail!.recoverables!;
  ok("recoverables to a negative surplus are n/d", negSurplus.items[0].toSurplus === null);
  const onlyDpw = facts({ dpw_by_line: [{ year: 2025, line: "Homeowners", value: 5 }], dpw_by_state: [{ year: 2025, state: "FL", value: 5 }] });
  ok("premiums by line and state alone add no detail (the premium mix already shows them)", !onlyDpw.detail!.lines && !onlyDpw.detail!.states);
  const npeOnly = facts({ npe_by_line: [{ year: 2025, line: "Fire", value: 3 }, { year: 2025, line: "Homeowners", value: 9 }] });
  ok("without direct premiums by line, lines are ranked by net premiums earned and shares are of that", npeOnly.detail!.lines!.by === "npe" && same(npeOnly.detail!.lines!.items.map((l) => [l.name, l.share]), [["Homeowners", 75], ["Fire", 25]]));
  const grp = P.factsFrom(stat({ loss_lae_ratio_by_line: [{ line: "Fire", value: 60 }, { line: "Fire", value: 70 }], npe_by_line: [{ line: "Fire", value: 1 }, { line: "Fire", value: 2 }], ay_loss_ratio: [{ item: "2025", value: 50 }, { item: "2025", value: 55 }] }, { kind: "group", codes: ["9001"] }), DIR, NOFIL, { ...O, kind: "group", code: "9001" });
  ok("for a group, ratios by line or accident year that differ by member can't be added up: missing, with the reason; dollars are added up", /can't be added up/.test(grp.missing.find((m) => m.field === "loss_lae_ratio_by_line")!.reason) && /can't be added up/.test(grp.missing.find((m) => m.field === "ay_loss_ratio")!.reason) && grp.detail!.lines!.items[0].npe === 3 && grp.detail!.lines!.items[0].lossRatio === null && !grp.detail!.accidentYears);

  const run = (cr: (number | null)[], years = [2021, 2022, 2023, 2024, 2025]) => facts({ combined_ratio: cr.map((v, i) => ({ year: years[i], value: v })) }).detail!.combinedRun;
  ok("the run of years: the last two at or below 100%", same(run([104, 108, 101, 99, 95]), { above: false, years: 2, from: 2024, to: 2025 }));
  ok("the run of years: three above 100%, a latest year missing skipped", same(run([95, 101, 102, 103, null]), { above: true, years: 3, from: 2022, to: 2024 }));
  ok("exactly 100% counts as at or below", same(run([100, 100]), { above: false, years: 2, from: 2021, to: 2022 }));
  ok("a run stops at a gap in the years", same(run([101, 102, 103], [2021, 2023, 2024]), { above: true, years: 2, from: 2023, to: 2024 }));
  ok("no combined ratio, no run", facts({}).detail!.combinedRun === undefined);
}

// ---------- the facts with all figures, none, a ragged mix, and before this change ----------
function within(t: P.ProfileText): string[] {
  const bad: string[] = [];
  const L = P.LIMITS, chk = (s: string, max: number, where: string) => { if (typeof s !== "string" || !s.trim() || s.length > max) bad.push(`${where}: ${s?.length}`); if (/\u2014/.test(s)) bad.push(`${where}: em dash`); };
  chk(t.cover.subtitle, L.subtitle, "subtitle");
  for (const s of P.SECTIONS) {
    chk(t[s].title, L.title, `${s}.title`);
    const [min, max] = P.POINT_COUNTS[s];
    if (t[s].points.length < min || t[s].points.length > max) bad.push(`${s}: ${t[s].points.length} points`);
    t[s].points.forEach((p, i) => { chk(p.lead, L.lead, `${s}.${i}.lead`); chk(p.text, L.point, `${s}.${i}.text`); });
  }
  if (t.questions.items.length !== 4) bad.push(`questions: ${t.questions.items.length}`);
  return bad;
}
const strings = (t: P.ProfileText) => [t.cover.subtitle, ...P.SECTIONS.flatMap((s) => [t[s].title, ...t[s].points.flatMap((p) => [p.lead, p.text])]), ...t.questions.items.flatMap((q) => [q.title, q.text])];
const figuresMatch = (f: P.Facts, t: P.ProfileText) => { const a = P.allowedFigures(f); return strings(t).map((s) => P.unmatched(s, a)).filter((u) => u.length); };
const S = P.sampleFacts("2026-11-14");
{
  ok("the sections: summary, premium, underwriting, earnings, balance sheet, capital, reserves, reinsurance, filings", same(P.SECTIONS, ["summary", "premium", "underwriting", "earnings", "balance", "capital", "reserves", "reinsurance", "filings"]));
  ok("earnings and the balance sheet have the same limits as the other sections", same(P.POINT_COUNTS.earnings, [2, 4]) && same(P.POINT_COUNTS.balance, [2, 4]));
  const t = P.plainText(S);
  ok("the sample's plain text is complete, within every limit, and every figure in it matches the facts", within(t).length === 0 && figuresMatch(S, t).length === 0, [within(t), figuresMatch(S, t)]);
  ok("earnings: underwriting gain, investment income with its yield and realized gains, net income with return on equity, cash", same(t.earnings.points.map((p) => p.lead), ["Underwriting", "Investments", "Net income", "Cash"]) && t.earnings.points[0].text === "Net underwriting gain of $6.4M in 2025." && t.earnings.points[1].text === "Net investment income of $5.6M in 2025, a yield of 3.5% on invested assets; net realized capital gains of $0.6M." && /Return on average equity of 15\.1% in 2025\.$/.test(t.earnings.points[2].text) && t.earnings.points[3].text === "Net cash from operations of $12.9M in 2025.", t.earnings.points);
  ok("a reported return on equity isn't marked derived", !/15\.1% in 2025 \(derived\)/.test(t.earnings.points[2].text));
  ok("balance sheet: invested assets and their mix (derived), liabilities, leverage, receivables", t.balance.points[0].text === "Cash and invested assets of $169.3M at the end of 2025: bonds 73.0%, common stocks 10.9%, cash and short-term 13.5% (derived)." && t.balance.points[1].text.includes("cash and invested assets were 1.0x liabilities (derived)") && t.balance.points[2].text.startsWith("Total liabilities were 2.9x surplus at the end of 2025 (derived)") && t.balance.points[3].text === "Premiums receivable of $24.1M at the end of 2025, 19.7% of direct premiums written (derived).", t.balance.points);
  ok("premium: assumed premiums, ceded premiums as reported (not derived), loss ratios on the largest line and state", /Assumed premiums written of \$6\.9M in 2025\./.test(t.premium.points[0].text) && t.premium.points[1].text === "Net premiums written of $79.6M in 2025, after ceding $49.8M." && /loss and LAE ratio on homeowners was 60\.0% in 2025/.test(t.premium.points[2].text) && /direct loss ratio in FL was 56\.1% in 2025/.test(t.premium.points[3].text), t.premium.points);
  ok("underwriting: the commission ratio, and the run of years", /; commission ratio 14\.9%\.$/.test(t.underwriting.points[1].text) && t.underwriting.points[3].text === "The combined ratio was at or below 100% in each of the last 2 years, 2024 to 2025 (derived).", t.underwriting.points);
  ok("capital: dividends and surplus notes, and RBC with its capital and control level", t.capital.points[1].text === "Dividends of $3.0M in 2025; surplus notes of $5.0M at the end of the year." && t.capital.points[2].text === "Risk-based capital ratio of 431.0% at the end of 2025; total adjusted capital $56.3M against an authorized control level of $13.1M.", t.capital.points);
  ok("reserves: two-year development, and the accident year that moved most, in percentage points (derived)", /Two-year development was favourable, \$0\.9M, in 2025\./.test(t.reserves.points[2].text) && t.reserves.points[3].text === "Accident year 2022's loss and DCC ratio went from 70.1% first reported in 2022 to 77.0% in 2025, up 6.9 percentage points (derived).", t.reserves.points);
  ok("reinsurance: ceded as reported, and the share owed by reinsurers not authorized (derived)", t.reinsurance.points[0].text === "Ceded $49.8M in 2025, 38.5% of gross premiums written (derived)." && t.reinsurance.points[3].text === "18.0% of recoverables at the end of 2025 were owed by reinsurers marked as not authorized, and 0.5% by reinsurers with no status given (derived).", t.reinsurance.points);
  ok("the questions: the figures first, then an accident year that has developed badly, then one from the filings, still exactly four", same(t.questions.items.map((q) => q.title), ["Underwriting losses", "Concentration", "Accident year development", "Withdrawals"]), t.questions.items.map((q) => q.title));

  const none = P.plainText(facts({}));
  ok("with no figures, every new section is there, n/d, within limits", within(none).length === 0 && none.earnings.points.every((p) => /n\/d/.test(p.text)) && none.balance.points.every((p) => /n\/d/.test(p.text)), [within(none), none.earnings, none.balance]);

  // ragged: every set of the new figures switched on or off in 64 groups, with the old ones on or off too
  const all = STAT_FIELDS.map((f) => f.id);
  const raw = (id: StatFieldId): Partial<StatRow>[] => {
    const meta = STAT_FIELDS.find((f) => f.id === id)!;
    if (meta.by === "year") return (S.series[id as P.SeriesId] ?? []).map((v, k) => ({ year: S.years[k], value: v }));
    if (id === "ay_loss_ratio") return S.detail!.accidentYears!.rows.flatMap((r) => r.values.map((v, k) => ({ year: S.years[k], item: String(r.ay), value: v })));
    if (id === "ay_npe") return S.detail!.accidentYears!.rows.map((r) => ({ year: 2025, item: String(r.ay), value: r.npe }));
    if (meta.by === "item") return S.detail!.recoverables!.items.map((r) => ({ year: 2025, item: r.name, tag: r.tag, value: r.recoverable }));
    if (meta.by === "line") return S.detail!.lines!.items.map((l) => ({ year: 2025, line: l.name, value: meta.unit === "pct" ? l.lossRatio : l.npe ?? l.dpw }));
    return S.detail!.states!.items.map((s) => ({ year: 2025, state: s.state, value: meta.unit === "pct" ? s.lossRatio : s.dpe ?? s.dpw }));
  };
  let worst: string[] = [], badFig: unknown[] = [], n = 0;
  for (let mask = 0; mask < 128; mask++) {
    const rows: Rows = {};
    all.forEach((id, i) => { if ((mask >> (i % 7)) & 1) rows[id] = raw(id); });
    const f = facts(rows, {}, mask % 3 ? NOFIL : S.filings), t = P.plainText(f);
    const b = within(t); if (b.length) worst = b;
    const u = figuresMatch(f, t); if (u.length) badFig = u;
    n++;
  }
  ok(`for ${n} ragged sets of figures the plain text is always complete, within limits, and its figures match the facts`, worst.length === 0 && badFig.length === 0, { worst, badFig });

  // accident years held as S&P holds them: an offset from the statement year, "AY(0)" down to "AY(-9)", with a
  // "Prior(10+)" row and a row with no accident year, both left out
  {
    const asYear = facts({ ay_loss_ratio: raw("ay_loss_ratio"), ay_npe: raw("ay_npe") }).detail!.accidentYears!;
    const off = (ay: number, y: number) => (ay === y ? "AY(0)" : `AY(${ay - y})`);
    const lr = S.detail!.accidentYears!.rows.flatMap((r) => r.values.map((v, k) => ({ year: S.years[k], item: off(r.ay, S.years[k]), value: v }))).filter((r) => r.value !== null);
    const npe = S.detail!.accidentYears!.rows.map((r) => ({ year: 2025, item: off(r.ay, 2025), value: r.npe }));
    const extra = [{ year: 2025, item: "Prior(10+)", value: 12.3 }, { year: 2025, item: null, value: 45.6 }, { year: 2025, item: "AY(1)", value: 7.8 }, { year: 2025, item: "AY(-3) x", value: 9.1 }];
    const asOffset = facts({ ay_loss_ratio: [...lr, ...extra], ay_npe: npe }).detail!.accidentYears!;
    ok("accident years given as offsets from the statement year read the same as four-digit years", same(asOffset, asYear) && asYear.rows.length > 0, [asOffset, asYear]);
    ok("a prior-years row, a row with no accident year, a year after the statement and a malformed offset are left out", asOffset.rows.every((r) => r.ay >= 2019 && r.ay <= 2025));
  }

  // facts and text saved before this change
  const old = JSON.parse(await Deno.readTextFile(new URL("../fixtures/profile_facts.json", import.meta.url)));
  ok("facts saved before this change have no detail and still give the whole plain text, within limits", old.facts.detail === undefined && within(P.plainText(old.facts)).length === 0 && figuresMatch(old.facts, P.plainText(old.facts)).length === 0, within(P.plainText(old.facts)));
  ok("their allowed figures and the check of Claude's text still work", P.unmatched("Combined ratio of 93.4% in 2025.", P.allowedFigures(old.facts)).length === 0);
  const oldText = JSON.parse(JSON.stringify(old.text));
  delete oldText.earnings; delete oldText.balance;
  ok("a text saved before this change (no earnings or balance sheet) still reads as a past answer", P.answerLines(old.facts, oldText).length > 5 && !P.answerLines(old.facts, oldText).some((l) => /^## (Earnings|Balance sheet)/.test(l.text)));
}

// ---------- the sample ----------
{
  ok("the sample has every figure by year, five values each, and nothing is missing", P.SERIES.every((id) => S.series[id]?.length === 5) && S.missing.length === 0);
  ok("the sample has every part of the detail", !!(S.detail!.lines && S.detail!.states && S.detail!.recoverables && S.detail!.accidentYears && S.detail!.combinedRun));
  ok("its made-up figures agree: gross is direct plus assumed, ceded is gross less net, liabilities are assets less surplus", S.series.gpw!.every((v, i) => near(v!, S.series.dpw![i]! + S.series.assumed_pw![i]!, 1)) && S.series.ceded_pw!.every((v, i) => near(v!, S.series.gpw![i]! - S.series.npw![i]!, 1)) && S.series.total_liabilities!.every((v, i) => near(v!, S.series.total_assets![i]! - S.series.surplus![i]!, 1)));
  ok("its reinsurers are made up: Nonesuch, Tarrow, Calloway or Other only", S.detail!.recoverables!.items.every((r) => /^(Nonesuch|Tarrow|Calloway|Other)/.test(r.name)));
  ok("its accident years run from 2019 to 2025", same(S.detail!.accidentYears!.rows.map((r) => r.ay), [2019, 2020, 2021, 2022, 2023, 2024, 2025]));
}

// ---------- Claude: the shape, the prompt and the check of the new sections ----------
function count(schemas: unknown[]) {
  let unions = 0, optional = 0; const unsupported: string[] = [];
  const walk = (s: any) => {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.type)) unions++;
    if (s.anyOf) { unions++; s.anyOf.forEach(walk); }
    if (s.oneOf) unsupported.push("oneOf");
    for (const k of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "pattern", "minItems", "maxItems"]) if (k in s) unsupported.push(k);
    if (s.type === "object" && s.additionalProperties !== false) unsupported.push("an object left open");
    if (s.properties) { const req = new Set(s.required ?? []); for (const [k, v] of Object.entries(s.properties)) { if (!req.has(k)) optional++; walk(v); } }
    if (s.items) walk(s.items);
  };
  schemas.forEach(walk);
  return { unions, optional, unsupported };
}
{
  const c = count([P.TEXT_SCHEMA]);
  ok("the text shape, with the new sections, is inside Anthropic's limits: no unions, nothing optional, nothing unsupported", c.unions <= SCHEMA_LIMITS.unions && c.optional <= SCHEMA_LIMITS.optional && c.unions === 0 && c.optional === 0 && c.unsupported.length === 0, c);
  ok("it asks for every section, the new ones included", P.DRAFT_SYSTEM.includes(`in this order: ${[...P.SECTIONS, "questions"].join(", ")}`) && P.SECTIONS.includes("earnings") && P.SECTIONS.includes("balance"));
  ok("the instructions name the new sections, keep exactly 4 questions, and say detail figures are derived", /earnings \(underwriting gain/.test(P.DRAFT_SYSTEM) && /balance \(the balance sheet/.test(P.DRAFT_SYSTEM) && /exactly 4 key diligence questions/.test(P.DRAFT_SYSTEM) && /facts\.detail\.derived lists/.test(P.DRAFT_SYSTEM) && !P.DRAFT_SYSTEM.includes("\u2014"));
  ok("Claude sees only the facts: no deal words in the prompt but the rules against them", !/pipeline|banker|target price/i.test(P.draftPrompt(S)) && P.draftPrompt(S).includes('"detail"'));
  const plain = P.plainText(S);
  const good: any = JSON.parse(JSON.stringify(plain)); delete good.by; delete good.note;
  good.earnings = { title: "Underwriting gain of $6.4M in 2025", points: [{ lead: "Investments", text: "Net investment income of $5.6M in 2025." }, { lead: "Cash", text: "Net cash from operations of $12.9M in 2025." }] };
  good.balance = { title: "Bonds are 73.0% of invested assets (derived)", points: [{ lead: "Mix", text: "Bonds 73.0% and common stocks 10.9% of cash and invested assets (derived)." }, { lead: "Leverage", text: "Total liabilities were 2.9x surplus in 2025 (derived)." }] };
  const r = P.checkDraft(good, S, plain);
  ok("Claude's new sections are used when their figures match", r.text.by === "claude" && r.text.earnings.title === "Underwriting gain of $6.4M in 2025" && r.text.balance.points.length === 2 && r.replaced.kept === P.SECTIONS.length + 2, r.replaced);
  const bad: any = JSON.parse(JSON.stringify(good));
  bad.earnings.points[0].text = "Net investment income of $9.9M in 2025.";
  delete bad.balance;
  const r2 = P.checkDraft(bad, S, plain);
  ok("a new section with a figure that isn't in the facts, or left out, falls back to the plain text", same(r2.text.earnings, plain.earnings) && same(r2.text.balance, plain.balance) && r2.replaced.figures === 1 && r2.replaced.shape === 1 && r2.text.note === `${P.NOTES.figures} ${P.NOTES.shape}`, r2.replaced);
  ok("a figure written from the detail passes: an accident year change in points, a reinsurer's share of surplus", P.unmatched("Accident year 2022 is up 6.9 percentage points (derived); Nonesuch Re is 17.8% of surplus (derived).", P.allowedFigures(S)).length === 0);
  ok("a made-up accident year or share fails", P.unmatched("Accident year 2017 was 50.0%.", P.allowedFigures(S)).length === 2);
  const lines = P.answerLines(S, plain).map((l) => l.text);
  ok("the saved answer carries the new sections under their names", lines.some((l) => l.startsWith("## Earnings: ")) && lines.some((l) => l.startsWith("## Balance sheet: ")));
}

done();
