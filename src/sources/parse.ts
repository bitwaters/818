import { numField, strField } from "../gmgn/http.js";
import type { Chain, SmartTrade } from "../types.js";

export const L0_SNAPSHOT_KEYS = [
  "renounced_mint",
  "renounced_freeze_account",
  "rug_ratio",
  "is_wash_trading",
  "rat_trader_amount_rate",
  "bundler_rate",
  "bundler_trader_amount_rate",
  "top_10_holder_rate",
  "is_honeypot",
  "owner_renounced",
  "is_renounced",
  "open_source",
  "is_open_source",
  "lock_percent",
  "lp_lock_percent",
  "buy_tax",
  "sell_tax",
] as const;

export function pickL0Snapshot(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of L0_SNAPSHOT_KEYS) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

export function tokenAddress(row: Record<string, unknown>): string | undefined {
  return strField(row, "base_address", "token_address", "token", "ca", "address");
}

export function tokenChain(row: Record<string, unknown>, fallback: Chain): Chain {
  const raw = strField(row, "chain", "chain_name");
  if (raw === "sol" || raw === "bsc") return raw;
  return fallback;
}

export function parseSide(value: unknown): "buy" | "sell" | undefined {
  if (value === 1 || value === "1") return "buy";
  if (value === 0 || value === "0") return "sell";
  if (typeof value === "string") {
    const s = value.toLowerCase();
    if (s === "buy" || s === "b") return "buy";
    if (s === "sell" || s === "s") return "sell";
  }
  return undefined;
}

export function parseTrade(row: Record<string, unknown>, now: number): SmartTrade | null {
  let wallet = strField(row, "maker", "wallet", "wallet_address", "from_address");
  if (!wallet && row.maker_info && typeof row.maker_info === "object") {
    wallet = strField(row.maker_info as Record<string, unknown>, "address");
  }
  const side = parseSide(row.side ?? row.buy_or_sell ?? row.event);
  const priceChange = numField(row, "price_change", "price_change_percent", "profit");
  if (!wallet || !side) return null;
  const ts = numField(row, "timestamp", "ts", "time", "created_at") ?? now;
  return {
    wallet,
    side,
    ...(priceChange != null ? { price_change: priceChange } : {}),
    ts: ts > 1e12 ? ts : ts * 1000,
  };
}

export function parseTokenInfoMc(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const inner =
    root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  const priceObj =
    inner.price && typeof inner.price === "object"
      ? (inner.price as Record<string, unknown>)
      : undefined;
  const price = Number(priceObj?.price);
  const circ = Number(inner.circulating_supply);
  if (!Number.isFinite(price) || !Number.isFinite(circ) || price <= 0 || circ <= 0) return null;
  return price * circ;
}
