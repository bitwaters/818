export function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

export function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key) && !isMissing(record[key]);
}

export function asNumber(value: unknown): number | undefined {
  if (isMissing(value)) return undefined;
  if (value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function isYes(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (typeof value === "string" && value.toLowerCase() === "yes") return true;
  return false;
}

export function isNo(value: unknown): boolean {
  if (value === false || value === 0 || value === "0") return true;
  if (typeof value === "string" && value.toLowerCase() === "no") return true;
  return false;
}

export function isExplicitNotHoneypot(value: unknown): boolean {
  return isNo(value);
}

export function bundlerPresent(record: Record<string, unknown>): boolean {
  return hasKey(record, "bundler_rate") || hasKey(record, "bundler_trader_amount_rate");
}

export function bundlerRate(record: Record<string, unknown>): number | undefined {
  const rates: number[] = [];
  if (hasKey(record, "bundler_rate")) {
    const n = asNumber(record.bundler_rate);
    if (n != null) rates.push(n);
  }
  if (hasKey(record, "bundler_trader_amount_rate")) {
    const n = asNumber(record.bundler_trader_amount_rate);
    if (n != null) rates.push(n);
  }
  if (rates.length === 0) return undefined;
  return Math.max(...rates);
}

export function ownerRenouncedPresent(record: Record<string, unknown>): boolean {
  return hasKey(record, "owner_renounced") || hasKey(record, "is_renounced");
}

export function ownerIsRenounced(record: Record<string, unknown>): boolean {
  if (hasKey(record, "owner_renounced")) return isYes(record.owner_renounced);
  if (hasKey(record, "is_renounced")) return isYes(record.is_renounced);
  return false;
}

export function openSourcePresent(record: Record<string, unknown>): boolean {
  return hasKey(record, "open_source") || hasKey(record, "is_open_source");
}

export function isOpenSource(record: Record<string, unknown>): boolean {
  if (hasKey(record, "open_source")) return isYes(record.open_source);
  if (hasKey(record, "is_open_source")) return isYes(record.is_open_source);
  return false;
}

export function lockPercent(record: Record<string, unknown>): number | undefined {
  if (hasKey(record, "lock_percent")) return asNumber(record.lock_percent);
  if (hasKey(record, "lp_lock_percent")) return asNumber(record.lp_lock_percent);
  return undefined;
}

export function lockPresent(record: Record<string, unknown>): boolean {
  return hasKey(record, "lock_percent") || hasKey(record, "lp_lock_percent");
}

export function signal10Active(at: number | undefined, now: number, ttlSec: number): boolean {
  if (at == null) return false;
  return now - at < ttlSec * 1000;
}
