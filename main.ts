// Tiny Bot — EMA crossover, long-only (bars-replay/v1).
// Reads NDJSON on stdin, writes exactly one reply JSON line per batch to stdout.
// Deterministic: no clock, no randomness, no environment reads.
// Money is BigInt; indicator prices are float64.

import * as readline from "readline";

type HelloSymbol = {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
};

type HelloMsg = {
  type: "hello";
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: {
    fee_bps: number;
    slippage_bps: number;
    min_notional_quote_units: string;
  };
  latency_bars: number;
  warmup_bars: number;
};

type Bar = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth?: string | null;
  c_depth?: string | null;
};

type Position = {
  symbol: string;
  qty: string;
  cost_quote_units: string;
};

type Account = {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
};

type BatchMsg = {
  type: "batch";
  seq: number;
  t: number;
  bars: Bar[];
  fills: unknown[];
  account: Account;
};

type Order =
  | {
      side: "buy";
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

type SymbolState = {
  symbol: string;
  priceScale: number;
  qtyScale: number;
  fastSpan: number;
  slowSpan: number;
  fastCloses: number[];
  slowCloses: number[];
  fastEma: number | null;
  slowEma: number | null;
  prevDiff: number | null;
  peak: bigint | null;
};

const FAST_SPAN = 9;
const SLOW_SPAN = 21;

let hello: HelloMsg | null = null;
let batchCount = 0;
const states = new Map<string, SymbolState>();

function getState(sym: HelloSymbol): SymbolState {
  let st = states.get(sym.symbol);
  if (!st) {
    st = {
      symbol: sym.symbol,
      priceScale: sym.price_scale,
      qtyScale: sym.qty_scale,
      fastSpan: FAST_SPAN,
      slowSpan: SLOW_SPAN,
      fastCloses: [],
      slowCloses: [],
      fastEma: null,
      slowEma: null,
      prevDiff: null,
      peak: null,
    };
    states.set(sym.symbol, st);
  }
  return st;
}

function updateEma(st: SymbolState, close: number): void {
  // Fast EMA.
  if (st.fastEma === null) {
    st.fastCloses.push(close);
    if (st.fastCloses.length === st.fastSpan) {
      let sum = 0;
      for (const v of st.fastCloses) sum += v;
      st.fastEma = sum / st.fastSpan;
      st.fastCloses = [];
    }
  } else {
    const k = 2 / (st.fastSpan + 1);
    st.fastEma = st.fastEma + k * (close - st.fastEma);
  }
  // Slow EMA.
  if (st.slowEma === null) {
    st.slowCloses.push(close);
    if (st.slowCloses.length === st.slowSpan) {
      let sum = 0;
      for (const v of st.slowCloses) sum += v;
      st.slowEma = sum / st.slowSpan;
      st.slowCloses = [];
    }
  } else {
    const k = 2 / (st.slowSpan + 1);
    st.slowEma = st.slowEma + k * (close - st.slowEma);
  }
}

function positionValueQuoteUnits(
  qtyStr: string,
  closeStr: string,
  qtyScale: number,
  priceScale: number,
  quoteScale: number,
): bigint {
  const qty = BigInt(qtyStr);
  const close = BigInt(closeStr);
  const numerator = qty * close * 10n ** BigInt(quoteScale);
  const denominator = 10n ** BigInt(qtyScale + priceScale);
  return numerator / denominator;
}

function handleBatch(batch: BatchMsg): void {
  const seq = batch.seq;
  const orders: Order[] = [];

  if (hello === null) {
    process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
    batchCount += 1;
    return;
  }

  const warmingUp = batchCount < hello.warmup_bars;
  const quoteScale = hello.capital.quote_scale;
  const account: Account = batch.account;
  const equity = BigInt(account.equity_quote_units);
  let cashRemaining = BigInt(account.cash_quote_units);
  const minNotional = BigInt(hello.fees.min_notional_quote_units);

  const symbolsByName = new Map<string, HelloSymbol>();
  for (const s of hello.symbols) symbolsByName.set(s.symbol, s);
  const universe = [...hello.symbols].sort((a, b) =>
    a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0,
  );

  const barBySymbol = new Map<string, Bar>();
  for (const bar of batch.bars || []) barBySymbol.set(bar.symbol, bar);

  const held = new Map<string, Position>();
  for (const p of account.positions || []) {
    if (BigInt(p.qty) !== 0n) held.set(p.symbol, p);
  }

  // First pass: update EMAs for every bar present, and record diffs.
  // diffBySymbol is the current fast-minus-slow diff when both EMAs exist.
  // prevDiffBySymbol is the diff from the previous bar for that symbol.
  const diffBySymbol = new Map<string, number>();
  const prevDiffBySymbol = new Map<string, number | null>();
  const zeroVolume = new Set<string>();

  for (const bar of batch.bars || []) {
    const sym = symbolsByName.get(bar.symbol);
    if (!sym) continue;
    const st = getState(sym);
    const closeNum = Number(bar.c) / 10 ** sym.price_scale;
    const prevDiff = st.prevDiff;
    updateEma(st, closeNum);
    if (st.fastEma !== null && st.slowEma !== null) {
      const diff = st.fastEma - st.slowEma;
      diffBySymbol.set(bar.symbol, diff);
      prevDiffBySymbol.set(bar.symbol, prevDiff);
      st.prevDiff = diff;
    } else {
      prevDiffBySymbol.set(bar.symbol, prevDiff);
    }
    if (bar.v === "0") zeroVolume.add(bar.symbol);
  }

  // Maintain trailing peaks for positions that are still held, using the
  // current bar's close. A position that appears for the first time gets
  // its peak initialised at its current value.
  const valueBySymbol = new Map<string, bigint>();
  for (const [symbol, pos] of held) {
    const bar = barBySymbol.get(symbol);
    const sym = symbolsByName.get(symbol);
    if (!bar || !sym) continue;
    const st = getState(sym);
    const value = positionValueQuoteUnits(
      pos.qty,
      bar.c,
      sym.qty_scale,
      sym.price_scale,
      quoteScale,
    );
    valueBySymbol.set(symbol, value);
    if (st.peak === null || value > st.peak) st.peak = value;
  }
  // Drop peaks for symbols no longer held.
  for (const st of states.values()) {
    if (!held.has(st.symbol)) st.peak = null;
  }

  if (!warmingUp) {
    const sold = new Set<string>();

    // Sells first, in alphabetical universe order.
    for (const sym of universe) {
      if (orders.length >= hello.caps.max_orders_per_bar) break;
      const pos = held.get(sym.symbol);
      if (!pos) continue;
      const bar = barBySymbol.get(sym.symbol);
      if (!bar) continue;
      if (zeroVolume.has(sym.symbol)) continue;
      const diff = diffBySymbol.get(sym.symbol);
      const value = valueBySymbol.get(sym.symbol);
      if (value === undefined) continue;
      const cost = BigInt(pos.cost_quote_units);
      const st = getState(sym);

      let sell = false;
      // EMA down: slow EMA above fast EMA (level, persists while true).
      if (diff !== undefined && diff < 0) sell = true;
      // Take profit +50%: value >= 1.5x cost.
      if (cost > 0n && value * 2n >= cost * 3n) sell = true;
      // Stop loss -12%: value <= 0.88x cost.
      if (cost > 0n && value * 100n <= cost * 88n) sell = true;
      // Trailing: value <= 0.90x peak while in profit (value > cost).
      if (
        st.peak !== null &&
        st.peak > 0n &&
        value * 10n <= st.peak * 9n &&
        value > cost
      ) {
        sell = true;
      }

      if (sell) {
        orders.push({
          side: "sell",
          client_id: "s-" + String(seq) + "-" + sym.symbol,
          symbol: sym.symbol,
          qty: pos.qty,
          max_slippage_bps: 100,
        });
        sold.add(sym.symbol);
      }
    }

    // Buys, in alphabetical universe order.
    const nSlots = Math.min(universe.length, hello.caps.max_open_positions);
    let heldAfterSells = 0;
    for (const symbol of held.keys()) {
      if (!sold.has(symbol)) heldAfterSells += 1;
    }

    if (nSlots > 0) {
      for (const sym of universe) {
        if (orders.length >= hello.caps.max_orders_per_bar) break;
        if (heldAfterSells >= nSlots) break;
        if (held.has(sym.symbol)) continue;
        if (sold.has(sym.symbol)) continue;
        const bar = barBySymbol.get(sym.symbol);
        if (!bar) continue;
        if (zeroVolume.has(sym.symbol)) continue;
        const diff = diffBySymbol.get(sym.symbol);
        const prevDiff = prevDiffBySymbol.get(sym.symbol);
        if (diff === undefined || prevDiff === undefined || prevDiff === null) continue;
        // Entry: fast crosses up through slow.
        if (!(prevDiff <= 0 && diff > 0)) continue;

        let notional = equity / BigInt(nSlots);
        const weightCap =
          (BigInt(hello.caps.max_weight_bps) * equity) / 10000n;
        if (weightCap < notional) notional = weightCap;
        if (cashRemaining < notional) notional = cashRemaining;
        if (notional <= 0n) continue;
        if (notional < minNotional) continue;

        orders.push({
          side: "buy",
          client_id: "b-" + String(seq) + "-" + sym.symbol,
          symbol: sym.symbol,
          notional_quote_units: notional.toString(),
          max_slippage_bps: 100,
        });
        cashRemaining -= notional;
        heldAfterSells += 1;
      }
    }
  }

  process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
  batchCount += 1;
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg: { type?: string };
  try {
    msg = JSON.parse(trimmed) as { type?: string };
  } catch {
    return;
  }
  if (msg.type === "hello") {
    hello = msg as unknown as HelloMsg;
    for (const s of hello.symbols) getState(s);
  } else if (msg.type === "batch") {
    handleBatch(msg as unknown as BatchMsg);
  } else if (msg.type === "done") {
    process.exit(0);
  }
});
