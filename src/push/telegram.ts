import { Bot, InlineKeyboard } from "grammy";
import type { Logger } from "../logger.js";
import type { Signal } from "../types.js";
import { renderSignalCard, signalButton } from "./cards.js";

export interface TelegramSendResult {
  okIds: string[];
  fail: number;
}

export interface TelegramSender {
  destinations(): string[];
  sendSignal(signal: Signal, chatIds?: string[]): Promise<TelegramSendResult>;
  sendText(html: string): Promise<boolean>;
}

export class TelegramPusher implements TelegramSender {
  private readonly bot: Bot;
  private readonly chatIds: string[];

  constructor(
    token: string,
    chatIds: string | string[],
    private readonly logger: Logger,
    private readonly parseMode: "HTML" = "HTML",
  ) {
    this.bot = new Bot(token);
    this.chatIds = (Array.isArray(chatIds) ? chatIds : [chatIds]).map((id) => id.trim()).filter(Boolean);
  }

  destinations(): string[] {
    return this.chatIds.slice();
  }

  async sendSignal(signal: Signal, chatIds?: string[]): Promise<TelegramSendResult> {
    const button = signalButton(signal);
    const keyboard = new InlineKeyboard().url(button.text, button.url);
    const html = renderSignalCard(signal);
    const result = await this.sendAll(
      (chatId) =>
        this.bot.api.sendMessage(chatId, html, {
          parse_mode: this.parseMode,
          reply_markup: keyboard,
        }),
      "signal",
      chatIds ?? this.chatIds,
    );
    return result;
  }

  async sendText(html: string): Promise<boolean> {
    const result = await this.sendAll(
      (chatId) => this.bot.api.sendMessage(chatId, html, { parse_mode: this.parseMode }),
      "text",
      this.chatIds,
    );
    return result.okIds.length > 0;
  }

  private async sendAll(
    send: (chatId: string) => Promise<unknown>,
    kind: string,
    chatIds: string[],
  ): Promise<TelegramSendResult> {
    if (chatIds.length === 0) {
      this.logger.warn({ kind }, "telegram no destinations");
      return { okIds: [], fail: 0 };
    }
    const results = await Promise.allSettled(chatIds.map((chatId) => send(chatId).then(() => chatId)));
    const okIds: string[] = [];
    let fail = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        okIds.push(result.value);
        continue;
      }
      fail += 1;
      const err = result.reason;
      this.logger.warn(
        { kind, err: err instanceof Error ? err.message : "send_failed" },
        "telegram destination failed",
      );
    }
    if (okIds.length === 0) {
      this.logger.warn({ kind, fail }, "telegram all destinations failed");
    }
    return { okIds, fail };
  }
}
