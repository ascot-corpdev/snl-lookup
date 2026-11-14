// Document page limits when S&P gives no page count: the app counts the pages in the file itself.
// Made-up filings and a fake S&P and Claude, as in the other suites.
(globalThis as any).__SNL_TEST__ = true;
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);
const { countPdfPages, LIMITS } = await import(new URL("../../supabase/functions/_shared/chat.ts", import.meta.url).href);
const { forgetTokens } = await import(new URL("../../supabase/functions/_shared/spgmi.ts", import.meta.url).href);
import { checks, corpdev, documentsIn, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, req, say, toolResults, toolUse } from "./helpers/fakes.ts";

const { ok, done } = checks();
const enc = (s: string) => new TextEncoder().encode(s);
/** A made-up PDF with n page objects, padded to at least `bytes` long. */
const pdf = (n: number, bytes = 0) => {
  let body = "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count " + n + " >> endobj\n";
  for (let i = 0; i < n; i++) body += `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`;
  return enc(body + "%".padEnd(Math.max(0, bytes - body.length), " ") + "\n%%EOF\n");
};

// ---------- counting ----------
ok("page objects are counted, and the page tree itself is not", countPdfPages(pdf(3)) === 3 && countPdfPages(pdf(120)) === 120);
ok("with or without a space after /Type", countPdfPages(enc("%PDF-1.7 <</Type/Page>> <</Type/Pages>> << /Type  /Page >>")) === 2);
ok("a file whose pages can't be seen gives no count rather than zero", countPdfPages(enc("%PDF-1.7 compressed object streams only")) === null && countPdfPages(new Uint8Array(0)) === null);

// ---------- the limits, for a filing S&P lists with no page count (TARR-135000002) ----------
const VERSION = "0A0A0A0A-0000-4000-8000-000000000006";
const SEARCH = { company_ids: [9200001], institution_ids: [], states: ["FL"], from: "2026-01-01", to: "2026-11-13", type_of_insurance_ids: [], filing_type_ids: [] };

async function ask(bytes: Uint8Array) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  const sp = fakeSpgmi(clock, { documents: { [VERSION]: { bytes } } });
  const seen: Record<string, any> = {};
  const claude = fakeAnthropic([
    { content: [toolUse("t1", "search_filings", SEARCH)] },
    (body) => { seen.search = toolResults(body).t1; return { content: [toolUse("t2", "read_filing_document", { document_id: null, filing_version_id: VERSION })] }; },
    (body) => { seen.read = toolResults(body).t2; seen.docs = documentsIn(body); return { content: [say("Done.")] }; },
    { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] },
  ]);
  const pending: Promise<unknown>[] = [];
  const res = await chat.handle(req("snl-chat", { action: "ask", question: "What does the Tarrow rate filing say?" }), {
    env: env({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "sk-ant-test" }),
    fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); },
  });
  const { jobId } = await res.json();
  await Promise.all(pending);
  return { job: db.jobs.get(jobId)!, seen, claude };
}

const small = await ask(pdf(3));
const row = small.seen.search.value.filings.find((f: any) => f.trackingNumber === "TARR-135000002");
ok("the search row has no page count and no document id", row.pages === null && row.documentId === null && row.filingVersionId === VERSION, row);
ok("a short document with no listed page count is read, and its counted pages are recorded", small.job.status === "done" && small.seen.read.isError === false && small.seen.read.value.pages === 3 && small.seen.docs.length === 1, small.seen.read);
ok("its progress line still says the count wasn't listed", small.job.progress.some((s) => s.text === "Reading filing TARR-135000002 (page count n/d)"), small.job.progress.map((s) => s.text));
ok("no limit is reported", (small.job.result as any).caps.length === 0);

const long = await ask(pdf(LIMITS.docPages + 20));
ok("a document that turns out to be over the page limit is not sent to Claude", long.seen.read.isError === true && long.seen.docs.length === 0 && long.claude.uploads.length === 0, long.seen.read);
ok("Claude is told why, and the answer says so", /over the limit of 100 for one document/.test(long.seen.read.value.error) && (long.job.result as any).caps.some((c: string) => c === `Filing TARR-135000002 has ${LIMITS.docPages + 20} pages, over the limit of ${LIMITS.docPages} pages for one document, so Claude didn't read it. Open it from the Filings view.`), (long.job.result as any).caps);

const opaque = await ask(enc("%PDF-1.7\n" + "x".repeat(LIMITS.docPages * LIMITS.bytesPerPage + 10)));
ok("a large document whose pages can't be counted is not sent to Claude", opaque.seen.read.isError === true && opaque.claude.uploads.length === 0 && /no page count and is too large/.test(opaque.seen.read.value.error), opaque.seen.read);
ok("and the answer says so", (opaque.job.result as any).caps.some((c: string) => c.startsWith("Filing TARR-135000002 has no page count and is too large")), (opaque.job.result as any).caps);

const smallOpaque = await ask(enc("%PDF-1.7\ncompressed object streams only"));
ok("a small document whose pages can't be counted is still read", smallOpaque.seen.read.isError === false && smallOpaque.seen.read.value.pages === null && smallOpaque.claude.uploads.length === 1, smallOpaque.seen.read);

// S&P's own page count is not trusted on its own
async function askListed(bytes: Uint8Array) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock);
  const sp = fakeSpgmi(clock, { documents: { "70000003": { bytes } } });   // CALL-134000003, which S&P lists at 30 pages
  const seen: Record<string, any> = {};
  const claude = fakeAnthropic([
    { content: [toolUse("t1", "search_filings", { company_ids: [9100001], institution_ids: [], states: ["FL"], from: "2025-01-01", to: "2025-12-31", type_of_insurance_ids: [], filing_type_ids: [1] })] },
    { content: [toolUse("t2", "read_filing_document", { document_id: 70000003, filing_version_id: null })] },
    (body) => { seen.read = toolResults(body).t2; seen.docs = documentsIn(body); return { content: [say("Done.")] }; },
    { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] },
  ]);
  const pending: Promise<unknown>[] = [];
  const res = await chat.handle(req("snl-chat", { action: "ask", question: "What does the rate filing say?" }), {
    env: env({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "sk-ant-test" }),
    fetch: sp.fetch, anthropicFetch: claude.fetch, now: clock.fn, whoIs: corpdev, db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); },
  });
  const { jobId } = await res.json();
  await Promise.all(pending);
  return { job: db.jobs.get(jobId)!, seen, claude };
}
const understated = await askListed(pdf(400));
ok("a document S&P lists at 30 pages that really has 400 is not sent to Claude", understated.seen.read.isError === true && understated.claude.uploads.length === 0 && /has 400 pages, over the limit/.test(understated.seen.read.value.error), understated.seen.read);
ok("and the answer says so", (understated.job.result as any).caps.some((c: string) => c.startsWith("Filing CALL-134000003 has 400 pages")), (understated.job.result as any).caps);
const overstated = await askListed(pdf(12));
ok("when the two counts differ the larger one is recorded", overstated.seen.read.isError === false && overstated.seen.read.value.pages === 30 && overstated.claude.uploads.length === 1, overstated.seen.read);

done();
