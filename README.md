# Sovereign Compute Allocation Model

An open, agent-based model comparing ways to allocate scarce public AI compute to Canadian firms: periodic committee review, fixed-term leases, and self-assessed (Harberger) licences. It also includes a quadratic-matching calculator for SME co-funding.

**Live model:** https://erik-pcpvr.github.io/sovereign-compute-model/

## What it does

Sixty firms with bursty training demand compete for a 100 MW pool of 1 MW blocks. The same demand stream runs under seven allocation rules, averaged over 20 seeds, with 10th–90th percentile ranges. Every assumption is a slider in the page; the *Assumptions & limitations* tab explains the mechanics and what the model leaves out (notably strategic gaming and shared-scheduler backfill).

Base case (demand 1.2× capacity):

| Rule | Capacity in use | Mean wait | Runs abandoned |
|---|---|---|---|
| Committee, 6-month cycle | 40% | 6.5 wk | 47% |
| Committee, best practice | 64% | 5.8 wk | 22% |
| Subsidized 6-month lease | 18% | 2.5 wk | 78% |
| Market-priced 1-month lease | 67% | 4.6 wk | 30% |
| Self-assessed licence, monthly | 75% | 1.9 wk | 30% |
| Self-assessed licence, weekly | 83% | 0.3 wk | 18% |
| **Self-assessed licence, recommended design** (weekly; running jobs protected up to 12 wk; 1.25%/mo) | **90%** | **1.6 wk** | **17%** |

Against the program's stated goals (recommended design vs best-practice committee):
- **Value:** 29% more value delivered from the same capacity.
- **Access for smaller firms:** the half of firms that gain least per MW get 41% vs 35% of the capacity used and abandon 29% vs 34% of their runs.
- **Concentration:** the top 10% of firms use 25% vs 27% of the capacity used.
- **Affordability:** licence charges cost users about 2.5% of the value of the compute they use.
- **Robustness:** the result holds when SMEs can pay only half their value up front (their abandoned runs go from 15% to 17%, against 28% to 52% under a market-priced lease), with a two-week migration window, and with idealized scheduler backfill.

*Program design options* in the page let you test SME cash limits, Access Fund vouchers, reserved SME blocks, run protection and backfill.

These are model outputs, not forecasts.

## Files

- `index.html`: the interactive page (no build step, no dependencies)
- `model.js`: the model; works in the browser (`window.ComputeModel`) and Node
- `test-model.js`: sanity checks and a text report: `node test-model.js`

## Author

Erik Peterson, Toronto. Built in a personal capacity to accompany a brief to the House of Commons Standing Committees on Science and Research and on Industry and Technology. MIT licence.
