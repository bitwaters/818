import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import pino from "pino";
import { TokenCache } from "../src/cache.ts";
import { runSnapshot, StatsStore, type SignalRow } from "../src/stats.ts";
import type { Signal } from "../src/types.ts";
import { FakeTelegram, testParams } from "./helpers.ts";

function signal(ruleVersion: string, ca: string, ts: number, mc = 1_000): Signal {
  return {
    rule_version: ruleVersion,
    chain: "bsc",
    ca,
    symbol: "T",
    ts,
    evidence: {
      smart_wallets: 2,
      eligible_strict: 2,
      buy_wallets: 2,
      sell_wallets: 0,
      buy_usd: 200,
      sell_usd: 0,
      has_usd: true,
      market_cap: mc,
    },
    l0: {},
    links: { gmgn: "https://gmgn.ai" },
  };
}

test("snapshot quota rotates fairly between current-rule uncalibrated signals", async () => {
  const db = new Database(":memory:");
  const params = testParams((p) => {
    p.rules.version = "fair-v1";
    p.quota.snapshot_per_round = { sol: 0, bsc: 1 };
  });
  const store = new StatsStore(params, pino({ level: "silent" }), db);
  const now = 1_700_000_000_000;
  const ca1 = "0x1111111111111111111111111111111111111111";
  const ca2 = "0x2222222222222222222222222222222222222222";
  store.insert(signal(params.rules.version, ca1, now - 2_000));
  store.insert(signal(params.rules.version, ca2, now - 1_000));
  const calls: string[] = [];
  const run = (at: number) =>
    runSnapshot({
      store,
      params,
      cache: new TokenCache(),
      telegram: new FakeTelegram(),
      fetchInfoMc: async (_chain, ca) => {
        calls.push(ca);
        return 1_000;
      },
      now: at,
    });

  await run(now);
  await run(now + 60_000);
  assert.deepEqual(calls, [ca2, ca1]);
  const calibrated = db
    .prepare(`SELECT COUNT(*) AS n FROM signals WHERE calib_mc IS NOT NULL`)
    .get() as { n: number };
  assert.equal(calibrated.n, 2);
  db.close();
});

test("observations store drawdown, hits, and time-bucket market caps", () => {
  const db = new Database(":memory:");
  const params = testParams((p) => {
    p.rules.version = "metrics-v1";
  });
  const store = new StatsStore(params, pino({ level: "silent" }), db);
  const ts = 1_700_000_000_000;
  const ca = "0x3333333333333333333333333333333333333333";
  store.insert(signal(params.rules.version, ca, ts));
  let row = db.prepare(`SELECT * FROM signals WHERE ca = ?`).get(ca) as SignalRow;
  store.recordObservation(row, 750, ts + 10 * 60_000);
  row = db.prepare(`SELECT * FROM signals WHERE ca = ?`).get(ca) as SignalRow;
  store.recordObservation(row, 1_600, ts + 31 * 60_000);
  const saved = db.prepare(`SELECT * FROM signals WHERE ca = ?`).get(ca) as SignalRow;
  assert.equal(saved.current_mc, 1_600);
  assert.equal(saved.min_mc, 750);
  assert.equal(saved.max_mc, 1_600);
  assert.equal(saved.drop_20_at, ts + 10 * 60_000);
  assert.equal(saved.hit_1_5_at, ts + 31 * 60_000);
  assert.equal(saved.mc_5m, 750);
  assert.equal(saved.mc_10m, 750);
  assert.equal(saved.mc_30m, 1_600);
  db.close();
});

test("repeat delivery keeps the first signal timestamp and entry market cap", () => {
  const db = new Database(":memory:");
  const params = testParams((p) => {
    p.rules.version = "repeat-v1";
  });
  const store = new StatsStore(params, pino({ level: "silent" }), db);
  const ca = "0x4444444444444444444444444444444444444444";
  assert.equal(store.insert(signal(params.rules.version, ca, 1_000, 10_000)), true);
  assert.equal(store.insert(signal(params.rules.version, ca, 3_601_000, 30_000)), false);
  const row = db.prepare(`SELECT ts, entry_mc FROM signals WHERE ca = ?`).get(ca) as {
    ts: number;
    entry_mc: number;
  };
  assert.deepEqual(row, { ts: 1_000, entry_mc: 10_000 });
  db.close();
});

test("legacy signals schema upgrades without destructive migration", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain TEXT NOT NULL,
      ca TEXT NOT NULL,
      symbol TEXT,
      ts INTEGER NOT NULL,
      entry_mc REAL NOT NULL,
      max_mc REAL NOT NULL,
      last_milestone INTEGER NOT NULL DEFAULT 0,
      calib_mc REAL
    );
    INSERT INTO signals (chain, ca, ts, entry_mc, max_mc) VALUES ('bsc', 'old', 1, 10, 10);
  `);
  const params = testParams();
  new StatsStore(params, pino({ level: "silent" }), db);
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(signals)`).all() as Array<{ name: string }>).map((x) => x.name),
  );
  assert.equal(cols.has("rule_version"), true);
  assert.equal(cols.has("current_mc"), true);
  assert.equal(cols.has("drop_20_at"), true);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM signals`).get() as { n: number }).n, 1);
  db.close();
});
