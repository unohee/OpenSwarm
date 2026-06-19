// ============================================
// OpenSwarm - Notifier abstraction
// ============================================
//
// Outbound notifications were hardwired to Discord. This abstracts the send
// path so Slack/Telegram/generic-webhook are BYO drop-ins (INT-1576). Only the
// OUTBOUND notification path is abstracted; interactive Discord bot commands
// (!status etc.) remain Discord-specific.

import type { EmbedBuilder } from 'discord.js';

export interface Notifier {
  /** Send one outbound notification. Implementations must not throw. */
  notify(message: string | EmbedBuilder): Promise<void>;
}

export type NotificationsConfig = {
  channel: 'discord' | 'slack' | 'telegram' | 'webhook' | 'none';
  slackWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
};

/** Discord's content shape (string or embeds) — the existing sendToChannel signature. */
type DiscordSend = (content: string | { embeds: EmbedBuilder[] }) => Promise<void>;

/** Flatten a string|Embed into readable plain text for non-Discord channels. */
export function messageToText(message: string | EmbedBuilder): string {
  if (typeof message === 'string') return message;
  const d = message.data;
  const parts: string[] = [];
  if (d.title) parts.push(d.title);
  if (d.description) parts.push(d.description);
  for (const f of d.fields ?? []) parts.push(`${f.name}: ${f.value}`);
  return parts.join('\n') || '(notification)';
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenSwarm/0.7' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
}

/** Logs only — used when no channel is configured. */
class NoopNotifier implements Notifier {
  async notify(message: string | EmbedBuilder): Promise<void> {
    console.log('[Notify] (no channel):', messageToText(message).slice(0, 200));
  }
}

/** Discord bot channel. Owns the string→Embed wrapping (moved here from reportToDiscord). */
class DiscordNotifier implements Notifier {
  constructor(private readonly send: DiscordSend) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      if (typeof message === 'string') {
        // Lazy import keeps discord.js out of the load path for non-Discord users.
        const { EmbedBuilder } = await import('discord.js');
        const embed = new EmbedBuilder().setDescription(message).setColor(0x00ff41).setTimestamp();
        await this.send({ embeds: [embed] });
      } else {
        await this.send({ embeds: [message] });
      }
    } catch (err) {
      console.error('[Notify] Discord send failed:', err);
    }
  }
}

class SlackNotifier implements Notifier {
  constructor(private readonly webhookUrl: string) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(this.webhookUrl, { text: messageToText(message) });
    } catch (err) {
      console.error('[Notify] Slack send failed:', err);
    }
  }
}

class TelegramNotifier implements Notifier {
  constructor(private readonly botToken: string, private readonly chatId: string) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text: messageToText(message),
      });
    } catch (err) {
      console.error('[Notify] Telegram send failed:', err);
    }
  }
}

class WebhookNotifier implements Notifier {
  constructor(private readonly url: string) {}
  async notify(message: string | EmbedBuilder): Promise<void> {
    try {
      await postJson(this.url, { text: messageToText(message) });
    } catch (err) {
      console.error('[Notify] Webhook send failed:', err);
    }
  }
}

/**
 * Build the notifier for the configured channel. `discordSend` is injected (not
 * imported) so this module stays decoupled from discordCore and Discord stays
 * optional. Falls back to Noop when the chosen channel lacks its credential.
 */
export function createNotifier(config: NotificationsConfig | undefined, discordSend?: DiscordSend): Notifier {
  const channel = config?.channel ?? (discordSend ? 'discord' : 'none');
  switch (channel) {
    case 'discord':
      return discordSend ? new DiscordNotifier(discordSend) : new NoopNotifier();
    case 'slack':
      return config?.slackWebhookUrl ? new SlackNotifier(config.slackWebhookUrl) : new NoopNotifier();
    case 'telegram':
      return config?.telegramBotToken && config?.telegramChatId
        ? new TelegramNotifier(config.telegramBotToken, config.telegramChatId)
        : new NoopNotifier();
    case 'webhook':
      return config?.webhookUrl ? new WebhookNotifier(config.webhookUrl) : new NoopNotifier();
    case 'none':
    default:
      return new NoopNotifier();
  }
}
