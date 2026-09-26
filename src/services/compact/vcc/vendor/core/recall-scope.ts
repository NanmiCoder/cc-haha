// Vendored from @sting8k/pi-vcc@0.8.0 (MIT). Do not edit by hand.
// @ts-nocheck
export type RecallScope = "lineage" | "all";
export type RecallMode = "hybrid" | "touched";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;

const VALID_MODES = new Set(["hybrid", "touched"]);

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
  typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

/**
 * Normalize a mode param to a supported recall mode. Without OM integration,
 * only "touched" adds behavior beyond the default hybrid search — "file"-only
 * search is not implemented in pi-vcc, so it is not exposed.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const normalizeRecallMode = (mode?: unknown): RecallMode =>
  typeof mode === "string" && VALID_MODES.has(mode.toLowerCase())
    ? (mode.toLowerCase() as RecallMode)
    : "hybrid";

export const parseRecallScope = (text: string): { scope: RecallScope; text: string } => {
  const match = text.match(SCOPE_RE);
  return {
    scope: normalizeRecallScope(match?.[1]),
    text: text.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim(),
  };
};
