import assert from "node:assert/strict";
import test from "node:test";
import { lastSides } from "../src/pass.js";
import { loadParams } from "../src/params.js";
import { buildSignal, passKindOf } from "../src/signal.js";
import type { CacheEntry } from "../src/types.js";

test("lastSides: missing price_change counts as eligible but not eligible_strict", () => {
  const now = 1_000_000;
  const sides = lastSides(
    [
      { wallet: "a", side: "buy", ts: now, price_change: 1.2 },
      { wallet: "b", side: "buy", ts: now },
      { wallet: "c", side: "sell", ts: now, price_change: 2 },
    ],
    now,
    180,
    1.0,
  );
  assert.equal(sides.buyWallets, 2);
  assert.equal(sides.sellWallets, 1);
  assert.equal(sides.eligible, 2);
  assert.equal(sides.eligible_strict, 1);
});

test("buildSignal reuses passed PassResult and does not zero missing tape", () => {
  const params = loadParams();
  const now = Date.now();
  const entry: CacheEntry = {
    chain: "sol",
    ca: "So11111111111111111111111111111111111111112",
    trades: [{ wallet: "a", side: "buy", ts: now }],
    l0: {},
  };
  const signal = buildSignal(entry, params, now, {
    kind: "pass",
    cluster: true,
    boost: false,
    eligible: 2,
    hot_pool_lane: "confirmed",
  });
  assert.equal(signal.evidence.pass_kind, "cluster");
  assert.equal(signal.evidence.volume, undefined);
  assert.equal(signal.evidence.swaps, undefined);
  assert.equal(signal.evidence.price_change_1m, undefined);
  assert.equal(signal.evidence.buys, undefined);
  assert.equal(passKindOf({ kind: "drop", reason: "tape" }), undefined);
  assert.equal(
    passKindOf({
      kind: "pass",
      cluster: false,
      boost: false,
      eligible: 0,
      hot_pool_lane: "confirmed",
    }),
    "hot",
  );
});
