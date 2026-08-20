import type { Params } from "./params.js";
import type { CacheEntry, HotPoolLane, MomentumTier } from "./types.js";

function fresh(at: number | undefined, now: number, ttlSec: number): boolean {
  return at != null && now - at >= 0 && now - at < ttlSec * 1000;
}

export function isFreshRank1m(entry: CacheEntry, params: Params, now: number): boolean {
  return fresh(entry.rank_1m_seen_at, now, params.hot_pool.membership_ttl_sec);
}

export function isFreshRank5m(entry: CacheEntry, params: Params, now: number): boolean {
  return fresh(entry.rank_5m_seen_at, now, params.hot_pool.membership_ttl_sec);
}

export function hotPoolPrice5m(
  entry: CacheEntry,
  params: Params,
  now: number,
): number | undefined {
  if (entry.price_change_5m == null) return undefined;
  return fresh(
    entry.price_change_5m_written_at,
    now,
    params.hot_pool.membership_ttl_sec,
  )
    ? entry.price_change_5m
    : undefined;
}

export function isNewToken(entry: CacheEntry, params: Params, now: number): boolean {
  if (entry.created_at == null || params.hot_pool.new_token_grace_sec <= 0) return false;
  const age = now - entry.created_at;
  // 容忍上游时间戳最多领先本机一分钟；时间未知不能走新币例外。
  return age >= -60_000 && age <= params.hot_pool.new_token_grace_sec * 1000;
}

/** 只判定候选池归属；5m 正负值由过线规则判断。 */
export function hotPoolLane(
  entry: CacheEntry,
  params: Params,
  now: number,
): HotPoolLane | undefined {
  if (!params.hot_pool.enabled) return "confirmed";
  if (!isFreshRank1m(entry, params, now)) return undefined;
  if (isFreshRank5m(entry, params, now)) {
    if (hotPoolPrice5m(entry, params, now) != null) return "confirmed";
    if (isNewToken(entry, params, now)) return "new_token";
    return "confirmed";
  }
  if (isNewToken(entry, params, now)) return "new_token";
  return undefined;
}

export function momentumTier(pc1m: number, params: Params): MomentumTier {
  if (params.tape.extreme_momentum_1m > 0 && pc1m >= params.tape.extreme_momentum_1m) {
    return "extreme";
  }
  if (params.tape.high_momentum_1m > 0 && pc1m >= params.tape.high_momentum_1m) {
    return "high";
  }
  return "normal";
}
