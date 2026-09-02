import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { KayaEventName, KayaEvents } from "./events.js";
import type {
  BeforeCompactEvent,
  BeforeCompactResult,
  BeforeProviderRequestEvent,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultResult,
} from "./events.js";
import type {
  ExtensionSourceInfo,
  KayaCommandDef,
  KayaExtensionAPI,
  KayaExtensionContext,
  KayaExtensionError,
  KayaExtensionFactory,
  KayaSessionFacade,
  RegisteredCommand,
  RegisteredTool,
} from "./types.js";

type AnyHandler = (event: never, ctx: KayaExtensionContext) => unknown;

interface RegisteredHandler {
  event: KayaEventName;
  handler: AnyHandler;
  source: ExtensionSourceInfo;
}

export interface ExtensionHostOptions {
  /** Routed errors from extension handlers and command handlers. */
  onError?: (error: KayaExtensionError) => void;
  /** Fired after tools or commands change post-load (e.g. from a handler). */
  onRegistryChanged?: () => void;
}

/**
 * The extension host: owns all extension registrations for one session
 * generation and dispatches events to them. Fully decoupled from discovery and
 * loading — anything that can produce a `KayaExtensionFactory` can feed it
 * (`loadFactory`), which keeps the door open for MCP bridges and plugin
 * loaders feeding the same pipeline later.
 *
 * Dispatch semantics: handlers run sequentially in load order; a throwing
 * handler is caught and routed to `onError` and never breaks the loop.
 * Mutable events (`tool_call`, `tool_result`, `before_provider_request`,
 * `before_compact`) have bespoke dispatchers with chaining/short-circuit.
 */
export class ExtensionHost {
  readonly #facade: KayaSessionFacade;
  readonly #onError: (error: KayaExtensionError) => void;
  readonly #onRegistryChanged: () => void;

  #handlers: RegisteredHandler[] = [];
  #tools = new Map<string, RegisteredTool>();
  #commands = new Map<string, RegisteredCommand>();
  #staleMessage: string | undefined;

  constructor(facade: KayaSessionFacade, options: ExtensionHostOptions = {}) {
    this.#facade = facade;
    this.#onError = options.onError ?? (() => {});
    this.#onRegistryChanged = options.onRegistryChanged ?? (() => {});
  }

  /**
   * Poison every context this host has handed out. After this, any captured
   * ctx method throws. Used before session replacement/reload swaps in a new
   * host.
   */
  invalidate(message?: string): void {
    this.#staleMessage =
      message ??
      "This extension context belongs to a session that was replaced or reloaded. " +
        "Drop the captured ctx and re-register from the new extension generation.";
  }

  #assertActive(): void {
    if (this.#staleMessage) throw new Error(this.#staleMessage);
    if (this.#facade.signal.aborted) {
      throw new Error("This extension's session has been disposed.");
    }
  }

  #createContext(source: ExtensionSourceInfo): KayaExtensionContext {
    const host = this;
    const facade = this.#facade;
    return {
      source,
      get cwd() {
        host.#assertActive();
        return facade.cwd;
      },
      get signal() {
        return facade.signal;
      },
      isIdle: () => (host.#assertActive(), facade.isIdle()),
      getModel: () => (host.#assertActive(), facade.getModel()),
      getThinkingLevel: () => (host.#assertActive(), facade.getThinkingLevel()),
      setThinkingLevel: (level) => (host.#assertActive(), facade.setThinkingLevel(level)),
      steer: (text) => (host.#assertActive(), facade.steer(text)),
      followUp: (text) => (host.#assertActive(), facade.followUp(text)),
      prompt: (text) => (host.#assertActive(), facade.prompt(text)),
      appendAssistantNote: (text) => (host.#assertActive(), facade.appendAssistantNote(text)),
      listTools: () => (host.#assertActive(), facade.listTools()),
    };
  }

  /**
   * Run an extension factory and commit its registrations atomically: a
   * throwing factory leaves no partial registrations behind.
   */
  async loadFactory(factory: KayaExtensionFactory, source: ExtensionSourceInfo): Promise<void> {
    const stagedHandlers: RegisteredHandler[] = [];
    const stagedTools = new Map<string, RegisteredTool>();
    const stagedCommands = new Map<string, RegisteredCommand>();

    const api: KayaExtensionAPI = {
      on: (event, handler) => {
        this.#assertActive();
        stagedHandlers.push({ event, handler: handler as AnyHandler, source });
      },
      registerTool: (tool) => {
        this.#assertActive();
        stagedTools.set(tool.name, { tool: tool as AgentTool, source });
      },
      registerCommand: (name, def: KayaCommandDef) => {
        this.#assertActive();
        stagedCommands.set(name, { ...def, name, source });
      },
    };

    try {
      await factory(api);
    } catch (error) {
      this.#onError({
        source,
        phase: "load",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return; // discard staged registrations
    }

    this.#handlers.push(...stagedHandlers);
    for (const [name, registered] of stagedTools) {
      if (this.#tools.has(name)) {
        this.#onError({
          source,
          phase: "load",
          error: new Error(
            `Tool "${name}" already registered by ${this.#tools.get(name)!.source.path}; keeping the first registration.`,
          ),
        });
        continue;
      }
      this.#tools.set(name, registered);
    }
    for (const [name, registered] of stagedCommands) {
      if (this.#commands.has(name)) {
        this.#onError({
          source,
          phase: "load",
          error: new Error(
            `Command "/${name}" already registered by ${this.#commands.get(name)!.source.path}; keeping the first registration.`,
          ),
        });
        continue;
      }
      this.#commands.set(name, registered);
    }
    if (stagedTools.size > 0 || stagedCommands.size > 0) this.#onRegistryChanged();
  }

  // ==========================================================================
  // Registry access
  // ==========================================================================

  getTools(): AgentTool[] {
    return [...this.#tools.values()].map((r) => r.tool);
  }

  getRegisteredTools(): RegisteredTool[] {
    return [...this.#tools.values()];
  }

  getCommands(): RegisteredCommand[] {
    return [...this.#commands.values()];
  }

  getCommand(name: string): RegisteredCommand | undefined {
    return this.#commands.get(name);
  }

  hasHandlers(event: KayaEventName): boolean {
    return this.#handlers.some((h) => h.event === event);
  }

  /**
   * Execute a slash command. Returns true when a command with that name exists
   * (even if its handler threw — the error is routed to onError).
   */
  async runCommand(name: string, args: string): Promise<boolean> {
    const command = this.#commands.get(name);
    if (!command) return false;
    try {
      await command.handler(args, this.#createContext(command.source));
    } catch (error) {
      this.#onError({
        source: command.source,
        phase: "command",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    return true;
  }

  // ==========================================================================
  // Dispatch
  // ==========================================================================

  /** Passive dispatch: every handler runs, in load order, errors isolated. */
  async emit<K extends KayaEventName>(event: K, payload: KayaEvents[K][0]): Promise<void> {
    for (const reg of this.#handlers) {
      if (reg.event !== event) continue;
      try {
        await (reg.handler as (e: unknown, ctx: KayaExtensionContext) => unknown)(
          payload,
          this.#createContext(reg.source),
        );
      } catch (error) {
        this.#onError({
          source: reg.source,
          phase: "handler",
          event,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  /**
   * `tool_call` dispatch: handlers may mutate `event.input` in place; the first
   * handler returning `{ block: true }` short-circuits.
   */
  async emitToolCall(event: ToolCallEvent): Promise<ToolCallResult | undefined> {
    for (const reg of this.#handlers) {
      if (reg.event !== "tool_call") continue;
      try {
        const result = (await reg.handler(
          event as never,
          this.#createContext(reg.source),
        )) as ToolCallResult | undefined | void;
        if (result && typeof result === "object" && result.block) return result;
      } catch (error) {
        this.#onError({
          source: reg.source,
          phase: "handler",
          event: "tool_call",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return undefined;
  }

  /**
   * `tool_result` dispatch: returned fields replace the event's fields, chained
   * so each handler observes previous replacements. Returns the merged
   * replacement, or undefined when no handler changed anything.
   */
  async emitToolResult(event: ToolResultEvent): Promise<ToolResultResult | undefined> {
    let changed = false;
    const merged: ToolResultResult = {};
    for (const reg of this.#handlers) {
      if (reg.event !== "tool_result") continue;
      try {
        const result = (await reg.handler(
          event as never,
          this.#createContext(reg.source),
        )) as ToolResultResult | undefined | void;
        if (!result || typeof result !== "object") continue;
        if (result.content !== undefined) {
          event.content = result.content;
          merged.content = result.content;
          changed = true;
        }
        if (result.details !== undefined) {
          event.details = result.details;
          merged.details = result.details;
          changed = true;
        }
        if (result.isError !== undefined) {
          event.isError = result.isError;
          merged.isError = result.isError;
          changed = true;
        }
      } catch (error) {
        this.#onError({
          source: reg.source,
          phase: "handler",
          event: "tool_result",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return changed ? merged : undefined;
  }

  /**
   * `before_provider_request` dispatch: each handler may return a replacement
   * payload; chained in load order. Returns the final payload.
   */
  async emitBeforeProviderRequest(event: BeforeProviderRequestEvent): Promise<unknown> {
    let payload = event.payload;
    for (const reg of this.#handlers) {
      if (reg.event !== "before_provider_request") continue;
      try {
        const result = (await reg.handler(
          { ...event, payload } as never,
          this.#createContext(reg.source),
        )) as unknown;
        if (result !== undefined) payload = result;
      } catch (error) {
        this.#onError({
          source: reg.source,
          phase: "handler",
          event: "before_provider_request",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return payload;
  }

  /** `before_compact` dispatch: first `{ cancel: true }` short-circuits. */
  async emitBeforeCompact(event: BeforeCompactEvent): Promise<BeforeCompactResult> {
    for (const reg of this.#handlers) {
      if (reg.event !== "before_compact") continue;
      try {
        const result = (await reg.handler(
          event as never,
          this.#createContext(reg.source),
        )) as BeforeCompactResult | undefined | void;
        if (result && typeof result === "object" && result.cancel) return { cancel: true };
      } catch (error) {
        this.#onError({
          source: reg.source,
          phase: "handler",
          event: "before_compact",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return {};
  }
}
