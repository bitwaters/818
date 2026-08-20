import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const chainBool = z.object({
  sol: z.boolean(),
  bsc: z.boolean(),
});

const ParamsSchema = z.object({
  rules: z
    .object({
      version: z.string().min(1),
      reset_id: z.string().min(1).optional(),
      delivery_reset_id: z.string().min(1).optional(),
    })
    .default({ version: "legacy" }),
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
  hot_pool: z
    .object({
      enabled: z.boolean().default(false),
      rank_limit: z.number().int().min(1).max(100).default(100),
      membership_ttl_sec: z.number().int().positive().default(30),
      new_token_grace_sec: z.number().int().nonnegative().default(360),
    })
    .default({
      enabled: false,
      rank_limit: 100,
      membership_ttl_sec: 30,
      new_token_grace_sec: 360,
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
    signal_enabled: chainBool.default({ sol: true, bsc: true }),
    min_entry_mc: z
      .object({
        sol: z.number().nonnegative().default(0),
        bsc: z.number().nonnegative().default(0),
      })
      .default({ sol: 0, bsc: 0 }),
    min_liquidity_usd: z
      .object({
        sol: z.number().nonnegative().default(0),
        bsc: z.number().nonnegative().default(0),
      })
      .default({ sol: 0, bsc: 0 }),
  }),
  flow: z.object({
    require_smart_money: z.boolean().default(true),
    min_smart_wallets: z.number().int().min(1),
    require_net_buy: z.boolean(),
    min_price_change_since_entry: z.number(),
  }),
  tape: z.object({
    min_volume_usd: z.number().nonnegative(),
    min_swaps: z.number().nonnegative(),
    min_price_change_1m: z.number().nonnegative(),
    /** 达到该 1m 涨幅视为追高；0 关闭 */
    max_price_change_1m: z.number().nonnegative().default(0),
    high_momentum_1m: z.number().nonnegative().default(100),
    extreme_momentum_1m: z.number().nonnegative().default(300),
    min_price_change_5m: z.number().nonnegative(),
    /** true 时缺少新鲜 5m 动量只等待，不允许直接放行。 */
    require_price_change_5m: z.boolean().default(false),
    /** 买/卖笔数比 ≥ 此值视为假动量否决；0 关闭 */
    max_buy_sell_ratio: z.number().nonnegative().default(0),
    /** 1m 成交量 / 市值的合理区间；0 关闭对应边界 */
    min_volume_market_cap_ratio: z.number().nonnegative().default(0),
    max_volume_market_cap_ratio: z.number().nonnegative().default(0),
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
    /** 0 关闭；启用时缺字段触发 security 补全，仍缺则不放行。 */
    min_holder_count: z.number().int().nonnegative().default(0),
    /** 0 关闭。 */
    bot_degen_rate_max: z.number().nonnegative().default(0),
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
  /** 缺整个 trace 或个别键时用默认值，避免旧 yaml 把进程打挂；默认关闭轨迹。 */
  trace: z
    .object({
      enabled: z.boolean().default(false),
      min_gap_ms: z.number().int().min(0).default(5000),
      mc_change_pct: z.number().positive().default(0.02),
      watch_min_sec: z.number().int().positive().default(21600),
      watch_idle_sec: z.number().int().positive().default(7200),
      watch_max_sec: z.number().int().positive().default(43200),
      retain_hours: z.number().positive().default(72),
      flush_ms: z.number().int().positive().default(1000),
    })
    .default({
      enabled: false,
      min_gap_ms: 5000,
      mc_change_pct: 0.02,
      watch_min_sec: 21600,
      watch_idle_sec: 7200,
      watch_max_sec: 43200,
      retain_hours: 72,
      flush_ms: 1000,
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
