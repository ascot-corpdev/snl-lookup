// Anthropic's limits on fixed shapes, and what a failed request to Claude is called.
//
// Structured output and strict tools are refused with a 400 when the shapes in one request have more than 16 fields
// that may be empty (a union type), more than 24 optional fields, or more than 20 strict tools (Anthropic's
// documentation, "Schema complexity limits", read 19 Nov 2026). On 18 Nov 2026 the summary shape had 39 such fields,
// every summary was refused, and the page said "Claude couldn't be reached". This suite counts every shape the app
// sends, so a shape that grows past a limit fails here and not on the live site; checks the smaller shape now sent
// for a summary gives the same saved summary as before; and checks each kind of failure gets its own plain words.
// Made-up filings and a stand-in for Anthropic's API throughout.
(globalThis as any).__SNL_TEST__ = true;
const D = await import(new URL("../../supabase/functions/_shared/digest.ts", import.meta.url).href);
const C = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
const P = await import(new URL("../../supabase/functions/_shared/profile.ts", import.meta.url).href);
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { checks, env, fakeAnthropic, say } from "./helpers/fakes.ts";
import { goodRaw } from "./helpers/digests.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const READ = [{ from: 1, to: 150 }];
const quiet = async (work: () => Promise<unknown>): Promise<any> => { const keep = console.error; console.error = () => {}; try { return await work(); } finally { console.error = keep; } };

// ---------- counting a shape the way Anthropic's limits do ----------
function count(schemas: unknown[]) {
  let unions = 0, optional = 0; const unsupported: string[] = [];
  const walk = (s: any) => {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.type)) unions++;
    if (s.anyOf) { unions++; if (s.type || s.properties) unsupported.push("anyOf beside type or properties"); s.anyOf.forEach(walk); }
    if (s.oneOf) unsupported.push("oneOf");
    for (const k of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "pattern", "minItems", "maxItems"]) if (k in s) unsupported.push(k);
    if (s.type === "object" && s.additionalProperties !== false) unsupported.push("an object left open");
    if (s.properties) { const req = new Set(s.required ?? []); for (const [k, v] of Object.entries(s.properties)) { if (!req.has(k)) optional++; walk(v); } }
    if (s.items) walk(s.items);
  };
  schemas.forEach(walk);
  return { unions, optional, unsupported: [...new Set(unsupported)] };
}
{
  ok("the counter counts a type list and an anyOf as one union each, and a field left out of required as optional",
    same(count([{ type: "object", properties: { a: { type: ["string", "null"] }, b: { anyOf: [{ type: "string" }, { type: "null" }] }, c: { type: "string" } }, required: ["a", "b"], additionalProperties: false }]), { unions: 2, optional: 1, unsupported: [] }));
  ok("the limits are Anthropic's documented ones", same(D.SCHEMA_LIMITS, { unions: 16, optional: 24, strictTools: 20 }));

  const L = D.SCHEMA_LIMITS;
  const within = (c: { unions: number; optional: number; unsupported: string[] }) => c.unions <= L.unions && c.optional <= L.optional && c.unsupported.length === 0;

  const digest = count([D.DIGEST_SCHEMA]);
  ok("a summary's shape is inside the limits, with room to spare (at most 10 of the 16 unions, nothing optional)", within(digest) && digest.unions <= 10 && digest.optional === 0, digest);
  ok("the shape it replaced was not: the after-answer shape, which is never sent as structured output, has 39", count([D.AFTER_SCHEMA.properties.digests.items]).unions === 39);

  const strict = (C.TOOLS as any[]).filter((t) => t.strict);
  const tools = count(strict.map((t) => t.input_schema));
  ok("Claude's tools, counted together as one request sends them, are inside the limits", strict.length <= L.strictTools && within(tools), { strict: strict.length, ...tools });

  ok("the profile's text shape is inside the limits", within(count([P.TEXT_SCHEMA])), count([P.TEXT_SCHEMA]));
  ok("the filings profile's text shape is inside the limits", within(count([P.FP_TEXT_SCHEMA])), count([P.FP_TEXT_SCHEMA]));
}

// ---------- the smaller shape gives the same summary ----------
const MORE = {
  indicatedPct: 12.4, maxPct: 15, minPct: -5, lossCostChangePct: 3.2, lossCostMultiplier: 1.25, targetLossRatio: 62.5, projectedLossRatio: 71.8, lossTrendPct: 6.5, expensePct: 27.4, profitPct: 5, exposures: 4380,
};
const PAGES: Record<string, number> = { indicatedPct: 14, maxPct: 22, minPct: 22, lossCostChangePct: 9, lossCostMultiplier: 9, targetLossRatio: 14, projectedLossRatio: 14, lossTrendPct: 15, expensePct: 16, profitPct: 16, exposures: 3 };
const REF = "Nonesuch Rating Bureau circular NRB-HO-2025-01";
const BASIS = "Overall rate change 9.8%. Written premium affected $1.2 million. 4,210 policyholders; 4,380 house-years. Effective 01/01/2027. Indicated change 12.4%; capped at +15.0% and -5.0% for any policyholder. "
  + "Adopts Nonesuch Rating Bureau circular NRB-HO-2025-01 loss costs (+3.2%) with a loss cost multiplier of 1.250. Permissible loss ratio 62.5%; projected loss and LAE ratio 71.8%; annual loss trend 6.5%; expenses 27.4%; profit and contingencies 5.0%.";
/** The same made-up summary twice: as it is checked and saved, and as the API is asked to write it. */
function both() {
  const base = goodRaw();
  const stored = goodRaw({
    forms: (base.forms as any[]).map((f) => ({ ...f, program: null })),
    rate: { ...(base.rate as object), basis: BASIS, ...MORE, lossCostRef: REF, pages: { ...PAGES, lossCostRef: 9 } },
  });
  const wire = goodRaw({
    forms: (base.forms as any[]).map((f) => ({ ...f, replaces: f.replaces ?? "", program: "" })),
    rate: {
      overallPct: 9.8, requestedPct: 9.8, approvedPct: null, premium: 1200000, policyholders: 4210, effectiveNew: "2027-01-01", effectiveRenewal: "", basis: BASIS, page: 3,
      more: Object.entries(MORE).map(([name, value]) => ({ name, value, page: PAGES[name] })),
      lossCostRefs: [{ text: REF, page: 9 }],
    },
  });
  return { stored, wire };
}
{
  const { stored, wire } = both();
  const a = D.checkDigest(stored, READ), b = D.checkDigest(D.digestFromWire(wire), READ);
  ok("an answer in the shape sent to the API checks to exactly the same summary as the same answer in the saved shape", a.fields !== null && same(a.fields, b.fields) && same(a.dropped, b.dropped), { a: a.fields?.rate, b: b.fields?.rate });
  ok("every extra figure arrived with its own page, and the reference with its page", Object.keys(MORE).every((k) => b.fields.rate[k] === (MORE as any)[k] && b.fields.rate.pages[k] === PAGES[k]) && b.fields.rate.lossCostRef === REF && b.fields.rate.pages.lossCostRef === 9, b.fields.rate);

  const back: any = D.digestFromWire(wire);
  ok("an empty text becomes null: a form's replaces and program, an effective date", back.forms[0].replaces === null && back.forms[0].program === null && back.forms[1].replaces === "HO 04 95" && back.rate.effectiveRenewal === null && back.rate.effectiveNew === "2027-01-01");
  ok("the lists themselves are gone from what is checked", !("more" in back.rate) && !("lossCostRefs" in back.rate));

  const none: any = D.digestFromWire({ ...wire, rate: { ...(wire.rate as object), more: [], lossCostRefs: [], basis: "" } });
  ok("a filing that gives none of the extra figures: each is null, the reference is null, and an empty basis is null", Object.keys(MORE).every((k) => none.rate[k] === null) && none.rate.lossCostRef === null && none.rate.basis === null);

  const odd: any = D.digestFromWire({ ...wire, rate: { ...(wire.rate as object), more: [{ name: "indicatedPct", value: 12.4, page: 14 }, { name: "indicatedPct", value: 99, page: 15 }, { name: "notAFigure", value: 1, page: 1 }, null, "x", { name: 7, value: 1, page: 1 }], lossCostRefs: [{ text: "  ", page: 2 }, { text: REF, page: 9 }] } });
  ok("a figure listed twice keeps its first entry; a name that isn't a figure, and entries that aren't objects, are ignored; a blank reference is skipped", odd.rate.indicatedPct === 12.4 && odd.rate.pages.indicatedPct === 14 && !("notAFigure" in odd.rate) && odd.rate.lossCostRef === REF && odd.rate.pages.lossCostRef === 9);

  ok("an answer already in the saved shape passes through unchanged, so nothing older breaks", same(D.digestFromWire(stored), stored) && same(D.digestFromWire(goodRaw()), goodRaw()));
  ok("something that isn't an answer passes through", D.digestFromWire(null) === null && D.digestFromWire("x") === "x" && same(D.digestFromWire([1]), [1]) && same(D.digestFromWire({ summary: "x", rate: null }), { summary: "x", forms: undefined, rate: null }));

  const hostile: any = D.digestFromWire({ ...wire, rate: { ...(wire.rate as object), more: [{ name: "__proto__", value: 1, page: 1 }, { name: "constructor", value: 1, page: 1 }, { name: "pages", value: 1, page: 1 }] } });
  ok("a hostile name can't reach anything but a figure", ({} as any).polluted === undefined && typeof hostile.rate.pages === "object" && hostile.rate.pages.indicatedPct === null && hostile.rate.constructor === Object);
}

// ---------- the rules say how to write the smaller shape ----------
{
  ok("the instructions for a summary on request carry the rules and then how to write them in this shape", D.DIGEST_SYSTEM.includes(D.DIGEST_RULES) && D.DIGEST_SYSTEM.endsWith(D.WIRE_RULES) && D.RATE_MORE_KEYS.every((k: string) => D.WIRE_RULES.includes(k)) && /rate\.more is a list/.test(D.WIRE_RULES) && /rate\.lossCostRefs is a list/.test(D.WIRE_RULES) && !D.WIRE_RULES.includes("—"));
  ok("the after-answer request, which has no structured output, keeps the saved shape and never mentions the lists", !D.afterAnswerPrompt(["1. CALL-FL-1"]).includes("rate.more") && !JSON.stringify(D.AFTER_SCHEMA).includes("lossCostRefs"));
}

// ---------- end to end: a reply in the smaller shape is saved as a full summary ----------
async function pdfOf(n: number) { const doc = await PDFDocument.create({ updateMetadata: false }); for (let i = 0; i < n; i++) doc.addPage([612, 792]); return await doc.save({ useObjectStreams: false }); }
const front = await D.frontPages(await pdfOf(30), C.LIMITS.sendBytes);
const meta = D.metaFrom({ trackingNumber: "CALL-FL-1", companyName: "Calloway Home Co", serffFilingStateId: "FL", serffFilingType: "Rate", pages: 30, documentId: 71000001 });
const ctx = (fetch: typeof globalThis.fetch) => ({ env: env({ ANTHROPIC_API_KEY: "k" }), anthropicFetch: fetch, timeMs: 5000, now: () => Date.parse("2026-11-19T05:00:00Z"), spRequests: 1 });
{
  const { wire } = both();
  let seen: any = null;
  const claude = fakeAnthropic([(body) => { seen = body; return { content: [say(JSON.stringify(wire))], usage: { input_tokens: 90_000, output_tokens: 2_000 } }; }]);
  const out: any = await D.makeDigest(front, meta, ctx(claude.fetch));
  ok("the request carries the smaller shape and its instructions", same(seen.output_config.format.schema, D.DIGEST_SCHEMA) && count([seen.output_config.format.schema]).unions <= 10 && String(seen.system).includes("rate.more is a list"));
  ok("the reply is saved as a version 2 summary with every extra figure, its page, and the loss cost reference", out.problem === null && out.digest.v === D.DIGEST_VERSION && out.digest.rate.indicatedPct === 12.4 && out.digest.rate.lossCostMultiplier === 1.25 && out.digest.rate.pages.lossCostMultiplier === 9 && out.digest.rate.lossCostRef === REF && out.digest.rate.overallPct === 9.8 && out.digest.forms.length === 2 && out.digest.forms[0].replaces === null, { problem: out.problem, rate: out.digest?.rate });
  ok("a figure the quoted words don't support is still dropped, as before", (await quiet(async () => {
    const bad = { ...wire, rate: { ...(wire.rate as any), more: [{ name: "indicatedPct", value: 55.5, page: 14 }] } };
    const c = fakeAnthropic([{ content: [say(JSON.stringify(bad))] }]);
    return D.makeDigest(front, meta, ctx(c.fetch));
  })).digest.rate.indicatedPct === undefined);
}

// ---------- each kind of failure in its own words ----------
{
  const N = D.MAKE_NOTES;
  const cases: [string, unknown, (p: string) => boolean][] = [
    ["a request Anthropic refuses (400)", { error: { status: 400, type: "invalid_request_error", message: "Schema is too complex for compilation." } }, (p) => p.startsWith(N.refused) && p.endsWith("Anthropic said (400): Schema is too complex for compilation.")],
    ["a model that doesn't exist (404)", { error: { status: 404, type: "not_found_error", message: "model: claude-nothing" } }, (p) => p.startsWith(N.refused) && p.includes("(404): model: claude-nothing")],
    ["Anthropic failing (500)", { error: { status: 500, type: "api_error", message: "oops" } }, (p) => p === N.overloaded],
    ["Anthropic overloaded (529)", { error: { status: 529, type: "overloaded_error", message: "Overloaded" } }, (p) => p === N.overloaded],
    ["busy (429)", { error: { status: 429, type: "rate_limit_error", message: "busy" } }, (p) => p === N.busy],
    ["a bad key (401)", { error: { status: 401, type: "authentication_error", message: "no" } }, (p) => p === N.key],
  ];
  for (const [what, reply, right] of cases) {
    const c = fakeAnthropic([reply as any]);
    const o: any = await quiet(() => D.makeDigest(front, meta, ctx(c.fetch)));
    ok(`${what}: no summary, the right plain reason, and the upload still deleted`, o.digest === null && right(o.problem) && c.deleted.length === 1, o.problem);
  }
  const refusedText: any = (await quiet(() => D.makeDigest(front, meta, ctx(fakeAnthropic([{ error: { status: 400, type: "invalid_request_error", message: "bad" } } as any]).fetch)))).problem;
  ok("a refused request is never called \"couldn't be reached\", and says it is the site's fault, not the filing's", !/couldn't be reached/.test(refusedText) && /fault in the site, not in the filing/.test(refusedText));

  const noConnection = new Anthropic.APIConnectionError({ message: "Connection error." });
  ok("only a failure to connect is \"couldn't be reached\"", D.claudeProblem(noConnection, N) === N.unreachable);
  ok("a fault in the site's own code says so", D.claudeProblem(new TypeError("x is not a function"), N) === N.fault && D.claudeProblem("text", N) === N.fault);
  const long = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "a\u0000b\n" + "x".repeat(600) } }, "400", new Headers());
  const said = D.claudeProblem(long, N);
  ok("Anthropic's reason is cut to 240 characters with control characters taken out", said.length <= N.refused.length + 30 + 240 && !/[\u0000-\u001f]/.test(said) && said.includes("a b x"));
  ok("the words are plain: no em dashes, and each ends with what to do", Object.values(N).every((t) => !String(t).includes("—")) && /Try again/.test(N.overloaded) && /tell the site owner/i.test(N.refused) && /Tell the site owner/.test(N.fault));

  ok("the profile's text request uses the same reasons, each saying the plain text is shown", P.NOTES.overloaded.includes("plain text is shown") && P.NOTES.refused.includes("plain text is shown") && P.NOTES.fault.includes("plain text is shown")
    && D.claudeProblem(long, P.NOTES).startsWith(P.NOTES.refused) && D.claudeProblem(noConnection, P.NOTES) === P.NOTES.unreachable);
}

done();
