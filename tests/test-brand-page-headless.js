// Headless Chrome (mobile viewport) checks that brand cards open a filled detail page.
// Usage: node tests/test-brand-page-headless.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const assert = require("assert");
const root = path.join(__dirname, "..");
const demo = path.join(root, "demo");

function writeDemo() {
  fs.rmSync(demo, { recursive: true, force: true });
  fs.mkdirSync(path.join(demo, "fawry"), { recursive: true });
  fs.mkdirSync(path.join(demo, "alex-bank"), { recursive: true });
  fs.mkdirSync(path.join(demo, "al-hilal-bank", "al-hilal-bank"), { recursive: true });
  fs.mkdirSync(path.join(demo, "bank-muscat"), { recursive: true });
  fs.writeFileSync(path.join(demo, "brands.yml"), `brands:
  - name: Fawry
    domain: fawry.com
    country: eg
  - name: Alex Bank
    domain: alexbank.com
    country: eg
  - name: Al Hilal Bank
    domain: alhilalbank.ae
    country: ae
  - name: Bank Muscat
    domain: bankmuscat.com
    official: bankmuscat.om
    country: om
  - name: Abu dhabi commercial bank
    domain: adcb.com
    keywords: adcb
    country: ae
`);
  const top = (host, score, severity) => ({
    host, url: "https://" + host + "/", score, severity, is_new: true, live: true,
    title: "Login", reasons: ["+20 brand logo on page"], sources: ["urlscan"],
    flags: ["password"], brand: "",
  });
  const summaryBrand = (name, slug, domain, extras) => Object.assign({
    name, slug, domain, enabled: true, generated_utc: "2026-11-24T15:07:00+00:00",
    duration_s: 1200, depth: "normal", total: extras.top.length, new_count: 1,
    severity: { critical: 0, high: 1, medium: 0 },
    official_assets: { generated_utc: "2026-11-24T10:00:00+00:00", reused: true, images: 2, resources: 3, snippets: 1 },
    campaigns: [{ id: "c1", title: "Demo campaign", count: 1, hosts: [extras.top[0].host], max_score: 56, severity: "high" }],
    source_findings: [],
    top: extras.top
  }, extras.more || {});
  const summary = {
    schema: 1, updated_utc: "2026-11-24T15:13:00+00:00",
    last_run: { run_id: 1, generated_utc: "2026-11-24T15:13:00+00:00" },
    brands: [
      summaryBrand("Fawry", "fawry", "fawry.com", { top: [top("iouch.buzz", 63, "high")] }),
      summaryBrand("Alex Bank", "alex-bank", "alexbank.com", { top: [top("lexbank.us", 40, "medium")] }),
      summaryBrand("Al Hilal Bank", "al-hilal-bank", "alhilalbank.ae", { top: [top("alhilal.live", 30, "medium")] }),
      summaryBrand("Bank Muscat", "bank-muscat", "bankmuscat.com", { top: [top("ucat.cc", 20, "low")] }),
      summaryBrand("Abu dhabi commercial bank", "abu-dhabi-commercial-bank", "adcb.com", { top: [Object.assign(top("adcb-otp.pages.dev", 56, "high"), {
        shots: { m: "shots/abu-dhabi-commercial-bank/adcb-otp.pages.dev-m.webp" }, confirmed: true, live_state: "live",
        alert: { utc: "2026-11-24T20:00:00+00:00", issue: 1 }, render: { brand: ["ADCB"], inputs: { otp: 1 }, fraud: ["OTP/PIN"] } })] }),
    ]
  };
  fs.writeFileSync(path.join(demo, "summary.json"), JSON.stringify(summary));
  fs.mkdirSync(path.join(demo, "shots", "abu-dhabi-commercial-bank"), { recursive: true });
  // 1x1 WebP
  fs.writeFileSync(path.join(demo, "shots", "abu-dhabi-commercial-bank", "adcb-otp.pages.dev-m.webp"),
    Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
  fs.writeFileSync(path.join(demo, "history.json"), "[]");
  fs.copyFileSync(path.join(__dirname, "fixture-phish-scan.yml"), path.join(demo, "phish-scan.yml"));

  // Full report: findings have no flags (this used to throw in hasLogin and leave the skeleton).
  // official_assets uses lists, as the live latest.json files do (summary uses counts).
  const fawryLatest = {
    generated_utc: "2026-11-24T15:07:58+00:00", duration_s: 1800, depth: "normal",
    brand: { name: "Fawry", domain: "fawry.com", country: "eg", official_names: ["Fawry"], generated_keywords: ["ماي فوري"] },
    stats: { total: 2, severity: { critical: 0, high: 1, medium: 1 }, new_count: 1 },
    findings: [
      { host: "iouch.buzz", score: 63, severity: "high", is_new: true, reasons: ["+20 Fawry logo"], sources: ["urlscan"], url: "https://iouch.buzz/beZNcVlYQ" },
      { host: "example-fawry-phish.test", score: 40, severity: "medium", reasons: ["+10 brand text"], sources: ["html"] }
    ],
    campaigns: [{ id: "camp-sisi", title: "Sisi gift", hosts: ["iouch.buzz"], count: 1, max_score: 63, severity: "high", is_new_campaign: true }],
    official_assets: {
      generated_utc: "2026-11-23T21:53:01+00:00", reused: true,
      favicon: { mmh3: 123, sha256: "abcdabcdabcdabcdffff" },
      images: ["aaa", "bbb"], resources: ["ccc"], snippets: ["Fawry"]
    },
    source_findings: [{ type: "app", title: "Fake Fawry app", url: "https://example.com/app", official_dev: "unofficial" }],
    learned_fingerprints: [{ id: "fp1" }]
  };
  fs.writeFileSync(path.join(demo, "fawry", "latest.json"), JSON.stringify(fawryLatest));

  const alexLatest = {
    generated_utc: "2026-11-24T15:07:31+00:00",
    brand: { name: "Alex Bank", domain: "alexbank.com", country: "eg" },
    findings: [{
      host: "lexbank.us", score: 40, severity: "medium", reasons: ["+10 lookalike"], sources: ["ct"],
      probe: { live: true, status: 200, title: "Alex Bank login", password_field: true, final_url: "https://lexbank.us/" }
    }]
  };
  fs.writeFileSync(path.join(demo, "alex-bank", "latest.json"), JSON.stringify(alexLatest));

  // Nested path only (slug/slug/latest.json) — the post-matrix layout some runs used.
  const hilalLatest = {
    generated_utc: "2026-11-24T15:10:37+00:00",
    brand: { name: "Al Hilal Bank", domain: "alhilalbank.ae", country: "ae" },
    findings: [{ host: "nested-hilal.test", score: 44, severity: "medium", reasons: ["+10 from nested report"] }]
  };
  fs.writeFileSync(path.join(demo, "al-hilal-bank", "al-hilal-bank", "latest.json"), JSON.stringify(hilalLatest));
}

function contentType(file) {
  return ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
    ".yml": "text/yaml", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".webp": "image/webp" })[path.extname(file)] || "application/octet-stream";
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
      let file = path.join(root, url === "/" ? "index.html" : url);
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found " + url); return; }
        res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
        res.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function main() {
  writeDemo();
  const puppeteer = require("puppeteer-core");
  const srv = await startServer();
  const port = srv.address().port;
  const base = "http://127.0.0.1:" + port + "/index.html?demo=1";
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  page.on("pageerror", (e) => { page._pfErrors = (page._pfErrors || []).concat([String(e)]); });

  async function assertBrandOpen(expectedH1, mustHave) {
    await page.waitForSelector("#brand:not([hidden])", { timeout: 8000 });
    await page.waitForFunction(() => {
      const box = document.getElementById("brandPage");
      return box && box.querySelector("h1") && !box.querySelector(":scope > .skeleton");
    }, { timeout: 8000 });
    const info = await page.evaluate(() => {
      const box = document.getElementById("brandPage");
      const onlySkeleton = box && box.children.length === 1 && box.firstElementChild && box.firstElementChild.classList.contains("skeleton");
      return {
        hidden: document.getElementById("brand").hidden,
        h1: (box.querySelector("h1") || {}).textContent || "",
        text: box.innerText,
        skeletonOnly: !!onlySkeleton,
        skeletonCount: box.querySelectorAll(".skeleton").length,
        findingCount: box.querySelectorAll(".finding").length,
        error: /Couldn't open this brand/.test(box.innerText)
      };
    });
    const errors = page._pfErrors || [];
    assert.ok(!info.hidden, "brand view should be visible");
    assert.ok(!info.skeletonOnly, "detail must not stay as a single skeleton card: " + JSON.stringify(info));
    assert.ok(!info.error, "render threw: " + info.text);
    assert.strictEqual(info.h1, expectedH1, JSON.stringify(info));
    assert.ok(info.findingCount >= 1, "expected incidents, got " + info.findingCount + " " + info.text.slice(0, 400));
    for (const s of mustHave || []) assert.ok(info.text.includes(s), "missing " + s + " in: " + info.text.slice(0, 800));
    assert.ok(!errors.length, "page errors: " + errors.join(" | "));
    return info;
  }

  // 1. Brands tab → tap Fawry card (findings in latest.json have no flags: the old crash)
  await page.goto(base + "#brands", { waitUntil: "networkidle0" });
  await page.waitForSelector(".brand-card", { timeout: 8000 });
  const cards = await page.$$eval(".brand-card .bname", (els) => els.map((e) => e.textContent));
  assert.ok(cards.includes("Fawry") && cards.includes("Al Hilal Bank") && cards.includes("Bank Muscat"), "cards: " + cards);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".brand-card")].find((c) => c.querySelector(".bname") && c.querySelector(".bname").textContent === "Fawry");
    card.click();
  });
  const fawry = await assertBrandOpen("Fawry", ["iouch.buzz", "example-fawry-phish.test", "Official assets", "2 logo/image hash(es)", "Fake Fawry app"]);
  assert.ok(fawry.findingCount >= 2, fawry.findingCount);

  // 2. Nested latest.json path for Al Hilal Bank
  await page.click("#brandBack");
  await page.waitForSelector("#brands:not([hidden])");
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".brand-card")].find((c) => c.querySelector(".bname") && c.querySelector(".bname").textContent === "Al Hilal Bank");
    card.click();
  });
  await assertBrandOpen("Al Hilal Bank", ["nested-hilal.test"]);

  // 3. Direct hash + compactFullFinding path (Alex Bank latest has probe)
  await page.goto(base + "#brand/alex-bank", { waitUntil: "networkidle0" });
  await assertBrandOpen("Alex Bank", ["lexbank.us"]);

  // 4. Brand with only summary (no latest.json) still fills, not a skeleton
  await page.goto(base + "#brand/abu-dhabi-commercial-bank", { waitUntil: "networkidle0" });
  await assertBrandOpen("Abu dhabi commercial bank", ["adcb-otp.pages.dev"]);

  // 5. Incident view shows the scanner's own phone screenshot, confirmation and alert status
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("#brandPage .finding")].find((r) => r.innerText.includes("adcb-otp.pages.dev"));
    row.click();
  });
  await page.waitForSelector("#findingDlg[open] img.shot-m", { timeout: 8000 });
  await page.waitForFunction(() => { const i = document.querySelector("#findingDlg img.shot-m"); return i && i.complete && i.naturalWidth > 0; }, { timeout: 8000 });
  const dlg = await page.$eval("#findingDlg", (d) => d.innerText);
  assert.ok(/live, confirmed phishing/.test(dlg) && /alerted/.test(dlg) && /Phone 390/.test(dlg) && /Phone render shows the brand: ADCB/.test(dlg), dlg.slice(0, 600));

  await browser.close();
  srv.close();
  console.log("ok - brand cards open a filled detail view on a mobile viewport (including no-flags findings and nested latest.json)");
  console.log("ok - incident view shows the phone screenshot, confirmed and alerted status");
}

main().catch((e) => { console.error(e); process.exit(1); });
