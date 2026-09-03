/**
 * Syntax highlighting for the file pane (SPEC 144).
 *
 * User, 2026-08-10: *"when i open a ts file here i dont get the highlights like in proper editors"*.
 * Reading code in one flat grey is the difference between a file pane you use and one you glance at
 * and then open a real editor.
 *
 * WHY PER-LINE HTML rather than one highlighted blob. A place chip (`app.ts:120`) has to land on a
 * LINE, and the old pane found one by splitting the pre's text and rebuilding it — which highlighted
 * markup would be destroyed by. So highlighting emits one element per line: the jump becomes a
 * lookup instead of a rebuild, and line numbers become possible at all.
 *
 * The hard part is that a highlighter's spans cross newlines (a block comment is one span over ten
 * lines), so a naive `split("\n")` yields lines with unbalanced tags — which the browser then
 * "fixes" by re-nesting the whole rest of the file inside one span. `splitLines` therefore closes
 * the open stack at each newline and re-opens it on the next, and the property that pins it is the
 * one that matters: the rows' text, concatenated, is byte-for-byte the input.
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import nix from "highlight.js/lib/languages/nix";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Registered by hand, not by importing the whole library: the full package is 9 MB of grammars, and
 * the pane is served over a LAN to a phone. This list is what User's trees actually contain — add
 * to it when a file lands here reading grey.
 */
for (const [name, lang] of [
  ["bash", bash],
  ["c", c],
  ["cpp", cpp],
  ["css", css],
  ["diff", diff],
  ["go", go],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["lua", lua],
  ["markdown", markdown],
  ["nix", nix],
  ["python", python],
  ["ruby", ruby],
  ["rust", rust],
  ["sql", sql],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
] as const) {
  hljs.registerLanguage(name, lang);
}

/** Extension → grammar. An extension with no entry is rendered plain rather than guessed at. */
const BY_EXT: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  conf: "ini",
  cpp: "cpp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonl: "json",
  jsx: "javascript",
  kt: "java",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  nix: "nix",
  patch: "diff",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "css",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

/** Files whose NAME carries the language, because they have no extension to read. */
const BY_NAME: Record<string, string> = {
  ".gitignore": "bash",
  ".zshrc": "bash",
  dockerfile: "bash",
  makefile: "bash",
};

export function languageOf(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const byName = BY_NAME[name];
  if (byName !== undefined) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile already handled above
  return BY_EXT[name.slice(dot + 1)] ?? null;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Cut highlighted HTML into one string per line, keeping every span balanced within its line.
 *
 * The input is highlight.js output: escaped text, `<span class="…">` and `</span>`, and nothing
 * else — no attributes that could contain a `>`, which is what lets the tag scanner stay this
 * simple. A newline closes the whole open stack and the next line re-opens it, so a block comment
 * spanning ten lines is ten complete spans rather than one that swallows the file.
 */
export function splitLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";

  for (const token of html.match(/<\/?span[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</span")) {
      open.pop();
      line += token;
    } else if (token.startsWith("<span")) {
      open.push(token);
      line += token;
    } else {
      const parts = token.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lines.push(line + "</span>".repeat(open.length));
          line = open.join("");
        }
        line += parts[i] ?? "";
      }
    }
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

/**
 * One HTML string per line of `text`. An unknown language is escaped and returned unstyled — a
 * wrong grammar reads worse than none, and `highlightAuto` guesses wrong on short files.
 */
export function highlightLines(text: string, language: string | null): string[] {
  if (language === null || !hljs.getLanguage(language)) {
    return text.split("\n").map(escapeHtml);
  }
  try {
    return splitLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
  } catch {
    return text.split("\n").map(escapeHtml); // a grammar that throws must not cost the read
  }
}
