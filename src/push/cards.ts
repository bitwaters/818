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

function ticker(signal: Signal): string {
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

function taxPct(value: unknown): string {
  const n = asNumber(value) ?? 0;
  return fmtNum(n * 100);
}

export function renderSignalCard(signal: Signal): string {
  const emoji = signal.chain === "sol" ? "🟣" : "🟡";
  const chain = signal.chain === "sol" ? "SOL" : "BSC";
  const ev = signal.evidence;
  const lines = [
    `${emoji} ${chain}  ${ticker(signal)}`,
    `<code>${escapeHtml(signal.ca)}</code>`,
    "",
    `💰 聪明钱 ${ev.smart_wallets} 地址净买`,
    `📈 1m +${fmtNum(ev.price_change_1m)}% · 买 ${ev.buys} / 卖 ${ev.sells} · $${fmtUsd(ev.volume)} · ${ev.swaps}笔`,
  ];
  if (ev.visiting_count != null) {
    lines.push(`👁 1m ${ev.visiting_count}`);
  }
  if (ev.market_cap != null || ev.liquidity != null) {
    const mc = ev.market_cap != null ? `MC $${fmtUsd(ev.market_cap)}` : "";
    const lp = ev.liquidity != null ? `LP $${fmtUsd(ev.liquidity)}` : "";
    lines.push(`📊 ${[mc, lp].filter(Boolean).join(" · ")}`);
  }
  if (signal.chain === "sol") {
    const mint = isYes(signal.l0.renounced_mint) ? "✓" : "✗";
    const freeze = isYes(signal.l0.renounced_freeze_account) ? "✓" : "✗";
    const rug = fmtNum(asNumber(signal.l0.rug_ratio) ?? 0);
    lines.push(`🛡 mint${mint}  freeze${freeze}  ·  rug ${rug}`);
  } else {
    const owner = isYes(signal.l0.owner_renounced) || isYes(signal.l0.is_renounced) ? "✓" : "✗";
    lines.push(
      `🛡 非貔貅  ·  owner${owner}  ·  买${taxPct(signal.l0.buy_tax)}% / 卖${taxPct(signal.l0.sell_tax)}%`,
    );
  }
  return lines.join("\n");
}

export function signalButton(signal: Signal): { text: string; url: string } {
  const emoji = signal.chain === "sol" ? "🟣" : "🟡";
  return { text: `${emoji} 打开 GMGN`, url: signal.links.gmgn };
}

export function renderMilestoneCard(
  signal: { chain: Signal["chain"]; ca: string; symbol: string },
  entryMc: number,
  maxMc: number,
  k: number,
  step: number,
): string {
  const emoji = signal.chain === "sol" ? "🟣" : "🟡";
  const gainPct = k * step * 100;
  const multiple = maxMc / entryMc;
  const name = signal.symbol ? `$${escapeHtml(signal.symbol)}` : `$${escapeHtml(signal.ca.slice(0, 6))}`;
  return [
    `🚀 ${emoji}  ${name}  +${fmtNum(gainPct)}%`,
    `<code>${escapeHtml(signal.ca)}</code>`,
    `入场 MC $${fmtUsd(entryMc)} → 最高 MC $${fmtUsd(maxMc)}  (${fmtNum(multiple)}x)`,
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
