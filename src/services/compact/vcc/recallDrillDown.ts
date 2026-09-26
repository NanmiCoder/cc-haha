// cc-haha drill-down for the vcc_recall tool: resolve `#N:path` to the
// file content a tool call in the `#N` cc row captured.
//
// pi-vcc's expandEntryFile indexes pi rawMessages by `#N` and reads their
// toolCall parts. cc-haha's `#N` is a cc row (see recallLoader); a row's
// tool_use blocks carry the same arguments. We reuse the vendor's
// isContentBearing/extractPath/parseDrillDown and mirror formatToolCallContent
// (which is not exported from the vendored drill-down.ts).
import { isContentBearing } from "./vendor/core/content"
import { extractPath } from "./vendor/core/tool-args"
import { parseDrillDown } from "./vendor/core/drill-down"
import type { CcLine } from "./recallLoader"

export type { parseDrillDown }

interface ContentBearingCall {
  name: string
  path: string
  content?: string
  oldText?: string
  newText?: string
  edits?: Array<{ oldText?: string; newText?: string }>
}

/** Find content-bearing tool_use blocks in a cc row's message content. */
export function findContentBearingCcCalls(
  content: CcLine["message"] extends undefined
    ? never
    : NonNullable<CcLine["message"]>["content"],
): ContentBearingCall[] {
  if (!Array.isArray(content)) return []
  const results: ContentBearingCall[] = []
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue
    const args = (block.input && typeof block.input === "object" ? block.input : {}) as Record<
      string,
      unknown
    >
    if (!isContentBearing(args)) continue
    const path = extractPath(args)
    if (!path) continue
    const entry: ContentBearingCall = { name: String(block.name ?? ""), path }
    if (typeof args.content === "string") entry.content = args.content
    if (Array.isArray(args.edits)) {
      entry.edits = (args.edits as unknown[]).filter(
        (e): e is { oldText?: string; newText?: string } =>
          e !== null && typeof e === "object",
      ) as ContentBearingCall["edits"]
    }
    if (typeof args.oldText === "string" && !Array.isArray(args.edits))
      entry.oldText = args.oldText
    if (typeof args.newText === "string" && !Array.isArray(args.edits))
      entry.newText = args.newText
    results.push(entry)
  }
  return results
}

const formatToolCallContent = (
  tc: ContentBearingCall,
  entryIndex: number,
  options?: { full?: boolean; offset?: number; limit?: number },
): string => {
  let body: string
  if (tc.content) {
    body = tc.content
  } else if (tc.edits) {
    body = tc.edits
      .map(
        (e, i) =>
          `--- edit ${i + 1} ---\n${e.oldText ?? ""}\n--- becomes ---\n${e.newText ?? ""}`,
      )
      .join("\n\n")
  } else if (tc.oldText && tc.newText) {
    body = `--- old ---\n${tc.oldText}\n--- new ---\n${tc.newText}`
  } else {
    body = "(no file content found in tool call arguments)"
  }

  const full = options?.full ?? false
  const offset = options?.offset
  const limit = options?.limit
  const allLines = body.split("\n")
  const totalLines = allLines.length
  const previewLimit = 30
  const MAX_FULL_BYTES = 50 * 1024

  if (full) {
    if (Buffer.byteLength(body, "utf8") > MAX_FULL_BYTES) {
      const truncated = body.slice(0, MAX_FULL_BYTES)
      return `File: ${tc.path}
Tool: ${tc.name}

${truncated}

... (${Buffer.byteLength(body, "utf8") - MAX_FULL_BYTES} more bytes — file exceeds 50KB display limit. Use #${entryIndex}:${tc.path}:${previewLimit} for next page.)`
    }
    return `File: ${tc.path}
Tool: ${tc.name}

${body}`
  }

  if (offset !== undefined) {
    const startLine = Math.max(0, offset)
    const maxLines = limit ?? 30
    const endLine = Math.min(startLine + maxLines, totalLines)
    const visible = allLines.slice(startLine, endLine)
    const displayStart = startLine + 1

    if (visible.length === 0) {
      return `Offset ${startLine} is beyond file length ${totalLines}. Use #${entryIndex}:${tc.path} for the first ${previewLimit} lines.`
    }

    let result = `File: ${tc.path}
Tool: ${tc.name}
Lines ${displayStart}-${endLine} (of ${totalLines}):

`
    result += visible.join("\n")

    if (endLine < totalLines) {
      result += `\n\n--- Use #${entryIndex}:${tc.path}:${endLine} or #${entryIndex}:${tc.path}:${endLine}:${maxLines} for next ${maxLines} lines, #${entryIndex}:${tc.path}:full for complete ---`
    } else if (offset > 0) {
      result += `\n\n(End of file)`
    }
    return result
  }

  if (totalLines > previewLimit) {
    const preview = allLines.slice(0, previewLimit).join("\n")
    return `File: ${tc.path}
Tool: ${tc.name}

${preview}

...(${totalLines - previewLimit} more lines — use #${entryIndex}:${tc.path}:full for complete content, or #${entryIndex}:${tc.path}:${previewLimit} for next ${previewLimit} lines)`
  }

  return `File: ${tc.path}
Tool: ${tc.name}

${body}`
}

/**
 * Expand a `#N:path` drill-down query against a loaded cc session.
 * `byIndex` is the `#N`→cc-row map from loadCcSession/loadCcSessionFile.
 */
export function expandCcEntryFile(
  byIndex: Map<number, CcLine>,
  entryIndex: number,
  pathPattern: string,
  full = false,
  offset?: number,
  limit?: number,
): string {
  const line = byIndex.get(entryIndex)
  if (!line || !line.message) {
    return `Entry #${entryIndex} not found in session history.`
  }

  const calls = findContentBearingCcCalls(line.message.content)

  if (pathPattern === "file") {
    if (calls.length === 0) {
      return `No file content found in entry #${entryIndex}.`
    }
    if (calls.length === 1) {
      return formatToolCallContent(calls[0], entryIndex, { full, offset, limit })
    }
    const items = calls.map(
      (tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`,
    )
    return `Entry #${entryIndex} has ${calls.length} file operations:\n${items.join("\n")}\n\nUse #${entryIndex}:path to drill into a specific file.`
  }

  const matched = calls.filter((tc) => tc.path.includes(pathPattern))
  if (matched.length === 0) {
    return `No file content found in entry #${entryIndex} for "${pathPattern}".`
  }
  if (matched.length > 1) {
    const items = matched.map(
      (tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`,
    )
    return `Entry #${entryIndex} has ${matched.length} file operations matching "${pathPattern}":
${items.join("\n")}

Use #${entryIndex}:<more-specific-path> to drill into a specific file.`
  }

  return formatToolCallContent(matched[0], entryIndex, { full, offset, limit })
}
