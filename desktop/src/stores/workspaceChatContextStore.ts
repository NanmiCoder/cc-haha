import { create } from 'zustand'

export type WorkspaceChatReferenceKind = 'file' | 'code-comment' | 'code-selection' | 'chat-selection'

export type WorkspaceChatReference = {
  id: string
  kind: WorkspaceChatReferenceKind
  path: string
  absolutePath?: string
  name: string
  isDirectory?: boolean
  lineStart?: number
  lineEnd?: number
  diffSide?: 'old' | 'new'
  hunkId?: string
  note?: string
  quote?: string
  sourceRole?: 'user' | 'assistant'
  messageId?: string
  // Character offsets of `quote` inside the source message's concatenated text.
  // They let the transcript paint the annotation back onto the exact span the
  // user selected instead of searching for the text again.
  startOffset?: number
  endOffset?: number
}

type WorkspaceChatContextStore = {
  referencesBySession: Record<string, WorkspaceChatReference[] | undefined>
  addReference: (
    sessionId: string,
    reference: Omit<WorkspaceChatReference, 'id'> & { id?: string },
  ) => void
  updateReference: (
    sessionId: string,
    referenceId: string,
    patch: Partial<Omit<WorkspaceChatReference, 'id'>>,
  ) => void
  removeReference: (sessionId: string, referenceId: string) => void
  clearReferences: (sessionId: string) => void
  clearSession: (sessionId: string) => void
}

/**
 * A chat selection is identified by the span it covers, not by its note: the
 * user edits one annotation in place, and re-annotating the same span replaces
 * it instead of stacking a duplicate. Offsets are exact; the quote is the
 * fallback for selections captured before offsets were recorded.
 */
function getChatSelectionAnchor(reference: Omit<WorkspaceChatReference, 'id'>) {
  if (reference.startOffset !== undefined && reference.endOffset !== undefined) {
    return `${reference.startOffset}-${reference.endOffset}`
  }
  return reference.quote?.trim() ?? ''
}

function makeReferenceId(reference: Omit<WorkspaceChatReference, 'id'>) {
  if (reference.kind === 'chat-selection') {
    return `chat-selection:${reference.path}:${getChatSelectionAnchor(reference)}`
  }
  const linePart = reference.lineStart
    ? `${reference.lineStart}-${reference.lineEnd ?? reference.lineStart}`
    : reference.messageId ?? 'file'
  const notePart = (reference.note?.trim() || reference.quote?.trim() || '').slice(0, 48)
  const diffPart = reference.kind === 'code-comment'
    ? `${reference.diffSide ?? ''}:${reference.hunkId ?? ''}:`
    : ''
  return `${reference.kind}:${reference.path}:${diffPart}${linePart}:${notePart}`
}

function getReferenceDedupKey(reference: WorkspaceChatReference) {
  if (reference.kind === 'file') return `${reference.kind}:${reference.path}`
  if (reference.kind === 'chat-selection') {
    return `${reference.kind}:${reference.path}:${getChatSelectionAnchor(reference)}`
  }
  return [
    reference.kind,
    reference.path,
    reference.messageId ?? '',
    reference.sourceRole ?? '',
    reference.lineStart ?? '',
    reference.lineEnd ?? '',
    reference.kind === 'code-comment' ? reference.diffSide ?? '' : '',
    reference.kind === 'code-comment' ? reference.hunkId ?? '' : '',
    reference.note?.trim() ?? '',
    reference.quote?.trim() ?? '',
  ].join(':')
}

export function formatWorkspaceReferenceLocation(reference: WorkspaceChatReference) {
  if (reference.kind === 'chat-selection') {
    return reference.sourceRole === 'assistant' ? 'Assistant message' : 'User message'
  }
  if (!reference.lineStart) return reference.path
  const lineEnd = reference.lineEnd && reference.lineEnd !== reference.lineStart
    ? `-L${reference.lineEnd}`
    : ''
  const side = reference.diffSide ? `:${reference.diffSide}` : ''
  return `${reference.path}${side}:L${reference.lineStart}${lineEnd}`
}

function getFenceForQuote(quote: string) {
  const runs = quote.match(/`+/g) ?? []
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function getLanguageHint(reference: WorkspaceChatReference) {
  if (reference.kind === 'chat-selection') return ''
  const extension = reference.name.split('.').pop()?.toLowerCase()
  if (!extension || extension === reference.name.toLowerCase()) return ''
  const aliases: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'bash',
    yml: 'yaml',
  }
  return aliases[extension] ?? extension
}

/**
 * 1-based numbers for the annotated chat selections, in the order they are sent.
 *
 * The transcript badges, the composer chips and the request's `[Annotation N]`
 * blocks are the same list, so the number has to come from one place — a second
 * implementation would drift the moment either side changed.
 */
export function getAnnotationNumbers(
  references: WorkspaceChatReference[] | undefined,
): Map<string, number> {
  const numbers = new Map<string, number>()
  let next = 1
  for (const reference of references ?? []) {
    if (reference.kind === 'chat-selection' && reference.note?.trim()) {
      numbers.set(reference.id, next)
      next += 1
    }
  }
  return numbers
}

export function formatWorkspaceReferencePrompt(references: WorkspaceChatReference[]) {  const workspaceReferencesWithContext = references.filter((reference) =>
    reference.kind === 'code-comment' ||
    reference.kind === 'code-selection' ||
    !!reference.lineStart ||
    !!reference.note?.trim() ||
    !!reference.quote?.trim(),
  ).filter((reference) => reference.kind !== 'chat-selection')
  const chatReferencesWithContext = references.filter((reference) =>
    reference.kind === 'chat-selection' && !!reference.quote?.trim() && !reference.note?.trim(),
  )
  // A chat selection carrying a note is an annotation: it gets its own numbered
  // section so the numbering the user sees on the transcript badges maps onto
  // the request. Keeping it separate is also what leaves the plain chat-context
  // block above byte-for-byte identical to what it was before annotations.
  const annotatedReferences = references.filter((reference) =>
    reference.kind === 'chat-selection' && !!reference.note?.trim(),
  )
  if (
    workspaceReferencesWithContext.length === 0 &&
    chatReferencesWithContext.length === 0 &&
    annotatedReferences.length === 0
  ) return ''

  const workspaceLines = workspaceReferencesWithContext.length > 0
    ? [
        'Referenced workspace context:',
        ...workspaceReferencesWithContext.map((reference) => {
          const location = formatWorkspaceReferenceLocation(reference)
          const parts = [`@"${location}":`]
          if (reference.note?.trim()) parts.push(`Comment: ${reference.note.trim()}`)
          if (reference.quote?.trim()) {
            const fence = getFenceForQuote(reference.quote)
            const languageHint = getLanguageHint(reference)
            parts.push(`${fence}${languageHint}`)
            parts.push(reference.quote.trim())
            parts.push(fence)
          }
          return parts.join('\n')
        }),
      ]
    : []
  const chatLines = chatReferencesWithContext.length > 0
    ? [
        'Referenced chat context:',
        ...chatReferencesWithContext.map((reference) => {
      const location = formatWorkspaceReferenceLocation(reference)
          const fence = getFenceForQuote(reference.quote ?? '')
          return [
            `${location}:`,
            fence,
            reference.quote?.trim() ?? '',
            fence,
          ].join('\n')
        }),
      ]
    : []

  const annotationLines = annotatedReferences.length > 0
    ? [
        'Annotated chat context:',
        ...annotatedReferences.flatMap((reference, index) => {
          const number = index + 1
          const lines = [`[Annotation ${number}]`]
          lines.push(`${formatWorkspaceReferenceLocation(reference)}:`)
          if (reference.quote?.trim()) {
            const fence = getFenceForQuote(reference.quote)
            lines.push(fence, reference.quote.trim(), fence)
          }
          lines.push(`Comment: ${reference.note!.trim()}`)
          lines.push(`[Annotation ${number} end]`)
          return lines
        }),
      ]
    : []

  return [...workspaceLines, ...chatLines, ...annotationLines].join('\n')
}

export const useWorkspaceChatContextStore = create<WorkspaceChatContextStore>((set) => ({
  referencesBySession: {},

  addReference: (sessionId, input) =>
    set((state) => {
      const reference: WorkspaceChatReference = {
        ...input,
        id: input.id ?? makeReferenceId(input),
      }
      const existing = state.referencesBySession[sessionId] ?? []
      const nextKey = getReferenceDedupKey(reference)
      const withoutDuplicate = existing.filter((item) => getReferenceDedupKey(item) !== nextKey)

      return {
        referencesBySession: {
          ...state.referencesBySession,
          [sessionId]: [...withoutDuplicate, reference],
        },
      }
    }),

  updateReference: (sessionId, referenceId, patch) =>
    set((state) => {
      const existing = state.referencesBySession[sessionId]
      if (!existing?.some((reference) => reference.id === referenceId)) return state
      return {
        referencesBySession: {
          ...state.referencesBySession,
          [sessionId]: existing.map((reference) =>
            reference.id === referenceId ? { ...reference, ...patch } : reference,
          ),
        },
      }
    }),

  removeReference: (sessionId, referenceId) =>
    set((state) => {
      const existing = state.referencesBySession[sessionId] ?? []
      return {
        referencesBySession: {
          ...state.referencesBySession,
          [sessionId]: existing.filter((reference) => reference.id !== referenceId),
        },
      }
    }),

  clearReferences: (sessionId) =>
    set((state) => ({
      referencesBySession: {
        ...state.referencesBySession,
        [sessionId]: [],
      },
    })),

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.referencesBySession)) return state
      const { [sessionId]: _removed, ...rest } = state.referencesBySession
      return { referencesBySession: rest }
    }),
}))
