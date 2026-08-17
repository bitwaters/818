import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { TokenCache, usableMarketCap } from "./cache.js";
import type { Logger } from "./logger.js";
import type { Params } from "./params.js";
import { renderDailySummary, renderHourlySummary, renderMilestoneCard } from "./push/cards.js";
import type { TelegramSender } from "./push/telegram.js";
import { SnapshotQuota } from "./quota.js";
import { dateKey, hourLabel, shiftDateKey } from "./time.js";
import type { Chain, Signal } from "./types.js";

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
  private readonly db: Database.Database;

  constructor(
    private readonly params: Params,
    private readonly logger: Logger,
  ) {
    const path = params.stats.sqlite_path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
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
  }

  insert(signal: Signal): boolean {
    const mc = signal.evidence.market_cap;
    if (mc == null || !(mc > 0)) return false;
    this.db
      .prepare(
        `INSERT INTO signals (chain, ca, symbol, ts, entry_mc, max_mc, last_milestone, calib_mc)
         VALUES (@chain, @ca, @symbol, @ts, @entry_mc, @max_mc, 0, NULL)`,
      )
      .run({
        chain: signal.chain,
        ca: signal.ca,
        symbol: signal.symbol,
        ts: signal.ts,
        entry_mc: mc,
        max_mc: mc,
      });
    return true;
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
    this.db.close();
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
