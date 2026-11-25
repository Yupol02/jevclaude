import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Selector } from "../core/uitree.js";

export interface CacheEntry {
  /** Selector that resolved the target last time (unique on that screen). */
  selector: Selector;
  /** Human label of the element, for reports. */
  label: string;
  /** Screen fingerprint when the entry was written. */
  fingerprint: string;
  /** Last risk probability for this action (so the guard needn't ask again). */
  risk?: number;
  hits: number;
  updatedAt: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/**
 * Replay cache: remembers which element a natural-language target resolved to, so re-runs skip
 * the model. Stored per app in `.jevclaude/cache/<app>.json` (commit it to make CI runs model-free).
 */
export class SelectorCache {
  private data: CacheFile = { version: 1, entries: {} };
  private dirty = false;

  constructor(
    readonly file: string,
    readonly mode: "on" | "off" | "update" = "on",
  ) {
    if (mode !== "off" && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
        if (parsed.version === 1) this.data = parsed;
      } catch {
        /* corrupt cache: start fresh */
      }
    }
  }

  static forApp(app: string, root = ".jevclaude", mode: SelectorCache["mode"] = "on") {
    return new SelectorCache(join(root, "cache", `${app.replace(/[^\w.-]+/g, "_")}.json`), mode);
  }

  static key(kind: "tap" | "type", target: string) {
    return `${kind}:${target.trim().toLocaleLowerCase()}`;
  }

  /** Lookups are skipped in "update" mode (forces fresh decisions that then overwrite entries). */
  get(key: string): CacheEntry | undefined {
    return this.mode === "on" ? this.data.entries[key] : undefined;
  }

  set(key: string, entry: Omit<CacheEntry, "hits" | "updatedAt">) {
    if (this.mode === "off") return;
    const prev = this.data.entries[key];
    this.data.entries[key] = { ...entry, hits: prev?.hits ?? 0, updatedAt: new Date().toISOString() };
    this.dirty = true;
  }

  hit(key: string) {
    const e = this.data.entries[key];
    if (e) {
      e.hits += 1;
      this.dirty = true;
    }
  }

  delete(key: string) {
    if (this.data.entries[key]) {
      delete this.data.entries[key];
      this.dirty = true;
    }
  }

  save() {
    if (!this.dirty || this.mode === "off") return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
    this.dirty = false;
  }
}
