// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

const KEEP_TOKEN_RE = /^keep:(\d+)$/;

export interface ParsedCompactionArgs {
  followUpPrompt: string;
  keepUserTurns: number | null;
  keepUserTurnsExplicit: boolean;
}

const parseKeepUserTurns = (raw: string): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
};

export const parseKeepAndPrompt = (args?: string): ParsedCompactionArgs => {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return { followUpPrompt: "", keepUserTurns: null, keepUserTurnsExplicit: false };

  const startMatch = trimmed.match(/^keep:(\d+)(?:\s+|$)([\s\S]*)$/);
  if (startMatch) {
    return {
      followUpPrompt: startMatch[2].trim(),
      keepUserTurns: parseKeepUserTurns(startMatch[1]),
      keepUserTurnsExplicit: true,
    };
  }

  const parts = trimmed.split(/\s+/);
  const endMatch = parts[parts.length - 1].match(KEEP_TOKEN_RE);
  if (endMatch) {
    return {
      followUpPrompt: trimmed.slice(0, trimmed.length - parts[parts.length - 1].length).trim(),
      keepUserTurns: parseKeepUserTurns(endMatch[1]),
      keepUserTurnsExplicit: true,
    };
  }

  return { followUpPrompt: trimmed, keepUserTurns: null, keepUserTurnsExplicit: false };
};

export const buildPiVccCustomInstructions = (keepUserTurns: number | null): string => {
  if (keepUserTurns == null) return PI_VCC_COMPACT_INSTRUCTION;
  return `${PI_VCC_COMPACT_INSTRUCTION} keep:${keepUserTurns}`;
};
