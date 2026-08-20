export type Chain = "sol" | "bsc";

export type Decision = "push" | "drop" | "skip";

export interface SmartTrade {
  /** GMGN transaction_hash，用于轮询结果去重 */
  id?: string;
  wallet: string;
  side: "buy" | "sell";
  /** 现价/成交价倍数；smartmoney 短字段经常没有 */
  price_change?: number;
  /** USD 成交额；有则净买按金额，没有才退回地址数 */
  amount_usd?: number;
  /** smartmoney：0=开仓/加仓，1=平仓/减仓 */
  is_open_or_close?: number;
  ts: number;
}

export interface Tape1m {
  price_change_1m: number;
  buys: number;
  sells: number;
  volume: number;
  swaps: number;
}

export interface CacheEntry {
  chain: Chain;
  ca: string;
  symbol?: string;
  trades: SmartTrade[];
  tape?: Partial<Tape1m>;
  tape_written_at?: number;
  /** 5m 热门盘口；不覆盖 1m tape，过线仍用 1m */
  tape5m?: Partial<Tape1m>;
  tape5m_written_at?: number;
  price_change_5m?: number;
  price_change_5m_written_at?: number;
  visiting_count?: number;
  visiting_written_at?: number;
  market_cap?: number;
  market_cap_written_at?: number;
  liquidity?: number;
  liquidity_written_at?: number;
  rank_1m?: number;
  rank_1m_seen_at?: number;
  rank_5m?: number;
  rank_5m_seen_at?: number;
  created_at?: number;
  signal10_at?: number;
  l0: Record<string, unknown>;
  /** L0 按字段记录更新时间，防止部分响应刷新整份旧快照。 */
  l0_written_at?: Record<string, number>;
}

export type PassKind = "cluster" | "boost";
export type HotPoolLane = "confirmed" | "new_token";
export type MomentumTier = "normal" | "high" | "extreme";

export interface SignalEvidence {
  smart_wallets: number;
  eligible_strict: number;
  buy_wallets: number;
  sell_wallets: number;
  buy_usd?: number;
  sell_usd?: number;
  pass_kind?: PassKind;
  price_change_1m?: number;
  price_change_5m?: number;
  buys?: number;
  sells?: number;
  volume?: number;
  swaps?: number;
  visiting_count?: number;
  market_cap?: number;
  liquidity?: number;
  /** 净买判断是否使用了完整 USD 成交额；false 时退回钱包方向。 */
  has_usd?: boolean;
  hot_pool_lane?: HotPoolLane;
  momentum_tier?: MomentumTier;
  rank_1m?: number;
  rank_5m?: number;
  rank_1m_seen_at?: number;
  rank_5m_seen_at?: number;
  created_at?: number;
}

export interface Signal {
  rule_version: string;
  chain: Chain;
  ca: string;
  symbol: string;
  ts: number;
  evidence: SignalEvidence;
  l0: Record<string, unknown>;
  links: { gmgn: string };
}

export type DecisionStage =
  | "cache"
  | "prepass"
  | "security"
  | "final"
  | "delivery";

export interface DecisionRecord {
  entry: CacheEntry;
  decision: Decision | "pass";
  reason: string;
  stage: DecisionStage;
  ts: number;
  quota_skipped?: boolean;
}

export type L0Status =
  | { kind: "incomplete" }
  | { kind: "drop"; reason: string }
  | { kind: "pass" };
