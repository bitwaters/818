import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withInFlight } from "../src/inflight.ts";
import { QuotaTracker } from "../src/quota.ts";
import { msUntilNextQuotaWindow, quotaWindowId } from "../src/time.ts";
import { L0_SOL, SOL_CA, evalOf, makeHarness, seedReady, testParams } from "./helpers.ts";

describe("审查修复", () => {
  it("H1 重叠 tick 被跳过", async () => {
    let runs = 0;
    const tick = withInFlight("test", async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 30));
    });
    tick();
    tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runs, 1);
  });

  it("H2 emit 在锁外，evaluate 返回后才入库", async () => {
    const h = makeHarness();
    seedReady(h);
    const pendingBeforeEmit: boolean[] = [];
    const orig = h.emitted.push.bind(h.emitted);
    h.emitted.push = ((...args: Parameters<typeof orig>) => {
      pendingBeforeEmit.push(h.pipeline.isPending("sol", SOL_CA));
      return orig(...args);
    }) as typeof orig;
    const r = await evalOf(h);
    assert.equal(r.decision, "push");
    assert.equal(h.emitted.length, 1);
    assert.equal(h.inserted.length, 1);
    assert.deepEqual(pendingBeforeEmit, [false]);
  });

  it("H4 配额按墙钟窗口翻页", () => {
    assert.equal(quotaWindowId(10_000, 10), 1);
    assert.equal(quotaWindowId(19_999, 10), 1);
    assert.equal(quotaWindowId(20_000, 10), 2);
    assert.equal(msUntilNextQuotaWindow(10_000, 10), 10_000);
    assert.equal(msUntilNextQuotaWindow(15_000, 10), 5_000);
    const q = new QuotaTracker(testParams().quota);
    q.resetWindow(10_000);
    q.consumeSecurity("sol", 10_000);
    q.consumeSecurity("sol", 10_000);
    assert.equal(q.canSecurity("sol", 10_000), false);
    assert.equal(q.canSecurity("sol", 20_000), true);
  });

  it("security 延迟跨过 TTL 后重新校验，不发送陈旧信号", async () => {
    let h: ReturnType<typeof makeHarness>;
    h = makeHarness({
      fetchSecurity: async () => {
        h.now += 181_000;
        return L0_SOL;
      },
    });
    seedReady(h);
    h.cache.get("sol", SOL_CA)!.l0 = {};
    const result = await evalOf(h);
    assert.equal(result.decision, "skip");
    assert.equal(result.reason, "tape_incomplete");
    assert.equal(h.telegram.signals.length, 0);
  });
});
