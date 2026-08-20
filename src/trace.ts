import type Database from "better-sqlite3";
import {
  TokenCache,
  tradesInWindow,
  usableLiquidity,
  usableL0,
  usableMarketCap,
  usablePriceChange5m,
  usableTape1m,
  usableVisiting,
} from "./cache.js";
import {
  hotPoolLane,
  hotPoolPrice5m,
  isFreshRank1m,
  isFreshRank5m,
  momentumTier,
} from "./hotpool.js";
import type { Logger } from "./logger.js";
import { strategyFor, type Params } from "./params.js";
import { lastSides } from "./pass.js";
import type { CacheEntry, Chain, DecisionRecord, Signal } from "./types.js";

const MAX_BUFFER = 5000;

export interface TickSnapshot {
  visiting: number | null;
  eligible: number;
  eligible_strict: number;
  buy_wallets: number;
  sell_wallets: number;
  buy_usd: number;
  sell_usd: number;
  volume: number | null;
  swaps: number | null;
  buys: number | null;
  sells: number | null;
  pc_1m: number | null;
  mc: number | null;
  pushed: 0 | 1;
}

export interface WatchState {
  firstSeen: number;
  lastIncreaseAt: number;
  lastTickAt: number;
  lastVisiting: number | null;
  lastEligible: number;
  lastEligibleStrict: number;
  lastBuy: number;
  lastSell: number;
  lastBuyUsd: number;
  lastSellUsd: number;
  lastMc: number | null;
}

interface BufferedTick extends TickSnapshot {
  ts: number;
  chain: Chain;
  ca: string;
}

interface BufferedCandidate {
  ts: number;
  chain: Chain;
  ca: string;
  symbol: string | null;
  mc: number | null;
  eligible: number;
  buy_usd: number;
  sell_usd: number;
  visiting: number | null;
  volume: number | null;
  pc_1m: number | null;
  liquidity: number | null;
  l0_json: string;
  pushed: 0 | 1;
  rule_version: string;
  has_usd: 0 | 1;
  pc_5m: number | null;
  hot_pool_lane: string | null;
  momentum_tier: string | null;
  rank_1m: number | null;
  rank_5m: number | null;
  rank_1m_seen_at: number | null;
  rank_5m_seen_at: number | null;
  created_at: number | null;
}

function watchKey(chain: Chain, ca: string): string {
  return `${chain}:${ca}`;
}

export function tickFingerprint(snap: TickSnapshot): string {
  return [
    snap.visiting,
    snap.eligible,
    snap.eligible_strict,
    snap.buy_wallets,
    snap.sell_wallets,
    snap.buy_usd,
    snap.sell_usd,
    snap.buys,
    snap.sells,
    snap.volume,
    snap.swaps,
    snap.pc_1m,
    snap.mc,
    snap.pushed,
  ].join("|");
}

export function shouldEnterWatch(hasVisiting: boolean, hasSmartmoney: boolean): boolean {
  return hasVisiting || hasSmartmoney;
}

export function isCountIncrease(prev: WatchState, snap: TickSnapshot): boolean {
  const visChanged = snap.visiting !== prev.lastVisiting;
  const smChange =
    snap.eligible !== prev.lastEligible ||
    snap.eligible_strict !== prev.lastEligibleStrict ||
    snap.buy_wallets !== prev.lastBuy ||
    snap.sell_wallets !== prev.lastSell;
  const amountChange = snap.buy_usd !== prev.lastBuyUsd || snap.sell_usd !== prev.lastSellUsd;
  return visChanged || smChange || amountChange;
}

export function isInterestingTick(
  prev: WatchState,
  snap: TickSnapshot,
  mcChangePct: number,
): boolean {
  if (isCountIncrease(prev, snap)) return true;
  if (prev.lastMc == null && snap.mc != null) return true;
  if (prev.lastMc != null && snap.mc != null && prev.lastMc > 0) {
    return Math.abs(snap.mc - prev.lastMc) / prev.lastMc >= mcChangePct;
  }
  return false;
}

export function shouldExpireWatch(
  watch: Pick<WatchState, "firstSeen" | "lastIncreaseAt">,
  now: number,
  trace: Params["trace"],
): boolean {
  const ageSec = (now - watch.firstSeen) / 1000;
  if (ageSec >= trace.watch_max_sec) return true;
  const idleSec = (now - watch.lastIncreaseAt) / 1000;
  return ageSec >= trace.watch_min_sec && idleSec >= trace.watch_idle_sec;
}

export function shouldWriteTick(opts: {
  interesting: boolean;
  lastTickAt: number;
  now: number;
  minGapMs: number;
}): boolean {
  // interesting 只延长 watch 活跃期，不再绕过采样下限；秒级重复快照对 10m 回放无价值。
  if (opts.lastTickAt === 0) return true;
  return opts.now - opts.lastTickAt >= opts.minGapMs;
}

function snapshotOf(
  entry: CacheEntry,
  params: Params,
  now: number,
  pushed: boolean,
): TickSnapshot {
  const strategy = strategyFor(params, entry.chain);
  const sides = lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    strategy.flow.min_price_change_since_entry,
  );
  const tape = usableTape1m(entry, now, params.cache.evidence_ttl_sec) ?? {};
  const mc = usableMarketCap(entry, now, params.cache.evidence_ttl_sec) ?? null;
  return {
    visiting: usableVisiting(entry, now, params.cache.evidence_ttl_sec) ?? null,
    eligible: sides.eligible,
    eligible_strict: sides.eligible_strict,
    buy_wallets: sides.buyWallets,
    sell_wallets: sides.sellWallets,
    buy_usd: sides.buyUsd,
    sell_usd: sides.sellUsd,
    volume: tape.volume ?? null,
    swaps: tape.swaps ?? null,
    buys: tape.buys ?? null,
    sells: tape.sells ?? null,
    pc_1m: tape.price_change_1m ?? null,
    mc,
    pushed: pushed ? 1 : 0,
  };
}

function ensureColumn(
  db: Database.Database,
  table: "ticks" | "candidates" | "decision_events",
  name: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

const SHADOW_L0_FIELDS = [
  "creator_close",
  "creator_token_status",
  "sniper_count",
  "top70_sniper_hold_rate",
  "dev_team_hold_rate",
  "launchpad",
  "smart_degen_count",
  "renowned_count",
  "initial_liquidity",
  "burn_ratio",
  "burn_status",
] as const;

export function shadowRiskSnapshot(l0: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SHADOW_L0_FIELDS) {
    if (l0[key] !== undefined) out[key] = l0[key];
  }
  return out;
}

export class TickRecorder {
  private readonly watches = new Map<string, WatchState>();
  private readonly cooled = new Set<string>();
  private buffer: BufferedTick[] = [];
  private candidateBuffer: BufferedCandidate[] = [];
  private readonly insert;
  private readonly upsertCandidate;
  private readonly insertDecision;
  private readonly insertPoolSnapshot;
  private readonly insertShadowSignal;
  private readonly hasShadowSignalStmt;
  private readonly pruneStmt;
  private readonly pruneDecisionsStmt;
  private readonly prunePoolSnapshotsStmt;
  private readonly decisionStates = new Map<string, { fingerprint: string; ts: number }>();
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly params: Params,
    private readonly logger: Logger,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        visiting INTEGER,
        eligible INTEGER,
        eligible_strict INTEGER,
        buy_wallets INTEGER,
        sell_wallets INTEGER,
        buy_usd REAL,
        sell_usd REAL,
        volume REAL,
        swaps INTEGER,
        buys INTEGER,
        sells INTEGER,
        pc_1m REAL,
        mc REAL,
        pushed INTEGER NOT NULL DEFAULT 0
      )
    `);
    ensureColumn(this.db, "ticks", "buys", "INTEGER");
    ensureColumn(this.db, "ticks", "sells", "INTEGER");
    ensureColumn(this.db, "ticks", "buy_usd", "REAL");
    ensureColumn(this.db, "ticks", "sell_usd", "REAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        symbol TEXT,
        first_mc REAL,
        max_mc REAL,
        eligible INTEGER NOT NULL,
        buy_usd REAL NOT NULL,
        sell_usd REAL NOT NULL,
        visiting INTEGER,
        volume REAL,
        pc_1m REAL,
        liquidity REAL,
        l0_json TEXT NOT NULL DEFAULT '{}',
        pushed INTEGER NOT NULL DEFAULT 0,
        rule_version TEXT NOT NULL DEFAULT 'legacy',
        has_usd INTEGER NOT NULL DEFAULT 0,
        pc_5m REAL,
        hot_pool_lane TEXT,
        momentum_tier TEXT,
        rank_1m INTEGER,
        rank_5m INTEGER,
        rank_1m_seen_at INTEGER,
        rank_5m_seen_at INTEGER,
        created_at INTEGER,
        PRIMARY KEY (chain, ca)
      )
    `);
    ensureColumn(this.db, "candidates", "rule_version", "TEXT NOT NULL DEFAULT 'legacy'");
    ensureColumn(this.db, "candidates", "has_usd", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "candidates", "pc_5m", "REAL");
    ensureColumn(this.db, "candidates", "hot_pool_lane", "TEXT");
    ensureColumn(this.db, "candidates", "momentum_tier", "TEXT");
    ensureColumn(this.db, "candidates", "rank_1m", "INTEGER");
    ensureColumn(this.db, "candidates", "rank_5m", "INTEGER");
    ensureColumn(this.db, "candidates", "rank_1m_seen_at", "INTEGER");
    ensureColumn(this.db, "candidates", "rank_5m_seen_at", "INTEGER");
    ensureColumn(this.db, "candidates", "created_at", "INTEGER");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        rule_version TEXT NOT NULL,
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        stage TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        quota_skipped INTEGER NOT NULL DEFAULT 0,
        eligible INTEGER NOT NULL,
        eligible_strict INTEGER NOT NULL,
        buy_wallets INTEGER NOT NULL,
        sell_wallets INTEGER NOT NULL,
        buy_usd REAL NOT NULL,
        sell_usd REAL NOT NULL,
        has_usd INTEGER NOT NULL,
        visiting INTEGER,
        volume REAL,
        swaps INTEGER,
        buys INTEGER,
        sells INTEGER,
        pc_1m REAL,
        pc_5m REAL,
        mc REAL,
        liquidity REAL,
        l0_json TEXT NOT NULL,
        shadow_json TEXT NOT NULL,
        hot_pool_lane TEXT,
        momentum_tier TEXT,
        rank_1m INTEGER,
        rank_5m INTEGER,
        rank_1m_seen_at INTEGER,
        rank_5m_seen_at INTEGER,
        created_at INTEGER
      )
    `);
    ensureColumn(this.db, "decision_events", "hot_pool_lane", "TEXT");
    ensureColumn(this.db, "decision_events", "momentum_tier", "TEXT");
    ensureColumn(this.db, "decision_events", "rank_1m", "INTEGER");
    ensureColumn(this.db, "decision_events", "rank_5m", "INTEGER");
    ensureColumn(this.db, "decision_events", "rank_1m_seen_at", "INTEGER");
    ensureColumn(this.db, "decision_events", "rank_5m_seen_at", "INTEGER");
    ensureColumn(this.db, "decision_events", "created_at", "INTEGER");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hot_pool_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        rule_version TEXT NOT NULL,
        chain TEXT NOT NULL,
        rank_1m_count INTEGER NOT NULL,
        rank_5m_count INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        smartmoney_count INTEGER NOT NULL,
        eligible_2_count INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_signals (
        rule_version TEXT NOT NULL,
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        ts INTEGER NOT NULL,
        symbol TEXT,
        pass_kind TEXT,
        hot_pool_lane TEXT,
        momentum_tier TEXT,
        visiting INTEGER NOT NULL,
        volume REAL,
        swaps INTEGER,
        buys INTEGER,
        sells INTEGER,
        pc_1m REAL,
        pc_5m REAL,
        mc REAL,
        liquidity REAL,
        smart_wallets INTEGER NOT NULL,
        buy_wallets INTEGER NOT NULL,
        sell_wallets INTEGER NOT NULL,
        buy_usd REAL,
        sell_usd REAL,
        rank_1m INTEGER,
        rank_5m INTEGER,
        created_at INTEGER,
        l0_json TEXT NOT NULL,
        PRIMARY KEY (rule_version, chain, ca)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ticks_ca_ts ON ticks (chain, ca, ts)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ticks_ts ON ticks (ts)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS decision_events_rule_ts ON decision_events (rule_version, ts)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS decision_events_ca_ts ON decision_events (chain, ca, ts)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS hot_pool_snapshots_rule_ts ON hot_pool_snapshots (rule_version, ts)`,
    );
    this.insert = this.db.prepare(`
      INSERT INTO ticks (
        ts, chain, ca, visiting, eligible, eligible_strict, buy_wallets, sell_wallets,
        buy_usd, sell_usd, volume, swaps, buys, sells, pc_1m, mc, pushed
      ) VALUES (
        @ts, @chain, @ca, @visiting, @eligible, @eligible_strict, @buy_wallets, @sell_wallets,
        @buy_usd, @sell_usd, @volume, @swaps, @buys, @sells, @pc_1m, @mc, @pushed
      )
    `);
    this.upsertCandidate = this.db.prepare(`
      INSERT INTO candidates (
        chain, ca, first_seen, last_seen, symbol, first_mc, max_mc, eligible,
        buy_usd, sell_usd, visiting, volume, pc_1m, liquidity, l0_json, pushed,
        rule_version, has_usd, pc_5m, hot_pool_lane, momentum_tier, rank_1m, rank_5m,
        rank_1m_seen_at, rank_5m_seen_at, created_at
      ) VALUES (
        @chain, @ca, @ts, @ts, @symbol, @mc, @mc, @eligible,
        @buy_usd, @sell_usd, @visiting, @volume, @pc_1m, @liquidity, @l0_json, @pushed,
        @rule_version, @has_usd, @pc_5m, @hot_pool_lane, @momentum_tier, @rank_1m, @rank_5m,
        @rank_1m_seen_at, @rank_5m_seen_at, @created_at
      )
      ON CONFLICT(chain, ca) DO UPDATE SET
        last_seen = excluded.last_seen,
        symbol = COALESCE(NULLIF(excluded.symbol, ''), candidates.symbol),
        first_seen = CASE
          WHEN candidates.rule_version <> excluded.rule_version THEN excluded.first_seen
          ELSE candidates.first_seen
        END,
        first_mc = CASE
          WHEN candidates.rule_version <> excluded.rule_version THEN excluded.first_mc
          ELSE COALESCE(candidates.first_mc, excluded.first_mc)
        END,
        max_mc = CASE
          WHEN candidates.rule_version <> excluded.rule_version THEN excluded.max_mc
          WHEN excluded.max_mc IS NULL THEN candidates.max_mc
          WHEN candidates.max_mc IS NULL OR excluded.max_mc > candidates.max_mc THEN excluded.max_mc
          ELSE candidates.max_mc
        END,
        eligible = excluded.eligible,
        buy_usd = excluded.buy_usd,
        sell_usd = excluded.sell_usd,
        visiting = excluded.visiting,
        volume = excluded.volume,
        pc_1m = excluded.pc_1m,
        liquidity = excluded.liquidity,
        l0_json = excluded.l0_json,
        pushed = CASE
          WHEN candidates.rule_version <> excluded.rule_version THEN excluded.pushed
          ELSE MAX(candidates.pushed, excluded.pushed)
        END,
        rule_version = excluded.rule_version,
        has_usd = excluded.has_usd,
        pc_5m = excluded.pc_5m,
        hot_pool_lane = excluded.hot_pool_lane,
        momentum_tier = excluded.momentum_tier,
        rank_1m = excluded.rank_1m,
        rank_5m = excluded.rank_5m,
        rank_1m_seen_at = excluded.rank_1m_seen_at,
        rank_5m_seen_at = excluded.rank_5m_seen_at,
        created_at = excluded.created_at
    `);
    this.insertDecision = this.db.prepare(`
      INSERT INTO decision_events (
        ts, rule_version, chain, ca, stage, decision, reason, quota_skipped,
        eligible, eligible_strict, buy_wallets, sell_wallets, buy_usd, sell_usd, has_usd,
        visiting, volume, swaps, buys, sells, pc_1m, pc_5m, mc, liquidity, l0_json, shadow_json,
        hot_pool_lane, momentum_tier, rank_1m, rank_5m,
        rank_1m_seen_at, rank_5m_seen_at, created_at
      ) VALUES (
        @ts, @rule_version, @chain, @ca, @stage, @decision, @reason, @quota_skipped,
        @eligible, @eligible_strict, @buy_wallets, @sell_wallets, @buy_usd, @sell_usd, @has_usd,
        @visiting, @volume, @swaps, @buys, @sells, @pc_1m, @pc_5m, @mc, @liquidity,
        @l0_json, @shadow_json, @hot_pool_lane, @momentum_tier, @rank_1m, @rank_5m,
        @rank_1m_seen_at, @rank_5m_seen_at, @created_at
      )
    `);
    this.insertPoolSnapshot = this.db.prepare(`
      INSERT INTO hot_pool_snapshots (
        ts, rule_version, chain, rank_1m_count, rank_5m_count, candidate_count,
        smartmoney_count, eligible_2_count
      ) VALUES (
        @ts, @rule_version, @chain, @rank_1m_count, @rank_5m_count, @candidate_count,
        @smartmoney_count, @eligible_2_count
      )
    `);
    this.insertShadowSignal = this.db.prepare(`
      INSERT OR IGNORE INTO shadow_signals (
        rule_version, chain, ca, ts, symbol, pass_kind, hot_pool_lane, momentum_tier,
        visiting, volume, swaps, buys, sells, pc_1m, pc_5m, mc, liquidity,
        smart_wallets, buy_wallets, sell_wallets, buy_usd, sell_usd,
        rank_1m, rank_5m, created_at, l0_json
      ) VALUES (
        @rule_version, @chain, @ca, @ts, @symbol, @pass_kind, @hot_pool_lane, @momentum_tier,
        @visiting, @volume, @swaps, @buys, @sells, @pc_1m, @pc_5m, @mc, @liquidity,
        @smart_wallets, @buy_wallets, @sell_wallets, @buy_usd, @sell_usd,
        @rank_1m, @rank_5m, @created_at, @l0_json
      )
    `);
    this.hasShadowSignalStmt = this.db.prepare(`
      SELECT 1 FROM shadow_signals WHERE rule_version = ? AND chain = ? AND ca = ? LIMIT 1
    `);
    this.pruneStmt = this.db.prepare(`DELETE FROM ticks WHERE ts < ?`);
    this.pruneDecisionsStmt = this.db.prepare(`DELETE FROM decision_events WHERE ts < ?`);
    this.prunePoolSnapshotsStmt = this.db.prepare(`DELETE FROM hot_pool_snapshots WHERE ts < ?`);
    this.logger.info({ retainHours: params.trace.retain_hours }, "ticks recorder ready");
  }

  start(): void {
    // 影子模式可单独使用同步基线存储；关闭 trace 时不得启动旧轨迹的采样/清理定时器。
    if (!this.params.trace.enabled) return;
    const trace = this.params.trace;
    this.flushTimer = setInterval(() => this.flush(), trace.flush_ms);
    this.pruneTimer = setInterval(() => this.maintain(Date.now()), 60_000);
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flush();
  }

  note(entry: CacheEntry, now: number, pushed: boolean): void {
    if (!this.params.trace.enabled) return;
    const key = watchKey(entry.chain, entry.ca);
    if (!hotPoolLane(entry, this.params, now)) {
      this.watches.delete(key);
      this.cooled.delete(key);
      return;
    }
    const windowed = tradesInWindow(entry.trades, now, this.params.cache.evidence_ttl_sec);
    const hasVisiting = usableVisiting(entry, now, this.params.cache.evidence_ttl_sec) != null;
    const hasSmartmoney = windowed.length > 0;
    if (this.cooled.has(key)) {
      if (hasVisiting || hasSmartmoney) return;
      this.cooled.delete(key);
    }
    let watch = this.watches.get(key);
    if (!watch) {
      if (!shouldEnterWatch(hasVisiting, hasSmartmoney)) return;
      watch = {
        firstSeen: now,
        lastIncreaseAt: now,
        lastTickAt: 0,
        lastVisiting: null,
        lastEligible: -1,
        lastEligibleStrict: -1,
        lastBuy: -1,
        lastSell: -1,
        lastBuyUsd: -1,
        lastSellUsd: -1,
        lastMc: null,
      };
      this.watches.set(key, watch);
    }

    const snap = snapshotOf(entry, this.params, now, pushed);
    // 候选研究数据不受 tick 采样间隔限制，确保 security/L0 更新和被拒绝状态不丢失。
    this.enqueueCandidate(entry, snap, now);
    const interesting = isInterestingTick(watch, snap, this.params.trace.mc_change_pct);
    if (interesting) watch.lastIncreaseAt = now;
    if (shouldExpireWatch(watch, now, this.params.trace)) {
      this.enqueue(entry, watch, snap, now);
      this.watches.delete(key);
      this.cooled.add(key);
      return;
    }

    if (
      !shouldWriteTick({
        interesting,
        lastTickAt: watch.lastTickAt,
        now,
        minGapMs: this.params.trace.min_gap_ms,
      })
    ) {
      return;
    }

    this.enqueue(entry, watch, snap, now);
  }

  /** 只记录各阶段决策状态变化，既保留真实漏斗，也避免轮询产生重复事件。 */
  noteDecision(record: DecisionRecord): void {
    if (!this.params.trace.enabled) return;
    const stateKey = `${record.entry.chain}:${record.entry.ca}:${record.stage}`;
    const fingerprint = `${record.decision}:${record.reason}:${record.quota_skipped ? 1 : 0}`;
    if (this.decisionStates.get(stateKey)?.fingerprint === fingerprint) return;
    const entry = record.entry;
    const now = record.ts;
    const strategy = strategyFor(this.params, entry.chain);
    const sides = lastSides(
      entry.trades,
      now,
      this.params.cache.evidence_ttl_sec,
      strategy.flow.min_price_change_since_entry,
    );
    const tape = usableTape1m(entry, now, this.params.cache.evidence_ttl_sec) ?? {};
    const l0 = usableL0(entry, now, this.params.cache.evidence_ttl_sec);
    const lane = hotPoolLane(entry, this.params, now);
    try {
      this.insertDecision.run({
        ts: now,
        rule_version: this.params.rules.version,
        chain: entry.chain,
        ca: entry.ca,
        stage: record.stage,
        decision: record.decision,
        reason: record.reason,
        quota_skipped: record.quota_skipped ? 1 : 0,
        eligible: sides.eligible,
        eligible_strict: sides.eligible_strict,
        buy_wallets: sides.buyWallets,
        sell_wallets: sides.sellWallets,
        buy_usd: sides.buyUsd,
        sell_usd: sides.sellUsd,
        has_usd: sides.hasUsd ? 1 : 0,
        visiting: usableVisiting(entry, now, this.params.cache.evidence_ttl_sec) ?? null,
        volume: tape.volume ?? null,
        swaps: tape.swaps ?? null,
        buys: tape.buys ?? null,
        sells: tape.sells ?? null,
        pc_1m: tape.price_change_1m ?? null,
        pc_5m: strategy.hot_pool.enabled
          ? (hotPoolPrice5m(entry, this.params, now) ?? null)
          : (usablePriceChange5m(entry, now, this.params.cache.evidence_ttl_sec) ?? null),
        mc: usableMarketCap(entry, now, this.params.cache.evidence_ttl_sec) ?? null,
        liquidity: usableLiquidity(entry, now, this.params.cache.evidence_ttl_sec) ?? null,
        l0_json: JSON.stringify(l0),
        shadow_json: JSON.stringify(shadowRiskSnapshot(l0)),
        hot_pool_lane: lane ?? null,
        momentum_tier:
          tape.price_change_1m == null
            ? null
            : momentumTier(tape.price_change_1m, this.params, entry.chain),
        rank_1m: isFreshRank1m(entry, this.params, now) ? (entry.rank_1m ?? null) : null,
        rank_5m: isFreshRank5m(entry, this.params, now) ? (entry.rank_5m ?? null) : null,
        rank_1m_seen_at: entry.rank_1m_seen_at ?? null,
        rank_5m_seen_at: entry.rank_5m_seen_at ?? null,
        created_at: entry.created_at ?? null,
      });
      this.decisionStates.set(stateKey, { fingerprint, ts: now });
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : "decision_insert_failed" },
        "decision event insert failed",
      );
    }
  }

  notePoolSnapshot(cache: TokenCache, chain: Chain, now: number): void {
    const strategy = strategyFor(this.params, chain);
    if (!this.params.trace.enabled || !strategy.hot_pool.enabled) return;
    let rank1 = 0;
    let rank5 = 0;
    let candidates = 0;
    let smartmoney = 0;
    let eligible2 = 0;
    for (const entry of cache.entries(chain)) {
      if (isFreshRank1m(entry, this.params, now)) rank1 += 1;
      if (isFreshRank5m(entry, this.params, now)) rank5 += 1;
      if (!hotPoolLane(entry, this.params, now)) continue;
      candidates += 1;
      const windowed = tradesInWindow(
        entry.trades,
        now,
        this.params.cache.evidence_ttl_sec,
      );
      if (windowed.length > 0) smartmoney += 1;
      if (
        lastSides(
          entry.trades,
          now,
          this.params.cache.evidence_ttl_sec,
          strategy.flow.min_price_change_since_entry,
        ).eligible >= strategy.flow.min_smart_wallets
      ) {
        eligible2 += 1;
      }
    }
    try {
      this.insertPoolSnapshot.run({
        ts: now,
        rule_version: this.params.rules.version,
        chain,
        rank_1m_count: rank1,
        rank_5m_count: rank5,
        candidate_count: candidates,
        smartmoney_count: smartmoney,
        eligible_2_count: eligible2,
      });
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : "hot_pool_snapshot_failed", chain },
        "hot pool snapshot insert failed",
      );
    }
  }

  hasShadowSignal(ruleVersion: string, chain: Chain, ca: string): boolean {
    return this.hasShadowSignalStmt.get(ruleVersion, chain, ca) != null;
  }

  /** 影子样本只保留同一规则版本的第一次完整过线基线。 */
  noteShadowSignal(signal: Signal): boolean {
    const ev = signal.evidence;
    if (ev.visiting_count == null || !Number.isFinite(ev.visiting_count)) return false;
    try {
      const result = this.insertShadowSignal.run({
        rule_version: signal.rule_version,
        chain: signal.chain,
        ca: signal.ca,
        ts: signal.ts,
        symbol: signal.symbol || null,
        pass_kind: ev.pass_kind ?? null,
        hot_pool_lane: ev.hot_pool_lane ?? null,
        momentum_tier: ev.momentum_tier ?? null,
        visiting: ev.visiting_count,
        volume: ev.volume ?? null,
        swaps: ev.swaps ?? null,
        buys: ev.buys ?? null,
        sells: ev.sells ?? null,
        pc_1m: ev.price_change_1m ?? null,
        pc_5m: ev.price_change_5m ?? null,
        mc: ev.market_cap ?? null,
        liquidity: ev.liquidity ?? null,
        smart_wallets: ev.smart_wallets,
        buy_wallets: ev.buy_wallets,
        sell_wallets: ev.sell_wallets,
        buy_usd: ev.buy_usd ?? null,
        sell_usd: ev.sell_usd ?? null,
        rank_1m: ev.rank_1m ?? null,
        rank_5m: ev.rank_5m ?? null,
        created_at: ev.created_at ?? null,
        l0_json: JSON.stringify(signal.l0),
      });
      return result.changes === 1 || this.hasShadowSignal(signal.rule_version, signal.chain, signal.ca);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : "shadow_signal_insert_failed" },
        "shadow signal insert failed",
      );
      return false;
    }
  }

  flush(): void {
    if (this.buffer.length === 0 && this.candidateBuffer.length === 0) return;
    const rows = this.buffer;
    const candidates = this.candidateBuffer;
    this.buffer = [];
    this.candidateBuffer = [];
    const run = this.db.transaction((batch: {
      ticks: BufferedTick[];
      candidates: BufferedCandidate[];
    }) => {
      for (const row of batch.ticks) this.insert.run(row);
      for (const candidate of batch.candidates) this.upsertCandidate.run(candidate);
    });
    try {
      run({ ticks: rows, candidates });
    } catch (err) {
      const merged = rows.concat(this.buffer);
      this.buffer = merged.length > MAX_BUFFER ? merged.slice(-MAX_BUFFER) : merged;
      const mergedCandidates = candidates.concat(this.candidateBuffer);
      this.candidateBuffer =
        mergedCandidates.length > MAX_BUFFER
          ? mergedCandidates.slice(-MAX_BUFFER)
          : mergedCandidates;
      this.logger.warn(
        { err: err instanceof Error ? err.message : "ticks_flush_failed", n: rows.length },
        "ticks flush failed",
      );
    }
  }

  maintain(now: number): void {
    for (const [key, watch] of this.watches) {
      if (shouldExpireWatch(watch, now, this.params.trace)) {
        this.watches.delete(key);
        this.cooled.add(key);
      }
    }
    const cutoff = now - this.params.trace.retain_hours * 3600 * 1000;
    for (const [key, state] of this.decisionStates) {
      if (state.ts < cutoff) this.decisionStates.delete(key);
    }
    try {
      this.pruneStmt.run(cutoff);
      this.pruneDecisionsStmt.run(cutoff);
      this.prunePoolSnapshotsStmt.run(cutoff);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : "ticks_prune_failed" },
        "ticks prune failed",
      );
    }
  }

  /** 测试用：热路径只入队，不在 note 里刷盘。 */
  bufferedCount(): number {
    return this.buffer.length;
  }

  private enqueue(entry: CacheEntry, watch: WatchState, snap: TickSnapshot, now: number): void {
    this.buffer.push({ ts: now, chain: entry.chain, ca: entry.ca, ...snap });
    watch.lastTickAt = now;
    watch.lastVisiting = snap.visiting;
    watch.lastEligible = snap.eligible;
    watch.lastEligibleStrict = snap.eligible_strict;
    watch.lastBuy = snap.buy_wallets;
    watch.lastSell = snap.sell_wallets;
    watch.lastBuyUsd = snap.buy_usd;
    watch.lastSellUsd = snap.sell_usd;
    watch.lastMc = snap.mc;
  }

  private enqueueCandidate(entry: CacheEntry, snap: TickSnapshot, now: number): void {
    const strategy = strategyFor(this.params, entry.chain);
    this.candidateBuffer.push({
      ts: now,
      chain: entry.chain,
      ca: entry.ca,
      symbol: entry.symbol ?? null,
      mc: snap.mc,
      eligible: snap.eligible,
      buy_usd: snap.buy_usd,
      sell_usd: snap.sell_usd,
      visiting: snap.visiting,
      volume: snap.volume,
      pc_1m: snap.pc_1m,
      liquidity: usableLiquidity(entry, now, this.params.cache.evidence_ttl_sec) ?? null,
      l0_json: JSON.stringify(
        usableL0(entry, now, this.params.cache.evidence_ttl_sec),
      ),
      pushed: snap.pushed,
      rule_version: this.params.rules.version,
      has_usd: lastSides(
        entry.trades,
        now,
        this.params.cache.evidence_ttl_sec,
        strategy.flow.min_price_change_since_entry,
      ).hasUsd
        ? 1
        : 0,
      pc_5m: strategy.hot_pool.enabled
        ? (hotPoolPrice5m(entry, this.params, now) ?? null)
        : (usablePriceChange5m(entry, now, this.params.cache.evidence_ttl_sec) ?? null),
      hot_pool_lane: hotPoolLane(entry, this.params, now) ?? null,
      momentum_tier:
        snap.pc_1m == null
          ? null
          : momentumTier(snap.pc_1m, this.params, entry.chain),
      rank_1m: isFreshRank1m(entry, this.params, now) ? (entry.rank_1m ?? null) : null,
      rank_5m: isFreshRank5m(entry, this.params, now) ? (entry.rank_5m ?? null) : null,
      rank_1m_seen_at: entry.rank_1m_seen_at ?? null,
      rank_5m_seen_at: entry.rank_5m_seen_at ?? null,
      created_at: entry.created_at ?? null,
    });
  }
}
