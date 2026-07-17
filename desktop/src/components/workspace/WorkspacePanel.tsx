import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { CircleAlert, Code2, File as FileIcon, FileText, FolderOpen, Image as ImageIcon, MessageCircle, PanelRightClose, PanelRightOpen, RefreshCw, Search, Settings2, X, type LucideIcon } from 'lucide-react'
import { Highlight } from 'prism-react-renderer'
import {
  sessionsApi,
  type WorkspaceSearchResult,
  type WorkspaceChangedFile,
  type WorkspaceFileStatus,
  type WorkspaceTreeEntry,
  type WorkspaceTreeResult,
} from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { useShallow } from 'zustand/react/shallow'
import {
  useWorkspacePanelStore,
  type WorkspacePreviewCloseScope,
  type WorkspacePreviewKind,
  type WorkspacePreviewTab,
} from '../../stores/workspacePanelStore'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { useUIStore } from '../../stores/uiStore'
import { copyTextToClipboard } from '../chat/clipboard'
import { clearWindowSelection, getSelectionPopoverPosition, useSelectionPopoverDismiss } from '../../hooks/useSelectionPopoverDismiss'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import {
  getFileExtension,
  normalizePrismLanguage,
  WORKSPACE_PREVIEW_LINE_LIMIT,
  WorkspaceDiffSurface,
  workspacePrismTheme,
  type WorkspaceDiffCommentSelection,
} from './WorkspaceCodeSurface'
import { WorkspaceFileOpenWith } from './WorkspaceFileOpenWith'
import { getFileIdentity, getWorkspaceStatusLabel, type WorkspaceFileIdentity } from './fileIdentity'
import type { WorkspaceDiffHighlightToken } from './workspaceDiffHighlighter'

type WorkspacePanelProps = {
  sessionId: string
  /**
   * When hosted inside the unified WorkbenchPanel, the close action lives in the
   * shared workbench mode strip. Set this to drop WorkspacePanel's own close
   * button so the panel header doesn't render a duplicate close control.
   */
  embedded?: boolean
  /**
   * Main-content workbench tabs reuse the same workspace preview UI without
   * depending on the right-side panel's open bit.
   */
  forceVisible?: boolean
}

type TreeNodeProps = {
  sessionId: string
  entry: WorkspaceTreeEntry
  depth: number
  expandedPaths: Set<string>
  treeByPath: Record<string, WorkspaceTreeResult | undefined>
  treeLoadingByPath: Record<string, boolean | undefined>
  treeErrorsByPath: Record<string, string | null | undefined>
  filterQuery: string
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onFileContextMenu: (event: MouseEvent, path: string, isDirectory: boolean) => void
  activePath: string | null
}

type FileContextMenuState = {
  path: string
  isDirectory: boolean
  x: number
  y: number
}

const FILE_STATUS_META: Record<WorkspaceFileStatus, { label: string; className: string }> = {
  modified: {
    label: 'M',
    className: 'text-[var(--color-warning)]',
  },
  added: {
    label: 'A',
    className: 'text-[var(--color-success)]',
  },
  deleted: {
    label: 'D',
    className: 'text-[var(--color-error)]',
  },
  renamed: {
    label: 'R',
    className: 'text-[var(--color-info)]',
  },
  untracked: {
    label: 'U',
    className: 'text-[var(--color-info)]',
  },
  copied: {
    label: 'C',
    className: 'text-[var(--color-info)]',
  },
  type_changed: {
    label: 'T',
    className: 'text-[var(--color-text-secondary)]',
  },
  unknown: {
    label: '?',
    className: 'text-[var(--color-text-secondary)]',
  },
}

const FILE_IDENTITY_ICONS: Record<WorkspaceFileIdentity['icon'], LucideIcon> = {
  code: Code2,
  config: Settings2,
  document: FileText,
  image: ImageIcon,
  file: FileIcon,
}

const EMPTY_TREE_BY_PATH: Record<string, WorkspaceTreeResult | undefined> = {}
const EMPTY_PREVIEW_TABS: WorkspacePreviewTab[] = []
const EMPTY_EXPANDED_PATHS: string[] = []
const SELECTION_MENU_OFFSET = 10
const SELECTION_MENU_WIDTH = 158
const SELECTION_MENU_HEIGHT = 44
const WORKSPACE_SEARCH_DEBOUNCE_MS = 250
const FILE_BADGE_META: Record<string, { label: string; className: string }> = {
  ts: { label: 'TS', className: 'bg-[var(--color-secondary)]/14 text-[var(--color-secondary)]' },
  tsx: { label: 'TSX', className: 'bg-[var(--color-secondary)]/14 text-[var(--color-secondary)]' },
  js: { label: 'JS', className: 'bg-[var(--color-warning)]/16 text-[var(--color-warning)]' },
  jsx: { label: 'JSX', className: 'bg-[var(--color-warning)]/16 text-[var(--color-warning)]' },
  json: { label: '{}', className: 'bg-[var(--color-tertiary)]/14 text-[var(--color-tertiary)]' },
  md: { label: 'MD', className: 'bg-[var(--color-text-tertiary)]/14 text-[var(--color-text-secondary)]' },
  css: { label: 'CSS', className: 'bg-[var(--color-secondary)]/14 text-[var(--color-secondary)]' },
  html: { label: 'H', className: 'bg-[var(--color-brand)]/14 text-[var(--color-brand)]' },
  png: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  jpg: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  jpeg: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  gif: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  svg: { label: 'SVG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
}

function makeTreeStateKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

function makePreviewStateKey(sessionId: string, tabId: string) {
  return `${sessionId}::${tabId}`
}

function getSessionScopedRecord<T>(
  record: Record<string, T>,
  sessionId: string,
) {
  const prefix = `${sessionId}::`
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key.startsWith(prefix)),
  ) as Record<string, T>
}

function getPreviewKindLabel(
  t: ReturnType<typeof useTranslation>,
  kind: WorkspacePreviewKind,
) {
  return kind === 'diff' ? t('workspace.previewKind.diff') : t('workspace.previewKind.file')
}

function getFileBadgeMeta(name: string) {
  const extension = getFileExtension(name)
  return FILE_BADGE_META[extension] ?? {
    label: extension ? extension.slice(0, 3).toUpperCase() : 'TXT',
    className: 'bg-[var(--color-text-tertiary)]/12 text-[var(--color-text-secondary)]',
  }
}

function resolveWorkspaceAttachmentPath(workDir: string | undefined, filePath: string) {
  if (!workDir || filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath)) return filePath
  return `${workDir.replace(/[\\/]+$/, '')}/${filePath.replace(/^[/\\]+/, '')}`
}

function getWorkspaceReferenceName(path: string, isDirectory = false) {
  const name = path.split('/').filter(Boolean).pop() || path
  return isDirectory && !name.endsWith('/') ? `${name}/` : name
}

function isMarkdownPreview(tab: WorkspacePreviewTab) {
  if (tab.kind !== 'file') return false
  const language = (tab.language ?? '').toLowerCase()
  const extension = getFileExtension(tab.path)
  return language === 'markdown' || language === 'md' || extension === 'md' || extension === 'markdown'
}

function FileTypeBadge({ name, subtle = false }: { name: string; subtle?: boolean }) {
  const meta = getFileBadgeMeta(name)
  return (
    <span
      className={`inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] px-1 font-[var(--font-label)] text-[9px] font-semibold leading-none ${meta.className} ${subtle ? 'opacity-55 grayscale' : ''}`}
      aria-hidden="true"
    >
      {meta.label}
    </span>
  )
}

function getInlineStateMessage(
  t: ReturnType<typeof useTranslation>,
  state: WorkspacePreviewTab['state'] | WorkspaceTreeResult['state'] | 'not_git_repo' | undefined,
  fallbackError?: string | null,
) {
  switch (state) {
    case 'loading':
      return t('workspace.previewState.loading')
    case 'binary':
      return t('workspace.previewState.binary')
    case 'too_large':
      return t('workspace.previewState.tooLarge')
    case 'missing':
      return t('workspace.previewState.missing')
    case 'not_git_repo':
      return t('workspace.notGitRepo')
    case 'error':
      return fallbackError || t('workspace.loadError')
    default:
      return fallbackError || t('workspace.loadError')
  }
}

function normalizeFilterQuery(query: string) {
  return query.trim().toLowerCase()
}

function changedFileMatchesFilter(file: WorkspaceChangedFile, query: string) {
  if (!query) return true
  return (
    file.path.toLowerCase().includes(query)
    || file.oldPath?.toLowerCase().includes(query)
    || file.status.toLowerCase().includes(query)
  )
}

function groupChangedFiles(files: WorkspaceChangedFile[]) {
  const groups = new Map<string, WorkspaceChangedFile[]>()
  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/')
    const lastSlash = normalizedPath.lastIndexOf('/')
    const directory = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : ''
    const group = groups.get(directory)
    if (group) group.push(file)
    else groups.set(directory, [file])
  }
  return Array.from(groups, ([directory, groupedFiles]) => ({ directory, files: groupedFiles }))
    .sort((a, b) => a.directory.localeCompare(b.directory))
}

function treeEntryMatchesFilter(
  entry: WorkspaceTreeEntry,
  query: string,
  treeByPath: Record<string, WorkspaceTreeResult | undefined>,
): boolean {
  if (!query) return true
  if (entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query)) {
    return true
  }

  if (!entry.isDirectory) return false
  const childTree = treeByPath[entry.path]
  if (childTree?.state !== 'ok') return false
  return childTree.entries.some((child) => treeEntryMatchesFilter(child, query, treeByPath))
}

type WorkspaceTextSelection = {
  text: string
  startLine?: number
  endLine?: number
}

type FloatingSelectionMenuState = WorkspaceTextSelection & {
  x: number
  y: number
}

type SelectionPointer = {
  clientX: number
  clientY: number
}

function getElementForNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function getLineNumberFromNode(node: Node | null, root: HTMLElement) {
  const element = getElementForNode(node)
  const row = element?.closest('[data-workspace-line-number]')
  if (!row || !root.contains(row)) return undefined
  const line = Number(row.getAttribute('data-workspace-line-number'))
  return Number.isFinite(line) ? line : undefined
}

function getSelectionPosition(range: Range, root: HTMLElement, pointer?: SelectionPointer) {
  return getSelectionPopoverPosition(range, root, {
    menuWidth: SELECTION_MENU_WIDTH,
    menuHeight: SELECTION_MENU_HEIGHT,
    offset: SELECTION_MENU_OFFSET,
    fallbackPointer: pointer,
  })
}

function getTextSelectionFromContainer(
  root: HTMLElement | null,
  resolveLines?: (text: string, range: Range) => { startLine?: number; endLine?: number },
  pointer?: SelectionPointer,
): FloatingSelectionMenuState | null {
  if (!root) return null

  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const startElement = getElementForNode(range.startContainer)
  const endElement = getElementForNode(range.endContainer)
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) {
    return null
  }

  const text = selection.toString().trim()
  if (!text) return null

  const nodeLines = {
    startLine: getLineNumberFromNode(range.startContainer, root),
    endLine: getLineNumberFromNode(range.endContainer, root),
  }
  const resolvedLines = resolveLines?.(text, range) ?? nodeLines
  const startLine = resolvedLines.startLine ?? nodeLines.startLine
  const endLine = resolvedLines.endLine ?? nodeLines.endLine ?? startLine
  const orderedStart = startLine && endLine ? Math.min(startLine, endLine) : startLine
  const orderedEnd = startLine && endLine ? Math.max(startLine, endLine) : endLine

  return {
    ...getSelectionPosition(range, root, pointer),
    text,
    ...(orderedStart ? { startLine: orderedStart } : {}),
    ...(orderedEnd ? { endLine: orderedEnd } : {}),
  }
}

function getLineRangeForText(value: string, text: string) {
  const index = value.indexOf(text)
  if (index < 0) return {}
  const startLine = value.slice(0, index).split('\n').length
  const endLine = startLine + text.split('\n').length - 1
  return { startLine, endLine }
}

function FloatingSelectionMenu({
  selection,
  onAdd,
  popoverRef,
}: {
  selection: FloatingSelectionMenuState | null
  onAdd: () => void
  popoverRef: { current: HTMLButtonElement | null }
}) {
  const t = useTranslation()
  if (!selection) return null

  return (
    <button
      ref={popoverRef}
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAdd}
      className="fixed z-50 inline-flex h-11 items-center gap-2 rounded-full border border-[var(--color-border)]/70 bg-[var(--color-surface-container-lowest)] px-5 text-[15px] font-semibold text-[var(--color-text-primary)] shadow-[0_10px_28px_rgba(15,23,42,0.14),0_2px_8px_rgba(15,23,42,0.08)] transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
      style={{ left: selection.x, top: selection.y }}
    >
      <MessageCircle size={21} strokeWidth={2.15} className="shrink-0 text-[var(--color-text-primary)]" aria-hidden="true" />
      <span>{t('workspace.addSelectionToChat')}</span>
    </button>
  )
}

function PanelMessage({
  icon,
  message,
  tone = 'muted',
  compact = false,
  announce = true,
}: {
  icon: string
  message: string
  tone?: 'muted' | 'error'
  compact?: boolean
  announce?: boolean
}) {
  const toneClass =
    tone === 'error'
      ? 'text-[var(--color-error)]'
      : 'text-[var(--color-text-tertiary)]'

  return (
    <div
      className={`flex items-center gap-2 px-4 ${compact ? 'py-2 text-[11px]' : 'py-8 text-xs'} ${toneClass}`}
      role={announce ? tone === 'error' ? 'alert' : 'status' : undefined}
    >
      <span className={`material-symbols-outlined shrink-0 text-[16px] ${icon === 'progress_activity' ? 'animate-spin' : ''}`}>
        {icon}
      </span>
      <span className="min-w-0 leading-relaxed">{message}</span>
    </div>
  )
}

function ToolbarIconButton({
  Icon,
  label,
  onClick,
}: {
  Icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)]/30"
    >
      <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
    </button>
  )
}

function WorkspaceFilterInput({
  value,
  onChange,
  summary,
  mode,
  loading = false,
  inputRef,
  onFocusFirstResult,
}: {
  value: string
  onChange: (value: string) => void
  summary?: string
  mode: 'changed' | 'all'
  loading?: boolean
  inputRef: RefObject<HTMLInputElement>
  onFocusFirstResult?: () => void
}) {
  const t = useTranslation()
  const placeholder = mode === 'all'
    ? t('workspace.searchAllPlaceholder')
    : t('workspace.filterChangedPlaceholder')

  return (
    <div className="shrink-0 border-b border-[var(--color-text-primary)]/10 px-3 pb-2.5 pt-2.5">
      <div className="flex h-9 items-center gap-2 rounded-[7px] bg-[var(--color-surface-container-low)] px-2.5 text-[var(--color-text-tertiary)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] transition-[background-color,box-shadow] duration-200 ease-out focus-within:bg-[var(--color-surface)] focus-within:shadow-[inset_0_0_0_1px_var(--color-info),0_0_0_3px_color-mix(in_srgb,var(--color-info)_12%,transparent)]">
        <Search size={15} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value) {
              event.preventDefault()
              onChange('')
            } else if (event.key === 'ArrowDown' && onFocusFirstResult) {
              event.preventDefault()
              onFocusFirstResult()
            }
          }}
          aria-label={placeholder}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        />
        {loading && (
          <RefreshCw size={13} aria-hidden="true" className="shrink-0 animate-spin" />
        )}
        {value.length > 0 && (
          <button
            type="button"
            aria-label={t('workspace.clearFilter')}
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      {summary && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 px-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]"
        >
          {summary}
        </div>
      )}
    </div>
  )
}

function FileStatusBadge({ status }: { status: WorkspaceFileStatus }) {
  const t = useTranslation()
  const meta = FILE_STATUS_META[status]
  return (
    <span
      className={`inline-flex h-5 w-4 shrink-0 items-center justify-center font-[var(--font-mono)] text-[10px] font-semibold ${meta.className}`}
      aria-label={getWorkspaceStatusLabel(status, t)}
    >
      {meta.label}
    </span>
  )
}

function workspaceCodeTokenStyle(token: WorkspaceDiffHighlightToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
  }
}

function CodeSurface({
  value,
  language,
  onAddLineComment,
  onAddSelection,
}: {
  value: string
  language: string
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

  useEffect(() => {
    if (usePlainLargePreview) {
      setShikiTokensByLine(null)
      return
    }

    let cancelled = false
    setShikiTokensByLine(null)
    void import('./workspaceDiffHighlighter')
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
      <div className="grid grid-cols-[48px_minmax(0,720px)] gap-3 bg-[var(--color-brand)]/10 px-3 py-2">
        <span aria-hidden="true" />
        <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-sm">
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
            <button
              type="button"
              onClick={() => {
                setCommentRange(null)
                setCommentDraft('')
              }}
              className="rounded-[7px] px-2.5 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={submitLineComment}
              disabled={!commentDraft.trim()}
              className="rounded-[7px] bg-[var(--color-text-primary)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {t('workspace.addCommentToChat')}
            </button>
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

  const lineRowClassName = (lineNumber: number) => (
    `group grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-3 ${
      isCommentLineSelected(lineNumber)
        ? 'bg-[var(--color-info-container)]'
        : 'hover:bg-[var(--color-surface-hover)]'
    }`
  )

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
        className={`select-none text-right text-[11px] transition-colors focus-visible:outline-none ${
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
            className="m-0 font-[var(--font-mono)] text-[12px] leading-[1.55]"
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
            className="m-0 font-[var(--font-mono)] text-[12px] leading-[1.55]"
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
                className="m-0 font-[var(--font-mono)] text-[12px] leading-[1.55]"
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
            <button
              type="button"
              onClick={() => setShowAllLines((current) => !current)}
              className="ml-auto rounded-[6px] px-2 py-1 text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              {showAllLines ? t('workspace.collapsePreview') : t('workspace.showAllLoadedLines')}
            </button>
          </div>
        )}
      </div>
      <FloatingSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}

function MarkdownSurface({
  value,
  onAddSelection,
}: {
  value: string
  onAddSelection: (selection: WorkspaceTextSelection) => void
}) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const selectionMenuRef = useRef<HTMLButtonElement>(null)
  const [selectionMenu, setSelectionMenu] = useState<FloatingSelectionMenuState | null>(null)

  useEffect(() => {
    setSelectionMenu(null)
  }, [value])

  const dismissSelectionMenu = useCallback(() => {
    setSelectionMenu(null)
  }, [])

  useSelectionPopoverDismiss({
    active: Boolean(selectionMenu),
    popoverRef: selectionMenuRef,
    onDismiss: dismissSelectionMenu,
  })

  const handleSelectionMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    setSelectionMenu(getTextSelectionFromContainer(
      surfaceRef.current,
      (text) => getLineRangeForText(value, text),
      event,
    ))
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

  return (
    <div
      ref={surfaceRef}
      className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)]"
      onMouseUp={handleSelectionMouseUp}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelectionMenu(null)
      }}
    >
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        <MarkdownRenderer
          content={value}
          variant="document"
          className="workspace-markdown-preview prose-p:text-[14px] prose-p:leading-7 prose-h1:text-[24px] prose-h2:text-[18px] prose-h3:text-[15px] prose-code:text-[12px] prose-pre:my-4"
        />
      </div>
      <FloatingSelectionMenu selection={selectionMenu} onAdd={addCurrentSelectionToChat} popoverRef={selectionMenuRef} />
    </div>
  )
}

function ImagePreview({ tab }: { tab: WorkspacePreviewTab }) {
  const t = useTranslation()

  if (!tab.dataUrl) {
    return (
      <PanelMessage
        icon="image_not_supported"
        message={tab.error || t('workspace.imagePreviewUnavailable')}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)] p-4">
      <div className="flex min-h-full items-center justify-center">
        <img
          src={tab.dataUrl}
          alt={tab.path}
          className="max-h-full max-w-full rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] object-contain shadow-sm"
        />
      </div>
    </div>
  )
}

function ChangedFileRow({
  file,
  active,
  onClick,
  onContextMenu,
}: {
  file: WorkspaceChangedFile
  active: boolean
  onClick: () => void
  onContextMenu: (event: MouseEvent, path: string) => void
}) {
  const identity = getFileIdentity(file.path)
  const IdentityIcon = FILE_IDENTITY_ICONS[identity.icon]
  const fileName = file.path.replace(/\\/g, '/').split('/').pop() || file.path

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(event) => onContextMenu(event, file.path)}
      aria-current={active ? 'true' : undefined}
      data-workspace-file-row=""
      data-workspace-file-path={file.path}
      title={file.path}
      className={`group mx-2 flex w-[calc(100%-16px)] items-center gap-1.5 rounded-[5px] px-2 text-left transition-[background-color,transform] duration-150 ease-out active:scale-[0.99] ${
        file.oldPath ? 'min-h-11 py-1' : 'h-[30px]'
      } ${
        active
          ? 'bg-[var(--color-info-container)] shadow-[inset_3px_0_0_var(--color-info)]'
          : 'hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <span
        className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center text-[var(--color-text-tertiary)] transition-colors group-hover:text-[var(--color-text-secondary)]"
        title={identity.languageLabel}
      >
        <IdentityIcon aria-hidden="true" size={14} strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline">
          <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">{fileName}</span>
          <span className="sr-only">
            {identity.shortLabel}
            <span> {identity.languageLabel}</span>
          </span>
        </div>
        {file.oldPath && (
          <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-tertiary)]">
            {file.oldPath}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right font-[var(--font-mono)] text-[10px] leading-4">
        <span className="text-[var(--color-success)]">+{file.additions}</span>
        <span className="ml-1 text-[var(--color-error)]">-{file.deletions}</span>
      </div>
      <FileStatusBadge status={file.status} />
    </button>
  )
}

function moveWorkspaceSearchResultFocus(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  direction: 'next' | 'previous' | 'first' | 'last',
) {
  const list = event.currentTarget.closest('[data-workspace-search-results]')
  const results = list
    ? Array.from(list.querySelectorAll<HTMLButtonElement>('[data-workspace-search-result]'))
    : []
  if (results.length === 0) return

  const currentIndex = results.indexOf(event.currentTarget)
  const targetIndex = direction === 'first'
    ? 0
    : direction === 'last'
      ? results.length - 1
      : direction === 'next'
        ? Math.min(currentIndex + 1, results.length - 1)
        : Math.max(currentIndex - 1, 0)
  results[targetIndex]?.focus()
}

function WorkspaceSearchResultRow({
  entry,
  active,
  onOpen,
  onContextMenu,
  onClearSearch,
}: {
  entry: WorkspaceTreeEntry
  active: boolean
  onOpen: () => void
  onContextMenu: (event: MouseEvent, path: string, isDirectory: boolean) => void
  onClearSearch: () => void
}) {
  const normalizedPath = entry.path.replace(/\\/g, '/')
  const lastSlash = normalizedPath.lastIndexOf('/')
  const parentPath = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '.'

  return (
    <div role="listitem">
      <button
        type="button"
        data-workspace-search-result=""
        data-workspace-file-path={entry.path}
        aria-current={active ? 'true' : undefined}
        aria-label={`${entry.name}, ${parentPath}`}
        title={normalizedPath}
        onClick={onOpen}
        onContextMenu={(event) => onContextMenu(event, entry.path, false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'next')
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'previous')
          } else if (event.key === 'Home') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'first')
          } else if (event.key === 'End') {
            event.preventDefault()
            moveWorkspaceSearchResultFocus(event, 'last')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClearSearch()
          }
        }}
        className={`group mx-2 flex min-h-12 w-[calc(100%-16px)] items-start gap-2 rounded-[7px] px-2.5 py-2 text-left transition-[background-color,transform] duration-150 ease-out active:scale-[0.99] ${
          active
            ? 'bg-[var(--color-info-container)] shadow-[inset_3px_0_0_var(--color-info)]'
            : 'hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <FileTypeBadge name={entry.name} subtle={!active} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--color-text-primary)]">
            {entry.name}
          </span>
          <span className="mt-0.5 block truncate font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
            {parentPath}
          </span>
        </span>
      </button>
    </div>
  )
}

function TreeNode({
  sessionId,
  entry,
  depth,
  expandedPaths,
  treeByPath,
  treeLoadingByPath,
  treeErrorsByPath,
  filterQuery,
  onToggle,
  onOpenFile,
  onFileContextMenu,
  activePath,
}: TreeNodeProps) {
  const t = useTranslation()
  const childTree = treeByPath[entry.path]
  const childLoading = treeLoadingByPath[makeTreeStateKey(sessionId, entry.path)] ?? false
  const childError = treeErrorsByPath[makeTreeStateKey(sessionId, entry.path)] ?? null
  const isExpanded = expandedPaths.has(entry.path)
  const isVisuallyExpanded = isExpanded || filterQuery.length > 0
  const indent = 14 + depth * 20

  if (!entry.isDirectory) {
    const isActive = entry.path === activePath
    return (
      <button
        type="button"
        onClick={() => onOpenFile(entry.path)}
        onContextMenu={(event) => onFileContextMenu(event, entry.path, false)}
        aria-current={isActive ? 'true' : undefined}
        className={`group mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-[7px] pr-2 text-left transition-colors ${
          isActive
            ? 'bg-[var(--color-surface-selected)] shadow-[inset_0_0_0_1.5px_var(--color-border-focus)]'
            : 'hover:bg-[var(--color-surface-hover)]'
        }`}
        style={{ paddingLeft: indent }}
      >
        <FileTypeBadge name={entry.name} subtle={!isActive} />
        <span className="min-w-0 truncate text-[14px] font-medium text-[var(--color-text-primary)]">{entry.name}</span>
      </button>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(entry.path)}
        onContextMenu={(event) => onFileContextMenu(event, entry.path, true)}
        aria-expanded={isVisuallyExpanded}
        className="group mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-[7px] pr-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ paddingLeft: indent }}
      >
        <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[18px] text-[var(--color-text-tertiary)] transition-colors group-hover:text-[var(--color-text-primary)]">
          {isVisuallyExpanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span className="min-w-0 truncate text-[15px] font-medium text-[var(--color-text-primary)]">{entry.name}</span>
      </button>

      {isVisuallyExpanded && (
        <div className="relative">
          {depth < 4 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-1 top-1 w-px bg-[var(--color-border)]"
              style={{ left: 28 + depth * 20 }}
            />
          )}
          {childLoading && !childTree && (
            <PanelMessage
              compact
              icon="progress_activity"
              message={t('common.loading')}
            />
          )}

          {!childLoading && childError && (
            <PanelMessage compact icon="error" tone="error" message={childError} />
          )}

          {!childLoading && !childError && childTree?.state === 'missing' && (
            <PanelMessage compact icon="folder_off" message={t('workspace.previewState.missing')} />
          )}

          {!childLoading && !childError && childTree?.state === 'error' && (
            <PanelMessage
              compact
              icon="error"
              tone="error"
              message={childTree.error || t('workspace.loadError')}
            />
          )}

          {!childLoading && !childError && childTree?.state === 'ok' && childTree.entries.length === 0 && (
            <PanelMessage compact icon="folder_open" message={t('workspace.noFiles')} />
          )}

          {!childLoading && !childError && childTree?.state === 'ok' && childTree.entries
            .filter((childEntry) => treeEntryMatchesFilter(childEntry, filterQuery, treeByPath))
            .map((childEntry) => (
              <TreeNode
                key={childEntry.path}
                sessionId={sessionId}
                entry={childEntry}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                treeByPath={treeByPath}
                treeLoadingByPath={treeLoadingByPath}
                treeErrorsByPath={treeErrorsByPath}
                filterQuery={filterQuery}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onFileContextMenu={onFileContextMenu}
                activePath={activePath}
              />
            ))}
        </div>
      )}
    </div>
  )
}

export function WorkspacePanel({ sessionId, embedded = false, forceVisible = false }: WorkspacePanelProps) {
  const t = useTranslation()
  const addToast = useUIStore((state) => state.addToast)
  const [filterQuery, setFilterQuery] = useState('')
  const [workspaceSearch, setWorkspaceSearch] = useState<WorkspaceSearchResult | null>(null)
  const [workspaceSearchLoading, setWorkspaceSearchLoading] = useState(false)
  const [workspaceSearchError, setWorkspaceSearchError] = useState<string | null>(null)
  const [workspaceSearchRevision, setWorkspaceSearchRevision] = useState(0)
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false)
  const [isNavigatorOpen, setIsNavigatorOpen] = useState(forceVisible)
  const [previewTabContextMenu, setPreviewTabContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null)
  const width = useWorkspacePanelStore((state) => state.width)
  const isOpen = useWorkspacePanelStore((state) => state.isPanelOpen(sessionId))
  const activeView = useWorkspacePanelStore((state) => state.getActiveView(sessionId))
  const status = useWorkspacePanelStore((state) => state.statusBySession[sessionId])
  const treeByPath = useWorkspacePanelStore((state) => state.treeBySessionPath[sessionId] ?? EMPTY_TREE_BY_PATH)
  const previewTabs = useWorkspacePanelStore((state) => state.previewTabsBySession[sessionId] ?? EMPTY_PREVIEW_TABS)
  const activePreviewTabId = useWorkspacePanelStore((state) => state.activePreviewTabIdBySession[sessionId] ?? null)
  const expandedPaths = useWorkspacePanelStore((state) => state.expandedPathsBySession[sessionId] ?? EMPTY_EXPANDED_PATHS)
  const statusLoading = useWorkspacePanelStore((state) => state.loading.statusBySession[sessionId] ?? false)
  const treeLoadingByPath = useWorkspacePanelStore(
    useShallow((state) => getSessionScopedRecord(state.loading.treeBySessionPath, sessionId)),
  )
  const statusError = useWorkspacePanelStore((state) => state.errors.statusBySession[sessionId] ?? null)
  const treeErrorsByPath = useWorkspacePanelStore(
    useShallow((state) => getSessionScopedRecord(state.errors.treeBySessionPath, sessionId)),
  )
  const setActiveView = useWorkspacePanelStore((state) => state.setActiveView)
  const loadStatus = useWorkspacePanelStore((state) => state.loadStatus)
  const loadTree = useWorkspacePanelStore((state) => state.loadTree)
  const toggleTreeNode = useWorkspacePanelStore((state) => state.toggleTreeNode)
  const openPreview = useWorkspacePanelStore((state) => state.openPreview)
  const closePreview = useWorkspacePanelStore((state) => state.closePreview)
  const closePreviewTabs = useWorkspacePanelStore((state) => state.closePreviewTabs)
  const closePanel = useWorkspacePanelStore((state) => state.closePanel)
  const addWorkspaceReference = useWorkspaceChatContextStore((state) => state.addReference)
  const chatState = useChatStore((state) => state.sessions[sessionId]?.chatState ?? 'idle')
  const shouldRender = forceVisible || isOpen
  const refreshLifecycleRef = useRef({
    sessionId,
    isOpen: false,
    chatState: 'idle',
  })
  const workspaceSearchRequestIdRef = useRef(0)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const previewHeaderRef = useRef<HTMLDivElement>(null)

  const rootTree = treeByPath['']
  const rootTreeKey = makeTreeStateKey(sessionId, '')
  const rootTreeLoading = treeLoadingByPath[rootTreeKey] ?? false
  const rootTreeError = treeErrorsByPath[rootTreeKey] ?? null
  const normalizedFilterQuery = normalizeFilterQuery(filterQuery)
  const activePreviewTab =
    previewTabs.find((tab) => tab.id === activePreviewTabId) ?? previewTabs[previewTabs.length - 1] ?? null
  const hasPreviewTabs = previewTabs.length > 0
  const isNavigatorVisible = !hasPreviewTabs || isNavigatorOpen
  const navigatorView = activeView
  const hasWorkspaceSearch = navigatorView === 'all' && normalizedFilterQuery.length > 0
  const activeWorkspaceSearch = workspaceSearch
    && normalizeFilterQuery(workspaceSearch.query) === normalizedFilterQuery
    ? workspaceSearch
    : null
  const displayedWorkspaceSearch = activeWorkspaceSearch ?? workspaceSearch
  const expandedPathSet = new Set(expandedPaths)
  const activeTreePath = activePreviewTab?.kind === 'file' ? activePreviewTab.path : null
  const activeChangedFile = activePreviewTab
    ? status?.changedFiles.find((file) => file.path === activePreviewTab.path) ?? null
    : null
  const filteredChangedFiles = useMemo(
    () => (status?.changedFiles ?? []).filter((file) => changedFileMatchesFilter(file, normalizedFilterQuery)),
    [normalizedFilterQuery, status?.changedFiles],
  )
  const changedFileGroups = useMemo(
    () => groupChangedFiles(filteredChangedFiles),
    [filteredChangedFiles],
  )
  const filteredRootEntries = useMemo(
    () => rootTree?.state === 'ok'
      ? rootTree.entries.filter((entry) => treeEntryMatchesFilter(entry, normalizedFilterQuery, treeByPath))
      : [],
    [normalizedFilterQuery, rootTree, treeByPath],
  )
  const visibleEntryCount = filteredChangedFiles.length
  const totalEntryCount = status?.changedFiles.length ?? 0
  const filterSummary = navigatorView === 'changed'
    ? normalizedFilterQuery
      ? t('workspace.filteredFilesCount', { visible: visibleEntryCount, total: totalEntryCount })
      : t('workspace.filesCount', { count: totalEntryCount })
    : !normalizedFilterQuery || workspaceSearchError
      ? undefined
      : workspaceSearchLoading || !activeWorkspaceSearch
        ? t('workspace.searching')
        : activeWorkspaceSearch.truncated
          ? t('workspace.searchResultsTruncated', { count: activeWorkspaceSearch.entries.length })
          : t('workspace.searchResultsCount', { count: activeWorkspaceSearch.entries.length })
  const activePreviewRequestKey = activePreviewTab
    ? makePreviewStateKey(sessionId, activePreviewTab.id)
    : null
  const activePreviewLoading = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.loading.previewByTabId[activePreviewRequestKey] ?? false : false,
  )
  const activePreviewError = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.errors.previewByTabId[activePreviewRequestKey] ?? null : null,
  )
  const activePreviewRefreshState = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.errors.previewRefreshStateByTabId[activePreviewRequestKey] ?? null : null,
  )

  useEffect(() => {
    const previous = refreshLifecycleRef.current
    const sessionChanged = previous.sessionId !== sessionId
    const opened = shouldRender && (sessionChanged || !previous.isOpen)
    const completedTurn =
      shouldRender &&
      !sessionChanged &&
      previous.chatState !== 'idle' &&
      chatState === 'idle'

    refreshLifecycleRef.current = { sessionId, isOpen: shouldRender, chatState }

    const shouldRefreshOnOpen = opened
    const shouldRefreshAfterCompletedTurn = completedTurn && chatState === 'idle'
    if ((!shouldRefreshOnOpen && !shouldRefreshAfterCompletedTurn) || statusLoading) return
    void loadStatus(sessionId)
  }, [chatState, loadStatus, sessionId, shouldRender, statusLoading])

  useEffect(() => {
    if (!shouldRender || !isNavigatorVisible || navigatorView !== 'all' || rootTree || rootTreeLoading || rootTreeError) return
    void loadTree(sessionId, '')
  }, [isNavigatorVisible, loadTree, navigatorView, rootTree, rootTreeError, rootTreeLoading, sessionId, shouldRender])

  useEffect(() => {
    const requestId = workspaceSearchRequestIdRef.current + 1
    workspaceSearchRequestIdRef.current = requestId

    if (!shouldRender || navigatorView !== 'all' || !normalizedFilterQuery) {
      if (!normalizedFilterQuery) setWorkspaceSearch(null)
      setWorkspaceSearchLoading(false)
      setWorkspaceSearchError(null)
      return
    }

    setWorkspaceSearchLoading(true)
    setWorkspaceSearchError(null)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void sessionsApi.searchWorkspace(sessionId, filterQuery.trim()).then((result) => {
        if (cancelled || workspaceSearchRequestIdRef.current !== requestId) return
        setWorkspaceSearch(result)
        setWorkspaceSearchLoading(false)
      }).catch((error) => {
        if (cancelled || workspaceSearchRequestIdRef.current !== requestId) return
        setWorkspaceSearchLoading(false)
        setWorkspaceSearchError(error instanceof Error ? error.message : t('workspace.loadError'))
      })
    }, WORKSPACE_SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [filterQuery, navigatorView, normalizedFilterQuery, sessionId, shouldRender, t, workspaceSearchRevision])

  useEffect(() => {
    if (!previewTabContextMenu && !fileContextMenu) return
    const close = () => {
      setPreviewTabContextMenu(null)
      setFileContextMenu(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [fileContextMenu, previewTabContextMenu])

  useEffect(() => {
    if (!hasPreviewTabs && isNavigatorOpen) {
      setIsNavigatorOpen(false)
    }
  }, [hasPreviewTabs, isNavigatorOpen])

  useEffect(() => {
    if (!isNavigatorVisible) {
      setIsViewMenuOpen(false)
    }
  }, [isNavigatorVisible])

  if (!shouldRender) return null

  const panelWidth = hasPreviewTabs ? width : Math.min(width, 520)
  const panelMaxWidth = hasPreviewTabs ? 'min(62%, calc(100% - 328px))' : '36%'
  const panelMinWidth = hasPreviewTabs ? 'min(420px, 54%)' : 'min(340px, 40%)'

  const handleRefresh = () => {
    void loadStatus(sessionId)
    if (activePreviewTab) {
      void openPreview(sessionId, activePreviewTab.path, activePreviewTab.kind)
    }
    if (hasWorkspaceSearch) {
      setWorkspaceSearchRevision((revision) => revision + 1)
    } else if (navigatorView === 'all') {
      void loadTree(sessionId, '')
    }
  }

  const focusPreviewAfterOpen = () => {
    window.setTimeout(() => previewHeaderRef.current?.focus(), 0)
  }

  const handleOpenDiff = (path: string) => {
    setIsNavigatorOpen(forceVisible)
    void openPreview(sessionId, path, 'diff')
    focusPreviewAfterOpen()
  }

  const handleOpenFile = (path: string) => {
    setIsNavigatorOpen(forceVisible)
    void openPreview(sessionId, path, 'file')
    focusPreviewAfterOpen()
  }

  const clearWorkspaceSearch = () => {
    setFilterQuery('')
    window.requestAnimationFrame(() => filterInputRef.current?.focus())
  }

  const focusFirstSearchResult = () => {
    document.querySelector<HTMLButtonElement>(
      `[data-testid="workspace-panel"] [data-workspace-search-result]`,
    )?.focus()
  }

  const addWorkspacePathToChat = (path: string, isDirectory = false) => {
    addWorkspaceReference(sessionId, {
      kind: 'file',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: getWorkspaceReferenceName(path, isDirectory),
      isDirectory,
    })
  }

  const addLineCommentToChat = (
    path: string,
    lineStart: number,
    lineEnd: number,
    note: string,
    quote: string,
  ) => {
    addWorkspaceReference(sessionId, {
      kind: 'code-comment',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
      lineStart,
      lineEnd,
      note,
      quote,
    })
  }

  const addDiffCommentToChat = (
    path: string,
    selection: WorkspaceDiffCommentSelection,
    note: string,
  ) => {
    addWorkspaceReference(sessionId, {
      kind: 'code-comment',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
      lineStart: selection.lineStart,
      lineEnd: selection.lineEnd,
      diffSide: selection.side,
      hunkId: selection.hunkId,
      note,
      quote: selection.quote,
    })
    requestAnimationFrame(() => {
      const composer = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="chat-input-shell"]'),
      ).find((element) => element.dataset.sessionId === sessionId)
      composer?.querySelector<HTMLTextAreaElement>('textarea:not([disabled])')?.focus()
    })
  }

  const addSelectionToChat = (path: string, selection: WorkspaceTextSelection) => {
    addWorkspaceReference(sessionId, {
      kind: 'code-selection',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
      lineStart: selection.startLine,
      lineEnd: selection.endLine,
      quote: selection.text,
    })
  }

  const handleSetActiveView = (view: 'changed' | 'all') => {
    setActiveView(sessionId, view)
    setIsViewMenuOpen(false)
  }

  const handlePreviewTabContextMenu = (event: MouseEvent, tabId: string) => {
    event.preventDefault()
    event.stopPropagation()
    setFileContextMenu(null)
    setPreviewTabContextMenu({ tabId, x: event.clientX, y: event.clientY })
  }

  const handleFileContextMenu = (event: MouseEvent, path: string, isDirectory = false) => {
    event.preventDefault()
    event.stopPropagation()
    setPreviewTabContextMenu(null)
    setFileContextMenu({ path, isDirectory, x: event.clientX, y: event.clientY })
  }

  const handleClosePreviewTabs = (scope: WorkspacePreviewCloseScope) => {
    if (!previewTabContextMenu) return
    closePreviewTabs(sessionId, previewTabContextMenu.tabId, scope)
    setPreviewTabContextMenu(null)
  }

  const copyWorkspacePath = async (path: string, mode: 'relative' | 'absolute' = 'relative') => {
    const pathToCopy = mode === 'absolute' ? resolveWorkspaceAttachmentPath(status?.workDir, path) : path
    const copied = await copyTextToClipboard(pathToCopy)
    setFileContextMenu(null)
    addToast({
      type: copied ? 'success' : 'error',
      message: copied ? t('workspace.pathCopied') : t('common.copyFailed'),
    })
  }

  const renderChangedView = () => {
    if (statusLoading && !status) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (status?.state === 'missing_workdir') {
      return <PanelMessage icon="folder_off" message={t('workspace.missingWorkdir')} />
    }

    if (status?.state === 'not_git_repo') {
      return <PanelMessage icon="account_tree" message={t('workspace.notGitRepo')} />
    }

    if (statusError || status?.state === 'error') {
      return (
        <PanelMessage
          icon="error"
          tone="error"
          message={statusError || status?.error || t('workspace.loadError')}
        />
      )
    }

    if (!status) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (status.changedFiles.length === 0) {
      return <PanelMessage icon="check_circle" message={t('workspace.noChanges')} />
    }

    if (filteredChangedFiles.length === 0) {
      return <PanelMessage icon="search_off" message={t('workspace.noMatchingFiles')} />
    }

    return (
      <div className="space-y-1">
        {changedFileGroups.map((group) => (
          <section key={group.directory || '__root__'}>
            {group.directory && (
              <div className="flex h-8 items-center gap-1.5 px-3.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
                <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 truncate">{group.directory}</span>
              </div>
            )}
            {group.files.map((file) => (
              <ChangedFileRow
                key={`${file.path}:${file.status}:${file.oldPath ?? ''}`}
                file={file}
                active={activePreviewTabId === `file:${file.path}` || activePreviewTabId === `diff:${file.path}`}
                onClick={() => handleOpenDiff(file.path)}
                onContextMenu={handleFileContextMenu}
              />
            ))}
          </section>
        ))}
      </div>
    )
  }

  const renderAllFilesView = () => {
    if (hasWorkspaceSearch) {
      if (workspaceSearchLoading && !displayedWorkspaceSearch) {
        return <PanelMessage announce={false} icon="progress_activity" message={t('workspace.searching')} />
      }
      if (workspaceSearchError && !displayedWorkspaceSearch) {
        return (
          <div role="alert" className="mx-3 my-3 rounded-[8px] border border-[var(--color-error)]/20 bg-[var(--color-error)]/6 p-3 text-[12px] text-[var(--color-error)]">
            <div className="flex items-start gap-2">
              <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 leading-5">{workspaceSearchError}</span>
            </div>
            <button
              type="button"
              onClick={() => setWorkspaceSearchRevision((revision) => revision + 1)}
              className="mt-2 rounded-[6px] border border-[var(--color-error)]/30 px-2 py-1 font-medium hover:bg-[var(--color-error)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-error)]/25"
            >
              {t('common.retry')}
            </button>
          </div>
        )
      }
      if (!displayedWorkspaceSearch) {
        return <PanelMessage announce={false} icon="progress_activity" message={t('workspace.searching')} />
      }
      if (!workspaceSearchLoading && activeWorkspaceSearch?.entries.length === 0) {
        return <PanelMessage announce={false} icon="search_off" message={t('workspace.noMatchingFiles')} />
      }

      return (
        <div
          role="list"
          aria-label={t('workspace.searchResults')}
          aria-busy={workspaceSearchLoading}
          data-workspace-search-results=""
          className="space-y-0.5 py-1"
        >
          {workspaceSearchError && (
            <div role="alert" className="mx-3 mb-2 flex items-center gap-2 rounded-[7px] bg-[var(--color-error)]/6 px-2.5 py-2 text-[11px] text-[var(--color-error)]">
              <CircleAlert size={14} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{workspaceSearchError}</span>
              <button
                type="button"
                onClick={() => setWorkspaceSearchRevision((revision) => revision + 1)}
                className="shrink-0 rounded-[5px] px-1.5 py-1 font-medium hover:bg-[var(--color-error)]/10"
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          {displayedWorkspaceSearch.entries.map((entry) => (
            <WorkspaceSearchResultRow
              key={entry.path}
              entry={entry}
              active={activeTreePath === entry.path}
              onOpen={() => handleOpenFile(entry.path)}
              onContextMenu={handleFileContextMenu}
              onClearSearch={clearWorkspaceSearch}
            />
          ))}
        </div>
      )
    }

    if (rootTreeLoading && !rootTree) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (rootTreeError) {
      return <PanelMessage icon="error" tone="error" message={rootTreeError} />
    }

    if (rootTree?.state === 'missing') {
      return <PanelMessage icon="folder_off" message={t('workspace.missingWorkdir')} />
    }

    if (rootTree?.state === 'error') {
      return <PanelMessage icon="error" tone="error" message={rootTree.error || t('workspace.loadError')} />
    }

    if (!rootTree) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (rootTree.entries.length === 0) {
      return <PanelMessage icon="folder_open" message={t('workspace.noFiles')} />
    }

    if (filteredRootEntries.length === 0) {
      return <PanelMessage icon="search_off" message={t('workspace.noMatchingFiles')} />
    }

    return (
      <div className="py-1">
        {filteredRootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            sessionId={sessionId}
            entry={entry}
            depth={0}
            expandedPaths={expandedPathSet}
            treeByPath={treeByPath}
            treeLoadingByPath={treeLoadingByPath}
            treeErrorsByPath={treeErrorsByPath}
            filterQuery={normalizedFilterQuery}
            onToggle={(path) => {
              void toggleTreeNode(sessionId, path)
            }}
            onOpenFile={handleOpenFile}
            onFileContextMenu={handleFileContextMenu}
            activePath={activeTreePath}
          />
        ))}
      </div>
    )
  }

  const renderPreviewContent = () => {
    if (!activePreviewTab) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-[var(--color-text-tertiary)]">
          {t('workspace.previewEmpty')}
        </div>
      )
    }

    const state = activePreviewTab.state ?? 'loading'
    const refreshErrorMessage = activePreviewError
      || (activePreviewRefreshState ? getInlineStateMessage(t, activePreviewRefreshState) : null)

    return (
      <div
        data-testid="workspace-preview-content"
        aria-busy={activePreviewLoading}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div
          ref={previewHeaderRef}
          tabIndex={-1}
          data-testid="workspace-preview-header"
          className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-text-primary)]/10 bg-[var(--color-surface)] px-3 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-info)]/35"
        >
          <FileText size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
          <span className="min-w-0 truncate font-medium text-[var(--color-text-primary)]">{activePreviewTab.path}</span>
          {activeChangedFile && (
            <span className="flex shrink-0 items-center gap-1.5 font-[var(--font-mono)] text-[11px] tabular-nums">
              <span className="text-[var(--color-success)]">+{activeChangedFile.additions}</span>
              <span className="text-[var(--color-error)]">-{activeChangedFile.deletions}</span>
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label={t('workspace.addToChat')}
              onClick={() => addWorkspacePathToChat(activePreviewTab.path)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[11px] font-medium text-[var(--color-text-secondary)] transition-[color,background-color,transform] duration-200 ease-out hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
            >
              <MessageCircle size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="hidden min-[960px]:inline">{t('workspace.addToChat')}</span>
            </button>
            <ToolbarIconButton Icon={RefreshCw} label={t('workspace.refresh')} onClick={handleRefresh} />
            <ToolbarIconButton
              Icon={isNavigatorVisible ? PanelRightClose : PanelRightOpen}
              label={isNavigatorVisible ? t('workspace.hideNavigator') : t('workspace.showNavigator')}
              onClick={() => setIsNavigatorOpen((open) => {
                const nextOpen = !open
                if (nextOpen) window.requestAnimationFrame(() => filterInputRef.current?.focus())
                return nextOpen
              })}
            />
            {previewTabs.length === 1 && (
              <ToolbarIconButton
                Icon={X}
                label={`${t('workspace.closeTab')} ${activePreviewTab.title} ${getPreviewKindLabel(t, activePreviewTab.kind)}`}
                onClick={() => closePreview(sessionId, activePreviewTab.id)}
              />
            )}
            {!embedded && (
              <ToolbarIconButton Icon={X} label={t('workspace.closePanel')} onClick={() => closePanel(sessionId)} />
            )}
            {activePreviewLoading && state === 'ok' && (
              <RefreshCw
                size={13}
                className="mx-1 shrink-0 animate-spin text-[var(--color-text-tertiary)]"
                aria-hidden="true"
              />
            )}
          </div>
        </div>

        {state === 'ok' && refreshErrorMessage && !activePreviewLoading && (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 border-b border-[var(--color-error)]/20 bg-[var(--color-error)]/6 px-3 py-2 text-[11px] text-[var(--color-error)]"
          >
            <CircleAlert size={15} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{refreshErrorMessage}</span>
            <button
              type="button"
              onClick={() => {
                void openPreview(sessionId, activePreviewTab.path, activePreviewTab.kind)
              }}
              className="shrink-0 rounded-[6px] border border-[var(--color-error)]/30 px-2 py-1 font-medium hover:bg-[var(--color-error)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-error)]/25"
            >
              {t('common.retry')}
            </button>
          </div>
        )}

        {state === 'loading' || (activePreviewLoading && state !== 'ok') ? (
          <PanelMessage icon="progress_activity" message={t('workspace.previewState.loading')} />
        ) : state === 'ok' && activePreviewTab.previewType === 'image' ? (
          <ImagePreview tab={activePreviewTab} />
        ) : state === 'ok' && activePreviewTab.kind === 'diff' ? (
          <WorkspaceDiffSurface
            value={activePreviewTab.diff ?? ''}
            path={activePreviewTab.path}
            hideSingleFileHeader
            onAddComment={(selection, note) => addDiffCommentToChat(activePreviewTab.path, selection, note)}
          />
        ) : state === 'ok' && isMarkdownPreview(activePreviewTab) ? (
          <MarkdownSurface
            value={activePreviewTab.content ?? ''}
            onAddSelection={(selection) => addSelectionToChat(activePreviewTab.path, selection)}
          />
        ) : state === 'ok' ? (
          <CodeSurface
            value={activePreviewTab.content ?? ''}
            language={activePreviewTab.language ?? 'text'}
            onAddLineComment={(lineStart, lineEnd, note, quote) => (
              addLineCommentToChat(activePreviewTab.path, lineStart, lineEnd, note, quote)
            )}
            onAddSelection={(selection) => addSelectionToChat(activePreviewTab.path, selection)}
          />
        ) : (
          <PanelMessage
            icon="error"
            tone={state === 'error' ? 'error' : 'muted'}
            message={getInlineStateMessage(t, state, activePreviewError || activePreviewTab.error || null)}
          />
        )}
      </div>
    )
  }

  const renderPreviewTabs = () => (
    <>
      <div className="flex h-9 shrink-0 items-end border-b border-[var(--color-text-primary)]/10 bg-[var(--color-surface)] px-3">
        <div
          role="tablist"
          aria-label={t('workspace.previewTabs')}
          className="flex min-w-0 flex-1 items-end gap-3 overflow-x-auto bg-[var(--color-surface)]"
        >
          {previewTabs.length === 0 ? (
            <div className="flex items-center gap-2 px-1.5 text-[12px] text-[var(--color-text-tertiary)]">
              <span className="material-symbols-outlined text-[15px]">docs</span>
              <span>{t('workspace.preview')}</span>
            </div>
          ) : (
            previewTabs.map((tab) => {
              const kindLabel = getPreviewKindLabel(t, tab.kind)
              const isActive = tab.id === activePreviewTab?.id

              return (
                <div
                  key={tab.id}
                  onContextMenu={(event) => handlePreviewTabContextMenu(event, tab.id)}
                  className={`group relative flex h-9 min-w-[96px] max-w-[220px] shrink-0 items-center gap-2 px-1 text-left text-[12px] transition-colors ${
                    isActive
                      ? 'text-[var(--color-text-primary)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--color-info)]'
                      : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => {
                      void openPreview(sessionId, tab.path, tab.kind)
                    }}
                    className="min-w-0 flex flex-1 items-center gap-2 text-left"
                  >
                    {tab.kind === 'diff' ? (
                      <span className="material-symbols-outlined shrink-0 text-[15px] text-[var(--color-text-tertiary)]">difference</span>
                    ) : (
                      <FileTypeBadge name={tab.title} subtle={!isActive} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('workspace.closeTab')} ${tab.title} ${kindLabel}`}
                    onClick={() => {
                      closePreview(sessionId, tab.id)
                    }}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-text-tertiary)] opacity-0 transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <span className="material-symbols-outlined text-[13px] leading-none">close</span>
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>

      {previewTabContextMenu && (
        <div
          role="menu"
          className="fixed z-50 min-w-[156px] rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 text-[12px] shadow-[var(--shadow-dropdown)]"
          style={{ left: previewTabContextMenu.x, top: previewTabContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('current')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('others')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('left')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('right')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('all')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeAll')}
          </button>
        </div>
      )}
    </>
  )

  return (
    <aside
      data-testid="workspace-panel"
      className={
        embedded
          ? 'flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--color-surface)]'
          : 'flex h-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]'
      }
      style={embedded ? undefined : { width: panelWidth, maxWidth: panelMaxWidth, minWidth: panelMinWidth }}
    >
      <div
        data-testid="workspace-review-layout"
        className={`relative grid min-h-0 flex-1 overflow-hidden ${hasPreviewTabs && isNavigatorVisible && forceVisible ? 'grid-cols-[minmax(0,1fr)_280px]' : 'grid-cols-1'}`}
      >
        {hasPreviewTabs && (
          <div data-testid="workspace-preview-column" className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--color-surface)]">
            {previewTabs.length > 1 ? renderPreviewTabs() : null}
            {renderPreviewContent()}
          </div>
        )}

        {isNavigatorVisible && (
          <div
            data-testid="workspace-file-navigator"
            className={`${hasPreviewTabs ? 'border-l border-[var(--color-text-primary)]/10' : ''} ${hasPreviewTabs && !forceVisible ? 'absolute inset-y-0 right-0 z-20 w-[min(280px,100%)] shadow-[-12px_0_28px_rgba(15,23,42,0.08)]' : ''} flex min-h-0 flex-col bg-[var(--color-surface)]`}
          >
            <header
              data-testid="workspace-file-navigator-header"
              className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-text-primary)]/10 px-3"
            >
              <div className="relative min-w-0">
              <button
                type="button"
                aria-label={activeView === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
                aria-haspopup="menu"
                aria-expanded={isViewMenuOpen}
                onClick={() => setIsViewMenuOpen((open) => !open)}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[7px] px-1 py-1 text-[14px] font-semibold leading-5 text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-info)]/30"
              >
                <span className="truncate">
                  {activeView === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
                </span>
                <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[15px] font-normal text-[var(--color-text-tertiary)]">expand_more</span>
              </button>
              {isViewMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-0 top-[calc(100%+4px)] z-30 min-w-[124px] overflow-hidden rounded-[9px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 shadow-[var(--shadow-dropdown)]"
                >
                  {(['changed', 'all'] as const).map((view) => {
                    const selected = activeView === view
                    return (
                      <button
                        key={view}
                        type="button"
                        role="menuitem"
                        onClick={() => handleSetActiveView(view)}
                        className={`flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px] transition-colors ${
                          selected ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {view === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
                        </span>
                        {selected && (
                          <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">check</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
              </div>
              {!hasPreviewTabs && (
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <ToolbarIconButton Icon={RefreshCw} label={t('workspace.refresh')} onClick={handleRefresh} />
                  {!embedded && (
                    <ToolbarIconButton Icon={X} label={t('workspace.closePanel')} onClick={() => closePanel(sessionId)} />
                  )}
                </div>
              )}
            </header>

            <WorkspaceFilterInput
              value={filterQuery}
              onChange={setFilterQuery}
              summary={normalizedFilterQuery ? filterSummary : undefined}
              mode={navigatorView}
              loading={hasWorkspaceSearch && workspaceSearchLoading}
              inputRef={filterInputRef}
              onFocusFirstResult={hasWorkspaceSearch ? focusFirstSearchResult : undefined}
            />

            <div className="min-h-0 flex-1 overflow-auto py-1.5">
              {navigatorView === 'changed' ? renderChangedView() : renderAllFilesView()}
            </div>
          </div>
        )}
      </div>

      {fileContextMenu && (
        <div
          role="menu"
          className="fixed z-50 min-w-[156px] rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 text-[12px] shadow-[var(--shadow-dropdown)]"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addWorkspacePathToChat(fileContextMenu.path, fileContextMenu.isDirectory)
              setFileContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">person_add</span>
            <span>{t('workspace.addToChat')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyWorkspacePath(fileContextMenu.path)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">content_copy</span>
            <span>{t('workspace.copyPath')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyWorkspacePath(fileContextMenu.path, 'absolute')}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">file_copy</span>
            <span>{t('workspace.copyAbsolutePath')}</span>
          </button>
          <WorkspaceFileOpenWith
            absolutePath={resolveWorkspaceAttachmentPath(status?.workDir, fileContextMenu.path)}
            sessionId={sessionId}
            workspacePath={fileContextMenu.isDirectory ? undefined : fileContextMenu.path}
            onAfterSelect={() => setFileContextMenu(null)}
          />
        </div>
      )}
    </aside>
  )
}
