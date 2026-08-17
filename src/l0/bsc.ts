import type { Params } from "../params.js";
import type { CacheEntry, L0Status } from "../types.js";
import {
  asNumber,
  bundlerPresent,
  bundlerRate,
  hasKey,
  isExplicitNotHoneypot,
  isOpenSource,
  isYes,
  lockPercent,
  lockPresent,
  openSourcePresent,
  ownerIsRenounced,
  ownerRenouncedPresent,
  signal10Active,
} from "./normalize.js";

export function checkBscL0(
  entry: CacheEntry,
  params: Params["l0_bsc"],
  now: number,
  ttlSec: number,
): L0Status {
  const l0 = entry.l0;
  if (params.require_not_honeypot && !hasKey(l0, "is_honeypot")) return { kind: "incomplete" };
  if (params.require_owner_renounced && !ownerRenouncedPresent(l0)) return { kind: "incomplete" };
  if (params.require_open_source && !openSourcePresent(l0)) return { kind: "incomplete" };
  if (params.require_lp_lock && !lockPresent(l0)) return { kind: "incomplete" };
  if (!hasKey(l0, "buy_tax") || !hasKey(l0, "sell_tax")) return { kind: "incomplete" };
  if (!hasKey(l0, "rug_ratio")) return { kind: "incomplete" };
  if (params.drop_wash_trading && !hasKey(l0, "is_wash_trading")) return { kind: "incomplete" };
  if (!hasKey(l0, "rat_trader_amount_rate")) return { kind: "incomplete" };
  if (!bundlerPresent(l0)) return { kind: "incomplete" };
  if (!hasKey(l0, "top_10_holder_rate")) return { kind: "incomplete" };

  if (params.require_not_honeypot && !isExplicitNotHoneypot(l0.is_honeypot)) {
    return { kind: "drop", reason: "honeypot" };
  }
  if (params.require_owner_renounced && !ownerIsRenounced(l0)) {
    return { kind: "drop", reason: "owner_not_renounced" };
  }
  if (params.require_open_source && !isOpenSource(l0)) {
    return { kind: "drop", reason: "not_open_source" };
  }
  if (params.require_lp_lock) {
    const lock = lockPercent(l0);
    if (lock == null || lock < 0.5) return { kind: "drop", reason: "lp_unlocked" };
  }
  const buyTax = asNumber(l0.buy_tax);
  const sellTax = asNumber(l0.sell_tax);
  if (buyTax != null && buyTax > params.buy_tax_max) return { kind: "drop", reason: "buy_tax" };
  if (sellTax != null && sellTax > params.sell_tax_max) return { kind: "drop", reason: "sell_tax" };

  const rug = asNumber(l0.rug_ratio);
  if (rug != null && rug > params.rug_ratio_max) return { kind: "drop", reason: "rug_ratio" };
  if (params.drop_wash_trading && isYes(l0.is_wash_trading)) {
    return { kind: "drop", reason: "wash_trading" };
  }
  const rat = asNumber(l0.rat_trader_amount_rate);
  if (rat != null && rat > params.rat_trader_rate_max) return { kind: "drop", reason: "rat_trader" };
  const bundler = bundlerRate(l0);
  if (bundler != null && bundler > params.bundler_rate_max) {
    return { kind: "drop", reason: "bundler" };
  }
  const top10 = asNumber(l0.top_10_holder_rate);
  if (top10 != null && top10 > params.top10_holder_rate_max) {
    return { kind: "drop", reason: "top10" };
  }
  if (params.drop_signal_10 && signal10Active(entry.signal10_at, now, ttlSec)) {
    return { kind: "drop", reason: "signal_10" };
  }
  return { kind: "pass" };
}
