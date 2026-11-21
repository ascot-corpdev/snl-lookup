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
    ["cover", "Cover"], ["summary", "Executive summary"], ["premium", "Premium"], ["lines", "Lines and states"], ["underwriting", "Underwriting"],
    ["earnings", "Earnings"], ["balance", "Balance sheet"], ["capital", "Capital"], ["reserves", "Reserves"], ["accident", "Accident years"], ["reinsurance", "Reinsurance"],
    ["filings", "Recent rate and form filings"], ["questions", "Key diligence questions"]
  ];
  // the detailed profile's slides: planned only for facts that have the detail (facts saved before it existed open
  // with the nine slides they had)
  var DETAIL_SLIDES = ["lines", "earnings", "balance", "accident"];
  var BLUE2 = "0081C3", TEAL2 = "00857C", GREY2 = "A6A6BF";
  var LABELS = {
    dpw: "Direct premiums written", npw: "Net premiums written", gpw: "Gross premiums written", npe: "Net premiums earned",
    loss_ratio: "Loss ratio", loss_lae_ratio: "Loss and LAE ratio", expense_ratio: "Expense ratio", combined_ratio: "Combined ratio", net_income: "Net income",
    surplus: "Surplus", paid_in_capital: "Paid-in capital", total_assets: "Total assets", rbc_ratio: "RBC ratio",
    net_reserves: "Net loss and LAE reserves", pyd: "One-year reserve development", reins_recoverable: "Reinsurance recoverables",
    ceded_by_reinsurer: "Ceded premiums by reinsurer",
    uw_gain: "Net underwriting gain", net_inv_income: "Net investment income earned", realized_gains: "Net realized capital gains", cash_from_ops: "Net cash from operations",
    investment_yield: "Net yield on invested assets", cash_invested: "Cash and invested assets", premiums_receivable: "Premiums receivable", total_liabilities: "Total liabilities",
    npe_by_line: "Net premiums earned by line", loss_lae_ratio_by_line: "Loss and LAE ratio by line", dpe_by_state: "Direct premiums earned by state", loss_ratio_by_state: "Direct loss ratio by state",
    ay_loss_ratio: "Net loss and LAE ratio by accident year"
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
  // the detailed profile's part of the facts, or null for facts made before it existed
  function detailOf(f) { return f && f.detail && typeof f.detail === "object" && !Array.isArray(f.detail) ? f.detail : null; }
  var EARN = ["uw_gain", "net_inv_income", "realized_gains", "cash_from_ops", "investment_yield"];
  var BAL = ["cash_invested", "bonds", "stocks", "cash_short_term", "premiums_receivable", "total_liabilities", "unearned_premiums"];

  // ---------- plan: which slides, and why one is left out ----------
  function joinWords(list) { return list.length < 2 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1]; }
  function lower(s) { return /^[A-Z][a-z]/.test(s) && !/^(RBC|LAE|NAIC)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; }
  // "Net loss and LAE reserves aren't", "Surplus isn't"
  // (named apart from the filings profile's plural below, which would otherwise replace it in this scope)
  function pluralLabel(label) { var w = String(label).trim().split(/\s+/).pop().toLowerCase(); return /s$/.test(w) && !/(surplus|gross|loss|ss|us)$/.test(w); }
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
    if (notMapped.length) parts.push(cap(joinWords(notMapped.map(function (l, i) { return i ? lower(l) : l; }))) + (notMapped.length > 1 || pluralLabel(notMapped[0]) ? " aren't" : " isn't") + " mapped to Snowflake yet");
    var yl = yearsLabel(f);
    if (empty.length) parts.push("S&P returned nothing for " + lower(joinWords(empty.map(lower))) + (yl ? " for " + yl : ""));
    return parts.join("; ") + ".";
  }
  function plan(facts) {
    var f = facts || {};
    var anySeries = Object.keys(f.series || {}).some(function (k) { return any(S(f, k)); });
    var X = detailOf(f);
    var rows = SLIDES.filter(function (s) { return X || DETAIL_SLIDES.indexOf(s[0]) < 0; }).map(function (s) { return { id: s[0], label: s[1], included: true, reason: "" }; });
    var out = function (id, reason) { rows.forEach(function (r) { if (r.id === id) { r.included = false; r.reason = reason; } }); };
    if (X) {
      if (!(X.lines && arr(X.lines.items).length) && !(X.states && arr(X.states.items).length)) out("lines", whyMissing(f, ["npe_by_line", "loss_lae_ratio_by_line", "dpe_by_state", "loss_ratio_by_state"]));
      if (!EARN.some(function (k) { return any(S(f, k)); })) out("earnings", whyMissing(f, EARN));
      if (!BAL.some(function (k) { return any(S(f, k)); })) out("balance", whyMissing(f, ["cash_invested", "premiums_receivable", "total_liabilities"]));
      if (!(X.accidentYears && arr(X.accidentYears.rows).length)) out("accident", whyMissing(f, ["ay_loss_ratio"]));
    }
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
      cession: function () { var l = latest(f, D(f, "cession_pct")); return l && { v: pct(l.v), label: "Share of gross premium ceded, " + l.year + " (derived)", d: 1 }; },
      // the detailed profile
      rbcCalc: function () { var l = latest(f, D(f, "rbc_ratio_calc")); return l && { v: pct(l.v), label: "RBC ratio, " + l.year + " (derived)", d: 1 }; },
      uwg: function () { var l = latest(f, S(f, "uw_gain")); return l && { v: money(l.v), label: "Net underwriting gain, " + l.year, c: l.v < 0 ? MAG : NAVY }; },
      ci: function () { var l = latest(f, S(f, "cash_invested")); return l && { v: money(l.v), label: "Cash and invested assets, " + l.year }; }
    };
    var spare = ["npw", "gpw", "niLast", "assets", "growth", "cession", "top3", "line", "lev", "lr", "uwg", "ci"];
    var wants = [
      { first: ["dpw", "npw", "gpw"], none: "Direct premiums written" },
      { first: ["cr", "lr"], none: "Combined ratio" },
      { first: ["surplus", "assets"], none: "Surplus" },
      { first: ["rbc", "rbcCalc", "lev"], none: "RBC ratio" },
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
    var rows = [], asm = S(f, "assumed_pw"), cpw = S(f, "ceded_pw"), gpd = D(f, "gross_pw");
    if (any(dpw)) rows.push(["Direct premiums written", dpw, millions, null, true]);
    if (any(asm)) rows.push(["Assumed premiums written", asm, millions]);
    if (any(gpw)) rows.push(["Gross premiums written", gpw, millions]);
    else if (any(gpd)) rows.push(["Gross premiums written (derived)", gpd, millions]);
    if (any(cpw)) rows.push(["Ceded premiums written", cpw, millions]);
    if (any(npw)) rows.push(["Net premiums written", npw, millions]);
    if (any(npe)) rows.push(["Net premiums earned", npe, millions]);
    if (any(cession)) rows.push(["Ceded share (%, derived)", cession, pctCell]);
    if (growth && any(growth)) rows.push(["DPW growth (%, derived)", growth, pctCell, negative]);
    var blocks = [chartBlock("Premiums written ($M)", { kind: "column", categories: years(f), series: series, labels: { format: "#,##0.0;(#,##0.0)" }, gap: 60, overlap: -10, legend: "top" })];
    var mix = f.mix || {};
    if ((mix.lines && mix.lines.length) || (mix.states && mix.states.length)) blocks.push(function (x, y, w, h) { return mixTables(f, x, y, w, h); });
    blocks.push(tableBlock("Premium by year", f, rows));
    var items = quads(blocks, pointsOf(t, "premium"));
    items.push(source(f, { derived: any(cession) || !!growth || (!any(gpw) && any(gpd)) }));
    return content(t, "premium", "Premium, " + yearsLabel(f), items);
  }

  function underwritingSlide(f, t) {
    var lr = S(f, "loss_ratio"), ll = S(f, "loss_lae_ratio"), er = S(f, "expense_ratio"), cr = S(f, "combined_ratio"), ni = S(f, "net_income"), roae = D(f, "roae");
    // loss and LAE ratio plus expense ratio is the combined ratio, so it is the one stacked when there is one
    var base = any(ll) ? ll : lr, baseName = any(ll) ? "Loss and LAE ratio" : "Loss ratio";
    var chart;
    if (any(base) && any(er)) {
      var sums = base.map(function (v, i) { return (num(v) ? v : 0) + (num(er[i]) ? er[i] : 0); });
      var max = Math.max(120, Math.ceil(Math.max.apply(null, sums) / 20) * 20);
      chart = chartBlock(any(ll) ? "Combined ratio in its two parts (%)" : "Loss and expense ratios (%)", { kind: "stackedColumn", categories: years(f), legend: "top", gap: 60, overlap: 100,
        series: [ser(baseName, base, NAVY), ser("Expense ratio", er, MAG)], labels: { format: "0.0;(0.0);;", position: "ctr", color: "FFFFFF" },
        valueAxis: { min: 0, max: max, major: 20, format: "0" } });
    } else {
      var pc = {}; cr.forEach(function (v, i) { if (num(v) && v > 100) pc[i] = MAG; });
      chart = chartBlock("Combined ratio (%)", { kind: "column", categories: years(f), legend: "none", gap: 60,
        series: [ser("Combined ratio", cr, NAVY, { pointColors: pc })], labels: { format: "0.0" } });
    }
    var rows = [];
    if (any(lr)) rows.push(["Loss ratio (%)", lr, pctCell]);
    if (any(ll)) rows.push(["Loss and LAE ratio (%)", ll, pctCell]);
    if (any(er)) rows.push(["Expense ratio (%)", er, pctCell]);
    var cm = S(f, "commission_ratio"), roaeR = S(f, "roae");
    if (any(cm)) rows.push(["Commission ratio (%)", cm, pctCell]);
    if (any(cr)) rows.push(["Combined ratio (%)", cr, pctCell, adverseOver100, true]);
    if (any(ni)) rows.push(["Net income", ni, millions, negative]);
    if (any(roaeR)) rows.push(["ROAE (%)", roaeR, pctCell, negative]);
    else if (any(roae)) rows.push(["ROAE (%, derived)", roae, pctCell, negative]);
    var items = quads([chart, tableBlock("Results by year", f, rows)], pointsOf(t, "underwriting"));
    items.push(source(f, { derived: any(roae) && !any(roaeR) }));
    return content(t, "underwriting", "Underwriting results, " + yearsLabel(f), items);
  }

  function capitalSlide(f, t) {
    var sp = S(f, "surplus"), pic = S(f, "paid_in_capital"), ta = S(f, "total_assets"), rbc = S(f, "rbc_ratio");
    var def = D(f, "accumulated_deficit"), lev = D(f, "npw_to_surplus");
    var series = [];
    if (any(pic)) series.push(ser("Paid-in capital", pic.map(m1), PAIDIN));
    series.push(ser("Surplus", sp.map(m1), NAVY));
    // the detailed profile: surplus notes, unassigned funds, dividends and capital paid in, and RBC from its parts
    var notes = S(f, "surplus_notes"), unas = S(f, "unassigned_funds"), divs = S(f, "dividends_paid"), contrib = S(f, "capital_contributed"), flow = D(f, "net_capital_flow");
    var tac = S(f, "rbc_tac"), acl = S(f, "rbc_acl"), aclImp = D(f, "rbc_acl_implied"), rbcCalc = D(f, "rbc_ratio_calc"), spg = D(f, "surplus_yoy");
    var flows = [];
    if (any(divs)) flows.push(["Dividends to stockholders", divs, millions]);
    if (any(contrib)) flows.push(["Capital paid in", contrib, millions]);
    if (any(flow)) flows.push(["Paid in less dividends (derived)", flow, millions, negative]);
    if (any(tac)) flows.push(["Total adjusted capital", tac, millions]);
    if (any(acl)) flows.push(["Authorized control level", acl, millions]);
    else if (any(aclImp)) flows.push(["Control level, implied (derived)", aclImp, millions]);
    var rich = flows.length > 0 || any(notes) || any(unas) || any(rbcCalc);
    if (rich) { if (any(rbc)) flows.push(["RBC ratio (%)", rbc, pctCell, null, true]); else if (any(rbcCalc)) flows.push(["RBC ratio (%, derived)", rbcCalc, pctCell, null, true]); }
    var rows = [["Surplus", sp, millions, null, true]];
    if (any(pic)) rows.push(["Paid-in capital", pic, millions]);
    if (any(def)) rows.push(["Surplus less paid-in (derived)", def, millions, negative]);
    if (any(notes)) rows.push(["Surplus notes", notes, millions]);
    if (any(unas)) rows.push(["Unassigned funds", unas, millions, negative]);
    if (any(ta)) rows.push(["Total assets", ta, millions]);
    if (any(lev)) rows.push(["NPW to surplus (x, derived)", lev, mult]);
    if (rich && any(spg)) rows.push(["Surplus growth (%, derived)", spg, pctCell, negative]);
    if (!rich && any(rbc)) rows.push(["RBC ratio (%)", rbc, pctCell]);
    var blocks = [chartBlock(series.length > 1 ? "Paid-in capital and surplus ($M)" : "Surplus ($M)",
      { kind: "column", categories: years(f), series: series, legend: series.length > 1 ? "top" : "none", gap: 60, overlap: -10, labels: { format: "#,##0.0;(#,##0.0)" } }),
      tableBlock("Capital by year", f, rows.slice(0, 8))];
    if (rich && flows.length) blocks.push(tableBlock("Capital flows and risk-based capital", f, flows));
    var items = quads(blocks, pointsOf(t, "capital"));
    items.push(source(f, { derived: any(def) || any(lev) || (rich && (any(flow) || any(spg) || (!any(acl) && any(aclImp)) || (!any(rbc) && any(rbcCalc)))) }));
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
    var pyd2 = S(f, "pyd_two_year"), ppn = D(f, "pyd_to_npe");
    if (any(ppn)) rows.push(["PYD to NPE (%, derived)", ppn, pctCell, positive]);
    if (any(pyd2)) rows.push(["Two-year development", pyd2, millions, positive]);
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
    var X = detailOf(f), RC = X && X.recoverables && arr(X.recoverables.items).length ? X.recoverables : null, ty = TOP;   // ty: where the recoverables table may start
    if (re.length) {
      items.push(header("Ceded premiums by reinsurer, " + f.reinsurers.year + " ($M)", L, TOP, lw));
      var bh = RC ? Math.min(2.05, 0.3 + re.length * 0.25) : Math.min(BOTTOM - TOP - HDR, 0.5 + re.length * 0.55);
      items.push({ type: "chart", kind: "bar", x: L, y: TOP + HDR, w: lw, h: bh, legend: "none", gap: 50,
        categories: re.map(function (r) { return fitText(r.name, RC ? 10 : 11, 2.6, false); }),
        series: [ser("Ceded premiums ($M)", re.map(function (r) { return m1(r.ceded); }), NAVY)], labels: { format: "#,##0.0;(#,##0.0)", size: RC ? 10 : undefined }, catSize: RC ? 10 : 11, name: "Chart reinsurers" });
      ty = TOP + HDR + bh + 0.15;
    } else {
      var rows = [];
      if (any(S(f, "gpw"))) rows.push(["Gross premiums written", S(f, "gpw"), millions]);
      if (any(S(f, "ceded_pw"))) rows.push(["Ceded premiums written", S(f, "ceded_pw"), millions, null, true]);
      else if (any(D(f, "ceded_pw"))) rows.push(["Ceded premiums (derived)", D(f, "ceded_pw"), millions, null, true]);
      if (any(cess)) rows.push(["Ceded share (%, derived)", cess, pctCell]);
      if (any(S(f, "reins_recoverable"))) rows.push(["Reinsurance recoverables", S(f, "reins_recoverable"), millions]);
      if (any(rts)) rows.push(["Recoverables to surplus (%, derived)", rts, pctCell]);
      items = items.concat(tableBlock("Reinsurance by year", f, rows)(L, TOP, lw, RC ? Math.min(2.6, HDR + 0.27 * (rows.length + 1)) : 2.6));
      ty = TOP + (RC ? Math.min(2.6, HDR + 0.27 * (rows.length + 1)) : 2.6) + 0.15;
    }
    if (RC) items = items.concat(recoverablesTable(RC, L, ty, lw));
    var a = latest(f, cess), b = latest(f, rts), tw = (rw - 0.2) / 2, th = 1.3;
    items.push(tile(rx, TOP, tw, th, a ? pct(a.v) : "n/d", "Share of gross premium ceded" + (a ? ", " + a.year : "") + " (derived)"));
    items.push(tile(rx + tw + 0.2, TOP, tw, th, b ? pct(b.v) : "n/d", "Recoverables to surplus" + (b ? ", " + b.year : "") + " (derived)", b && b.v > 100 ? MAG : NAVY));
    var y2 = TOP + th + 0.3;
    if (RC && RC.tagged) {
      var us = RC.unauthorizedShare;
      items.push(tile(rx, y2, rw, 1.0, num(us) ? pct(us) : "n/d", "Recoverables owed by reinsurers not authorized, " + RC.year + " (derived)", num(us) && us >= 20 ? MAG : NAVY));
      y2 += 1.0 + 0.3;
    }
    items = items.concat(takeaways(pointsOf(t, "reinsurance"), rx, y2, rw, BOTTOM - y2));
    items.push(source(f, { derived: true, period: re.length ? yearsLabel(f) : "" }));
    return content(t, "reinsurance", "Reinsurance, " + yearsLabel(f), items);
  }

  // ---------- the detailed profile's slides ----------
  // recoverables by reinsurer as a table: amount, share, share of surplus and the tag (authorized or not) when given
  function recoverablesTable(RC, x, y, w) {
    var rowH = 0.25, tagged = !!RC.tagged;
    var num3 = [0.85, 0.85, 1.05], tagW = tagged ? 1.3 : 0, nameW = w - num3.reduce(function (a, b) { return a + b; }, 0) - tagW;
    var max = Math.max(1, Math.floor((BOTTOM - y - HDR - 0.05) / rowH) - 1), list = arr(RC.items).slice(0, max);
    var head = ["Reinsurer", "$M", "Share", "To surplus"].concat(tagged ? ["Status"] : []);
    var colW = [nameW].concat(num3).concat(tagged ? [tagW] : []);
    var rows = [head].concat(list.map(function (r) {
      var cells = [cellText(r.name, nameW), millions(r.recoverable), pctCell(r.share), pctCell(r.toSurplus)];
      if (tagged) cells.push(flat(r.name) === "Other" ? "" : cellText(r.tag || "Not given", tagW, false));
      return cells;
    }));
    return [header("Recoverables by reinsurer, " + RC.year + " ($M; shares, %)", x, y, w),
      { type: "table", x: x, y: y + HDR, colW: colW, rowH: rowH, size: 11, rows: rows, aligns: ["l", "r", "r", "r"].concat(tagged ? ["l"] : []), name: "Table recoverables" }];
  }

  // lines and states: the largest five of each with premiums, share and loss ratio, and the loss ratios as bar charts
  function linesSlide(f, t) {
    var X = detailOf(f) || {}, Ld = X.lines && arr(X.lines.items).length ? X.lines : null, Sd = X.states && arr(X.states.items).length ? X.states : null, items = [];
    var panel = function (kind, d, tx, ty, tw, th, cx, cy, cw, ch) {
      var lines = kind === "line", list = arr(d.items), key = lines ? "name" : "state";
      var has = function (k) { return list.some(function (r) { return num(r[k]); }); };
      var cols = [[lines ? "Line" : "State", null]];
      if (has("dpw")) cols.push(["DPW", "dpw", millions, 0.8]);
      if (lines && has("npw")) cols.push(["NPW", "npw", millions, 0.8]);
      if (has(lines ? "npe" : "dpe")) cols.push([lines ? "NPE" : "DPE", lines ? "npe" : "dpe", millions, 0.8]);
      cols.push(["Share", "share", pctCell, 0.75]);
      if (has("lossRatio")) cols.push(["Loss ratio", "lossRatio", pctCell, 1.05]);
      var rest = cols.slice(1).reduce(function (a, c) { return a + c[3]; }, 0), nameW = tw - rest;
      var by = d.by === "npe" ? "net premiums earned" : d.by === "dpe" ? "direct premiums earned" : "direct premiums written";
      var out = [header((lines ? "Largest lines, " + d.year + " ($M; loss ratio with LAE, %)" : "Largest states, " + d.year + " ($M; direct loss ratio, %)"), tx, ty, tw)];
      out.push({ type: "table", x: tx, y: ty + HDR, colW: [nameW].concat(cols.slice(1).map(function (c) { return c[3]; })), rowH: 0.27, size: 11, name: lines ? "Table lines" : "Table states",
        aligns: ["l"].concat(cols.slice(1).map(function () { return "r"; })),
        rows: [cols.map(function (c) { return c[0]; })].concat(list.map(function (r) { return [cellText(r[key], nameW)].concat(cols.slice(1).map(function (c) { return c[2](r[c[1]]); })); })) });
      var withRatio = list.filter(function (r) { return flat(r[key]) !== "Other" && num(r.lossRatio); }).slice(0, 5);
      if (withRatio.length) {
        out.push(header((lines ? "Loss and LAE ratio by line, " : "Direct loss ratio by state, ") + d.year + " (%)", cx, cy, cw));
        var pc = {}; withRatio.forEach(function (r, i) { if (r.lossRatio > 100) pc[i] = MAG; });
        out.push({ type: "chart", kind: "bar", x: cx, y: cy + HDR, w: cw, h: ch - HDR, legend: "none", gap: 50, catSize: 10, name: lines ? "Chart line loss ratios" : "Chart state loss ratios",
          categories: withRatio.map(function (r) { return fitText(r[key], 10, 1.9, false); }), series: [ser(lines ? "Loss and LAE ratio (%)" : "Direct loss ratio (%)", withRatio.map(function (r) { return r.lossRatio; }), lines ? NAVY : BLUE, { pointColors: pc })], labels: { format: "0.0", size: 10 } });
      }
      notes.push(by);
      return out;
    };
    var th = HDR + 0.27 * 7, cy = TOP + th + 0.25, ch = BOTTOM - cy, notes = [];
    if (Ld && Sd) items = items.concat(panel("line", Ld, L, TOP, QW, th, L, cy, QW, ch), panel("state", Sd, QX2, TOP, QW, th, QX2, cy, QW, ch));
    else items = items.concat(panel(Ld ? "line" : "state", Ld || Sd, L, TOP, QW, th, QX2, TOP, QW, BOTTOM - TOP));
    var note = notes.length > 1 && notes[0] !== notes[1] ? "Shares: of each total." : "Shares: of " + notes[0] + ".";
    items.push(source(f, { derived: true, period: String((Ld || Sd).year), note: note }));
    return content(t, "lines", "Lines and states, " + (Ld || Sd).year, items);
  }

  function earningsSlide(f, t) {
    var ug = S(f, "uw_gain"), nii = S(f, "net_inv_income"), rg = S(f, "realized_gains"), ni = S(f, "net_income"), cfo = S(f, "cash_from_ops"), yld = S(f, "investment_yield");
    var roaeR = S(f, "roae"), roaeD = D(f, "roae");
    var series = [];
    if (any(ug)) series.push(ser("Underwriting gain", ug.map(m1), NAVY));
    if (any(nii)) series.push(ser("Investment income", nii.map(m1), BLUE2));
    if (any(ni)) series.push(ser("Net income", ni.map(m1), MAG));
    var rows = [];
    if (any(ug)) rows.push(["Net underwriting gain", ug, millions, negative]);
    if (any(nii)) rows.push(["Net investment income", nii, millions]);
    if (any(rg)) rows.push(["Net realized capital gains", rg, millions, negative]);
    if (any(ni)) rows.push(["Net income", ni, millions, negative, true]);
    if (any(cfo)) rows.push(["Net cash from operations", cfo, millions, negative]);
    if (any(yld)) rows.push(["Investment yield (%)", yld, pctCell]);
    if (any(roaeR)) rows.push(["ROAE (%)", roaeR, pctCell, negative]);
    else if (any(roaeD)) rows.push(["ROAE (%, derived)", roaeD, pctCell, negative]);
    var blocks = [];
    if (series.length) blocks.push(chartBlock("Earnings by year ($M)", { kind: "column", categories: years(f), series: series, legend: series.length > 1 ? "top" : "none", gap: 60, overlap: -10, catLabels: "low", labels: { format: "#,##0.0;(#,##0.0)", size: 9 } }));
    blocks.push(tableBlock("Earnings by year", f, rows));
    var items = quads(blocks, pointsOf(t, "earnings"));
    var tot = f.derived && f.derived.net_income_total;
    items.push(source(f, { derived: !any(roaeR) && any(roaeD), note: num(tot) ? "Net income over the years shown: " + money(tot) + " (derived)." : "" }));
    return content(t, "earnings", "Earnings, " + yearsLabel(f), items);
  }

  function balanceSlide(f, t) {
    var ci = S(f, "cash_invested"), bo = S(f, "bonds"), st = S(f, "stocks"), cs = S(f, "cash_short_term"), pr = S(f, "premiums_receivable"), ta = S(f, "total_assets"), tl = S(f, "total_liabilities"), up = S(f, "unearned_premiums");
    var blocks = [], derived = false;
    var parts = [["Bonds", bo, NAVY], ["Common stocks", st, BLUE2], ["Cash and short-term", cs, MAG]].filter(function (p) { return any(p[1]); });
    if (parts.length && any(ci)) {
      var other = ci.map(function (v, i) { if (!num(v)) return null; var s = 0, all = true; parts.forEach(function (p) { if (num(p[1][i])) s += p[1][i]; else all = false; }); return all && v - s >= 0 ? v - s : null; });
      // only the largest part carries labels: the thin ones would be unreadable
      var sers = parts.map(function (p, i) { return ser(p[0], p[1].map(m1), p[2], i ? { labels: false } : null); });
      if (any(other)) sers.push(ser("Other invested assets", other.map(m1), GREY2, { labels: false }));
      blocks.push(chartBlock("Cash and invested assets ($M)", { kind: "stackedColumn", categories: years(f), series: sers, legend: "top", gap: 60, overlap: 100, labels: { format: "#,##0;(#,##0);;", position: "ctr", color: "FFFFFF", size: 9 } }));
    } else if (any(ci) || any(tl)) {
      var s2 = [];
      if (any(ci)) s2.push(ser("Cash and invested assets", ci.map(m1), NAVY));
      if (any(tl)) s2.push(ser("Total liabilities", tl.map(m1), MAG));
      blocks.push(chartBlock(s2.length > 1 ? "Invested assets and liabilities ($M)" : s2[0].name + " ($M)", { kind: "column", categories: years(f), series: s2, legend: s2.length > 1 ? "top" : "none", gap: 60, overlap: -10, labels: { format: "#,##0.0;(#,##0.0)", size: 9 } }));
    }
    var rows = [];
    if (any(ci)) rows.push(["Cash and invested assets", ci, millions, null, true]);
    if (any(bo)) rows.push(["Bonds", bo, millions]);
    if (any(st)) rows.push(["Common stocks", st, millions]);
    if (any(cs)) rows.push(["Cash and short-term", cs, millions]);
    if (any(pr)) rows.push(["Premiums receivable", pr, millions]);
    if (any(ta)) rows.push(["Total assets", ta, millions]);
    if (any(tl)) rows.push(["Total liabilities", tl, millions]);
    if (any(up)) rows.push(["Unearned premiums", up, millions]);
    if (rows.length) blocks.push(tableBlock("Balance sheet by year", f, rows));
    var ratios = [];
    [["Invested assets to liabilities (x)", "invested_to_liabilities", mult], ["Liabilities to surplus (x)", "liabilities_to_surplus", mult], ["NPW to surplus (x)", "npw_to_surplus", mult],
      ["Receivables to DPW (%)", "receivable_to_dpw", pctCell], ["Bonds share (%)", "bonds_share", pctCell], ["Stocks share (%)", "stocks_share", pctCell], ["Cash share (%)", "cash_share", pctCell]].forEach(function (r) {
      var a = D(f, r[1]); if (any(a)) ratios.push([r[0], a, r[2]]);
    });
    if (ratios.length) { derived = true; blocks.push(tableBlock("Liquidity and leverage (derived)", f, ratios)); }
    if (!blocks.length) blocks.push(tableBlock("Balance sheet by year", f, rows));
    var items = quads(blocks.slice(0, 3), pointsOf(t, "balance"));
    items.push(source(f, { derived: derived }));
    return content(t, "balance", "Balance sheet, " + yearsLabel(f), items);
  }

  // accident years: each one's loss and LAE ratio as each statement year reported it, and how far it has moved
  function accidentSlide(f, t) {
    var A = (detailOf(f) || {}).accidentYears || {}, rows = arr(A.rows).slice(-10), ys = (f.years || []).map(Number), n = ys.length;
    var hasNpe = rows.some(function (r) { return num(r.npe); });
    var yw = 0.82, aw = 1.25, cw = 1.15, nw = hasNpe ? 1.0 : 0, tw = aw + yw * n + cw + nw;
    var head = ["Accident year"].concat(ys.map(String)).concat(["Change (pts)"]).concat(hasNpe ? ["NPE ($M)"] : []);
    var body = rows.map(function (r) {
      var vals = arr(r.values);
      return [String(r.ay)].concat(ys.map(function (y, i) { return r.ay > y ? "" : pctCell(vals[i]); }))
        .concat([num(r.change) ? (r.change > 0 ? { text: "+" + fixed1(r.change), color: MAG } : pctCell(r.change)) : "n/d"]).concat(hasNpe ? [millions(r.npe)] : []);
    });
    var rowH = Math.min(0.3, (BOTTOM - TOP - HDR) / (rows.length + 1));
    var items = [header("Loss and LAE ratio by accident year, as each statement reported it (%)", L, TOP, tw),
      { type: "table", x: L, y: TOP + HDR, colW: [aw].concat(ys.map(function () { return yw; })).concat([cw]).concat(hasNpe ? [nw] : []), rowH: rowH, size: 11, rows: [head].concat(body),
        aligns: ["l"].concat(ys.map(function () { return "r"; })).concat(["r"]).concat(hasNpe ? ["r"] : []), name: "Table accident years" }];
    var rx = L + tw + 0.3, rw = R - rx;
    var worst = rows.filter(function (r) { return num(r.change); }).sort(function (a, b) { return b.change - a.change; })[0];
    var withChange = rows.filter(function (r) { return num(r.change); });
    if (rw >= 2.4) {
      items.push(tile(rx, TOP, rw, 1.2, worst ? (worst.change > 0 ? "+" : "") + fixed1(worst.change) + " pts" : "n/d", worst ? "Largest change, accident year " + worst.ay + ", since " + (worst.firstYear === worst.ay ? "first reported" : worst.firstYear) + " (derived)" : "Largest change since first shown (derived)", worst && worst.change > 0 ? MAG : NAVY));
      items.push(tile(rx, TOP + 1.45, rw, 1.2, withChange.length ? cnt(A.worse) + " of " + cnt(withChange.length) : "n/d", "Accident years worse than first shown (derived)", num(A.worse) && A.worse > 0 ? MAG : NAVY));
      if (withChange.length) {
        var cy = TOP + 2.9, pc = {};
        withChange.forEach(function (r, i) { pc[i] = r.change > 0 ? MAG : NAVY; });
        items.push(header("Change since first shown (points)", rx, cy, rw));
        items.push({ type: "chart", kind: "column", x: rx, y: cy + HDR, w: rw, h: BOTTOM - cy - HDR, legend: "none", gap: 60, catLabels: "low", catSize: 10, name: "Chart accident year change",
          categories: withChange.map(function (r) { return String(r.ay); }), series: [ser("Change (points)", withChange.map(function (r) { return r.change; }), NAVY, { pointColors: pc })], labels: { format: "0.0;(0.0);0.0", size: 9 } });
      }
    }
    items.push(source(f, { derived: true, note: "Change: points since first shown; up is worse." }));
    return content(t, "accident", "Accident years, " + yearsLabel(f), items);
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
    ["cover", "Cover"], ["summary", "Executive summary"], ["states", "Where it files (map)"], ["rateMap", "Latest rate change by state (map)"], ["rates", "Rate changes"],
    ["exposure", "Premium and policyholders the rate filings state"], ["adequacy", "Rate adequacy and loss costs"], ["programs", "Programs and forms"], ["market", "Against the market"],
    ["years", "Filings by year and type"], ["forms", "Latest form and rule filings"], ["regulator", "Time with the regulator"], ["questions", "Key diligence questions"]
  ];
  var LX2 = 8.42, LW = 7.4, RW = R - LX2;                 // two columns: left x 0.52 w 7.4, right x 8.42 w 4.38
  var FP_CHART_COLS = 20;                                 // the most filings drawn as columns on the rate chart
  var NOTHING = "S&P returned nothing for this search, so there are no filings to show. That doesn't prove nothing was filed.";

  function arr(a) { return Array.isArray(a) ? a : []; }
  function cnt(n) { return num(n) ? commas(String(Math.round(n))) : "n/d"; }
  function fpRows(f, k) { return arr(f[k] && f[k].rows).filter(function (r) { return r && typeof r === "object"; }); }
  function fpPlan(facts, opts) {
    var f = facts || {}, T = f.totals || {}, R = f.rates || {}, Y = f.years || {};
    var rows = FP_SLIDES.map(function (s) { return { id: s[0], label: s[1], included: true, reason: "" }; });
    var out = function (id, reason) { rows.forEach(function (r) { if (r.id === id) { r.included = false; r.reason = reason; } }); };
    if (!num(T.filings) || T.filings <= 0) { ["states", "rateMap", "rates", "exposure", "adequacy", "programs", "market", "years", "forms", "regulator"].forEach(function (id) { out(id, fpScope(f) ? fpNothing(f) + ", so there are no filings to show. That says nothing about other " + fpOther(f) + ", and doesn't prove nothing was filed." : NOTHING); }); return rows; }
    var X = rich(f), map = usMapOf(opts);
    if (!map) out("rateMap", "The outlines of the states didn't load, so the rate map is left out (the filings by state are a bar chart instead). Reload the page and build again.");
    else if (!fpRows(f, "states").some(function (s) { return s.latest && num(s.latest.rate); })) out("rateMap", "No filing in any state carried an overall rate impact in S&P's data, so there is nothing to shade.");
    if (!arr(X.E.rows).length) out("exposure", needSummaries(f, "rate", "the premium or policyholders they affect"));
    if (!arr(X.A.rows).length) out("adequacy", needSummaries(f, "rate", "an indicated, filed or approved change, loss costs or assumptions"));
    if (!arr(X.G.programs).length && !arr(X.G.forms).length) out("programs", X.U.checked && X.G.summaries ? "The " + plural(X.G.summaries, "saved summary", "saved summaries") + " of this company's filings name no program or form." : needSummaries(f, "form", "a program or a form"));
    if (!arr(X.M.rows).length) out("market", flat(X.M.reason) || "The market index wasn't looked up for this profile.");
    // what the narrowing by filing type left out (fpLeftOut in profile.ts): said so, never as "S&P returned nothing"
    var LO = fpLeft(f);
    if (LO.rate && !(R.filings > 0)) { out("rateMap", fpOutWhy(f, ["rate"])); out("exposure", fpOutWhy(f, ["rate"])); out("adequacy", fpOutWhy(f, ["rate"])); }
    if (LO.form && !arr(X.G.programs).length && !arr(X.G.forms).length) out("programs", fpOutWhy(f, LO.rule ? ["form", "rule"] : ["form"]));
    if (LO.form && LO.rule && !(f.latest && f.latest.total > 0)) out("forms", fpOutWhy(f, ["form", "rule"]));
    if (LO.rate && !R.filings) out("rates", fpOutWhy(f, ["rate"]));
    else if (!R.filings) out("rates", fpNothing(f, "no rate filings") + ", so there are no rate changes to show.");
    else if (!R.withImpact) out("rates", "No filing carried an overall rate impact in S&P's data, so there are no rate changes to chart.");
    else if (!arr(R.points).length) out("rates", "None of the filings with a rate impact has a publish date, so they can't be put in date order.");
    if (!fpRows(f, "states").length) out("states", "None of the filings names a state in S&P's data.");
    if (!arr(Y.totals).some(function (n) { return n > 0; })) out("years", "None of the filings has a publish date in S&P's data.");
    if (!(LO.form && LO.rule) && !(f.latest && f.latest.total > 0 && fpRows(f, "latest").length)) out("forms", fpNothing(f, "no form or rule filings") + ".");
    if (!(f.regulator && f.regulator.all)) out("regulator", "None of the filings has both a submitted date and a publish date in S&P's data, so the time with the regulator can't be worked out.");
    return rows;
  }

  function fpName(f) { var e = f.entity || {}; return flat(e.name) || flat(e.groupName) || (e.kind === "group" ? "The group" : "The company"); }
  function fpThisYear(f) { return (ymd(f.asOf) || {}).y; }
  function fpDate(f, s) { return shortDate(s, fpThisYear(f)); }
  // what the profile was narrowed to ("Narrow it down"), from the facts (profile.ts fpScopeOf); null when it wasn't
  function fpScope(f) { var s = f && f.scope; return s && typeof s === "object" && s.narrowed === true && flat(s.words) && flat(s.short) ? { words: flat(s.words), short: flat(s.short) } : null; }
  // what the narrowing by filing type or status leaves out (profile.ts fpLeftOut); nothing for facts not narrowed by them
  function fpLeft(f) { var s = f && f.scope, l = s && s.narrowed === true && s.leftOut && typeof s.leftOut === "object" ? s.leftOut : {}; return { rate: !!l.rate, rule: !!l.rule, form: !!l.form, approved: !!l.approved, unapproved: !!l.unapproved, statuses: !!l.statuses }; }
  function fpNames(a, max, words) { a = arr(a).map(function (x) { return x && flat(x.name); }).filter(Boolean); return a.length ? words(a, max) : ""; }
  function lowName(n) { return /^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n; }
  function andW(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  function orW(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " or " + a[a.length - 1]; }
  function ftWords(a, max) { if (a.length > max) return a.length + " filing types"; var w = andW(a.map(lowName)); return /\bfilings?$/i.test(w) ? w : w + " filings"; }
  function stWords(a, max) { return a.length > max ? a.length + " statuses" : orW(a.map(lowName)); }
  // "The profile was narrowed to rate filings, so form and rule filings weren't searched." (as fpOutWhy in profile.ts)
  function fpOutWhy(f, kinds) {
    var s = f && f.scope || {};
    if (kinds === "status") return "The profile was narrowed to " + (fpNames(s.statuses, 3, stWords) || "some statuses") + ", so not every status was searched.";
    return "The profile was narrowed to " + (fpNames(s.filingTypes, 3, ftWords) || "some filing types") + ", so " + andW(kinds) + " filings weren't searched.";
  }
  // "says nothing about other ...": all four kinds when a filing type or status was chosen
  function fpOther(f) { var s = f && f.scope || {}; return arr(s.filingTypes).length || arr(s.statuses).length ? "states, types of insurance, filing types or statuses" : "states or types of insurance"; }
  // the same, for a header: " (FL and TX, homeowners)"; "" when not narrowed
  function fpTag(f) { var s = fpScope(f); return s ? " (" + s.short + ")" : ""; }
  // "S&P returned nothing for this search", naming the scope when narrowed
  function fpNothing(f, what) { var s = fpScope(f); return "S&P returned " + (what || "nothing") + " for this search" + (s ? " of " + s.words : ""); }
  // a status as S&P gives it, lower case inside a sentence or label when it is a plain word or two
  function statusWord(s) { s = flat(s); return !s ? "status n/d" : /^[A-Za-z][A-Za-z -]*$/.test(s) ? s.toLowerCase() : s; }
  // the source line: S&P, the filings product and the period, then notes, made shorter until it fits on one line
  // claude: say the text was drafted by Claude (the summary and the questions, as on the full profile)
  function fpSource(f, t, notes, claudeNote) {
    var P = f.period || {}, long = longDate(P.from) + " to " + longDate(P.to), short = monthYear(P.from).replace(/^(\w{3})\w*/, "$1") + " to " + monthYear(P.to).replace(/^(\w{3})\w*/, "$1");
    // a narrowed profile names its scope on every source line, before any note: in words, or shorter when it must fit
    var sc = fpScope(f);
    if (sc) { long = long + ", " + sc.words + " only"; short = short + ", " + sc.short; }
    notes = (notes || []).filter(Boolean);
    var claude = claudeNote && t && t.by === "claude", capped = f.search && f.search.capped;
    var tries = [[long, 0], [long, 1], [long, 2], [short, 2], [short, 3]];
    for (var i = 0; i < tries.length; i++) {
      var lv = tries[i][1], parts = ["Source: " + FILINGS_SOURCE + ", " + tries[i][0] + "."];
      if (capped) parts.push(lv > 2 ? "Incomplete." : lv ? "Search incomplete." : "The search stopped early, so figures may be incomplete.");
      notes.forEach(function (n) { var v = typeof n === "string" ? n : n[Math.min(lv, n.length - 1)]; if (v) parts.push(v); });
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
    var title = fitText(fpName(f), 40, 15, true) + ": filings profile" + (f.sample ? " (sample)" : ""), sc = fpScope(f);
    return { kind: "cover", kicker: "Corporate development | " + monthYear(f.asOf) + (sc ? " | " + sc.short : ""), title: title, subtitle: flat(t.cover && t.cover.subtitle) };
  }
  function fpNothingBox(f, x, y, w) {
    var P = f.period || {};
    return { type: "box", x: x, y: y, w: w, h: 1.6, fill: "EEEEF5", margins: [0.2, 0.2, 0.15, 0.15], anchor: "ctr", name: "Nothing returned",
      paras: [{ after: 4, runs: [{ text: "S&P returned nothing for this search" + fpTag(f), size: 16, bold: true, color: NAVY }] },
              { runs: [{ text: "Filings published " + longDate(P.from) + " to " + longDate(P.to) + (fpScope(f) ? " were searched in " + fpScope(f).words + " only. That says nothing about other " + fpOther(f) + ", and doesn't prove nothing was filed." : " were searched in every state in S&P's list. That doesn't prove nothing was filed."), size: 12, color: NAVY }] }] };
  }

  function fpSummary(f, t) {
    var T = f.totals || {}, big = f.largest, A = f.approval || {}, items = [], lw = 5.6;
    var rx = L + lw + 0.3, rw = R - rx;
    if (!T.filings) {
      items.push(header("Filings", L, TOP, lw), fpNothingBox(f, L, TOP + HDR, lw));
    } else {
      items.push(header("Key figures" + fpTag(f), L, TOP, lw));
      var LO = fpLeft(f), kindTile = function (k, label) { return LO[k] && !T[k] ? ["Left out", label + ": not searched, as the profile was narrowed"] : [cnt(T[k]), label]; };
      var tiles = [
        [cnt(T.filings), "Filings published in the period"], kindTile("rate", "Rate filings"), kindTile("rule", "Rule filings"), kindTile("form", "Form filings"),
        [cnt(T.states), "States with filings, of " + cnt(f.search && f.search.statesSearched) + " searched"],
        [T.latest ? fpDate(f, T.latest) : "n/d", "Latest filing published"],
        LO.rate && !big ? ["Left out", "Largest overall rate change: rate filings weren't searched"] : big ? [pct(big.rate), "Largest overall rate change: " + (flat(big.state) || "state n/d") + ", " + fpDate(f, big.date) + ", " + statusWord(big.status) + (big.approved ? "" : " (may be as asked)"), big.approved ? NAVY : PURPLE]
          : ["n/d", "Largest overall rate change (no filing carried one)"],
        LO.statuses ? ["Left out", "Rate filings approved: not every status was searched"] : A.rateFilings ? [pct(A.share), "Rate filings approved, " + cnt(A.approved) + " of " + cnt(A.rateFilings) + " (derived)"] : ["n/d", "Rate filings approved (no rate filings)"]
      ];
      // what the saved summaries and the market index add takes the place of the rule and form counts, then the latest date
      richTiles(f).forEach(function (r, i) { tiles[[2, 3, 5][i]] = r; });
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
    items.push(header("Filings by state" + fpTag(f) + (rows.length > bars.length ? " (top " + bars.length + " of " + rows.length + ")" : ""), L, TOP, LW));
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
    items.push(header("Filings by year published and filing type" + fpTag(f), L, TOP, LW));
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

  // =================================================================================================================
  // ---------- the richer filings profile: maps, exposure, rate adequacy, programs and forms, the market ----------
  // =================================================================================================================
  // The facts come from profile.ts (fpRich, fpMarketFacts): what saved summaries of the company's own filings state, and
  // the market index of the states it files in. Every figure from a summary is shown with its filing and page.
  var FP_USD_150 = [2.30, 3.50];          // what Claude reading 150 pages costs (the README's estimate, FC_USD_150 on the page)
  var FP_SUGGEST = 5;                      // the summaries the plan suggests making when none is saved
  var MAP_VIEW = [0, 0, 975, 610];         // US_MAP's drawing (Albers USA)
  var SMALL = ["NH", "VT", "MA", "RI", "CT", "NJ", "DE", "MD", "DC"];   // labelled beside the map, with a leader line
  var COUNT_FILLS = ["DCDAF0", "B4AEDB", "847CC0", "51499A", NAVY];
  var NOTHING_FILL = { prst: "ltUpDiag", fg: "A6A6BF", bg: "FFFFFF" }, NO_RATE_FILL = "EEEEF5", UNSEARCHED_FILL = "BFBFBF";
  var RATE_BINS = [
    { label: "Down 5.0% or more", fill: TEAL, dark: true, has: function (v) { return v <= -5; } },
    { label: "Down under 5.0%", fill: "8FD0CA", has: function (v) { return v < 0 && v > -5; } },
    { label: "No change", fill: "D9DCE6", has: function (v) { return v === 0; } },
    { label: "Up to 5.0%", fill: "F7B6DA", has: function (v) { return v > 0 && v <= 5; } },
    { label: "Up over 5.0% to 10.0%", fill: "F062B5", dark: true, has: function (v) { return v > 5 && v <= 10; } },
    { label: "Up over 10.0%", fill: MAG, dark: true, has: function (v) { return v > 10; } }
  ];
  // where a label sits off US_MAP's own point, in its units, so neighbouring south-eastern labels don't collide
  var NUDGE = { SC: [14, 6], GA: [-8, 8], LA: [-4, 4], MS: [0, -6], AL: [2, 8], NC: [14, 2], FL: [14, 8], WV: [-4, 2], KY: [4, 0], TN: [0, 2] };

  function rich(f) {
    var z = { filings: 0, withDocument: 0, summarised: 0, older: 0 }, o = f || {};
    var U = o.summaries && typeof o.summaries === "object" ? o.summaries : { checked: false, note: "Saved summaries weren't looked up for this profile.", rate: z, form: z };
    return {
      searched: arr(o.map && o.map.searched),
      U: { checked: !!U.checked, note: flat(U.note), rate: U.rate || z, form: U.form || z },
      E: o.exposure || { rows: [], total: 0, latest: [], latestPremium: null, latestPolicyholders: null, summarised: 0 },
      A: o.adequacy || { rows: [], total: 0, summarised: 0 },
      G: o.programs || { programs: [], programsTotal: 0, forms: [], formsTotal: 0, summaries: 0 },
      M: o.market || { checked: false, reason: "The market index wasn't looked up for this profile.", rows: [], coverage: [], indexed: [] }
    };
  }
  function usd2(v) { return "$" + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  // what making n summaries costs, as the page estimates it: 1 S&P request each and up to 150 pages of Claude reading
  function makeCost(n) { return plural(n, "S&P request") + " and about " + usd2(n * FP_USD_150[0]) + " to " + usd2(n * FP_USD_150[1]) + " of Claude reading"; }
  function plural(n, one, more) { return cnt(n) + " " + (n === 1 ? one : (more || one + "s")); }
  /* Why a slide that needs saved summaries is left out, and what including it would cost. kind: "rate" or "form". */
  function needSummaries(f, kind, what) {
    var R = rich(f), c = R.U[kind], noun = kind === "rate" ? "rate filing" : "form filing";
    if (!c.filings && fpLeft(f)[kind]) return fpOutWhy(f, [kind]);
    if (!R.U.checked) return (R.U.note || "Saved summaries weren't looked up for this profile.") + " This slide needs them.";
    if (!c.filings) return "S&P returned no " + noun + "s for this search, so there is nothing to summarise for this slide.";
    if (!c.summarised) {
      var k = Math.min(FP_SUGGEST, c.withDocument);
      if (!k) return "None of the " + plural(c.filings, noun) + " has a document to summarise, so this slide can't be filled.";
      return "None of the " + plural(c.filings, noun) + " has a saved summary yet. Summarising the latest " + cnt(k) + " would take " + makeCost(k) + "; choose it below to include this slide.";
    }
    var older = c.older ? " " + plural(c.older, "of them was", "of them were") + " summarised before these figures were read; refreshing " + (c.older === 1 ? "it" : "them") + " would take " + makeCost(c.older) + "." : "";
    return "The " + plural(c.summarised, "summarised " + noun) + " don't state " + what + "." + older;
  }

  // ----- the map -----
  function pathBox(d) {
    var toks = String(d || "").match(/[MmLlHhVvZz]|-?\d+(?:\.\d+)?/g) || [], x = 0, y = 0, sx = 0, sy = 0, cmd = "", i = 0, b = [Infinity, Infinity, -Infinity, -Infinity];
    var see = function () { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      if (cmd === "z" || cmd === "Z") { x = sx; y = sy; continue; }
      var a = +toks[i++];
      if (cmd === "M" || cmd === "m") { var b2 = +toks[i++]; x = cmd === "m" ? x + a : a; y = cmd === "m" ? y + b2 : b2; sx = x; sy = y; cmd = cmd === "m" ? "l" : "L"; }
      else if (cmd === "L" || cmd === "l") { var c2 = +toks[i++]; x = cmd === "l" ? x + a : a; y = cmd === "l" ? y + c2 : c2; }
      else if (cmd === "H" || cmd === "h") x = cmd === "h" ? x + a : a;
      else if (cmd === "V" || cmd === "v") y = cmd === "v" ? y + a : a;
      see();
    }
    return b;
  }
  function usMapOf(opts) {
    var m = opts && opts.usMap;
    if (!m && typeof US_MAP !== "undefined") m = US_MAP;   // the page's own outlines (web/index.html), when loaded there
    if (!m || typeof m !== "object") return null;
    var ok = Object.keys(m).filter(function (k) { return /^[A-Z]{2}$/.test(k) && Array.isArray(m[k]) && typeof m[k][0] === "string"; });
    return ok.length >= 40 ? m : null;
  }
  // count bins: five even steps up to the most filings in a state (1 to 4, 5 to 8, ... for 19), fewer when that's small
  function countBins(max) {
    var step = Math.max(1, Math.ceil(max / 5)), out = [];
    for (var lo = 1; lo <= max; lo += step) out.push({ lo: lo, hi: Math.min(lo + step - 1, max) });
    return out.map(function (b, i) { return { lo: b.lo, hi: b.hi, fill: COUNT_FILLS[Math.round(i * (COUNT_FILLS.length - 1) / Math.max(1, out.length - 1))], dark: i * (COUNT_FILLS.length - 1) / Math.max(1, out.length - 1) >= 2.5,
      label: b.lo === b.hi ? plural(b.lo, "filing") : cnt(b.lo) + " to " + cnt(b.hi) + " filings" }; });
  }
  /* The map as one group of native shapes: a freeform for each state (from US_MAP), its two-letter code and figure
     where the state is big enough, and the small north-eastern states labelled beside the map with leader lines.
     mode "count": shaded by filings; "rate": by the latest overall rate change. A state S&P returned nothing for is
     hatched (never shaded as zero); a state with filings but no rate impact is pale grey on the rate map. */
  function mapItems(f, mode, usMap, x, y, w, h) {
    var rows = fpRows(f, "states"), by = {}, R = rich(f), searched = {};
    rows.forEach(function (r) { if (r.state) by[r.state] = r; });
    R.searched.forEach(function (s) { searched[s] = true; });
    var anySearched = R.searched.length > 0;
    var maxN = rows.reduce(function (m, r) { return Math.max(m, num(r.n) ? r.n : 0); }, 0), bins = countBins(maxN);
    var callW = 0.62, k = Math.min((w - callW - 0.12) / MAP_VIEW[2], h / MAP_VIEW[3]), mw = MAP_VIEW[2] * k, mh = MAP_VIEW[3] * k;
    var mx = x, my = y + (h - mh) / 2;
    var look = function (code) {
      var r = by[code];
      if (anySearched && !searched[code] && !r) return { fill: UNSEARCHED_FILL, kind: "unsearched" };
      if (!r || !num(r.n) || r.n <= 0) return { pattern: NOTHING_FILL, kind: "nothing" };
      if (mode === "count") { var b = bins.filter(function (q) { return r.n >= q.lo && r.n <= q.hi; })[0] || bins[bins.length - 1]; return { fill: b.fill, dark: b.dark, value: cnt(r.n), kind: "data" }; }
      var l = r.latest; if (!l || !num(l.rate)) return { fill: NO_RATE_FILL, value: "n/d", kind: "norate" };
      var rb = RATE_BINS.filter(function (q) { return q.has(l.rate); })[0];
      return { fill: rb.fill, dark: !!rb.dark, value: pctCell(l.rate) + (l.approved ? "" : "*"), kind: "data" };
    };
    var shapes = [], labels = [], callouts = [];
    Object.keys(usMap).filter(function (c) { return /^[A-Z]{2}$/.test(c); }).sort().forEach(function (code) {
      var e = usMap[code], st = look(code), name = flat(e[1]) || code;
      shapes.push({ type: "freeform", path: e[0], view: MAP_VIEW, x: mx, y: my, w: mw, h: mh, fill: st.fill, pattern: st.pattern, line: { color: st.kind === "nothing" ? "A6A6BF" : "FFFFFF", width: 0.75 },
        name: name + (st.kind === "nothing" ? ": S&P returned nothing" : st.kind === "unsearched" ? ": not searched" : st.kind === "norate" ? ": no rate impact" : ": " + st.value) });
      var nd = NUDGE[code] || [0, 0], lx = num(e[2]) ? e[2] + nd[0] : null, ly = num(e[3]) ? e[3] + nd[1] : null;
      if (lx === null && code === "HI") { var hb = pathBox(e[0]); lx = (hb[0] + hb[2]) / 2 + 30; ly = (hb[1] + hb[3]) / 2 - 18; }
      var col = st.dark ? "FFFFFF" : NAVY;
      if (lx !== null && ly !== null) {
        var cx = mx + lx * k, cy = my + ly * k, two = st.kind === "data" || st.kind === "norate";
        labels.push({ type: "text", x: cx - 0.3, y: cy - (two ? 0.17 : 0.1), w: 0.6, h: two ? 0.34 : 0.2, margin: 0, anchor: "ctr", autofit: false, name: "Label " + code,
          paras: [{ align: "ctr", runs: [{ text: code, size: 10, bold: two, color: two ? col : "666666" }] }].concat(two ? [{ align: "ctr", runs: [{ text: st.value, size: 10, color: col }] }] : []) });
      } else if (SMALL.indexOf(code) >= 0 && (st.kind === "data" || st.kind === "norate")) {
        var bb = pathBox(e[0]);
        callouts.push({ code: code, value: st.value, cx: mx + (bb[0] + bb[2]) / 2 * k, cy: my + (bb[1] + bb[3]) / 2 * k });
      }
    });
    // the small states' labels in a column right of the map, in north to south order, never overlapping
    callouts.sort(function (a, b) { return a.cy - b.cy; });
    var colX = mx + mw + 0.12, lastY = -Infinity;
    callouts.forEach(function (c) {
      var ty = Math.max(c.cy - 0.1, lastY + 0.22); lastY = ty;
      labels.push({ type: "line", x1: c.cx, y1: c.cy, x2: colX - 0.02, y2: ty + 0.1, color: "666666", width: 0.5, name: "Leader " + c.code });
      labels.push({ type: "text", x: colX, y: ty, w: callW, h: 0.2, margin: 0, anchor: "ctr", autofit: false, name: "Label " + c.code,
        paras: [{ runs: [{ text: c.code + " ", size: 10, bold: true, color: NAVY }, { text: c.value, size: 10, color: NAVY }] }] });
    });
    var legend = mode === "count" ? bins.map(function (b) { return { fill: b.fill, label: b.label }; })
      : RATE_BINS.map(function (b) { return { fill: b.fill, label: b.label }; }).concat([{ fill: NO_RATE_FILL, label: "Filings, no rate impact" }]);
    legend.push({ pattern: NOTHING_FILL, label: "S&P returned nothing" });
    if (anySearched && Object.keys(usMap).some(function (c) { return /^[A-Z]{2}$/.test(c) && !searched[c] && !by[c]; })) legend.push({ fill: UNSEARCHED_FILL, label: fpScope(f) ? "Not searched (outside the scope)" : "Not searched" });
    return { group: { type: "group", name: mode === "count" ? "Map of filings by state" : "Map of latest rate change by state", items: shapes.concat(labels) }, legend: legend, bottom: my + mh, right: colX + (callouts.length ? callW : 0) };
  }
  // the legend: a swatch (a small freeform square, so a hatch can show) and its label, in rows across the width given
  function legendItems(legend, x, y, w, name) {
    var items = [], cw = Math.max(1.55, Math.min(2.3, w / Math.min(legend.length, 4))), per = Math.max(1, Math.floor(w / cw));
    legend.forEach(function (l, i) {
      var lx = x + (i % per) * cw, ly = y + Math.floor(i / per) * 0.24;
      items.push({ type: "freeform", path: "M0 0H10V10H0Z", view: [0, 0, 10, 10], x: lx, y: ly + 0.04, w: 0.16, h: 0.16, fill: l.fill, pattern: l.pattern, line: { color: "A6A6BF", width: 0.5 }, name: "Key " + l.label });
      items.push({ type: "text", x: lx + 0.22, y: ly, w: cw - 0.26, h: 0.24, margin: 0, anchor: "ctr", autofit: false, name: "Key label " + l.label, paras: [{ runs: [{ text: l.label, size: 10, color: NAVY }] }] });
    });
    return { group: { type: "group", name: name || "Key", items: items }, h: Math.ceil(legend.length / per) * 0.24 };
  }
  function mapSlide(f, t, mode, usMap) {
    var items = [], lw = 7.75, rx = 8.62, rw = R - rx, rows = fpRows(f, "states"), star = false;
    var legendRows = Math.ceil((mode === "count" ? countBins(rows.reduce(function (m, r) { return Math.max(m, r.n || 0); }, 0)).length + 2 : 9) / 3);
    var mapH = BOTTOM - TOP - HDR - 0.12 - legendRows * 0.24;
    items.push(header((mode === "count" ? "Filings by state, shaded by number of filings" : "Latest overall rate change by state (%)") + fpTag(f), L, TOP, lw));
    var m = mapItems(f, mode, usMap, L, TOP + HDR, lw, mapH);
    items.push(m.group);
    items.push(legendItems(m.legend, L, m.bottom + 0.1, lw, mode === "count" ? "Key: filings" : "Key: rate change").group);
    // the right column: the states with filings, then the takeaways
    var tableRows = rows.slice(0, 12), head, tr;
    if (mode === "count") {
      head = ["State", "Filings", "Rate filings", "Latest rate (%)"];
      tr = tableRows.map(function (r) { var l = r.latest; if (l && !l.approved) star = true; return [r.state, cnt(r.n), cnt(r.rate), l ? pctCell(l.rate) + (l.approved ? "" : "*") : "n/d"]; });
    } else {
      var withRate = rows.filter(function (r) { return r.latest && num(r.latest.rate); }).sort(function (a, b) { return b.latest.rate - a.latest.rate || a.state.localeCompare(b.state); });
      tableRows = withRate.slice(0, 12);
      head = ["State", "Latest (%)", "Published", "Status"];
      tr = tableRows.map(function (r) { var l = r.latest; if (!l.approved) star = true; return [r.state, { text: pctCell(l.rate) + (l.approved ? "" : "*"), color: l.rate > 0 ? NAVY : l.rate < 0 ? TEAL : NAVY }, fpDate(f, l.date), cellText(l.status, 1.2)]; });
    }
    var all = mode === "count" ? rows.length : rows.filter(function (r) { return r.latest && num(r.latest.rate); }).length;
    items.push(header((mode === "count" ? "By state" : "Highest first") + (all > tableRows.length ? " (" + tableRows.length + " of " + all + ")" : ""), rx, TOP, rw));
    items.push({ type: "table", x: rx, y: TOP + HDR, colW: mode === "count" ? [0.7, 0.9, 1.1, 1.48] : [0.7, 1.1, 1.18, 1.2], rowH: 0.25, size: 11, name: mode === "count" ? "Table states" : "Table latest rate by state",
      aligns: mode === "count" ? ["l", "r", "r", "r"] : ["l", "r", "r", "l"], rows: [head].concat(tr) });
    var y2 = TOP + HDR + (tr.length + 1) * 0.25 + 0.25;
    if (BOTTOM - y2 >= 1.2) items = items.concat(takeaways(pointsOf(t, mode === "count" ? "states" : "rateMap"), rx, y2, rw, BOTTOM - y2));
    var notes = [star ? ["* Not approved: the figure may be the change asked for. Rate impacts are S&P's overall figure, not weighted by premium.", "* Not approved: may be the change asked for. Unweighted.", "* Not approved: may be as asked."]
      : ["Rate impacts are S&P's overall figure for the newest filing with one, not weighted by premium.", "Rate impacts: overall, not premium-weighted."],
      fpScope(f) ? ["Hatched: S&P returned nothing for this search in that state; grey: not searched, outside this profile's scope.", "Hatched: nothing returned; grey: not searched.", "Grey: not searched."]
        : ["Hatched: S&P returned nothing for this search in that state, which doesn't prove nothing was filed.", "Hatched: S&P returned nothing (not proof of none).", "Hatched: nothing returned."]];
    if (f.states && f.states.noState) notes.push(cnt(f.states.noState) + " with no state left out.");
    items.push(fpSource(f, t, notes));
    return content(t, mode === "count" ? "states" : "rateMap", mode === "count" ? "Where it files" : "Latest rate change by state", items);
  }

  // ----- exposure: what each summarised rate filing states about the book it covers -----
  var EXPO_LINE = "What each rate filing states for the book it covers, from its own pages: not statutory premium, and not the company's whole book.";
  function sumNote(f) { var R = rich(f); return cnt(R.E.summarised || R.U.rate.summarised) + " of " + plural(R.U.rate.filings, "rate filing") + " summarised"; }
  function fpExposure(f, t) {
    var R = rich(f), E = R.E, items = [], rows = arr(E.rows).slice();
    items.push({ type: "text", x: L, y: TOP, w: W, h: 0.3, margin: 0, name: "What these figures are", paras: [{ runs: [{ text: EXPO_LINE, size: 12, color: NAVY }] }] });
    var top = TOP + 0.35, ch = 1.85, y2 = top + HDR + ch + 0.15, cap = Math.max(1, Math.floor((BOTTOM - y2 - HDR) / 0.25) - 1);
    var c1w = 3.9, c2x = L + c1w + 0.3, c2w = LX2 - 0.3 - c2x;
    // the table: the latest filing for each state and type first (the first chart's figures), then the newest others;
    // both charts draw only what the table shows, so every figure charted has its filing and page beside it
    var latest = arr(E.latest), key = function (r) { return (r.filingNo || "") + "|" + (r.published || "") + "|" + (r.state || "") + "|" + (r.toi || ""); };
    var pick = latest.slice(0, cap), have = {}; pick.forEach(function (r) { have[key(r)] = true; });
    rows.slice().sort(function (a, b) { return String(b.published || "").localeCompare(String(a.published || "")); }).forEach(function (r) { if (pick.length < cap && !have[key(r)]) { pick.push(r); have[key(r)] = true; } });
    var shown = pick.sort(function (a, b) { return String(b.published || "").localeCompare(String(a.published || "")); });
    var label = function (r) { return (flat(r.state) || "n/d") + " " + (flat(r.toi) || "type n/d"); };
    var usePrem = latest.some(function (r) { return num(r.premium) && have[key(r)]; });
    var val = function (r) { return usePrem ? (num(r.premium) ? m1(r.premium) : null) : (num(r.policyholders) ? r.policyholders : null); };
    // chart 1: by state and type of insurance (the latest filing of each), largest first
    var bars = latest.filter(function (r) { return have[key(r)] && val(r) !== null; }).slice(0, 7);
    items.push(header(usePrem ? "Latest per state and type ($M)" : "Latest per state and type", L, top, c1w));
    items.push({ type: "chart", kind: "bar", x: L, y: top + HDR, w: c1w, h: ch, legend: "none", gap: 40, categories: bars.length ? bars.map(function (r) { return fitText(label(r), 10, 2.0, false); }) : ["n/d"],
      series: [ser(usePrem ? "Premium affected ($M)" : "Policyholders", bars.length ? bars.map(val) : [null], NAVY, { pointColors: { 0: MAG } })], labels: { format: usePrem ? "#,##0.0" : "#,##0" }, catSize: 10, name: "Chart exposure by state" });
    // chart 2: over time, each filing in the table in date order
    var dated = shown.filter(function (r) { return val(r) !== null; }).slice().reverse();
    items.push(header(usePrem ? "Each filing, in date order ($M)" : "Each filing, in date order", c2x, top, c2w));
    items.push({ type: "chart", kind: "column", x: c2x, y: top + HDR, w: c2w, h: ch, legend: "none", gap: 50, catSize: 10, catLabels: "low",
      categories: dated.length ? dated.map(function (r) { var d = ymd(r.published); return (flat(r.state) || "n/d") + " " + (d ? MONTHS[d.m - 1].slice(0, 3) + " " + d.y : "n/d"); }) : ["n/d"],
      series: [ser(usePrem ? "Premium affected ($M)" : "Policyholders", dated.length ? dated.map(val) : [null], BLUE)], labels: { format: usePrem ? "#,##0.0" : "#,##0", size: 10 }, name: "Chart exposure over time" });
    // the table, and the takeaways beside it
    var tr = shown.map(function (r) {
      var pg = num(r.page) ? String(r.page) : "n/d";
      if (num(r.exposures) && num(r.exposuresPage) && r.exposuresPage !== r.page) pg = (num(r.page) ? r.page + ", " : "") + r.exposuresPage;
      return [fpDate(f, r.published), flat(r.state) || "n/d", flat(r.toi) || "n/d", num(r.premium) ? millions(r.premium) : "n/d", num(r.policyholders) ? cnt(r.policyholders) : "n/d", num(r.exposures) ? cnt(r.exposures) : "n/d", num(r.rate) ? pctCell(r.rate) : "n/d", flat(r.filingNo) || "n/d", pg];
    });
    items.push(header("Each filing's own figures, newest first" + (num(E.total) && E.total > shown.length ? " (" + shown.length + " of " + cnt(E.total) + ")" : ""), L, y2, W));
    items.push(fpTable("Table exposure", L, y2 + HDR, W, ["Published", "State", "Type of insurance", "Premium ($M)", "Policyholders", "Exposures", "Overall rate (%)", "Filing", "Page"], tr,
      [1.1, 0.6, 2.4, 1.35, 1.25, 1.1, 1.35, 2.4, 0.73], ["r", "l", "l", "r", "r", "r", "r", "l", "r"], [0, 1, 7, 8], { fit: [2, 7] }));
    items = items.concat(takeaways(pointsOf(t, "exposure"), LX2, top, RW, y2 - 0.12 - top));
    items.push(fpSource(f, t, [["Premium (US dollars) and policyholders as each filing states them, from saved summaries made by Claude; totals add the latest filing per state and type (derived).",
      "As each filing states them (summaries by Claude); totals (derived).", "Filings' own figures; totals (derived)."], [sumNote(f) + ".", ""]]));
    return content(t, "exposure", "Premium and policyholders the rate filings state", items);
  }

  // ----- rate adequacy and loss costs -----
  function fpAdequacy(f, t) {
    var R = rich(f), rows = arr(R.A.rows), items = [];
    items.push({ type: "text", x: L, y: TOP, w: W, h: 0.3, margin: 0, name: "What these figures are", paras: [{ runs: [{ text: "Indicated: the change the filing's own analysis supports. Filed: the change asked for. Approved: the change the regulator allowed, where the filing states it.", size: 12, color: NAVY }] }] });
    var top = TOP + 0.35, lw = 7.4, ch = 2.2;
    var withPct = rows.filter(function (r) { return [r.indicatedPct, r.requestedPct, r.overallPct, r.approvedPct].some(num); }).slice(0, 6).reverse();
    var filedOf = function (r) { return num(r.requestedPct) ? r.requestedPct : num(r.overallPct) ? r.overallPct : null; };
    if (withPct.length) {
      var cats = withPct.map(function (r) { var d = ymd(r.published); return (flat(r.state) || "n/d") + " " + (d ? MONTHS[d.m - 1].slice(0, 3) + " " + d.y : "n/d"); });
      var series = [ser("Indicated", withPct.map(function (r) { return num(r.indicatedPct) ? r.indicatedPct : null; }), NAVY), ser("Filed", withPct.map(filedOf), MAG), ser("Approved", withPct.map(function (r) { return num(r.approvedPct) ? r.approvedPct : null; }), TEAL)]
        .filter(function (s) { return s.values.some(num); });
      items.push(header("Indicated, filed and approved rate change, by filing (%)", L, top, lw));
      items.push({ type: "chart", kind: "column", x: L, y: top + HDR, w: lw, h: ch, categories: cats, series: series, legend: "top", gap: 90, overlap: -10, labels: { format: "0.0;(0.0);0.0", size: 10 }, catSize: 10, catLabels: "low", name: "Chart indicated and filed" });
    } else {
      items.push(header("Rate change by filing (%)", L, top, lw));
      items.push({ type: "box", x: L, y: top + HDR, w: lw, h: 1.2, fill: "EEEEF5", margins: [0.2, 0.2, 0.15, 0.15], anchor: "ctr", name: "No indicated change", paras: [{ runs: [{ text: "None of the summarised rate filings states an indicated, filed or approved change.", size: 12, color: NAVY }] }] });
      ch = 1.2;
    }
    var y2 = top + HDR + ch + 0.2;
    var SHOWN = ["indicatedPct", "requestedPct", "approvedPct", "overallPct", "lossCostMultiplier", "lossCostChangePct", "lossTrendPct", "targetLossRatio", "projectedLossRatio", "expensePct", "profitPct"];
    var pageList = function (r) { var p = {}; SHOWN.forEach(function (k) { if (num(r[k]) && r.pages && num(r.pages[k])) p[r.pages[k]] = true; }); if (num(r.page) && [r.requestedPct, r.approvedPct, r.overallPct].some(num)) p[r.page] = true; var a = Object.keys(p).map(Number).sort(function (a, b) { return a - b; }); return a.length ? a.join(", ") : "n/d"; };
    var shown = rows.slice(0, Math.max(1, Math.floor((BOTTOM - y2 - HDR) / 0.25) - 1));
    var tr = shown.map(function (r) {
      var c = function (v) { return num(v) ? pctCell(v) : "n/d"; }, ind = r.indicatedPct, fi = filedOf(r);
      return [flat(r.state) || "n/d", fpDate(f, r.published), num(ind) && num(fi) && ind > fi + 0.05 ? { text: c(ind), color: MAG } : c(ind), c(fi), c(r.approvedPct),
        num(r.lossCostMultiplier) ? r.lossCostMultiplier.toFixed(3) : "n/d", c(r.lossCostChangePct), c(r.lossTrendPct), c(r.targetLossRatio), c(r.projectedLossRatio), c(r.expensePct), c(r.profitPct), flat(r.filingNo) || "n/d", pageList(r)];
    });
    items.push(header("Loss costs and assumptions each filing states (%; LCM a multiplier)" + (num(R.A.total) && R.A.total > shown.length ? " (" + shown.length + " of " + cnt(R.A.total) + ")" : ""), L, y2, W));
    items.push(fpTable("Table adequacy", L, y2 + HDR, W, ["State", "Published", "Indicated", "Filed", "Approved", "LCM", "Loss costs", "Trend", "Target LR", "Projected LR", "Expenses", "Profit", "Filing number", "Pages"], tr,
      [0.55, 1.0, 0.9, 0.62, 0.92, 0.62, 0.95, 0.66, 0.95, 1.12, 0.9, 0.66, 1.8, 1.25], ["l", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "l", "r"], [0, 1, 12, 13], { fit: [12, 13] }));
    items = items.concat(takeaways(pointsOf(t, "adequacy"), LX2, top, RW, y2 - 0.15 - top));
    var refs = rows.filter(function (r) { return r.lossCostRef; }).length;
    items.push(fpSource(f, t, [["As each filing states them (saved summaries made by Claude, with the filing's pages). Magenta: indicated above filed. LCM: loss cost multiplier; LR: loss ratio.",
      "As each filing states them (summaries by Claude). Magenta: indicated above filed. LR: loss ratio.", "Filings' own figures. Magenta: indicated above filed."], refs ? [plural(refs, "filing adopts", "filings adopt") + " advisory loss costs.", ""] : "", [sumNote(f) + ".", ""]]));
    return content(t, "adequacy", "Rate adequacy and loss costs", items);
  }

  // ----- programs and forms -----
  function fpPrograms(f, t) {
    var R = rich(f), G = R.G, items = [], progs = arr(G.programs), forms = arr(G.forms);
    var pRows = progs.slice(0, 6), lw = LW;
    items.push(header("Programs by segment" + (num(G.programsTotal) && G.programsTotal > pRows.length ? " (" + pRows.length + " of " + cnt(G.programsTotal) + ")" : ""), L, TOP, lw));
    if (pRows.length) items.push(fpTable("Table programs", L, TOP + HDR, lw, ["Program", "Segment", "State", "Published", "Filing", "Page"],
      pRows.map(function (p) { return [flat(p.name) || "n/d", p.segment ? flat(p.segment) : "n/d", flat(p.state) || "n/d", fpDate(f, p.published), flat(p.filingNo) || "n/d", num(p.page) ? String(p.page) : "n/d"]; }),
      [2.1, 1.3, 0.55, 1.0, 1.95, 0.55], ["l", "l", "l", "r", "l", "r"], [0, 1, 4, 5], { fit: [0, 1, 4] }));
    else items.push({ type: "box", x: L, y: TOP + HDR, w: lw, h: 0.8, fill: "EEEEF5", margins: [0.2, 0.2, 0.1, 0.1], anchor: "ctr", name: "No programs", paras: [{ runs: [{ text: "The saved summaries name no program.", size: 12, color: NAVY }] }] });
    var ph = pRows.length ? (pRows.length + 1) * 0.25 : 0.8, y2 = Math.max(TOP + HDR + ph + 0.3, 3.4);
    items = items.concat(takeaways(pointsOf(t, "programs"), LX2, TOP, RW, y2 - 0.15 - TOP));
    var fRows = forms.slice(0, Math.max(1, Math.floor((BOTTOM - y2 - HDR) / 0.25) - 1));
    items.push(header("Latest form schedule, newest filing first" + (num(G.formsTotal) && G.formsTotal > fRows.length ? " (" + fRows.length + " of " + cnt(G.formsTotal) + ")" : ""), L, y2, W));
    if (fRows.length) items.push(fpTable("Table forms", L, y2 + HDR, W, ["Form", "Edition", "Title", "Action", "State", "Published", "Filing", "Page"],
      fRows.map(function (x) { return [flat(x.number) || "n/d", flat(x.edition) || "n/d", flat(x.title) || "n/d", x.action ? cap(flat(x.action)) : "n/d", flat(x.state) || "n/d", fpDate(f, x.published), flat(x.filingNo) || "n/d", num(x.page) ? String(x.page) : "n/d"]; }),
      [1.4, 0.85, 3.6, 1.0, 0.6, 1.2, 2.3, 0.6], ["l", "l", "l", "l", "l", "r", "l", "r"], [0, 2, 6, 7], { fit: [0, 1, 2, 6] }));
    else items.push({ type: "box", x: L, y: y2 + HDR, w: W, h: 0.8, fill: "EEEEF5", margins: [0.2, 0.2, 0.1, 0.1], anchor: "ctr", name: "No forms", paras: [{ runs: [{ text: "The saved summaries list no form.", size: 12, color: NAVY }] }] });
    items.push(fpSource(f, t, [["From saved summaries made by Claude, with the filing and page of each item; a segment is Claude's judgement from the filing's words.", "From summaries by Claude; segment is a judgement.", "Summaries by Claude."],
      [plural(G.summaries || 0, "summary", "summaries") + " used.", ""]]));
    return content(t, "programs", "Programs and forms", items);
  }

  // ----- against the market -----
  function fpMarket(f, t) {
    var R = rich(f), M = R.M, rows = arr(M.rows).slice(0, 4), items = [];
    var cov = arr(M.coverage).map(function (c) { return c.state + ": filings published " + longDate(c.from) + " to " + longDate(c.to) + ", " + cnt(c.covered) + " companies in the app's list covered, " + cnt(c.missed) + " not"; }).join("; ");
    items.push({ type: "text", x: L, y: TOP, w: W, h: 0.42, margin: 0, name: "Index coverage", paras: [{ runs: [{ text: "Market index coverage: ", size: 11, bold: true, color: NAVY }, { text: (cov || "n/d") + ". Companies outside the app's list aren't in it, so it isn't the whole market.", size: 11, color: NAVY }] }] });
    var top = TOP + 0.5, ch = 2.15, c1w = 3.6, c2x = L + c1w + 0.3, c2w = LX2 - 0.3 - c2x;
    var cats = rows.map(function (r) { return (flat(r.state) || "n/d") + " " + fitText(flat(r.toi) || "type n/d", 10, 1.4, false); });
    items.push(header("Its share of indexed filings (%)", L, top, c1w));
    items.push({ type: "chart", kind: "bar", x: L, y: top + HDR, w: c1w, h: ch, legend: "none", gap: 50, categories: cats, series: [ser("Share of filings (%)", rows.map(function (r) { return num(r.share) ? Math.round(r.share * 10) / 10 : null; }), NAVY, { pointColors: { 0: MAG } })],
      labels: { format: "0.0" }, catSize: 10, name: "Chart share of filings" });
    items.push(header("Rate change against the index (%)", c2x, top, c2w));
    items.push({ type: "chart", kind: "column", x: c2x, y: top + HDR, w: c2w, h: ch, categories: cats, legend: "top", gap: 60, overlap: -5, catLabels: "low", labels: { format: "0.0;(0.0);0.0", size: 10 }, catSize: 10, name: "Chart rate against index",
      series: [ser("Lower quartile", rows.map(function (r) { return r.market.q1; }), "A6A6BF"), ser("Median", rows.map(function (r) { return r.market.median; }), NAVY),
        ser("Upper quartile", rows.map(function (r) { return r.market.q3; }), BLUE), ser("Its latest", rows.map(function (r) { return r.carrier.latest ? r.carrier.latest.rate : null; }), MAG)].filter(function (s) { return s.values.some(num); }) });
    items = items.concat(takeaways(pointsOf(t, "market"), LX2, top, RW, ch + HDR));
    var y2 = top + HDR + ch + 0.2, star = false;
    var tr = rows.map(function (r) {
      var l = r.carrier.latest; if (l && !l.approved) star = true;
      var rng = num(r.market.lo) ? (r.market.lo === r.market.hi ? pctCell(r.market.lo) : pctCell(r.market.lo) + " to " + pctCell(r.market.hi)) : "n/d";
      return [(flat(r.state) || "n/d") + " " + (flat(r.toi) || ""), monthYear(r.from).replace(/^(\w{3})\w*/, "$1") + " to " + monthYear(r.to).replace(/^(\w{3})\w*/, "$1"), cnt(r.market.filings), cnt(r.market.companies), cnt(r.carrier.filings), num(r.share) ? pctCell(r.share) : "n/d", num(r.rank) ? cnt(r.rank) + " of " + cnt(r.market.companies) : "n/d", rng,
        num(r.market.q1) ? pctCell(r.market.q1) + " to " + pctCell(r.market.q3) : "n/d", num(r.market.median) ? pctCell(r.market.median) : "n/d", l ? pctCell(l.rate) + (l.approved ? "" : "*") : "n/d"];
    });
    items.push(header("Against the index: same state, type of insurance and dates", L, y2, W));
    items.push(fpTable("Table market", L, y2 + HDR, W, ["State and type", "Published", "Filings", "Companies", "Its filings", "Share (%)", "Its rank", "Index range (%)", "Middle half (%)", "Median (%)", "Its latest (%)"], tr,
      [1.45, 2.05, 0.75, 1.0, 0.95, 0.85, 0.8, 1.25, 1.2, 0.9, 1.05], ["l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "r"], [0, 1, 2, 4], { fit: [0, 1] }));
    var cut = rows.some(function (r) { return r.truncated; });
    items.push(fpSource(f, t, [["Index: S&P filings swept into the app's market index; quartiles and median of S&P's overall rate impacts (derived), not weighted by premium.", "Index: the app's market index; quartiles and median (derived).", "Index; median (derived)."],
      star ? ["* Not approved: may be the change asked for.", "* May be as asked."] : "", cut ? "Index rows capped." : ""]));
    return content(t, "market", "Against the market", items);
  }

  // the summary's tiles, with what the saved summaries and the index add in place of the rule and form counts
  function richTiles(f) {
    var R = rich(f), out = [];
    if (num(R.E.latestPremium)) out.push([money(R.E.latestPremium), "Premium the latest rate filings state, summed (derived; not statutory)"]);
    var ind = arr(R.A.rows).filter(function (r) { return num(r.indicatedPct) && (num(r.requestedPct) || num(r.overallPct)); });
    if (ind.length) { var gap = ind.filter(function (r) { return r.indicatedPct > (num(r.requestedPct) ? r.requestedPct : r.overallPct) + 0.05; }).length; out.push([cnt(gap) + " of " + cnt(ind.length), "Rate filings filed below their own indicated change", gap ? MAG : NAVY]); }
    var m0 = arr(R.M.rows)[0];
    if (m0 && num(m0.share)) out.push([pct(m0.share), "Share of indexed " + flat(m0.state) + " " + lower(flat(m0.toi)) + " filings (derived)"]);
    return out;
  }

  function fpSpec(facts, text, opts) {
    var f = facts || {}, t = text || {}, usMap = usMapOf(opts);
    var included = {}; fpPlan(f, opts).forEach(function (r) { included[r.id] = r.included; });
    var make = { summary: fpSummary, rates: fpRates, states: usMap ? function (f, t) { return mapSlide(f, t, "count", usMap); } : fpStates, rateMap: function (f, t) { return mapSlide(f, t, "rate", usMap); },
      exposure: fpExposure, adequacy: fpAdequacy, programs: fpPrograms, market: fpMarket, years: fpYears, forms: fpForms, regulator: fpRegulator, questions: fpQuestions };
    var slides = [fpCover(f, t)];
    FP_SLIDES.slice(1).forEach(function (s) { if (included[s[0]]) slides.push(make[s[0]](f, t)); });
    var day = ymd(f.asOf) ? String(f.asOf).slice(0, 10) : "";
    return { fileName: (slug(fpName(f)) || "filings") + "-filings-profile" + (f.sample ? "-sample" : "") + (day ? "-" + day : "") + ".pptx", slides: slides };
  }

  // opts.skip: ids of slides the reader chose to leave out (the cover always stays)
  function spec(facts, text, opts) {
    var f = facts || {}, t = text || {}, skip = opts && Array.isArray(opts.skip) ? opts.skip : [];
    var included = {}; plan(f).forEach(function (r) { included[r.id] = r.included && (r.id === "cover" || skip.indexOf(r.id) < 0); });
    var make = { summary: summarySlide, premium: premiumSlide, lines: linesSlide, underwriting: underwritingSlide, earnings: earningsSlide, balance: balanceSlide, capital: capitalSlide,
      reserves: reservesSlide, accident: accidentSlide, reinsurance: reinsuranceSlide, filings: filingsSlide, questions: questionsSlide };
    var slides = [coverSlide(f, t)];
    SLIDES.slice(1).forEach(function (s) { if (included[s[0]]) slides.push(make[s[0]](f, t)); });
    var name = slug(entityName(f)) || "company";
    var day = ymd(f.asOf) ? String(f.asOf).slice(0, 10) : "";
    return { fileName: name + "-profile" + (f.sample ? "-sample" : "") + (day ? "-" + day : "") + ".pptx", slides: slides };
  }

  window.SNLProfile = { plan: plan, spec: spec, filingsPlan: fpPlan, filingsSpec: fpSpec, filingsCost: makeCost,
    format: { money: money, millions: millions, pct: pct, pctCell: pctCell, mult: mult, shortDate: shortDate, monthYear: monthYear, trimTitle: trimTitle } };
})();
