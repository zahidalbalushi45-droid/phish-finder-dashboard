// node tests/test.js  - logic tests for dashlib.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const L = require("../dashlib.js");
let n = 0;
function t(name, fn) { fn(); n++; console.log("ok -", name); }

t("daily 07:00 Bahrain -> 04:00 UTC", () => {
  assert.deepStrictEqual(L.buildCron({ freq: "daily", time: "07:00" }).crons, ["0 4 * * *"]);
  assert.deepStrictEqual(L.buildCron({ freq: "daily", time: "01:30" }).crons, ["30 22 * * *"]);
  assert.deepStrictEqual(L.buildCron({ freq: "daily", time: "00:00" }).crons, ["0 21 * * *"]);
});
t("every 6 hours from 07:00", () => {
  assert.deepStrictEqual(L.buildCron({ freq: "hours", time: "07:00", every: 6 }).crons, ["0 4,10,16,22 * * *"]);
  assert.deepStrictEqual(L.buildCron({ freq: "hours", time: "02:15", every: 12 }).crons, ["15 11,23 * * *"]);
});
t("weekdays shift back a day when UTC crosses midnight", () => {
  assert.deepStrictEqual(L.buildCron({ freq: "weekdays", time: "08:00", days: [0, 1, 2, 3, 4] }).crons, ["0 5 * * 0,1,2,3,4"]);
  assert.deepStrictEqual(L.buildCron({ freq: "weekdays", time: "02:00", days: [0, 4] }).crons, ["0 23 * * 3,6"]);
});
t("off -> no cron", () => assert.deepStrictEqual(L.buildCron({ freq: "off" }).crons, []));
t("bad input throws", () => {
  assert.throws(() => L.buildCron({ freq: "daily", time: "25:00" }));
  assert.throws(() => L.buildCron({ freq: "hours", time: "07:00", every: 5 }));
  assert.throws(() => L.buildCron({ freq: "weekdays", time: "07:00", days: [] }));
});
t("parseCron round-trips every shape", () => {
  const cases = [
    { freq: "daily", time: "07:00" }, { freq: "daily", time: "00:45" }, { freq: "daily", time: "23:59" },
    { freq: "hours", time: "01:00", every: 3 }, { freq: "hours", time: "07:30", every: 1 }, { freq: "hours", time: "06:00", every: 8 },
    { freq: "weekdays", time: "02:00", days: [0, 4, 6] }, { freq: "weekdays", time: "09:10", days: [5] }, { freq: "off" },
  ];
  for (let h = 0; h < 24; h++) cases.push({ freq: "weekdays", time: String(h).padStart(2, "0") + ":05", days: [0, 1, 6] });
  for (const c of cases) {
    const back = L.parseCron(L.buildCron(c).crons);
    assert.strictEqual(back.freq, c.freq, JSON.stringify(c));
    if (c.freq === "hours") { // start hour is only known modulo N; same run times
      assert.deepStrictEqual(L.buildCron(back).crons, L.buildCron(c).crons);
    } else if (c.freq !== "off") assert.strictEqual(back.time, c.time, JSON.stringify(c));
    if (c.freq === "hours") assert.strictEqual(back.every, c.every);
    if (c.freq === "weekdays") assert.deepStrictEqual(back.days, c.days);
  }
  assert.strictEqual(L.parseCron(["*/5 * * * *"]).freq, "custom");
  assert.strictEqual(L.parseCron(["0 4 1 * *"]).freq, "custom");
});
t("nextRuns uses UTC cron and Bahrain display", () => {
  const from = new Date("2026-11-23T00:00:00Z");
  const r = L.nextRuns(["0 4 * * *"], from, 2);
  assert.strictEqual(r[0].toISOString(), "2026-11-23T04:00:00.000Z");
  assert.strictEqual(L.fmtBahrain(r[0]), "23 Nov, 07:00 Bahrain");
  assert.strictEqual(L.runsPerMonth(["0 4,10,16,22 * * *"]), 30 * 4 + 0 || 120); // Jan 1..30
  const w = L.nextRuns(["0 23 * * 3,6"], from, 1)[0]; // Thu 02:00 Bahrain = Wed 23:00 UTC
  assert.strictEqual(w.toISOString(), "2026-11-25T23:00:00.000Z");
});
t("rewriteSchedule edits only the schedule block of the real workflow", () => {
  const wf = fs.readFileSync(path.join(__dirname, "fixture-phish-scan.yml"), "utf8");
  assert.deepStrictEqual(L.readSchedule(wf), ["0 4 * * *"]);
  const b = L.buildCron({ freq: "hours", time: "07:00", every: 6 });
  const wf2 = L.rewriteSchedule(wf, b.crons, b.label);
  assert.deepStrictEqual(L.readSchedule(wf2), ["0 4,10,16,22 * * *"]);
  const b2 = L.buildCron({ freq: "hours", time: "13:00", every: 6 });
  const wf3 = L.rewriteSchedule(wf, b2.crons, b2.label);
  assert.strictEqual(L.parseCron(L.readSchedule(wf3), L.readScheduleLabel(wf3)).time, "13:00");
  const strip = (s) => s.split("\n").filter((l) => !/^\s*(- cron:|# .*Bahrain time|schedule:)/.test(l)).join("\n");
  assert.strictEqual(strip(wf2), strip(wf));
  const off = L.rewriteSchedule(wf2, [], "");
  assert.deepStrictEqual(L.readSchedule(off), []);
  assert.ok(/\n  workflow_dispatch:/.test(off) && !/schedule:/.test(off.split("workflow_dispatch")[0].split("\non:")[1]));
  const on = L.rewriteSchedule(off, ["0 4 * * *"], "Daily at 07:00 Bahrain time");
  assert.deepStrictEqual(L.readSchedule(on), ["0 4 * * *"]);
  const yaml = require("../js-yaml.min.js");
  for (const s of [wf2, off, on]) {
    const doc = yaml.load(s);
    assert.ok(doc.on.workflow_dispatch.inputs.mode);
    assert.strictEqual(doc.jobs.scan.steps.length, yaml.load(wf).jobs.scan.steps.length);
  }
  fs.writeFileSync("/tmp/wf-hours.yml", wf2); fs.writeFileSync("/tmp/wf-off.yml", off); fs.writeFileSync("/tmp/wf-on.yml", on);
});
t("brands.yml dump matches python brands_cfg byte-for-byte", () => {
  const repo = process.env.PF_REPO || "/workspace/phish-finder-repo";
  const samples = [
    fs.readFileSync(path.join(repo, "brands.yml"), "utf8"),
    "brands:\n  - {name: Example Bank, domain: ExampleBank.com, keywords: [exbank, 'ex-bank'], country: no, enabled: no}\n  - name: \"1 Bank: Gulf\"\n    domain: 1bank.bh\n    days: 45\n    official: \"a.com,b.com\"\n",
    "settings: {mode: full}\nbrands: []\n",
  ];
  for (const s of samples) {
    const js = L.dumpBrands(L.parseBrands(s));
    fs.writeFileSync("/tmp/sample.yml", s);
    const py = execFileSync("python3", ["-c", "import sys;sys.path.insert(0,'" + repo + "/tools');import brands_cfg as b;sys.stdout.write(b.dump(b.load('/tmp/sample.yml')))"]).toString();
    assert.strictEqual(js, py);
    assert.strictEqual(L.dumpBrands(L.parseBrands(js)), js); // idempotent
  }
});
t("brandFromForm validates and cleans", () => {
  const b = L.brandFromForm({ name: " NBB ", domain: "https://www.NBBonline.com/en", official: "nbb.bh, https://nbb.com.bh/", keywords: "nbb ,  national bank", country: "BH" }, null, []);
  assert.deepStrictEqual(b, { name: "NBB", domain: "nbbonline.com", official: "nbb.bh, nbb.com.bh", keywords: "nbb, national bank", country: "bh" });
  assert.throws(() => L.brandFromForm({ name: "X", domain: "not a domain" }, null, []));
  assert.throws(() => L.brandFromForm({ name: "Fawry", domain: "fawry2.com" }, null, [{ name: "fawry" }]));
  assert.throws(() => L.brandFromForm({ name: "X", domain: "x.com", country: "bhr" }, null, []));
});
t("utf8 base64 + safeUrl", () => {
  const s = "Ajeer أجير ✓";
  assert.strictEqual(L.b64DecodeUtf8(L.b64EncodeUtf8(s)), s);
  assert.strictEqual(L.safeUrl("javascript:alert(1)"), "");
  assert.strictEqual(L.safeUrl("http://fawrymicrofinance.com/"), "http://fawrymicrofinance.com/");
});
t("zip reader", () => {
  execFileSync("bash", ["-c", "rm -rf /tmp/ztest && mkdir -p /tmp/ztest/fawry && echo '<h1>hi</h1>' > /tmp/ztest/fawry/latest.html && cd /tmp/ztest && python3 -c \"import zipfile;z=zipfile.ZipFile('/tmp/ztest.zip','w',zipfile.ZIP_DEFLATED);z.write('fawry/latest.html');z.close()\""]);
  const e = L.zipEntries(fs.readFileSync("/tmp/ztest.zip"));
  assert.strictEqual(e[0].name, "fawry/latest.html");
  assert.strictEqual(e[0].method, 8);
  assert.strictEqual(require("zlib").inflateRawSync(Buffer.from(e[0].data)).toString(), "<h1>hi</h1>\n");
});
console.log(`\n${n} test groups passed`);
