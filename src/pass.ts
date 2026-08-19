import { tradesInWindow } from "./cache.js";
import type { Params } from "./params.js";
import type { CacheEntry, SmartTrade, Tape1m } from "./types.js";

export interface LastSides {
  eligible: number;
  /** 仅 price_change ≥ 阈值；缺字段不计 */
  eligible_strict: number;
  buyWallets: number;
  sellWallets: number;
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
  for (const trade of last.values()) {
    if (trade.side === "buy") {
      buyWallets += 1;
      if (trade.price_change == null || trade.price_change >= minPriceChange) eligible += 1;
      if (trade.price_change != null && trade.price_change >= minPriceChange) eligible_strict += 1;
    } else {
      sellWallets += 1;
    }
  }
  return { eligible, eligible_strict, buyWallets, sellWallets };
}

export function netBuyOk(sides: LastSides, requireNetBuy: boolean): boolean {
  if (!requireNetBuy) return true;
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
    tape.price_change_1m > 0 &&
    tape.buys > tape.sells &&
    tape.volume >= params.min_volume_usd &&
    tape.swaps >= params.min_swaps
  );
}

export function visitingOk(count: number | undefined, min: number): boolean {
  return count != null && count >= min;
}

export type PassResult =
  | { kind: "skip"; reason: "tape_incomplete" }
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
  if (!tapeComplete(entry.tape)) return { kind: "skip", reason: "tape_incomplete" };
  if (!tapeOk(entry.tape, params.tape)) return { kind: "drop", reason: "tape" };

  const cluster = sides.eligible >= params.flow.min_smart_wallets && net;
  const boost =
    params.pass.visiting_can_boost &&
    sides.eligible >= 1 &&
    sides.eligible < params.flow.min_smart_wallets &&
    visitingOk(entry.visiting_count, params.attention.min_visiting_count);

  if (cluster || boost) return { kind: "pass", cluster, boost, eligible: sides.eligible };
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
