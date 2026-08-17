import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const chainBool = z.object({
  sol: z.boolean(),
  bsc: z.boolean(),
});

const ParamsSchema = z.object({
  chains: chainBool,
  poll: z.object({
    smartmoney: z.number().positive(),
    trending: z.number().positive(),
    hot_searches: z.number().positive(),
    signal: z.number().positive(),
  }),
  intervals: z.object({
    trending: z.array(z.string().min(1)).min(1),
  }),
  cache: z.object({
    evidence_ttl_sec: z.number().int().positive(),
    push_cooldown_sec: z.number().int().nonnegative(),
  }),
  sources: z.object({
    smartmoney: z.boolean(),
    trending: z.boolean(),
    hot_searches: z.boolean(),
    signal_12: z.boolean(),
    signal_6: z.boolean(),
    signal_7: z.boolean(),
    signal_10: z.boolean(),
  }),
  pass: z.object({
    visiting_can_boost: z.boolean(),
  }),
  flow: z.object({
    min_smart_wallets: z.number().int().min(1),
    require_net_buy: z.boolean(),
    min_price_change_since_entry: z.number(),
  }),
  tape: z.object({
    min_volume_usd: z.number().nonnegative(),
    min_swaps: z.number().nonnegative(),
  }),
  attention: z.object({
    min_visiting_count: z.number().nonnegative(),
    use_interval: z.string().min(1),
  }),
  l0_sol: z.object({
    require_renounced_mint: z.boolean(),
    require_renounced_freeze: z.boolean(),
    rug_ratio_max: z.number(),
    drop_wash_trading: z.boolean(),
    rat_trader_rate_max: z.number(),
    bundler_rate_max: z.number(),
    top10_holder_rate_max: z.number(),
    drop_signal_10: z.boolean(),
  }),
  l0_bsc: z.object({
    require_not_honeypot: z.boolean(),
    require_owner_renounced: z.boolean(),
    require_open_source: z.boolean(),
    require_lp_lock: z.boolean(),
    sell_tax_max: z.number(),
    buy_tax_max: z.number(),
    rug_ratio_max: z.number(),
    drop_wash_trading: z.boolean(),
    rat_trader_rate_max: z.number(),
    bundler_rate_max: z.number(),
    top10_holder_rate_max: z.number(),
    drop_signal_10: z.boolean(),
  }),
  push: z.object({
    telegram_enabled: z.boolean(),
    parse_mode: z.literal("HTML"),
    gmgn_token_url: z.object({
      sol: z.string().includes("{ca}"),
      bsc: z.string().includes("{ca}"),
    }),
  }),
  stats: z.object({
    enabled: z.boolean(),
    sqlite_path: z.string().min(1),
    snapshot_sec: z.number().positive(),
    track_hours: z.number().positive(),
    hit_multiple: z.number().positive(),
    milestone_step: z.number().positive(),
    timezone: z.string().min(1),
  }),
  quota: z.object({
    window_sec: z.number().int().min(1),
    security_per_round: z.object({
      sol: z.number().int().min(0),
      bsc: z.number().int().min(0),
    }),
    snapshot_per_round: z.object({
      sol: z.number().int().min(0),
      bsc: z.number().int().min(0),
    }),
    on_429: z.enum(["read_reset"]),
  }),
});

export type Params = z.infer<typeof ParamsSchema>;

export function loadParams(path = resolve(process.cwd(), "params.yaml")): Params {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`failed to read params: ${path}`);
    throw err;
  }
  const parsed = ParamsSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(parsed.error.flatten());
    process.exit(1);
  }
  return parsed.data;
}

export function parseParams(raw: unknown): Params {
  return ParamsSchema.parse(raw);
}
