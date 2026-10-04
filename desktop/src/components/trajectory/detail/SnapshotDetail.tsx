import { useMemo, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { cx } from '@/lib/cx'
import { diffLines, diffToolCatalogs, type ToolCatalogEntry } from '../../../lib/trajectory/lineDiff'
import type { TrajectorySnapshotBlob, TrajectorySnapshotRef } from '../../../types/trajectory'
import { useSnapshotBlob } from '../useTrajectoryDetail'
import { CopyAction, DetailSection, JsonBlock, PlainText } from './DetailBlocks'

export type SnapshotTab = 'prompt' | 'tools' | 'context' | 'diff'

function asTools(blob: TrajectorySnapshotBlob | null): ToolCatalogEntry[] {
  return Array.isArray(blob?.json) ? (blob!.json as ToolCatalogEntry[]).filter((tool) => tool && typeof tool.name === 'string') : []
}

function contextText(blob: TrajectorySnapshotBlob | null): string {
  if (!blob) return ''
  if (typeof blob.text === 'string') return blob.text
  if (blob.json && typeof blob.json === 'object') {
    return Object.entries(blob.json as Record<string, unknown>)
      .map(([key, value]) => `# ${key}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
      .join('\n\n')
  }
  return ''
}

function Loading() {
  return <div className="flex justify-center py-8"><Spinner size={16} /></div>
}

export function snapshotTabs(ref: TrajectorySnapshotRef): SnapshotTab[] {
  if (ref.change === 'context') return ref.prevCtx ? ['context', 'diff'] : ['context']
  const hasPrevious = Boolean(ref.prevSys || ref.prevTools)
  return hasPrevious ? ['prompt', 'tools', 'diff'] : ['prompt', 'tools']
}

export function SnapshotDetail({ sessionId, snapshot, tab }: { sessionId: string; snapshot: TrajectorySnapshotRef; tab: SnapshotTab }) {
  const t = useTranslation()
  const isContext = snapshot.change === 'context'
  const sys = useSnapshotBlob(sessionId, tab === 'prompt' || (tab === 'diff' && !isContext) ? snapshot.sys : undefined)
  const tools = useSnapshotBlob(sessionId, tab === 'tools' || (tab === 'diff' && !isContext) ? snapshot.tools : undefined)
  const ctx = useSnapshotBlob(sessionId, isContext ? snapshot.ctx : undefined)
  const prevSys = useSnapshotBlob(sessionId, tab === 'diff' && !isContext && snapshot.prevSys !== snapshot.sys ? snapshot.prevSys : undefined)
  const prevTools = useSnapshotBlob(sessionId, tab === 'diff' && !isContext && snapshot.prevTools !== snapshot.tools ? snapshot.prevTools : undefined)
  const prevCtx = useSnapshotBlob(sessionId, tab === 'diff' && isContext ? snapshot.prevCtx : undefined)

  const failed = [sys, tools, ctx, prevSys, prevTools, prevCtx].find((item) => item.status === 'error')
  if (failed) return <EmptyState description={t('trajectory.detail.loadFailed', { error: failed.error ?? '' })} variant="dashed" size="sm" />

  if (tab === 'prompt') {
    if (sys.status !== 'ready') return <Loading />
    const text = sys.value?.text ?? ''
    return (
      <DetailSection title={t('trajectory.detail.systemPrompt', { count: text.length.toLocaleString() })} actions={<CopyAction text={text} />}>
        {sys.value?.truncated && <TruncatedNotice />}
        <PlainText text={text} />
      </DetailSection>
    )
  }

  if (tab === 'tools') {
    if (tools.status !== 'ready') return <Loading />
    return <ToolCatalog tools={asTools(tools.value)} truncated={Boolean(tools.value?.truncated)} />
  }

  if (tab === 'context') {
    if (ctx.status !== 'ready') return <Loading />
    const text = contextText(ctx.value)
    return (
      <DetailSection title={t('trajectory.system.userContext')} actions={<CopyAction text={text} />}>
        <PlainText text={text} />
      </DetailSection>
    )
  }

  // diff
  if (isContext) {
    if (ctx.status !== 'ready' || prevCtx.status !== 'ready') return <Loading />
    return <TextDiff before={contextText(prevCtx.value)} after={contextText(ctx.value)} />
  }
  const sysChanged = Boolean(snapshot.prevSys && snapshot.prevSys !== snapshot.sys)
  const toolsChanged = Boolean(snapshot.prevTools && snapshot.prevTools !== snapshot.tools)
  if ((sysChanged && (sys.status !== 'ready' || prevSys.status !== 'ready')) || (toolsChanged && (tools.status !== 'ready' || prevTools.status !== 'ready'))) {
    return <Loading />
  }
  return (
    <div className="flex flex-col gap-5">
      {toolsChanged && <ToolCatalogDiff before={asTools(prevTools.value)} after={asTools(tools.value)} />}
      {sysChanged && (
        <DetailSection title={t('trajectory.detail.systemPromptDiff')}>
          <TextDiff before={prevSys.value?.text ?? ''} after={sys.value?.text ?? ''} />
        </DetailSection>
      )}
      {!sysChanged && !toolsChanged && <EmptyState description={t('trajectory.detail.noChanges')} variant="dashed" size="sm" />}
    </div>
  )
}

function TruncatedNotice() {
  const t = useTranslation()
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-1.5 text-[12px] text-[var(--color-on-warning-container)]">
      {t('trajectory.detail.truncated')}
    </div>
  )
}

function ToolCatalog({ tools, truncated }: { tools: ToolCatalogEntry[]; truncated: boolean }) {
  const t = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <DetailSection title={t('trajectory.table.toolCount', { count: tools.length })}>
      {truncated && <TruncatedNotice />}
      <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
        {tools.map((tool) => {
          const expanded = open === tool.name
          return (
            <li key={tool.name}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : tool.name)}
                className="flex w-full min-w-0 items-baseline gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
              >
                <span className="shrink-0 font-mono text-[12px] font-medium text-[var(--color-text-primary)]">{tool.name}</span>
                <span className="min-w-0 truncate text-[12px] text-[var(--color-text-tertiary)]">{tool.description?.split('\n')[0]}</span>
              </button>
              {expanded && (
                <div className="flex flex-col gap-2 px-3 pb-3">
                  {tool.description && <PlainText text={tool.description} />}
                  <JsonBlock value={tool.input_schema ?? null} maxLines={60} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </DetailSection>
  )
}

function ToolCatalogDiff({ before, after }: { before: ToolCatalogEntry[]; after: ToolCatalogEntry[] }) {
  const t = useTranslation()
  const diff = useMemo(() => diffToolCatalogs(before, after), [after, before])
  const groups = [
    { key: 'added', label: t('trajectory.detail.toolsAdded'), names: diff.added, tone: 'text-[var(--color-success)]' },
    { key: 'removed', label: t('trajectory.detail.toolsRemoved'), names: diff.removed, tone: 'text-[var(--color-error)]' },
    { key: 'changed', label: t('trajectory.detail.toolsChanged'), names: diff.changed, tone: 'text-[var(--color-text-primary)]' },
  ].filter((group) => group.names.length)
  return (
    <DetailSection title={t('trajectory.detail.toolsDiff')}>
      {groups.length ? groups.map((group) => (
        <div key={group.key} className="flex flex-wrap items-baseline gap-1.5 text-[12px]">
          <span className="text-[var(--color-text-tertiary)]">{group.label}</span>
          {group.names.map((name) => <span key={name} className={cx('font-mono', group.tone)}>{name}</span>)}
        </div>
      )) : <span className="text-[12px] text-[var(--color-text-tertiary)]">{t('trajectory.detail.noChanges')}</span>}
    </DetailSection>
  )
}

/** Unchanged runs longer than this collapse to a marker so the change stays on screen. */
const CONTEXT_LINES = 3

function TextDiff({ before, after }: { before: string; after: string }) {
  const t = useTranslation()
  const lines = useMemo(() => diffLines(before, after), [after, before])
  const rendered: Array<{ key: string; type: 'same' | 'add' | 'remove' | 'gap'; text: string }> = []
  let index = 0
  while (index < lines.length) {
    if (lines[index]!.type !== 'same') {
      rendered.push({ key: `l${index}`, ...lines[index]! })
      index++
      continue
    }
    let end = index
    while (end < lines.length && lines[end]!.type === 'same') end++
    const run = end - index
    if (run > CONTEXT_LINES * 2 + 1) {
      const keepHead = index === 0 ? 0 : CONTEXT_LINES
      const keepTail = end === lines.length ? 0 : CONTEXT_LINES
      for (let i = index; i < index + keepHead; i++) rendered.push({ key: `l${i}`, ...lines[i]! })
      rendered.push({ key: `g${index}`, type: 'gap', text: t('trajectory.detail.unchangedLines', { count: run - keepHead - keepTail }) })
      for (let i = end - keepTail; i < end; i++) rendered.push({ key: `l${i}`, ...lines[i]! })
    } else {
      for (let i = index; i < end; i++) rendered.push({ key: `l${i}`, ...lines[i]! })
    }
    index = end
  }
  if (!rendered.some((line) => line.type === 'add' || line.type === 'remove')) {
    return <span className="text-[12px] text-[var(--color-text-tertiary)]">{t('trajectory.detail.noChanges')}</span>
  }
  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)] font-mono text-[12px] leading-[1.6]" data-testid="trajectory-diff">
      {rendered.map((line) => (
        <div
          key={line.key}
          data-diff={line.type}
          className={cx(
            'whitespace-pre-wrap break-words px-3',
            line.type === 'add' && 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]',
            line.type === 'remove' && 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]',
            line.type === 'same' && 'text-[var(--color-text-secondary)]',
            line.type === 'gap' && 'bg-[var(--color-surface-container-low)] py-0.5 text-center text-[11px] text-[var(--color-text-tertiary)]',
          )}
        >
          {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : line.type === 'same' ? '  ' : ''}
          {line.text}
        </div>
      ))}
    </div>
  )
}
