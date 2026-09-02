import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * Persistent provider API keys, stored as a flat providerId -> key map in
 * `<configDir>/keys.json` (default `~/.kaya/keys.json`). Never commit this
 * file; the CLI's `/apikey <provider> <key>` command writes it and
 * `createKayaModels` resolves provider auth from it.
 *
 * Env vars always win: pi-ai's api-key resolve checks a stored credential
 * before env vars, so the store hides stored keys whenever the provider's
 * API-key env var is set.
 */

/** API-key env vars per registered provider; an empty list means keyless. */
const PROVIDER_API_KEY_ENV: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  ollama: [],
};

/** Flat on-disk shape of keys.json: provider id -> API key. */
export type KeysFile = Record<string, string>;

export function keysFilePath(configDir: string): string {
  return path.join(configDir, "keys.json");
}

/** Read keys.json; missing or malformed files yield an empty map. */
export async function readKeysFile(file: string): Promise<KeysFile> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: KeysFile = {};
    for (const [provider, key] of Object.entries(parsed)) {
      if (typeof key === "string" && key) out[provider] = key;
    }
    return out;
  } catch {
    return {};
  }
}

/** Store one provider API key (0600 on POSIX; the key is never logged). */
export async function saveApiKey(file: string, providerId: string, key: string): Promise<void> {
  const keys = await readKeysFile(file);
  keys[providerId] = key;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
}

/**
 * CredentialStore over keys.json for pi-ai's `createModels({ credentials })`.
 * Only api_key credentials are persisted; other credential types (which kaya
 * never produces — there is no OAuth login flow) live in memory for the
 * process lifetime.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #file: string;
  readonly #memory = new Map<string, Credential>();

  constructor(file: string) {
    this.#file = file;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (this.#envKeySet(providerId)) return undefined; // env var wins over the stored key
    return this.#memory.get(providerId) ?? (await this.#readApiKey(providerId));
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const out: CredentialInfo[] = [...this.#memory].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
    for (const providerId of Object.keys(await readKeysFile(this.#file))) {
      if (!this.#memory.has(providerId) && !this.#envKeySet(providerId)) {
        out.push({ providerId, type: "api_key" });
      }
    }
    return out;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const current = await this.read(providerId, options);
    const next = await fn(current);
    options?.signal?.throwIfAborted();
    if (next === undefined) return current;
    this.#memory.set(providerId, next);
    if (next.type === "api_key") {
      const keys = await readKeysFile(this.#file);
      if (next.key) keys[providerId] = next.key;
      else delete keys[providerId];
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.writeFile(this.#file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    }
    return next;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.#memory.delete(providerId);
    const keys = await readKeysFile(this.#file);
    delete keys[providerId];
    await fs.writeFile(this.#file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  }

  async #readApiKey(providerId: string): Promise<Credential | undefined> {
    const key = (await readKeysFile(this.#file))[providerId];
    return key ? { type: "api_key", key } : undefined;
  }

  #envKeySet(providerId: string): boolean {
    return (PROVIDER_API_KEY_ENV[providerId] ?? []).some((name) => !!process.env[name]);
  }
}
