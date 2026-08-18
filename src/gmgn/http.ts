import { randomUUID } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";

export const GMGN_HOST = "https://openapi.gmgn.ai";
export const GMGN_MIN_GAP_MS = 400;
export const GMGN_MIN_PAUSE_MS = 60_000;

const ipv4Agent = new Agent({ connect: { family: 4 } });

export type GmgnOk<T> = { ok: true; data: T; status: number };
export type GmgnRateLimited = { ok: false; kind: "rate_limited"; resetAt: number; paused?: boolean };
export type GmgnErr = { ok: false; kind: "error"; status?: number; message?: string };
export type GmgnResult<T = unknown> = GmgnOk<T> | GmgnRateLimited | GmgnErr;

export interface GmgnRequest {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  apiKey: string;
  fetchImpl?: (url: URL | string, init?: Parameters<typeof undiciFetch>[1]) => Promise<Response>;
}

let pausedUntil = 0;
let pauseLogged = false;
let lastDispatchAt = 0;
let tail: Promise<unknown> = Promise.resolve();

export function resetGmgnHttp(): void {
  pausedUntil = 0;
  pauseLogged = false;
  lastDispatchAt = 0;
  tail = Promise.resolve();
}

export function gmgnPausedUntil(): number {
  return pausedUntil;
}

export function shouldLogGmgnFail(result: GmgnResult): boolean {
  if (result.ok) return false;
  return result.kind !== "rate_limited" || !result.paused;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logPause(until: number): void {
  if (pauseLogged) return;
  pauseLogged = true;
  console.warn(
    JSON.stringify({
      level: 40,
      time: Date.now(),
      msg: "gmgn paused until reset",
      resetAt: until,
    }),
  );
}

function logResume(): void {
  console.warn(
    JSON.stringify({
      level: 30,
      time: Date.now(),
      msg: "gmgn resume",
    }),
  );
}

function armPause(resetAt: number, now: number): number {
  const until = resetAt > now ? resetAt : now + GMGN_MIN_PAUSE_MS;
  if (until > pausedUntil) pausedUntil = until;
  logPause(pausedUntil);
  return pausedUntil;
}

export function parseResetAt(
  headers: { get(name: string): string | null },
  body: unknown,
  now = Date.now(),
): number {
  const header = headers.get("x-ratelimit-reset") ?? headers.get("X-RateLimit-Reset");
  const fromHeader = header ? Number(header) : NaN;
  const fromBody =
    body && typeof body === "object" && "reset_at" in body
      ? Number((body as { reset_at: unknown }).reset_at)
      : NaN;
  const raw = Number.isFinite(fromHeader) ? fromHeader : fromBody;
  if (!Number.isFinite(raw)) return now;
  return raw > 1e12 ? raw : raw * 1000;
}

async function dispatch<T>(req: GmgnRequest): Promise<GmgnResult<T>> {
  const now = Date.now();
  if (now < pausedUntil) {
    return { ok: false, kind: "rate_limited", resetAt: pausedUntil, paused: true };
  }
  if (pauseLogged) {
    pauseLogged = false;
    logResume();
  }
  const wait = lastDispatchAt + GMGN_MIN_GAP_MS - now;
  if (wait > 0) await sleep(wait);
  lastDispatchAt = Date.now();

  const url = new URL(req.path, GMGN_HOST);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const clientId = randomUUID();
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("client_id", clientId);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const fetchImpl = req.fetchImpl ?? undiciFetch;
  type MiniRes = {
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    text: () => Promise<string>;
  };
  let res: MiniRes;
  try {
    res = (await fetchImpl(url, {
      method: req.method ?? "GET",
      headers: {
        "X-APIKEY": req.apiKey,
        ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      dispatcher: ipv4Agent,
    })) as MiniRes;
  } catch (err) {
    return { ok: false, kind: "error", message: err instanceof Error ? err.message : "network" };
  }

  let body: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (res.status === 429) {
    const resetAt = parseResetAt(res.headers, body);
    armPause(resetAt, Date.now());
    return { ok: false, kind: "rate_limited", resetAt };
  }
  if (!res.ok) {
    return { ok: false, kind: "error", status: res.status, message: "http_error" };
  }
  return { ok: true, data: body as T, status: res.status };
}

export async function gmgnRequest<T = unknown>(req: GmgnRequest): Promise<GmgnResult<T>> {
  const run = tail.then(() => dispatch<T>(req), () => dispatch<T>(req));
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function unwrapList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["data", "list", "rank", "ranks", "tokens", "items", "result"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        const inner = v as Record<string, unknown>;
        for (const k of ["list", "rank", "ranks", "tokens", "items"]) {
          if (Array.isArray(inner[k])) return inner[k] as unknown[];
        }
      }
    }
  }
  return [];
}

export function strField(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function numField(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = row[key];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
