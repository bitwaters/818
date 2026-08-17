export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(ts: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export function dateKey(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const utc = Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days);
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function msUntilNextHour(now: number, timeZone: string): number {
  const p = zonedParts(now, timeZone);
  const elapsed = (p.minute * 60 + p.second) * 1000 + (now % 1000);
  return 3600 * 1000 - elapsed;
}

export function msUntilNextMidnight(now: number, timeZone: string): number {
  const p = zonedParts(now, timeZone);
  const elapsed = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (now % 1000);
  return 24 * 3600 * 1000 - elapsed;
}

export function quotaWindowId(now: number, windowSec: number): number {
  return Math.floor(now / (windowSec * 1000));
}

export function msUntilNextQuotaWindow(now: number, windowSec: number): number {
  const ms = windowSec * 1000;
  const rem = now % ms;
  return rem === 0 ? ms : ms - rem;
}

export function hourLabel(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${String(p.hour).padStart(2, "0")}:00`;
}
