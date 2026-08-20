import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gmgnUrl } from "../src/signal.ts";
import { BASE_PARAMS } from "./helpers.ts";

describe("gmgn_token_url 真 CA path", () => {
  it("8.3 SOL / BSC 模板替换后 path 正确", () => {
    const solCa = "So11111111111111111111111111111111111111112";
    const bscCa = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
    const sol = new URL(gmgnUrl(BASE_PARAMS, "sol", solCa));
    const bsc = new URL(gmgnUrl(BASE_PARAMS, "bsc", bscCa));
    assert.equal(sol.hostname, "gmgn.ai");
    assert.equal(sol.pathname, `/sol/token/${solCa}`);
    assert.equal(bsc.hostname, "gmgn.ai");
    assert.equal(bsc.pathname, `/bsc/token/${bscCa}`);
  });
});
