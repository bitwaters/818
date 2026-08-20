import type Database from "better-sqlite3";
import { tradesInWindow, usableMarketCap, usableVisiting } from "./cache.js";
import type { Logger } from "./logger.js";
import type { Params } from "./params.js";
import { lastSides } from "./pass.js";
import type { CacheEntry, Chain } from "./types.js";

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
  const sides = lastSides(
    entry.trades,
    now,
    params.cache.evidence_ttl_sec,
    params.flow.min_price_change_since_entry,
  );
  const tape = entry.tape ?? {};
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

function ensureTicksColumn(db: Database.Database, name: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(ticks)`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === name)) return;
  db.exec(`ALTER TABLE ticks ADD COLUMN ${name} ${ddl}`);
}

export class TickRecorder {
  private readonly watches = new Map<string, WatchState>();
  private readonly cooled = new Set<string>();
  private buffer: BufferedTick[] = [];
  private candidateBuffer: BufferedCandidate[] = [];
  private readonly insert;
  private readonly upsertCandidate;
  private readonly pruneStmt;
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
    ensureTicksColumn(this.db, "buys", "INTEGER");
    ensureTicksColumn(this.db, "sells", "INTEGER");
    ensureTicksColumn(this.db, "buy_usd", "REAL");
    ensureTicksColumn(this.db, "sell_usd", "REAL");
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
        PRIMARY KEY (chain, ca)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ticks_ca_ts ON ticks (chain, ca, ts)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ticks_ts ON ticks (ts)`);
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
        buy_usd, sell_usd, visiting, volume, pc_1m, liquidity, l0_json, pushed
      ) VALUES (
        @chain, @ca, @ts, @ts, @symbol, @mc, @mc, @eligible,
        @buy_usd, @sell_usd, @visiting, @volume, @pc_1m, @liquidity, @l0_json, @pushed
      )
      ON CONFLICT(chain, ca) DO UPDATE SET
        last_seen = excluded.last_seen,
        symbol = COALESCE(NULLIF(excluded.symbol, ''), candidates.symbol),
        first_mc = COALESCE(candidates.first_mc, excluded.first_mc),
        max_mc = CASE
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
        l0_json = CASE
          WHEN excluded.l0_json = '{}' THEN candidates.l0_json
          ELSE excluded.l0_json
        END,
        pushed = MAX(candidates.pushed, excluded.pushed)
    `);
    this.pruneStmt = this.db.prepare(`DELETE FROM ticks WHERE ts < ?`);
    this.logger.info({ retainHours: params.trace.retain_hours }, "ticks recorder ready");
  }

  start(): void {
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
    const windowed = tradesInWindow(entry.trades, now, this.params.cache.evidence_ttl_sec);
    const hasVisiting = usableVisiting(entry, now, this.params.cache.evidence_ttl_sec) != null;
    const hasSmartmoney = windowed.length > 0;
    const key = watchKey(entry.chain, entry.ca);
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
    try {
      this.pruneStmt.run(cutoff);
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
      liquidity: entry.liquidity ?? null,
      l0_json: JSON.stringify(entry.l0),
      pushed: snap.pushed,
    });
  }
}
