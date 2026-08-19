import { usableMarketCap } from "./cache.js";
import type { Params } from "./params.js";
import { evaluatePass, lastSides } from "./pass.js";
import type { CacheEntry, PassKind, Signal } from "./types.js";

function passKindFrom(entry: CacheEntry, params: Params, now: number): PassKind | undefined {
  const pass = evaluatePass(entry, params, now);
  if (pass.kind !== "pass") return undefined;
  return pass.cluster ? "cluster" : "boost";
}

export function gmgnUrl(params: Params, chain: CacheEntry["chain"], ca: string): string {
  return params.push.gmgn_token_url[chain].replaceAll("{ca}", ca);
}

export function buildSignal(entry: CacheEntry, params: Params, now: number): Signal {
  const tape = entry.tape ?? {};
  const sides = lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    params.flow.min_price_change_since_entry,
  );
  const mc = usableMarketCap(entry, now, params.cache.evidence_ttl_sec);
  const kind = passKindFrom(entry, params, now);
  return {
    chain: entry.chain,
    ca: entry.ca,
    symbol: entry.symbol ?? "",
    ts: now,
    evidence: {
      smart_wallets: sides.eligible,
      eligible_strict: sides.eligible_strict,
      buy_wallets: sides.buyWallets,
      sell_wallets: sides.sellWallets,
      ...(kind ? { pass_kind: kind } : {}),
      price_change_1m: tape.price_change_1m ?? 0,
      ...(entry.price_change_5m != null ? { price_change_5m: entry.price_change_5m } : {}),
      buys: tape.buys ?? 0,
      sells: tape.sells ?? 0,
      volume: tape.volume ?? 0,
      swaps: tape.swaps ?? 0,
      ...(entry.visiting_count != null ? { visiting_count: entry.visiting_count } : {}),
      ...(mc != null ? { market_cap: mc } : {}),
      ...(entry.liquidity != null ? { liquidity: entry.liquidity } : {}),
    },
    l0: { ...entry.l0 },
    links: { gmgn: gmgnUrl(params, entry.chain, entry.ca) },
  };
}
