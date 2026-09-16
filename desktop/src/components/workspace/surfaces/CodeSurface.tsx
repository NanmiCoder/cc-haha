import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { Highlight } from 'prism-react-renderer'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { clearWindowSelection, useSelectionPopoverDismiss } from '@/hooks/useSelectionPopoverDismiss'
import type { WorkspaceReveal } from '@/lib/workspace/types'
import {
  normalizePrismLanguage,
  WORKSPACE_PREVIEW_LINE_LIMIT,
  workspacePrismTheme,
} from '../WorkspaceCodeSurface'
import type { WorkspaceDiffHighlightToken } from '../workspaceDiffHighlighter'
import { FloatingSelectionMenu } from './FloatingSelectionMenu'
import {
  getTextSelectionFromContainer,
  type FloatingSelectionMenuState,
  type WorkspaceTextSelection,
} from './textSelection'

export function workspaceCodeTokenStyle(token: WorkspaceDiffHighlightToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
  }
}

export function CodeSurface({
  value,
  language,
  reveal,
  revealScroll = true,
  onAddLineComment,
  onAddSelection,
}: {
  value: string
  language: string
  reveal?: WorkspaceReveal
  revealScroll?: boolean
  onAddLineComment: (lineStart: number, lineEnd: number, note: string, quote: string) => void
  onAddSelection: (selection: WorkspaceTextSelection) => void
}) {
  const t = useTranslation()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectionMenuRef = useRef<HTMLButtonElement>(null)
  const [commentRange, setCommentRange] = useState<{ anchorLine: number; focusLine: number } | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [showAllLines, setShowAllLines] = useState(false)
  const [selectionMenu, setSelectionMenu] = useState<FloatingSelectionMenuState | null>(null)
  const [shikiTokensByLine, setShikiTokensByLine] = useState<WorkspaceDiffHighlightToken[][] | null>(null)
  const lines = value.split('\n')
  const visibleLines = showAllLines ? lines : lines.slice(0, WORKSPACE_PREVIEW_LINE_LIMIT)
  const commentLineStart = commentRange ? Math.min(commentRange.anchorLine, commentRange.focusLine) : null
  const commentLineEnd = commentRange ? Math.max(commentRange.anchorLine, commentRange.focusLine) : null
  const activeQuote = commentLineStart && commentLineEnd
    ? visibleLines.slice(commentLineStart - 1, commentLineEnd).join('\n')
    : ''
  const usePlainLargePreview = showAllLines && lines.length > WORKSPACE_PREVIEW_LINE_LIMIT
  const visibleCode = usePlainLargePreview ? '' : visibleLines.join('\n')

  useEffect(() => {
    setShowAllLines(false)
    setCommentRange(null)
    setCommentDraft('')
    setSelectionMenu(null)
  }, [language, value])

  const revealLine = reveal?.line
  const revealNonce = reveal?.nonce

  // A reference past the fold (`foo.ts:900`) is unreachable while the preview is
  // truncated, so expand first. Declared AFTER the reset effect above on purpose:
  // effects run in declaration order, so when a reload changes `value` the reset
  // collapses and this re-expands, rather than the other way round.
  useEffect(() => {
    if (revealLine && revealLine > WORKSPACE_PREVIEW_LINE_LIMIT) setShowAllLines(true)
  }, [revealLine, revealNonce, value])

  // Scroll the marked line into view. `shikiTokensByLine` and `showAllLines` are
  // dependencies because both rebuild the line rows underneath us — highlighting
  // resolves asynchronously, so the row may not exist on the first pass.
  useEffect(() => {
    if (!revealLine || !revealScroll) return
    const surface = surfaceRef.current
    const row = surface?.querySelector<HTMLElement>(`[data-workspace-line-number="${revealLine}"]`)
    if (!surface || !row) return

    // Deliberately not scrollIntoView: that also scrolls every ancestor, which
    // drags the whole chat column when the workbench is a side panel.
    const rowRect = row.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    const delta = rowRect.top - surfaceRect.top - surface.clientHeight / 2 + rowRect.height / 2
    surface.scrollTop = Math.max(0, surface.scrollTop + delta)
  }, [revealLine, revealNonce, revealScroll, value, shikiTokensByLine, showAllLines])

  useEffect(() => {
    if (usePlainLargePreview) {
      setShikiTokensByLine(null)
      return
    }

    let cancelled = false
    setShikiTokensByLine(null)
    void import('../workspaceDiffHighlighter')
      .then(({ highlightWorkspaceCode }) => highlightWorkspaceCode({ value: visibleCode, language }))
      .then((result) => {
        if (!cancelled && result.engine === 'shiki') setShikiTokensByLine(result.tokensByLine)
      })
      .catch(() => {
        if (!cancelled) setShikiTokensByLine(null)
      })
    return () => {
      cancelled = true
    }
  }, [language, usePlainLargePreview, visibleCode])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  useSelectionPopoverDismiss({
    active: Boolean(selectionMenu),
    popoverRef: selectionMenuRef,
    onDismiss: dismissSelectionMenu,
  })

  const submitLineComment = () => {
    if (!commentLineStart || !commentLineEnd || !commentDraft.trim()) return
    onAddLineComment(commentLineStart, commentLineEnd, commentDraft.trim(), activeQuote)
    setCommentRange(null)
    setCommentDraft('')
  }

  const handleSelectionMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.ctrlKey) {
      setSelectionMenu(null)
      return
    }
    const selection = getTextSelectionFromContainer(surfaceRef.current, undefined, event)
    if (!selection?.startLine || !selection.endLine || selection.startLine === selection.endLine) {
      setSelectionMenu(selection)
      return
    }

    setSelectionMenu({
      ...selection,
      text: visibleLines.slice(selection.startLine - 1, selection.endLine).join('\n').trim(),
    })
  }

  const addCurrentSelectionToChat = () => {
    if (!selectionMenu) return
    onAddSelection({
      text: selectionMenu.text,
      startLine: selectionMenu.startLine,
      endLine: selectionMenu.endLine,
    })
    setSelectionMenu(null)
    clearWindowSelection()
  }

  const renderLineCommentEditor = (lineNumber: number) => {
    if (!commentLineStart || commentLineEnd !== lineNumber) return null

    return (
      <div className="grid grid-cols-[32px_minmax(0,720px)] gap-3 bg-[var(--color-brand-soft)] px-3 py-2">
        <span aria-hidden="true" />
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-card)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
            <span className="material-symbols-outlined text-[15px] text-[var(--color-text-tertiary)]">chat_bubble</span>
            <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{t('workspace.localComment')}</span>
            <span className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
              {commentLineStart === commentLineEnd
                ? t('workspace.commentLineTarget', { line: commentLineStart })
                : t('workspace.commentLineRangeTarget', { start: commentLineStart, end: commentLineEnd })}
            </span>
          </div>
          <textarea
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            autoFocus
            rows={3}
            placeholder={t('workspace.commentPlaceholder')}
            className="block w-full resize-none bg-transparent px-3 py-3 text-[13px] leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          <div className="flex justify-end gap-2 px-3 pb-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCommentRange(null)
                setCommentDraft('')
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={submitLineComment}
              disabled={!commentDraft.trim()}
            >
              {t('workspace.addCommentToChat')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const isCommentLineSelected = (lineNumber: number) => (
    commentLineStart !== null
    && commentLineEnd !== null
    && lineNumber >= commentLineStart
    && lineNumber <= commentLineEnd
  )

  const lineRowClassName = (lineNumber: number) => {
    // A comment selection is something the user just did by hand, so it outranks
    // the reveal mark left over from the reference they clicked to get here.
    if (isCommentLineSelected(lineNumber)) {
      return 'group grid grid-cols-[32px_minmax(0,1fr)] gap-3 px-3 bg-[var(--color-info-container)]'
    }
    if (revealLine === lineNumber) {
      return 'group grid grid-cols-[32px_minmax(0,1fr)] gap-3 px-3 bg-[var(--color-brand-soft)] shadow-[inset_2px_0_0_var(--color-brand)]'
    }
    return 'group grid grid-cols-[32px_minmax(0,1fr)] gap-3 px-3 hover:bg-[var(--color-surface-hover)]'
  }

  const renderLineNumberButton = (lineNumber: number) => {
    const selected = isCommentLineSelected(lineNumber)
    return (
      <button
        type="button"
        aria-label={t('workspace.commentLine', { line: lineNumber })}
        aria-pressed={selected}
        onClick={(event) => {
          const extendRange = event.shiftKey && commentRange !== null
          setCommentRange(extendRange
            ? { ...commentRange, focusLine: lineNumber }
            : { anchorLine: lineNumber, focusLine: lineNumber })
          if (!extendRange) setCommentDraft('')
        }}
        className={`select-none text-right text-[13px] transition-colors focus-visible:outline-none ${
          selected
            ? 'font-semibold text-[var(--color-info)]'
            : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-brand)] focus-visible:text-[var(--color-brand)]'
        }`}
      >
        {lineNumber}
      </button>
    )
  }

  return (
    <div
      ref={surfaceRef}
      data-workspace-scroll-surface=""
      className="min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)]"
      onMouseUp={handleSelectionMouseUp}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      <div className="relative min-w-max py-2">
        {usePlainLargePreview ? (
          <pre
            data-workspace-code=""
            data-testid="workspace-code"
            className="m-0 font-mono text-[15px] leading-[26px]"
            style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
          >
            {visibleLines.map((line, index) => {
              const lineNumber = index + 1
              return (
                <div key={lineNumber}>
                  <div
                    className={lineRowClassName(lineNumber)}
                    data-workspace-line-number={lineNumber}
                  >
                    {renderLineNumberButton(lineNumber)}
                    <span className="whitespace-pre pr-6">{line || ' '}</span>
                  </div>
                  {renderLineCommentEditor(lineNumber)}
                </div>
              )
            })}
          </pre>
        ) : shikiTokensByLine ? (
          <pre
            data-workspace-code=""
            data-testid="workspace-code"
            data-highlight-engine="shiki"
            className="m-0 font-mono text-[15px] leading-[26px]"
            style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
          >
            {shikiTokensByLine.map((line, index) => {
              const lineNumber = index + 1
              return (
                <div key={lineNumber}>
                  <div
                    data-workspace-line-number={lineNumber}
                    className={lineRowClassName(lineNumber)}
                  >
                    {renderLineNumberButton(lineNumber)}
                    <span className="whitespace-pre pr-6">
                      {line.length === 0 ? ' ' : line.map((token, tokenIndex) => (
                        <span
                          key={`${tokenIndex}:${token.content}`}
                          data-workspace-token=""
                          style={workspaceCodeTokenStyle(token)}
                        >
                          {token.content}
                        </span>
                      ))}
                    </span>
                  </div>
                  {renderLineCommentEditor(lineNumber)}
                </div>
              )
            })}
          </pre>
        ) : (
          <Highlight
            theme={workspacePrismTheme}
            code={visibleCode}
            language={normalizePrismLanguage(language)}
          >
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre
                data-workspace-code=""
                data-testid="workspace-code"
                data-highlight-engine="prism"
                className="m-0 font-mono text-[15px] leading-[26px]"
                style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
              >
                {tokens.map((line, index) => {
                  const { key: lineKey, ...lineProps } = getLineProps({ line, key: index })
                  const lineNumber = index + 1
                  return (
                    <div key={String(lineKey)}>
                      <div
                        {...lineProps}
                        data-workspace-line-number={lineNumber}
                        className={lineRowClassName(lineNumber)}
                      >
                        {renderLineNumberButton(lineNumber)}
                        <span className="whitespace-pre pr-6">
                          {line.length === 1 && line[0]?.empty ? ' ' : line.map((token, tokenIndex) => {
                            const { key: tokenKey, ...tokenProps } = getTokenProps({ token, key: tokenIndex })
                            return <span key={String(tokenKey)} {...tokenProps} />
                          })}
                        </span>
                      </div>
                      {renderLineCommentEditor(lineNumber)}
                    </div>
                  )
                })}
              </pre>
            )}
          </Highlight>
        )}
        {lines.length > WORKSPACE_PREVIEW_LINE_LIMIT && (
          <div className="sticky bottom-0 flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-xs text-[var(--color-text-tertiary)] backdrop-blur">
            <span>
              {showAllLines
                ? t('workspace.previewAllLines', { total: lines.length })
                : t('workspace.previewLineLimit', { count: visibleLines.length, total: lines.length })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAllLines((current) => !current)}
              className="ml-auto"
            >
              {showAllLines ? t('workspace.collapsePreview') : t('workspace.showAllLoadedLines')}
            </Button>
          </div>
        )}
      </div>
      <FloatingSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}
