import type { TraceCallUsage } from '../../types/trace'
import { formatTokenCount } from '../formatTokenCount'
import type { NormalizedUsage } from './types'

export { formatTokenCount }

export function formatDurationMs(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function formatUsageBrief(u?: NormalizedUsage | TraceCallUsage): string {
  if (!u) return '--'
  return `${formatTokenCount(u.inputTokens)} → ${formatTokenCount(u.outputTokens)}`
}

export function formatClockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
