import { beforeEach, describe, expect, it } from 'vitest'
import {
  formatWorkspaceReferenceLocation,
  formatWorkspaceReferencePrompt,
  getAnnotationNumbers,
  useWorkspaceChatContextStore,
} from './workspaceChatContextStore'

const initialState = useWorkspaceChatContextStore.getInitialState()

describe('workspaceChatContextStore', () => {
  beforeEach(() => {
    useWorkspaceChatContextStore.setState(initialState, true)
  })

  it('deduplicates file references per session', () => {
    const store = useWorkspaceChatContextStore.getState()

    store.addReference('session-1', {
      kind: 'file',
      path: 'src/App.tsx',
      absolutePath: '/repo/src/App.tsx',
      name: 'App.tsx',
    })
    store.addReference('session-1', {
      kind: 'file',
      path: 'src/App.tsx',
      absolutePath: '/repo/src/App.tsx',
      name: 'App.tsx',
    })

    expect(useWorkspaceChatContextStore.getState().referencesBySession['session-1']).toHaveLength(1)
  })

  it('formats line comments into the request prompt', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'ref-1',
        kind: 'code-comment',
        path: 'src/App.tsx',
        absolutePath: '/repo/src/App.tsx',
        name: 'App.tsx',
        lineStart: 12,
        lineEnd: 12,
        note: 'Use a clearer name',
        quote: 'const value = 1',
      },
    ])

    expect(prompt).toContain('Referenced workspace context:')
    expect(prompt).toContain('@"src/App.tsx:L12":')
    expect(prompt).toContain('Comment: Use a clearer name')
    expect(prompt).toContain('```tsx\nconst value = 1\n```')
    expect(prompt).not.toContain('Use the Read tool')
    expect(prompt).not.toContain('Path: /repo/src/App.tsx')
  })

  it('formats diff comments with their source side while preserving ordinary locations', () => {
    const diffReference = {
      id: 'diff-ref-1',
      kind: 'code-comment' as const,
      path: 'src/a.ts',
      name: 'a.ts',
      lineStart: 11,
      lineEnd: 12,
      diffSide: 'new' as const,
      hunkId: 'hunk-1',
      note: 'Use a shared helper',
      quote: 'const result = buildResult()\nreturn result',
    }
    const ordinaryReference = {
      ...diffReference,
      id: 'ordinary-ref-1',
      diffSide: undefined,
      hunkId: undefined,
    }

    expect(formatWorkspaceReferenceLocation(diffReference)).toBe('src/a.ts:new:L11-L12')
    expect(formatWorkspaceReferencePrompt([diffReference])).toContain('src/a.ts:new:L11-L12')
    expect(formatWorkspaceReferencePrompt([diffReference])).toContain('Comment: Use a shared helper')
    expect(formatWorkspaceReferenceLocation(ordinaryReference)).toBe('src/a.ts:L11-L12')
  })

  it('deduplicates diff comments only when side and hunk also match', () => {
    const store = useWorkspaceChatContextStore.getState()
    const baseReference = {
      kind: 'code-comment' as const,
      path: 'src/a.ts',
      name: 'a.ts',
      lineStart: 11,
      lineEnd: 12,
      note: 'Use a shared helper',
      quote: 'return result',
    }

    store.addReference('session-diff', { ...baseReference, diffSide: 'new', hunkId: 'hunk-1' })
    store.addReference('session-diff', { ...baseReference, diffSide: 'new', hunkId: 'hunk-1' })
    store.addReference('session-diff', { ...baseReference, diffSide: 'old', hunkId: 'hunk-1' })
    store.addReference('session-diff', { ...baseReference, diffSide: 'new', hunkId: 'hunk-2' })

    const references = useWorkspaceChatContextStore.getState().referencesBySession['session-diff'] ?? []
    expect(references).toHaveLength(3)
    expect(new Set(references.map((reference) => reference.id))).toHaveLength(3)
  })

  it('formats selected code without requiring a comment', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'ref-1',
        kind: 'code-selection',
        path: 'src/App.tsx',
        absolutePath: '/repo/src/App.tsx',
        name: 'App.tsx',
        lineStart: 10,
        lineEnd: 12,
        quote: 'const value = 1\nreturn value',
      },
    ])

    expect(prompt).toContain('Referenced workspace context:')
    expect(prompt).toContain('@"src/App.tsx:L10-L12":')
    expect(prompt).toContain('```tsx\nconst value = 1\nreturn value\n```')
    expect(prompt).not.toContain('Comment:')
  })

  it('formats selected chat messages as chat context instead of file context', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'chat-ref-1',
        kind: 'chat-selection',
        path: 'chat://assistant/assistant-1',
        name: 'Assistant message',
        messageId: 'assistant-1',
        sourceRole: 'assistant',
        quote: 'Use the workspace panel selection menu.',
      },
    ])

    expect(prompt).toContain('Referenced chat context:')
    expect(prompt).toContain('Assistant message:')
    expect(prompt).toContain('```\nUse the workspace panel selection menu.\n```')
    expect(prompt).not.toContain('@"chat://assistant/assistant-1"')
    expect(prompt).not.toContain('Referenced workspace context:')
  })

  it('serializes an annotated chat selection as a numbered annotation with its note', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'chat-ref-1',
        kind: 'chat-selection',
        path: 'chat://assistant/assistant-1',
        name: 'Assistant message',
        messageId: 'assistant-1',
        sourceRole: 'assistant',
        quote: 'The order is reversed.',
        note: 'Move this after the user text.',
      },
    ])

    expect(prompt).toContain('Annotated chat context:')
    expect(prompt).toContain('[Annotation 1]')
    expect(prompt).toContain('[Annotation 1 end]')
    expect(prompt).toContain('The order is reversed.')
    expect(prompt).toContain('Comment: Move this after the user text.')
    expect(prompt).not.toContain('Referenced chat context:')
  })

  it('numbers multiple annotations in reference order', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'chat-ref-1', kind: 'chat-selection', path: 'chat://assistant/a', name: 'Assistant message',
        messageId: 'a', sourceRole: 'assistant', quote: 'First quote', note: 'First note',
      },
      {
        id: 'chat-ref-2', kind: 'chat-selection', path: 'chat://assistant/b', name: 'Assistant message',
        messageId: 'b', sourceRole: 'assistant', quote: 'Second quote', note: 'Second note',
      },
    ])

    expect(prompt).toContain('[Annotation 1]')
    expect(prompt).toContain('[Annotation 2]')
    expect(prompt.indexOf('First quote')).toBeLessThan(prompt.indexOf('Second quote'))
    expect(prompt.indexOf('[Annotation 1]')).toBeLessThan(prompt.indexOf('[Annotation 2]'))
  })

  it('keeps the plain chat context format byte-for-byte when no annotation has a note', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'chat-ref-1',
        kind: 'chat-selection',
        path: 'chat://assistant/assistant-1',
        name: 'Assistant message',
        messageId: 'assistant-1',
        sourceRole: 'assistant',
        quote: 'Use the workspace panel selection menu.',
      },
    ])

    expect(prompt).toBe(
      'Referenced chat context:\nAssistant message:\n```\nUse the workspace panel selection menu.\n```',
    )
  })

  it('mixes plain and annotated chat selections without disturbing either section', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'plain', kind: 'chat-selection', path: 'chat://assistant/a', name: 'Assistant message',
        messageId: 'a', sourceRole: 'assistant', quote: 'Plain quote',
      },
      {
        id: 'annotated', kind: 'chat-selection', path: 'chat://assistant/b', name: 'Assistant message',
        messageId: 'b', sourceRole: 'assistant', quote: 'Annotated quote', note: 'Do this instead',
      },
    ])

    expect(prompt).toContain('Referenced chat context:\nAssistant message:\n```\nPlain quote\n```')
    expect(prompt).toContain('Annotated chat context:')
    expect(prompt).toContain('[Annotation 1]\nAssistant message:\n```\nAnnotated quote\n```\nComment: Do this instead\n[Annotation 1 end]')
    expect(prompt.match(/\[Annotation 1\]/g)).toHaveLength(1)
  })

  it('updates an annotation note in place without changing its id or position', () => {
    const store = useWorkspaceChatContextStore.getState()
    store.addReference('session-annotate', {
      kind: 'chat-selection', path: 'chat://assistant/a', name: 'Assistant message',
      messageId: 'a', sourceRole: 'assistant', quote: 'Quote', note: 'First note',
    })
    store.addReference('session-annotate', {
      kind: 'file', path: 'src/App.tsx', name: 'App.tsx',
    })
    const [annotation, file] = useWorkspaceChatContextStore.getState().referencesBySession['session-annotate']!

    store.updateReference('session-annotate', annotation!.id, { note: 'Edited note' })

    const references = useWorkspaceChatContextStore.getState().referencesBySession['session-annotate']!
    expect(references).toHaveLength(2)
    expect(references[0]!.id).toBe(annotation!.id)
    expect(references[0]!.note).toBe('Edited note')
    expect(references[1]!.id).toBe(file!.id)
  })

  it('keeps the annotation identity stable when only its note changes', () => {
    const store = useWorkspaceChatContextStore.getState()
    const input = {
      kind: 'chat-selection' as const, path: 'chat://assistant/a', name: 'Assistant message',
      messageId: 'a', sourceRole: 'assistant' as const, quote: 'Quote', startOffset: 4, endOffset: 9,
    }
    store.addReference('session-annotate', { ...input, note: 'First note' })
    const firstId = useWorkspaceChatContextStore.getState().referencesBySession['session-annotate']![0]!.id

    store.updateReference('session-annotate', firstId, { note: 'Second note' })

    const references = useWorkspaceChatContextStore.getState().referencesBySession['session-annotate']!
    expect(references).toHaveLength(1)
    expect(references[0]!.id).toBe(firstId)
  })

  it('numbers annotations the same way the prompt does', () => {
    const references = [
      {
        id: 'plain', kind: 'chat-selection' as const, path: 'chat://assistant/a', name: 'Assistant message',
        messageId: 'a', sourceRole: 'assistant' as const, quote: 'Plain quote',
      },
      {
        id: 'first', kind: 'chat-selection' as const, path: 'chat://assistant/b', name: 'Assistant message',
        messageId: 'b', sourceRole: 'assistant' as const, quote: 'First', note: 'One',
      },
      {
        id: 'file', kind: 'file' as const, path: 'src/App.tsx', name: 'App.tsx',
      },
      {
        id: 'second', kind: 'chat-selection' as const, path: 'chat://assistant/c', name: 'Assistant message',
        messageId: 'c', sourceRole: 'assistant' as const, quote: 'Second', note: 'Two',
      },
    ]

    const numbers = getAnnotationNumbers(references)
    expect(numbers.get('first')).toBe(1)
    expect(numbers.get('second')).toBe(2)
    expect(numbers.has('plain')).toBe(false)
    expect(numbers.has('file')).toBe(false)

    // The badges in the transcript and the request's [Annotation N] blocks are
    // the same list, so their order has to come from one place.
    const prompt = formatWorkspaceReferencePrompt(references)
    expect(prompt.indexOf('First')).toBeLessThan(prompt.indexOf('Second'))
  })

  it('does not add prompt text for plain file attachments', () => {
    const prompt = formatWorkspaceReferencePrompt([
      {
        id: 'ref-1',
        kind: 'file',
        path: 'src/App.tsx',
        absolutePath: '/repo/src/App.tsx',
        name: 'App.tsx',
      },
    ])

    expect(prompt).toBe('')
  })
})
