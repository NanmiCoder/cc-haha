import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowLeft, Bot, CircleX, LocateFixed, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Spinner } from '@/components/ui/Spinner'
import { formatClockTime, formatDurationMs, formatTokenCount } from '../../lib/trace/formatters'
import { attachmentText, extractDetailContent } from '../../lib/trajectory/detailContent'
import { hasUsage, rowDurationMs, toolHasResult } from '../../lib/trajectory/viewModel'
import { formatBytes } from '../../lib/formatBytes'
import { cx } from '@/lib/cx'
import { TRAJECTORY_DETAIL_WIDTH_DEFAULT, TRAJECTORY_DETAIL_WIDTH_MIN, clampDetailWidth } from '../../stores/trajectoryViewStore'
import type { TrajectoryRow } from '../../types/trajectory'
import { KIND_LABEL_KEYS, KIND_TONES, KIND_VARIANTS, agentLabelFromInput, contextLabel, systemRowTitle, turnLabel } from './trajectoryLabels'
import { useRowDetail } from './useTrajectoryDetail'
import { DetailSection, JsonBlock, MarkdownText, MetaList, PlainText, type MetaItem } from './detail/DetailBlocks'
import { SnapshotDetail, snapshotTabs, type SnapshotTab } from './detail/SnapshotDetail'
import { RawRequestTab } from './detail/RawRequestTab'

type RowTab = 'overview' | 'preview' | 'input' | 'output' | 'raw' | 'request'
type DetailTab = RowTab | SnapshotTab

const TAB_LABEL_KEYS: Record<DetailTab, TranslationKey> = {
  overview: 'trajectory.tab.overview',
  preview: 'trajectory.tab.preview',
  input: 'trajectory.tab.input',
  output: 'trajectory.tab.output',
  raw: 'trajectory.tab.raw',
  request: 'trajectory.tab.request',
  prompt: 'trajectory.tab.prompt',
  tools: 'trajectory.tab.tools',
  context: 'trajectory.tab.context',
  diff: 'trajectory.tab.diff',
}

function tabsFor(row: TrajectoryRow, allowRawRequest: boolean): DetailTab[] {
  if (row.snapshot) return snapshotTabs(row.snapshot)
  switch (row.kind) {
    case 'tool': return ['overview', 'input', 'output', 'raw']
    case 'assistant': return allowRawRequest ? ['overview', 'preview', 'raw', 'request'] : ['overview', 'preview', 'raw']
    case 'compact': return ['overview', 'raw']
    default: return ['overview', 'preview', 'raw']
  }
}

type Props = {
  sessionId: string
  agentId?: string
  row: TrajectoryRow
  width: number
  /** Widest the panel may get without squeezing the ledger below its minimum. */
  maxWidth: number
  /** `drawer` overlays the ledger when the column is too narrow to share. */
  mode: 'side' | 'drawer'
  /** The raw-request tab (captures exist only for the main session's calls). */
  allowRawRequest: boolean
  running: boolean
  onWidthChange: (width: number) => void
  onClose: () => void
  onLocateInChat: ((row: TrajectoryRow) => void) | null
  onOpenAgent: (agentId: string, label: string) => void
  onSelectRow: (rowId: string) => void
}

export function TrajectoryDetailPanel({
  sessionId,
  agentId,
  row,
  width,
  maxWidth,
  mode,
  allowRawRequest,
  running,
  onWidthChange,
  onClose,
  onLocateInChat,
  onOpenAgent,
  onSelectRow,
}: Props) {
  const t = useTranslation()
  const tabs = tabsFor(row, allowRawRequest)
  const [preferred, setPreferred] = useState<DetailTab>('overview')
  const tab: DetailTab = tabs.includes(preferred) ? preferred : tabs[0]!
  const kindLabel = row.snapshot ? systemRowTitle(row, t) : t(KIND_LABEL_KEYS[row.kind])
  const context = row.kind === 'context' ? contextLabel(row, t) : null
  const subtitle = [turnLabel(row.turn, t), context, row.kind === 'tool' ? row.toolName : null].filter(Boolean).join(' · ')

  const drawer = mode === 'drawer'
  return (
    <aside
      className={cx(
        'flex min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]',
        drawer ? 'absolute inset-y-0 right-0 z-[var(--z-raised)] shadow-[var(--shadow-overlay)]' : 'relative shrink-0',
      )}
      style={{ width: drawer ? '100%' : Math.min(width, maxWidth) }}
      aria-label={t('trajectory.detail.label')}
      data-testid="trajectory-detail"
      data-mode={mode}
    >
      {!drawer && <ResizeHandle width={Math.min(width, maxWidth)} maxWidth={maxWidth} onWidthChange={onWidthChange} />}
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3">
        {drawer && (
          <IconButton icon={<ArrowLeft size={14} strokeWidth={1.75} />} label={t('trajectory.detail.back')} size="sm" tone="muted" onClick={onClose} />
        )}
        <Badge tone={row.isError ? 'danger' : KIND_TONES[row.kind]} variant={KIND_VARIANTS[row.kind]} size="xs" pill={false}>{t(KIND_LABEL_KEYS[row.kind])}</Badge>
        <span className="min-w-0 truncate text-[13px] text-[var(--color-text-secondary)]">
          {row.snapshot ? kindLabel : subtitle}
          {row.snapshot && subtitle ? ` · ${subtitle}` : ''}
        </span>
        {!drawer && <IconButton icon={<X size={14} strokeWidth={1.75} />} label={t('common.close')} size="sm" tone="muted" className="ml-auto" onClick={onClose} />}
      </header>
      <div className="shrink-0 px-4 pt-2">
        <SegmentedControl
          as="tablist"
          appearance="underline"
          size="sm"
          layout="auto"
          label={t('trajectory.detail.tabs')}
          value={tab}
          onChange={setPreferred}
          items={tabs.map((value) => ({ value, label: t(TAB_LABEL_KEYS[value]) }))}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" role="tabpanel">
        {row.snapshot ? (
          <SnapshotDetail sessionId={sessionId} snapshot={row.snapshot} tab={tab as SnapshotTab} />
        ) : tab === 'request' ? (
          <RawRequestTab sessionId={sessionId} row={row} />
        ) : (
          <RowDetail
            sessionId={sessionId}
            agentId={agentId}
            row={row}
            tab={tab as RowTab}
            running={running}
            onLocateInChat={onLocateInChat}
            onOpenAgent={onOpenAgent}
            onSelectRow={onSelectRow}
          />
        )}
      </div>
    </aside>
  )
}

function RowDetail({
  sessionId,
  agentId,
  row,
  tab,
  running,
  onLocateInChat,
  onOpenAgent,
  onSelectRow,
}: {
  sessionId: string
  agentId?: string
  row: TrajectoryRow
  tab: RowTab
  running: boolean
  onLocateInChat: ((row: TrajectoryRow) => void) | null
  onOpenAgent: (agentId: string, label: string) => void
  onSelectRow: (rowId: string) => void
}) {
  const t = useTranslation()
  const detail = useRowDetail(sessionId, agentId, row)
  const content = useMemo(
    () => (detail.value ? extractDetailContent(row, detail.value.entries) : null),
    [detail.value, row],
  )

  if (tab === 'overview') {
    return (
      <Overview
        row={row}
        content={content}
        running={running}
        loading={detail.status === 'loading'}
        onLocateInChat={onLocateInChat}
        onOpenAgent={onOpenAgent}
        onSelectRow={onSelectRow}
      />
    )
  }
  if (detail.status === 'error') {
    return <EmptyState description={t('trajectory.detail.loadFailed', { error: detail.error ?? '' })} variant="dashed" size="sm" />
  }
  if (!detail.value || !content) return <div className="flex justify-center py-8"><Spinner size={16} /></div>

  const truncatedNotice = detail.value.truncated ? (
    <p className="text-[12px] text-[var(--color-text-tertiary)]">{t('trajectory.detail.truncated')}</p>
  ) : null

  if (tab === 'raw') {
    return (
      <div className="flex flex-col gap-2">
        {truncatedNotice}
        <JsonBlock value={detail.value.entries.length === 1 ? detail.value.entries[0] : detail.value.entries} />
      </div>
    )
  }
  if (tab === 'input') {
    return content.toolInput === undefined
      ? <EmptyState description={t('trajectory.detail.notLoaded')} variant="dashed" size="sm" />
      : <JsonBlock value={content.toolInput} />
  }
  if (tab === 'output') {
    if (content.toolResult === undefined) {
      const reason = row.resultOmittedBytes
        ? t('trajectory.tool.resultTooLarge', { size: formatBytes(row.resultOmittedBytes) })
        : t(toolHasResult(row) ? 'trajectory.detail.notLoaded' : running ? 'trajectory.tool.running' : 'trajectory.tool.noResult')
      return <EmptyState description={reason} variant="dashed" size="sm" />
    }
    return (
      <div className="flex flex-col gap-4">
        {truncatedNotice}
        {content.imageCount > 0 && (
          <p className="text-[12px] text-[var(--color-text-tertiary)]">{t('trajectory.detail.images', { count: content.imageCount })}</p>
        )}
        <DetailSection title={t('trajectory.detail.resultText')}>
          <PlainText text={content.toolResult || t('trajectory.tool.emptyResult')} />
        </DetailSection>
        {content.toolResultStructured !== undefined && (
          <DetailSection title={t('trajectory.detail.resultStructured')}>
            <JsonBlock value={content.toolResultStructured} maxLines={120} />
          </DetailSection>
        )}
      </div>
    )
  }
  // preview
  const text = content.text || (content.attachment !== undefined ? attachmentText(content.attachment) : '')
  return (
    <div className="flex flex-col gap-4">
      {truncatedNotice}
      {content.thinking.length > 0 && (
        <details className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2" open={!text}>
          <summary className="cursor-pointer text-[12px] text-[var(--color-text-tertiary)]">{t('trajectory.detail.thinking')}</summary>
          <div className="mt-2 text-[13px]"><MarkdownText text={content.thinking.join('\n\n')} /></div>
        </details>
      )}
      {text ? <div className="text-[13px]"><MarkdownText text={text} /></div> : null}
      {content.toolUses.length > 0 && (
        <DetailSection title={t('trajectory.table.toolCount', { count: content.toolUses.length })}>
          <div className="flex flex-wrap gap-1.5">
            {content.toolUses.map((use) => (
              <button
                key={use.id}
                type="button"
                onClick={() => onSelectRow(`t:${use.id}`)}
                className="rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-2 py-0.5 font-mono text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              >
                {use.name}
              </button>
            ))}
          </div>
        </DetailSection>
      )}
      {!text && !content.thinking.length && !content.toolUses.length && (
        <EmptyState description={t('trajectory.detail.empty')} variant="dashed" size="sm" />
      )}
    </div>
  )
}

function Overview({
  row,
  content,
  running,
  loading,
  onLocateInChat,
  onOpenAgent,
  onSelectRow,
}: {
  row: TrajectoryRow
  content: ReturnType<typeof extractDetailContent> | null
  running: boolean
  loading: boolean
  onLocateInChat: ((row: TrajectoryRow) => void) | null
  onOpenAgent: (agentId: string, label: string) => void
  onSelectRow: (rowId: string) => void
}) {
  const t = useTranslation()
  const duration = rowDurationMs(row)
  const items: MetaItem[] = [{ label: t('trajectory.detail.time'), value: formatClockTime(row.ts) }]
  if (row.kind === 'context' && (row.attachmentType || row.label)) {
    items.push({ label: t('trajectory.detail.source'), value: <span className="font-mono text-[12px]">{row.attachmentType ?? row.label}</span> })
  }
  if (row.kind === 'tool') {
    items.push({
      label: t('trajectory.detail.status'),
      value: row.isError
        ? <span className="inline-flex items-center gap-1 text-[var(--color-error)]"><CircleX size={14} strokeWidth={1.75} aria-hidden />{t('trajectory.status.error')}</span>
        : toolHasResult(row)
          ? t('trajectory.status.done')
          : t(running ? 'trajectory.tool.running' : 'trajectory.tool.noResult'),
    })
    if (row.resultOmittedBytes) {
      items.push({ label: t('trajectory.tab.output'), value: t('trajectory.tool.resultTooLarge', { size: formatBytes(row.resultOmittedBytes) }) })
    }
  }
  if (row.kind === 'assistant') {
    if (row.model) items.push({ label: t('trajectory.detail.model'), value: <span className="font-mono text-[12px]">{row.model}</span> })
    if (row.stopReason) items.push({ label: t('trajectory.detail.stopReason'), value: <span className="font-mono text-[12px]">{row.stopReason}</span> })
    if (hasUsage(row) && row.usage) {
      items.push({
        label: t('trajectory.detail.tokens'),
        value: t('trajectory.detail.tokenBreakdown', {
          input: formatTokenCount(row.usage.input),
          cacheRead: formatTokenCount(row.usage.cacheRead),
          cacheWrite: formatTokenCount(row.usage.cacheWrite),
          output: formatTokenCount(row.usage.output),
        }),
      })
    }
  }
  if (duration !== null) {
    items.push({
      label: t('trajectory.detail.duration'),
      value: row.kind === 'assistant' ? t('trajectory.detail.approx', { value: formatDurationMs(duration) }) : formatDurationMs(duration),
    })
  }
  if (row.parentId) {
    items.push({
      label: t('trajectory.detail.issuedBy'),
      value: (
        <button type="button" className="rounded-[var(--radius-xs)] text-[var(--color-text-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]" onClick={() => onSelectRow(row.parentId!)}>
          {t('trajectory.kind.assistant')}
        </button>
      ),
    })
  }

  const preview = row.kind === 'tool'
    ? null
    : content
      ? (content.text || (content.attachment !== undefined ? attachmentText(content.attachment) : '')).slice(0, 4000)
      : row.preview

  return (
    <div className="flex flex-col gap-4">
      <MetaList items={items} />
      {(onLocateInChat || row.agentId) && (
        <div className="flex flex-wrap gap-2">
          {onLocateInChat && (row.kind === 'user' || row.kind === 'assistant' || row.kind === 'tool') && (
            <Button size="sm" variant="secondary" icon={<LocateFixed size={14} strokeWidth={1.75} />} onClick={() => onLocateInChat(row)}>
              {t('trajectory.detail.locateInChat')}
            </Button>
          )}
          {row.agentId && (
            <Button size="sm" variant="secondary" icon={<Bot size={14} strokeWidth={1.75} />} onClick={() => onOpenAgent(row.agentId!, agentLabelFromInput(row.inputPreview, row.agentId!))}>
              {t('trajectory.subagent.view')}
            </Button>
          )}
        </div>
      )}
      {row.kind === 'tool' ? (
        <>
          <DetailSection title={t('trajectory.tab.input')}>
            {content?.toolInput !== undefined ? <JsonBlock value={content.toolInput} maxLines={24} /> : <PlainText text={row.inputPreview ?? ''} />}
          </DetailSection>
          {(row.resultPreview || content?.toolResult !== undefined) && (
            <DetailSection title={t('trajectory.tab.output')}>
              <PlainText text={(content?.toolResult ?? row.resultPreview ?? '').slice(0, 4000)} />
            </DetailSection>
          )}
        </>
      ) : preview ? (
        <DetailSection title={t('trajectory.tab.preview')}>
          <div className="text-[13px]"><MarkdownText text={preview} /></div>
        </DetailSection>
      ) : loading ? (
        <div className="flex justify-center py-4"><Spinner size={14} /></div>
      ) : null}
    </div>
  )
}

const KEYBOARD_STEP = 16

function ResizeHandle({ width, maxWidth, onWidthChange }: { width: number; maxWidth: number; onWidthChange: (width: number) => void }) {
  const t = useTranslation()
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [liveWidth, setLiveWidth] = useState<number | null>(null)
  // The stored preference is clamped to the absolute range; the layout's room clamps it further.
  const clamp = (value: number) => Math.min(clampDetailWidth(value), Math.max(TRAJECTORY_DETAIL_WIDTH_MIN, maxWidth))

  useEffect(() => {
    if (!dragging) setLiveWidth(null)
  }, [dragging])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width }
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // The panel sits on the right, so dragging left widens it.
    const next = clamp(drag.current.startWidth + drag.current.startX - event.clientX)
    setLiveWidth(next)
    onWidthChange(next)
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    drag.current = null
    setDragging(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') onWidthChange(clamp(width + KEYBOARD_STEP))
    else if (event.key === 'ArrowRight') onWidthChange(clamp(width - KEYBOARD_STEP))
    else return
    event.preventDefault()
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('trajectory.detail.resize')}
      aria-valuenow={liveWidth ?? width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onWidthChange(clamp(TRAJECTORY_DETAIL_WIDTH_DEFAULT))}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -left-1 z-[var(--z-raised)] w-2 cursor-col-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      data-testid="trajectory-detail-resize"
    />
  )
}
