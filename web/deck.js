// SNLDeck: builds a PowerPoint file (.pptx) on the team's own template, in the browser. It knows PowerPoint files and
// nothing about insurance. Needs window.JSZip (3.10.1), loaded first. Plain script: no modules, no build step.
//
//   SNLDeck.inspect(bytes)       -> Promise<{ok:true, slides, widthIn, heightIn, layouts:{cover:{name, named}, content:{name, named}}, note}
//                                    | {ok:false, message}>   (note: a plain sentence saying which layouts were matched, or "")
//   SNLDeck.build(bytes, spec)   -> Promise<Uint8Array>   (rejects with an Error whose message is a plain sentence)
//
// build opens the template (a zip of XML parts), removes its example slides cleanly (slide list, relationships,
// content types, slide parts, notes, and any picture, chart or embedded file nothing else uses), then adds the
// spec's slides on the template's own layouts: found by name, or else the closest match (see pickLayouts), so an
// ordinary corporate template works too. Everything is positioned in inches.
//
// spec = { fileName?, layouts?: {cover, content}, slides: [ slide ] }
//   cover slide:   { kind:"cover", kicker, title, subtitle }               (filled as the layout's placeholders)
//   content slide: { kind:"content", title, items:[ item ] }               (title placeholder + slide number)
// items (x, y, w, h in inches; colours as "RRGGBB"):
//   {type:"text", x,y,w,h, paras:[{runs:[{text,size,bold,italic,color}], align:"l"|"ctr"|"r", after}], anchor:"t"|"ctr"|"b", margin, name}
//   {type:"bullets", x,y,w,h, items:[{level:0|1, runs:[{text,bold}] | text}], size, subSize, after, name}
//   {type:"tile", x,y,w,h, value, label, color, fill, valueSize, labelSize, name}            (text inside the shape)
//   {type:"box", shape:"rect"|"ellipse", x,y,w,h, fill, line:{color,width}, paras, margins:[l,r,t,b], anchor, name}
//   {type:"header", text, x, y, w}                                     (centred 14pt bold navy, thin rule each side)
//   {type:"source", text}                                              (10pt italic grey at y 6.66)
//   {type:"line", x1,y1,x2,y2, color, width, dash}
//   {type:"numbered", x,y,w,h, n, title, text, inset, badge, badgeColor, name}   (oval badge with the digit inside)
//   {type:"table", x,y, colW:[], rowH: number|[], rows:[[cell]], header:true, aligns:["l"|"ctr"|"r"], size,
//        rowStyles:{rowIndex:{bold,color}}, name}       cell = string | {text, bold, color}
//   {type:"chart", kind:"column"|"stackedColumn"|"bar"|"stackedBar", x,y,w,h, categories:[], series:[{name, values,
//        color, pointColors:{i:color}, labelColor}], labels:{format, position, color, size} | false, legend:"top"|"none",
//        valueAxis:{max, min, major, format} | null, gap, overlap, catSize, catLabels:"low"|"nextTo", name}
//        (catLabels "low" puts the category labels at the bottom, clear of columns below zero)
(function () {
  "use strict";
  var NS = {
    a: "http://schemas.openxmlformats.org/drawingml/2006/main",
    r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    p: "http://schemas.openxmlformats.org/presentationml/2006/main",
    c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
    pr: "http://schemas.openxmlformats.org/package/2006/relationships",
    ct: "http://schemas.openxmlformats.org/package/2006/content-types",
    ep: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    vt: "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
    s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  };
  var RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  var CT = {
    slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    chart: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pres: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    potx: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
    rels: "application/vnd.openxmlformats-package.relationships+xml"
  };
  var LAYOUTS = { cover: "Title White", content: "Spectrum Title Only White" };
  var EMU = 914400, DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var NAVY = "262166", MAG = "EB008C", GREY = "666666", TILE = "EEEEF5", ALT = "F5F5FA", GRID = "D9DCE6", WHITE = "FFFFFF";
  var SLIDE_W = 13.333, SLIDE_H = 7.5;

  // ---------- text that goes into XML ----------
  // Characters XML 1.0 forbids (most control characters, lone surrogates, U+FFFE/U+FFFF) are dropped; the rest is escaped.
  var BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  function clean(s) {
    s = s == null ? "" : String(s);
    // a lone low surrogate match may include the character before it: keep that character
    return s.replace(BAD, function (m) { return m.length > 1 && !/[\uDC00-\uDFFF]/.test(m[0]) ? m[0] : ""; });
  }
  function esc(s) {
    return clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function oneLine(s) { return clean(s).replace(/[\r\n\t\u2028\u2029]+/g, " "); }
  function emu(inches) { return Math.round(inches * EMU); }
  function color(c, fallback) { c = String(c || fallback || NAVY).replace(/^#/, "").toUpperCase(); return /^[0-9A-F]{6}$/.test(c) ? c : (fallback || NAVY); }
  function num(v) { return typeof v === "number" && isFinite(v); }
  function fail(msg) { throw new Error(msg); }
  // Office files have no folder entries in the zip
  function put(zip, path, data) { zip.file(path, data, { createFolders: false }); }

  // ---------- package helpers ----------
  function dirOf(path) { var i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); }
  function relsPathOf(path) { var d = dirOf(path), f = path.slice(d.length ? d.length + 1 : 0); return (d ? d + "/" : "") + "_rels/" + f + ".rels"; }
  function resolve(base, target) {
    if (target.charAt(0) === "/") return target.slice(1);
    var parts = (base ? base.split("/") : []).concat(target.split("/")), out = [];
    parts.forEach(function (p) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); });
    return out.join("/");
  }
  function relTarget(from, to) {
    var a = dirOf(from).split("/").filter(Boolean), b = to.split("/");
    var i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    var up = []; for (var k = i; k < a.length; k++) up.push("..");
    return up.concat(b.slice(i)).join("/");
  }
  function parse(xml, what) {
    var doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) fail("Part of the template is damaged (" + what + "), so it can't be used. Save the template again in PowerPoint and upload it again.");
    return doc;
  }
  function serialize(doc) { return DECL + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, ""); }
  function kids(el, ns, name) { var out = []; if (!el) return out; for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.namespaceURI === ns && n.localName === name) out.push(n); return out; }
  function kid(el, ns, name) { return kids(el, ns, name)[0] || null; }

  function Pkg(zip) { this.zip = zip; this.docs = {}; this.dirty = {}; }
  Pkg.prototype.touch = function (path) { this.dirty[path] = true; };
  Pkg.prototype.has = function (path) { return !!this.zip.file(path); };
  Pkg.prototype.text = function (path) { var f = this.zip.file(path); return f ? f.async("string") : Promise.resolve(null); };
  Pkg.prototype.doc = function (path) {
    var self = this;
    if (self.docs[path]) return Promise.resolve(self.docs[path]);
    return self.text(path).then(function (t) { if (t == null) return null; var d = parse(t, path); self.docs[path] = d; return d; });
  };
  Pkg.prototype.rels = function (path) {
    return this.doc(relsPathOf(path)).then(function (d) {
      if (!d) return [];
      return Array.prototype.map.call(d.getElementsByTagNameNS(NS.pr, "Relationship"), function (r) {
        return { id: r.getAttribute("Id"), type: r.getAttribute("Type"), target: r.getAttribute("Target"), external: r.getAttribute("TargetMode") === "External", el: r,
          path: r.getAttribute("TargetMode") === "External" ? null : resolve(dirOf(path), r.getAttribute("Target") || "") };
      });
    });
  };
  Pkg.prototype.flush = function () {
    var self = this;
    Object.keys(self.dirty).forEach(function (p) { if (self.docs[p] && self.has(p)) put(self.zip, p, serialize(self.docs[p])); });
  };
  Pkg.prototype.remove = function (path) { this.zip.remove(path); delete this.docs[path]; var rp = relsPathOf(path); if (this.has(rp)) { this.zip.remove(rp); delete this.docs[rp]; } };
  // every part reachable from the package root through relationships
  Pkg.prototype.reachable = function () {
    var self = this, seen = {}, queue = [""];
    function step() {
      if (!queue.length) return Promise.resolve(seen);
      var part = queue.shift();
      var rp = part === "" ? "_rels/.rels" : relsPathOf(part);
      return self.doc(rp).then(function (d) {
        if (d) Array.prototype.forEach.call(d.getElementsByTagNameNS(NS.pr, "Relationship"), function (r) {
          if (r.getAttribute("TargetMode") === "External") return;
          var t = resolve(part === "" ? "" : dirOf(part), r.getAttribute("Target") || "");
          if (!seen[t] && self.has(t)) { seen[t] = true; queue.push(t); }
        });
        return step();
      });
    }
    return step();
  };

  // ---------- opening and checking a template ----------
  var NOT_PPTX = "This file isn't a PowerPoint file. Choose your template saved as a .pptx file.";
  function open(bytes) {
    if (!window.JSZip) return Promise.reject(new Error("The zip library didn't load. Reload the page and try again."));
    var u8 = bytes instanceof Uint8Array ? bytes : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
    if (!u8 || !u8.length) return Promise.reject(new Error("The file is empty. Choose your template saved as a .pptx file."));
    if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0)
      return Promise.reject(new Error("This file is in the old PowerPoint format (.ppt) or is protected with a password. Open it in PowerPoint, save it as a .pptx without a password, and upload it again."));
    return window.JSZip.loadAsync(u8).catch(function () { throw new Error(NOT_PPTX); }).then(function (zip) {
      var pkg = new Pkg(zip);
      return pkg.rels("").then(function (rootRels) {
        var main = rootRels.filter(function (r) { return /\/officeDocument$/.test(r.type) && !r.external; })[0];
        if (!main || !pkg.has(main.path)) throw new Error(NOT_PPTX);
        pkg.main = main.path;
        return pkg.doc(main.path).catch(function () { throw new Error(NOT_PPTX); });
      }).then(function (pres) {
        if (!pres || pres.documentElement.namespaceURI !== NS.p || pres.documentElement.localName !== "presentation") throw new Error(NOT_PPTX);
        pkg.pres = pres;
        return pkg.rels(pkg.main);
      }).then(function (presRels) {
        pkg.presRels = presRels;
        var masters = presRels.filter(function (r) { return /\/slideMaster$/.test(r.type) && r.path; });
        return Promise.all(masters.map(function (m) { return pkg.rels(m.path); }));
      }).then(function (masterRels) {
        var paths = [];
        masterRels.forEach(function (rs) { rs.forEach(function (r) { if (/\/slideLayout$/.test(r.type) && r.path && paths.indexOf(r.path) < 0 && pkg.has(r.path)) paths.push(r.path); }); });
        return Promise.all(paths.map(function (p) { return pkg.doc(p).then(function (d) { return { path: p, doc: d }; }); }));
      }).then(function (layouts) {
        pkg.layouts = layouts.map(function (l) {
          var cSld = l.doc.getElementsByTagNameNS(NS.p, "cSld")[0];
          return { path: l.path, doc: l.doc, name: cSld ? (cSld.getAttribute("name") || "") : "" };
        });
        var sz = pkg.pres.getElementsByTagNameNS(NS.p, "sldSz")[0];
        pkg.widthIn = sz ? +sz.getAttribute("cx") / EMU : 0; pkg.heightIn = sz ? +sz.getAttribute("cy") / EMU : 0;
        return pkg;
      });
    });
  }

  function placeholders(layoutDoc) {
    var out = [];
    Array.prototype.forEach.call(layoutDoc.getElementsByTagNameNS(NS.p, "ph"), function (ph) {
      var sp = ph.parentNode && ph.parentNode.parentNode && ph.parentNode.parentNode.parentNode;
      if (!sp || sp.localName !== "sp") return;
      var cNvPr = sp.getElementsByTagNameNS(NS.p, "cNvPr")[0], fld = sp.getElementsByTagNameNS(NS.a, "fld")[0];
      out.push({ type: ph.getAttribute("type") || "obj", idx: ph.hasAttribute("idx") ? +ph.getAttribute("idx") : 0, el: ph,
        name: cNvPr ? cNvPr.getAttribute("name") : "", fldId: fld ? fld.getAttribute("id") : null });
    });
    return out;
  }
  function findLayout(pkg, name) {
    var exact = pkg.layouts.filter(function (l) { return l.name === name; })[0];
    if (exact) return exact;
    var norm = function (s) { return String(s).trim().replace(/\s+/g, " ").toLowerCase(); };
    return pkg.layouts.filter(function (l) { return norm(l.name) === norm(name); })[0] || null;
  }
  // the roles a layout's placeholders play, read from the layout itself
  function roles(layout) {
    var phs = placeholders(layout.doc);
    var title = phs.filter(function (p) { return p.type === "title" || p.type === "ctrTitle"; })[0] || null;
    var bodyish = phs.filter(function (p) { return p.type === "body" || p.type === "obj" || p.type === "subTitle"; });
    var subtitle = phs.filter(function (p) { return p.type === "subTitle"; })[0] || bodyish.filter(function (p) { return p.idx === 1; })[0] || null;
    var rest = bodyish.filter(function (p) { return p !== subtitle; }).sort(function (a, b) { return a.idx - b.idx; });
    var kicker = rest.filter(function (p) { return p.idx === 10; })[0] || rest[0] || null;
    var number = phs.filter(function (p) { return p.type === "sldNum"; })[0] || null;
    return { title: title, subtitle: subtitle, kicker: kicker, number: number };
  }
  // ---------- choosing the layouts ----------
  // The layouts named in names (exactly, or with different spacing or letter case) when they have a title box.
  // Otherwise the closest match, so an ordinary corporate template works too:
  //   cover:   a layout with a title and a subtitle box (PowerPoint's "Title Slide" is the model)
  //   content: a layout with a title box and as little else as possible (PowerPoint's "Title Only")
  // Ties go to the layout listed first in the template. Pictures and footers drawn on a layout don't matter.
  var DECOR = { dt: 1, ftr: 1, sldNum: 1, hdr: 1 };
  var FILLS = { pic: 1, chart: 1, tbl: 1, dgm: 1, media: 1, clipArt: 1 };
  function layoutType(l) { return l.doc.documentElement.getAttribute("type") || ""; }
  function coverScore(l) {
    var r = roles(l);
    if (!r.title || !r.subtitle || r.subtitle.type === "obj") return -1;
    var s = 1;
    if (layoutType(l) === "title") s += 8;
    if (r.title.type === "ctrTitle") s += 4;
    if (r.subtitle.type === "subTitle") s += 4;
    if (/\b(title slide|cover)\b/i.test(l.name)) s += 2;
    if (placeholders(l.doc).some(function (p) { return FILLS[p.type]; })) s -= 3;   // a cover that expects a picture would show it empty
    return Math.max(s, 0);
  }
  function contentScore(l) {
    var r = roles(l);
    if (!r.title) return -1;
    var others = placeholders(l.doc).filter(function (p) { return p.el !== r.title.el && !DECOR[p.type]; });
    var s = 1;
    if (layoutType(l) === "titleOnly") s += 8;
    if (/\btitle only\b/i.test(l.name)) s += 4;
    if (!others.length) s += 4;
    if (r.number) s += 1;
    if (r.title.type === "ctrTitle") s -= 2;
    return Math.max(s, 0);
  }
  function best(pkg, score, avoid) {
    var top = null, topScore = -1;
    pkg.layouts.forEach(function (l) { var s = score(l); if (s > topScore || (s === topScore && top === avoid && l !== avoid)) { top = l; topScore = s; } });
    return topScore < 0 ? null : top;
  }
  function quoted(l) { return l.name ? "\"" + l.name + "\"" : "an unnamed layout"; }
  // -> {cover:{layout, named}, content:{layout, named}, note} or {problem}
  function pickLayouts(pkg, names) {
    var cl = findLayout(pkg, names.cover), tl = findLayout(pkg, names.content), notes = [];
    var cover = cl && roles(cl).title ? { layout: cl, named: true } : null;
    var content = tl && roles(tl).title ? { layout: tl, named: true } : null;
    if (!cover) {
      var c = best(pkg, coverScore, content && content.layout);
      if (!c) return { problem: "Your template has no layout the profile can use for the cover. It needs a layout named \"" + names.cover + "\", or one with a title box and a subtitle box, like PowerPoint's \"Title Slide\"." };
      cover = { layout: c, named: false };
      notes.push("It has no layout named \"" + names.cover + "\", so the cover uses " + quoted(c) + ".");
    }
    if (!content) {
      var t = best(pkg, contentScore, cover.layout);
      if (!t) return { problem: "Your template has no layout the profile can use for its other slides. It needs a layout named \"" + names.content + "\", or one with a title box, like PowerPoint's \"Title Only\"." };
      content = { layout: t, named: false };
      notes.push("It has no layout named \"" + names.content + "\", so the other slides use " + quoted(t) + ".");
    }
    return { cover: cover, content: content, note: notes.join(" ") };
  }
  function check(pkg, names) {
    var w = Math.round(pkg.widthIn * 100) / 100, h = Math.round(pkg.heightIn * 100) / 100;
    if (Math.abs(pkg.widthIn - SLIDE_W) > 0.05 || Math.abs(pkg.heightIn - SLIDE_H) > 0.05)
      return { problem: "Your template's slides are " + w + " x " + h + " in, but the profile is laid out for widescreen slides (13.33 x 7.5 in). Choose a widescreen PowerPoint template." };
    return pickLayouts(pkg, names);
  }
  function slideList(pkg) {
    var lst = kid(pkg.pres.documentElement, NS.p, "sldIdLst");
    return kids(lst, NS.p, "sldId");
  }

  function inspect(bytes) {
    return open(bytes).then(function (pkg) {
      var pick = check(pkg, LAYOUTS);
      if (pick.problem) return { ok: false, message: pick.problem };
      return { ok: true, slides: slideList(pkg).length, widthIn: Math.round(pkg.widthIn * 100) / 100, heightIn: Math.round(pkg.heightIn * 100) / 100,
        layouts: { cover: { name: pick.cover.layout.name, named: pick.cover.named }, content: { name: pick.content.layout.name, named: pick.content.named } }, note: pick.note };
    }, function (e) { return { ok: false, message: e.message }; });
  }

  // ---------- removing the example slides ----------
  function removeSlides(pkg) {
    var presEl = pkg.pres.documentElement, rid = function (el) { return el.getAttributeNS(NS.r, "id"); };
    var slideRels = pkg.presRels.filter(function (r) { return /\/slide$/.test(r.type); });
    var gone = {}; slideRels.forEach(function (r) { if (r.path) gone[r.path] = true; });
    var goneIds = {}, maxId = 255;
    slideList(pkg).forEach(function (s) { goneIds[s.getAttribute("id")] = true; maxId = Math.max(maxId, +s.getAttribute("id") || 0); s.parentNode.removeChild(s); });
    pkg.nextSlideId = maxId + 1;
    var goneRids = {}; slideRels.forEach(function (r) { goneRids[r.id] = true; r.el.parentNode.removeChild(r.el); });
    pkg.presRels = pkg.presRels.filter(function (r) { return !goneRids[r.id]; });
    pkg.touch(pkg.main); pkg.touch(relsPathOf(pkg.main));
    // custom shows that list removed slides
    var shows = kid(presEl, NS.p, "custShowLst");
    if (shows) {
      kids(shows, NS.p, "custShow").forEach(function (cs) {
        var lst = kid(cs, NS.p, "sldLst");
        kids(lst, NS.p, "sld").forEach(function (s) { if (goneRids[rid(s)]) s.parentNode.removeChild(s); });
        if (!kids(lst, NS.p, "sld").length) cs.parentNode.removeChild(cs);
      });
      if (!kids(shows, NS.p, "custShow").length) presEl.removeChild(shows);
    }
    // sections (p14:sectionLst inside an extension): they list the removed slides, so the list goes
    var ext = kid(presEl, NS.p, "extLst");
    if (ext) {
      kids(ext, NS.p, "ext").forEach(function (e) {
        for (var n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === "sectionLst") { ext.removeChild(e); break; }
      });
      if (!kids(ext, NS.p, "ext").length) presEl.removeChild(ext);
    }
    return pkg;
  }
  // after removal: drop every part that was reachable before and isn't now (slides, notes, charts, embedded
  // workbooks, pictures only the slides used), relationships that still point at removed slides, and stale content types
  function collect(pkg, before) {
    return pkg.reachable().then(function (after) {
      var dead = Object.keys(before).filter(function (p) { return !after[p]; });
      dead.forEach(function (p) { pkg.remove(p); });
      // the outline view in viewProps can name slides; other parts must not point at removed parts
      var paths = Object.keys(pkg.zip.files).filter(function (p) { return /\.rels$/.test(p) && !pkg.zip.files[p].dir; });
      var views = [];
      return Promise.all(paths.map(function (rp) {
        return pkg.doc(rp).then(function (d) {
          if (!d) return;
          var owner = rp.replace(/(^|\/)_rels\/([^/]+)\.rels$/, function (m, a, f) { return a + f; });
          var base = rp === "_rels/.rels" ? "" : dirOf(owner);
          Array.prototype.slice.call(d.getElementsByTagNameNS(NS.pr, "Relationship")).forEach(function (r) {
            if (r.getAttribute("TargetMode") === "External") return;
            if (pkg.has(resolve(base, r.getAttribute("Target") || ""))) return;
            r.parentNode.removeChild(r); pkg.touch(rp);
            if (/viewProps\.xml$/.test(owner)) views.push({ owner: owner, id: r.getAttribute("Id") });
          });
        });
      })).then(function () {
        return Promise.all(views.map(function (v) {
          return pkg.doc(v.owner).then(function (d) {
            if (!d) return;
            pkg.touch(v.owner);
            Array.prototype.slice.call(d.getElementsByTagNameNS(NS.p, "sld")).forEach(function (s) { if (s.getAttributeNS(NS.r, "id") === v.id) s.parentNode.removeChild(s); });
            Array.prototype.slice.call(d.getElementsByTagNameNS(NS.p, "sldLst")).forEach(function (l) { if (!kids(l, NS.p, "sld").length) l.parentNode.removeChild(l); });
          });
        }));
      });
    });
  }

  // ---------- content types and app properties ----------
  function contentTypes(pkg) { return pkg.doc("[Content_Types].xml"); }
  function setOverride(ct, path, type) {
    var root = ct.documentElement, name = "/" + path;
    var have = kids(root, NS.ct, "Override").filter(function (o) { return o.getAttribute("PartName").toLowerCase() === name.toLowerCase(); })[0];
    if (have) { have.setAttribute("ContentType", type); return; }
    var o = ct.createElementNS(NS.ct, "Override"); o.setAttribute("PartName", name); o.setAttribute("ContentType", type); root.appendChild(o);
  }
  function ensureDefault(ct, ext, type) {
    var root = ct.documentElement;
    if (kids(root, NS.ct, "Default").some(function (d) { return d.getAttribute("Extension").toLowerCase() === ext; })) return;
    var d = ct.createElementNS(NS.ct, "Default"); d.setAttribute("Extension", ext); d.setAttribute("ContentType", type);
    var first = kid(root, NS.ct, "Override"); root.insertBefore(d, first);
  }
  function tidyContentTypes(pkg, ct) {
    kids(ct.documentElement, NS.ct, "Override").forEach(function (o) { if (!pkg.has(o.getAttribute("PartName").replace(/^\//, ""))) o.parentNode.removeChild(o); });
    // a template (.potx) becomes a presentation
    kids(ct.documentElement, NS.ct, "Override").forEach(function (o) { if (o.getAttribute("ContentType") === CT.potx) o.setAttribute("ContentType", CT.pres); });
  }
  function updateApp(pkg, titles) {
    return pkg.doc("docProps/app.xml").then(function (app) {
      if (!app) return;
      pkg.touch("docProps/app.xml");
      var root = app.documentElement;
      var setText = function (name, v) { var el = kid(root, NS.ep, name); if (el) el.textContent = String(v); };
      setText("Slides", titles.length); setText("Notes", 0); setText("HiddenSlides", 0); setText("MMClips", 0);
      var hp = kid(kid(root, NS.ep, "HeadingPairs"), NS.vt, "vector"), tp = kid(kid(root, NS.ep, "TitlesOfParts"), NS.vt, "vector");
      if (!hp || !tp) return;
      var variants = kids(hp, NS.vt, "variant"), names = kids(tp, NS.vt, "lpstr"), pairs = [], at = 0;
      for (var i = 0; i + 1 < variants.length; i += 2) {
        var label = (variants[i].textContent || "").trim(), cnt = parseInt(variants[i + 1].textContent, 10) || 0;
        pairs.push({ label: label, items: names.slice(at, at + cnt).map(function (n) { return n.textContent; }) }); at += cnt;
      }
      var slidePair = pairs.filter(function (p) { return p.label === "Slide Titles"; })[0];
      if (!slidePair) { slidePair = { label: "Slide Titles", items: [] }; pairs.push(slidePair); }
      slidePair.items = titles.map(oneLine);
      while (hp.firstChild) hp.removeChild(hp.firstChild);
      while (tp.firstChild) tp.removeChild(tp.firstChild);
      var all = [];
      pairs.forEach(function (p) {
        var v1 = app.createElementNS(NS.vt, "vt:variant"), s = app.createElementNS(NS.vt, "vt:lpstr"); s.textContent = p.label; v1.appendChild(s); hp.appendChild(v1);
        var v2 = app.createElementNS(NS.vt, "vt:variant"), n = app.createElementNS(NS.vt, "vt:i4"); n.textContent = String(p.items.length); v2.appendChild(n); hp.appendChild(v2);
        all = all.concat(p.items);
      });
      all.forEach(function (t) { var s = app.createElementNS(NS.vt, "vt:lpstr"); s.textContent = clean(t); tp.appendChild(s); });
      hp.setAttribute("size", String(pairs.length * 2)); tp.setAttribute("size", String(all.length));
    });
  }

  // ---------- drawing ----------
  function rPr(r) {
    var size = num(r.size) ? Math.round(r.size * 100) : 1400;
    return '<a:rPr lang="en-US" sz="' + size + '" b="' + (r.bold ? 1 : 0) + '" i="' + (r.italic ? 1 : 0) + '" dirty="0">' +
      '<a:solidFill><a:srgbClr val="' + color(r.color) + '"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr>';
  }
  function run(r) { return "<a:r>" + rPr(r) + "<a:t>" + esc(oneLine(r.text)) + "</a:t></a:r>"; }
  var ALIGN = { l: "l", left: "l", ctr: "ctr", c: "ctr", center: "ctr", r: "r", right: "r" };
  function para(p, extraPPr) {
    var runs = (p.runs || []).filter(function (r) { return r && r.text != null && String(r.text) !== ""; });
    var after = num(p.after) ? '<a:spcAft><a:spcPts val="' + Math.round(p.after * 100) + '"/></a:spcAft>' : "";
    var pPr = '<a:pPr algn="' + (ALIGN[p.align] || "l") + '"' + (extraPPr ? extraPPr.attrs : "") + ">" + after + (extraPPr ? extraPPr.kids : "") + "</a:pPr>";
    var first = (p.runs || [])[0] || {};
    var end = '<a:endParaRPr lang="en-US" sz="' + (num(first.size) ? Math.round(first.size * 100) : 1400) + '" dirty="0"/>';
    return "<a:p>" + pPr + runs.map(run).join("") + end + "</a:p>";
  }
  function bodyPr(o) {
    var m = o.margins || [o.margin, o.margin, o.margin, o.margin];
    var ins = function (v, d) { return emu(num(v) ? v : d); };
    return '<a:bodyPr wrap="square" lIns="' + ins(m[0], 0.1) + '" tIns="' + ins(m[2], 0.05) + '" rIns="' + ins(m[1], 0.1) + '" bIns="' + ins(m[3], 0.05) +
      '" rtlCol="0" anchor="' + ({ t: "t", top: "t", ctr: "ctr", middle: "ctr", b: "b", bottom: "b" }[o.anchor] || "t") + '">' + (o.autofit ? "<a:spAutoFit/>" : "<a:noAutofit/>") + "</a:bodyPr>";
  }
  function xfrm(x, y, w, h, tag) {
    tag = tag || "a:xfrm";
    return "<" + tag + '><a:off x="' + emu(x) + '" y="' + emu(y) + '"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></' + tag + ">";
  }
  function needBox(it, where) {
    ["x", "y", "w", "h"].forEach(function (k) { if (!num(it[k])) fail("The slide plan has a problem: " + where + " has no " + k + " position."); });
    if (it.w < 0 || it.h < 0) fail("The slide plan has a problem: " + where + " has a negative size.");
  }

  function Slide(n) { this.n = n; this.nextId = 2; this.xml = []; this.charts = []; }
  Slide.prototype.id = function () { return this.nextId++; };

  function textShape(s, it, txBox) {
    var id = s.id(), name = it.name || ((txBox ? "TextBox " : "Shape ") + (id - 1));
    var geom = '<a:prstGeom prst="' + (it.shape === "ellipse" ? "ellipse" : "rect") + '"><a:avLst/></a:prstGeom>';
    var fill = it.fill ? '<a:solidFill><a:srgbClr val="' + color(it.fill) + '"/></a:solidFill>' : "<a:noFill/>";
    var line = txBox ? "" : (it.line ? '<a:ln w="' + Math.round((num(it.line.width) ? it.line.width : 1) * 12700) + '"><a:solidFill><a:srgbClr val="' + color(it.line.color) + '"/></a:solidFill></a:ln>' : "<a:ln><a:noFill/></a:ln>");
    var paras = (it.paras && it.paras.length ? it.paras : [{ runs: [] }]).map(function (p) { return para(p); }).join("");
    s.xml.push('<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(oneLine(name)) + '"/><p:cNvSpPr' + (txBox ? ' txBox="1"' : "") + "/><p:nvPr/></p:nvSpPr>" +
      "<p:spPr>" + xfrm(it.x, it.y, it.w, it.h) + geom + fill + line + "</p:spPr>" +
      "<p:txBody>" + bodyPr(it) + "<a:lstStyle/>" + paras + "</p:txBody></p:sp>");
  }
  function lineShape(s, it) {
    var x1 = it.x1, y1 = it.y1, x2 = it.x2, y2 = it.y2;
    if (![x1, y1, x2, y2].every(num)) fail("The slide plan has a problem: a line has no position.");
    var id = s.id(), flip = "";
    var x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if ((x2 < x1) !== (y2 < y1) && w && h) flip = ' flipV="1"';
    var dash = it.dash ? '<a:prstDash val="dash"/>' : "";
    s.xml.push('<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="' + id + '" name="' + esc(oneLine(it.name || "Connector " + (id - 1))) + '"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>' +
      "<p:spPr><a:xfrm" + flip + '><a:off x="' + emu(x) + '" y="' + emu(y) + '"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></a:xfrm>' +
      '<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="' + Math.round((num(it.width) ? it.width : 1) * 12700) + '"><a:solidFill><a:srgbClr val="' + color(it.color) + '"/></a:solidFill>' + dash + "</a:ln></p:spPr></p:cxnSp>");
  }
  function bulletsShape(s, it) {
    var size = num(it.size) ? it.size : 14, sub = num(it.subSize) ? it.subSize : 13, after = num(it.after) ? it.after : 5;
    var paras = (it.items || []).map(function (b) {
      var level = b.level ? 1 : 0;
      var runs = typeof b === "string" ? [{ text: b }] : (typeof b.runs === "string" ? [{ text: b.runs }] : (b.runs || [{ text: b.text }]));
      var ppr = { attrs: ' marL="' + emu(level ? 0.42 : 0.18) + '" indent="' + (-emu(0.17)) + '"',
        kids: '<a:buClr><a:srgbClr val="' + (level ? NAVY : MAG) + '"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="' + (level ? "\u2013" : "\u2022") + '"/>' };
      return para({ after: after, align: "l", runs: runs.map(function (r) { return { text: r.text, bold: r.bold, italic: r.italic, size: level ? sub : size, color: r.color || NAVY }; }) }, ppr);
    }).join("");
    var id = s.id();
    s.xml.push('<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(oneLine(it.name || "Bullets " + (id - 1))) + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
      "<p:spPr>" + xfrm(it.x, it.y, it.w, it.h) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
      "<p:txBody>" + bodyPr({ margin: 0.02, anchor: "t" }) + "<a:lstStyle/>" + (paras || '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>') + "</p:txBody></p:sp>");
  }
  function headerShape(s, it) {
    if (![it.x, it.y, it.w].every(num)) fail("The slide plan has a problem: a section header has no position.");
    var text = oneLine(it.text), tw = Math.min(it.w - 0.4, text.length * 0.098 + 0.35), tx = it.x + (it.w - tw) / 2;
    textShape(s, { x: tx, y: it.y, w: tw, h: 0.32, margin: 0, anchor: "ctr", name: it.name || "Header " + text,
      paras: [{ align: "ctr", runs: [{ text: text, size: 14, bold: true, color: NAVY }] }] }, true);
    if (tx - it.x > 0.1) {
      lineShape(s, { x1: it.x, y1: it.y + 0.16, x2: tx - 0.08, y2: it.y + 0.16, color: NAVY, width: 1 });
      lineShape(s, { x1: tx + tw + 0.08, y1: it.y + 0.16, x2: it.x + it.w, y2: it.y + 0.16, color: NAVY, width: 1 });
    }
  }
  function tileShape(s, it) {
    textShape(s, { x: it.x, y: it.y, w: it.w, h: it.h, fill: it.fill || TILE, margins: [0.15, 0.15, 0.1, 0.1], anchor: "ctr", name: it.name || "Tile " + oneLine(it.label),
      paras: [{ after: 2, runs: [{ text: it.value, size: num(it.valueSize) ? it.valueSize : 26, bold: true, color: it.color || NAVY }] },
              { runs: [{ text: it.label, size: num(it.labelSize) ? it.labelSize : 11, color: NAVY }] }] });
  }
  function numberedShape(s, it) {
    var inset = num(it.inset) ? it.inset : 1.05, badge = num(it.badge) ? it.badge : 0.6;
    textShape(s, { x: it.x, y: it.y, w: it.w, h: it.h, fill: it.fill || TILE, margins: [inset, 0.2, 0.2, 0.15], anchor: "t", name: it.name || "Question " + it.n,
      paras: [{ after: 4, runs: [{ text: it.title, size: num(it.titleSize) ? it.titleSize : 14, bold: true, color: NAVY }] },
              { runs: [{ text: it.text, size: num(it.size) ? it.size : 12, color: NAVY }] }] });
    textShape(s, { shape: "ellipse", x: it.x + (inset - badge) / 2, y: it.y + 0.2, w: badge, h: badge, fill: it.badgeColor || MAG, margins: [0, 0, 0, 0], anchor: "ctr",
      name: "Badge " + it.n, paras: [{ align: "ctr", runs: [{ text: String(it.n), size: 20, bold: true, color: WHITE }] }] });
  }
  function border(tag) {
    return "<a:" + tag + ' w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="' + GRID + '"/></a:solidFill><a:prstDash val="solid"/><a:round/>' +
      '<a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></a:' + tag + ">";
  }
  function tableShape(s, it) {
    var rows = it.rows || [], colW = it.colW || [];
    if (!rows.length) return;
    if (!num(it.x) || !num(it.y)) fail("The slide plan has a problem: a table has no position.");
    var nc = colW.length;
    if (!nc || !colW.every(num)) fail("The slide plan has a problem: a table has no column widths.");
    rows.forEach(function (r) { if (!Array.isArray(r) || r.length !== nc) fail("The slide plan has a problem: a table row doesn't have " + nc + " cells."); });
    var rh = Array.isArray(it.rowH) ? it.rowH : rows.map(function () { return num(it.rowH) ? it.rowH : 0.3; });
    var size = num(it.size) ? it.size : 11, header = it.header !== false, styles = it.rowStyles || {};
    var w = colW.reduce(function (a, b) { return a + b; }, 0), h = rh.reduce(function (a, b) { return a + b; }, 0);
    var grid = colW.map(function (c) { return '<a:gridCol w="' + emu(c) + '"/>'; }).join("");
    var trs = rows.map(function (row, i) {
      var head = header && i === 0, st = styles[i] || {};
      return '<a:tr h="' + emu(rh[i]) + '">' + row.map(function (cell, j) {
        var c = cell && typeof cell === "object" ? cell : { text: cell };
        var al = (it.aligns && it.aligns[j]) || (j === 0 ? "l" : "r");
        var col = head ? WHITE : color(c.color || st.color, NAVY), bold = head || !!c.bold || !!st.bold;
        var fill = head ? NAVY : (i % 2 === 0 ? ALT : WHITE);
        return "<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>" + para({ align: al, runs: [{ text: c.text == null ? "" : c.text, size: size, bold: bold, color: col }] }) + "</a:txBody>" +
          '<a:tcPr marL="' + emu(0.07) + '" marR="' + emu(0.07) + '" marT="' + emu(0.03) + '" marB="' + emu(0.03) + '" anchor="ctr">' +
          border("lnL") + border("lnR") + border("lnT") + border("lnB") + '<a:solidFill><a:srgbClr val="' + fill + '"/></a:solidFill></a:tcPr></a:tc>';
      }).join("") + "</a:tr>";
    }).join("");
    var id = s.id();
    s.xml.push('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="' + esc(oneLine(it.name || "Table " + (id - 1))) + '"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
      xfrm(it.x, it.y, w, h, "p:xfrm") + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0">' +
      "<a:tableStyleId>{2D5ABB26-0587-4C30-8999-92F81FD0307C}</a:tableStyleId></a:tblPr><a:tblGrid>" + grid + "</a:tblGrid>" + trs + "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>");
  }
  function chartShape(s, it, where) {
    needBox(it, where);
    var kinds = { column: ["col", "clustered"], stackedColumn: ["col", "stacked"], bar: ["bar", "clustered"], stackedBar: ["bar", "stacked"] };
    if (!kinds[it.kind]) fail("The slide plan has a problem: " + where + " asks for a chart type the builder doesn't make.");
    var cats = (it.categories || []).map(function (c) { return oneLine(c); });
    if (!cats.length) fail("The slide plan has a problem: " + where + " has a chart with no categories.");
    var series = (it.series || []).map(function (sr) {
      var vals = (sr.values || []).map(function (v) { return num(v) ? v : null; });
      if (vals.length !== cats.length) fail("The slide plan has a problem: " + where + " has a chart series whose values don't match its categories.");
      return { name: oneLine(sr.name), values: vals, color: sr.color, pointColors: sr.pointColors || {}, labelColor: sr.labelColor, labels: sr.labels };
    });
    if (!series.length) fail("The slide plan has a problem: " + where + " has a chart with no series.");
    var rel = "rId" + (s.charts.length + 2), id = s.id();
    s.charts.push({ rel: rel, xml: chartXml(it, kinds[it.kind], cats, series), cats: cats, series: series });
    s.xml.push('<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="' + esc(oneLine(it.name || "Chart " + (id - 1))) + '"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
      xfrm(it.x, it.y, it.w, it.h, "p:xfrm") + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart xmlns:c="' + NS.c + '" r:id="' + rel + '"/></a:graphicData></a:graphic></p:graphicFrame>');
  }

  // ---------- charts ----------
  function col(n) { var s = ""; n += 1; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function txPr(size, c, extra) {
    return '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + Math.round(size * 100) + '"' + (extra || "") + ">" +
      (c ? '<a:solidFill><a:srgbClr val="' + color(c) + '"/></a:solidFill>' : "") + '<a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>';
  }
  var LBLPOS = { outEnd: "outEnd", inEnd: "inEnd", ctr: "ctr", center: "ctr", inBase: "inBase" };
  function dLbls(lb, stacked, fallbackColor) {
    if (lb === false) return '<c:dLbls><c:delete val="1"/></c:dLbls>';
    lb = lb || {};
    var pos = LBLPOS[lb.position] || (stacked ? "ctr" : "outEnd");
    if (stacked && pos === "outEnd") pos = "ctr";   // PowerPoint repairs a stacked chart with labels outside the end
    return '<c:dLbls><c:numFmt formatCode="' + esc(lb.format || "#,##0.0;(#,##0.0)") + '" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
      txPr(num(lb.size) ? lb.size : 10, lb.color || fallbackColor || (stacked ? WHITE : "333333")) +
      '<c:dLblPos val="' + pos + '"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>';
  }
  function chartXml(it, kind, cats, series) {
    var dir = kind[0], grouping = kind[1], stacked = grouping === "stacked", n = cats.length;
    var catRef = "Sheet1!$A$2:$A$" + (n + 1);
    var catXml = '<c:cat><c:strRef><c:f>' + catRef + "</c:f><c:strCache><c:ptCount val=\"" + n + '"/>' +
      cats.map(function (c, i) { return '<c:pt idx="' + i + '"><c:v>' + esc(c) + "</c:v></c:pt>"; }).join("") + "</c:strCache></c:strRef></c:cat>";
    var sers = series.map(function (sr, k) {
      var L = col(k + 1), fill = color(sr.color, [NAVY, MAG, "00539E", "0081C3", "944599"][k % 5]);
      var dpts = Object.keys(sr.pointColors).filter(function (i) { return +i >= 0 && +i < n; }).sort(function (a, b) { return a - b; }).map(function (i) {
        return '<c:dPt><c:idx val="' + (+i) + '"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="' + color(sr.pointColors[i]) + '"/></a:solidFill></c:spPr></c:dPt>';
      }).join("");
      var own = sr.labels === false ? dLbls(false) : (sr.labelColor ? dLbls(Object.assign({}, it.labels || {}, { color: sr.labelColor }), stacked) : "");
      if (it.labels === false && sr.labels !== true) own = "";
      return '<c:ser><c:idx val="' + k + '"/><c:order val="' + k + '"/><c:tx><c:strRef><c:f>Sheet1!$' + L + '$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>' + esc(sr.name) + "</c:v></c:pt></c:strCache></c:strRef></c:tx>" +
        '<c:spPr><a:solidFill><a:srgbClr val="' + fill + '"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>' + dpts + own + catXml +
        '<c:val><c:numRef><c:f>Sheet1!$' + L + "$2:$" + L + "$" + (n + 1) + "</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val=\"" + n + '"/>' +
        sr.values.map(function (v, i) { return v == null ? "" : '<c:pt idx="' + i + '"><c:v>' + String(v) + "</c:v></c:pt>"; }).join("") + "</c:numCache></c:numRef></c:val></c:ser>";
    }).join("");
    var gap = num(it.gap) ? Math.max(0, Math.min(500, Math.round(it.gap))) : 60;
    var overlap = num(it.overlap) ? Math.max(-100, Math.min(100, Math.round(it.overlap))) : (stacked ? 100 : null);
    var va = it.valueAxis || null, catSize = num(it.catSize) ? it.catSize : 11;
    var scaling = '<c:scaling><c:orientation val="minMax"/>' + (va && num(va.max) ? '<c:max val="' + va.max + '"/>' : "") + (va && num(va.min) ? '<c:min val="' + va.min + '"/>' : "") + "</c:scaling>";
    var catAx = '<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="' + (dir === "bar" ? "maxMin" : "minMax") + '"/></c:scaling><c:delete val="0"/>' +
      '<c:axPos val="' + (dir === "bar" ? "l" : "b") + '"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="' + (it.catLabels === "low" ? "low" : "nextTo") + '"/>' +
      '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>' + txPr(catSize, "333333") +
      '<c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>';
    var valAx = '<c:valAx><c:axId val="500000002"/>' + scaling + '<c:delete val="' + (va ? 0 : 1) + '"/><c:axPos val="' + (dir === "bar" ? "b" : "l") + '"/>' +
      (va ? '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="' + GRID + '"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' : "") +
      '<c:numFmt formatCode="' + esc((va && va.format) || "General") + '" sourceLinked="' + (va && va.format ? 0 : 1) + '"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
      '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>' + txPr(10, GREY) +
      '<c:crossAx val="500000001"/><c:crosses val="' + (dir === "bar" ? "max" : "autoZero") + '"/><c:crossBetween val="between"/>' + (va && num(va.major) && va.major > 0 ? '<c:majorUnit val="' + va.major + '"/>' : "") + "</c:valAx>";
    var legend = it.legend === "none" || it.legend === false ? "" :
      '<c:legend><c:legendPos val="t"/><c:overlay val="0"/>' + txPr(11, "333333") + "</c:legend>";
    return DECL + '<c:chartSpace xmlns:c="' + NS.c + '" xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '"><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/>' +
      '<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:barChart><c:barDir val="' + dir + '"/><c:grouping val="' + grouping + '"/><c:varyColors val="0"/>' + sers +
      dLbls(it.labels, stacked) + '<c:gapWidth val="' + gap + '"/>' + (overlap != null ? '<c:overlap val="' + overlap + '"/>' : "") +
      '<c:axId val="500000001"/><c:axId val="500000002"/></c:barChart>' + catAx + valAx + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>' + legend +
      '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
      txPr(10, "555555") + '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>';
  }
  // the chart's own small workbook, so "Edit data" works in PowerPoint
  function workbook(cats, series) {
    var strings = [], index = {};
    var str = function (s) { s = String(s); if (!(s in index)) { index[s] = strings.length; strings.push(s); } return index[s]; };
    var rows = [];
    var head = '<row r="1">' + series.map(function (sr, k) { return '<c r="' + col(k + 1) + '1" t="s"><v>' + str(sr.name) + "</v></c>"; }).join("") + "</row>";
    rows.push(head);
    cats.forEach(function (c, i) {
      var r = i + 2;
      rows.push('<row r="' + r + '"><c r="A' + r + '" t="s"><v>' + str(c) + "</v></c>" + series.map(function (sr, k) {
        var v = sr.values[i]; return v == null ? "" : '<c r="' + col(k + 1) + r + '"><v>' + String(v) + "</v></c>";
      }).join("") + "</row>");
    });
    var z = new window.JSZip();
    put(z, "[Content_Types].xml", DECL + '<Types xmlns="' + NS.ct + '"><Default Extension="rels" ContentType="' + CT.rels + '"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>');
    put(z, "_rels/.rels", DECL + '<Relationships xmlns="' + NS.pr + '"><Relationship Id="rId1" Type="' + RT + 'officeDocument" Target="xl/workbook.xml"/></Relationships>');
    put(z, "xl/workbook.xml", DECL + '<workbook xmlns="' + NS.s + '" xmlns:r="' + NS.r + '"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
    put(z, "xl/_rels/workbook.xml.rels", DECL + '<Relationships xmlns="' + NS.pr + '"><Relationship Id="rId1" Type="' + RT + 'worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' + RT + 'styles" Target="styles.xml"/><Relationship Id="rId3" Type="' + RT + 'sharedStrings" Target="sharedStrings.xml"/></Relationships>');
    put(z, "xl/worksheets/sheet1.xml", DECL + '<worksheet xmlns="' + NS.s + '" xmlns:r="' + NS.r + '"><dimension ref="A1:' + col(series.length) + (cats.length + 1) + '"/>' +
      '<cols><col min="1" max="1" width="28" customWidth="1"/></cols><sheetData>' + rows.join("") + "</sheetData></worksheet>");
    put(z, "xl/styles.xml", DECL + '<styleSheet xmlns="' + NS.s + '"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
    put(z, "xl/sharedStrings.xml", DECL + '<sst xmlns="' + NS.s + '" count="' + strings.length + '" uniqueCount="' + strings.length + '">' +
      strings.map(function (t) { return "<si><t xml:space=\"preserve\">" + esc(t) + "</t></si>"; }).join("") + "</sst>");
    return z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  // ---------- slides ----------
  function phShape(s, ph, text, fieldNumber) {
    var attrs = Array.prototype.map.call(ph.el.attributes, function (a) { return a.name; })
      .filter(function (n) { return ["type", "idx", "sz", "orient"].indexOf(n) >= 0; })
      .map(function (n) { return " " + n + '="' + esc(ph.el.getAttribute(n)) + '"'; }).join("");
    var id = s.id(), body;
    if (fieldNumber) body = '<a:p><a:fld id="' + esc(ph.fldId || "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}") + '" type="slidenum"><a:rPr lang="en-US"/><a:t>' + fieldNumber + "</a:t></a:fld></a:p>";
    else body = '<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>' + esc(oneLine(text)) + '</a:t></a:r></a:p>';
    s.xml.push('<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(oneLine(ph.name || "Placeholder " + (id - 1))) + '"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph' + attrs + "/></p:nvPr></p:nvSpPr>" +
      "<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>" + body + "</p:txBody></p:sp>");
  }
  function slideXml(s) {
    return DECL + '<p:sld xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '" xmlns:p="' + NS.p + '"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' + s.xml.join("") +
      "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";
  }
  function drawSlide(spec, n, cover, content) {
    var s = new Slide(n), where;
    if (spec.kind === "cover") {
      s.layout = cover.layout;
      if (cover.roles.kicker && spec.kicker) phShape(s, cover.roles.kicker, spec.kicker);
      phShape(s, cover.roles.title, spec.title || "");
      if (cover.roles.subtitle && spec.subtitle) phShape(s, cover.roles.subtitle, spec.subtitle);
      s.title = spec.title || "";
      return s;
    }
    s.layout = content.layout; s.title = spec.title || "";
    phShape(s, content.roles.title, spec.title || "");
    if (content.roles.number) phShape(s, content.roles.number, "", n);
    (spec.items || []).forEach(function (it, k) {
      where = "slide " + n + ", item " + (k + 1);
      if (!it || typeof it !== "object") fail("The slide plan has a problem: " + where + " is empty.");
      switch (it.type) {
        case "text": needBox(it, where); textShape(s, Object.assign({ margin: 0.02, autofit: true }, it), true); break;
        case "box": needBox(it, where); textShape(s, it, false); break;
        case "bullets": needBox(it, where); bulletsShape(s, it); break;
        case "tile": needBox(it, where); tileShape(s, it); break;
        case "numbered": needBox(it, where); numberedShape(s, it); break;
        case "header": headerShape(s, it); break;
        case "source":
          textShape(s, { x: 0.52, y: 6.66, w: 11.8, h: 0.3, margin: 0, anchor: "t", name: "Source", autofit: true,
            paras: [{ runs: [{ text: it.text, size: 10, italic: true, color: GREY }] }] }, true); break;
        case "line": lineShape(s, it); break;
        case "table": tableShape(s, it); break;
        case "chart": chartShape(s, it, where); break;
        default: fail("The slide plan has a problem: " + where + " is of a kind the builder doesn't draw (" + oneLine(it.type).slice(0, 40) + ").");
      }
    });
    return s;
  }

  function build(bytes, spec) {
    if (!spec || !Array.isArray(spec.slides) || !spec.slides.length) return Promise.reject(new Error("There are no slides to build."));
    var names = { cover: (spec.layouts && spec.layouts.cover) || LAYOUTS.cover, content: (spec.layouts && spec.layouts.content) || LAYOUTS.content };
    var pkg, ct;
    return open(bytes).then(function (p) {
      pkg = p;
      var pick = check(pkg, names);
      if (pick.problem) throw new Error(pick.problem);
      var cl = pick.cover.layout, tl = pick.content.layout;
      var cover = { layout: cl, roles: roles(cl) }, content = { layout: tl, roles: roles(tl) };
      // draw first, so a bad spec fails before the template is touched
      pkg.drawn = spec.slides.map(function (sl, i) {
        if (!sl || (sl.kind !== "cover" && sl.kind !== "content")) fail("The slide plan has a problem: slide " + (i + 1) + " is neither a cover nor a content slide.");
        return drawSlide(sl, i + 1, cover, content);
      });
      return pkg.reachable();
    }).then(function (before) {
      removeSlides(pkg);
      return collect(pkg, before);
    }).then(function () { return contentTypes(pkg); }).then(function (c) {
      ct = c;
      if (!ct) throw new Error(NOT_PPTX);
      pkg.touch("[Content_Types].xml"); pkg.touch(pkg.main); pkg.touch(relsPathOf(pkg.main));
      var presRelsDoc = pkg.docs[relsPathOf(pkg.main)];
      var used = {}; pkg.presRels.forEach(function (r) { used[r.id] = true; });
      var nextRid = 1, freeRid = function () { while (used["rId" + nextRid]) nextRid++; used["rId" + nextRid] = true; return "rId" + nextRid; };
      var freePath = function (dir, stem, ext) { var i = 1; while (pkg.has(dir + stem + i + ext) || (pkg.taken && pkg.taken[dir + stem + i + ext])) i++; pkg.taken = pkg.taken || {}; pkg.taken[dir + stem + i + ext] = true; return dir + stem + i + ext; };
      var presDir = dirOf(pkg.main);
      var lst = kid(pkg.pres.documentElement, NS.p, "sldIdLst");
      if (!lst) {
        lst = pkg.pres.createElementNS(NS.p, "p:sldIdLst");
        pkg.pres.documentElement.insertBefore(lst, kid(pkg.pres.documentElement, NS.p, "sldSz") || kid(pkg.pres.documentElement, NS.p, "notesSz"));
      }
      ensureDefault(ct, "xlsx", CT.xlsx);
      var jobs = pkg.drawn.map(function (s) {
        var path = freePath(presDir + "/slides/", "slide", ".xml");
        var rels = ['<Relationship Id="rId1" Type="' + RT + 'slideLayout" Target="' + esc(relTarget(path, s.layout.path)) + '"/>'];
        var work = s.charts.map(function (c) {
          var cpath = freePath(presDir + "/charts/", "chart", ".xml"), xpath = freePath(presDir + "/embeddings/", "Microsoft_Excel_Worksheet", ".xlsx");
          rels.push('<Relationship Id="' + c.rel + '" Type="' + RT + 'chart" Target="' + esc(relTarget(path, cpath)) + '"/>');
          put(pkg.zip, cpath, c.xml);
          put(pkg.zip, relsPathOf(cpath), DECL + '<Relationships xmlns="' + NS.pr + '"><Relationship Id="rId1" Type="' + RT + 'package" Target="' + esc(relTarget(cpath, xpath)) + '"/></Relationships>');
          setOverride(ct, cpath, CT.chart);
          return workbook(c.cats, c.series).then(function (bin) { put(pkg.zip, xpath, bin); });
        });
        put(pkg.zip, path, slideXml(s));
        put(pkg.zip, relsPathOf(path), DECL + '<Relationships xmlns="' + NS.pr + '">' + rels.join("") + "</Relationships>");
        setOverride(ct, path, CT.slide);
        var rid = freeRid();
        var rel = presRelsDoc.createElementNS(NS.pr, "Relationship");
        rel.setAttribute("Id", rid); rel.setAttribute("Type", RT + "slide"); rel.setAttribute("Target", relTarget(pkg.main, path));
        presRelsDoc.documentElement.appendChild(rel);
        var sid = pkg.pres.createElementNS(NS.p, "p:sldId");
        sid.setAttribute("id", String(pkg.nextSlideId++)); sid.setAttributeNS(NS.r, "r:id", rid);
        lst.appendChild(sid);
        return Promise.all(work);
      });
      return Promise.all(jobs);
    }).then(function () {
      return updateApp(pkg, pkg.drawn.map(function (s) { return s.title; }));
    }).then(function () {
      tidyContentTypes(pkg, ct);
      pkg.flush();
      return pkg.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    });
  }

  window.SNLDeck = { inspect: inspect, build: build, layouts: { cover: LAYOUTS.cover, content: LAYOUTS.content }, _clean: clean };
})();
