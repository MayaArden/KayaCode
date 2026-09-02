import type { PiClient } from "@earendil-works/pi-client";
import type { ThinkingLevel } from "@earendil-works/pi-protocol";
import { parseModelRef } from "@kaya/server";

export interface PrintModeOptions {
  client: PiClient;
  cwd: string;
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * One-shot mode: stream the answer as plain text; tool calls announced as
 * single lines. Exit code 1 when the run ends in error.
 */
export async function runPrintMode(options: PrintModeOptions): Promise<number> {
  const session = await options.client.createSession({
    cwd: options.cwd,
    ...(options.model !== undefined ? { model: parseModelRef(options.model) } : {}),
    ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
  });

  const unsub = session.onEvent((event) => {
    if (event.type !== "session_progress") return;
    const progress = event.progress;
    if (progress.type === "assistant_delta" && progress.kind === "text") {
      process.stdout.write(progress.delta);
    } else if (progress.type === "item_started" && progress.item.role === "tool") {
      const item = progress.item;
      process.stdout.write(`\n> ${item.toolName}(${summarize(item.input)})\n`);
    } else if (progress.type === "item_finished" && progress.item.role === "tool" && progress.item.isError) {
      const text = progress.item.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      process.stdout.write(`  [tool error] ${text.slice(0, 500)}\n`);
    }
  });

  let exitCode = 0;
  try {
    const snapshot = await session.prompt(options.prompt);
    process.stdout.write("\n");
    const lastAssistant = [...snapshot.transcript].reverse().find((i) => i.role === "assistant");
    if (lastAssistant && (lastAssistant.status === "error" || lastAssistant.status === "aborted")) {
      exitCode = 1;
      // Surface the failure — without this the error only lives in the session file.
      const message = (lastAssistant as { errorMessage?: string }).errorMessage;
      if (message) process.stderr.write(`kaya: ${message.slice(0, 500)}\n`);
    }
  } finally {
    unsub();
    await session.dispose().catch(() => {});
  }
  return exitCode;
}

function summarize(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
