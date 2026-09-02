import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { escapeHtml } from "@kaya/server";

export const TELEGRAM_HTML_LIMIT = 4000; // a hair under Telegram's 4096

/** Condensed one-line tool summary, mirroring the CLI's collapsed-by-default rendering. */
export function toolSummaryLine(item: ToolTranscriptItem): string {
  const glyph = item.status === "running" ? "◌" : item.status === "error" ? "✗" : "✓";
  const summary = inputSummary(item.input);
  const chars = itemContent(item).length;
  const suffix = chars > 0 ? ` <i>(${linesOf(itemContent(item))} lines — /output to see)</i>` : "";
  return `${glyph} <code>${escapeHtml(item.toolName)} ${escapeHtml(summary)}</code>${suffix}`;
}

/** Full tool output in a <pre> block, chunked to Telegram limits. */
export function toolOutputChunks(item: ToolTranscriptItem): string[] {
  const header = `<b>${escapeHtml(item.toolName)}</b> ${escapeHtml(inputSummary(item.input))}\n`;
  const body = itemContent(item) || "(no output)";
  return chunkText(header + `<pre>${escapeHtml(body)}</pre>`);
}

export function assistantTextOf(content: readonly { type: string; text?: string; thinking?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

export function thinkingSummaryOf(content: readonly { type: string; thinking?: string }[]): string | undefined {
  const chars = content
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking ?? "")
    .join("").length;
  return chars > 0 ? `<i>thinking (${chars} chars — collapsed)</i>` : undefined;
}

export function plainAnswer(text: string, streaming: boolean): string {
  const cursor = streaming ? " ▍" : "";
  return chunkText(escapeHtml(truncate(text, TELEGRAM_HTML_LIMIT - 16)) + cursor)[0] ?? "…";
}

function inputSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    for (const key of ["path", "file_path", "filePath"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return truncate(text ?? "", 60);
}

function itemContent(item: ToolTranscriptItem): string {
  return item.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function linesOf(text: string): number {
  return text.split("\n").length;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Split on line boundaries where possible, never exceeding the limit. */
export function chunkText(text: string, limit = TELEGRAM_HTML_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
