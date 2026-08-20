import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { resetAnalyticsOnce } from "../src/reset.ts";

test("analytics reset is transactional, idempotent, and preserves pushed ledger", () => {
  const db = new Database(":memory:");
  for (const table of [
    "signals",
    "ticks",
    "candidates",
    "decision_events",
    "hot_pool_snapshots",
  ]) {
    db.exec(`CREATE TABLE ${table} (id INTEGER)`);
    db.exec(`INSERT INTO ${table} (id) VALUES (1)`);
  }
  db.exec(`CREATE TABLE pushed (id INTEGER)`);
  db.exec(`INSERT INTO pushed (id) VALUES (1)`);

  const first = resetAnalyticsOnce(db, "reset-v4", "v4", 123);
  assert.equal(first.applied, true);
  assert.deepEqual(first.deleted, {
    signals: 1,
    ticks: 1,
    candidates: 1,
    decision_events: 1,
    hot_pool_snapshots: 1,
  });
  for (const table of Object.keys(first.deleted)) {
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      0,
    );
  }
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM pushed`).get() as { n: number }).n, 1);

  db.exec(`INSERT INTO signals (id) VALUES (2)`);
  const second = resetAnalyticsOnce(db, "reset-v4", "v4", 456);
  assert.deepEqual(second, { applied: false, deleted: {} });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM signals`).get() as { n: number }).n, 1);
  db.close();
});
