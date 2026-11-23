// "The compiled grammar is too large": on 23 Nov 2026 Anthropic refused every full profile's text request with this 400,
// so every profile fell back to the plain text. This suite covers the fix:
//   - both profiles now ask for one generic list of sections, and the code checks what the shape used to (which
//     sections, their order does not matter, how many points, how long each text is, exactly 4 questions);
//   - the text and the slides come out the same for the samples as from the older shape;
//   - the safety net: a 400 that refuses the shape or the strict tools is tried once more without the constraint
//     (the profile drafts, a summary on request, the comparison table, Ask Claude), only that kind of 400 is retried,
//     and when both tries fail the page still says what happened with Anthropic's own reason;
//   - query_statutory takes field ids as plain text, checked in code, and answers a wrong one with the valid ids.
// Made-up companies and a stand-in for Anthropic's API throughout; nothing real is called.
(globalThis as any).__SNL_TEST__ = true;
const P = await import(new URL("../../supabase/functions/_shared/profile.ts", import.meta.url).href);
const D = await import(new URL("../../supabase/functions/_shared/digest.ts", import.meta.url).href);
const C = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { forgetTokens } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import { checks, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, type Reply, req, say, toolResults, toolUse } from "./helpers/fakes.ts";
import { goodRaw } from "./helpers/digests.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const EM_DASH = String.fromCharCode(0x2014), ELLIPSIS = String.fromCharCode(0x2026);
const quiet = async <T>(work: () => Promise<T>): Promise<T> => { const keep = console.error; console.error = () => {}; try { return await work(); } finally { console.error = keep; } };
const GRAMMAR = "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";
const refuse = (message = GRAMMAR): Reply => ({ error: { status: 400, type: "invalid_request_error", message } } as any);
const formatOf = (body: any) => body.output_config?.format;
const userText = (body: any) => { const c = body.messages.at(-1).content; return typeof c === "string" ? c : (c as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n"); };

/** A profile's text (plain or Claude's) in the generic shape Claude is now asked for. */
function toWire(t: any, ids: readonly string[]) {
  return { subtitle: t.cover.subtitle, sections: [...ids.map((id) => ({ id, title: t[id].title, points: t[id].points })), { id: "questions", title: t.questions.title, points: t.questions.items.map((q: any) => ({ lead: q.title, text: q.text })) }] };
}
/** The same text in the older shape, one field for each section. */
function toOld(t: any) { const o = structuredClone(t); delete o.by; delete o.note; return o; }

// ---------- the generic shape and the checks in code ----------
const S = P.sampleFacts("2026-11-14"), PLAIN = P.plainText(S);
{
  ok("both profiles ask for the same small shape: a subtitle and a list of sections, each an id, a title and points",
    P.TEXT_SCHEMA === P.FP_TEXT_SCHEMA && same(P.TEXT_SCHEMA.required, ["subtitle", "sections"]) && same(P.TEXT_SCHEMA.properties.sections.items.required, ["id", "title", "points"]) && same(P.TEXT_SCHEMA.properties.sections.items.properties.points.items.required, ["lead", "text"]));
  ok("the shape has no bounds, enums or unions: each is checked in code", !/minItems|maxItems|minLength|maxLength|pattern|enum|anyOf|"null"/.test(JSON.stringify(P.TEXT_SCHEMA)));
  ok("the instructions say how to write it, naming every section in order and the 4 questions", P.DRAFT_SYSTEM.includes(`in this order: ${[...P.SECTIONS, "questions"].join(", ")}`) && /exactly 4 key diligence questions/.test(P.DRAFT_SYSTEM) && /lead is the question's short title/.test(P.DRAFT_SYSTEM) && !P.DRAFT_SYSTEM.includes(EM_DASH) && !P.FP_DRAFT_SYSTEM.includes(EM_DASH));

  const viaWire = P.checkDraft(toWire(PLAIN, P.SECTIONS), S, PLAIN), viaOld = P.checkDraft(toOld(PLAIN), S, PLAIN);
  ok("the sample's text comes out the same through the new shape as through the old one, so the slides are the same", same(viaWire, viaOld) && viaWire.text.by === "claude" && viaWire.replaced.kept === P.SECTIONS.length + 2 && viaWire.replaced.shape === 0, viaWire.replaced);
  ok("and it is the sample's text itself", same({ ...viaWire.text, by: 0, note: 0 }, { ...PLAIN, by: 0, note: 0 }));
  ok("an answer in the old shape still passes through unchanged", same(P.draftFromWire(toOld(PLAIN), P.SECTIONS), toOld(PLAIN)) && P.draftFromWire(null, P.SECTIONS) === null && P.draftFromWire("x", P.SECTIONS) === "x");

  // a made-up Claude answer, every figure from the sample, so only the shape decides what is kept
  const pt = (n: number, text = "Surplus of $56.3M at the end of 2025 (inferred).") => Array.from({ length: n }, (_, i) => ({ lead: `Point ${i + 1}`, text }));
  const good = () => ({ subtitle: "Florida homeowners insurer with $122.5M of direct premiums in 2025",
    sections: [...P.SECTIONS.map((id: string) => ({ id, title: `Combined ratio of 91.5% in 2025, ${id}`, points: pt(id === "summary" ? 6 : 3) })), { id: "questions", title: "Key questions", points: pt(4, "What drove the 104.4% combined ratio in 2022?") }] });
  const g = P.checkDraft(good(), S, PLAIN);
  ok("a good answer in the new shape is kept whole, with no note", g.text.by === "claude" && g.text.note === null && g.replaced.kept === P.SECTIONS.length + 2 && g.text.questions.items.length === 4 && g.text.questions.items[0].title === "Point 1", g.replaced);
  ok("section order in the list doesn't matter", same(P.checkDraft({ ...good(), sections: [...good().sections].reverse() }, S, PLAIN), g));

  const withSections = (f: (s: any[]) => any[]) => { const a: any = good(); a.sections = f(a.sections); return P.checkDraft(a, S, PLAIN); };
  const wrongId = withSections((s) => s.map((x) => (x.id === "premium" ? { ...x, id: "premiums" } : x)));
  ok("a wrong section id: that section is the plain one, and the note says some text didn't fit", same(wrongId.text.premium, PLAIN.premium) && wrongId.replaced.shape === 1 && wrongId.text.note === P.NOTES.shape, wrongId.replaced);
  const missing = withSections((s) => s.filter((x) => x.id !== "reserves"));
  ok("a missing section: the plain one", same(missing.text.reserves, PLAIN.reserves) && missing.replaced.shape === 1);
  const twice = withSections((s) => [...s, { id: "capital", title: "Second capital", points: pt(3) }]);
  ok("a section given twice: the first is kept", twice.text.capital.title.endsWith("capital") && twice.text.capital.title !== "Second capital" && twice.replaced.shape === 0);
  const hostile = withSections((s) => [{ id: "__proto__", title: "x", points: pt(3) }, { id: "constructor", title: "x", points: pt(3) }, { id: "cover", title: "x", points: pt(3) }, ...s]);
  ok("ids that aren't sections are ignored, hostile ones included", same(hostile, g) && ({} as any).title === undefined);
  const few = withSections((s) => s.map((x) => (x.id === "underwriting" ? { ...x, points: pt(1) } : x)));
  ok("too few points: the plain section", same(few.text.underwriting, PLAIN.underwriting) && few.replaced.shape === 1);
  const many = withSections((s) => s.map((x) => (x.id === "summary" ? { ...x, points: pt(9) } : x.id === "earnings" ? { ...x, points: pt(6) } : x)));
  ok("too many points: cut to the most a slide takes (7 in the summary, 4 elsewhere)", many.text.summary.points.length === 7 && many.text.earnings.points.length === 4 && many.replaced.shape === 0);
  const q3 = withSections((s) => s.map((x) => (x.id === "questions" ? { ...x, points: pt(3) } : x)));
  ok("three questions: the plain questions", same(q3.text.questions, PLAIN.questions) && q3.replaced.shape === 1);
  const q5 = withSections((s) => s.map((x) => (x.id === "questions" ? { ...x, points: pt(5, "What drove the 104.4% combined ratio in 2022?") } : x)));
  ok("five questions: the first four", q5.text.questions.items.length === 4 && q5.replaced.shape === 0);
  const long = withSections((s) => s.map((x) => (x.id === "balance" ? { ...x, title: "y".repeat(300), points: x.points.map((p: any) => ({ lead: "z".repeat(90), text: p.text + " More words.".repeat(40) })) } : x)));
  const L = P.LIMITS;
  ok("over-long text is cut to its limit: title, lead and point", long.text.balance.title.length <= L.title && long.text.balance.points.every((p: any) => p.lead.length <= L.lead && p.text.length <= L.point) && long.text.balance.title.endsWith(ELLIPSIS));
  const longQ = withSections((s) => s.map((x) => (x.id === "questions" ? { ...x, points: pt(4).map((p) => ({ lead: "q".repeat(200), text: "What drove the 104.4% combined ratio in 2022?".repeat(20) })) } : x)));
  ok("an over-long question is cut to the question limits", longQ.text.questions.items.every((q: any) => q.title.length <= L.qTitle && q.text.length <= L.qText));
  const badPoint = withSections((s) => s.map((x) => (x.id === "filings" ? { ...x, points: [...pt(2), { lead: 5, text: null }] } : x)));
  ok("a point that isn't a lead and a text: the plain section", same(badPoint.text.filings, PLAIN.filings) && badPoint.replaced.shape === 1);
  const figure = withSections((s) => s.map((x) => (x.id === "capital" ? { ...x, points: pt(3, "Surplus grew 35.7% since 2021.") } : x)));
  ok("every figure is still checked: one not in the facts sends that section back to plain", same(figure.text.capital, PLAIN.capital) && figure.replaced.figures === 1);
  for (const [name, raw] of [["no sections and a blank subtitle", { subtitle: " ", sections: [] }], ["sections that aren't objects", { subtitle: 5, sections: [1, "x", null] }]] as const) {
    const r = P.checkDraft(raw, S, PLAIN);
    ok(`an answer with ${name} gives the plain text, by "plain", with a note`, r.text.by === "plain" && r.text.note.startsWith(P.NOTES.unusable));
  }
}

// ---------- the filings profile: the same shape, its own sections ----------
const FS = P.filingsSampleFacts("2026-11-19"), FPLAIN = P.filingsPlainText(FS);
{
  const viaWire = P.checkFilingsDraft(toWire(FPLAIN, P.FP_SECTIONS), FS, FPLAIN), viaOld = P.checkFilingsDraft(toOld(FPLAIN), FS, FPLAIN);
  ok("the filings sample's text comes out the same through the new shape as through the old one", same(viaWire, viaOld) && viaWire.text.by === "claude" && viaWire.replaced.shape === 0, viaWire.replaced);
  ok("the filings instructions name its 11 sections and the questions, in order", P.FP_DRAFT_SYSTEM.includes(`in this order: ${[...P.FP_SECTIONS, "questions"].join(", ")}`));
  const w: any = toWire(FPLAIN, P.FP_SECTIONS);
  w.sections = w.sections.filter((s: any) => s.id !== "regulator").map((s: any) => (s.id === "states" ? { ...s, id: "premium" } : s));
  const r = P.checkFilingsDraft(w, FS, FPLAIN);
  ok("a full-profile id in a filings profile, and a missing section: both plain", same(r.text.states, FPLAIN.states) && same(r.text.regulator, FPLAIN.regulator) && r.replaced.shape === 2, r.replaced);
}

// ---------- the safety net on the profile drafts ----------
const dctx = (fetch: typeof globalThis.fetch, timeMs = 5000) => ({ env: env({ ANTHROPIC_API_KEY: "k" }), anthropicFetch: fetch, timeMs, spRequests: 0 });
const wireReply = (t: any, ids: readonly string[], wrap = (s: string) => s): Reply => ({ content: [say(wrap(JSON.stringify(toWire(t, ids))))], usage: { input_tokens: 4000, output_tokens: 900 } });
{
  const c = fakeAnthropic([refuse(), wireReply(PLAIN, P.SECTIONS)]);
  const out: any = await quiet(() => P.draftText(S, dctx(c.fetch)));
  const [a, b] = c.calls.map((x) => x.body);
  ok("refused with this exact message, the profile is asked for once more, and Claude's text is used", c.calls.length === 2 && out.text.by === "claude" && out.text.note === null, { calls: c.calls.length, note: out.text.note });
  ok("the first try sends the shape as structured output; the second sends none and asks for the JSON in its prompt", formatOf(a)?.type === "json_schema" && same(formatOf(a).schema, P.TEXT_SCHEMA) && formatOf(b) === undefined && b.output_config.effort === "medium" && userText(b).includes("Reply with only one JSON object") && userText(b).includes(JSON.stringify(P.TEXT_SCHEMA)));
  ok("the second try is otherwise the same request: model, system prompt, facts, fallback and limit", a.model === b.model && a.system === b.system && userText(b).startsWith(userText(a)) && a.max_tokens === b.max_tokens && same(a.fallbacks, b.fallbacks) && c.calls[1].betas === c.calls[0].betas && c.calls[1].stream);
  ok("the cost counts the reply that was billed (a refused request isn't billed)", out.usage.inputTokens === 4000 && out.usage.outputTokens === 900, out.usage);
  ok("the text is the same as the shaped request would have given", same({ ...out.text, by: 0, note: 0 }, { ...PLAIN, by: 0, note: 0 }));
}
{
  const c = fakeAnthropic([refuse(), wireReply(PLAIN, P.SECTIONS, (s) => "Here is the text.\n```json\n" + s + "\n```")]);
  const out: any = await quiet(() => P.draftText(S, dctx(c.fetch)));
  ok("without the shape, JSON with words or a code fence around it is still read", out.text.by === "claude" && c.calls.length === 2);
  const c2 = fakeAnthropic([refuse(), { content: [say("Sorry, no JSON here.")] }]);
  const out2: any = await quiet(() => P.draftText(S, dctx(c2.fetch)));
  ok("without the shape, a reply with no JSON gives the plain text and says Claude's text couldn't be used", out2.text.by === "plain" && out2.text.note === P.NOTES.unusable);
}
{
  const c = fakeAnthropic([refuse(), refuse()]);
  const out: any = await quiet(() => P.draftText(S, dctx(c.fetch)));
  ok("refused both times: the plain text, with the note the owner saw, Anthropic's own reason included", c.calls.length === 2 && out.text.by === "plain" && out.text.note.startsWith(P.NOTES.refused) && out.text.note.includes("Anthropic said (400): The compiled grammar is too large"), out.text.note);
  ok("the note has no em dash", !out.text.note.includes(EM_DASH));
}
for (const msg of ["Schema is too complex for compilation.", "Too many optional parameters in strict schemas (30 > 24).", "output_config.format.schema: Too many parameters with union types"]) {
  const c = fakeAnthropic([refuse(msg), wireReply(PLAIN, P.SECTIONS)]);
  const out: any = await quiet(() => P.draftText(S, dctx(c.fetch)));
  ok(`the earlier shape complaints are retried too: "${msg.slice(0, 40)}"`, c.calls.length === 2 && out.text.by === "claude");
}
for (const [what, reply] of [["a different 400", refuse("messages.0.content: Input should be a valid list")], ["busy (429)", { error: { status: 429, type: "rate_limit_error", message: "slow down" } }], ["overloaded (529)", { error: { status: 529, type: "overloaded_error", message: "Overloaded" } }], ["a bad key (401)", { error: { status: 401, type: "authentication_error", message: "no" } }]] as const) {
  const c = fakeAnthropic([reply as any, wireReply(PLAIN, P.SECTIONS)]);
  const out: any = await quiet(() => P.draftText(S, dctx(c.fetch)));
  ok(`${what} is not retried: one request, the plain text and its own reason`, c.calls.length === 1 && out.text.by === "plain" && !!out.text.note, { calls: c.calls.length, note: out.text.note });
}
{
  const c = fakeAnthropic([refuse(), wireReply(FPLAIN, P.FP_SECTIONS)]);
  const out: any = await quiet(() => P.draftFilingsText(FS, dctx(c.fetch)));
  ok("the filings profile has the same safety net", c.calls.length === 2 && out.text.by === "claude" && formatOf(c.calls[1].body) === undefined && userText(c.calls[1].body).includes(JSON.stringify(P.FP_TEXT_SCHEMA)) && c.calls[1].body.system === P.FP_DRAFT_SYSTEM);
}
{
  ok("only a 400 that names the shape, grammar or strict tools counts as a shape refusal", D.schemaRefused(Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: GRAMMAR } }, "400", new Headers()))
    && !D.schemaRefused(Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } }, "400", new Headers()))
    && !D.schemaRefused(Anthropic.APIError.generate(500, { type: "error", error: { type: "api_error", message: "grammar service failed" } }, "500", new Headers()))
    && !D.schemaRefused(new Error(GRAMMAR)));
}

// ---------- a summary on request ----------
async function pdfOf(n: number) { const doc = await PDFDocument.create({ updateMetadata: false }); for (let i = 0; i < n; i++) doc.addPage([612, 792]); return await doc.save({ useObjectStreams: false }); }
const front = await D.frontPages(await pdfOf(30), C.LIMITS.sendBytes);
const meta = D.metaFrom({ trackingNumber: "CALL-FL-1", companyName: "Calloway Home Co", serffFilingStateId: "FL", serffFilingType: "Rate", pages: 30, documentId: 71000001 });
const mctx = (fetch: typeof globalThis.fetch) => ({ env: env({ ANTHROPIC_API_KEY: "k" }), anthropicFetch: fetch, timeMs: 5000, now: () => Date.parse("2026-11-23T05:00:00Z"), spRequests: 1 });
{
  const c = fakeAnthropic([refuse(), { content: [say("```json\n" + JSON.stringify(goodRaw()) + "\n```")], usage: { input_tokens: 50_000, output_tokens: 1_500 } }]);
  const out: any = await quiet(() => D.makeDigest(front, meta, mctx(c.fetch)));
  const b = c.calls[1]?.body;
  ok("a summary refused over its shape is asked for once more without it, and saved", c.calls.length === 2 && out.problem === null && out.digest?.forms?.length === 2, out.problem);
  ok("the second try carries the same document and asks for the JSON in its prompt; the file is deleted once", formatOf(b) === undefined && userText(b).includes(JSON.stringify(D.DIGEST_SCHEMA)) && b.messages[0].content[0].source.file_id === c.calls[0].body.messages[0].content[0].source.file_id && c.uploads.length === 1 && c.deleted.length === 1);
  ok("its cost counts the billed reply", out.usage.inputTokens === 50_000 && out.usage.outputTokens === 1_500, out.usage);
  const c2 = fakeAnthropic([refuse(), refuse()]);
  const out2: any = await quiet(() => D.makeDigest(front, meta, mctx(c2.fetch)));
  ok("refused twice: no summary, the site's fault, with Anthropic's reason", c2.calls.length === 2 && out2.digest === null && out2.problem.startsWith(D.MAKE_NOTES.refused) && out2.problem.includes("The compiled grammar is too large"));
  const c3 = fakeAnthropic([refuse("bad document"), { content: [say(JSON.stringify(goodRaw()))] }]);
  const out3: any = await quiet(() => D.makeDigest(front, meta, mctx(c3.fetch)));
  ok("another 400 isn't retried", c3.calls.length === 1 && out3.digest === null && out3.problem.includes("bad document"));
}

// ---------- the comparison table ----------
{
  const st = () => ({ ...C.newState("Q", [], "2026-11-23"), final: { answer: [{ text: "Calloway Home Co filed form CHO 30 01 in FL.", cites: [] }], sources: [] } });
  const TABLE = { needs_table: true, title: "Forms", columns: ["Company", "Form number"], rows: [{ cells: ["Calloway Home Co", "CHO 30 01"] }], notes: [] };
  const c = fakeAnthropic([refuse(), { content: [say("```json\n" + JSON.stringify(TABLE) + "\n```")] }]);
  const s1 = st();
  const t: any = await quiet(() => C.buildTable(C.makeClient({ env: env({ ANTHROPIC_API_KEY: "k" }), anthropicFetch: c.fetch }), "claude-test-model", "Q", s1));
  ok("the table refused over its shape is asked for once more without it, and built", c.calls.length === 2 && same(t?.rows, [["Calloway Home Co", "CHO 30 01"]]) && formatOf(c.calls[0].body)?.type === "json_schema" && formatOf(c.calls[1].body) === undefined && userText(c.calls[1].body).includes(JSON.stringify(C.TABLE_SCHEMA)));
  ok("only the billed reply is counted", s1.outputTokens === 200, s1.outputTokens);
  const c2 = fakeAnthropic([refuse(), refuse()]);
  let threw: unknown = null;
  try { await quiet(() => C.buildTable(C.makeClient({ env: env({ ANTHROPIC_API_KEY: "k" }), anthropicFetch: c2.fetch }), "m", "Q", st())); } catch (e) { threw = e; }
  ok("refused twice: the failure goes to the caller, which notes the table couldn't be built", c2.calls.length === 2 && D.schemaRefused(threw));
  const c3 = fakeAnthropic([refuse("bad"), { content: [say(JSON.stringify(TABLE))] }]);
  try { await quiet(() => C.buildTable(C.makeClient({ env: env({ ANTHROPIC_API_KEY: "k" }), anthropicFetch: c3.fetch }), "m", "Q", st())); } catch { /* expected */ }
  ok("another 400 isn't retried", c3.calls.length === 1);
}

// ---------- Ask Claude: the strict tools ----------
const NO_TABLE: Reply = { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] };
function world(script: Parameters<typeof fakeAnthropic>[0]) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock), claude = fakeAnthropic(script);
  const pending: Promise<unknown>[] = [];
  const deps = { env: env({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "test-anthropic-key" }), fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: async () => ({ id: "login-1", role: "reader" }), db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const ask = async (question: string) => {
    const res: Response = await chat.handle(req("snl-chat", { action: "ask", question }), deps);
    const jobId = (await res.json()).jobId as string;
    while (pending.length) await pending.shift();
    return db.jobs.get(jobId)!;
  };
  return { claude, ask };
}
{
  ok("query_statutory's fields are plain text, its description lists every id, and its other inputs are as before", (() => {
    const t = C.TOOLS.find((x: any) => x.name === "query_statutory"), f = t.input_schema.properties.fields;
    return t.strict === true && f.type === "array" && f.items.type === "string" && !("enum" in f.items) && same(t.input_schema.properties.kind.enum, ["company", "group"]) && f.description.includes("surplus") && f.description.includes("loss_lae_ratio");
  })());
  ok("field ids are read with spacing and capitals ignored, and unknown ones picked out", same(C.statFieldsFrom([" Surplus", "loss_ratio", "premiums_total", 7]), { fields: ["surplus", "loss_ratio"], bad: ["premiums_total", "7"] }) && same(C.statFieldsFrom(undefined), { fields: [], bad: [] }));
  ok("the loose tools are the same tools, same order and inputs, with strict off", same(C.LOOSE_TOOLS.map((t: any) => t.name), C.TOOLS.map((t: any) => t.name)) && C.LOOSE_TOOLS.every((t: any, i: number) => !("strict" in t) && same(t.input_schema, C.TOOLS[i].input_schema) && t.description === C.TOOLS[i].description) && C.TOOLS.every((t: any) => t.strict === true));
}
{
  const w = world([refuse(), { content: [toolUse("t1", "query_statutory", { kind: "company", naic_codes: ["10001"], from_year: 2021, to_year: 2025, fields: ["surplus", "premiums_total"] })] }, { content: [say("Done.")] }, NO_TABLE]);
  const job = await quiet(() => w.ask("What is Calloway Insurance Co's surplus?"));
  const [a, b, c] = w.claude.calls.map((x) => x.body);
  ok("Ask Claude refused over its strict tools carries on with the same tools, strict off, and answers", job.status === "done" && w.claude.calls.length === 4, { status: job.status, error: job.error, calls: w.claude.calls.length });
  ok("the first try sends strict tools; the retry the same tools with strict off; and strict stays off for the rest of the answer", a.tools.every((t: any) => t.strict === true) && same(b.tools, C.LOOSE_TOOLS) && same(c.tools, C.LOOSE_TOOLS) && same(a.messages, b.messages) && same(a.system, b.system));
  const res = toolResults(c).t1;
  ok("an unknown field id from Claude is refused with the valid ids, and nothing is run", res?.isError === true && /These aren't field ids: premiums_total/.test(JSON.stringify(res.value)) && JSON.stringify(res.value).includes("loss_lae_ratio"), res);
}
{
  const w = world([refuse(), refuse()]);
  const job = await quiet(() => w.ask("Q"));
  ok("refused twice: the answer stops, saying it is the site's fault, with Anthropic's own reason", job.status === "error" && w.claude.calls.length === 2 && String(job.error).startsWith(C.CHAT_REFUSED.refused) && String(job.error).includes("Anthropic said (400): The compiled grammar is too large") && !String(job.error).includes(EM_DASH), job.error);
  const w2 = world([refuse("messages.1: something else"), { content: [say("Done.")] }, NO_TABLE]);
  const job2 = await quiet(() => w2.ask("Q"));
  ok("another 400 isn't retried and keeps its old words", job2.status === "error" && w2.claude.calls.length === 1 && job2.error === "Claude couldn't read this conversation. Start a new conversation and ask again.", job2.error);
}

done();
