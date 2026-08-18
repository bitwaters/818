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
    `📈 1分钟 <b>${fmtPct(ev.price_change_1m)}</b>`,
    ev.price_change_5m != null ? `⏱ 5分钟 ${fmtPct(ev.price_change_5m)}` : undefined,
  ]);
  if (change) lines.push(change);

  lines.push(`🟢 买入 ${ev.buys}  ·  🔴 卖出 ${ev.sells}`);
  lines.push(`💵 成交额 $${fmtUsd(ev.volume)}  ·  🔢 笔数 ${ev.swaps}`);

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
  signal: { chain: Signal["chain"]; ca: string; symbol: string },
  entryMc: number,
  maxMc: number,
  k: number,
  step: number,
): string {
  const emoji = signal.chain === "sol" ? "🟣" : "🟡";
  const chain = signal.chain === "sol" ? "SOL" : "BSC";
  const gainPct = k * step * 100;
  const multiple = maxMc / entryMc;
  return [
    `🚀 ${emoji} ${chain}  ${ticker(signal)}  +${fmtNum(gainPct)}%`,
    `<code>${escapeHtml(signal.ca)}</code>`,
    `入场市值 $${fmtUsd(entryMc)} → 最高市值 $${fmtUsd(maxMc)}  (${fmtNum(multiple)}x)`,
  ].join("\n");
}

export function renderHourlySummary(opts: {
  hourLabel: string;
  n: number;
  hit: number;
  hitMultiple: number;
  top?: { multiple: number; symbol: string };
}): string {
  const hitPct = (opts.hitMultiple - 1) * 100;
  const pct = opts.n === 0 ? 0 : (opts.hit / opts.n) * 100;
  const lines = [
    `📊 小时汇总  ${opts.hourLabel}`,
    `今日入库 ${opts.n}`,
    `命中(≥${fmtNum(hitPct)}%) ${opts.hit}`,
    `命中率 ${fmtNum(pct)}%`,
  ];
  if (opts.top) {
    const name = opts.top.symbol ? `$${escapeHtml(opts.top.symbol)}` : "";
    lines.push(`最高 ${fmtNum(opts.top.multiple)}x  ${name}`.trimEnd());
  }
  return lines.join("\n");
}

export function renderDailySummary(opts: {
  dateLabel: string;
  n: number;
  hit: number;
  hitMultiple: number;
  top?: { multiple: number; symbol: string };
}): string {
  const hitPct = (opts.hitMultiple - 1) * 100;
  const pct = opts.n === 0 ? 0 : (opts.hit / opts.n) * 100;
  const lines = [
    `📊 日汇总  ${opts.dateLabel}`,
    `入库 ${opts.n}`,
    `命中(≥${fmtNum(hitPct)}%) ${opts.hit}`,
    `命中率 ${fmtNum(pct)}%`,
  ];
  if (opts.top) {
    const name = opts.top.symbol ? `$${escapeHtml(opts.top.symbol)}` : "";
    lines.push(`最高 ${fmtNum(opts.top.multiple)}x  ${name}`.trimEnd());
  }
  return lines.join("\n");
}

export function hitPct(params: Params): number {
  return (params.stats.hit_multiple - 1) * 100;
}
