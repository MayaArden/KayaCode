# Phase 1 study notes — Pi monorepo @ 23842b1e6 (v0.84.4, all packages lockstep)

Distilled from 12 read-only study passes over the local checkout plus direct
verification of `coding-agent/src/core/extensions/types.ts` and `.../extensions/loader.ts`.
Full sub-agent transcripts live in the session tool-results log; this file is the
build-relevant distillation.

## pi-agent-core (`@earendil-works/pi-agent-core`, v0.84.4, ESM, node>=22.19)

- `new Agent(options)`: `initialState` ({systemPrompt, model, thinkingLevel, tools, messages}),
  required-by-type `streamFn` (runtime falls back to `setDefaultStreamFn`), `getApiKey`,
  `onPayload`/`onResponse` (pi-ai SimpleStreamOptions hooks — our `before_provider_request`
  surface), `beforeToolCall`/`afterToolCall` (block/modify), `shouldStopAfterTurn`,
  `prepareNextTurn[WithContext]`, `steeringMode`/`followUpMode` ("all"|"one-at-a-time"),
  `thinkingBudgets`, `transport`, `toolExecution` ("parallel"|"sequential"), `sessionId`.
- Methods: `subscribe(listener) -> unsub` (listeners awaited sequentially, in order),
  `prompt(string|AgentMessage[])`, `continue()`, `steer(msg)`, `followUp(msg)`,
  `abort()`, `waitForIdle()` (settles after awaited agent_end listeners), `reset()`,
  `state` (tools/messages copy-on-assign only; hook fields are public mutable props).
- AgentEvent union — the complete 10: `agent_start`, `agent_end {messages}`,
  `turn_start`, `turn_end {message, toolResults}`,
  `message_start {message}`, `message_update {message, assistantMessageEvent}`,
  `message_end {message}`,
  `tool_execution_start {toolCallId, toolName, args}`,
  `tool_execution_update {+partialResult}`, `tool_execution_end {toolCallId, toolName, result, isError}`.
  (message_update.assistantMessageEvent.type: start/text_start/text_delta/text_end/
  thinking_start/thinking_delta/thinking_end/toolcall_start/toolcall_delta/toolcall_end/done/error)
- `AgentTool<TParams extends TSchema, TDetails>` = pi-ai `Tool` {name, description,
  parameters(TypeBox)} + `label`, `prepareArguments?`, `executionMode?`,
  `execute(toolCallId, params, signal?, onUpdate?) -> {content, details, usage?, addedToolNames?, terminate?}`.
  Tools throw on failure; loop converts to error tool result. `terminate:true` stops loop
  only if every result in the batch sets it.
- beforeToolCall ctx {assistantMessage, toolCall, args, context} -> {block?, reason?, terminate?};
  afterToolCall ctx {+result, isError} -> field-replacement {content?, details?, isError?, usage?, terminate?}.
- Also ships (same package): harness layer (`AgentHarness` — scaffold, all ops reject
  HarnessNotImplemented today), JSONL session repo (`JsonlSessionRepo`), compaction helpers
  (`compact`, `shouldCompact`, `estimateContextTokens`, `DEFAULT_COMPACTION_SETTINGS`),
  built-in tool factories `createBashTool/createEditTool/createReadTool/createWriteTool`,
  `Session`/`SessionRepo` contracts, `./node` subpath (`NodeExecutionEnv`).
  Re-exports pi-telemetry schema constants: `AGENT_TELEMETRY_SCHEMAS`, `startAiSpan`, `startHarnessSpan`.

## pi-ai (`@earendil-works/pi-ai`)

- `createModels({credentials?, modelsStore?, authContext?}) -> MutableModels`;
  `models.setProvider(provider)`, `models.getModel(provider, id)`,
  `models.streamSimple(model, ctx, opts)` — satisfies `StreamFn` for Agent.
- Provider = inert factory; register via `setProvider`. Subpaths: `./providers/*`,
  `./api/*`, `./oauth`, `./compat` (deprecated global-api; avoid), root is side-effect-free.
- 39 built-in provider factories (anthropic, openai, openrouter, google, bedrock, ...).
  **NO Ollama provider** — local models need a custom provider via
  `createProvider({id, auth, models, api: openAICompletionsApi-ish, baseUrl})`
  (`api: "openai-completions"` stream impl; auth object mandatory even for keyless local).
- `CredentialStore`: read/list/modify/delete; `modify` is the only write path (serialized).
  `InMemoryCredentialStore` default. Auth precedence: explicit override -> stored cred
  (OAuth refreshed under lock) -> env/ambient.
- Model type: {id, name, api, provider, baseUrl, reasoning, thinkingLevelMap?, input,
  cost, contextWindow, maxTokens, samplingParams?, headers?, compat?}.
- Re-exports TypeBox `Type`/`Static`/`TSchema` from root.

## pi-tui (`@earendil-works/pi-tui`) — pure UI lib, zero colors of its own

- `TUI` interface (component tree, overlays, input listeners, requestRender throttled 16ms,
  start/stop). `TuiMainScreen` = differential line renderer (main buffer);
  `TuiAltScreen` = fullscreen ScrollView app (`setLayoutRoot`, follow:"end").
- `Component { render(width): string[]; handleInput?(data); invalidate() }` — one ANSI line
  per array entry, MUST fit width (throws in main-screen mode otherwise).
- `Editor(tui, theme: EditorTheme, options?)` — multiline editor,
  `onSubmit(text)`, `setAutocompleteProvider`, history, paste markers, `borderColor` mutable.
- `CombinedAutocompleteProvider(commands: SlashCommand[], basePath, fdPath?)` —
  `/` commands at line 0, `@` file fuzzy (needs `fd` binary), else sync readdir path completion.
- `SlashCommand { name, description?, argumentHint?, getArgumentCompletions?(prefix) }`.
- Components: Text, Markdown (theme = bag of (text)=>string fns), SelectList, Loader,
  CancellableLoader, Box, ScrollView, VStack/HStack, Spacer, Input, Image, SettingsList...
- Keybindings global singleton (`getKeybindings`), TUI_KEYBINDINGS ids `tui.*`.
- `matchesKey(data, keyId)`, raw mode => handle ctrl+c yourself.
- Pattern (confirmed by pi usage): one Component per transcript block, mutate on events,
  `tui.requestRender()`; recreate/setText Markdown per delta.
- Render-state handoff: `captureRenderState`/`restoreRenderState`, `stop({preserveScreen})`.
- Crash guard: line wider than width writes pi-crash.log (logDirectory param — pass our own).

## pi-protocol (`@earendil-works/pi-protocol`) — wire vocab, no transport

- CBOR (strict RFC8949 subset) + 4-byte BE length prefix. Transport-agnostic; needs only an
  ordered byte stream. Node/browser neutral. Dep: typebox only.
- Handshake: client `{type:"hello", version:1}` -> server `hello {version, connectionId,
  snapshot: ServerSnapshot}` or `hello_error`. Then `{type:"request", id, request: Command}`
  <-> `{type:"response", id, ok, result|error}` + push `{type:"event", event}`.
- Commands (9, exact): `list`, `create`, `attach`, `detach`, `prompt`, `steer`, `abort`,
  `set_model`, `set_thinking`.
- ServerEvent: `server_snapshot`, `session_snapshot`, `session_progress`, `session_removed`.
- TranscriptProgress: `item_started` | `assistant_delta {messageId, contentIndex,
  kind:"text"|"thinking"|"toolCall", delta}` | `item_updated` | `item_finished`.
- TranscriptItem roles: `user` | `assistant` | `tool`; content blocks: text/thinking/image/toolCall.
  Assistant status: streaming|complete|error|aborted. Tool status: running|complete|error.
  SessionPhase: idle|turn|compaction|branch_summary|retry.
- Snapshots are AUTHORITATIVE and carry full transcript; progress is advisory deltas.
  No slash-command/extension concept on the wire. additionalProperties:false everywhere.

## pi-server (`@earendil-works/pi-server`) — hosts protocol, NOT the Agent

- No pi-agent-core dep. Consumer implements:
  `PiServerService { listSessions, listModels, createSession(opts), openSession(id) }`
  returning `PiSessionRuntime { snapshot(), getPhase(), prompt({text}), steer({text}),
  abort(), setModel(ModelRef), setThinking(level), subscribe(listener) -> unsub, dispose() }`.
- Runtime events: `{type:"snapshot"}` (server re-reads snapshot + broadcasts),
  `{type:"progress", progress: TranscriptProgress}` (forwarded verbatim),
  `{type:"error"}` (server force-closes attached connections + disposes runtime).
- `new PiServer(service, {listeners, maxFrameLength?, handshakeTimeoutMs?, serverId?, onError?})`;
  `createUnixServer(service, {path, mode?})` preset (`./unix` subpath). Listeners are injectable
  SPI — we can write an in-process listener for combined mode.
- Bridge helpers exported: `toProtocolAssistantMessage`, `toProtocolUserMessage`,
  `toProtocolToolResultMessage`, `toProtocolModelMetadata`, `sanitizeProtocolDetails` (lossy
  JsonValue conversion for tool details). "deferred" stopReason throws (protocol v1).
- Exclusive runtime acquisition; conflicting ops reject; auto-dispose when detached+idle.
- `./testing` subpath = conformance harness (createTestServer/ProtocolTestClient/WireChannel).

## pi-client (`@earendil-works/pi-client`)

- `PiClient.connect({transportFactory, maxFrameLength?, onListenerError?})`; options:
  `transportFactory: (handlers {onData,onClose,onError}) -> ByteTransport {send, close}`.
  `./unix` subpath `createUnixTransportFactory({path})` (throws on win32!).
- `client.createSession({cwd?, name?, model?, thinkingLevel?})` / `attachSession` /
  `acquireSession(id, {mode:"shared"|"exclusive"})` -> SessionLease:
  `prompt/steer/abort/setModel/setThinking -> SessionSnapshot`,
  `subscribe(snapshot listener)`, `onEvent(ServerEvent listener)`, `detach()/dispose()`.
- `client.subscribe(ServerSnapshot)`, `client.onEvent(ServerEvent)`,
  `client.onConnectionStateChange`; NO auto-reconnect (`reconnect()` manual).
- Recommended UI pattern (from coding-agent/src/client): snapshots authoritative,
  progress deltas overlaid: text/thinking append per contentIndex; toolCall args
  accumulated per `${messageId}:${contentIndex}` buffer and JSON.parsed per delta;
  `item_finished` drops buffers; queuedSteer appended at end.

## pi-telemetry (`@earendil-works/pi-telemetry`) — contract only, no exporters

- `TelemetryContext.startSpan(options, cb)`; `TelemetrySpan` = context + addEvent/setAttributes/
  setStatus. `NOOP_TELEMETRY_CONTEXT`, `InMemoryTelemetryContext` (no timestamps, local ids).
- `defineTelemetrySchema` (identity, compile-time), `createTypedSpanStarter(ctx, schemas)`.
- Closed vocabulary lives in pi-agent-core: AI_TELEMETRY_SCHEMA (`pi.ai.request`),
  HARNESS_TELEMETRY_SCHEMA (pi.harness.run/turn/step/tool/hook/...), AGENT_TELEMETRY_SCHEMAS.
- **Caveat:** no Pi package actually emits spans yet (harness scaffold, pi-ai only plumbs
  `telemetryContext` through stream options). Our server must wrap the loop itself.
  pi-ai accepts `telemetryContext?` in stream options — pass our span context through.
- `./testing` conformance suite is reusable for our own exporter adapter.

## session-backends

- Only `@earendil-works/pi-session-backend-sqlite-node` (12-table schema, lanes/facts,
  writer leases, FTS5 search). No JSON-file backend. For v1's "simple JSON-file" persistence
  we write our own tiny store; SQLite package stays an upgrade path.

## pi-coding-agent — design lessons (reference only, no code copied)

Verified directly: `core/extensions/types.ts` (ExtensionAPI, 38 `pi.on` events) and
`core/extensions/loader.ts` (jiti loader, 806 lines).

- ExtensionAPI on(event): 38 lifecycle events — full list captured in swarm output.
  Categories: session lifecycle (session_start/shutdown/before_compact/...), context
  mutation (context, before_provider_request(+headers), after_provider_response),
  agent loop mirror (agent_start..tool_execution_end), tool interception (tool_call mutable
  block/mutate-input; tool_result rewrite), input (transform/handle), UI (ui_prompt_*,
  renderers, widgets).
- Dispatch semantics worth adopting: handlers sequential in load order; mutable/return-valued
  events get bespoke emitters (chaining transforms, short-circuit on block/cancel); passive
  events share one loop; per-handler error isolation routed to onError listeners;
  load-time factory errors discard just that extension (commit/discard pattern).
- Stale-context poisoning after session replacement/reload is the load-bearing safety
  mechanism (all ctx getters throw post-invalidate).
- Loader: jiti (`createJiti`, moduleCache:false) with virtualModules mapping for bundled
  builds; discovery = project dir + global dir + configured paths, one level deep,
  `*.ts|js` or subdir index or package.json manifest; no build step. `/reload` clears
  module cache and rebuilds the whole runner.
- Tool registration chain: registerTool -> extension.tools map -> runner registry
  (first registration per name wins; extension tools override builtins) ->
  `agent.state.tools = merged` + system prompt rebuild. Agent-level beforeToolCall/
  afterToolCall installed ONCE and read current runner lazily (survives /reload).
- Slash commands are dispatched CLIENT-side in-process in pi (prompt() intercepts leading
  `/`); the wire protocol has no command concept.
- Modes: interactive / print (-p) / json / rpc share one core and differ only in
  bindExtensions({mode}) + output plumbing. CLI arg parsing is hand-rolled.
- coding-agent has NO server hosting (src/server/create-harness.ts wraps the harness
  scaffold, used only by its own test); pi-server/pi-client are experimental and consumed
  by nothing else in the monorepo. We will be their first real consumer.
- Built-in tools (reference set): bash, powershell, read, edit, write, grep (rg binary),
  find (fd binary), ls. edit normalizes CRLF/BOM; file writes serialized per-path queue.
- No worker isolation for extensions; no sandbox/permission system anywhere.
