import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { cacheKey, normalizeCa } from "../src/cache.ts";
import { renderSignalCard } from "../src/push/cards.ts";
import { impliedMc, milestoneK, runSnapshot, sendDailySummary, sendHourlySummary, StatsStore, tokenInfoMarketCap } from "../src/stats.ts";
import {
  BSC_CA,
  BSC_CA_MIXED,
  GOOD_TAPE,
  L0_BSC,
  L0_SOL,
  SOL_CA,
  evalOf,
  makeHarness,
  oneBuy,
  seed,
  seedReady,
  testParams,
  twoBuys,
} from "./helpers.ts";

function memoryStore(params: Parameters<typeof StatsStore>[0], logger: Parameters<typeof StatsStore>[1]) {
  return new StatsStore(params, logger, new Database(":memory:"));
}

describe("金样例 1–11 L0/过线", () => {
  it("1 SOL mint 未弃权 → 丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.mergeL0("sol", SOL_CA, { renounced_mint: 0 });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "mint_not_renounced");
  });

  it("2 BSC honeypot 空串或非 no/0 → 丢", async () => {
    for (const value of ["", "yes", "1", true]) {
      const h = makeHarness();
      seedReady(h, "bsc", BSC_CA);
      h.cache.mergeL0("bsc", BSC_CA, { is_honeypot: value });
      const r = await evalOf(h, "bsc", BSC_CA);
      assert.equal(r.decision, "drop", `honeypot=${String(value)}`);
    }
  });

  it("3 SOL honeypot 空不因此丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.mergeL0("sol", SOL_CA, { is_honeypot: "" });
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
  });

  it("4 BSC renounced_mint=false 忽略", async () => {
    const h = makeHarness();
    seedReady(h, "bsc", BSC_CA);
    h.cache.mergeL0("bsc", BSC_CA, { renounced_mint: false });
    const r = await evalOf(h, "bsc", BSC_CA);
    assert.equal(r.decision, "push");
  });

  it("5 eligible=2 净买 tape 达标 → 推", async () => {
    const h = makeHarness();
    seedReady(h);
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
    assert.equal(h.emitted.length, 1);
  });

  it("6 5m 已 10x 仍用 1m tape → 推", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writePriceChange5m("sol", SOL_CA, 1000, h.now);
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
  });

  it("7 1m ≤ 0 → 丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeTape1m("sol", SOL_CA, { ...GOOD_TAPE, price_change_1m: 0 });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "tape");
  });

  it("7b 1m 涨幅 19% < 20% → 丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeTape1m("sol", SOL_CA, { ...GOOD_TAPE, price_change_1m: 19 });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "tape");
  });

  it("7c 无 5m 不挡过线 → 推", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      trades: twoBuys(h.now),
      visiting: 150,
      priceChange5m: 12,
      marketCap: 100_000,
    });
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
  });

  it("7d 5m ≤ 0 → 丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writePriceChange5m("sol", SOL_CA, 0, h.now);
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "tape_5m");
  });

  it("7e 过期 5m 视同缺席 → 推", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writePriceChange5m("sol", SOL_CA, -8, h.now - 200_000);
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
  });

  it("7f 离开 5m 热门榜清掉负涨幅后可推", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writePriceChange5m("sol", SOL_CA, -3, h.now);
    const blocked = await evalOf(h);
    assert.equal(blocked.decision, "drop");
    assert.equal(blocked.reason, "tape_5m");
    h.cache.clearAbsentPriceChange5m("sol", new Set());
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
  });

  it("8 无 1m 盘面 → 跳过", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, { l0: L0_SOL, trades: twoBuys(h.now) });
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "tape_incomplete");
  });

  it("9 eligible=1 即使浏览达标 → 丢", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      trades: oneBuy(h.now),
      visiting: 150,
      priceChange5m: 12,
      marketCap: 100_000,
    });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "pass_formula");
  });

  it("10 浏览缺失不挡，不足则丢", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      trades: twoBuys(h.now),
      priceChange5m: 12,
      marketCap: 100_000,
    });
    const missing = await evalOf(h);
    assert.equal(missing.decision, "push");
    const h2 = makeHarness();
    seed(h2, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      trades: twoBuys(h2.now),
      visiting: 99,
      priceChange5m: 12,
      marketCap: 100_000,
    });
    const low = await evalOf(h2);
    assert.equal(low.decision, "drop");
    assert.equal(low.reason, "visiting");
  });

  it("11 仅 visiting 高 → 丢", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, { l0: L0_SOL, tape: GOOD_TAPE, visiting: 999, priceChange5m: 12, marketCap: 100_000 });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
  });
});

describe("金样例 12–15、21、22 Telegram", () => {
  it("12 ticker 含 <b> 按文本 escape", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeSymbol("sol", SOL_CA, "<b>HAX");
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
    const html = renderSignalCard(r.signal!);
    assert.match(html, /&lt;b&gt;HAX/);
    assert.doesNotMatch(html, /<b>HAX/);
  });

  it("13 sendMessage 失败不冷却", async () => {
    const h = makeHarness();
    seedReady(h);
    h.telegram.failNext = true;
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(h.pipeline.isCooling("sol", SOL_CA, h.now), false);
    assert.equal(h.emitted.length, 0);
  });

  it("14 已向全部目的地推过 → 跳过", async () => {
    const h = makeHarness();
    seedReady(h);
    assert.equal((await evalOf(h)).decision, "push");
    h.inserted.length = 0;
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "already_pushed");
    assert.equal(h.inserted.length, 0);
  });

  it("15 已 pending → 跳过", async () => {
    const h = makeHarness();
    seedReady(h);
    h.pipeline.markPending("sol", SOL_CA);
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "pending");
  });

  it("21 SOL 无/过期/非正市值 → 跳过等热门，不推", async () => {
    const cases: Array<(h: ReturnType<typeof makeHarness>) => void> = [
      (h) => {
        seedReady(h);
        const e = h.cache.get("sol", SOL_CA)!;
        delete e.market_cap;
        delete e.market_cap_written_at;
      },
      (h) => {
        seedReady(h);
        h.cache.writeMarketCap("sol", SOL_CA, 100, h.now - 181_000);
      },
      (h) => {
        seedReady(h);
        h.cache.writeMarketCap("sol", SOL_CA, 0, h.now);
      },
    ];
    for (const setup of cases) {
      const h = makeHarness();
      setup(h);
      const r = await evalOf(h);
      assert.equal(r.decision, "skip");
      assert.equal(r.reason, "entry_mc_incomplete");
      assert.equal(h.emitted.length, 0);
      assert.equal(h.pipeline.isCooling("sol", SOL_CA, h.now), false);
    }
  });

  it("21b BSC 无市值仍推（门槛为 0）但不入库", async () => {
    const h = makeHarness();
    seedReady(h, "bsc", BSC_CA);
    const e = h.cache.get("bsc", BSC_CA)!;
    delete e.market_cap;
    delete e.market_cap_written_at;
    const r = await evalOf(h, "bsc", BSC_CA);
    assert.equal(r.decision, "push");
    assert.equal(h.emitted.length, 1);
    assert.equal(h.inserted.length, 0);
  });

  it("22 入库失败冷却不回滚", async () => {
    const h = makeHarness({
      insertImpl: () => {
        throw new Error("db down");
      },
    });
    seedReady(h);
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
    assert.equal(h.pipeline.isCooling("sol", SOL_CA, h.now), true);
  });
});

describe("金样例 16–20 缓存与过线边沿", () => {
  it("16 L0 缺键 eligible≥1 security 未返回 → 跳过", async () => {
    const h = makeHarness({ fetchSecurity: async () => null });
    seed(h, "sol", SOL_CA, { trades: twoBuys(h.now), tape: GOOD_TAPE, marketCap: 100_000 });
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "security_failed");
    assert.equal(h.securityCalls.length, 1);
    assert.equal(h.quota.isSkipped("sol", SOL_CA), false);
  });

  it("16b BSC is_honeypot 键不存在 → 跳过不是丢", async () => {
    const h = makeHarness({ fetchSecurity: async () => null });
    const l0 = { ...L0_BSC };
    delete l0.is_honeypot;
    seed(h, "bsc", BSC_CA, { l0, tape: GOOD_TAPE, trades: twoBuys(h.now) });
    const r = await evalOf(h, "bsc", BSC_CA);
    assert.equal(r.decision, "skip");
    assert.notEqual(r.decision, "drop");
  });

  it("17 BSC 大小写同一缓存键", () => {
    assert.equal(normalizeCa("bsc", BSC_CA_MIXED), BSC_CA);
    assert.equal(cacheKey("bsc", BSC_CA_MIXED), cacheKey("bsc", BSC_CA));
  });

  it("18 最后一笔为卖不计入 eligible", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      trades: [
        { wallet: "w1", side: "buy", price_change: 2, ts: h.now - 1000 },
        { wallet: "w1", side: "sell", price_change: 2, ts: h.now },
        { wallet: "w2", side: "buy", price_change: 2, ts: h.now },
        { wallet: "w3", side: "buy", price_change: 2, ts: h.now },
      ],
      visiting: 150,
      priceChange5m: 12,
      marketCap: 100_000,
    });
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
    assert.equal(r.signal?.evidence.smart_wallets, 2);
  });

  it("19 min_smart_wallets=3 eligible=2 浏览达标不再 boost → 丢", async () => {
    const h = makeHarness({ params: testParams((p) => { p.flow.min_smart_wallets = 3; }) });
    seed(h, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      trades: twoBuys(h.now),
      visiting: 150,
      priceChange5m: 12,
      marketCap: 100_000,
    });
    const r = await evalOf(h);
    assert.equal(r.decision, "drop");
    assert.equal(r.reason, "pass_formula");
  });

  it("20 require_not_honeypot=false 且 honeypot=yes 不因此丢", async () => {
    const h = makeHarness({
      params: testParams((p) => {
        p.l0_bsc.require_not_honeypot = false;
      }),
    });
    seedReady(h, "bsc", BSC_CA);
    h.cache.mergeL0("bsc", BSC_CA, { is_honeypot: "yes" });
    assert.equal((await evalOf(h, "bsc", BSC_CA)).decision, "push");
  });
});

describe("金样例 21b、23–32 统计", () => {
  it("21b 市值字段按 trending 时间过期", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, {
      l0: L0_SOL,
      tape: GOOD_TAPE,
      trades: twoBuys(h.now),
      visiting: 150,
      priceChange5m: 12,
      marketCap: 99,
      marketCapAt: h.now - 180_000,
      symbol: "PEPE",
    });
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(r.reason, "entry_mc_incomplete");
    assert.equal(h.emitted.length, 0);
    assert.equal(h.inserted.length, 0);
  });

  it("23 / 23b / 24 命中与涨幅档", () => {
    assert.equal(milestoneK(1.4, 1), 0);
    assert.equal(milestoneK(1.9, 1), 0);
    assert.equal(milestoneK(2.0, 1), 1);
    assert.ok(1.4 < 1.5);
    assert.ok(1.9 >= 1.5);
  });

  it("24 2.0x 提醒成功写 last_milestone=1", async () => {
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
    });
    const h = makeHarness({ params });
    const store = memoryStore(params, h.logger);
    store.insert({
      chain: "sol",
      ca: SOL_CA,
      symbol: "PEPE",
      ts: h.now,
      evidence: { smart_wallets: 2, price_change_1m: 40, buys: 1, sells: 0, volume: 1, swaps: 1, market_cap: 100 },
      l0: {},
      links: { gmgn: "https://gmgn.ai/sol/token/x" },
    });
    seed(h, "sol", SOL_CA, { marketCap: 200, marketCapAt: h.now });
    await runSnapshot({
      store,
      params,
      cache: h.cache,
      telegram: h.telegram,
      fetchInfoMc: async () => null,
      now: h.now + 60_000,
    });
    const row = store.activeRows(h.now)[0]!;
    assert.equal(row.max_mc, 200);
    assert.equal(row.last_milestone, 1);
    assert.match(h.telegram.texts[0] ?? "", /\+100%/);
    store.close();
  });

  it("24b 提醒发送失败不改档", async () => {
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
    });
    const h = makeHarness({ params });
    h.telegram.failText = true;
    const store = memoryStore(params, h.logger);
    store.insert({
      chain: "sol",
      ca: SOL_CA,
      symbol: "PEPE",
      ts: h.now,
      evidence: { smart_wallets: 2, price_change_1m: 1, buys: 1, sells: 0, volume: 1, swaps: 1, market_cap: 100 },
      l0: {},
      links: { gmgn: "https://x" },
    });
    seed(h, "sol", SOL_CA, { marketCap: 200, marketCapAt: h.now });
    await runSnapshot({
      store,
      params,
      cache: h.cache,
      telegram: h.telegram,
      fetchInfoMc: async () => null,
      now: h.now + 60_000,
    });
    assert.equal(store.activeRows(h.now)[0]!.last_milestone, 0);
    store.close();
  });

  it("25 1.8x 跳到 3.1x 只发 +200%", async () => {
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
    });
    const h = makeHarness({ params });
    const store = memoryStore(params, h.logger);
    store.insert({
      chain: "sol",
      ca: SOL_CA,
      symbol: "PEPE",
      ts: h.now,
      evidence: { smart_wallets: 2, price_change_1m: 1, buys: 1, sells: 0, volume: 1, swaps: 1, market_cap: 100 },
      l0: {},
      links: { gmgn: "https://x" },
    });
    seed(h, "sol", SOL_CA, { marketCap: 180, marketCapAt: h.now });
    await runSnapshot({
      store,
      params,
      cache: h.cache,
      telegram: h.telegram,
      fetchInfoMc: async () => null,
      now: h.now,
    });
    seed(h, "sol", SOL_CA, { marketCap: 310, marketCapAt: h.now });
    await runSnapshot({
      store,
      params,
      cache: h.cache,
      telegram: h.telegram,
      fetchInfoMc: async () => null,
      now: h.now + 60_000,
    });
    assert.equal(h.telegram.texts.length, 1);
    assert.match(h.telegram.texts[0] ?? "", /\+200%/);
    assert.doesNotMatch(h.telegram.texts[0] ?? "", /\+100%/);
    assert.equal(store.activeRows(h.now)[0]!.last_milestone, 2);
    store.close();
  });

  it("26 小时窗口无入库不发", async () => {
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
    });
    const h = makeHarness({ params });
    const store = memoryStore(params, h.logger);
    const sent = await sendHourlySummary({ store, params, telegram: h.telegram, now: h.now });
    assert.equal(sent, false);
    assert.equal(h.telegram.texts.length, 0);
    store.close();
  });

  it("26b 日窗口无入库不发", async () => {
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
    });
    const h = makeHarness({ params });
    const store = memoryStore(params, h.logger);
    store.insert({
      chain: "sol",
      ca: SOL_CA,
      symbol: "PEPE",
      ts: h.now,
      evidence: { smart_wallets: 2, price_change_1m: 1, buys: 1, sells: 0, volume: 1, swaps: 1, market_cap: 100 },
      l0: {},
      links: { gmgn: "https://x" },
    });
    const sent = await sendDailySummary({ store, params, telegram: h.telegram, now: h.now });
    assert.equal(sent, false);
    store.close();
  });

  it("27 同一 CA 只保留第一行", () => {
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
    });
    const h = makeHarness({ params });
    const store = memoryStore(params, h.logger);
    const sig = {
      chain: "sol" as const,
      ca: SOL_CA,
      symbol: "PEPE",
      ts: h.now,
      evidence: { smart_wallets: 2, price_change_1m: 1, buys: 1, sells: 0, volume: 1, swaps: 1, market_cap: 100 },
      l0: {},
      links: { gmgn: "https://x" },
    };
    assert.equal(store.insert(sig), true);
    assert.equal(
      store.insert({ ...sig, ts: h.now + 400_000, evidence: { ...sig.evidence, market_cap: 200 } }),
      false,
    );
    const rows = store.activeRows(h.now + 400_000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.entry_mc, 100);
    store.close();
  });

  it("30 token info 缺字段 miss", () => {
    assert.equal(tokenInfoMarketCap({ price: {}, circulating_supply: 1 }), null);
    assert.equal(tokenInfoMarketCap({ price: { price: "1" } }), null);
  });

  it("31 / 32 calib_mc 与 implied_mc", async () => {
    assert.equal(impliedMc(100, 180, 120), 150);
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
    });
    const h = makeHarness({ params });
    const store = memoryStore(params, h.logger);
    store.insert({
      chain: "sol",
      ca: SOL_CA,
      symbol: "PEPE",
      ts: h.now,
      evidence: { smart_wallets: 2, price_change_1m: 1, buys: 1, sells: 0, volume: 1, swaps: 1, market_cap: 100 },
      l0: {},
      links: { gmgn: "https://x" },
    });
    let info = 120;
    await runSnapshot({
      store,
      params,
      cache: h.cache,
      telegram: h.telegram,
      fetchInfoMc: async () => info,
      now: h.now,
    });
    let row = store.activeRows(h.now)[0]!;
    assert.equal(row.calib_mc, 120);
    assert.equal(row.max_mc, 100);
    assert.equal(h.telegram.texts.length, 0);
    info = 180;
    await runSnapshot({
      store,
      params,
      cache: h.cache,
      telegram: h.telegram,
      fetchInfoMc: async () => info,
      now: h.now + 60_000,
    });
    row = store.activeRows(h.now)[0]!;
    assert.equal(row.max_mc, 150);
    assert.ok(row.max_mc / row.entry_mc >= 1.5);
    assert.ok(row.max_mc / row.entry_mc < 1.8);
    store.close();
  });
});

describe("金样例 28–29、33–37", () => {
  it("28 / 28b / 28c security 配额与失败", async () => {
    const incomplete = {
      trades: twoBuys(1_700_000_000_000),
      tape: GOOD_TAPE,
      marketCap: 100_000,
    };
    const h = makeHarness({ fetchSecurity: async () => null });
    const ca1 = "SolQuota111111111111111111111111111111111";
    const ca2 = "SolQuota222222222222222222222222222222222";
    const ca3 = "SolQuota333333333333333333333333333333333";
    seed(h, "sol", ca1, incomplete);
    seed(h, "sol", ca2, incomplete);
    seed(h, "sol", ca3, incomplete);
    await evalOf(h, "sol", ca1);
    await evalOf(h, "sol", ca2);
    const r3 = await evalOf(h, "sol", ca3);
    assert.equal(r3.decision, "skip");
    assert.equal(r3.quotaSkipped, true);
    assert.equal(h.quota.isSkipped("sol", ca3), true);
    assert.equal(h.securityCalls.length, 2);

    const bscL0 = { ...L0_BSC };
    delete bscL0.is_honeypot;
    seed(h, "bsc", BSC_CA, { l0: bscL0, trades: twoBuys(h.now), tape: GOOD_TAPE });
    const beforeBsc = h.securityCalls.length;
    await evalOf(h, "bsc", BSC_CA);
    assert.equal(h.securityCalls.length, beforeBsc + 1);
    assert.equal(h.securityCalls.at(-1)?.chain, "bsc");

    const before = h.securityCalls.length;
    await h.pipeline.onWindowEnd();
    assert.ok(h.securityCalls.length > before);
    const hFail = makeHarness({ fetchSecurity: async () => null });
    seed(hFail, "sol", SOL_CA, incomplete);
    const fail = await evalOf(hFail);
    assert.equal(fail.decision, "skip");
    assert.equal(hFail.quota.isSkipped("sol", SOL_CA), false);
  });

  it("33 rug_ratio 超上限 → 丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.mergeL0("sol", SOL_CA, { rug_ratio: 0.9 });
    assert.equal((await evalOf(h)).decision, "drop");
  });

  it("34 BSC 税超上限 → 丢", async () => {
    const h = makeHarness();
    seedReady(h, "bsc", BSC_CA);
    h.cache.mergeL0("bsc", BSC_CA, { buy_tax: 0.2 });
    assert.equal((await evalOf(h, "bsc", BSC_CA)).decision, "drop");
  });

  it("35 窗口内 type 10 → 丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeSignal10("sol", SOL_CA, h.now);
    assert.equal((await evalOf(h)).decision, "drop");
  });

  it("35b type 10 已超时不丢", async () => {
    const h = makeHarness();
    seedReady(h);
    h.cache.writeSignal10("sol", SOL_CA, h.now - 181_000);
    assert.equal((await evalOf(h)).decision, "push");
  });

  it("36 eligible=0 且 L0 缺键不拉 security", async () => {
    const h = makeHarness();
    seed(h, "sol", SOL_CA, { tape: GOOD_TAPE });
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(h.securityCalls.length, 0);
  });

  it("37 快照名额满只 miss 不进 quota_skipped", async () => {
    const params = testParams((p) => {
      p.stats.sqlite_path = ":memory:";
      p.quota.snapshot_per_round.sol = 0;
    });
    const h = makeHarness({ params });
    const store = memoryStore(params, h.logger);
    store.insert({
      chain: "sol",
      ca: SOL_CA,
      symbol: "PEPE",
      ts: h.now,
      evidence: { smart_wallets: 2, price_change_1m: 1, buys: 1, sells: 0, volume: 1, swaps: 1, market_cap: 100 },
      l0: {},
      links: { gmgn: "https://x" },
    });
    const out = await runSnapshot({
      store,
      params,
      cache: h.cache,
      telegram: h.telegram,
      fetchInfoMc: async () => 999,
      now: h.now,
    });
    assert.equal(out.missed, 1);
    assert.equal(h.quota.isSkipped("sol", SOL_CA), false);
    store.close();
  });
});
