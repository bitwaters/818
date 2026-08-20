import type { Params } from "../params.js";
import type { CacheEntry, L0Status } from "../types.js";
import { usableL0 } from "../cache.js";
import {
  asNumber,
  bundlerPresent,
  bundlerRate,
  hasKey,
  isExplicitNotHoneypot,
  isOpenSource,
  isNo,
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
  const l0 = usableL0(entry, now, ttlSec);
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
  if (params.min_holder_count > 0 && !hasKey(l0, "holder_count")) {
    return { kind: "incomplete" };
  }
  if (params.bot_degen_rate_max > 0 && !hasKey(l0, "bot_degen_rate")) {
    return { kind: "incomplete" };
  }

  const buyTax = asNumber(l0.buy_tax);
  const sellTax = asNumber(l0.sell_tax);
  const rug = asNumber(l0.rug_ratio);
  const rat = asNumber(l0.rat_trader_amount_rate);
  const bundler = bundlerRate(l0);
  const top10 = asNumber(l0.top_10_holder_rate);
  if (
    buyTax == null ||
    sellTax == null ||
    rug == null ||
    rat == null ||
    bundler == null ||
    top10 == null
  ) {
    return { kind: "incomplete" };
  }
  if (buyTax < 0 || sellTax < 0 || rug < 0 || rat < 0 || bundler < 0 || top10 < 0) {
    return { kind: "incomplete" };
  }
  if (
    params.drop_wash_trading &&
    !isYes(l0.is_wash_trading) &&
    !isNo(l0.is_wash_trading)
  ) {
    return { kind: "incomplete" };
  }

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
  if (buyTax > params.buy_tax_max) return { kind: "drop", reason: "buy_tax" };
  if (sellTax > params.sell_tax_max) return { kind: "drop", reason: "sell_tax" };

  if (rug > params.rug_ratio_max) return { kind: "drop", reason: "rug_ratio" };
  if (params.drop_wash_trading && isYes(l0.is_wash_trading)) {
    return { kind: "drop", reason: "wash_trading" };
  }
  if (rat > params.rat_trader_rate_max) return { kind: "drop", reason: "rat_trader" };
  if (bundler > params.bundler_rate_max) {
    return { kind: "drop", reason: "bundler" };
  }
  if (top10 > params.top10_holder_rate_max) {
    return { kind: "drop", reason: "top10" };
  }
  const holderCount = asNumber(l0.holder_count);
  if (params.min_holder_count > 0 && holderCount == null) return { kind: "incomplete" };
  if (holderCount != null && holderCount < 0) return { kind: "incomplete" };
  if (holderCount != null && holderCount < params.min_holder_count) {
    return { kind: "drop", reason: "holder_count" };
  }
  const botDegen = asNumber(l0.bot_degen_rate);
  if (params.bot_degen_rate_max > 0 && botDegen == null) return { kind: "incomplete" };
  if (botDegen != null && botDegen < 0) return { kind: "incomplete" };
  if (
    params.bot_degen_rate_max > 0 &&
    botDegen != null &&
    botDegen > params.bot_degen_rate_max
  ) {
    return { kind: "drop", reason: "bot_degen" };
  }
  if (params.drop_signal_10 && signal10Active(entry.signal10_at, now, ttlSec)) {
    return { kind: "drop", reason: "signal_10" };
  }
  return { kind: "pass" };
}
