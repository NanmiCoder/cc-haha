import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { CornerDownLeft, FileCode2, MessageSquare, Plus } from 'lucide-react'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { useTranslation } from '../../i18n'
import {
  getCompatibleDiffRange,
  parseWorkspaceDiff,
  type WorkspaceDiffRow,
  type WorkspaceDiffSelection,
} from './workspaceDiffModel'
import {
  type WorkspaceDiffHighlightResult,
  type WorkspaceDiffHighlightToken,
  type WorkspaceDiffWordRange,
} from './workspaceDiffHighlighter'
import {
  createWorkspaceDiffHighlightCacheKey,
  requestWorkspaceDiffHighlight,
} from './workspaceDiffHighlightRuntime'

export const WORKSPACE_PREVIEW_LINE_LIMIT = 2000
export const WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD = 5000

export const workspacePrismTheme: PrismTheme = {
  plain: {
    color: 'var(--color-code-fg)',
    backgroundColor: 'transparent',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-code-comment)', fontStyle: 'italic' } },
    { types: ['string', 'attr-value', 'template-string'], style: { color: 'var(--color-code-string)' } },
    { types: ['keyword', 'selector', 'important', 'atrule'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['function'], style: { color: 'var(--color-code-function)' } },
    { types: ['tag'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['number', 'boolean'], style: { color: 'var(--color-code-number)' } },
    { types: ['operator'], style: { color: 'var(--color-code-fg)' } },
    { types: ['punctuation'], style: { color: 'var(--color-code-punctuation)' } },
    { types: ['variable', 'parameter'], style: { color: 'var(--color-code-fg)' } },
    { types: ['property', 'attr-name'], style: { color: 'var(--color-code-property)' } },
    { types: ['builtin', 'class-name', 'constant', 'symbol'], style: { color: 'var(--color-code-type)' } },
    { types: ['inserted'], style: { color: 'var(--color-code-inserted)' } },
    { types: ['deleted'], style: { color: 'var(--color-code-deleted)' } },
  ],
}

export function getFileExtension(name: string) {
  const cleanName = name.split('/').pop() ?? name
  const lastDot = cleanName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === cleanName.length - 1) return ''
  return cleanName.slice(lastDot + 1).toLowerCase()
}

export function normalizePrismLanguage(language: string) {
  const lower = language.toLowerCase()
  const map: Record<string, string> = {
    text: 'text',
    typescript: 'typescript',
    ts: 'typescript',
    tsx: 'tsx',
    javascript: 'javascript',
    js: 'javascript',
    jsx: 'jsx',
    markdown: 'markdown',
    md: 'markdown',
    html: 'markup',
    xml: 'markup',
    shell: 'bash',
    sh: 'bash',
    zsh: 'bash',
    diff: 'diff',
  }
  return map[lower] ?? lower
}

export function getLanguageFromPath(path: string) {
  return normalizePrismLanguage(getFileExtension(path) || 'text')
}

export const InlineHighlightedCode = memo(function InlineHighlightedCode({
  value,
  language,
}: {
  value: string
  language: string
}) {
  return (
    <Highlight theme={workspacePrismTheme} code={value} language={normalizePrismLanguage(language)}>
      {({ tokens, getTokenProps }) => (
        <>
          {(tokens[0] ?? []).map((token, tokenIndex) => {
            const { key: tokenKey, ...tokenProps } = getTokenProps({ token, key: tokenIndex })
            return <span key={String(tokenKey)} {...tokenProps} />
          })}
        </>
      )}
    </Highlight>
  )
})

function tokenStyle(token: WorkspaceDiffHighlightToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecoration: [
      fontStyle & 4 ? 'underline' : '',
      fontStyle & 8 ? 'line-through' : '',
    ].filter(Boolean).join(' ') || undefined,
  }
}

function overlapsRange(start: number, end: number, ranges: WorkspaceDiffWordRange[]) {
  return ranges.some((range) => start < range.end && end > range.start)
}

const HighlightedDiffLine = memo(function HighlightedDiffLine({
  row,
  tokens,
  wordRanges,
}: {
  row: WorkspaceDiffRow
  tokens: WorkspaceDiffHighlightToken[]
  wordRanges: WorkspaceDiffWordRange[]
}) {
  let offset = 0
  return (
    <>
      {tokens.map((token, tokenIndex) => {
        const tokenStart = offset
        const tokenEnd = tokenStart + token.content.length
        offset = tokenEnd
        const boundaries = new Set([tokenStart, tokenEnd])
        wordRanges.forEach((range) => {
          if (range.start > tokenStart && range.start < tokenEnd) boundaries.add(range.start)
          if (range.end > tokenStart && range.end < tokenEnd) boundaries.add(range.end)
        })
        const points = [...boundaries].sort((left, right) => left - right)
        return points.slice(0, -1).map((start, partIndex) => {
          const end = points[partIndex + 1]!
          const changed = overlapsRange(start, end, wordRanges)
          return (
            <span
              key={`${tokenIndex}-${partIndex}`}
              data-diff-word-change={changed ? row.kind : undefined}
              className={changed
                ? row.kind === 'addition'
                  ? 'bg-[var(--color-diff-added-word)]'
                  : row.kind === 'deletion'
                    ? 'bg-[var(--color-diff-removed-word)]'
                    : undefined
                : undefined}
              style={tokenStyle(token)}
            >
              {token.content.slice(start - tokenStart, end - tokenStart)}
            </span>
          )
        })
      })}
    </>
  )
})

export interface WorkspaceDiffCommentSelection {
  side: 'old' | 'new'
  lineStart: number
  lineEnd: number
  quote: string
  hunkId: string
}

export interface WorkspaceDiffSurfaceProps {
  value: string
  path: string
  className?: string
  lineLimit?: number
  hideSingleFileHeader?: boolean
  onAddComment?: (selection: WorkspaceDiffCommentSelection, note: string) => void
}

interface ReviewState {
  anchorId: string | null
  focusId: string | null
  selection: WorkspaceDiffSelection | null
  draft: string
}

type ReviewStatus = 'selectionReset' | 'diffChanged' | 'collapsedSelection' | null

const plainHighlightResult: WorkspaceDiffHighlightResult = {
  engine: 'plain',
  tokensByRowId: {},
  wordRangesByRowId: {},
}

const emptyReviewState: ReviewState = {
  anchorId: null,
  focusId: null,
  selection: null,
  draft: '',
}

function rowTone(row: WorkspaceDiffRow) {
  if (row.kind === 'addition') return 'bg-[var(--color-diff-added-bg)]'
  if (row.kind === 'deletion') return 'bg-[var(--color-diff-removed-bg)]'
  if (row.kind === 'hunk') return 'bg-[var(--color-diff-highlight-bg)]'
  return 'hover:bg-[var(--color-surface-hover)]'
}

function gutterTone(row: WorkspaceDiffRow, selected: boolean) {
  if (selected) return 'bg-[var(--color-info-container)]'
  if (row.kind === 'addition') return 'bg-[var(--color-diff-added-bg)]'
  if (row.kind === 'deletion') return 'bg-[var(--color-diff-removed-bg)]'
  if (row.kind === 'hunk') return 'bg-[var(--color-diff-highlight-bg)]'
  return 'bg-[var(--color-code-bg)] group-hover:bg-[var(--color-surface-hover)]'
}

function prefixTone(row: WorkspaceDiffRow) {
  if (row.kind === 'addition') return 'text-[var(--color-diff-added-text)]'
  if (row.kind === 'deletion') return 'text-[var(--color-diff-removed-text)]'
  return 'text-[var(--color-text-tertiary)]'
}

function codeTone(row: WorkspaceDiffRow) {
  if (row.kind === 'metadata') return 'font-semibold text-[var(--color-text-secondary)]'
  if (row.kind === 'hunk') return 'font-semibold text-[var(--color-warning)]'
  return ''
}

function isStructuralMetadata(row: WorkspaceDiffRow) {
  if (row.kind !== 'metadata') return false
  return row.text.startsWith('diff --') || row.text.startsWith('--- ') || row.text.startsWith('+++ ')
}

export function WorkspaceDiffSurface({
  value,
  path,
  className = 'min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)]',
  lineLimit = WORKSPACE_PREVIEW_LINE_LIMIT,
  hideSingleFileHeader = false,
  onAddComment,
}: WorkspaceDiffSurfaceProps) {
  const t = useTranslation()
  const files = useMemo(() => parseWorkspaceDiff(value), [value])
  const rows = useMemo(() => files.flatMap((file) => file.rows), [files])
  const lineNumberCharacters = useMemo(
    () => rows.reduce((maximum, row) => Math.max(
      maximum,
      row.oldLine === null ? 0 : String(row.oldLine).length,
      row.newLine === null ? 0 : String(row.newLine).length,
    ), 3),
    [rows],
  )
  const codeStyle = {
    '--workspace-diff-gutter-width': `${lineNumberCharacters + 3}ch`,
  } as CSSProperties
  const showFileHeaders = !hideSingleFileHeader || files.length > 1
  const displayItemIds = useMemo(
    () => files.flatMap((file) => [
      ...(showFileHeaders ? [`${file.id}-header`] : []),
      ...file.rows.filter((row) => !isStructuralMetadata(row)).map((row) => row.id),
    ]),
    [files, showFileHeaders],
  )
  const [review, setReview] = useState<ReviewState>(emptyReviewState)
  const [status, setStatus] = useState<ReviewStatus>(null)
  const [showAllRows, setShowAllRows] = useState(false)
  const visibleItemIds = useMemo(
    () => new Set(showAllRows ? displayItemIds : displayItemIds.slice(0, lineLimit)),
    [displayItemIds, lineLimit, showAllRows],
  )
  const visibleRows = useMemo(() => rows.filter((row) => visibleItemIds.has(row.id)), [rows, visibleItemIds])
  const selectableRows = useMemo(() => visibleRows.filter((row) => row.selectable), [visibleRows])
  const usePlainLargePreview = rows.length > WORKSPACE_PLAIN_TEXT_LINE_THRESHOLD
  const highlightCacheKey = useMemo(
    () => createWorkspaceDiffHighlightCacheKey(path, value),
    [path, value],
  )
  const [highlightState, setHighlightState] = useState<{
    cacheKey: string | null
    result: WorkspaceDiffHighlightResult
  }>({
    cacheKey: null,
    result: plainHighlightResult,
  })
  const highlightResult = !usePlainLargePreview && highlightState.cacheKey === highlightCacheKey
    ? highlightState.result
    : plainHighlightResult
  const [rovingId, setRovingId] = useState<string | null>(() => rows.find((row) => row.selectable)?.id ?? null)
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const shouldFocusEditor = useRef(false)
  const pendingRovingFocus = useRef<string | null>(null)
  const previousPath = useRef(path)
  const previousValue = useRef(value)
  const selectedIds = new Set(review.selection?.rowIds ?? [])
  const sideLabel = (side: 'old' | 'new') => t(`workspace.diffReview.side.${side}`)

  useEffect(() => {
    if (usePlainLargePreview) {
      setHighlightState({ cacheKey: null, result: plainHighlightResult })
      return
    }

    let cancelled = false
    setHighlightState({ cacheKey: null, result: plainHighlightResult })
    requestWorkspaceDiffHighlight({ cacheKey: highlightCacheKey, files, path }).then((result) => {
      if (!cancelled) setHighlightState({ cacheKey: highlightCacheKey, result })
    })
    return () => {
      cancelled = true
    }
  }, [files, highlightCacheKey, path, usePlainLargePreview])

  useEffect(() => {
    const pathChanged = previousPath.current !== path
    const valueChanged = previousValue.current !== value
    previousPath.current = path
    previousValue.current = value

    if (pathChanged) {
      setReview(emptyReviewState)
      setStatus(null)
      setShowAllRows(false)
      setRovingId(selectableRows[0]?.id ?? null)
      return
    }

    if (valueChanged) {
      setReview((current) => ({
        ...current,
        anchorId: null,
        focusId: null,
        selection: null,
      }))
      setStatus(review.draft ? 'diffChanged' : null)
      setRovingId(selectableRows[0]?.id ?? null)
    }
  }, [path, review.draft, selectableRows, value])

  useEffect(() => {
    if (!rovingId || !selectableRows.some((row) => row.id === rovingId)) {
      setRovingId(selectableRows[0]?.id ?? null)
    }
    const pendingId = pendingRovingFocus.current
    if (pendingId && selectableRows.some((row) => row.id === pendingId)) {
      pendingRovingFocus.current = null
      setRovingId(pendingId)
      buttonRefs.current.get(pendingId)?.focus()
    }
  }, [rovingId, selectableRows])

  useEffect(() => {
    if (review.selection && shouldFocusEditor.current) {
      shouldFocusEditor.current = false
      editorRef.current?.focus()
    }
  }, [review.selection])

  const focusButton = (id: string | null) => {
    if (id) buttonRefs.current.get(id)?.focus()
  }

  const selectSingleRow = (row: WorkspaceDiffRow, resetStatus: ReviewStatus = null, focusEditor = false) => {
    const selection = getCompatibleDiffRange(rows, row.id, row.id)
    if (!selection) return
    shouldFocusEditor.current = focusEditor
    setReview((current) => ({
      ...current,
      anchorId: row.id,
      focusId: row.id,
      selection,
    }))
    setStatus(resetStatus)
  }

  const extendSelection = (row: WorkspaceDiffRow, focusEditor = false) => {
    if (!review.anchorId) {
      selectSingleRow(row, null, focusEditor)
      return
    }
    const selection = getCompatibleDiffRange(rows, review.anchorId, row.id)
    if (!selection) {
      selectSingleRow(row, 'selectionReset', focusEditor)
      return
    }
    shouldFocusEditor.current = focusEditor
    setReview((current) => ({ ...current, focusId: row.id, selection }))
    setStatus(null)
  }

  const activateRow = (row: WorkspaceDiffRow, extend: boolean, focusEditor: boolean) => {
    setRovingId(row.id)
    if (extend) extendSelection(row, focusEditor)
    else selectSingleRow(row, null, focusEditor)
  }

  const handleRowClick = (event: MouseEvent<HTMLButtonElement>, row: WorkspaceDiffRow) => {
    if (event.shiftKey) event.currentTarget.focus()
    activateRow(row, event.shiftKey, !event.shiftKey)
  }

  const moveRovingFocus = (row: WorkspaceDiffRow, direction: -1 | 1, extend: boolean) => {
    const currentIndex = selectableRows.findIndex((candidate) => candidate.id === row.id)
    const anchorRow = review.anchorId
      ? selectableRows.find((candidate) => candidate.id === review.anchorId) ?? row
      : row
    let target = selectableRows[currentIndex + direction]
    if (extend) {
      let targetIndex = currentIndex + direction
      while (target && (target.side !== anchorRow.side || target.hunkId !== anchorRow.hunkId)) {
        targetIndex += direction
        target = selectableRows[targetIndex]
      }
    }
    if (!target) return
    setRovingId(target.id)
    focusButton(target.id)
    if (extend && !review.anchorId) {
      const selection = getCompatibleDiffRange(rows, row.id, target.id)
      if (selection) {
        setReview((current) => ({
          ...current,
          anchorId: row.id,
          focusId: target.id,
          selection,
        }))
        setStatus(null)
      } else {
        selectSingleRow(target, 'selectionReset')
      }
    } else if (extend) {
      extendSelection(target)
    }
  }

  const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: WorkspaceDiffRow) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveRovingFocus(row, event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const navigationRows = event.shiftKey
        ? selectableRows.filter((candidate) => (
          candidate.side === row.side && candidate.hunkId === row.hunkId
        ))
        : selectableRows
      const target = event.key === 'Home' ? navigationRows[0] : navigationRows.at(-1)
      if (target) {
        setRovingId(target.id)
        focusButton(target.id)
        if (event.shiftKey && !review.anchorId) {
          const selection = getCompatibleDiffRange(rows, row.id, target.id)
          if (selection) {
            setReview((current) => ({
              ...current,
              anchorId: row.id,
              focusId: target.id,
              selection,
            }))
            setStatus(null)
          }
        } else if (event.shiftKey) {
          extendSelection(target)
        }
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateRow(row, event.shiftKey, true)
    }
  }

  const closeEditor = () => {
    const restoreId = review.anchorId
    setReview((current) => ({ ...current, anchorId: null, focusId: null, selection: null }))
    setStatus(null)
    focusButton(restoreId)
  }

  const submitComment = () => {
    const note = review.draft.trim()
    if (!note || !review.selection) return
    const { side, lineStart, lineEnd, quote, hunkId } = review.selection
    onAddComment?.({ side, lineStart, lineEnd, quote, hunkId }, note)
    const restoreId = review.anchorId
    setReview(emptyReviewState)
    setStatus(null)
    focusButton(restoreId)
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submitComment()
    }
  }

  const toggleRows = () => {
    if (!showAllRows) {
      setShowAllRows(true)
      return
    }

    const collapsedItemIds = new Set(displayItemIds.slice(0, lineLimit))
    const collapsedSelectableRows = rows.filter((row) => row.selectable && collapsedItemIds.has(row.id))
    const nextRovingId = collapsedSelectableRows[0]?.id ?? null
    const selectionWillBeHidden = review.selection?.rowIds.some((id) => !collapsedItemIds.has(id)) ?? false

    if (selectionWillBeHidden) {
      setReview((current) => ({
        ...current,
        anchorId: null,
        focusId: null,
        selection: null,
      }))
      setStatus('collapsedSelection')
    }
    setRovingId(nextRovingId)
    pendingRovingFocus.current = nextRovingId
    setShowAllRows(false)
  }

  const renderEditor = () => review.selection && (
    <div
      data-diff-editor=""
      className="sticky z-[2] my-1.5 min-w-[280px] max-w-3xl overflow-hidden rounded-[10px] bg-[var(--color-surface-container-low)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-text-primary)_9%,transparent)]"
      style={{
        left: 'var(--workspace-diff-gutter-width)',
        width: 'min(48rem, calc(100cqi - var(--workspace-diff-gutter-width) - 0.75rem))',
      }}
    >
      <div className="flex min-h-10 items-center gap-2 px-3 pt-2.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]">
          <MessageSquare aria-hidden="true" size={14} />
        </span>
        <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">{t('workspace.localComment')}</div>
        <div className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
          {sideLabel(review.selection.side)} L{review.selection.lineStart}{review.selection.lineEnd === review.selection.lineStart ? '' : `-L${review.selection.lineEnd}`}
        </div>
      </div>
      {status && (
        <div role="status" aria-live="polite" className="px-3 pt-1.5 text-[11px] text-[var(--color-warning)]">
          {t(`workspace.diffReview.${status}`)}
        </div>
      )}
      <textarea
        ref={editorRef}
        aria-label={t('workspace.diffReview.editorLabel')}
        value={review.draft}
        placeholder={t('workspace.commentPlaceholder')}
        onChange={(event) => setReview((current) => ({ ...current, draft: event.target.value }))}
        onKeyDown={handleEditorKeyDown}
        rows={2}
        className="block min-h-0 w-full resize-y bg-transparent px-3 py-2 font-[var(--font-body)] text-[13px] leading-5 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
      />
      <div className="flex items-center justify-end gap-2 px-2 pb-2">
        <button
          type="button"
          onClick={closeEditor}
          className="inline-flex h-8 items-center justify-center rounded-[7px] px-3 text-[12px] font-medium text-[var(--color-text-secondary)] transition-[color,background-color,transform] duration-200 ease-out hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          aria-label={t('workspace.diffReview.submitAria')}
          disabled={!review.draft.trim()}
          onClick={submitComment}
          className="inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-[7px] bg-[var(--color-info)] px-3 text-[12px] font-medium text-[var(--color-surface)] transition-[opacity,transform] duration-200 ease-out hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35"
        >
          <CornerDownLeft aria-hidden="true" size={14} />
          <span>{t('workspace.diffReview.submit')}</span>
        </button>
      </div>
    </div>
  )

  return (
    <div data-testid="workspace-diff-scroll" className={className} style={{ containerType: 'inline-size' }}>
      <div data-testid="workspace-diff-content" className="relative min-w-full w-max pb-3">
        <div
          data-workspace-code=""
          data-testid="workspace-code"
          data-highlight-engine={highlightResult.engine}
          role="grid"
          aria-label={`${path} diff`}
          className="m-0 min-w-full font-[var(--font-mono)] text-[13px] leading-5 text-[var(--color-code-fg)]"
          style={codeStyle}
        >
          {files.map((file) => {
            const headerVisible = showFileHeaders && visibleItemIds.has(`${file.id}-header`)
            const fileRows = file.rows.filter((row) => visibleItemIds.has(row.id) && !isStructuralMetadata(row))
            if (!headerVisible && fileRows.length === 0) return null
            const oldPath = file.oldPath ? `a/${file.oldPath}` : '/dev/null'
            const newPath = file.newPath ? `b/${file.newPath}` : '/dev/null'
            const fileAdditions = file.rows.filter((row) => row.kind === 'addition').length
            const fileDeletions = file.rows.filter((row) => row.kind === 'deletion').length
            const displayPath = file.newPath ?? file.oldPath ?? path
            const displayName = displayPath.split('/').pop() ?? displayPath
            const displayDirectory = displayPath.slice(0, Math.max(0, displayPath.length - displayName.length))
            return (
              <div key={file.id}>
                {headerVisible && (
                  <div
                    data-testid="workspace-diff-file-header"
                    className="sticky top-0 z-10 flex h-10 items-center gap-2 border-b border-[var(--color-text-primary)]/10 bg-[var(--color-surface)]/96 px-4 text-[12px] backdrop-blur"
                  >
                    <FileCode2 aria-hidden="true" size={15} className="shrink-0 text-[var(--color-text-tertiary)]" />
                    <span className="min-w-0 truncate">
                      {displayDirectory && (
                        <span className="text-[var(--color-text-tertiary)]">{displayDirectory}</span>
                      )}
                      <span className="font-semibold text-[var(--color-text-primary)]">{displayName}</span>
                    </span>
                    <span className="ml-auto shrink-0 font-[var(--font-mono)] text-[11px] tabular-nums">
                      <span className="text-[var(--color-success)]">+{fileAdditions}</span>
                      <span className="ml-1.5 text-[var(--color-error)]">-{fileDeletions}</span>
                    </span>
                    <span className="sr-only">diff --git {oldPath} {newPath}</span>
                  </div>
                )}
                {fileRows.map((row) => {
                  const line = row.side === 'old' ? row.oldLine : row.newLine
                  const selected = selectedIds.has(row.id)
                  const selectionFocus = selected && row.id === review.focusId
                  const rangeEdge = selected
                    ? review.selection?.startId === review.selection?.endId
                      ? 'single'
                      : row.id === review.selection?.startId
                        ? 'start'
                        : row.id === review.selection?.endId
                          ? 'end'
                          : undefined
                    : undefined
                  return (
                    <Fragment key={row.id}>
                      <div
                        role="row"
                        aria-selected={selected}
                        data-diff-row-id={row.id}
                        data-range-edge={rangeEdge}
                        className={`group relative grid min-w-full w-max items-stretch ${row.kind === 'hunk' ? 'min-h-8' : 'min-h-5'} ${
                          selected ? 'bg-[var(--color-info-container)]' : rowTone(row)
                        }`}
                        style={{ gridTemplateColumns: 'var(--workspace-diff-gutter-width) minmax(max-content, 1fr)' }}
                      >
                        <span
                          data-diff-number-gutter=""
                          className={`sticky left-0 z-[1] flex min-h-full select-none items-center justify-end pl-[2ch] pr-[1ch] text-right text-[11px] text-[var(--color-text-tertiary)] ${gutterTone(row, selected)}`}
                        >
                          {selected && (
                            <span
                              data-diff-selection-rail=""
                              aria-hidden="true"
                              className={`absolute inset-y-0 left-0 w-[3px] bg-[var(--color-info)] ${
                                rangeEdge === 'single' ? 'rounded-sm' : rangeEdge === 'start' ? 'rounded-t-sm' : rangeEdge === 'end' ? 'rounded-b-sm' : ''
                              }`}
                            />
                          )}
                          <span
                            data-diff-line-number=""
                            className={`transition-opacity duration-100 group-hover:opacity-0 group-focus-within:opacity-0 ${selectionFocus ? 'opacity-0' : ''}`}
                          >
                            {line ?? ''}
                          </span>
                          {row.selectable && row.side && line !== null && (
                            <span
                              data-diff-gutter-utility-slot=""
                              className="absolute inset-y-0 right-0 flex items-center justify-end"
                            >
                              <button
                                ref={(element) => {
                                  if (element) buttonRefs.current.set(row.id, element)
                                  else buttonRefs.current.delete(row.id)
                                }}
                                type="button"
                                aria-label={t('workspace.diffReview.commentLineAria', {
                                  path,
                                  side: sideLabel(row.side),
                                  line,
                                })}
                                aria-pressed={selected}
                                data-selection-focus={selectionFocus ? 'true' : undefined}
                                tabIndex={row.id === rovingId ? 0 : -1}
                                onClick={(event) => handleRowClick(event, row)}
                                onFocus={() => setRovingId(row.id)}
                                onKeyDown={(event) => handleRowKeyDown(event, row)}
                                className={`relative right-[calc(1ch-1.25rem)] inline-flex h-5 w-5 items-center justify-center rounded-[4px] transition-[color,background-color,opacity,transform] duration-100 ease-out before:absolute before:-inset-1 hover:bg-[var(--color-info)] hover:text-[var(--color-surface)] active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[var(--color-info)] ${
                                  selectionFocus ? 'bg-[var(--color-info)] text-[var(--color-surface)] opacity-100' : 'text-[var(--color-text-tertiary)] opacity-0 group-hover:opacity-100 focus:opacity-100'
                                }`}
                              >
                                {selected ? <MessageSquare aria-hidden="true" size={12} /> : <Plus aria-hidden="true" size={13} />}
                              </button>
                            </span>
                          )}
                        </span>
                        <span
                          data-row-text={row.text}
                          data-selected={selected ? 'true' : undefined}
                          className="whitespace-pre self-center pr-6"
                        >
                          <span className={`inline-block w-[2ch] select-none text-center ${prefixTone(row)}`}>{row.prefix || ' '}</span>
                          <span className={codeTone(row)}>
                            {row.selectable && row.text && highlightResult.tokensByRowId[row.id]
                              ? (
                                  <HighlightedDiffLine
                                    row={row}
                                    tokens={highlightResult.tokensByRowId[row.id]!}
                                    wordRanges={highlightResult.wordRangesByRowId[row.id] ?? []}
                                  />
                                )
                              : row.text || ' '}
                          </span>
                        </span>
                      </div>
                      {review.selection?.endId === row.id ? renderEditor() : null}
                    </Fragment>
                  )
                })}
              </div>
            )
          })}
        </div>

        {status && !review.selection && (
          <div className="sticky bottom-0 border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2">
            <div role="status" aria-live="polite" className="text-[11px] text-[var(--color-warning)]">
              {t(`workspace.diffReview.${status}`)}
            </div>
          </div>
        )}

        {displayItemIds.length > lineLimit && (
          <div className="sticky bottom-0 flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
            <span>
              {showAllRows
                ? t('workspace.previewAllLines', { total: displayItemIds.length })
                : t('workspace.previewLineLimit', { count: visibleItemIds.size, total: displayItemIds.length })}
            </span>
            <button
              type="button"
              onClick={toggleRows}
              className="ml-auto h-7 rounded-[5px] px-2 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              {showAllRows ? t('workspace.collapsePreview') : t('workspace.showAllLoadedLines')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
