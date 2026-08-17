import { Bot, InlineKeyboard } from "grammy";
import type { Logger } from "../logger.js";
import type { Signal } from "../types.js";
import { renderSignalCard, signalButton } from "./cards.js";

export interface TelegramSender {
  sendSignal(signal: Signal): Promise<boolean>;
  sendText(html: string): Promise<boolean>;
}

export class TelegramPusher implements TelegramSender {
  private readonly bot: Bot;

  constructor(
    token: string,
    private readonly chatId: string,
    private readonly logger: Logger,
    private readonly parseMode: "HTML" = "HTML",
  ) {
    this.bot = new Bot(token);
  }

  async sendSignal(signal: Signal): Promise<boolean> {
    const button = signalButton(signal);
    const keyboard = new InlineKeyboard().url(button.text, button.url);
    try {
      await this.bot.api.sendMessage(this.chatId, renderSignalCard(signal), {
        parse_mode: this.parseMode,
        reply_markup: keyboard,
      });
      return true;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : "send_failed" }, "telegram signal failed");
      return false;
    }
  }

  async sendText(html: string): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(this.chatId, html, { parse_mode: this.parseMode });
      return true;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : "send_failed" }, "telegram text failed");
      return false;
    }
  }
}
