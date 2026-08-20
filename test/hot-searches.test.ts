import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TokenCache } from "../src/cache.ts";
import { evaluatePass } from "../src/pass.ts";
import { ingestHotSearchGroup, parseHotSearchGroups } from "../src/sources/hot-searches.ts";
import { GOOD_TAPE, L0_SOL, SOL_CA, testParams, twoBuys } from "./helpers.ts";

const OTHER = "SoOther11111111111111111111111111111111111";
const enabled = () => true;

function passAt(cache: TokenCache, now: number) {
  const entry = cache.get("sol", SOL_CA)!;
  return evaluatePass(
    {
      ...entry,
      trades: twoBuys(now),
      tape: GOOD_TAPE,
      l0: { ...L0_SOL },
      market_cap: 100_000,
      market_cap_written_at: now,
    },
    testParams(),
    now,
  );
}

describe("hot-searches 解析", () => {
  it("官方 { data: [{ chain, tokens }] } 按链分桶", () => {
    const groups = parseHotSearchGroups(
      {
        code: 0,
        data: [
          { chain: "sol", interval: "1m", tokens: [{ address: "SoL1", visiting_count: 80 }] },
          { chain: "bsc", interval: "1m", tokens: [{ address: "0xabc", visiting_count: 51 }] },
          { chain: "base", interval: "1m", tokens: [{ address: "0xdef", visiting_count: 99 }] },
        ],
      },
      ["sol", "bsc"],
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.chain, "sol");
    assert.equal(groups[0]?.rows.length, 1);
    assert.equal(groups[1]?.chain, "bsc");
  });

  it("兼容 { sol: [...], bsc: [] } 空桶也返回该链", () => {
    const groups = parseHotSearchGroups(
      { sol: [{ address: "SoL1", visiting_count: 80 }], bsc: [] },
      ["sol", "bsc"],
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.chain, "sol");
    assert.equal(groups[1]?.chain, "bsc");
    assert.equal(groups[1]?.rows.length, 0);
  });

  it("官方空 tokens 仍分出该链", () => {
    const groups = parseHotSearchGroups(
      {
        data: [
          { chain: "sol", interval: "1m", tokens: [{ address: "SoL1", visiting_count: 80 }] },
          { chain: "bsc", interval: "1m", tokens: [] },
        ],
      },
      ["sol", "bsc"],
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[1]?.chain, "bsc");
    assert.equal(groups[1]?.rows.length, 0);
  });
});

describe("hot-searches 入榜不清浏览", () => {
  it("空榜不清低浏览，否决仍在", () => {
    const cache = new TokenCache();
    const now = 1_700_000_000_000;
    cache.writeVisiting("sol", SOL_CA, 80, now);
    const ingest = ingestHotSearchGroup({
      cache,
      groupChain: "sol",
      rows: [],
      now,
      chainEnabled: enabled,
    });
    assert.equal(ingest.present.size, 0);
    assert.equal(cache.get("sol", SOL_CA)?.visiting_count, 80);
    const pass = passAt(cache, now);
    assert.equal(pass.kind, "drop");
    assert.equal(pass.kind === "drop" ? pass.reason : "", "visiting");
  });

  it("在榜但无 visiting_count 仍算在场，保留旧浏览", () => {
    const cache = new TokenCache();
    const now = 1_700_000_000_000;
    cache.writeVisiting("sol", SOL_CA, 80, now);
    const ingest = ingestHotSearchGroup({
      cache,
      groupChain: "sol",
      rows: [{ address: SOL_CA }],
      now,
      chainEnabled: enabled,
    });
    assert.equal(ingest.present.has(SOL_CA), true);
    assert.equal(cache.get("sol", SOL_CA)?.visiting_count, 80);
    const pass = passAt(cache, now);
    assert.equal(pass.kind, "drop");
    assert.equal(pass.kind === "drop" ? pass.reason : "", "visiting");
  });

  it("离榜不清浏览，TTL 内仍否决，过期后视为字段不完整", () => {
    const cache = new TokenCache();
    const now = 1_700_000_000_000;
    cache.writeVisiting("sol", SOL_CA, 80, now);
    ingestHotSearchGroup({
      cache,
      groupChain: "sol",
      rows: [{ address: OTHER, visiting_count: 200 }],
      now,
      chainEnabled: enabled,
    });
    assert.equal(cache.get("sol", SOL_CA)?.visiting_count, 80);
    const stillHot = passAt(cache, now);
    assert.equal(stillHot.kind, "drop");
    assert.equal(stillHot.kind === "drop" ? stillHot.reason : "", "visiting");
    const afterTtl = passAt(cache, now + 200_000);
    assert.deepEqual(afterTtl, { kind: "skip", reason: "visiting_incomplete" });
  });
});
