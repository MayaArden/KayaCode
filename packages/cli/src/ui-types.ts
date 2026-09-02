import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { Component, EditorTheme, MarkdownTheme, SelectListTheme, TUI } from "@earendil-works/pi-tui";

/**
 * Kaya's blue-first palette. All UI color functions route through here.
 * Hexes chosen to read on both dark and light terminals:
 *   primary  #5CB8FF  borders, accents, prompt marker
 *   accent   #7AA2F7  headings, tool names
 *   info     #89DDFF  inline code, links
 *   muted    #3D59A1  thinking text, secondary labels
 *   userText #C0CAF5  user message text
 *   ok       #9ECE6A  success markers and diff additions
 *   error    #F7768E  errors and diff removals
 */
export interface KayaPalette {
  primary: (text: string) => string;
  accent: (text: string) => string;
  info: (text: string) => string;
  muted: (text: string) => string;
  userText: (text: string) => string;
  ok: (text: string) => string;
  error: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
}

/** A transcript item rendered as a live-updating component. */
export interface TranscriptItemComponent extends Component {
  readonly id: string;
  /** Called when the item's data changes (streaming deltas, completion). */
  update(item: TranscriptItem): void;
}

/**
 * A component whose detail body is collapsed by default (thinking blocks,
 * tool output). ONE shared mechanism covers both: the app toggles/scrolls the
 * bottom-most expandable component via keyboard; components own only state.
 */
export interface ExpandableComponent extends TranscriptItemComponent {
  readonly expandable: true;
  isCollapsed(): boolean;
  toggleExpanded(): void;
  /**
   * Scroll the expanded content window by `delta` pages (sign = direction).
   * Returns true when the scroll changed the view (caller consumes the key).
   */
  scrollContent(delta: number): boolean;
}

export function isExpandable(component: TranscriptItemComponent): component is ExpandableComponent {
  return "expandable" in component && component.expandable === true;
}

/** The UI module contract implemented by ui/theme.ts and ui/render.ts. */
export interface KayaUi {
  palette: KayaPalette;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
  selectListTheme: SelectListTheme;
  /** Create a renderer component for one transcript item. */
  createItemComponent(item: TranscriptItem): TranscriptItemComponent;
  /** One-line status bar content for the current session state. */
  formatStatus(status: SessionStatusView): string;
}

export interface SessionStatusView {
  phase: "idle" | "turn" | "compaction" | string | undefined;
  model: string;
  thinkingLevel: string;
  connected: boolean;
  serverAddress: string;
}

export type { Component, TUI };
