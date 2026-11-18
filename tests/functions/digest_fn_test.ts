// The snl-digest function (Contract B): status, get, make and search; a login required; the daily limit, one answer at
// a time, not set up, too large, unreadable; a saved summary given back free and made again only on refresh; the cost
// recorded as one question; search by form number with any spacing and punctuation, by title, program and words, in a
// state, newest first; and the table not set up. Made-up filings and fake services throughout.
(globalThis as any).__SNL_TEST__ = true;
const fn = await import(new URL("../../supabase/functions/snl-digest/index.ts", import.meta.url).href);
const D = await import(new URL("../../supabase/functions/_shared/digest.ts", import.meta.url).href);
const { forgetTokens } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
import { PDFDocument, PDFName, PDFNumber } from "npm:pdf-lib@1.17.1";
import { checks, digestTables, env, fakeAnthropic, fakeClock, J, memoryDb, nobody, type Reply, req, say } from "./helpers/fakes.ts";
import { filing, spStub } from "./helpers/more.ts";
import { goodRaw } from "./helpers/digests.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SECRETS = { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "test-anthropic-key" };
const quiet = async (work: () => Promise<unknown>): Promise<any> => { const keep = console.error; console.error = () => {}; try { return await work(); } finally { console.error = keep; } };

async function pdfOf(n: number) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 1; i <= n; i++) doc.addPage([612, 792]).node.set(PDFName.of("SNLTestPage"), PDFNumber.of(i));
  return await doc.save({ useObjectStreams: false });
}
const PDF624 = await pdfOf(624), PDF12 = await pdfOf(12);
const ROW = (i: number, over: Record<string, unknown> = {}) => filing(i, { trackingNumber: "", sfcNumber: `CAL000000${i}`, companyName: "Calloway Home Co", pages: 624, ...over });

function world(o: { secrets?: Record<string, string>; script?: (Reply | ((b: any) => Reply))[]; docs?: Record<number, { bytes: Uint8Array; type?: string; length?: string }>; who?: any; tables?: boolean } = {}) {
  forgetTokens();
  const clock = fakeClock("2026-11-18T05:00:00Z"), db: any = memoryDb(clock), digests = digestTables(clock);
  if (o.tables !== false) Object.assign(db, digests);
  const claude = fakeAnthropic(o.script ?? []);
  const sp = spStub(clock, (call) => {
    if (call.path === "/api/v1/download") {
      const d = (o.docs ?? {})[call.body.properties.documentId];
      if (!d) return J({ status: 404, error: "Not Found", message: "Resource not found" }, 404);
      return new Response(d.bytes as unknown as BodyInit, { status: 200, headers: { "content-type": d.type ?? "application/pdf", "content-length": d.length ?? String(d.bytes.length) } });
    }
    return J({ status: 404, error: "Not Found", message: "no" }, 404);
  });
  const deps = { env: env(o.secrets ?? SECRETS), fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: o.who ?? (async () => ({ id: "login-digest", role: "reader" })), db, sleep: clock.sleep, claudeMs: 5000 };
  const call = async (body: unknown) => { const r: Response = await fn.handle(req("snl-digest", body), deps); return { status: r.status, body: await r.json() }; };
  return { clock, db, digests, claude, sp, call, downloads: () => sp.calls("/api/v1/download").length };
}
const save = async (w: ReturnType<typeof world>, i: number, over: Record<string, unknown> = {}, at = "2026-11-18T05:00:00.000Z", raw = goodRaw()) => {
  const meta = D.metaFrom(ROW(i, over));
  const d = D.buildDigest(meta, D.checkDigest(raw, [{ from: 1, to: 150 }]).fields, [{ from: 1, to: 150 }], at);
  await w.digests.putDigest(D.digestRow(d, D.digestId(d)));
  return d;
};

// ---------- a login is required ----------
{
  const w = world({ who: nobody });
  const r = await w.call({ action: "status" });
  ok("no login: 401 and nothing done", r.status === 401 && r.body.error === "signin" && w.digests.gets.length === 0);
  const bad = await world().call({ nope: 1 });
  ok("an unknown action is refused plainly", bad.status === 400 && bad.body.message === "Unknown action. Use status, get, make or search.");
}

// ---------- status ----------
{
  const w = world();
  await save(w, 1); await save(w, 2);
  const r = await w.call({ action: "status" });
  ok("status: whether Claude and S&P are set up, and how many summaries are saved", r.status === 200 && same(r.body, { claude: { configured: true }, filings: { configured: true }, saved: 2 }), r.body);
  const off = await world({ secrets: {} }).call({ action: "status" });
  ok("status with nothing set up still answers", off.status === 200 && same(off.body, { claude: { configured: false }, filings: { configured: false }, saved: 0 }), off.body);
  const w2 = world(); w2.digests.fail = 'relation "public.snl_digests" does not exist';
  const nt = await w2.call({ action: "status" });
  ok("the table not there (migration 0005 not run): 503 no_tables, saying which migration to run", nt.status === 503 && nt.body.error === "no_tables" && nt.body.message.includes("0005_filing_digests.sql"), nt.body);
  const w3 = world({ tables: false });
  ok("a database without the summaries' methods says the same", (await w3.call({ action: "get", filings: [{ documentId: 1 }] })).body.error === "no_tables");
}

// ---------- get ----------
{
  const w = world();
  const d1 = await save(w, 1), d2 = await save(w, 2, { documentId: null });
  const r = await w.call({ action: "get", filings: [{ documentId: d1.documentId }, { filingVersionId: d2.filingVersionId }, { documentId: 99, filingVersionId: "0B0B0B0B-0000-4000-8000-000000000099" }, { documentId: "71000001" }] });
  ok("get: the saved summaries, found by document id or version id, each once", r.status === 200 && r.body.digests.length === 2 && same(r.body.digests.map((d: any) => d.filingNo), ["S&P no. CAL0000001", "S&P no. CAL0000002"]), r.body);
  ok("get: the filings with none are listed as asked", same(r.body.missing, [{ documentId: 99, filingVersionId: "0B0B0B0B-0000-4000-8000-000000000099" }]), r.body.missing);
  ok("get costs nothing: no S&P request and no Claude call, and isn't counted as a question", w.downloads() === 0 && w.claude.calls.length === 0 && w.db.jobs.size === 0);
  ok("get takes at most 50 filings", (await w.call({ action: "get", filings: Array.from({ length: 51 }, (_, i) => ({ documentId: i + 1 })) })).status === 400);
  ok("get needs filings, each with a usable id", (await w.call({ action: "get", filings: [] })).status === 400 && (await w.call({ action: "get", filings: [{ documentId: "x; drop table" }] })).status === 400 && (await w.call({ action: "get" })).status === 400);
  const w2 = world();
  const d3 = await save(w2, 3), later = await save(w2, 3, { documentId: null }, "2026-11-19T05:00:00.000Z", goodRaw({ summary: "The newer reading." }));
  const r2 = await w2.call({ action: "get", filings: [{ documentId: d3.documentId, filingVersionId: d3.filingVersionId }] });
  ok("a filing saved twice gives its newest summary", r2.body.digests.length === 1 && r2.body.digests[0].summary === "The newer reading." && later.madeAt > d3.madeAt, r2.body.digests);
}

// ---------- make ----------
{
  const w = world({ docs: { [71000001]: { bytes: PDF624 } }, script: [{ content: [say(JSON.stringify(goodRaw()))], usage: { input_tokens: 600_000, output_tokens: 3_000 } }] });
  const r = await w.call({ action: "make", filing: { ...ROW(1), extra: "ignored" } });
  ok("make: one S&P request, one Claude request, the digest back and not from the store", r.status === 200 && r.body.fromStore === false && w.downloads() === 1 && w.claude.calls.length === 1, r.body);
  ok("the digest says it rests on pages 1 to 150 of 624", same(r.body.digest.read, [{ from: 1, to: 150 }]) && r.body.digest.pages === 624 && r.body.digest.filingNo === "S&P no. CAL0000001" && r.body.digest.state === "FL", r.body.digest);
  ok("it is saved under the filing's version id, with the columns search uses", w.digests.rows.size === 1 && [...w.digests.rows.keys()][0] === "v:0B0B0B0B-0000-4000-8000-000000000001" && [...w.digests.rows.values()][0].form_keys === " CHO3001 CHO3107 " && [...w.digests.rows.values()][0].pages_read === 150);
  const job = [...w.db.jobs.values()][0];
  ok("it counts as one question: a finished answer with its cost recorded, as a profile's text is", w.db.jobs.size === 1 && job.status === "done" && job.question === "Summary of filing S&P no. CAL0000001" && (job.result as any).usage.costUsd === 2.46 && (job.result as any).usage.spRequests === 2, job);
  ok("the answer line says what was read", (job.result as any).answer[0].text.startsWith("Summary of filing S&P no. CAL0000001, made by Claude from pages 1 to 150 of 624."));
  ok("the cost comes back to the page too", r.body.usage.costUsd === 2.46 && r.body.usage.inputTokens === 600_000);
  ok("the download, and the sign-in before it, went through the shared counter", w.db.slots.length === 2 && w.sp.log.filter((c: any) => c.path === "token").length === 1);
  const again = await w.call({ action: "make", filing: ROW(1) });
  ok("a saved summary is given back at once, free: no S&P request, no Claude call, not counted", again.status === 200 && again.body.fromStore === true && again.body.usage === null && w.downloads() === 1 && w.claude.calls.length === 1 && w.db.jobs.size === 1, again.body);
  const byOther = await w.call({ action: "make", filing: { documentId: 71000001 } });
  ok("it is found by its document id alone too", byOther.body.fromStore === true);
}
{
  const w = world({ docs: { [71000001]: { bytes: PDF624 } }, script: [{ content: [say(JSON.stringify(goodRaw({ summary: "Read again." })))] }] });
  await save(w, 1);
  const r = await w.call({ action: "make", filing: ROW(1), refresh: true });
  ok("refresh makes it again and replaces the saved one, under the same key", r.status === 200 && r.body.fromStore === false && r.body.digest.summary === "Read again." && w.digests.rows.size === 1 && (w.digests.rows.get("v:0B0B0B0B-0000-4000-8000-000000000001")!.doc as any).summary === "Read again." && w.downloads() === 1);
}
{
  const w = world({ docs: { [71000002]: { bytes: PDF12 } }, script: [{ content: [say(JSON.stringify(goodRaw({ programs: [], forms: [], rate: { ...goodRaw().rate, page: 3 }, eligibility: [], notable: [{ text: "Short.", page: 12 }] })))] }] });
  const r = await w.call({ action: "make", filing: ROW(2, { pages: 12, filingVersionId: null }) });
  ok("a short filing is read whole, and a filing with no version id is saved under its document id", r.status === 200 && same(r.body.digest.read, [{ from: 1, to: 12 }]) && w.digests.rows.has("d:71000002"), { read: r.body.digest?.read, keys: [...w.digests.rows.keys()] });
}

// ---------- make: refused before any work ----------
{
  const nk = world({ secrets: { SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass" } });
  const a = await nk.call({ action: "make", filing: ROW(1) });
  ok("no Anthropic key: not_configured, nothing spent", a.status === 503 && a.body.error === "not_configured" && a.body.message.startsWith("Claude isn't connected yet.") && nk.downloads() === 0);
  const ns = world({ secrets: { ANTHROPIC_API_KEY: "k" } });
  const b = await ns.call({ action: "make", filing: ROW(1) });
  ok("no S&P credentials: not_configured, nothing spent", b.status === 503 && b.body.error === "not_configured" && b.body.message.startsWith("S&P API access isn't set up yet.") && ns.claude.calls.length === 0);
  const nsSaved = world({ secrets: {} }); await save(nsSaved, 1);
  ok("a saved summary still opens with nothing set up", (await nsSaved.call({ action: "make", filing: ROW(1) })).body.fromStore === true);

  const busy = world({ docs: { [71000001]: { bytes: PDF624 } } });
  const jobId = await busy.db.createJob("login-digest", "An answer still going");
  const c = await busy.call({ action: "make", filing: ROW(1) });
  ok("an answer already in progress: busy, nothing spent", c.status === 409 && c.body.error === "busy" && c.body.jobId === jobId && busy.downloads() === 0 && busy.claude.calls.length === 0);

  const lim = world({ secrets: { ...SECRETS, CHAT_DAILY_LIMIT: "2" }, docs: { [71000001]: { bytes: PDF624 } } });
  for (const id of [await lim.db.createJob("login-digest", "q1"), await lim.db.createJob("login-digest", "q2")]) await lim.db.updateJob(id!, { status: "done" });
  const d = await lim.call({ action: "make", filing: ROW(1) });
  ok("at the daily limit: limit, with when it resets, nothing spent or counted", d.status === 429 && d.body.error === "limit" && d.body.dailyLimit === 2 && d.body.askedToday === 2 && d.body.message.includes("Making a summary counts as a question.") && lim.downloads() === 0 && lim.db.jobs.size === 2, d.body);
  ok("make needs a filing with an id", (await world().call({ action: "make", filing: { companyName: "Calloway Home Co" } })).status === 400 && (await world().call({ action: "make" })).status === 400);
}

// ---------- make: the document ----------
{
  const big = world({ docs: { [71000001]: { bytes: new Uint8Array(10), length: "61000000" } } });
  const r = await big.call({ action: "make", filing: ROW(1) });
  ok("a document over 60 MB: too_large, after one S&P request, no Claude call and not counted", r.status === 413 && r.body.error === "too_large" && r.body.message.startsWith("This document is 61 MB, over the 60 MB") && big.downloads() === 1 && big.claude.calls.length === 0 && big.db.jobs.size === 0, r.body);
  const txt = world({ docs: { [71000001]: { bytes: new TextEncoder().encode("plain"), type: "text/plain" } } });
  const t = await txt.call({ action: "make", filing: ROW(1) });
  ok("a document that isn't a PDF: unreadable, plainly, not counted", t.status === 422 && t.body.error === "unreadable" && txt.db.jobs.size === 0 && txt.claude.calls.length === 0);
  const missing = world({ docs: {} });
  const m = await missing.call({ action: "make", filing: ROW(1) });
  ok("S&P has no such document: its answer passed on, not counted", m.status === 404 && m.body.error === "spgmi_not_found" && missing.db.jobs.size === 0, m.body);
  const fails = world({ docs: { [71000001]: { bytes: PDF624 } }, script: [{ content: [say("not json")] }] });
  const f = await quiet(() => fails.call({ action: "make", filing: ROW(1) }));
  const job = [...fails.db.jobs.values()][0];
  ok("Claude's answer unusable: an error with the reason, nothing saved, but the question and its cost are recorded", f.status === 502 && f.body.error === "claude" && f.body.message === D.MAKE_NOTES.unusable && fails.digests.rows.size === 0 && job.status === "done" && (job.result as any).answer[0].text.startsWith("Claude couldn't summarise filing") && (job.result as any).usage.inputTokens === 1000, { body: f.body, job });
  const cant = world({ docs: { [71000001]: { bytes: PDF624 } }, script: [{ content: [say(JSON.stringify(goodRaw()))] }] });
  cant.db.putDigest = async () => { throw new Error("disk full"); };
  const c = await quiet(() => cant.call({ action: "make", filing: ROW(1) }));
  ok("a summary that can't be saved is still shown, with a note", c.status === 200 && c.body.digest.summary.length > 0 && c.body.note === "The summary couldn't be saved, so it shows only now.");
}

// ---------- search ----------
{
  const w = world();
  await save(w, 1, {}, "2026-11-10T05:00:00.000Z");
  await save(w, 2, { serffFilingStateId: "TX" }, "2026-11-12T05:00:00.000Z", goodRaw({ summary: "Tarrow Mutual revises its dwelling fire rules.", programs: [], forms: [{ number: "TMF 10 02", edition: null, title: "Dwelling fire policy", action: "revised", replaces: null, basis: "TMF 10 02 Dwelling fire policy", page: 9 }], notable: [{ text: "Adds a roof age surcharge.", page: 40 }] }));
  await save(w, 3, {}, "2026-11-15T05:00:00.000Z", goodRaw({ summary: "A second Calloway homeowners filing.", forms: [{ number: "CHO 30 01", edition: "01 27", title: "Homeowners policy", action: "revised", replaces: null, basis: "CHO 30 01 01 27", page: 10 }] }));
  const find = async (q: string, state?: string) => (await w.call({ action: "search", q, ...(state ? { state } : {}) })).body;
  for (const q of ["CHO 30 01", "CHO3001", "cho-30-01", "cho.30/01"]) {
    const r = await find(q);
    ok(`"${q}" finds both filings with form CHO 30 01, newest first, as a form number`, r.total === 2 && same(r.matches.map((m: any) => m.digest.filingNo), ["S&P no. CAL0000003", "S&P no. CAL0000001"]) && r.matches.every((m: any) => m.where === "form number"), r);
  }
  const fl = await find("CHO 30 01", "fl"), tx = await find("CHO 30 01", "TX");
  ok("within a state: only that state's filings", fl.total === 2 && tx.total === 0 && same(tx.matches, []), { fl: fl.total, tx });
  ok("the snippet shows the matching form and its page", (await find("CHO3001")).matches[0].snippet === "CHO 30 01 (01 27), Homeowners policy, page 10");
  const title = await find("dwelling fire");
  ok("a form title matches as a form title", title.total === 1 && title.matches[0].where === "form title" && title.matches[0].digest.state === "TX" && title.matches[0].snippet === "TMF 10 02, Dwelling fire policy, page 9", title);
  const prog = await find("Signature Home");
  ok("a program name matches as a program", prog.total === 2 && prog.matches.every((m: any) => m.where === "program"), prog);
  const sum = await find("roof age surcharge");
  ok("words in a notable point match it", sum.total === 1 && sum.matches[0].where === "notable" && sum.matches[0].snippet === "Adds a roof age surcharge., page 40", sum);
  const s2 = await find("revises dwelling");
  ok("words in the summary match the summary", s2.total === 1 && s2.matches[0].where === "summary", s2);
  const none = await find("earthquake");
  ok("nothing matching: an empty list and a total of 0", same(none, { matches: [], total: 0 }));
  ok("search asks the database for the form number without spacing, the words, and the state", same(w.digests.searches.at(-1), { formKey: null, words: ["earthquake"], state: null, limit: 200 }) && w.digests.searches.some((s: any) => s.formKey === "CHO3001" && s.state === "FL"));
  ok("search is free: no S&P request, no Claude call, not counted", w.downloads() === 0 && w.claude.calls.length === 0 && w.db.jobs.size === 0);
  ok("limit caps the matches but not the total", (await w.call({ action: "search", q: "CHO3001", limit: 1 })).body.matches.length === 1 && (await w.call({ action: "search", q: "CHO3001", limit: 1 })).body.total === 2);
  ok("a bad state or an empty box is refused plainly", (await w.call({ action: "search", q: "x y", state: "Florida" })).status === 400 && (await w.call({ action: "search", q: " " })).body.message === "Type a form number or some words to search for.");
  const hostile = world();
  await save(hostile, 4, { companyName: "<b>Calloway</b>" }, "2026-11-10T05:00:00.000Z", goodRaw({ summary: "<script>alert(1)</script> water", programs: [] }));
  const h = await hostile.call({ action: "search", q: "water" });
  ok("hostile text comes back as text, for the page to escape", h.body.matches[0].digest.summary === "<script>alert(1)</script> water" && h.body.matches[0].digest.company === "<b>Calloway</b>");
}

done();
