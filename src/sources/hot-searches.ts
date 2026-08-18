import type { TokenCache } from "../cache.js";
import type { Pipeline } from "../core.js";
import type { Env } from "../env.js";
import { gmgnRequest, numField, shouldLogGmgnFail } from "../gmgn/http.js";
import { withInFlight } from "../inflight.js";
import type { Logger } from "../logger.js";
import type { Params } from "../params.js";
import type { Chain } from "../types.js";
import { tokenAddress, tokenChain } from "./parse.js";

function asChain(raw: unknown): Chain | undefined {
  return raw === "sol" || raw === "bsc" ? raw : undefined;
}

function rowsFromBlock(block: Record<string, unknown>): unknown[] {
  for (const key of ["tokens", "list", "rank", "ranks", "items"]) {
    const v = block[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** Official body: `{ data: [{ chain, interval, tokens }] }`. Also accept `{ sol: [], bsc: [] }`. */
export function parseHotSearchGroups(
  data: unknown,
  want: Chain[],
): { chain: Chain; rows: unknown[] }[] {
  const wanted = new Set(want);
  const groups: { chain: Chain; rows: unknown[] }[] = [];
  const root = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const payload = Array.isArray(root?.data) ? root.data : Array.isArray(data) ? data : (root?.data ?? data);

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      const chain = asChain(block.chain);
      if (!chain || !wanted.has(chain)) continue;
      const rows = rowsFromBlock(block);
      if (rows.length > 0) groups.push({ chain, rows });
    }
    return groups;
  }

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const chain of want) {
      const bucket = obj[chain];
      if (Array.isArray(bucket) && bucket.length > 0) groups.push({ chain, rows: bucket });
    }
  }
  return groups;
}

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
    if (shouldLogGmgnFail(result)) {
      opts.logger.warn({ kind: result.kind }, "hot-searches failed");
    }
    return;
  }
  const groups = parseHotSearchGroups(result.data, chains);
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
