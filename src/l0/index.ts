import type { Params } from "../params.js";
import type { CacheEntry, L0Status } from "../types.js";
import { checkBscL0 } from "./bsc.js";
import { checkSolL0 } from "./sol.js";

export function checkL0(entry: CacheEntry, params: Params, now: number): L0Status {
  const ttl = params.cache.evidence_ttl_sec;
  if (entry.chain === "sol") return checkSolL0(entry, params.l0_sol, now, ttl);
  return checkBscL0(entry, params.l0_bsc, now, ttl);
}

export { checkBscL0 } from "./bsc.js";
export { checkSolL0 } from "./sol.js";
