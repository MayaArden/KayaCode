import { Bot } from "grammy";
import type { PiClient } from "@earendil-works/pi-client";
import type { TelegramConfig } from "@kaya/server";
import { escapeHtml, isChatAllowed, isUserAllowed, loadTelegramConfig } from "@kaya/server";
import { ChatBridge, type TelegramSink } from "./bridge.js";
import type { ChatSessions } from "./sessions.js";

/**
 * grammy wiring: allowlist gate, bot commands bridged to kaya commands,
 * per-chat ChatBridge over real pi-client sessions.
 */
export function createKayaTelegramBot(options: {
  config: TelegramConfig;
  configDir: string;
  client: PiClient;
  sessions: ChatSessions;
}): Bot {
  const { config, configDir, client, sessions } = options;
  const bot = new Bot(config.botToken!);
  // Re-read the allowlist per update so `/telegram allow|deny` edits from the
  // terminal CLI take effect without restarting the bot.
  const currentConfig = (): TelegramConfig => loadTelegramConfig(configDir) ?? config;

  const sink: TelegramSink = {
    async send(chatId, html) {
      const message = await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
      return message.message_id;
    },
    async edit(chatId, messageId, html) {
      await bot.api
        .editMessageText(chatId, messageId, html, { parse_mode: "HTML" })
        .catch(() => {}); // "message is not modified" etc. — harmless
    },
  };

  const bridges = new Map<number, ChatBridge>();
  async function bridgeFor(chatId: number): Promise<ChatBridge> {
    let bridge = bridges.get(chatId);
    if (!bridge) {
      bridge = new ChatBridge(chatId, sink);
      bridges.set(chatId, bridge);
    }
    if (!bridge.session?.active) {
      bridge.attach(await sessions.ensure(chatId));
    }
    return bridge;
  }

  // Allowlist gate: silently drop anything from non-allowlisted chats/users.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const cfg = currentConfig();
    if (!isChatAllowed(cfg, chatId) || !isUserAllowed(cfg, ctx.from?.id)) {
      console.log(`[kaya-telegram] dropped update from chat ${chatId} (not allowlisted)`);
      return;
    }
    await next();
  });

  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

  bot.command("start", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    await ctx.reply(
      [
        "kaya connected for this chat.",
        "Ask anything; each chat has its own kaya session.",
        "Commands: /model /provider /thinking /new /status /output /compact /tools /reload",
        `Session phase: ${bridge.phase}`,
      ].join("\n"),
    );
  });

  bot.command("new", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    bridge.attach(await sessions.fresh(ctx.chat.id));
    await ctx.reply("New session started for this chat.");
  });

  bot.command("status", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    const snapshot = bridge.session?.snapshot;
    await ctx.reply(
      `phase: ${bridge.phase}\nmodel: ${snapshot ? `${snapshot.model.provider}/${snapshot.model.id}` : "?"}\nthinking: ${snapshot?.thinkingLevel ?? "?"}`,
    );
  });

  bot.command("model", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    const arg = ctx.match.trim();
    if (!arg) {
      const models = client.snapshot?.models ?? [];
      const current = bridge.session?.snapshot?.model;
      const lines = models
        .slice(0, 40)
        .map((m) => `${m.provider}/${m.id}${current && m.provider === current.provider && m.id === current.id ? " ← current" : ""}`);
      await ctx.reply(`Usage: /model provider/id\n\n${escapeHtml(lines.join("\n"))}`, { parse_mode: "HTML" });
      return;
    }
    const slash = arg.indexOf("/");
    if (slash === -1) {
      await ctx.reply("Usage: /model provider/id");
      return;
    }
    await bridge.session?.setModel({ provider: arg.slice(0, slash), id: arg.slice(slash + 1) });
    await ctx.reply(`Model set to ${arg}`);
  });

  bot.command("provider", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    const arg = ctx.match.trim();
    const models = client.snapshot?.models ?? [];
    const providers = [...new Set(models.map((m) => m.provider))];
    if (!arg || !providers.includes(arg)) {
      await ctx.reply(`Usage: /provider <name>\nKnown: ${providers.join(", ")}`);
      return;
    }
    const currentId = bridge.session?.snapshot?.model.id;
    const target = models.find((m) => m.provider === arg && m.id === currentId) ?? models.find((m) => m.provider === arg);
    if (!target) {
      await ctx.reply(`Provider "${arg}" has no models.`);
      return;
    }
    await bridge.session?.setModel({ provider: arg, id: target.id });
    await ctx.reply(`Provider ${arg}, model ${target.id}`);
  });

  bot.command("thinking", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    const arg = ctx.match.trim();
    if (!(THINKING_LEVELS as readonly string[]).includes(arg)) {
      await ctx.reply(`Usage: /thinking <${THINKING_LEVELS.join("|")}>`);
      return;
    }
    await bridge.session?.setThinking(arg as (typeof THINKING_LEVELS)[number]);
    await ctx.reply(`Thinking level: ${arg}`);
  });

  bot.command("output", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    const n = ctx.match.trim() ? Number.parseInt(ctx.match.trim(), 10) : undefined;
    await bridge.showOutput(Number.isInteger(n) ? n : undefined);
  });

  bot.command("abort", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    await bridge.abort();
  });

  // Everything else starting with "/" (compact, tools, reload, extension
  // commands) is forwarded to the server's command registry unchanged.
  for (const forwarded of ["compact", "tools", "reload"]) {
    bot.command(forwarded, async (ctx) => {
      const bridge = await bridgeFor(ctx.chat.id);
      await bridge.submit(`/${forwarded} ${ctx.match.trim()}`.trim());
    });
  }

  bot.on("message:text", async (ctx) => {
    const bridge = await bridgeFor(ctx.chat.id);
    try {
      await bridge.submit(ctx.message.text);
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return bot;
}
