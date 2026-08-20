import type Database from "better-sqlite3";
import { TokenCache, usableMarketCap } from "./cache.js";
import type { Logger } from "./logger.js";
import type { Params } from "./params.js";
import { renderDailySummary, renderHourlySummary, renderMilestoneCard } from "./push/cards.js";
import type { TelegramSender } from "./push/telegram.js";
import { SnapshotQuota } from "./quota.js";
import { dateKey, hourLabel, shiftDateKey } from "./time.js";
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

export function impliedMc(entryMc: number, infoMc: number, calibMc: number): number {
  return entryMc * (infoMc / calibMc);
}

export function milestoneK(multiple: number, step: number): number {
  if (step <= 0 || multiple < 1 + step) return 0;
  return Math.floor((multiple - 1) / step);
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
        calib_mc REAL
      )
    `);
    ensureReplayColumns(this.db);
    this.logger.info({ replay: REPLAY_COLUMNS.map(([name]) => name) }, "signals replay columns ready");
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
           chain, ca, symbol, ts, entry_mc, max_mc, last_milestone, calib_mc,
           pass_kind, eligible, eligible_strict, buy_wallets, sell_wallets,
           buy_usd, sell_usd, visiting, volume, swaps, buys, sells, pc_1m, pc_5m, liquidity,
           l0_json
         ) VALUES (
           @chain, @ca, @symbol, @ts, @entry_mc, @max_mc, 0, NULL,
           @pass_kind, @eligible, @eligible_strict, @buy_wallets, @sell_wallets,
           @buy_usd, @sell_usd, @visiting, @volume, @swaps, @buys, @sells, @pc_1m, @pc_5m,
           @liquidity, @l0_json
         )`,
      )
      .run({
        chain: signal.chain,
        ca: signal.ca,
        symbol: signal.symbol,
        ts: signal.ts,
        entry_mc: mc,
        max_mc: mc,
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
    return this.db
      .prepare(`SELECT * FROM signals WHERE ts >= ?`)
      .all(cutoff) as SignalRow[];
  }

  rowsInDateKeys(keys: string[], timeZone: string): SignalRow[] {
    const all = this.db.prepare(`SELECT * FROM signals`).all() as SignalRow[];
    const set = new Set(keys);
    return all.filter((row) => set.has(dateKey(row.ts, timeZone)));
  }

  updateMax(id: number, maxMc: number): void {
    this.db.prepare(`UPDATE signals SET max_mc = ? WHERE id = ?`).run(maxMc, id);
  }

  updateCalib(id: number, calibMc: number): void {
    this.db.prepare(`UPDATE signals SET calib_mc = ? WHERE id = ?`).run(calibMc, id);
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
  for (const row of opts.store.activeRows(opts.now)) {
    const entry = opts.cache.get(row.chain, row.ca);
    const cached = entry
      ? usableMarketCap(entry, opts.now, opts.params.cache.evidence_ttl_sec)
      : undefined;
    let observed: number | undefined = cached;
    let fromInfo = false;
    if (observed == null) {
      if (!quota.tryConsume(row.chain)) {
        missed += 1;
        continue;
      }
      const infoMc = await opts.fetchInfoMc(row.chain, row.ca);
      if (infoMc == null) {
        missed += 1;
        continue;
      }
      fromInfo = true;
      if (row.calib_mc == null) {
        opts.store.updateCalib(row.id, infoMc);
        continue;
      }
      observed = impliedMc(row.entry_mc, infoMc, row.calib_mc);
    }
    if (observed == null || !(observed > row.max_mc)) continue;
    opts.store.updateMax(row.id, observed);
    updated += 1;
    const multiple = observed / row.entry_mc;
    const k = milestoneK(multiple, opts.params.stats.milestone_step);
    if (k > row.last_milestone) {
      const html = renderMilestoneCard(
        { chain: row.chain, ca: row.ca, symbol: row.symbol },
        row.entry_mc,
        observed,
        k,
        opts.params.stats.milestone_step,
      );
      const sent = await opts.telegram.sendText(html);
      if (sent) opts.store.updateMilestone(row.id, k);
    }
    void fromInfo;
  }
  return { missed, updated };
}

function summarize(rows: SignalRow[], hitMultiple: number) {
  let hit = 0;
  let top: { multiple: number; symbol: string } | undefined;
  for (const row of rows) {
    const multiple = row.max_mc / row.entry_mc;
    if (multiple >= hitMultiple) hit += 1;
    if (!top || multiple > top.multiple) top = { multiple, symbol: row.symbol };
  }
  return { n: rows.length, hit, top };
}

export async function sendHourlySummary(opts: {
  store: StatsStore;
  params: Params;
  telegram: TelegramSender;
  now: number;
}): Promise<boolean> {
  const tz = opts.params.stats.timezone;
  const today = dateKey(opts.now, tz);
  const rows = opts.store.rowsInDateKeys([today], tz);
  if (rows.length === 0) return false;
  const { n, hit, top } = summarize(rows, opts.params.stats.hit_multiple);
  const html = renderHourlySummary({
    hourLabel: hourLabel(opts.now, tz),
    n,
    hit,
    hitMultiple: opts.params.stats.hit_multiple,
    top,
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
  const { n, hit, top } = summarize(rows, opts.params.stats.hit_multiple);
  const html = renderDailySummary({
    dateLabel: yesterday,
    n,
    hit,
    hitMultiple: opts.params.stats.hit_multiple,
    top,
  });
  return opts.telegram.sendText(html);
}
