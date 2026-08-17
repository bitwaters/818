import type { Params } from "../params.js";
import type { CacheEntry, L0Status } from "../types.js";
import {
  asNumber,
  bundlerPresent,
  bundlerRate,
  hasKey,
  isYes,
  signal10Active,
} from "./normalize.js";

export function checkSolL0(
  entry: CacheEntry,
  params: Params["l0_sol"],
  now: number,
  ttlSec: number,
): L0Status {
  const l0 = entry.l0;
  if (params.require_renounced_mint && !hasKey(l0, "renounced_mint")) return { kind: "incomplete" };
  if (params.require_renounced_freeze && !hasKey(l0, "renounced_freeze_account")) {
    return { kind: "incomplete" };
  }
  if (!hasKey(l0, "rug_ratio")) return { kind: "incomplete" };
  if (params.drop_wash_trading && !hasKey(l0, "is_wash_trading")) return { kind: "incomplete" };
  if (!hasKey(l0, "rat_trader_amount_rate")) return { kind: "incomplete" };
  if (!bundlerPresent(l0)) return { kind: "incomplete" };
  if (!hasKey(l0, "top_10_holder_rate")) return { kind: "incomplete" };

  if (params.require_renounced_mint && !isYes(l0.renounced_mint)) {
    return { kind: "drop", reason: "mint_not_renounced" };
  }
  if (params.require_renounced_freeze && !isYes(l0.renounced_freeze_account)) {
    return { kind: "drop", reason: "freeze_not_renounced" };
  }
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
