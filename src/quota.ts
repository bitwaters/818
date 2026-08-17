import type { Params } from "./params.js";
import { quotaWindowId } from "./time.js";
import type { Chain } from "./types.js";

export class QuotaTracker {
  private windowId = Number.NaN;
  private readonly securityUsed: Record<Chain, number> = { sol: 0, bsc: 0 };
  private readonly skipped: Record<Chain, Set<string>> = {
    sol: new Set(),
    bsc: new Set(),
  };

  constructor(private readonly quota: Params["quota"]) {}

  rollIfNeeded(now: number): boolean {
    const id = quotaWindowId(now, this.quota.window_sec);
    if (id === this.windowId) return false;
    this.windowId = id;
    this.securityUsed.sol = 0;
    this.securityUsed.bsc = 0;
    return true;
  }

  resetWindow(now: number): void {
    this.windowId = Number.NaN;
    this.rollIfNeeded(now);
  }

  canSecurity(chain: Chain, now = Date.now()): boolean {
    this.rollIfNeeded(now);
    return this.securityUsed[chain] < this.quota.security_per_round[chain];
  }

  consumeSecurity(chain: Chain, now = Date.now()): void {
    this.rollIfNeeded(now);
    this.securityUsed[chain] += 1;
  }

  addSkipped(chain: Chain, ca: string): void {
    this.skipped[chain].add(ca);
  }

  removeSkipped(chain: Chain, ca: string): void {
    this.skipped[chain].delete(ca);
  }

  isSkipped(chain: Chain, ca: string): boolean {
    return this.skipped[chain].has(ca);
  }

  skippedList(): { chain: Chain; ca: string }[] {
    const out: { chain: Chain; ca: string }[] = [];
    for (const chain of ["sol", "bsc"] as const) {
      for (const ca of this.skipped[chain]) out.push({ chain, ca });
    }
    return out;
  }
}

export class SnapshotQuota {
  private readonly used: Record<Chain, number> = { sol: 0, bsc: 0 };

  constructor(private readonly perRound: Params["quota"]["snapshot_per_round"]) {}

  reset(): void {
    this.used.sol = 0;
    this.used.bsc = 0;
  }

  tryConsume(chain: Chain): boolean {
    if (this.used[chain] >= this.perRound[chain]) return false;
    this.used[chain] += 1;
    return true;
  }
}
