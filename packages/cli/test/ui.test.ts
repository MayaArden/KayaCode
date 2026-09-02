import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { createKayaUi, isExpandable } from "../src/ui/index.js";
import type { ExpandableComponent } from "../src/ui/index.js";

// Force truecolor so palette-specific ANSI codes are deterministic in tests.
chalk.level = 3;

const ui = createKayaUi();
const ACCENT_RGB = "38;2;122;162;247";
const USER_TEXT_RGB = "38;2;192;202;245";

/** Render a component at width 80 and assert every line fits. */
function render80(item: TranscriptItem): string[] {
  const component = ui.createItemComponent(item);
  const lines = component.render(80);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(visibleWidth(line), `line too wide: ${JSON.stringify(line)}`).toBeLessThanOrEqual(80);
  }
  return lines;
}

function plain(item: TranscriptItem): string {
  return stripTerminalSequences(render80(item).join("\n"));
}

function asExpandable(item: TranscriptItem): ExpandableComponent {
  const component = ui.createItemComponent(item);
  if (!isExpandable(component)) throw new Error("expected an expandable component");
  return component;
}

const userItem: TranscriptItem = {
  id: "u1",
  role: "user",
  content: [{ type: "text", text: "hello kaya, please fix the parser" }],
  timestamp: 0,
};

const assistantStreaming: TranscriptItem = {
  id: "a1",
  role: "assistant",
  content: [
    { type: "thinking", thinking: "I should look at the parser file first" },
    { type: "text", text: "Let me check **the parser**." },
    { type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls -la src" } },
  ],
  model: { provider: "anthropic", id: "test-model" },
  timestamp: 0,
  status: "streaming",
};

const assistantComplete: TranscriptItem = { ...assistantStreaming, status: "complete", stopReason: "toolUse" };

const assistantTextOnly: TranscriptItem = {
  id: "a2",
  role: "assistant",
  content: [{ type: "text", text: "Plain answer with no thinking." }],
  model: { provider: "anthropic", id: "test-model" },
  timestamp: 0,
  status: "complete",
  stopReason: "stop",
};

const bashRunning: TranscriptItem = {
  id: "t1",
  role: "tool",
  toolCallId: "tc1",
  toolName: "bash",
  input: { command: "npm test", timeout: 60 },
  content: [],
  timestamp: 0,
  status: "running",
  isError: false,
};

const longOutput = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
const bashComplete: TranscriptItem = {
  id: "t2",
  role: "tool",
  toolCallId: "tc1",
  toolName: "bash",
  input: { command: "npm test" },
  content: [{ type: "text", text: longOutput }],
  details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full-output.log" },
  timestamp: 0,
  status: "complete",
  isError: false,
};

const editComplete: TranscriptItem = {
  id: "t3",
  role: "tool",
  toolCallId: "tc2",
  toolName: "edit",
  input: { path: "src/parser.ts" },
  content: [],
  details: {
    diff: ["@@ -1,2 +1,3 @@", " context line", "+ added line", "- removed line"].join("\n"),
    patch: "fake patch",
    firstChangedLine: "- removed line",
  },
  timestamp: 0,
  status: "complete",
  isError: false,
};

const genericComplete: TranscriptItem = {
  id: "t4",
  role: "tool",
  toolCallId: "tc3",
  toolName: "read",
  input: { path: "src/parser.ts" },
  content: [{ type: "text", text: Array.from({ length: 25 }, (_, i) => `file line ${i}`).join("\n") }],
  timestamp: 0,
  status: "complete",
  isError: false,
};

const toolError: TranscriptItem = {
  id: "t5",
  role: "tool",
  toolCallId: "tc4",
  toolName: "bash",
  input: { command: "exit 1" },
  content: [{ type: "text", text: "Command failed with exit code: 1" }],
  timestamp: 0,
  status: "error",
  isError: true,
};

describe("user item", () => {
  it("renders a double-border box with marker and text", () => {
    const lines = render80(userItem);
    const raw = lines.join("\n");
    const text = stripTerminalSequences(raw);
    expect(text).toContain("╔");
    expect(text).toContain("║");
    expect(text).toContain("╚");
    expect(text).toContain("❯");
    expect(text).toContain("hello kaya, please fix the parser");
    // Border lines carry the accent color code.
    expect(lines[0]).toContain(ACCENT_RGB);
    // The message text carries the userText color code.
    expect(lines[1]).toContain(USER_TEXT_RGB);
  });

  it("wraps long user text inside the box", () => {
    const long: TranscriptItem = {
      ...userItem,
      content: [{ type: "text", text: "word ".repeat(60).trim() }],
    };
    const lines = render80(long);
    expect(lines.length).toBeGreaterThan(3);
    expect(plain(long)).toContain("word");
  });
});

describe("assistant item", () => {
  it("expands thinking while streaming, with text and toolCall lines", () => {
    const text = plain(assistantStreaming);
    expect(text).toContain("thinking");
    expect(text).toContain("I should look at the parser file first");
    expect(text).toContain("Let me check the parser.");
    expect(text).toContain("→");
    expect(text).toContain("bash");
    expect(text).toContain("ls -la");
  });

  it("appends the streaming cursor on the last text line", () => {
    const component = ui.createItemComponent(assistantStreaming);
    const lines = component.render(80).map((line) => stripTerminalSequences(line));
    const textLine = lines.find((line) => line.includes("Let me check the parser."));
    expect(textLine).toBeDefined();
    expect(textLine).toContain("▍");
  });

  it("collapses thinking to a char count once complete, and is expandable", () => {
    const component = asExpandable(assistantComplete);
    const text = stripTerminalSequences(component.render(80).join("\n"));
    expect(text).toMatch(/thinking \(\d+ chars\)/);
    expect(text).not.toContain("I should look at the parser file first");
    expect(text).not.toContain("▍");
    expect(component.isCollapsed()).toBe(true);
  });

  it("toggleExpanded round-trips all thinking blocks; scrollContent is a no-op", () => {
    const component = asExpandable(assistantComplete);
    component.toggleExpanded();
    expect(component.isCollapsed()).toBe(false);
    const expanded = stripTerminalSequences(component.render(80).join("\n"));
    expect(expanded).toContain("I should look at the parser file first");
    component.toggleExpanded();
    expect(component.isCollapsed()).toBe(true);
    expect(stripTerminalSequences(component.render(80).join("\n"))).toMatch(/thinking \(\d+ chars\)/);
    expect(component.scrollContent(1)).toBe(false);
    expect(component.scrollContent(-1)).toBe(false);
  });

  it("keeps the user's toggle across update() while streaming", () => {
    const component = asExpandable(assistantStreaming);
    component.toggleExpanded(); // collapse thinking while still streaming
    expect(component.isCollapsed()).toBe(true);
    const text = stripTerminalSequences(component.render(80).join("\n"));
    expect(text).toMatch(/thinking \(\d+ chars\)/);
    expect(text).toContain("▍"); // text block still streams
  });

  it("is not expandable without thinking blocks", () => {
    const component = ui.createItemComponent(assistantTextOnly);
    expect(isExpandable(component)).toBe(false);
  });

  it("summarizes toolCall input given as a raw JSON string", () => {
    const raw: TranscriptItem = {
      ...assistantStreaming,
      content: [{ type: "toolCall", toolCallId: "tc9", toolName: "edit", input: '{"path":"src/a.ts"}' }],
    };
    expect(plain(raw)).toContain("src/a.ts");
  });
});

describe("tool item: bash", () => {
  it("renders the expanded box while running", () => {
    const text = plain(bashRunning);
    expect(text).toContain("◌");
    expect(text).toContain("bash");
    expect(text).toContain("npm test");
    expect(text).toContain("$ npm test");
    expect(text).toContain("…");
    expect(text).toContain("╭");
  });

  it("draws a rounded box", () => {
    const lines = render80(bashRunning);
    expect(stripTerminalSequences(lines[0] ?? "")).toMatch(/^╭─+╮$/);
    expect(stripTerminalSequences(lines[lines.length - 1] ?? "")).toMatch(/^╰─+╯$/);
    expect(stripTerminalSequences(lines[1] ?? "")).toMatch(/^│ .*│$/);
  });

  it("auto-collapses on completion when the user never toggled", () => {
    const component = asExpandable(bashRunning);
    expect(component.isCollapsed()).toBe(false);
    component.update(bashComplete);
    expect(component.isCollapsed()).toBe(true);
    const collapsed = stripTerminalSequences(component.render(80).join("\n"));
    expect(collapsed).not.toContain("╭");
    expect(collapsed).toContain("(42 lines — ctrl+o to expand)");
  });

  it("keeps the user's toggle across the running -> finished transition", () => {
    const component = asExpandable(bashRunning);
    component.toggleExpanded(); // collapse while running
    component.toggleExpanded(); // expand again — user choice is now "expanded"
    component.update(bashComplete);
    expect(component.isCollapsed()).toBe(false);
    expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("╭");
  });

  it("pages expanded output with indicators and end-of-range scrolls", () => {
    const component = asExpandable(bashComplete); // already finished: collapsed
    component.toggleExpanded();
    // Body = $ command + 40 output lines + footer = 42 lines -> 3 pages.
    const page1 = stripTerminalSequences(component.render(80).join("\n"));
    expect(page1).toContain("$ npm test");
    expect(page1).toContain("line 0");
    expect(page1).not.toContain("line 39");
    expect(page1).toContain("… page 1/3 (alt+up/alt+down)");

    expect(component.scrollContent(1)).toBe(true);
    const page2 = stripTerminalSequences(component.render(80).join("\n"));
    expect(page2).toContain("… page 2/3 (alt+up/alt+down)");

    expect(component.scrollContent(1)).toBe(true);
    const page3 = stripTerminalSequences(component.render(80).join("\n"));
    expect(page3).toContain("line 39");
    expect(page3).toContain("output truncated");
    expect(page3).toContain("/tmp/full-output.log");
    expect(page3).not.toContain("line 0\n");

    expect(component.scrollContent(1)).toBe(false); // last page
    expect(component.scrollContent(-1)).toBe(true);
    expect(component.scrollContent(-1)).toBe(true);
    expect(component.scrollContent(-1)).toBe(false); // first page
  });

  it("scrollContent does nothing while collapsed", () => {
    const component = asExpandable(bashComplete);
    expect(component.scrollContent(1)).toBe(false);
  });
});

describe("tool item: edit", () => {
  it("renders diff lines with +/- and hunk headers when expanded", () => {
    const component = asExpandable(editComplete);
    component.toggleExpanded();
    const text = stripTerminalSequences(component.render(80).join("\n"));
    expect(text).toContain("edit");
    expect(text).toContain("src/parser.ts");
    expect(text).toContain("+ added line");
    expect(text).toContain("- removed line");
    expect(text).toContain("@@ -1,2 +1,3 @@");
    expect(text).not.toContain("page "); // single page, no indicator
  });

  it("falls back to the input summary while the diff is missing", () => {
    const running: TranscriptItem = {
      ...editComplete,
      status: "running",
      isError: false,
      details: undefined,
    };
    const text = plain(running);
    expect(text).toContain("src/parser.ts");
    expect(text).toContain("…");
  });

  it("pages long diffs at 20 lines per page", () => {
    const many = Array.from({ length: 60 }, (_, i) => `+ added ${i}`).join("\n");
    const big: TranscriptItem = { ...editComplete, details: { diff: many, patch: "x" } };
    const component = asExpandable(big);
    component.toggleExpanded();
    const page1 = stripTerminalSequences(component.render(80).join("\n"));
    expect(page1).toContain("+ added 0");
    expect(page1).not.toContain("+ added 59");
    expect(page1).toContain("… page 1/3 (alt+up/alt+down)");
    component.scrollContent(2);
    const page3 = stripTerminalSequences(component.render(80).join("\n"));
    expect(page3).toContain("+ added 59");
  });
});

describe("tool item: generic", () => {
  it("pages content at 20 lines and reports the collapsed line count", () => {
    const component = asExpandable(genericComplete);
    expect(component.isCollapsed()).toBe(true);
    const collapsed = stripTerminalSequences(component.render(80).join("\n"));
    expect(collapsed).toContain("read");
    expect(collapsed).toContain("(25 lines — ctrl+o to expand)");

    component.toggleExpanded();
    const page1 = stripTerminalSequences(component.render(80).join("\n"));
    expect(page1).toContain("file line 0");
    expect(page1).not.toContain("file line 24");
    expect(page1).toContain("… page 1/2 (alt+up/alt+down)");
    expect(component.scrollContent(1)).toBe(true);
    const page2 = stripTerminalSequences(component.render(80).join("\n"));
    expect(page2).toContain("file line 24");
    expect(page2).not.toContain("file line 0\n");
    expect(component.scrollContent(1)).toBe(false);
  });

  it("marks error state with the error glyph; body visible when expanded", () => {
    const collapsed = plain(toolError);
    expect(collapsed).toContain("✗");
    expect(collapsed).toContain("bash");
    expect(collapsed).toContain("exit 1");
    const component = asExpandable(toolError);
    component.toggleExpanded();
    const expanded = stripTerminalSequences(component.render(80).join("\n"));
    expect(expanded).toContain("Command failed with exit code: 1");
  });
});

describe("formatStatus", () => {
  it("renders connected status with model, thinking level, and phase", () => {
    const line = ui.formatStatus({
      phase: "turn",
      model: "kimi-k2",
      thinkingLevel: "high",
      connected: true,
      serverAddress: "127.0.0.1:9",
    });
    const text = stripTerminalSequences(line);
    expect(text).toContain("● kaya");
    expect(text).toContain("kimi-k2");
    expect(text).toContain("thinking:high");
    expect(text).toContain("turn");
    expect(text).toContain("│");
  });

  it("renders disconnected and idle state", () => {
    const line = ui.formatStatus({
      phase: "idle",
      model: "kimi-k2",
      thinkingLevel: "off",
      connected: false,
      serverAddress: "",
    });
    const text = stripTerminalSequences(line);
    expect(text).toContain("○ kaya");
    expect(text).not.toContain("idle");
  });
});
