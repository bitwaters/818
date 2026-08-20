import {
  usableLiquidity,
  usableL0,
  usableMarketCap,
  usablePriceChange5m,
  usableTape1m,
  usableVisiting,
} from "./cache.js";
import { hotPoolPrice5m, momentumTier } from "./hotpool.js";
import type { Params } from "./params.js";
import { evaluatePass, lastSides, type PassResult } from "./pass.js";
import type { CacheEntry, PassKind, Signal } from "./types.js";

export function passKindOf(pass: PassResult): PassKind | undefined {
  if (pass.kind !== "pass") return undefined;
  return pass.cluster ? "cluster" : "boost";
}

export function gmgnUrl(params: Params, chain: CacheEntry["chain"], ca: string): string {
  return params.push.gmgn_token_url[chain].replaceAll("{ca}", ca);
}

export function buildSignal(
  entry: CacheEntry,
  params: Params,
  now: number,
  pass: PassResult = evaluatePass(entry, params, now),
): Signal {
  const tape = usableTape1m(entry, now, params.cache.evidence_ttl_sec) ?? {};
  const sides = lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    params.flow.min_price_change_since_entry,
  );
  const mc = usableMarketCap(entry, now, params.cache.evidence_ttl_sec);
  const visiting = usableVisiting(entry, now, params.cache.evidence_ttl_sec);
  const pc5 = params.hot_pool.enabled
    ? hotPoolPrice5m(entry, params, now)
    : usablePriceChange5m(entry, now, params.cache.evidence_ttl_sec);
  const liquidity = usableLiquidity(entry, now, params.cache.evidence_ttl_sec);
  const l0 = usableL0(entry, now, params.cache.evidence_ttl_sec);
  const kind = passKindOf(pass);
  return {
    rule_version: params.rules.version,
    chain: entry.chain,
    ca: entry.ca,
    symbol: entry.symbol ?? "",
    ts: now,
    evidence: {
      smart_wallets: sides.eligible,
      eligible_strict: sides.eligible_strict,
      buy_wallets: sides.buyWallets,
      sell_wallets: sides.sellWallets,
      buy_usd: sides.buyUsd,
      sell_usd: sides.sellUsd,
      has_usd: sides.hasUsd,
      ...(kind ? { pass_kind: kind } : {}),
      ...(pass.kind === "pass" ? { hot_pool_lane: pass.hot_pool_lane } : {}),
      ...(tape.price_change_1m != null
        ? { momentum_tier: momentumTier(tape.price_change_1m, params) }
        : {}),
      ...(entry.rank_1m != null ? { rank_1m: entry.rank_1m } : {}),
      ...(entry.rank_5m != null ? { rank_5m: entry.rank_5m } : {}),
      ...(entry.rank_1m_seen_at != null ? { rank_1m_seen_at: entry.rank_1m_seen_at } : {}),
      ...(entry.rank_5m_seen_at != null ? { rank_5m_seen_at: entry.rank_5m_seen_at } : {}),
      ...(entry.created_at != null ? { created_at: entry.created_at } : {}),
      ...(tape.price_change_1m != null ? { price_change_1m: tape.price_change_1m } : {}),
      ...(pc5 != null ? { price_change_5m: pc5 } : {}),
      ...(tape.buys != null ? { buys: tape.buys } : {}),
      ...(tape.sells != null ? { sells: tape.sells } : {}),
      ...(tape.volume != null ? { volume: tape.volume } : {}),
      ...(tape.swaps != null ? { swaps: tape.swaps } : {}),
      ...(visiting != null ? { visiting_count: visiting } : {}),
      ...(mc != null ? { market_cap: mc } : {}),
      ...(liquidity != null ? { liquidity } : {}),
    },
    l0: { ...l0 },
    links: { gmgn: gmgnUrl(params, entry.chain, entry.ca) },
  };
}
