import type { Agent, AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent as AgentClass, estimateContextTokens, generateSummaryWithUsage } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import type { AssistantMessage, Model, MutableModels, UserMessage } from "@earendil-works/pi-ai";
import type { ModelRef, SessionPhase, SessionSnapshot, ThinkingLevel, TranscriptProgress } from "@earendil-works/pi-protocol";
import { SessionBusyError, type PiSessionRuntimeEvent, type PromptInput, type SteerInput } from "@earendil-works/pi-server";
import { NOOP_TELEMETRY_CONTEXT, createTypedSpanStarter, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { ExtensionHost } from "@kaya/extensions";
import { McpLoader, type McpLoadResult } from "@kaya/mcp";
import {
  createTelegramApi,
  escapeHtml,
  isChatAllowed,
  loadLinkedChatId,
  loadTelegramConfig,
  saveLinkedChatId,
  updateTelegramAllowlist,
} from "./telegram.js";
import type { ExtensionLoader, KayaExtensionError, KayaSessionFacade } from "@kaya/extensions";
import { KAYA_TELEMETRY_SCHEMA } from "./telemetry.js";
import { runningToolItem, runningToolItemWithContent, finishedToolItem, TranscriptMapper } from "./transcript.js";
import type { JsonSessionStore } from "./store.js";

export interface KayaSessionOptions {
  id: string;
  cwd: string;
  name?: string;
  createdAt?: number;
  model: Model<never>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  defaultTools: AgentTool[];
  extensionLoader: ExtensionLoader;
  models: MutableModels;
  store: JsonSessionStore;
  telemetry?: TelemetryContext;
  /** Initial messages when resuming a stored session. */
  messages?: AgentMessage[];
  /** Directories whose changes trigger an extension reload (debounced). */
  watchDirs?: string[];
  /** Global kaya config dir (~/.kaya) — MCP config merges .kaya/mcp.json from here and cwd. */
  globalConfigDir?: string;
  /** Connect configured MCP servers on session start. Default true. */
  mcp?: boolean;
  mcpConnectTimeoutMs?: number;
  onLoadWarnings?: (warnings: { path: string; error: string }[]) => void;
}

const COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

/**
 * One live session: owns the pi-agent-core Agent, the ExtensionHost, and the
 * bridge that turns agent events into pi-protocol snapshots and progress.
 */
export class KayaSessionRuntime {
  readonly id: string;
  readonly #cwd: string;
  readonly #store: JsonSessionStore;
  readonly #models: MutableModels;
  readonly #extensionLoader: ExtensionLoader;
  readonly #telemetry: TelemetryContext;
  readonly #systemPrompt: string;
  readonly #defaultTools: AgentTool[];
  readonly #abort = new AbortController();

  #agent: Agent;
  #host: ExtensionHost;
  #mapper = new TranscriptMapper();
  #createdAt: number;
  #updatedAt: number;
  #name: string | undefined;
  #revision = 0;
  #phase: SessionPhase = "idle";
  #compacting = false;
  #disposed = false;
  #listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
  #runPromise: Promise<void> | undefined;
  /** Id of the assistant message currently streaming (ids survive object identity changes). */
  #streamingMessageId: string | undefined;
  /** Input args per toolCallId, captured at tool_execution_start. */
  #toolArgs = new Map<string, unknown>();
  #mcpLoader: McpLoader | undefined;
  #watchers: { close(): void }[] = [];
  #reloadTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #watchDirs: string[];
  readonly #globalConfigDir: string | undefined;
  readonly #mcpEnabled: boolean;
  readonly #mcpConnectTimeoutMs: number | undefined;

  constructor(options: KayaSessionOptions) {
    this.id = options.id;
    this.#cwd = options.cwd;
    this.#store = options.store;
    this.#models = options.models;
    this.#extensionLoader = options.extensionLoader;
    this.#telemetry = options.telemetry ?? NOOP_TELEMETRY_CONTEXT;
    this.#systemPrompt = options.systemPrompt;
    this.#defaultTools = options.defaultTools;
    this.#createdAt = options.createdAt ?? Date.now();
    this.#updatedAt = this.#createdAt;
    this.#watchDirs = options.watchDirs ?? [];
    this.#globalConfigDir = options.globalConfigDir;
    this.#mcpEnabled = options.mcp ?? true;
    this.#mcpConnectTimeoutMs = options.mcpConnectTimeoutMs;
    if (options.name !== undefined) this.#name = options.name;

    const facade = this.#createFacade();
    this.#host = new ExtensionHost(facade, {
      onError: (error) => this.#handleExtensionError(error),
      onRegistryChanged: () => this.#refreshTools(),
    });
    this.#agent = this.#createAgent(options);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Load extensions, emit session_start, persist. Call exactly once. */
  async init(reason: "startup" | "reload" = "startup"): Promise<void> {
    const load = await this.#extensionLoader.loadAll(this.#host);
    if (load.errors.length > 0) {
      this.#notifyListeners({ type: "snapshot" });
    }
    await this.#loadMcpInto(this.#host);
    this.#registerBuiltinCommands();
    this.#refreshTools();
    await this.#host.emit("session_start", { type: "session_start", reason });
    this.#startWatching();
    this.#persist();
    this.#notifySnapshot();
  }

  /** Rebuild the extension host from disk (the /reload and fs-watch path). */
  async reloadExtensions(): Promise<void> {
    if (this.#disposed) return;
    await this.waitForIdle();
    await this.#host.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    this.#host.invalidate();
    const facade = this.#createFacade();
    this.#host = new ExtensionHost(facade, {
      onError: (error) => this.#handleExtensionError(error),
      onRegistryChanged: () => this.#refreshTools(),
    });
    const load = await this.#extensionLoader.loadAll(this.#host);
    await this.#loadMcpInto(this.#host);
    this.#registerBuiltinCommands();
    this.#refreshTools();
    await this.#host.emit("session_start", { type: "session_start", reason: "reload" });
    if (load.errors.length > 0) {
      this.#appendNote(
        `Reloaded with ${load.errors.length} extension error(s): ${load.errors
          .map((e) => `${e.path}: ${e.error}`)
          .join("; ")}`,
      );
    }
    this.#notifySnapshot();
  }

  #startWatching(): void {
    for (const dir of this.#watchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, () => this.#scheduleReload());
        this.#watchers.push(watcher);
      } catch {
        // Unwatchable directory; reload remains available via /reload.
      }
    }
  }

  #scheduleReload(): void {
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = undefined;
      this.reloadExtensions().catch((error: unknown) => {
        this.#appendNote(
          `[extension reload failed] ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 300);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
    try {
      await this.#host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    } catch {
      // Host may already be invalidated.
    }
    this.#host.invalidate();
    if (this.#mcpLoader) await this.#mcpLoader.close();
    this.#agent.abort();
    try {
      await this.#agent.waitForIdle();
    } catch {
      // Aborted run rejection; disposal continues.
    }
    this.#persist();
    this.#abort.abort();
    this.#listeners.clear();
  }

  // ==========================================================================
  // PiSessionRuntime surface
  // ==========================================================================

  snapshot(): SessionSnapshot {
    const transcript = this.#mapper.toTranscript(this.#agent.state.messages);
    const snapshot: SessionSnapshot = {
      id: this.id,
      ...(this.#name !== undefined ? { name: this.#name } : {}),
      cwd: this.#cwd,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      phase: this.getPhase(),
      model: this.modelRef(),
      thinkingLevel: this.#agent.state.thinkingLevel,
      attached: false,
      locked: true,
      revision: this.#revision,
      transcript,
      queuedSteer: [],
      queuedSteerCount: 0,
    };
    return snapshot;
  }

  getPhase(): SessionPhase {
    if (this.#compacting) return "compaction";
    return this.#agent.state.isStreaming ? "turn" : "idle";
  }

  modelRef(): ModelRef {
    const model = this.#agent.state.model;
    return { provider: model.provider, id: model.id };
  }

  async prompt(input: PromptInput): Promise<void> {
    this.#assertLive();
    const text = input.text;
    if (text.startsWith("/")) {
      const spaceIndex = text.indexOf(" ");
      const name = text.slice(1, spaceIndex === -1 ? text.length : spaceIndex);
      const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
      const handled = await this.#host.runCommand(name, args);
      if (handled) {
        this.#persist();
        this.#notifySnapshot();
        return;
      }
      // Unknown command: fall through and let the model see the raw text.
    }
    if (this.#agent.state.isStreaming) {
      throw new SessionBusyError();
    }
    const startSpan = createTypedSpanStarter(this.#telemetry, [KAYA_TELEMETRY_SCHEMA]);
    const ref = this.modelRef();
    this.#runPromise = startSpan(
      "kaya.session.run",
      { "kaya.session.id": this.id, "kaya.provider": ref.provider, "kaya.model": ref.id },
      async (span) => {
        try {
          await this.#agent.prompt(text);
          await this.#agent.waitForIdle();
          const lastStop = this.#lastStopReason();
          if (lastStop) span.setAttributes({ "kaya.stop_reason": lastStop });
        } finally {
          await this.#maybeCompact("threshold");
          this.#persist();
          this.#notifySnapshot();
        }
      },
    ).then(() => undefined);
    await this.#runPromise;
  }

  async steer(input: SteerInput): Promise<void> {
    this.#assertLive();
    this.#agent.steer(this.#userMessage(input.text));
  }

  async abort(): Promise<void> {
    this.#assertLive();
    this.#agent.abort();
  }

  async setModel(model: ModelRef): Promise<void> {
    this.#assertLive();
    const resolved = this.#models.getModel(model.provider, model.id);
    if (!resolved) {
      throw new Error(`Model not found: ${model.provider}/${model.id}`);
    }
    this.#agent.state.model = resolved;
    this.#persist();
    this.#notifySnapshot();
  }

  async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
    this.#assertLive();
    this.#agent.state.thinkingLevel = thinkingLevel;
    this.#persist();
    this.#notifySnapshot();
  }

  subscribe(
    listener: (event: PiSessionRuntimeEvent) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  waitForIdle(): Promise<void> {
    return this.#agent.waitForIdle();
  }

  // ==========================================================================
  // Agent construction and event bridge
  // ==========================================================================

  #createAgent(options: KayaSessionOptions): Agent {
    const models = this.#models;
    const agent = new AgentClass({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        tools: [...options.defaultTools],
        messages: options.messages ?? [],
      },
      streamFn: (model, context, streamOptions) =>
        models.streamSimple(model, context, { ...streamOptions, telemetryContext: this.#telemetry }),
      convertToLlm: (messages) => messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
      onPayload: async (payload, model) => {
        const replaced = await this.#host.emitBeforeProviderRequest({
          type: "before_provider_request",
          provider: model.provider,
          model: model.id,
          payload,
        });
        return replaced;
      },
      onResponse: async (response, model) => {
        await this.#host.emit("after_provider_response", {
          type: "after_provider_response",
          provider: model.provider,
          model: model.id,
          response,
        });
      },
      beforeToolCall: async (context, _signal) => {
        const result = await this.#host.emitToolCall({
          type: "tool_call",
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          input: context.args,
        });
        if (!result) return undefined;
        return { block: result.block, reason: result.reason, terminate: result.terminate };
      },
      afterToolCall: async (context, _signal) => {
        const merged = await this.#host.emitToolResult({
          type: "tool_result",
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          content: Array.isArray(context.result.content) ? [...context.result.content] : [],
          details: context.result.details,
          isError: context.isError,
        });
        if (!merged) return undefined;
        return { content: merged.content, details: merged.details, isError: merged.isError };
      },
    });
    agent.subscribe((event) => this.#onAgentEvent(event));
    return agent;
  }

  async #onAgentEvent(event: AgentEvent): Promise<void> {
    const progress = this.#toProgress(event);
    if (progress) this.#notifyListeners({ type: "progress", progress });

    // Passive mirror into the extension host.
    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        await this.#host.emit(event.type, event as never);
        break;
    }

    if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
      this.#persist();
      this.#notifySnapshot();
    }
  }

  #toProgress(event: AgentEvent): TranscriptProgress | undefined {
    switch (event.type) {
      case "message_start": {
        // Tool-result messages already appeared as tool items at
        // tool_execution_start; emitting them again would duplicate the item.
        if (event.message.role === "toolResult") return undefined;
        const item = this.#mapper.toItem(event.message);
        if (event.message.role === "assistant") {
          this.#streamingMessageId = this.#mapper.idFor(event.message);
        }
        return item ? ({ type: "item_started", item } as TranscriptProgress) : undefined;
      }
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta" || inner.type === "thinking_delta" || inner.type === "toolcall_delta") {
          const kind = inner.type === "text_delta" ? "text" : inner.type === "thinking_delta" ? "thinking" : "toolCall";
          return {
            type: "assistant_delta",
            messageId: this.#streamingMessageId ?? this.#mapper.idFor(event.message),
            contentIndex: inner.contentIndex,
            kind,
            delta: inner.delta,
          };
        }
        return undefined;
      }
      case "message_end": {
        // Tool-result messages are covered by tool_execution_* progress.
        if (event.message.role === "toolResult") return undefined;
        if (event.message.role === "assistant") {
          // Pin the streaming id to the finalized message object BEFORE
          // deriving the item, so snapshots (which re-derive ids from
          // state.messages) agree with progress ids.
          if (this.#streamingMessageId) this.#mapper.setId(event.message, this.#streamingMessageId);
          this.#streamingMessageId = undefined;
        }
        const item = this.#mapper.toItem(event.message);
        // Protocol v1 allows user items in item_started but not item_finished.
        if (!item || item.role === "user") return undefined;
        return { type: "item_finished", item } as TranscriptProgress;
      }
      case "tool_execution_start": {
        const id = this.#mapper.toolItemIdFor(event.toolCallId);
        this.#toolArgs.set(event.toolCallId, event.args);
        return { type: "item_started", item: runningToolItem(id, event.toolCallId, event.toolName, event.args) } as TranscriptProgress;
      }
      case "tool_execution_update": {
        const id = this.#mapper.toolItemIdFor(event.toolCallId);
        return {
          type: "item_updated",
          item: runningToolItemWithContent(
            id,
            event.toolCallId,
            event.toolName,
            this.#toolArgs.get(event.toolCallId) ?? event.args,
            event.partialResult as { content?: unknown } | undefined,
          ),
        } as TranscriptProgress;
      }
      case "tool_execution_end": {
        const id = this.#mapper.toolItemIdFor(event.toolCallId);
        const item = finishedToolItem(
          id,
          event.toolCallId,
          event.toolName,
          this.#toolArgs.get(event.toolCallId),
          event.result as { content?: unknown; details?: unknown } | undefined,
          event.isError,
        );
        this.#toolArgs.delete(event.toolCallId);
        return { type: "item_finished", item } as TranscriptProgress;
      }
      default:
        return undefined;
    }
  }

  // ==========================================================================
  // Extension facade and tool registry
  // ==========================================================================

  #createFacade(): KayaSessionFacade {
    const runtime = this;
    return {
      get cwd() {
        return runtime.#cwd;
      },
      get signal() {
        return runtime.#abort.signal;
      },
      isIdle: () => !runtime.#agent.state.isStreaming,
      getModel: () => runtime.modelRef(),
      getThinkingLevel: () => runtime.#agent.state.thinkingLevel,
      setThinkingLevel: (level) => {
        runtime.#agent.state.thinkingLevel = level;
        runtime.#notifySnapshot();
      },
      steer: (text) => runtime.#agent.steer(runtime.#userMessage(text)),
      followUp: (text) => runtime.#agent.followUp(runtime.#userMessage(text)),
      // Bypasses slash-command parsing; extensions always reach the agent.
      prompt: (text) => runtime.#agent.prompt(text).then(() => runtime.#agent.waitForIdle()),
      appendAssistantNote: (text) => {
        runtime.#appendNote(text);
      },
      listTools: () => runtime.#agent.state.tools.map((t) => t.name),
    };
  }

  #appendNote(text: string): void {
    const note: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: this.#agent.state.model.api,
      provider: this.#agent.state.model.provider,
      model: this.#agent.state.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    this.#agent.state.messages = [...this.#agent.state.messages, note];
    this.#persist();
    this.#notifySnapshot();
  }

  #refreshTools(): void {
    this.#agent.state.tools = [...this.#defaultTools, ...this.#host.getTools()];
  }

  #handleExtensionError(error: KayaExtensionError): void {
    const where = error.phase === "handler" && error.event ? ` in ${error.event} handler` : ` during ${error.phase}`;
    this.#appendNote(`[extension error] ${error.source.path}${where}: ${error.error.message}`);
  }

  /** Connect configured MCP servers and register their tools into the host. */
  async #loadMcpInto(host: ExtensionHost): Promise<void> {
    if (!this.#mcpEnabled) return;
    // Close connections from a previous generation (reload creates a new host).
    if (this.#mcpLoader) await this.#mcpLoader.close();
    const loader = new McpLoader({
      cwd: this.#cwd,
      ...(this.#globalConfigDir !== undefined ? { configDir: this.#globalConfigDir } : {}),
      ...(this.#mcpConnectTimeoutMs !== undefined ? { connectTimeoutMs: this.#mcpConnectTimeoutMs } : {}),
    });
    this.#mcpLoader = loader;
    let result: McpLoadResult;
    try {
      result = await loader.loadInto(host);
    } catch (error) {
      this.#appendNote(`[mcp] load failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const failed of result.errors) {
      this.#appendNote(`[mcp] skipped server "${failed.name}": ${failed.error}`);
    }
    if (result.connected.length > 0) {
      const summary = result.connected
        .map((c) => `${c.name} (${c.transport}, ${c.toolNames.length} tools)`)
        .join(", ");
      this.#appendNote(`[mcp] connected: ${summary}`);
    }
  }

  #registerBuiltinCommands(): void {
    const runtime = this;
    void this.#host.loadFactory(
      (kaya) => {
        kaya.registerCommand("compact", {
          description: "Compact the conversation context now",
          handler: async (_args, ctx) => {
            await runtime.compact("manual");
            ctx.appendAssistantNote("Context compacted.");
          },
        });
        kaya.registerCommand("tools", {
          description: "List active tools",
          handler: (_args, ctx) => {
            ctx.appendAssistantNote(`Active tools: ${ctx.listTools().join(", ") || "(none)"}`);
          },
        });
        kaya.registerCommand("reload", {
          description: "Reload extensions from disk",
          handler: async () => {
            await runtime.reloadExtensions();
          },
        });

        if (runtime.#globalConfigDir && loadTelegramConfig(runtime.#globalConfigDir)) {
          const configDir = runtime.#globalConfigDir;
          kaya.registerCommand("telegram", {
            description: "Telegram linkage and allowlist management",
            argumentHint: "[status] | link <chatId> | unlink | test | allow chat <id> | deny chat <id> | allow user <id> | deny user <id>",
            handler: async (args, ctx) => {
              const config = loadTelegramConfig(configDir)!;
              const parts = args.trim().split(/\s+/);
              const action = parts[0] ?? "";
              const rest = parts.slice(1).join(" ");
              if (action === "" || action === "status") {
                const linked = loadLinkedChatId(configDir);
                ctx.appendAssistantNote(
                  [
                    "Telegram status:",
                    `- bot token: ${config.botToken ? "configured" : "missing"}`,
                    `- allowedChats: ${config.allowedChatIds.join(", ") || "(none)"}`,
                    `- allowedUsers: ${(config.allowedUserIds ?? []).join(", ") || "(any user in an allowed chat)"}`,
                    `- linked chat: ${linked ?? "(none — set with /telegram link <chatId>)"}`,
                    "Manage: /telegram allow|deny chat|user <id>",
                  ].join("\n"),
                );
                return;
              }
              if (action === "allow" || action === "deny") {
                const kind = parts[1] ?? "";
                const id = Number(parts[2]);
                if ((kind !== "chat" && kind !== "user") || !Number.isInteger(id)) {
                  ctx.appendAssistantNote("Usage: /telegram allow|deny chat|user <id>");
                  return;
                }
                const updated = updateTelegramAllowlist(configDir, {
                  ...(kind === "chat" && action === "allow" ? { addChatId: id } : {}),
                  ...(kind === "chat" && action === "deny" ? { removeChatId: id } : {}),
                  ...(kind === "user" && action === "allow" ? { addUserId: id } : {}),
                  ...(kind === "user" && action === "deny" ? { removeUserId: id } : {}),
                });
                if (kind === "chat" && action === "deny" && loadLinkedChatId(configDir) === id) {
                  saveLinkedChatId(configDir, undefined);
                }
                ctx.appendAssistantNote(
                  `${action === "allow" ? "Allowed" : "Denied"} ${kind} ${id}. ` +
                    `allowedChats: ${updated.allowedChatIds.join(", ") || "(none)"}, ` +
                    `allowedUsers: ${(updated.allowedUserIds ?? []).join(", ") || "(unrestricted)"}`,
                );
                return;
              }
              if (action === "link") {
                const chatId = Number(rest);
                if (!Number.isInteger(chatId)) {
                  ctx.appendAssistantNote("Usage: /telegram link <chatId> (integer; must be allowlisted)");
                  return;
                }
                if (!isChatAllowed(config, chatId)) {
                  ctx.appendAssistantNote(`Chat ${chatId} is not in allowedChatIds — refusing to link. /telegram allow chat ${chatId} first if you trust it.`);
                  return;
                }
                saveLinkedChatId(configDir, chatId);
                ctx.appendAssistantNote(`Telegram linked to chat ${chatId}.`);
                return;
              }
              if (action === "unlink") {
                saveLinkedChatId(configDir, undefined);
                ctx.appendAssistantNote("Telegram link removed.");
                return;
              }
              if (action === "test") {
                const target = loadLinkedChatId(configDir) ?? config.allowedChatIds[0];
                if (target === undefined || !isChatAllowed(config, target)) {
                  ctx.appendAssistantNote("No allowlisted/linked chat to send to.");
                  return;
                }
                const api = createTelegramApi(config);
                await api.sendMessage(target, escapeHtml("kaya /telegram test — wiring works."));
                ctx.appendAssistantNote(`Test message sent to chat ${target}.`);
                return;
              }
              ctx.appendAssistantNote("Usage: /telegram [status] | link <chatId> | unlink | test | allow|deny chat|user <id>");
            },
          });
        }
      },
      { path: "<inline:kaya-server>", kind: "inline" },
    );
  }

  // ==========================================================================
  // Compaction
  // ==========================================================================

  async compact(reason: "threshold" | "manual"): Promise<boolean> {
    this.#assertLive();
    const messages = this.#agent.state.messages;
    const estimate = estimateContextTokens(messages);
    const decision = await this.#host.emitBeforeCompact({
      type: "before_compact",
      reason,
      messageCount: messages.length,
      estimatedTokens: estimate.tokens,
    });
    if (decision.cancel) return false;

    const keepTokens = COMPACTION_SETTINGS.keepRecentTokens;
    // Walk from the end, keeping roughly keepRecentTokens worth of messages.
    let kept = 0;
    let cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = estimateContextTokens([messages[i]!]).tokens;
      if (kept + tokens > keepTokens && cutIndex < messages.length) break;
      kept += tokens;
      cutIndex = i;
    }
    if (cutIndex === 0) return false; // Nothing to compact.
    const toSummarize = messages.slice(0, cutIndex);
    const retained = messages.slice(cutIndex);

    const startSpan = createTypedSpanStarter(this.#telemetry, [KAYA_TELEMETRY_SCHEMA]);
    this.#compacting = true;
    this.#notifySnapshot();
    try {
      return await startSpan(
        "kaya.compaction",
        { "kaya.session.id": this.id, "kaya.compaction.reason": reason },
        async (span) => {
          const result = await generateSummaryWithUsage(
            toSummarize.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
            this.#models,
            this.#agent.state.model,
            COMPACTION_SETTINGS.reserveTokens,
            this.#abort.signal,
            undefined,
            this.#agent.state.thinkingLevel,
          );
          if (!result.ok) throw result.error;
          span.setAttributes({ "kaya.compaction.tokens_before": estimate.tokens });
          const summaryMessage: UserMessage = {
            role: "user",
            content: [
              {
                type: "text",
                text: `[Context summary of earlier conversation]\n\n${result.value.text}`,
              },
            ],
            timestamp: Date.now(),
          };
          this.#agent.state.messages = [summaryMessage, ...retained];
          this.#persist();
          return true;
        },
      );
    } finally {
      this.#compacting = false;
      this.#notifySnapshot();
    }
  }

  async #maybeCompact(reason: "threshold"): Promise<void> {
    if (!COMPACTION_SETTINGS.enabled || this.#disposed) return;
    const estimate = estimateContextTokens(this.#agent.state.messages);
    const contextWindow = this.#agent.state.model.contextWindow;
    if (estimate.tokens <= contextWindow - COMPACTION_SETTINGS.reserveTokens) return;
    try {
      await this.compact(reason);
    } catch {
      // Compaction failure must not break the session; context stays whole.
    }
  }

  // ==========================================================================
  // Plumbing
  // ==========================================================================

  get host(): ExtensionHost {
    return this.#host;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get agent(): Agent {
    return this.#agent;
  }

  #userMessage(text: string): UserMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  }

  #lastStopReason(): string | undefined {
    const messages = this.#agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "assistant") return message.stopReason;
    }
    return undefined;
  }

  #persist(): void {
    this.#updatedAt = Date.now();
    this.#store.save({
      id: this.id,
      cwd: this.#cwd,
      ...(this.#name !== undefined ? { name: this.#name } : {}),
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      model: this.modelRef(),
      thinkingLevel: this.#agent.state.thinkingLevel,
      messages: this.#agent.state.messages,
    });
  }

  #notifySnapshot(): void {
    this.#revision++;
    this.#notifyListeners({ type: "snapshot" });
  }

  #notifyListeners(event: PiSessionRuntimeEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break the runtime.
      }
    }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error(`Session ${this.id} is disposed.`);
  }
}
