import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import { parse } from "yaml";
import { TokenCache, usableMarketCap } from "../src/cache.ts";
import { Pipeline, type EvaluateResult } from "../src/core.ts";
import type { Logger } from "../src/logger.ts";
import { parseParams, type Params } from "../src/params.ts";
import type { TelegramSender } from "../src/push/telegram.ts";
import { QuotaTracker } from "../src/quota.ts";
import type {
  CacheEntry,
  Chain,
  DecisionRecord,
  Signal,
  SmartTrade,
  Tape1m,
} from "../src/types.ts";

export const SOL_CA = "SoLTest11111111111111111111111111111111112";
export const BSC_CA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const BSC_CA_MIXED = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

export const BASE_PARAMS: Params = parseParams(
  parse(readFileSync(resolve(process.cwd(), "params.yaml"), "utf8")),
);

export function testParams(mut?: (p: Params) => void): Params {
  const params = structuredClone(BASE_PARAMS);
  // 大多数金样例只验证原有单一规则；新增生产过滤由专项用例覆盖。
  for (const strategy of Object.values(params.strategy)) {
    strategy.mode = "live";
    strategy.hot_pool.enabled = false;
    strategy.flow.require_smart_money = true;
    strategy.tape.min_price_change_1m = 20;
    strategy.tape.max_price_change_1m = 0;
    strategy.tape.require_price_change_5m = false;
    strategy.tape.min_volume_market_cap_ratio = 0;
    strategy.tape.max_volume_market_cap_ratio = 0;
    strategy.pass.min_entry_mc = 0;
    strategy.pass.min_liquidity_usd = 0;
  }
  // 旧金样例保留 SOL $10k 市值门槛；BSC 专项用例自行开启生产门槛。
  params.strategy.sol.pass.min_entry_mc = 10_000;
  params.l0_bsc.min_holder_count = 0;
  params.l0_bsc.bot_degen_rate_max = 0;
  mut?.(params);
  return parseParams(params);
}

export const GOOD_TAPE: Tape1m = {
  price_change_1m: 40,
  buys: 22,
  sells: 10,
  volume: 8000,
  swaps: 25,
};

export const L0_SOL: Record<string, unknown> = {
  renounced_mint: 1,
  renounced_freeze_account: 1,
  rug_ratio: 0.1,
  is_wash_trading: 0,
  rat_trader_amount_rate: 0.1,
  bundler_rate: 0.1,
  top_10_holder_rate: 0.2,
};

export const L0_BSC: Record<string, unknown> = {
  is_honeypot: "no",
  owner_renounced: "yes",
  buy_tax: 0.01,
  sell_tax: 0.01,
  rug_ratio: 0.1,
  is_wash_trading: 0,
  rat_trader_amount_rate: 0.1,
  bundler_rate: 0.1,
  top_10_holder_rate: 0.2,
  holder_count: 100,
  bot_degen_rate: 0.1,
};

export function twoBuys(now: number): SmartTrade[] {
  return [
    { wallet: "w1", side: "buy", price_change: 1.2, amount_usd: 400, ts: now },
    { wallet: "w2", side: "buy", price_change: 1.5, amount_usd: 600, ts: now },
  ];
}

export function oneBuy(now: number): SmartTrade[] {
  return [{ wallet: "w1", side: "buy", price_change: 1.2, amount_usd: 400, ts: now }];
}

export class FakeTelegram implements TelegramSender {
  signals: Signal[] = [];
  texts: string[] = [];
  failNext = false;
  failText = false;
  private readonly ids = ["test-chat"];

  destinations(): string[] {
    return this.ids.slice();
  }

  async sendSignal(signal: Signal, chatIds?: string[]): Promise<{ okIds: string[]; fail: number }> {
    if (this.failNext) {
      this.failNext = false;
      return { okIds: [], fail: 1 };
    }
    this.signals.push(signal);
    return { okIds: chatIds && chatIds.length > 0 ? chatIds : this.ids, fail: 0 };
  }

  async sendText(html: string): Promise<boolean> {
    if (this.failText || this.failNext) {
      this.failNext = false;
      this.failText = false;
      return false;
    }
    this.texts.push(html);
    return true;
  }
}

export interface Harness {
  params: Params;
  cache: TokenCache;
  quota: QuotaTracker;
  telegram: FakeTelegram;
  pipeline: Pipeline;
  logger: Logger;
  emitted: Signal[];
  inserted: Signal[];
  securityCalls: { chain: Chain; ca: string }[];
  decisions: DecisionRecord[];
  shadowSignals: Signal[];
  now: number;
}

export function makeHarness(opts?: {
  params?: Params;
  now?: number;
  fetchSecurity?: (chain: Chain, ca: string) => Promise<Record<string, unknown> | null>;
  insertImpl?: (signal: Signal) => void;
  initialPushed?: { chain: Chain; ca: string; ts: number };
}): Harness {
  const params = opts?.params ?? testParams();
  const now = opts?.now ?? 1_700_000_000_000;
  const cache = new TokenCache();
  const quota = new QuotaTracker(params.quota);
  quota.resetWindow(now);
  const telegram = new FakeTelegram();
  const emitted: Signal[] = [];
  const inserted: Signal[] = [];
  const securityCalls: { chain: Chain; ca: string }[] = [];
  const decisions: DecisionRecord[] = [];
  const shadowSignals: Signal[] = [];
  const shadowKeys = new Set<string>();
  const logger = pino({ level: "silent" });
  const clock = { now };
  const dests = telegram.destinations();
  const pushed = new Map<string, number>();
  const destKey = (chain: Chain, ca: string, chatId: string) => `${chain}:${ca}:${chatId}`;
  if (opts?.initialPushed) {
    for (const id of dests) {
      pushed.set(
        destKey(opts.initialPushed.chain, opts.initialPushed.ca, id),
        opts.initialPushed.ts,
      );
    }
  }
  const recent = (chain: Chain, ca: string, chatId: string, at: number) => {
    const ts = pushed.get(destKey(chain, ca, chatId));
    return ts != null && ts > at - params.cache.push_cooldown_sec * 1000;
  };
  const insertSignal = (s: Signal) => {
    try {
      const entry = cache.get(s.chain, s.ca);
      const mc = entry
        ? usableMarketCap(entry, clock.now, params.cache.evidence_ttl_sec)
        : s.evidence.market_cap;
      if (mc == null || !(mc > 0)) return;
      if (opts?.insertImpl) opts.insertImpl(s);
      else inserted.push(s);
    } catch {
      // 入库失败忽略，不回滚冷却
    }
  };
  const pipeline = new Pipeline({
    params,
    cache,
    quota,
    logger,
    now: () => clock.now,
    fetchSecurity: async (chain, ca) => {
      securityCalls.push({ chain, ca });
      if (opts?.fetchSecurity) return opts.fetchSecurity(chain, ca);
      return null;
    },
    telegram,
    hasPushedAll: (chain, ca, at) => dests.every((id) => recent(chain, ca, id, at)),
    hasAnyPushed: (chain, ca, at) => dests.some((id) => recent(chain, ca, id, at)),
    pendingDests: (chain, ca, at) => dests.filter((id) => !recent(chain, ca, id, at)),
    markPushedDest: (chain, ca, chatId) => {
      pushed.set(destKey(chain, ca, chatId), clock.now);
    },
    ensureInserted: insertSignal,
    recordDecision: (record) => decisions.push(record),
    hasShadowSignal: (ruleVersion, chain, ca) =>
      shadowKeys.has(`${ruleVersion}:${chain}:${ca}`),
    recordShadowSignal: (signal) => {
      const key = `${signal.rule_version}:${signal.chain}:${signal.ca}`;
      if (!shadowKeys.has(key)) shadowSignals.push(signal);
      shadowKeys.add(key);
      return true;
    },
    emit: (s) => {
      emitted.push(s);
    },
  });
  const harness: Harness = {
    params,
    cache,
    quota,
    telegram,
    pipeline,
    logger,
    emitted,
    inserted,
    securityCalls,
    decisions,
    shadowSignals,
    now,
  };
  Object.defineProperty(harness, "now", {
    get: () => clock.now,
    set: (v: number) => {
      clock.now = v;
    },
  });
  return harness;
}

export function seed(
  h: Harness,
  chain: Chain,
  ca: string,
  patch: {
    l0?: Record<string, unknown>;
    tape?: Partial<Tape1m>;
    trades?: SmartTrade[];
    visiting?: number;
    marketCap?: number;
    marketCapAt?: number;
    symbol?: string;
    liquidity?: number;
    priceChange5m?: number;
    priceChange5mAt?: number;
    signal10At?: number;
  },
): CacheEntry {
  const entry = h.cache.upsert(chain, ca)!;
  if (patch.l0) h.cache.mergeL0(chain, ca, patch.l0, h.now);
  if (patch.tape) h.cache.writeTape1m(chain, ca, patch.tape, { symbol: patch.symbol, liquidity: patch.liquidity, now: h.now });
  if (patch.trades) h.cache.writeTrades(chain, ca, patch.trades);
  if (patch.visiting != null) h.cache.writeVisiting(chain, ca, patch.visiting, h.now);
  if (patch.marketCap != null) {
    h.cache.writeMarketCap(chain, ca, patch.marketCap, patch.marketCapAt ?? h.now);
  }
  if (patch.symbol) h.cache.writeSymbol(chain, ca, patch.symbol);
  if (patch.priceChange5m != null) {
    h.cache.writePriceChange5m(chain, ca, patch.priceChange5m, patch.priceChange5mAt ?? h.now);
  }
  if (patch.signal10At != null) h.cache.writeSignal10(chain, ca, patch.signal10At);
  return entry;
}

export function seedReady(h: Harness, chain: Chain = "sol", ca = SOL_CA): CacheEntry {
  return seed(h, chain, ca, {
    l0: chain === "sol" ? L0_SOL : L0_BSC,
    tape: GOOD_TAPE,
    trades: twoBuys(h.now),
    visiting: 150,
    priceChange5m: 12,
    symbol: "PEPE",
    marketCap: 100_000,
  });
}

export async function evalOf(
  h: Harness,
  chain: Chain = "sol",
  ca = SOL_CA,
): Promise<EvaluateResult> {
  const result = await h.pipeline.evaluate(chain, ca);
  await Promise.resolve();
  return result;
}
