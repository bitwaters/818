import type { TokenCache } from "../cache.js";
import type { Pipeline } from "../core.js";
import type { Env } from "../env.js";
import { gmgnRequest, shouldLogGmgnFail, unwrapList } from "../gmgn/http.js";
import { withInFlight } from "../inflight.js";
import type { Logger } from "../logger.js";
import type { Params } from "../params.js";
import type { Chain, SmartTrade } from "../types.js";
import { parseTrade, tokenAddress } from "./parse.js";

export async function pollSmartmoney(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
  now: () => number;
  chain: Chain;
}): Promise<void> {
  const result = await gmgnRequest({
    path: "/v1/user/smartmoney",
    query: { chain: opts.chain, limit: 100 },
    apiKey: opts.env.GMGN_API_KEY,
  });
  if (!result.ok) {
    if (shouldLogGmgnFail(result)) {
      opts.logger.warn({ kind: result.kind, chain: opts.chain }, "smartmoney failed");
    }
    return;
  }
  const now = opts.now();
  const touched = new Set<string>();
  const grouped = new Map<string, SmartTrade[]>();
  for (const item of unwrapList(result.data)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const ca = tokenAddress(row);
    const trade = parseTrade(row, now);
    if (!ca || !trade) continue;
    const trades = grouped.get(ca) ?? [];
    trades.push(trade);
    grouped.set(ca, trades);
  }
  for (const [ca, trades] of grouped) {
    opts.cache.writeTrades(opts.chain, ca, trades, {
      now,
      ttlSec: opts.params.cache.evidence_ttl_sec,
    });
    touched.add(ca);
  }
  for (const ca of touched) await opts.pipeline.onWrite(opts.chain, ca);
}

export function startSmartmoney(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
  now?: () => number;
}): () => void {
  if (!opts.params.sources.smartmoney) return () => undefined;
  const now = opts.now ?? Date.now;
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const chain of (["sol", "bsc"] as const).filter((c) => opts.params.chains[c])) {
    const tick = withInFlight(`smartmoney:${chain}`, () =>
      pollSmartmoney({ ...opts, now, chain }),
    );
    tick();
    timers.push(setInterval(tick, opts.params.poll.smartmoney * 1000));
  }
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
