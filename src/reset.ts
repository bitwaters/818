import type Database from "better-sqlite3";
import type { Logger } from "./logger.js";

const ANALYTICS_TABLES = [
  "signals",
  "ticks",
  "candidates",
  "decision_events",
  "hot_pool_snapshots",
] as const;

export interface ResetResult {
  applied: boolean;
  deleted: Record<string, number>;
}

/** 新推送策略启用时一次性清空旧去重账本，不改动 signals 的首次统计基准。 */
export function resetDeliveryOnce(
  db: Database.Database,
  resetId: string | undefined,
  ruleVersion: string,
  now: number,
  logger?: Logger,
): ResetResult {
  if (!resetId) return { applied: false, deleted: {} };
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_resets (
      reset_id TEXT PRIMARY KEY,
      rule_version TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      deleted_json TEXT NOT NULL
    )
  `);
  const exists = db
    .prepare(`SELECT 1 AS ok FROM delivery_resets WHERE reset_id = ?`)
    .get(resetId) as { ok: number } | undefined;
  if (exists) return { applied: false, deleted: {} };

  const deleted: Record<string, number> = {};
  const apply = db.transaction(() => {
    const pushedExists = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'pushed'`)
      .get() as { ok: number } | undefined;
    if (pushedExists) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM pushed`).get() as { n: number };
      db.prepare(`DELETE FROM pushed`).run();
      deleted.pushed = count.n;
    }
    db.prepare(
      `INSERT INTO delivery_resets (reset_id, rule_version, applied_at, deleted_json)
       VALUES (?, ?, ?, ?)`,
    ).run(resetId, ruleVersion, now, JSON.stringify(deleted));
  });
  apply();
  logger?.info({ resetId, ruleVersion, deleted }, "delivery ledger reset applied");
  return { applied: true, deleted };
}

/** 一次性清理研究/报表数据；永远不触碰 pushed，避免历史代币重复推送。 */
export function resetAnalyticsOnce(
  db: Database.Database,
  resetId: string | undefined,
  ruleVersion: string,
  now: number,
  logger?: Logger,
): ResetResult {
  if (!resetId) return { applied: false, deleted: {} };
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_resets (
      reset_id TEXT PRIMARY KEY,
      rule_version TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      deleted_json TEXT NOT NULL
    )
  `);
  const exists = db
    .prepare(`SELECT 1 AS ok FROM analytics_resets WHERE reset_id = ?`)
    .get(resetId) as { ok: number } | undefined;
  if (exists) return { applied: false, deleted: {} };

  const deleted: Record<string, number> = {};
  const apply = db.transaction(() => {
    for (const table of ANALYTICS_TABLES) {
      const tableExists = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { ok: number } | undefined;
      if (!tableExists) continue;
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      db.prepare(`DELETE FROM ${table}`).run();
      deleted[table] = count.n;
    }
    db.prepare(
      `INSERT INTO analytics_resets (reset_id, rule_version, applied_at, deleted_json)
       VALUES (?, ?, ?, ?)`,
    ).run(resetId, ruleVersion, now, JSON.stringify(deleted));
  });
  apply();
  logger?.info({ resetId, ruleVersion, deleted }, "analytics reset applied");
  return { applied: true, deleted };
}
