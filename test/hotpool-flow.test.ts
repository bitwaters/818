import assert from "node:assert/strict";
import test from "node:test";
import { TokenCache } from "../src/cache.ts";
import { hotPoolLane, momentumTier } from "../src/hotpool.ts";
import { evaluatePass } from "../src/pass.ts";
import { buildSignal } from "../src/signal.ts";
import { tokenCreatedAt } from "../src/sources/parse.ts";
import { trendingQuery } from "../src/sources/trending.ts";
import type { CacheEntry } from "../src/types.ts";
import {
  BSC_CA,
  evalOf,
  GOOD_TAPE,
  type Harness,
  L0_BSC,
  L0_SOL,
  makeHarness,
  seed,
  SOL_CA,
  testParams,
  twoBuys,
} from "./helpers.ts";

const now = 1_700_000_000_000;

function params() {
  return testParams((p) => {
    p.hot_pool.enabled = true;
    p.hot_pool.rank_limit = 100;
    p.hot_pool.membership_ttl_sec = 30;
    p.hot_pool.new_token_grace_sec = 360;
    p.tape.min_price_change_1m = 0;
    p.tape.require_price_change_5m = true;
  });
}

function ready(patch: Partial<CacheEntry> = {}): CacheEntry {
  return {
    chain: "sol",
    ca: SOL_CA,
    trades: twoBuys(now),
    tape: { ...GOOD_TAPE },
    tape_written_at: now,
    visiting_count: 150,
    visiting_written_at: now,
    market_cap: 100_000,
    market_cap_written_at: now,
    l0: { ...L0_SOL },
    ...patch,
  };
}

test("trending rank explicitly requests the API maximum of 100", () => {
  assert.deepEqual(trendingQuery(params(), "bsc", "1m"), {
    chain: "bsc",
    interval: "1m",
    limit: 100,
  });
});

test("token creation timestamps accept seconds and milliseconds", () => {
  assert.equal(tokenCreatedAt({ creation_timestamp: 1_700_000_000 }), 1_700_000_000_000);
  assert.equal(tokenCreatedAt({ open_timestamp: 1_700_000_000_123 }), 1_700_000_000_123);
  assert.equal(tokenCreatedAt({}), undefined);
});

test("1m rank is the hard entrance; ordinary tokens still require fresh positive 5m", () => {
  const p = params();
  const outside = evaluatePass(ready(), p, now);
  assert.deepEqual(outside, { kind: "skip", reason: "hot_1m_incomplete" });

  const oneMinuteOnly = evaluatePass(ready({ rank_1m: 1, rank_1m_seen_at: now }), p, now);
  assert.deepEqual(oneMinuteOnly, { kind: "skip", reason: "tape_5m_incomplete" });

  const confirmed = ready({
    rank_1m: 1,
    rank_1m_seen_at: now,
    rank_5m: 2,
    rank_5m_seen_at: now,
    price_change_5m: 8,
    price_change_5m_written_at: now,
  });
  const passed = evaluatePass(confirmed, p, now);
  assert.equal(passed.kind, "pass");
  assert.equal(passed.kind === "pass" ? passed.hot_pool_lane : "", "confirmed");

  const fading = evaluatePass(
    { ...confirmed, price_change_5m: -1 },
    p,
    now,
  );
  assert.deepEqual(fading, { kind: "drop", reason: "tape_5m" });

  const staleFiveMinute = evaluatePass(
    { ...confirmed, price_change_5m_written_at: now - 31_000 },
    p,
    now,
  );
  assert.deepEqual(staleFiveMinute, { kind: "skip", reason: "tape_5m_incomplete" });
});

test("a verified young 1m-ranked token may pass while 5m data is not formed", () => {
  const p = params();
  const young = ready({
    rank_1m: 3,
    rank_1m_seen_at: now,
    created_at: now - 2 * 60_000,
  });
  const result = evaluatePass(young, p, now);
  assert.equal(result.kind, "pass");
  assert.equal(result.kind === "pass" ? result.hot_pool_lane : "", "new_token");

  const youngListed5m = evaluatePass(
    { ...young, rank_5m: 9, rank_5m_seen_at: now },
    p,
    now,
  );
  assert.equal(youngListed5m.kind, "pass");
  assert.equal(
    youngListed5m.kind === "pass" ? youngListed5m.hot_pool_lane : "",
    "new_token",
  );

  const unknownAge = evaluatePass(
    { ...young, created_at: undefined },
    p,
    now,
  );
  assert.deepEqual(unknownAge, { kind: "skip", reason: "tape_5m_incomplete" });

  const tooOld = evaluatePass(
    { ...young, created_at: now - 361_000 },
    p,
    now,
  );
  assert.deepEqual(tooOld, { kind: "skip", reason: "tape_5m_incomplete" });
});

test("hot-pool mode can pass without smart-money trades when confirmation is disabled", async () => {
  const p = params();
  p.flow.require_smart_money = false;
  const entry = ready({
    trades: [],
    rank_1m: 1,
    rank_1m_seen_at: now,
    rank_5m: 1,
    rank_5m_seen_at: now,
    price_change_5m: 8,
    price_change_5m_written_at: now,
  });
  const pass = evaluatePass(entry, p, now);
  assert.equal(pass.kind, "pass");
  assert.equal(pass.kind === "pass" ? pass.cluster : true, false);
  assert.equal(buildSignal(entry, p, now, pass).evidence.pass_kind, "hot");

  let h!: Harness;
  h = makeHarness({
    params: p,
    now,
    fetchSecurity: async () => ({ ...L0_SOL }),
  });
  seed(h, "sol", SOL_CA, {
    tape: GOOD_TAPE,
    trades: [],
    visiting: 150,
    marketCap: 100_000,
    priceChange5m: 8,
  });
  h.cache.replaceRankMembership("sol", "1m", [SOL_CA], now);
  h.cache.replaceRankMembership("sol", "5m", [SOL_CA], now);
  assert.equal((await evalOf(h)).decision, "push");
  assert.equal(h.securityCalls.length, 1);
});

test("extreme 1m momentum is tagged rather than rejected", () => {
  const p = params();
  const entry = ready({
    tape: { ...GOOD_TAPE, price_change_1m: 450 },
    rank_1m: 1,
    rank_1m_seen_at: now,
    rank_5m: 1,
    rank_5m_seen_at: now,
    price_change_5m: 900,
    price_change_5m_written_at: now,
  });
  const pass = evaluatePass(entry, p, now);
  assert.equal(pass.kind, "pass");
  assert.equal(momentumTier(450, p), "extreme");
  assert.equal(buildSignal(entry, p, now, pass).evidence.momentum_tier, "extreme");
});

test("BSC market-cap floor is inclusive at $10k", () => {
  const p = params();
  p.pass.min_entry_mc.bsc = 10_000;
  p.pass.min_liquidity_usd.bsc = 10_000;
  p.tape.min_volume_market_cap_ratio = 0.5;
  p.tape.max_volume_market_cap_ratio = 2;
  const entry: CacheEntry = {
    ...ready({
      tape: { ...GOOD_TAPE, volume: 8_000 },
      rank_1m: 1,
      rank_1m_seen_at: now,
      rank_5m: 1,
      rank_5m_seen_at: now,
      price_change_5m: 10,
      price_change_5m_written_at: now,
      liquidity: 10_000,
      liquidity_written_at: now,
      market_cap: 10_000,
      l0: { ...L0_BSC },
    }),
    chain: "bsc",
    ca: BSC_CA,
  };
  assert.equal(evaluatePass(entry, p, now).kind, "pass");
  assert.deepEqual(
    evaluatePass({ ...entry, market_cap: 9_999 }, p, now),
    { kind: "drop", reason: "entry_mc" },
  );
});

test("rank membership replacement clears leavers and TTL expires stale snapshots", () => {
  const p = params();
  const cache = new TokenCache();
  cache.replaceRankMembership("sol", "1m", [SOL_CA], now);
  cache.replaceRankMembership("sol", "5m", [SOL_CA], now);
  const entry = cache.get("sol", SOL_CA)!;
  assert.equal(hotPoolLane(entry, p, now), "confirmed");
  assert.equal(hotPoolLane(entry, p, now + 30_000), undefined);

  cache.replaceRankMembership("sol", "1m", ["SoOther11111111111111111111111111111111111"], now + 1);
  assert.equal(entry.rank_1m_seen_at, undefined);
  assert.equal(hotPoolLane(entry, p, now + 1), undefined);
});

test("a partial new rank row cannot borrow missing tape fields from the previous round", () => {
  const cache = new TokenCache();
  cache.replaceTape1m("sol", SOL_CA, GOOD_TAPE, { now });
  cache.replaceTape1m("sol", SOL_CA, { price_change_1m: 50 }, { now: now + 10_000 });
  assert.deepEqual(cache.get("sol", SOL_CA)?.tape, { price_change_1m: 50 });
});

test("central hot-pool gate blocks security and is rechecked after async security", async () => {
  const p = params();
  let h!: Harness;
  h = makeHarness({
    params: p,
    now,
    fetchSecurity: async () => {
      h.now += 31_000;
      return { ...L0_SOL };
    },
  });
  seed(h, "sol", SOL_CA, {
    tape: GOOD_TAPE,
    trades: twoBuys(now),
    visiting: 150,
    marketCap: 100_000,
    priceChange5m: 10,
  });
  assert.equal((await evalOf(h)).reason, "hot_1m_incomplete");
  assert.equal(h.securityCalls.length, 0);

  h.cache.replaceRankMembership("sol", "1m", [SOL_CA], h.now);
  h.cache.replaceRankMembership("sol", "5m", [SOL_CA], h.now);
  const result = await evalOf(h);
  assert.equal(result.reason, "hot_1m_incomplete");
  assert.equal(h.securityCalls.length, 1);
  assert.equal(h.telegram.signals.length, 0);
});
