// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import type { Message } from "../../pi-ai";
import { PATH_KEYS } from "./tool-args";

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Try to cut at a word boundary
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

/**
 * Clip text to last sentence boundary at or before `max` chars.
 * Falls back to word boundary (clip()) if no sentence end is found in the
 * acceptable range. Trailing whitespace stripped.
 */
export const clipSentence = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Look for sentence terminators followed by space/newline within [max*0.5, max]
  const window = text.slice(0, max);
  const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + 1; // include the punctuation
    if (end >= max * 0.5) return text.slice(0, end);
  }
  return clip(text, max);
};

export const nonEmptyLines = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

export const firstLine = (text: string, max = 200): string =>
  clip(text.split("\n")[0] ?? "", max);

export const textParts = (content: Message["content"]): string[] => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
};

export const textOf = (content: Message["content"]): string =>
  textParts(content).join("\n");

/**
 * Check if tool call arguments contain content-bearing data.
 *
 * A call is content-bearing if it has a path argument AND at least one
 * large string/array field (content, edits, oldText, newText).
 * This is a generic heuristic — not dependent on tool names.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const isContentBearing = (args: Record<string, unknown>): boolean => {
  if (!args || typeof args !== "object") return false;
  // Must have a path in one of the known keys
  const hasPath = PATH_KEYS.some((k) => typeof args[k] === "string");
  if (!hasPath) return false;
  // Must have at least one content-bearing field
  if (typeof args.content === "string" && args.content.length > 0) return true;
  // edits must be a non-empty array of objects (each with oldText/newText)
  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every((e) => typeof e === "object" && e !== null)
  )
    return true;
  // oldText/newText without edits are content-bearing
  if (
    typeof args.oldText === "string" &&
    args.oldText.length > 0 &&
    args.edits === undefined
  )
    return true;
  if (
    typeof args.newText === "string" &&
    args.newText.length > 0 &&
    args.edits === undefined
  )
    return true;
  return false;
};

/**
 * Extract textual content from tool call arguments (content, edits,
 * oldText, newText). Used for counting touched-file lines and search.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const extractToolCallText = (args: Record<string, unknown>): string => {
  let text = "";
  if (typeof args.content === "string") text += args.content + "\n";
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        if (typeof edit.oldText === "string") text += edit.oldText + "\n";
        if (typeof edit.newText === "string") text += edit.newText + "\n";
      }
    }
  }
  if (typeof args.oldText === "string" && !Array.isArray(args.edits))
    text += args.oldText + "\n";
  if (typeof args.newText === "string" && !Array.isArray(args.edits))
    text += args.newText + "\n";
  return text;
};

/**
 * Extract every scalar string argument from a tool call for search indexing
 * — command, query, content, oldText/newText, etc. Generic value walk (no
 * tool-name allowlist): top-level strings plus strings one level into
 * array-of-object fields (e.g. `edits`). Unbounded by design — a single
 * toolCall's raw argument text — so a message with several toolCalls doesn't
 * silently multiply an internal cap. The caller (search-entries.ts) applies
 * one shared budget across all toolCalls in a message.
 */
export const extractToolCallArgsText = (args: Record<string, unknown>): string => {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          parts.push(item);
        } else if (item && typeof item === "object") {
          for (const v of Object.values(item)) {
            if (typeof v === "string") parts.push(v);
          }
        }
      }
    }
  }
  return parts.join("\n");
};

/** Extract a snippet of ~`radius` chars around the first match of `term` in `text`. */
export const snippet = (text: string, term: string, radius = 60): string | null => {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};
