// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
/**
 * Drill-down: resolve #N:path syntax to tool call file content.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 *
 * Supports: #42:auth.ts (preview), #42:auth.ts:full (full content), #42:file (auto-select).
 *
 * Path matching notes:
 * - The regex uses $ anchor so lazy .+? consumes the full path — spaces, dots, and
 *   Windows drive-letter colons (C:\) all work correctly.
 * - One edge case: a file path literally ending in ":full" (e.g. C:\file:full)
 *   would be misinterpreted as the :full flag. This is extremely unlikely.
 * - Inline queries like "check #42:auth.ts" are NOT drill-down — the ^ anchor
 *   requires the entire query to be the drill-down pattern.
 */
import { isContentBearing } from "./content";
import { extractPath } from "./tool-args";
import { loadAllMessages } from "./load-messages";

// ── Types ─────────────────────────────────────────────────────────────────

interface ContentBearingCall {
  name: string;
  path: string;
  content?: string;
  oldText?: string;
  newText?: string;
  edits?: Array<{ oldText?: string; newText?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Find content-bearing tool calls that have a `path` argument and at least
 * one content field (content, edits, oldText, newText).
 * Uses the shared isContentBearing() heuristic from content.ts.
 */
function findContentBearingCalls(content: unknown[]): ContentBearingCall[] {
  if (!Array.isArray(content)) return [];
  const results: ContentBearingCall[] = [];
  for (const part of content) {
    if (!part || (part as any).type !== "toolCall") continue;
    const args = (part as any).arguments ?? {};
    if (!isContentBearing(args)) continue;
    const path = extractPath(args);
    if (!path) continue;
    const entry: ContentBearingCall = { name: (part as any).name ?? "", path };
    if (typeof args.content === "string") entry.content = args.content;
    if (Array.isArray(args.edits)) {
      entry.edits = args.edits.filter(
        (e: unknown): e is { oldText?: string; newText?: string } =>
          e !== null && typeof e === "object",
      );
    }
    if (typeof args.oldText === "string" && !Array.isArray(args.edits))
      entry.oldText = args.oldText;
    if (typeof args.newText === "string" && !Array.isArray(args.edits))
      entry.newText = args.newText;
    results.push(entry);
  }
  return results;
}

/** Format content for display with optional offset/limit slicing.
 *
 * When full=true, shows everything ignoring offset/limit.
 * When offset/limit given, shows a window with "Lines X-Y (of Z)" header.
 * When neither, shows preview (first 30 lines) with truncation hint.
 */
function formatToolCallContent(
  tc: ContentBearingCall,
  entryIndex: number,
  options?: { full?: boolean; offset?: number; limit?: number },
): string {
  let body: string;
  if (tc.content) {
    body = tc.content;
  } else if (tc.edits) {
    body = tc.edits
      .map(
        (e, i) =>
          `--- edit ${i + 1} ---\n${e.oldText ?? ""}\n--- becomes ---\n${e.newText ?? ""}`,
      )
      .join("\n\n");
  } else if (tc.oldText && tc.newText) {
    body = `--- old ---\n${tc.oldText}\n--- new ---\n${tc.newText}`;
  } else {
    body = "(no file content found in tool call arguments)";
  }

  const full = options?.full ?? false;
  const offset = options?.offset;
  const limit = options?.limit;
  const allLines = body.split("\n");
  const totalLines = allLines.length;
  const previewLimit = 30;
  const MAX_FULL_BYTES = 50 * 1024;

  if (full) {
    // Full content: capped at 50KB
    if (Buffer.byteLength(body, "utf8") > MAX_FULL_BYTES) {
      const truncated = body.slice(0, MAX_FULL_BYTES);
      return `File: ${tc.path}
Tool: ${tc.name}

${truncated}

... (${Buffer.byteLength(body, "utf8") - MAX_FULL_BYTES} more bytes — file exceeds 50KB display limit. Use #${entryIndex}:${tc.path}:${previewLimit} for next page.)`;
    }
    return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
  }

  if (offset !== undefined) {
    // Offset-based window: show slice
    const startLine = Math.max(0, offset);
    const maxLines = limit ?? 30;
    const endLine = Math.min(startLine + maxLines, totalLines);
    const visible = allLines.slice(startLine, endLine);
    const displayStart = startLine + 1; // 1-indexed for user display

    if (visible.length === 0) {
      return `Offset ${startLine} is beyond file length ${totalLines}. Use #${entryIndex}:${tc.path} for the first ${previewLimit} lines.`;
    }

    let result = `File: ${tc.path}
Tool: ${tc.name}
Lines ${displayStart}-${endLine} (of ${totalLines}):

`;
    result += visible.join("\n");

    if (endLine < totalLines) {
      result += `\n\n--- Use #${entryIndex}:${tc.path}:${endLine} or #${entryIndex}:${tc.path}:${endLine}:${maxLines} for next ${maxLines} lines, #${entryIndex}:${tc.path}:full for complete ---`;
    } else if (offset > 0) {
      result += `\n\n(End of file)`;
    }

    return result;
  }

  // Default preview mode: first ${previewLimit} lines
  if (totalLines > previewLimit) {
    const preview = allLines.slice(0, previewLimit).join("\n");
    return `File: ${tc.path}
Tool: ${tc.name}

${preview}

...(${totalLines - previewLimit} more lines — use #${entryIndex}:${tc.path}:full for complete content, or #${entryIndex}:${tc.path}:${previewLimit} for next ${previewLimit} lines)`;
  }

  return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
}

// ── Parse drill-down query ────────────────────────────────────────────────

/**
 * Pattern: #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit
 * Group 1: index number
 * Group 2: path (consumed lazily, expanded until suffix can match)
 * Group 3: suffix — "full", a number (offset), or "offset:limit"
 */
const DRILLDOWN_PATTERN = /^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/;

/**
 * Parse a drill-down query like #42:auth.ts or #42:auth.ts:full.
 * Returns null if the query doesn't match the drill-down pattern.
 *
 * Suffixes:
 *   :full       → full content (no truncation)
 *   :30         → offset 30 lines, default limit (30)
 *   :30:20      → offset 30 lines, limit 20 lines
 *   (none)      → preview first 30 lines
 */
export function parseDrillDown(query: string): {
  index: number;
  pathPattern: string;
  full: boolean;
  offset?: number;
  limit?: number;
} | null {
  const match = query.match(DRILLDOWN_PATTERN);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  const pathPattern = match[2];
  const suffix = match[3];

  if (suffix === "full") {
    return {
      index,
      pathPattern,
      full: true,
      offset: undefined,
      limit: undefined,
    };
  }

  if (suffix !== undefined) {
    // Parse "offset" or "offset:limit"
    const parts = suffix.split(":");
    const offset = parseInt(parts[0], 10);
    const limit = parts[1] !== undefined ? parseInt(parts[1], 10) : undefined;
    if (!Number.isNaN(offset)) {
      return { index, pathPattern, full: false, offset, limit };
    }
  }

  return {
    index,
    pathPattern,
    full: false,
    offset: undefined,
    limit: undefined,
  };
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Expand a drill-down query (#N:path) to tool call content.
 *
 * Offset/limit let you page through file content incrementally (like pi's read tool):
 *   #42:auth.ts         → first 30 lines (preview)
 *   #42:auth.ts:full    → all content
 *   #42:auth.ts:30      → lines 31-60 (default limit 30)
 *   #42:auth.ts:30:20   → lines 31-50 (custom limit 20)
 *
 * @param sessionFile - Path to the JSONL session file
 * @param entryIndex - The message index (#N)
 * @param pathPattern - File path substring to match (or "file" keyword)
 * @param full - If true, return complete content without truncation
 * @param offset - Line offset (0-indexed) for windowed content
 * @param limit - Max lines to show (default 30 for windowed, ignored if full=true)
 * @returns Formatted content string
 */
export function expandEntryFile(
  sessionFile: string,
  entryIndex: number,
  pathPattern: string,
  full = false,
  offset?: number,
  limit?: number,
): string {
  const { rawMessages } = loadAllMessages(sessionFile, true);

  if (entryIndex < 0 || entryIndex >= rawMessages.length) {
    return `Entry #${entryIndex} not found in session history.`;
  }

  const msg = rawMessages[entryIndex];
  const content = msg.content as unknown[];
  const calls = findContentBearingCalls(content);

  // Special case: #42:file keyword
  if (pathPattern === "file") {
    if (calls.length === 0) {
      return `No file content found in entry #${entryIndex}.`;
    }
    if (calls.length === 1) {
      return formatToolCallContent(calls[0], entryIndex, {
        full,
        offset,
        limit,
      });
    }
    // Multiple content-bearing calls — list them
    const items = calls.map(
      (tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`,
    );
    return `Entry #${entryIndex} has ${calls.length} file operations:\n${items.join("\n")}\n\nUse #${entryIndex}:path to drill into a specific file.`;
  }

  const matched = calls.filter((tc) => tc.path.includes(pathPattern));

  if (matched.length === 0) {
    return `No file content found in entry #${entryIndex} for "${pathPattern}".`;
  }

  if (matched.length > 1) {
    // Ambiguous match — list options instead of silently picking the first
    const items = matched.map(
      (tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`,
    );
    return `Entry #${entryIndex} has ${matched.length} file operations matching "${pathPattern}":
${items.join("\n")}

Use #${entryIndex}:<more-specific-path> to drill into a specific file.`;
  }

  return formatToolCallContent(matched[0], entryIndex, { full, offset, limit });
}