// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
import type { NormalizedBlock } from "../types";

const NOISE_TOOLS = new Set([
  "TodoWrite", "TodoRead", "ToolSearch", "WebSearch",
  "AskUser", "ExitSpecMode", "GenerateDroid",
]);

const NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet.",
];

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

const isNoiseUserBlock = (text: string): boolean => {
  const trimmed = text.trim();
  if (NOISE_STRINGS.some((s) => trimmed.includes(s))) return true;
  const stripped = trimmed.replace(XML_WRAPPER_RE, "").trim();
  return stripped.length === 0;
};

const cleanUserText = (text: string): string =>
  text.replace(XML_WRAPPER_RE, "").trim();

export const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => {
  const out: NormalizedBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "user") {
      if (isNoiseUserBlock(b.text)) continue;
      const cleaned = cleanUserText(b.text);
      if (!cleaned) continue;
      out.push({ kind: "user", text: cleaned });
      continue;
    }
    out.push(b);
  }
  return out;
};
