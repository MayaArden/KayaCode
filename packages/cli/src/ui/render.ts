import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type {
  AssistantTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import type { ExpandableComponent, KayaPalette, KayaUi, SessionStatusView, TranscriptItemComponent } from "../ui-types.js";
import {
  createEditorTheme,
  createKayaPalette,
  createMarkdownTheme,
  createSelectListTheme,
} from "./theme.js";

const USER_MARKER = "❯";
const STREAM_CURSOR = "▍";
const TOOL_CALL_ARROW = "→";
const TOOL_PAGE_LINES = 20;
const COLLAPSE_HINT = "ctrl+o to expand";
const SCROLL_HINT = "alt+up/alt+down";

/** Any block shape that may carry plain text (user content, tool content). */
interface LooseTextBlock {
  readonly type: string;
  readonly text?: string;
}

function isTextBlock(block: LooseTextBlock): block is { type: "text"; text: string } {
  return block.type === "text" && typeof block.text === "string";
}

/** Join the text of all `{type:"text"}` blocks with newlines. */
function extractText(blocks: readonly LooseTextBlock[]): string {
  return blocks.filter(isTextBlock).map((block) => block.text).join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Single-line summary of a tool input. Defends against the input still being
 * a raw unparsed JSON string while streaming.
 */
function inputSummary(toolName: string, input: unknown): string {
  let value: unknown = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        value = JSON.parse(trimmed) as unknown;
      } catch {
        return oneLine(trimmed);
      }
    } else {
      return oneLine(trimmed);
    }
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (toolName === "bash" && typeof record.command === "string") return oneLine(record.command);
    if ((toolName === "edit" || toolName === "read" || toolName === "write") && typeof record.path === "string") {
      return oneLine(record.path);
    }
    const parts: string[] = [];
    for (const [key, entry] of Object.entries(record)) {
      parts.push(`${key}=${typeof entry === "string" ? oneLine(entry) : oneLine(JSON.stringify(entry) ?? "")}`);
    }
    return parts.join(" ");
  }
  return oneLine(JSON.stringify(value) ?? "");
}

/**
 * Defensive read of `details.truncation`, which may be a boolean, a string,
 * or an object flag depending on the tool implementation.
 */
function indicatesTruncation(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === "string") return value.length > 0;
  const record = asRecord(value);
  if (!record) return false;
  if (record.truncated === true || record.isTruncated === true) return true;
  return typeof record.omittedLines === "number" && record.omittedLines > 0;
}

/**
 * User transcript item: a double-line box in accent color with a `❯` marker
 * on the first inner line and the message text in userText color, wrapped.
 */
class UserItemView implements TranscriptItemComponent {
  readonly id: string;
  private item: UserTranscriptItem;
  private readonly palette: KayaPalette;

  constructor(item: UserTranscriptItem, palette: KayaPalette) {
    this.palette = palette;
    this.id = item.id;
    this.item = item;
  }

  update(item: TranscriptItem): void {
    if (item.role === "user") this.item = item;
  }

  invalidate(): void {
    // Stateless rendering: nothing cached to drop.
  }

  render(width: number): string[] {
    const { palette } = this;
    // Budget leaves room for the ║ borders and the single space of padding.
    const textBudget = Math.max(1, width - 6);
    const text = extractText(this.item.content);
    const wrapped = text.length === 0 ? [] : wrapTextWithAnsi(text, textBudget);
    const inner: string[] = [];
    for (const [index, line] of wrapped.entries()) {
      inner.push(index === 0 ? `${palette.primary(USER_MARKER)} ${palette.userText(line)}` : palette.userText(`  ${line}`));
    }
    if (inner.length === 0) inner.push(palette.primary(USER_MARKER));

    let innerWidth = 0;
    for (const line of inner) innerWidth = Math.max(innerWidth, visibleWidth(line));
    const bar = "═".repeat(innerWidth + 2);
    const box: string[] = [palette.accent(`╔${bar}╗`)];
    for (const line of inner) {
      const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      box.push(`${palette.accent("║")} ${line}${fill} ${palette.accent("║")}`);
    }
    box.push(palette.accent(`╚${bar}╝`));
    return box;
  }
}

type AssistantBlock =
  | { kind: "thinking"; text: string }
  | { kind: "text"; raw: string; markdown: Markdown }
  | { kind: "toolCall"; toolName: string; input: unknown };

/**
 * Assistant transcript item. Thinking blocks are expanded while streaming and
 * collapsed to a `thinking (N chars)` summary afterwards; the whole item is an
 * ExpandableComponent when (and only when) it carries thinking text, so the
 * app can toggle all thinking blocks via the shared mechanism.
 */
class AssistantItemView implements TranscriptItemComponent {
  readonly id: string;
  private item: AssistantTranscriptItem;
  private blocks: AssistantBlock[] = [];
  private expanded = false;
  private userToggled = false;
  private readonly palette: KayaPalette;
  private readonly markdownTheme: MarkdownTheme;

  constructor(item: AssistantTranscriptItem, palette: KayaPalette, markdownTheme: MarkdownTheme) {
    this.palette = palette;
    this.markdownTheme = markdownTheme;
    this.id = item.id;
    this.item = item;
    this.rebuild();
  }

  /** Expandable exactly when the item has thinking content (dynamic; the
   *  isExpandable guard reads this at runtime). */
  get expandable(): boolean {
    return this.blocks.some((block) => block.kind === "thinking" && block.text.length > 0);
  }

  isCollapsed(): boolean {
    return !this.effectiveExpanded();
  }

  toggleExpanded(): void {
    this.expanded = !this.effectiveExpanded();
    this.userToggled = true;
  }

  scrollContent(_delta: number): boolean {
    // Thinking is short; no paging.
    return false;
  }

  update(item: TranscriptItem): void {
    if (item.role !== "assistant") return;
    this.item = item;
    this.rebuild();
  }

  invalidate(): void {
    this.rebuild();
  }

  private effectiveExpanded(): boolean {
    if (this.userToggled) return this.expanded;
    return this.item.status === "streaming";
  }

  private rebuild(): void {
    this.blocks = [];
    for (const block of this.item.content) {
      if (block.type === "thinking") {
        this.blocks.push({ kind: "thinking", text: block.thinking });
      } else if (block.type === "text") {
        this.blocks.push({ kind: "text", raw: block.text, markdown: new Markdown(block.text, 0, 0, this.markdownTheme) });
      } else if (block.type === "toolCall") {
        this.blocks.push({ kind: "toolCall", toolName: block.toolName, input: block.input });
      }
    }
  }

  render(width: number): string[] {
    const streaming = this.item.status === "streaming";
    const thinkingExpanded = this.effectiveExpanded();
    const lines: string[] = [];
    for (const block of this.blocks) {
      if (block.kind === "thinking") {
        if (block.text.length === 0) continue;
        if (thinkingExpanded) {
          lines.push(this.palette.italic(this.palette.muted("thinking")));
          for (const line of wrapTextWithAnsi(block.text, Math.max(1, width - 2))) {
            lines.push(this.palette.italic(this.palette.muted(`  ${line}`)));
          }
        } else {
          lines.push(this.palette.italic(this.palette.muted(`thinking (${block.text.length} chars)`)));
        }
      } else if (block.kind === "text") {
        if (block.raw.trim().length === 0) continue;
        const rendered = block.markdown.render(width);
        if (rendered.length === 0) continue;
        if (streaming) {
          const last = (rendered[rendered.length - 1] ?? "").replace(/\s+$/, "");
          lines.push(...rendered.slice(0, -1));
          lines.push(truncateToWidth(`${last}${this.palette.primary(STREAM_CURSOR)}`, width));
        } else {
          lines.push(...rendered);
        }
      } else {
        const line = `${this.palette.accent(TOOL_CALL_ARROW)} ${this.palette.bold(this.palette.accent(block.toolName))} ${this.palette.muted(inputSummary(block.toolName, block.input))}`;
        lines.push(truncateToWidth(line, width));
      }
    }
    return lines;
  }
}

/**
 * Tool transcript item. Expanded (while running, or after the user toggles)
 * it is a rounded box with a status glyph, the tool name, and a paged body
 * (20 logical lines per page). Collapsed it is a single summary line.
 */
class ToolItemView implements ExpandableComponent {
  readonly id: string;
  readonly expandable = true as const;
  private item: ToolTranscriptItem;
  private expanded = false;
  private userToggled = false;
  private page = 1;
  private readonly palette: KayaPalette;

  constructor(item: ToolTranscriptItem, palette: KayaPalette) {
    this.palette = palette;
    this.id = item.id;
    this.item = item;
  }

  isCollapsed(): boolean {
    return !this.effectiveExpanded();
  }

  toggleExpanded(): void {
    this.expanded = !this.effectiveExpanded();
    this.userToggled = true;
  }

  scrollContent(delta: number): boolean {
    if (!this.effectiveExpanded()) return false;
    const pages = Math.max(1, Math.ceil(this.buildBody().length / TOOL_PAGE_LINES));
    const next = Math.min(pages, Math.max(1, this.page + delta));
    if (next === this.page) return false;
    this.page = next;
    return true;
  }

  update(item: TranscriptItem): void {
    if (item.role !== "tool") return;
    const wasRunning = this.item.status === "running";
    this.item = item;
    // Auto-collapse on the running -> finished transition, but only when the
    // user never toggled the item themselves (their choice wins).
    if (wasRunning && item.status !== "running" && !this.userToggled) {
      this.expanded = false;
    }
  }

  invalidate(): void {
    // Body is rebuilt per render; nothing cached to drop.
  }

  private effectiveExpanded(): boolean {
    if (this.userToggled) return this.expanded;
    return this.item.status === "running";
  }

  render(width: number): string[] {
    if (!this.effectiveExpanded()) return [this.collapsedLine(width)];

    const { palette } = this;
    const item = this.item;
    const budget = Math.max(1, width - 4);
    const inner: string[] = [];
    for (const line of wrapTextWithAnsi(this.headerLine(), budget)) inner.push(line);

    const body = this.buildBody();
    const pages = Math.max(1, Math.ceil(body.length / TOOL_PAGE_LINES));
    this.page = Math.min(Math.max(1, this.page), pages);
    const start = (this.page - 1) * TOOL_PAGE_LINES;
    for (const logical of body.slice(start, start + TOOL_PAGE_LINES)) {
      for (const wrapped of wrapTextWithAnsi(logical, budget)) inner.push(wrapped);
    }
    if (pages > 1) {
      inner.push(palette.muted(`… page ${this.page}/${pages} (${SCROLL_HINT})`));
    }

    let innerWidth = 0;
    for (const line of inner) innerWidth = Math.max(innerWidth, visibleWidth(line));
    const bar = "─".repeat(innerWidth + 2);
    const box: string[] = [palette.primary(`╭${bar}╮`)];
    for (const line of inner) {
      const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      box.push(`${palette.primary("│")} ${line}${fill} ${palette.primary("│")}`);
    }
    box.push(palette.primary(`╰${bar}╯`));
    return box;
  }

  private headerLine(): string {
    const { palette } = this;
    const item = this.item;
    // The protocol guarantees isError is true exactly when status is "error".
    const isError = item.status === "error";
    const glyph = item.status === "running" ? palette.primary("◌") : isError ? palette.error("✗") : palette.ok("✓");
    return `${glyph} ${palette.bold(palette.accent(item.toolName))} ${palette.muted(inputSummary(item.toolName, item.input))}`;
  }

  /** One-line collapsed form: glyph, name, input summary, expansion hint. */
  private collapsedLine(width: number): string {
    const { palette } = this;
    const count = this.buildBody().length;
    const suffix =
      count === 0
        ? ""
        : palette.muted(count === 1 ? `(1 line — ${COLLAPSE_HINT})` : `(${count} lines — ${COLLAPSE_HINT})`);
    const line = [this.headerLine(), suffix].filter((part) => part.length > 0).join(" ");
    return truncateToWidth(line.replace(/\s+$/, ""), width);
  }

  /**
   * Full logical body lines (unwrapped; wrapping happens per page at render
   * time so page boundaries stay independent of terminal width).
   */
  private buildBody(): string[] {
    const { palette } = this;
    const item = this.item;
    const body: string[] = [];

    if (item.toolName === "bash") {
      const command = inputSummary("bash", item.input);
      if (command.length > 0) body.push(palette.info(`$ ${command}`));
      const output = extractText(item.content);
      if (output.length > 0) body.push(...output.split("\n"));
      const details = asRecord(item.details);
      const truncated = details ? indicatesTruncation(details.truncation) : false;
      const fullOutputPath = details && typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
      if (truncated || fullOutputPath) {
        const notes: string[] = [];
        if (truncated) notes.push("output truncated");
        if (fullOutputPath) notes.push(`full output: ${fullOutputPath}`);
        body.push(palette.muted(notes.join(" · ")));
      }
    } else if (item.toolName === "edit") {
      const details = asRecord(item.details);
      const diff = details && typeof details.diff === "string" ? details.diff : undefined;
      if (diff !== undefined) {
        body.push(...this.styleDiff(diff));
      } else {
        // Still running or no diff available: fall back to the input summary.
        const summary = inputSummary("edit", item.input);
        if (summary.length > 0) body.push(palette.muted(summary));
      }
    } else {
      const output = extractText(item.content);
      if (output.length > 0) body.push(...output.split("\n"));
    }

    if (item.status === "running") body.push(palette.primary("…"));
    return body;
  }

  /** Color each unified-diff line: + ok, - error, @@ hunk headers info. */
  private styleDiff(diff: string): string[] {
    const { palette } = this;
    return diff.split("\n").map((raw) => {
      if (raw.startsWith("+") && !raw.startsWith("++")) return palette.ok(raw);
      if (raw.startsWith("-") && !raw.startsWith("--")) return palette.error(raw);
      if (raw.startsWith("@@")) return palette.info(raw);
      return raw;
    });
  }
}

export function createKayaUi(): KayaUi {
  const palette = createKayaPalette();
  const markdownTheme = createMarkdownTheme(palette);
  return {
    palette,
    markdownTheme,
    editorTheme: createEditorTheme(palette),
    selectListTheme: createSelectListTheme(palette),
    createItemComponent(item: TranscriptItem): TranscriptItemComponent {
      if (item.role === "user") return new UserItemView(item, palette);
      if (item.role === "assistant") return new AssistantItemView(item, palette, markdownTheme);
      return new ToolItemView(item, palette);
    },
    formatStatus(status: SessionStatusView): string {
      const sep = palette.muted(" │ ");
      const parts: string[] = [];
      if (status.connected) {
        parts.push(`${palette.primary("●")} ${palette.primary(palette.bold("kaya"))}`);
      } else {
        parts.push(`${palette.muted("○")} ${palette.muted("kaya")}`);
      }
      if (status.model.length > 0) parts.push(palette.accent(status.model));
      if (status.thinkingLevel.length > 0) parts.push(palette.muted(`thinking:${status.thinkingLevel}`));
      if (status.phase !== undefined && status.phase !== "idle") parts.push(palette.info(status.phase));
      return parts.join(sep);
    },
  };
}
