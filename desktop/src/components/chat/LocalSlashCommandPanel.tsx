import { useEffect, useMemo, useRef, useState } from 'react'
import { skillsApi } from '../../api/skills'
import { mcpApi } from '../../api/mcp'
import {
  sessionsApi,
  type SessionContextSnapshot,
  type SessionInspectionResponse,
  type SessionUsageSnapshot,
} from '../../api/sessions'
import { Info, PowerOff, RefreshCw, Server, X } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { mcpStatusTone } from '@/lib/mcpStatus'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useSkillStore } from '../../stores/skillStore'
import type { McpServerRecord } from '../../types/mcp'
import type { SkillMeta } from '../../types/skill'
import type { SlashCommandOption } from './composerUtils'
import { SlashCommandPanelShell as PanelShell } from './SlashCommandPanelShell'
import { WorkflowSavePanel } from './WorkflowSavePanel'

export type LocalSlashCommandName =
  | 'mcp'
  | 'skills'
  | 'help'
  | 'status'
  | 'cost'
  | 'context'
  | 'save-workflow'

type Props = {
  command: LocalSlashCommandName
  sessionId?: string
  cwd?: string
  commands?: SlashCommandOption[]
  onClose: () => void
}

type SessionInspectorTab = 'status' | 'usage' | 'context'
type Translate = ReturnType<typeof useTranslation>

function scopeLabel(scope: string, t: ReturnType<typeof useTranslation>) {
  switch (scope) {
    case 'user':
      return t('settings.mcp.scope.user')
    case 'local':
      return t('settings.mcp.scope.local')
    case 'project':
      return t('settings.mcp.scope.project')
    default:
      return scope
  }
}

function projectBadge(path?: string, t?: ReturnType<typeof useTranslation>) {
  if (!path || !t) return null
  const label = path.replace(/\/$/, '').split('/').pop() || path
  return t('slash.mcp.projectBadge', { name: label })
}

function formatNumber(value: number | undefined) {
  return new Intl.NumberFormat().format(value ?? 0)
}

function formatDuration(seconds: number | undefined) {
  const total = Math.max(0, Math.round(seconds ?? 0))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const remaining = total % 60
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
}

function formatPercent(value: number | undefined) {
  const percent = Math.max(0, Math.min(100, value ?? 0))
  return `${percent.toFixed(percent >= 10 || Number.isInteger(percent) ? 0 : 1)}%`
}

function sessionInspectorInitialTab(command: LocalSlashCommandName): SessionInspectorTab {
  if (command === 'cost') return 'usage'
  if (command === 'context') return 'context'
  return 'status'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

function isSessionInspectionResponse(value: unknown): value is SessionInspectionResponse {
  if (!isRecord(value)) return false
  if (typeof value.active !== 'boolean') return false
  if (!isRecord(value.status)) return false
  return (
    typeof value.status.sessionId === 'string' &&
    typeof value.status.workDir === 'string' &&
    typeof value.status.permissionMode === 'string'
  )
}

function assertSessionInspectionResponse(value: unknown, t: Translate): SessionInspectionResponse {
  if (isSessionInspectionResponse(value)) return value
  throw new Error(t('slash.inspector.error.unavailable'))
}

/** Small section label: 12px semibold tertiary, sentence case. */
function InspectorSectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex min-h-6 items-center justify-between gap-4">
      <div className="text-xs font-semibold text-[var(--color-text-tertiary)]">{children}</div>
      {action}
    </div>
  )
}

/** Sunken tile inside the panel card: no border, so the card does not nest frames. */
function MetricCard({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-h-[72px] rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5">
      <div className="truncate text-xs text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 whitespace-pre-line text-[15px] font-medium leading-6 tabular-nums text-[var(--color-text-primary)]">{value}</div>
      {detail && <div className="mt-0.5 text-xs leading-5 text-[var(--color-text-tertiary)]">{detail}</div>}
    </div>
  )
}

function InspectorNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-[13px] text-[var(--color-text-secondary)]">
      <Info size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      <span>{children}</span>
    </div>
  )
}

function KeyValueRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[180px_minmax(0,1fr)] border-t border-[var(--color-border)] first:border-t-0">
          <div className="bg-[var(--color-surface-container)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)]">
            {label}
          </div>
          <div className="min-w-0 break-words px-3 py-2 text-[13px] text-[var(--color-text-primary)]">{value}</div>
        </div>
      ))}
    </div>
  )
}

function UsageTab({
  usage,
  context,
  error,
  t,
}: {
  usage?: SessionUsageSnapshot
  context?: SessionContextSnapshot
  error?: string
  t: Translate
}) {
  if (error && !usage) return <ErrorState title={error} />
  if (!usage) {
    return <EmptyState title={t('slash.inspector.usage.emptyTitle')} description={t('slash.inspector.usage.emptyBody')} />
  }

  const usageHasTokens = (
    usage.totalInputTokens +
    usage.totalOutputTokens +
    usage.totalCacheReadInputTokens +
    usage.totalCacheCreationInputTokens
  ) > 0
  const apiUsage = context?.apiUsage
  const useContextUsageFallback = !usageHasTokens && !!apiUsage
  const totalInputTokens = useContextUsageFallback ? apiUsage.input_tokens : usage.totalInputTokens
  const totalOutputTokens = useContextUsageFallback ? apiUsage.output_tokens : usage.totalOutputTokens
  const totalCacheReadInputTokens = useContextUsageFallback ? apiUsage.cache_read_input_tokens : usage.totalCacheReadInputTokens
  const totalCacheCreationInputTokens = useContextUsageFallback ? apiUsage.cache_creation_input_tokens : usage.totalCacheCreationInputTokens
  const models = Array.isArray(usage.models) && usage.models.length > 0
    ? usage.models
    : useContextUsageFallback
      ? [{
          model: context?.model ?? 'current-model',
          displayName: context?.model ?? t('slash.inspector.status.activeModel'),
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: totalCacheReadInputTokens,
          cacheCreationInputTokens: totalCacheCreationInputTokens,
          webSearchRequests: 0,
          costUSD: 0,
          costDisplay: 'n/a',
          contextWindow: context?.rawMaxTokens ?? 0,
          maxOutputTokens: 0,
        }]
      : []
  const sourceLabel = useContextUsageFallback
    ? t('slash.inspector.usage.source.contextSnapshot')
    : usage.source === 'transcript'
      ? t('slash.inspector.usage.source.transcript')
      : t('slash.inspector.usage.source.currentProcess')

  return (
    <div className="space-y-5">
      {useContextUsageFallback && (
        <InspectorNotice>
          {t('slash.inspector.usage.contextSnapshotNotice')}
        </InspectorNotice>
      )}
      {usage.source === 'transcript' && (
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-[13px] text-[var(--color-text-secondary)]">
          {t('slash.inspector.usage.transcriptNotice')}
        </div>
      )}
      {usage.hasUnknownModelCost && (
        <div className="rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2 text-[13px] text-[var(--color-on-warning-container)]">
          {t('slash.inspector.usage.unknownCost')}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard label={t('slash.inspector.usage.totalCost')} value={useContextUsageFallback ? 'n/a' : usage.costDisplay} />
        <MetricCard label={t('slash.inspector.usage.source')} value={sourceLabel} />
        <MetricCard label={t('slash.inspector.usage.apiDuration')} value={usage.source === 'transcript' || useContextUsageFallback ? '0ms' : formatDuration(usage.totalAPIDuration)} />
        <MetricCard label={usage.source === 'transcript' ? t('slash.inspector.usage.usageSpan') : t('slash.inspector.usage.wallDuration')} value={useContextUsageFallback ? '0ms' : formatDuration(usage.totalDuration)} />
        <MetricCard
          label={t('slash.inspector.usage.codeChanges')}
          value={`${formatNumber(usage.totalLinesAdded)}/${formatNumber(usage.totalLinesRemoved)}`}
        />
        <MetricCard label={t('slash.inspector.usage.input')} value={formatNumber(totalInputTokens)} />
        <MetricCard label={t('slash.inspector.usage.output')} value={formatNumber(totalOutputTokens)} />
        <MetricCard label={t('slash.inspector.usage.cacheReadWrite')} value={`${formatNumber(totalCacheReadInputTokens)} / ${formatNumber(totalCacheCreationInputTokens)}`} />
        <MetricCard label={t('slash.inspector.usage.webSearch')} value={formatNumber(usage.totalWebSearchRequests)} />
      </div>
      <section>
        <InspectorSectionTitle>{t('slash.inspector.usage.byModel')}</InspectorSectionTitle>
        {models.length === 0 ? (
          <EmptyState title={t('slash.inspector.usage.noModelTitle')} description={t('slash.inspector.usage.noModelBody')} />
        ) : (
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {models.map((model) => (
              <div key={model.model} className="border-t border-[var(--color-border)] first:border-t-0">
                <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[13px] text-[var(--color-text-primary)]">{model.displayName || model.model}</div>
                    {(model.contextWindow > 0 || context?.rawMaxTokens) && (
                      <div className="mt-0.5 truncate text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                        {t('slash.inspector.status.contextWindow')}: {formatNumber(model.contextWindow || context?.rawMaxTokens)}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-xs font-semibold text-[var(--color-text-tertiary)]">{t('slash.inspector.usage.tokens')}</div>
                </div>
                <div className="grid grid-cols-[120px_minmax(0,1fr)_120px] items-center gap-4 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0">
                  <div className="text-xs text-[var(--color-text-secondary)]">{t('slash.inspector.usage.input')}</div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--color-surface-container)]">
                    <div className="h-full rounded-full bg-[var(--color-brand)]" style={{ width: '95%' }} />
                  </div>
                  <div className="text-right font-mono text-xs tabular-nums text-[var(--color-text-primary)]">{formatNumber(model.inputTokens)}</div>
                </div>
                <div className="grid grid-cols-[120px_minmax(0,1fr)_120px] items-center gap-4 px-3 py-2">
                  <div className="text-xs text-[var(--color-text-secondary)]">{t('slash.inspector.usage.output')}</div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--color-surface-container)]">
                    <div className="h-full rounded-full bg-[var(--color-text-tertiary)]" style={{ width: `${Math.max(4, Math.min(100, (model.outputTokens / Math.max(1, model.inputTokens)) * 100))}%` }} />
                  </div>
                  <div className="text-right font-mono text-xs tabular-nums text-[var(--color-text-primary)]">{formatNumber(model.outputTokens)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

type ContextCategory = SessionContextSnapshot['categories'][number]
type ContextMemoryFile = SessionContextSnapshot['memoryFiles'][number]

function isCapacityCategory(category: ContextCategory) {
  const name = category.name.toLowerCase()
  return category.isDeferred || name.includes('free') || name.includes('autocompact')
}

function ContextStackedBar({ categories, rawMaxTokens, t }: { categories: ContextCategory[]; rawMaxTokens: number; t: Translate }) {
  const activeCategories = categories.filter((category) => !isCapacityCategory(category) && category.tokens > 0)
  if (activeCategories.length === 0) return null

  return (
    <div className="overflow-hidden rounded-full bg-[var(--color-surface-container)]">
      <div className="flex h-2 w-full">
        {activeCategories.map((category) => (
          <div
            key={category.name}
            title={`${category.name}: ${t('common.tokens', { count: formatNumber(category.tokens) })}`}
            style={{
              width: `${Math.max(0.5, (category.tokens / rawMaxTokens) * 100)}%`,
              backgroundColor: category.color,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function CategoryBreakdown({ categories, rawMaxTokens, t }: { categories: ContextCategory[]; rawMaxTokens: number; t: Translate }) {
  const visibleCategories = categories.filter((category) => category.tokens > 0)
  if (visibleCategories.length === 0) {
    return <EmptyState title={t('slash.inspector.context.noCategoriesTitle')} description={t('slash.inspector.context.noCategoriesBody')} />
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3">
      <InspectorSectionTitle>{t('slash.inspector.context.categoryTitle')}</InspectorSectionTitle>
      <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {visibleCategories.map((category) => {
          const percent = rawMaxTokens > 0 ? (category.tokens / rawMaxTokens) * 100 : 0
          const muted = isCapacityCategory(category)
          return (
            <div
              key={category.name}
              className="min-w-0"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
                <span className={`min-w-0 truncate text-[13px] ${muted ? 'text-[var(--color-text-tertiary)]' : 'font-medium text-[var(--color-text-primary)]'}`}>
                  {category.name}
                </span>
                <span className="shrink-0 text-right font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
                  {formatNumber(category.tokens)}
                  <span className="ml-1.5 text-[11px] text-[var(--color-text-tertiary)]">{formatPercent(percent)}</span>
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-surface-container)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(0.5, percent))}%`,
                    backgroundColor: muted ? 'var(--color-outline)' : 'var(--color-brand)',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function memoryContextFileLabel(path: string) {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').pop() || normalized
}

function MemoryFilesBreakdown({ files, t }: { files: ContextMemoryFile[]; t: Translate }) {
  const setPendingSettingsTab = useUIStore((state) => state.setPendingSettingsTab)
  const setPendingMemoryPath = useUIStore((state) => state.setPendingMemoryPath)
  const openSettings = (path?: string) => {
    if (path) setPendingMemoryPath(path)
    setPendingSettingsTab('memory')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
  }

  const openMemoryButton = (path?: string) => (
    <Button variant="secondary" size="sm" onClick={() => openSettings(path)}>
      {t('slash.inspector.context.openMemory')}
    </Button>
  )

  if (files.length === 0) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3">
        <InspectorSectionTitle action={openMemoryButton()}>
          {t('slash.inspector.context.memoryFiles')}
        </InspectorSectionTitle>
        <div className="text-[13px] text-[var(--color-text-tertiary)]">{t('slash.inspector.context.noMemoryFiles')}</div>
      </div>
    )
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3">
      <InspectorSectionTitle action={openMemoryButton(files[0]?.path)}>
        {t('slash.inspector.context.memoryFiles')}
      </InspectorSectionTitle>
      <div className="grid gap-1.5">
        {files.map((file) => (
          <div
            key={`${file.type}:${file.path}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-[13px] font-medium text-[var(--color-text-primary)]" title={file.path}>
                {memoryContextFileLabel(file.path)}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]" title={file.path}>
                {file.path}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xs text-[var(--color-text-secondary)]">{file.type}</div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{t('common.tokens', { count: formatNumber(file.tokens) })}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ContextStatPill({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 truncate text-[15px] font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</div>
      {detail && <div className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{detail}</div>}
    </div>
  )
}

function statusDisplayLabel(status: string, t: Translate) {
  const normalized = status.toLowerCase()
  if (normalized === 'connected') return t('slash.inspector.status.connected')
  if (normalized === 'failed') return t('slash.inspector.status.failed')
  return status
}

function InspectorStatusBadge({ status, t }: { status: string; t: Translate }) {
  const normalized = status.toLowerCase()
  const tone = normalized === 'connected' ? 'success' : normalized === 'failed' ? 'danger' : 'neutral'

  return (
    <Badge
      tone={tone}
      size="md"
      icon={<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
    >
      {statusDisplayLabel(status, t)}
    </Badge>
  )
}

function McpServerIcon({ status }: { status: string }) {
  const isFailed = status === 'failed'
  const Icon = isFailed ? PowerOff : Server
  return (
    <Icon
      size={16}
      strokeWidth={1.75}
      aria-hidden="true"
      className={`shrink-0 ${isFailed ? 'text-[var(--color-error)]' : 'text-[var(--color-success)]'}`}
    />
  )
}

function ContextOverview({ context, categories, t }: { context: SessionContextSnapshot; categories: ContextCategory[]; t: Translate }) {
  const usedPercent = Math.min(100, Math.max(0, context.percentage))
  const freeTokens = Math.max(0, context.rawMaxTokens - context.totalTokens)
  const freePercent = context.rawMaxTokens > 0 ? (freeTokens / context.rawMaxTokens) * 100 : 0
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3">
      <InspectorSectionTitle
        action={(
          <span className="max-w-[50%] truncate rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-secondary)]">
            {context.model}
          </span>
        )}
      >
        {t('slash.inspector.context.windowUsage')}
      </InspectorSectionTitle>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[22px] font-semibold tabular-nums text-[var(--color-text-primary)]">
        <span>
          {formatNumber(context.totalTokens)}
          <span className="mx-1 font-normal text-[var(--color-text-tertiary)]">/</span>
          <span>{formatNumber(context.rawMaxTokens)}</span>
        </span>
        <span className="text-[13px] font-normal text-[var(--color-text-tertiary)]">{formatPercent(usedPercent)} {t('slash.inspector.context.used')}</span>
      </div>
      <div className="mt-3">
        <ContextStackedBar categories={categories} rawMaxTokens={context.rawMaxTokens} t={t} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5">
          <ContextStatPill label={t('slash.inspector.context.free')} value={formatNumber(freeTokens)} detail={formatPercent(freePercent)} />
        </div>
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5">
          <ContextStatPill label={t('slash.inspector.context.messages')} value={formatNumber(context.messageBreakdown?.assistantMessageTokens ?? 0)} detail={t('slash.inspector.context.assistant')} />
        </div>
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5">
          <ContextStatPill label={t('slash.inspector.context.toolResults')} value={formatNumber(context.messageBreakdown?.toolResultTokens ?? 0)} />
        </div>
        <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5">
          <ContextStatPill label={t('slash.inspector.context.context')} value={formatPercent(usedPercent)} />
        </div>
      </div>
    </div>
  )
}

function ContextTab({
  context,
  error,
  loading,
  t,
}: {
  context?: SessionContextSnapshot
  error?: string
  loading?: boolean
  t: Translate
}) {
  if (error && !context) return <ErrorState title={error} />
  if (loading && !context) return <LoadingState label={t('slash.inspector.context.loading')} />
  if (!context) {
    return <EmptyState title={t('slash.inspector.context.emptyTitle')} description={t('slash.inspector.context.emptyBody')} />
  }

  const categories = Array.isArray(context.categories) ? context.categories : []
  return (
    <div className="space-y-3">
      <ContextOverview context={context} categories={categories} t={t} />
      <MemoryFilesBreakdown files={Array.isArray(context.memoryFiles) ? context.memoryFiles : []} t={t} />
      <CategoryBreakdown categories={categories} rawMaxTokens={context.rawMaxTokens} t={t} />
    </div>
  )
}

function StatusTab({
  data,
  commands,
  t,
}: {
  data: SessionInspectionResponse
  commands?: SlashCommandOption[]
  t: Translate
}) {
  const mcpServers = Array.isArray(data.status.mcpServers) ? data.status.mcpServers : []
  const tools = Array.isArray(data.status.tools) ? data.status.tools : []
  const context = data.context ?? data.contextEstimate
  const model = data.status.model ?? context?.model ?? data.usage?.models?.[0]?.displayName ?? data.usage?.models?.[0]?.model ?? t('slash.inspector.status.unknown')
  const contextWindow = context?.rawMaxTokens ?? data.usage?.models?.find((entry) => entry.contextWindow > 0)?.contextWindow
  const slashCommandCount = (data.status.slashCommandCount ?? 0) > 0
    ? data.status.slashCommandCount
    : commands?.length ?? 0
  const connectedMcp = mcpServers.filter((server) => server.status === 'connected').length
  const failedMcp = mcpServers.filter((server) => server.status === 'failed').length
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricCard
          label={t('slash.inspector.status.cliStatus')}
          value={(
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${data.active ? 'bg-[var(--color-success)]' : 'bg-[var(--color-error)]'}`} />
              {data.active ? t('slash.inspector.status.running') : t('slash.inspector.status.notRunning')}
            </span>
          )}
        />
        <MetricCard
          label={t('slash.inspector.status.activeModel')}
          value={model}
          detail={contextWindow ? `${t('slash.inspector.status.contextWindow')}: ${formatNumber(contextWindow)}` : undefined}
        />
        <MetricCard
          label={t('slash.inspector.status.mcpConnections')}
          value={(
            <span>
              <span className="text-[var(--color-success)]">{formatNumber(connectedMcp)}</span>
              <span className="mx-2 font-normal text-[var(--color-text-tertiary)]">/</span>
              <span className="text-[var(--color-error)]">{formatNumber(failedMcp)}</span>
            </span>
          )}
          detail={(
            <span>
              <span>{t('slash.inspector.status.connected')}</span>
              <span className="mx-1.5" aria-hidden="true">·</span>
              <span>{t('slash.inspector.status.failed')}</span>
            </span>
          )}
        />
        <MetricCard label={t('slash.inspector.status.registeredTools')} value={`${formatNumber(tools.length)} / ${formatNumber(slashCommandCount)} ${t('slash.inspector.status.commands')}`} />
      </div>
      <section>
        <InspectorSectionTitle>{t('slash.inspector.status.sessionMetadata')}</InspectorSectionTitle>
        <KeyValueRows
          rows={[
            [t('slash.inspector.status.version'), data.status.version ?? t('slash.inspector.status.unknown')],
            [t('slash.inspector.status.sessionId'), <span className="font-mono text-xs">{data.status.sessionId}</span>],
            [t('slash.inspector.status.workingDirectory'), <span className="font-mono text-xs">{data.status.cwd ?? data.status.workDir}</span>],
            [t('slash.inspector.status.permissionMode'), <span className="rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-1.5 py-0.5 font-mono text-xs">{data.status.permissionMode}</span>],
            [t('slash.inspector.status.authToken'), data.status.apiKeySource ?? t('slash.inspector.status.unknown')],
            [t('slash.inspector.status.outputStyle'), data.status.outputStyle ?? t('slash.inspector.status.default')],
          ]}
        />
      </section>
      {mcpServers.length > 0 && (
        <section>
          <InspectorSectionTitle
            action={(
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />}
              >
                {t('slash.inspector.status.refresh')}
              </Button>
            )}
          >
            {t('slash.inspector.status.mcpServers')}
          </InspectorSectionTitle>
          <div className="grid gap-2 lg:grid-cols-2">
            {mcpServers.map((server) => (
              <div
                key={`${server.name}:${server.status}`}
                className="flex min-h-10 items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <McpServerIcon status={server.status} />
                  <span className="min-w-0 truncate text-[13px] text-[var(--color-text-primary)]">{server.name}</span>
                </div>
                <InspectorStatusBadge status={server.status} t={t} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SessionInspectorShell({
  selectedTab,
  tabs,
  onSelectTab,
  onClose,
  children,
  t,
}: {
  selectedTab: SessionInspectorTab
  tabs: Array<{ id: SessionInspectorTab; label: string }>
  onSelectTab: (tab: SessionInspectorTab) => void
  onClose: () => void
  children: React.ReactNode
  t: Translate
}) {
  return (
    <div
      className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] text-[var(--color-text-primary)] shadow-[var(--shadow-dropdown)]"
    >
      <div className="grid min-h-12 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
        <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{t('slash.inspector.title')}</div>
        <SegmentedControl
          as="tablist"
          size="sm"
          label={t('slash.inspector.title')}
          items={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
          value={selectedTab}
          onChange={onSelectTab}
        />
        <div className="flex justify-end">
          <IconButton
            icon={<X size={16} strokeWidth={1.75} aria-hidden="true" />}
            label={t('slash.inspector.close')}
            size="sm"
            tone="muted"
            onClick={onClose}
          />
        </div>
      </div>
      <div className="max-h-[min(540px,58vh)] overflow-y-auto p-4">{children}</div>
    </div>
  )
}

function SessionInspectorPanel({
  command,
  sessionId,
  commands,
  onClose,
}: {
  command: LocalSlashCommandName
  sessionId?: string
  commands?: SlashCommandOption[]
  onClose: () => void
}) {
  const t = useTranslation()
  const [selectedTab, setSelectedTab] = useState<SessionInspectorTab>(() => sessionInspectorInitialTab(command))
  const [data, setData] = useState<SessionInspectionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const contextRequestSessionRef = useRef<string | null>(null)

  useEffect(() => {
    if (command !== 'status' && command !== 'cost' && command !== 'context') return
    setSelectedTab(sessionInspectorInitialTab(command))
  }, [command])

  useEffect(() => {
    if (!sessionId) {
      setError(t('slash.inspector.error.noActiveSession'))
      return
    }
    let cancelled = false
    setData(null)
    setError(null)
    setContextLoading(false)
    setContextError(null)
    contextRequestSessionRef.current = null
    sessionsApi.getInspection(sessionId, { includeContext: false })
      .then((response) => {
        if (!cancelled) setData(assertSessionInspectionResponse(response, t))
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, t])

  useEffect(() => {
    if (!sessionId || selectedTab !== 'context' || data === null || data.context) return
    if (contextRequestSessionRef.current === sessionId) return
    contextRequestSessionRef.current = sessionId
    let cancelled = false
    setContextLoading(true)
    setContextError(null)
    sessionsApi.getInspection(sessionId, { includeContext: true, contextOnly: true, timeout: 45_000 })
      .then((response) => {
        if (cancelled) return
        const inspected = assertSessionInspectionResponse(response, t)
        setData((current) => current
          ? {
              ...current,
              context: inspected.context,
              errors: {
                ...(current.errors ?? {}),
                ...(inspected.errors ?? {}),
              },
            }
          : inspected)
        setContextError(inspected.errors?.context ?? null)
      })
      .catch((err) => {
        if (!cancelled) setContextError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [data, selectedTab, sessionId, t])

  const tabs: Array<{ id: SessionInspectorTab; label: string }> = [
    { id: 'status', label: t('slash.inspector.tab.status') },
    { id: 'usage', label: t('slash.inspector.tab.usage') },
    { id: 'context', label: t('slash.inspector.tab.context') },
  ]

  return (
    <SessionInspectorShell selectedTab={selectedTab} tabs={tabs} onSelectTab={setSelectedTab} onClose={onClose} t={t}>
      {error ? (
        <ErrorState title={error} />
      ) : data === null ? (
        <LoadingState label={t('slash.inspector.loading')} />
      ) : selectedTab === 'usage' ? (
        <UsageTab usage={data.usage} context={data.context ?? data.contextEstimate} error={data.errors?.usage} t={t} />
      ) : selectedTab === 'context' ? (
        <ContextTab
          context={data.context ?? data.contextEstimate}
          error={contextError ?? data.errors?.context}
          loading={contextLoading && !data.contextEstimate}
          t={t}
        />
      ) : (
        <StatusTab data={data} commands={commands} t={t} />
      )}
    </SessionInspectorShell>
  )
}

function McpPanel({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  const t = useTranslation()
  const setPendingSettingsTab = useUIStore((s) => s.setPendingSettingsTab)
  const selectServer = useMcpStore((s) => s.selectServer)
  const [servers, setServers] = useState<McpServerRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    mcpApi.list(cwd)
      .then(async (response) => {
        if (cancelled) return
        const visibleServers = response.servers.filter((server) => server.scope === 'user' || server.scope === 'local' || server.scope === 'project')
        setServers(visibleServers)

        const statusResults = await Promise.allSettled(
          visibleServers.map((server) => mcpApi.status(server.name, cwd)),
        )
        if (cancelled) return

        const liveServers = new Map<string, McpServerRecord>()
        for (const result of statusResults) {
          if (result.status === 'fulfilled') {
            liveServers.set(result.value.server.name, result.value.server)
          }
        }
        if (liveServers.size > 0) {
          setServers((current) =>
            current?.map((server) => liveServers.get(server.name) ?? server) ?? current,
          )
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const grouped = useMemo(() => {
    const groups = new Map<string, McpServerRecord[]>()
    for (const server of servers ?? []) {
      const key = server.scope
      const existing = groups.get(key) ?? []
      existing.push(server)
      groups.set(key, existing)
    }
    return groups
  }, [servers])

  return (
    <PanelShell
      title={t('slash.mcp.title')}
      subtitle={cwd ? t('slash.mcp.subtitleWithProject', { path: cwd }) : t('slash.mcp.subtitle')}
      onClose={onClose}
    >
      {error ? (
        <ErrorState title={error} />
      ) : servers === null ? (
        <LoadingState label={t('common.loading')} />
      ) : servers.length === 0 ? (
        <EmptyState title={t('slash.mcp.emptyTitle')} description={t('slash.mcp.emptyBody')} />
      ) : (
        <div className="space-y-4">
          {['user', 'local', 'project'].filter((scope) => grouped.has(scope)).map((scope) => (
            <section key={scope}>
              <div className="mb-1.5 flex items-center justify-between px-1">
                <div className="text-xs font-semibold text-[var(--color-text-tertiary)]">{scopeLabel(scope, t)}</div>
                <div className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{grouped.get(scope)?.length ?? 0}</div>
              </div>
              <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
                {grouped.get(scope)?.map((server) => (
                  <button
                    type="button"
                    key={`${server.scope}:${server.projectPath ?? 'global'}:${server.name}`}
                    onClick={() => {
                      selectServer(server)
                      setPendingSettingsTab('mcp')
                      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
                      onClose()
                    }}
                    className="block w-full border-t border-[var(--color-border)] px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
                  >
                    <div className="flex items-center gap-2">
                      <div className="text-[13px] font-medium text-[var(--color-text-primary)]">{server.name}</div>
                      <Badge tone={mcpStatusTone(server.status)} size="md">
                        {server.statusLabel}
                      </Badge>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
                      <Badge size="md">{server.transport}</Badge>
                      {server.projectPath && (
                        <Badge size="md" title={server.projectPath}>
                          {projectBadge(server.projectPath, t)}
                        </Badge>
                      )}
                      <span className="truncate">{server.summary}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PanelShell>
  )
}

function SkillsPanel({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  const t = useTranslation()
  const fetchSkillDetail = useSkillStore((s) => s.fetchSkillDetail)
  const [skills, setSkills] = useState<SkillMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    skillsApi.list(cwd)
      .then((response) => {
        if (cancelled) return
        setSkills(response.skills.filter((skill) => skill.userInvocable))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return (
    <PanelShell
      title={t('slash.skills.title')}
      subtitle={cwd ? t('slash.skills.subtitleWithProject', { path: cwd }) : t('slash.skills.subtitle')}
      onClose={onClose}
    >
      {error ? (
        <ErrorState title={error} />
      ) : skills === null ? (
        <LoadingState label={t('common.loading')} />
      ) : skills.length === 0 ? (
        <EmptyState title={t('slash.skills.emptyTitle')} description={t('slash.skills.emptyBody')} />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
          {skills.map((skill) => (
            <button
              type="button"
              key={`${skill.source}:${skill.name}`}
              onClick={async () => {
                await fetchSkillDetail(skill.source, skill.name, cwd, 'skills')
                useUIStore.getState().setPendingSettingsTab('skills')
                useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
                onClose()
              }}
              className="block w-full border-t border-[var(--color-border)] px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)]"
            >
              <div className="flex items-center gap-2">
                <div className="font-mono text-[13px] text-[var(--color-text-primary)]">/{skill.name}</div>
                <Badge size="md">{skill.source}</Badge>
              </div>
              <div className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{skill.description}</div>
            </button>
          ))}
        </div>
      )}
    </PanelShell>
  )
}

const COMMAND_GROUPS = [
  {
    titleKey: 'slash.help.group.context',
    names: ['clear', 'compact', 'context', 'cost'],
  },
  {
    titleKey: 'slash.help.group.project',
    names: ['init', 'review', 'commit', 'pr'],
  },
  {
    titleKey: 'slash.help.group.desktop',
    names: ['mcp', 'skills', 'save-workflow', 'plugin', 'help'],
  },
] satisfies Array<{ titleKey: TranslationKey; names: string[] }>

function HelpPanel({
  commands,
  onClose,
}: {
  commands?: SlashCommandOption[]
  onClose: () => void
}) {
  const t = useTranslation()
  const commandMap = useMemo(() => {
    const map = new Map<string, SlashCommandOption>()
    for (const command of commands ?? []) {
      map.set(command.name, command)
    }
    return map
  }, [commands])

  const groupedNames = new Set(COMMAND_GROUPS.flatMap((group) => group.names))
  const otherCommands = (commands ?? [])
    .filter((command) => !groupedNames.has(command.name))
    .slice(0, 12)
  const hiddenOtherCommandCount = Math.max(
    0,
    (commands ?? []).filter((command) => !groupedNames.has(command.name)).length - otherCommands.length,
  )

  const renderCommand = (command: SlashCommandOption) => (
    <div key={command.name} className="flex min-w-0 items-start gap-3 border-t border-[var(--color-border)] px-3 py-2 first:border-t-0">
      <div className="flex min-w-[120px] max-w-[45%] shrink-0 flex-wrap items-baseline gap-x-1.5 font-mono">
        <span className="text-[13px] text-[var(--color-text-primary)]">/{command.name}</span>
        {command.argumentHint ? (
          <span className="text-[11px] leading-5 text-[var(--color-text-tertiary)]">{command.argumentHint}</span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{command.description}</div>
    </div>
  )

  return (
    <PanelShell
      title={t('slash.help.title')}
      subtitle={t('slash.help.subtitle')}
      onClose={onClose}
    >
      <div className="space-y-4">
        {COMMAND_GROUPS.map((group) => {
          const entries = group.names
            .map((name) => commandMap.get(name))
            .filter((command): command is SlashCommandOption => Boolean(command))
          if (entries.length === 0) return null
          return (
            <section key={group.titleKey}>
              <div className="mb-1.5 px-1 text-xs font-semibold text-[var(--color-text-tertiary)]">{t(group.titleKey)}</div>
              <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
                {entries.map(renderCommand)}
              </div>
            </section>
          )
        })}

        {otherCommands.length > 0 && (
          <section>
            <div className="mb-1.5 px-1 text-xs font-semibold text-[var(--color-text-tertiary)]">{t('slash.help.group.more')}</div>
            <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {otherCommands.map(renderCommand)}
            </div>
            {hiddenOtherCommandCount > 0 && (
              <p className="mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
                {t('slash.help.moreAvailable', { count: hiddenOtherCommandCount })}
              </p>
            )}
          </section>
        )}
      </div>
    </PanelShell>
  )
}

export function LocalSlashCommandPanel({ command, sessionId, cwd, commands, onClose }: Props) {
  if (command === 'mcp') return <McpPanel cwd={cwd} onClose={onClose} />
  if (command === 'skills') return <SkillsPanel cwd={cwd} onClose={onClose} />
  if (command === 'save-workflow') {
    return (
      <WorkflowSavePanel
        sessionId={sessionId}
        cwd={cwd}
        commands={commands}
        onClose={onClose}
      />
    )
  }
  if (command === 'status' || command === 'cost' || command === 'context') {
    return <SessionInspectorPanel command={command} sessionId={sessionId} commands={commands} onClose={onClose} />
  }
  return <HelpPanel commands={commands} onClose={onClose} />
}
