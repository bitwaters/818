import assert from "node:assert/strict";
import test from "node:test";
import { TokenCache } from "../src/cache.ts";
import { evaluatePass } from "../src/pass.ts";
import { ingestTrending5m } from "../src/sources/trending.ts";
import { GOOD_TAPE, L0_SOL, SOL_CA, testParams, twoBuys } from "./helpers.ts";

const OTHER = "SoOther11111111111111111111111111111111111";

test("empty 5m rank does not clear a fresh fade veto", () => {
  const cache = new TokenCache();
  const now = 1_700_000_000_000;
  cache.writePriceChange5m("sol", SOL_CA, -3, now);
  const ingest = ingestTrending5m({ cache, chain: "sol", rows: [], now });
  assert.equal(ingest.skippedClear, true);
  assert.equal(ingest.cleared.length, 0);
  assert.equal(cache.get("sol", SOL_CA)?.price_change_5m, -3);
  const pass = evaluatePass(
    {
      chain: "sol",
      ca: SOL_CA,
      trades: twoBuys(now),
      tape: GOOD_TAPE,
      visiting_count: 150,
      visiting_written_at: now,
      market_cap: 100_000,
      market_cap_written_at: now,
      price_change_5m: cache.get("sol", SOL_CA)?.price_change_5m,
      price_change_5m_written_at: cache.get("sol", SOL_CA)?.price_change_5m_written_at,
      l0: { ...L0_SOL },
    },
    testParams(),
    now,
  );
  assert.equal(pass.kind, "drop");
  assert.equal(pass.kind === "drop" ? pass.reason : "", "tape_5m");
});

test("listed 5m token without pct stays present and keeps old fade", () => {
  const cache = new TokenCache();
  const now = 1_700_000_000_000;
  cache.writePriceChange5m("sol", SOL_CA, -3, now);
  const ingest = ingestTrending5m({
    cache,
    chain: "sol",
    rows: [{ address: SOL_CA }],
    now,
  });
  assert.equal(ingest.skippedClear, false);
  assert.equal(ingest.present.has(SOL_CA), true);
  assert.equal(cache.get("sol", SOL_CA)?.price_change_5m, -3);
});

test("non-empty 5m rank still clears tokens that left the list", () => {
  const cache = new TokenCache();
  const now = 1_700_000_000_000;
  cache.writePriceChange5m("sol", SOL_CA, -3, now);
  const ingest = ingestTrending5m({
    cache,
    chain: "sol",
    rows: [{ address: OTHER, price_change_percent: 8 }],
    now,
  });
  assert.equal(ingest.skippedClear, false);
  assert.equal(ingest.cleared.length, 1);
  assert.equal(cache.get("sol", SOL_CA)?.price_change_5m, undefined);
  assert.equal(cache.get("sol", OTHER)?.price_change_5m, 8);
});

test("unparseable 5m rows skip clear like an empty rank", () => {
  const cache = new TokenCache();
  const now = 1_700_000_000_000;
  cache.writePriceChange5m("sol", SOL_CA, -3, now);
  const ingest = ingestTrending5m({
    cache,
    chain: "sol",
    rows: [{}, { symbol: "X" }],
    now,
  });
  assert.equal(ingest.skippedClear, true);
  assert.equal(cache.get("sol", SOL_CA)?.price_change_5m, -3);
});
