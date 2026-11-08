/*
 * Sovereign compute allocation model.
 *
 * Agent-based, weekly time step. A pool of firms has bursty compute demand
 * (training runs). Capacity is divided into 1 MW blocks. Three allocation rules
 * are compared on the same demand stream (common random numbers):
 *
 *   committee  periodic merit review; grants last the whole cycle; between
 *              rounds, unallocated blocks are available first-come-first-served
 *   lease      first-come-first-served fixed-term leases at a fixed (subsidized)
 *              price; holders renew if holding is worth more than the price
 *   harberger  self-assessed licences: holders declare a price per block each
 *              billing period, pay a charge on it, and must sell at that price
 *
 * Holding an idle block is worth something to a firm: if its next burst arrives
 * it avoids waiting to re-acquire capacity. That "option value" is computed
 * from the firm's own burst rate and the wait it is currently seeing under
 * the rule in force. Under lease and committee rules this drives hoarding.
 * Under harberger it sets the (low) price at which idle blocks are released.
 *
 * Works in the browser (window.ComputeModel) and Node (module.exports).
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.ComputeModel = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const WEEKS_PER_MONTH = 4;
  const RULES = ["committee", "lease", "harberger"];

  const DEFAULTS = {
    // Pool and demand
    capacityMw: 100,          // capacity in the sandbox, 1 MW blocks
    firms: 60,                // eligible firms competing for it
    load: 1.2,                // mean demanded MW / capacity (1 = exactly full)
    burstMwMin: 2, burstMwMax: 12,     // size of a training run (MW)
    burstWeeksMin: 2, burstWeeksMax: 10, // length of a training run (weeks)
    valueSigma: 0.7,          // dispersion of value per MW across firms (lognormal)
    valuePerMwMonth: 1.7,     // $M CAD value of 1 facility-MW-month to the average user (≈570 H100 at ~US$2.80/GPU-hr 1-yr contract, 1.41 CAD/USD)
    maxWaitWeeks: 12,         // firms give up (go abroad) after waiting this long
    migrationDays: 3,         // capacity lost when a block changes hands
    delayCost: 0.5,           // share of a week's value lost per week a run is delayed
    // Committee
    committeeCycleMonths: 6,
    committeeNoise: 0.6,      // review scoring error (lognormal sd)
    committeeBuffer: 1.25,    // firms request this multiple of their need
    committeeKeepProb: 0.5,   // chance an idle recent user applies "just in case"
    committeeSpecDiscount: 0.5, // reviewers discount requests with no active project
    committeeReclaimWeeks: 8, // unused allocations are taken back after this long (0 = never)
    // Lease
    leaseTermMonths: 6,
    leasePriceFraction: 0.3,  // lease price as a share of valuePerMwMonth
    // Harberger
    taxRatePerMonth: 0.025,   // charge on declared value, per month
    billingWeeks: 4,          // how often declarations reset and buyouts clear
    // Program design options (all off by default)
    smeShare: 0.5,            // share of firms that are SMEs (random, independent of value)
    smeCashLimit: 1,          // SMEs can pay at most this share of a run's value up front (1 = no constraint)
    voucherShare: 0,          // share of SMEs' lease, buyout and licence costs paid by the Compute Access Fund
    reserveShare: 0,          // share of blocks only SMEs may hold
    runLockWeeks: 0,          // licence: blocks of a running job can't be bought for this long (0 = off)
    lockSurcharge: 1,         // licence: extra charge on locked blocks, as a multiple of the base charge
    backfillShare: 0,         // share of allocated-but-idle capacity used by preemptible backfill jobs
    backfillValue: 0.5,       // value of backfill work relative to an average firm's run
    // Run
    weeks: 52, warmupWeeks: 26, seeds: 20, seed: 1,
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    const u = mulberry32(seed);
    const gauss = () => {
      let a = 0;
      while (a === 0) a = u();
      return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
    };
    return {
      u,
      lognMean1: (s) => Math.exp(s * gauss() - (s * s) / 2),
      int: (lo, hi) => lo + Math.floor(u() * (hi - lo + 1)),
    };
  }

  function derived(P) {
    const C = Math.max(1, Math.round(P.capacityMw));
    const meanMw = (P.burstMwMin + P.burstMwMax) / 2;
    const meanWk = (P.burstWeeksMin + P.burstWeeksMax) / 2;
    // Fraction of time a firm is running a burst, to hit the target load.
    const activeFrac = Math.min(0.9, (P.load * C) / (P.firms * meanMw));
    const idleWeeks = (meanWk * (1 - activeFrac)) / activeFrac;
    const pStart = 1 / Math.max(1, idleWeeks);
    return {
      C, pStart,
      valWk: P.valuePerMwMonth / WEEKS_PER_MONTH,
      migLoss: P.migrationDays / 7, // block-weeks lost per transferred block
      qMonth: 1 - Math.pow(1 - pStart, WEEKS_PER_MONTH), // P(burst within a month)
      leasePrice: P.leasePriceFraction * P.valuePerMwMonth, // per block-month
    };
  }

  function simulateOne(rule, P, seed) {
    if (!RULES.includes(rule)) throw new Error("unknown rule " + rule);
    const D = derived(P);
    const { C, valWk, migLoss } = D;
    const N = P.firms;
    const demand = makeRng(seed);           // shared across rules
    const noise = makeRng(seed ^ 0x9e3779b9); // rule-specific randomness

    const firms = [];
    for (let i = 0; i < N; i++) {
      firms.push({ v: demand.lognMean1(P.valueSigma), burst: null, lastMw: 0, recent: false, lastActive: 0 });
    }
    const smeRng = makeRng(seed ^ 0x51ed2701); // same SME flags under every rule
    for (const f of firms) f.sme = smeRng.u() < P.smeShare;
    const Rsv = Math.round(Math.max(0, Math.min(1, P.reserveShare)) * C); // blocks [0, Rsv) are SME-only
    const vs = Math.max(0, Math.min(1, P.voucherShare));
    // Can firm i afford a cost, given the value it would get? SMEs face a cash limit, eased by vouchers.
    const affordable = (i, cost, value) => firms[i].sme
      ? (1 - vs) * cost < Math.min(1, P.smeCashLimit) * value
      : cost < value;
    const holder = new Int32Array(C).fill(-1);
    const price = new Float64Array(C);
    const assignedWeek = new Int32Array(C).fill(-1e9);
    const expiry = new Int32Array(C);

    let recentWait = 4;   // smoothed weeks to acquire capacity (what firms expect)
    let turnover = 0.1;   // smoothed share of blocks transferred per billing period
    const T = P.warmupWeeks + P.weeks;
    const cycleWeeks = Math.max(1, P.committeeCycleMonths * WEEKS_PER_MONTH);
    const tau = P.taxRatePerMonth;

    const m = {
      usedBW: 0, idleHeldBW: 0, freeBW: 0, value: 0, revenue: 0,
      waits: [], started: 0, abandoned: 0, bursts: 0, transfers: 0,
      served: new Set(), monthly: [], _mUsed: 0, _mWeeks: 0, voucher: 0,
    };

    const fUsed = new Float64Array(N), fStarted = new Int32Array(N), fAband = new Int32Array(N), fCharge = new Float64Array(N);
    const counts = new Int32Array(N);
    const recount = () => {
      counts.fill(0);
      for (let b = 0; b < C; b++) if (holder[b] >= 0) counts[holder[b]]++;
    };
    const assign = (b, i, w) => {
      if (holder[b] !== i) {
        if (holder[b] >= 0) m.transfers += w >= P.warmupWeeks ? 1 : 0;
        holder[b] = i;
        assignedWeek[b] = w;
      }
    };
    // Value per month of keeping one idle block: chance the next run starts
    // this month times what waiting `recentWait` weeks for capacity would cost
    // (capped at losing a whole average run).
    const meanWk = (P.burstWeeksMin + P.burstWeeksMax) / 2;
    const optionValue = (f) =>
      D.qMonth * f.v * valWk * Math.min(recentWait * P.delayCost, meanWk);

    const waitingFirms = () => {
      const out = [];
      for (let i = 0; i < N; i++) {
        const b = firms[i].burst;
        if (b && counts[i] < b.mw) out.push(i);
      }
      return out;
    };

    // Give free blocks to waiting firms in order of arrival (rapid access / FCFS).
    const fcfsFree = (w, onAssign, accept) => {
      recount();
      const free = [];
      for (let b = 0; b < C; b++) if (holder[b] < 0) free.push(b);
      if (!free.length) return;
      const wait = waitingFirms().sort((a, b) => firms[a].burst.waitSince - firms[b].burst.waitSince);
      for (const i of wait) {
        const need = firms[i].burst.mw - counts[i];
        const pool = firms[i].sme ? free : free.filter((b) => b >= Rsv);
        if (need > pool.length) continue;
        if (accept && !accept(i)) continue;
        // SMEs use reserved blocks first; everyone else takes from the top.
        const take = firms[i].sme && Rsv > 0 ? pool.slice(0, need) : pool.slice(pool.length - need).reverse();
        const tk = new Set(take);
        for (const b of take) {
          assign(b, i, w);
          if (onAssign) onAssign(b);
        }
        for (let k = free.length - 1; k >= 0; k--) if (tk.has(free[k])) free.splice(k, 1);
        counts[i] += need;
      }
    };

    // ---- rule steps -------------------------------------------------------
    function stepCommittee(w) {
      if (w % cycleWeeks === 0) {
        const prev = Int32Array.from(holder);
        holder.fill(-1);
        const apps = [];
        for (let i = 0; i < N; i++) {
          const f = firms[i];
          let need = 0;
          if (f.burst) need = f.burst.mw;
          else if (f.recent && noise.u() < P.committeeKeepProb) need = f.lastMw;
          if (need > 0) {
            const spec = f.burst ? 1 : P.committeeSpecDiscount;
            apps.push({ i, req: Math.ceil(need * P.committeeBuffer), score: spec * f.v * noise.lognMean1(P.committeeNoise) });
          }
          f.recent = false;
        }
        apps.sort((a, b) => b.score - a.score);
        let remaining = C;
        for (const a of apps) {
          if (a.req > remaining) continue;
          remaining -= a.req;
          let left = a.req;
          // Keep blocks the firm already had (no migration), then fill.
          const ok = (b) => firms[a.i].sme || b >= Rsv;
          let avail = 0;
          for (let b = 0; b < C; b++) if (holder[b] < 0 && ok(b)) avail++;
          if (avail < a.req) { remaining += a.req; continue; }
          for (let b = 0; b < C && left; b++) if (prev[b] === a.i && holder[b] < 0 && ok(b)) { holder[b] = a.i; left--; }
          for (let b = 0; b < C && left; b++) if (holder[b] < 0 && prev[b] !== a.i && ok(b)) { assign(b, a.i, w); left--; }
        }
        for (let b = 0; b < C; b++) if (holder[b] >= 0 && holder[b] !== prev[b]) assignedWeek[b] = w;
      } else if (P.committeeReclaimWeeks > 0) {
        // Use-it-or-lose-it: take back blocks from firms idle for too long.
        for (let b = 0; b < C; b++) {
          const i = holder[b];
          if (i < 0 || firms[i].burst) continue;
          const since = Math.max(firms[i].lastActive, assignedWeek[b]);
          if (w - since >= P.committeeReclaimWeeks) holder[b] = -1;
        }
      }
      fcfsFree(w);
    }

    function stepLease(w) {
      for (let b = 0; b < C; b++) {
        const i = holder[b];
        if (i < 0 || expiry[b] > w) continue;
        const f = firms[i];
        const keep = !!f.burst || optionValue(f) > D.leasePrice;
        if (keep) expiry[b] = w + P.leaseTermMonths * WEEKS_PER_MONTH;
        else holder[b] = -1;
      }
      // A firm signs a lease only if its run plus the value of keeping the
      // capacity for the rest of the term covers the lease cost.
      const termWeeks = P.leaseTermMonths * WEEKS_PER_MONTH;
      const worthIt = (i) => {
        const f = firms[i];
        const runValue = f.burst.v * valWk * f.burst.left;
        const restMonths = Math.max(0, (termWeeks - f.burst.left) / WEEKS_PER_MONTH);
        const cost = D.leasePrice * P.leaseTermMonths, value = runValue + restMonths * optionValue(f);
        return f.sme ? (1 - vs) * cost <= Math.min(1, P.smeCashLimit) * value : cost <= value;
      };
      fcfsFree(w, (b) => { expiry[b] = w + termWeeks; }, worthIt);
      let leased = 0, smeLeased = 0;
      for (let b = 0; b < C; b++) if (holder[b] >= 0) { leased++; if (firms[holder[b]].sme) smeLeased++; }
      if (w >= P.warmupWeeks) {
        m.revenue += (leased * D.leasePrice) / WEEKS_PER_MONTH;
        m.voucher += (vs * smeLeased * D.leasePrice) / WEEKS_PER_MONTH;
      }
    }

    function stepHarberger(w) {
      const period = Math.max(1, Math.round(P.billingWeeks));
      if (w % period !== 0) { fcfsFree(w); return; }
      recount();
      const shade = tau / (tau + Math.max(0.02, turnover));
      // Declarations: a firm's first `mw` blocks carry the value of its current
      // run, any extra blocks only their option value.
      const seen = new Int32Array(N);
      for (let b = 0; b < C; b++) {
        const i = holder[b];
        if (i < 0) { price[b] = 0; continue; }
        const f = firms[i];
        const opt = optionValue(f);
        let h = opt;
        if (f.burst && seen[i] < f.burst.mw) {
          // Value of finishing the current run (lost if the block is sold).
          h = f.burst.v * valWk * f.burst.left + opt;
        }
        seen[i]++;
        price[b] = h * (1 - shade);
      }
      // Run protection: blocks of a job that started less than runLockWeeks ago can't be bought.
      const locked = (b) => {
        const s = holder[b];
        if (s < 0 || P.runLockWeeks <= 0) return false;
        const fb = firms[s].burst;
        return !!fb && fb.started >= 0 && w - fb.started < P.runLockWeeks;
      };
      let charge = 0, smeCharge = 0;
      for (let b = 0; b < C; b++) {
        if (holder[b] < 0) continue;
        const c = tau * price[b] * (locked(b) ? 1 + P.lockSurcharge : 1);
        charge += c;
        if (firms[holder[b]].sme) smeCharge += c;
        if (w >= P.warmupWeeks) fCharge[holder[b]] += c * (period / WEEKS_PER_MONTH);
      }
      if (w >= P.warmupWeeks) {
        m.revenue += charge * (period / WEEKS_PER_MONTH);
        m.voucher += vs * smeCharge * (period / WEEKS_PER_MONTH);
      }

      // Buyouts: waiting firms, highest value first, buy the cheapest blocks.
      let moved = 0;
      const wait = waitingFirms().sort((a, b) => firms[b].burst.v - firms[a].burst.v);
      for (const i of wait) {
        const f = firms[i];
        const need = f.burst.mw - counts[i];
        if (need <= 0) continue;
        const cand = [];
        for (let b = 0; b < C; b++) if (holder[b] !== i && (f.sme || b >= Rsv) && !locked(b)) cand.push(b);
        if (cand.length < need) continue;
        cand.sort((a, b) => price[a] - price[b]);
        const take = cand.slice(0, need);
        const cost = take.reduce((s, b) => s + price[b], 0);
        // Buyer's value: completing its run, net of migration downtime.
        const perBlock = f.burst.v * valWk * (f.burst.left - migLoss);
        if (!affordable(i, cost, perBlock * need)) continue;
        if (w >= P.warmupWeeks && f.sme) m.voucher += vs * cost;
        for (const b of take) {
          const s = holder[b];
          if (s >= 0) {
            counts[s]--;
            moved++;
            const sb = firms[s].burst;
            if (sb && sb.started >= 0 && counts[s] < sb.mw && sb.waitSince < 0) sb.waitSince = w;
          }
          assign(b, i, w);
          price[b] = perBlock * (1 - shade);
        }
        counts[i] += need;
      }
      turnover = 0.7 * turnover + 0.3 * ((moved / C) * (WEEKS_PER_MONTH / period));
    }

    const step = { committee: stepCommittee, lease: stepLease, harberger: stepHarberger }[rule];

    // ---- main loop --------------------------------------------------------
    for (let w = 0; w < T; w++) {
      const measuring = w >= P.warmupWeeks;

      // 1. Demand (same draws regardless of rule).
      for (let i = 0; i < N; i++) {
        const u = demand.u(), mw = demand.int(P.burstMwMin, P.burstMwMax);
        const len = demand.int(P.burstWeeksMin, P.burstWeeksMax), vm = demand.lognMean1(0.3);
        const f = firms[i];
        if (!f.burst && u < D.pStart) {
          f.burst = { mw, left: len, v: f.v * vm, created: w, started: -1, waitSince: w };
          f.lastMw = mw;
          f.recent = true;
          if (measuring) m.bursts++;
        }
      }

      // 2. Allocation.
      step(w);
      recount();

      // 3. Run bursts that hold enough capacity; account.
      let used = 0;
      for (let i = 0; i < N; i++) {
        const f = firms[i];
        const b = f.burst;
        if (!b || counts[i] < b.mw) continue;
        if (b.started < 0) {
          b.started = w;
          const waited = w - b.created;
          recentWait = 0.9 * recentWait + 0.1 * waited;
          if (measuring) { m.waits.push(waited); m.started++; m.served.add(i); fStarted[i]++; }
        }
        b.waitSince = -1;
        f.lastActive = w;
        // Migration downtime: a block assigned `age` weeks ago loses
        // min(1, migLoss - age) of this week (spread if migration > 1 week).
        let lost = 0, nBlocks = 0;
        for (let k = 0; k < C && nBlocks < b.mw; k++) {
          if (holder[k] !== i) continue;
          nBlocks++;
          lost += Math.max(0, Math.min(1, migLoss - (w - assignedWeek[k])));
        }
        const eff = b.mw - lost;
        used += eff;
        if (measuring) { m.value += eff * valWk * b.v; fUsed[i] += eff; }
        if (--b.left <= 0) f.burst = null;
      }
      // Waiting bursts give up after maxWaitWeeks.
      for (let i = 0; i < N; i++) {
        const b = firms[i].burst;
        if (b && counts[i] < b.mw) {
          if (b.waitSince < 0) b.waitSince = w;
          if (w - b.waitSince >= P.maxWaitWeeks) {
            if (b.started < 0) recentWait = 0.9 * recentWait + 0.1 * P.maxWaitWeeks;
            if (measuring) { m.abandoned++; fAband[i]++; }
            firms[i].burst = null;
          }
        }
      }

      if (measuring) {
        let held = 0;
        for (let k = 0; k < C; k++) if (holder[k] >= 0) held++;
        // Backfill: preemptible jobs use part of the allocated-but-idle capacity.
        const bf = Math.max(0, Math.min(1, P.backfillShare)) * Math.max(0, held - used);
        m.value += bf * valWk * P.backfillValue;
        m.usedBW += used + bf;
        m.idleHeldBW += held - used - bf;
        m.freeBW += C - held;
        m._mUsed += used + bf;
        if (++m._mWeeks === WEEKS_PER_MONTH) {
          m.monthly.push((100 * m._mUsed) / (C * WEEKS_PER_MONTH));
          m._mUsed = 0; m._mWeeks = 0;
        }
      }
    }

    const BW = C * P.weeks;
    const yr = 52 / P.weeks;
    const sorted = m.waits.slice().sort((a, b) => a - b);
    // Program-goal metrics. Firms ranked by their typical value per MW: the
    // lower half stands in for firms less able to pay (e.g. early-stage SMEs).
    const byV = firms.map((f, i) => i).sort((a, b) => firms[a].v - firms[b].v);
    const low = byV.slice(0, Math.floor(N / 2));
    const sum = (ix, arr) => ix.reduce((s, i) => s + arr[i], 0);
    const totUsed = sum(byV, fUsed) || 1;
    const lowSt = sum(low, fStarted), lowAb = sum(low, fAband);
    const byUse = byV.slice().sort((a, b) => fUsed[b] - fUsed[a]);
    const usedMonths = m.usedBW / WEEKS_PER_MONTH;
    const sme = byV.filter((i) => firms[i].sme);
    const smeSt = sum(sme, fStarted), smeAb = sum(sme, fAband);
    return {
      highValueChargeShare: (() => { const t = sum(byV, fCharge); return t ? (100 * (t - sum(low, fCharge))) / t : 0; })(),
      smeShare: (100 * sum(sme, fUsed)) / totUsed,
      smeAbandon: smeSt + smeAb ? (100 * smeAb) / (smeSt + smeAb) : 0,
      voucherM: m.voucher * yr,
      lowValueShare: (100 * sum(low, fUsed)) / totUsed,
      lowValueAbandon: lowSt + lowAb ? (100 * lowAb) / (lowSt + lowAb) : 0,
      top10Share: (100 * sum(byUse.slice(0, Math.max(1, Math.round(N / 10))), fUsed)) / totUsed,
      costPctValue: usedMonths ? (100 * m.revenue) / (usedMonths * P.valuePerMwMonth) : 0,
      utilization: (100 * m.usedBW) / BW,
      idleHeld: (100 * m.idleHeldBW) / BW,
      unallocated: (100 * m.freeBW) / BW,
      valueM: m.value * yr,
      revenueM: m.revenue * yr,
      meanWait: m.waits.length ? m.waits.reduce((a, b) => a + b, 0) / m.waits.length : 0,
      medianWait: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      abandonRate: m.started + m.abandoned ? (100 * m.abandoned) / (m.started + m.abandoned) : 0,
      firmsServed: m.served.size,
      transfersPerMonth: m.transfers / (P.weeks / WEEKS_PER_MONTH),
      monthly: m.monthly,
    };
  }

  const METRICS = ["utilization", "idleHeld", "unallocated", "valueM", "revenueM",
    "meanWait", "medianWait", "abandonRate", "firmsServed", "transfersPerMonth",
    "lowValueShare", "lowValueAbandon", "top10Share", "costPctValue", "smeShare", "smeAbandon", "voucherM", "highValueChargeShare"];

  function summarize(runs) {
    const out = {};
    for (const k of METRICS) {
      const xs = runs.map((r) => r[k]).sort((a, b) => a - b);
      const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
      out[k] = { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p10: q(0.1), p90: q(0.9) };
    }
    const months = runs[0].monthly.length;
    out.monthly = Array.from({ length: months }, (_, j) => runs.reduce((s, r) => s + r.monthly[j], 0) / runs.length);
    return out;
  }

  function run(params) {
    const P = Object.assign({}, DEFAULTS, params || {});
    const res = {};
    for (const rule of RULES) {
      const runs = [];
      for (let s = 0; s < P.seeds; s++) runs.push(simulateOne(rule, P, P.seed * 7919 + s * 104729));
      res[rule] = summarize(runs);
    }
    return { params: P, results: res };
  }

  // Quadratic matching. Each project: array of contributions.
  // alpha = 1 is full quadratic funding, alpha = 0 is plain 1:1 dollar matching;
  // in between, the CLR weight is blended. Matches are scaled to the pool.
  function quadraticMatch(projects, pool, alpha) {
    const a = alpha == null ? 1 : alpha;
    const w = projects.map((p) => {
      const sumC = p.contributions.reduce((s, c) => s + c, 0);
      const sumRoot = p.contributions.reduce((s, c) => s + Math.sqrt(c), 0);
      const qf = Math.max(0, sumRoot * sumRoot - sumC);
      return { sumC, weight: a * qf + (1 - a) * sumC, linear: sumC };
    });
    const tw = w.reduce((s, x) => s + x.weight, 0) || 1;
    const tl = w.reduce((s, x) => s + x.linear, 0) || 1;
    return w.map((x) => ({ private: x.sumC, match: (pool * x.weight) / tw, linearMatch: (pool * x.linear) / tl }));
  }

  // Named comparison scenarios used in the brief and the report.
  const SCENARIOS = [
    { id: "committee", label: "Committee, 6-month cycle", rule: "committee", params: {} },
    { id: "committeeBest", label: "Committee, best practice (3-mo cycle, 4-wk reclaim, no buffer)", rule: "committee",
      params: { committeeCycleMonths: 3, committeeReclaimWeeks: 4, committeeBuffer: 1.0 } },
    { id: "leaseSub", label: "Subsidized lease (6 mo at 30% of value)", rule: "lease", params: {} },
    { id: "leaseMkt", label: "Market-priced lease (1 mo at 60% of value)", rule: "lease",
      params: { leaseTermMonths: 1, leasePriceFraction: 0.6 } },
    { id: "licMonthly", label: "Self-assessed licence, monthly billing", rule: "harberger", params: {} },
    { id: "licWeekly", label: "Self-assessed licence, weekly billing", rule: "harberger", params: { billingWeeks: 1 } },
    { id: "licDesign", label: "Self-assessed licence, recommended design (weekly; running jobs protected up to 12 wk; 1.25%/mo)", rule: "harberger",
      params: { billingWeeks: 1, runLockWeeks: 12, taxRatePerMonth: 0.0125 } },
  ];

  function runScenarios(params) {
    const base = Object.assign({}, DEFAULTS, params || {});
    return SCENARIOS.map((sc) => {
      const P = Object.assign({}, base, sc.params);
      const runs = [];
      for (let s = 0; s < P.seeds; s++) runs.push(simulateOne(sc.rule, P, P.seed * 7919 + s * 104729));
      return Object.assign({}, sc, { result: summarize(runs) });
    });
  }

  return { DEFAULTS, RULES, SCENARIOS, WEEKS_PER_MONTH, run, runScenarios, simulateOne, quadraticMatch, derived };
});
