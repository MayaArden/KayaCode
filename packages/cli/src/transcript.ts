import type { SessionSnapshot, TranscriptItem, TranscriptProgress } from "@earendil-works/pi-protocol";

/**
 * Client-side transcript state: snapshots are authoritative, progress events
 * are advisory deltas overlaid on top (streaming text/thinking, tool args).
 * Own design over the pi-client re-emission model; see phase1-notes.
 */
export interface TranscriptState {
  /** Latest authoritative snapshot, if any. */
  snapshot: SessionSnapshot | undefined;
  /** Items from the last snapshot, by id. */
  base: Map<string, TranscriptItem>;
  baseOrder: string[];
  /** In-progress overrides/items from progress events, by id. */
  overlays: Map<string, TranscriptItem>;
  overlayOrder: string[];
  /** Raw JSON accumulation for streaming toolCall args, keyed `messageId:contentIndex`. */
  toolArgBuffers: Map<string, string>;
}

export function createTranscriptState(): TranscriptState {
  return {
    snapshot: undefined,
    base: new Map(),
    baseOrder: [],
    overlays: new Map(),
    overlayOrder: [],
    toolArgBuffers: new Map(),
  };
}

export function applySnapshot(state: TranscriptState, snapshot: SessionSnapshot): TranscriptState {
  // Stale snapshots lose on revision; a snapshot for a different session resets.
  if (state.snapshot && state.snapshot.id === snapshot.id && snapshot.revision < state.snapshot.revision) {
    return state;
  }
  const base = new Map<string, TranscriptItem>();
  const baseOrder: string[] = [];
  for (const item of snapshot.transcript) {
    base.set(item.id, item);
    baseOrder.push(item.id);
  }
  // A fresh snapshot absorbs everything it covers; keep overlays only for
  // items the snapshot does not know about yet (still-streaming).
  const overlays = new Map<string, TranscriptItem>();
  const overlayOrder: string[] = [];
  for (const [id, item] of state.overlays) {
    if (!base.has(id)) {
      overlays.set(id, item);
      overlayOrder.push(id);
    }
  }
  return { snapshot, base, baseOrder, overlays, overlayOrder, toolArgBuffers: state.toolArgBuffers };
}

export function applyProgress(state: TranscriptState, progress: TranscriptProgress): TranscriptState {
  switch (progress.type) {
    case "item_started":
    case "item_updated": {
      return upsertOverlay(state, progress.item as TranscriptItem);
    }
    case "item_finished": {
      const item = progress.item as TranscriptItem;
      state.toolArgBuffers.forEach((_v, key) => {
        if (key.startsWith(`${item.id}:`)) state.toolArgBuffers.delete(key);
      });
      return upsertOverlay(state, item);
    }
    case "assistant_delta": {
      const target = state.overlays.get(progress.messageId) ?? state.base.get(progress.messageId);
      if (!target || target.role !== "assistant") return state;
      const content = target.content.map((c) => ({ ...c }));
      if (progress.kind === "toolCall") {
        const key = `${progress.messageId}:${progress.contentIndex}`;
        const buffer = (state.toolArgBuffers.get(key) ?? "") + progress.delta;
        state.toolArgBuffers.set(key, buffer);
        const existing = content[progress.contentIndex];
        if (existing && existing.type === "toolCall") {
          content[progress.contentIndex] = { ...existing, input: tryParseJson(buffer) ?? buffer } as typeof existing;
        } else if (!existing) {
          // The item_started snapshot may predate this block; create it.
          content[progress.contentIndex] = {
            type: "toolCall",
            toolCallId: "",
            toolName: "",
            input: tryParseJson(buffer) ?? buffer,
          } as (typeof content)[number];
        }
      } else {
        const existing = content[progress.contentIndex];
        if (existing && existing.type === progress.kind) {
          if (existing.type === "text") {
            content[progress.contentIndex] = { ...existing, text: existing.text + progress.delta };
          } else if (existing.type === "thinking") {
            content[progress.contentIndex] = { ...existing, thinking: existing.thinking + progress.delta };
          }
        } else if (!existing) {
          // The block does not exist yet in the streaming item: create it.
          if (progress.kind === "text") {
            content[progress.contentIndex] = { type: "text", text: progress.delta };
          } else if (progress.kind === "thinking") {
            content[progress.contentIndex] = { type: "thinking", thinking: progress.delta };
          }
        }
      }
      const next = { ...target, content } as TranscriptItem;
      return upsertOverlay(state, next);
    }
  }
}

function upsertOverlay(state: TranscriptState, item: TranscriptItem): TranscriptState {
  if (!state.overlays.has(item.id)) state.overlayOrder.push(item.id);
  state.overlays.set(item.id, item);
  return state;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Merged view: snapshot transcript overlaid with in-progress items. */
export function selectTranscript(state: TranscriptState): TranscriptItem[] {
  const merged = new Map<string, TranscriptItem>();
  for (const id of state.baseOrder) merged.set(id, state.base.get(id)!);
  for (const id of state.overlayOrder) merged.set(id, state.overlays.get(id)!);
  // queuedSteer (user messages steered but not yet applied) ride at the end.
  if (state.snapshot) {
    for (const item of state.snapshot.queuedSteer) {
      if (!merged.has(item.id)) merged.set(item.id, item);
    }
  }
  return [...merged.values()];
}

/** Latest session phase from the authoritative snapshot. */
export function selectPhase(state: TranscriptState): SessionSnapshot["phase"] | undefined {
  return state.snapshot?.phase;
}
