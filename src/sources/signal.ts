import type { TokenCache } from "../cache.js";
import type { Pipeline } from "../core.js";
import type { Env } from "../env.js";
import { gmgnRequest, numField, unwrapList } from "../gmgn/http.js";
import { withInFlight } from "../inflight.js";
import type { Logger } from "../logger.js";
import type { Params } from "../params.js";
import type { Chain } from "../types.js";
import { tokenAddress } from "./parse.js";

export function enabledSignalTypes(sources: Params["sources"]): number[] {
  const types: number[] = [];
  if (sources.signal_6) types.push(6);
  if (sources.signal_7) types.push(7);
  if (sources.signal_10) types.push(10);
  if (sources.signal_12) types.push(12);
  return types;
}

export async function pollSignal(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
  now: () => number;
  chain: Chain;
}): Promise<void> {
  const types = enabledSignalTypes(opts.params.sources);
  if (types.length === 0) return;
  const result = await gmgnRequest({
    method: "POST",
    path: "/v1/market/token_signal",
    body: { chain: opts.chain, groups: [{ signal_type: types }] },
    apiKey: opts.env.GMGN_API_KEY,
  });
  if (!result.ok) {
    opts.logger.warn({ kind: result.kind, chain: opts.chain }, "signal failed");
    return;
  }
  const now = opts.now();
  for (const item of unwrapList(result.data)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const type = numField(row, "signal_type", "type");
    if (type === 12) continue;
    if (type !== 10) continue;
    const ca = tokenAddress(row);
    if (!ca) continue;
    const at = numField(row, "trigger_at", "timestamp", "ts") ?? now;
    opts.cache.writeSignal10(opts.chain, ca, at > 1e12 ? at : at * 1000);
    await opts.pipeline.onWrite(opts.chain, ca);
  }
}

export function startSignal(opts: {
  params: Params;
  env: Env;
  cache: TokenCache;
  pipeline: Pipeline;
  logger: Logger;
  now?: () => number;
}): () => void {
  const types = enabledSignalTypes(opts.params.sources);
  if (types.length === 0) return () => undefined;
  const now = opts.now ?? Date.now;
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const chain of (["sol", "bsc"] as const).filter((c) => opts.params.chains[c])) {
    const tick = withInFlight(`signal:${chain}`, () => pollSignal({ ...opts, now, chain }));
    tick();
    timers.push(setInterval(tick, opts.params.poll.signal * 1000));
  }
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
