export type Chain = "sol" | "bsc";

export type Decision = "push" | "drop" | "skip";

export interface SmartTrade {
  wallet: string;
  side: "buy" | "sell";
  price_change: number;
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
  price_change_5m?: number;
  visiting_count?: number;
  market_cap?: number;
  market_cap_written_at?: number;
  liquidity?: number;
  signal10_at?: number;
  l0: Record<string, unknown>;
}

export interface SignalEvidence {
  smart_wallets: number;
  price_change_1m: number;
  price_change_5m?: number;
  buys: number;
  sells: number;
  volume: number;
  swaps: number;
  visiting_count?: number;
  market_cap?: number;
  liquidity?: number;
}

export interface Signal {
  chain: Chain;
  ca: string;
  symbol: string;
  ts: number;
  evidence: SignalEvidence;
  l0: Record<string, unknown>;
  links: { gmgn: string };
}

export type L0Status =
  | { kind: "incomplete" }
  | { kind: "drop"; reason: string }
  | { kind: "pass" };
