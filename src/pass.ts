import {
  tradesInWindow,
  usableLiquidity,
  usableMarketCap,
  usablePriceChange5m,
  usableTape1m,
  usableVisiting,
} from "./cache.js";
import { hotPoolLane, hotPoolPrice5m, isFreshRank1m } from "./hotpool.js";
import { strategyFor, type ChainStrategy, type Params } from "./params.js";
import type { CacheEntry, HotPoolLane, SmartTrade, Tape1m } from "./types.js";

export interface LastSides {
  eligible: number;
  /** 仅 price_change ≥ 阈值；缺字段不计 */
  eligible_strict: number;
  buyWallets: number;
  sellWallets: number;
  buyUsd: number;
  sellUsd: number;
  /** 窗口内每笔成交都有 USD 金额时为 true；部分缺失不得把未知金额当 0 */
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
  let hasUsd = windowed.length > 0;
  // 方向看每个钱包最后一笔；净流必须累计窗口内全部去重成交，不能只取最后金额。
  for (const trade of windowed) {
    if (trade.amount_usd == null) {
      hasUsd = false;
      continue;
    }
    if (trade.side === "buy") buyUsd += trade.amount_usd;
    else sellUsd += trade.amount_usd;
  }
  for (const trade of last.values()) {
    if (trade.side === "buy") {
      buyWallets += 1;
      if (!isClose(trade)) eligible += 1;
      if (
        !isClose(trade) &&
        trade.price_change != null &&
        trade.price_change >= minPriceChange
      ) {
        eligible_strict += 1;
      }
    } else {
      sellWallets += 1;
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

export function tapeOk(tape: Tape1m, params: ChainStrategy["tape"]): boolean {
  const priceOk =
    params.min_price_change_1m === 0
      ? tape.price_change_1m > 0
      : tape.price_change_1m >= params.min_price_change_1m;
  return (
    priceOk &&
    tape.buys > tape.sells &&
    tape.volume >= params.min_volume_usd &&
    tape.swaps >= params.min_swaps
  );
}

export function tapeVolumeMarketCapOk(
  tape: Tape1m,
  marketCap: number,
  params: ChainStrategy["tape"],
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
  if (!(maxRatio > 0)) return false;
  if (!(tape.sells > 0)) return tape.buys > 0;
  return tape.buys / tape.sells >= maxRatio;
}

export function tape5mOk(pc5m: number, min: number): boolean {
  return pc5m > min;
}

export function visitingOk(count: number | undefined, min: number): boolean {
  return count != null && count >= min;
}

export type PassResult =
  | {
      kind: "skip";
      reason:
        | "tape_incomplete"
        | "hot_1m_incomplete"
        | "tape_5m_incomplete"
        | "visiting_incomplete"
        | "entry_mc_incomplete"
        | "liquidity_incomplete";
    }
  | { kind: "drop"; reason: string }
  | {
      kind: "pass";
      cluster: boolean;
      boost: boolean;
      eligible: number;
      hot_pool_lane: HotPoolLane;
    };

export function evaluatePass(entry: CacheEntry, params: Params, now: number): PassResult {
  const strategy = strategyFor(params, entry.chain);
  if (strategy.mode === "off") return { kind: "drop", reason: "chain_disabled" };
  const lane = hotPoolLane(entry, params, now);
  if (!lane) {
    return {
      kind: "skip",
      reason: isFreshRank1m(entry, params, now)
        ? "tape_5m_incomplete"
        : "hot_1m_incomplete",
    };
  }
  const sides = lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    strategy.flow.min_price_change_since_entry,
  );
  const net = netBuyOk(sides, strategy.flow.require_net_buy);
  const vis = usableVisiting(entry, now, params.cache.evidence_ttl_sec);
  const pc5 = strategy.hot_pool.enabled
    ? hotPoolPrice5m(entry, params, now)
    : usablePriceChange5m(entry, now, params.cache.evidence_ttl_sec);
  const tape = usableTape1m(entry, now, params.cache.evidence_ttl_sec);
  if (!tapeComplete(tape)) return { kind: "skip", reason: "tape_incomplete" };
  if (!tapeOk(tape, strategy.tape)) return { kind: "drop", reason: "tape" };
  if (
    strategy.tape.max_price_change_1m > 0 &&
    tape.price_change_1m >= strategy.tape.max_price_change_1m
  ) {
    return { kind: "drop", reason: "tape_chase" };
  }
  if (tapeFakeMomentum(tape, strategy.tape.max_buy_sell_ratio)) {
    return { kind: "drop", reason: "tape_fake" };
  }
  if (strategy.tape.require_price_change_5m && pc5 == null && lane !== "new_token") {
    return { kind: "skip", reason: "tape_5m_incomplete" };
  }
  if (pc5 != null && !tape5mOk(pc5, strategy.tape.min_price_change_5m)) {
    return { kind: "drop", reason: "tape_5m" };
  }
  if (vis == null || !Number.isFinite(vis)) {
    return { kind: "skip", reason: "visiting_incomplete" };
  }
  if (!visitingOk(vis, strategy.attention.min_visiting_count)) {
    return { kind: "drop", reason: "visiting" };
  }

  const minLiquidity = strategy.pass.min_liquidity_usd;
  if (minLiquidity > 0) {
    const liquidity = usableLiquidity(entry, now, params.cache.evidence_ttl_sec);
    if (liquidity == null) return { kind: "skip", reason: "liquidity_incomplete" };
    if (liquidity < minLiquidity) return { kind: "drop", reason: "liquidity" };
  }

  const minMc = strategy.pass.min_entry_mc;
  const needsMc =
    minMc > 0 ||
    strategy.tape.min_volume_market_cap_ratio > 0 ||
    strategy.tape.max_volume_market_cap_ratio > 0;
  const mc = usableMarketCap(entry, now, params.cache.evidence_ttl_sec);
  if (needsMc) {
    if (mc == null) return { kind: "skip", reason: "entry_mc_incomplete" };
    if (!tapeVolumeMarketCapOk(tape, mc, strategy.tape)) {
      return { kind: "drop", reason: "tape_volume_mc" };
    }
  }
  if (minMc > 0 && mc != null) {
    if (mc < minMc) {
      return { kind: "drop", reason: "entry_mc" };
    }
  }

  const smartMoneyConfirmed = sides.eligible >= strategy.flow.min_smart_wallets && net;
  if (!strategy.flow.require_smart_money || smartMoneyConfirmed) {
    return {
      kind: "pass",
      cluster: smartMoneyConfirmed,
      boost: false,
      eligible: sides.eligible,
      hot_pool_lane: lane,
    };
  }
  return { kind: "drop", reason: "pass_formula" };
}

export function eligibleCount(entry: CacheEntry, params: Params, now: number): number {
  const strategy = strategyFor(params, entry.chain);
  return lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    strategy.flow.min_price_change_since_entry,
  ).eligible;
}
