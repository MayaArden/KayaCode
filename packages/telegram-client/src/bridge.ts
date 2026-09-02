import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import type { PiSessionHandle } from "@earendil-works/pi-client";

/** The Telegram-facing edge; grammy adapts it in bot.ts, tests record it. */
export interface TelegramSink {
  send(chatId: number, html: string): Promise<number>;
  edit(chatId: number, messageId: number, html: string): Promise<void>;
}

import { assistantTextOf, plainAnswer, thinkingSummaryOf, toolOutputChunks, toolSummaryLine } from "./format.js";
import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";

interface StreamingAnswer {
  telegramMessageId: number;
  text: string;
}

/**
 * One Telegram chat <-> one kaya session. Turns the session's snapshot+progress
 * event stream into Telegram-appropriate messages: condensed tool summaries by
 * default (matching the CLI's collapse-by-default), full output via /output,
 * answers edited in place as they stream.
 */
export class ChatBridge {
  readonly chatId: number;
  readonly #sink: TelegramSink;
  #session: PiSessionHandle | undefined;
  #unsub: Array<() => void> = [];
  #phase: SessionSnapshot["phase"] = "idle";
  #streaming = new Map<string, StreamingAnswer>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #toolOutputs: ToolTranscriptItem[] = [];

  constructor(chatId: number, sink: TelegramSink) {
    this.chatId = chatId;
    this.#sink = sink;
  }

  get phase(): SessionSnapshot["phase"] {
    return this.#phase;
  }

  get session(): PiSessionHandle | undefined {
    return this.#session;
  }

  attach(session: PiSessionHandle): void {
    this.detach();
    this.#session = session;
    this.#phase = session.snapshot?.phase ?? "idle";
    this.#unsub.push(
      session.subscribe((snapshot) => {
        if (snapshot.id !== session.id) return;
        this.#phase = snapshot.phase;
      }),
      session.onEvent((event) => {
        if (event.type !== "session_progress") return;
        void this.#onProgress(event.progress);
      }),
    );
  }

  detach(): void {
    for (const unsub of this.#unsub) unsub();
    this.#unsub = [];
    this.#session = undefined;
  }

  /** Plain user text → prompt (idle) or steer (busy). */
  async submit(text: string): Promise<void> {
    const session = this.#requireSession();
    if (this.#phase === "idle") await session.prompt(text);
    else await session.steer(text);
  }

  async abort(): Promise<void> {
    await this.#requireSession().abort();
    await this.#say("<i>aborted</i>");
  }

  /** /output [n] — full output of the nth-from-last (default: last) tool call. */
  async showOutput(n?: number): Promise<void> {
    const index = n ?? 1;
    const item = this.#toolOutputs.at(-index);
    if (!item) {
      await this.#say("No tool output recorded yet in this chat.");
      return;
    }
    for (const chunk of toolOutputChunks(item)) await this.#say(chunk);
  }

  get toolOutputCount(): number {
    return this.#toolOutputs.length;
  }

  async #onProgress(progress: import("@earendil-works/pi-protocol").TranscriptProgress): Promise<void> {
    if (progress.type === "assistant_delta" && progress.kind === "text") {
      const entry = this.#streaming.get(progress.messageId) ?? (await this.#startAnswer(progress.messageId));
      entry.text += progress.delta;
      this.#scheduleFlush();
    } else if (progress.type === "item_finished") {
      const item = progress.item;
      if (item.role === "assistant") {
        await this.#finishAnswer(item.id, assistantTextOf(item.content), thinkingSummaryOf(item.content));
      } else if (item.role === "tool") {
        this.#toolOutputs.push(item);
        if (this.#toolOutputs.length > 50) this.#toolOutputs.shift();
        await this.#say(toolSummaryLine(item));
      }
    }
  }

  async #startAnswer(messageId: string): Promise<StreamingAnswer> {
    const telegramMessageId = await this.#sink.send(this.chatId, "…");
    const entry: StreamingAnswer = { telegramMessageId, text: "" };
    this.#streaming.set(messageId, entry);
    return entry;
  }

  #scheduleFlush(): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flush();
    }, 700);
  }

  async #flush(): Promise<void> {
    for (const entry of this.#streaming.values()) {
      await this.#sink.edit(this.chatId, entry.telegramMessageId, plainAnswer(entry.text, true));
    }
  }

  async #finishAnswer(messageId: string, text: string, thinking?: string): Promise<void> {
    const entry = this.#streaming.get(messageId);
    if (entry) {
      this.#streaming.delete(messageId);
      await this.#sink.edit(this.chatId, entry.telegramMessageId, plainAnswer(text, false));
    } else if (text) {
      await this.#say(plainAnswer(text, false));
    }
    if (thinking) await this.#sink.send(this.chatId, thinking);
  }

  async #say(html: string): Promise<void> {
    await this.#sink.send(this.chatId, html);
  }

  #requireSession(): PiSessionHandle {
    if (!this.#session) throw new Error("no session attached to this chat");
    return this.#session;
  }
}
