import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { isMainModule } from "../src/is-main.ts";
import { loadParams, parseParams } from "../src/params.ts";
import { parseSide, parseTrade, tokenAddress } from "../src/sources/parse.ts";
import { evalOf, makeHarness, seedReady, testParams } from "./helpers.ts";

describe("参数与发送开关", () => {
  it("2.1 从 params.yaml 加载并通过 Zod", () => {
    const params = loadParams();
    assert.equal(params.flow.min_smart_wallets, 2);
    assert.equal(params.pass.visiting_can_boost, false);
    assert.equal(params.attention.min_visiting_count, 100);
    assert.equal(params.tape.min_price_change_1m, 20);
    assert.equal(params.tape.max_price_change_1m, 200);
    assert.equal(params.tape.min_volume_market_cap_ratio, 0.5);
    assert.equal(params.tape.max_volume_market_cap_ratio, 2);
    assert.equal(params.pass.signal_enabled.sol, false);
    assert.equal(params.pass.signal_enabled.bsc, true);
    assert.equal(params.pass.min_entry_mc.sol, 10000);
    assert.equal(params.pass.min_entry_mc.bsc, 0);
    assert.equal(params.tape.max_buy_sell_ratio, 3);
    assert.equal(params.quota.on_429, "read_reset");
    assert.equal(params.stats.timezone, "Asia/Shanghai");
    assert.equal(params.trace.enabled, true);
  });

  it("缺 trace 整段时用默认关闭轨迹，不抛错", () => {
    const raw = parse(readFileSync(resolve(process.cwd(), "params.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    delete raw.trace;
    const params = parseParams(raw);
    assert.equal(params.trace.enabled, false);
    assert.equal(params.trace.min_gap_ms, 5000);
    assert.equal(params.trace.watch_max_sec, 43200);
  });

  it("6.3 telegram_enabled=false 不发送不冷却不 emit 不入库", async () => {
    const h = makeHarness({
      params: testParams((p) => {
        p.push.telegram_enabled = false;
      }),
    });
    seedReady(h);
    const r = await evalOf(h);
    assert.equal(r.decision, "skip");
    assert.equal(h.telegram.signals.length, 0);
    assert.equal(h.emitted.length, 0);
    assert.equal(h.inserted.length, 0);
    assert.equal(h.pipeline.isCooling("sol", "SoLTest11111111111111111111111111111111112", h.now), false);
  });

  it("相对路径入口也视为 main", () => {
    const abs = resolve("dist/index.js");
    assert.equal(isMainModule(pathToFileURL(abs).href, "dist/index.js"), true);
    assert.equal(isMainModule(pathToFileURL(abs).href, "/tmp/other.js"), false);
  });

  it("聪明钱 address 只当 CA，不当钱包", () => {
    const row = {
      address: "So11111111111111111111111111111111111111112",
      wallet_address: "Wallet111",
      side: "buy",
      price_change: 1.2,
      timestamp: 1_700_000_000_000,
    };
    assert.equal(tokenAddress(row), row.address);
    assert.equal(parseTrade(row, row.timestamp)?.wallet, "Wallet111");
    assert.equal(parseTrade({ address: row.address, side: "buy", price_change: 1.2 }, 0), null);
  });

  it("官方 smartmoney 字段 maker/base_address，side 可为数字", () => {
    const row = {
      maker: "WalletSM",
      base_address: "So11111111111111111111111111111111111111112",
      side: "buy",
      price_change: 1.2,
      timestamp: 1_700_000_000,
    };
    assert.equal(tokenAddress(row), row.base_address);
    assert.equal(parseTrade(row, 0)?.wallet, "WalletSM");
    assert.equal(parseTrade(row, 0)?.price_change, 1.2);
    assert.equal(parseSide(1), "buy");
    assert.equal(parseSide(0), "sell");
    assert.equal(parseTrade({ maker: "W", side: 1 }, 0)?.side, "buy");
  });
});
