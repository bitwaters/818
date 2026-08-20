import { TokenCache, cacheKey, normalizeCa } from "./cache.js";
import { checkL0 } from "./l0/index.js";
import { hotPoolLane, isFreshRank1m } from "./hotpool.js";
import type { Logger } from "./logger.js";
import type { Params } from "./params.js";
import { eligibleCount, evaluatePass } from "./pass.js";
import type { TelegramSender } from "./push/telegram.js";
import { QuotaTracker } from "./quota.js";
import { buildSignal } from "./signal.js";
import type { Chain, Decision, DecisionRecord, Signal } from "./types.js";

export interface EvaluateResult {
  decision: Decision;
  reason: string;
  signal?: Signal;
  quotaSkipped?: boolean;
}

export interface PipelineDeps {
  params: Params;
  cache: TokenCache;
  quota: QuotaTracker;
  logger: Logger;
  now: () => number;
  fetchSecurity: (chain: Chain, ca: string) => Promise<Record<string, unknown> | null>;
  telegram: TelegramSender;
  emit: (signal: Signal) => void;
  hasPushedAll: (chain: Chain, ca: string, now: number) => boolean;
  hasAnyPushed: (chain: Chain, ca: string, now: number) => boolean;
  pendingDests: (chain: Chain, ca: string, now: number) => string[];
  markPushedDest: (chain: Chain, ca: string, chatId: string) => void;
  ensureInserted: (signal: Signal) => void;
  recordDecision?: (record: DecisionRecord) => void;
  recordPoolSnapshot?: (chain: Chain, ts: number) => void;
}

export class Pipeline {
  private readonly pending = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: PipelineDeps) {}

  isPending(chain: Chain, ca: string): boolean {
    const key = cacheKey(chain, ca);
    return key ? this.pending.has(key) : false;
  }

  isCooling(chain: Chain, ca: string, now = this.deps.now()): boolean {
    const key = cacheKey(chain, ca);
    if (!key) return false;
    const normalized = normalizeCa(chain, ca);
    if (normalized && this.deps.hasPushedAll(chain, normalized, now)) return true;
    const until = this.cooldownUntil.get(key);
    return until != null && now < until;
  }

  markPending(chain: Chain, ca: string): void {
    const key = cacheKey(chain, ca);
    if (key) this.pending.add(key);
  }

  async onWrite(chain: Chain, ca: string): Promise<EvaluateResult> {
    return this.evaluate(chain, ca);
  }

  recordPoolSnapshot(chain: Chain, ts = this.deps.now()): void {
    this.deps.recordPoolSnapshot?.(chain, ts);
  }

  async onWindowEnd(): Promise<EvaluateResult[]> {
    const results: EvaluateResult[] = [];
    this.deps.quota.resetWindow(this.deps.now());
    for (const { chain, ca } of this.deps.quota.skippedList()) {
      if (!this.deps.cache.has(chain, ca)) {
        this.deps.quota.removeSkipped(chain, ca);
        continue;
      }
      const result = await this.evaluate(chain, ca);
      results.push(result);
      if (result.quotaSkipped) continue;
      this.deps.quota.removeSkipped(chain, ca);
    }
    return results;
  }

  async evaluate(chain: Chain, rawCa: string): Promise<EvaluateResult> {
    const key = cacheKey(chain, rawCa);
    if (!key) return { decision: "skip", reason: "invalid_ca" };
    const result = await this.withLock(key, () => this.evaluateLocked(chain, rawCa, key));
    if (result.decision === "push" && result.signal) {
      const signal = result.signal;
      queueMicrotask(() => {
        try {
          this.deps.emit(signal);
        } catch {
          // 订阅者失败忽略
        }
      });
    }
    return result;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = prev.then(() => gate);
    this.locks.set(key, current);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  private async evaluateLocked(chain: Chain, rawCa: string, key: string): Promise<EvaluateResult> {
    const { params, cache, quota, now: nowFn } = this.deps;
    const now = nowFn();
    cache.pruneTrades(chain, rawCa, now, params.cache.evidence_ttl_sec);
    const entry = cache.get(chain, rawCa);
    if (!entry) return { decision: "skip", reason: "not_in_cache" };
    // 中央门禁：任何来源都不能让非热门代币进入候选漏斗或 security 配额。
    if (params.hot_pool.enabled && !hotPoolLane(entry, params, now)) {
      return {
        decision: "skip",
        reason: isFreshRank1m(entry, params, now)
          ? "tape_5m_incomplete"
          : "hot_1m_incomplete",
      };
    }
    const done = (
      result: EvaluateResult,
      stage: DecisionRecord["stage"],
      at = nowFn(),
    ): EvaluateResult => {
      this.deps.recordDecision?.({
        entry,
        decision: result.decision,
        reason: result.reason,
        stage,
        ts: at,
        quota_skipped: result.quotaSkipped,
      });
      return result;
    };
    const passed = (stage: DecisionRecord["stage"], reason: string, at = nowFn()): void => {
      this.deps.recordDecision?.({ entry, decision: "pass", reason, stage, ts: at });
    };

    if (this.pending.has(key)) return done({ decision: "skip", reason: "pending" }, "cache", now);
    if (this.deps.hasPushedAll(chain, entry.ca, now)) {
      return done({ decision: "skip", reason: "cooldown" }, "cache", now);
    }
    const cool = this.cooldownUntil.get(key);
    if (cool != null && now < cool) {
      return done({ decision: "skip", reason: "cooldown" }, "cache", now);
    }

    // 先跑无需额外 API 的盘口/资金流条件，避免不可能过线的币耗尽 security 配额。
    const prePass = evaluatePass(entry, params, now);
    if (prePass.kind === "skip") {
      return done({ decision: "skip", reason: prePass.reason }, "prepass", now);
    }
    if (prePass.kind === "drop") {
      quota.removeSkipped(chain, entry.ca);
      return done({ decision: "drop", reason: prePass.reason }, "prepass", now);
    }
    passed("prepass", "prepass_pass", now);

    const l0 = checkL0(entry, params, now);
    if (l0.kind === "incomplete") {
      const eligible = eligibleCount(entry, params, now);
      if (params.flow.require_smart_money && eligible === 0) {
        return done({ decision: "skip", reason: "l0_incomplete_no_eligible" }, "security", now);
      }
      if (!quota.canSecurity(chain, now)) {
        quota.addSkipped(chain, entry.ca);
        return done(
          { decision: "skip", reason: "security_quota", quotaSkipped: true },
          "security",
          now,
        );
      }
      quota.consumeSecurity(chain, now);
      const fields = await this.deps.fetchSecurity(chain, entry.ca);
      if (!fields) return done({ decision: "skip", reason: "security_failed" }, "security");
      cache.mergeL0(chain, entry.ca, fields, nowFn());
      const again = checkL0(cache.get(chain, entry.ca)!, params, nowFn());
      if (again.kind === "incomplete") {
        return done({ decision: "skip", reason: "l0_still_incomplete" }, "security");
      }
      if (again.kind === "drop") {
        quota.removeSkipped(chain, entry.ca);
        return done({ decision: "drop", reason: again.reason }, "security");
      }
      passed("security", "l0_pass");
    } else if (l0.kind === "drop") {
      quota.removeSkipped(chain, entry.ca);
      return done({ decision: "drop", reason: l0.reason }, "security", now);
    } else {
      passed("security", "l0_pass", now);
    }

    // security 可能排队或网络延迟；最终发送必须按当前时间重新剪枝和校验 TTL。
    const finalNow = nowFn();
    cache.pruneTrades(chain, entry.ca, finalNow, params.cache.evidence_ttl_sec);
    const finalEntry = cache.get(chain, entry.ca)!;
    const pass = evaluatePass(finalEntry, params, finalNow);
    if (pass.kind === "skip") return done({ decision: "skip", reason: pass.reason }, "final", finalNow);
    if (pass.kind === "drop") {
      quota.removeSkipped(chain, entry.ca);
      return done({ decision: "drop", reason: pass.reason }, "final", finalNow);
    }
    passed("final", "final_pass", finalNow);

    const signal = buildSignal(finalEntry, params, finalNow, pass);
    if (!params.push.telegram_enabled) {
      return done({ decision: "skip", reason: "telegram_disabled", signal }, "delivery", finalNow);
    }

    const pending = this.deps.pendingDests(chain, entry.ca, finalNow);
    if (pending.length === 0) {
      return done({ decision: "skip", reason: "cooldown", signal }, "delivery", finalNow);
    }

    const firstDelivery = !this.deps.hasAnyPushed(chain, entry.ca, finalNow);
    this.pending.add(key);
    let sent: { okIds: string[]; fail: number };
    try {
      sent = await this.deps.telegram.sendSignal(signal, pending);
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : "telegram_failed", chain },
        "telegram signal send threw",
      );
      return done(
        { decision: "skip", reason: "telegram_failed", signal },
        "delivery",
        finalNow,
      );
    } finally {
      this.pending.delete(key);
    }
    for (const chatId of sent.okIds) this.deps.markPushedDest(chain, entry.ca, chatId);
    if (sent.okIds.length === 0) {
      return done({ decision: "skip", reason: "telegram_failed", signal }, "delivery", finalNow);
    }

    this.deps.ensureInserted(signal);
    if (this.deps.hasPushedAll(chain, entry.ca, nowFn())) {
      this.cooldownUntil.set(key, nowFn() + params.cache.push_cooldown_sec * 1000);
    }
    if (!firstDelivery) {
      return done({ decision: "skip", reason: "dest_retry", signal }, "delivery", finalNow);
    }

    quota.removeSkipped(chain, entry.ca);
    return done({ decision: "push", reason: "pass", signal }, "delivery", finalNow);
  }
}
