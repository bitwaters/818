import { usableMarketCap, usablePriceChange5m, usableVisiting } from "./cache.js";
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
  const tape = entry.tape ?? {};
  const sides = lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    params.flow.min_price_change_since_entry,
  );
  const mc = usableMarketCap(entry, now, params.cache.evidence_ttl_sec);
  const visiting = usableVisiting(entry, now, params.cache.evidence_ttl_sec);
  const pc5 = usablePriceChange5m(entry, now, params.cache.evidence_ttl_sec);
  const kind = passKindOf(pass);
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
      ...(tape.price_change_1m != null ? { price_change_1m: tape.price_change_1m } : {}),
      ...(pc5 != null ? { price_change_5m: pc5 } : {}),
      ...(tape.buys != null ? { buys: tape.buys } : {}),
      ...(tape.sells != null ? { sells: tape.sells } : {}),
      ...(tape.volume != null ? { volume: tape.volume } : {}),
      ...(tape.swaps != null ? { swaps: tape.swaps } : {}),
      ...(visiting != null ? { visiting_count: visiting } : {}),
      ...(mc != null ? { market_cap: mc } : {}),
      ...(entry.liquidity != null ? { liquidity: entry.liquidity } : {}),
    },
    l0: { ...entry.l0 },
    links: { gmgn: gmgnUrl(params, entry.chain, entry.ca) },
  };
}
