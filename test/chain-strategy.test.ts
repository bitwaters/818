import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import pino from "pino";
import { checkL0 } from "../src/l0/index.ts";
import { evaluatePass } from "../src/pass.ts";
import { TickRecorder } from "../src/trace.ts";
import type { CacheEntry } from "../src/types.ts";
import {
  BSC_CA,
  GOOD_TAPE,
  L0_BSC,
  L0_SOL,
  SOL_CA,
  evalOf,
  makeHarness,
  seedReady,
  testParams,
} from "./helpers.ts";

const now = 1_700_000_000_000;

function candidate(chain: "sol" | "bsc", visiting: number | undefined): CacheEntry {
  return {
    chain,
    ca: chain === "sol" ? SOL_CA : BSC_CA,
    trades: [],
    tape: { ...GOOD_TAPE },
    tape_written_at: now,
    visiting_count: visiting,
    visiting_written_at: now,
    market_cap: 10_000,
    market_cap_written_at: now,
    l0: chain === "sol" ? { ...L0_SOL } : { ...L0_BSC },
  };
}

test("SOL and BSC select independent tape thresholds", () => {
  const params = testParams((p) => {
    p.strategy.sol.flow.require_smart_money = false;
    p.strategy.bsc.flow.require_smart_money = false;
    p.strategy.sol.tape.min_volume_usd = 3_000;
    p.strategy.bsc.tape.min_volume_usd = 5_000;
  });
  const sol = candidate("sol", 100);
  const bsc = candidate("bsc", 100);
  sol.tape = { ...GOOD_TAPE, volume: 4_000 };
  bsc.tape = { ...GOOD_TAPE, volume: 4_000 };
  assert.equal(evaluatePass(sol, params, now).kind, "pass");
  assert.deepEqual(evaluatePass(bsc, params, now), {
    kind: "drop",
    reason: "tape",
  });
});

test("visiting_count is required, finite, and inclusive at 100 on both chains", () => {
  const params = testParams((p) => {
    p.strategy.sol.flow.require_smart_money = false;
    p.strategy.bsc.flow.require_smart_money = false;
  });
  for (const chain of ["sol", "bsc"] as const) {
    assert.deepEqual(evaluatePass(candidate(chain, undefined), params, now), {
      kind: "skip",
      reason: "visiting_incomplete",
    });
    assert.deepEqual(evaluatePass(candidate(chain, Number.NaN), params, now), {
      kind: "skip",
      reason: "visiting_incomplete",
    });
    assert.deepEqual(evaluatePass(candidate(chain, 99), params, now), {
      kind: "drop",
      reason: "visiting",
    });
    assert.equal(evaluatePass(candidate(chain, 100), params, now).kind, "pass");
  }
});

test("security dispatch never substitutes the other chain schema", () => {
  const params = testParams();
  assert.deepEqual(checkL0({ ...candidate("sol", 100), l0: L0_BSC }, params, now), {
    kind: "incomplete",
  });
  assert.deepEqual(checkL0({ ...candidate("bsc", 100), l0: L0_SOL }, params, now), {
    kind: "incomplete",
  });
});

test("SOL shadow pass records once without any live side effect", async () => {
  const params = testParams((p) => {
    p.strategy.sol.mode = "shadow";
  });
  const h = makeHarness({
    params,
    initialPushed: { chain: "sol", ca: SOL_CA, ts: now },
  });
  seedReady(h, "sol", SOL_CA);

  assert.equal(h.pipeline.isCooling("sol", SOL_CA, h.now), false);
  const first = await evalOf(h, "sol", SOL_CA);
  assert.equal(first.reason, "shadow_pass");
  assert.equal(h.shadowSignals.length, 1);
  assert.equal(h.telegram.signals.length, 0);
  assert.equal(h.emitted.length, 0);
  assert.equal(h.inserted.length, 0);
  assert.equal(h.pipeline.isCooling("sol", SOL_CA, h.now), false);

  const second = await evalOf(h, "sol", SOL_CA);
  assert.equal(second.reason, "shadow_recorded");
  assert.equal(h.shadowSignals.length, 1);
});

test("shadow baseline storage preserves first entry and separates rule versions", () => {
  const db = new Database(":memory:");
  const params = testParams();
  const rec = new TickRecorder(db, params, pino({ level: "silent" }));
  const signal = {
    rule_version: "r1",
    chain: "sol" as const,
    ca: SOL_CA,
    symbol: "TEST",
    ts: now,
    evidence: {
      smart_wallets: 0,
      eligible_strict: 0,
      buy_wallets: 0,
      sell_wallets: 0,
      visiting_count: 100,
      market_cap: 10_000,
    },
    l0: { ...L0_SOL },
    links: { gmgn: "https://example.test" },
  };
  assert.equal(rec.noteShadowSignal(signal), true);
  assert.equal(rec.noteShadowSignal({ ...signal, ts: now + 1, symbol: "REPLACED" }), true);
  assert.equal(rec.noteShadowSignal({ ...signal, rule_version: "r2", ts: now + 2 }), true);

  const rows = db.prepare(`SELECT rule_version, ts, symbol FROM shadow_signals ORDER BY rule_version`).all();
  assert.deepEqual(rows, [
    { rule_version: "r1", ts: now, symbol: "TEST" },
    { rule_version: "r2", ts: now + 2, symbol: "TEST" },
  ]);
  rec.stop();
});
