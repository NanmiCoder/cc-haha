import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PromptOptimizeButton } from './PromptOptimizeButton'
import { isOptimizablePrompt, usePromptOptimize, type PromptOptimizeController } from './usePromptOptimize'
import { prepareMentionsForRewrite, type ComposerMention } from '@/lib/composerMentions'
import { sessionsApi } from '@/api/sessions'
import { useUIStore } from '@/stores/uiStore'
import { MentionComposer, getComposerViewForTesting, type MentionComposerHandle } from './MentionComposer'
import { undo } from 'prosemirror-history'
import { useRef, useState } from 'react'
import { MAX_OPTIMIZE_PROMPT_LENGTH, renderOptimizeDraft } from '../../../../src/shared/promptOptimizeReferences'

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

describe('prepareMentionsForRewrite', () => {
  it('preserves surviving mention pills even when the rewrite reorders them', () => {
    const mentions: ComposerMention[] = [
      { label: 'a.ts', path: '/repo/a.ts', isDirectory: false, tokenOrdinal: 0 },
      { label: 'b.ts', path: '/repo/b.ts', isDirectory: false, tokenOrdinal: 0 },
    ]
    const rewrite = prepareMentionsForRewrite('@a.ts @b.ts', mentions)
    const [a, b] = rewrite.prompt.split(' ')
    const { mentions: reconciled } = rewrite.restore(`First inspect ${b} Then update ${a} accordingly.`)
    expect(reconciled.map(m => m.label)).toEqual(['b.ts', 'a.ts'])
    expect(reconciled.map(m => m.path)).toEqual(['/repo/b.ts', '/repo/a.ts'])
    expect(reconciled.map(m => m.tokenOrdinal)).toEqual([0, 0])
  })

  it('drops mentions whose tokens were removed without breaking remaining pills', () => {
    const mentions: ComposerMention[] = [
      { label: 'gone.ts', path: '/repo/gone.ts', isDirectory: false, tokenOrdinal: 0 },
      { label: 'kept.ts', path: '/repo/kept.ts', isDirectory: false, tokenOrdinal: 0 },
    ]
    const rewrite = prepareMentionsForRewrite('Read @gone.ts and update @kept.ts', mentions)
    const { mentions: reconciled } = rewrite.restore(rewrite.prompt.replace(/^.* and update /, 'Update '))
    expect(reconciled).toEqual([
      { label: 'kept.ts', path: '/repo/kept.ts', isDirectory: false, tokenOrdinal: 0 },
    ])
  })

  it.each(['Read @Report.', 'Read @Report and compare @Report with @Report.'])(
    'leaves ambiguous occurrences as plain text after a duplicate count changes: %s', rewritten => {
      const fileMention = { label: 'Report', path: '/repo/Report', isDirectory: false, tokenOrdinal: 0 }
      const rewrite = prepareMentionsForRewrite('Read @Report and type @Report.', [fileMention])
      expect(rewrite.restore(rewritten)).toEqual({ text: rewritten, mentions: [] })
    },
  )

  it('tracks same-named files when reordered and leaves copied references as text', () => {
    const first = { label: 'Report', path: '/a/Report', isDirectory: false, tokenOrdinal: 0 }
    const second = { ...first, path: '/b/Report', tokenOrdinal: 2 }
    const rewrite = prepareMentionsForRewrite('@Report @Report @Report', [first, second])
    const [a, literal, b] = rewrite.prompt.split(' ')
    expect(rewrite.restore(`${b} ${literal} ${a}`)).toEqual({
      text: '@Report @Report @Report',
      mentions: [{ ...second, tokenOrdinal: 0 }, { ...first, tokenOrdinal: 2 }],
    })
    expect(rewrite.restore(`${a} ${a}`)).toEqual({ text: '@Report @Report', mentions: [] })
    expect(rewrite.restore(a!.replace('Report', 'Summary'))).toEqual({ text: '@Summary', mentions: [] })
  })

  it('does not attach the original file to a longer name introduced by the rewrite', () => {
    const file = { label: 'Report', path: '/a/Report', isDirectory: false, tokenOrdinal: 0 }
    const rewrite = prepareMentionsForRewrite('Open @Report', [file])
    expect(rewrite.restore('Type @Report.md')).toEqual({ text: 'Type @Report.md', mentions: [] })
    const renamed = rewrite.prompt.replace('Report', 'Report.md')
    expect(rewrite.restore(renamed)).toEqual({ text: 'Open @Report.md', mentions: [] })
  })

  it('does not turn a newly typed example into a file mention after the original was dropped', () => {
    const file = { label: 'Report', path: '/a/Report', isDirectory: false, tokenOrdinal: 0 }
    const rewrite = prepareMentionsForRewrite('Open @Report', [file])
    expect(rewrite.restore('Type the literal @Report.')).toEqual({ text: 'Type the literal @Report.', mentions: [] })
  })

  it('keeps user-written marker text and restores adjacent Chinese text and punctuation', () => {
    const file = { label: '报告', path: '/a/报告', isDirectory: false, tokenOrdinal: 0 }
    const draft = '保留[[ref:0]]，查看@报告的摘要。'
    const rewrite = prepareMentionsForRewrite(draft, [file])
    expect(rewrite.restore(rewrite.prompt)).toEqual({ text: draft, mentions: [file] })
  })

  it('round-trips references in a full-length draft without charging marker bytes to the user', () => {
    const file = { label: 'Report', path: '/a/Report', isDirectory: false, tokenOrdinal: 0 }
    const draft = 'x'.repeat(MAX_OPTIMIZE_PROMPT_LENGTH - 8) + ' @Report'
    const rewrite = prepareMentionsForRewrite(draft, [file])
    expect(rewrite.requestPrompt).toEqual({ text: draft, referenceEnds: [draft.length] })
    expect(rewrite.restore(renderOptimizeDraft(rewrite.requestPrompt))).toEqual({ text: draft, mentions: [file] })
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
    mockOptimizePrompt.mockImplementationOnce(async (_sessionId, { prompt }) => ({
      requestId: 'req-1',
      optimizedPrompt: renderOptimizeDraft(prompt).replace('check ', 'Inspect ').replace(' add button', ' toolbar layout and add a prompt optimization button with regression tests.'),
    }))

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

  it('keeps the second @Report bound to the file when the first is literal text', async () => {
    mockOptimizePrompt.mockImplementationOnce(async (_sessionId, { prompt }) => ({
      requestId: 'req-duplicate',
      optimizedPrompt: renderOptimizeDraft(prompt).replace('type', 'Type').replace(' then', ' first, then') + '.',
    }))
    render(<ComposerOptimizeHarness
      initialText="type @Report then open @Report"
      initialMentions={[{ label: 'Report', path: '/repo/Report', isDirectory: false, tokenOrdinal: 1 }]}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))
    await waitFor(() => expect(screen.getByTestId('model-content')).toHaveTextContent(
      'Type @Report first, then open @"/repo/Report".',
    ))
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
