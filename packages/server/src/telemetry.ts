import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type {
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { defineTelemetrySchema } from "@earendil-works/pi-telemetry";

/**
 * Kaya's telemetry span schema. pi-agent-core's harness schema vocabulary is
 * tied to harness concepts (lanes, checkpoints) kaya does not have, so the
 * server defines its own small schema over the same mechanics.
 */
export const KAYA_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    "kaya.session.run": {
      description: "One agent run (prompt → agent_end), server-side.",
      parents: { kind: "root_or_external" },
      startAttributes: {
        "kaya.session.id": { type: "string", required: true, description: "Session id" },
        "kaya.provider": { type: "string", required: true, description: "Model provider id" },
        "kaya.model": { type: "string", required: true, description: "Model id" },
      },
      endAttributes: {
        "kaya.stop_reason": { type: "string", description: "Final assistant stopReason" },
      },
      status: { default: "ok", errorWhen: "run throws or is aborted with an error" },
    },
    "kaya.tool.call": {
      description: "One tool execution.",
      parents: { kind: "spans", spans: ["kaya.session.run"] },
      startAttributes: {
        "kaya.tool.name": { type: "string", required: true, description: "Tool name" },
        "kaya.tool.call_id": { type: "string", required: true, description: "Tool call id" },
      },
      endAttributes: {
        "kaya.tool.is_error": { type: "boolean", description: "Whether the tool result is an error" },
      },
      status: { default: "ok", errorWhen: "tool result isError" },
    },
    "kaya.compaction": {
      description: "Context compaction pass.",
      parents: { kind: "any" },
      startAttributes: {
        "kaya.session.id": { type: "string", required: true, description: "Session id" },
        "kaya.compaction.reason": { type: "string", required: true, description: "threshold | manual" },
      },
      endAttributes: {
        "kaya.compaction.tokens_before": { type: "number", description: "Estimated tokens before compaction" },
      },
      status: { default: "ok", errorWhen: "compaction fails" },
    },
  },
});

interface RecordedSpanLine {
  ts: number;
  id: number;
  parentId: number | null;
  name: string;
  attributes: Record<string, unknown>;
  events: { name: string; attributes: Record<string, unknown> }[];
  status: SpanStatus;
  durationMs?: number;
}

class JsonlSpan implements TelemetrySpan {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly #sink: JsonlTelemetryContext;
  readonly #startTime: number;
  #attributes: Record<string, unknown>;
  #events: { name: string; attributes: Record<string, unknown> }[] = [];
  #status: SpanStatus = { status: "ok" };
  #explicitStatus = false;
  #settled = false;

  constructor(sink: JsonlTelemetryContext, id: number, parentId: number | null, name: string, attributes: Record<string, unknown>) {
    this.#sink = sink;
    this.id = id;
    this.parentId = parentId;
    this.name = name;
    this.#attributes = { ...attributes };
    this.#startTime = performance.now();
  }

  startSpan<T>(options: { name: string; attributes?: Record<string, unknown> }, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    return this.#sink.startSpan(options, callback, this.id);
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    if (this.#settled) return;
    this.#events.push({ name, attributes: { ...attributes } });
  }

  setAttributes(attributes: Record<string, unknown>): void {
    if (this.#settled) return;
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.#attributes[key] = value;
    }
  }

  setStatus(status: SpanStatus): void {
    if (this.#settled) return;
    this.#status = status;
    this.#explicitStatus = true;
  }

  settle(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    if (error !== undefined && !this.#explicitStatus) {
      this.#status = {
        status: "error",
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "Error", message: String(error) },
      };
    }
    this.#sink.write({
      ts: Date.now(),
      id: this.id,
      parentId: this.parentId,
      name: this.name,
      attributes: this.#attributes,
      events: this.#events,
      status: this.#status,
      durationMs: Math.round(performance.now() - this.#startTime),
    });
  }
}

/**
 * Reference TelemetryContext adapter: appends one JSON line per settled span.
 * pi-telemetry ships no exporters, so the server provides its own sink.
 */
export class JsonlTelemetryContext implements TelemetryContext {
  readonly #filePath: string;
  #nextId = 1;

  constructor(filePath: string) {
    this.#filePath = filePath;
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  get filePath(): string {
    return this.#filePath;
  }

  startSpan<T>(
    options: { name: string; attributes?: Record<string, unknown> },
    callback: (span: TelemetrySpan) => T | Promise<T>,
    parentId: number | null = null,
  ): Promise<T> {
    const span = new JsonlSpan(this, this.#nextId++, parentId, options.name, options.attributes ?? {});
    let result: T | Promise<T>;
    try {
      result = callback(span);
    } catch (error) {
      span.settle(error);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          span.settle(undefined);
          return value;
        },
        (error: unknown) => {
          span.settle(error);
          throw error;
        },
      );
    }
    span.settle(undefined);
    return Promise.resolve(result);
  }

  write(line: RecordedSpanLine): void {
    try {
      appendFileSync(this.#filePath, `${JSON.stringify(line)}\n`);
    } catch {
      // Telemetry must never break the session.
    }
  }
}
