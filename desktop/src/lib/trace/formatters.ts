import type { TraceCallUsage } from '../../types/trace'
import type { NormalizedUsage } from './types'

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

export function formatTokenCount(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '--'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
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
