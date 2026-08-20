import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { PushedLedger } from "../src/pushed.ts";

test("pushed ledger persists a one-hour per-destination cooldown and then allows resend", () => {
  const db = new Database(":memory:");
  const now = 1_700_000_000_000;
  const ca = "0x1111111111111111111111111111111111111111";
  const first = new PushedLedger(db, ["a", "b"]);
  first.markDest("bsc", ca, "a", now);

  assert.equal(first.hasAny("bsc", ca, now, 3600), true);
  assert.equal(first.hasAll("bsc", ca, now, 3600), false);
  assert.deepEqual(first.pendingDests("bsc", ca, now, 3600), ["b"]);
  first.markDest("bsc", ca, "b", now);
  assert.equal(first.hasAll("bsc", ca, now + 3_599_999, 3600), true);
  assert.deepEqual(first.pendingDests("bsc", ca, now + 3_600_000, 3600), ["a", "b"]);

  const afterRestart = new PushedLedger(db, ["a", "b"]);
  assert.equal(afterRestart.hasAll("bsc", ca, now + 1_000, 3600), true);
  afterRestart.markDest("bsc", ca, "a", now + 3_600_000);
  assert.equal(
    (db.prepare(`SELECT ts FROM pushed WHERE chat_id = ?`).get("a") as { ts: number }).ts,
    now + 3_600_000,
  );
  db.close();
});
