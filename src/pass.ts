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
  for (const trade of windowed) {
    const previous = last.get(trade.wallet);
    if (!previous || trade.ts > previous.ts) last.set(trade.wallet, trade);
  }
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

export function tapeVolumeMarketCapOk(
  tape: Tape1m,
  marketCap: number,
  params: Params["tape"],
): boolean {
  const ratio = tape.volume / marketCap;
  if (params.min_volume_market_cap_ratio > 0 && ratio < params.min_volume_market_cap_ratio) {
    return false;
  }
  if (params.max_volume_market_cap_ratio > 0 && ratio > params.max_volume_market_cap_ratio) {
    return false;
  }
  return true;
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
  if (!params.pass.signal_enabled[entry.chain]) return { kind: "drop", reason: "chain_disabled" };
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
  if (
    params.tape.max_price_change_1m > 0 &&
    tape.price_change_1m >= params.tape.max_price_change_1m
  ) {
    return { kind: "drop", reason: "tape_chase" };
  }
  if (tapeFakeMomentum(tape, params.tape.max_buy_sell_ratio)) {
    return { kind: "drop", reason: "tape_fake" };
  }
  if (pc5 != null && !tape5mOk(pc5, params.tape.min_price_change_5m)) {
    return { kind: "drop", reason: "tape_5m" };
  }
  if (vis != null && !visitingOk(vis, params.attention.min_visiting_count)) {
    return { kind: "drop", reason: "visiting" };
  }

  const minMc = params.pass.min_entry_mc[entry.chain];
  const needsMc =
    minMc > 0 ||
    params.tape.min_volume_market_cap_ratio > 0 ||
    params.tape.max_volume_market_cap_ratio > 0;
  const mc = usableMarketCap(entry, now, params.cache.evidence_ttl_sec);
  if (needsMc) {
    if (mc == null) return { kind: "skip", reason: "entry_mc_incomplete" };
    if (!tapeVolumeMarketCapOk(tape, mc, params.tape)) {
      return { kind: "drop", reason: "tape_volume_mc" };
    }
  }
  if (minMc > 0 && mc != null) {
    if (mc < minMc) {
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
