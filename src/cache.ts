import type { CacheEntry, Chain, SmartTrade, Tape1m } from "./types.js";

const BSC_CA = /^0x[0-9a-f]{40}$/;

export function normalizeCa(chain: Chain, raw: string): string | null {
  if (chain === "sol") {
    const ca = raw.trim();
    return ca.length > 0 ? ca : null;
  }
  const ca = raw.trim().toLowerCase();
  return BSC_CA.test(ca) ? ca : null;
}

export function cacheKey(chain: Chain, rawCa: string): string | null {
  const ca = normalizeCa(chain, rawCa);
  return ca ? `${chain}:${ca}` : null;
}

export function isMarketCapFresh(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): boolean {
  if (entry.market_cap_written_at == null) return false;
  return now - entry.market_cap_written_at < ttlSec * 1000;
}

export function usableMarketCap(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): number | undefined {
  if (!isMarketCapFresh(entry, now, ttlSec)) return undefined;
  const mc = entry.market_cap;
  if (mc == null || !(mc > 0)) return undefined;
  return mc;
}

export function usableLiquidity(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): number | undefined {
  const value = entry.liquidity;
  if (value == null || !(value >= 0)) return undefined;
  // 兼容直接构造的旧缓存/测试；生产写入始终带字段时间。
  if (entry.liquidity_written_at == null) return value;
  if (now - entry.liquidity_written_at >= ttlSec * 1000) return undefined;
  return value;
}

export function usableL0(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): Record<string, unknown> {
  const stamps = entry.l0_written_at;
  if (!stamps) return entry.l0;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.l0)) {
    const writtenAt = stamps[key];
    if (writtenAt == null || now - writtenAt < ttlSec * 1000) out[key] = value;
  }
  return out;
}

export function isVisitingFresh(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): boolean {
  if (entry.visiting_count == null) return false;
  if (entry.visiting_written_at == null) return false;
  return now - entry.visiting_written_at < ttlSec * 1000;
}

export function usableVisiting(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): number | undefined {
  if (!isVisitingFresh(entry, now, ttlSec)) return undefined;
  return entry.visiting_count;
}

export function usableTape1m(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): Partial<Tape1m> | undefined {
  if (!entry.tape) return undefined;
  if (entry.tape_written_at == null) return entry.tape;
  if (now - entry.tape_written_at >= ttlSec * 1000) return undefined;
  return entry.tape;
}

export function usablePriceChange5m(
  entry: CacheEntry,
  now: number,
  ttlSec: number,
): number | undefined {
  if (entry.price_change_5m == null) return undefined;
  if (entry.price_change_5m_written_at == null) return undefined;
  if (now - entry.price_change_5m_written_at >= ttlSec * 1000) return undefined;
  return entry.price_change_5m;
}

export function tradesInWindow(
  trades: SmartTrade[],
  now: number,
  ttlSec: number,
): SmartTrade[] {
  const cutoff = now - ttlSec * 1000;
  return trades.filter((t) => t.ts >= cutoff);
}

export class TokenCache {
  private readonly map = new Map<string, CacheEntry>();
  private batchDepth = 0;
  private readonly batchedMutations = new Set<CacheEntry>();

  constructor(private readonly onMutate?: (entry: CacheEntry) => void) {}

  private emitMutate(entry: CacheEntry): void {
    if (this.batchDepth > 0) {
      this.batchedMutations.add(entry);
      return;
    }
    try {
      this.onMutate?.(entry);
    } catch {
      // 轨迹失败不得挡住源写入
    }
  }

  /** 同一来源对一个 token 的多字段更新只通知一次，避免轨迹记录中间态。 */
  batch<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchedMutations.size > 0) {
        const entries = [...this.batchedMutations];
        this.batchedMutations.clear();
        for (const entry of entries) this.emitMutate(entry);
      }
    }
  }

  get(chain: Chain, rawCa: string): CacheEntry | undefined {
    const key = cacheKey(chain, rawCa);
    return key ? this.map.get(key) : undefined;
  }

  has(chain: Chain, rawCa: string): boolean {
    const key = cacheKey(chain, rawCa);
    return key ? this.map.has(key) : false;
  }

  entries(chain?: Chain): CacheEntry[] {
    const entries = [...this.map.values()];
    return chain ? entries.filter((entry) => entry.chain === chain) : entries;
  }

  delete(chain: Chain, rawCa: string): void {
    const key = cacheKey(chain, rawCa);
    if (key) this.map.delete(key);
  }

  upsert(chain: Chain, rawCa: string): CacheEntry | null {
    const ca = normalizeCa(chain, rawCa);
    if (!ca) return null;
    const key = `${chain}:${ca}`;
    let entry = this.map.get(key);
    if (!entry) {
      entry = { chain, ca, trades: [], l0: {} };
      this.map.set(key, entry);
    }
    return entry;
  }

  pruneTrades(chain: Chain, rawCa: string, now: number, ttlSec: number): void {
    const entry = this.get(chain, rawCa);
    if (!entry) return;
    entry.trades = tradesInWindow(entry.trades, now, ttlSec);
  }

  writeTrades(
    chain: Chain,
    rawCa: string,
    trades: SmartTrade[],
    window?: { now: number; ttlSec: number },
  ): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    const known = new Set(entry.trades.flatMap((trade) => (trade.id ? [trade.id] : [])));
    const added: SmartTrade[] = [];
    for (const trade of trades) {
      if (trade.id && known.has(trade.id)) continue;
      if (trade.id) known.add(trade.id);
      added.push(trade);
    }
    const before = entry.trades.length;
    entry.trades.push(...added);
    if (window) entry.trades = tradesInWindow(entry.trades, window.now, window.ttlSec);
    if (added.length > 0 || entry.trades.length !== before) this.emitMutate(entry);
    return entry;
  }

  writeTape1m(
    chain: Chain,
    rawCa: string,
    tape: Partial<Tape1m>,
    extras?: { symbol?: string; liquidity?: number; now?: number },
  ): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.tape = { ...entry.tape, ...tape };
    if (extras?.now != null) entry.tape_written_at = extras.now;
    if (extras?.symbol) entry.symbol = extras.symbol;
    if (extras?.liquidity != null) {
      entry.liquidity = extras.liquidity;
      if (extras.now != null) entry.liquidity_written_at = extras.now;
    }
    this.emitMutate(entry);
    return entry;
  }

  /** 热门榜一行代表一份完整时点快照；缺字段不能用上一轮残值拼成“完整盘口”。 */
  replaceTape1m(
    chain: Chain,
    rawCa: string,
    tape: Partial<Tape1m>,
    extras: { symbol?: string; liquidity?: number; now: number },
  ): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.tape = { ...tape };
    entry.tape_written_at = extras.now;
    if (extras.symbol) entry.symbol = extras.symbol;
    if (extras.liquidity != null) {
      entry.liquidity = extras.liquidity;
      entry.liquidity_written_at = extras.now;
    }
    this.emitMutate(entry);
    return entry;
  }

  writeTape5m(
    chain: Chain,
    rawCa: string,
    tape: Partial<Tape1m>,
    now: number,
  ): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.tape5m = { ...entry.tape5m, ...tape };
    entry.tape5m_written_at = now;
    this.emitMutate(entry);
    return entry;
  }

  writePriceChange5m(chain: Chain, rawCa: string, pct: number, now: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.price_change_5m = pct;
    entry.price_change_5m_written_at = now;
    this.emitMutate(entry);
    return entry;
  }

  writeCreatedAt(chain: Chain, rawCa: string, createdAt: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    if (Number.isFinite(createdAt) && createdAt > 0) entry.created_at = createdAt;
    return entry;
  }

  /** 成功且非空的榜单原子替换成员；失败/异常空榜由调用方跳过，交给 TTL 失效。 */
  replaceRankMembership(
    chain: Chain,
    interval: "1m" | "5m",
    rankedCas: string[],
    now: number,
  ): { present: Set<string>; changed: CacheEntry[] } {
    const present = new Set<string>();
    const positions = new Map<string, number>();
    for (const rawCa of rankedCas) {
      const entry = this.upsert(chain, rawCa);
      if (!entry || present.has(entry.ca)) continue;
      present.add(entry.ca);
      positions.set(entry.ca, present.size);
    }
    if (present.size === 0) return { present, changed: [] };

    const changed: CacheEntry[] = [];
    this.batch(() => {
      for (const entry of this.map.values()) {
        if (entry.chain !== chain) continue;
        const position = positions.get(entry.ca);
        let didChange = false;
        if (interval === "1m") {
          const wasPresent = entry.rank_1m_seen_at != null;
          const nextPresent = position != null;
          if (nextPresent) {
            entry.rank_1m = position;
            entry.rank_1m_seen_at = now;
          } else {
            entry.rank_1m = undefined;
            entry.rank_1m_seen_at = undefined;
          }
          didChange = wasPresent !== nextPresent || nextPresent;
        } else {
          const wasPresent = entry.rank_5m_seen_at != null;
          const nextPresent = position != null;
          if (nextPresent) {
            entry.rank_5m = position;
            entry.rank_5m_seen_at = now;
          } else {
            entry.rank_5m = undefined;
            entry.rank_5m_seen_at = undefined;
          }
          didChange = wasPresent !== nextPresent || nextPresent;
        }
        if (didChange) {
          changed.push(entry);
          this.emitMutate(entry);
        }
      }
    });
    return { present, changed };
  }

  /** 本轮 5m 热门未出现的 token 清掉 5m 涨幅，避免过线一直用发臭的动量。 */
  clearAbsentPriceChange5m(chain: Chain, presentCas: Set<string>): CacheEntry[] {
    const cleared: CacheEntry[] = [];
    for (const entry of this.map.values()) {
      if (entry.chain !== chain) continue;
      if (entry.price_change_5m == null && entry.tape5m == null) continue;
      if (presentCas.has(entry.ca)) continue;
      entry.price_change_5m = undefined;
      entry.price_change_5m_written_at = undefined;
      entry.tape5m = undefined;
      entry.tape5m_written_at = undefined;
      this.emitMutate(entry);
      cleared.push(entry);
    }
    return cleared;
  }

  writeMarketCap(chain: Chain, rawCa: string, marketCap: number, now: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.market_cap = marketCap;
    entry.market_cap_written_at = now;
    this.emitMutate(entry);
    return entry;
  }

  writeVisiting(chain: Chain, rawCa: string, count: number, now: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.visiting_count = count;
    entry.visiting_written_at = now;
    this.emitMutate(entry);
    return entry;
  }

  /** 本轮热搜未出现的 token 清掉浏览，避免过线/轨迹一直用发臭的人数。 */
  clearAbsentVisiting(chain: Chain, presentCas: Set<string>): CacheEntry[] {
    const cleared: CacheEntry[] = [];
    for (const entry of this.map.values()) {
      if (entry.chain !== chain) continue;
      if (entry.visiting_count == null) continue;
      if (presentCas.has(entry.ca)) continue;
      entry.visiting_count = undefined;
      entry.visiting_written_at = undefined;
      this.emitMutate(entry);
      cleared.push(entry);
    }
    return cleared;
  }

  writeSignal10(chain: Chain, rawCa: string, at: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.signal10_at = at;
    return entry;
  }

  mergeL0(
    chain: Chain,
    rawCa: string,
    fields: Record<string, unknown>,
    now = Date.now(),
  ): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.l0_written_at ??= {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        entry.l0[k] = v;
        entry.l0_written_at[k] = now;
      }
    }
    this.emitMutate(entry);
    return entry;
  }

  writeSymbol(chain: Chain, rawCa: string, symbol: string): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.symbol = symbol;
    return entry;
  }
}
