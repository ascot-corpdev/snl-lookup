// The team library: answers a login chose to share with everyone who has a login on this site (migration 0007).
// Saving copies a finished answer of the caller's own, exactly as it was shown, into public.snl_library, so it
// outlives the 30-day clean-up of answers. It fetches nothing from S&P or Claude and costs nothing.
// Every login reads the library straight from the table (row-level security), as Past answers are read; only these
// actions of the snl-chat function write to it, with the service role.
//
//   {"action": "library_save", "jobId": "...", "title": "...", "tags": ["..."]}  -> 200 {entry, existing}
//     existing: true when the answer was already in the library (the entry already there is returned, unchanged)
//   {"action": "library_update", "id": "...", "title": "...", "tags": ["..."]}  -> 200 {entry}
//   {"action": "library_remove", "id": "..."}                                  -> 200 {removed: true}
// Errors, in the shape every function uses ({error, message}): bad (400), not_found (404), not_finished (409),
// forbidden (403: only the saver or a Corp Dev login may change or remove an entry), library_full (409),
// too_large (413), library_missing (503: the migration hasn't been run).
// Titles and tags are untrusted text: control characters removed, spaces collapsed, lengths limited. Nothing is
// recorded about why an answer was saved.

import type { Db, Job, LibraryRow } from "./db.ts";
import { LIBRARY_MISSING } from "./db.ts";
import type { Json } from "./http.ts";

/** The most entries the library holds, and the most one entry's copied answer may take as JSON (UTF-8 bytes).
    500 entries is years of the good answers of a small team; 150 KB is several times a long answer with a table
    and forty sources. Together they keep the table under about 75 MB at the very worst (typical answers are
    20 to 40 KB, so about 15 MB when full), well inside a free Supabase project's 500 MB. */
export const LIBRARY = { maxEntries: 500, maxBytes: 150_000, title: 120, tags: 5, tag: 30, companies: 40, company: 120 };

export const LIBRARY_NOT_SET_UP = "The team library isn't set up yet. Corp Dev runs supabase/migrations/0007_answer_library.sql in the Supabase SQL editor (see the README), then it works straight away.";

/** Text a person typed: control characters out, runs of spaces to one, trimmed. */
export const cleanText = (v: unknown): string => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim() : "";

/** A title: 1 to 120 characters once cleaned, or null. */
export function cleanTitle(v: unknown): string | null {
  const t = cleanText(v);
  return t && t.length <= LIBRARY.title ? t : null;
}

/** Tags: missing gives none; otherwise a list of up to 5 texts of up to 30 characters each. Empty ones are dropped and
    repeats (in any letter case) kept once. A message saying what is wrong, or the tags. */
export function cleanTags(v: unknown): { tags: string[] } | { problem: string } {
  if (v === undefined || v === null) return { tags: [] };
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { problem: "Send tags as a list of words." };
  const seen = new Set<string>(), tags: string[] = [];
  for (const x of v) {
    const t = cleanText(x);
    if (!t) continue;
    if (t.length > LIBRARY.tag) return { problem: `Keep each tag to ${LIBRARY.tag} characters.` };
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); tags.push(t);
  }
  return tags.length > LIBRARY.tags ? { problem: `Use up to ${LIBRARY.tags} tags.` } : { tags };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNum = (v: unknown): string | number | null => (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** What a finished answer showed, and only that: the answer's lines with their citations, the sources, the table,
    the limits that were reached and what was looked up. Each part keeps the fields the page shows, so nothing else in
    the job's result (the cost, say) is copied. */
export function answerCopy(result: Record<string, unknown> | null): LibraryRow["answer"] {
  const r = result ?? {};
  const answer = list(r.answer).map(obj).filter((s): s is Record<string, unknown> => !!s && typeof s.text === "string")
    .map((s) => ({ text: s.text as string, cites: list(s.cites).filter((n) => typeof n === "number" && Number.isInteger(n)) }));
  const sources = list(r.sources).map(obj).filter((s): s is Record<string, unknown> => !!s && num(s.n) !== null).map((s) => ({
    n: num(s.n), documentId: num(s.documentId), filingVersionId: str(s.filingVersionId), title: str(s.title), company: str(s.company), state: str(s.state),
    trackingNumber: str(s.trackingNumber), ...(str(s.sfcNumber) ? { sfcNumber: str(s.sfcNumber) } : {}), pages: strOrNum(s.pages), startPage: num(s.startPage), quote: str(s.quote),
  }));
  const tb = obj(r.table);
  const table = tb && Array.isArray(tb.columns) && Array.isArray(tb.rows) ? {
    title: str(tb.title) ?? "", columns: tb.columns.map((c) => String(c ?? "")),
    rows: tb.rows.filter(Array.isArray).map((row) => (row as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c)))),
    notes: list(tb.notes).filter((n): n is string => typeof n === "string"),
  } : null;
  const caps = list(r.caps).filter((c): c is string => typeof c === "string");
  const lookups = list(r.lookups).map(obj).filter((l): l is Record<string, unknown> => !!l).map((l) => ({ tool: str(l.tool) ?? "", detail: str(l.detail) ?? "" }));
  return { answer, sources, table, caps, lookups };
}

/** The companies the answer's sources name, each once, for the search box. */
export function companiesOf(copy: LibraryRow["answer"]): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const s of copy.sources as { company?: unknown }[]) {
    const c = cleanText(s?.company).slice(0, LIBRARY.company);
    if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); }
    if (out.length >= LIBRARY.companies) break;
  }
  return out;
}

/** The one column the page searches: title, question, tags and companies, in lower case. */
export const searchText = (title: string, question: string, tags: string[], companies: string[]): string =>
  [title, cleanText(question), tags.join(" "), companies.join(" ")].join(" \u00b7 ").toLowerCase().slice(0, 12_000);

/** What the page is sent about an entry: every column but the copied answer and the search text. */
export function entryOut(r: LibraryRow) {
  return { id: r.id, job_id: r.job_id, title: r.title, question: r.question, tags: r.tags, companies: r.companies, model: r.model,
    asked_at: r.asked_at, answered_at: r.answered_at, saved_by: r.saved_by, saved_by_name: r.saved_by_name, saved_at: r.saved_at, updated_at: r.updated_at };
}

const ID = /^[0-9a-f-]{8,64}$/i;
const GONE = "That entry is no longer in the team library. Someone may have removed it.";
const FORBIDDEN = "Only the person who saved this entry, or a Corp Dev login, can change or remove it.";

/** The library actions of the snl-chat function. null when the action isn't one of them. */
export async function libraryAction(body: Record<string, unknown>, who: { id: string; role: string }, db: Db, json: Json): Promise<Response | null> {
  if (body.action !== "library_save" && body.action !== "library_update" && body.action !== "library_remove") return null;
  if (!db.libraryGet || !db.libraryByJob || !db.libraryAdd || !db.libraryUpdate || !db.libraryRemove || !db.libraryCount) return json(500, { error: "server", message: "The team library can't be reached from this function." });
  try {
    if (body.action === "library_save") return await save(body, who, db, json);
    const id = typeof body.id === "string" && ID.test(body.id) ? body.id : null;
    const entry = id ? await db.libraryGet(id) : null;
    if (!entry) return json(404, { error: "not_found", message: GONE });
    if (entry.saved_by !== who.id && who.role !== "corpdev") return json(403, { error: "forbidden", message: FORBIDDEN });
    if (body.action === "library_remove") {
      // Gone for everyone at once: there is no bin to restore it from.
      return (await db.libraryRemove(entry.id)) ? json(200, { removed: true }) : json(404, { error: "not_found", message: GONE });
    }
    const title = cleanTitle(body.title);
    if (!title) return json(400, { error: "bad", message: `Give the entry a title of up to ${LIBRARY.title} characters.` });
    const tags = cleanTags(body.tags);
    if ("problem" in tags) return json(400, { error: "bad", message: tags.problem });
    const changed = await db.libraryUpdate(entry.id, { title, tags: tags.tags, search_text: searchText(title, entry.question, tags.tags, entry.companies) });
    return changed ? json(200, { entry: entryOut(changed) }) : json(404, { error: "not_found", message: GONE });
  } catch (e) {
    if ((e as Error)?.message === LIBRARY_MISSING) return json(503, { error: "library_missing", message: LIBRARY_NOT_SET_UP });
    throw e;
  }
}

async function save(body: Record<string, unknown>, who: { id: string; role: string }, db: Db, json: Json): Promise<Response> {
  const jobId = typeof body.jobId === "string" && ID.test(body.jobId) ? body.jobId : null;
  const job: Job | null = jobId ? await db.getJob(jobId) : null;
  // Someone else's answer is answered as if it weren't there, so its existence isn't given away.
  if (!job || job.owner !== who.id) return json(404, { error: "not_found", message: "That answer wasn't found. Only your own answers can be saved to the team library, and answers are kept for 30 days." });
  if (job.status === "error") return json(409, { error: "not_finished", message: "This answer didn't finish, so there is nothing to save. Ask the question again, then save the new answer." });
  if (job.status !== "done" || !job.result) return json(409, { error: "not_finished", message: "This answer hasn't finished yet. Save it once it has." });
  const title = cleanTitle(body.title);
  if (!title) return json(400, { error: "bad", message: `Give the entry a title of up to ${LIBRARY.title} characters.` });
  const tags = cleanTags(body.tags);
  if ("problem" in tags) return json(400, { error: "bad", message: tags.problem });

  const already = await db.libraryByJob!(job.id);
  if (already) return json(200, { entry: entryOut(already), existing: true });
  const held = await db.libraryCount!();
  if (held >= LIBRARY.maxEntries) return json(409, { error: "library_full", message: `The team library is full: it holds ${LIBRARY.maxEntries.toLocaleString("en-US")} answers. Corp Dev can remove old entries to make room, then save this one again.` });

  const answer = answerCopy(job.result);
  const bytes = new TextEncoder().encode(JSON.stringify(answer)).length;
  if (bytes > LIBRARY.maxBytes) return json(413, { error: "too_large", message: `This answer is too long for the team library (${Math.ceil(bytes / 1000).toLocaleString("en-US")} KB; the most is ${LIBRARY.maxBytes / 1000} KB). Use Export answer to share it as a Word document instead.` });
  const companies = companiesOf(answer);
  const name = cleanText(await db.profileName?.(who.id)).slice(0, 80) || "A colleague";
  const row = await db.libraryAdd!({
    job_id: job.id, title, question: job.question, answer, model: typeof job.result.model === "string" && job.result.model ? job.result.model.slice(0, 80) : null,
    asked_at: job.created_at, answered_at: job.updated_at, saved_by: who.id, saved_by_name: name,
    tags: tags.tags, companies, search_text: searchText(title, job.question, tags.tags, companies),
  });
  if (row) return json(200, { entry: entryOut(row), existing: false });
  // Saved a moment ago from another tab: the entry already there.
  const now = await db.libraryByJob!(job.id);
  return now ? json(200, { entry: entryOut(now), existing: true }) : json(500, { error: "server", message: "The answer couldn't be saved to the team library. Try again." });
}
