# Tiny EMA Surfer

[![competition](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/competitions/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/zeetasw8-sketch/makefun-gorun-tiny-bot-01/rank.svg)](https://make.fun/competitions/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/zeetasw8-sketch/makefun-gorun-tiny-bot-01/reward.svg)](https://make.fun/competitions/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Entry for the make.fun competition **"Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana"** — a tiny long-only trading bot that reads one batch of hourly bars and answers with orders, until the data ends.

## How it works

- **Signal:** EMA crossover per symbol — fast EMA (span 9) crossing above slow EMA (span 21) on the hourly close enters a long position; the position is sold in full when the slow EMA moves back above the fast EMA.
- **Risk controls:** take profit at +50% of cost, stop loss at −12% of cost, and a trailing exit if the position falls to 90% of its peak value while in profit. Position values are computed exactly with `BigInt` from the quoted on-chain scales.
- **Sizing:** each buy uses `min(equity / nSlots, max_weight_bps * equity / 10000, unused cash)`, where `nSlots = min(universe size, max_open_positions)`. Sells go first, then buys, in alphabetical symbol order, within `max_orders_per_bar`. No shorts, no leverage, no orders during warmup.
- **Determinism:** no clock, no randomness, no environment reads — two runs produce a byte-identical action log. Money is always `BigInt`; only indicator prices use `float64`.

## Files

- `main.ts` — the whole bot (Node 22 TypeScript, no dependencies, only the `readline` builtin; NDJSON `bars-replay/v1` on stdin/stdout).

## Local dev result (grade-local, process driver)

- Net PnL **−144.997 USDC** over the dev window (136 hourly bars), **22 trades** across 7 symbols, **max drawdown 2.07%**, 0 rejected orders, action log reproduced byte for byte.
- Buy-and-hold baseline on the same dev window: **−869.338 USDC**, 7 trades, max drawdown 10.92% — the bot beats it by about **+724 USDC**.

## License

MIT — see `LICENSE`.
