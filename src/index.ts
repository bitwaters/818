import { TokenCache, usableMarketCap } from "./cache.js";
import { Pipeline } from "./core.js";
import { isMainModule } from "./is-main.js";
import { loadEnv, telegramDestinations } from "./env.js";
import { createLogger } from "./logger.js";
import { loadParams } from "./params.js";
import { TelegramPusher } from "./push/telegram.js";
import { PushedLedger } from "./pushed.js";
import { QuotaTracker } from "./quota.js";
import { resetAnalyticsOnce } from "./reset.js";
import { fetchTokenSecurity } from "./sources/security.js";
import { startHotSearches } from "./sources/hot-searches.js";
import { startSignal } from "./sources/signal.js";
import { startSmartmoney } from "./sources/smartmoney.js";
import { withInFlight } from "./inflight.js";
import { fetchTokenInfoMc } from "./sources/token-info.js";
import { startTrending } from "./sources/trending.js";
import { openSqlite } from "./sqlite.js";
import { runSnapshot, sendDailySummary, sendHourlySummary, StatsStore } from "./stats.js";
import { TickRecorder } from "./trace.js";
import { msUntilNextHour, msUntilNextMidnight, msUntilNextQuotaWindow } from "./time.js";
import type { Signal } from "./types.js";

export function start(opts?: { paramsPath?: string }): {
  stop: () => void;
  onSignal: (fn: (signal: Signal) => void) => void;
} {
  const params = loadParams(opts?.paramsPath);
  const env = loadEnv();
  const logger = createLogger();
  const quota = new QuotaTracker(params.quota);
  quota.resetWindow(Date.now());
  const dests = telegramDestinations(env);
  const telegram = new TelegramPusher(
    env.TELEGRAM_BOT_TOKEN,
    dests,
    logger,
    params.push.parse_mode,
  );
  const sqlite = openSqlite(params.stats.sqlite_path);
  const store = params.stats.enabled ? new StatsStore(params, logger, sqlite) : null;
  const pushed = new PushedLedger(sqlite, dests);
  const trace = params.trace.enabled ? new TickRecorder(sqlite, params, logger) : null;
  resetAnalyticsOnce(sqlite, params.rules.reset_id, params.rules.version, Date.now(), logger);
  const cache = new TokenCache((entry) => {
    trace?.note(entry, Date.now(), pushed.hasAll(entry.chain, entry.ca));
  });
  const listeners: Array<(signal: Signal) => void> = [];

  const onSignal = (fn: (signal: Signal) => void) => {
    listeners.push(fn);
  };

  const pipeline = new Pipeline({
    params,
    cache,
    quota,
    logger,
    now: Date.now,
    fetchSecurity: (chain, ca) => fetchTokenSecurity(env, chain, ca),
    telegram,
    hasPushedAll: (chain, ca) => pushed.hasAll(chain, ca),
    hasAnyPushed: (chain, ca) => pushed.hasAny(chain, ca),
    pendingDests: (chain, ca) => pushed.pendingDests(chain, ca),
    markPushedDest: (chain, ca, chatId) => pushed.markDest(chain, ca, chatId, Date.now()),
    ensureInserted: (signal) => {
      if (!store) return;
      const entry = cache.get(signal.chain, signal.ca);
      const mc =
        signal.evidence.market_cap ??
        (entry ? usableMarketCap(entry, Date.now(), params.cache.evidence_ttl_sec) : undefined);
      if (mc == null || !(mc > 0)) return;
      store.insertIfAbsent({
        ...signal,
        evidence: { ...signal.evidence, market_cap: mc },
      });
    },
    recordDecision: (record) => trace?.noteDecision(record),
    recordPoolSnapshot: (chain, ts) => trace?.notePoolSnapshot(cache, chain, ts),
    emit: (signal) => {
      for (const fn of listeners) {
        try {
          fn(signal);
        } catch {
          // 订阅者失败忽略，不回滚 pushed
        }
      }
    },
  });

  const shared = { params, env, cache, pipeline, logger };
  const stops = [
    startSmartmoney(shared),
    startTrending(shared),
    startSignal(shared),
    startHotSearches(shared),
  ];

  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  const runWindow = withInFlight("quota-window", () => pipeline.onWindowEnd().then(() => undefined));
  const scheduleWindow = () => {
    windowTimer = setTimeout(() => {
      runWindow();
      scheduleWindow();
    }, msUntilNextQuotaWindow(Date.now(), params.quota.window_sec));
  };
  scheduleWindow();
  trace?.start();

  let snapshotTimer: ReturnType<typeof setInterval> | undefined;
  let hourTimer: ReturnType<typeof setTimeout> | undefined;
  let dayTimer: ReturnType<typeof setTimeout> | undefined;

  if (store) {
    const runSnap = withInFlight("snapshot", async () => {
      await runSnapshot({
        store,
        params,
        cache,
        telegram,
        fetchInfoMc: (chain, ca) => fetchTokenInfoMc(env, chain, ca),
        now: Date.now(),
      });
    });
    snapshotTimer = setInterval(runSnap, params.stats.snapshot_sec * 1000);

    const scheduleHour = () => {
      hourTimer = setTimeout(() => {
        void sendHourlySummary({ store, params, telegram, now: Date.now() });
        scheduleHour();
      }, msUntilNextHour(Date.now(), params.stats.timezone));
    };
    const scheduleDay = () => {
      dayTimer = setTimeout(() => {
        void sendDailySummary({ store, params, telegram, now: Date.now() });
        scheduleDay();
      }, msUntilNextMidnight(Date.now(), params.stats.timezone));
    };
    scheduleHour();
    scheduleDay();
  }

  logger.info(
    { chains: params.chains, telegramDestinations: dests.length, trace: params.trace.enabled },
    "meme-signal-pusher started",
  );

  return {
    onSignal,
    stop: () => {
      for (const stop of stops) stop();
      if (windowTimer) clearTimeout(windowTimer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (hourTimer) clearTimeout(hourTimer);
      if (dayTimer) clearTimeout(dayTimer);
      trace?.stop();
      store?.close();
      sqlite.close();
    },
  };
}

if (isMainModule(import.meta.url)) {
  start();
}
