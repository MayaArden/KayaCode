import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/**
 * The complete set of events extensions can subscribe to via `kaya.on(...)`.
 *
 * Tier 1 events are the verbatim `AgentEvent` stream emitted by
 * `@earendil-works/pi-agent-core` (payloads ARE the pi-agent-core event
 * objects). Tier 2 events are synthesized by `@kaya/server` and use
 * kaya-owned payload types defined below.
 */

export type AgentEventOf<TType extends AgentEvent["type"]> = Extract<AgentEvent, { type: TType }>;

// ============================================================================
// Tier 2 event payloads (synthesized by the server)
// ============================================================================

export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload";
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload";
}

/**
 * Fired via the Agent's `onPayload` hook, immediately before a request payload
 * is sent to the provider. Handlers may return a replacement payload; chained
 * in load order (each handler sees the previous handler's replacement).
 */
export interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  provider: string;
  model: string;
  payload: unknown;
}

/** Return value of a `before_provider_request` handler: replacement payload. */
export type BeforeProviderRequestResult = unknown;

/** Passive mirror fired via the Agent's `onResponse` hook. */
export interface AfterProviderResponseEvent {
  type: "after_provider_response";
  provider: string;
  model: string;
  response: unknown;
}

export interface BeforeCompactEvent {
  type: "before_compact";
  reason: "threshold" | "manual";
  messageCount: number;
  estimatedTokens: number;
}

export interface BeforeCompactResult {
  /** Cancel this compaction pass. First handler to cancel short-circuits. */
  cancel?: boolean;
}

/**
 * Mutable interception point before a tool executes (dispatched from the
 * Agent's `beforeToolCall` hook). Mutate `input` in place to change the
 * arguments the tool receives, or return a block result to stop execution.
 */
export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolCallResult {
  /** Block tool execution; the tool returns an error result with `reason`. */
  block?: boolean;
  reason?: string;
  /** Hint to stop the agent after the current tool batch (see pi-agent-core). */
  terminate?: boolean;
}

/**
 * Mutable interception point after a tool executes (dispatched from the
 * Agent's `afterToolCall` hook). Returned fields replace the corresponding
 * fields on the tool result before it enters the transcript.
 */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details: unknown;
  isError: boolean;
}

export interface ToolResultResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}

// ============================================================================
// Event map: name -> [payload, handler result]
// ============================================================================

export interface KayaEvents {
  // ---- Tier 1: verbatim pi-agent-core agent loop events ----
  agent_start: [AgentEventOf<"agent_start">, void];
  agent_end: [AgentEventOf<"agent_end">, void];
  turn_start: [AgentEventOf<"turn_start">, void];
  turn_end: [AgentEventOf<"turn_end">, void];
  message_start: [AgentEventOf<"message_start">, void];
  message_update: [AgentEventOf<"message_update">, void];
  message_end: [AgentEventOf<"message_end">, void];
  tool_execution_start: [AgentEventOf<"tool_execution_start">, void];
  tool_execution_update: [AgentEventOf<"tool_execution_update">, void];
  tool_execution_end: [AgentEventOf<"tool_execution_end">, void];

  // ---- Tier 2: synthesized by @kaya/server ----
  session_start: [SessionStartEvent, void];
  session_shutdown: [SessionShutdownEvent, void];
  before_provider_request: [BeforeProviderRequestEvent, BeforeProviderRequestResult];
  after_provider_response: [AfterProviderResponseEvent, void];
  before_compact: [BeforeCompactEvent, BeforeCompactResult];
  tool_call: [ToolCallEvent, ToolCallResult];
  tool_result: [ToolResultEvent, ToolResultResult];
}

export type KayaEventName = keyof KayaEvents;

/** Events whose handlers may return a value that changes behavior. */
export const MUTABLE_EVENT_NAMES = [
  "before_provider_request",
  "before_compact",
  "tool_call",
  "tool_result",
] as const satisfies readonly KayaEventName[];

export type KayaMutableEventName = (typeof MUTABLE_EVENT_NAMES)[number];

/** Whether an event has bespoke (mutating) dispatch semantics. */
export function isMutableEvent(name: KayaEventName): name is KayaMutableEventName {
  return (MUTABLE_EVENT_NAMES as readonly string[]).includes(name);
}
