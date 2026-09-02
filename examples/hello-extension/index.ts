import { Type } from "@kaya/extensions";
import type { KayaExtensionAPI } from "@kaya/extensions";

/**
 * Kaya example extension: one custom tool, one slash command, one lifecycle
 * hook. Copy this directory's index.ts into `.kaya/extensions/` of any project
 * (or `~/.kaya/extensions/` globally) and it loads without a build step.
 */
export default function helloExtension(kaya: KayaExtensionAPI): void {
  // Lifecycle hook: runs on every session start and /reload.
  kaya.on("session_start", (event, ctx) => {
    if (event.reason === "startup") {
      ctx.appendAssistantNote(`hello-extension active in ${ctx.cwd}`);
    }
  });

  // Custom tool: a real pi-agent-core AgentTool, callable by the model.
  kaya.registerTool({
    name: "get_current_time",
    label: "Get current time",
    description: "Returns the current local time and timezone offset.",
    parameters: Type.Object({
      format: Type.Optional(Type.Union([Type.Literal("iso"), Type.Literal("locale")])),
    }),
    execute: (_toolCallId, params) => {
      const now = new Date();
      const text = params.format === "locale" ? now.toLocaleString() : now.toISOString();
      return Promise.resolve({ content: [{ type: "text" as const, text }], details: undefined });
    },
  });

  // Slash command: `/hello <name>` in the client, dispatched server-side.
  kaya.registerCommand("hello", {
    description: "Greet someone",
    argumentHint: "<name>",
    handler: (args, ctx) => {
      ctx.appendAssistantNote(`Hello, ${args || "there"}! (from hello-extension)`);
    },
  });
}
