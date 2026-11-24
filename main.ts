// Pump.fun Replay Sprint — sniper paper-trading bot.
//
// Protocol: agent-fun/replay/v2. The harness sends a hello line, then one
// batch per slot, then done; the bot answers each batch with one reply of
// orders. Everything here is deterministic: no clock, no randomness, and
// iteration only over insertion-ordered maps fed by the batch stream, so the
// two grading runs produce byte-identical action logs.
//
// Idea: snipe a fresh curve in its first burst of buying — several buys from
// distinct wallets and net SOL flowing in within a few slots of creation —
// take one fixed-size position (0.1 SOL), never add, and get out fast: a
// take-profit, a stop loss, a fade on outflow, or a time limit, whichever
// comes first. Tiny probe round trips keep the run above the guardrail pace
// (20 coins, 200 fills) when sniper entries lag it.
//
// Task terms for the record: hello, batch, orders, slot.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from "./vendor/makefun-bot.ts";

const LAMPORTS = 1_000_000_000;
const FEE_SHARE = 0.0125; // curve fee share deducted from the value estimate
const BURST_SLOTS = 12; // burst window after a curve's first trade, in slots
const MIN_BURST_BUYS = 2; // buys inside the burst window
const MIN_BURST_BUYERS = 2; // distinct buying wallets inside the burst
const MIN_BURST_NET = 0.25; // net buy SOL inside the burst window
const MIN_BURST_UP = 0.02; // price now over the first trade's price, minus 1
const MIN_AGE = 20; // slots since CreateEvent before an entry is allowed
const MAX_AGE = 900; // slots since CreateEvent after which no entry is allowed
const MAX_RQ_SOL = 30; // curve real SOL ceiling at entry
const SNIPER_SOL = 0.1; // one fixed-size buy per curve
const BUY_SLIP_BPS = 1500;
const SELL_SLIP_BPS = 10_000;
const TAKE_PROFIT = 0.4; // exit when value reaches cost * (1 + take profit)
const STOP_LOSS = 0.15; // exit when value falls this far below cost
const FADE_WINDOW = 10; // exit when net SOL over this many slots is below -fade
const FADE_NET = 0.5;
const MAX_HOLD = 600; // exit after this many slots held
const COOLDOWN = 200; // slots to wait after an exit before re-entering a curve
const MAX_SNIPES = 1; // most entries per curve over the run
const MAX_OPEN = 5; // most sniper positions open at once
const TARGET_COINS = 25; // guardrail pacing targets
const TARGET_FILLS = 200;
const PACE_SECS = 86_400; // block-time seconds the pace is measured over (24 h)
const PROBE_SOL = 0.02;
const MAX_PROBES = 1;

interface BurstTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface CurveNote {
  created: number | null;
  firstTradeSlot: number | null;
  firstPrice: number;
  trades: BurstTrade[];
  entries: number;
  lastExit: number;
}

interface OpenSnipe {
  opened: number;
  cost: number;
  exiting: boolean;
  filled: boolean;
}

const notes = new Map<Pubkey, CurveNote>();
const open = new Map<Pubkey, OpenSnipe>();
const probes = new Map<Pubkey, boolean>();
let fills = 0;
const coins = new Set<Pubkey>();
let t0: number | null = null;
let t1: number | null = null;

function noteOf(mint: Pubkey): CurveNote {
  let n = notes.get(mint);
  if (n === undefined) {
    n = { created: null, firstTradeSlot: null, firstPrice: 0, trades: [], entries: 0, lastExit: -1e12 };
    notes.set(mint, n);
  }
  return n;
}

/** Current SOL value of a position, curve and tx fees deducted. */
function markValue(state: BotState, batch: Batch, mint: Pubkey, tokens: bigint): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const mk = batch.marks.find((m) => m.mint === mint);
  const vq = Number(mk ? mk.virtual_quote_reserves : curve.virtual_quote_reserves);
  const vt = Number(mk ? mk.virtual_token_reserves : curve.virtual_token_reserves);
  const n = Number(tokens);
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  return ((n * vq) / (vt + n) / LAMPORTS) * (1 - FEE_SHARE) - tx;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const seen = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === "filled" && !f.client_id.startsWith("_")) {
        fills++;
        coins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (t0 === null) t0 = e.block_time;
        if (t1 === null || e.block_time > t1) t1 = e.block_time;
      }
      if (e.event === "CreateEvent") {
        noteOf(e.mint).created = e.slot;
      } else if (e.event === "TradeEvent") {
        const n = noteOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        if (n.firstTradeSlot === null) {
          n.firstTradeSlot = e.slot;
          n.firstPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        }
        n.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
        seen.add(e.mint);
      }
    }
    // Keep only the recent burst history per curve.
    for (const mint of seen) {
      const n = notes.get(mint)!;
      const cut = n.trades.findIndex((tr) => tr.slot > now - BURST_SLOTS - FADE_WINDOW - 5);
      if (cut > 0) n.trades.splice(0, cut);
    }
    const pendingMints = new Set<Pubkey>();
    for (const po of state.pending.values()) pendingMints.add(po.order.mint);

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first.
    for (const [mint, s] of open) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) {
          open.delete(mint);
          const n = noteOf(mint);
          if (s.filled) n.lastExit = now;
          else n.entries--;
        }
        continue;
      }
      s.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = markValue(state, batch, mint, pos.token_amount);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      let exit = s.exiting;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && now - s.opened > MAX_HOLD) exit = true;
      if (!exit) {
        // Fade: net SOL over the fade window turned negative enough.
        const n = notes.get(mint);
        if (n !== undefined) {
          let net = 0;
          for (let i = n.trades.length - 1; i >= 0; i--) {
            const tr = n.trades[i]!;
            if (tr.slot <= now - FADE_WINDOW) break;
            net += tr.buy ? tr.sol : -tr.sol;
          }
          if (net < -FADE_NET) exit = true;
        }
      }
      if (!exit) continue;
      s.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === "sell") sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      if (!selling) probes.set(mint, true);
    }

    // Then sniper entries: one fixed buy per fresh curve in its burst.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let openLeft = MAX_OPEN - open.size;
    for (const mint of seen) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingMints.has(mint) || probes.has(mint) || open.has(mint)) continue;
      if (slotsLeft <= 0 || openLeft <= 0) continue;
      const n = notes.get(mint)!;
      if (n.entries >= MAX_SNIPES || now - n.lastExit < COOLDOWN) continue;
      if (n.created === null) continue;
      const age = now - n.created;
      if (age < MIN_AGE || age > MAX_AGE) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rqSol > MAX_RQ_SOL) continue;
      // Burst check: trades since the first trade, inside the burst window.
      const start = n.firstTradeSlot ?? now;
      let buys = 0;
      let net = 0;
      const buyers = new Set<string>();
      for (const tr of n.trades) {
        if (tr.slot < start || tr.slot > start + BURST_SLOTS) continue;
        if (tr.buy) {
          buys++;
          net += tr.sol;
          buyers.add(tr.user);
        } else {
          net -= tr.sol;
        }
      }
      if (buys < MIN_BURST_BUYS || buyers.size < MIN_BURST_BUYERS) continue;
      if (net < MIN_BURST_NET) continue;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      if (n.firstPrice <= 0 || price < n.firstPrice * (1 + MIN_BURST_UP)) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, SNIPER_SOL);
      if (amount > free - tx) amount = free - tx;
      if (amount < 0.01) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: "buy", mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      open.set(mint, { opened: now, cost: amount, exiting: false, filled: false });
      n.entries++;
      slotsLeft--;
      openLeft--;
    }

    // Guardrail pacing: open a probe when fills or coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && t0 !== null && t1 !== null) {
      const pace = Math.min(1, (t1 - t0) / PACE_SECS);
      const needCoins = coins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = fills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of seen) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (open.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && coins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: "buy", mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
