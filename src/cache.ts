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

  get(chain: Chain, rawCa: string): CacheEntry | undefined {
    const key = cacheKey(chain, rawCa);
    return key ? this.map.get(key) : undefined;
  }

  has(chain: Chain, rawCa: string): boolean {
    const key = cacheKey(chain, rawCa);
    return key ? this.map.has(key) : false;
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
    entry.trades.push(...trades);
    if (window) entry.trades = tradesInWindow(entry.trades, window.now, window.ttlSec);
    return entry;
  }

  writeTape1m(
    chain: Chain,
    rawCa: string,
    tape: Partial<Tape1m>,
    extras?: { symbol?: string; liquidity?: number },
  ): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.tape = { ...entry.tape, ...tape };
    if (extras?.symbol) entry.symbol = extras.symbol;
    if (extras?.liquidity != null) entry.liquidity = extras.liquidity;
    return entry;
  }

  writePriceChange5m(chain: Chain, rawCa: string, pct: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.price_change_5m = pct;
    return entry;
  }

  writeMarketCap(chain: Chain, rawCa: string, marketCap: number, now: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.market_cap = marketCap;
    entry.market_cap_written_at = now;
    return entry;
  }

  writeVisiting(chain: Chain, rawCa: string, count: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.visiting_count = count;
    return entry;
  }

  writeSignal10(chain: Chain, rawCa: string, at: number): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.signal10_at = at;
    return entry;
  }

  mergeL0(chain: Chain, rawCa: string, fields: Record<string, unknown>): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) entry.l0[k] = v;
    }
    return entry;
  }

  writeSymbol(chain: Chain, rawCa: string, symbol: string): CacheEntry | null {
    const entry = this.upsert(chain, rawCa);
    if (!entry) return null;
    entry.symbol = symbol;
    return entry;
  }
}
