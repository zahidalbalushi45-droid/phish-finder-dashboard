/* Phish Finder dashboard - UI + GitHub REST calls. All data is read live from the private repo. */
(function () {
  "use strict";
  var L = window.DashLib;
  var API = "https://api.github.com";
  var WORKFLOW = "phish-scan.yml";
  var WORKFLOW_PATH = ".github/workflows/" + WORKFLOW;
  var BRANDS_PATH = "brands.yml";
  var TRIAGE_PATH = "triage.json";
  var LS_TOKEN = "pf.token", LS_REPO = "pf.repo", LS_SEEN = "pf.seenRun";
  var FREE_MINUTES = 2000;
  var VIEWS = ["home", "findings", "brands", "brand", "schedule", "runs"];
  var DEMO = /(?:^|[?&])demo=1(?:&|$)/.test(location.search);
  var STATUSES = [
    { id: "open", label: "Open", icon: "●" },
    { id: "reviewing", label: "Reviewing", icon: "👀" },
    { id: "reported", label: "Reported", icon: "📨" },
    { id: "taken_down", label: "Taken down", icon: "✅" },
    { id: "false_positive", label: "False positive", icon: "🚫" },
    { id: "ours", label: "Ours (official)", icon: "🏠" }
  ];
  var CLOSED = ["taken_down", "false_positive", "ours"];

  var S = { repo: "", token: "", user: "", cfg: null, wf: "", summary: null, history: [], runs: [], jobs: {}, triage: { hosts: {} },
    sched: null, pollTimer: null, lastLoad: 0, filter: { q: "", brand: "", status: "action", sort: "score", chips: {} }, shown: 60 };

  /* ---------- DOM helpers (data is only ever set as text) ---------- */
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  function link(url, text, cls) {
    var u = L.safeUrl(url);
    return u ? h("a", { href: u, target: "_blank", rel: "noopener noreferrer nofollow", class: cls || null, text: text || u, onclick: function (e) { e.stopPropagation(); } }) : h("span", { text: text || url || "" });
  }
  function mailLink(to, subject, body, text) {
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(to || "")) return null;
    return h("a", { href: "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body), text: text, onclick: function (e) { e.stopPropagation(); } });
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function msg(el, text, kind) { el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }
  var toastTimer;
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3800); }
  function svg(tag, attrs) { var e = document.createElementNS("http://www.w3.org/2000/svg", tag); Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function ago(iso) {
    var s = (Date.now() - new Date(iso)) / 1000;
    if (!(s >= 0)) return "";
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch (e) { var ta = h("textarea", {}); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copied"); } catch (e2) { toast("Copy failed"); } ta.remove(); }
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = h("a", { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function busy(on) { $("syncDot").className = "sync " + (on ? "busy" : "live"); }

  /* ---------- GitHub API ---------- */
  function friendly(status, data, path) {
    var m = (data && data.message) || "";
    path = path || "";
    if (status === 401) return "Your GitHub key is wrong or has expired. Connect again with a new key.";
    if (status === 403 && /rate limit/i.test(m)) return "GitHub is rate-limiting requests. Try again in a few minutes.";
    if (status === 403 || (status === 404 && /actions/.test(path))) {
      if (/\.github\/workflows/.test(path) || /workflow/i.test(m)) return "Your key needs “Workflows: Read and write” to change the schedule. Edit the key on GitHub (Settings → Developer settings → Fine-grained tokens) and add it.";
      if (/actions/.test(path)) return "Your key needs “Actions: Read and write”. Edit the key on GitHub and add it.";
      return "Your key does not have permission for this (needs Contents, Actions and Workflows = Read and write on this repo).";
    }
    if (status === 404) return "Not found. Check the repository name and that the key includes this repository.";
    if (status === 409) return "The file changed at the same time. Please try again.";
    if (status === 422) return "GitHub rejected the request: " + m;
    return "GitHub error " + status + (m ? ": " + m : "");
  }
  async function api(path, opts) {
    opts = opts || {};
    var headers = { "Accept": opts.accept || "application/vnd.github+json", "Authorization": "Bearer " + S.token, "X-GitHub-Api-Version": "2022-11-28" };
    if (opts.body) headers["Content-Type"] = "application/json";
    var res;
    try { res = await fetch(API + path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store" }); }
    catch (e) { var ne = new Error("No connection to GitHub. Check your internet and try again."); ne.status = 0; throw ne; }
    if (res.status === 204) return null;
    var txt = await res.text(), data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!res.ok) { var err = new Error(friendly(res.status, data, path)); err.status = res.status; err.data = data; throw err; }
    return data;
  }
  function repoPath(p) { return "/repos/" + S.repo + p; }
  async function getFile(path, ref) {
    try {
      var d = await api(repoPath("/contents/" + path + (ref ? "?ref=" + encodeURIComponent(ref) : "")));
      if (!d || d.type !== "file") return null;
      var text = d.content ? L.b64DecodeUtf8(d.content) : "";
      if (!d.content && d.size > 0) text = await api(repoPath("/contents/" + path + "?ref=" + encodeURIComponent(ref || "main")), { accept: "application/vnd.github.raw+json" }).then(function (x) { return typeof x === "string" ? x : JSON.stringify(x); });
      return { text: text, sha: d.sha };
    } catch (e) { if (e.status === 404) return null; throw e; }
  }
  async function putFile(path, text, sha, message) {
    var body = { message: message, content: L.b64EncodeUtf8(text), branch: "main" };
    if (sha) body.sha = sha;
    return api(repoPath("/contents/" + path), { method: "PUT", body: body });
  }
  /* Read-modify-write with one retry if the file changed meanwhile. */
  async function changeFile(path, parse, dump, mutate, message) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var f = await getFile(path, "main");
      var obj = parse(f ? f.text : null);
      mutate(obj);
      try { await putFile(path, dump(obj), f && f.sha, message); return obj; }
      catch (e) { if ((e.status === 409 || e.status === 422) && attempt < 2) continue; throw e; }
    }
  }
  async function changeBrands(mutate, message) {
    busy(true);
    try { S.cfg = await changeFile(BRANDS_PATH, function (t) { return L.parseBrands(t || "brands: []\n"); }, L.dumpBrands, mutate, message); }
    finally { busy(false); }
    renderAll();
  }
  async function changeTriage(mutate, message) {
    busy(true);
    try {
      S.triage = await changeFile(TRIAGE_PATH, function (t) { var o; try { o = t ? JSON.parse(t) : {}; } catch (e) { o = {}; } o.hosts = o.hosts || {}; return o; },
        function (o) { return JSON.stringify(o, null, 1) + "\n"; }, mutate, message);
    } finally { busy(false); }
    renderAll();
  }
  async function dispatchScan(brand, mode) {
    var inputs = { mode: mode || "default" };
    if (brand) inputs.brand = brand;
    await api(repoPath("/actions/workflows/" + WORKFLOW + "/dispatches"), { method: "POST", body: { ref: "main", inputs: inputs } });
    [3000, 8000, 15000].forEach(function (t) { setTimeout(loadRuns, t); });
  }

  /* ---------- connect ---------- */
  function defaultRepo() {
    var q = new URLSearchParams(location.search).get("repo");
    if (q) return q;
    var m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    return m ? m[1] + "/phish-finder" : "";
  }
  function tokenUrl(owner, repoName) {
    var p = new URLSearchParams({
      name: "Phish Finder dashboard",
      description: "Phish Finder dashboard. Repository access: only " + (repoName || "phish-finder") + ".",
      expires_in: "366", contents: "write", actions: "write", workflows: "write", metadata: "read"
    });
    if (owner) p.set("target_name", owner);
    return "https://github.com/settings/personal-access-tokens/new?" + p.toString();
  }
  function syncRepoHints() {
    var repo = $("repoInput").value.trim(), parts = repo.split("/");
    $("tokenLink").href = tokenUrl(parts[0], parts[1]);
    $("repoNameStep").textContent = parts[1] || "phish-finder";
    $("repoShow").textContent = repo || "not set";
  }
  function showConnect(text) {
    $("connect").hidden = false; $("tabs").hidden = true; $("refreshBtn").hidden = true;
    VIEWS.forEach(function (v) { $(v).hidden = true; });
    $("repoInput").value = localStorage.getItem(LS_REPO) || defaultRepo();
    syncRepoHints();
    $("repoLabel").textContent = "";
    $("syncDot").className = "sync";
    if (!$("repoInput").value) $("connect").querySelector("details").open = true;
    msg($("connectMsg"), text || "", text ? "err" : "");
  }
  $("repoInput").addEventListener("input", syncRepoHints);
  $("tokenInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("connectBtn").click(); });
  $("connectBtn").addEventListener("click", async function () {
    var repo = $("repoInput").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    var token = $("tokenInput").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { $("connect").querySelector("details").open = true; return msg($("connectMsg"), "Repository should look like owner/phish-finder", "err"); }
    if (!token) return msg($("connectMsg"), "Paste your GitHub key first", "err");
    if (/^gh[pousr]_/.test(token) === false && token.indexOf("github_pat_") !== 0) return msg($("connectMsg"), "That doesn't look like a GitHub key (it should start with github_pat_).", "err");
    S.repo = repo; S.token = token;
    this.disabled = true; msg($("connectMsg"), "Checking…");
    try {
      await verify();
      localStorage.setItem(LS_REPO, repo); localStorage.setItem(LS_TOKEN, token);
      $("tokenInput").value = ""; msg($("connectMsg"), "");
      start();
      toast("Connected ✓");
    } catch (e) { msg($("connectMsg"), e.message, "err"); S.token = ""; }
    finally { this.disabled = false; }
  });
  async function verify() {
    var r = await api(repoPath(""));
    S.repoInfo = r;
    var p = r.permissions || {};
    if (p.push === false) throw new Error("This key can only read the repo. It needs Contents = Read and write.");
    try { var u = await api("/user"); S.user = u.login; } catch (e) { S.user = r.owner && r.owner.login; }
    return r;
  }
  $("disconnectBtn").addEventListener("click", function () {
    if (!confirm("Remove the GitHub key from this device? You can connect again any time.")) return;
    localStorage.removeItem(LS_TOKEN); S.token = "";
    clearInterval(S.pollTimer);
    showConnect("");
  });

  /* ---------- navigation ---------- */
  function parseHash() {
    var raw = (location.hash || "#home").replace(/^#/, "");
    if (raw.indexOf("brand/") === 0) return { view: "brand", slug: raw.slice(6) };
    return { view: VIEWS.indexOf(raw) >= 0 ? raw : "home", slug: "" };
  }
  function go(view, keepScroll, slug) {
    if (view === "brand") {
      slug = slug || S.brandSlug;
      if (!slug) view = "brands";
      else S.brandSlug = slug;
    }
    VIEWS.forEach(function (v) { if ($(v)) $(v).hidden = v !== view; });
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) {
      b.classList.toggle("on", b.dataset.view === view || (view === "brand" && b.dataset.view === "brands"));
    });
    var hash = (view === "brand" && S.brandSlug) ? "brand/" + S.brandSlug : view;
    var suffix = DEMO ? (location.search || "?demo=1") : location.search;
    if (location.hash !== "#" + hash) history.replaceState(null, "", suffix + "#" + hash);
    if (!keepScroll) window.scrollTo(0, 0);
    if (view === "brand") renderBrandPage();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) { b.addEventListener("click", function () { go(b.dataset.view); }); });
  window.addEventListener("hashchange", function () {
    var parsed = parseHash();
    if (parsed.slug) S.brandSlug = parsed.slug;
    go(parsed.view, true, parsed.slug);
  });
  $("refreshBtn").addEventListener("click", function () { loadAll(true); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && S.token && Date.now() - S.lastLoad > 60000) loadAll(false); });

  async function start() {
    $("connect").hidden = true; $("tabs").hidden = false; $("refreshBtn").hidden = false;
    $("repoLabel").textContent = S.repo + (S.repoInfo && S.repoInfo.private === false ? " · ⚠ PUBLIC" : " · private");
    if (S.repoInfo && S.repoInfo.private === false) toast("Warning: this repository is PUBLIC. Make it private in GitHub settings.");
    var parsed = parseHash();
    if (parsed.slug) S.brandSlug = parsed.slug;
    go(parsed.view, false, parsed.slug);
    renderSettings();
    await loadAll(false);
    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(function () { if (!document.hidden && anyActive()) loadRuns(); }, 15000);
  }
  function anyActive() { return S.runs.some(function (r) { return r.status !== "completed"; }); }

  async function loadAll(manual) {
    busy(true); S.lastLoad = Date.now();
    var res = await Promise.allSettled([loadConfig(), loadData(), loadRuns()]);
    busy(false);
    var bad = res.filter(function (r) { return r.status === "rejected"; });
    if (bad.length) {
      var e = bad[0].reason;
      if (e && e.status === 401) { localStorage.removeItem(LS_TOKEN); return showConnect(e.message); }
      toast((e && e.message) || String(e));
      $("syncDot").className = "sync";
    } else if (manual) toast("Up to date");
  }
  async function loadConfig() {
    var r = await Promise.all([getFile(BRANDS_PATH, "main"), getFile(WORKFLOW_PATH, "main"), getFile(TRIAGE_PATH, "main")]);
    S.cfg = L.parseBrands(r[0] ? r[0].text : "brands: []\n");
    S.wf = r[1] ? r[1].text : "";
    try { S.triage = r[2] ? JSON.parse(r[2].text) : { hosts: {} }; } catch (e) { S.triage = { hosts: {} }; }
    S.triage.hosts = S.triage.hosts || {};
    initSchedule(); renderAll();
  }
  async function loadData() {
    var r = await Promise.all([getFile("dashboard/summary.json", "state"), getFile("dashboard/history.json", "state")]);
    try { S.summary = r[0] ? JSON.parse(r[0].text) : null; } catch (e) { S.summary = null; }
    try { S.history = r[1] ? JSON.parse(r[1].text) : []; } catch (e) { S.history = []; }
    renderAll();
  }
  async function loadRuns() {
    var d = await api(repoPath("/actions/workflows/" + WORKFLOW + "/runs?per_page=20"));
    var before = S.runs.filter(function (r) { return r.status !== "completed"; }).map(function (r) { return r.id; });
    S.runs = d.workflow_runs || [];
    var active = S.runs.filter(function (r) { return r.status !== "completed"; });
    await Promise.all(active.slice(0, 3).map(function (r) {
      return api(repoPath("/actions/runs/" + r.id + "/jobs")).then(function (j) { S.jobs[r.id] = (j.jobs || [])[0]; }).catch(function () { });
    }));
    renderRuns(); renderLive(); previewSched();
    if (S.runs.some(function (r) { return before.indexOf(r.id) >= 0 && r.status === "completed"; })) {
      toast("A scan just finished – loading results"); setTimeout(loadData, 2500);
    }
  }

  /* ---------- derived data ---------- */
  function brands() { return (S.cfg && S.cfg.brands) || []; }
  function brandBySlug(slug) { return brands().find(function (b) { return L.slug(b.name) === slug; }); }
  function settingsMode() { var m = S.cfg && S.cfg.settings && S.cfg.settings.mode; return L.MODES.indexOf(m) >= 0 ? m : "normal"; }
  function statusOf(f) {
    var b = brandBySlug(f.brandSlug);
    if (b) {
      if (L.csvList(b.ignore).some(function (x) { return x === f.host || x === f.reg; })) return "false_positive";
      if (L.csvList(b.official).some(function (x) { return f.host === x || f.host.slice(-(x.length + 1)) === "." + x; })) return "ours";
    }
    var t = S.triage.hosts[f.host];
    return (t && t.status) || "open";
  }
  function allFindings() {
    var out = [];
    ((S.summary && S.summary.brands) || []).forEach(function (b) {
      (b.top || []).forEach(function (f) {
        var x = Object.assign({}, f, { brand: b.name, brandSlug: b.slug, brandDomain: b.domain, run_id: b.run_id, scanned: b.generated_utc });
        x.reg = x.reg || x.host; x.flags = x.flags || [];
        x.st = statusOf(x);
        out.push(x);
      });
    });
    return out;
  }
  function isCritHigh(f) { return f.severity === "critical" || f.severity === "high"; }
  function needsAction(f) { return f.st === "open" || f.st === "reviewing"; }
  function hasLogin(f) { return f.flags.indexOf("password") >= 0 || f.flags.indexOf("sensitive") >= 0 || (f.reasons || []).some(function (r) { return /login|password|otp|card/i.test(r); }); }

  function renderAll() {
    if (!S.cfg) return;
    renderTiles(); renderAttention(); renderScanForm(); renderResults(); renderFindings(); renderBrands(); renderRuns(); renderSettings(); if (!$("brand").hidden) renderBrandPage();
  }

  /* ---------- Home ---------- */
  function renderTiles() {
    var box = clear($("tiles")), fs = allFindings();
    var open = fs.filter(function (f) { return needsAction(f) && isCritHigh(f); }).length;
    var lr = S.summary && S.summary.last_run;
    var newCount = fs.filter(function (f) { return f.is_new && needsAction(f); }).length;
    var live = fs.filter(function (f) { return f.live && needsAction(f) && f.flags.indexOf("parked") < 0 && f.flags.indexOf("down") < 0; }).length;
    var active = brands().filter(function (b) { return L.isEnabled(b.enabled); }).length;
    function tile(n, l, cls, onclick) { return h("button", { class: "tile " + (cls || ""), onclick: onclick }, h("div", { class: "n", text: String(n) }), h("div", { class: "l", text: l })); }
    box.appendChild(tile(open, "Critical / high to act on", open ? "red" : "green", function () { setFilter({ status: "action", chips: { crit: true } }); }));
    box.appendChild(tile(newCount, "New since last scan", newCount ? "blue" : "", function () { setFilter({ status: "action", chips: { "new": true } }); }));
    box.appendChild(tile(live, "Live suspicious sites", "", function () { setFilter({ status: "action", chips: { live: true } }); }));
    box.appendChild(tile(active + "/" + brands().length, "Brands monitored", "", function () { go("brands"); }));
    var nb = $("badgeFindings"); nb.hidden = !open; nb.textContent = open > 99 ? "99+" : String(open);
    $("updatedLine").textContent = S.summary ? "Updated " + ago(S.summary.updated_utc) : "";
    void lr;
  }
  function renderAttention() {
    var box = clear($("attention"));
    var fs = allFindings().filter(function (f) { return needsAction(f) && isCritHigh(f); }).sort(function (a, b) { return (b.score - a.score) || (b.is_new - a.is_new); });
    if (!S.summary) return;
    var card = h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", { text: fs.length ? "Needs attention" : "All clear" }), fs.length ? h("button", { class: "small", onclick: function () { setFilter({ status: "action", chips: { crit: true } }); } }, "See all " + fs.length + " →") : null));
    if (!fs.length) card.appendChild(h("p", { class: "muted small", text: "No open critical or high findings. Nice." }));
    fs.slice(0, 5).forEach(function (f) { card.appendChild(findingRow(f, true)); });
    box.appendChild(card);
  }
  function renderScanForm() {
    var sel = $("scanBrand"), prev = sel.value;
    clear(sel).appendChild(h("option", { value: "", text: "All active brands" }));
    brands().forEach(function (b) { sel.appendChild(h("option", { value: b.name, text: b.name + (L.isEnabled(b.enabled) ? "" : " (paused)") })); });
    sel.value = prev;
    if (!$("scanMode").dataset.touched) $("scanMode").value = settingsMode();
    var crons = L.readSchedule(S.wf || "");
    var nx = crons.length ? L.nextRuns(crons, new Date(), 1)[0] : null;
    $("nextScanLine").textContent = nx ? "Next auto: " + L.fmtBahrain(nx, true) : "Auto scans off";
  }
  $("scanMode").addEventListener("change", function () { this.dataset.touched = "1"; });
  $("scanBtn").addEventListener("click", async function () {
    var b = $("scanBrand").value, m = $("scanMode").value;
    this.disabled = true; msg($("scanMsg"), "Starting…");
    try {
      await dispatchScan(b, m);
      msg($("scanMsg"), "Started: " + (b || "all active brands") + " · " + m + ". Progress shows above in a few seconds.", "ok");
    } catch (e) { msg($("scanMsg"), e.message, "err"); }
    finally { this.disabled = false; }
  });

  function sevBar(sev, total) {
    var bar = h("div", { class: "bar", title: "Severity mix" });
    if (!total) return bar;
    [["critical", "c"], ["high", "h"], ["medium", "m"], ["low", "lo"]].forEach(function (p) {
      var n = (sev && sev[p[0]]) || 0; if (n) bar.appendChild(h("span", { class: p[1], style: "width:" + (100 * n / total).toFixed(2) + "%" }));
    });
    return bar;
  }
  function sevPills(sev) {
    return ["critical", "high", "medium", "low"].filter(function (s) { return sev && sev[s]; }).map(function (s) { return h("span", { class: "pill sev-" + s, text: sev[s] + " " + s }); });
  }
  function sparkline(slug) {
    var pts = (S.history || []).slice().reverse().map(function (r) { var b = (r.brands || []).find(function (x) { return (x.slug || L.slug(x.name)) === slug; }); return b && b.findings !== null && b.findings !== undefined ? b.findings : null; }).filter(function (x) { return x !== null; }).slice(-20);
    if (pts.length < 3) return null;
    var w = 96, hh = 28, max = Math.max.apply(null, pts), min = Math.min.apply(null, pts), rng = Math.max(1, max - min);
    var d = pts.map(function (v, i) { return (i ? "L" : "M") + (i * w / (pts.length - 1)).toFixed(1) + " " + (hh - 3 - (v - min) / rng * (hh - 6)).toFixed(1); }).join(" ");
    var s = svg("svg", { width: w, height: hh, viewBox: "0 0 " + w + " " + hh, class: "spark", role: "img", "aria-label": "Findings trend" });
    s.appendChild(svg("path", { d: d, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }));
    return h("span", { class: "muted", title: "Findings over the last " + pts.length + " scans" }, s);
  }
  function renderResults() {
    var box = clear($("results")), sm = S.summary;
    if (!sm || !(sm.brands || []).length) {
      box.appendChild(h("div", { class: "card empty" }, h("b", { text: "🔍" }), "No results yet. They appear here after the next scan finishes – tap “Start scan” above."));
      return;
    }
    var fs = allFindings();
    sm.brands.forEach(function (b) {
      var card = h("div", { class: "card brand" });
      var mine = fs.filter(function (f) { return f.brandSlug === b.slug; });
      var act = mine.filter(needsAction);
      card.appendChild(h("div", { class: "bhead" },
        h("div", {}, h("div", { class: "bname", text: b.name }), h("div", { class: "small muted" }, b.domain ? link("https://" + b.domain, b.domain) : null)),
        sparkline(b.slug)));
      if (!b.generated_utc) { card.appendChild(h("p", { class: "muted small", text: "Not scanned yet." })); box.appendChild(card); return; }
      card.appendChild(h("div", { class: "small muted", text: "Scanned " + L.fmtBahrain(b.generated_utc, true) + " · " + (b.depth || "") + (b.duration_s ? " · took " + L.fmtDuration(b.duration_s) : "") }));
      card.appendChild(sevBar(b.severity, b.total));
      card.appendChild(h("div", {}, b.new_count ? h("span", { class: "pill new", text: b.new_count + " new" }) : null, sevPills(b.severity),
        h("span", { class: "pill", text: act.length + " to act on" }), b.enabled === false ? h("span", { class: "pill paused", text: "paused" }) : null));
      var top = act.filter(isCritHigh).slice(0, 3);
      top.forEach(function (f) { card.appendChild(findingRow(f, true)); });
      card.appendChild(h("div", { class: "actions" },
        h("button", { class: "small primary", onclick: function () { setFilter({ brand: b.slug, status: "action", chips: {} }); } }, "All findings (" + (b.total || 0) + ")"),
        b.run_id ? h("button", { class: "small", onclick: function () { openReport(b); } }, "📄 Full report") : null,
        h("button", { class: "small", onclick: function () { scanOne(b.name); } }, "🔍 Scan")));
      box.appendChild(card);
    });
  }

  /* ---------- Findings ---------- */
  function setFilter(f) {
    S.filter = Object.assign({ q: "", brand: "", status: "action", sort: "score", chips: {} }, f);
    $("fSearch").value = S.filter.q; S.shown = 60;
    go("findings"); renderFindings();
  }
  function scoreBox(f) {
    return h("div", { class: "score sev-" + (f.severity || "info") }, String(f.score === null || f.score === undefined ? "–" : f.score), h("small", { text: (f.severity || "").slice(0, 4) }));
  }
  function statusPill(st) { if (st === "open") return null; var s = STATUSES.find(function (x) { return x.id === st; }); return h("span", { class: "pill st-" + st, text: s ? s.label : st }); }
  function findingRow(f, compact) {
    var meta = [f.brand, f.age_days !== null && f.age_days !== undefined ? "registered " + (f.age_days === 0 ? "today" : f.age_days + "d ago") : "", f.hosting].filter(Boolean).join(" · ");
    return h("div", { class: "finding" + (compact ? " compact" : ""), onclick: function () { openFinding(f); }, role: "button", tabindex: "0" },
      scoreBox(f),
      h("div", { class: "body" },
        h("div", { class: "host" }, f.host, " ", f.is_new ? h("span", { class: "pill new", text: "NEW" }) : null, statusPill(f.st)),
        h("div", { class: "meta" }, f.live ? h("span", { class: "pill", text: "live" }) : null, hasLogin(f) ? h("span", { class: "pill", text: "login" }) : null, (f.sources || []).indexOf("feeds") >= 0 ? h("span", { class: "pill", text: "on feeds" }) : null, meta),
        compact ? null : h("div", { class: "why", text: (f.reasons || []).map(function (r) { return r.replace(/^[+-]\d+\s*/, ""); }).join(" · ") })),
      h("span", { class: "chev", text: "›" }));
  }
  function filtered() {
    var F = S.filter, q = F.q.trim().toLowerCase();
    var list = allFindings().filter(function (f) {
      if (F.brand && f.brandSlug !== F.brand) return false;
      if (F.status === "action" ? !needsAction(f) : (F.status !== "all" && f.st !== F.status)) return false;
      if (F.chips["new"] && !f.is_new) return false;
      if (F.chips.crit && !isCritHigh(f)) return false;
      if (F.chips.live && !f.live) return false;
      if (F.chips.login && !hasLogin(f)) return false;
      if (F.chips.feeds && (f.sources || []).indexOf("feeds") < 0) return false;
      if (q) {
        var hay = [f.host, f.url, f.feed_url, f.ip, f.registrar, f.hosting, f.title, f.brand, (f.reasons || []).join(" ")].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var sorters = {
      score: function (a, b) { return (b.score || 0) - (a.score || 0); },
      age: function (a, b) { return (a.age_days === null || a.age_days === undefined ? 1e9 : a.age_days) - (b.age_days === null || b.age_days === undefined ? 1e9 : b.age_days) || (b.score - a.score); },
      host: function (a, b) { return a.host.localeCompare(b.host); }
    };
    return list.sort(sorters[F.sort] || sorters.score);
  }
  function renderFindings() {
    var F = S.filter;
    var bs = $("fBrand"); clear(bs).appendChild(h("option", { value: "", text: "All brands" }));
    ((S.summary && S.summary.brands) || []).forEach(function (b) { bs.appendChild(h("option", { value: b.slug, text: b.name })); });
    bs.value = F.brand; $("fStatus").value = F.status; $("fSort").value = F.sort;
    Array.prototype.forEach.call(document.querySelectorAll("#fChips button"), function (b) { b.classList.toggle("on", !!F.chips[b.dataset.chip]); });
    var list = filtered(), box = clear($("fList"));
    var total = allFindings().length;
    var cut = ((S.summary && S.summary.brands) || []).some(function (b) { return (b.total || 0) > (b.top || []).length; });
    $("fCount").textContent = list.length + " of " + plural(total, "finding") + (cut ? " (top 300 per brand; the full report has all)" : "");
    if (!S.summary) box.appendChild(h("div", { class: "card empty" }, h("b", { text: "🔍" }), "No scan results yet."));
    else if (!list.length) box.appendChild(h("div", { class: "card empty" }, h("b", { text: "✓" }), "Nothing matches these filters.", h("br"), h("button", { class: "small", onclick: function () { setFilter({ status: "all" }); } }, "Show everything")));
    list.slice(0, S.shown).forEach(function (f) { box.appendChild(findingRow(f, false)); });
    $("fMore").hidden = list.length <= S.shown;
    $("fMore").textContent = "Show more (" + (list.length - S.shown) + " left)";
  }
  var searchT;
  $("fSearch").addEventListener("input", function () { clearTimeout(searchT); var v = this.value; searchT = setTimeout(function () { S.filter.q = v; S.shown = 60; renderFindings(); }, 150); });
  $("fBrand").addEventListener("change", function () { S.filter.brand = this.value; S.shown = 60; renderFindings(); });
  $("fStatus").addEventListener("change", function () { S.filter.status = this.value; S.shown = 60; renderFindings(); });
  $("fSort").addEventListener("change", function () { S.filter.sort = this.value; renderFindings(); });
  Array.prototype.forEach.call(document.querySelectorAll("#fChips button"), function (b) {
    b.addEventListener("click", function () { S.filter.chips[b.dataset.chip] = !S.filter.chips[b.dataset.chip]; S.shown = 60; renderFindings(); });
  });
  $("fMore").addEventListener("click", function () { S.shown += 100; renderFindings(); });
  $("fExport").addEventListener("click", function () {
    var list = filtered();
    if (!list.length) return toast("Nothing to export");
    var cols = [
      { label: "Brand", key: "brand" }, { label: "Host", key: "host" }, { label: "URL", key: "url" }, { label: "Also seen at", key: "feed_url" },
      { label: "Score", key: "score" }, { label: "Severity", key: "severity" }, { label: "Status", key: "st" }, { label: "New", get: function (f) { return f.is_new ? "yes" : ""; } },
      { label: "Live", get: function (f) { return f.live ? "yes" : ""; } }, { label: "IP", key: "ip" }, { label: "Hosting", key: "hosting" }, { label: "Abuse contact", key: "abuse" },
      { label: "Registrar", key: "registrar" }, { label: "Registered", key: "created" }, { label: "Google Safe Browsing", key: "gsb" },
      { label: "Reasons", get: function (f) { return (f.reasons || []).join("; "); } }, { label: "Note", get: function (f) { return (S.triage.hosts[f.host] || {}).note || ""; } }
    ];
    var d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bahrain" }).format(new Date());
    download("phish-finder-findings-" + d + ".csv", "\ufeff" + L.toCSV(list, cols), "text/csv;charset=utf-8");
  });

  /* Finding detail sheet */
  function openFinding(f) {
    var body = clear($("findingBody")), url = L.safeUrl(f.url) || L.safeUrl("https://" + f.host);
    var brand = brandBySlug(f.brandSlug) || { name: f.brand, domain: f.brandDomain };
    var td = L.takedownText(f, brand), t = S.triage.hosts[f.host] || {};
    var inner = h("div", { class: "inner" });
    body.appendChild(h("div", { class: "grab" }));
    body.appendChild(inner);
    inner.appendChild(h("div", { class: "row between" }, h("div", { class: "row", style: "align-items:center" }, scoreBox(f), h("div", {}, h("div", { class: "host", style: "font-weight:800;font-size:18px;overflow-wrap:anywhere", text: f.host }), h("div", { class: "small muted", text: f.brand + " · " + (f.technique || (f.sources || []).join(", ")) }))),
      h("button", { class: "small", onclick: function () { $("findingDlg").close(); } }, "✕")));
    inner.appendChild(h("div", {}, f.is_new ? h("span", { class: "pill new", text: "NEW" }) : null, statusPill(f.st), f.live ? h("span", { class: "pill", text: "live (HTTP " + (f.status || "?") + ")" }) : h("span", { class: "pill", text: "not live" }),
      f.flags.map(function (x) { return h("span", { class: "pill", text: { password: "password field", sensitive: "asks for sensitive data", exfil: "sends data out", parked: "parked", down: "taken down", "cf-block": "Cloudflare warning", gsb: "Google flagged", mx: "can send e-mail" }[x] || x }); })));
    inner.appendChild(h("div", { class: "warnbox", text: "⚠ Real link – may be a live phishing page. Never enter real details." }));
    inner.appendChild(h("div", { style: "font-size:14px" }, link(url, url)));
    if (f.feed_url && f.feed_url !== url) inner.appendChild(h("div", { class: "small" }, "Also seen at: ", link(f.feed_url, f.feed_url)));
    if (f.title) inner.appendChild(h("div", { class: "small muted", text: "Page title: “" + f.title + "”" }));

    inner.appendChild(h("h3", { text: "Status" }));
    var stRow = h("div", { class: "statusrow" });
    STATUSES.forEach(function (s) {
      stRow.appendChild(h("button", { class: f.st === s.id ? "on" : "", onclick: function () { setStatus(f, s.id); } }, s.icon + " " + s.label));
    });
    inner.appendChild(stRow);
    inner.appendChild(h("p", { class: "muted small", text: "False positive = never report this host again (saved to the brand's ignore list). Ours = it belongs to the brand (added to official domains)." }));
    var note = h("textarea", { placeholder: "Note (e.g. ticket number, who you reported to)…" }); note.value = t.note || "";
    inner.appendChild(note);
    inner.appendChild(h("div", { class: "row end" }, h("button", { class: "small", onclick: function () { saveNote(f, note.value); } }, "Save note")));
    if (t.updated) inner.appendChild(h("div", { class: "small muted", text: "Last change " + L.fmtBahrain(t.updated, true) + (t.by ? " by " + t.by : "") }));

    inner.appendChild(h("h3", { text: "Report & take down" }));
    var ag = h("div", { class: "actions-grid" });
    append(ag, mailLink(f.abuse, td.subject, td.body, "✉️ E-mail hosting abuse"));
    ag.appendChild(link("https://safebrowsing.google.com/safebrowsing/report_phish/?url=" + encodeURIComponent(url), "🛡 Google Safe Browsing"));
    ag.appendChild(link("https://report.netcraft.com/report", "🕸 Netcraft"));
    ag.appendChild(link("https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site-guest", "🪟 Microsoft SmartScreen"));
    append(ag, mailLink("reportphishing@apwg.org", td.subject, td.body, "🎣 APWG (e-mail)"));
    ag.appendChild(link("https://lookup.icann.org/en/lookup?name=" + encodeURIComponent(f.reg), "📇 Registrar contact"));
    ag.appendChild(h("button", { onclick: function () { copy(td.subject + "\n\n" + td.body); } }, "📋 Copy takedown text"));
    ag.appendChild(h("button", { onclick: function () { copy(url); } }, "🔗 Copy link"));
    inner.appendChild(ag);

    inner.appendChild(h("h3", { text: "Details" }));
    var g = h("div", { class: "grid2" });
    function kv(k, v) { if (v !== null && v !== undefined && v !== "") g.appendChild(h("div", {}, h("span", { text: k }), String(v))); }
    kv("Registered", f.created ? f.created + (f.age_days !== null && f.age_days !== undefined ? " (" + f.age_days + " days ago)" : "") : "");
    kv("Registrar", f.registrar); kv("Hosting", f.hosting); kv("IP address", f.ip); kv("Abuse contact", f.abuse);
    kv("Google Safe Browsing", f.gsb); kv("First TLS certificate", f.first_cert); kv("Found by", (f.sources || []).join(", "));
    kv("Phishing feeds", (f.feeds || []).join(", ")); kv("Scanned", f.scanned ? L.fmtBahrain(f.scanned, true) : "");
    inner.appendChild(g);
    inner.appendChild(h("h3", { text: "Why it was flagged" }));
    inner.appendChild(h("ul", { class: "reasons" }, (f.reasons || []).map(function (r) { return h("li", { text: r }); })));
    inner.appendChild(h("h3", { text: "Investigate" }));
    inner.appendChild(h("div", { class: "linkrow" },
      link("https://urlscan.io/domain/" + encodeURIComponent(f.host), "urlscan"),
      link("https://www.virustotal.com/gui/domain/" + encodeURIComponent(f.host), "VirusTotal"),
      link("https://crt.sh/?q=" + encodeURIComponent(f.reg), "Certificates"),
      link("https://who.is/whois/" + encodeURIComponent(f.reg), "WHOIS"),
      link("https://web.archive.org/web/*/" + encodeURIComponent(f.host), "Archive"),
      f.run_id ? link("https://github.com/" + S.repo + "/actions/runs/" + f.run_id, "Scan run") : null));
    $("findingDlg").showModal();
  }
  $("findingDlg").addEventListener("click", function (e) { if (e.target === this) this.close(); });

  async function setStatus(f, st) {
    var host = f.host, slug = f.brandSlug, prev = f.st;
    if (st === prev) return;
    if (st === "ours" && !confirm("Mark " + host + " as owned by " + f.brand + "? It will be added to the brand's official domains and treated as legitimate in future scans.")) return;
    try {
      // Undo list-based statuses first
      if (prev === "false_positive" || prev === "ours") {
        await changeBrands(function (cfg) {
          var b = cfg.brands.find(function (x) { return L.slug(x.name) === slug; }); if (!b) return;
          if (prev === "false_positive") { b.ignore = L.removeFromList(L.removeFromList(b.ignore, host), f.reg === host ? host : ""); if (!b.ignore) delete b.ignore; }
          if (prev === "ours") { b.official = L.removeFromList(b.official, host); if (!b.official) delete b.official; }
        }, "Un-mark " + host + " (" + prev.replace("_", " ") + ") (dashboard)");
      }
      if (st === "false_positive" || st === "ours") {
        await changeBrands(function (cfg) {
          var b = cfg.brands.find(function (x) { return L.slug(x.name) === slug; });
          if (!b) throw new Error(f.brand + " is no longer in brands.yml");
          if (st === "false_positive") b.ignore = L.addToList(b.ignore, host); else b.official = L.addToList(b.official, host);
        }, (st === "ours" ? "Mark " + host + " as official for " : "Ignore false positive " + host + " for ") + f.brand + " (dashboard)");
      }
      await changeTriage(function (o) {
        var rec = o.hosts[host] || {};
        rec.status = st; rec.brand = f.brand; rec.updated = new Date().toISOString(); rec.by = S.user || "";
        rec.history = (rec.history || []).concat([{ s: st, t: rec.updated }]).slice(-10);
        if (st === "open" && !rec.note) delete o.hosts[host]; else o.hosts[host] = rec;
      }, "Triage " + host + ": " + st + " (dashboard)");
      toast(host + " → " + (STATUSES.find(function (x) { return x.id === st; }) || {}).label);
      f.st = st;
      openFinding(Object.assign({}, f, { st: statusOf(f) }));
    } catch (e) { toast(e.message); }
  }
  async function saveNote(f, text) {
    try {
      await changeTriage(function (o) {
        var rec = o.hosts[f.host] || { status: f.st === "false_positive" || f.st === "ours" ? f.st : (f.st || "open") };
        rec.note = String(text || "").slice(0, 1000); rec.brand = f.brand; rec.updated = new Date().toISOString(); rec.by = S.user || "";
        o.hosts[f.host] = rec;
      }, "Note on " + f.host + " (dashboard)");
      toast("Note saved");
    } catch (e) { toast(e.message); }
  }

  /* Full report: download the run artifact, unzip <slug>/latest.html in the browser, show it sandboxed. */
  async function openReport(b) {
    toast("Loading report…");
    try {
      var arts = await api(repoPath("/actions/runs/" + b.run_id + "/artifacts?per_page=20"));
      var art = (arts.artifacts || []).find(function (a) { return a.name === "phish-finder-reports"; });
      if (!art) throw new Error("This scan has no report file.");
      if (art.expired) throw new Error("This report has expired (reports are kept 30 days).");
      var res = await fetch(art.archive_download_url, { headers: { Authorization: "Bearer " + S.token, Accept: "application/vnd.github+json" }, cache: "no-store" });
      if (!res.ok) throw new Error(friendly(res.status, null, "/actions/artifacts"));
      var entries = L.zipEntries(await res.arrayBuffer());
      var e = entries.find(function (x) { return x.name === b.slug + "/latest.html"; }) || entries.find(function (x) { return x.name.indexOf(b.slug + "/") === 0 && /\.html$/.test(x.name); });
      if (!e) throw new Error("Report for " + b.name + " not found in this scan's files.");
      var bytes = e.method === 0 ? e.data : await inflate(e.data);
      var html = new TextDecoder().decode(bytes).replace(/<head(\s[^>]*)?>/i, function (m) { return m + '<base target="_blank">'; });
      var url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      $("reportTitle").textContent = b.name + " – full report";
      $("reportFrame").src = url;
      var dl = $("reportDownload"); dl.href = url; dl.download = b.slug + "-phishing-report.html";
      $("reportView").hidden = false;
    } catch (err) {
      var net = err.message === "Failed to fetch" || err.status === 0;
      toast(net ? "Couldn't download the report here – opening the scan on GitHub." : err.message);
      if (net) window.open("https://github.com/" + S.repo + "/actions/runs/" + b.run_id, "_blank", "noopener");
    }
  }
  async function inflate(u8) {
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  $("reportClose").addEventListener("click", function () {
    $("reportView").hidden = true;
    var u = $("reportFrame").src; $("reportFrame").src = "about:blank";
    setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e) { /* */ } }, 1000);
  });

  /* ---------- Brands ---------- */
  function lastFor(name) { var sl = L.slug(name); return ((S.summary && S.summary.brands) || []).find(function (b) { return b.slug === sl; }) || null; }
  function logoUrl(domain) {
    return domain ? "https://icons.duckduckgo.com/ip3/" + String(domain).replace(/^www\./, "") + ".ico" : "";
  }
  function logoImg(domain, cls, name) {
    var wrap = h("span", { class: "logo-wrap" });
    var letter = String(name || domain || "?").replace(/^www\./, "").charAt(0).toUpperCase() || "?";
    wrap.appendChild(h("span", { class: (cls || "brand-logo") + " logo-letter", text: letter, "aria-hidden": "true" }));
    if (!domain) return wrap;
    var el = h("img", { class: cls || "brand-logo", alt: "", width: "36", height: "36" });
    var sources = [
      "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(domain)
    ];
    var i = 0;
    function tryNext() {
      if (i >= sources.length) { el.remove(); return; }
      el.src = sources[i++];
    }
    el.addEventListener("error", tryNext);
    el.addEventListener("load", function () {
      if (el.naturalWidth && el.naturalWidth < 32) tryNext();
    });
    tryNext();
    wrap.appendChild(el);
    return wrap;
  }
  function severityCounts(b) {
    var s = b.severity || {};
    return { c: s.critical || 0, h: s.high || 0, m: s.medium || 0, total: b.total || 0, neu: b.new_count || 0 };
  }
  function renderBrands() {
    var box = clear($("brandList"));
    box.className = "brand-grid";
    if (!brands().length) {
      box.className = "";
      box.appendChild(h("div", { class: "card empty" }, h("b", { text: "🏷" }), "No brands yet. Tap “Add brand” to start monitoring one."));
      return;
    }
    brands().forEach(function (b, i) {
      var on = L.isEnabled(b.enabled), last = lastFor(b.name), sc = severityCounts(last || {});
      var card = h("div", { class: "card brand-card", role: "button", tabindex: "0",
        onclick: function () { go("brand", false, L.slug(b.name)); },
        onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go("brand", false, L.slug(b.name)); } } });
      card.appendChild(h("div", { class: "bhead" },
        logoImg(b.domain, "brand-logo", b.name),
        h("div", { class: "grow" },
          h("div", { class: "bname", text: b.name }),
          h("div", { class: "bmeta" },
            h("a", { href: "https://" + b.domain, target: "_blank", rel: "noopener noreferrer nofollow",
              text: b.domain, onclick: function (e) { e.stopPropagation(); } }), " ",
            on ? h("span", { class: "pill new", text: "active" }) : h("span", { class: "pill paused", text: "paused" })))));
      var counts = h("div", { class: "brand-counts" });
      if (sc.c) counts.appendChild(h("span", { class: "c", text: sc.c + " critical" }));
      if (sc.h) counts.appendChild(h("span", { class: "h", text: sc.h + " high" }));
      if (sc.m) counts.appendChild(h("span", { class: "m", text: sc.m + " medium" }));
      counts.appendChild(h("span", { text: plural(sc.total, "finding") + (sc.neu ? " · " + sc.neu + " new" : "") }));
      card.appendChild(counts);
      card.appendChild(h("div", { class: "bmeta", text: last && last.generated_utc ? ("Last scan " + L.fmtBahrain(last.generated_utc, true) + (last.duration_s ? " · " + L.fmtDuration(last.duration_s) : "")) : "Not scanned yet" }));
      var tr = sparkline(L.slug(b.name));
      if (tr) card.appendChild(h("div", { class: "trend" }, tr));
      box.appendChild(card);
    });
  }
  function nextAutoScan() {
    try {
      var crons = L.readSchedule(S.wf || "");
      var nxt = L.nextRuns(crons, new Date(), 1);
      return nxt && nxt[0] ? nxt[0] : null;
    } catch (e) { return null; }
  }
  function compactFullFinding(f, brand, slug, domain) {
    var p = f.probe || {}, rd = f.rdap || {}, ipo = f.ip_owner || {}, gsb = f.gsb || {}, dns = f.dns || {};
    var flags = [];
    if (p.password_field) flags.push("password");
    if (p.sensitive_fields && p.sensitive_fields.length) flags.push("sensitive");
    if (p.exfil || p.exfil_strong) flags.push("exfil");
    if (p.parked) flags.push("parked");
    if (p.taken_down) flags.push("down");
    return {
      host: f.host || "", reg: f.registrable || "", url: (p.final_url || (f.urlscan && f.urlscan.url) || ("https://" + (f.host || "") + "/")),
      score: f.score, severity: f.severity || "", is_new: !!f.is_new, live: !!p.live, status: p.status,
      title: (p.title || (f.urlscan && f.urlscan.title) || "").slice(0, 160),
      reasons: (f.reasons || []).slice(0, 8), sources: f.sources || [], feeds: f.feeds || [],
      technique: f.technique || "", flags: flags, ip: ((dns.a || [])[0]) || "", hosting: (ipo && (ipo.org || ipo.net)) || "",
      abuse: (ipo && ipo.abuse) || "", registrar: rd.registrar || "", created: rd.created || "", age_days: rd.age_days,
      gsb: gsb.state || "", first_cert: f.first_cert || "", campaign_id: f.campaign_id || "", campaign_new: !!f.campaign_new,
      kit: (p.kit_fingerprint && (p.kit_fingerprint.id || p.kit_fingerprint.name)) || f.kit_seed || "",
      logo_match: p.logo_match || "", ocr: p.ocr_brand_hits || [],
      brand: brand, brandSlug: slug, brandDomain: domain, scanned: null
    };
  }
  function findingsToCsv(list) {
    var cols = ["score", "severity", "host", "url", "title", "live", "is_new", "campaign_id", "sources", "reasons", "registrar", "hosting", "created"];
    function cell(v) {
      v = v === null || v === undefined ? "" : String(v);
      if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
      return v;
    }
    var lines = [cols.join(",")];
    list.forEach(function (f) {
      lines.push(cols.map(function (k) {
        if (k === "url") return cell(f.url || ("https://" + f.host + "/"));
        if (k === "sources") return cell((f.sources || []).join(";"));
        if (k === "reasons") return cell((f.reasons || []).join(" | "));
        if (k === "live") return cell(f.live ? "yes" : "no");
        return cell(f[k]);
      }).join(","));
    });
    return lines.join("\n");
  }
  function downloadText(name, text, type) {
    var blob = new Blob([text], { type: type || "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  async function loadBrandLatest(slug) {
    S.latest = S.latest || {};
    if (S.latest[slug]) return S.latest[slug];
    try {
      var data = null;
      if (DEMO) {
        var r = await fetch("demo/" + slug + "/latest.json", { cache: "no-store" });
        if (r.ok) data = await r.json();
      } else {
        var f = await getFile(slug + "/latest.json", "state");
        if (f && f.text) data = JSON.parse(f.text);
      }
      if (data) S.latest[slug] = data;
      return data;
    } catch (e) { return null; }
  }
  async function renderBrandPage() {
    var slug = S.brandSlug, box = $("brandPage");
    if (!box) return;
    var cfgB = brands().find(function (b) { return L.slug(b.name) === slug; });
    var last = lastFor(slug) || ((S.summary && S.summary.brands) || []).find(function (b) { return b.slug === slug; }) || {};
    if (!cfgB && last.name) cfgB = { name: last.name, domain: last.domain, country: last.country };
    if (!cfgB) { clear(box).appendChild(h("p", { class: "muted", text: "Brand not found." })); return; }
    var idx = brands().indexOf(cfgB);
    clear(box).appendChild(h("div", { class: "skeleton" }));
    var latest = await loadBrandLatest(slug);
    if (S.brandSlug !== slug) return;
    var meta = (latest && latest.brand) || {};
    var findings = ((latest && latest.findings) || last.top || []).map(function (f) {
      if (f.probe || f.rdap) return compactFullFinding(f, cfgB.name, slug, cfgB.domain);
      return Object.assign({}, f, { brand: cfgB.name, brandSlug: slug, brandDomain: cfgB.domain });
    });
    findings.forEach(function (f) { f.st = (((S.triage || {}).hosts || {})[f.host] || {}).status || "open"; });
    var camps = (latest && latest.campaigns) || last.campaigns || [];
    var kits = last.kits || [];
    if (latest && latest.findings && !kits.length) {
      var seen = {};
      (latest.findings || []).forEach(function (f) {
        var p = f.probe || {};
        var id = (p.kit_fingerprint && p.kit_fingerprint.id) || f.kit_seed;
        var name = (p.kit_fingerprint && p.kit_fingerprint.name) || id;
        if (id) { seen[id] = seen[id] || { id: id, name: name, count: 0 }; seen[id].count++; }
      });
      kits = Object.keys(seen).map(function (k) { return seen[k]; });
    }
    var sc = severityCounts(last);
    var nxt = nextAutoScan();
    var hist = (S.history || []).slice().reverse().map(function (r) {
      var b = (r.brands || []).find(function (x) { return (x.slug || L.slug(x.name)) === slug; });
      if (!b) return null;
      return { at: r.updated_utc || r.generated_utc || "", total: b.findings, new_count: b.new_count, duration_s: b.duration_s, depth: b.depth };
    }).filter(Boolean);

    var kwText = "";
    if (meta.generated_keywords && meta.generated_keywords.length) kwText = meta.generated_keywords.join("\n");
    else if (last.generated_keywords && last.generated_keywords.length) kwText = last.generated_keywords.join("\n");
    else kwText = L.previewKeywords({
      name: cfgB.name, domain: cfgB.domain, keywords: L.csv(cfgB.keywords),
      country: cfgB.country || meta.country || "", autoKeywords: cfgB.auto_keywords !== false
    });

    var head = h("div", { class: "bp-head" },
      logoImg(cfgB.domain, "brand-logo", cfgB.name),
      h("div", { class: "grow" },
        h("h1", { text: cfgB.name }),
        h("div", { class: "muted small" }, link("https://" + cfgB.domain, cfgB.domain),
          cfgB.country ? " · " + String(cfgB.country).toUpperCase() : "",
          " · ", L.isEnabled(cfgB.enabled) ? "active" : "paused"),
        h("div", { class: "bp-actions" },
          h("button", { class: "small primary", onclick: function () { scanOne(cfgB.name); } }, "🔍 Scan now"),
          idx >= 0 ? h("button", { class: "small", onclick: function () { editBrand(idx); } }, "✏️ Settings") : null,
          h("button", { class: "small", onclick: function () { downloadText(slug + "-incidents.csv", findingsToCsv(findings), "text/csv;charset=utf-8"); } }, "⬇ Download CSV"))));

    var counts = h("div", { class: "brand-counts card" },
      h("span", { class: "c", text: sc.c + " critical" }),
      h("span", { class: "h", text: sc.h + " high" }),
      h("span", { class: "m", text: sc.m + " medium" }),
      h("span", { text: plural(findings.length || sc.total, "incident") }),
      sc.neu ? h("span", { class: "pill new", text: sc.neu + " new" }) : null);

    var when = h("div", { class: "card" },
      h("h2", { text: "Scans" }),
      h("div", { text: last.generated_utc ? ("Last scan " + L.fmtBahrain(last.generated_utc, true) + (last.duration_s ? " · took " + L.fmtDuration(last.duration_s) : "") + (last.depth ? " · " + last.depth : "")) : "Not scanned yet" }),
      h("div", { class: "muted small", text: nxt ? ("Next scheduled scan " + L.fmtBahrain(nxt, true)) : "Automatic scans are off" }),
      sparkline(slug) ? h("div", { class: "trend", style: "margin-top:10px" }, sparkline(slug)) : null);

    var histBox = h("div", { class: "card" }, h("h2", { text: "Scan history" }));
    if (!hist.length) histBox.appendChild(h("p", { class: "muted small", text: "No previous runs in history yet." }));
    hist.slice(0, 12).forEach(function (r) {
      histBox.appendChild(h("div", { class: "hist-row" },
        h("span", { text: r.at ? L.fmtBahrain(r.at, true) : "—" }),
        h("span", { class: "muted", text: plural(r.total || 0, "finding") + (r.new_count ? " · " + r.new_count + " new" : "") + (r.duration_s ? " · " + L.fmtDuration(r.duration_s) : "") })));
    });

    var campBox = h("div", { class: "card" }, h("h2", { text: "Campaigns" }));
    if (!camps.length) campBox.appendChild(h("p", { class: "muted small", text: "No clustered campaigns yet. Sibling sites that share a title, image, script or path will appear here after a scan." }));
    camps.forEach(function (c) {
      campBox.appendChild(h("div", { class: "camp" },
        h("div", { class: "camp-head" },
          h("b", { class: "camp-title", text: c.title || c.id || "Campaign" }), " ",
          c.is_new_campaign ? h("span", { class: "pill new", text: "NEW" }) : null,
          " ", h("span", { class: "pill sev-" + (c.severity || "info"), text: (c.severity || "") + (c.max_score ? " · " + c.max_score : "") })),
        c.id ? h("div", { class: "muted small mono", text: c.id }) : null,
        h("div", { class: "muted small", text: plural(c.count || (c.hosts || []).length, "site") +
          (c.first_seen ? " · first " + L.fmtBahrain(c.first_seen, true) : "") +
          (c.last_seen ? " · last " + L.fmtBahrain(c.last_seen, true) : "") }),
        h("div", { class: "small camp-hosts" }, (c.hosts || []).slice(0, 12).map(function (host, i) {
          return h("span", {}, i ? " · " : "", link("https://" + host + "/", host));
        }))));
    });

    var kitBox = h("div", { class: "card" }, h("h2", { text: "Scam templates" }));
    if (!kits.length) kitBox.appendChild(h("p", { class: "muted small", text: "No known-kit fingerprints seen for this brand on the last scan. New campaigns are still clustered above from logos, OCR and page content." }));
    kits.forEach(function (k) {
      kitBox.appendChild(h("div", { class: "camp" },
        h("b", { text: k.name || k.id }), " ",
        h("span", { class: "muted small", text: plural(k.count || 0, "host") + (k.id && k.name && k.id !== k.name ? " · " + k.id : "") })));
    });

    var inc = h("div", { class: "card" },
      h("div", { class: "row between" }, h("h2", { text: "Incidents" }), h("button", { class: "small", onclick: function () { downloadText(slug + "-incidents.csv", findingsToCsv(findings), "text/csv;charset=utf-8"); } }, "⬇ CSV")),
      h("p", { class: "muted small", text: "Tap a row for evidence, reasons and lookup links. Links are real: these may be live phishing pages." }));
    if (!findings.length) inc.appendChild(h("p", { class: "muted", text: "No incidents in the last scan." }));
    findings.sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).forEach(function (f) {
      inc.appendChild(findingRow(f, false));
    });

    var settings = h("div", { class: "card" },
      h("h2", { text: "Auto-generated keywords & settings" }),
      h("div", { class: "muted small", text: "Language " + (meta.language || last.language || "–") +
        " · country " + String(cfgB.country || meta.country || last.country || "–").toUpperCase() +
        " · auto-keywords " + (cfgB.auto_keywords === false || cfgB.auto_keywords === "false" ? "off" : "on") }),
      (meta.official_names || last.official_names || []).length ? h("div", { class: "small", text: "Official names from the homepage: " + (meta.official_names || last.official_names).join(" · ") }) : null,
      h("pre", { class: "kw-box", text: kwText || "—" }),
      L.csv(cfgB.official) ? h("div", { class: "small muted", text: "Also owns: " + L.csv(cfgB.official) }) : null,
      L.csv(cfgB.keywords) ? h("div", { class: "small muted", text: "Extra keywords you added: " + L.csv(cfgB.keywords) }) : null,
      L.csv(cfgB.ignore) ? h("div", { class: "small muted", text: "Ignoring: " + L.csv(cfgB.ignore) }) : null,
      idx >= 0 ? h("button", { class: "small", style: "margin-top:8px", onclick: function () { editBrand(idx); } }, "✏️ Edit settings") : null);

    clear(box);
    [head, counts, when, campBox, kitBox, inc, histBox, settings].forEach(function (el) { box.appendChild(el); });
  }

  async function scanOne(name) {
    if (!confirm("Start a " + settingsMode() + " scan of " + name + " now?")) return;
    try { await dispatchScan(name, settingsMode()); toast("Scan of " + name + " started"); go("home"); } catch (e) { toast(e.message); }
  }
  async function toggleBrand(i) {
    var b = brands()[i], name = b.name, on = L.isEnabled(b.enabled);
    try {
      await changeBrands(function (cfg) {
        var x = cfg.brands.find(function (y) { return L.slug(y.name) === L.slug(name); });
        if (!x) throw new Error(name + " is no longer in brands.yml");
        if (on) x.enabled = false; else delete x.enabled;
      }, (on ? "Pause" : "Resume") + " brand " + name + " (dashboard)");
      toast(name + (on ? " paused" : " resumed"));
    } catch (e) { toast(e.message); }
  }
  async function removeBrand(i) {
    var name = brands()[i].name;
    if (!confirm("Remove " + name + "? Automatic scans will stop for it. Past scan results stay on GitHub.")) return;
    try {
      await changeBrands(function (cfg) { cfg.brands = cfg.brands.filter(function (y) { return L.slug(y.name) !== L.slug(name); }); }, "Remove brand " + name + " (dashboard)");
      toast(name + " removed");
    } catch (e) { toast(e.message); }
  }
  var editing = -1;
  function editBrand(i) {
    editing = i;
    var f = $("brandForm"), b = i >= 0 ? brands()[i] : {};
    f.reset();
    f.name.value = b.name || ""; f.domain.value = b.domain || ""; f.official.value = L.csv(b.official); f.keywords.value = L.csv(b.keywords);
    f.country.value = b.country || ""; f.ignore.value = L.csv(b.ignore); f.enabled.checked = i >= 0 ? L.isEnabled(b.enabled) : true;
    if (f.autoKeywords) f.autoKeywords.checked = b.auto_keywords !== false && b.auto_keywords !== "false";
    updateKwPreview();
    f.scanAfter.checked = i < 0;
    $("brandDlgTitle").textContent = i >= 0 ? "Edit " + b.name : "Add a brand";
    msg($("brandMsg"), "");
    $("brandDlg").showModal();
  }
  function updateKwPreview() {
    var box = $("kwPreview"), f = $("brandForm");
    if (!box || !f) return;
    var on = !f.autoKeywords || f.autoKeywords.checked;
    box.hidden = false;
    box.textContent = L.previewKeywords({
      name: f.name.value, domain: f.domain.value, keywords: f.keywords.value,
      country: f.country.value, autoKeywords: on
    });
  }
  ["name","domain","keywords","country"].forEach(function (n) {
    var el = $("brandForm") && $("brandForm")[n];
    if (el) { el.addEventListener("input", updateKwPreview); el.addEventListener("change", updateKwPreview); }
  });
  if ($("brandForm") && $("brandForm").autoKeywords) $("brandForm").autoKeywords.addEventListener("change", updateKwPreview);
  $("addBrandBtn").addEventListener("click", function () { editBrand(-1); });
  if ($("brandBack")) $("brandBack").addEventListener("click", function () { go("brands"); });
  $("brandCancel").addEventListener("click", function () { $("brandDlg").close(); });
  $("brandForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var f = this, btn = $("brandSave");
    var form = { name: f.name.value, domain: f.domain.value, official: f.official.value, keywords: f.keywords.value, country: f.country.value, enabled: f.enabled.checked, autoKeywords: f.autoKeywords ? f.autoKeywords.checked : true };
    var ignore = L.csvList(f.ignore.value).map(L.cleanDomain).filter(Boolean).join(", ");
    var oldName = editing >= 0 ? brands()[editing].name : null, scanAfter = f.scanAfter.checked, nb;
    try {
      var others = brands().filter(function (x) { return !oldName || L.slug(x.name) !== L.slug(oldName); });
      nb = L.brandFromForm(form, editing >= 0 ? brands()[editing] : null, others);
    } catch (e) { return msg($("brandMsg"), e.message, "err"); }
    btn.disabled = true; msg($("brandMsg"), "Saving…");
    try {
      await changeBrands(function (cfg) {
        var cur = oldName ? cfg.brands.find(function (x) { return L.slug(x.name) === L.slug(oldName); }) : null;
        var others2 = cfg.brands.filter(function (x) { return x !== cur; });
        var built = L.brandFromForm(form, cur, others2);
        if (ignore) built.ignore = ignore; else delete built.ignore;
        if (cur) cfg.brands[cfg.brands.indexOf(cur)] = built; else cfg.brands.push(built);
      }, (oldName ? "Edit brand " + oldName : "Add brand " + nb.name) + " (dashboard)");
      $("brandDlg").close();
      toast((oldName ? "Saved " : "Added ") + nb.name);
      if (scanAfter) { try { await dispatchScan(nb.name, settingsMode()); toast("Saved – first scan of " + nb.name + " started"); go("home"); } catch (e) { toast("Saved, but the scan did not start: " + e.message); } }
    } catch (e) { msg($("brandMsg"), e.message, "err"); }
    finally { btn.disabled = false; }
  });

  /* ---------- Schedule ---------- */
  (function () {
    var sel = $("schedEvery");
    L.EVERY_OPTIONS.forEach(function (n) { sel.appendChild(h("option", { value: String(n), text: n === 1 ? "1 hour" : n + " hours" })); });
    var days = $("daysWrap");
    L.DAY_NAMES.forEach(function (d, i) { days.appendChild(h("button", { type: "button", "data-day": String(i), text: d, onclick: function () { this.classList.toggle("on"); readSchedForm(); } })); });
    Array.prototype.forEach.call(document.querySelectorAll("#freqSeg button"), function (b) { b.addEventListener("click", function () { S.sched.freq = b.dataset.freq; paintSched(); }); });
    ["schedTime", "schedEvery", "schedMode"].forEach(function (id) { $(id).addEventListener("change", readSchedForm); $(id).addEventListener("input", readSchedForm); });
  })();
  function initSchedule() {
    var crons = L.readSchedule(S.wf || ""), label = L.readScheduleLabel(S.wf || "");
    var p = L.parseCron(crons, label);
    $("schedCurrent").textContent = crons.length ? "Now: " + (p.freq === "custom" ? "custom schedule (" + crons.join(" | ") + " UTC)" : L.buildCron(p).label) + " · " + settingsMode() + " depth" : "Now: automatic scans are off.";
    if (p.freq === "custom") p = { freq: "daily", time: "07:00", every: 6, days: [0, 1, 2, 3, 4] };
    S.sched = { freq: p.freq, time: p.time || "07:00", every: p.every || 6, days: p.days || [0, 1, 2, 3, 4], mode: settingsMode(), origCrons: crons, origMode: settingsMode() };
    paintSched();
  }
  function paintSched() {
    var s = S.sched; if (!s) return;
    Array.prototype.forEach.call(document.querySelectorAll("#freqSeg button"), function (b) { b.classList.toggle("on", b.dataset.freq === s.freq); });
    $("schedTime").value = s.time; $("schedEvery").value = String(s.every); $("schedMode").value = s.mode;
    if ($("autoKeywordsGlobal")) {
      var ak = S.cfg && S.cfg.settings && S.cfg.settings.auto_keywords;
      $("autoKeywordsGlobal").checked = !(ak === false || ak === "false");
    }
    Array.prototype.forEach.call(document.querySelectorAll("#daysWrap button"), function (b) { b.classList.toggle("on", s.days.indexOf(+b.dataset.day) >= 0); });
    $("timeWrap").hidden = s.freq === "off";
    $("timeLbl").textContent = s.freq === "hours" ? "Starting at (Bahrain)" : "Time (Bahrain)";
    $("everyWrap").hidden = s.freq !== "hours";
    $("daysWrap").hidden = s.freq !== "weekdays";
    previewSched();
  }
  function readSchedForm() {
    var s = S.sched; if (!s) return;
    s.time = $("schedTime").value || "07:00"; s.every = +$("schedEvery").value; s.mode = $("schedMode").value;
    s.days = Array.prototype.filter.call(document.querySelectorAll("#daysWrap button"), function (b) { return b.classList.contains("on"); }).map(function (b) { return +b.dataset.day; });
    previewSched();
  }
  function avgMinutes(mode) {
    var done = S.runs.filter(function (r) { return r.status === "completed" && r.conclusion === "success"; });
    var mins = done.map(function (r) { return Math.ceil((new Date(r.updated_at) - new Date(r.run_started_at || r.created_at)) / 60000); }).filter(function (m) { return m > 0 && m < 360; });
    var nBrands = Math.max(1, brands().filter(function (b) { return L.isEnabled(b.enabled); }).length);
    var perBrand = { quick: 3, normal: 6, full: 14 }[mode] || 6;
    if (!mins.length || mode !== settingsMode()) return { m: perBrand * nBrands + 1, guess: true };
    return { m: mins.reduce(function (a, b) { return a + b; }, 0) / mins.length, guess: false };
  }
  function previewSched() {
    var s = S.sched, out; if (!s) return null;
    try { out = L.buildCron(s); } catch (e) { $("schedPreview").textContent = e.message; clear($("schedCost")); return null; }
    var nx = L.nextRuns(out.crons, new Date(), 3).map(function (d) { return L.fmtBahrain(d, true); });
    clear($("schedPreview")).appendChild(h("b", { text: out.label }));
    if (nx.length) $("schedPreview").appendChild(h("div", { class: "small", text: "Next: " + nx.join(" · ") }));
    var box = clear($("schedCost"));
    if (out.crons.length) {
      var per = L.runsPerMonth(out.crons), avg = avgMinutes(s.mode), est = Math.round(per * avg.m), pct = Math.min(100, 100 * est / FREE_MINUTES);
      box.appendChild(h("div", { text: "≈ " + per + " scans/month × ~" + Math.round(avg.m) + " min" + (avg.guess ? " (estimate)" : " (recent average)") + " ≈ " + est + " of " + FREE_MINUTES + " free minutes" }));
      box.appendChild(h("div", { class: "bar" }, h("span", { class: pct > 100 * 0.95 ? "over" : pct > 75 ? "warn" : "use", style: "width:" + pct.toFixed(1) + "%" })));
      if (est > FREE_MINUTES * 0.8) box.appendChild(h("div", { class: "msg err", text: "⚠ Close to or over the free limit – choose fewer scans or Quick depth." }));
    } else box.appendChild(h("div", { text: "You can still start scans any time with “Scan now”." }));
    return out;
  }
  $("schedSave").addEventListener("click", async function () {
    var out = previewSched(); if (!out) return msg($("schedMsg"), "Fix the schedule first", "err");
    var s = S.sched, btn = this;
    var cronChanged = JSON.stringify(out.crons) !== JSON.stringify(s.origCrons) || (out.crons.length && L.readScheduleLabel(S.wf).indexOf(out.label) < 0);
    var modeChanged = s.mode !== s.origMode;
    if (!cronChanged && !modeChanged) return msg($("schedMsg"), "Nothing to change – that's already the schedule.", "ok");
    btn.disabled = true; msg($("schedMsg"), "Saving…"); busy(true);
    try {
      if (cronChanged) {
        var f = await getFile(WORKFLOW_PATH, "main");
        if (!f) throw new Error("Workflow file " + WORKFLOW_PATH + " not found in the repo.");
        var text = L.rewriteSchedule(f.text, out.crons, out.label);
        if (text !== f.text) await putFile(WORKFLOW_PATH, text, f.sha, "Schedule: " + out.label + " (dashboard)");
        S.wf = text;
      }
      var wantAk = $("autoKeywordsGlobal") ? $("autoKeywordsGlobal").checked : true;
      var haveAk = !(S.cfg && S.cfg.settings && (S.cfg.settings.auto_keywords === false || S.cfg.settings.auto_keywords === "false"));
      if (modeChanged || wantAk !== haveAk) await changeBrands(function (cfg) {
        cfg.settings = cfg.settings || {};
        cfg.settings.mode = s.mode;
        cfg.settings.auto_keywords = wantAk;
      }, "Scan settings: " + s.mode + " depth, auto-keywords " + (wantAk ? "on" : "off") + " (dashboard)");
      msg($("schedMsg"), "Saved ✓ " + out.label + ", " + s.mode + " depth.", "ok");
      initSchedule(); renderScanForm();
    } catch (e) { msg($("schedMsg"), e.message, "err"); }
    finally { btn.disabled = false; busy(false); }
  });

  /* ---------- Scans ---------- */
  function histFor(id) { return (S.history || []).find(function (x) { return String(x.run_id) === String(id); }); }
  function runIcon(r) {
    if (r.status !== "completed") return r.status === "queued" || r.status === "waiting" ? "🕒" : "⏳";
    return { success: "✅", failure: "❌", cancelled: "⏹", timed_out: "⌛", skipped: "⏭" }[r.conclusion] || "•";
  }
  function runRow(r, live) {
    var hi = histFor(r.id), active = r.status !== "completed";
    var startedAt = r.run_started_at || r.created_at;
    var dur = active ? "running " + L.fmtDuration((Date.now() - new Date(startedAt)) / 1000) : L.fmtDuration((new Date(r.updated_at) - new Date(startedAt)) / 1000);
    var what = r.event === "schedule" ? "Automatic scan" : r.event === "workflow_dispatch" ? "Manual scan" : r.event;
    var brandsTxt = hi && hi.brands && hi.brands.length ? hi.brands.map(function (b) { return b.name + (b.rc ? " (error)" : ""); }).join(", ") : "";
    var body = h("div", { class: "body" },
      h("div", {}, h("b", { text: what }), " ", h("span", { class: "small muted", text: L.fmtBahrain(startedAt, true) })),
      h("div", { class: "small muted", text: [dur, hi ? hi.mode : "", brandsTxt].filter(Boolean).join(" · ") }),
      hi ? h("div", {}, h("span", { class: "pill " + (hi.new_findings ? "new" : ""), text: hi.new_findings ? hi.new_findings + " new findings" : "no new findings" })) : null);
    if (active) {
      var job = S.jobs[r.id], steps = (job && job.steps) || [];
      var done = steps.filter(function (s) { return s.status === "completed"; }).length, cur = steps.find(function (s) { return s.status === "in_progress"; });
      var pct = steps.length ? Math.max(4, Math.round(100 * done / steps.length)) : 4;
      body.appendChild(h("div", { class: "progress" }, h("span", { style: "width:" + pct + "%" })));
      body.appendChild(h("div", { class: "small muted", text: cur ? "Now: " + cur.name + (cur.name === "Run scan" ? " (the long part)" : "") : r.status === "queued" ? "Waiting for a GitHub runner…" : "Starting…" }));
    }
    var side = h("div", { style: "display:flex;flex-direction:column;gap:6px;align-items:flex-end" }, link(r.html_url, "Open"));
    if (active) side.appendChild(h("button", { class: "small danger", onclick: function () { cancelRun(r); } }, "Stop"));
    else if (r.conclusion === "failure" || r.conclusion === "cancelled") side.appendChild(h("button", { class: "small", onclick: function () { rerun(r); } }, "Retry"));
    return h("div", { class: "card run" + (live ? " live" : "") }, h("div", { class: "st", text: runIcon(r) }), body, side);
  }
  async function cancelRun(r) {
    if (!confirm("Stop this scan?")) return;
    try { await api(repoPath("/actions/runs/" + r.id + "/cancel"), { method: "POST" }); toast("Stopping…"); setTimeout(loadRuns, 4000); } catch (e) { toast(e.message); }
  }
  async function rerun(r) {
    try { await api(repoPath("/actions/runs/" + r.id + "/rerun"), { method: "POST" }); toast("Scan restarted"); setTimeout(loadRuns, 4000); } catch (e) { toast(e.message); }
  }
  function renderRuns() {
    var box = clear($("runList"));
    if (!S.runs.length) { box.appendChild(h("div", { class: "card empty" }, h("b", { text: "📜" }), "No scans yet.")); return; }
    S.runs.forEach(function (r) { box.appendChild(runRow(r, false)); });
  }
  function renderLive() {
    var box = clear($("liveRun"));
    S.runs.filter(function (r) { return r.status !== "completed"; }).slice(0, 3).forEach(function (r) { box.appendChild(runRow(r, true)); });
  }
  function renderSettings() {
    $("setRepo").textContent = S.repo; $("whoami").textContent = S.user || "–";
    $("keyInfo").textContent = S.token ? "saved on this device (…" + S.token.slice(-4) + ")" : "–";
    var lr = clear($("setLinks"));
    lr.appendChild(link("https://github.com/" + S.repo, "Repo"));
    lr.appendChild(link("https://github.com/" + S.repo + "/actions", "Actions"));
    lr.appendChild(link("https://github.com/" + S.repo + "/settings/secrets/actions", "Secrets (alerts)"));
    lr.appendChild(link("https://github.com/" + S.repo + "/blob/main/brands.yml", "brands.yml"));
    lr.appendChild(link("https://github.com/settings/personal-access-tokens", "Manage keys"));
    lr.appendChild(link("https://github.com/settings/billing/summary", "Actions minutes used"));
  }

  /* ---------- boot ---------- */
  async function startDemo() {
    S.repo = "demo/phish-finder";
    S.user = "demo";
    S.token = "";
    $("connect").hidden = true; $("tabs").hidden = false; $("refreshBtn").hidden = true;
    $("repoLabel").textContent = "demo · local preview";
    try {
      var brandsTxt = await fetch("demo/brands.yml", { cache: "no-store" }).then(function (r) { return r.text(); });
      S.cfg = L.parseBrands(brandsTxt);
    } catch (e) { S.cfg = { settings: { mode: "normal", auto_keywords: true }, brands: [] }; }
    try { S.wf = await fetch("demo/phish-scan.yml", { cache: "no-store" }).then(function (r) { return r.ok ? r.text() : ""; }); } catch (e) { S.wf = ""; }
    try { S.summary = await fetch("demo/summary.json", { cache: "no-store" }).then(function (r) { return r.json(); }); } catch (e) { S.summary = { brands: [] }; }
    try { S.history = await fetch("demo/history.json", { cache: "no-store" }).then(function (r) { return r.json(); }); } catch (e) { S.history = []; }
    S.triage = { hosts: {} };
    S.runs = [];
    var parsed = parseHash();
    if (parsed.slug) S.brandSlug = parsed.slug;
    go(parsed.view || "brands", false, parsed.slug);
    renderTiles(); renderAttention(); renderScanForm(); renderResults(); renderFindings(); renderBrands(); renderRuns(); renderSettings();
    if ($("schedCurrent")) try { initSchedule(); } catch (e) {}
  }
  S.token = localStorage.getItem(LS_TOKEN) || "";
  S.repo = localStorage.getItem(LS_REPO) || defaultRepo();
  void LS_SEEN;
  if (DEMO) startDemo().catch(function (e) { showConnect(e.message || String(e)); });
  else if (!S.token || !S.repo) showConnect("");
  else verify().then(start).catch(function (e) {
    if (e.status === 401 || e.status === 404) { localStorage.removeItem(LS_TOKEN); showConnect(e.message); }
    else { start(); toast(e.message); }
  });
})();
