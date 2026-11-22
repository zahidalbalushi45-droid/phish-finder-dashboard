/* Phish Finder dashboard - pure logic (no DOM, no network). Tested with node (tests/test.js). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./js-yaml.min.js"));
  else root.DashLib = factory(root.jsyaml);
})(typeof self !== "undefined" ? self : this, function (jsyaml) {
  "use strict";
  var OFFSET = 3; // Asia/Bahrain = UTC+3, no daylight saving
  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var EVERY_OPTIONS = [1, 2, 3, 4, 6, 8, 12];
  var MODES = ["quick", "normal", "full"];

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function parseTime(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
    if (!m) throw new Error("Time must look like 07:00");
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) throw new Error("Time must be between 00:00 and 23:59");
    return { h: h, m: mi };
  }
  function uniqSorted(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }).sort(function (x, y) { return x - y; }); }

  /* cfg: {freq:'daily'|'hours'|'weekdays'|'off', time:'HH:MM' (Bahrain), every:N, days:[0-6 Bahrain, Sun=0]} */
  function buildCron(cfg) {
    var freq = cfg.freq;
    if (freq === "off") return { crons: [], label: "Automatic scans are off" };
    var t = parseTime(cfg.time);
    var uh = t.h - OFFSET, shift = 0;
    if (uh < 0) { uh += 24; shift = -1; }
    if (freq === "daily") {
      return { crons: [t.m + " " + uh + " * * *"], label: "Daily at " + pad(t.h) + ":" + pad(t.m) + " Bahrain time" };
    }
    if (freq === "hours") {
      var n = +cfg.every;
      if (EVERY_OPTIONS.indexOf(n) < 0) throw new Error("Every N hours must be one of " + EVERY_OPTIONS.join(", "));
      var bh = [];
      for (var k = 0; k < 24 / n; k++) bh.push((t.h + k * n) % 24);
      var hs = uniqSorted(bh.map(function (h) { return (h - OFFSET + 24) % 24; }));
      return { crons: [t.m + " " + hs.join(",") + " * * *"],
        label: "Every " + n + " hour" + (n > 1 ? "s" : "") + " from " + pad(t.h) + ":" + pad(t.m) + " Bahrain time" };
    }
    if (freq === "weekdays") {
      var days = uniqSorted((cfg.days || []).map(Number).filter(function (d) { return d >= 0 && d <= 6; }));
      if (!days.length) throw new Error("Pick at least one day");
      var ud = uniqSorted(days.map(function (d) { return (d + shift + 7) % 7; }));
      return { crons: [t.m + " " + uh + " * * " + ud.join(",")],
        label: days.map(function (d) { return DAY_NAMES[d]; }).join(", ") + " at " + pad(t.h) + ":" + pad(t.m) + " Bahrain time" };
    }
    throw new Error("Unknown frequency " + freq);
  }

  function expandField(f, lo, hi) {
    var out = [];
    String(f).split(",").forEach(function (part) {
      var step = 1, m = /^(.*)\/(\d+)$/.exec(part);
      if (m) { part = m[1]; step = +m[2]; }
      var a, b;
      if (part === "*") { a = lo; b = hi; }
      else if (/^\d+-\d+$/.test(part)) { a = +part.split("-")[0]; b = +part.split("-")[1]; }
      else if (/^\d+$/.test(part)) { a = +part; b = m ? hi : a; }
      else throw new Error("Unsupported cron field " + f);
      for (var i = a; i <= b; i += step) out.push(i);
    });
    return uniqSorted(out.map(function (x) { return lo === 0 && hi === 6 && x === 7 ? 0 : x; }));
  }

  /* Reverse of buildCron, for showing the current schedule. Unknown shapes -> freq 'custom'. */
  function parseCron(crons, label) {
    var r = parseCronRaw(crons);
    // "Every N hours" only knows its start time modulo N; the dashboard's comment keeps the exact one.
    var m = /from (\d{2}:\d{2})/.exec(label || "");
    if (r.freq === "hours" && m) {
      var alt = Object.assign({}, r, { time: m[1] });
      try { if (buildCron(alt).crons[0] === buildCron(r).crons[0]) return alt; } catch (e) { /* ignore */ }
    }
    return r;
  }
  function parseCronRaw(crons) {
    crons = (crons || []).filter(Boolean);
    if (!crons.length) return { freq: "off", time: "07:00", every: 6, days: [0, 1, 2, 3, 4] };
    var custom = { freq: "custom", raw: crons, time: "07:00", every: 6, days: [0, 1, 2, 3, 4] };
    if (crons.length !== 1) return custom;
    var p = crons[0].trim().split(/\s+/);
    if (p.length !== 5 || p[2] !== "*" || p[3] !== "*" || !/^\d+$/.test(p[0])) return custom;
    var mi = +p[0], hours, dows;
    try { hours = expandField(p[1], 0, 23); dows = p[4] === "*" ? null : expandField(p[4], 0, 6); } catch (e) { return custom; }
    if (hours.length === 1) {
      var bh = hours[0] + OFFSET, shift = 0;
      if (bh >= 24) { bh -= 24; shift = 1; }
      var time = pad(bh) + ":" + pad(mi);
      if (!dows) return { freq: "daily", time: time, every: 6, days: [0, 1, 2, 3, 4] };
      if (dows.length === 7) return { freq: "daily", time: time, every: 6, days: [0, 1, 2, 3, 4] };
      return { freq: "weekdays", time: time, every: 6, days: uniqSorted(dows.map(function (d) { return (d + shift) % 7; })) };
    }
    if (dows) return custom;
    var bhs = uniqSorted(hours.map(function (h) { return (h + OFFSET) % 24; }));
    var n = 24 / bhs.length;
    if (EVERY_OPTIONS.indexOf(n) < 0) return custom;
    for (var s = 0; s < bhs.length; s++) {
      var ok = true;
      for (var k = 0; k < bhs.length; k++) if (bhs.indexOf((bhs[s] + k * n) % 24) < 0) ok = false;
      if (ok) return { freq: "hours", time: pad(bhs[0]) + ":" + pad(mi), every: n, days: [0, 1, 2, 3, 4] };
    }
    return custom;
  }

  function lineIndent(l) { return l.length - l.replace(/^\s+/, "").length; }

  /* Find the schedule block inside `on:` of a workflow file. */
  function findSchedule(text) {
    var lines = text.split("\n");
    var onIdx = -1;
    for (var i = 0; i < lines.length; i++) if (/^(on|"on"|'on'):\s*(#.*)?$/.test(lines[i])) { onIdx = i; break; }
    if (onIdx < 0) throw new Error("Workflow file has no 'on:' block");
    var start = -1, end = -1;
    for (var j = onIdx + 1; j < lines.length; j++) {
      var l = lines[j];
      if (l.trim() && lineIndent(l) === 0 && !/^#/.test(l)) break; // end of on:
      if (/^  schedule:\s*(#.*)?$/.test(l)) { start = j; break; }
    }
    if (start >= 0) {
      end = lines.length;
      for (var k = start + 1; k < lines.length; k++) {
        if (lines[k].trim() && lineIndent(lines[k]) <= 2) { end = k; break; }
      }
      while (end - 1 > start && !lines[end - 1].trim()) end--; // keep blank lines outside
    }
    var crons = [];
    if (start >= 0) for (var c = start + 1; c < end; c++) {
      var m = /^\s*-\s*cron:\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(lines[c]);
      if (m) crons.push(m[1].trim());
    }
    return { lines: lines, onIdx: onIdx, start: start, end: end, crons: crons };
  }

  function readSchedule(text) { return findSchedule(text).crons; }
  function readScheduleLabel(text) {
    var f = findSchedule(text);
    if (f.start < 0) return "";
    for (var i = f.start + 1; i < f.end; i++) { var m = /^\s*#\s*(.*)$/.exec(f.lines[i]); if (m) return m[1]; }
    return "";
  }

  function rewriteSchedule(text, crons, label) {
    var f = findSchedule(text), lines = f.lines.slice();
    var block = [];
    if (crons.length) {
      block.push("  schedule:");
      block.push("    # " + String(label || "").replace(/[\r\n]/g, " ") + " (set from the dashboard)");
      crons.forEach(function (c) { block.push('    - cron: "' + c + '"'); });
    }
    if (f.start >= 0) lines.splice(f.start, f.end - f.start, ...block);
    else if (block.length) lines.splice(f.onIdx + 1, 0, ...block);
    return lines.join("\n");
  }

  /* Minimal cron matcher (UTC) to show the next scheduled times. */
  function nextRuns(crons, fromDate, count) {
    var specs = (crons || []).map(function (c) {
      var p = c.trim().split(/\s+/);
      return { m: expandField(p[0], 0, 59), h: expandField(p[1], 0, 23), dom: p[2], d: expandField(p[2], 1, 31),
        mon: expandField(p[3], 1, 12), dowStar: p[4] === "*", dow: expandField(p[4], 0, 6) };
    });
    var out = [];
    if (!specs.length) return out;
    var t = new Date(Math.floor(fromDate.getTime() / 60000) * 60000 + 60000);
    for (var i = 0; i < 60 * 24 * 32 && out.length < (count || 3); i++, t = new Date(t.getTime() + 60000)) {
      for (var s = 0; s < specs.length; s++) {
        var sp = specs[s];
        if (sp.m.indexOf(t.getUTCMinutes()) < 0 || sp.h.indexOf(t.getUTCHours()) < 0 || sp.mon.indexOf(t.getUTCMonth() + 1) < 0) continue;
        var domOk = sp.d.indexOf(t.getUTCDate()) >= 0, dowOk = sp.dow.indexOf(t.getUTCDay()) >= 0;
        var dayOk = sp.dom === "*" ? dowOk : (sp.dowStar ? domOk : (domOk || dowOk));
        if (dayOk) { out.push(new Date(t)); break; }
      }
    }
    return out;
  }

  function runsPerMonth(crons) {
    var from = new Date(Date.UTC(2026, 0, 1)), n = 0;
    nextRuns(crons, from, 2000).forEach(function (d) { if (d < new Date(Date.UTC(2026, 0, 31))) n++; });
    return n;
  }

  /* ---------- brands.yml (same canonical layout as tools/brands_cfg.py) ---------- */
  var HEADER = [
    "# Brands scanned by the scheduled GitHub Action (and by tools/ci_scan.py).",
    "# Easiest way to change this file: the Phish Finder dashboard, or the",
    '# "Manage brands" workflow in the GitHub app (Actions tab -> Manage brands).',
    "#",
    "#   Required:  name, domain",
    "#   Optional:  official  - other domains the brand owns (comma-separated)",
    "#              keywords  - extra search words (comma-separated)",
    '#              ignore    - hosts marked "false positive" (never reported again)',
    "#              country   - 2-letter code (auto-detected from a ccTLD otherwise)",
    "#              days      - override the mode's look-back window for this brand",
    "#              enabled   - false = keep the brand but skip it in scheduled scans",
    "#   settings.mode - depth of scheduled scans: quick / normal / full"
  ].join("\n");
  var FIELD_ORDER = ["name", "domain", "official", "keywords", "ignore", "country", "days", "enabled"];
  var RESERVED = ["y", "yes", "n", "no", "true", "false", "on", "off", "null", "nil", "none"];

  function csv(v) {
    if (v === null || v === undefined || v === false) return "";
    var parts = Array.isArray(v) ? v.map(String) : String(v).split(",");
    return parts.map(function (s) { return s.trim(); }).filter(Boolean).join(", ");
  }
  function isEnabled(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === "boolean") return v;
    return ["false", "no", "off", "0", "n", "disabled"].indexOf(String(v).trim().toLowerCase()) < 0;
  }
  function scalar(v) {
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number" && Number.isInteger(v)) return String(v);
    var s = String(v);
    if (/^[A-Za-z][A-Za-z0-9 ._,\/-]*$/.test(s) && s === s.trim() && RESERVED.indexOf(s.toLowerCase()) < 0) return s;
    return JSON.stringify(s);
  }
  function cleanDomain(d) {
    d = String(d || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, "");
    if (d.indexOf("www.") === 0) d = d.slice(4);
    return d;
  }
  function validDomain(d) { return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(d); }
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

  function parseBrands(text) {
    var data = jsyaml.load(text || "") || {};
    if (Array.isArray(data)) data = { brands: data };
    if (typeof data !== "object") throw new Error("brands.yml must be a mapping with a 'brands' list");
    var brands = data.brands || [];
    if (!Array.isArray(brands)) throw new Error("'brands' must be a list");
    var settings = data.settings && typeof data.settings === "object" ? data.settings : {};
    return { settings: settings, brands: brands.filter(function (b) { return b && typeof b === "object"; }) };
  }

  function normaliseBrand(b) {
    var out = {};
    out.name = String(b.name || "").trim();
    out.domain = String(b.domain || "").trim().toLowerCase();
    ["official", "keywords", "ignore"].forEach(function (k) { var v = csv(b[k]); if (v) out[k] = v; });
    if (b.country === false) b = Object.assign({}, b, { country: "no" });
    if (b.country !== null && b.country !== undefined && b.country !== "") out.country = String(b.country).trim().toLowerCase();
    if (b.days !== null && b.days !== undefined && b.days !== "") { var d = parseInt(b.days, 10); if (!isNaN(d)) out.days = d; }
    if (!isEnabled(b.enabled)) out.enabled = false;
    Object.keys(b).forEach(function (k) {
      if (FIELD_ORDER.indexOf(k) < 0 && ["string", "number", "boolean"].indexOf(typeof b[k]) >= 0) out[k] = b[k];
    });
    return out;
  }

  function dumpBrands(cfg) {
    var lines = [HEADER, ""];
    var mode = String((cfg.settings || {}).mode || "normal").trim().toLowerCase();
    if (MODES.indexOf(mode) < 0) mode = "normal";
    lines.push("settings:", "  mode: " + mode, "");
    var brands = (cfg.brands || []).map(normaliseBrand);
    if (!brands.length) lines.push("brands: []");
    else {
      lines.push("brands:");
      brands.forEach(function (b) {
        var keys = FIELD_ORDER.filter(function (k) { return k in b; }).concat(Object.keys(b).filter(function (k) { return FIELD_ORDER.indexOf(k) < 0; }));
        keys.forEach(function (k, i) { lines.push((i === 0 ? "  - " : "    ") + k + ": " + scalar(b[k])); });
        lines.push("");
      });
    }
    return lines.join("\n").replace(/\n+$/, "") + "\n";
  }

  /* Validate + build a brand object from form values. Returns {brand} or throws. */
  function brandFromForm(f, existing, others) {
    var name = String(f.name || "").trim();
    if (!name) throw new Error("Give the brand a name");
    var domain = cleanDomain(f.domain);
    if (!validDomain(domain)) throw new Error("Main domain should look like examplebank.com");
    var official = csv(f.official).split(",").map(function (x) { return cleanDomain(x); }).filter(Boolean);
    var bad = official.filter(function (d) { return !validDomain(d); });
    if (bad.length) throw new Error("Not a domain: " + bad.join(", "));
    var country = String(f.country || "").trim().toLowerCase();
    if (country && !/^[a-z]{2}$/.test(country)) throw new Error("Country should be a 2-letter code like bh, sa, eg");
    (others || []).forEach(function (o) {
      if (slug(o.name) === slug(name)) throw new Error("There is already a brand called " + o.name);
    });
    var b = Object.assign({}, existing || {});
    b.name = name; b.domain = domain;
    if (official.length) b.official = official.join(", "); else delete b.official;
    var kw = csv(f.keywords); if (kw) b.keywords = kw; else delete b.keywords;
    if (country) b.country = country; else delete b.country;
    if (f.enabled === false) b.enabled = false; else delete b.enabled;
    return b;
  }

  function csvList(v) { return csv(v).split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function addToList(v, item) { var l = csvList(v); if (l.indexOf(item) < 0) l.push(item); return l.join(", "); }
  function removeFromList(v, item) { return csvList(v).filter(function (x) { return x !== item; }).join(", "); }

  /* Spreadsheet-safe CSV (formula injection guarded). */
  function toCSV(rows, cols) {
    function cell(v) {
      var s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    return [cols.map(function (c) { return cell(c.label); }).join(",")].concat(rows.map(function (r) {
      return cols.map(function (c) { return cell(typeof c.get === "function" ? c.get(r) : r[c.key]); }).join(",");
    })).join("\r\n") + "\r\n";
  }

  function takedownText(f, brand) {
    var lines = [
      "Hello,",
      "",
      "The website below is impersonating " + brand.name + (brand.domain ? " (official site: " + brand.domain + ")" : "") +
        " and appears to be used for phishing / fraud against its customers. Please investigate and suspend it.",
      "",
      "URL: " + (f.url || ("https://" + f.host)),
    ];
    if (f.feed_url && f.feed_url !== f.url) lines.push("Also seen at: " + f.feed_url);
    if (f.ip) lines.push("IP address: " + f.ip + (f.hosting ? " (" + f.hosting + ")" : ""));
    if (f.registrar) lines.push("Registrar: " + f.registrar + (f.created ? ", registered " + f.created : ""));
    if ((f.reasons || []).length) {
      lines.push("", "Evidence:");
      f.reasons.forEach(function (r) { lines.push("- " + String(r).replace(/^[+-]\d+\s*/, "")); });
    }
    lines.push("", "Thank you.");
    return { subject: "Phishing site impersonating " + brand.name + ": " + f.host, body: lines.join("\n") };
  }

  /* ---------- misc ---------- */
  function b64EncodeUtf8(s) {
    var bytes = new TextEncoder().encode(s), bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64DecodeUtf8(b) {
    var bin = atob(String(b).replace(/\s+/g, "")), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function safeUrl(u) {
    try { var x = new URL(String(u)); return x.protocol === "http:" || x.protocol === "https:" ? x.href : ""; } catch (e) { return ""; }
  }
  function fmtBahrain(iso, withDay) {
    if (!iso) return "";
    var d = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(d)) return "";
    var opts = { timeZone: "Asia/Bahrain", hour: "2-digit", minute: "2-digit", hour12: false, day: "numeric", month: "short" };
    if (withDay) opts.weekday = "short";
    return new Intl.DateTimeFormat("en-GB", opts).format(d) + " Bahrain";
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + "m " + (s ? s + "s" : "");
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  /* Tiny ZIP reader for the artifact (stored or deflate entries). inflateRaw: async (Uint8Array)->Uint8Array */
  function zipEntries(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a zip file");
    var n = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true), out = [];
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error("Bad zip directory");
      var method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
      var nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
      var dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      out.push({ name: name, method: method, data: u8.subarray(dataStart, dataStart + csize) });
      off += 46 + nlen + xlen + clen;
    }
    return out;
  }

  return {
    OFFSET: OFFSET, DAY_NAMES: DAY_NAMES, EVERY_OPTIONS: EVERY_OPTIONS, MODES: MODES,
    buildCron: buildCron, parseCron: parseCron, readSchedule: readSchedule, readScheduleLabel: readScheduleLabel, rewriteSchedule: rewriteSchedule,
    nextRuns: nextRuns, runsPerMonth: runsPerMonth,
    parseBrands: parseBrands, dumpBrands: dumpBrands, normaliseBrand: normaliseBrand, brandFromForm: brandFromForm,
    isEnabled: isEnabled, csv: csv, csvList: csvList, addToList: addToList, removeFromList: removeFromList,
    toCSV: toCSV, takedownText: takedownText, cleanDomain: cleanDomain, validDomain: validDomain, slug: slug,
    b64EncodeUtf8: b64EncodeUtf8, b64DecodeUtf8: b64DecodeUtf8, safeUrl: safeUrl,
    fmtBahrain: fmtBahrain, fmtDuration: fmtDuration, zipEntries: zipEntries
  };
});
