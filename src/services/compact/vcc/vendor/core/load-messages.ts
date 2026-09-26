// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import type { Message } from "../../pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { forEachJsonlLine } from "./jsonl";
import { isCountedMessageEntry } from "./global-indices";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages => {
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  let messageIndex = 0;

  const processLine = (line: Buffer) => {
    if (line.length === 0) return;
    let entry: any;
    try { entry = JSON.parse(line.toString("utf8")); } catch { return; }
    // Counting rule shared with src/core/global-indices.ts — both index
    // spaces must agree by construction.
    if (!isCountedMessageEntry(entry)) return;

    const allowed = !allowedEntryIds || allowedEntryIds.has(entry.id);
    if (allowed) {
      rendered.push(renderMessage(entry.message, messageIndex, full));
      rawMessages.push(entry.message);
    }
    messageIndex++;
  };

  // Streamed via forEachJsonlLine: large sessions can exceed V8's maximum
  // string length before parsing even starts. A missing file yields an empty
  // result — Pi does not create a new session's JSONL until its first
  // persisted entry.
  forEachJsonlLine(sessionFile, processLine);

  return { rendered, rawMessages };
};
