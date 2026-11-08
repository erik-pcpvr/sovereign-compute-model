// Sanity checks and a base-case report. Run: node simulator/test-model.js [--report]
const assert = require("assert");
const M = require("./model.js");

const fmt = (x, d = 1) => x.toFixed(d);
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("ok   " + name); }
  catch (e) { failures++; console.log("FAIL " + name + "\n     " + e.message); }
}

const base = M.run({});
const R = base.results;

check("deterministic for a given seed", () => {
  const again = M.run({});
  assert.strictEqual(again.results.harberger.utilization.mean, R.harberger.utilization.mean);
});

check("shares add to 100% (used + idle-held + unallocated)", () => {
  for (const r of M.RULES) {
    const s = R[r].utilization.mean + R[r].idleHeld.mean + R[r].unallocated.mean;
    assert.ok(Math.abs(s - 100) < 1e-6, `${r}: ${s}`);
  }
});

check("utilization within [0,100] for every rule", () => {
  for (const r of M.RULES) assert.ok(R[r].utilization.p10 >= 0 && R[r].utilization.p90 <= 100);
});

check("committee and lease raise no licence revenue / committee raises none", () => {
  assert.strictEqual(R.committee.revenueM.mean, 0);
});

check("low load: committee and licence serve nearly everyone", () => {
  const lo = M.run({ load: 0.3, seeds: 8 }).results;
  for (const r of ["committee", "harberger"]) assert.ok(lo[r].abandonRate.mean < 15, `${r} abandon ${lo[r].abandonRate.mean}`);
});

check("lease hoarding falls as the lease gets shorter and less subsidized", () => {
  const long = M.run({ leaseTermMonths: 12, leasePriceFraction: 0.15, seeds: 8 }).results.lease.idleHeld.mean;
  const short = M.run({ leaseTermMonths: 1, leasePriceFraction: 0.6, seeds: 8 }).results.lease.idleHeld.mean;
  assert.ok(short < long, `${long} -> ${short}`);
});

check("licence: weekly billing beats monthly on utilization", () => {
  const mo = M.run({ seeds: 8 }).results.harberger.utilization.mean;
  const wk = M.run({ seeds: 8, billingWeeks: 1 }).results.harberger.utilization.mean;
  assert.ok(wk > mo, `${mo} -> ${wk}`);
});

check("utilization cannot exceed demand: at load 0.3 every rule is below 40%", () => {
  const lo = M.run({ load: 0.3, seeds: 8 }).results;
  for (const r of M.RULES) assert.ok(lo[r].utilization.mean < 40, `${r} ${lo[r].utilization.mean}`);
});

check("harberger revenue scales with the charge rate", () => {
  const a = M.run({ taxRatePerMonth: 0.01, seeds: 8 }).results.harberger.revenueM.mean;
  const b = M.run({ taxRatePerMonth: 0.05, seeds: 8 }).results.harberger.revenueM.mean;
  assert.ok(b > a, `${a} -> ${b}`);
});

check("goal metrics are shares within [0,100] and committee charges nothing", () => {
  for (const r of M.RULES) for (const k of ["lowValueShare", "lowValueAbandon", "top10Share"]) {
    assert.ok(R[r][k].mean >= 0 && R[r][k].mean <= 100, `${r} ${k} ${R[r][k].mean}`);
  }
  assert.strictEqual(R.committee.costPctValue.mean, 0);
  assert.ok(R.harberger.lowValueShare.mean < 50, "lower-value half should use less than half");
});

check("a voucher exactly offsetting the SME cash limit restores the unconstrained result", () => {
  const free = M.run({ seeds: 6 }).results.harberger.utilization.mean;
  const fixed = M.run({ seeds: 6, smeCashLimit: 0.5, voucherShare: 0.5 }).results.harberger.utilization.mean;
  assert.ok(Math.abs(free - fixed) < 1e-9, `${free} vs ${fixed}`);
});

check("reserving every block for SMEs gives SMEs all the capacity used", () => {
  const r = M.run({ seeds: 4, reserveShare: 1 }).results;
  for (const rule of M.RULES) assert.ok(r[rule].smeShare.mean > 99.9, `${rule} ${r[rule].smeShare.mean}`);
});

check("backfill raises utilization under every rule", () => {
  const a = M.run({ seeds: 4 }).results, b = M.run({ seeds: 4, backfillShare: 0.5 }).results;
  for (const rule of M.RULES) assert.ok(b[rule].utilization.mean > a[rule].utilization.mean, rule);
});

check("protecting running jobs cuts abandonment when migration is slow", () => {
  const off = M.run({ seeds: 8, billingWeeks: 1, migrationDays: 14 }).results.harberger.abandonRate.mean;
  const on = M.run({ seeds: 8, billingWeeks: 1, migrationDays: 14, runLockWeeks: 12 }).results.harberger.abandonRate.mean;
  assert.ok(on < off, `${off} -> ${on}`);
});

check("quadratic match: one big donor gets no CLR match; many small donors do", () => {
  const out = M.quadraticMatch([
    { contributions: [1_000_000] },
    { contributions: Array(400).fill(2500) },
  ], 10, 1);
  assert.strictEqual(out[0].match, 0);
  assert.ok(Math.abs(out[1].match - 10) < 1e-9);
});

if (process.argv.includes("--report") || failures === 0) {
  const P = base.params;
  console.log(`\nBase case: ${P.capacityMw} MW, ${P.firms} firms, load ${P.load}, ` +
    `charge ${fmt(P.taxRatePerMonth * 100, 1)}%/mo, committee cycle ${P.committeeCycleMonths} mo, ` +
    `lease ${P.leaseTermMonths} mo @ ${fmt(P.leasePriceFraction * 100, 0)}% of value, migration ${P.migrationDays} d, ${P.seeds} seeds`);
  const rows = [
    ["Util %", "utilization", 1], ["Idle-held %", "idleHeld", 1], ["Free %", "unallocated", 1],
    ["Value $M/yr", "valueM", 0], ["Crown $M/yr", "revenueM", 1], ["Wait wk", "meanWait", 1],
    ["Abandon %", "abandonRate", 1], ["Firms", "firmsServed", 0],
    ["LowV use %", "lowValueShare", 0], ["LowV aband %", "lowValueAbandon", 0], ["Top10 %", "top10Share", 0], ["Paid % val", "costPctValue", 1],
  ];
  const pad = (x, n) => String(x).padEnd(n);
  console.log(pad("Scenario", 64) + rows.map((r) => pad(r[0], 13)).join(""));
  for (const sc of M.runScenarios({})) {
    console.log(pad(sc.label.slice(0, 62), 64) + rows.map(([, k, d]) =>
      pad(`${fmt(sc.result[k].mean, d)}`, 13)).join(""));
  }
  console.log("(means over " + P.seeds + " seeds; p10–p90 ranges available in the UI and CSV)");

  console.log("\nSensitivity (harberger vs committee, utilization % / value $M):");
  const sweeps = [
    ["load", [0.6, 0.9, 1.2, 1.6]],
    ["migrationDays", [0, 3, 7, 14]],
    ["taxRatePerMonth", [0.005, 0.01, 0.025, 0.05, 0.1]],
    ["committeeCycleMonths", [1, 3, 6, 12]],
    ["valueSigma", [0.1, 0.4, 0.7, 1.2]],
  ];
  for (const [k, vals] of sweeps) {
    const line = vals.map((v) => {
      const r = M.run({ [k]: v, seeds: 10 }).results;
      return `${v}: H ${fmt(r.harberger.utilization.mean, 0)}/${fmt(r.harberger.valueM.mean, 0)}` +
        ` C ${fmt(r.committee.utilization.mean, 0)}/${fmt(r.committee.valueM.mean, 0)}` +
        ` L ${fmt(r.lease.utilization.mean, 0)}/${fmt(r.lease.valueM.mean, 0)}`;
    });
    console.log(`  ${k.padEnd(22)} ${line.join(" | ")}`);
  }
}
process.exit(failures ? 1 : 0);
