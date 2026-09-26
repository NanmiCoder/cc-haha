// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import { closeSync, openSync, readSync } from "fs";

/**
 * Stream a JSONL file line-by-line without materializing it as one string.
 * Large sessions can exceed V8's maximum string length before parsing even
 * starts (PR #26), so every reader shares this chunked splitter.
 *
 * Calls `onLine` per line (empty lines included; callers skip them). Returns
 * false when the file does not exist — Pi does not create a new session's
 * JSONL until its first persisted entry — and rethrows other IO errors.
 */
export const forEachJsonlLine = (file: string, onLine: (line: Buffer) => void): boolean => {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }

  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending: Buffer[] = [];
  let pendingLength = 0;

  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] !== 0x0a) continue;

        const segment = chunk.subarray(start, i);
        if (pendingLength > 0) {
          pending.push(segment);
          onLine(Buffer.concat(pending, pendingLength + segment.length));
          pending = [];
          pendingLength = 0;
        } else {
          onLine(segment);
        }
        start = i + 1;
      }

      if (start < bytesRead) {
        const remainder = Buffer.from(chunk.subarray(start, bytesRead));
        pending.push(remainder);
        pendingLength += remainder.length;
      }
    }

    // JSONL files normally end with a newline, but preserve a final partial line.
    if (pendingLength > 0) onLine(Buffer.concat(pending, pendingLength));
  } finally {
    closeSync(fd);
  }
  return true;
};
