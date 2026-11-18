// Reading part of a long filing: counts a PDF's pages and cuts out a range of them, so Claude can read the
// pages that matter in a document too long to send whole.
//
// Measured on made-up filings of realistic shape (text, tables and scanned pages, 300 to 1,000 pages, 1 to 87 MB,
// some written with compressed object streams), in Deno with pdf-lib 1.17.1: loading takes 40 to 210 ms of CPU and
// a 120-page cut 70 to 280 ms in all, well inside an Edge Function's 2 seconds. Memory is the tighter limit: a
// cut holds the file about twice over (a 52 MB file peaked at about 200 MB), so the chat function only downloads
// files up to LIMITS.docBytes. A function call stops cutting after LIMITS.cutMs of work and puts further reads off
// to its next call.

import { PDFDocument } from "npm:pdf-lib@1.17.1";

export type OpenPdf = { ok: true; doc: PDFDocument; pages: number } | { ok: false; reason: "encrypted" | "damaged" };

/** Reads a PDF's structure. A password-protected file, or one that can't be read or has no pages, gives a reason. */
export async function openPdf(bytes: Uint8Array): Promise<OpenPdf> {
  // Every complete PDF ends with "startxref" and "%%EOF". A file without them is cut short or isn't a PDF, and
  // pdf-lib can spend many seconds of CPU searching such a file for objects (7.5 MB of junk took 30 seconds).
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 8192)));
  if (!tail.includes("startxref") || !tail.includes("%%EOF")) return { ok: false, reason: "damaged" };
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = doc.getPageCount();
    return pages > 0 ? { ok: true, doc, pages } : { ok: false, reason: "damaged" };
  } catch (e) {
    return { ok: false, reason: /encrypt/i.test(String((e as Error)?.name) + String((e as Error)?.message)) ? "encrypted" : "damaged" };
  }
}

/** A new PDF holding pages first to last (1-based, inclusive) of an open one. null when it can't be written. */
export async function cutPages(src: PDFDocument, first: number, last: number): Promise<Uint8Array | null> {
  try {
    const out = await PDFDocument.create({ updateMetadata: false });
    const idx = Array.from({ length: last - first + 1 }, (_, i) => first - 1 + i);
    for (const p of await out.copyPages(src, idx)) out.addPage(p);
    return await out.save({ useObjectStreams: false });
  } catch (e) {
    console.error("couldn't cut a page range", (e as Error)?.message);
    return null;
  }
}

/** The page of the original document that a page of a cut part is: page 1 of a part that starts at page 401 is
    page 401. A part that starts at page 1 (or a whole document) keeps its numbers. */
export const originalPage = (partPage: number, firstPage: number): number => partPage + Math.max(1, firstPage) - 1;

/** "pages 1 to 150 of 842", "page 7 of 842", or "pages 1 to 150" when the total isn't known. */
export function rangeText(first: number, last: number, of: number | null): string {
  const part = first === last ? `page ${first}` : `pages ${first} to ${last}`;
  return of ? `${part} of ${of.toLocaleString("en-US")}` : part;
}
