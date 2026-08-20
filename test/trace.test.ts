import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import pino from "pino";
import { TokenCache, usablePriceChange5m } from "../src/cache.js";
import { evaluatePass } from "../src/pass.js";
import {
  isCountIncrease,
  isInterestingTick,
  shouldEnterWatch,
  shouldExpireWatch,
  shouldWriteTick,
  TickRecorder,
  type TickSnapshot,
  type WatchState,
} from "../src/trace.js";
import type { CacheEntry } from "../src/types.js";
import { GOOD_TAPE, L0_SOL, SOL_CA, oneBuy, twoBuys, testParams } from "./helpers.ts";

const prev = (): WatchState => ({
  firstSeen: 1_000,
  lastIncreaseAt: 1_000,
  lastTickAt: 1_000,
  lastVisiting: 50,
  lastEligible: 1,
  lastEligibleStrict: 0,
  lastBuy: 1,
  lastSell: 0,
  lastBuyUsd: 100,
  lastSellUsd: 0,
  lastMc: 10_000,
});

function baseSnap(patch: Partial<TickSnapshot> = {}): TickSnapshot {
  return {
    visiting: 50,
    eligible: 1,
    eligible_strict: 0,
    buy_wallets: 1,
    sell_wallets: 0,
    buy_usd: 100,
    sell_usd: 0,
    volume: null,
    swaps: null,
    buys: null,
    sells: null,
    pc_1m: null,
    mc: 10_000,
    pushed: 0,
    ...patch,
  };
}

test("watchlist enters on visiting or smartmoney only", () => {
  assert.equal(shouldEnterWatch(false, false), false);
  assert.equal(shouldEnterWatch(true, false), true);
  assert.equal(shouldEnterWatch(false, true), true);
});

test("visiting increase and new smart wallet are interesting", () => {
  const p = prev();
  assert.equal(isCountIncrease(p, baseSnap({ visiting: 80 })), true);
  assert.equal(
    isInterestingTick(p, baseSnap({ eligible: 2, buy_wallets: 2 }), 0.02),
    true,
  );
});

test("visiting drop, eligible_strict change, and net-buy flip are increases", () => {
  const p = prev();
  assert.equal(isCountIncrease(p, baseSnap({ visiting: 20 })), true);
  assert.equal(isCountIncrease(p, baseSnap({ eligible_strict: 1 })), true);
  assert.equal(isCountIncrease(p, baseSnap({ buy_wallets: 0, sell_wallets: 2 })), true);
});

test("mc move of 2% is interesting; 1% is not", () => {
  const p = prev();
  assert.equal(isInterestingTick(p, baseSnap({ mc: 10_100 }), 0.02), false);
  assert.equal(isInterestingTick(p, baseSnap({ mc: 10_300 }), 0.02), true);
});

test("flat ticks coalesce inside 5s and heartbeat after 5s", () => {
  assert.equal(
    shouldWriteTick({ interesting: false, lastTickAt: 1000, now: 4000, minGapMs: 5000 }),
    false,
  );
  assert.equal(
    shouldWriteTick({ interesting: false, lastTickAt: 1000, now: 6000, minGapMs: 5000 }),
    true,
  );
  assert.equal(
    shouldWriteTick({ interesting: true, lastTickAt: 1000, now: 1100, minGapMs: 5000 }),
    false,
  );
});

test("expire after min watch + idle, or hard max", () => {
  const trace = {
    enabled: true,
    min_gap_ms: 5000,
    mc_change_pct: 0.02,
    watch_min_sec: 6,
    watch_idle_sec: 2,
    watch_max_sec: 12,
    retain_hours: 72,
    flush_ms: 1000,
  };
  assert.equal(shouldExpireWatch({ firstSeen: 0, lastIncreaseAt: 0 }, 5_000, trace), false);
  assert.equal(shouldExpireWatch({ firstSeen: 0, lastIncreaseAt: 0 }, 8_000, trace), true);
  assert.equal(shouldExpireWatch({ firstSeen: 0, lastIncreaseAt: 11_000 }, 12_000, trace), true);
});

function recorderParams() {
  return testParams((p) => {
    p.trace.enabled = true;
    p.trace.min_gap_ms = 5000;
    p.trace.mc_change_pct = 0.02;
    p.trace.watch_min_sec = 6;
    p.trace.watch_idle_sec = 2;
    p.trace.watch_max_sec = 12;
    p.trace.flush_ms = 60_000;
  });
}

function tokenAt(now: number, patch: Partial<CacheEntry> = {}): CacheEntry {
  return {
    chain: "sol",
    ca: SOL_CA,
    trades: [{ wallet: "w1", side: "buy", ts: now, price_change: 1.2 }],
    tape: { ...GOOD_TAPE },
    visiting_count: 80,
    visiting_written_at: now,
    market_cap: 10_000,
    market_cap_written_at: now,
    l0: {},
    ...patch,
  };
}

test("note only enqueues; flush writes buys/sells; failed flush restores buffer", () => {
  const db = new Database(":memory:");
  const rec = new TickRecorder(db, recorderParams(), pino({ level: "silent" }));
  const now = 1_700_000_000_000;
  for (let i = 0; i < 201; i += 1) {
    rec.note(tokenAt(now, { visiting_count: 80 + i, visiting_written_at: now }), now + i, false);
  }
  assert.equal(rec.bufferedCount(), 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ticks`).get() as { n: number }).n, 0);

  db.exec("PRAGMA query_only = ON");
  rec.flush();
  assert.equal(rec.bufferedCount(), 1);
  db.exec("PRAGMA query_only = OFF");
  rec.flush();
  assert.equal(rec.bufferedCount(), 0);
  const row = db.prepare(`SELECT buys, sells, visiting FROM ticks ORDER BY id LIMIT 1`).get() as {
    buys: number;
    sells: number;
    visiting: number;
  };
  assert.equal(row.buys, GOOD_TAPE.buys);
  assert.equal(row.sells, GOOD_TAPE.sells);
  assert.equal(row.visiting, 80);
  rec.stop();
});

test("stale market cap is stored as null on ticks", () => {
  const db = new Database(":memory:");
  const rec = new TickRecorder(db, recorderParams(), pino({ level: "silent" }));
  const now = 1_700_000_000_000;
  rec.note(
    tokenAt(now, { market_cap: 10_000, market_cap_written_at: now - 200_000 }),
    now,
    false,
  );
  rec.flush();
  const row = db.prepare(`SELECT mc FROM ticks LIMIT 1`).get() as { mc: number | null };
  assert.equal(row.mc, null);
  rec.stop();
});

test("stale tape is stored as null instead of replaying expired momentum", () => {
  const db = new Database(":memory:");
  const rec = new TickRecorder(db, recorderParams(), pino({ level: "silent" }));
  const now = 1_700_000_000_000;
  rec.note(tokenAt(now, { tape_written_at: now - 200_000 }), now, false);
  rec.flush();
  const row = db.prepare(`SELECT volume, buys, pc_1m FROM ticks LIMIT 1`).get() as {
    volume: number | null;
    buys: number | null;
    pc_1m: number | null;
  };
  assert.deepEqual(row, { volume: null, buys: null, pc_1m: null });
  rec.stop();
});

test("candidate table records rejected/disabled-chain research fields and outcome", () => {
  const db = new Database(":memory:");
  const rec = new TickRecorder(db, recorderParams(), pino({ level: "silent" }));
  const t0 = 1_700_000_000_000;
  rec.note(tokenAt(t0), t0, false);
  // 低于 tick 最小间隔的 security/L0 更新仍必须进入候选表。
  rec.note(
    tokenAt(t0 + 100, { l0: { holder_count: 42, sniper_count: 7 } }),
    t0 + 100,
    false,
  );
  rec.note(
    tokenAt(t0 + 6_000, {
      market_cap: 15_000,
      l0: { holder_count: 42, sniper_count: 7 },
    }),
    t0 + 6_000,
    true,
  );
  rec.flush();
  const row = db.prepare(`SELECT * FROM candidates WHERE chain = ? AND ca = ?`).get("sol", SOL_CA) as {
    first_mc: number;
    max_mc: number;
    l0_json: string;
    pushed: number;
  };
  assert.equal(row.first_mc, 10_000);
  assert.equal(row.max_mc, 15_000);
  assert.deepEqual(JSON.parse(row.l0_json), { holder_count: 42, sniper_count: 7 });
  assert.equal(row.pushed, 1);
  rec.stop();
});

test("candidate baseline resets across rule versions and never preserves stale L0", () => {
  const db = new Database(":memory:");
  const params = recorderParams();
  params.rules.version = "legacy-rule";
  const now = 1_700_000_000_000;
  const legacy = new TickRecorder(db, params, pino({ level: "silent" }));
  legacy.note(
    tokenAt(now, {
      market_cap: 50_000,
      l0: { holder_count: 500 },
      l0_written_at: { holder_count: now },
    }),
    now,
    true,
  );
  legacy.flush();
  legacy.stop();

  params.rules.version = "new-rule";
  const current = new TickRecorder(db, params, pino({ level: "silent" }));
  current.note(
    tokenAt(now + 200_000, {
      market_cap: 20_000,
      market_cap_written_at: now + 200_000,
      l0: { holder_count: 500 },
      l0_written_at: { holder_count: now },
    }),
    now + 200_000,
    false,
  );
  current.flush();
  const row = db.prepare(`SELECT * FROM candidates WHERE chain = ? AND ca = ?`).get("sol", SOL_CA) as {
    first_seen: number;
    first_mc: number;
    max_mc: number;
    l0_json: string;
    pushed: number;
    rule_version: string;
  };
  assert.equal(row.rule_version, "new-rule");
  assert.equal(row.first_seen, now + 200_000);
  assert.equal(row.first_mc, 20_000);
  assert.equal(row.max_mc, 20_000);
  assert.deepEqual(JSON.parse(row.l0_json), {});
  assert.equal(row.pushed, 0);
  current.stop();
});

test("decision events keep rule version, exact rejection evidence, and shadow fields", () => {
  const db = new Database(":memory:");
  const params = recorderParams();
  params.rules.version = "test-rule";
  const rec = new TickRecorder(db, params, pino({ level: "silent" }));
  const now = 1_700_000_000_000;
  const entry = tokenAt(now, {
    price_change_5m: 12,
    price_change_5m_written_at: now,
    liquidity: 12_000,
    l0: { creator_close: true, sniper_count: 5 },
  });
  rec.noteDecision({
    entry,
    decision: "drop",
    reason: "liquidity",
    stage: "prepass",
    ts: now,
  });
  rec.noteDecision({
    entry,
    decision: "drop",
    reason: "liquidity",
    stage: "prepass",
    ts: now + 1,
  });
  const rows = db.prepare(`SELECT * FROM decision_events`).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.rule_version, "test-rule");
  assert.equal(rows[0]?.reason, "liquidity");
  assert.equal(rows[0]?.has_usd, 0);
  assert.deepEqual(JSON.parse(String(rows[0]?.shadow_json)), {
    creator_close: true,
    sniper_count: 5,
  });
  rec.stop();
});

test("idle expire writes a final tick; cooled until off-list; mc move keeps the watch", () => {
  const t0 = 1_000;

  const idleDb = new Database(":memory:");
  const idleRec = new TickRecorder(idleDb, recorderParams(), pino({ level: "silent" }));
  idleRec.note(tokenAt(t0), t0, true);
  idleRec.note(tokenAt(t0 + 8_000), t0 + 8_000, true);
  assert.equal(idleRec.bufferedCount(), 2);
  idleRec.note(tokenAt(t0 + 8_500), t0 + 8_500, true);
  assert.equal(idleRec.bufferedCount(), 2);
  idleRec.note(
    tokenAt(t0 + 9_000, { trades: [], visiting_count: undefined, visiting_written_at: undefined }),
    t0 + 9_000,
    true,
  );
  assert.equal(idleRec.bufferedCount(), 2);
  idleRec.note(tokenAt(t0 + 10_000), t0 + 10_000, true);
  assert.equal(idleRec.bufferedCount(), 3);
  idleRec.flush();
  idleRec.stop();

  const liveDb = new Database(":memory:");
  const liveRec = new TickRecorder(liveDb, recorderParams(), pino({ level: "silent" }));
  liveRec.note(tokenAt(t0), t0, true);
  liveRec.note(tokenAt(t0 + 8_000, { market_cap: 10_300 }), t0 + 8_000, true);
  assert.equal(liveRec.bufferedCount(), 2);
  liveRec.note(tokenAt(t0 + 8_500, { market_cap: 10_300 }), t0 + 8_500, true);
  assert.equal(liveRec.bufferedCount(), 2);
  liveRec.flush();
  liveRec.stop();
});

test("stale visiting is not usable for boost; leaving hot list clears it", () => {
  const params = testParams();
  const now = 1_700_000_000_000;
  const stale: CacheEntry = {
    chain: "sol",
    ca: SOL_CA,
    trades: oneBuy(now),
    tape: GOOD_TAPE,
    price_change_5m: 12,
    visiting_count: 80,
    visiting_written_at: now - 200_000,
    l0: { ...L0_SOL },
    market_cap: 100_000,
    market_cap_written_at: now,
  };
  const stalePass = evaluatePass(stale, params, now);
  assert.equal(stalePass.kind, "drop");
  assert.equal(stalePass.kind === "drop" ? stalePass.reason : "", "pass_formula");

  const staleCluster = evaluatePass({ ...stale, trades: twoBuys(now) }, params, now);
  assert.equal(staleCluster.kind, "pass");

  const cache = new TokenCache();
  cache.writeVisiting("sol", SOL_CA, 80, now);
  cache.writeVisiting("sol", "SoOther11111111111111111111111111111111111", 60, now);
  const cleared = cache.clearAbsentVisiting("sol", new Set([SOL_CA]));
  assert.equal(cleared.length, 1);
  assert.equal(cache.get("sol", SOL_CA)?.visiting_count, 80);
  assert.equal(cleared[0]?.visiting_count, undefined);
  const emptied = cache.clearAbsentVisiting("sol", new Set());
  assert.equal(emptied.length, 1);
  assert.equal(cache.get("sol", SOL_CA)?.visiting_count, undefined);
});

test("stale or absent 5m does not block pass; fresh 5m<=0 drops; leaving 5m list clears", () => {
  const params = testParams();
  const now = 1_700_000_000_000;
  const ready = (): CacheEntry => ({
    chain: "sol",
    ca: SOL_CA,
    trades: twoBuys(now),
    tape: GOOD_TAPE,
    visiting_count: 150,
    visiting_written_at: now,
    market_cap: 100_000,
    market_cap_written_at: now,
    l0: { ...L0_SOL },
  });

  const missing = evaluatePass(ready(), params, now);
  assert.equal(missing.kind, "pass");

  const stale = evaluatePass(
    { ...ready(), price_change_5m: -9, price_change_5m_written_at: now - 200_000 },
    params,
    now,
  );
  assert.equal(stale.kind, "pass");

  const legacy = evaluatePass({ ...ready(), price_change_5m: -9 }, params, now);
  assert.equal(legacy.kind, "pass");
  assert.equal(usablePriceChange5m({ ...ready(), price_change_5m: -9 }, now, 180), undefined);

  const fade = evaluatePass(
    { ...ready(), price_change_5m: 0, price_change_5m_written_at: now },
    params,
    now,
  );
  assert.equal(fade.kind, "drop");
  assert.equal(fade.kind === "drop" ? fade.reason : "", "tape_5m");

  const cache = new TokenCache();
  cache.writePriceChange5m("sol", SOL_CA, -3, now);
  cache.writePriceChange5m("sol", "SoOther11111111111111111111111111111111111", 8, now);
  const cleared = cache.clearAbsentPriceChange5m("sol", new Set([SOL_CA]));
  assert.equal(cleared.length, 1);
  assert.equal(cache.get("sol", SOL_CA)?.price_change_5m, -3);
  assert.equal(cleared[0]?.price_change_5m, undefined);
  const emptied = cache.clearAbsentPriceChange5m("sol", new Set());
  assert.equal(emptied.length, 1);
  assert.equal(cache.get("sol", SOL_CA)?.price_change_5m, undefined);
});
