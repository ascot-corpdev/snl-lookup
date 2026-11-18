// SNLDeck (web/deck.js): builds a .pptx on the team's PowerPoint template in the browser. Runs inspect and build in a
// blank Chromium page against a made-up stand-in template (tests/fixtures/standin-template.pptx), pulls the bytes back
// and checks the unzipped parts with JSZip: example slides and everything only they used are gone, layouts are found
// by name, placeholders are filled, each building block is drawn, charts carry their data and an embedded workbook,
// relationships and content types agree, hostile text is escaped, and bad files are refused in plain words.
const { chromium } = require("playwright"); const fs = require("fs"); const path = require("path");
const JSZip = require("jszip");
const ROOT = path.join(__dirname, "../..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "tests/fixtures/standin-template.pptx"));
const STANDARD = fs.readFileSync(path.join(ROOT, "web/standard-template.pptx"));
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + "  " + JSON.stringify(x === undefined ? "" : x).slice(0, 600)); } };
const EMU = v => Math.round(v * 914400);
const NAVY = "262166", MAG = "EB008C";
const SPEC = {
  fileName: "x.pptx",
  slides: [
    { kind: "cover", kicker: "Corporate development | November 2026", title: "Calloway Insurance Co: company profile", subtitle: "Florida homeowners insurer" },
    { kind: "content", title: "Every building block", items: [
      { type: "text", x: 0.52, y: 1.3, w: 4, h: 0.4, paras: [{ runs: [{ text: "Hello ", size: 14, bold: true }, { text: "world", size: 12, italic: true, color: MAG }] }] },
      { type: "header", text: "Takeaways", x: 0.52, y: 1.8, w: 5.91 },
      { type: "bullets", x: 0.52, y: 2.2, w: 5.91, h: 1.6, items: [{ level: 0, runs: [{ text: "Scale: ", bold: true }, { text: "premium grew" }] }, { level: 1, runs: "a second level" }] },
      { type: "tile", x: 6.89, y: 1.3, w: 2.24, h: 1.45, value: "$122.5M", label: "Direct premiums written, 2025" },
      { type: "numbered", x: 6.89, y: 3.0, w: 5.91, h: 1.5, n: 3, title: "Question title", text: "Question text" },
      { type: "line", x1: 0.52, y1: 4.0, x2: 6.43, y2: 4.0 },
      { type: "table", x: 0.52, y: 4.2, colW: [2, 1, 1], rowH: [0.3, 0.27, 0.27], rows: [["Metric", "2024", "2025"], ["DPW", "110.0", "122.5"], ["Combined ratio (%)", "98.0", { text: "104.2", color: MAG }]], rowStyles: { 2: { bold: true } }, aligns: ["l", "r", "ctr"] },
      { type: "chart", kind: "column", x: 6.89, y: 4.6, w: 2.9, h: 1.9, categories: ["2023", "2024", "2025"], series: [{ name: "DPW", values: [100, 110, 122.5], color: NAVY }, { name: "NPW", values: [80, null, 90], color: MAG }], labels: { format: "#,##0.0" }, gap: 70, overlap: -10 },
      { type: "chart", kind: "stackedColumn", x: 9.9, y: 4.6, w: 2.9, h: 1.9, categories: ["2023", "2024", "2025"], series: [{ name: "Loss", values: [60, 70, 65] }, { name: "Expense", values: [30, 31, 32] }], labels: { position: "outEnd" }, valueAxis: { min: 0, max: 140, major: 20 } },
      { type: "source", text: "Source: made-up figures." }] },
    { kind: "content", title: "Bars", items: [
      { type: "chart", kind: "bar", x: 0.52, y: 1.3, w: 5.91, h: 3, categories: ["Nonesuch Re", "Other"], series: [{ name: "Ceded ($M)", values: [12, 8] }], legend: "none" },
      { type: "chart", kind: "stackedBar", x: 6.89, y: 1.3, w: 5.91, h: 3, categories: ["A", "B"], series: [{ name: "x", values: [12, 8] }, { name: "y", values: [1, 2] }] },
      { type: "source", text: "Source: made-up figures." }] }
  ]
};
const EVIL = '<script>alert(1)</script> & "q" \u0001\u0008\u000B ]]> \uFFFE <p:sp/> \uD800 end';

(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await b.newPage(); p.on("pageerror", e => errs.push(String(e)));
  await p.setContent("<html><body></body></html>");
  await p.addScriptTag({ path: path.join(ROOT, "node_modules/jszip/dist/jszip.min.js") });
  await p.addScriptTag({ path: path.join(ROOT, "web/deck.js") });
  const b64 = buf => Buffer.from(buf).toString("base64");
  const inspect = buf => p.evaluate(s => SNLDeck.inspect(Uint8Array.from(atob(s), c => c.charCodeAt(0))), b64(buf));
  const build = (buf, spec) => p.evaluate(async ([s, spec]) => {
    try {
      const out = await SNLDeck.build(Uint8Array.from(atob(s), c => c.charCodeAt(0)), spec);
      let t = ""; for (let i = 0; i < out.length; i += 0x8000) t += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return { ok: true, b64: btoa(t), isU8: out instanceof Uint8Array };
    } catch (e) { return { ok: false, message: e.message, isError: e instanceof Error }; }
  }, [b64(buf), spec]);
  // every XML part well-formed, checked with the browser's own parser
  const wellFormed = xmls => p.evaluate(list => list.filter(([n, x]) => new DOMParser().parseFromString(x, "application/xml").getElementsByTagName("parsererror").length).map(([n]) => n), xmls);
  async function unzip(res) { return JSZip.loadAsync(Buffer.from(res.b64, "base64")); }
  const read = (z, n) => z.file(n) ? z.file(n).async("string") : Promise.resolve(null);
  const names = z => Object.keys(z.files);
  const resolve = (base, t) => { if (t.startsWith("/")) return t.slice(1); const out = []; (base ? base.split("/") : []).concat(t.split("/")).forEach(x => { if (x === "..") out.pop(); else if (x && x !== ".") out.push(x); }); return out.join("/"); };
  const relsOf = n => { const i = n.lastIndexOf("/"); return (i < 0 ? "" : n.slice(0, i + 1)) + "_rels/" + n.slice(i + 1) + ".rels"; };
  const dir = n => n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : "";
  async function rels(z, part) {
    const x = await read(z, part === "" ? "_rels/.rels" : relsOf(part)); if (!x) return [];
    return [...x.matchAll(/<Relationship ([^>]*?)\/?>/g)].map(m => { const a = k => (m[1].match(new RegExp(k + '="([^"]*)"')) || [])[1];
      return { id: a("Id"), type: a("Type"), target: a("Target"), external: a("TargetMode") === "External", path: a("TargetMode") === "External" ? null : resolve(part === "" ? "" : dir(part), a("Target")) }; });
  }
  async function slides(z) {
    const pres = await read(z, "ppt/presentation.xml"), pr = await rels(z, "ppt/presentation.xml");
    const ids = [...pres.matchAll(/<p:sldId [^>]*\/>/g)].map(m => ({ id: +m[0].match(/ id="(\d+)"/)[1], rid: m[0].match(/r:id="([^"]+)"/)[1] }));
    return Promise.all(ids.map(async s => { const path = pr.find(r => r.id === s.rid).path; const lr = (await rels(z, path)).find(r => /slideLayout$/.test(r.type));
      const lx = await read(z, lr.path); return { ...s, path, xml: await read(z, path), layoutName: lx.match(/<p:cSld name="([^"]*)"/)[1], rels: await rels(z, path) }; }));
  }
  async function packageProblems(z) {
    const out = [], all = names(z), ct = await read(z, "[Content_Types].xml");
    if (all.some(n => n.endsWith("/"))) out.push("folder entries in the zip");
    const over = [...ct.matchAll(/<Override PartName="([^"]+)" ContentType="([^"]+)"\/>/g)].map(m => m[1].slice(1));
    const defs = [...ct.matchAll(/<Default Extension="([^"]+)"/g)].map(m => m[1].toLowerCase());
    over.forEach(o => { if (!z.file(o)) out.push("content type for missing part " + o); });
    all.filter(n => !n.endsWith("/") && n !== "[Content_Types].xml").forEach(n => { if (!over.includes(n) && !defs.includes(n.split(".").pop().toLowerCase())) out.push("no content type for " + n); });
    const targets = new Set();
    for (const r of all.filter(n => n.endsWith(".rels"))) {
      const owner = r === "_rels/.rels" ? "" : r.replace(/(^|\/)_rels\/([^/]+)\.rels$/, "$1$2");
      if (owner && !z.file(owner)) out.push("relationships for missing part " + owner);
      for (const x of await rels(z, owner)) { if (x.external) continue; targets.add(x.path); if (!z.file(x.path)) out.push("dangling " + r + " -> " + x.target); }
    }
    all.filter(n => !n.endsWith("/") && !n.endsWith(".rels") && n !== "[Content_Types].xml").forEach(n => { if (!targets.has(n)) out.push("part nothing points at: " + n); });
    return out;
  }

  // ----- inspect -----
  let r = await inspect(TEMPLATE);
  ok("inspect: the stand-in template is usable, with its size and example slide count", r.ok === true && r.slides === 3 && r.widthIn === 13.33 && r.heightIn === 7.5, r);
  ok("inspect: its layouts are found by name, so there is nothing to say about them", JSON.stringify(r.layouts) === JSON.stringify({ cover: { name: "Title White", named: true }, content: { name: "Spectrum Title Only White", named: true } }) && r.note === "", r);
  r = await inspect(Buffer.from("this is just text, not a presentation"));
  ok("inspect: a text file is refused in plain words", r.ok === false && r.message === "This file isn't a PowerPoint file. Choose your template saved as a .pptx file.", r);
  const notPres = new JSZip(); notPres.file("word/document.xml", "<w:document/>"); notPres.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  r = await inspect(await notPres.generateAsync({ type: "nodebuffer" }));
  ok("inspect: another Office file (a zip that isn't a presentation) is refused", r.ok === false && /isn't a PowerPoint file/.test(r.message), r);
  r = await inspect(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0]));
  ok("inspect: an old .ppt or a password-protected file says what to do", r.ok === false && r.message === "This file is in the old PowerPoint format (.ppt) or is protected with a password. Open it in PowerPoint, save it as a .pptx without a password, and upload it again.", r);
  r = await inspect(Buffer.alloc(0));
  ok("inspect: an empty file is refused", r.ok === false && /empty/.test(r.message), r);
  async function variant(fn) { const z = await JSZip.loadAsync(TEMPLATE); await fn(z); return z.generateAsync({ type: "nodebuffer" }); }
  // ----- layouts not named as the profile expects: the closest match, and a note saying which -----
  const layoutNames = async (z, map) => { for (const n of names(z).filter(n => /slideLayouts\/slideLayout\d+\.xml$/.test(n))) { let x = await read(z, n); for (const [a, b2] of map) x = x.replace(a, b2); z.file(n, x, { createFolders: false }); } };   // Office files have no folder entries
  const noCover = await variant(z => layoutNames(z, [['name="Title White"', 'name="Title Blue"']]));
  r = await inspect(noCover);
  ok("inspect: no cover layout by that name: the title slide layout is used, and the note says so", r.ok === true && r.layouts.cover.name === "Title Blue" && r.layouts.cover.named === false && r.layouts.content.named === true &&
    r.note === 'It has no layout named "Title White", so the cover uses "Title Blue".', r);
  // a corporate template: its own names, and no layout types to go by, so only the placeholders tell
  const corporate = await variant(z => layoutNames(z, [['name="Title White"', 'name="Cover page"'], ['name="Spectrum Title Only White"', 'name="Heading"'], [/<p:sldLayout([^>]*?) type="\w+"/, "<p:sldLayout$1"]]));
  r = await inspect(corporate);
  ok("inspect: a corporate template's own layouts are matched by their boxes: title and subtitle for the cover, a title alone for the rest", r.ok === true &&
    JSON.stringify(r.layouts) === JSON.stringify({ cover: { name: "Cover page", named: false }, content: { name: "Heading", named: false } }) &&
    r.note === 'It has no layout named "Title White", so the cover uses "Cover page". It has no layout named "Spectrum Title Only White", so the other slides use "Heading".', r);
  const narrow = await variant(async z => z.file("ppt/presentation.xml", (await read(z, "ppt/presentation.xml")).replace(/<p:sldSz cx="\d+"/, '<p:sldSz cx="9144000"')));
  r = await inspect(narrow);
  ok("inspect: a 4:3 template is still refused with its size", r.ok === false && r.message === "Your template's slides are 10 x 7.5 in, but the profile is laid out for widescreen slides (13.33 x 7.5 in). Choose a widescreen PowerPoint template.", r);
  const noTitle = await variant(async z => { for (const n of names(z).filter(n => /slideLayouts\/slideLayout\d+\.xml$/.test(n))) { const x = await read(z, n); if (x.includes('name="Spectrum Title Only White"')) z.file(n, x.replace('<p:ph type="title"/>', '<p:ph type="body" idx="13"/>')); } });
  r = await inspect(noTitle);
  ok("inspect: the named content layout has no title box: another layout with one is used instead, never the cover", r.ok === true && r.layouts.content.named === false && ["Title and Content", "Section Header"].includes(r.layouts.content.name) &&
    r.note === `It has no layout named "Spectrum Title Only White", so the other slides use "${r.layouts.content.name}".`, r);
  const noTitles = await variant(z => layoutNames(z, [[/<p:ph type="(ctrTitle|title)"\/>/g, '<p:ph type="body" idx="14"/>']]));
  r = await inspect(noTitles);
  ok("inspect: no layout with a title box at all: refused, saying what a cover layout needs", r.ok === false && r.message === 'Your template has no layout the profile can use for the cover. It needs a layout named "Title White", or one with a title box and a subtitle box, like PowerPoint\'s "Title Slide".', r);
  const coverOnly = await variant(z => layoutNames(z, [[/<p:ph type="title"\/>/g, '<p:ph type="body" idx="14"/>']]));
  r = await inspect(coverOnly);
  ok("inspect: a title box only on the cover layout: the cover's own layout is used for the rest too", r.ok === true && r.layouts.cover.name === "Title White" && r.layouts.content.name === "Title White", r);

  // the layouts in the stand-in are not numbered in order, so the builder must find them by name
  const tz = await JSZip.loadAsync(TEMPLATE);
  const layoutFiles = {};
  for (const n of names(tz).filter(n => /slideLayouts\/slideLayout\d+\.xml$/.test(n))) layoutFiles[(await read(tz, n)).match(/<p:cSld name="([^"]*)"/)[1]] = n;
  ok("the stand-in's layouts are out of order, so finding them by name matters", layoutFiles["Title White"] && layoutFiles["Spectrum Title Only White"] !== "ppt/slideLayouts/slideLayout2.xml", layoutFiles);
  const before = names(tz);
  ok("the stand-in has example slides, notes, a chart with a workbook and two pictures", ["ppt/slides/slide3.xml", "ppt/notesSlides/notesSlide1.xml", "ppt/charts/chart1.xml", "ppt/embeddings/Microsoft_Excel_Sheet1.xlsx", "ppt/media/image1.png", "ppt/media/image2.png"].every(n => before.includes(n)) && (await read(tz, "ppt/presentation.xml")).includes("p14:sectionLst"));

  // ----- build -----
  r = await build(TEMPLATE, SPEC);
  ok("build gives a Uint8Array", r.ok && r.isU8, r.message);
  let z = await unzip(r), all = names(z);
  ok("every part of the result is well-formed XML", (await wellFormed(await Promise.all(all.filter(n => /\.(xml|rels)$/.test(n)).map(async n => [n, await read(z, n)])))).length === 0);
  const probs = await packageProblems(z);
  ok("no dangling relationships, no content types for missing parts, nothing unreferenced, no folder entries", probs.length === 0, probs);
  let sl = await slides(z);
  ok("the result has exactly the spec's slides, in order", sl.length === 3 && sl[0].xml.includes("Calloway Insurance Co: company profile") && sl[1].xml.includes("Every building block") && sl[2].xml.includes(">Bars<"), sl.map(s => s.path));
  ok("no example slide text is left anywhere", !(await Promise.all(all.filter(n => /^ppt\/slides\//.test(n)).map(n => read(z, n)))).some(x => /Example slide/.test(x)));
  ok("the example slides' notes are gone", !all.some(n => /notesSlides\//.test(n)));
  ok("the example chart and its workbook are gone; the new charts use fresh parts", !all.includes("ppt/embeddings/Microsoft_Excel_Sheet1.xlsx") && !(await read(z, "ppt/charts/chart1.xml")).includes("Example series"));
  ok("the picture only an example slide used is gone; the one a layout uses is kept", !all.includes("ppt/media/image2.png") && all.includes("ppt/media/image1.png") && (await rels(z, layoutFiles["Blank"])).some(x => x.path === "ppt/media/image1.png"));
  ok("masters, layouts, theme and notes master are kept", Object.values(layoutFiles).every(n => all.includes(n)) && all.includes("ppt/slideMasters/slideMaster1.xml") && all.includes("ppt/theme/theme1.xml") && all.includes("ppt/notesMasters/notesMaster1.xml"));
  const pres = await read(z, "ppt/presentation.xml");
  ok("sections that listed the example slides are removed", !pres.includes("sectionLst"));
  const ids = sl.map(s => s.id);
  ok("slide ids are new, unique and above the removed ones", new Set(ids).size === 3 && ids.every(i => i > 258), ids);
  const ct = await read(z, "[Content_Types].xml");
  ok("content types: one override per new slide and chart, xlsx as a default, none for removed parts", sl.every(s => ct.includes('PartName="/' + s.path + '" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"')) &&
    all.filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n)).length === 4 && all.filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n)).every(n => ct.includes('PartName="/' + n + '" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"')) &&
    /<Default Extension="xlsx" ContentType="application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet"\/>/.test(ct) && !ct.includes("notesSlide+xml"));
  const app = await read(z, "docProps/app.xml");
  ok("app properties: slide and notes counts and the slide titles match", app.includes("<Slides>3</Slides>") && app.includes("<Notes>0</Notes>") && app.includes('<vt:i4>3</vt:i4>') &&
    app.includes('<vt:vector size="5" baseType="lpstr">') && app.includes("<vt:lpstr>Every building block</vt:lpstr>") && !app.includes("Example slide"), app);
  ok("the slides are on the layouts named in the brief", sl[0].layoutName === "Title White" && sl[1].layoutName === "Spectrum Title Only White" && sl[2].layoutName === "Spectrum Title Only White");

  // placeholders are filled as placeholders, so the layout's formatting applies
  const cover = sl[0].xml;
  ok("cover: kicker, title and descriptor go into the layout's placeholders (idx 10, title, idx 1)", /<p:ph type="body" idx="10"\/><\/p:nvPr><\/p:nvSpPr><p:spPr\/><p:txBody><a:bodyPr\/><a:lstStyle\/><a:p><a:r><a:rPr lang="en-US" dirty="0"\/><a:t>Corporate development \| November 2026<\/a:t>/.test(cover) &&
    /<p:ph type="ctrTitle"\/>.*?<a:t>Calloway Insurance Co: company profile<\/a:t>/.test(cover) && /<p:ph type="subTitle" idx="1"\/>.*?<a:t>Florida homeowners insurer<\/a:t>/.test(cover), cover);
  ok("cover: no slide number and no drawn shapes", !cover.includes("sldNum") && (cover.match(/<p:sp>/g) || []).length === 3);
  const s2 = sl[1].xml;
  ok("content slide: the title placeholder carries the title, with no position of its own", /<p:ph type="title"\/><\/p:nvPr><\/p:nvSpPr><p:spPr\/>.*?<a:t>Every building block<\/a:t>/.test(s2));
  ok("content slides: the slide number placeholder from the layout, with its number", /<p:ph type="sldNum" sz="quarter" idx="12"\/>.*?<a:fld id="\{[^}]+\}" type="slidenum"><a:rPr lang="en-US"\/><a:t>2<\/a:t><\/a:fld>/.test(s2) && /type="slidenum"><a:rPr lang="en-US"\/><a:t>3<\/a:t>/.test(sl[2].xml));
  const shape = name => { const m = s2.match(new RegExp('<p:(sp|cxnSp|graphicFrame)><p:nv\\w+><p:cNvPr id="\\d+" name="' + name + '"/>.*?</p:\\1>')); return m ? m[0] : ""; };
  const off = (x, y) => '<a:off x="' + EMU(x) + '" y="' + EMU(y) + '"/>';
  ok("text box: runs with size, bold, italic and colour, positioned in inches", shape("TextBox 3").includes(off(0.52, 1.3)) && shape("TextBox 3").includes('<a:ext cx="' + EMU(4) + '" cy="' + EMU(0.4) + '"/>') &&
    /sz="1400" b="1" i="0".*?<a:t>Hello <\/a:t>/.test(shape("TextBox 3")) && /sz="1200" b="0" i="1" dirty="0"><a:solidFill><a:srgbClr val="EB008C"\/>.*?<a:t>world<\/a:t>/.test(shape("TextBox 3")));
  const bl = s2.match(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="Bullets \d+"\/>.*?<\/p:sp>/)[0];
  ok("bullets: magenta dot at level one, navy dash at level two, bold lead", /<a:buClr><a:srgbClr val="EB008C"\/><\/a:buClr><a:buFont typeface="Arial"\/><a:buChar char="\u2022"\/>/.test(bl) && /<a:buClr><a:srgbClr val="262166"\/><\/a:buClr><a:buFont typeface="Arial"\/><a:buChar char="\u2013"\/>/.test(bl) && /b="1".*?<a:t>Scale: <\/a:t>/.test(bl));
  const tile = shape("Tile Direct premiums written, 2025");
  ok("stat tile: a filled rectangle with the value and label inside the shape", /<a:prstGeom prst="rect">.*<a:solidFill><a:srgbClr val="EEEEF5"\/><\/a:solidFill><a:ln><a:noFill\/><\/a:ln>/.test(tile) && /<p:txBody><a:bodyPr [^>]*anchor="ctr"/.test(tile) && /sz="2600" b="1".*?<a:t>\$122.5M<\/a:t>.*sz="1100".*?<a:t>Direct premiums written, 2025<\/a:t>/.test(tile) && !tile.includes('txBox="1"'));
  const hdr = shape("Header Takeaways");
  ok("section header: centred 14pt bold navy text with a rule each side", /<a:pPr algn="ctr">.*sz="1400" b="1".*?val="262166".*?<a:t>Takeaways<\/a:t>/.test(hdr) && (s2.match(/<p:cxnSp>.*?<\/p:cxnSp>/g) || []).filter(c => c.includes('y="' + EMU(1.96) + '"')).length === 2);
  const q = shape("Question 3"), badge = shape("Badge 3");
  ok("numbered tile: an oval badge with the digit inside, text inside the tile beside it", /<a:prstGeom prst="ellipse">/.test(badge) && /<a:t>3<\/a:t>/.test(badge) && badge.includes('val="EB008C"') && q.includes('lIns="' + EMU(1.05) + '"') && /<a:t>Question title<\/a:t>.*<a:t>Question text<\/a:t>/.test(q));
  ok("straight line: a connector with a navy line", /<p:cxnSp>.*?<a:prstGeom prst="line">.*?<a:ln w="12700"><a:solidFill><a:srgbClr val="262166"\/>/.test(s2) && s2.includes(off(0.52, 4.0) + '<a:ext cx="' + EMU(5.91) + '" cy="0"/>'));
  const src = shape("Source");
  ok("source line: 10pt italic grey at y 6.66", src.includes(off(0.52, 6.66)) && /sz="1000" b="0" i="1".*?val="666666".*?<a:t>Source: made-up figures.<\/a:t>/.test(src));
  const tb = s2.match(/<p:graphicFrame>(?:(?!<\/p:graphicFrame>).)*drawingml\/2006\/table.*?<\/p:graphicFrame>/)[0];
  ok("table: no built-in style banding, explicit column widths and row heights", tb.includes('<a:tblPr firstRow="0" bandRow="0"><a:tableStyleId>{2D5ABB26-0587-4C30-8999-92F81FD0307C}</a:tableStyleId></a:tblPr>') &&
    tb.includes('<a:gridCol w="' + EMU(2) + '"/><a:gridCol w="' + EMU(1) + '"/><a:gridCol w="' + EMU(1) + '"/>') && tb.includes('<a:tr h="' + EMU(0.3) + '">') && (tb.match(new RegExp('<a:tr h="' + EMU(0.27) + '">', "g")) || []).length === 2);
  const cells = [...tb.matchAll(/<a:tc>.*?<\/a:tc>/g)].map(m => m[0]);
  ok("table: navy header row with white bold text", cells.slice(0, 3).every(c => /b="1".*?val="FFFFFF"/.test(c) && c.includes('<a:solidFill><a:srgbClr val="262166"/></a:solidFill></a:tcPr>')));
  ok("table: alternating rows, thin grid-grey borders on every side", cells[3].includes('<a:srgbClr val="FFFFFF"/></a:solidFill></a:tcPr>') && cells[6].includes('<a:srgbClr val="F5F5FA"/></a:solidFill></a:tcPr>') &&
    cells.every(c => ["lnL", "lnR", "lnT", "lnB"].every(t => new RegExp("<a:" + t + ' w="6350"[^>]*><a:solidFill><a:srgbClr val="D9DCE6"/>').test(c))));
  ok("table: per-column alignment, a bold key row, a magenta cell", /<a:pPr algn="l">.*?<a:t>DPW<\/a:t>/.test(cells[3]) && /<a:pPr algn="r">/.test(cells[4]) && /<a:pPr algn="ctr">/.test(cells[5]) && /b="1"/.test(cells[6]) && /b="1".*?val="EB008C".*?<a:t>104.2<\/a:t>/.test(cells[8]) && /b="0"/.test(cells[3]));
  // charts
  const chartRels = sl[1].rels.filter(x => /\/chart$/.test(x.type));
  ok("charts: each is related from its slide and referenced by its frame", chartRels.length === 2 && chartRels.every(x => s2.includes('<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="' + x.id + '"/>')));
  const c1 = await read(z, chartRels[0].path), c2 = await read(z, chartRels[1].path);
  ok("clustered column chart: direction, grouping, gap width and overlap", c1.includes('<c:barDir val="col"/><c:grouping val="clustered"/>') && c1.includes('<c:gapWidth val="70"/><c:overlap val="-10"/>'));
  ok("chart data: series names, categories and values in the cache, a blank left blank", c1.includes("<c:v>DPW</c:v>") && c1.includes('<c:pt idx="2"><c:v>2025</c:v></c:pt>') && c1.includes('<c:pt idx="2"><c:v>122.5</c:v></c:pt>') && /<c:f>Sheet1!\$C\$2:\$C\$4<\/c:f><c:numCache><c:formatCode>General<\/c:formatCode><c:ptCount val="3"\/><c:pt idx="0"><c:v>80<\/c:v><\/c:pt><c:pt idx="2"><c:v>90<\/c:v>/.test(c1));
  ok("chart look: series colours, data labels with their number format, legend at the top, no title, hidden value axis", c1.includes('<c:spPr><a:solidFill><a:srgbClr val="EB008C"/>') && c1.includes('<c:numFmt formatCode="#,##0.0" sourceLinked="0"/>') && c1.includes('<c:showVal val="1"/>') && c1.includes('<c:legendPos val="t"/>') && c1.includes('<c:autoTitleDeleted val="1"/>') && /<c:valAx>.*<c:delete val="1"\/>/.test(c1));
  ok("stacked column: value axis kept with max, min and major unit; labels never outside the end", c2.includes('<c:grouping val="stacked"/>') && c2.includes('<c:overlap val="100"/>') && /<c:valAx><c:axId val="\d+"\/><c:scaling><c:orientation val="minMax"\/><c:max val="140"\/><c:min val="0"\/><\/c:scaling><c:delete val="0"\/>/.test(c2) && c2.includes('<c:majorUnit val="20"/>') && c2.includes("<c:majorGridlines>") && c2.includes('<c:dLblPos val="ctr"/>') && !c2.includes("outEnd"));
  const c3 = await read(z, sl[2].rels.filter(x => /\/chart$/.test(x.type))[0].path), c4 = await read(z, sl[2].rels.filter(x => /\/chart$/.test(x.type))[1].path);
  ok("bar charts: horizontal, top to bottom, no legend when asked; stacked bar too", c3.includes('<c:barDir val="bar"/><c:grouping val="clustered"/>') && c3.includes('<c:orientation val="maxMin"/>') && !c3.includes("<c:legend>") && c4.includes('<c:barDir val="bar"/><c:grouping val="stacked"/>'));
  const crel = await rels(z, chartRels[0].path);
  ok("each chart points at its own embedded workbook", crel.length === 1 && /\/package$/.test(crel[0].type) && /^ppt\/embeddings\/.+\.xlsx$/.test(crel[0].path) && c1.includes('<c:externalData r:id="' + crel[0].id + '"><c:autoUpdate val="0"/></c:externalData>'));
  const wb = await JSZip.loadAsync(await z.file(crel[0].path).async("nodebuffer"));
  const sheet = await read(wb, "xl/worksheets/sheet1.xml"), sst = await read(wb, "xl/sharedStrings.xml");
  const strs = [...sst.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(m => m[1]);
  const cell = ref => { const m = sheet.match(new RegExp('<c r="' + ref + '"( t="s")?><v>([^<]*)</v></c>')); return m ? (m[1] ? strs[+m[2]] : +m[2]) : undefined; };
  ok("the workbook holds the chart's data where the chart's formulas point (Edit data works)", cell("B1") === "DPW" && cell("C1") === "NPW" && cell("A2") === "2023" && cell("A4") === "2025" && cell("B4") === 122.5 && cell("C2") === 80 && cell("C3") === undefined && cell("C4") === 90, sheet);
  ok("the workbook is a complete package", ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"].every(n => !!wb.file(n)) && (await read(wb, "xl/workbook.xml")).includes('<sheet name="Sheet1" sheetId="1" r:id="rId1"/>'));

  // ----- hostile text -----
  const evilSpec = { slides: [{ kind: "cover", kicker: EVIL, title: EVIL, subtitle: EVIL }, { kind: "content", title: EVIL, items: [
    { type: "text", x: 1, y: 1.3, w: 3, h: 1, name: EVIL, paras: [{ runs: [{ text: EVIL, color: '"/><x' }] }] },
    { type: "bullets", x: 1, y: 2.5, w: 3, h: 1, items: [{ level: 0, runs: [{ text: EVIL, bold: true }] }] },
    { type: "tile", x: 5, y: 1.3, w: 2, h: 1, value: EVIL, label: EVIL }, { type: "header", text: EVIL, x: 5, y: 3, w: 4 },
    { type: "table", x: 1, y: 4, colW: [2, 2], rows: [[EVIL, "b"], [{ text: EVIL }, "d"]] },
    { type: "chart", kind: "column", x: 5, y: 4, w: 3, h: 2, categories: [EVIL, "b"], series: [{ name: EVIL, values: [1, 2] }], labels: { format: '0"/><x' } },
    { type: "source", text: EVIL }] }] };
  r = await build(TEMPLATE, evilSpec);
  ok("hostile text: the deck still builds", r.ok, r.message);
  z = await unzip(r); all = names(z);
  const xmls = await Promise.all(all.filter(n => /\.(xml|rels)$/.test(n)).map(async n => [n, await read(z, n)]));
  ok("hostile text: every part is still well-formed", (await wellFormed(xmls)).length === 0, await wellFormed(xmls));
  const joined = xmls.map(x => x[1]).join("");
  ok("hostile text: markup is escaped, never written as markup", !joined.includes("<script>") && joined.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;") && !joined.includes("<x") && !/<p:sp\/>/.test(joined));
  ok("hostile text: characters XML forbids are dropped, the rest is kept", !/[\u0001\u0008\u000B\uFFFE]/.test(joined) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(joined) && joined.includes("]]&gt;") && joined.includes(" end<"));
  const wb2 = await JSZip.loadAsync(await z.file(all.find(n => n.endsWith(".xlsx"))).async("nodebuffer"));
  ok("hostile text: the embedded workbook is escaped too", (await read(wb2, "xl/sharedStrings.xml")).includes("&lt;script&gt;") && (await wellFormed([["sst", await read(wb2, "xl/sharedStrings.xml")]])).length === 0);
  ok("hostile text: a bad colour falls back to navy", /<a:srgbClr val="262166"\/><\/a:solidFill><a:latin typeface="Arial"\/><a:cs typeface="Arial"\/><\/a:rPr><a:t>&lt;script/.test(joined));

  // ----- what build refuses -----
  r = await build(Buffer.from("not a pptx"), SPEC);
  ok("build: a non-PowerPoint file is refused with an Error in plain words", !r.ok && r.isError && r.message === "This file isn't a PowerPoint file. Choose your template saved as a .pptx file.", r);
  r = await build(noTitles, SPEC);
  ok("build: a template with no usable layout is refused with the inspect message", !r.ok && r.message.startsWith("Your template has no layout the profile can use for the cover."), r);
  r = await build(corporate, SPEC);
  z = await unzip(r);
  const cSlides = (await slides(z)).map(x => x.layoutName), cProblems = await packageProblems(z);
  ok("build: a corporate template's matched layouts are the ones used", r.ok && JSON.stringify(cSlides) === JSON.stringify(["Cover page", "Heading", "Heading"]) && cProblems.length === 0, [cSlides, cProblems]);

  // ----- the standard template that ships with the site (web/standard-template.pptx) -----
  r = await inspect(STANDARD);
  ok("standard: usable as it is, widescreen, no slides of its own, both layouts found by name", r.ok === true && r.slides === 0 && r.widthIn === 13.33 && r.heightIn === 7.5 &&
    JSON.stringify(r.layouts) === JSON.stringify({ cover: { name: "Title White", named: true }, content: { name: "Spectrum Title Only White", named: true } }) && r.note === "", r);
  const sz = await JSZip.loadAsync(STANDARD), sNames = names(sz);
  const sText = (await Promise.all(sNames.filter(n => /\.(xml|rels)$/.test(n)).map(n => read(sz, n)))).join("\n");
  ok("standard: no pictures, media, embedded files, thumbnail or macros", !sNames.some(n => /media\/|embeddings\/|thumbnail|vbaProject|\.(png|jpe?g|gif|emf|wmf|svg|bin)$/i.test(n)), sNames);
  ok("standard: no company name or person in it (the name built from pieces, as orgname.test.mjs does)", !new RegExp(["a", "s", "c", "o", "t"].join("") + "|lloyd|python-pptx|steve|canny", "i").test(sText.replace(/name="Spectrum Title Only White"/g, "")) && /<dc:creator><\/dc:creator>/.test(await read(sz, "docProps/core.xml")) && /<cp:lastModifiedBy><\/cp:lastModifiedBy>/.test(await read(sz, "docProps/core.xml")));
  const theme = await read(sz, "ppt/theme/theme1.xml");
  ok("standard: a neutral theme in Arial, none of the house colours", /<a:theme [^>]*name="Standard"/.test(theme) && (theme.match(/<a:latin typeface="Arial"/g) || []).length >= 2 && !new RegExp(NAVY + "|" + MAG + "|E6007E|1E2761|2B2464", "i").test(sText));
  ok("standard: five layouts, in an order and with names a person can work with", JSON.stringify(await Promise.all(sNames.filter(n => /slideLayouts\/slideLayout\d+\.xml$/.test(n)).map(async n => (await read(sz, n)).match(/<p:cSld name="([^"]*)"/)[1])).then(a => a.sort())) === JSON.stringify(["Blank", "Section Header", "Spectrum Title Only White", "Title White", "Title and Content"]));
  r = await build(STANDARD, SPEC);
  z = await unzip(r);
  const sSlides = await slides(z);
  ok("standard: a whole deck builds on it, with no package problems and well-formed parts", r.ok && sSlides.length === 3 && (await packageProblems(z)).length === 0 &&
    (await wellFormed(await Promise.all(names(z).filter(n => /\.(xml|rels)$/.test(n)).map(async n => [n, await read(z, n)])))).length === 0);
  ok("standard: on the layouts by name, with the cover's kicker, title and subtitle and the slide numbers filled", JSON.stringify(sSlides.map(x => x.layoutName)) === JSON.stringify(["Title White", "Spectrum Title Only White", "Spectrum Title Only White"]) &&
    /idx="10"\/>.*Corporate development \| November 2026/.test(sSlides[0].xml) && /<p:ph type="subTitle" idx="1"\/>/.test(sSlides[0].xml) && /type="slidenum"><a:rPr lang="en-US"\/><a:t>2</.test(sSlides[1].xml));
  r = await build(TEMPLATE, { slides: [] });
  ok("build: an empty plan is refused", !r.ok && r.message === "There are no slides to build.", r);
  r = await build(TEMPLATE, { slides: [{ kind: "content", title: "t", items: [{ type: "tile", y: 1, w: 1, h: 1, value: "1", label: "x" }] }] });
  ok("build: an item without a position is refused, naming where", !r.ok && r.message === "The slide plan has a problem: slide 1, item 1 has no x position.", r);
  r = await build(TEMPLATE, { slides: [{ kind: "content", title: "t", items: [{ type: "chart", kind: "pie", x: 1, y: 1, w: 1, h: 1, categories: ["a"], series: [{ name: "s", values: [1] }] }] }] });
  ok("build: a chart type it doesn't make is refused", !r.ok && /chart type the builder doesn't make/.test(r.message), r);
  r = await build(TEMPLATE, { slides: [{ kind: "content", title: "t", items: [{ type: "chart", kind: "bar", x: 1, y: 1, w: 1, h: 1, categories: ["a", "b"], series: [{ name: "s", values: [1] }] }] }] });
  ok("build: chart values that don't match the categories are refused", !r.ok && /values don't match its categories/.test(r.message), r);
  r = await build(TEMPLATE, { slides: [{ kind: "content", title: "t", items: [{ type: "table", x: 1, y: 1, colW: [1, 1], rows: [["a"]] }] }] });
  ok("build: a table row with the wrong number of cells is refused", !r.ok && /table row doesn't have 2 cells/.test(r.message), r);
  r = await build(TEMPLATE, { slides: [{ kind: "picture" }] });
  ok("build: a slide of unknown kind is refused", !r.ok && /neither a cover nor a content slide/.test(r.message), r);

  // a template saved as .potx becomes a presentation; a second build from the result also works
  const potx = await variant(async z => z.file("[Content_Types].xml", (await read(z, "[Content_Types].xml")).replace("presentation.main+xml", "template.main+xml")));
  r = await build(potx, { slides: SPEC.slides.slice(0, 1) });
  z = await unzip(r);
  ok("a .potx template gives a .pptx", r.ok && (await read(z, "[Content_Types].xml")).includes("presentationml.presentation.main+xml") && !(await read(z, "[Content_Types].xml")).includes("template.main+xml"));
  const again = await build(Buffer.from(r.b64, "base64"), SPEC);
  z = await unzip(again);
  ok("building on a built deck replaces its slides cleanly", again.ok && (await slides(z)).length === 3 && (await packageProblems(z)).length === 0);

  ok("no page errors", errs.length === 0, errs);
  await b.close();
  console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0);
})().catch(e => { console.log("FAIL crashed " + (e && e.stack)); console.log(pass + " passed, " + (fail + 1) + " failed"); process.exit(1); });
