import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { createJiti } from "jiti";
import type { ExtensionHost } from "./host.js";
import type { ExtensionSourceInfo, KayaExtensionFactory } from "./types.js";

export interface LoaderOptions {
  /** Working directory of the session; project extensions live under it. */
  cwd: string;
  /** Config dir name inside cwd and the global dir. Defaults to ".kaya". */
  configDirName?: string;
  /** Global extension base dir (e.g. ~/.kaya). */
  globalConfigDir?: string;
  /** Extra files or directories to load after project/global extensions. */
  extraPaths?: string[];
}

export interface ExtensionLoadError {
  path: string;
  error: string;
}

export interface LoadResult {
  /** Paths whose factories ran successfully. */
  loaded: string[];
  errors: ExtensionLoadError[];
}

/**
 * Resolve the modules extensions commonly import to the server's own
 * (deduped, single-version) copies, so an extension in a bare directory works
 * without its own node_modules.
 */
function buildAliases(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const aliases: Record<string, string> = {};
  for (const specifier of [
    "typebox",
    "typebox/compile",
    "typebox/value",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@kaya/extensions",
  ]) {
    try {
      aliases[specifier] = require.resolve(specifier);
    } catch {
      // Dependency not installed; leave it to normal resolution to error.
    }
  }
  return aliases;
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Discover extension entry points in a directory, one level deep:
 * direct `*.ts`/`*.js` files, or subdirectories with an `index.ts`/`index.js`.
 */
export function discoverInDir(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
      discovered.push(entryPath);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      for (const index of ["index.ts", "index.js"]) {
        const indexPath = path.join(entryPath, index);
        if (fs.existsSync(indexPath)) {
          discovered.push(indexPath);
          break;
        }
      }
    }
  }
  return discovered.sort();
}

/**
 * Discovery order: `cwd/<configDir>/extensions/` (project), then
 * `<globalConfigDir>/extensions/` (global), then explicitly configured paths
 * (file or directory). Duplicates by resolved path are removed, first wins.
 */
export function discoverExtensionPaths(options: LoaderOptions): string[] {
  const configDirName = options.configDirName ?? ".kaya";
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      paths.push(resolved);
    }
  };

  for (const p of discoverInDir(path.join(path.resolve(options.cwd), configDirName, "extensions"))) add(p);

  if (options.globalConfigDir) {
    for (const p of discoverInDir(path.join(path.resolve(options.globalConfigDir), "extensions"))) add(p);
  }

  for (const p of options.extraPaths ?? []) {
    const resolved = path.resolve(options.cwd, p);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      for (const discovered of discoverInDir(resolved)) add(discovered);
    } else {
      add(resolved);
    }
  }

  return paths;
}

/**
 * Loads TypeScript extension files with jiti (no build step required) and feeds
 * their default-exported factories into an ExtensionHost. A fresh jiti
 * instance is created per `loadAll()` call, so calling it again after edits is
 * also the hot-reload path — there is no module cache to clear.
 */
export class ExtensionLoader {
  readonly #options: LoaderOptions;

  constructor(options: LoaderOptions) {
    this.#options = options;
  }

  discover(): string[] {
    return discoverExtensionPaths(this.#options);
  }

  /** Load one extension file into the host. */
  async loadPath(host: ExtensionHost, extensionPath: string): Promise<string | null> {
    const resolved = path.resolve(this.#options.cwd, extensionPath);
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: buildAliases(),
    });
    let factory: KayaExtensionFactory;
    try {
      const module = (await jiti.import(resolved, { default: true })) as unknown;
      if (typeof module !== "function") {
        return `Extension does not default-export a factory function: ${extensionPath}`;
      }
      factory = module as KayaExtensionFactory;
    } catch (error) {
      return `Failed to import extension ${extensionPath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    const source: ExtensionSourceInfo = { path: resolved, kind: "file" };
    await host.loadFactory(factory, source);
    return null;
  }

  /** Discover and load everything into the host. Errors are per-file; loading continues. */
  async loadAll(host: ExtensionHost, paths?: string[]): Promise<LoadResult> {
    const targets = paths ?? this.discover();
    const result: LoadResult = { loaded: [], errors: [] };
    for (const target of targets) {
      const error = await this.loadPath(host, target);
      if (error) result.errors.push({ path: target, error });
      else result.loaded.push(target);
    }
    return result;
  }
}
