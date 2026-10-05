import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionsApi, type SessionRewindResponse } from '@/api/sessions'
import { useChatStore, type PerSessionState } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import type { UIMessage } from '@/types/chat'
import type { TranslationKey } from '@/i18n/locales/en'
import { useUserMessageEditResend, type EditableTurnCard } from './useUserMessageEditResend'
import type { UserMessageEditDraft } from './userMessageEdit'

const messages: UIMessage[] = [
  { id: 'shared-user', type: 'user_text', content: 'continue', timestamp: 1 },
  { id: 'reply', type: 'assistant_text', content: 'Done', timestamp: 2 },
]
const draft: UserMessageEditDraft = { text: 'edited prompt', attachments: [], sessionReferences: [] }
const target = { targetUserMessageId: 'shared-user', userMessageIndex: 0, userMessageCount: 1 }
const preview: SessionRewindResponse = {
  target, conversation: { messagesRemoved: 2 },
  code: { available: false, filesChanged: [], insertions: 0, deletions: 0 },
}
const codePreview: SessionRewindResponse = { ...preview, code: { available: true, filesChanged: ['app.ts'], insertions: 1, deletions: 0 } }
const translate = (key: TranslationKey) => key

function makeSession(): PerSessionState {
  return {
    messages, chatState: 'idle', connectionState: 'connected', historyStatus: 'ready', historyHydrated: true,
    streamingText: '', streamingToolInput: '', activeToolUseId: null, activeToolName: null, activeThinkingId: null,
    pendingPermission: null, pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 }, streamingResponseChars: 0, elapsedSeconds: 0,
    statusVerb: '', apiRetry: null, slashCommands: [], agentTaskNotifications: {}, elapsedTimer: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

const card: EditableTurnCard = { target: { messageId: 'shared-user', expectedContent: 'continue' }, checkpoint: { target } }
const completed = new Set(['shared-user'])

type Availability = {
  turnCards: EditableTurnCard[]
  blockedReason: string | null
  pendingReason: string | null
}

function setup(availability: Partial<Availability> = {}) {
  const setRewindingTurnId = vi.fn()
  return renderHook((props: { sessionId: string } & Partial<Availability>) => useUserMessageEditResend({
    sessionId: props.sessionId,
    messages,
    turnCards: props.turnCards ?? [card],
    completedMessageIds: completed,
    blockedReason: props.blockedReason ?? null,
    pendingReason: props.pendingReason ?? null,
    disabled: false, rewindingTurnId: null, setRewindingTurnId, t: translate,
  }), { initialProps: { sessionId: 'session-a', ...availability } })
}

describe('useUserMessageEditResend session and recovery boundaries', () => {
  beforeEach(() => {
    useChatStore.setState({ ...useChatStore.getInitialState(), sessions: { 'session-a': makeSession(), 'session-b': makeSession() } }, true)
    useUIStore.setState({ toasts: [] })
    vi.spyOn(sessionsApi, 'rewind').mockResolvedValue(preview)
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(() => {})
  })

  afterEach(() => { vi.restoreAllMocks() })

  it.each([preview, codePreview])('ignores a pending preview after switching session instead of rewinding either session', async (response) => {
    const pending = deferred<SessionRewindResponse>()
    vi.mocked(sessionsApi.rewind).mockReturnValueOnce(pending.promise)
    const { result, rerender } = setup()
    act(() => result.current.editActionByMessageId.get('shared-user')!.onSubmit(draft))
    rerender({ sessionId: 'session-b' })
    await act(async () => { pending.resolve(response) })
    expect(result.current.dialog.open).toBe(false)
    expect(sessionsApi.rewind).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled()
  })

  it('rejects a captured editor submit action after switching session', async () => {
    const { result, rerender } = setup()
    const submitOld = result.current.editActionByMessageId.get('shared-user')!.onSubmit
    rerender({ sessionId: 'session-b' })
    await act(async () => submitOld(draft))
    expect(sessionsApi.rewind).not.toHaveBeenCalled()
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled()
  })

  it('ignores a stale preview even after switching back to its original session', async () => {
    const pending = deferred<SessionRewindResponse>()
    vi.mocked(sessionsApi.rewind).mockReturnValueOnce(pending.promise)
    const { result, rerender } = setup()
    act(() => result.current.editActionByMessageId.get('shared-user')!.onSubmit(draft))
    rerender({ sessionId: 'session-b' })
    rerender({ sessionId: 'session-a' })
    await act(async () => { pending.resolve(codePreview) })
    expect(result.current.dialog.open).toBe(false)
    expect(sessionsApi.rewind).toHaveBeenCalledTimes(1)
  })

  it('hides the old dialog and rejects its captured action after switching session', async () => {
    vi.mocked(sessionsApi.rewind).mockResolvedValue(codePreview)
    const { result, rerender } = setup()
    await act(async () => result.current.editActionByMessageId.get('shared-user')!.onSubmit(draft))
    expect(result.current.dialog.open).toBe(true)
    const confirmOld = result.current.dialog.actions[1]!.onClick
    rerender({ sessionId: 'session-b' })
    expect(result.current.dialog.open).toBe(false)
    await act(async () => confirmOld())
    expect(sessionsApi.rewind).toHaveBeenCalledTimes(1)
  })

  it('finishes an already committed rewind in its original session after navigation', async () => {
    const pending = deferred<SessionRewindResponse>()
    vi.mocked(sessionsApi.rewind).mockResolvedValueOnce(preview).mockReturnValueOnce(pending.promise)
    const reload = vi.spyOn(useChatStore.getState(), 'reloadHistory').mockResolvedValue(undefined)
    const { result, rerender } = setup()
    act(() => result.current.editActionByMessageId.get('shared-user')!.onSubmit(draft))
    await waitFor(() => expect(sessionsApi.rewind).toHaveBeenCalledTimes(2))
    rerender({ sessionId: 'session-b' })
    await act(async () => { pending.resolve(preview) })
    expect(reload).toHaveBeenCalledWith('session-a', expect.objectContaining({ messages }), { requireApplied: true })
    expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith('session-a', draft.text, [], expect.any(Object))
  })

  it('recovers the draft when its source tab closes during the committed rewind', async () => {
    vi.spyOn(sessionsApi, 'getFullHistory').mockResolvedValue({ messages: [] })
    const pending = deferred<SessionRewindResponse>()
    vi.mocked(sessionsApi.rewind).mockResolvedValueOnce(preview).mockReturnValueOnce(pending.promise)
    const withContext: UserMessageEditDraft = {
      ...draft,
      attachments: [{ id: 'file', type: 'file', name: 'app.ts', path: '/repo/app.ts', lineStart: 3, quote: 'value', sendable: true }],
      sessionReferences: [{ sessionId: 'referenced-session' }],
    }
    const { result, unmount } = setup()
    act(() => result.current.editActionByMessageId.get('shared-user')!.onSubmit(withContext))
    await waitFor(() => expect(sessionsApi.rewind).toHaveBeenCalledTimes(2))
    act(() => useChatStore.getState().disconnectSession('session-a'))
    unmount()
    await act(async () => { pending.resolve(preview) })
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions['session-a']?.composerPrefill).toMatchObject({
      text: draft.text, attachments: withContext.attachments, sessionReferences: withContext.sessionReferences,
    })
    expect(useChatStore.getState().sessions['session-b']?.composerPrefill).toBeUndefined()
  })

  it('isolates drafts in branched sessions that share a transcript message id', () => {
    const { result, rerender } = setup()
    act(() => {
      const action = result.current.editActionByMessageId.get('shared-user')!
      action.onStart()
      action.onDraftChange(draft)
    })
    rerender({ sessionId: 'session-b' })
    expect(result.current.editActionByMessageId.get('shared-user')!.editing).toBe(false)
    expect(result.current.editActionByMessageId.get('shared-user')!.getDraft().text).toBe('continue')
    rerender({ sessionId: 'session-a' })
    expect(result.current.editActionByMessageId.get('shared-user')!.getDraft().text).toBe(draft.text)
  })

  it('hands the complete draft to the composer when the real history reload fails', async () => {
    vi.spyOn(sessionsApi, 'getFullHistory').mockRejectedValue(new Error('history offline'))
    const withContext: UserMessageEditDraft = {
      ...draft,
      attachments: [{ id: 'file', type: 'file', name: 'app.ts', path: '/repo/app.ts', lineStart: 3, lineEnd: 5, quote: 'for (;;) {}', sendable: true }],
      sessionReferences: [{ sessionId: 'referenced-session' }],
    }
    const { result } = setup()
    await act(async () => result.current.editActionByMessageId.get('shared-user')!.onSubmit(withContext))
    expect(useChatStore.getState().sendMessage).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions['session-a']!.composerPrefill).toMatchObject({
      text: draft.text, attachments: withContext.attachments, sessionReferences: withContext.sessionReferences,
    })
    expect(useUIStore.getState().toasts).toContainEqual(expect.objectContaining({ type: 'warning' }))
  })

  it('ignores a failed preview after the editor unmounts', async () => {
    const pending = deferred<SessionRewindResponse>()
    vi.mocked(sessionsApi.rewind).mockReturnValueOnce(pending.promise)
    const { result, unmount } = setup()
    act(() => result.current.editActionByMessageId.get('shared-user')!.onSubmit(draft))
    unmount()
    await act(async () => { pending.reject(new Error('late failure')) })
    expect(useUIStore.getState().toasts).toEqual([])
    expect(sessionsApi.rewind).toHaveBeenCalledTimes(1)
  })

  // The action used to vanish whenever an edit could not start, which read as
  // the feature being gone. It now stays, disabled, and says why.
  describe('availability', () => {
    type Result = ReturnType<typeof setup>['result']
    const actionOf = (result: Result) => result.current.editActionByMessageId.get('shared-user')

    it('keeps a blocked prompt visible with the reason, refuses its submit, and re-enables it once unblocked', async () => {
      const { result, rerender } = setup({ blockedReason: 'Wait for background tasks' })
      expect(actionOf(result)).toMatchObject({ disabled: true, disabledReason: 'Wait for background tasks' })
      await act(async () => actionOf(result)!.onSubmit(draft))
      expect(sessionsApi.rewind).not.toHaveBeenCalled()

      rerender({ sessionId: 'session-a' })
      expect(actionOf(result)).toMatchObject({ disabled: false })
      expect(actionOf(result)!.disabledReason).toBeUndefined()
    })

    it('reports the block before a missing rewind target', () => {
      const { result } = setup({ turnCards: [], blockedReason: 'Wait for this turn', pendingReason: 'Checking' })
      expect(actionOf(result)).toMatchObject({ disabled: true, disabledReason: 'Wait for this turn' })
    })

    it('says a prompt is being checked until its own target arrives', () => {
      const { result, rerender } = setup({ turnCards: [], pendingReason: 'Checking' })
      expect(actionOf(result)).toMatchObject({ disabled: true, disabledReason: 'Checking' })
      // Other prompts may still be loading; this one already has its target.
      rerender({ sessionId: 'session-a', turnCards: [card], pendingReason: 'Checking' })
      expect(actionOf(result)).toMatchObject({ disabled: false })
      expect(actionOf(result)!.disabledReason).toBeUndefined()
    })

    it('offers nothing once the settled targets leave the prompt out', () => {
      const { result } = setup({ turnCards: [] })
      expect(actionOf(result)).toBeUndefined()
    })

    it('keeps an open editor and its draft while background work blocks the edit', () => {
      const { result, rerender } = setup()
      act(() => {
        actionOf(result)!.onStart()
        actionOf(result)!.onDraftChange(draft)
      })
      // Running background tasks also withhold the turn cards.
      rerender({ sessionId: 'session-a', turnCards: [], blockedReason: 'Wait for background tasks' })
      expect(actionOf(result)).toMatchObject({ editing: true, disabled: true, disabledReason: 'Wait for background tasks' })
      expect(actionOf(result)!.getDraft().text).toBe(draft.text)
    })

    it('never offers the files back for a conversation-only target, whatever the dry run finds', async () => {
      vi.mocked(sessionsApi.rewind).mockResolvedValue(codePreview)
      vi.spyOn(useChatStore.getState(), 'reloadHistory').mockResolvedValue(undefined)
      const { result } = setup({ turnCards: [{ ...card, conversationOnly: true }] })
      await act(async () => actionOf(result)!.onSubmit(draft))
      await waitFor(() => expect(sessionsApi.rewind).toHaveBeenCalledTimes(2))
      expect(sessionsApi.rewind).toHaveBeenLastCalledWith('session-a', expect.objectContaining({ mode: 'conversation' }))
      expect(result.current.dialog.open).toBe(false)
      await waitFor(() => expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith('session-a', draft.text, [], expect.any(Object)))
    })
  })
})
