import type { ReactNode } from 'react'
import {
  AlertTriangle,
  Bot,
  CircleDot,
  Clock3,
  FileJson2,
  GitBranch,
  MessageSquareText,
  RadioTower,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TraceSpan, TraceSpanStatus } from '../../lib/traceViewModel'

type TraceTranslator = ReturnType<typeof useTranslation>

export function TypeIcon({ span, size = 14 }: { span: TraceSpan; size?: number }) {
  const { icon, className } = iconForSpan(span, size)
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${className}`} aria-hidden="true">
      {icon}
    </span>
  )
}

function iconForSpan(span: TraceSpan, size: number): { icon: ReactNode; className: string } {
  const tertiary = 'text-[var(--color-text-tertiary)]'
  switch (span.kind) {
    case 'llm':
      return { icon: <Sparkles size={size} strokeWidth={2} />, className: 'text-[var(--color-brand)]' }
    case 'tool':
      return { icon: <Wrench size={size} strokeWidth={2} />, className: 'text-[var(--color-warning)]' }
    case 'tool_result':
      return { icon: <Wrench size={size} strokeWidth={2} />, className: tertiary }
    case 'turn':
      return { icon: <GitBranch size={size} strokeWidth={2} />, className: tertiary }
    case 'session':
      return { icon: <RadioTower size={size} strokeWidth={2} />, className: tertiary }
    case 'event':
      return span.status === 'error'
        ? { icon: <AlertTriangle size={size} strokeWidth={2} />, className: 'text-[var(--color-error)]' }
        : { icon: <CircleDot size={size} strokeWidth={2} />, className: tertiary }
    case 'message':
      if (span.message?.type === 'assistant') {
        return { icon: <Bot size={size} strokeWidth={2} />, className: tertiary }
      }
      if (span.message?.type === 'system') {
        return { icon: <FileJson2 size={size} strokeWidth={2} />, className: tertiary }
      }
      return { icon: <MessageSquareText size={size} strokeWidth={2} />, className: tertiary }
    default:
      return { icon: <FileJson2 size={size} strokeWidth={2} />, className: tertiary }
  }
}

export function StatusGlyph({ status }: { status: TraceSpanStatus }) {
  if (status === 'error') {
    return <AlertTriangle size={13} strokeWidth={2} className="shrink-0 text-[var(--color-error)]" aria-hidden="true" />
  }
  if (status === 'pending') {
    return <Clock3 size={13} strokeWidth={2} className="shrink-0 animate-pulse-dot text-[var(--color-warning)]" aria-hidden="true" />
  }
  return null
}

export function StatusPill({ status }: { status: TraceSpanStatus }) {
  const t = useTranslation()
  const className = status === 'error'
    ? 'bg-[var(--color-error)]/10 text-[var(--color-error)]'
    : status === 'pending'
      ? 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'
      : 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
  const label = status === 'error'
    ? t('trace.status.error')
    : status === 'pending'
      ? t('trace.status.pending')
      : t('trace.status.ok')
  return (
    <span className={`inline-flex shrink-0 items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] font-semibold ${className}`}>
      {label}
    </span>
  )
}

export function MetaChip({
  label,
  value,
  tone = 'default',
  title,
}: {
  label: string
  value: string
  tone?: 'default' | 'danger'
  title?: string
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-[10px]"
      {...(title ? { title } : {})}
    >
      <span className="shrink-0 text-[var(--color-text-tertiary)]">{label}</span>
      <span className={`truncate font-mono ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]'}`}>
        {value}
      </span>
    </span>
  )
}

export function LiveBadge() {
  const t = useTranslation()
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-success)]/25 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-success)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
      {t('trace.live')}
    </span>
  )
}

export function spanDisplayTitle(span: TraceSpan, t: TraceTranslator): string {
  if (span.kind === 'message' && span.message) {
    switch (span.message.type) {
      case 'user': return t('trace.message.user')
      case 'assistant': return t('trace.message.assistant')
      case 'system': return t('trace.message.system')
      case 'tool_use': return t('trace.message.toolRequest')
      case 'tool_result': return t('trace.message.toolResult')
      default: return span.message.type
    }
  }
  if (span.kind === 'llm') {
    return span.call?.model ?? span.call?.provider?.name ?? t('trace.modelCall')
  }
  if (span.kind === 'tool') {
    return span.toolName ?? span.title
  }
  if (span.kind === 'tool_result') {
    return span.status === 'error' ? t('trace.toolError') : t('trace.toolResult')
  }
  if (span.kind === 'event' && span.event) {
    return traceEventPhaseLabel(span.event.phase, t)
  }
  if (span.kind === 'turn') {
    return turnDisplayTitle(span.title, (span.turnIndex ?? 0) + 1, t)
  }
  return span.title
}

export function turnDisplayTitle(title: string, oneBasedIndex: number, t: TraceTranslator): string {
  if (title === 'Session activity') return t('trace.sessionActivity')
  const match = title.match(/^Turn (\d+)$/)
  if (match) return t('trace.turnLabel', { index: match[1]! })
  if (!title.trim()) return t('trace.turnLabel', { index: oneBasedIndex })
  return title
}

export function traceEventPhaseLabel(phase: string, t: TraceTranslator): string {
  switch (phase) {
    case 'api_call_started': return t('trace.event.apiCallStarted')
    case 'api_call_completed': return t('trace.event.apiCallCompleted')
    case 'api_call_failed': return t('trace.event.apiCallFailed')
    case 'api_call_aborted': return t('trace.event.apiCallAborted')
    case 'response_capture_failed': return t('trace.event.responseCaptureFailed')
    case 'upstream_fetch_started': return t('trace.event.upstreamFetchStarted')
    case 'upstream_fetch_completed': return t('trace.event.upstreamFetchCompleted')
    case 'upstream_fetch_failed': return t('trace.event.upstreamFetchFailed')
    default:
      return phase
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
  }
}
