import * as fs from "node:fs";
import * as path from "node:path";
import type { PiClient, PiSessionHandle } from "@earendil-works/pi-client";

/**
 * chatId -> kaya session id, persisted to <configDir>/telegram-sessions.json
 * so chats reattach to their own sessions across bot restarts.
 */
export class ChatSessions {
  readonly #client: PiClient;
  readonly #cwd: string;
  readonly #file: string;
  #map: Record<string, string> = {};
  #handles = new Map<number, PiSessionHandle>();

  constructor(client: PiClient, cwd: string, configDir: string) {
    this.#client = client;
    this.#cwd = cwd;
    this.#file = path.join(configDir, "telegram-sessions.json");
    try {
      this.#map = JSON.parse(fs.readFileSync(this.#file, "utf8")) as Record<string, string>;
    } catch {
      this.#map = {};
    }
  }

  async ensure(chatId: number): Promise<PiSessionHandle> {
    const live = this.#handles.get(chatId);
    if (live?.active) return live;
    const known = this.#map[String(chatId)];
    if (known) {
      try {
        const handle = await this.#client.attachSession(known);
        this.#handles.set(chatId, handle);
        return handle;
      } catch {
        // Session gone from the store; fall through to create.
      }
    }
    const handle = await this.#client.createSession({ cwd: this.#cwd, name: `telegram:${chatId}` });
    this.#handles.set(chatId, handle);
    this.#map[String(chatId)] = handle.id;
    this.#persist();
    return handle;
  }

  async fresh(chatId: number): Promise<PiSessionHandle> {
    await this.#handles.get(chatId)?.dispose().catch(() => {});
    this.#handles.delete(chatId);
    delete this.#map[String(chatId)];
    return this.ensure(chatId);
  }

  #persist(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, JSON.stringify(this.#map));
  }
}
