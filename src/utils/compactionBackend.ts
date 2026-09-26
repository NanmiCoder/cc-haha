// Context-compaction backend selection.
//
// 'algorithm' = pi-vcc algorithmic compactor (no LLM call); 'llm' = the
// original LLM summary step. Read live at each compaction so the user can
// switch backends mid-session (hot switch). Default 'algorithm'.
export type CompactionBackend = 'algorithm' | 'llm'

export const COMPACTION_BACKENDS: readonly CompactionBackend[] = [
  'algorithm',
  'llm',
] as const

/**
 * Resolve the active compaction backend from user settings. Unknown/absent
 * values fall back to 'algorithm' (the new default), so a stale or partial
 * patch can never silently disable algorithmic compaction.
 */
export function getCompactionBackend(
  value: unknown,
): CompactionBackend {
  return value === 'llm' ? 'llm' : 'algorithm'
}
