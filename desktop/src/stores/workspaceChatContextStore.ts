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
  note?: string
  quote?: string
  sourceRole?: 'user' | 'assistant'
  messageId?: string
}

type WorkspaceChatContextStore = {
  referencesBySession: Record<string, WorkspaceChatReference[] | undefined>
  addReference: (
    sessionId: string,
    reference: Omit<WorkspaceChatReference, 'id'> & { id?: string },
  ) => void
  removeReference: (sessionId: string, referenceId: string) => void
  clearReferences: (sessionId: string) => void
  clearSession: (sessionId: string) => void
}

function makeReferenceId(reference: Omit<WorkspaceChatReference, 'id'>) {
  const linePart = reference.lineStart
    ? `${reference.lineStart}-${reference.lineEnd ?? reference.lineStart}`
    : reference.messageId ?? 'file'
  const notePart = (reference.note?.trim() || reference.quote?.trim() || '').slice(0, 48)
  return `${reference.kind}:${reference.path}:${linePart}:${notePart}`
}

function getReferenceDedupKey(reference: WorkspaceChatReference) {
  if (reference.kind === 'file') return `${reference.kind}:${reference.path}`
  return [
    reference.kind,
    reference.path,
    reference.messageId ?? '',
    reference.sourceRole ?? '',
    reference.lineStart ?? '',
    reference.lineEnd ?? '',
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
  return `${reference.path}:L${reference.lineStart}${lineEnd}`
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

export function formatWorkspaceReferencePrompt(references: WorkspaceChatReference[]) {
  const workspaceReferencesWithContext = references.filter((reference) =>
    reference.kind === 'code-comment' ||
    reference.kind === 'code-selection' ||
    !!reference.lineStart ||
    !!reference.note?.trim() ||
    !!reference.quote?.trim(),
  ).filter((reference) => reference.kind !== 'chat-selection')
  const chatReferencesWithContext = references.filter((reference) =>
    reference.kind === 'chat-selection' && !!reference.quote?.trim(),
  )
  if (workspaceReferencesWithContext.length === 0 && chatReferencesWithContext.length === 0) return ''

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

  return [...workspaceLines, ...chatLines].join('\n')
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
