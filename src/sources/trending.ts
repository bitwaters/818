import type { TokenCache } from "../cache.js";
import type { Pipeline } from "../core.js";
import type { Env } from "../env.js";
import { gmgnRequest, numField, shouldLogGmgnFail, unwrapList } from "../gmgn/http.js";
import { withInFlight } from "../inflight.js";
import type { Logger } from "../logger.js";
import type { Params } from "../params.js";
import type { CacheEntry, Chain } from "../types.js";
import { pickL0Snapshot, tokenAddress } from "./parse.js";

export function ingestTrending5m(opts: {
  cache: TokenCache;
  chain: Chain;
  rows: unknown[];
  now: number;
}): { present: Set<string>; cleared: CacheEntry[]; skippedClear: boolean } {
  const present = new Set<string>();
  for (const item of opts.rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const ca = tokenAddress(row);
    if (!ca) continue;
    const entry = opts.cache.upsert(opts.chain, ca);
    if (!entry) continue;
    present.add(entry.ca);
    const pct = numField(row, "price_change_percent", "price_change_5m", "change5m");
    if (pct != null) opts.cache.writePriceChange5m(opts.chain, ca, pct, opts.now);
    const symbol = typeof row.symbol === "string" ? row.symbol : undefined;
    if (symbol) opts.cache.writeSymbol(opts.chain, ca, symbol);
  }
  if (present.size === 0) {
    return { present, cleared: [], skippedClear: true };
  }
  return {
    present,
    cleared: opts.cache.clearAbsentPriceChange5m(opts.chain, present),
    skippedClear: false,
  };
}

export async function pollTrending(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
  now: () => number;
  chain: Chain;
  interval: string;
}): Promise<void> {
  const result = await gmgnRequest({
    path: "/v1/market/rank",
    query: { chain: opts.chain, interval: opts.interval },
    apiKey: opts.env.GMGN_API_KEY,
  });
  if (!result.ok) {
    if (shouldLogGmgnFail(result)) {
      opts.logger.warn({ kind: result.kind, chain: opts.chain, interval: opts.interval }, "trending failed");
    }
    return;
  }
  const now = opts.now();
  const rows = unwrapList(result.data);
  if (opts.interval === "5m") {
    const ingest = ingestTrending5m({ cache: opts.cache, chain: opts.chain, rows, now });
    if (ingest.skippedClear) {
      opts.logger.warn({ chain: opts.chain, rows: rows.length }, "trending 5m empty rank; skip clear");
    }
    for (const ca of ingest.present) await opts.pipeline.onWrite(opts.chain, ca);
    for (const entry of ingest.cleared) await opts.pipeline.onWrite(entry.chain, entry.ca);
    return;
  }
  if (opts.interval !== "1m") return;
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const ca = tokenAddress(row);
    if (!ca) continue;
    const symbol = typeof row.symbol === "string" ? row.symbol : undefined;
    const liquidity = numField(row, "liquidity");
    opts.cache.writeTape1m(
      opts.chain,
      ca,
      {
        price_change_1m: numField(row, "price_change_percent", "price_change_1m", "change1m"),
        buys: numField(row, "buys"),
        sells: numField(row, "sells"),
        volume: numField(row, "volume"),
        swaps: numField(row, "swaps"),
      },
      { symbol, liquidity },
    );
    const mc = numField(row, "market_cap", "usd_market_cap");
    if (mc != null) opts.cache.writeMarketCap(opts.chain, ca, mc, now);
    opts.cache.mergeL0(opts.chain, ca, pickL0Snapshot(row));
    await opts.pipeline.onWrite(opts.chain, ca);
  }
}

export function startTrending(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
  now?: () => number;
}): () => void {
  if (!opts.params.sources.trending) return () => undefined;
  const now = opts.now ?? Date.now;
  const timers: ReturnType<typeof setInterval>[] = [];
  const chains = (["sol", "bsc"] as const).filter((c) => opts.params.chains[c]);
  for (const chain of chains) {
    for (const interval of opts.params.intervals.trending) {
      const tick = withInFlight(`trending:${chain}:${interval}`, () =>
        pollTrending({ ...opts, now, chain, interval }),
      );
      tick();
      timers.push(setInterval(tick, opts.params.poll.trending * 1000));
    }
  }
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
