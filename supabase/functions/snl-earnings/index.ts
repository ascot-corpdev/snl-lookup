// Earnings for SNL lookup: for one company on the team's earnings watchlist and one quarter, the quarter's results
// documents from SEC EDGAR and the company's investor-relations pages, found once, saved, and passed through to the
// page on request. The rules are in _shared/earnings.ts. Any signed-in login may look and download; only Corp Dev edits
// the watchlist (the page writes the shared setting "earnings_watchlist" itself, under row-level security, after
// asking "check" here). Uses no S&P request and no Claude.
//
// Secret: SEC_CONTACT, the organisation and a contact email the SEC asks automated tools to send. Without it nothing is
// fetched from anywhere. Optional: ALLOWED_ORIGIN.
// Deploy: supabase functions deploy snl-earnings --no-verify-jwt
//
// POST /functions/v1/snl-earnings  {"action": ...}
//   status                                  -> {configured, companies, problems, role, quarter: the latest ended}
//   list                                    -> {companies, problems, configured}: the watchlist as the app reads it
//   check {list} (Corp Dev)                 -> {companies, problems}: a pasted or edited list, checked entry by entry
//   saved {quarter}                         -> {quarter, results: [...]}: what was found before, asking nobody
//   find {company, quarter, refresh?}       -> {result, fromStore}: one company. Saved results come back without asking
//     anyone, until refresh. Errors: not_configured, unknown_company, bad.
//   download {company, quarter, doc}        -> the file itself, passed through from where it was found (60 MB at most).
//     The page names a document by the id find gave it; the address is looked up here, never taken from the page.
//     Errors: not_configured, unknown_doc, web_page, refused, too_big, not_file, failed.

import { type Env, type Json, readBody, sleep, type WhoIs, whoIs, withCors, adminClient } from "../_shared/http.ts";
import { type Db, supabaseDb } from "../_shared/db.ts";
import {
  CALL_MS, checkUrl, cleanWatchlist, type Company, denoResolve, DOWNLOAD_MAX_BYTES, fileExt, IR_UA, lastEndedQuarter, NOT_SET_UP, parseQuarter,
  quarterEnd, quarterName, readWatchlist, type Resolve, type Result, resultId, runCompany, safeFetch, secContact, SecError, secOpen,
} from "../_shared/earnings.ts";

export type Deps = { env: Env; fetch: typeof fetch; now?: () => number; whoIs?: WhoIs; db?: Db; sleep?: (ms: number) => Promise<void>; resolve?: Resolve;
  /** How long one investor page may take (PAGE_TIMEOUT_MS). Tests make it short. */
  pageTimeoutMs?: number };

export function handle(req: Request, deps: Deps): Promise<Response> {
  return withCors(req, deps.env, "The earnings function", (json, cors) => serve(req, deps, json, cors));
}

const PASTE_MAX = 200_000;
const asResult = (doc: unknown): Result | null => doc && typeof doc === "object" && (doc as Result).v === 1 && Array.isArray((doc as Result).docs) ? doc as Result : null;

async function serve(req: Request, deps: Deps, json: Json, cors: Record<string, string>): Promise<Response> {
  const who = await (deps.whoIs ?? whoIs(deps.env))(req);
  if (!who) return json(401, { error: "signin", message: "Sign in again." });
  const body = await readBody(req);
  if (!body) return json(400, { error: "bad", message: "Send a JSON body with an action." });
  const clock = deps.now ?? Date.now, start = clock();
  const admin = deps.db ? null : adminClient(deps.env);
  const db = deps.db ?? (admin ? supabaseDb(admin, clock) : null);
  if (!db) return json(500, { error: "server", message: "The function can't reach its database. It must run inside Supabase." });
  const contact = secContact(deps.env);

  switch (body.action) {
    case "status": {
      const w = await readWatchlist(db), lq = lastEndedQuarter(clock());
      return json(200, { configured: !!contact, companies: w.companies.length, problems: w.problems.length, role: who.role, quarter: quarterName(lq.q, lq.y) });
    }
    case "list": {
      const w = await readWatchlist(db);
      return json(200, { companies: w.companies, problems: w.problems, configured: !!contact });
    }
    case "check": {
      if (who.role !== "corpdev") return json(403, { error: "forbidden", message: "Only Corp Dev logins can change the earnings watchlist. Ask Corp Dev." });
      let raw: unknown = body.list;
      if (typeof raw === "string") {
        if (raw.length > PASTE_MAX) return json(400, { error: "bad", message: `What was pasted is longer than ${PASTE_MAX.toLocaleString("en-US")} characters. Paste only the "companies" list.` });
        try { raw = JSON.parse(raw); }
        catch { return json(400, { error: "bad", message: "That isn't JSON the app can read. Copy the companies list from the script from its opening [ to its closing ], or the whole BUILT_IN_CONFIG between its triple quotes." }); }
      }
      const out = cleanWatchlist(raw);
      return json(200, { companies: out.companies, problems: out.problems });
    }
    case "saved": {
      const qy = parseQuarter(body.quarter);
      if (!qy) return json(400, { error: "bad", message: "Choose a quarter, for example 3Q26." });
      const qn = quarterName(qy.q, qy.y), w = await readWatchlist(db), results: Result[] = [];
      for (const co of w.companies) { const r = asResult((await db.getStore(resultId(qn, co.id)))?.doc); if (r) results.push(r); }
      return json(200, { quarter: qn, results });
    }
    case "find":
    case "download": {
      if (!contact) return json(503, { error: "not_configured", message: NOT_SET_UP });
      const qy = parseQuarter(body.quarter);
      if (!qy) return json(400, { error: "bad", message: "Choose a quarter, for example 3Q26 or Q3 2026." });
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (quarterEnd(qy.q, qy.y) >= today) return json(400, { error: "bad", message: `${quarterName(qy.q, qy.y)} hasn't ended yet. Choose a quarter that has.` });
      if (qy.y < 2010) return json(400, { error: "bad", message: "Choose a quarter from 2010 on." });
      const w = await readWatchlist(db), co = w.companies.find((c) => c.id === body.company);
      if (!co) return json(404, { error: "unknown_company", message: "That company isn't on the earnings watchlist any more. Reload the page." });
      const qn = quarterName(qy.q, qy.y), id = resultId(qn, co.id);
      const saved = asResult((await db.getStore(id))?.doc);
      if (body.action === "download") return await download(body, saved, co, deps, json, cors, contact, clock, start);
      if (saved && body.refresh !== true) return json(200, { result: saved, fromStore: true });
      const result = await runCompany(co, qy.q, qy.y, { fetch: deps.fetch, now: clock, sleep: deps.sleep ?? sleep, resolve: deps.resolve ?? denoResolve, contact, db, deadline: start + CALL_MS, pageTimeoutMs: deps.pageTimeoutMs }, saved);
      const ok = await db.putStore({ id, kind: "discover", label: `Earnings ${qn} ${co.name}`.slice(0, 400), doc: result as unknown as Record<string, unknown> });
      return json(200, { result, fromStore: false, ...(ok ? {} : { note: "What was found couldn't be saved, so it shows only now." }) });
    }
    default:
      return json(400, { error: "bad", message: "Unknown action. Use status, list, check, saved, find or download." });
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Content-Disposition with a plain-letters fallback and the full name in UTF-8. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
/** The body passed on as it arrives, with the head already read put first, cut off (an error the page sees) past max. */
function capped(head: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>, max: number, done: () => void): ReadableStream<Uint8Array> {
  let size = head.reduce((a, b) => a + b.length, 0);
  return new ReadableStream<Uint8Array>({
    start(c) { for (const h of head) c.enqueue(h); },
    async pull(c) {
      try {
        const { done: end, value } = await reader.read();
        if (end) { done(); c.close(); return; }
        size += value.length;
        if (size > max) { await reader.cancel().catch(() => {}); done(); c.error(new Error("too_big")); return; }
        c.enqueue(value);
      } catch (e) { done(); c.error(e); }
    },
    async cancel() { await reader.cancel().catch(() => {}); done(); },
  });
}
/** Reads from the start of a body until there are at least n bytes (or it ends). */
async function headOf(reader: ReadableStreamDefaultReader<Uint8Array>, n: number): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  let size = 0;
  while (size < n) { const { done, value } = await reader.read(); if (done) break; parts.push(value); size += value.length; }
  return parts;
}
const joined = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const tooBig = (json: Json) => json(413, { error: "too_big", message: `This file is larger than ${DOWNLOAD_MAX_BYTES / 1_000_000} MB, more than the site passes through. Open it from its link instead.` });

async function download(body: Record<string, unknown>, saved: Result | null, co: Company, deps: Deps, json: Json, cors: Record<string, string>, contact: string, clock: () => number, start: number): Promise<Response> {
  const doc = saved?.docs.find((d) => d.id === body.doc);
  if (!saved || !doc) return json(404, { error: "unknown_doc", message: "That document isn't in what was found for this quarter. Find again, then download." });
  if (doc.page) return json(400, { error: "web_page", message: "This is a web page on the company's site, not a file. Open it from its link." });
  if (checkUrl(doc.url)) return json(400, { error: "failed", message: "This document's address can't be fetched." });
  const headers = (type: string, ext: string) => ({ ...cors, "Content-Type": type, "Content-Disposition": disposition(doc.name + ext), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });

  if (doc.source === "sec") {
    let o;
    try { o = await secOpen({ fetch: deps.fetch, contact, now: clock, sleep: deps.sleep ?? sleep, deadline: start + CALL_MS, resolve: deps.resolve ?? denoResolve, count: { n: 0 } }, doc.url); }
    catch (e) { return json(502, { error: e instanceof SecError && e.kind === "refused" ? "refused" : "failed", message: (e as Error).message }); }
    const said = o.res.headers.get("content-length");
    if (said && /^\d+$/.test(said) && Number(said) > DOWNLOAD_MAX_BYTES) { await o.res.body?.cancel().catch(() => {}); o.done(); return tooBig(json); }
    const reader = o.res.body!.getReader(), head = await headOf(reader, 8), ext = doc.ext || ".htm";
    if (ext === ".pdf") {
      if (!fileExt(joined(head), [".pdf"])) { await reader.cancel().catch(() => {}); o.done(); return json(415, { error: "not_file", message: "The SEC sent something other than the PDF this should be. Open it from its link." }); }
      return new Response(capped(head, reader, DOWNLOAD_MAX_BYTES, o.done), { status: 200, headers: headers("application/pdf", ".pdf") });
    }
    if (ext === ".htm") {
      // The SEC's own web page, saved as it is. Its images and links are addresses next to it on sec.gov, so a <base>
      // pointing there makes them load when the saved file is opened online; nothing more is fetched here.
      const folder = doc.url.slice(0, doc.url.lastIndexOf("/") + 1);
      const note = new TextEncoder().encode(`<!-- Saved by SNL lookup from ${esc(doc.url)} on ${new Date(clock()).toISOString().slice(0, 10)}. This is the SEC's own web page, not a PDF: open it in a browser. Its images and links load from sec.gov when you are online. -->\n<base href="${esc(folder)}">\n`);
      return new Response(capped([note, ...head], reader, DOWNLOAD_MAX_BYTES + note.length, o.done), { status: 200, headers: headers("text/html; charset=utf-8", ".htm") });
    }
    if (ext === ".txt") return new Response(capped(head, reader, DOWNLOAD_MAX_BYTES, o.done), { status: 200, headers: headers("text/plain; charset=utf-8", ".txt") });
    await reader.cancel().catch(() => {}); o.done();
    return json(415, { error: "not_file", message: "This kind of SEC document can't be saved here. Open it from its link." });
  }

  // An investor site: only a PDF or Excel file of the kind expected passes, whatever the site says it is.
  const allowed = doc.col === "supplement" ? [".pdf", ".xlsx", ".xls"] : [".pdf"];
  let host = "";
  try { host = new URL(doc.url).hostname; } catch { /* checked above */ }
  const hop = await safeFetch(doc.url, { fetch: deps.fetch, resolve: deps.resolve ?? denoResolve, timeoutMs: Math.max(10_000, start + CALL_MS - clock()), headers: { "User-Agent": IR_UA, "Referer": `https://${host}/`, "Accept": "*/*" } });
  if (!hop.ok) return json(hop.kind === "blocked" ? 400 : 502, { error: "failed", message: `The file couldn't be fetched: ${hop.reason}. Open it from its link.` });
  const res = hop.res;
  if ([401, 403, 405, 406, 429, 451, 503, 999].includes(res.status)) { await res.body?.cancel().catch(() => {}); hop.done(); return json(502, { error: "refused", message: `The company's site refused to hand the file to the app (it answered ${res.status}). Open it from its link in your browser.` }); }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); hop.done(); return json(502, { error: "failed", message: `The company's site answered ${res.status}. Open the file from its link.` }); }
  const said = res.headers.get("content-length");
  if (said && /^\d+$/.test(said) && Number(said) > DOWNLOAD_MAX_BYTES) { await res.body?.cancel().catch(() => {}); hop.done(); return tooBig(json); }
  const reader = res.body!.getReader(), head = await headOf(reader, 8), ext = fileExt(joined(head), allowed);
  if (!ext) { await reader.cancel().catch(() => {}); hop.done(); return json(415, { error: "not_file", message: `The company's site sent ${allowed.length > 1 ? "something other than a PDF or Excel file" : "something other than a PDF"}, often a page that needs a browser. Open it from its link.` }); }
  const type = ext === ".pdf" ? "application/pdf" : ext === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/vnd.ms-excel";
  return new Response(capped(head, reader, DOWNLOAD_MAX_BYTES, hop.done), { status: 200, headers: headers(type, ext) });
}

// Tests import handle() with this flag set; in Supabase the server always starts.
if (!(globalThis as { __SNL_TEST__?: boolean }).__SNL_TEST__) {
  Deno.serve((req) => handle(req, { env: (k) => Deno.env.get(k), fetch }));
}
