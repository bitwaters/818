import type { TokenCache } from "../cache.js";
import type { Pipeline } from "../core.js";
import type { Env } from "../env.js";
import { gmgnRequest, numField } from "../gmgn/http.js";
import { withInFlight } from "../inflight.js";
import type { Logger } from "../logger.js";
import type { Params } from "../params.js";
import type { Chain } from "../types.js";
import { tokenAddress, tokenChain } from "./parse.js";

export async function pollHotSearches(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
}): Promise<void> {
  const chains = (["sol", "bsc"] as const).filter((c) => opts.params.chains[c]);
  if (chains.length === 0) return;
  const result = await gmgnRequest({
    method: "POST",
    path: "/v1/market/hot_searches",
    body: { chains, interval: opts.params.attention.use_interval },
    apiKey: opts.env.GMGN_API_KEY,
  });
  if (!result.ok) {
    opts.logger.warn({ kind: result.kind }, "hot-searches failed");
    return;
  }
  const groups: { chain: Chain; rows: unknown[] }[] = [];
  const data = result.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const inner = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<string, unknown>;
    for (const chain of chains) {
      const bucket = inner[chain];
      if (Array.isArray(bucket)) groups.push({ chain, rows: bucket });
    }
  }
  if (groups.length === 0) {
    opts.logger.warn("hot-searches missing per-chain buckets; skip write");
    return;
  }
  for (const { chain: groupChain, rows } of groups) {
    for (const item of rows) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const ca = tokenAddress(row);
      const visiting = numField(row, "visiting_count");
      if (!ca || visiting == null) continue;
      const chain = tokenChain(row, groupChain);
      if (!opts.params.chains[chain]) continue;
      opts.cache.writeVisiting(chain, ca, visiting);
      await opts.pipeline.onWrite(chain, ca);
    }
  }
}

export function startHotSearches(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
}): () => void {
  if (!opts.params.sources.hot_searches) return () => undefined;
  const tick = withInFlight("hot-searches", () => pollHotSearches(opts));
  tick();
  const timer = setInterval(tick, opts.params.poll.hot_searches * 1000);
  return () => clearInterval(timer);
}
