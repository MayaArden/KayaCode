import * as os from "node:os";
import * as path from "node:path";
import type { ModelRef, SessionMetadata, ThinkingLevel } from "@earendil-works/pi-protocol";
import type { Model } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { ModelMetadata } from "@earendil-works/pi-protocol";
import { SessionNotFoundError, toProtocolModelMetadata, type CreateSessionOptions, type PiServerService, type PiSessionRuntime } from "@earendil-works/pi-server";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { ExtensionLoader } from "@kaya/extensions";
import { DEFAULT_MODEL_REF, createKayaModels, parseModelRef, resolveModel } from "./providers.js";
import { KAYA_DEFAULT_SYSTEM_PROMPT } from "./prompt.js";
import { KayaSessionRuntime } from "./session.js";
import { createNotifyTelegramTool } from "./telegram.js";
import { JsonSessionStore, type StoredSession } from "./store.js";
import { JsonlTelemetryContext } from "./telemetry.js";
import { createDefaultTools } from "./tools.js";

export interface KayaServerConfig {
  /** Default cwd for new sessions (clients may override per session). */
  cwd?: string;
  /** Global config dir; default `~/.kaya`. Project extensions load from `<session cwd>/.kaya`. */
  configDir?: string;
  /** "provider/id"; falls back to KAYA_MODEL env, then anthropic/claude-sonnet-4-6. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  ollamaBaseUrl?: string;
  ollamaModels?: string[];
  /** Path of the JSONL span file; telemetry disabled when omitted and KAYA_TELEMETRY unset. */
  telemetryFile?: string;
  extraExtensionPaths?: string[];
  /** Watch extension dirs and hot-reload on change. Default true. */
  watchExtensions?: boolean;
  /** Connect MCP servers from .kaya/mcp.json on session start. Default true. */
  mcp?: boolean;
  mcpConnectTimeoutMs?: number;
}

export interface KayaServer {
  service: KayaServerService;
  models: MutableModels;
  configDir: string;
  dispose(): Promise<void>;
}

export class KayaServerService implements PiServerService {
  readonly #liveSessions = new Map<string, KayaSessionRuntime>();

  /** The currently-live runtime for a session id (combined-mode introspection). */
  getLiveSession(id: string): KayaSessionRuntime | undefined {
    const runtime = this.#liveSessions.get(id);
    return runtime && !runtime.disposed ? runtime : undefined;
  }

  readonly #models: MutableModels;
  readonly #store: JsonSessionStore;
  readonly #telemetry: TelemetryContext;
  readonly #config: Required<Pick<KayaServerConfig, "cwd" | "configDir" | "thinkingLevel" | "systemPrompt" | "extraExtensionPaths" | "watchExtensions">> & KayaServerConfig;
  readonly #defaultModel: Model<never>;
  readonly #defaultModelRef: ModelRef;

  constructor(options: {
    models: MutableModels;
    store: JsonSessionStore;
    telemetry: TelemetryContext;
    config: KayaServerConfig & { cwd: string; configDir: string };
    defaultModel: Model<never>;
    defaultModelRef: ModelRef;
  }) {
    this.#models = options.models;
    this.#store = options.store;
    this.#telemetry = options.telemetry;
    this.#config = {
      thinkingLevel: "off",
      systemPrompt: KAYA_DEFAULT_SYSTEM_PROMPT,
      extraExtensionPaths: [],
      watchExtensions: true,
      ...options.config,
    };
    this.#defaultModel = options.defaultModel;
    this.#defaultModelRef = options.defaultModelRef;
  }

  listSessions(): Promise<SessionMetadata[]> {
    return Promise.resolve(this.#store.list());
  }

  async listModels(): Promise<ModelMetadata[]> {
    const out: ModelMetadata[] = [];
    for (const provider of this.#models.getProviders()) {
      let authenticated = false;
      try {
        authenticated = (await this.#models.checkAuth(provider.id)) !== undefined;
      } catch {
        authenticated = false;
      }
      for (const model of this.#models.getModels(provider.id)) {
        out.push(toProtocolModelMetadata(model, authenticated));
      }
    }
    return out;
  }

  async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
    const cwd = options.cwd ?? this.#config.cwd;
    const ref = options.model ?? this.#defaultModelRef;
    const model = resolveModel(this.#models, ref);
    if (!model) {
      throw new SessionNotFoundError(`Model not found: ${ref.provider}/${ref.id || "(default)"}`);
    }
    const record: StoredSession = {
      id: options.id,
      cwd,
      ...(options.name !== undefined ? { name: options.name } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: ref,
      thinkingLevel: options.thinkingLevel ?? this.#config.thinkingLevel,
      messages: [],
    };
    this.#store.create(record);
    const runtime = this.#buildRuntime(record);
    await runtime.init("startup");
    this.#liveSessions.set(record.id, runtime);
    return runtime;
  }

  async openSession(sessionId: string): Promise<PiSessionRuntime> {
    const record = this.#store.open(sessionId);
    if (!record) throw new SessionNotFoundError(`Session not found: ${sessionId}`);
    const runtime = this.#buildRuntime(record);
    await runtime.init("startup");
    this.#liveSessions.set(sessionId, runtime);
    return runtime;
  }

  #buildRuntime(record: StoredSession): KayaSessionRuntime {
    const ref = record.model ?? this.#defaultModelRef;
    const model = resolveModel(this.#models, ref) ?? this.#defaultModel;
    const loader = new ExtensionLoader({
      cwd: record.cwd,
      globalConfigDir: this.#config.configDir,
      extraPaths: this.#config.extraExtensionPaths,
    });
    const watchDirs = this.#config.watchExtensions
      ? [path.join(record.cwd, ".kaya", "extensions"), path.join(this.#config.configDir, "extensions")]
      : [];
    return new KayaSessionRuntime({
      id: record.id,
      cwd: record.cwd,
      ...(record.name !== undefined ? { name: record.name } : {}),
      createdAt: record.createdAt,
      model,
      thinkingLevel: record.thinkingLevel ?? this.#config.thinkingLevel,
      systemPrompt: this.#config.systemPrompt,
      defaultTools: createDefaultTools(record.cwd, { notifyTelegram: createNotifyTelegramTool(this.#config.configDir) }),
      extensionLoader: loader,
      models: this.#models,
      store: this.#store,
      telemetry: this.#telemetry,
      messages: record.messages,
      watchDirs,
      globalConfigDir: this.#config.configDir,
      mcp: this.#config.mcp ?? true,
      ...(this.#config.mcpConnectTimeoutMs !== undefined ? { mcpConnectTimeoutMs: this.#config.mcpConnectTimeoutMs } : {}),
    });
  }
}

/** Compose the service stack: models, store, telemetry, defaults. */
export async function createKayaService(config: KayaServerConfig = {}): Promise<KayaServer> {
  const cwd = config.cwd ? path.resolve(config.cwd) : process.cwd();
  const configDir = config.configDir ?? path.join(os.homedir(), ".kaya");
  const models = createKayaModels({
    ...(config.ollamaBaseUrl !== undefined ? { ollamaBaseUrl: config.ollamaBaseUrl } : {}),
    ...(config.ollamaModels !== undefined ? { ollamaModels: config.ollamaModels } : {}),
  });
  const defaultModelRef = parseModelRef(config.model ?? process.env.KAYA_MODEL ?? "") ?? DEFAULT_MODEL_REF;
  const defaultRef = defaultModelRef.id ? defaultModelRef : DEFAULT_MODEL_REF;
  const defaultModel = resolveModel(models, defaultRef);
  if (!defaultModel) {
    throw new Error(
      `Default model not found: ${defaultRef.provider}/${defaultRef.id}. ` +
        `Set KAYA_MODEL to a provider/id available in the registered providers.`,
    );
  }
  const telemetryFile = config.telemetryFile ?? process.env.KAYA_TELEMETRY;
  const telemetry = telemetryFile
    ? new JsonlTelemetryContext(path.resolve(cwd, telemetryFile))
    : NOOP_TELEMETRY_CONTEXT;
  const store = new JsonSessionStore(path.join(configDir, "sessions"));
  const service = new KayaServerService({
    models,
    store,
    telemetry,
    config: { ...config, cwd, configDir },
    defaultModel,
    defaultModelRef: defaultRef,
  });
  return {
    service,
    models,
    configDir,
    dispose: () => Promise.resolve(),
  };
}
