import type Database from "better-sqlite3";
import type { Chain } from "./types.js";

function rowKey(chain: Chain, ca: string, chatId: string): string {
  return `${chain}:${ca}:${chatId}`;
}

function isRecent(ts: number | undefined, now: number, cooldownSec: number): boolean {
  return ts != null && ts > now - cooldownSec * 1000;
}

/** 按目的地保存最近成功时间；冷却结束后允许同一 chain+CA 再次发送。 */
export class PushedLedger {
  private readonly latest = new Map<string, number>();

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
    for (const row of this.db.prepare(`SELECT chain, ca, chat_id, ts FROM pushed`).all() as Array<{
      chain: Chain;
      ca: string;
      chat_id: string;
      ts: number;
    }>) {
      this.remember(row.chain, row.ca, row.chat_id, row.ts);
    }
  }

  hasAll(chain: Chain, ca: string, now: number, cooldownSec: number): boolean {
    if (this.destIds.length === 0) return false;
    return this.destIds.every((id) =>
      isRecent(this.latest.get(rowKey(chain, ca, id)), now, cooldownSec),
    );
  }

  hasAny(chain: Chain, ca: string, now: number, cooldownSec: number): boolean {
    return this.destIds.some((id) =>
      isRecent(this.latest.get(rowKey(chain, ca, id)), now, cooldownSec),
    );
  }

  pendingDests(chain: Chain, ca: string, now: number, cooldownSec: number): string[] {
    return this.destIds.filter(
      (id) => !isRecent(this.latest.get(rowKey(chain, ca, id)), now, cooldownSec),
    );
  }

  markDest(chain: Chain, ca: string, chatId: string, ts: number): void {
    const k = rowKey(chain, ca, chatId);
    const previous = this.latest.get(k);
    if (previous != null && previous >= ts) return;
    this.db
      .prepare(
        `INSERT INTO pushed (chain, ca, chat_id, ts)
         VALUES (@chain, @ca, @chat_id, @ts)
         ON CONFLICT(chain, ca, chat_id) DO UPDATE SET ts = excluded.ts
         WHERE excluded.ts > pushed.ts`,
      )
      .run({ chain, ca, chat_id: chatId, ts });
    // 先落盘再更新内存；SQLite 失败时不能误进入一小时冷却。
    this.remember(chain, ca, chatId, ts);
  }

  private remember(chain: Chain, ca: string, chatId: string, ts: number): void {
    this.latest.set(rowKey(chain, ca, chatId), ts);
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

}
