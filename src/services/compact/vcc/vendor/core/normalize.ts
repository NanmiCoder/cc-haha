// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import type { Message } from "../../pi-ai";
import type { NormalizedBlock } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

const normalizeOne = (msg: Message, msgIndex: number | undefined): NormalizedBlock[] => {
  if (msg.role === "user") {
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(msg.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  if (msg.role === "bashExecution") {
    const cmd = (msg as any).command ?? "";
    const out = (msg as any).output ?? "";
    const exit = (msg as any).exitCode;
    return [{ kind: "bash", command: cmd, output: out, exitCode: exit, sourceIndex: msgIndex }];
  }

  if (msg.role === "toolResult") {
    return [{
      kind: "tool_result",
      name: msg.toolName,
      text: sanitize(textOf(msg.content)),
      sourceIndex: msgIndex,
    }];
  }

  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [{ kind: "assistant", text: sanitize(msg.content), sourceIndex: msgIndex }];
    }

    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex: msgIndex });
      } else if (part.type === "toolCall") {
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args: part.arguments,
          sourceIndex: msgIndex,
        });
      }
    }
    return blocks;
  }

  return [];
};

/**
 * Normalize messages to blocks. `sourceIndices`, when provided, supplies the
 * session-global `#N` index per input position (see src/core/global-indices.ts).
 * A missing entry yields `sourceIndex: undefined`, which downstream renderers
 * display as no ref — never a window-relative number. Omitted entirely, the
 * legacy positional behavior is preserved (used by callers/tests that have no
 * index space to map into).
 */
export const normalize = (
  messages: Message[],
  sourceIndices?: Array<number | undefined>,
): NormalizedBlock[] =>
  messages.flatMap((msg, i) => normalizeOne(msg, sourceIndices ? sourceIndices[i] : i));


