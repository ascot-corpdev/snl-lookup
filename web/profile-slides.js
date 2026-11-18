// SNLProfile: turns a company's figures (facts) and the slide text (text) into the slide plan that SNLDeck.build
// draws. It knows the slides of a company profile and nothing about zip files. Plain script: no modules, no build step.
//
//   SNLProfile.plan(facts)        -> [{id, label, included, reason}] in deck order; reason "" when included
//   SNLProfile.spec(facts, text)  -> {fileName, slides:[...]} for SNLDeck.build (format described in deck.js)
//
// House style: Arial, navy text, one magenta accent (adverse figures), $M with commas and one decimal, negatives in
// parentheses, ratios to one decimal, "n/d" for a gap, "(derived)" on calculations, a source line on every content
// slide. Grid (inches, 13.33 x 7.5 slide): content x 0.52 to 12.80, y 1.3 to 6.6; source line at y 6.66.
// Positions come from the grid below; text is fitted by estimating Arial widths, and bullets and table rows are
// capped so nothing runs into the source line.
(function () {
  "use strict";
  var NAVY = "262166", MAG = "EB008C", BLUE = "00539E", PAIDIN = "A6A6BF";
  var L = 0.52, R = 12.80, W = R - L, TOP = 1.3, BOTTOM = 6.55;
  var QX2 = 6.89, QW = 5.91, ROW2 = 4.0;                 // quadrants: x 0.52 / 6.89, y 1.3 / 4.0, w 5.91
  var HDR = 0.4;                                        // a section header and the gap under it
  var ELLIPSIS = String.fromCharCode(0x2026);
  var FILINGS_SOURCE = "S&P Global Market Intelligence, SNL Insurance Product Filings";
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  var SLIDES = [
    ["cover", "Cover"], ["summary", "Executive summary"], ["premium", "Premium"], ["underwriting", "Underwriting"],
    ["capital", "Capital"], ["reserves", "Reserves"], ["reinsurance", "Reinsurance"],
    ["filings", "Recent rate and form filings"], ["questions", "Key diligence questions"]
  ];
  var LABELS = {
    dpw: "Direct premiums written", npw: "Net premiums written", gpw: "Gross premiums written", npe: "Net premiums earned",
    loss_ratio: "Loss ratio", expense_ratio: "Expense ratio", combined_ratio: "Combined ratio", net_income: "Net income",
    surplus: "Surplus", paid_in_capital: "Paid-in capital", total_assets: "Total assets", rbc_ratio: "RBC ratio",
    net_reserves: "Net loss and LAE reserves", pyd: "One-year reserve development", reins_recoverable: "Reinsurance recoverables",
    ceded_by_reinsurer: "Ceded premiums by reinsurer"
  };
  // statutory field ids that feed a series key (dpw and npw are the by-line figures summed)
  var FIELDS = { dpw: ["dpw", "dpw_by_line"], npw: ["npw", "npw_by_line"] };

  // ---------- numbers ----------
  function num(v) { return typeof v === "number" && isFinite(v); }
  function commas(s) { var p = s.split("."); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","); return p.join("."); }
  function signed(v, body) { return v < 0 && body !== commas((0).toFixed(1)) ? "(" + body + ")" : body; }
  function fixed1(v) { var a = Math.abs(v), s = commas(a.toFixed(1)); return s === "0.0" ? "0.0" : s; }
  function money(v) { if (!num(v)) return "n/d"; var b = fixed1(v / 1e6); return v < 0 && b !== "0.0" ? "($" + b + "M)" : "$" + b + "M"; }
  function millions(v) { if (!num(v)) return "n/d"; return signed(v, fixed1(v / 1e6)); }        // table cell under a ($M) label
  function pct(v) { if (!num(v)) return "n/d"; var b = fixed1(v); return v < 0 && b !== "0.0" ? "(" + b + "%)" : b + "%"; }
  function pctCell(v) { if (!num(v)) return "n/d"; return signed(v, fixed1(v)); }                // under a (%) label
  function mult(v) { if (!num(v)) return "n/d"; var b = fixed1(v); return v < 0 && b !== "0.0" ? "(" + b + "x)" : b + "x"; }
  function m1(v) { return num(v) ? Math.round(v / 1e4) / 100 : null; }                           // usd -> $M for charts

  // ---------- dates ----------
  function ymd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
  function monthYear(s) { var d = ymd(s); return d ? MONTHS[d.m - 1] + " " + d.y : ""; }
  function shortDate(s, thisYear) {
    var d = ymd(s); if (!d) return "n/d";
    return d.d + " " + MONTHS[d.m - 1].slice(0, 3) + (d.y !== thisYear ? " " + d.y : "");
  }
  function longDate(s) { var d = ymd(s); return d ? d.d + " " + MONTHS[d.m - 1].slice(0, 3) + " " + d.y : "n/d"; }

  // ---------- fitting text (Arial advance widths, thousandths of an em) ----------
  var WIDTHS = (function () {
    var w = {}, set = function (chars, v) { for (var i = 0; i < chars.length; i++) w[chars[i]] = v; };
    set("ijl'", 222); set(" ft.,:;!|/[]\\", 278); set("r()-`", 333); set("\"", 355); set("*", 389); set("^", 469);
    set("ckszvxyJ_", 500); set("abdeghnopqu0123456789$#?L~+=<>", 556); set("FTZ", 611); set("ABEKPSVXY&", 667);
    set("wCDHNRU", 722); set("GOQ", 778); set("mM", 833); set("%", 889); set("W", 944); set("@", 1015); set("I", 278);
    return w;
  })();
  function textWidth(s, pt, bold) {
    var t = 0; s = String(s);
    for (var i = 0; i < s.length; i++) t += WIDTHS[s[i]] || 580;
    return t / 1000 * pt / 72 * (bold ? 1.08 : 1.0);
  }
  // greedy word wrap; runs: [{text, bold}]
  function lineCount(runs, pt, width) {
    var words = [];
    runs.forEach(function (r) { String(r.text || "").split(/(\s+)/).forEach(function (w) { if (w) words.push({ w: w, bold: r.bold }); }); });
    var lines = 1, cur = 0;
    words.forEach(function (x) {
      var ww = textWidth(x.w, pt, x.bold), space = /^\s+$/.test(x.w);
      if (space) { cur += ww; return; }
      if (cur + ww > width && cur > 0) { lines++; cur = ww; } else cur += ww;
      while (cur > width) { lines++; cur -= width; }
    });
    return lines;
  }
  function fitText(s, pt, width, bold) {
    s = flat(s);
    if (textWidth(s, pt, bold) <= width) return s;
    var words = s.split(" "), out = "";
    for (var i = 0; i < words.length; i++) {
      var next = out ? out + " " + words[i] : words[i];
      if (textWidth(next + ELLIPSIS, pt, bold) > width) break;
      out = next;
    }
    if (!out) { out = s; while (out.length > 1 && textWidth(out + ELLIPSIS, pt, bold) > width) out = out.slice(0, -1); }
    return out.replace(/[\s,;:(-]+$/, "") + ELLIPSIS;
  }
  function flat(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  // a title is one line: at most 65 characters and the width of the title box, cut at a word boundary
  function trimTitle(s) {
    s = flat(s);
    var fits = function (t) { return t.length <= 65 && textWidth(t, 28, false) <= 11.9; };
    if (fits(s)) return s;
    var words = s.split(" "), out = "";
    for (var i = 0; i < words.length; i++) { var next = out ? out + " " + words[i] : words[i]; if (!fits(next)) break; out = next; }
    if (!out) { out = s; while (out.length && !fits(out)) out = out.slice(0, -1); }
    return out.replace(/[\s,;:(\-]+$/, "");
  }

  // ---------- facts ----------
  function S(f, k) { var a = f && f.series && f.series[k]; return Array.isArray(a) ? a : null; }
  function D(f, k) { var a = f && f.derived && f.derived[k]; return Array.isArray(a) ? a : null; }
  function any(a) { return !!a && a.some(num); }
  function lastIdx(a) { if (!a) return -1; for (var i = a.length - 1; i >= 0; i--) if (num(a[i])) return i; return -1; }
  function latest(f, a) { var i = lastIdx(a); return i < 0 ? null : { v: a[i], year: (f.years || [])[i] }; }
  function yearsLabel(f) {
    var y = (f.years || []).filter(num);
    if (!y.length) return "";
    return y[0] === y[y.length - 1] ? String(y[0]) : y[0] + " to " + y[y.length - 1];
  }
  function entityName(f) {
    var e = f.entity || {};
    var n = flat(e.name) || (e.kind === "group" ? flat(e.groupName) : "");
    return n || "NAIC " + (e.kind === "group" ? "group " : "company ") + flat(e.code);
  }
  function hasFilings(f) { return !!f.filings && !f.filings.unavailable; }

  // ---------- plan: which slides, and why one is left out ----------
  function joinWords(list) { return list.length < 2 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1]; }
  function lower(s) { return /^[A-Z][a-z]/.test(s) && !/^(RBC|LAE|NAIC)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; }
  // "Net loss and LAE reserves aren't", "Surplus isn't"
  function plural(label) { var w = String(label).trim().split(/\s+/).pop().toLowerCase(); return /s$/.test(w) && !/(surplus|gross|loss|ss|us)$/.test(w); }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
  function whyMissing(f, keys) {
    var miss = f.missing || [], notMapped = [], empty = [];
    keys.forEach(function (k) {
      var ids = FIELDS[k] || [k];
      var m = miss.filter(function (x) { return x && ids.indexOf(x.field) >= 0; })[0];
      var label = flat(m && m.label);
      if (!label || /^[a-z0-9_]+$/.test(label)) label = LABELS[k] || label || k;
      if (m && /not mapped/i.test(String(m.reason || ""))) notMapped.push(label); else empty.push(label);
    });
    var parts = [];
    if (notMapped.length) parts.push(cap(joinWords(notMapped.map(function (l, i) { return i ? lower(l) : l; }))) + (notMapped.length > 1 || plural(notMapped[0]) ? " aren't" : " isn't") + " mapped to Snowflake yet");
    var yl = yearsLabel(f);
    if (empty.length) parts.push("S&P returned nothing for " + lower(joinWords(empty.map(lower))) + (yl ? " for " + yl : ""));
    return parts.join("; ") + ".";
  }
  function plan(facts) {
    var f = facts || {};
    var anySeries = Object.keys(f.series || {}).some(function (k) { return any(S(f, k)); });
    var rows = SLIDES.map(function (s) { return { id: s[0], label: s[1], included: true, reason: "" }; });
    var out = function (id, reason) { rows.forEach(function (r) { if (r.id === id) { r.included = false; r.reason = reason; } }); };
    if (!anySeries) out("summary", "No statutory figures came back for this company, so there is nothing to sum up.");
    if (!any(S(f, "dpw")) && !any(S(f, "npw"))) out("premium", whyMissing(f, ["dpw", "npw"]));
    if (!any(S(f, "combined_ratio")) && !(any(S(f, "loss_ratio")) && any(S(f, "expense_ratio"))))
      out("underwriting", whyMissing(f, ["combined_ratio", "loss_ratio", "expense_ratio"].filter(function (k) { return !any(S(f, k)); })));
    if (!any(S(f, "surplus"))) out("capital", whyMissing(f, ["surplus"]));
    if (!any(S(f, "net_reserves"))) out("reserves", whyMissing(f, ["net_reserves"]));
    var reinsItems = f.reinsurers && Array.isArray(f.reinsurers.items) && f.reinsurers.items.length;
    if (!reinsItems && !any(D(f, "cession_pct")) && !any(S(f, "reins_recoverable")))
      out("reinsurance", whyMissing(f, ["ceded_by_reinsurer", "gpw", "reins_recoverable"]));
    if (!f.filings) out("filings", "Recent filings weren't looked up for this profile.");
    else if (f.filings.unavailable) out("filings", flat(f.filings.unavailable) || "Recent filings aren't available.");
    return rows;
  }

  // ---------- building blocks ----------
  function header(text, x, y, w) { return { type: "header", text: text, x: x, y: y, w: w }; }
  function points(list) {
    return (list || []).filter(function (p) { return p && (flat(p.text) || flat(p.lead)); }).map(function (p) {
      var lead = flat(p.lead), text = flat(p.text);
      return { level: 0, runs: lead ? [{ text: lead.replace(/:$/, "") + ": ", bold: true }, { text: text }] : [{ text: text }] };
    });
  }
  // as many points as fit in the box at 13pt (the rest are left out rather than shrunk)
  function bullets(list, x, y, w, h, name) {
    var size = 13, inner = w - 0.18 - 0.06, used = 0, items = [];
    var full = false;
    points(list).forEach(function (b) {
      var need = lineCount(b.runs, size, inner) * size * 1.2 / 72 + 5 / 72;
      if (full || used + need > h) { full = true; return; }
      items.push(b); used += need;
    });
    return { type: "bullets", x: x, y: y, w: w, h: h, items: items, size: size, after: 5, name: name || "Takeaways" };
  }
  function takeaways(list, x, y, w, h) { return [header("Takeaways", x, y, w), bullets(list, x, y + HDR, w, h - HDR)]; }
  function tile(x, y, w, h, value, label, color) {
    var size = textWidth(value, 26, true) <= w - 0.32 ? 26 : 22;
    return { type: "tile", x: x, y: y, w: w, h: h, value: value, label: flat(label), color: color || NAVY, valueSize: size, name: "Tile " + flat(label) };
  }
  // a by-year table: first column the measure (with its unit), one column per year; rows: [label, values, fmt, adverse(v)?, key]
  function yearTable(f, x, y, w, rows, rowH) {
    var years = (f.years || []).map(String), n = years.length;
    var need = Math.max.apply(null, [1.6].concat(rows.map(function (r) { return textWidth(r[0], 11, !!r[4]) + 0.3; })));
    var yw = Math.min(0.85, Math.max(0.64, (w - need) / Math.max(n, 1))), lw = w - yw * n;
    var body = [[""].concat(years)];
    var styles = {};
    rows.forEach(function (r, i) {
      var label = fitText(r[0], 11, lw - 0.26, !!r[4]);
      body.push([label].concat((r[1] || []).slice(0, n).concat(new Array(Math.max(0, n - (r[1] || []).length)).fill(null)).map(function (v) {
        var t = r[2](v);
        return r[3] && num(v) && r[3](v) ? { text: t, color: MAG } : t;
      })));
      if (r[4]) styles[i + 1] = { bold: true };
    });
    body[0][0] = "$M unless shown";
    var cols = [lw].concat(years.map(function () { return yw; }));
    return { type: "table", x: x, y: y, colW: cols, rowH: rowH || 0.27, rows: body, rowStyles: styles, size: 11, name: "Table by year" };
  }
  // cell margins are 0.07 in each side; the rest of the allowance keeps LibreOffice and PowerPoint from wrapping
  function cellText(s, w, bold) { return fitText(flat(s) || "n/d", 11, w - 0.26, bold); }
  function source(f, opts) {
    opts = opts || {};
    var yl = opts.period || yearsLabel(f), src = flat(opts.src || f.source) || "S&P Global Market Intelligence";
    var line = function (src, short) {
      var parts = ["Source: " + src + (yl ? ", " + yl : "") + "."];
      if (opts.note) parts.push(opts.note);
      if (opts.derived) parts.push(short ? "(derived): calculated." : "(derived): calculated from the reported figures.");
      if (opts.claude) parts.push(short ? "Text drafted by Claude: check it." : "Text drafted by Claude from these figures: check it before use.");
      if (f.sample) parts.push("Sample: made-up figures.");
      return parts.join(" ");
    };
    var s = line(src, false);
    if (textWidth(s, 10, false) > 11.7) s = line(src, true);
    while (textWidth(s, 10, false) > 11.7 && src.length > 20) { src = src.slice(0, -6); s = line(src.replace(/[\s,]+$/, "") + ELLIPSIS, true); }
    return { type: "source", text: s };
  }
  function adverseOver100(v) { return v > 100; }
  function negative(v) { return v < 0; }
  function positive(v) { return v > 0; }

  // ---------- slides ----------
  function coverSlide(f, t) {
    // the cover title stays within two lines: a very long name is cut at a word boundary
    var title = fitText(entityName(f), 40, 15, true) + ": company profile" + (f.sample ? " (sample)" : "");
    return { kind: "cover", kicker: "Corporate development | " + monthYear(f.asOf), title: title, subtitle: flat(t.cover && t.cover.subtitle) };
  }
  function content(t, id, fallback, items) {
    var title = trimTitle(flat(t[id] && t[id].title) || fallback);
    return { kind: "content", id: id, title: title, items: items };
  }
  function pointsOf(t, id) { return (t[id] && t[id].points) || []; }

  function summarySlide(f, t) {
    var dpw = S(f, "dpw"), cr = S(f, "combined_ratio"), mix = f.mix || {}, used = {}, derived = false;
    var cand = {
      dpw: function () { var l = latest(f, dpw); return l && { v: money(l.v), label: "Direct premiums written, " + l.year }; },
      npw: function () { var l = latest(f, S(f, "npw")); return l && { v: money(l.v), label: "Net premiums written, " + l.year }; },
      gpw: function () { var l = latest(f, S(f, "gpw")); return l && { v: money(l.v), label: "Gross premiums written, " + l.year }; },
      cr: function () { var l = latest(f, cr); return l && { v: pct(l.v), label: "Combined ratio, " + l.year, c: l.v > 100 ? MAG : NAVY }; },
      lr: function () { var l = latest(f, S(f, "loss_ratio")); return l && { v: pct(l.v), label: "Loss ratio, " + l.year }; },
      surplus: function () { var l = latest(f, S(f, "surplus")); return l && { v: money(l.v), label: "Surplus, " + l.year }; },
      assets: function () { var l = latest(f, S(f, "total_assets")); return l && { v: money(l.v), label: "Total assets, " + l.year }; },
      rbc: function () { var l = latest(f, S(f, "rbc_ratio")); return l && { v: pct(l.v), label: "RBC ratio, " + l.year }; },
      lev: function () { var l = latest(f, D(f, "npw_to_surplus")); return l && { v: mult(l.v), label: "Net premiums written to surplus, " + l.year + " (derived)", d: 1 }; },
      top: function () { return num(mix.topStateShare) && mix.states && mix.states[0] ? { v: pct(mix.topStateShare), label: "Share of direct premiums in " + flat(mix.states[0].state) + ", " + mix.year } : null; },
      top3: function () { return num(mix.top3StateShare) ? { v: pct(mix.top3StateShare), label: "Share of direct premiums in the top three states, " + mix.year } : null; },
      line: function () { var l = mix.lines && mix.lines[0]; return l && num(l.share) ? { v: pct(l.share), label: "Share of direct premiums in " + lower(flat(l.name)) + ", " + mix.year } : null; },
      avg: function () { var a = f.derived && f.derived.combined_avg; return num(a) ? { v: pct(a), label: "Average combined ratio, " + yearsLabel(f) + " (derived)", c: a > 100 ? MAG : NAVY, d: 1 } : null; },
      ni: function () { var a = f.derived && f.derived.net_income_total; return num(a) ? { v: money(a), label: "Net income, " + yearsLabel(f) + " in total (derived)", c: a < 0 ? MAG : NAVY, d: 1 } : null; },
      niLast: function () { var l = latest(f, S(f, "net_income")); return l && { v: money(l.v), label: "Net income, " + l.year, c: l.v < 0 ? MAG : NAVY }; },
      growth: function () { var a = f.derived && f.derived.dpw_growth_pct; return num(a) ? { v: pct(a), label: "Direct premium growth a year, " + yearsLabel(f) + " (derived)", d: 1 } : null; },
      cession: function () { var l = latest(f, D(f, "cession_pct")); return l && { v: pct(l.v), label: "Share of gross premium ceded, " + l.year + " (derived)", d: 1 }; }
    };
    var spare = ["npw", "gpw", "niLast", "assets", "growth", "cession", "top3", "line", "lev", "lr"];
    var wants = [
      { first: ["dpw", "npw", "gpw"], none: "Direct premiums written" },
      { first: ["cr", "lr"], none: "Combined ratio" },
      { first: ["surplus", "assets"], none: "Surplus" },
      { first: ["rbc", "lev"], none: "RBC ratio" },
      { first: ["top", "line", "top3"], none: "Share of direct premiums in the top state" },
      { first: ["avg", "ni"], none: "Average combined ratio (derived)" }
    ];
    var pick = function (keys) { for (var i = 0; i < keys.length; i++) { if (used[keys[i]]) continue; var c = cand[keys[i]](); if (c) { used[keys[i]] = true; return c; } } return null; };
    var tiles = wants.map(function (w) { return pick(w.first) || pick(spare) || { v: "n/d", label: w.none }; });
    var bx = L, bw = 4.94, tw = (bw - 0.15) / 2, th = 1.46, items = [header("Key figures", bx, TOP, bw)];
    tiles.forEach(function (c, i) {
      if (c.d) derived = true;
      items.push(tile(bx + (i % 2) * (tw + 0.15), TOP + HDR + Math.floor(i / 2) * (th + 0.15), tw, th, c.v, c.label, c.c));
    });
    var rx = bx + bw + 0.3, rw = R - rx;
    items = items.concat(takeaways(pointsOf(t, "summary"), rx, TOP, rw, BOTTOM - TOP));
    items.push(source(f, { derived: derived, claude: t.by === "claude" }));
    return content(t, "summary", "Executive summary, " + yearsLabel(f), items);
  }

  function mixTables(f, x, y, w, h) {
    var mix = f.mix || {}, lines = (mix.lines || []).slice(0, 8), states = (mix.states || []).slice(0, 8), out = [], rowH = 0.235;
    var maxRows = Math.max(1, Math.floor((h - HDR) / rowH) - 1);
    lines = lines.slice(0, maxRows); states = states.slice(0, maxRows);
    out.push(header("Premium mix, " + mix.year + " (% of direct premiums)", x, y, w));
    var lw = states.length ? w - 2.05 - 0.2 : w, sx = x + lw + 0.2;
    if (lines.length) {
      var nameW = lw - 0.8;
      out.push({ type: "table", x: x, y: y + HDR, colW: [nameW, 0.8], rowH: rowH, size: 11, name: "Table lines",
        rows: [["Line of business", "%"]].concat(lines.map(function (l) { return [cellText(l.name, nameW), pctCell(l.share)]; })) });
    } else sx = x;
    if (states.length) {
      out.push({ type: "table", x: sx, y: y + HDR, colW: [0.8, 0.65, 0.6], rowH: rowH, size: 11, name: "Table states",
        rows: [["State", "$M", "%"]].concat(states.map(function (s) { return [cellText(s.state, 0.8), millions(s.dpw), pctCell(s.share)]; })) });
    }
    return out;
  }
  // blocks: functions (x, y, w, h) -> items. Three blocks fill three quadrants and the takeaways the fourth;
  // two blocks fill the top row and the takeaways run across the bottom.
  function quads(blocks, pts) {
    var items = [], h1 = ROW2 - TOP - 0.15, h2 = BOTTOM - ROW2;
    var at = [[L, TOP, QW, h1], [QX2, TOP, QW, h1], [L, ROW2, QW, h2]];
    blocks.forEach(function (b, i) { items = items.concat(b.apply(null, at[i])); });
    if (blocks.length >= 3) items = items.concat(takeaways(pts, QX2, ROW2, QW, h2));
    else if (blocks.length === 2) items = items.concat(takeaways(pts, L, ROW2, W, h2));
    else items = items.concat(takeaways(pts, QX2, TOP, QW, BOTTOM - TOP));
    return items;
  }
  function chartBlock(title, chart) {
    return function (x, y, w, h) { return [header(title, x, y, w), Object.assign({ type: "chart", x: x, y: y + HDR, w: w, h: h - HDR }, chart)]; };
  }
  function tableBlock(title, f, rows) {
    return function (x, y, w, h) {
      var rh = Math.min(0.27, (h - HDR) / (rows.length + 1));
      return [header(title, x, y, w), yearTable(f, x, y + HDR, w, rows, Math.max(0.235, rh))];
    };
  }
  function years(f) { return (f.years || []).map(String); }
  function ser(name, values, color, extra) { return Object.assign({ name: name, values: values, color: color }, extra || {}); }

  function premiumSlide(f, t) {
    var dpw = S(f, "dpw"), npw = S(f, "npw"), gpw = S(f, "gpw"), npe = S(f, "npe"), cession = D(f, "cession_pct");
    var series = [];
    if (any(dpw)) series.push(ser("Direct premiums written", dpw.map(m1), NAVY));
    if (any(npw)) series.push(ser("Net premiums written", npw.map(m1), MAG));
    var growth = any(dpw) ? dpw.map(function (v, i) { return i && num(v) && num(dpw[i - 1]) && dpw[i - 1] > 0 ? Math.round((v / dpw[i - 1] - 1) * 1000) / 10 : null; }) : null;
    var rows = [];
    if (any(dpw)) rows.push(["Direct premiums written", dpw, millions, null, true]);
    if (any(gpw)) rows.push(["Gross premiums written", gpw, millions]);
    if (any(npw)) rows.push(["Net premiums written", npw, millions]);
    if (any(npe)) rows.push(["Net premiums earned", npe, millions]);
    if (any(cession)) rows.push(["Ceded share (%, derived)", cession, pctCell]);
    if (growth && any(growth)) rows.push(["DPW growth (%, derived)", growth, pctCell, negative]);
    var blocks = [chartBlock("Premiums written ($M)", { kind: "column", categories: years(f), series: series, labels: { format: "#,##0.0;(#,##0.0)" }, gap: 60, overlap: -10, legend: "top" })];
    var mix = f.mix || {};
    if ((mix.lines && mix.lines.length) || (mix.states && mix.states.length)) blocks.push(function (x, y, w, h) { return mixTables(f, x, y, w, h); });
    blocks.push(tableBlock("Premium by year", f, rows));
    var items = quads(blocks, pointsOf(t, "premium"));
    items.push(source(f, { derived: any(cession) || !!growth }));
    return content(t, "premium", "Premium, " + yearsLabel(f), items);
  }

  function underwritingSlide(f, t) {
    var lr = S(f, "loss_ratio"), er = S(f, "expense_ratio"), cr = S(f, "combined_ratio"), ni = S(f, "net_income"), roae = D(f, "roae");
    var chart;
    if (any(lr) && any(er)) {
      var sums = lr.map(function (v, i) { return (num(v) ? v : 0) + (num(er[i]) ? er[i] : 0); });
      var max = Math.max(120, Math.ceil(Math.max.apply(null, sums) / 20) * 20);
      chart = chartBlock("Loss and expense ratios (%)", { kind: "stackedColumn", categories: years(f), legend: "top", gap: 60, overlap: 100,
        series: [ser("Loss ratio", lr, NAVY), ser("Expense ratio", er, MAG)], labels: { format: "0.0;(0.0);;", position: "ctr", color: "FFFFFF" },
        valueAxis: { min: 0, max: max, major: 20, format: "0" } });
    } else {
      var pc = {}; cr.forEach(function (v, i) { if (num(v) && v > 100) pc[i] = MAG; });
      chart = chartBlock("Combined ratio (%)", { kind: "column", categories: years(f), legend: "none", gap: 60,
        series: [ser("Combined ratio", cr, NAVY, { pointColors: pc })], labels: { format: "0.0" } });
    }
    var rows = [];
    if (any(lr)) rows.push(["Loss ratio (%)", lr, pctCell]);
    if (any(er)) rows.push(["Expense ratio (%)", er, pctCell]);
    if (any(cr)) rows.push(["Combined ratio (%)", cr, pctCell, adverseOver100, true]);
    if (any(ni)) rows.push(["Net income", ni, millions, negative]);
    if (any(roae)) rows.push(["ROAE (%, derived)", roae, pctCell, negative]);
    var items = quads([chart, tableBlock("Results by year", f, rows)], pointsOf(t, "underwriting"));
    items.push(source(f, { derived: any(roae) }));
    return content(t, "underwriting", "Underwriting results, " + yearsLabel(f), items);
  }

  function capitalSlide(f, t) {
    var sp = S(f, "surplus"), pic = S(f, "paid_in_capital"), ta = S(f, "total_assets"), rbc = S(f, "rbc_ratio");
    var def = D(f, "accumulated_deficit"), lev = D(f, "npw_to_surplus");
    var series = [];
    if (any(pic)) series.push(ser("Paid-in capital", pic.map(m1), PAIDIN));
    series.push(ser("Surplus", sp.map(m1), NAVY));
    var rows = [["Surplus", sp, millions, null, true]];
    if (any(pic)) rows.push(["Paid-in capital", pic, millions]);
    if (any(def)) rows.push(["Surplus less paid-in (derived)", def, millions, negative]);
    if (any(ta)) rows.push(["Total assets", ta, millions]);
    if (any(lev)) rows.push(["NPW to surplus (x, derived)", lev, mult]);
    if (any(rbc)) rows.push(["RBC ratio (%)", rbc, pctCell]);
    var items = quads([chartBlock(series.length > 1 ? "Paid-in capital and surplus ($M)" : "Surplus ($M)",
      { kind: "column", categories: years(f), series: series, legend: series.length > 1 ? "top" : "none", gap: 60, overlap: -10, labels: { format: "#,##0.0;(#,##0.0)" } }),
      tableBlock("Capital by year", f, rows)], pointsOf(t, "capital"));
    items.push(source(f, { derived: any(def) || any(lev) }));
    return content(t, "capital", "Capital, " + yearsLabel(f), items);
  }

  function reservesSlide(f, t) {
    var res = S(f, "net_reserves"), npe = S(f, "npe"), pyd = S(f, "pyd");
    var rtn = D(f, "reserves_to_npe"), rts = D(f, "reserves_to_surplus"), pps = D(f, "pyd_to_prior_surplus");
    var tw = (W - 0.6) / 3, th = 1.25, items = [];
    var a = latest(f, rts), b = latest(f, rtn), c = latest(f, pps);
    items.push(tile(L, TOP, tw, th, a ? mult(a.v) : "n/d", "Reserves to surplus" + (a ? ", " + a.year : "") + " (derived)"));
    items.push(tile(L + tw + 0.3, TOP, tw, th, b ? mult(b.v) : "n/d", "Reserves to net premiums earned" + (b ? ", " + b.year : "") + " (derived)"));
    items.push(tile(L + 2 * (tw + 0.3), TOP, tw, th, c ? pct(c.v) : "n/d", "One-year development to prior surplus" + (c ? ", " + c.year : "") + " (derived; positive is adverse)", c && c.v > 0 ? MAG : NAVY));
    var rows = [["Net loss and LAE reserves", res, millions, null, true]];
    if (any(npe)) rows.push(["Net premiums earned", npe, millions]);
    if (any(rtn)) rows.push(["Reserves to NPE (x, derived)", rtn, mult]);
    if (any(rts)) rows.push(["Reserves to surplus (x, derived)", rts, mult]);
    if (any(pyd)) rows.push(["One-year development (PYD)", pyd, millions, positive]);
    if (any(pps)) rows.push(["PYD to prior surplus (%, derived)", pps, pctCell, positive]);
    var y2 = TOP + th + 0.3;
    items = items.concat(tableBlock("Reserves by year", f, rows)(L, y2, QW, BOTTOM - y2));
    items = items.concat(takeaways(pointsOf(t, "reserves"), QX2, y2, QW, BOTTOM - y2));
    items.push(source(f, { derived: true, note: any(pyd) ? "Development: positive is adverse." : "" }));
    return content(t, "reserves", "Reserves, " + yearsLabel(f), items);
  }

  function reinsuranceSlide(f, t) {
    var re = f.reinsurers && Array.isArray(f.reinsurers.items) ? f.reinsurers.items.slice(0, 8) : [];
    var cess = D(f, "cession_pct"), rts = D(f, "recoverable_to_surplus"), items = [];
    var lw = 7.4, rx = 8.42, rw = R - rx;
    if (re.length) {
      items.push(header("Ceded premiums by reinsurer, " + f.reinsurers.year + " ($M)", L, TOP, lw));
      items.push({ type: "chart", kind: "bar", x: L, y: TOP + HDR, w: lw, h: Math.min(BOTTOM - TOP - HDR, 0.5 + re.length * 0.55), legend: "none", gap: 50,
        categories: re.map(function (r) { return fitText(r.name, 11, 2.6, false); }),
        series: [ser("Ceded premiums ($M)", re.map(function (r) { return m1(r.ceded); }), NAVY)], labels: { format: "#,##0.0;(#,##0.0)" }, catSize: 11, name: "Chart reinsurers" });
    } else {
      var rows = [];
      if (any(S(f, "gpw"))) rows.push(["Gross premiums written", S(f, "gpw"), millions]);
      if (any(D(f, "ceded_pw"))) rows.push(["Ceded premiums (derived)", D(f, "ceded_pw"), millions, null, true]);
      if (any(cess)) rows.push(["Ceded share (%, derived)", cess, pctCell]);
      if (any(S(f, "reins_recoverable"))) rows.push(["Reinsurance recoverables", S(f, "reins_recoverable"), millions]);
      if (any(rts)) rows.push(["Recoverables to surplus (%, derived)", rts, pctCell]);
      items = items.concat(tableBlock("Reinsurance by year", f, rows)(L, TOP, lw, 2.6));
    }
    var a = latest(f, cess), b = latest(f, rts), tw = (rw - 0.2) / 2, th = 1.3;
    items.push(tile(rx, TOP, tw, th, a ? pct(a.v) : "n/d", "Share of gross premium ceded" + (a ? ", " + a.year : "") + " (derived)"));
    items.push(tile(rx + tw + 0.2, TOP, tw, th, b ? pct(b.v) : "n/d", "Recoverables to surplus" + (b ? ", " + b.year : "") + " (derived)", b && b.v > 100 ? MAG : NAVY));
    var y2 = TOP + th + 0.3;
    items = items.concat(takeaways(pointsOf(t, "reinsurance"), rx, y2, rw, BOTTOM - y2));
    items.push(source(f, { derived: true, period: re.length ? yearsLabel(f) : "" }));
    return content(t, "reinsurance", "Reinsurance, " + yearsLabel(f), items);
  }

  function filingsSlide(f, t) {
    var fl = f.filings || {}, rows = Array.isArray(fl.rows) ? fl.rows : [], items = [], thisYear = (ymd(f.asOf) || {}).y;
    var period = longDate(fl.from) + " to " + longDate(fl.to);
    var total = num(fl.total) ? fl.total : rows.length;
    var note = fl.capped ? "S&P returned more than " + total + " filings; counts cover the first " + total + "." : "";
    if (!rows.length && !total) {
      items.push({ type: "box", x: L, y: TOP + HDR, w: QW, h: 1.5, fill: "EEEEF5", margins: [0.2, 0.2, 0.15, 0.15], anchor: "ctr", name: "Nothing returned",
        paras: [{ after: 4, runs: [{ text: "S&P returned nothing for this period", size: 16, bold: true, color: NAVY }] },
                { runs: [{ text: "Filings searched from " + period + ".", size: 12, color: NAVY }] }] });
      items.unshift(header("Filings, " + period, L, TOP, QW));
      items = items.concat(takeaways(pointsOf(t, "filings"), QX2, TOP, QW, BOTTOM - TOP));
      items.push(source(f, { src: FILINGS_SOURCE, period: period }));
      return content(t, "filings", "Recent rate and form filings", items);
    }
    var mini = function (title, list, key, x) {
      list = (list || []).slice(0, 6);
      if (!list.length) return [];
      return [header(title, x, TOP, 2.8), { type: "table", x: x, y: TOP + HDR, colW: [1.95, 0.85], rowH: 0.25, size: 11, name: "Table " + title,
        rows: [[key === "type" ? "Filing type" : "State", "Filings"]].concat(list.map(function (r) { return [cellText(r[key], 1.95), String(num(r.count) ? r.count : "n/d")]; })) }];
    };
    items = items.concat(mini("By filing type", fl.byType, "type", L), mini("By state", fl.byState, "state", L + 3.11));
    items = items.concat(takeaways(pointsOf(t, "filings"), QX2, TOP, QW, 3.6 - TOP));
    var colW = [0.7, 1.15, 2.35, 1.95, 1.2, 1.2, 1.15, 2.58];   // the status is often two words ("Closed - Approved")
    var shown = rows.slice(0, 8), y2 = 3.7;
    var trs = [["State", "Filing type", "Type of insurance", "Status", "Published", "Effective", "Rate impact", "Tracking number"]].concat(shown.map(function (r) {
      var ri = pct(r.rateImpact);
      return [cellText(r.state, colW[0]), cellText(r.type, colW[1]), cellText(r.toi, colW[2]), cellText(r.status, colW[3]),
        shortDate(r.published, thisYear), shortDate(r.effective, thisYear), ri, cellText(r.tracking, colW[7])];
    }));
    items.push(header("Latest filings (" + shown.length + " of " + total + (fl.capped ? " or more" : "") + ")", L, y2, W));
    items.push({ type: "table", x: L, y: y2 + HDR, colW: colW, rowH: 0.25, size: 11, rows: trs, aligns: ["l", "l", "l", "l", "r", "r", "r", "l"], name: "Table latest filings" });
    items.push(source(f, { src: FILINGS_SOURCE, period: period, note: note }));
    return content(t, "filings", "Recent rate and form filings", items);
  }

  function questionsSlide(f, t) {
    var qs = ((t.questions && t.questions.items) || []).filter(function (q) { return q && (flat(q.title) || flat(q.text)); }).slice(0, 4), items = [];
    qs.forEach(function (q, i) {
      var x = i % 2 ? QX2 : L, y = i < 2 ? 1.35 : 3.8, inner = QW - 1.05 - 0.2;
      var title = flat(q.title), text = flat(q.text);
      // keep the tile's text inside it: about 2 title lines and 6 text lines
      if (lineCount([{ text: title, bold: true }], 14, inner) > 2) title = fitText(title, 14, inner * 2 - 0.3, true);
      while (lineCount([{ text: text }], 12, inner) > 6) text = fitText(text, 12, (lineCount([{ text: text }], 12, inner) - 1) * inner - 0.4, false);
      items.push({ type: "numbered", x: x, y: y, w: QW, h: 2.2, n: i + 1, title: title, text: text, inset: 1.05, badge: 0.6, name: "Question " + (i + 1) });
    });
    items.push(source(f, { claude: t.by === "claude", note: t.by === "claude" ? "" : "Questions follow from the figures in this profile (inferred)." }));
    return content(t, "questions", "Key diligence questions", items);
  }

  function slug(s) { return flat(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, ""); }

  // =================================================================================================================
  // ---------- the filings profile: a deck from S&P filings alone (facts from filingsFactsFrom in profile.ts) ----------
  // =================================================================================================================
  //   SNLProfile.filingsPlan(facts)        -> [{id, label, included, reason}] in deck order
  //   SNLProfile.filingsSpec(facts, text)  -> {fileName, slides} for SNLDeck.build
  // Every figure is the function's; nothing here adds or averages rate impacts. Columns that would be empty on every
  // row are left out, and a filing's description is never used (real rows often have none).
  var TEAL = "00857C", PURPLE = "944599";
  var FP_SLIDES = [
    ["cover", "Cover"], ["summary", "Summary"], ["rates", "Rate changes"], ["states", "Where it files"], ["years", "Filings by year and type"],
    ["forms", "Latest form and rule filings"], ["regulator", "Time with the regulator"], ["questions", "Key diligence questions"]
  ];
  var LX2 = 8.42, LW = 7.4, RW = R - LX2;                 // two columns: left x 0.52 w 7.4, right x 8.42 w 4.38
  var FP_CHART_COLS = 20;                                 // the most filings drawn as columns on the rate chart
  var NOTHING = "S&P returned nothing for this search, so there are no filings to show. That doesn't prove nothing was filed.";

  function arr(a) { return Array.isArray(a) ? a : []; }
  function cnt(n) { return num(n) ? commas(String(Math.round(n))) : "n/d"; }
  function fpRows(f, k) { return arr(f[k] && f[k].rows).filter(function (r) { return r && typeof r === "object"; }); }
  function fpPlan(facts) {
    var f = facts || {}, T = f.totals || {}, R = f.rates || {}, Y = f.years || {};
    var rows = FP_SLIDES.map(function (s) { return { id: s[0], label: s[1], included: true, reason: "" }; });
    var out = function (id, reason) { rows.forEach(function (r) { if (r.id === id) { r.included = false; r.reason = reason; } }); };
    if (!num(T.filings) || T.filings <= 0) { ["rates", "states", "years", "forms", "regulator"].forEach(function (id) { out(id, NOTHING); }); return rows; }
    if (!R.filings) out("rates", "S&P returned no rate filings for this search, so there are no rate changes to show.");
    else if (!R.withImpact) out("rates", "No filing carried an overall rate impact in S&P's data, so there are no rate changes to chart.");
    else if (!arr(R.points).length) out("rates", "None of the filings with a rate impact has a publish date, so they can't be put in date order.");
    if (!fpRows(f, "states").length) out("states", "None of the filings names a state in S&P's data.");
    if (!arr(Y.totals).some(function (n) { return n > 0; })) out("years", "None of the filings has a publish date in S&P's data.");
    if (!(f.latest && f.latest.total > 0 && fpRows(f, "latest").length)) out("forms", "S&P returned no form or rule filings for this search.");
    if (!(f.regulator && f.regulator.all)) out("regulator", "None of the filings has both a submitted date and a publish date in S&P's data, so the time with the regulator can't be worked out.");
    return rows;
  }

  function fpName(f) { var e = f.entity || {}; return flat(e.name) || flat(e.groupName) || (e.kind === "group" ? "The group" : "The company"); }
  function fpThisYear(f) { return (ymd(f.asOf) || {}).y; }
  function fpDate(f, s) { return shortDate(s, fpThisYear(f)); }
  // a status as S&P gives it, lower case inside a sentence or label when it is a plain word or two
  function statusWord(s) { s = flat(s); return !s ? "status n/d" : /^[A-Za-z][A-Za-z -]*$/.test(s) ? s.toLowerCase() : s; }
  // the source line: S&P, the filings product and the period, then notes, made shorter until it fits on one line
  // claude: say the text was drafted by Claude (the summary and the questions, as on the full profile)
  function fpSource(f, t, notes, claudeNote) {
    var P = f.period || {}, long = longDate(P.from) + " to " + longDate(P.to), short = monthYear(P.from).replace(/^(\w{3})\w*/, "$1") + " to " + monthYear(P.to).replace(/^(\w{3})\w*/, "$1");
    notes = (notes || []).filter(Boolean);
    var claude = claudeNote && t && t.by === "claude", capped = f.search && f.search.capped;
    var tries = [[long, 0], [long, 1], [long, 2], [short, 2], [short, 3]];
    for (var i = 0; i < tries.length; i++) {
      var lv = tries[i][1], parts = ["Source: " + FILINGS_SOURCE + ", " + tries[i][0] + "."];
      if (capped) parts.push(lv > 2 ? "Incomplete." : lv ? "Search incomplete." : "The search stopped early, so figures may be incomplete.");
      notes.forEach(function (n) { parts.push(typeof n === "string" ? n : n[Math.min(lv, n.length - 1)]); });
      if (claude) parts.push(lv > 2 ? "Claude's text: check it." : lv ? "Text drafted by Claude: check it." : "Text drafted by Claude from these figures: check it before use.");
      if (f.sample) parts.push(lv > 2 ? "Made-up." : lv > 1 ? "Made-up figures." : "Sample: made-up figures.");
      var s = parts.join(" ");
      if (textWidth(s, 10, false) <= 11.7 || i === tries.length - 1) return { type: "source", text: s };
    }
  }
  var RATE_NOTE = ["Rate impacts are S&P's overall figure for each filing, not weighted by premium; for one not approved it may be the change asked for.",
    "Rate impacts: overall, not by premium; if not approved, may be the change asked for.", "Rate impacts unweighted; if not approved, may be as asked.", "Unweighted; unapproved may be as asked."];
  var DAYS_NOTE = ["Days: from submitted to published by S&P, so approximate.", "Days: submitted to published, approximate."];
  // a table with any column that is empty ("n/d") on every row left out, its width shared among the others
  function fpTable(name, x, y, w, head, rows, widths, aligns, keep, opts) {
    var use = head.map(function (_, j) { return keep.indexOf(j) >= 0 || rows.some(function (r) { var c = r[j], s = c && typeof c === "object" ? c.text : c; return flat(s) && flat(s) !== "n/d"; }); });
    var wsum = widths.reduce(function (a, b, j) { return a + (use[j] ? b : 0); }, 0);
    var cols = widths.map(function (c, j) { return c * w / wsum; });
    var pick = function (r) { return r.filter(function (_, j) { return use[j]; }); };
    var fitRow = function (r) { return r.map(function (c, j) { if (c && typeof c === "object") return c; return (opts && opts.fit && opts.fit.indexOf(j) >= 0) ? cellText(c, cols[j]) : c; }); };
    return Object.assign({ type: "table", x: x, y: y, colW: pick(cols), rowH: 0.25, size: 11, name: name, aligns: pick(aligns),
      rows: [pick(head)].concat(rows.map(function (r) { return pick(fitRow(r)); })) }, opts && opts.extra || {});
  }

  function fpCover(f, t) {
    var title = fitText(fpName(f), 40, 15, true) + ": filings profile" + (f.sample ? " (sample)" : "");
    return { kind: "cover", kicker: "Corporate development | " + monthYear(f.asOf), title: title, subtitle: flat(t.cover && t.cover.subtitle) };
  }
  function fpNothingBox(f, x, y, w) {
    var P = f.period || {};
    return { type: "box", x: x, y: y, w: w, h: 1.6, fill: "EEEEF5", margins: [0.2, 0.2, 0.15, 0.15], anchor: "ctr", name: "Nothing returned",
      paras: [{ after: 4, runs: [{ text: "S&P returned nothing for this search", size: 16, bold: true, color: NAVY }] },
              { runs: [{ text: "Filings published " + longDate(P.from) + " to " + longDate(P.to) + " were searched in every state in S&P's list. That doesn't prove nothing was filed.", size: 12, color: NAVY }] }] };
  }

  function fpSummary(f, t) {
    var T = f.totals || {}, big = f.largest, A = f.approval || {}, items = [], lw = 5.6;
    var rx = L + lw + 0.3, rw = R - rx;
    if (!T.filings) {
      items.push(header("Filings", L, TOP, lw), fpNothingBox(f, L, TOP + HDR, lw));
    } else {
      items.push(header("Key figures", L, TOP, lw));
      var tiles = [
        [cnt(T.filings), "Filings published in the period"], [cnt(T.rate), "Rate filings"], [cnt(T.rule), "Rule filings"], [cnt(T.form), "Form filings"],
        [cnt(T.states), "States with filings, of " + cnt(f.search && f.search.statesSearched) + " searched"],
        [T.latest ? fpDate(f, T.latest) : "n/d", "Latest filing published"],
        big ? [pct(big.rate), "Largest overall rate change: " + (flat(big.state) || "state n/d") + ", " + fpDate(f, big.date) + ", " + statusWord(big.status) + (big.approved ? "" : " (may be as asked)"), big.approved ? NAVY : PURPLE]
          : ["n/d", "Largest overall rate change (no filing carried one)"],
        A.rateFilings ? [pct(A.share), "Rate filings approved, " + cnt(A.approved) + " of " + cnt(A.rateFilings) + " (derived)"] : ["n/d", "Rate filings approved (no rate filings)"]
      ];
      var tw = (lw - 0.15) / 2, th = (BOTTOM - 0.1 - TOP - HDR - 3 * 0.12) / 4;
      tiles.forEach(function (c, i) {
        var tl = tile(L + (i % 2) * (tw + 0.15), TOP + HDR + Math.floor(i / 2) * (th + 0.12), tw, th, c[0], c[1], c[2]);
        tl.labelSize = 11; items.push(tl);
      });
    }
    items = items.concat(takeaways(pointsOf(t, "summary"), rx, TOP, rw, BOTTOM - TOP));
    items.push(fpSource(f, t, [big ? RATE_NOTE : ""], true));
    return content(t, "summary", T.filings ? cnt(T.filings) + " filings" : "S&P returned nothing for this search", items);
  }

  function fpRates(f, t) {
    var R = f.rates || {}, items = [], pts = arr(R.points).filter(function (p) { return p && num(p.rate); });
    var shown = pts.slice(-FP_CHART_COLS), cats = shown.map(function (p) { var d = ymd(p.date); return (flat(p.state) || "n/d") + " " + (d ? MONTHS[d.m - 1].slice(0, 3) + " " + d.y : "n/d"); });
    // one series for each kind of change, so the legend explains the colours; each filing has a value in one of them
    var kinds = [
      { name: "Increase, approved", color: MAG, has: function (p) { return p.approved && p.rate > 0; } },
      { name: "Decrease, approved", color: TEAL, has: function (p) { return p.approved && p.rate < 0; } },
      { name: "No change, approved", color: NAVY, has: function (p) { return p.approved && p.rate === 0; } },
      { name: "Not approved (may be as asked)", color: PURPLE, has: function (p) { return !p.approved; } }
    ];
    var series = kinds.filter(function (k) { return shown.some(k.has); }).map(function (k) {
      return ser(k.name, shown.map(function (p) { return k.has(p) ? p.rate : null; }), k.color);
    });
    var many = pts.length > shown.length || R.pointsTotal > pts.length;
    items.push(header("Overall rate impact of each filing, in date order (%)" + (many ? ", latest " + shown.length + " of " + cnt(R.pointsTotal) : ""), L, TOP, W));
    items.push({ type: "chart", kind: "column", x: L, y: TOP + HDR, w: W, h: 2.15, categories: cats, series: series, legend: "top", gap: 40, overlap: 100,
      labels: { format: "0.0;(0.0);0.0", size: 10 }, catSize: 10, catLabels: "low", name: "Chart rate changes" });
    // the table: state and type of insurance, the most rate filings first
    var y2 = TOP + HDR + 2.15 + 0.2, maxRows = Math.max(1, Math.floor((BOTTOM - y2 - HDR) / 0.25) - 1);
    var rows = fpRows(f, "rates").slice(0, maxRows).sort(function (a, b) { return (a.state || "~").localeCompare(b.state || "~") || (a.toi || "~").localeCompare(b.toi || "~"); });
    var tr = rows.map(function (r) {
      var range = !num(r.lo) ? "n/d" : r.lo === r.hi ? pctCell(r.lo) : pctCell(r.lo) + " to " + pctCell(r.hi), l = r.latest;
      return [flat(r.state) || "n/d", flat(r.toi) || "n/d", cnt(r.n), range, l ? pctCell(l.rate) : "n/d", l ? fpDate(f, l.date) : "n/d", l ? flat(l.status) || "n/d" : "n/d"];
    });
    var total = num(R.rowsTotal) ? R.rowsTotal : rows.length;
    items.push(header("Rate filings by state and type of insurance" + (total > rows.length ? " (" + rows.length + " of " + total + ")" : ""), L, y2, LW));
    items.push(fpTable("Table rate filings", L, y2 + HDR, LW, ["State", "Type of insurance", "Filings", "Range (%)", "Latest (%)", "Published", "Status"], tr,
      [0.55, 1.85, 0.65, 1.2, 0.95, 1.0, 1.2], ["l", "l", "r", "r", "r", "r", "l"], [0, 2], { fit: [1, 6] }));
    items = items.concat(takeaways(pointsOf(t, "rates"), LX2, y2, RW, BOTTOM - y2));
    items.push(fpSource(f, t, [RATE_NOTE]));
    return content(t, "rates", "Rate changes", items);
  }

  function fpStates(f, t) {
    var rows = fpRows(f, "states"), T = f.totals || {}, items = [];
    var tableRows = rows.slice(0, Math.floor((BOTTOM - TOP - HDR) / 0.25) - 1), bars = rows.slice(0, 12), star = false;
    items.push(header("Filings by state" + (rows.length > bars.length ? " (top " + bars.length + " of " + rows.length + ")" : ""), L, TOP, LW));
    var ch = Math.min(BOTTOM - TOP - HDR, 0.45 + bars.length * 0.3);
    items.push({ type: "chart", kind: "bar", x: L, y: TOP + HDR, w: LW, h: ch, legend: "none", gap: 50, categories: bars.map(function (r) { return r.state; }),
      series: [ser("Filings", bars.map(function (r) { return r.n; }), NAVY, { pointColors: { 0: MAG } })], labels: { format: "#,##0" }, catSize: 11, name: "Chart states" });
    var y2 = TOP + HDR + ch + 0.25;
    if (BOTTOM - y2 >= 1.3) items = items.concat(takeaways(pointsOf(t, "states"), L, y2, LW, BOTTOM - y2));
    var tr = tableRows.map(function (r) {
      var l = r.latest; if (l && !l.approved) star = true;
      return [r.state, cnt(r.n), cnt(r.rate), l ? pctCell(l.rate) + (l.approved ? "" : "*") : "n/d"];
    });
    items.push(header("By state" + (rows.length > tableRows.length ? " (" + tableRows.length + " of " + rows.length + ")" : ""), LX2, TOP, RW));
    items.push({ type: "table", x: LX2, y: TOP + HDR, colW: [0.7, 0.9, 1.15, 1.63], rowH: 0.25, size: 11, name: "Table states", aligns: ["l", "r", "r", "r"],
      rows: [["State", "Filings", "Rate filings", "Latest rate (%)"]].concat(tr) });
    items.push(fpSource(f, t, [star ? ["* Not approved: the figure may be the change asked for. Rate impacts are S&P's overall figure, not weighted by premium.", "* Not approved: may be the change asked for. Rate impacts unweighted.", "* Not approved: may be as asked."]
      : ["Latest rate: S&P's overall figure for the newest filing with one, not weighted by premium.", "Latest rate: overall, not premium-weighted."], f.states && f.states.noState ? cnt(f.states.noState) + " with no state left out." : ""]));
    return content(t, "states", T.states ? "Where it files" : "Where it files", items);
  }

  function fpYears(f, t) {
    var Y = f.years || {}, years = arr(Y.years), types = arr(Y.types), counts = arr(Y.counts), totals = arr(Y.totals), items = [];
    var colors = [NAVY, MAG, BLUE, TEAL, PURPLE, "0081C3"];
    var series = types.map(function (ty, i) { return ser(flat(ty) || "Type n/d", years.map(function (_, yi) { var v = arr(counts[yi])[i]; return num(v) ? v : 0; }), colors[i % colors.length]); });
    items.push(header("Filings by year published and filing type", L, TOP, LW));
    var rowsN = years.length + 1, th = rowsN * 0.25, ch = BOTTOM - TOP - HDR - 0.2 - th;
    items.push({ type: "chart", kind: "stackedColumn", x: L, y: TOP + HDR, w: LW, h: ch, categories: years.map(String), series: series, legend: "top", gap: 60, overlap: 100,
      labels: { format: "0;;;", position: "ctr", color: "FFFFFF", size: 10 }, catSize: 11, name: "Chart years" });
    var head = ["Year"].concat(types.map(function (ty) { return flat(ty) || "Type n/d"; })).concat(["All"]);
    var cw = (LW - 0.9) / (types.length + 1);
    items.push({ type: "table", x: L, y: TOP + HDR + ch + 0.2, colW: [0.9].concat(types.map(function () { return cw; })).concat([cw]), rowH: 0.25, size: 11, name: "Table years",
      rows: [head.map(function (h, j) { return j ? fitText(h, 11, cw - 0.26, true) : h; })].concat(years.map(function (y, yi) { return [String(y)].concat(types.map(function (_, i) { return cnt(arr(counts[yi])[i] || 0); })).concat([{ text: cnt(totals[yi] || 0), bold: true }]); })) });
    items = items.concat(takeaways(pointsOf(t, "years"), LX2, TOP, RW, BOTTOM - TOP));
    var und = f.totals && f.totals.undated;
    items.push(fpSource(f, t, [["By the year S&P published each filing; the first and last years are part years.", "By year published; first and last are part years."], und ? cnt(und) + " undated left out." : ""]));
    return content(t, "years", "Filings by year and type", items);
  }

  function fpForms(f, t) {
    var all = fpRows(f, "latest"), total = f.latest && num(f.latest.total) ? f.latest.total : all.length, items = [];
    var pts = points(pointsOf(t, "forms")), room = pts.length ? 10 : 14, rows = all.slice(0, room);
    items.push(header("Latest form and rule filings, newest first" + (total > rows.length ? " (" + rows.length + " of " + cnt(total) + ")" : ""), L, TOP, W));
    var tr = rows.map(function (r) { return [flat(r.company) || "n/d", flat(r.state) || "n/d", flat(r.toi) || "n/d", flat(r.type) || "n/d", flat(r.status) || "n/d", fpDate(f, r.published), flat(r.filingNo) || "n/d"]; });
    var tbl = fpTable("Table latest filings", L, TOP + HDR, W, ["Company", "State", "Type of insurance", "Filing type", "Status", "Published", "Filing number"], tr,
      [3.0, 0.65, 2.45, 1.3, 1.35, 1.2, 2.33], ["l", "l", "l", "l", "l", "r", "l"], [0, 5], { fit: [0, 2, 3, 4, 6] });
    items.push(tbl);
    var y2 = TOP + HDR + (rows.length + 1) * 0.25 + 0.3;
    if (pts.length && BOTTOM - y2 >= 0.9) items = items.concat(takeaways(pointsOf(t, "forms"), L, y2, W, BOTTOM - y2));
    items.push(fpSource(f, t, [["Filing number: the tracking number, or S&P's own number (S&P no.) when there is none.", "Filing number: tracking or S&P no."]]));
    return content(t, "forms", "Latest form and rule filings", items);
  }

  function fpRegulator(f, t) {
    var G = f.regulator || {}, rows = fpRows(f, "regulator").filter(function (r) { return r.state; }), items = [];
    var bars = rows.slice(0, 12), maxI = -1;
    bars.forEach(function (r, i) { if (maxI < 0 || r.median > bars[maxI].median) maxI = i; });
    items.push(header("Median days from submitted to published, by state", L, TOP, LW));
    var ch = Math.min(BOTTOM - TOP - HDR, 0.45 + bars.length * 0.3), pc = {}; if (maxI >= 0) pc[maxI] = MAG;
    items.push({ type: "chart", kind: "bar", x: L, y: TOP + HDR, w: LW, h: ch, legend: "none", gap: 50, categories: bars.map(function (r) { return r.state; }),
      series: [ser("Median days", bars.map(function (r) { return r.median; }), NAVY, { pointColors: pc })], labels: { format: "#,##0" }, catSize: 11, name: "Chart days" });
    var y2 = TOP + HDR + ch + 0.25;
    if (BOTTOM - y2 >= 1.3) items = items.concat(takeaways(pointsOf(t, "regulator"), L, y2, LW, BOTTOM - y2));
    var maxRows = Math.floor((BOTTOM - TOP - HDR) / 0.25) - 2, shown = rows.slice(0, maxRows);
    var range = function (r) { return r.lo === r.hi ? cnt(r.lo) : cnt(r.lo) + " to " + cnt(r.hi); };
    var tr = shown.map(function (r) { return [r.state, cnt(r.n), cnt(r.median), range(r)]; });
    if (G.all && rows.length > 1) { tr.push([{ text: "All states", bold: true }, { text: cnt(G.all.n), bold: true }, { text: cnt(G.all.median), bold: true, color: MAG }, { text: range(G.all), bold: true }]); }
    items.push(header("By state, approximate" + (rows.length > shown.length ? " (" + shown.length + " of " + rows.length + ")" : ""), LX2, TOP, RW));
    items.push({ type: "table", x: LX2, y: TOP + HDR, colW: [1.0, 0.9, 1.15, 1.33], rowH: 0.25, size: 11, name: "Table days", aligns: ["l", "r", "r", "r"],
      rows: [["State", "Filings", "Median days", "Range of days"]].concat(tr) });
    items.push(fpSource(f, t, [DAYS_NOTE, G.left ? cnt(G.left) + " without both dates left out." : ""]));
    return content(t, "regulator", "Time with the regulator, approximately", items);
  }

  function fpQuestions(f, t) {
    var qs = ((t.questions && t.questions.items) || []).filter(function (q) { return q && (flat(q.title) || flat(q.text)); }).slice(0, 4), items = [];
    qs.forEach(function (q, i) {
      var x = i % 2 ? QX2 : L, y = i < 2 ? 1.35 : 3.8, inner = QW - 1.05 - 0.2;
      var title = flat(q.title), text = flat(q.text);
      if (lineCount([{ text: title, bold: true }], 14, inner) > 2) title = fitText(title, 14, inner * 2 - 0.3, true);
      while (lineCount([{ text: text }], 12, inner) > 6) text = fitText(text, 12, (lineCount([{ text: text }], 12, inner) - 1) * inner - 0.4, false);
      items.push({ type: "numbered", x: x, y: y, w: QW, h: 2.2, n: i + 1, title: title, text: text, inset: 1.05, badge: 0.6, name: "Question " + (i + 1) });
    });
    items.push(fpSource(f, t, [t.by === "claude" ? "" : ["Questions follow from the filings in this profile (inferred).", "Questions inferred from the filings."]], true));
    return { kind: "content", id: "questions", title: trimTitle(flat(t.questions && t.questions.title) || "Key diligence questions"), items: items };
  }

  function fpSpec(facts, text) {
    var f = facts || {}, t = text || {};
    var included = {}; fpPlan(f).forEach(function (r) { included[r.id] = r.included; });
    var make = { summary: fpSummary, rates: fpRates, states: fpStates, years: fpYears, forms: fpForms, regulator: fpRegulator, questions: fpQuestions };
    var slides = [fpCover(f, t)];
    FP_SLIDES.slice(1).forEach(function (s) { if (included[s[0]]) slides.push(make[s[0]](f, t)); });
    var day = ymd(f.asOf) ? String(f.asOf).slice(0, 10) : "";
    return { fileName: (slug(fpName(f)) || "filings") + "-filings-profile" + (f.sample ? "-sample" : "") + (day ? "-" + day : "") + ".pptx", slides: slides };
  }

  function spec(facts, text) {
    var f = facts || {}, t = text || {};
    var included = {}; plan(f).forEach(function (r) { included[r.id] = r.included; });
    var make = { summary: summarySlide, premium: premiumSlide, underwriting: underwritingSlide, capital: capitalSlide,
      reserves: reservesSlide, reinsurance: reinsuranceSlide, filings: filingsSlide, questions: questionsSlide };
    var slides = [coverSlide(f, t)];
    SLIDES.slice(1).forEach(function (s) { if (included[s[0]]) slides.push(make[s[0]](f, t)); });
    var name = slug(entityName(f)) || "company";
    var day = ymd(f.asOf) ? String(f.asOf).slice(0, 10) : "";
    return { fileName: name + "-profile" + (f.sample ? "-sample" : "") + (day ? "-" + day : "") + ".pptx", slides: slides };
  }

  window.SNLProfile = { plan: plan, spec: spec, filingsPlan: fpPlan, filingsSpec: fpSpec,
    format: { money: money, millions: millions, pct: pct, pctCell: pctCell, mult: mult, shortDate: shortDate, monthYear: monthYear, trimTitle: trimTitle } };
})();
