import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PromptOptimizeButton } from './PromptOptimizeButton'
import { isOptimizablePrompt, usePromptOptimize, type PromptOptimizeController } from './usePromptOptimize'
import { reconcileMentionsAfterRewrite, type ComposerMention } from '@/lib/composerMentions'
import { sessionsApi } from '@/api/sessions'
import { useUIStore } from '@/stores/uiStore'
import { MentionComposer, getComposerViewForTesting, type MentionComposerHandle } from './MentionComposer'
import { undo } from 'prosemirror-history'
import { useRef, useState } from 'react'

vi.mock('@/api/sessions', () => ({
  sessionsApi: {
    optimizePrompt: vi.fn(),
    cancelOptimizePrompt: vi.fn().mockResolvedValue({ requestId: 'req', cancelled: true }),
  },
}))

const mockOptimizePrompt = vi.mocked(sessionsApi.optimizePrompt)
const mockCancelOptimizePrompt = vi.mocked(sessionsApi.cancelOptimizePrompt)

function makeController(overrides: Partial<PromptOptimizeController> = {}): PromptOptimizeController {
  return {
    isOptimizing: false,
    restoreSnapshot: null,
    optimize: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    restore: vi.fn(),
    dismissRestore: vi.fn(),
    notifyDraftChanged: vi.fn(),
    ...overrides,
  }
}

function ComposerOptimizeHarness({
  sessionId = 'session-1',
  initialText = '',
  initialMentions = [],
  disabled = false,
}: {
  sessionId?: string | null
  initialText?: string
  initialMentions?: ComposerMention[]
  disabled?: boolean
}) {
  const [text, setText] = useState(initialText)
  const [mentions, setMentions] = useState<ComposerMention[]>(initialMentions)
  const textRef = useRef(text)
  const mentionsRef = useRef(mentions)
  textRef.current = text
  mentionsRef.current = mentions
  const composerRef = useRef<MentionComposerHandle>(null)

  const controller = usePromptOptimize({
    sessionId,
    disabled,
    getDraft: () => ({ text: textRef.current, mentions: mentionsRef.current }),
    applyDraft: (nextText, nextMentions, options) => {
      composerRef.current?.replaceContentWithHistory(nextText, nextMentions, options)
    },
  })

  return (
    <div>
      <MentionComposer
        ref={composerRef}
        value={text}
        mentions={mentions}
        onChange={(nextText, nextMentions) => {
          textRef.current = nextText
          mentionsRef.current = nextMentions
          setText(nextText)
          setMentions(nextMentions)
          controller.notifyDraftChanged()
        }}
      />
      <PromptOptimizeButton
        controller={controller}
        canOptimize={!disabled && isOptimizablePrompt(text)}
      />
      <output data-testid="draft-value">{text}</output>
      <output data-testid="mentions-count">{mentions.length}</output>
      <output data-testid="model-content">{composerRef.current?.getModelContent() ?? ''}</output>
    </div>
  )
}

describe('reconcileMentionsAfterRewrite', () => {
  it('preserves surviving mention pills even when the rewrite reorders them', () => {
    const mentions: ComposerMention[] = [
      { label: 'a.ts', path: '/repo/a.ts', isDirectory: false, tokenOrdinal: 0 },
      { label: 'b.ts', path: '/repo/b.ts', isDirectory: false, tokenOrdinal: 0 },
    ]
    const reconciled = reconcileMentionsAfterRewrite(
      'First inspect @b.ts and then update @a.ts accordingly.',
      mentions,
    )
    expect(reconciled.map(m => m.label)).toEqual(['b.ts', 'a.ts'])
    expect(reconciled.map(m => m.path)).toEqual(['/repo/b.ts', '/repo/a.ts'])
    expect(reconciled.map(m => m.tokenOrdinal)).toEqual([0, 0])
  })

  it('drops mentions whose tokens were removed without breaking remaining pills', () => {
    const mentions: ComposerMention[] = [
      { label: 'gone.ts', path: '/repo/gone.ts', isDirectory: false, tokenOrdinal: 0 },
      { label: 'kept.ts', path: '/repo/kept.ts', isDirectory: false, tokenOrdinal: 0 },
    ]
    const reconciled = reconcileMentionsAfterRewrite('Update @kept.ts', mentions)
    expect(reconciled).toEqual([
      { label: 'kept.ts', path: '/repo/kept.ts', isDirectory: false, tokenOrdinal: 0 },
    ])
  })
})

describe('PromptOptimizeButton', () => {
  beforeEach(() => {
    mockOptimizePrompt.mockReset()
    mockCancelOptimizePrompt.mockReset()
    mockCancelOptimizePrompt.mockResolvedValue({ requestId: 'req', cancelled: true })
    useUIStore.setState({ toasts: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders a named disabled button when empty on desktop and hides on mobile when empty', () => {
    const { rerender } = render(
      <PromptOptimizeButton controller={makeController()} canOptimize={false} mobile={false} />,
    )
    const desktopButton = screen.getByRole('button', { name: 'Optimize prompt' })
    expect(desktopButton).toBeDisabled()

    rerender(<PromptOptimizeButton controller={makeController()} canOptimize={false} mobile />)
    expect(screen.queryByRole('button', { name: 'Optimize prompt' })).not.toBeInTheDocument()

    rerender(<PromptOptimizeButton controller={makeController()} canOptimize mobile />)
    expect(screen.getByRole('button', { name: 'Optimize prompt' })).toHaveClass('h-11', 'w-11')
  })

  it('optimizes the prompt, preserves @mentions, supports one-click Restore and ProseMirror Cmd+Z undo', async () => {
    const fileMention: ComposerMention = {
      label: 'ChatInput.tsx',
      path: '/repo/desktop/src/components/chat/ChatInput.tsx',
      isDirectory: false,
      tokenOrdinal: 0,
    }
    mockOptimizePrompt.mockResolvedValueOnce({
      requestId: 'req-1',
      optimizedPrompt: 'Inspect @ChatInput.tsx toolbar layout and add a prompt optimization button with regression tests.',
    })

    const { container } = render(
      <ComposerOptimizeHarness
        initialText="check @ChatInput.tsx add button"
        initialMentions={[fileMention]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))

    await waitFor(() => {
      expect(screen.getByTestId('draft-value')).toHaveTextContent(
        'Inspect @ChatInput.tsx toolbar layout and add a prompt optimization button with regression tests.',
      )
    })
    expect(mockOptimizePrompt).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('mentions-count')).toHaveTextContent('1')
    expect(screen.getByTestId('prompt-optimize-notice')).toHaveTextContent('Prompt optimized')

    // Native ProseMirror undo reverts the optimization in a single step.
    const editorEl = container.querySelector<HTMLElement>('[data-composer-editor]')
    const view = getComposerViewForTesting(editorEl)
    expect(view).toBeDefined()
    act(() => {
      undo(view!.state, view!.dispatch)
    })
    await waitFor(() => {
      expect(screen.getByTestId('draft-value')).toHaveTextContent('check @ChatInput.tsx add button')
    })
    expect(screen.getByTestId('mentions-count')).toHaveTextContent('1')
  })

  it('restores original text via the floating Restore button', async () => {
    mockOptimizePrompt.mockResolvedValueOnce({
      requestId: 'req-2',
      optimizedPrompt: 'Refactored prompt with clear steps',
    })

    render(<ComposerOptimizeHarness initialText="fix it" />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))

    const restoreButton = await screen.findByRole('button', { name: 'Restore' })
    expect(screen.getByTestId('draft-value')).toHaveTextContent('Refactored prompt with clear steps')

    fireEvent.click(restoreButton)
    expect(screen.getByTestId('draft-value')).toHaveTextContent('fix it')
    expect(screen.queryByTestId('prompt-optimize-notice')).not.toBeInTheDocument()
  })

  it('cancels an in-flight optimization when clicked again', async () => {
    let signalRef: AbortSignal | undefined
    mockOptimizePrompt.mockImplementationOnce((_sessionId, _body, signal) => {
      signalRef = signal
      return new Promise(() => {})
    })

    render(<ComposerOptimizeHarness initialText="refactor login" />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))

    const cancelButton = await screen.findByRole('button', { name: 'Cancel prompt optimization' })
    expect(cancelButton).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(cancelButton)

    expect(signalRef?.aborted).toBe(true)
    expect(mockCancelOptimizePrompt).toHaveBeenCalledWith('session-1', expect.any(String))
    expect(screen.getByRole('button', { name: 'Optimize prompt' })).toBeEnabled()
  })

  it('cancels in-flight optimization and keeps new edits when user types', async () => {
    let resolveOptimize!: (value: { requestId: string; optimizedPrompt: string }) => void
    mockOptimizePrompt.mockImplementationOnce(
      () => new Promise(resolve => { resolveOptimize = resolve }),
    )

    const { container } = render(<ComposerOptimizeHarness initialText="rough draft" />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))
    await screen.findByRole('button', { name: 'Cancel prompt optimization' })

    const editorEl = container.querySelector<HTMLElement>('[data-composer-editor]')
    const view = getComposerViewForTesting(editorEl)!
    act(() => {
      view.dispatch(view.state.tr.insertText(' updated', view.state.doc.content.size - 1))
    })

    expect(mockCancelOptimizePrompt).toHaveBeenCalledTimes(1)
    act(() => {
      resolveOptimize({ requestId: 'stale', optimizedPrompt: 'stale optimized result' })
    })
    await Promise.resolve()
    expect(screen.getByTestId('draft-value')).toHaveTextContent('rough draft updated')
  })

  it('preserves original draft and shows an error toast on failure', async () => {
    mockOptimizePrompt.mockRejectedValueOnce(new Error('Provider unavailable'))

    render(<ComposerOptimizeHarness initialText="original wording" />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))

    await waitFor(() => {
      expect(useUIStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'error', message: 'Provider unavailable' }),
        ]),
      )
    })
    expect(screen.getByTestId('draft-value')).toHaveTextContent('original wording')
  })

  it('disables optimization for slash commands', () => {
    expect(isOptimizablePrompt('')).toBe(false)
    expect(isOptimizablePrompt('   ')).toBe(false)
    expect(isOptimizablePrompt('/compact')).toBe(false)
    expect(isOptimizablePrompt('  /cost')).toBe(false)
    expect(isOptimizablePrompt('帮我优化登录流程')).toBe(true)
  })
})
