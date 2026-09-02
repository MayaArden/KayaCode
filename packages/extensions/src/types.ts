import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { KayaEventName, KayaEvents } from "./events.js";

/**
 * Kaya's thinking-level vocabulary. Matches pi-agent-core and pi-protocol
 * (pi-ai's own ThinkingLevel omits "off" because it is model-facing).
 */
export type KayaThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Where an extension registration came from. Kept source-agnostic on purpose. */
export interface ExtensionSourceInfo {
  /** Absolute file path, `<inline:name>` for programmatic sources, etc. */
  path: string;
  kind: "file" | "inline" | "package";
}

/**
 * The session surface extensions are allowed to touch. Implemented per-session
 * by `@kaya/server`; extensions never get the raw Agent.
 */
export interface KayaSessionFacade {
  readonly cwd: string;
  /** Aborted when the session is disposed. */
  readonly signal: AbortSignal;
  isIdle(): boolean;
  getModel(): { provider: string; id: string };
  getThinkingLevel(): KayaThinkingLevel;
  setThinkingLevel(level: KayaThinkingLevel): void;
  /** Inject a message after the current turn's tools finish. */
  steer(text: string): void;
  /** Queue a message delivered only when the loop would otherwise stop. */
  followUp(text: string): void;
  /** Run a prompt server-side (triggers a full agent turn). */
  prompt(text: string): Promise<void>;
  /**
   * Append a display note to the transcript as an assistant message. Visible
   * to every connected client; also enters LLM context (documented behavior).
   */
  appendAssistantNote(text: string): void;
  /** Names of the tools currently active on the agent. */
  listTools(): string[];
}

/** Handler context: the session facade plus the extension's own source info. */
export interface KayaExtensionContext extends KayaSessionFacade {
  readonly source: ExtensionSourceInfo;
}

export type KayaHandler<K extends KayaEventName> = (
  event: KayaEvents[K][0],
  ctx: KayaExtensionContext,
) => KayaEvents[K][1] | void | Promise<KayaEvents[K][1] | void>;

export interface KayaCompletionItem {
  value: string;
  label?: string;
  description?: string;
}

export interface KayaCommandDef {
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => KayaCompletionItem[] | null | Promise<KayaCompletionItem[] | null>;
  handler: (args: string, ctx: KayaExtensionContext) => void | Promise<void>;
}

/**
 * The API object handed to every extension factory. Registration methods may
 * be called while the factory runs; everything else flows through the handler
 * context (`ctx`) at event time.
 */
export interface KayaExtensionAPI {
  /** Subscribe to a lifecycle event. Handlers run sequentially in load order. */
  on<K extends KayaEventName>(event: K, handler: KayaHandler<K>): void;

  /**
   * Register a real pi-agent-core `AgentTool`. Source-agnostic: any well-formed
   * AgentTool is accepted, whatever produced it (local extension, future MCP
   * bridge, plugin manifest).
   */
  registerTool<TParameters extends TSchema = TSchema, TDetails = unknown>(
    tool: AgentTool<TParameters, TDetails>,
  ): void;

  /** Register a `/name args...` command, dispatched server-side. */
  registerCommand(name: string, def: KayaCommandDef): void;
}

/** Extension module shape: default-exported factory. */
export type KayaExtensionFactory = (kaya: KayaExtensionAPI) => void | Promise<void>;

/** A registered handler command, with provenance. */
export interface RegisteredCommand extends KayaCommandDef {
  name: string;
  source: ExtensionSourceInfo;
}

export interface RegisteredTool {
  tool: AgentTool;
  source: ExtensionSourceInfo;
}

export type KayaExtensionErrorPhase = "load" | "handler" | "command";

export interface KayaExtensionError {
  source: ExtensionSourceInfo;
  phase: KayaExtensionErrorPhase;
  /** Event name for handler-phase errors. */
  event?: KayaEventName;
  error: Error;
}
