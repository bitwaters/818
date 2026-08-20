import type Database from "better-sqlite3";
import { TokenCache, usableMarketCap } from "./cache.js";
import type { Logger } from "./logger.js";
import type { Params } from "./params.js";
import {
  renderDailySummary,
  renderHourlySummary,
  renderMilestoneCard,
  type PerformanceSummary,
  type ReportToken,
} from "./push/cards.js";
import type { TelegramSender } from "./push/telegram.js";
import { SnapshotQuota } from "./quota.js";
import { dateKey, previousCompleteHourWindow, shiftDateKey } from "./time.js";
import type { Chain, PassKind, Signal } from "./types.js";

export interface SignalRow {
  id: number;
  chain: Chain;
  ca: string;
  symbol: string;
  ts: number;
  entry_mc: number;
  max_mc: number;
  last_milestone: number;
  milestone_config: string;
  calib_mc: number | null;
  pass_kind: PassKind | null;
  eligible: number | null;
  eligible_strict: number | null;
  buy_wallets: number | null;
  sell_wallets: number | null;
  buy_usd: number | null;
  sell_usd: number | null;
  visiting: number | null;
  volume: number | null;
  swaps: number | null;
  buys: number | null;
  sells: number | null;
  pc_1m: number | null;
  pc_5m: number | null;
  liquidity: number | null;
  l0_json: string | null;
  rule_version: string;
  has_usd: number | null;
  hot_pool_lane: string | null;
  momentum_tier: string | null;
  rank_1m: number | null;
  rank_5m: number | null;
  rank_1m_seen_at: number | null;
  rank_5m_seen_at: number | null;
  created_at: number | null;
  current_mc: number | null;
  min_mc: number | null;
  last_snapshot_at: number | null;
  next_snapshot_at: number | null;
  snapshot_failures: number;
  hit_1_2_at: number | null;
  hit_1_5_at: number | null;
  hit_2_at: number | null;
  drop_20_at: number | null;
  drop_50_at: number | null;
  mc_5m: number | null;
  mc_10m: number | null;
  mc_30m: number | null;
  mc_1h: number | null;
}

const REPLAY_COLUMNS: Array<[string, string]> = [
  ["pass_kind", "TEXT"],
  ["eligible", "INTEGER"],
  ["eligible_strict", "INTEGER"],
  ["buy_wallets", "INTEGER"],
  ["sell_wallets", "INTEGER"],
  ["buy_usd", "REAL"],
  ["sell_usd", "REAL"],
  ["visiting", "INTEGER"],
  ["volume", "REAL"],
  ["swaps", "INTEGER"],
  ["buys", "INTEGER"],
  ["sells", "INTEGER"],
  ["pc_1m", "REAL"],
  ["pc_5m", "REAL"],
  ["liquidity", "REAL"],
  ["l0_json", "TEXT"],
  ["rule_version", "TEXT NOT NULL DEFAULT 'legacy'"],
  ["has_usd", "INTEGER"],
  ["hot_pool_lane", "TEXT"],
  ["momentum_tier", "TEXT"],
  ["rank_1m", "INTEGER"],
  ["rank_5m", "INTEGER"],
  ["rank_1m_seen_at", "INTEGER"],
  ["rank_5m_seen_at", "INTEGER"],
  ["created_at", "INTEGER"],
  ["current_mc", "REAL"],
  ["min_mc", "REAL"],
  ["last_snapshot_at", "INTEGER"],
  ["next_snapshot_at", "INTEGER"],
  ["snapshot_failures", "INTEGER NOT NULL DEFAULT 0"],
  ["hit_1_2_at", "INTEGER"],
  ["hit_1_5_at", "INTEGER"],
  ["hit_2_at", "INTEGER"],
  ["drop_20_at", "INTEGER"],
  ["drop_50_at", "INTEGER"],
  ["mc_5m", "REAL"],
  ["mc_10m", "REAL"],
  ["mc_30m", "REAL"],
  ["mc_1h", "REAL"],
  ["milestone_config", "TEXT NOT NULL DEFAULT ''"],
];

function ensureReplayColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(signals)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, type] of REPLAY_COLUMNS) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE signals ADD COLUMN ${name} ${type}`);
  }
}

function migrateMilestoneConfig(db: Database.Database, tiers: number[]): number {
  const config = JSON.stringify(tiers);
  const rows = db
    .prepare(
      `SELECT id, entry_mc, max_mc FROM signals
       WHERE milestone_config IS NULL OR milestone_config != ?`,
    )
    .all(config) as Array<{ id: number; entry_mc: number; max_mc: number }>;
  if (rows.length === 0) return 0;
  const update = db.prepare(
    `UPDATE signals SET last_milestone = ?, milestone_config = ? WHERE id = ?`,
  );
  db.transaction(() => {
    for (const row of rows) {
      update.run(reachedMilestoneCount(row.max_mc / row.entry_mc, tiers), config, row.id);
    }
  })();
  return rows.length;
}

export function impliedMc(entryMc: number, infoMc: number, calibMc: number): number {
  return entryMc * (infoMc / calibMc);
}

export function reachedMilestoneCount(multiple: number, tiers: number[]): number {
  let count = 0;
  for (const tier of tiers) {
    if (multiple < tier) break;
    count += 1;
  }
  return count;
}

export function snapshotDelayMs(signalTs: number, now: number): number {
  const age = Math.max(0, now - signalTs);
  if (age < 30 * 60_000) return 60_000;
  if (age < 2 * 3_600_000) return 5 * 60_000;
  return 30 * 60_000;
}

export function tokenInfoMarketCap(data: unknown): number | null {
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

export class StatsStore {
  constructor(
    private readonly params: Params,
    private readonly logger: Logger,
    private readonly db: Database.Database,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        symbol TEXT,
        ts INTEGER NOT NULL,
        entry_mc REAL NOT NULL,
        max_mc REAL NOT NULL,
        last_milestone INTEGER NOT NULL DEFAULT 0,
        milestone_config TEXT NOT NULL DEFAULT '',
        calib_mc REAL
      )
    `);
    ensureReplayColumns(this.db);
    const migratedMilestones = migrateMilestoneConfig(
      this.db,
      this.params.stats.milestone_multiples,
    );
    this.logger.info(
      { replay: REPLAY_COLUMNS.map(([name]) => name), migratedMilestones },
      "signals replay columns ready",
    );
  }

  hasRow(chain: Chain, ca: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM signals WHERE chain = ? AND ca = ? LIMIT 1`)
      .get(chain, ca) as { ok: number } | undefined;
    return row != null;
  }

  insert(signal: Signal): boolean {
    const ev = signal.evidence;
    const mc = ev.market_cap;
    if (mc == null || !(mc > 0)) return false;
    if (this.hasRow(signal.chain, signal.ca)) return false;
    this.db
      .prepare(
        `INSERT INTO signals (
           chain, ca, symbol, ts, entry_mc, max_mc, last_milestone, milestone_config, calib_mc,
           pass_kind, eligible, eligible_strict, buy_wallets, sell_wallets,
           buy_usd, sell_usd, visiting, volume, swaps, buys, sells, pc_1m, pc_5m, liquidity,
           l0_json, rule_version, has_usd, hot_pool_lane, momentum_tier, rank_1m, rank_5m,
           rank_1m_seen_at, rank_5m_seen_at, created_at,
           current_mc, min_mc, next_snapshot_at
         ) VALUES (
           @chain, @ca, @symbol, @ts, @entry_mc, @max_mc, 0, @milestone_config, NULL,
           @pass_kind, @eligible, @eligible_strict, @buy_wallets, @sell_wallets,
           @buy_usd, @sell_usd, @visiting, @volume, @swaps, @buys, @sells, @pc_1m, @pc_5m,
           @liquidity, @l0_json, @rule_version, @has_usd, @hot_pool_lane, @momentum_tier,
           @rank_1m, @rank_5m, @rank_1m_seen_at, @rank_5m_seen_at, @created_at,
           @entry_mc, @entry_mc, @ts
         )`,
      )
      .run({
        chain: signal.chain,
        ca: signal.ca,
        symbol: signal.symbol,
        ts: signal.ts,
        entry_mc: mc,
        max_mc: mc,
        milestone_config: JSON.stringify(this.params.stats.milestone_multiples),
        pass_kind: ev.pass_kind ?? null,
        eligible: ev.smart_wallets,
        eligible_strict: ev.eligible_strict,
        buy_wallets: ev.buy_wallets,
        sell_wallets: ev.sell_wallets,
        buy_usd: ev.buy_usd ?? null,
        sell_usd: ev.sell_usd ?? null,
        visiting: ev.visiting_count ?? null,
        volume: ev.volume ?? null,
        swaps: ev.swaps ?? null,
        buys: ev.buys ?? null,
        sells: ev.sells ?? null,
        pc_1m: ev.price_change_1m ?? null,
        pc_5m: ev.price_change_5m ?? null,
        liquidity: ev.liquidity ?? null,
        l0_json: JSON.stringify(signal.l0),
        // 兼容内部旧调用方/历史测试；生产 buildSignal 始终显式写入版本。
        rule_version: signal.rule_version || this.params.rules.version,
        has_usd: ev.has_usd == null ? null : ev.has_usd ? 1 : 0,
        hot_pool_lane: ev.hot_pool_lane ?? null,
        momentum_tier: ev.momentum_tier ?? null,
        rank_1m: ev.rank_1m ?? null,
        rank_5m: ev.rank_5m ?? null,
        rank_1m_seen_at: ev.rank_1m_seen_at ?? null,
        rank_5m_seen_at: ev.rank_5m_seen_at ?? null,
        created_at: ev.created_at ?? null,
      });
    return true;
  }

  insertIfAbsent(signal: Signal): boolean {
    try {
      return this.insert(signal);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : "insert_failed", chain: signal.chain },
        "signals insert failed",
      );
      return false;
    }
  }

  activeRows(now: number): SignalRow[] {
    const cutoff = now - this.params.stats.track_hours * 3600 * 1000;
    return this.db.prepare(`SELECT * FROM signals WHERE ts >= ?`).all(cutoff) as SignalRow[];
  }

  dueRows(now: number): SignalRow[] {
    const cutoff = now - this.params.stats.track_hours * 3600 * 1000;
    return this.db
      .prepare(
        `SELECT * FROM signals
         WHERE ts >= ? AND (next_snapshot_at IS NULL OR next_snapshot_at <= ?)
         ORDER BY
           CASE WHEN rule_version = ? THEN 0 ELSE 1 END,
           CASE WHEN calib_mc IS NULL THEN 0 ELSE 1 END,
           COALESCE(last_snapshot_at, 0),
           ts DESC`,
      )
      .all(cutoff, now, this.params.rules.version) as SignalRow[];
  }

  rowsInDateKeys(keys: string[], timeZone: string): SignalRow[] {
    const all = this.db
      .prepare(`SELECT * FROM signals WHERE rule_version = ?`)
      .all(this.params.rules.version) as SignalRow[];
    const set = new Set(keys);
    return all.filter((row) => set.has(dateKey(row.ts, timeZone)));
  }

  rowsInRange(start: number, end: number): SignalRow[] {
    return this.db
      .prepare(
        `SELECT * FROM signals
         WHERE rule_version = ? AND ts >= ? AND ts < ?
         ORDER BY ts ASC`,
      )
      .all(this.params.rules.version, start, end) as SignalRow[];
  }

  markCalibrated(row: SignalRow, calibMc: number, now: number): void {
    this.db
      .prepare(
        `UPDATE signals SET calib_mc = ?, last_snapshot_at = ?, next_snapshot_at = ?,
          snapshot_failures = 0 WHERE id = ?`,
      )
      .run(calibMc, now, now + snapshotDelayMs(row.ts, now), row.id);
  }

  markSnapshotFailure(row: SignalRow, now: number): void {
    const failures = row.snapshot_failures + 1;
    const retryMs = Math.min(5 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 3));
    this.db
      .prepare(
        `UPDATE signals SET last_snapshot_at = ?, next_snapshot_at = ?,
          snapshot_failures = ? WHERE id = ?`,
      )
      .run(now, now + retryMs, failures, row.id);
  }

  recordObservation(
    row: SignalRow,
    observed: number,
    now: number,
  ): { maxMc: number; maxIncreased: boolean } {
    const maxMc = Math.max(row.max_mc, observed);
    const minMc = Math.min(row.min_mc ?? row.entry_mc, observed);
    const multiple = observed / row.entry_mc;
    const age = now - row.ts;
    this.db
      .prepare(
        `UPDATE signals SET
          current_mc = @current_mc,
          max_mc = @max_mc,
          min_mc = @min_mc,
          last_snapshot_at = @now,
          next_snapshot_at = @next_snapshot_at,
          snapshot_failures = 0,
          hit_1_2_at = COALESCE(hit_1_2_at, @hit_1_2_at),
          hit_1_5_at = COALESCE(hit_1_5_at, @hit_1_5_at),
          hit_2_at = COALESCE(hit_2_at, @hit_2_at),
          drop_20_at = COALESCE(drop_20_at, @drop_20_at),
          drop_50_at = COALESCE(drop_50_at, @drop_50_at),
          mc_5m = COALESCE(mc_5m, @mc_5m),
          mc_10m = COALESCE(mc_10m, @mc_10m),
          mc_30m = COALESCE(mc_30m, @mc_30m),
          mc_1h = COALESCE(mc_1h, @mc_1h)
        WHERE id = @id`,
      )
      .run({
        id: row.id,
        current_mc: observed,
        max_mc: maxMc,
        min_mc: minMc,
        now,
        next_snapshot_at: now + snapshotDelayMs(row.ts, now),
        hit_1_2_at: multiple >= 1.2 ? now : null,
        hit_1_5_at: multiple >= 1.5 ? now : null,
        hit_2_at: multiple >= 2 ? now : null,
        drop_20_at: multiple <= 0.8 ? now : null,
        drop_50_at: multiple <= 0.5 ? now : null,
        mc_5m: age >= 5 * 60_000 ? observed : null,
        mc_10m: age >= 10 * 60_000 ? observed : null,
        mc_30m: age >= 30 * 60_000 ? observed : null,
        mc_1h: age >= 60 * 60_000 ? observed : null,
      });
    return { maxMc, maxIncreased: maxMc > row.max_mc };
  }

  updateMilestone(id: number, k: number): void {
    this.db.prepare(`UPDATE signals SET last_milestone = ? WHERE id = ?`).run(k, id);
  }

  close(): void {
    // 连接由调用方 close，避免与 PushedLedger 双关
  }
}

export async function runSnapshot(opts: {
  store: StatsStore;
  params: Params;
  cache: TokenCache;
  telegram: TelegramSender;
  fetchInfoMc: (chain: Chain, ca: string) => Promise<number | null>;
  now: number;
}): Promise<{ missed: number; updated: number }> {
  const quota = new SnapshotQuota(opts.params.quota.snapshot_per_round);
  let missed = 0;
  let updated = 0;
  for (const row of opts.store.dueRows(opts.now)) {
    const entry = opts.cache.get(row.chain, row.ca);
    const cached = entry
      ? usableMarketCap(entry, opts.now, opts.params.cache.evidence_ttl_sec)
      : undefined;
    let observed: number | undefined;
    // 首次快照必须尽早建立 Token Info 基准；不能等离榜后再把暴跌后的价格当基准。
    if (row.calib_mc == null) {
      if (!quota.tryConsume(row.chain)) {
        if (cached != null) observed = cached;
        else {
          missed += 1;
          continue;
        }
      } else {
        const infoMc = await opts.fetchInfoMc(row.chain, row.ca);
        if (infoMc != null) {
          opts.store.markCalibrated(row, infoMc, opts.now);
          continue;
        }
        if (cached != null) observed = cached;
        else {
          opts.store.markSnapshotFailure(row, opts.now);
          missed += 1;
          continue;
        }
      }
    } else {
      observed = cached;
    }
    if (row.calib_mc != null && observed == null) {
      if (!quota.tryConsume(row.chain)) {
        missed += 1;
        continue;
      }
      const infoMc = await opts.fetchInfoMc(row.chain, row.ca);
      if (infoMc == null) {
        opts.store.markSnapshotFailure(row, opts.now);
        missed += 1;
        continue;
      }
      if (!(row.calib_mc > 0)) {
        opts.store.markSnapshotFailure(row, opts.now);
        missed += 1;
        continue;
      }
      observed = impliedMc(row.entry_mc, infoMc, row.calib_mc);
    }
    if (observed == null || !(observed > 0)) {
      opts.store.markSnapshotFailure(row, opts.now);
      missed += 1;
      continue;
    }
    const observation = opts.store.recordObservation(row, observed, opts.now);
    if (observation.maxIncreased) updated += 1;
    const multiple = observation.maxMc / row.entry_mc;
    const tiers = opts.params.stats.milestone_multiples;
    const reachedCount = reachedMilestoneCount(multiple, tiers);
    if (reachedCount > row.last_milestone) {
      const reachedTier = tiers[reachedCount - 1];
      if (reachedTier == null) continue;
      const html = renderMilestoneCard({
        signal: {
          chain: row.chain,
          ca: row.ca,
          symbol: row.symbol,
          ts: row.ts,
          rank1m: row.rank_1m,
          rank5m: row.rank_5m,
          visiting: row.visiting,
        },
        entryMc: row.entry_mc,
        currentMc: observed,
        maxMc: observation.maxMc,
        reachedTier,
        crossedTiers: tiers.slice(row.last_milestone, reachedCount),
        reachedAt: opts.now,
        timeZone: opts.params.stats.timezone,
        gmgnUrl: gmgnUrl(opts.params, row),
      });
      const sent = await opts.telegram.sendText(html);
      if (sent) opts.store.updateMilestone(row.id, reachedCount);
    }
  }
  return { missed, updated };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function gmgnUrl(params: Params, row: Pick<SignalRow, "chain" | "ca">): string {
  return params.push.gmgn_token_url[row.chain].replace("{ca}", encodeURIComponent(row.ca));
}

function reportToken(row: SignalRow, params: Params): ReportToken {
  const tracked = row.last_snapshot_at != null;
  return {
    id: row.id,
    chain: row.chain,
    ca: row.ca,
    symbol: row.symbol,
    entryMc: row.entry_mc,
    peakMultiple: tracked ? row.max_mc / row.entry_mc : null,
    currentMultiple: tracked && row.current_mc != null ? row.current_mc / row.entry_mc : null,
    gmgnUrl: gmgnUrl(params, row),
  };
}

function byPeakDesc(a: ReportToken, b: ReportToken): number {
  return (b.peakMultiple ?? Number.NEGATIVE_INFINITY) -
    (a.peakMultiple ?? Number.NEGATIVE_INFINITY) || a.id - b.id;
}

function byCurrentAsc(a: ReportToken, b: ReportToken): number {
  return (a.currentMultiple ?? Number.POSITIVE_INFINITY) -
    (b.currentMultiple ?? Number.POSITIVE_INFINITY) || a.id - b.id;
}

export function summarizePerformance(
  rows: SignalRow[],
  params: Params,
  topLimit: number,
  bottomLimit: number,
): PerformanceSummary {
  const trackedRows = rows.filter((row) => row.last_snapshot_at != null);
  const peaks = trackedRows.map((row) => row.max_mc / row.entry_mc);
  const currents = trackedRows.map((row) => (row.current_mc ?? row.entry_mc) / row.entry_mc);
  const hitMultiple = params.stats.hit_multiple;
  const tokens = rows.map((row) => reportToken(row, params));
  const ranked = tokens.filter((token) => token.peakMultiple != null).sort(byPeakDesc);
  const top = ranked.slice(0, topLimit);
  const topIds = new Set(top.map((token) => token.id));
  const bottom = tokens
    .filter((token) => token.currentMultiple != null && !topIds.has(token.id))
    .sort(byCurrentAsc)
    .slice(0, bottomLimit);
  const shownIds = new Set([...top, ...bottom].map((token) => token.id));
  return {
    n: rows.length,
    tracked: trackedRows.length,
    hit: peaks.filter((multiple) => multiple >= hitMultiple).length,
    hitMultiple,
    medianPeak: median(peaks),
    medianCurrent: median(currents),
    drawdown: trackedRows.filter(
      (row) => (row.min_mc ?? row.entry_mc) / row.entry_mc <= 0.8,
    ).length,
    distribution: {
      x1_2: peaks.filter((multiple) => multiple >= 1.2).length,
      x1_5: peaks.filter((multiple) => multiple >= 1.5).length,
      x2: peaks.filter((multiple) => multiple >= 2).length,
    },
    all: tokens.sort(byPeakDesc),
    top,
    bottom,
    omitted: Math.max(0, rows.length - shownIds.size),
  };
}

export async function sendHourlySummary(opts: {
  store: StatsStore;
  params: Params;
  telegram: TelegramSender;
  now: number;
}): Promise<boolean> {
  const tz = opts.params.stats.timezone;
  const window = previousCompleteHourWindow(opts.now, tz);
  const rows = opts.store.rowsInRange(window.start, window.end);
  if (rows.length === 0) return false;
  const html = renderHourlySummary({
    hourLabel: window.label,
    summary: summarizePerformance(rows, opts.params, 5, 3),
  });
  return opts.telegram.sendText(html);
}

export async function sendDailySummary(opts: {
  store: StatsStore;
  params: Params;
  telegram: TelegramSender;
  now: number;
}): Promise<boolean> {
  const tz = opts.params.stats.timezone;
  const yesterday = shiftDateKey(dateKey(opts.now, tz), -1);
  const rows = opts.store.rowsInDateKeys([yesterday], tz);
  if (rows.length === 0) return false;
  const html = renderDailySummary({
    dateLabel: yesterday,
    summary: summarizePerformance(rows, opts.params, 10, 5),
  });
  return opts.telegram.sendText(html);
}
