import { TokenCache, cacheKey, normalizeCa } from "./cache.js";
import { checkL0 } from "./l0/index.js";
import type { Logger } from "./logger.js";
import type { Params } from "./params.js";
import { eligibleCount, evaluatePass } from "./pass.js";
import type { TelegramSender } from "./push/telegram.js";
import { QuotaTracker } from "./quota.js";
import { buildSignal } from "./signal.js";
import type { Chain, Decision, Signal } from "./types.js";

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
  hasPushedAll: (chain: Chain, ca: string) => boolean;
  hasAnyPushed: (chain: Chain, ca: string) => boolean;
  pendingDests: (chain: Chain, ca: string) => string[];
  markPushedDest: (chain: Chain, ca: string, chatId: string) => void;
  ensureInserted: (signal: Signal) => void;
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
    if (normalized && this.deps.hasPushedAll(chain, normalized)) return true;
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

    if (this.pending.has(key)) return { decision: "skip", reason: "pending" };
    if (this.deps.hasPushedAll(chain, entry.ca)) {
      this.deps.ensureInserted(buildSignal(entry, params, now, evaluatePass(entry, params, now)));
      return { decision: "skip", reason: "already_pushed" };
    }
    const cool = this.cooldownUntil.get(key);
    if (cool != null && now < cool) return { decision: "skip", reason: "cooldown" };

    // 先跑无需额外 API 的盘口/资金流条件，避免不可能过线的币耗尽 security 配额。
    const prePass = evaluatePass(entry, params, now);
    if (prePass.kind === "skip") return { decision: "skip", reason: prePass.reason };
    if (prePass.kind === "drop") {
      quota.removeSkipped(chain, entry.ca);
      return { decision: "drop", reason: prePass.reason };
    }

    const l0 = checkL0(entry, params, now);
    if (l0.kind === "incomplete") {
      const eligible = eligibleCount(entry, params, now);
      if (eligible === 0) return { decision: "skip", reason: "l0_incomplete_no_eligible" };
      if (!quota.canSecurity(chain, now)) {
        quota.addSkipped(chain, entry.ca);
        return { decision: "skip", reason: "security_quota", quotaSkipped: true };
      }
      quota.consumeSecurity(chain, now);
      const fields = await this.deps.fetchSecurity(chain, entry.ca);
      if (!fields) return { decision: "skip", reason: "security_failed" };
      cache.mergeL0(chain, entry.ca, fields);
      const again = checkL0(cache.get(chain, entry.ca)!, params, nowFn());
      if (again.kind === "incomplete") return { decision: "skip", reason: "l0_still_incomplete" };
      if (again.kind === "drop") {
        quota.removeSkipped(chain, entry.ca);
        return { decision: "drop", reason: again.reason };
      }
    } else if (l0.kind === "drop") {
      quota.removeSkipped(chain, entry.ca);
      return { decision: "drop", reason: l0.reason };
    }

    // security 可能排队或网络延迟；最终发送必须按当前时间重新剪枝和校验 TTL。
    const finalNow = nowFn();
    cache.pruneTrades(chain, entry.ca, finalNow, params.cache.evidence_ttl_sec);
    const finalEntry = cache.get(chain, entry.ca)!;
    const pass = evaluatePass(finalEntry, params, finalNow);
    if (pass.kind === "skip") return { decision: "skip", reason: pass.reason };
    if (pass.kind === "drop") {
      quota.removeSkipped(chain, entry.ca);
      return { decision: "drop", reason: pass.reason };
    }

    const signal = buildSignal(finalEntry, params, finalNow, pass);
    if (!params.push.telegram_enabled) {
      return { decision: "skip", reason: "telegram_disabled", signal };
    }

    const pending = this.deps.pendingDests(chain, entry.ca);
    if (pending.length === 0) {
      this.deps.ensureInserted(signal);
      return { decision: "skip", reason: "already_pushed", signal };
    }

    const firstDelivery = !this.deps.hasAnyPushed(chain, entry.ca);
    this.pending.add(key);
    const sent = await this.deps.telegram.sendSignal(signal, pending);
    this.pending.delete(key);
    for (const chatId of sent.okIds) this.deps.markPushedDest(chain, entry.ca, chatId);
    if (sent.okIds.length === 0) return { decision: "skip", reason: "telegram_failed", signal };

    this.deps.ensureInserted(signal);
    if (!firstDelivery) return { decision: "skip", reason: "dest_retry", signal };

    this.cooldownUntil.set(key, nowFn() + params.cache.push_cooldown_sec * 1000);
    quota.removeSkipped(chain, entry.ca);
    return { decision: "push", reason: "pass", signal };
  }
}
