import { config } from "dotenv";

export interface Env {
  GMGN_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

const KEYS = ["GMGN_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;

export function loadEnv(opts?: { optional?: boolean }): Env {
  config();
  const env: Partial<Env> = {};
  const missing: string[] = [];
  for (const key of KEYS) {
    const value = process.env[key]?.trim() ?? "";
    if (!value) missing.push(key);
    env[key] = value;
  }
  if (missing.length > 0 && !opts?.optional) {
    console.error(`missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
  return env as Env;
}
