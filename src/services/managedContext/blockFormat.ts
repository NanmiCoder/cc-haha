export const MANAGED_CONTEXT_BLOCK_BEGIN = '<cc-haha:managed-context>'
export const MANAGED_CONTEXT_BLOCK_END = '</cc-haha:managed-context>'

export type ManagedContextTextProjection =
  | { ok: true; text: string; hadManagedContext: boolean }
  | { ok: false }

/**
 * Project model-facing managed context back to the user-visible body.
 *
 * The block format is intentionally strict. A transcript value that starts with
 * the managed marker but is incomplete/malformed is never exposed as public
 * history/search/title/replay text: callers fail closed by dropping it.
 */
export function projectManagedContextText(text: string): ManagedContextTextProjection {
  if (!text.startsWith(MANAGED_CONTEXT_BLOCK_BEGIN)) {
    return { ok: true, text, hadManagedContext: false }
  }

  const bodyStart = MANAGED_CONTEXT_BLOCK_BEGIN.length
  if (text.slice(bodyStart, bodyStart + 1) !== '\n') return { ok: false }
  const delimiter = `\n${MANAGED_CONTEXT_BLOCK_END}\n\n`
  const blockEnd = text.indexOf(delimiter, bodyStart + 1)
  if (blockEnd < 0) return { ok: false }

  return {
    ok: true,
    text: text.slice(blockEnd + delimiter.length),
    hadManagedContext: true,
  }
}

export type ManagedContextContentProjection =
  | { ok: true; content: unknown; hadManagedContext: boolean }
  | { ok: false }

/** Public projection for transcript content (string or Anthropic text blocks). */
export function projectManagedContextContent(content: unknown): ManagedContextContentProjection {
  if (typeof content === 'string') {
    const projected = projectManagedContextText(content)
    return projected.ok
      ? { ok: true, content: projected.text, hadManagedContext: projected.hadManagedContext }
      : projected
  }
  if (!Array.isArray(content)) {
    return { ok: true, content, hadManagedContext: false }
  }

  let hadManagedContext = false
  const projectedBlocks: unknown[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      projectedBlocks.push(block)
      continue
    }
    const record = block as Record<string, unknown>
    if (record.type !== 'text' || typeof record.text !== 'string') {
      projectedBlocks.push(block)
      continue
    }
    const projected = projectManagedContextText(record.text)
    if (!projected.ok) return { ok: false }
    hadManagedContext ||= projected.hadManagedContext
    projectedBlocks.push(projected.hadManagedContext ? { ...record, text: projected.text } : block)
  }
  return { ok: true, content: projectedBlocks, hadManagedContext }
}
