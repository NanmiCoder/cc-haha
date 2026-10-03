import { describe, expect, it } from 'vitest'
import type { UIAttachment, UIMessage } from '../../types/chat'
import { formatWorkspaceReferencePrompt, type WorkspaceChatReference } from '../../stores/workspaceChatContextStore'
import {
  buildUserMessageResendPayload,
  countLaterUserTurns,
  createUserMessageEditDraft,
  type UserMessageEditDraft,
} from './userMessageEdit'

const labels = { contextReferencesOnly: (count: number) => `Added ${count} references` }

const WORKSPACE_PROMPT = [
  'Referenced workspace context:',
  '@"src/app.ts:L3-L5":',
  'Comment: why does this loop',
  '```typescript',
  'for (;;) {}',
  '```',
].join('\n')

describe('createUserMessageEditDraft', () => {
  it('edits the plain prompt of a message with nothing attached', () => {
    const draft = createUserMessageEditDraft({ content: 'Fix the login bug' })

    expect(draft).toEqual({ text: 'Fix the login bug', attachments: [], sessionReferences: [] })
  })

  it('turns the workspace reference prompt into a chip and keeps only the typed text', () => {
    // What the composer sends for a code selection: the server prefixes the
    // absolute path, then the reference block, then what the user typed.
    const draft = createUserMessageEditDraft({
      content: 'Please refactor',
      modelContent: `@"/repo/src/app.ts" ${WORKSPACE_PROMPT}\n\nPlease refactor`,
    })

    expect(draft.text).toBe('Please refactor')
    expect(draft.attachments).toEqual([
      expect.objectContaining({
        type: 'file',
        path: '/repo/src/app.ts',
        lineStart: 3,
        lineEnd: 5,
        note: 'why does this loop',
        quote: 'for (;;) {}',
        sendable: true,
      }),
    ])
  })

  it('keeps inline image data from the message and drops the generated image metadata line', () => {
    const draft = createUserMessageEditDraft({
      content: 'What is wrong here?',
      modelContent: 'What is wrong here?\n[Image source: /tmp/uploads/shot.png]',
      attachments: [{ type: 'image', name: 'shot.png', data: 'data:image/png;base64,AAAA', path: '/tmp/uploads/shot.png' }],
    })

    expect(draft.text).toBe('What is wrong here?')
    expect(draft.attachments).toEqual([
      expect.objectContaining({ type: 'image', data: 'data:image/png;base64,AAAA', sendable: true }),
    ])
  })

  it('moves the session-reference envelope out of the text', () => {
    const draft = createUserMessageEditDraft({
      content: 'Compare with that session',
      modelContent: 'Compare with that session\n\n<session_references>\nReferenced sessions:\n[{"sessionId":"session-b"}]\n</session_references>',
    })

    expect(draft.text).toBe('Compare with that session')
    expect(draft.sessionReferences).toEqual([{ sessionId: 'session-b' }])
  })

  it('does not bring back the placeholder written for an attachment-only prompt', () => {
    const draft = createUserMessageEditDraft({
      content: '',
      modelContent: '@"/repo/notes.md" Please analyze the attached files.',
    })

    expect(draft.text).toBe('')
    expect(draft.attachments).toEqual([expect.objectContaining({ type: 'file', path: '/repo/notes.md' })])
  })

  it('keeps a chat selection once, in the text the model saw, not again as a chip', () => {
    const chatBlock = 'Referenced chat context:\nAssistant message:\n```\nuse a mutex\n```'
    const draft = createUserMessageEditDraft({
      content: 'Why?',
      modelContent: `${chatBlock}\n\nWhy?`,
      attachments: [{ type: 'file', name: 'Assistant message', referenceKind: 'chat-selection', quote: 'use a mutex' }],
    })

    expect(draft.text).toBe(`${chatBlock}\n\nWhy?`)
    expect(draft.attachments).toEqual([])
  })

  it.each([false, true])('preserves distinct suffix paths from composer references (loaded: %s)', (loaded) => {
    const reference: WorkspaceChatReference = {
      id: 'root-selection', kind: 'code-selection', name: 'config.ts',
      path: 'config.ts', absolutePath: '/repo/config.ts',
      lineStart: 1, lineEnd: 1, quote: 'root config',
    }
    const referencePrompt = formatWorkspaceReferencePrompt([reference])
    // ChatInput prefixes uploads before the absolute workspace reference paths.
    // Previously the display parser consumed the upload as the selection and
    // editing permanently dropped that distinct file from the model payload.
    const liveAttachments: UIAttachment[] = [
      { type: 'file', name: 'config.ts', path: '/repo/sub/config.ts', mimeType: 'text/typescript' },
      { type: 'file', name: reference.name, path: reference.path,
        lineStart: reference.lineStart, lineEnd: reference.lineEnd, quote: reference.quote },
    ]
    const draft = createUserMessageEditDraft({
      content: 'Compare these',
      modelContent: `@"/repo/sub/config.ts" @"${reference.absolutePath}" ${referencePrompt}\n\nCompare these`,
      // The old history display parser has already omitted the wrong prefix.
      attachments: loaded
        ? [{ type: 'file', name: 'config.ts', path: '/repo/config.ts' }, liveAttachments[1]!]
        : liveAttachments,
    })
    const payload = buildUserMessageResendPayload(draft, labels)!
    expect(payload.attachments.map(attachment => attachment.path))
      .toEqual(['/repo/sub/config.ts', '/repo/config.ts'])
    expect(payload.attachments[1]).toMatchObject({ lineStart: 1, quote: 'root config' })
    if (!loaded) expect(payload.attachments[0]?.mimeType).toBe('text/typescript')
  })

  it('keeps separate selections and their original diff metadata on one file', () => {
    const references: WorkspaceChatReference[] = [
      { id: 'first', kind: 'code-comment', path: 'src/config.ts', absolutePath: '/repo/src/config.ts',
        name: 'config.ts', lineStart: 2, diffSide: 'old', hunkId: 'hunk-first', note: ' first ', quote: ' first quote ' },
      { id: 'second', kind: 'code-comment', path: 'src/config.ts', absolutePath: '/repo/src/config.ts',
        name: 'config.ts', lineStart: 8, diffSide: 'new', hunkId: 'hunk-second', quote: 'second quote' },
    ]
    const draft = createUserMessageEditDraft({
      content: 'Review',
      modelContent: `@"/repo/other/src/config.ts" @"/repo/src/config.ts" @"/repo/src/config.ts" ${formatWorkspaceReferencePrompt(references)}\n\nReview`,
      attachments: [
        { type: 'file', name: 'config.ts', path: '/repo/other/src/config.ts' },
        ...references.map((reference): UIAttachment => ({
          type: 'file', name: reference.name, path: reference.path, lineStart: reference.lineStart,
          diffSide: reference.diffSide, hunkId: reference.hunkId, note: reference.note, quote: reference.quote,
        })),
      ],
    })
    expect(draft.attachments.map(attachment => attachment.path))
      .toEqual(['/repo/other/src/config.ts', '/repo/src/config.ts', '/repo/src/config.ts'])
    expect(draft.attachments[1]).toMatchObject({ hunkId: 'hunk-first', lineStart: 2, diffSide: 'old' })
    expect(draft.attachments[2]).toMatchObject({ hunkId: 'hunk-second', lineStart: 8, diffSide: 'new' })
  })

  it('merges exact original attachment metadata instead of losing image data and directory identity', () => {
    const draft = createUserMessageEditDraft({
      content: 'Look',
      modelContent: '@"/repo/shot.png" @"/repo/assets" Look',
      attachments: [
        { type: 'image', name: 'Original screenshot', path: '/repo/shot.png', data: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
        { type: 'file', name: 'assets', path: '/repo/assets', isDirectory: true },
      ],
    })
    expect(draft.attachments).toHaveLength(2)
    expect(draft.attachments[0]).toMatchObject({ name: 'Original screenshot', data: 'data:image/png;base64,AAAA', mimeType: 'image/png' })
    expect(draft.attachments[1]).toMatchObject({ isDirectory: true })
    expect(buildUserMessageResendPayload(draft, labels)?.attachments[0])
      .toEqual({ type: 'image', name: 'Original screenshot', mimeType: 'image/png', data: 'data:image/png;base64,AAAA' })
  })

  it('marks an attachment with neither data nor a path as not sendable', () => {
    const draft = createUserMessageEditDraft({
      content: 'Summarize',
      attachments: [{ type: 'file', name: 'report.pdf' }],
    })

    expect(draft.attachments).toEqual([expect.objectContaining({ name: 'report.pdf', sendable: false })])
  })
})

describe('buildUserMessageResendPayload', () => {
  it('sends the edited text alone when nothing is attached', () => {
    const payload = buildUserMessageResendPayload(
      { text: '  Fix the signup bug  ', attachments: [], sessionReferences: [] },
      labels,
    )

    expect(payload).toEqual({
      content: 'Fix the signup bug',
      attachments: [],
      options: { displayContent: 'Fix the signup bug', displayAttachments: [] },
      droppedAttachmentCount: 0,
    })
  })

  it('rebuilds the reference prompt in front of the edited text and keeps the file attached', () => {
    const draft = createUserMessageEditDraft({
      content: 'Please refactor',
      modelContent: `@"/repo/src/app.ts" ${WORKSPACE_PROMPT}\n\nPlease refactor`,
    })
    const payload = buildUserMessageResendPayload({ ...draft, text: 'Please delete it instead' }, labels)!

    expect(payload.content).toBe(`${WORKSPACE_PROMPT.replace('src/app.ts', '/repo/src/app.ts')}\n\nPlease delete it instead`)
    expect(payload.attachments).toEqual([
      expect.objectContaining({ type: 'file', path: '/repo/src/app.ts', lineStart: 3, lineEnd: 5 }),
    ])
    expect(payload.options.displayContent).toBe('Please delete it instead')

    // The resent prompt must read back as the same draft, or a second edit of
    // the replacement would drift.
    const reread = createUserMessageEditDraft({
      content: 'Please delete it instead',
      modelContent: `@"/repo/src/app.ts" ${payload.content}`,
    })
    expect(reread.text).toBe('Please delete it instead')
    expect(reread.attachments.map(({ id: _id, ...rest }) => rest))
      .toEqual(draft.attachments.map(({ id: _id, ...rest }) => rest))
  })

  it('drops the reference prompt with its chip when the user removes it', () => {
    const draft = createUserMessageEditDraft({
      content: 'Please refactor',
      modelContent: `@"/repo/src/app.ts" ${WORKSPACE_PROMPT}\n\nPlease refactor`,
    })
    const payload = buildUserMessageResendPayload({ ...draft, attachments: [] }, labels)!

    expect(payload.content).toBe('Please refactor')
    expect(payload.attachments).toEqual([])
  })

  it('sends an image by its data and not by its upload path', () => {
    const payload = buildUserMessageResendPayload({
      text: 'Now?',
      attachments: [{ id: 'a', type: 'image', name: 'shot.png', data: 'data:image/png;base64,AAAA', path: '/tmp/shot.png', mimeType: 'image/png', sendable: true }],
      sessionReferences: [],
    }, labels)!

    expect(payload.attachments).toEqual([
      { type: 'image', name: 'shot.png', mimeType: 'image/png', data: 'data:image/png;base64,AAAA' },
    ])
  })

  it('carries session references as an option, not inside the text', () => {
    const payload = buildUserMessageResendPayload(
      { text: 'Compare', attachments: [], sessionReferences: [{ sessionId: 'session-b' }] },
      labels,
    )!

    expect(payload.content).toBe('Compare')
    expect(payload.options.sessionReferences).toEqual([{ sessionId: 'session-b' }])
  })

  it('leaves unreadable attachments out and reports how many', () => {
    const draft: UserMessageEditDraft = {
      text: '',
      attachments: [
        { id: 'a', type: 'file', name: 'gone.pdf', sendable: false },
        { id: 'b', type: 'file', name: 'notes.md', path: '/repo/notes.md', sendable: true },
      ],
      sessionReferences: [],
    }
    const payload = buildUserMessageResendPayload(draft, labels)!

    expect(payload.attachments).toEqual([expect.objectContaining({ path: '/repo/notes.md' })])
    expect(payload.options.displayContent).toBe('Added 1 references')
    expect(payload.droppedAttachmentCount).toBe(1)
  })

  it('returns nothing to send for an empty draft', () => {
    expect(buildUserMessageResendPayload({ text: '   ', attachments: [], sessionReferences: [] }, labels)).toBeNull()
    expect(buildUserMessageResendPayload({
      text: '',
      attachments: [{ id: 'a', type: 'file', name: 'gone.pdf', sendable: false }],
      sessionReferences: [],
    }, labels)).toBeNull()
  })
})

describe('countLaterUserTurns', () => {
  const user = (id: string, extra: Partial<Extract<UIMessage, { type: 'user_text' }>> = {}): UIMessage => ({
    id, type: 'user_text', content: id, timestamp: 0, ...extra,
  })
  const reply = (id: string): UIMessage => ({ id, type: 'assistant_text', content: id, timestamp: 0 })

  it('counts only the real user turns after the target', () => {
    const messages = [
      user('u1'), reply('a1'),
      user('u2'), reply('a2'),
      user('teammate', { teammateFrom: 'reviewer' }),
      user('u3'), reply('a3'),
      user('queued', { optimisticQueued: true }),
      user('pending', { pending: true }),
    ]

    expect(countLaterUserTurns(messages, 'u1')).toBe(2)
    expect(countLaterUserTurns(messages, 'u3')).toBe(0)
    expect(countLaterUserTurns(messages, 'missing')).toBe(0)
  })
})
