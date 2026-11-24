// node tests/test-progress.js
const assert = require("assert");
const L = require("../dashlib.js");
let n = 0;
function t(name, fn) { fn(); n++; console.log("ok -", name); }

t("progressFromJobs tracks every matrix job, not just Plan brands", () => {
  const planDone = { name: "Plan brands", status: "completed", steps: [{ name: "List brands to scan", status: "completed" }] };
  const scanRun = {
    name: "Scan Fawry", status: "in_progress",
    steps: [{ name: "Checkout", status: "completed" }, { name: "Run scan", status: "in_progress" }]
  };
  const mid = L.progressFromJobs([planDone, scanRun, { name: "Scan Alex Bank", status: "queued" }, { name: "Publish results", status: "queued" }]);
  assert.ok(mid.total === 4 && mid.done === 1, JSON.stringify(mid));
  assert.ok(mid.pct > 4 && mid.pct < 50, "plan-finished must not look complete: " + mid.pct);
  assert.match(mid.label, /Scan Fawry/);
  assert.match(mid.label, /long part/);

  const allQueued = L.progressFromJobs([
    { name: "Plan brands", status: "queued" },
    { name: "Scan Al Hilal Bank", status: "queued" },
    { name: "Publish results", status: "queued" }
  ]);
  assert.ok(allQueued.pct <= 10, allQueued.pct);
  assert.match(allQueued.label, /runner/i);

  const publishRun = L.progressFromJobs([
    planDone,
    { name: "Scan Bank Muscat", status: "completed", steps: [{ name: "Run scan", status: "completed" }] },
    { name: "Publish results", status: "in_progress", steps: [{ name: "Merge run records", status: "in_progress" }] }
  ]);
  assert.ok(publishRun.pct >= 60 && publishRun.pct < 100, publishRun.pct);
  assert.match(publishRun.label, /Publish results/);

  const empty = L.progressFromJobs([]);
  assert.strictEqual(empty.pct, 4);
  assert.match(empty.label, /Starting/);

  const skipped = L.progressFromJobs([
    planDone,
    { name: "Scan Other", status: "skipped" },
    { name: "Publish results", status: "in_progress", steps: [{ name: "Upload combined reports", status: "in_progress" }] }
  ]);
  assert.strictEqual(skipped.total, 2);
  assert.ok(skipped.pct < 100, skipped.pct);

  const legacy = L.progressFromJobs([{
    name: "scan", status: "in_progress",
    steps: [
      { name: "Checkout", status: "completed" },
      { name: "Set up Python", status: "completed" },
      { name: "Run scan", status: "in_progress" },
      { name: "Upload reports", status: "queued" }
    ]
  }]);
  assert.ok(legacy.pct >= 4 && legacy.pct < 100, legacy.pct);
  assert.match(legacy.label, /Run scan/);
});

console.log(`\n${n} test groups passed`);
