# Sovereign Compute Allocation Model

An open, agent-based model comparing ways to allocate scarce public AI compute to Canadian firms: periodic committee review, fixed-term leases, and self-assessed (Harberger) licences. It also includes a quadratic-matching calculator for SME co-funding.

**Live model:** https://erik-pcpvr.github.io/sovereign-compute-model/

## What it does

Sixty firms with bursty training demand compete for a 100 MW pool of 1 MW blocks. The same demand stream runs under six allocation rules, averaged over 20 seeds, with 10th–90th percentile ranges. Every assumption is a slider in the page; the *Assumptions & limitations* tab explains the mechanics and what the model leaves out (notably strategic gaming and shared-scheduler backfill).

Base case (demand 1.2× capacity):

| Rule | Capacity in use | Mean wait | Runs abandoned |
|---|---|---|---|
| Committee, 6-month cycle | 40% | 6.5 wk | 47% |
| Committee, best practice | 64% | 5.8 wk | 22% |
| Subsidized 6-month lease | 18% | 2.5 wk | 78% |
| Market-priced 1-month lease | 67% | 4.6 wk | 30% |
| Self-assessed licence, monthly | 75% | 1.9 wk | 30% |
| Self-assessed licence, weekly | 83% | 0.3 wk | 19% |

These are model outputs, not forecasts.

## Files

- `index.html`: the interactive page (no build step, no dependencies)
- `model.js`: the model; works in the browser (`window.ComputeModel`) and Node
- `test-model.js`: sanity checks and a text report: `node test-model.js`

## Author

Erik Peterson, Toronto. Built in a personal capacity to accompany a brief to the House of Commons Standing Committees on Science and Research and on Industry and Technology. MIT licence.
