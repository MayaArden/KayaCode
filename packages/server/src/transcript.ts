import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  sanitizeProtocolDetails,
  toProtocolAssistantMessage,
  toProtocolToolResultMessage,
  toProtocolUserMessage,
} from "@earendil-works/pi-server";

/**
 * Maps pi-agent-core messages to pi-protocol transcript items. Owns stable
 * item ids (pi-ai messages carry none) so snapshots and progress deltas line
 * up across a session.
 */
export class TranscriptMapper {
  readonly #messageIds = new WeakMap<object, string>();
  readonly #toolCallById = new Map<string, ToolCall>();
  readonly #toolItemIds = new Map<string, string>();

  /** Deterministic transcript id for tool items: progress and snapshot ids match. */
  toolItemIdFor(toolCallId: string): string {
    let id = this.#toolItemIds.get(toolCallId);
    if (!id) {
      id = `tool-${toolCallId}`;
      this.#toolItemIds.set(toolCallId, id);
    }
    return id;
  }

  idFor(message: AgentMessage): string {
    let id = this.#messageIds.get(message);
    if (!id) {
      id = uuidv7();
      this.#messageIds.set(message, id);
    }
    return id;
  }

  /** Pin an id to a message object (streaming-started assistant messages). */
  setId(message: AgentMessage, id: string): void {
    this.#messageIds.set(message, id);
  }

  /** Build the full snapshot transcript from the agent's message list. */
  toTranscript(messages: AgentMessage[]): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    for (const message of messages) {
      const item = this.toItem(message);
      if (item) items.push(item);
    }
    return items;
  }

  toItem(message: AgentMessage): TranscriptItem | undefined {
    if (message.role === "user") {
      return toProtocolUserMessage(message, { id: this.idFor(message) });
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") this.#toolCallById.set(block.id, block);
      }
      return toProtocolAssistantMessage(message, { id: this.idFor(message) });
    }
    if (message.role === "toolResult") {
      const call = this.findToolCall(message.toolCallId, message.toolName);
      return toProtocolToolResultMessage(message, { id: this.toolItemIdFor(message.toolCallId), call });
    }
    // Custom kaya/pi message roles are not representable in protocol v1.
    return undefined;
  }

  findToolCall(toolCallId: string, toolName: string): ToolCall {
    return (
      this.#toolCallById.get(toolCallId) ?? { type: "toolCall", id: toolCallId, name: toolName, arguments: {} }
    );
  }

  toolCallForMessage(message: ToolResultMessage): ToolCall {
    return this.findToolCall(message.toolCallId, message.toolName);
  }
}

/** A tool transcript item in `running` state, for `tool_execution_start`. */
export function runningToolItem(id: string, toolCallId: string, toolName: string, input: unknown): ToolTranscriptItem {
  return {
    id,
    role: "tool",
    toolCallId,
    toolName,
    input: sanitizeProtocolDetails(input) ?? null,
    content: [],
    timestamp: Date.now(),
    status: "running",
    isError: false,
  };
}

/** A tool transcript item updated with a partial result, still `running`. */
export function runningToolItemWithContent(
  id: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  partial: { content?: unknown } | undefined,
): ToolTranscriptItem {
  const content = extractItemContent(partial);
  return {
    id,
    role: "tool",
    toolCallId,
    toolName,
    input: sanitizeProtocolDetails(input) ?? null,
    content,
    timestamp: Date.now(),
    status: "running",
    isError: false,
  };
}

/** A finalized tool transcript item. */
export function finishedToolItem(
  id: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  result: { content?: unknown; details?: unknown } | undefined,
  isError: boolean,
): ToolTranscriptItem {
  const content = extractItemContent(result);
  const details = sanitizeProtocolDetails(result?.details);
  if (isError) {
    return {
      id,
      role: "tool",
      toolCallId,
      toolName,
      input: sanitizeProtocolDetails(input) ?? null,
      content,
      ...(details !== undefined ? { details } : {}),
      timestamp: Date.now(),
      status: "error",
      isError: true,
    };
  }
  return {
    id,
    role: "tool",
    toolCallId,
    toolName,
    input: sanitizeProtocolDetails(input) ?? null,
    content,
    ...(details !== undefined ? { details } : {}),
    timestamp: Date.now(),
    status: "complete",
    isError: false,
  };
}

function extractItemContent(result: { content?: unknown } | undefined): { type: "text"; text: string }[] {
  const raw = result?.content;
  if (!Array.isArray(raw)) return [];
  const out: { type: "text"; text: string }[] = [];
  for (const block of raw) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      out.push({ type: "text", text: String((block as { text?: unknown }).text ?? "") });
    }
  }
  return out;
}
