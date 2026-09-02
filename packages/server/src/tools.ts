import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Static, TSchema } from "@earendil-works/pi-ai";

/**
 * Kaya's default tool set: pi-agent-core's own well-tested built-ins
 * (bash/read/edit/write), with the harness context bound in so they satisfy
 * the plain `AgentTool` contract the Agent loop executes.
 */
function bindContext<TParams extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParams, TDetails>,
  context: ExecutionToolContext,
): AgentTool<TParams, TDetails> {
  const { execute, ...rest } = tool;
  return {
    ...rest,
    execute: (
      toolCallId: string,
      params: Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ): Promise<AgentToolResult<TDetails>> => execute(toolCallId, params, signal, onUpdate, context),
  };
}

export function createDefaultTools(cwd: string, options?: { notifyTelegram?: AgentTool }): AgentTool[] {
  const context: ExecutionToolContext = { env: new NodeExecutionEnv({ cwd }) };
  const tools: AgentTool[] = [
    bindContext(createBashTool(), context),
    bindContext(createReadTool(), context),
    bindContext(createEditTool(), context),
    bindContext(createWriteTool(), context),
  ];
  if (options?.notifyTelegram) tools.push(options.notifyTelegram);
  return tools;
}
