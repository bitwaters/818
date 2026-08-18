import pino from "pino";

export function createLogger() {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "GMGN_API_KEY",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID",
        "TELEGRAM_GROUP_ID",
        "TELEGRAM_CHANNEL_ID",
        "req.headers.X-APIKEY",
        "headers.X-APIKEY",
        "*.apiKey",
        "*.token",
      ],
      remove: true,
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
