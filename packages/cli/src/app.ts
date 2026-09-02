import type { PiClient } from "@earendil-works/pi-client";
import type { ModelRef, ThinkingLevel, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  VStack,
  matchesKey,
  type AutocompleteItem,
  type SlashCommand,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { ModelMetadata } from "@earendil-works/pi-protocol";
import { parseModelRef } from "@kaya/server";
import { applyProgress, applySnapshot, createTranscriptState, selectTranscript, type TranscriptState } from "./transcript.js";
import { createKayaUi, type KayaUi } from "./ui/index.js";
import { isExpandable, type ExpandableComponent, type SessionStatusView, type TranscriptItemComponent } from "./ui-types.js";

export interface InteractiveAppOptions {
  client: PiClient;
  cwd: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Attach to an existing session instead of creating one. */
  sessionId?: string;
  /** Human label for the server (e.g. "in-process" or a tcp address). */
  serverLabel: string;
  /** Log directory for pi-tui crash logs. */
  logDirectory: string;
  /**
   * Terminal implementation override (tests/harnesses inject a fake terminal;
   * production uses ProcessTerminal).
   */
  terminal?: Terminal;
  /**
   * Fires once the TUI is started and the session snapshot is applied. Lets a
   * harness drive the app programmatically (submit text, capture frames, stop).
   */
  onReady?: (driver: InteractiveDriver) => void;
  /**
   * Combined mode only: fetch commands registered on the live server session
   * (extension + built-in server commands) so they appear in autocomplete with
   * their argument completions. In split mode the wire protocol carries no
   * command metadata (documented limitation).
   */
  getExtensionCommands?: (sessionId: string) => ServerCommandInfo[];
}

/** A server-side (extension or built-in) slash command, as advertised to the client. */
export interface ServerCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => { value: string; label?: string; description?: string }[] | null | Promise<{ value: string; label?: string; description?: string }[] | null>;
}

/** Programmatic handle for driving the interactive app (harness/tests). */
export interface InteractiveDriver {
  /** Feed text as if submitted in the editor. */
  submit(text: string): Promise<void>;
  /** Current rendered frame lines (what TuiMainScreen would write). */
  renderFrame(width: number): string[];
  /** Current session phase from the latest snapshot. */
  phase(): string | undefined;
  stop(): Promise<void>;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The interactive TUI: a pi-tui main-screen app driven entirely by pi-client
 * snapshots (authoritative) + session_progress deltas (streaming overlay).
 */
export async function runInteractiveApp(options: InteractiveAppOptions): Promise<number> {
  const ui = createKayaUi();
  const session = options.sessionId
    ? await options.client.attachSession(options.sessionId)
    : await options.client.createSession({
        cwd: options.cwd,
        ...(options.model !== undefined ? { model: parseModelRef(options.model) } : {}),
        ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
      });

  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, true, options.logDirectory);

  let state: TranscriptState = createTranscriptState();
  const components = new Map<string, TranscriptItemComponent>();
  const transcriptStack = new VStack([], { gap: 0 });
  const statusLine = new Text("", 1, 0);

  const editorTheme = ui.editorTheme;
  const editor = new Editor(tui, editorTheme);
  tui.addChild(transcriptStack);
  tui.addChild(editor);
  tui.addChild(statusLine); // status bar sits below the input box
  tui.setFocus(editor);

  const serverModels: readonly ModelMetadata[] = options.client.snapshot?.models ?? [];
  const extensionCommands = options.getExtensionCommands?.(session.id) ?? [];
  const commands: SlashCommand[] = buildSlashCommands(serverModels, extensionCommands);
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, options.cwd, null));

  let stopping = false;
  let busy = false;

  const updateStatus = () => {
    const snapshot = state.snapshot;
    const view: SessionStatusView = {
      phase: snapshot?.phase,
      model: snapshot ? `${snapshot.model.provider}/${snapshot.model.id}` : options.model ?? "default",
      thinkingLevel: snapshot?.thinkingLevel ?? options.thinkingLevel ?? "off",
      connected: options.client.connected,
      serverAddress: options.serverLabel,
    };
    busy = snapshot?.phase === "turn" || snapshot?.phase === "compaction";
    statusLine.setText(ui.formatStatus(view));
  };

  const syncTranscript = () => {
    const items = selectTranscript(state);
    const seen = new Set<string>();
    let dirty = false;
    for (const item of items) {
      seen.add(item.id);
      const existing = components.get(item.id);
      if (existing) {
        existing.update(item);
      } else {
        const component = ui.createItemComponent(item);
        components.set(item.id, component);
        transcriptStack.addChild(component);
        dirty = true;
      }
    }
    for (const [id, component] of components) {
      if (!seen.has(id)) {
        components.delete(id);
        transcriptStack.removeChild(component);
        dirty = true;
      }
    }
    updateStatus();
    tui.requestRender(dirty);
  };

  const notice = (text: string, tone: "info" | "error" = "info") => {
    const line = new Text(tone === "error" ? ui.palette.error(text) : ui.palette.info(text), 1, 0);
    transcriptStack.addChild(line);
    tui.requestRender();
  };

  const unsubSnapshot = session.subscribe((snapshot) => {
    state = applySnapshot(state, snapshot);
    syncTranscript();
  });
  // pi-client does not replay the current snapshot to a new subscriber;
  // seed from the lease directly.
  if (session.snapshot) {
    state = applySnapshot(state, session.snapshot);
  }
  const unsubEvents = session.onEvent((event) => {
    if (event.type === "session_progress") {
      state = applyProgress(state, event.progress);
      syncTranscript();
    } else if (event.type === "session_removed") {
      notice(`Session removed on server.`, "error");
    }
  });

  const stop = async (exitCode: number): Promise<number> => {
    if (stopping) return exitCode;
    stopping = true;
    unsubSnapshot();
    unsubEvents();
    tui.stop();
    await session.dispose().catch(() => {});
    return exitCode;
  };

  /**
   * App-level keys. Defaults live in this table (not hardcoded in checks) so
   * they stay rebindable later.
   */
  const APP_KEYBINDINGS = {
    toggleExpand: "ctrl+o",
    scrollExpandedUp: "alt+up",
    scrollExpandedDown: "alt+down",
  } as const;

  /** Expandable components in current transcript order. */
  const expandables = (): ExpandableComponent[] => {
    const out: ExpandableComponent[] = [];
    for (const item of selectTranscript(state)) {
      const component = components.get(item.id);
      if (component && isExpandable(component)) out.push(component);
    }
    return out;
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, APP_KEYBINDINGS.toggleExpand)) {
      // Expand the bottom-most collapsed block; when everything is expanded,
      // collapse the bottom-most one. This lets repeated presses walk up the
      // transcript instead of only ever touching the newest block.
      const list = expandables();
      const target = list.filter((c) => c.isCollapsed()).at(-1) ?? list.at(-1);
      if (target) {
        target.toggleExpanded();
        tui.requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(data, APP_KEYBINDINGS.scrollExpandedDown) || matchesKey(data, APP_KEYBINDINGS.scrollExpandedUp)) {
      const delta = matchesKey(data, APP_KEYBINDINGS.scrollExpandedDown) ? 1 : -1;
      for (const component of expandables().reverse()) {
        if (!component.isCollapsed() && component.scrollContent(delta)) {
          tui.requestRender();
          return { consume: true };
        }
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        void session.abort();
        return { consume: true };
      }
      void stop(0).then((code) => process.exit(code));
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (text) => {
    void handleSubmit(text);
  };

  const handleSubmit = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    editor.addToHistory(text);
    if (text.startsWith("/")) {
      const space = text.indexOf(" ");
      const name = text.slice(1, space === -1 ? text.length : space);
      const arg = space === -1 ? "" : text.slice(space + 1).trim();
      switch (name) {
        case "quit":
        case "exit":
          await stop(0).then((code) => process.exit(code));
          return;
        case "help":
          notice(
            [
              "Client commands: /help /model <provider/id> /provider <name> /thinking <level> /clear /quit",
              "Server commands (extensions): /compact /tools /reload and any extension command.",
              `Keys: ${APP_KEYBINDINGS.toggleExpand} expand/collapse newest block, ${APP_KEYBINDINGS.scrollExpandedUp}/${APP_KEYBINDINGS.scrollExpandedDown} scroll an expanded block.`,
              `Thinking levels: ${THINKING_LEVELS.join(", ")}`,
            ].join("\n"),
          );
          return;
        case "clear":
          components.clear();
          transcriptStack.clear();
          tui.requestRender(true);
          return;
        case "model": {
          const ref = parseModelRef(arg);
          if (!ref || !ref.id) {
            notice(`Usage: /model provider/id (arguments autocomplete in the editor)`, "error");
            return;
          }
          try {
            await session.setModel(ref as ModelRef);
            notice(`Model set to ${ref.provider}/${ref.id}`);
          } catch (error) {
            notice(`Set model failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        case "provider": {
          const providers = [...new Set(serverModels.map((m) => m.provider))];
          if (!providers.includes(arg)) {
            notice(`Usage: /provider <name> — known providers: ${providers.join(", ") || "(none)"}`, "error");
            return;
          }
          // Keep the current model id when the provider offers it, else fall
          // back to the provider's first (default) model.
          const currentId = state.snapshot?.model.id;
          const target =
            serverModels.find((m) => m.provider === arg && m.id === currentId) ??
            serverModels.find((m) => m.provider === arg);
          if (!target) {
            notice(`Provider "${arg}" has no models.`, "error");
            return;
          }
          try {
            await session.setModel({ provider: arg, id: target.id });
            notice(`Provider set to ${arg}, model ${target.id}`);
          } catch (error) {
            notice(`Set provider failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        case "thinking": {
          if (!THINKING_LEVELS.includes(arg as ThinkingLevel)) {
            notice(`Unknown thinking level "${arg}". One of: ${THINKING_LEVELS.join(", ")}`, "error");
            return;
          }
          await session.setThinking(arg as ThinkingLevel);
          notice(`Thinking level set to ${arg}`);
          return;
        }
        default:
          // Everything else (e.g. /compact, /tools, /reload, extension commands)
          // is dispatched server-side through the extension command registry.
          break;
      }
    }
    try {
      if (busy) {
        await session.steer(text);
      } else {
        await session.prompt(text);
      }
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  updateStatus();
  syncTranscript();
  tui.start();

  options.onReady?.({
    submit: (text: string) => handleSubmit(text),
    renderFrame: (width: number) => [...transcriptStack.render(width), ...editor.render(width), ...statusLine.render(width)],
    phase: () => state.snapshot?.phase,
    stop: () => stop(0).then(() => undefined),
  });

  // Idle until stopped.
  await new Promise<void>((resolve) => {
    const check = () => (stopping ? resolve() : setTimeout(check, 250));
    check();
  });
  return 0;
}

/**
 * Slash commands with structured argument completion. Argument completers are
 * data-driven: each command declares a completer for its first argument, and
 * CombinedAutocompleteProvider invokes it as `/name <prefix>` is typed. Adding
 * another argument-completable command is one entry here, not a special case.
 */
function buildSlashCommands(models: readonly ModelMetadata[], serverCommands: ServerCommandInfo[]): SlashCommand[] {
  const providers = [...new Set(models.map((m) => m.provider))];

  const modelArgCompletion = (prefix: string): AutocompleteItem[] => {
    if (prefix.includes("/")) {
      return models
        .filter((m) => `${m.provider}/${m.id}`.startsWith(prefix))
        .map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name, description: m.provider }));
    }
    const items: AutocompleteItem[] = providers
      .filter((p) => p.startsWith(prefix))
      .map((p) => ({ value: `${p}/`, label: p, description: "provider" }));
    items.push(
      ...models
        .filter((m) => `${m.provider}/${m.id}`.startsWith(prefix))
        .map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name, description: m.provider })),
    );
    return items;
  };

  const providerArgCompletion = (prefix: string): AutocompleteItem[] =>
    providers.filter((p) => p.startsWith(prefix)).map((p) => ({ value: p, label: p, description: "provider" }));

  const thinkingArgCompletion = (prefix: string): AutocompleteItem[] =>
    THINKING_LEVELS.filter((level) => level.startsWith(prefix)).map((level) => ({ value: level, label: level }));

  const commands: SlashCommand[] = [
    { name: "help", description: "Show help" },
    { name: "quit", description: "Exit kaya" },
    { name: "exit", description: "Exit kaya" },
    { name: "clear", description: "Clear the transcript view" },
    {
      name: "model",
      description: "Set model (provider/id — suggestions as you type)",
      argumentHint: "provider/id",
      getArgumentCompletions: modelArgCompletion,
    },
    {
      name: "provider",
      description: "Switch provider (keeps current model id when available)",
      argumentHint: "provider",
      getArgumentCompletions: providerArgCompletion,
    },
    {
      name: "thinking",
      description: "Set thinking level",
      argumentHint: "off|minimal|low|medium|high|xhigh|max",
      getArgumentCompletions: thinkingArgCompletion,
    },
  ];
  for (const command of serverCommands) {
    if (commands.some((c) => c.name === command.name)) continue; // client builtins win
    const entry: SlashCommand = {
      name: command.name,
      ...(command.description !== undefined ? { description: command.description } : {}),
      ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
    };
    if (command.getArgumentCompletions) {
      const complete = command.getArgumentCompletions;
      entry.getArgumentCompletions = async (prefix: string): Promise<AutocompleteItem[] | null> => {
        const items = await complete(prefix);
        return (
          items?.map((i) => ({
            value: i.value,
            label: i.label ?? i.value,
            ...(i.description !== undefined ? { description: i.description } : {}),
          })) ?? null
        );
      };
    }
    commands.push(entry);
  }
  return commands;
}
