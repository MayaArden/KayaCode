import { createModels, createProvider, type CredentialStore, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ModelRef } from "@earendil-works/pi-protocol";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * Ollama ships no dedicated provider in pi-ai; local OpenAI-compatible
 * servers are modeled with `createProvider` over the openai-completions API.
 * The model list is static: default a few common ids, override with the
 * `OLLAMA_MODELS` env var (comma-separated ids).
 */
function createOllamaProvider(baseUrl: string, modelIds: string[]) {
  const models: Model<"openai-completions">[] = modelIds.map((id) => ({
    id,
    name: `${id} (Ollama)`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  }));
  return createProvider<"openai-completions">({
    id: "ollama",
    name: "Ollama",
    baseUrl,
    auth: {
      apiKey: {
        name: "Ollama (local, no key)",
        resolve: () => Promise.resolve({ auth: { apiKey: "ollama" }, source: "local" }),
      },
    },
    models,
    api: { stream, streamSimple },
  });
}

export interface KayaModelsOptions {
  ollamaBaseUrl?: string;
  ollamaModels?: string[];
  /** Persistent credential store (e.g. FileCredentialStore over ~/.kaya/keys.json). */
  credentials?: CredentialStore;
}

export function createKayaModels(options: KayaModelsOptions = {}): MutableModels {
  const ollamaBaseUrl = options.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const ollamaModels =
    options.ollamaModels ??
    (process.env.OLLAMA_MODELS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) || ["llama3.1", "qwen3"]);
  const models = createModels({ credentials: options.credentials });
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openrouterProvider());
  models.setProvider(createOllamaProvider(ollamaBaseUrl, ollamaModels));
  return models;
}

export const DEFAULT_MODEL_REF: ModelRef = { provider: "anthropic", id: "claude-sonnet-4-6" };

/** Parse a "provider/id" string; bare "provider" yields undefined id. */
export function parseModelRef(spec: string): ModelRef | undefined {
  const slash = spec.indexOf("/");
  if (slash === -1) return { provider: spec, id: "" };
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/** Resolve a ModelRef to a live Model, picking the provider's first model when id is empty. */
export function resolveModel(models: MutableModels, ref: ModelRef): Model<never> | undefined {
  if (ref.id) return models.getModel(ref.provider, ref.id) as Model<never> | undefined;
  return models.getModels(ref.provider)[0] as Model<never> | undefined;
}
