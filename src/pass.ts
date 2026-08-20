import { tradesInWindow, usableMarketCap, usablePriceChange5m, usableTape1m, usableVisiting } from "./cache.js";
import type { Params } from "./params.js";
import type { CacheEntry, SmartTrade, Tape1m } from "./types.js";

export interface LastSides {
  eligible: number;
  /** 仅 price_change ≥ 阈值；缺字段不计 */
  eligible_strict: number;
  buyWallets: number;
  sellWallets: number;
  buyUsd: number;
  sellUsd: number;
  hasUsd: boolean;
}

function isClose(trade: SmartTrade): boolean {
  return trade.is_open_or_close === 1;
}

export function lastSides(
  trades: SmartTrade[],
  now: number,
  ttlSec: number,
  minPriceChange: number,
): LastSides {
  const windowed = tradesInWindow(trades, now, ttlSec);
  const last = new Map<string, SmartTrade>();
  for (const trade of windowed) last.set(trade.wallet, trade);
  let eligible = 0;
  let eligible_strict = 0;
  let buyWallets = 0;
  let sellWallets = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let hasUsd = false;
  for (const trade of last.values()) {
    if (trade.amount_usd != null) hasUsd = true;
    const usd = trade.amount_usd ?? 0;
    if (trade.side === "buy") {
      buyWallets += 1;
      buyUsd += usd;
      if (!isClose(trade)) eligible += 1;
      if (trade.price_change != null && trade.price_change >= minPriceChange) eligible_strict += 1;
    } else {
      sellWallets += 1;
      sellUsd += usd;
    }
  }
  return { eligible, eligible_strict, buyWallets, sellWallets, buyUsd, sellUsd, hasUsd };
}

export function netBuyOk(sides: LastSides, requireNetBuy: boolean): boolean {
  if (!requireNetBuy) return true;
  if (sides.hasUsd) return sides.buyUsd > sides.sellUsd;
  return sides.buyWallets > sides.sellWallets;
}

export function tapeComplete(tape: Partial<Tape1m> | undefined): tape is Tape1m {
  if (!tape) return false;
  return (
    tape.price_change_1m !== undefined &&
    tape.buys !== undefined &&
    tape.sells !== undefined &&
    tape.volume !== undefined &&
    tape.swaps !== undefined
  );
}

export function tapeOk(tape: Tape1m, params: Params["tape"]): boolean {
  return (
    tape.price_change_1m >= params.min_price_change_1m &&
    tape.buys > tape.sells &&
    tape.volume >= params.min_volume_usd &&
    tape.swaps >= params.min_swaps
  );
}

export function tapeFakeMomentum(tape: Tape1m, maxRatio: number): boolean {
  if (!(maxRatio > 0) || !(tape.sells > 0)) return false;
  return tape.buys / tape.sells >= maxRatio;
}

export function tape5mOk(pc5m: number, min: number): boolean {
  return pc5m > min;
}

export function visitingOk(count: number | undefined, min: number): boolean {
  return count != null && count >= min;
}

export type PassResult =
  | { kind: "skip"; reason: "tape_incomplete" | "entry_mc_incomplete" }
  | { kind: "drop"; reason: string }
  | { kind: "pass"; cluster: boolean; boost: boolean; eligible: number };

export function evaluatePass(entry: CacheEntry, params: Params, now: number): PassResult {
  const sides = lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    params.flow.min_price_change_since_entry,
  );
  const net = netBuyOk(sides, params.flow.require_net_buy);
  const vis = usableVisiting(entry, now, params.cache.evidence_ttl_sec);
  const pc5 = usablePriceChange5m(entry, now, params.cache.evidence_ttl_sec);
  const tape = usableTape1m(entry, now, params.cache.evidence_ttl_sec);
  if (!tapeComplete(tape)) return { kind: "skip", reason: "tape_incomplete" };
  if (!tapeOk(tape, params.tape)) return { kind: "drop", reason: "tape" };
  if (tapeFakeMomentum(tape, params.tape.max_buy_sell_ratio)) {
    // #region agent log
    fetch("http://127.0.0.1:7878/ingest/8c69d535-940b-4345-8c6a-a5c24d5224c8", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "f281b7" },
      body: JSON.stringify({
        sessionId: "f281b7",
        hypothesisId: "D",
        location: "pass.ts:tape_fake",
        message: "drop fake buy/sell ratio",
        data: { chain: entry.chain, buys: tape.buys, sells: tape.sells, volume: tape.volume },
        timestamp: Date.now(),
      }),
    }).catch(() => undefined);
    // #endregion
    return { kind: "drop", reason: "tape_fake" };
  }
  if (pc5 != null && !tape5mOk(pc5, params.tape.min_price_change_5m)) {
    return { kind: "drop", reason: "tape_5m" };
  }
  if (vis != null && !visitingOk(vis, params.attention.min_visiting_count)) {
    return { kind: "drop", reason: "visiting" };
  }

  const minMc = params.pass.min_entry_mc[entry.chain];
  if (minMc > 0) {
    const mc = usableMarketCap(entry, now, params.cache.evidence_ttl_sec);
    if (mc == null) return { kind: "skip", reason: "entry_mc_incomplete" };
    if (mc < minMc) {
      // #region agent log
      fetch("http://127.0.0.1:7878/ingest/8c69d535-940b-4345-8c6a-a5c24d5224c8", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "f281b7" },
        body: JSON.stringify({
          sessionId: "f281b7",
          hypothesisId: "B",
          location: "pass.ts:entry_mc",
          message: "drop sol microcap",
          data: { chain: entry.chain, mc, minMc },
          timestamp: Date.now(),
        }),
      }).catch(() => undefined);
      // #endregion
      return { kind: "drop", reason: "entry_mc" };
    }
  }

  const cluster = sides.eligible >= params.flow.min_smart_wallets && net;
  if (cluster) return { kind: "pass", cluster: true, boost: false, eligible: sides.eligible };
  return { kind: "drop", reason: "pass_formula" };
}

export function eligibleCount(entry: CacheEntry, params: Params, now: number): number {
  return lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    params.flow.min_price_change_since_entry,
  ).eligible;
}
