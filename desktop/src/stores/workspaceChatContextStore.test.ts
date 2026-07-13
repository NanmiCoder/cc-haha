import { beforeEach, describe, expect, it } from 'vitest'
import {
  formatWorkspaceReferenceLocation,
  formatWorkspaceReferencePrompt,
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
