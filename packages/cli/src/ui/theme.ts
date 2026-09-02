import chalk from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import type { KayaPalette } from "../ui-types.js";

/**
 * Kaya's blue-first palette. See ui-types.ts for the hex rationale.
 */
export function createKayaPalette(): KayaPalette {
  return {
    primary: chalk.hex("#5CB8FF"),
    accent: chalk.hex("#7AA2F7"),
    info: chalk.hex("#89DDFF"),
    muted: chalk.hex("#3D59A1"),
    userText: chalk.hex("#C0CAF5"),
    ok: chalk.hex("#9ECE6A"),
    error: chalk.hex("#F7768E"),
    bold: chalk.bold,
    italic: chalk.italic,
  };
}

export function createMarkdownTheme(p: KayaPalette): MarkdownTheme {
  return {
    heading: (text) => p.bold(p.accent(text)),
    link: (text) => chalk.underline(p.info(text)),
    linkUrl: (text) => p.muted(text),
    code: (text) => p.info(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => p.muted(text),
    quote: (text) => p.muted(text),
    quoteBorder: (text) => p.muted(text),
    hr: (text) => p.muted(text),
    listBullet: (text) => p.muted(text),
    bold: (text) => p.bold(text),
    italic: (text) => p.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
  };
}

export function createSelectListTheme(p: KayaPalette): SelectListTheme {
  return {
    selectedPrefix: (text) => p.primary(text),
    selectedText: (text) => p.primary(text),
    description: (text) => p.muted(text),
    scrollInfo: (text) => p.muted(text),
    noMatch: (text) => p.muted(text),
  };
}

export function createEditorTheme(p: KayaPalette): EditorTheme {
  return {
    borderColor: p.primary,
    selectList: createSelectListTheme(p),
  };
}
