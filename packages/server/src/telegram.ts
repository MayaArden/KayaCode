import * as fs from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import * as path from "node:path";

/**
 * Telegram integration config and Bot API access for kaya. One bot, one token:
 * the standalone telegram client (`@kaya/telegram-client`) and the server's
 * `notify_telegram` tool read the exact same configuration.
 *
 * Config file: `<configDir>/telegram.json` (typically `~/.kaya/telegram.json`):
 * ```json
 * {
 *   "botToken": "123456:ABC...",          // or env TELEGRAM_BOT_TOKEN
 *   "allowedChatIds": [123456789],        // chats the bot will answer
 *   "allowedUserIds": [987654321],        // optional extra user allowlist
 *   "apiBase": "https://api.telegram.org" // default; overridable for tests
 * }
 * ```
 *
 * The linked chat (where notify_telegram posts by default) is stored separately
 * in `<configDir>/telegram-link.json` { "chatId": 123 }.
 */
export interface TelegramConfig {
  botToken?: string;
  allowedChatIds: number[];
  allowedUserIds?: number[];
  apiBase?: string;
  /** Server address the persistent telegram client connects to (split mode). */
  server?: string;
}

export class TelegramConfigError extends Error {}

export function loadTelegramConfig(configDir: string): TelegramConfig | undefined {
  const file = path.join(configDir, "telegram.json");
  let parsed: TelegramConfig | undefined;
  if (fs.existsSync(file)) {
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TelegramConfig;
    } catch (error) {
      throw new TelegramConfigError(
        `Invalid ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const config: TelegramConfig | undefined =
    parsed || envToken
      ? {
          allowedChatIds: parsed?.allowedChatIds ?? [],
          ...(parsed?.allowedUserIds !== undefined ? { allowedUserIds: parsed.allowedUserIds } : {}),
          ...(parsed?.apiBase !== undefined ? { apiBase: parsed.apiBase } : {}),
          ...(parsed?.server !== undefined ? { server: parsed.server } : {}),
          botToken: parsed?.botToken ?? envToken,
        }
      : undefined;
  if (config && !config.botToken) return undefined;
  return config;
}

export function requireTelegramConfig(configDir: string): TelegramConfig {
  const config = loadTelegramConfig(configDir);
  if (!config) {
    throw new TelegramConfigError(
      `No Telegram bot configured. Set TELEGRAM_BOT_TOKEN or create ${path.join(configDir, "telegram.json")} with { "botToken": ..., "allowedChatIds": [...] }.`,
    );
  }
  return config;
}

export function isChatAllowed(config: TelegramConfig, chatId: number): boolean {
  return config.allowedChatIds.includes(chatId);
}

export function isUserAllowed(config: TelegramConfig, userId: number | undefined): boolean {
  if (config.allowedUserIds && config.allowedUserIds.length > 0) {
    return userId !== undefined && config.allowedUserIds.includes(userId);
  }
  return true; // no user-level restriction configured
}

// ============================================================================
// Linked chat (notify_telegram default target)
// ============================================================================

function linkPath(configDir: string): string {
  return path.join(configDir, "telegram-link.json");
}

export function loadLinkedChatId(configDir: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(linkPath(configDir), "utf8")) as { chatId?: number };
    return typeof parsed.chatId === "number" ? parsed.chatId : undefined;
  } catch {
    return undefined;
  }
}

export function saveLinkedChatId(configDir: string, chatId: number | undefined): void {
  fs.mkdirSync(configDir, { recursive: true });
  if (chatId === undefined) {
    fs.rmSync(linkPath(configDir), { force: true });
    return;
  }
  fs.writeFileSync(linkPath(configDir), JSON.stringify({ chatId }));
}

/** Resolve the chat a notification should go to: explicit arg > linked chat > first allowlisted. */
export function resolveNotifyTarget(config: TelegramConfig, configDir: string, explicit?: number): number {
  const target = explicit ?? loadLinkedChatId(configDir) ?? config.allowedChatIds[0];
  if (target === undefined) {
    throw new TelegramConfigError("No notification target: no explicit chat, no linked chat, empty allowlist.");
  }
  if (!isChatAllowed(config, target)) {
    throw new TelegramConfigError(`Chat ${target} is not in allowedChatIds; refusing to send.`);
  }
  return target;
}

// ============================================================================
// Bot API (thin HTTP layer; shared by server notify tool and the bot client)
// ============================================================================

export interface TelegramApi {
  sendMessage(chatId: number, text: string, options?: { disableNotification?: boolean }): Promise<{ messageId: number }>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
  answerTestOk(): void;
}

const TELEGRAM_MESSAGE_LIMIT = 4096;

export function createTelegramApi(config: TelegramConfig): TelegramApi {
  const base = config.apiBase ?? "https://api.telegram.org";

  async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${base}/bot${config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram API ${method} failed: ${body.description ?? response.statusText}`);
    }
    return body.result as T;
  }

  return {
    async sendMessage(chatId, text, options) {
      const result = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: text.slice(0, TELEGRAM_MESSAGE_LIMIT),
        parse_mode: "HTML",
        disable_notification: options?.disableNotification ?? false,
      });
      return { messageId: result.message_id };
    },
    async editMessage(chatId, messageId, text) {
      await call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, TELEGRAM_MESSAGE_LIMIT),
        parse_mode: "HTML",
      });
    },
    answerTestOk() {},
  };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================================
// notify_telegram tool (registered server-side when Telegram is configured)
// ============================================================================

/**
 * The built-in proactive-notification tool. Bound to the config-file's token
 * and allowlist — the tool can only message allowlisted (or the linked) chat,
 * never an arbitrary one.
 */
export function createNotifyTelegramTool(configDir: string): AgentTool | undefined {
  const config = loadTelegramConfig(configDir);
  if (!config) return undefined;
  return {
    name: "notify_telegram",
    label: "Notify via Telegram",
    description:
      "Send a Telegram message to the user's linked allowlisted chat. Use it to proactively report: task finished, input needed, error hit. The destination is restricted to the configured allowlisted chats.",
    parameters: Type.Object({
      message: Type.String({ description: "The message text to send" }),
      chatId: Type.Optional(
        Type.Integer({ description: "Target chat id (must be allowlisted; defaults to the linked chat)" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { message, chatId } = params as { message: string; chatId?: number };
      const freshConfig = requireTelegramConfig(configDir); // re-read: token/link may change at runtime
      const target = resolveNotifyTarget(freshConfig, configDir, chatId);
      const api = createTelegramApi(freshConfig);
      const { messageId } = await api.sendMessage(target, escapeHtml(message));
      return {
        content: [{ type: "text" as const, text: `Telegram message sent to chat ${target} (message ${messageId}).` }],
        details: { chatId: target, messageId },
      };
    },
  };
}

// ============================================================================
// Persisted allowlist editing (used by the /telegram command)
// ============================================================================

export interface TelegramAllowlistChange {
  addChatId?: number;
  removeChatId?: number;
  addUserId?: number;
  removeUserId?: number;
}

/**
 * Persist an allowlist change to <configDir>/telegram.json. Creates the file
 * if absent (a botToken from TELEGRAM_BOT_TOKEN still applies at load time).
 * Returns the resulting config.
 */
export function updateTelegramAllowlist(configDir: string, change: TelegramAllowlistChange): TelegramConfig {
  const file = path.join(configDir, "telegram.json");
  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  }
  const chatIds = new Set(Array.isArray(parsed.allowedChatIds) ? (parsed.allowedChatIds as number[]) : []);
  const userIds = new Set(Array.isArray(parsed.allowedUserIds) ? (parsed.allowedUserIds as number[]) : []);
  if (change.addChatId !== undefined) chatIds.add(change.addChatId);
  if (change.removeChatId !== undefined) chatIds.delete(change.removeChatId);
  if (change.addUserId !== undefined) userIds.add(change.addUserId);
  if (change.removeUserId !== undefined) userIds.delete(change.removeUserId);
  parsed.allowedChatIds = [...chatIds];
  if (userIds.size > 0 || parsed.allowedUserIds !== undefined) parsed.allowedUserIds = [...userIds];
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  const fresh = loadTelegramConfig(configDir);
  if (!fresh) throw new TelegramConfigError("No Telegram bot token configured (file or TELEGRAM_BOT_TOKEN).");
  return fresh;
}
