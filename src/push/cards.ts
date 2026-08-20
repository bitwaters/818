import { asNumber, isYes } from "../l0/normalize.js";
import type { Params } from "../params.js";
import type { Signal } from "../types.js";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ticker(signal: { symbol: string; ca: string }): string {
  if (signal.symbol) return `$${escapeHtml(signal.symbol)}`;
  return `$${escapeHtml(signal.ca.slice(0, 6))}`;
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `${fmtNum(n / 1_000_000)}M`;
  if (n >= 1_000) return `${fmtNum(n / 1_000)}k`;
  return fmtNum(n);
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmtNum(n)}%`;
}

function taxPct(value: unknown): string {
  const n = asNumber(value) ?? 0;
  return fmtNum(n * 100);
}

function joinParts(parts: Array<string | undefined>): string | undefined {
  const xs = parts.filter((p): p is string => Boolean(p));
  if (xs.length === 0) return undefined;
  return xs.join("  ·  ");
}

export function renderSignalCard(signal: Signal): string {
  const emoji = signal.chain === "sol" ? "🟣" : "🟡";
  const chain = signal.chain === "sol" ? "SOL" : "BSC";
  const ev = signal.evidence;
  const lines: string[] = [
    `${emoji} <b>${chain}</b>  <b>${ticker(signal)}</b>`,
    "",
    `<code>${escapeHtml(signal.ca)}</code>`,
  ];

  const size = joinParts([
    ev.market_cap != null ? `💰 市值 $${fmtUsd(ev.market_cap)}` : undefined,
    ev.liquidity != null ? `💧 流动性 $${fmtUsd(ev.liquidity)}` : undefined,
  ]);
  if (size) lines.push(size);

  const change = joinParts([
    ev.price_change_1m != null ? `📈 1分钟 <b>${fmtPct(ev.price_change_1m)}</b>` : undefined,
    ev.price_change_5m != null ? `⏱ 5分钟 ${fmtPct(ev.price_change_5m)}` : undefined,
  ]);
  if (change) lines.push(change);

  if (ev.buys != null || ev.sells != null) {
    lines.push(`🟢 买入 ${ev.buys ?? "—"}  ·  🔴 卖出 ${ev.sells ?? "—"}`);
  }
  if (ev.volume != null || ev.swaps != null) {
    const vol = ev.volume != null ? `💵 成交额 $${fmtUsd(ev.volume)}` : undefined;
    const swaps = ev.swaps != null ? `🔢 笔数 ${ev.swaps}` : undefined;
    const row = joinParts([vol, swaps]);
    if (row) lines.push(row);
  }

  const attention = joinParts([
    ev.visiting_count != null ? `👁 浏览 ${ev.visiting_count}` : undefined,
    `👥 聪明钱 ${ev.smart_wallets}`,
  ]);
  if (attention) lines.push(attention);

  if (signal.chain === "sol") {
    const mint = isYes(signal.l0.renounced_mint) ? "✓" : "✗";
    const freeze = isYes(signal.l0.renounced_freeze_account) ? "✓" : "✗";
    const rug = fmtNum(asNumber(signal.l0.rug_ratio) ?? 0);
    lines.push(`🛡 Mint ${mint}  Freeze ${freeze}  Rug ${rug}`);
  } else {
    const owner = isYes(signal.l0.owner_renounced) || isYes(signal.l0.is_renounced) ? "✓" : "✗";
    lines.push(`🛡 非貔貅  ·  Owner ${owner}`);
    lines.push(`🛡 买入税 ${taxPct(signal.l0.buy_tax)}%  ·  卖出税 ${taxPct(signal.l0.sell_tax)}%`);
  }
  return lines.join("\n");
}

export function signalButton(signal: Signal): { text: string; url: string } {
  const emoji = signal.chain === "sol" ? "🟣" : "🟡";
  const chain = signal.chain === "sol" ? "SOL" : "BSC";
  return { text: `${emoji} ${chain} · GMGN`, url: signal.links.gmgn };
}

export function renderMilestoneCard(
  opts: {
    signal: {
      chain: Signal["chain"];
      ca: string;
      symbol: string;
      ts: number;
      rank1m: number | null;
      rank5m: number | null;
      visiting: number | null;
    };
    entryMc: number;
    currentMc: number;
    maxMc: number;
    reachedTier: number;
    crossedTiers: number[];
    reachedAt: number;
    timeZone: string;
    gmgnUrl: string;
  },
): string {
  const { signal } = opts;
  const emoji = signal.chain === "sol" ? "🟣" : "🟡";
  const chain = signal.chain === "sol" ? "SOL" : "BSC";
  const multiple = opts.maxMc / opts.entryMc;
  const gainPct = (multiple - 1) * 100;
  const elapsed = Math.max(0, opts.reachedAt - signal.ts);
  const duration = elapsed < 3_600_000
    ? `${Math.max(1, Math.round(elapsed / 60_000))}m`
    : `${fmtNum(elapsed / 3_600_000)}h`;
  const rank = joinParts([
    signal.rank1m != null ? `1m #${signal.rank1m}` : undefined,
    signal.rank5m != null ? `5m #${signal.rank5m}` : undefined,
    signal.visiting != null ? `👁 浏览 ${signal.visiting}` : undefined,
  ]);
  const crossed = opts.crossedTiers.map((tier) => `${fmtNum(tier)}x`).join(" · ");
  const linkedTicker = `<a href="${escapeHtml(opts.gmgnUrl)}"><b>${ticker(signal)}</b></a>`;
  const lines = [
    `🔥 ${emoji} <b>${chain}</b>  ${linkedTicker} 达到 <b>${fmtNum(opts.reachedTier)}x</b>`,
    `信号后最高 <b>${fmtNum(multiple)}x</b>（${fmtPct(gainPct)}）`,
    `入场 $${fmtUsd(opts.entryMc)}  ·  当前 $${fmtUsd(opts.currentMc)}  ·  最高 $${fmtUsd(opts.maxMc)}`,
    `达到用时 ${duration}  ·  本次跨越 ${crossed}`,
    `首次信号 ${dateTimeText(signal.ts, opts.timeZone)}`,
  ];
  if (rank) lines.push(rank);
  lines.push(`<code>${escapeHtml(signal.ca)}</code>`);
  return lines.join("\n");
}

export interface ReportToken {
  id: number;
  chain: Signal["chain"];
  ca: string;
  symbol: string;
  entryMc: number;
  peakMultiple: number | null;
  currentMultiple: number | null;
  gmgnUrl: string;
}

export interface PerformanceSummary {
  n: number;
  tracked: number;
  hit: number;
  hitMultiple: number;
  medianPeak: number | null;
  medianCurrent: number | null;
  drawdown: number;
  distribution: { x1_2: number; x1_5: number; x2: number };
  all: ReportToken[];
  top: ReportToken[];
  bottom: ReportToken[];
  omitted: number;
}

function dateTimeText(ts: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function multipleText(value: number | null): string {
  return value == null ? "—" : `${fmtNum(value)}x`;
}

function renderTokenRow(token: ReportToken, index: number): string {
  const emoji = token.chain === "sol" ? "🟣" : "🟡";
  const name = token.symbol ? `$${escapeHtml(token.symbol)}` : `$${escapeHtml(token.ca.slice(0, 6))}`;
  return `${index}. ${emoji} <a href="${escapeHtml(token.gmgnUrl)}"><b>${name}</b></a> · 信号后最高 ${multipleText(token.peakMultiple)} · 当前 ${multipleText(token.currentMultiple)} · 入场 $${fmtUsd(token.entryMc)}`;
}

function renderPerformanceReport(opts: {
  title: string;
  summary: PerformanceSummary;
  fullList: boolean;
}): string {
  const s = opts.summary;
  const hitRate = s.tracked === 0 ? null : (s.hit / s.tracked) * 100;
  const drawdownRate = s.tracked === 0 ? null : (s.drawdown / s.tracked) * 100;
  const lines = [
    opts.title,
    `信号 ${s.n}  ·  已跟踪 ${s.tracked}`,
    `≥${fmtNum(s.hitMultiple)}x ${s.hit}  ·  命中率 ${hitRate == null ? "—" : `${fmtNum(hitRate)}%`}`,
    `中位最高 ${multipleText(s.medianPeak)}  ·  中位当前 ${multipleText(s.medianCurrent)}`,
    `跌破 0.8x ${s.drawdown}  ·  回撤率 ${drawdownRate == null ? "—" : `${fmtNum(drawdownRate)}%`}`,
    `分布  ≥1.2x ${s.distribution.x1_2}  |  ≥1.5x ${s.distribution.x1_5}  |  ≥2x ${s.distribution.x2}`,
  ];

  if (opts.fullList) {
    lines.push("", "📋 <b>全部信号</b>");
    s.all.forEach((token, index) => lines.push(renderTokenRow(token, index + 1)));
  } else {
    if (s.top.length > 0) {
      lines.push("", "🏆 <b>信号后最高 Top</b>");
      s.top.forEach((token, index) => lines.push(renderTokenRow(token, index + 1)));
    }
    if (s.bottom.length > 0) {
      lines.push("", "📉 <b>当前表现 Bottom</b>");
      s.bottom.forEach((token, index) => lines.push(renderTokenRow(token, index + 1)));
    }
    if (s.omitted > 0) lines.push(`其余 ${s.omitted} 个信号未展开`);
  }
  return lines.join("\n");
}

export function renderHourlySummary(opts: {
  hourLabel: string;
  summary: PerformanceSummary;
}): string {
  return renderPerformanceReport({
    title: `📊 <b>小时战报</b>｜${escapeHtml(opts.hourLabel)}`,
    summary: opts.summary,
    fullList: opts.summary.n <= 10,
  });
}

export function renderDailySummary(opts: {
  dateLabel: string;
  summary: PerformanceSummary;
}): string {
  return renderPerformanceReport({
    title: `📊 <b>日报</b>｜${escapeHtml(opts.dateLabel)}`,
    summary: opts.summary,
    fullList: false,
  });
}

export function hitPct(params: Params): number {
  return (params.stats.hit_multiple - 1) * 100;
}
