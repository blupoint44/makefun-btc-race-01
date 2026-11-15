// cbBTC minute-bar thrust bot for the make.fun 24h BTC race.
//
// Strategy (long only, one position at a time):
//
//   * Regime: two EMAs of the 1-minute close (fast 12, slow 48).  The bot
//     only considers buying while the fast EMA sits above the slow one.
//   * Trigger: only a genuine thrust qualifies — the trailing 15-bar and
//     30-bar returns must both be strongly positive.  In a falling tape
//     most bounces are feeble and die within minutes; demanding an
//     unusually strong half-hour move keeps the bot out of them and
//     leaves it flat (and fee-free) instead.
//   * Sizing: a fixed share of cash, capped so the order's own price
//     impact on the pool stays small (the pool depth at the latest close
//     is the sizing guide, as the rules suggest).
//   * Exits: the trend flipping (EMA spread clearly negative), a
//     trailing stop under the best close since entry, a hard stop under
//     the fill price, or a time stop when a thrust fails to follow
//     through, whichever comes first.  After an exit the bot rests for
//     a few bars so it does not pay the round-trip cost twice on the
//     same wiggle.
//   * Safety: if equity ever falls 6% under its peak the bot flattens
//     and stops trading for the rest of the window; capital preservation
//     beats heroics when the ranking also punishes deep drawdowns.
//
// Everything is a pure function of the bars seen so far: no clock, no
// randomness, no files, so the two graded executions agree byte for
// byte.  Missing or malformed bars are skipped quietly and every batch
// still gets exactly one valid reply (the vendored shim owns the wire).

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

const FAST_SPAN = 12;
const SLOW_SPAN = 48;
const MOM_FAST_BARS = 15;
const MOM_SLOW_BARS = 30;

const ENTER_MOM_FAST = 0.006;   // trailing 15-bar return must exceed this
const ENTER_MOM_SLOW = 0.0085;  // and trailing 30-bar return must exceed this
const EXIT_SPREAD = -0.0005;    // trend is over once the spread is this negative
const TRAIL_STOP = 0.016;       // sell if close falls this share under the peak since entry
const HARD_STOP = 0.016;        // sell if close falls this share under the fill price
const TIME_STOP_BARS = 25;      // a thrust that has not followed through by now is a failure
const TIME_STOP_MAX_GAIN = 0.001; // ...if it is up less than this over the fill price
const REST_BARS = 12;           // bars to sit out after an exit
const CASH_SHARE = 0.95;        // share of cash one entry may spend
const IMPACT_CAP_BPS = 15;      // keep the order's own price impact under this
const MIN_ORDER_UNITS = 100_000_000n; // never bother with a buy under 100 USDC
const EQUITY_HALT = 0.06;       // flatten and stop at this drawdown from peak equity
const MAX_SLIPPAGE_BPS = 250;

class Bot {
  closes: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  entryPrice: number | null = null; // fill price of the open position, as a double
  entrySeq: number | null = null;   // seq of the batch that reported the entry fill
  peakSinceEntry: number | null = null;
  restUntil = -1;
  peakEquity: bigint | null = null;
  halted = false;
  pendingEntry = false;

  noteFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      const price = Number(fill.price);
      if (fill.side === 'buy') {
        this.entryPrice = price;
        this.entrySeq = batch.seq;
        this.peakSinceEntry = price;
        this.pendingEntry = false;
      } else {
        this.entryPrice = null;
        this.entrySeq = null;
        this.peakSinceEntry = null;
        this.restUntil = batch.seq + REST_BARS;
      }
    }
  }

  noteClose(close: number): void {
    this.closes.push(close);
    if (this.emaFast === null || this.emaSlow === null) {
      this.emaFast = close;
      this.emaSlow = close;
      return;
    }
    const kf = 2 / (FAST_SPAN + 1);
    const ks = 2 / (SLOW_SPAN + 1);
    this.emaFast += kf * (close - this.emaFast);
    this.emaSlow += ks * (close - this.emaSlow);
    if (this.entryPrice !== null) {
      if (this.peakSinceEntry === null || close > this.peakSinceEntry) {
        this.peakSinceEntry = close;
      }
    }
  }

  wantExit(close: number, seq: number): boolean {
    if (this.entryPrice === null || this.emaFast === null || this.emaSlow === null) {
      return false;
    }
    const spread = (this.emaFast - this.emaSlow) / close;
    if (spread < EXIT_SPREAD) return true;
    if (this.peakSinceEntry !== null && close < this.peakSinceEntry * (1 - TRAIL_STOP)) {
      return true;
    }
    if (close < this.entryPrice * (1 - HARD_STOP)) return true;
    if (this.entrySeq !== null && seq - this.entrySeq >= TIME_STOP_BARS &&
        close < this.entryPrice * (1 + TIME_STOP_MAX_GAIN)) {
      return true;
    }
    return false;
  }

  wantEntry(): boolean {
    if (this.closes.length < SLOW_SPAN + MOM_SLOW_BARS) return false;
    if (this.emaFast === null || this.emaSlow === null) return false;
    if (this.emaFast <= this.emaSlow) return false;
    const last = this.closes[this.closes.length - 1];
    const momFast = last / this.closes[this.closes.length - 1 - MOM_FAST_BARS] - 1;
    if (momFast < ENTER_MOM_FAST) return false;
    const momSlow = last / this.closes[this.closes.length - 1 - MOM_SLOW_BARS] - 1;
    return momSlow > ENTER_MOM_SLOW;
  }

  entrySize(state: BarsState): bigint {
    let budget = (state.cash * BigInt(Math.round(CASH_SHARE * 10000))) / 10000n;
    const depth = state.depthAt(SYMBOL);
    if (depth !== null && depth.length > 0) {
      // impactBps(amount) is roughly amount / depth * 10000 for one hop;
      // solve for the amount that keeps it at IMPACT_CAP_BPS.
      let sum = 0n;
      for (const d of depth) sum += d;
      const meanDepth = sum / BigInt(depth.length);
      const cap = (BigInt(IMPACT_CAP_BPS) * meanDepth) / 10000n;
      if (cap < budget) budget = cap;
    }
    const room = state.weightRoom(SYMBOL);
    if (room < budget) budget = room;
    return budget >= MIN_ORDER_UNITS ? budget : 0n;
  }
}

let bot = new Bot();

await runBars({
  onHello(state: BarsState) {
    bot = new Bot();
    bot.peakEquity = state.equity;
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    bot.noteFills(batch);

    if (bot.peakEquity === null || state.equity > bot.peakEquity) {
      bot.peakEquity = state.equity;
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    if (!Number.isFinite(close) || close <= 0) return [];
    bot.noteClose(close);

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const heldQty = held === undefined ? 0n : held.qty;

    // Equity guardrail: flatten and stop if the window turns against us.
    if (bot.peakEquity !== null &&
        Number(state.equity) < Number(bot.peakEquity) * (1 - EQUITY_HALT)) {
      bot.halted = true;
      if (heldQty > 0n) {
        return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (bot.halted) return [];

    if (heldQty > 0n) {
      if (bot.wantExit(close, batch.seq)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (bot.pendingEntry) return []; // an entry order is out; wait for its fill report
    if (batch.seq <= bot.restUntil) return [];

    if (bot.wantEntry()) {
      const size = bot.entrySize(state);
      if (size > 0n) {
        bot.pendingEntry = true;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
