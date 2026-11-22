/* Phish Finder dashboard - UI + GitHub REST calls. All data comes live from the private repo. */
(function () {
  "use strict";
  var L = window.DashLib;
  var API = "https://api.github.com";
  var WORKFLOW = "phish-scan.yml";
  var WORKFLOW_PATH = ".github/workflows/" + WORKFLOW;
  var BRANDS_PATH = "brands.yml";
  var LS_TOKEN = "pf.token", LS_REPO = "pf.repo";
  var FREE_MINUTES = 2000;

  var S = { repo: "", token: "", cfg: null, cfgSha: "", wf: "", wfSha: "", summary: null, history: [], runs: [], user: "", sched: null, pollTimer: null };

  /* ---------- tiny DOM helpers (always textContent, never innerHTML with data) ---------- */
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
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(function (x) { if (x !== null && x !== undefined && x !== false) el.appendChild(typeof x === "string" || typeof x === "number" ? document.createTextNode(String(x)) : x); });
    }
    return el;
  }
  function link(url, text) {
    var u = L.safeUrl(url);
    return u ? h("a", { href: u, target: "_blank", rel: "noopener noreferrer nofollow" , text: text || u }) : h("span", { text: text || url || "" });
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function msg(el, text, kind) { el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }
  var toastTimer;
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3500); }

  /* ---------- GitHub API ---------- */
  function friendly(status, data, path) {
    var m = (data && data.message) || "";
    if (status === 401) return "Your GitHub key is wrong or has expired. Tap Disconnect, then connect again with a new key.";
    if (status === 403 && /rate limit/i.test(m)) return "GitHub is rate-limiting requests. Try again in a few minutes.";
    if (status === 403 || (status === 404 && /actions|dispatch/.test(path || ""))) {
      if (/workflow/i.test(m) || /\.github\/workflows/.test(path || "")) return "Your key needs the “Workflows: Read and write” permission to change the schedule. Edit the key on GitHub (Settings → Developer settings → Fine-grained tokens) and add it.";
      if (/actions/.test(path || "")) return "Your key needs the “Actions: Read and write” permission. Edit the key on GitHub and add it.";
      return "Your key does not have permission for this (needs Contents, Actions and Workflows = Read and write on this repo). " + m;
    }
    if (status === 404) return "Not found. Check the repository name and that the key includes this repository.";
    if (status === 409) return "Someone else changed the file at the same time. Please try again.";
    if (status === 422) return "GitHub rejected the request: " + m;
    return "GitHub error " + status + (m ? ": " + m : "");
  }
  async function api(path, opts) {
    opts = opts || {};
    var headers = { "Accept": opts.accept || "application/vnd.github+json", "Authorization": "Bearer " + S.token, "X-GitHub-Api-Version": "2022-11-28" };
    if (opts.body) headers["Content-Type"] = "application/json";
    var res;
    try {
      res = await fetch(API + path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
    } catch (e) { var ne = new Error("No connection to GitHub. Check your internet and try again."); ne.status = 0; throw ne; }
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
      if (!d.content && d.size > 0) { // >1 MB: fetch raw
        text = await (await fetch(API + repoPath("/contents/" + path + "?ref=" + encodeURIComponent(ref || "main")), { headers: { Accept: "application/vnd.github.raw+json", Authorization: "Bearer " + S.token }, cache: "no-store" })).text();
      }
      return { text: text, sha: d.sha };
    } catch (e) { if (e.status === 404) return null; throw e; }
  }
  async function putFile(path, text, sha, message) {
    var body = { message: message, content: L.b64EncodeUtf8(text), branch: "main" };
    if (sha) body.sha = sha;
    return api(repoPath("/contents/" + path), { method: "PUT", body: body });
  }

  /* Re-read brands.yml, apply change, write. Retries once if it changed meanwhile. */
  async function changeBrands(mutate, message) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var f = await getFile(BRANDS_PATH, "main");
      var cfg = L.parseBrands(f ? f.text : "brands: []\n");
      mutate(cfg);
      var text = L.dumpBrands(cfg);
      try {
        var r = await putFile(BRANDS_PATH, text, f && f.sha, message);
        S.cfg = cfg; S.cfgSha = r.content.sha;
        return r;
      } catch (e) { if ((e.status === 409 || e.status === 422) && attempt === 0) continue; throw e; }
    }
  }

  async function dispatchScan(brand, mode) {
    var inputs = { mode: mode || "default" };
    if (brand) inputs.brand = brand;
    await api(repoPath("/actions/workflows/" + WORKFLOW + "/dispatches"), { method: "POST", body: { ref: "main", inputs: inputs } });
    setTimeout(loadRuns, 4000);
    setTimeout(loadRuns, 12000);
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
      description: "Phone dashboard for " + (repoName || "phish-finder") + " (brands, schedule, scans). Only select repository: " + (repoName || "phish-finder"),
      expires_in: "366", contents: "write", actions: "write", workflows: "write", metadata: "read"
    });
    if (owner) p.set("target_name", owner);
    return "https://github.com/settings/personal-access-tokens/new?" + p.toString();
  }
  function showConnect(text) {
    $("connect").hidden = false; $("tabs").hidden = true; $("refreshBtn").hidden = true;
    ["home", "brands", "schedule", "runs"].forEach(function (v) { $(v).hidden = true; });
    var repo = localStorage.getItem(LS_REPO) || defaultRepo();
    $("repoInput").value = repo;
    var parts = repo.split("/");
    $("tokenLink").href = tokenUrl(parts[0], parts[1]);
    $("repoNameStep").textContent = parts[1] || "phish-finder";
    $("repoLabel").textContent = "";
    if (text) msg($("connectMsg"), text, "err");
  }
  $("repoInput").addEventListener("input", function () {
    var parts = this.value.trim().split("/");
    $("tokenLink").href = tokenUrl(parts[0], parts[1]);
    $("repoNameStep").textContent = parts[1] || "phish-finder";
  });
  $("connectBtn").addEventListener("click", async function () {
    var repo = $("repoInput").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    var token = $("tokenInput").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return msg($("connectMsg"), "Repository should look like owner/phish-finder", "err");
    if (!token) return msg($("connectMsg"), "Paste your GitHub key first", "err");
    S.repo = repo; S.token = token;
    this.disabled = true; msg($("connectMsg"), "Checking…");
    try {
      await verify();
      localStorage.setItem(LS_REPO, repo); localStorage.setItem(LS_TOKEN, token);
      $("tokenInput").value = "";
      msg($("connectMsg"), "");
      start();
    } catch (e) { msg($("connectMsg"), e.message, "err"); S.token = ""; }
    finally { this.disabled = false; }
  });
  async function verify() {
    var r = await api(repoPath(""));
    if (!r.private) toast("Warning: this repository is PUBLIC. Make it private in GitHub settings.");
    var p = r.permissions || {};
    if (p.push === false) throw new Error("This key can only read the repo. It needs Contents = Read and write.");
    try { var u = await api("/user"); S.user = u.login; } catch (e) { S.user = r.owner && r.owner.login; }
    return r;
  }
  $("disconnectBtn").addEventListener("click", function () {
    if (!confirm("Remove the GitHub key from this phone? You can connect again any time.")) return;
    localStorage.removeItem(LS_TOKEN); S.token = "";
    clearInterval(S.pollTimer);
    showConnect("");
  });

  /* ---------- navigation ---------- */
  function go(view) {
    ["home", "brands", "schedule", "runs"].forEach(function (v) { $(v).hidden = v !== view; });
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) { b.classList.toggle("on", b.dataset.view === view); });
    if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
    window.scrollTo(0, 0);
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) { b.addEventListener("click", function () { go(b.dataset.view); }); });
  $("refreshBtn").addEventListener("click", function () { loadAll(true); });

  async function start() {
    $("connect").hidden = true; $("tabs").hidden = false; $("refreshBtn").hidden = false;
    $("repoLabel").textContent = S.repo + " · private";
    $("whoami").textContent = (S.user || "GitHub") + " · " + S.repo;
    var v = (location.hash || "#home").slice(1);
    go(["home", "brands", "schedule", "runs"].indexOf(v) >= 0 ? v : "home");
    await loadAll(false);
    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(function () { if (!document.hidden && anyActive()) { loadRuns(); } }, 20000);
  }
  function anyActive() { return S.runs.some(function (r) { return r.status !== "completed"; }); }

  async function loadAll(manual) {
    var jobs = [loadConfig(), loadData(), loadRuns()];
    var res = await Promise.allSettled(jobs);
    var bad = res.filter(function (r) { return r.status === "rejected"; });
    if (bad.length) {
      var e = bad[0].reason;
      if (e && e.status === 401) { localStorage.removeItem(LS_TOKEN); return showConnect(e.message); }
      toast(e.message || String(e));
    } else if (manual) toast("Up to date");
  }

  async function loadConfig() {
    var pair = await Promise.all([getFile(BRANDS_PATH, "main"), getFile(WORKFLOW_PATH, "main")]);
    S.cfg = L.parseBrands(pair[0] ? pair[0].text : "brands: []\n"); S.cfgSha = pair[0] && pair[0].sha;
    S.wf = pair[1] ? pair[1].text : ""; S.wfSha = pair[1] && pair[1].sha;
    renderBrands(); renderScanForm(); initSchedule();
  }
  async function loadData() {
    var pair = await Promise.all([getFile("dashboard/summary.json", "state"), getFile("dashboard/history.json", "state")]);
    try { S.summary = pair[0] ? JSON.parse(pair[0].text) : null; } catch (e) { S.summary = null; }
    try { S.history = pair[1] ? JSON.parse(pair[1].text) : []; } catch (e) { S.history = []; }
    renderResults(); renderBrands(); renderRuns();
  }
  async function loadRuns() {
    var d = await api(repoPath("/actions/workflows/" + WORKFLOW + "/runs?per_page=15"));
    var before = S.runs.filter(function (r) { return r.status !== "completed"; }).map(function (r) { return r.id; });
    S.runs = d.workflow_runs || [];
    renderRuns(); renderLive();
    var justDone = S.runs.some(function (r) { return before.indexOf(r.id) >= 0 && r.status === "completed"; });
    if (justDone) { toast("A scan just finished – loading results"); setTimeout(loadData, 1500); }
  }

  /* ---------- Home: scan form + results ---------- */
  function brands() { return (S.cfg && S.cfg.brands) || []; }
  function settingsMode() { var m = S.cfg && S.cfg.settings && S.cfg.settings.mode; return L.MODES.indexOf(m) >= 0 ? m : "normal"; }
  function renderScanForm() {
    var sel = clear($("scanBrand"));
    sel.appendChild(h("option", { value: "", text: "All active brands" }));
    brands().forEach(function (b) { sel.appendChild(h("option", { value: b.name, text: b.name + (L.isEnabled(b.enabled) ? "" : " (paused)") })); });
    $("scanMode").value = settingsMode();
    var crons = L.readSchedule(S.wf || "");
    var nx = crons.length ? L.nextRuns(crons, new Date(), 1)[0] : null;
    $("nextScanLine").textContent = nx ? "Next automatic scan: " + L.fmtBahrain(nx, true) : "Automatic scans are off (see Schedule).";
  }
  $("scanBtn").addEventListener("click", async function () {
    var b = $("scanBrand").value, m = $("scanMode").value;
    this.disabled = true; msg($("scanMsg"), "Starting…");
    try {
      await dispatchScan(b, m);
      msg($("scanMsg"), "Scan started (" + (b || "all active brands") + ", " + m + "). It shows below in a few seconds; quick ≈ 5–10 min, normal ≈ 10–20 min, full can take an hour.", "ok");
    } catch (e) { msg($("scanMsg"), e.message, "err"); }
    finally { this.disabled = false; }
  });

  function sevPills(sev) {
    return ["critical", "high", "medium", "low"].filter(function (s) { return sev && sev[s]; }).map(function (s) { return h("span", { class: "pill sev-" + s, text: sev[s] + " " + s }); });
  }
  function scoreBox(f) {
    var sc = f.score === null || f.score === undefined ? "–" : f.score;
    return h("div", { class: "score sev-" + (f.severity || "info"), text: String(sc) });
  }
  function renderResults() {
    var box = clear($("results"));
    var sm = S.summary;
    if (!sm || !(sm.brands || []).some(function (b) { return b.generated_utc; })) {
      box.appendChild(h("div", { class: "card" }, h("p", { text: "No results yet. Results appear here after the next scan finishes (scans started before the dashboard was added show on GitHub only)." }),
        h("p", { class: "small" }, link("https://github.com/" + S.repo + "/actions/workflows/" + WORKFLOW, "Open scans on GitHub"))));
      return;
    }
    box.appendChild(h("p", { class: "muted small", text: "Updated " + L.fmtBahrain(sm.updated_utc, true) + ". Links are real (not defanged) – they may be live phishing pages. Never type real details into them." }));
    sm.brands.forEach(function (b) {
      if (!b.generated_utc) {
        box.appendChild(h("div", { class: "card" }, h("b", { text: b.name }), " ", h("span", { class: "muted small", text: "– not scanned yet" })));
        return;
      }
      var head = h("summary", {},
        h("div", { class: "row between" }, h("b", { text: b.name }), h("span", { class: "muted small", text: "▾" })),
        h("div", { class: "small muted", text: "Scanned " + L.fmtBahrain(b.generated_utc, true) + " · " + (b.depth || "") + " · " + (b.total || 0) + " findings" + (b.duration_s ? " · " + L.fmtDuration(b.duration_s) : "") }),
        h("div", {}, b.new_count ? h("span", { class: "pill new", text: b.new_count + " NEW" }) : null, sevPills(b.severity), b.enabled === false ? h("span", { class: "pill paused", text: "paused" }) : null));
      var list = h("div", {});
      (b.top || []).forEach(function (f) {
        var url = L.safeUrl(f.url) || L.safeUrl("https://" + f.host);
        list.appendChild(h("div", { class: "finding" }, scoreBox(f), h("div", { class: "body" },
          h("div", { class: "host" }, link(url, f.host || url), " ", f.is_new ? h("span", { class: "pill new", text: "NEW" }) : null, f.live ? h("span", { class: "pill", text: "live" }) : null),
          f.feed_url && f.feed_url !== url ? h("div", { class: "small" }, link(f.feed_url, f.feed_url)) : null,
          f.title ? h("div", { class: "small", text: "“" + f.title + "”" }) : null,
          h("div", { class: "why", text: (f.reasons || []).join(" · ") }))));
      });
      if (!(b.top || []).length) list.appendChild(h("p", { class: "muted", text: "Nothing found in this scan." }));
      var actions = h("div", { class: "row", style: "flex-wrap:wrap;margin-top:10px" });
      if (b.run_id) {
        actions.appendChild(h("button", { class: "small primary", onclick: function () { openReport(b); } }, "📄 Full report"));
        actions.appendChild(link("https://github.com/" + S.repo + "/actions/runs/" + b.run_id, "Scan on GitHub"));
      }
      if ((b.total || 0) > (b.top || []).length) list.appendChild(h("p", { class: "muted small", text: "Showing top " + (b.top || []).length + " of " + b.total + ". The full report has all of them." }));
      box.appendChild(h("details", { class: "card", open: sm.brands.length <= 2 ? true : null }, head, list, actions));
    });
  }

  /* Download the run artifact (zip), unzip <slug>/latest.html in the browser, show it sandboxed. */
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
      var want = [b.slug + "/latest.html", "latest.html"];
      var e = entries.find(function (x) { return want.indexOf(x.name) >= 0 || /\/latest\.html$/.test(x.name) && x.name.indexOf(b.slug + "/") >= 0; })
        || entries.find(function (x) { return x.name.indexOf(b.slug + "/") >= 0 && /\.html$/.test(x.name); });
      if (!e) throw new Error("Report for " + b.name + " not found in this scan's files.");
      var bytes = e.method === 0 ? e.data : await inflate(e.data);
      var html = new TextDecoder().decode(bytes).replace(/<head(\s[^>]*)?>/i, function (m) { return m + '<base target="_blank">'; });
      var blob = new Blob([html], { type: "text/html" });
      var url = URL.createObjectURL(blob);
      $("reportTitle").textContent = b.name + " report";
      $("reportFrame").src = url;
      var dl = $("reportDownload"); dl.href = url; dl.download = b.slug + "-phishing-report.html";
      $("reportView").hidden = false;
    } catch (err) {
      toast(err.message === "Failed to fetch" ? "Could not download the report here – opening the scan page on GitHub." : err.message);
      if (err.message === "Failed to fetch") window.open("https://github.com/" + S.repo + "/actions/runs/" + b.run_id, "_blank", "noopener");
    }
  }
  async function inflate(u8) {
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  $("reportClose").addEventListener("click", function () {
    $("reportView").hidden = true;
    var u = $("reportFrame").src; $("reportFrame").src = "about:blank";
    setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e) { /* */ } }, 1000);
  });

  /* ---------- Brands ---------- */
  function lastFor(name) {
    var sm = S.summary; if (!sm) return null;
    var sl = L.slug(name);
    return (sm.brands || []).find(function (b) { return b.slug === sl; }) || null;
  }
  function renderBrands() {
    var box = clear($("brandList"));
    if (!S.cfg) return;
    if (!brands().length) box.appendChild(h("div", { class: "card" }, "No brands yet. Tap “Add brand”."));
    brands().forEach(function (b, i) {
      var on = L.isEnabled(b.enabled), last = lastFor(b.name);
      box.appendChild(h("div", { class: "card brand" },
        h("div", { class: "row between" }, h("span", { class: "name", text: b.name }), on ? h("span", { class: "pill", text: "active" }) : h("span", { class: "pill paused", text: "paused" })),
        h("div", {}, link("https://" + b.domain, b.domain)),
        L.csv(b.official) ? h("div", { class: "small muted", text: "Also owns: " + L.csv(b.official) }) : null,
        L.csv(b.keywords) ? h("div", { class: "small muted", text: "Keywords: " + L.csv(b.keywords) }) : null,
        b.country ? h("div", { class: "small muted", text: "Country: " + String(b.country).toUpperCase() }) : null,
        last && last.generated_utc ? h("div", { class: "small", text: "Last scan " + L.fmtBahrain(last.generated_utc) + " · " + (last.total || 0) + " findings" + (last.new_count ? " · " + last.new_count + " new" : "") }) : h("div", { class: "small muted", text: "Not scanned yet" }),
        h("div", { class: "actions" },
          h("button", { class: "small", onclick: function () { editBrand(i); } }, "✏️ Edit"),
          h("button", { class: "small", onclick: function () { toggleBrand(i); } }, on ? "⏸ Pause" : "▶ Resume"),
          h("button", { class: "small", onclick: function () { scanOne(b.name); } }, "🔍 Scan"),
          h("button", { class: "small danger", onclick: function () { removeBrand(i); } }, "🗑 Remove"))));
    });
  }
  async function scanOne(name) {
    if (!confirm("Start a " + settingsMode() + " scan of " + name + " now?")) return;
    try { await dispatchScan(name, settingsMode()); toast("Scan of " + name + " started – see Home or Scans"); } catch (e) { toast(e.message); }
  }
  async function toggleBrand(i) {
    var b = brands()[i], name = b.name, on = L.isEnabled(b.enabled);
    try {
      await changeBrands(function (cfg) {
        var x = cfg.brands.find(function (y) { return L.slug(y.name) === L.slug(name); });
        if (!x) throw new Error(name + " is no longer in brands.yml");
        if (on) x.enabled = false; else delete x.enabled;
      }, (on ? "Pause" : "Resume") + " brand " + name + " (dashboard)");
      toast(name + (on ? " paused" : " resumed")); renderBrands(); renderScanForm();
    } catch (e) { toast(e.message); }
  }
  async function removeBrand(i) {
    var name = brands()[i].name;
    if (!confirm("Remove " + name + "? Automatic scans will stop for it. (Old results stay in past scans.)")) return;
    try {
      await changeBrands(function (cfg) { cfg.brands = cfg.brands.filter(function (y) { return L.slug(y.name) !== L.slug(name); }); }, "Remove brand " + name + " (dashboard)");
      toast(name + " removed"); renderBrands(); renderScanForm();
    } catch (e) { toast(e.message); }
  }
  var editing = -1;
  function editBrand(i) {
    editing = i;
    var f = $("brandForm"), b = i >= 0 ? brands()[i] : {};
    f.reset();
    f.name.value = b.name || ""; f.domain.value = b.domain || ""; f.official.value = L.csv(b.official); f.keywords.value = L.csv(b.keywords);
    f.country.value = b.country || ""; f.enabled.checked = i >= 0 ? L.isEnabled(b.enabled) : true;
    f.scanAfter.checked = i < 0;
    $("brandDlgTitle").textContent = i >= 0 ? "Edit " + b.name : "Add brand";
    msg($("brandMsg"), "");
    $("brandDlg").showModal();
  }
  $("addBrandBtn").addEventListener("click", function () { editBrand(-1); });
  $("brandCancel").addEventListener("click", function () { $("brandDlg").close(); });
  $("brandForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var f = this, btn = $("brandSave");
    var form = { name: f.name.value, domain: f.domain.value, official: f.official.value, keywords: f.keywords.value, country: f.country.value, enabled: f.enabled.checked };
    var oldName = editing >= 0 ? brands()[editing].name : null, scanAfter = f.scanAfter.checked;
    var nb;
    try {
      var others = brands().filter(function (x) { return !oldName || L.slug(x.name) !== L.slug(oldName); });
      nb = L.brandFromForm(form, editing >= 0 ? brands()[editing] : null, others);
    } catch (e) { return msg($("brandMsg"), e.message, "err"); }
    btn.disabled = true; msg($("brandMsg"), "Saving…");
    try {
      await changeBrands(function (cfg) {
        var others2 = cfg.brands.filter(function (x) { return !oldName || L.slug(x.name) !== L.slug(oldName); });
        var built = L.brandFromForm(form, oldName ? cfg.brands.find(function (x) { return L.slug(x.name) === L.slug(oldName); }) : null, others2);
        if (oldName) {
          var idx = cfg.brands.findIndex(function (x) { return L.slug(x.name) === L.slug(oldName); });
          if (idx < 0) cfg.brands.push(built); else cfg.brands[idx] = built;
        } else cfg.brands.push(built);
      }, (oldName ? "Edit brand " + oldName : "Add brand " + nb.name) + " (dashboard)");
      $("brandDlg").close();
      toast((oldName ? "Saved " : "Added ") + nb.name);
      renderBrands(); renderScanForm();
      if (scanAfter) { try { await dispatchScan(nb.name, "quick"); toast("Saved – quick scan of " + nb.name + " started"); } catch (e) { toast("Saved, but the scan did not start: " + e.message); } }
    } catch (e) { msg($("brandMsg"), e.message, "err"); }
    finally { btn.disabled = false; }
  });

  /* ---------- Schedule ---------- */
  (function () {
    var sel = $("schedEvery");
    L.EVERY_OPTIONS.forEach(function (n) { sel.appendChild(h("option", { value: String(n), text: n === 1 ? "1 hour" : n + " hours" })); });
    var days = $("daysWrap");
    L.DAY_NAMES.forEach(function (d, i) { days.appendChild(h("button", { type: "button", "data-day": String(i), text: d, onclick: function () { this.classList.toggle("on"); readSchedForm(); } })); });
    Array.prototype.forEach.call(document.querySelectorAll("#freqSeg button"), function (b) {
      b.addEventListener("click", function () { S.sched.freq = b.dataset.freq; paintSched(); });
    });
    ["schedTime", "schedEvery", "schedMode"].forEach(function (id) { $(id).addEventListener("change", readSchedForm); $(id).addEventListener("input", readSchedForm); });
  })();
  function initSchedule() {
    var crons = L.readSchedule(S.wf || ""), label = L.readScheduleLabel(S.wf || "");
    var p = L.parseCron(crons, label);
    $("schedCurrent").textContent = crons.length ? "Now: " + (p.freq === "custom" ? "custom schedule (" + crons.join(" | ") + " UTC)" : L.buildCron(p).label) + "." : "Now: automatic scans are off.";
    if (p.freq === "custom") p = { freq: "daily", time: "07:00", every: 6, days: [0, 1, 2, 3, 4] };
    S.sched = { freq: p.freq, time: p.time || "07:00", every: p.every || 6, days: p.days || [0, 1, 2, 3, 4], mode: settingsMode(), origCrons: crons, origMode: settingsMode() };
    paintSched();
  }
  function paintSched() {
    var s = S.sched; if (!s) return;
    Array.prototype.forEach.call(document.querySelectorAll("#freqSeg button"), function (b) { b.classList.toggle("on", b.dataset.freq === s.freq); });
    $("schedTime").value = s.time; $("schedEvery").value = String(s.every); $("schedMode").value = s.mode;
    Array.prototype.forEach.call(document.querySelectorAll("#daysWrap button"), function (b) { b.classList.toggle("on", s.days.indexOf(+b.dataset.day) >= 0); });
    $("timeWrap").hidden = s.freq === "off";
    $("timeWrap").firstChild.textContent = s.freq === "hours" ? "Starting at (Bahrain)" : "Time (Bahrain)";
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
  function avgMinutes() {
    var done = S.runs.filter(function (r) { return r.status === "completed" && r.conclusion === "success"; });
    var mins = done.map(function (r) { return (new Date(r.updated_at) - new Date(r.run_started_at || r.created_at)) / 60000; }).filter(function (m) { return m > 0 && m < 360; });
    if (!mins.length) return { m: S.sched.mode === "quick" ? 8 : S.sched.mode === "full" ? 45 : 18, guess: true };
    return { m: mins.reduce(function (a, b) { return a + b; }, 0) / mins.length, guess: false };
  }
  function previewSched() {
    var s = S.sched, out;
    try { out = L.buildCron(s); } catch (e) { $("schedPreview").textContent = e.message; $("schedCost").textContent = ""; return null; }
    var nx = L.nextRuns(out.crons, new Date(), 3).map(function (d) { return L.fmtBahrain(d, true); });
    $("schedPreview").textContent = out.label + (nx.length ? ". Next: " + nx.join(" · ") : ".");
    if (out.crons.length) {
      var per = L.runsPerMonth(out.crons), avg = avgMinutes();
      var est = Math.round(per * avg.m);
      $("schedCost").textContent = "≈ " + per + " scans/month × ~" + Math.round(avg.m) + " min" + (avg.guess ? " (estimate)" : " (your recent average)") + " ≈ " + est + " of the " + FREE_MINUTES + " free GitHub minutes per month." + (est > FREE_MINUTES * 0.8 ? " ⚠️ That is close to or over the free limit – choose fewer scans or Quick depth." : "");
    } else $("schedCost").textContent = "You can still start scans any time with “Scan now”.";
    return out;
  }
  $("schedSave").addEventListener("click", async function () {
    var out = previewSched(); if (!out) return msg($("schedMsg"), "Fix the schedule first", "err");
    var s = S.sched, btn = this;
    var cronChanged = JSON.stringify(out.crons) !== JSON.stringify(s.origCrons) || (out.crons.length && L.readScheduleLabel(S.wf).indexOf(out.label) < 0);
    var modeChanged = s.mode !== s.origMode;
    if (!cronChanged && !modeChanged) return msg($("schedMsg"), "Nothing changed.", "ok");
    btn.disabled = true; msg($("schedMsg"), "Saving…");
    try {
      if (cronChanged) {
        var f = await getFile(WORKFLOW_PATH, "main");
        if (!f) throw new Error("Workflow file " + WORKFLOW_PATH + " not found in the repo.");
        var text = L.rewriteSchedule(f.text, out.crons, out.label);
        if (text !== f.text) await putFile(WORKFLOW_PATH, text, f.sha, "Schedule: " + out.label + " (dashboard)");
        S.wf = text;
      }
      if (modeChanged) await changeBrands(function (cfg) { cfg.settings = cfg.settings || {}; cfg.settings.mode = s.mode; }, "Scheduled scan depth: " + s.mode + " (dashboard)");
      msg($("schedMsg"), "Saved. " + out.label + ", " + s.mode + " depth.", "ok");
      initSchedule(); renderScanForm();
    } catch (e) { msg($("schedMsg"), e.message, "err"); }
    finally { btn.disabled = false; }
  });

  /* ---------- Runs ---------- */
  function histFor(id) { return (S.history || []).find(function (x) { return String(x.run_id) === String(id); }); }
  function runIcon(r) {
    if (r.status !== "completed") return "⏳";
    return { success: "✅", failure: "❌", cancelled: "⏹", timed_out: "⌛", skipped: "⏭" }[r.conclusion] || "•";
  }
  function runRow(r) {
    var hi = histFor(r.id);
    var dur = r.status === "completed" ? L.fmtDuration((new Date(r.updated_at) - new Date(r.run_started_at || r.created_at)) / 1000) : "running " + L.fmtDuration((Date.now() - new Date(r.run_started_at || r.created_at)) / 1000);
    var what = r.event === "schedule" ? "Automatic scan" : r.event === "workflow_dispatch" ? "Manual scan" : r.event;
    var brandsTxt = hi && hi.brands && hi.brands.length ? hi.brands.map(function (b) { return b.name + (b.rc ? " (error)" : ""); }).join(", ") : "";
    return h("div", { class: "card run" }, h("div", { class: "st", text: runIcon(r) }),
      h("div", { class: "body" },
        h("div", {}, h("b", { text: what }), " · ", h("span", { class: "small", text: L.fmtBahrain(r.run_started_at || r.created_at, true) })),
        h("div", { class: "small muted", text: [dur, hi ? hi.mode : "", brandsTxt].filter(Boolean).join(" · ") }),
        hi ? h("div", {}, h("span", { class: "pill " + (hi.new_findings ? "new" : ""), text: "NEW_FINDINGS=" + hi.new_findings })) : null),
      link(r.html_url, "Open"));
  }
  function renderRuns() {
    var box = clear($("runList"));
    if (!S.runs.length) { box.appendChild(h("p", { class: "muted", text: "No scans yet." })); return; }
    S.runs.forEach(function (r) { box.appendChild(runRow(r)); });
  }
  function renderLive() {
    var box = clear($("liveRun"));
    S.runs.filter(function (r) { return r.status !== "completed"; }).slice(0, 3).forEach(function (r) { box.appendChild(runRow(r)); });
  }

  /* ---------- boot ---------- */
  S.token = localStorage.getItem(LS_TOKEN) || "";
  S.repo = localStorage.getItem(LS_REPO) || defaultRepo();
  if (!S.token || !S.repo) showConnect("");
  else verify().then(start).catch(function (e) { if (e.status === 401 || e.status === 404) { localStorage.removeItem(LS_TOKEN); showConnect(e.message); } else { start(); toast(e.message); } });
})();
