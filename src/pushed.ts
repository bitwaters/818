import type Database from "better-sqlite3";
import type { Chain } from "./types.js";

function rowKey(chain: Chain, ca: string, chatId: string): string {
  return `${chain}:${ca}:${chatId}`;
}

function anyKey(chain: Chain, ca: string): string {
  return `${chain}:${ca}`;
}

/** 按目的地终身去重：同一 chain+CA 只对尚未成功的 chat 补发。 */
export class PushedLedger {
  private readonly seen = new Set<string>();
  private readonly any = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly destIds: string[],
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pushed (
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (chain, ca, chat_id)
      )
    `);
    this.migrateLegacy();
    this.seedFromSignals();
    for (const row of this.db.prepare(`SELECT chain, ca, chat_id FROM pushed`).all() as Array<{
      chain: Chain;
      ca: string;
      chat_id: string;
    }>) {
      this.remember(row.chain, row.ca, row.chat_id);
    }
  }

  hasAll(chain: Chain, ca: string): boolean {
    if (this.destIds.length === 0) return this.any.has(anyKey(chain, ca));
    return this.destIds.every((id) => this.seen.has(rowKey(chain, ca, id)));
  }

  hasAny(chain: Chain, ca: string): boolean {
    return this.any.has(anyKey(chain, ca));
  }

  pendingDests(chain: Chain, ca: string): string[] {
    return this.destIds.filter((id) => !this.seen.has(rowKey(chain, ca, id)));
  }

  markDest(chain: Chain, ca: string, chatId: string, ts: number): void {
    const k = rowKey(chain, ca, chatId);
    if (this.seen.has(k)) return;
    this.remember(chain, ca, chatId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pushed (chain, ca, chat_id, ts) VALUES (@chain, @ca, @chat_id, @ts)`,
      )
      .run({ chain, ca, chat_id: chatId, ts });
  }

  private remember(chain: Chain, ca: string, chatId: string): void {
    this.seen.add(rowKey(chain, ca, chatId));
    this.any.add(anyKey(chain, ca));
  }

  private migrateLegacy(): void {
    const cols = this.db.prepare(`PRAGMA table_info(pushed)`).all() as Array<{ name: string }>;
    if (cols.length === 0) return;
    if (cols.some((c) => c.name === "chat_id")) return;
    this.db.exec(`ALTER TABLE pushed RENAME TO pushed_legacy`);
    this.db.exec(`
      CREATE TABLE pushed (
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (chain, ca, chat_id)
      )
    `);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO pushed (chain, ca, chat_id, ts) SELECT chain, ca, ?, ts FROM pushed_legacy`,
    );
    const expand = this.db.transaction(() => {
      const targets = this.destIds.length > 0 ? this.destIds : ["*"];
      for (const dest of targets) insert.run(dest);
      this.db.exec(`DROP TABLE pushed_legacy`);
    });
    expand();
  }

  private seedFromSignals(): void {
    const exists = this.db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'signals'`)
      .get() as { ok: number } | undefined;
    if (!exists || this.destIds.length === 0) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO pushed (chain, ca, chat_id, ts)
      SELECT chain, ca, ?, MIN(ts) FROM signals GROUP BY chain, ca
    `);
    const seed = this.db.transaction(() => {
      for (const dest of this.destIds) insert.run(dest);
    });
    seed();
  }
}
