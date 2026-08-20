import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  GMGN_MIN_GAP_MS,
  gmgnPausedUntil,
  gmgnRequest,
  parseResetAt,
  resetGmgnHttp,
  unwrapList,
} from "../src/gmgn/http.ts";

beforeEach(() => {
  resetGmgnHttp();
});

describe("429 read_reset", () => {
  it("29 读 Reset，禁止忙等，reset 前不重打该请求", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ reset_at: 1_700_000_010 }), {
        status: 429,
        headers: { "X-RateLimit-Reset": "1700000010" },
      });
    };
    const t0 = Date.now();
    const result = await gmgnRequest({
      path: "/v1/token/security",
      apiKey: "test-key",
      fetchImpl,
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "rate_limited");
      assert.equal(result.resetAt, 1_700_000_010_000);
    }
    assert.equal(calls, 1);
    assert.ok(elapsed < 80);
  });

  it("解开 data.data.rank 双层包", () => {
    const body = { code: 0, data: { code: 0, data: { rank: [{ address: "SoL1" }, { address: "SoL2" }] } } };
    assert.equal(unwrapList(body).length, 2);
    assert.equal(unwrapList({ code: 0, data: { list: [1, 2, 3] } }).length, 3);
    assert.equal(unwrapList({ code: 0, data: [{ signal_type: 10 }] }).length, 1);
  });

  it("429 之后后续请求不出网", async () => {
    let calls = 0;
    const resetSec = Math.floor(Date.now() / 1000) + 300;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ reset_at: resetSec }), {
        status: 429,
        headers: { "X-RateLimit-Reset": String(resetSec) },
      });
    };
    await gmgnRequest({ path: "/v1/market/rank", apiKey: "test-key", fetchImpl });
    const second = await gmgnRequest({ path: "/v1/market/rank", apiKey: "test-key", fetchImpl });
    assert.equal(calls, 1);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.kind, "rate_limited");
      assert.equal(second.paused, true);
    }
    assert.ok(gmgnPausedUntil() > Date.now());
  });
});

describe("gmgn 出网队列", () => {
  it("并行请求串行发出且间隔至少 400ms", async () => {
    const started: number[] = [];
    const fetchImpl = async () => {
      started.push(Date.now());
      return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 });
    };
    await Promise.all([
      gmgnRequest({ path: "/v1/a", apiKey: "test-key", fetchImpl }),
      gmgnRequest({ path: "/v1/b", apiKey: "test-key", fetchImpl }),
      gmgnRequest({ path: "/v1/c", apiKey: "test-key", fetchImpl }),
    ]);
    assert.equal(started.length, 3);
    assert.ok(started[1]! - started[0]! >= GMGN_MIN_GAP_MS - 20);
    assert.ok(started[2]! - started[1]! >= GMGN_MIN_GAP_MS - 20);
  });
});
