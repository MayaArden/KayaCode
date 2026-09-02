export * from "./events.js";
export * from "./types.js";
export { ExtensionHost, type ExtensionHostOptions } from "./host.js";
export {
  ExtensionLoader,
  discoverExtensionPaths,
  discoverInDir,
  type ExtensionLoadError,
  type LoaderOptions,
  type LoadResult,
} from "./loader.js";

// Convenience re-exports so extension authors need only @kaya/extensions.
export { Type } from "@earendil-works/pi-ai";
export type { Static, TSchema, TextContent, ImageContent, ThinkingLevel } from "@earendil-works/pi-ai";
export type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
