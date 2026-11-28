export const MAX_OPTIMIZE_PROMPT_LENGTH = 32_000

export type OptimizeDraft = string | { text: string; referenceEnds: number[] }

export function referenceMarkerPrefix(text: string): string {
  let prefix = '[[ref:'
  for (let suffix = 1; text.includes(prefix); suffix++) prefix = `[[ref${suffix}:`
  return prefix
}

/** Add the temporary markers only after validating the user-visible draft length. */
export function renderOptimizeDraft(draft: OptimizeDraft): string {
  if (typeof draft === 'string') return draft
  const prefix = referenceMarkerPrefix(draft.text)
  let from = 0
  let marked = ''
  for (const [index, end] of draft.referenceEnds.entries()) {
    marked += draft.text.slice(from, end) + prefix + index + ']]'
    from = end
  }
  return marked + draft.text.slice(from)
}
