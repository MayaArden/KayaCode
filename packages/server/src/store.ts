import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelRef, SessionMetadata, ThinkingLevel } from "@earendil-works/pi-protocol";

export interface StoredSession {
  id: string;
  cwd: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  messages: AgentMessage[];
}

/**
 * Deliberately simple JSON-file session persistence (v1). One file per session
 * under `<dir>/<id>.json`, written atomically via rename. The pi SQLite
 * session backend is the documented upgrade path.
 */
export class JsonSessionStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  get dir(): string {
    return this.#dir;
  }

  #filePath(id: string): string {
    return path.join(this.#dir, `${id}.json`);
  }

  list(): SessionMetadata[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.#dir);
    } catch {
      return [];
    }
    const out: SessionMetadata[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.#dir, file), "utf8")) as StoredSession;
        out.push({
          id: record.id,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          sessionName: record.name,
          cwd: record.cwd,
        });
      } catch {
        // Skip unreadable/corrupt files.
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  create(record: StoredSession): void {
    this.save(record);
  }

  open(id: string): StoredSession | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.#filePath(id), "utf8")) as StoredSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(record: StoredSession): void {
    const target = this.#filePath(record.id);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, target);
  }
}
