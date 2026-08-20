import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TokenCache } from "../src/cache.ts";
import { evaluatePass, lastSides, netBuyOk, tapeFakeMomentum } from "../src/pass.ts";
import { parseTrade, pickL0Snapshot } from "../src/sources/parse.ts";
import { ingestTrending5m } from "../src/sources/trending.ts";
import {
  BSC_CA,
  GOOD_TAPE,
  L0_BSC,
  L0_SOL,
  SOL_CA,
  evalOf,
  makeHarness,
  seed,
  seedReady,
  testParams,
  twoBuys,
} from "./helpers.ts";

describe("热门写入浏览", () => {
  it("5m 热门写入 visiting_count 和 tape5m，不覆盖 1m tape", () => {
    const cache = new TokenCache();
    const now = 1_700_000_000_000;
    cache.writeTape1m("sol", SOL_CA, GOOD_TAPE, { now });
    const ingest = ingestTrending5m({
      cache,
      chain: "sol",
      rows: [
        {
          address: SOL_CA,
          visiting_count: 220,
          price_change_percent: 12,
          buys: 40,
          sells: 11,
          volume: 9000,
          swaps: 51,
        },
      ],
      now,
    });
    const entry = cache.get("sol", SOL_CA)!;
    assert.equal(ingest.visitingN, 1);
    assert.equal(entry.visiting_count, 220);
    assert.equal(entry.tape?.buys, GOOD_TAPE.buys);
    assert.equal(entry.tape5m?.buys, 40);
    assert.equal(entry.price_change_5m, 12);
  });
});

describe("SOL 入场市值", () => {
  it("SOL <$10k 丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeMarketCap("sol", SOL_CA, 9000, h.now);
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "entry_mc");
  });

  it("SOL ≥$10k 推", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeMarketCap("sol", SOL_CA, 10000, h.now);
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
  });

  it("BSC <$10k 仍推", async () => {
    const h = makeHarness();
    seed(h, "bsc", BSC_CA, {
      l0: L0_BSC,
      tape: GOOD_TAPE,
      trades: twoBuys(h.now),
      visiting: 150,
      priceChange5m: 12,
      marketCap: 4000,
    });
    const r = await evalOf(h, "bsc", BSC_CA);
    assert.equal(r.decision, "push");
  });
});

describe("tape TTL 与假动量", () => {
  it("过期 1m tape → 跳过", async () => {
    const h = makeHarness();
    seedReady(h);
    const e = h.cache.get("sol", SOL_CA)!;
    e.tape_written_at = h.now - 181_000;
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "tape_incomplete");
  });

  it("买/卖 ≥3 丢 tape_fake", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeTape1m("sol", SOL_CA, { ...GOOD_TAPE, buys: 40, sells: 10 }, { now: h.now });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "tape_fake");
  });

  it("tapeFakeMomentum 卖单为 0 按无限买卖比否决", () => {
    assert.equal(tapeFakeMomentum({ ...GOOD_TAPE, buys: 40, sells: 0 }, 3), true);
    assert.equal(tapeFakeMomentum({ ...GOOD_TAPE, buys: 40, sells: 10 }, 3), true);
    assert.equal(tapeFakeMomentum({ ...GOOD_TAPE, buys: 22, sells: 10 }, 3), false);
  });
});

describe("聪明钱金额净买", () => {
  it("parseTrade 读 amount_usd 和 is_open_or_close，不把 percent 当倍数", () => {
    const trade = parseTrade(
      {
        maker: "W",
        side: "buy",
        amount_usd: "250.5",
        is_open_or_close: 0,
        transaction_hash: "tx-1",
        price_change_percent: 80,
        timestamp: 1_700_000_000,
      },
      0,
    );
    assert.equal(trade?.amount_usd, 250.5);
    assert.equal(trade?.is_open_or_close, 0);
    assert.equal(trade?.id, "tx-1");
    assert.equal(trade?.price_change, undefined);
  });

  it("GMGN 倒序列表按时间戳取真正最新一笔", () => {
    const now = 1_700_000_000_000;
    const sides = lastSides(
      [
        { wallet: "w", side: "buy", amount_usd: 300, ts: now },
        { wallet: "w", side: "sell", amount_usd: 100, ts: now - 10_000 },
      ],
      now,
      180,
      1,
    );
    assert.equal(sides.eligible, 1);
    assert.equal(sides.buyWallets, 1);
    assert.equal(sides.sellWallets, 0);
  });

  it("相同 transaction_hash 的轮询成交只缓存一次", () => {
    const cache = new TokenCache();
    const now = 1_700_000_000_000;
    const trade = { id: "same-tx", wallet: "w", side: "buy" as const, ts: now };
    cache.writeTrades("sol", SOL_CA, [trade], { now, ttlSec: 180 });
    cache.writeTrades("sol", SOL_CA, [trade], { now, ttlSec: 180 });
    assert.equal(cache.get("sol", SOL_CA)?.trades.length, 1);
  });

  it("同一 token 的批量字段写入只触发一次轨迹通知", () => {
    let mutations = 0;
    const cache = new TokenCache(() => {
      mutations += 1;
    });
    const now = 1_700_000_000_000;
    cache.batch(() => {
      cache.writeTape1m("sol", SOL_CA, GOOD_TAPE, { now });
      cache.writeVisiting("sol", SOL_CA, 200, now);
      cache.writeMarketCap("sol", SOL_CA, 100_000, now);
    });
    assert.equal(mutations, 1);
  });

  it("有金额时净买按 USD，两笔小买打不过一笔大卖", () => {
    const now = 1_700_000_000_000;
    const sides = lastSides(
      [
        { wallet: "a", side: "buy", amount_usd: 20, ts: now },
        { wallet: "b", side: "buy", amount_usd: 30, ts: now },
        { wallet: "c", side: "sell", amount_usd: 5000, ts: now },
      ],
      now,
      180,
      1,
    );
    assert.equal(sides.buyWallets > sides.sellWallets, true);
    assert.equal(sides.hasUsd, true);
    assert.equal(netBuyOk(sides, true), false);
  });

  it("净流累计窗口全部成交，不被钱包最后一笔小买掩盖", () => {
    const now = 1_700_000_000_000;
    const sides = lastSides(
      [
        { id: "sell-old", wallet: "a", side: "sell", amount_usd: 1000, ts: now - 1000 },
        { id: "buy-new", wallet: "a", side: "buy", amount_usd: 10, ts: now },
        { id: "buy-b", wallet: "b", side: "buy", amount_usd: 10, ts: now },
      ],
      now,
      180,
      1,
    );
    assert.equal(sides.eligible, 2);
    assert.equal(sides.buyUsd, 20);
    assert.equal(sides.sellUsd, 1000);
    assert.equal(netBuyOk(sides, true), false);
  });

  it("窗口任一金额缺失时退回钱包方向，不把未知卖额当 0", () => {
    const now = 1_700_000_000_000;
    const sides = lastSides(
      [
        { wallet: "a", side: "buy", amount_usd: 100, ts: now },
        { wallet: "b", side: "sell", ts: now },
      ],
      now,
      180,
      1,
    );
    assert.equal(sides.hasUsd, false);
    assert.equal(netBuyOk(sides, true), false);
  });

  it("平仓买不算 eligible", () => {
    const now = 1_700_000_000_000;
    const sides = lastSides(
      [
        { wallet: "a", side: "buy", amount_usd: 100, is_open_or_close: 1, ts: now },
        { wallet: "b", side: "buy", amount_usd: 100, is_open_or_close: 0, ts: now },
      ],
      now,
      180,
      1,
    );
    assert.equal(sides.eligible, 1);
    assert.equal(sides.buyWallets, 2);
  });

  it("金额净卖 → 过线丢", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      visiting: 150,
      priceChange5m: 12,
      marketCap: 50_000,
      trades: [
        { wallet: "w1", side: "buy", amount_usd: 10, ts: h.now },
        { wallet: "w2", side: "buy", amount_usd: 10, ts: h.now },
        { wallet: "w3", side: "sell", amount_usd: 800, ts: h.now },
      ],
    });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "pass_formula");
  });
});

describe("回放调优后的盘口边界", () => {
  const tuned = () =>
    testParams((p) => {
      p.tape.max_price_change_1m = 200;
      p.tape.min_volume_market_cap_ratio = 0.5;
      p.tape.max_volume_market_cap_ratio = 2;
    });

  it("1m 涨幅达到 200% 作为追高否决", async () => {
    const h = makeHarness({ params: tuned() });
    seedReady(h, "bsc", BSC_CA);
    h.cache.writeTape1m(
      "bsc",
      BSC_CA,
      { ...GOOD_TAPE, price_change_1m: 200, volume: 60_000 },
      { now: h.now },
    );
    const r = await evalOf(h, "bsc", BSC_CA);
    assert.equal(r.reason, "tape_chase");
  });

  it("成交量/市值只接受 0.5–2.0", async () => {
    const low = makeHarness({ params: tuned() });
    seedReady(low, "bsc", BSC_CA);
    assert.equal((await evalOf(low, "bsc", BSC_CA)).reason, "tape_volume_mc");

    const good = makeHarness({ params: tuned() });
    seedReady(good, "bsc", BSC_CA);
    good.cache.writeTape1m("bsc", BSC_CA, { ...GOOD_TAPE, volume: 60_000 }, { now: good.now });
    assert.equal((await evalOf(good, "bsc", BSC_CA)).decision, "push");
  });

  it("禁用链只停止信号，不影响数据源配置", async () => {
    const params = testParams((p) => {
      p.pass.signal_enabled.sol = false;
    });
    const h = makeHarness({ params });
    seedReady(h);
    const r = await evalOf(h);
    assert.equal(r.reason, "chain_disabled");
    assert.equal(params.chains.sol, true);
  });

  it("廉价盘口不通过时不消耗 security 配额", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, {
      tape: { ...GOOD_TAPE, price_change_1m: 0 },
      trades: twoBuys(h.now),
      marketCap: 100_000,
    });
    assert.equal((await evalOf(h)).reason, "tape");
    assert.equal(h.securityCalls.length, 0);
  });

  it("额外风险字段进入快照，暂不盲目硬过滤", () => {
    const snap = pickL0Snapshot({ holder_count: 321, sniper_count: 9, unknown: 1 });
    assert.deepEqual(snap, { holder_count: 321, sniper_count: 9 });
  });
});
