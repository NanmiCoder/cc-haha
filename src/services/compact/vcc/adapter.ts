// cc-haha session messages → the pi message shapes pi-vcc's core reads.
//
// cc-haha stores Anthropic-SDK-shaped messages: {type:'user'|'assistant',
// message:{role, content: string | Block[]}, uuid, ...}. The pi core wants
// role-topped messages whose content is a flat parts array, with Bash
// tool_use/tool_result pairs collapsed into a single `bashExecution` message
// (the core's compressBash / file tracking key on that shape).
//
// Every emitted pi message carries a session-global `#N` index (the recall
// index space). The engine builds the uuid→index map from the session JSONL
// using the same counting rule recall uses, so summary `(#N)` refs resolve.
import type {
  AssistantMessage,
  BashExecutionMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "./pi-ai"
import type { FileOps } from "./vendor/types"

export type PiMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage

/** The cc-haha message wrapper (subset we rely on — see src/types/message). */
export interface CcMessage {
  type: "user" | "assistant"
  uuid?: string
  timestamp?: string
  /** Marks the synthesized continuation summary after a compaction. */
  isCompactSummary?: boolean
  message: {
    role: "user" | "assistant"
    content:
      | string
      | Array<{ type: string; [k: string]: any }>
    [k: string]: any
  }
}

const timeOf = (m: CcMessage): number => {
  const t = Date.parse(m.timestamp ?? "")
  return Number.isFinite(t) ? t : 0
}

const textOfBlocks = (blocks: Array<{ type: string; [k: string]: any }>): string =>
  blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")

const imageParts = (
  blocks: Array<{ type: string; [k: string]: any }>,
): ImageContent[] =>
  blocks
    .filter((b) => b.type === "image")
    .map((b) => ({
      type: "image" as const,
      data: "",
      mimeType:
        b.source?.media_type ??
        (typeof b.url === "string" && b.url.startsWith("data:")
          ? b.url.slice(5, b.url.indexOf(";"))
          : "image/png"),
    }))

const toolCallsOf = (
  blocks: Array<{ type: string; [k: string]: any }>,
): ToolCall[] =>
  blocks
    .filter((b) => b.type === "tool_use" && typeof b.id === "string")
    .map((b) => ({
      type: "toolCall" as const,
      id: b.id as string,
      name: String(b.name ?? "tool"),
      arguments: (b.input && typeof b.input === "object" ? b.input : {}) as Record<
        string,
        any
      >,
    }))

const textOfToolResult = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
  return ""
}

export interface VccAdapted {
  messages: PiMessage[]
  fileOps: FileOps
  /** uuid → session-global `#N`, for messages that resolved one. */
  indexByUuid: Map<string, number>
  /** Global index parallel to `messages` (undefined where unresolvable). */
  sourceIndices: Array<number | undefined>
  /** Source cc-haha message index parallel to `messages` (the cut must not
   *   split a cc message's emitted pi messages). */
  ccIndices: number[]
}

export function adaptCcMessages(
  ccMessages: CcMessage[],
  globalIndexByUuid: Map<string, number>,
): VccAdapted {
  const out: PiMessage[] = []
  const sourceIndices: Array<number | undefined> = []
  const ccIndices: number[] = []
  const fileOps: FileOps = { readFiles: [], modifiedFiles: [], createdFiles: [] }

  // First pass: tool_use id → name/args so Bash tool_results become bashExecution.
  const toolUseById = new Map<string, { name: string; input: any }>()
  for (const m of ccMessages) {
    const c = m.message.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b.type === "tool_use" && typeof b.id === "string")
        toolUseById.set(b.id, { name: String(b.name ?? "tool"), input: b.input })
    }
  }

  const pathOf = (input: any): string | undefined => {
    if (!input || typeof input !== "object") return undefined
    for (const k of ["file_path", "filePath", "path", "notebook_path"])
      if (typeof input[k] === "string" && input[k]) return input[k]
    return undefined
  }

  for (let mi = 0; mi < ccMessages.length; mi++) {
    const m = ccMessages[mi]
    const t = timeOf(m)
    const idx = m.uuid ? globalIndexByUuid.get(m.uuid) : undefined
    const c = m.message.content

    if (m.message.role === "assistant") {
      const parts: AssistantMessage["content"] = []
      if (typeof c === "string") {
        if (c.trim()) parts.push({ type: "text", text: c })
      } else {
        for (const b of c) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim())
            parts.push({ type: "text", text: b.text })
          else if (b.type === "thinking" && typeof b.thinking === "string")
            parts.push({ type: "thinking", thinking: b.thinking })
        }
        parts.push(...toolCallsOf(c))
      }
      if (parts.length === 0) continue
      out.push({ role: "assistant", content: parts, timestamp: t })
      sourceIndices.push(idx)
      ccIndices.push(mi)
      // File ops from this assistant's tool calls.
      for (const c2 of c) {
        if (c2.type !== "tool_use") continue
        const name = String(c2.name ?? "")
        const p = pathOf(c2.input)
        if (!p) continue
        if (name === "Read") fileOps.readFiles?.push(p)
        else if (name === "Edit" || name === "MultiEdit")
          fileOps.modifiedFiles?.push(p)
        else if (name === "Write") {
          fileOps.modifiedFiles?.push(p)
          fileOps.createdFiles?.push(p)
        }
      }
    } else {
      // user
      const texts: string[] = []
      const images = Array.isArray(c) ? imageParts(c) : []
      const results: ToolResultMessage[] = []
      if (typeof c === "string") texts.push(c)
      else
        for (const b of c) {
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text)
          else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            const tu = toolUseById.get(b.tool_use_id)
            const toolName = tu?.name ?? "tool"
            const isErr = b.is_error === true
            if (toolName === "Bash" || toolName === "PowerShell") {
              out.push({
                role: "bashExecution",
                command: typeof tu?.input?.command === "string" ? tu.input.command : "",
                output: textOfToolResult(b.content),
                exitCode: isErr ? 1 : 0,
                timestamp: t,
              })
              sourceIndices.push(idx)
              ccIndices.push(mi)
              continue
            }
            results.push({
              role: "toolResult",
              toolCallId: b.tool_use_id,
              toolName,
              content: [
                {
                  type: "text",
                  text: (isErr ? "Error: " : "") + textOfToolResult(b.content),
                },
              ],
              isError: isErr,
              timestamp: t,
            })
          }
        }
      const text = texts.join("\n")
      if (text.trim() || images.length > 0) {
        out.push({
          role: "user",
          content: text
            ? ([{ type: "text", text } as TextContent[]].concat(images))
            : images,
          timestamp: t,
        })
        sourceIndices.push(idx)
        ccIndices.push(mi)
      }
      for (const r of results) {
        out.push(r)
        sourceIndices.push(idx)
        ccIndices.push(mi)
      }
    }
  }

  const indexByUuid = new Map<string, number>()
  for (const m of ccMessages)
    if (m.uuid && globalIndexByUuid.has(m.uuid))
      indexByUuid.set(m.uuid, globalIndexByUuid.get(m.uuid)!)
  return { messages: out, fileOps, indexByUuid, sourceIndices, ccIndices }

}
