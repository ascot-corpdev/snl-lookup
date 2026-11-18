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
  //   SNLProfile.filingsPlan(facts, extra)        -> [{id, label, included, reason}] in deck order
  //   SNLProfile.filingsSpec(facts, text, extra)  -> {fileName, slides} for SNLDeck.build
  //   extra: {digests} (optional), saved summaries of the facts' readable rate filings, from snl-digest, for the slide of
  //   rate figures read by Claude
  // Every figure is the function's; nothing here adds or averages rate impacts. Columns that would be empty on every
  // row are left out, and a filing's description is never used (real rows often have none).
  var TEAL = "00857C", PURPLE = "944599";
  var FP_SLIDES = [
    ["cover", "Cover"], ["summary", "Summary"], ["signals", "Filing signals (red, amber, green)"], ["states", "Where it files (map)"],
    ["ratemap", "Latest approved rate change by state (map)"], ["rates", "Rate changes"], ["history", "Approved rate changes compounded"],
    ["lines", "Types of insurance and outcomes"], ["read", "Rate filings read by Claude"], ["exposure", "Premium and exposure by state"],
    ["years", "Filings by year and type"], ["forms", "Latest form and rule filings"], ["regulator", "Time with the regulator"], ["questions", "Key diligence questions"]
  ];
  var LX2 = 8.42, LW = 7.4, RW = R - LX2;                 // two columns: left x 0.52 w 7.4, right x 8.42 w 4.38
  var FP_CHART_COLS = 20;                                 // the most filings drawn as columns on the rate chart
  var NOTHING = "S&P returned nothing for this search, so there are no filings to show. That doesn't prove nothing was filed.";

  function arr(a) { return Array.isArray(a) ? a : []; }
  function cnt(n) { return num(n) ? commas(String(Math.round(n))) : "n/d"; }
  function fpRows(f, k) { return arr(f[k] && f[k].rows).filter(function (r) { return r && typeof r === "object"; }); }
  var OLDER = "These figures came from an older version of the profile function, which doesn't work them out. Deploy snl-profile again (README, step 10).";
  var EXPOSURE = "A filings profile has no premium or exposure figures: they need statutory data (S&P on Snowflake). Filing counts aren't exposure. The full profile shows premium by state once statutory data is set up.";
  // the summaries of rate filings the page passes in (extra.digests): those with a rate figure, in the order given
  function readRows(extra) {
    return arr(extra && extra.digests).filter(function (d) {
      var r = d && d.rate; return r && typeof r === "object" && ["overallPct", "requestedPct", "approvedPct", "indicatedPct", "lcm", "trendPct", "expensePct", "premium"].some(function (k) { return num(r[k]); });
    }).slice(0, 8);
  }
  function fpPlan(facts, extra) {
    var f = facts || {}, T = f.totals || {}, R = f.rates || {}, Y = f.years || {};
    var rows = FP_SLIDES.map(function (s) { return { id: s[0], label: s[1], included: true, reason: "" }; });
    var out = function (id, reason) { rows.forEach(function (r) { if (r.id === id) { r.included = false; r.reason = reason; } }); };
    out("exposure", EXPOSURE);
    if (!num(T.filings) || T.filings <= 0) { ["signals", "states", "ratemap", "rates", "history", "lines", "read", "years", "forms", "regulator"].forEach(function (id) { out(id, NOTHING); }); return rows; }
    if (!Array.isArray(f.signals)) out("signals", OLDER); else if (!f.signals.length) out("signals", "There are no filings to screen.");
    if (!fpRows(f, "states").length) out("ratemap", "None of the filings names a state in S&P's data.");
    else if (!fpRows(f, "states").some(function (r) { return "approved" in r; })) out("ratemap", OLDER);
    else if (!fpRows(f, "states").some(function (r) { return r.approved && num(r.approved.rate); })) out("ratemap", "No approved filing carries an overall rate impact in S&P's data, so there is nothing to colour the rate map by.");
    if (!f.history) out("history", OLDER);
    else if (!fpRows(f, "history").length) out("history", "No approved filing carries an overall rate impact and a publish date in S&P's data, so there is nothing to compound.");
    if (!f.lines) out("lines", OLDER); else if (!fpRows(f, "lines").length) out("lines", "None of the filings names a type of insurance in S&P's data.");
    if (!readRows(extra).length) out("read", arr(extra && extra.digests).length
      ? "The saved summaries of these rate filings carry no rate figures."
      : "No rate filing in this profile has a saved summary yet. Summarise the largest rate filings to add the requested, approved and indicated changes.");
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
      notes.forEach(function (n) { var x = typeof n === "string" ? n : n[Math.min(lv, n.length - 1)]; if (x) parts.push(x); });
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

  // ---------- the map of the United States ----------
  // The state outlines are the page's own (US_MAP in index.html: us-atlas 3.0.1, ISC licence, copyright 2013-2019
  // Michael Bostock, made from the US Census Bureau's public cartographic boundary files, simplified), copied here so
  // the slide builder needs no other file; tests/web/deckfilings.test.cjs checks that the two copies are the same. Each
  // is [SVG path, name, label x, label y] on a 975 x 610 drawing (Albers USA: Alaska and Hawaii sit bottom left). On a
  // slide each state is its own editable outline (a freeform shape), and the map is one group.
  var US_MAP = {
AK:["M99 570l4 -5l2 4l-4 1zM93 575l6 -4h4l2 2l-6 5l-2 -1l-2 3zM44 547l2 1l4 -1l1 4l-3 1l-4 -3zM31 601l3 -1l4 -4l2 2l-3 3zM51 505l8 -4l7 -1l-1 4l6 1l3 -1l-3 -4l2 -2l-3 -1l-3 -1l-1 -4l-3 -4l-4 -4l3 -3h5l3 -2l2 -4l3 -4h3l4 -3h5l2 -3l4 1l-1 3l2 -3l1 3l4 -1l2 1v1l3 2l5 -1l5 2h5l4 1l3 -2l7 2l14 73h4l4 -2v2l7 5l2 3l3 -3v-4l2 -2l3 1l4 5l5 2l9 8l2 4l1 -1l7 2l3 6l-2 5l-3 -3l-5 -1l-1 -3l-3 -1l1 -2l-2 -3l-5 -2l-1 -3l-4 -3h-2l-5 -6l4 7l-2 -1l-5 2l-6 -3l-2 -2l-7 -2v-3l-2 2l-5 -1h-5l-6 2l-6 -3l-4 2l3 -3l-2 -1l-2 -2l-5 2l2 6l-2 1h-5l-3 5l-1 -2l-1 3h-4l4 -4l-2 1l-2 -1l2 -4v-3l4 -3l1 1v-3h-3l-3 2l-4 7l-2 4l-4 3v2l4 2l-4 3v2l-6 3l-4 4v2l-4 1l-2 3l-3 1l2 1l-2 2h-6l-4 3h-4v-1l-2 3l-5 1l-3 2l-6 1l2 -3l8 -2l5 -5h4l5 -4l4 -2l6 -6l1 -7l2 -3l-4 2l-2 -2l-2 3l-3 -4l-2 -1l-6 3l-1 -6l2 -1l-2 -6l-1 1l-5 1l-5 -6l1 -2v-4l-1 1l-2 -4l2 -2l1 -2l3 -4l2 -3l2 -1l3 2l3 -3h4l2 -2l-1 -6l2 -1l-1 -2l-5 3l-7 -2l-2 1l-4 -2l-1 -5h2l-4 -2zM25 603l4 -4l2 1zM34 518h5l3 3l3 1l-4 2l-2 -3zM-6 601h5l-1 2zM-15 601l2 -2l2 2zM-58 571l3 1l1 2l-2 -1zM185 573v-3h2l7 6l2 4l-6 -2l-1 -2zM180 567l2 -2l3 -1l4 3l-3 2h-2v3h-1zM175 556l1 1h2l3 6l-1 3l-1 -3zM174 565l1 -2h2l3 5l1 5l-5 -5l-1 -3zM169 561l3 -3l3 1l2 4l-3 -1v3z","Alaska",102,521],
AL:["M642 384l24 -2l23 -2l13 47l3 5l3 4l-1 3l3 1l-3 3v3l-1 4l1 3l2 4l-1 8l3 4l-17 2l-33 3l-1 3l5 4v4l1 1l-2 4l-6 2l1 -2l-3 -2l-1 -6h-2l-1 4v4l-3 -1h-3l-4 -34l1 -42l1 -27z","Alabama",672,433],
AR:["M523 355h27l36 -2l18 -1l1 2v3l-2 2l-3 5l12 -1l2 2l-3 1l2 1l-5 2l2 3l-3 2l-2 4h2l-2 3l2 2l-2 1l-2 3l1 2l-6 4l2 1l-2 2l1 4l-4 2l-1 5l-2 1l1 1l-3 2l2 4h-3l1 3h-3l2 2h-1v3l1 2l2 5l-2 1v2l-20 1l-34 1v-12l-3 -1l-3 1l-3 -2l1 -40z","Arkansas",564,391],
AZ:["M145 407h4l2 -3l-1 -3l-3 -1l1 -5v-3l2 -1l2 -2l2 -3v-6l3 -3l3 -1l3 -2l-3 -4l-2 -7l-2 -4l1 -3l2 -3l-1 -8l1 -3v-4l1 -7h3h4l1 4h2l3 -4l3 -18l27 5l36 6l26 4l-14 96l-4 32l-39 -6l-36 -21l-30 -17l1 -3z","Arizona",208,382],
CA:["M77 374l4 3v3l-2 -2v-2zM75 384l3 6l-2 -1zM57 355l6 4l-6 -2zM50 355h4l1 3h-3zM33 160l13 4l16 4l22 7l16 4l-17 67l74 110l-1 3l2 4l2 7l3 4l-3 2l-3 1l-3 3v6l-2 3l-2 2l-2 1v3l-1 5l3 1l1 3l-2 3h-4l-46 -5l1 -2l-2 -2l1 -4v-6l-2 -6l-5 -6l-6 -6l-1 1l-3 -2l1 -2l-1 -5h-6l-6 -5l-1 -3l-4 -5l-6 -1l-4 -3l-6 -1l-3 -4l3 -5l-1 -2l2 -5l-4 -3l1 -4l-2 -2l-2 -4l-1 -2l-5 -13l-2 -4v-4l1 -3h2l2 -3l-2 -5h-3l-4 -7l2 -3l-1 -4l1 -6h2v5l3 4l1 -5l-3 -3l1 -3l-1 -2l3 -1l-1 -3l-2 1v3l-3 3l-4 -5l-3 -2l2 -3l-1 -7l-3 -3l-1 -4l-3 -7l2 -2l-1 -8l3 -3v-7l-2 -7l-4 -5l1 -4l8 -9l1 -5l3 -6l1 -7l-2 -2z","California",78,294],
CO:["M277 237l24 3l32 4l28 3l34 2l-1 23l-4 69l-18 -2l-23 -1l-34 -4l-36 -4l-14 -2l3 -26v-3l3 -19z","Colorado",332,290],
CT:["M871 184l28 -6l3 13v2h-2l-7 4l-6 1h-2l-3 5l-4 2l-4 3l-2 -2l4 -3l-2 -2z","Connecticut"],
DC:["M826 267l1 -2l3 2l-2 3z","District of Columbia"],
DE:["M845 245l2 -3l4 -1l-1 3l-2 3l1 2l4 3l2 6l5 5h1l3 7l-11 3z","Delaware"],
FL:["M794 604l1 -2l5 -4l5 2l-9 4zM711 469l3 6l52 -4l1 5h3v-5l-1 -5l1 -1l5 1h5l3 10l4 10l8 14l11 14l-1 3l2 5l5 7l3 8l5 7l2 5l1 5l1 21l-2 -1l-1 6l1 3v4l-3 2l1 -3h-2l-4 2l-7 2l-2 -2v-3l-4 -7l-3 -2l-5 -2l-1 1l-3 -4l-1 -5l-3 -3l-3 -2l-2 -2l1 -4l-1 -3l-1 1l1 3l-2 1l-5 -6l-4 -5l-3 -3l5 -10l-6 -3l-1 2l3 2v3h-2l-3 -4v-6l2 -6v-4l-3 -5l1 -2l-3 -5h-4l-1 1l-1 -3h-2l-1 -3l-4 -2l-1 -3l-2 -1l-3 -3l-8 -4h-5l-1 3v2h-3l-7 5l-4 1l2 3l-4 -2l-3 1l1 -3l-2 -3l-10 -6l-7 -2h-8l-13 3l-4 1l2 -4l-1 -1v-4l-5 -4l1 -3l33 -3z","Florida",789,539],
GA:["M689 380l24 -3l13 -2l9 -1v1l-3 4v3l3 1l3 2h3l3 6l4 5l7 4l1 2l3 1l3 3v2l2 1l2 3l5 2l2 4l1 5l3 1l4 6v3l5 2l1 1l-4 6l-1 5l-1 4v3l-1 2l-2 4l2 1v5h-5l-5 -1l-1 1l1 5v5h-3l-1 -5l-52 4l-3 -6l-3 -4l1 -8l-2 -4l-1 -3l1 -4v-3l3 -3l-3 -1l1 -3l-3 -4l-3 -5z","Georgia",736,428],
HI:["M305 584l3 -2l2 -4l-1 -3l1 -2l5 3l7 2l4 4v2h2v3l4 2l-3 4l-4 2h-3l-5 3l-3 5l-5 -3l-1 -1l1 -5l-1 -4zM292 558l2 -3l2 4l4 -2l6 4l-1 3l-6 2l-2 -1v-4l-4 -1zM292 567l2 -2l1 2zM284 558h3l2 2l-3 2zM279 554l1 -3l11 2l-3 2l-5 -1zM258 543h3l4 -3l2 4v2l4 3l-3 1l-2 -1h-4zM226 533l1 -3l4 -2l4 1l2 1l-1 4l-3 2h-3zM216 537l4 -4v3l-3 2z","Hawaii"],
IA:["M491 195h25l33 -1l27 -1l1 3l2 3l-2 3l1 5l2 4l6 1l1 3l3 3l2 4l4 2v7l-2 2l-1 3l-5 3l-6 2l-1 4l3 3v4l-3 3v3l-4 1l-1 6l-5 -5l-26 1l-24 1h-19l-2 -3l1 -4l-2 -10v-3l-3 -2l1 -6l-3 -4l-3 -12l-3 -6l1 -2l1 -4l1 -2l-3 -4l1 -2l-1 -3z","Iowa",540,227],
ID:["M171 102v-4l-1 -4l1 -2l7 -33l6 -23l14 3l-5 23l4 7l-1 3l1 2h-2l3 4l3 2l1 2l3 6v2l3 3l1 3h4l-2 6l-3 7l1 5l-3 1v2l-1 3l3 3l4 -2l3 -3l2 3l-1 2l1 4l2 5l1 2l-1 5l2 2l3 1l1 7l2 3l1 -3l7 2l2 -3l2 2h4l7 1v-3h3l1 3l2 3l-9 56l-47 -8l-2 -1l-38 -8l-11 -2l9 -41l4 -7l-1 -2l-3 -1l-1 -3l5 -7l2 -1l3 -3v-2l2 -2l2 -4l5 -6l-1 -3l-3 -2z","Idaho",199,165],
IL:["M576 265l1 -6l4 -1v-3l3 -3v-4l-3 -3l1 -4l6 -2l5 -3l1 -3l2 -2v-7l-4 -2l-2 -4l-3 -3l31 -1l16 -2v5l3 5l3 8l5 54l-2 4l3 5l1 5l-2 2v3l-3 6l-3 1l1 2l-2 5l1 3l-2 3l2 4l-7 3v2l2 3l-2 2l-8 -3l-3 4v2l-2 -2v2l-5 -7l1 -1l-2 -4l1 -2l-2 -2l-5 -4l-1 1l-8 -8v-4l2 -6l-1 -2l2 -3l-6 -2l-2 2l-2 -1l-1 -7l-6 -4l-1 -2l-5 -4l-2 -7l-1 -5z","Illinois",615,270],
IN:["M640 230l2 1h5l5 -3l17 -2l17 -2v1l2 22l5 37l-2 2l3 6h-3l-3 3l-3 -1l-2 1l1 3l-3 3l-1 3l-3 1l-1 7l-2 1l-4 -2l-1 -2l-3 3v2l-4 1l-1 -2l-4 3l-2 3l-4 -3l-3 1l-1 -2v3l-2 -1l-6 3l-1 -3l2 -5l-1 -2l3 -1l3 -6v-3l2 -2l-1 -5l-3 -5l2 -4z","Indiana",665,269],
KS:["M394 272l28 1l21 1l22 1h30h15l2 2l4 1l1 3h-1l-2 5l3 3l2 4l3 2l1 49h-34h-30l-26 -1l-43 -2z","Kansas",456,309],
KY:["M621 340v-2l3 -4l8 3l2 -2l-2 -3v-2l7 -3l-2 -4l2 -3l6 -3l2 1v-3l1 2l3 -1l4 3l2 -3l4 -3l1 2l4 -1v-2l3 -3l1 2l4 2l2 -1l1 -7l3 -1l1 -3l3 -3l-1 -3l2 -1l3 1l3 -3h3l-3 -6l2 -2l1 -1l2 2l3 -2l2 2l3 5h6l4 3l2 -2l5 1h2l2 -3l2 -1l1 4h3l2 3l1 3v4l2 4l4 3l1 2l3 2h3l-6 7l-6 5v1l-2 2v2l-3 2l-1 2l-9 5l-16 2h-12l-11 2h-9l-27 3l-4 -1v5l-22 1h-2v-2h3l2 -9z","Kentucky",694,323],
LA:["M629 498l2 -3l1 3zM577 511h3l3 1l-3 2zM535 435l34 -1l20 -1l2 3l-1 3h2l-2 2l3 1l-2 3l2 1l1 2h1l-5 3l3 2l-1 2l-2 2l-3 4l-1 5l-2 1l1 3h-2l2 3h-3l2 5l-1 1l23 -1l13 -1l-1 8l3 4l1 4l3 2l-6 4v2h2l1 2l2 -1v-2l2 -2l2 3l2 -2l1 3l-3 1l-1 4l-4 1v2l3 3l6 1l3 4l-1 4l-2 -2l-3 4l2 -5l-7 -3l-4 -1l-7 6l-3 -5l-2 -1l-3 3l-4 5l-3 -3h-3l-5 -3l2 -1l3 2l-1 -2l-2 -2l-2 1v-2l-2 1l-2 -4h-2v-2l-5 1v-3l-5 2h-1l2 3l-4 2l-6 -1l-11 -4h-6l-6 1l-1 1l-2 -3l4 -5v-9l-1 -3l4 -6v-4l-1 -4l-3 -7l-2 -2v-4l-5 -5z","Louisiana",568,480],
MA:["M928 187l5 -1l-2 2zM918 188l3 -4l4 3zM871 168l13 -3l19 -4l3 -5l3 -1l2 4l3 -1l-5 8l1 3l2 -2l5 4v3h2l3 4l3 -1l4 -2l-1 -4l3 6l-6 3l-2 2l-3 1l-2 -4v3l-3 1v2l-2 1l-2 -3l-1 -1l-2 -1l-3 -5l-6 2l-28 6v-1z","Massachusetts"],
MD:["M782 257l34 -6l29 -6l8 28l11 -3l-1 10l-7 3l-1 1l-3 1l-1 -3l-3 -6v3h-2l-5 -5l1 -3h4l-6 -3l2 -2l-1 -2l-2 2v-4l2 1l1 -3l-3 -1l1 -4l2 -2l1 -4l-2 1l1 2l-3 2h-2l1 3l-2 2l2 4l-2 6l2 5l3 3l-1 2l3 3l1 2l-3 -1l-3 -2l-3 1l-4 -2l-1 -2l-3 2l-2 -2l2 -4l1 -4l2 -3l-3 -2l-1 2l-4 -2l-4 -1l1 -2l-2 -2h-3l-3 -4v-2l-3 1l-3 -2l-3 2l-2 3l-3 1l-3 -2l-2 5l-2 -1l-3 5l-3 3z","Maryland"],
ME:["M931 119l2 -2l1 2l-2 2zM910 150l-2 -1l-1 -2l-2 -2l-10 -31l-4 -12l1 -1l3 2l-1 -4h3l-2 -3l2 -4l2 -2l-1 -1l2 -3l-2 -3v-7l2 -2l-1 -7l7 -19h3l1 3l2 1l5 -3l3 -1v-2h3l7 4l7 24l2 6l3 1l3 -1v3l1 1v3l3 3l3 -2l5 7l-2 4h-2l-3 7l-3 -2l-1 3l-2 1v2h-3v3l-2 1l-2 -4l-2 1l2 4l-1 3l-1 -3l-3 -1l-1 -4l-1 4l-1 6l1 3l-4 3l-2 2l-3 1l-1 3l-2 -1l-3 3v3l-2 1v4l-2 1z","Maine",919,93],
MI:["M677 131l5 1l-2 1zM662 139l1 -4l2 3zM652 228l3 -4l2 -5l2 -3l1 -6v-5l-1 -7l-3 -7l-4 -7l2 -4l-2 -5l3 -7v-8l2 -1v-4l4 -1l3 -6l1 3l-1 5l1 1l1 -5v6l2 -5l-1 -7l3 -3l4 -1l-2 -1l-2 -3l3 -4l2 -1l6 2h4l2 3h3l5 2h2l4 7l-2 -1v3l2 1l1 4v8l-3 4v3l-4 2l-1 6l1 2l4 1l6 -9l5 -3l3 1l2 3l3 9l1 5l3 5l-1 9l-2 2v-3h-3l-1 8l-3 3l1 3l-3 4l-2 5l-22 3v-1l-17 2zM601 92l1 -1l8 -5l4 -2l-4 5l-5 2l-2 2zM585 123l6 -3l3 -3l7 -1l4 -4h2l1 -3l5 -3l2 -3l4 -2l5 -1l2 1l-4 1l-4 6l-3 4l1 5l3 -5h5l4 2l5 7h11l-1 -2l2 2l2 -3l5 -3l10 -1l3 -2l5 -1l-1 2l1 5h3l3 -1v1l3 -2l4 -1l1 6l-2 2l4 1l1 2h3v-2h3l2 2l-1 2l-9 -1l-4 2l-5 -2l-1 2l1 2h-2l-3 -3l-5 -1h-3l-2 3l-4 2l-4 -1l-2 2l-1 2l-5 4l3 -5l-4 1l-1 3l-5 2l-6 13l-2 -2l1 -3l-4 -1l1 -3v-4l-3 -2l-3 -1l1 -2l-11 -1l-5 -3l-17 -3l-2 -4z","Michigan",690,199],
MN:["M479 71h32v-9h3l2 2l2 9v3l2 1h4l1 1l6 1l1 2l4 -1v-1l4 -1l4 1l4 1v2h3l2 5l2 -3h3l1 2l4 1l3 4l5 -1l4 -4h2l1 3l10 -1l4 3l2 -1l2 1l-6 3l-8 4l-3 1l-6 7l-3 3l-5 5l-6 5l1 2l-1 -1l-3 2v14v1l-5 2l-3 5v3h1l2 3l-1 4v8l-1 4l5 4h3l2 3l5 2l1 3l5 4h2l4 5l-1 4l1 2l-27 1l-33 1h-25v-41l-4 -2l-3 -5l5 -5v-2v-9l-2 -3l-1 -5v-5l-1 -1v-15l-4 -13v-2v-6v-3z","Minnesota",519,136],
MO:["M502 262h19l24 -1l26 -1l5 5l-1 3l1 5l2 7l5 4l1 2l6 4l1 7l2 1l2 -2l6 2l-2 3l1 2l-2 6v4l8 8l1 -1l5 4l2 2l-1 2l2 4l-1 1l5 7v-2l2 2h1l-2 9h-3v2h-1l-1 1v2l-3 4l2 2l-2 3l-12 1l3 -5l2 -2v-3l-1 -2l-18 1l-36 2h-27v-11l-1 -49l-3 -2l-2 -4l-3 -3l2 -5h1l-1 -3l-4 -1l-2 -2l-2 -1l-1 -4l-2 -2z","Missouri",560,312],
MS:["M589 433v-2l2 -1l-2 -5l-1 -2v-3h1l-2 -2h3l-1 -3h3l-2 -4l3 -2l-1 -1l2 -1l1 -5l4 -2l-1 -4l2 -2l-2 -1l6 -4l-1 -2l16 -1l23 -2l2 2l-1 27l-1 42l4 34l-2 2l-8 -1l-3 1l-6 3l-2 1l-3 -2l-1 -4l-3 -4l1 -8l-13 1l-23 1l1 -1l-2 -5h3l-2 -3h2l-1 -3l2 -1l1 -5l3 -4l2 -2l1 -2l-3 -2l5 -3h-1l-1 -2l-2 -1l2 -3l-3 -1l2 -2h-2l1 -3z","Mississippi",618,437],
MT:["M198 39l12 3l23 4l32 6l38 5l23 3l14 2l24 3l13 1l-6 68l-2 22l-30 -3l-41 -5l-35 -5l-5 -1l-2 12l-2 -3l-1 -3h-3v3l-7 -1h-4l-2 -2l-2 3l-7 -2l-1 3l-2 -3l-1 -7l-3 -1l-2 -2l1 -5l-1 -2l-2 -5l-1 -4l1 -2l-2 -3l-3 3l-4 2l-3 -3l1 -3v-2l3 -1l-1 -5l3 -7l2 -6h-4l-1 -3l-3 -3v-2l-3 -6l-1 -2l-3 -2l-3 -4h2l-1 -2l1 -3l-4 -7z","Montana",287,100],
NC:["M863 350l1 -2l7 -5v1l-4 2zM756 334l24 -3l32 -5l28 -6l19 -4l2 4l5 8h-2l-4 -9l-4 -2l3 3l3 5l-3 -2l-1 2l-4 -2l3 3l-4 2l-2 2h-4v3l5 -2h1l3 -1h3v2l1 4v-6l3 -1l3 6l-1 2l-2 1l-3 6l-7 1l-2 -3l1 3l-9 -2l11 4l-1 5l-3 3l-4 -2v2l4 1l5 -3l4 1l-2 2l-1 4l6 -10h1l-5 7l-2 5v-1h-5l-7 4l-6 5l-4 7l-1 7l-4 -1l-6 3l-25 -18l-20 3l-1 -2l-3 -4l-2 2v-2l-23 2l-3 1l-11 6l-9 1l-13 2v-6l4 -2v-3l4 -3l5 -1l7 -6h2l3 -6l2 -2l1 3l2 -2l1 -2l3 -2l4 1l1 -5l3 -3z","North Carolina",801,350],
ND:["M377 66l27 2l17 1l24 1l34 1l2 7v3v6v2l4 13v15l1 1v5l1 5l2 3v9l-29 -1h-17l-31 -2l-20 -1l-21 -2z","North Dakota",429,104],
NE:["M365 201l39 3l30 1l23 1v1l9 5l1 -2h3h6l3 2h3l5 3l1 3h3l3 12l3 4l-1 6l3 2v3l2 10l-1 4l2 3l3 6l2 2l1 4l2 1h-15h-30l-22 -1l-21 -1l-28 -1l1 -23l-34 -2z","Nebraska",434,239],
NH:["M886 111l1 -6l1 -2l3 1v-2l4 12l10 31l2 2l1 2l2 1l-1 5l-3 1l-3 5l-19 4l-2 -2v-5l-1 -12l2 -13l-1 -5l3 -2l3 -4v-3l-2 -2l1 -4z","New Hampshire"],
NJ:["M849 246l1 -2l1 -3l4 -2v-2l6 -6l-7 -5l-1 -2l-2 -1l-1 -2l2 -5l-2 -2l3 -5v-3l2 -2l15 5l-1 7v1l-2 1v3v1h4l1 3l1 12l-3 10l-3 4l-2 6l-2 2v-5l-3 -1l-1 1l-7 -4h-2z","New Jersey"],
NM:["M265 328l14 2l36 4l34 4l23 1v12h-1l-4 57l-2 22l-2 23l-24 -2l-21 -2l-23 -2l-1 2l2 3l-32 -4l-1 10l-16 -2l4 -32z","New Mexico",311,393],
NV:["M100 179l22 6l27 6l11 2l38 8l-22 110v2l-3 18l-3 4h-2l-1 -4h-4h-3l-1 7v4l-1 3l1 8l-2 3l-74 -110z","Nevada",142,252],
NY:["M869 217l-1 3l-1 1v-3zM768 200l8 -8l2 -3l2 -3l-2 -4h-1l-2 -6l9 -4l8 -2h4l4 2l2 -1l7 -2l4 -2l4 -5l2 -1v-3l-2 -4l2 -2l-4 -2v-4l5 -5l2 -3l7 -10l3 -4l13 -3l13 -3l1 4v5l2 2l1 5l-1 6l3 5v4l2 -1l1 2l3 16l1 2v15v1l3 17l2 2l-4 3l2 2v3l3 -3h5l1 -1l8 -3l4 -4l5 2l3 -3l-7 7l-10 7l-8 4l-4 1l-2 1l-3 -3l1 -7l-15 -5l-1 -1l-4 -1l-3 -5l-2 -3l-2 1l-2 -3l-16 4l-25 5l-31 5z","New York",842,172],
OH:["M686 225l22 -3l7 2l3 1l1 -1l4 3h3l7 -4h5l4 -5l6 -5l8 -4l5 30l-2 2l1 2l1 4l-2 5l1 4l-2 7l-4 6l-2 2l-2 -2l-2 4h-2l-1 5l1 3l-2 2l-3 -3l-2 5l1 5h-2v3l-5 2l-2 -3h-3l-1 -4l-2 1l-2 3h-2l-5 -1l-2 2l-4 -3h-6l-3 -5l-2 -2l-3 2l-2 -2l-1 1l-5 -37z","Ohio",724,253],
OK:["M372 339l18 2l43 2l26 1h30h34v11l4 26l-1 40l-6 -3l-3 -2l-5 -3l-1 2h-4l-1 -1l-5 2l-2 -1l-6 3l-1 2l-2 -2l-5 -3l-1 2l-3 -3l-5 5l-1 -5l-3 3l-1 -2l-4 -2l-4 3l-2 -1l1 -2l-3 -1l-1 -2l-4 -1l-2 2l-2 -2h-3l-4 -2h-4l-1 -3l-3 -3v2l-3 -1l-3 1l-3 -4l-2 -1l2 -44l-30 -2l-24 -1z","Oklahoma",485,378],
OR:["M71 70l3 4h3l3 3v3l-1 7l7 4l8 -1l4 1l5 2v2l9 -1l2 1l4 1l5 -1h8l5 1l3 -1l32 7l1 5l3 2l1 3l-5 6l-2 4l-2 2v2l-3 3l-2 1l-5 7l1 3l3 1l1 2l-4 7l-9 41l-27 -6l-22 -6l-16 -4l-22 -7l-16 -4l-13 -4l-2 -3l1 -8l2 -3l-1 -6l2 -3l3 -6l5 -5l2 -5l8 -18l1 -4l3 -7l4 -11l1 -6l2 -1v-5l1 2z","Oregon",103,134],
PA:["M756 209l3 -2l9 -7l1 6l31 -5l25 -5l16 -4l2 3l2 -1l2 3l3 5l4 1l1 1l-2 2v3l-3 5l2 2l-2 5l1 2l2 1l1 2l7 5l-6 6v2l-4 2l-4 1l-2 3l-29 6l-34 6l-17 3l-4 -21z","Pennsylvania",806,226],
RI:["M911 183l2 3l-4 2zM902 193v-2l-3 -13l6 -2l3 5l2 1l-3 -1l1 7v3z","Rhode Island"],
SC:["M735 374l11 -6l3 -1l23 -2v2l2 -2l3 4l1 2l20 -3l25 18l-3 2l-4 4l-3 7l1 5l-3 2v2h-3l-1 3l-4 4l-2 4l-4 2l-2 2l-3 1l1 3l-3 2l-4 4v2l-5 -2v-3l-4 -6l-3 -1l-1 -5l-2 -4l-5 -2l-2 -3l-2 -1v-2l-3 -3l-3 -1l-1 -2l-7 -4l-4 -5l-3 -6h-3l-3 -2l-3 -1v-3l3 -4z","South Carolina",779,392],
SD:["M369 156l2 -22l21 2l20 1l31 2h17l29 1v2l-5 5l3 5l4 2v41h-3l1 3l-1 2l3 4l-1 2l-1 4l-1 2l3 6h-3l-1 -3l-5 -3h-3l-3 -2h-6h-3l-1 2l-9 -5v-1l-23 -1l-30 -1l-39 -3z","South Dakota",430,172],
TN:["M612 363l2 -3l-2 -2l3 -4v-2l1 -1h1h2l22 -1v-5l4 1l27 -3h9l11 -2h12l16 -2l7 -1l29 -4l-1 4l-3 3l-1 5l-4 -1l-3 2l-1 2l-2 2l-1 -3l-2 2l-3 6h-2l-7 6l-5 1l-4 3v3l-4 2v6l-24 3l-23 2l-24 2l-23 2l-16 1l2 -3l2 -1l-2 -2l2 -3h-2l2 -4l3 -2l-2 -3l5 -2l-2 -1l3 -1z","Tennessee",673,361],
TX:["M372 351l24 1l30 2l-2 44l2 1l3 4l3 -1l3 1v-2l3 3l1 3h4l4 2h3l2 2l2 -2l4 1l1 2l3 1l-1 2l2 1l4 -3l4 2l1 2l3 -3l1 5l5 -5l3 3l1 -2l5 3l2 2l1 -2l6 -3l2 1l5 -2l1 1h4l1 -2l5 3l3 2l6 3l3 2l3 -1l3 1v12v23l5 5v4l2 2l3 7l1 4v4l-4 6l1 3v9l-4 5l2 3l-6 1l-13 6l5 -4l-5 1l2 -5h-3l-1 2h-2l-1 3l3 1v4l-4 4l-1 1l7 -6l1 1l-6 4l-7 7l-18 9l-3 3l-4 2l-5 4l-5 7l-3 7l-2 4v8l3 13l1 5l-2 -10l-2 -6v-7l2 -9l3 -6l5 -8l6 -4l3 -1v-1l-5 2l-2 -2v4l-3 2l-2 -1l-3 2h3l-3 6l-1 -1h-4l1 3l3 1l-4 8l-2 1v-2l-2 3h4l-1 10l1 7l3 5l-1 4l3 1v2l-4 1v2l-3 -1l-3 -4h-3h-7l-2 -1l-5 -3l-4 -1l-3 -3l-6 -1l-3 -10l-3 -4v-3l-1 -3l1 -5l-3 -3l-2 -1l-3 -3l-1 -4l-3 -4l-4 -3l-2 -7l-4 -8l-1 -4l-2 -3l-4 -3l-1 -3l-4 -2l-1 -2l-3 -3h-4l-3 -1h-5l-5 -2l-1 2l-2 -1l-4 1l-2 5l-3 7h-2l-2 5l-4 -1l-2 -1l-3 -3l-3 -1l-2 -2l-3 -1l-3 -2l-2 -3h-1l-4 -4l-2 -6v-6l-3 -5v-4l-2 -3l-7 -5l-4 -5l-3 -2l-3 -5l-4 -3l-3 -6l-3 -2l-2 -3l1 -2l23 2l21 2l24 2l2 -23l2 -22l4 -57z","Texas",434,469],
UT:["M198 201l2 1l47 8l-3 22l9 2l24 3l-6 43l-3 19v3l-3 26l-26 -4l-36 -6l-27 -5v-2z","Utah",227,269],
VA:["M855 284l1 -1l7 -3l-2 4l-1 1l-2 3l1 4l-2 9l-2 3l-2 -3v-9l3 -6zM747 313v2l3 4l3 1h2l3 -4l3 2l6 -3v-2l2 1l4 -4l1 2l3 -3l1 -3l-2 -1l1 -3l3 -5v-3l4 -7v-4l3 2l3 1l2 -3l2 -8l3 2l6 -11v-7l10 6l1 -5h3l2 2l-1 2l4 1l4 2l2 3l-1 4l-2 1v4l1 2l4 -2l2 4h6l2 2l6 2l-1 2l1 4l-4 1l-2 -3l-2 -1l4 5h4l2 4v1l-3 -1l1 4l3 2l-2 4l-4 -3l-1 -2l-2 1l6 5h3v-2h6l4 8l-19 4l-28 6l-32 5l-24 3l-29 4l-7 1l9 -5l1 -2l3 -2v-2l2 -2v-1l6 -5z","Virginia",809,311],
VT:["M858 118l16 -4l12 -3l1 2l-1 4l2 2v3l-3 4l-3 2l1 5l-2 13l1 12v5l2 2l-13 3l-1 -2l-3 -16l-1 -2l-2 1v-4l-3 -5l1 -6l-1 -5l-2 -2v-5z","Vermont"],
WA:["M95 31l4 -3v3l-3 1l1 1v4l1 -2l2 2l-2 2l-2 -3l1 -3zM91 21l5 -1l2 2l-2 5l-4 -3zM184 36l-6 23l-7 33l-1 2l1 4v4l-32 -7l-3 1l-5 -1h-8l-5 1l-4 -1l-2 -1l-9 1v-2l-5 -2l-4 -1l-8 1l-7 -4l1 -7v-3l-3 -3h-3l-3 -4l-2 -1h-3l-2 -4l2 -5v3h2l-1 -3l3 -1l-4 -2l1 -2l4 -1l-4 -3v-6v-2l1 -9l-2 -4v-7l2 -2l2 -1l7 7l4 1l6 3h2l1 2h5l-1 2l1 3l-3 3l-4 3l4 -1v-1l5 -3l-2 7l-1 1l-2 5h4v-5l2 -5l4 -4l-1 -5l-3 1l1 -2l2 -1l-3 -6l3 2l1 -6l-3 -2v-4l1 -1l15 5l25 6l26 7z","Washington",124,59],
WI:["M579 113h4l-2 2zM560 121h3l5 -1l8 -5l4 1l-2 3l-1 4l3 -3l5 3l3 1l2 4l17 3l5 3l11 1l-1 2l3 1l3 2v4l-1 3l4 1l-1 3l2 2v3l-3 1l-2 5l-1 4h2l3 -3l2 -4l3 -2l2 -6l4 -3l-1 4l-2 3l-4 10v5v4l-2 2l-1 5l1 4l-1 3l-1 7l1 6l2 5v6l-16 2l-31 1l-1 -3l-6 -1l-2 -4l-1 -5l2 -3l-2 -3l-1 -3l-1 -2l1 -4l-4 -5h-2l-5 -4l-1 -3l-5 -2l-2 -3h-3l-5 -4l1 -4v-8l1 -4l-2 -3h-1v-3l3 -5l5 -2v-1v-14l3 -2z","Wisconsin",595,167],
WV:["M733 295l5 -2v-3h2l-1 -5l2 -5l3 3l2 -2l-1 -3l1 -5h2l2 -4l2 2l2 -2l4 -6l2 -7l-1 -4l2 -5l-1 -4l-1 -2l2 -2l4 21l17 -3l2 12l3 -3l3 -5l2 1l2 -5l3 2l3 -1l2 -3l3 -2l3 2l3 -1v2l3 4l-1 5l-10 -6v7l-6 11l-3 -2l-2 8l-2 3l-3 -1l-3 -2v4l-4 7v3l-3 5l-1 3l2 1l-1 3l-3 3l-1 -2l-4 4l-2 -1v2l-6 3l-3 -2l-3 4h-2l-3 -1l-3 -4v-2h-3l-3 -2l-1 -2l-4 -3l-2 -4v-4z","West Virginia",763,291],
WY:["M369 156l-4 45l-4 46l-28 -3l-32 -4l-24 -3l-24 -3l-9 -2l3 -22l9 -56l2 -12l5 1l35 5l41 5z","Wyoming",308,195]
};
  var MAP_W = 975, MAP_H = 610, OUTLINE = "8C8FA3", WHITE = "FFFFFF", TILE = "EEEEF5", NO_RATE = "F5F5FA";
  var COUNT_FILL = ["D6E6F3", "9CC3E3", "4F95CC", "00539E"], DARK = { "4F95CC": 1, "00539E": 1, "00857C": 1, "EB008C": 1 };
  // the rate map's colours: the Snapshot view's
  var RATE_BINS = [
    { fill: "00857C", label: "Down 5.0% or more", has: function (v) { return v <= -5; } },
    { fill: "8CCBC6", label: "Down less than 5.0%", has: function (v) { return v < 0; } },
    { fill: "C9CBD6", label: "No change", has: function (v) { return v === 0; } },
    { fill: "F5A3D0", label: "Up less than 5.0%", has: function (v) { return v < 5; } },
    { fill: "EB008C", label: "Up 5.0% or more", has: function () { return true; } }];
  var SHAPES = null;
  // an SVG path of M, L, H and V commands (either case) and Z, as closed polygons of [x, y]
  function polysOf(d) {
    var out = [], cur = null, x = 0, y = 0, cmd = "", toks = String(d).match(/[MLHVZmlhvz]|-?\d*\.?\d+/g) || [], i = 0;
    var take = function () { return +toks[i++]; };
    var end = function () { if (cur && cur.length >= 3) out.push(cur); cur = null; };
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) { cmd = toks[i++]; if (cmd === "z" || cmd === "Z") end(); continue; }
      if (cmd === "M" || cmd === "m") { end(); if (cmd === "M") { x = take(); y = take(); } else { x += take(); y += take(); } cur = [[x, y]]; cmd = cmd === "M" ? "L" : "l"; continue; }
      if (!cur) cur = [[x, y]];
      if (cmd === "L") { x = take(); y = take(); } else if (cmd === "l") { x += take(); y += take(); }
      else if (cmd === "H") x = take(); else if (cmd === "h") x += take();
      else if (cmd === "V") y = take(); else if (cmd === "v") y += take();
      else { i++; continue; }
      cur.push([x, y]);
    }
    end();
    return out;
  }
  function shapes() {
    if (SHAPES) return SHAPES;
    SHAPES = {};
    Object.keys(US_MAP).forEach(function (c) {
      // points outside the 975 x 610 drawing (Alaska's far islands) are drawn at its edge, as the page's map clips them
      var e = US_MAP[c], ps = polysOf(e[0]).map(function (p) { return p.map(function (pt) { return [Math.max(0, Math.min(MAP_W, pt[0])), Math.max(0, Math.min(MAP_H, pt[1]))]; }); }), xs = [], ys = [];
      ps.forEach(function (p) { p.forEach(function (pt) { xs.push(pt[0]); ys.push(pt[1]); }); });
      SHAPES[c] = { polys: ps, name: e[1], lx: num(e[2]) ? e[2] : null, ly: num(e[3]) ? e[3] : null,
        box: { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) } };
    });
    return SHAPES;
  }
  function onMap(code) { return !!US_MAP[code]; }
  function stateName(code) { return US_MAP[code] ? US_MAP[code][1] : flat(code) || "n/d"; }
  // where a state's callout points: its label, or the middle of its outline
  function anchorOf(code) { var s = shapes()[code]; return s.lx !== null ? [s.lx, s.ly, true] : [(s.box.x0 + s.box.x1) / 2, (s.box.y0 + s.box.y1) / 2, false]; }
  // the map as one group: every state an outline filled by look(code) -> {fill, none, line}, then the state codes
  // where the page's map puts them. States S&P returned nothing for are drawn last, so their dashed outline shows.
  function mapGroup(x, y, w, look, name) {
    var k = w / MAP_W, S = shapes(), parts = [], last = [], labels = [];
    Object.keys(US_MAP).forEach(function (c) {
      var sh = S[c], lk = look(c), b = sh.box;
      var it = { type: "freeform", name: "State " + c, x: x + b.x0 * k, y: y + b.y0 * k, w: Math.max(0.01, (b.x1 - b.x0) * k), h: Math.max(0.01, (b.y1 - b.y0) * k),
        pathW: b.x1 - b.x0, pathH: b.y1 - b.y0, fill: lk.fill,
        paths: sh.polys.map(function (p) { return p.map(function (pt) { return [pt[0] - b.x0, pt[1] - b.y0]; }); }),
        line: lk.none ? { color: OUTLINE, width: 0.75, dash: true } : lk.line || { color: WHITE, width: 0.75 } };
      (lk.none ? last : parts).push(it);
      if (sh.lx !== null) labels.push({ type: "text", name: "Label " + c, x: x + sh.lx * k - 0.22, y: y + sh.ly * k - 0.1, w: 0.44, h: 0.2, margin: 0, anchor: "ctr", autofit: false,
        paras: [{ align: "ctr", runs: [{ text: c, size: 10, bold: true, color: DARK[lk.fill] ? WHITE : NAVY }] }] });
    });
    return { type: "group", name: name, items: parts.concat(last, labels) };
  }
  // the key under a map: a swatch and a label for each colour, perRow to a row
  function mapKey(x, y, w, keys, perRow) {
    var out = [], cw = w / perRow;
    keys.forEach(function (it, i) {
      var cx = x + (i % perRow) * cw, cy = y + Math.floor(i / perRow) * 0.27;
      out.push({ type: "box", name: "Key " + it.label, x: cx, y: cy + 0.05, w: 0.24, h: 0.16, fill: it.fill, paras: [{ runs: [] }],
        line: { color: it.dash || it.fill === WHITE || it.fill === NO_RATE ? OUTLINE : it.fill, width: 0.75, dash: !!it.dash } });
      out.push({ type: "text", name: "Key text " + it.label, x: cx + 0.3, y: cy, w: cw - 0.34, h: 0.26, margin: 0, anchor: "ctr", autofit: false,
        paras: [{ runs: [{ text: fitText(it.label, 10, cw - 0.36, false), size: 10, color: NAVY }] }] });
    });
    return { type: "group", name: "Map key", items: out };
  }
  // up to four keys on one row, more on two
  function keyPerRow(n) { return Math.max(1, n <= 4 ? n : Math.ceil(n / 2)); }
  // callouts for a few states: a magenta dot on the state, a thin line to a box in the column to the right of the map,
  // the boxes in the order of the states from top to bottom
  function callouts(mx, my, mw, list, cx, cw, top, bottom) {
    var k = mw / MAP_W, items = [], bh = 0.58, gap = 0.12;
    var pts = list.filter(function (c) { return onMap(c.code); }).map(function (c) { var a = anchorOf(c.code); return Object.assign({ ax: mx + a[0] * k + (a[2] ? 0.2 : 0), ay: my + a[1] * k }, c); })
      .sort(function (a, b) { return a.ay - b.ay; });
    if (!pts.length) return [];
    var total = pts.length * bh + (pts.length - 1) * gap, mid = pts.reduce(function (s, c) { return s + c.ay; }, 0) / pts.length;
    var y0 = Math.max(top, Math.min(bottom - total, mid - total / 2));
    pts.forEach(function (c, i) {
      var by = y0 + i * (bh + gap);
      items.push({ type: "line", name: "Leader " + c.code, x1: c.ax, y1: c.ay, x2: cx, y2: by + bh / 2, color: "666666", width: 0.5 });
      items.push({ type: "box", shape: "ellipse", name: "Dot " + c.code, x: c.ax - 0.045, y: c.ay - 0.045, w: 0.09, h: 0.09, fill: MAG, line: { color: WHITE, width: 0.5 }, paras: [{ runs: [] }] });
      items.push({ type: "box", name: "Callout " + c.code, x: cx, y: by, w: cw, h: bh, fill: TILE, margins: [0.08, 0.06, 0.03, 0.03], anchor: "ctr",
        paras: [{ after: 1, runs: [{ text: fitText(c.title, 12, cw - 0.16, true), size: 12, bold: true, color: c.color || NAVY }] }, { runs: [{ text: fitText(c.text, 10, cw - 0.16, false), size: 10, color: NAVY }] }] });
    });
    return [{ type: "group", name: "Callouts", items: items }];
  }
  // filings-count classes: one a count up to 4, else four equal steps (as on the Snapshot view)
  function countBins(max) {
    if (!(max > 0)) return [];
    var bins = [];
    if (max <= 4) for (var i = 1; i <= max; i++) bins.push({ lo: i, hi: i });
    else { var st = Math.ceil(max / 4); for (var j = 0; j < 4; j++) if (j * st + 1 <= max) bins.push({ lo: j * st + 1, hi: Math.min(max, (j + 1) * st) }); }
    return bins.map(function (b, i) { return { lo: b.lo, hi: b.hi, fill: COUNT_FILL[COUNT_FILL.length - bins.length + i], label: b.lo === b.hi ? cnt(b.lo) + (b.lo === 1 ? " filing" : " filings") : cnt(b.lo) + " to " + cnt(b.hi) + " filings" }; });
  }
  var MAP_X = L, MAP_Y = TOP + HDR + 0.05, MAP_WIDTH = 5.75, MAP_HEIGHT = MAP_WIDTH * MAP_H / MAP_W, CALL_X = MAP_X + MAP_WIDTH + 0.15, CALL_W = L + LW - CALL_X;
  // the right-hand column of a map slide: a small table, then the takeaways under it
  function mapSide(title, head, rows, widths, aligns, pts) {
    var items = [header(title, LX2, TOP, RW)], n = Math.min(rows.length, 8);
    items.push({ type: "table", x: LX2, y: TOP + HDR, colW: widths, rowH: 0.25, size: 11, name: "Table " + title, aligns: aligns, rows: [head].concat(rows.slice(0, n)) });
    var y2 = TOP + HDR + (n + 1) * 0.25 + 0.3;
    if (BOTTOM - y2 >= 1.2) items = items.concat(takeaways(pts, LX2, y2, RW, BOTTOM - y2));
    return items;
  }

  function fpStates(f, t) {
    var rows = fpRows(f, "states"), by = {}, items = [], star = false;
    rows.forEach(function (r) { by[r.state] = r; });
    var bins = countBins(Math.max.apply(null, [0].concat(rows.map(function (r) { return num(r.n) ? r.n : 0; }))));
    var binOf = function (n) { return bins.filter(function (b) { return n >= b.lo && n <= b.hi; })[0] || bins[bins.length - 1]; };
    items.push(header("Number of filings by state (not premium or exposure)", L, TOP, LW));
    items.push(mapGroup(MAP_X, MAP_Y, MAP_WIDTH, function (c) { var r = by[c]; return r && r.n > 0 ? { fill: binOf(r.n).fill } : { fill: WHITE, none: true }; }, "Map of filings by state"));
    items = items.concat(callouts(MAP_X, MAP_Y, MAP_WIDTH, rows.filter(function (r) { return onMap(r.state); }).slice(0, 4).map(function (r, i) {
      return { code: r.state, title: stateName(r.state), text: cnt(r.n) + (r.n === 1 ? " filing, " : " filings, ") + cnt(r.rate) + " rate", color: i ? NAVY : MAG };
    }), CALL_X, CALL_W, MAP_Y, MAP_Y + MAP_HEIGHT));
    var keys = bins.map(function (b) { return { fill: b.fill, label: b.label }; }).concat([{ fill: WHITE, dash: true, label: "Nothing returned" }]);
    items.push(mapKey(L, MAP_Y + MAP_HEIGHT + 0.15, LW, keys, keyPerRow(keys.length)));
    var tr = rows.map(function (r) {
      var l = r.latest; if (l && !l.approved) star = true;
      return [r.state, cnt(r.n), cnt(r.rate), l ? pctCell(l.rate) + (l.approved ? "" : "*") : "n/d"];
    });
    items = items.concat(mapSide("Most filings" + (rows.length > 8 ? " (8 of " + rows.length + ")" : ""), ["State", "Filings", "Rate filings", "Latest rate (%)"], tr, [0.7, 0.9, 1.15, 1.63], ["l", "r", "r", "r"], pointsOf(t, "states")));
    var off = rows.filter(function (r) { return !onMap(r.state); }).length;
    items.push(fpSource(f, t, [["Counts of filings, not premium or exposure.", ""],
      star ? ["* Not approved: the figure may be the change asked for. Rate impacts are S&P's overall figure, not weighted by premium.", "* Not approved: may be the change asked for. Rate impacts unweighted.", "* Not approved: may be as asked."]
        : ["Latest rate: S&P's overall figure for the newest filing with one, not weighted by premium.", "Latest rate: overall, not premium-weighted."],
      f.states && f.states.noState ? cnt(f.states.noState) + " with no state left out." : "", off ? cnt(off) + " not on the map (territories)." : ""]));
    return content(t, "states", "Where it files", items);
  }

  function fpRateMap(f, t) {
    var rows = fpRows(f, "states"), by = {}, items = [];
    rows.forEach(function (r) { by[r.state] = r; });
    var used = {};
    items.push(header("Latest approved overall rate change by state", L, TOP, LW));
    items.push(mapGroup(MAP_X, MAP_Y, MAP_WIDTH, function (c) {
      var r = by[c];
      if (!r || !(r.n > 0)) { used.none = true; return { fill: WHITE, none: true }; }
      if (!r.approved || !num(r.approved.rate)) { used.nrate = true; return { fill: NO_RATE, line: { color: OUTLINE, width: 0.75 } }; }
      var b = RATE_BINS.filter(function (x) { return x.has(r.approved.rate); })[0]; used[b.fill] = true; return { fill: b.fill };
    }, "Map of the latest approved rate change by state"));
    var ap = rows.filter(function (r) { return r.approved && num(r.approved.rate); }).sort(function (a, b) { return Math.abs(b.approved.rate) - Math.abs(a.approved.rate) || (b.approved.date || "").localeCompare(a.approved.date || ""); });
    items = items.concat(callouts(MAP_X, MAP_Y, MAP_WIDTH, ap.filter(function (r) { return onMap(r.state); }).slice(0, 4).map(function (r) {
      return { code: r.state, title: stateName(r.state), text: pct(r.approved.rate) + ", " + fpDate(f, r.approved.date), color: r.approved.rate > 0 ? MAG : r.approved.rate < 0 ? TEAL : NAVY };
    }), CALL_X, CALL_W, MAP_Y, MAP_Y + MAP_HEIGHT));
    var keys = RATE_BINS.filter(function (b) { return used[b.fill]; }).map(function (b) { return { fill: b.fill, label: b.label }; });
    if (used.nrate) keys.push({ fill: NO_RATE, label: "No approved rate" });
    if (used.none) keys.push({ fill: WHITE, dash: true, label: "Nothing returned" });
    items.push(mapKey(L, MAP_Y + MAP_HEIGHT + 0.15, LW, keys, keyPerRow(keys.length)));
    var tr = ap.map(function (r) { return [r.state, pctCell(r.approved.rate), fpDate(f, r.approved.date), cellText(r.approved.toi, 1.7)]; });
    items = items.concat(mapSide("Largest latest changes" + (ap.length > 8 ? " (8 of " + ap.length + ")" : ""), ["State", "Change (%)", "Published", "Type of insurance"], tr, [0.6, 1.0, 1.08, 1.7], ["l", "r", "r", "l"], pointsOf(t, "ratemap")));
    items.push(fpSource(f, t, [["Each state's newest approved filing with an overall rate impact, any type of insurance; S&P's overall figure, not weighted by premium.", "Newest approved overall impact per state, not weighted by premium.", "Newest approved impact, unweighted."]]));
    return content(t, "ratemap", "Latest approved rate change by state", items);
  }

  // ---------- the red, amber and green screen ----------
  var LEVEL = { red: { word: "Red", fill: MAG }, amber: { word: "Amber", fill: "C46A1B" }, green: { word: "Green", fill: TEAL } };
  // text cut to two lines of a cell
  function twoLines(s, pt, w) { s = flat(s) || "n/d"; var inner = w - 0.26; return lineCount([{ text: s }], pt, inner) <= 2 ? s : fitText(s, pt, inner * 2 - 0.5, false); }
  function fpSignals(f, t) {
    var list = arr(f.signals).filter(function (s) { return s && LEVEL[s.level]; }).slice(0, 10), items = [];
    var n = { red: 0, amber: 0, green: 0 }; list.forEach(function (s) { n[s.level]++; });
    items.push(header("Screen of the filings: " + cnt(n.red) + " red, " + cnt(n.amber) + " amber, " + cnt(n.green) + " green", L, TOP, W));
    var cw = [2.6, 0.95, W - 3.55], rowH = [0.3];
    var rows = list.map(function (s) {
      rowH.push(lineCount([{ text: twoLines(s.evidence, 11, cw[2]) }], 11, cw[2] - 0.26) > 1 || lineCount([{ text: flat(s.title), bold: true }], 11, cw[0] - 0.26) > 1 ? 0.46 : 0.3);
      return [{ text: cellText(s.title, cw[0], true), bold: true }, { text: LEVEL[s.level].word, bold: true, color: "FFFFFF", fill: LEVEL[s.level].fill }, twoLines(s.evidence, 11, cw[2])];
    });
    items.push({ type: "table", x: L, y: TOP + HDR, colW: cw, rowH: rowH, size: 11, name: "Table signals", aligns: ["l", "ctr", "l"], rows: [["Signal", "Rating", "Evidence in S&P's filings"]].concat(rows) });
    var y2 = TOP + HDR + rowH.reduce(function (a, b) { return a + b; }, 0) + 0.25;
    if (BOTTOM - y2 >= 0.75) items.push({ type: "box", name: "How to read it", x: L, y: y2, w: W, h: Math.min(0.75, BOTTOM - y2), fill: TILE, margins: [0.15, 0.15, 0.08, 0.08], anchor: "ctr",
      paras: [{ runs: [{ text: "How to read it: ", size: 12, bold: true, color: NAVY }, { text: "a screen of S&P's filing data against the app's own thresholds (inferred). A red or amber signal is a question to ask, not a finding; green means nothing in these filings tripped the test, not that all is well.", size: 12, color: NAVY }] }] });
    items.push(fpSource(f, t, [["Thresholds: rate changes of 10% or more (red at 20%, or 3 or more); 2 or more disapprovals; 3 or more withdrawals; 60 and 120 days; 50% and 75% in one state; 15% and 30% compounded.",
      "Thresholds are the app's own (inferred); see the README.", "Thresholds: the app's own."]]));
    var title = n.red || n.amber ? (n.red ? cnt(n.red) + " red" + (n.amber ? " and " + cnt(n.amber) + " amber" : "") : cnt(n.amber) + " amber") + " signals in the filings" : "No red or amber signals in the filings";
    return content(t, "signals", title, items);
  }

  // ---------- approved rate changes compounded ----------
  var LINE_COLORS = [NAVY, MAG, BLUE, TEAL];
  function comboName(r) { return (flat(r.state) || "n/d") + " " + (flat(r.toi) || "type n/d"); }
  function fpHistory(f, t) {
    var H = f.history || {}, rows = fpRows(f, "history"), yrs = arr(H.years).map(String);
    var lines = rows.slice(0, 4), big = rows.slice().sort(function (a, b) { return Math.abs(b.total) - Math.abs(a.total); }).slice(0, 8);
    var lineChart = chartBlock("Compounded since the period began, by year end (%)", { kind: "line", categories: yrs, legend: "top", labels: false, catSize: 10, catLabels: "low",
      valueAxis: { format: "0;(0)" }, name: "Chart compounded by year",
      series: lines.map(function (r, i) { return ser(fitText(comboName(r), 10, 2.4, false), yrs.map(function (_, yi) { var v = arr(r.byYear)[yi]; return num(v) ? v : null; }), LINE_COLORS[i], { labelLast: true }); }) });
    var maxI = 0; big.forEach(function (r, i) { if (Math.abs(r.total) > Math.abs(big[maxI].total)) maxI = i; });
    var pc = {}; big.forEach(function (r, i) { if (r.total < 0) pc[i] = TEAL; }); pc[maxI] = MAG;
    var barChart = chartBlock("Compounded to date, largest " + big.length + (rows.length > big.length ? " of " + cnt(H.total) : "") + " (%)", { kind: "bar", legend: "none", gap: 50, catSize: 10,
      categories: big.map(function (r) { return fitText(comboName(r), 10, 2.1, false); }), series: [ser("Compounded (%)", big.map(function (r) { return r.total; }), NAVY, { pointColors: pc })],
      labels: { format: "0.0;(0.0);0.0" }, name: "Chart compounded to date" });
    var table = function (x, y, w, h) {
      var max = Math.max(1, Math.floor((h - HDR) / 0.25) - 1), shown = rows.slice(0, max);
      var tr = shown.map(function (r) { return [flat(r.state) || "n/d", flat(r.toi) || "n/d", cnt(r.n), fpDate(f, r.last), pctCell(r.total)]; });
      return [header("Approved changes by state and type" + (num(H.total) && H.total > shown.length ? " (" + shown.length + " of " + cnt(H.total) + ")" : ""), x, y, w),
        fpTable("Table compounded", x, y + HDR, w, ["State", "Type of insurance", "Approved", "Latest", "Compounded (%)"], tr, [0.6, 1.9, 1.0, 1.15, 1.26], ["l", "l", "r", "r", "r"], [0, 2, 4], { fit: [1] })];
    };
    var items = quads([lineChart, barChart, table], pointsOf(t, "history"));
    items.push(fpSource(f, t, [["Compounded: approved overall rate impacts multiplied together in date order since the period began (derived); not weighted by premium.", "Compounded approved impacts (derived), not weighted by premium.", "Derived; unweighted."]]));
    return content(t, "history", "Approved rate changes compounded", items);
  }

  // ---------- types of insurance and outcomes ----------
  var OUTCOME_LABEL = { approved: "Approved", pending: "In progress", disapproved: "Disapproved", withdrawn: "Withdrawn", other: "Other or n/d" };
  function fpLines(f, t) {
    var Ln = f.lines || {}, rows = fpRows(f, "lines"), bars = rows.slice(0, 8), outs = arr(f.outcomes).filter(function (o) { return o && OUTCOME_LABEL[o.outcome]; });
    var parts = [["Rate filings", "rate", NAVY], ["Form and rule filings", "formRule", MAG], ["Other filings", "other", BLUE]].filter(function (p) { return bars.some(function (r) { return r[p[1]] > 0; }); });
    var chart = chartBlock("Filings by type of insurance" + (rows.length > bars.length ? " (top " + bars.length + " of " + cnt(Ln.total) + ")" : ""), { kind: "stackedBar", legend: "top", gap: 50, overlap: 100, catSize: 10,
      categories: bars.map(function (r) { return fitText(flat(r.toi) || "Type n/d", 10, 2.1, false); }), series: parts.map(function (p) { return ser(p[0], bars.map(function (r) { return num(r[p[1]]) ? r[p[1]] : 0; }), p[2]); }),
      labels: { format: "0;;;", position: "ctr", color: "FFFFFF", size: 10 }, name: "Chart types of insurance" });
    var range = function (o) { return !num(o.lo) ? "n/d" : o.lo === o.hi ? pctCell(o.lo) : pctCell(o.lo) + " to " + pctCell(o.hi); };
    var outcomes = function (x, y, w) {
      var tr = outs.map(function (o) { return [OUTCOME_LABEL[o.outcome], cnt(o.n), cnt(o.withImpact), range(o) + (o.outcome !== "approved" && num(o.lo) ? "*" : "")]; });
      return [header("Rate filings by outcome", x, y, w), fpTable("Table outcomes", x, y + HDR, w, ["Outcome", "Rate filings", "With a rate impact", "Range (%)"], tr, [1.5, 1.2, 1.6, 1.6], ["l", "r", "r", "r"], [0, 1, 2, 3])];
    };
    var table = function (x, y, w, h) {
      var max = Math.max(1, Math.floor((h - HDR) / 0.25) - 1), shown = rows.slice(0, max);
      var tr = shown.map(function (r) { return [flat(r.toi) || "n/d", cnt(r.n), cnt(r.states), cnt(r.rate), cnt(r.approved), range(r)]; });
      return [header("By type of insurance" + (num(Ln.total) && Ln.total > shown.length ? " (" + shown.length + " of " + cnt(Ln.total) + ")" : ""), x, y, w),
        fpTable("Table types of insurance", x, y + HDR, w, ["Type of insurance", "Filings", "States", "Rate", "Approved", "Range (%)"], tr, [2.0, 0.75, 0.7, 0.65, 0.95, 1.2], ["l", "r", "r", "r", "r", "r"], [0, 1, 2, 3, 4, 5], { fit: [0] })];
    };
    var blocks = outs.length ? [chart, outcomes, table] : [chart, table];
    var items = quads(blocks, pointsOf(t, "lines"));
    items.push(fpSource(f, t, [["Rate filings: S&P's rate types or any filing with a rate impact. * Not approved: may be the change asked for.", "Rate filings: rate types or with an impact. * May be as asked.", "* May be as asked."],
      ["Rate impacts are S&P's overall figure for each filing, not weighted by premium.", "Rate impacts unweighted.", "Unweighted."]]));
    return content(t, "lines", "Types of insurance and outcomes", items);
  }

  // ---------- rate filings read by Claude (saved summaries) ----------
  function fpRead(f, t, extra) {
    var list = readRows(extra), items = [];
    var lcm = function (v) { return num(v) ? v.toFixed(3) : "n/d"; };
    var name = function (d) { return [flat(d.state), flat(d.typeOfInsurance), d.published ? fpDate(f, d.published) : ""].filter(Boolean).join(", "); };
    var tr = list.map(function (d) {
      var r = d.rate || {};
      return [cellText(name(d), 2.75), cellText(d.status, 1.3), pctCell(r.overallPct), pctCell(r.requestedPct), pctCell(r.approvedPct), pctCell(r.indicatedPct), lcm(r.lcm), pctCell(r.trendPct), pctCell(r.expensePct), millions(r.premium), num(r.page) ? cnt(r.page) : "n/d"];
    });
    items.push(header("Rate figures from the filings' own documents", L, TOP, W));
    var tbl = fpTable("Table rate filings read", L, TOP + HDR, W, ["Filing", "Status", "Overall (%)", "Requested (%)", "Approved (%)", "Indicated (%)", "LCM", "Loss trend (%)", "Expense (%)", "Premium ($M)", "Page"], tr,
      [2.75, 1.3, 0.95, 1.1, 1.05, 1.05, 0.7, 1.05, 0.95, 1.05, 0.55], ["l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "r"], [0, 1, 10]);
    // the header row holds two lines where a heading wraps
    var head = tbl.rows[0].some(function (h, j) { return textWidth(h, 11, true) > tbl.colW[j] - 0.2; }) ? 0.42 : 0.25;
    tbl.rowH = [head].concat(tr.map(function () { return 0.25; }));
    items.push(tbl);
    var y2 = TOP + HDR + head + tr.length * 0.25 + 0.3, h2 = BOTTOM - y2;
    // requested, approved and indicated side by side, for the filings that give two of them or more
    var kinds = [["Requested", "requestedPct", NAVY], ["Approved", "approvedPct", MAG], ["Indicated", "indicatedPct", BLUE]];
    var both = list.filter(function (d) { var r = d.rate || {}; return kinds.filter(function (k) { return num(r[k[1]]); }).length >= 2; });
    var used = kinds.filter(function (k) { return both.some(function (d) { return num(d.rate[k[1]]); }); });
    var pts = list.map(function (d) {
      var read = arr(d.read).map(function (p) { return p && num(p.from) && num(p.to) ? (p.from === p.to ? String(p.from) : p.from + " to " + p.to) : ""; }).filter(Boolean).join(", ");
      return { lead: (flat(d.state) || "n/d") + " " + (flat(d.typeOfInsurance) || ""), text: (flat(d.filingNo) || "Filing number n/d") + ": pages " + (read || "n/d") + (num(d.pages) ? " of " + cnt(d.pages) : "") + " read; summary made " + longDate(d.madeAt) + "." };
    });
    if (both.length && h2 >= 1.6) {
      items = items.concat(chartBlock("Requested, approved and indicated changes (%)", { kind: "column", categories: both.map(function (d) { var y = ymd(d.published); return fitText([flat(d.state), flat(d.typeOfInsurance), y ? String(y.y) : ""].filter(Boolean).join(" "), 10, 2.6, false); }), legend: "top", gap: 80, overlap: -10, catSize: 10, catLabels: "low",
        series: used.map(function (k) { return ser(k[0], both.map(function (d) { return num(d.rate[k[1]]) ? d.rate[k[1]] : null; }), k[2]); }), labels: { format: "0.0;(0.0);0.0", size: 10 }, name: "Chart requested and approved" })(L, y2, QW, h2));
      items = items.concat([header("What was read", QX2, y2, QW), bullets(pts, QX2, y2 + HDR, QW, h2 - HDR, "What was read")]);
    } else if (h2 >= 1.0) items = items.concat([header("What was read", L, y2, W), bullets(pts, L, y2 + HDR, W, h2 - HDR, "What was read")]);
    items.push(fpSource(f, t, [["Rate figures read by Claude from each filing's document and checked against the words it quoted; n/d where the filing doesn't give one. LCM: loss cost multiplier.", "Read by Claude from the filings and checked; LCM: loss cost multiplier.", "Read by Claude; checked."]]));
    var asked = list.filter(function (d) { return d.rate && num(d.rate.requestedPct) && num(d.rate.approvedPct); });
    return content(t, "read", asked.length ? cnt(asked.length) + (asked.length === 1 ? " rate filing" : " rate filings") + " read with requested and approved changes" : "Rate filings read by Claude", items);
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

  function fpSpec(facts, text, extra) {
    var f = facts || {}, t = text || {};
    var included = {}; fpPlan(f, extra).forEach(function (r) { included[r.id] = r.included; });
    var make = { summary: fpSummary, signals: fpSignals, states: fpStates, ratemap: fpRateMap, rates: fpRates, history: fpHistory, lines: fpLines, read: fpRead,
      years: fpYears, forms: fpForms, regulator: fpRegulator, questions: fpQuestions };
    var slides = [fpCover(f, t)];
    FP_SLIDES.slice(1).forEach(function (s) { if (included[s[0]] && make[s[0]]) slides.push(make[s[0]](f, t, extra)); });
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

  window.SNLProfile = { plan: plan, spec: spec, filingsPlan: fpPlan, filingsSpec: fpSpec, _usMap: US_MAP,
    format: { money: money, millions: millions, pct: pct, pctCell: pctCell, mult: mult, shortDate: shortDate, monthYear: monthYear, trimTitle: trimTitle } };
})();
