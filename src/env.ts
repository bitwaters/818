import { config } from "dotenv";

export interface Env {
  GMGN_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_GROUP_ID: string;
  TELEGRAM_CHANNEL_ID: string;
}

const REQUIRED = ["GMGN_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
const OPTIONAL = ["TELEGRAM_GROUP_ID", "TELEGRAM_CHANNEL_ID"] as const;

export function parseTelegramChatIds(...chunks: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const part of chunk.split(/[,;\s]+/)) {
      const id = part.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function telegramDestinations(env: Env): string[] {
  return parseTelegramChatIds(env.TELEGRAM_CHAT_ID, env.TELEGRAM_GROUP_ID, env.TELEGRAM_CHANNEL_ID);
}

export function loadEnv(opts?: { optional?: boolean }): Env {
  config();
  const env: Partial<Env> = {};
  const missing: string[] = [];
  for (const key of REQUIRED) {
    const value = process.env[key]?.trim() ?? "";
    if (!value) missing.push(key);
    env[key] = value;
  }
  for (const key of OPTIONAL) {
    env[key] = process.env[key]?.trim() ?? "";
  }
  if (missing.length > 0 && !opts?.optional) {
    console.error(`missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
  return env as Env;
}
